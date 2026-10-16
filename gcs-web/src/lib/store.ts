// Estado central da estação: conexão com a ponte, telemetria, log, parâmetros,
// plano de missão e mapa LiDAR. Componentes React assinam "canais" para
// renderizar só quando o que lhes interessa muda.

import { useSyncExternalStore } from 'react'
import { distance, enuToLatLon, type LatLon } from './geo'
import { decodeMapFrame } from './mapframe'
import { desktop, describeLink, isDesktop, saveLink, savedLink, type LinkConfig, type LinkStatus } from './desktop'
import type { ClientCommand, LogEntry, LogLevel, MissionItem, PayloadState, ReleaseEvent, Sample, ServerMessage, Telemetry } from '../types'

export type Channel = 'telemetry' | 'log' | 'params' | 'mission' | 'map' | 'ui' | 'conn' | 'payload' | 'link'
export type View = 'fly' | 'plan' | 'setup' | 'analyze'

export interface Settings {
  bridgeUrl: string
  tileUrl: string
  tileAttribution: string
  videoUrl: string
  takeoffAlt: number
  wpAlt: number
}

const DEFAULT_SETTINGS: Settings = {
  bridgeUrl: `ws://${location.hostname || '127.0.0.1'}:8765`,
  tileUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  tileAttribution: 'Imagens © Esri, Maxar, Earthstar Geographics',
  videoUrl: '',
  takeoffAlt: 20,
  wpAlt: 40,
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem('aracua.settings')
    const q = new URLSearchParams(location.search).get('bridge')
    const s = { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) }
    if (q) s.bridgeUrl = q
    // No app desktop a ponte é local e iniciada pelo próprio app.
    if (isDesktop) s.bridgeUrl = 'ws://127.0.0.1:8765'
    return s
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** Parâmetros do ArduCopter lidos ao conectar (usados em Configurar e no mapa). */
export const PARAM_IDS = [
  'FENCE_ENABLE', 'FENCE_RADIUS', 'RTL_ALT', 'BATT_LOW_MAH', 'BATT_FS_LOW_ACT', 'FS_GCS_ENABLE',
  'AVOID_ENABLE', 'AVOID_DIST_MAX', 'WPNAV_SPEED', 'LOIT_SPEED', 'PILOT_SPEED_UP', 'PILOT_TKOFF_ALT',
]

const SEVERITY: LogLevel[] = ['error', 'error', 'error', 'error', 'warn', 'info', 'info', 'info']
const HISTORY_S = 300

class Station {
  settings = loadSettings()
  view: View = 'fly'
  follow = true
  lidarLayer = true
  addMode = true
  videoBig = false
  /** Painel de entrega visível na tela de voo. */
  deliveryOpen = true
  surveyPreview: { width: number; height: number; spacing: number; northSouth: boolean } | null = null
  /** Preenchido pelo MapView para que outros componentes controlem o mapa. */
  mapApi: { center(): LatLon; zoomBy(d: number): void; flyTo(p: LatLon): void; fit(pts: LatLon[]): void } | null = null

  conn: 'connecting' | 'open' | 'closed' = 'closed'
  hello: { bridge: string; version: string; mavlink: string } | null = null
  telem: Telemetry | null = null
  lastTelemAt = 0

  log: LogEntry[] = []
  unread = 0
  params = new Map<string, number>()

  plan: MissionItem[] = []
  selected = -1
  upload: { state: 'idle' | 'sending' | 'ok' | 'error'; text: string } = { state: 'idle', text: '' }
  /** Cópia do plano enviada ao veículo (para mapear mission_current). */
  onVehicle: MissionItem[] = []
  /** Sequência MAVLink de cada waypoint enviado (entregas acrescentam itens entre eles). */
  onVehicleSeq: number[] = []

  // Sistema de entrega
  payload: PayloadState | null = null
  /** Último lançamento, para o aviso na tela de voo. */
  lastRelease: ReleaseEvent | null = null
  /** Quando chegou o último lançamento/confirmação (performance.now()). */
  lastReleaseAt = 0
  /** Quando chegou o último estado de entrega: âncora do relógio da contagem. */
  payloadAt = 0

  // Mapa LiDAR
  origin: LatLon | null = null
  voxelM = 1
  vox = { e: [] as number[], n: [] as number[], u: [] as number[], cls: [] as number[] }
  voxKeys = new Set<number>()
  groundCells = 0
  sectors: Float32Array | null = null
  sectorInc = 5
  nearest = Infinity

  // Histórico para os gráficos e resumo do voo
  history: Sample[] = []
  stats = { maxAlt: 0, maxGs: 0, distance: 0, flightS: 0, photos: 0 }
  private lastPos: LatLon | null = null
  private lastSampleAt = 0

  // App desktop: a ponte é um processo filho; a tela "Conectar" escolhe o veículo.
  link: LinkStatus | null = null
  linkDialog = false
  linkBusy = false
  linkError = ''
  private linkPoll = 0

  private ws: WebSocket | null = null
  private retry = 0
  private versions = new Map<Channel, number>()
  private listeners = new Map<Channel, Set<() => void>>()

  // ---------- assinatura ----------
  subscribe(ch: Channel, fn: () => void) {
    if (!this.listeners.has(ch)) this.listeners.set(ch, new Set())
    this.listeners.get(ch)!.add(fn)
    return () => this.listeners.get(ch)!.delete(fn)
  }
  version(ch: Channel) {
    return this.versions.get(ch) ?? 0
  }
  emit(...chs: Channel[]) {
    for (const ch of chs) {
      this.versions.set(ch, this.version(ch) + 1)
      this.listeners.get(ch)?.forEach((f) => f())
    }
  }

  // ---------- configurações ----------
  saveSettings(patch: Partial<Settings>) {
    const reconnect = patch.bridgeUrl !== undefined && patch.bridgeUrl !== this.settings.bridgeUrl
    this.settings = { ...this.settings, ...patch }
    try {
      localStorage.setItem('aracua.settings', JSON.stringify(this.settings))
    } catch {
      /* armazenamento indisponível: vale só nesta sessão */
    }
    this.emit('ui')
    if (reconnect) this.connect()
  }

  setView(v: View) {
    this.view = v
    if (v === 'fly') this.follow = true
    this.emit('ui')
  }

  // ---------- app desktop ----------
  /** Ao abrir o app: reconecta com a última escolha ou mostra a tela "Conectar". */
  async initDesktop() {
    if (!isDesktop) return
    this.link = await desktop.status().catch(() => null)
    const last = savedLink()
    if (!this.link?.running && last) await this.startLink(last)
    else if (!this.link?.running) this.openLinkDialog()
    // A ponte pode morrer sozinha (rádio desconectado, porta ocupada).
    clearInterval(this.linkPoll)
    this.linkPoll = window.setInterval(async () => {
      const was = this.link?.running
      this.link = await desktop.status().catch(() => this.link)
      if (was && !this.link?.running) {
        this.linkError = `A ponte parou${this.link?.exit_code != null ? ` (código ${this.link.exit_code})` : ''}. Veja o log abaixo.`
        this.addLog('error', 'A ponte encerrou; escolha a conexão de novo')
        this.linkDialog = true
      }
      this.emit('link')
    }, 2000)
  }

  openLinkDialog() {
    this.linkError = ''
    this.linkDialog = true
    this.emit('link')
  }

  closeLinkDialog() {
    this.linkDialog = false
    this.emit('link')
  }

  async startLink(c: LinkConfig) {
    this.linkBusy = true
    this.linkError = ''
    this.emit('link')
    try {
      this.link = await desktop.start(c)
      saveLink(c)
      this.linkDialog = false
      this.addLog('ok', `Conexão: ${describeLink(c)}`)
      this.connect()
    } catch (e) {
      this.linkError = String(e)
      this.link = await desktop.status().catch(() => null)
      this.linkDialog = true
    } finally {
      this.linkBusy = false
      this.emit('link')
    }
  }

  async stopLink() {
    this.link = await desktop.stop().catch(() => null)
    this.emit('link')
  }

  // ---------- conexão ----------
  connect() {
    this.ws?.close()
    this.conn = 'connecting'
    this.emit('conn')
    let ws: WebSocket
    try {
      ws = new WebSocket(this.settings.bridgeUrl)
    } catch {
      this.conn = 'closed'
      this.addLog('error', `Endereço da ponte inválido: ${this.settings.bridgeUrl}`)
      this.emit('conn')
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => {
      this.retry = 0
      this.conn = 'open'
      this.addLog('ok', `Conectado à ponte em ${this.settings.bridgeUrl}`)
      this.emit('conn')
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      const was = this.conn
      this.conn = 'closed'
      if (was === 'open') this.addLog('warn', 'Conexão com a ponte perdida; tentando de novo')
      this.emit('conn')
      const delay = Math.min(10_000, 500 * 2 ** this.retry++)
      setTimeout(() => this.ws === ws && this.connect(), delay)
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') this.onJson(JSON.parse(ev.data) as ServerMessage)
      else this.onBinary(ev.data as ArrayBuffer)
    }
  }

  send(cmd: ClientCommand, quiet = false) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      if (!quiet) this.addLog('warn', 'Sem conexão com a ponte: comando não enviado')
      return false
    }
    this.ws.send(JSON.stringify(cmd))
    if (!quiet) this.addLog('cmd', describe(cmd))
    return true
  }

  // ---------- mensagens da ponte ----------
  private onJson(m: ServerMessage) {
    switch (m.type) {
      case 'telemetry':
        this.onTelemetry(m)
        break
      case 'hello':
        this.hello = m
        this.clearMap(false)
        this.emit('conn')
        break
      case 'statustext':
        this.addLog(SEVERITY[m.severity] ?? 'info', m.text)
        break
      case 'ack': {
        const ok = m.result === 'MAV_RESULT_ACCEPTED'
        const cmd = m.command.replace('MAV_CMD_', '').toLowerCase().replaceAll('_', ' ')
        this.addLog(ok ? 'ok' : 'warn', `${ok ? 'Aceito' : 'Recusado'}: ${cmd}${ok ? '' : ` (${m.result.replace('MAV_RESULT_', '')})`}`)
        break
      }
      case 'param':
        this.params.set(m.id, m.value)
        this.emit('params')
        break
      case 'mission_upload':
        this.upload = m.ok
          ? { state: 'ok', text: `Missão enviada (${m.count} itens)` }
          : { state: 'error', text: `Falha no envio: ${m.result}` }
        this.addLog(m.ok ? 'ok' : 'error', this.upload.text)
        if (!m.ok) this.onVehicle = []
        this.onVehicleSeq = m.ok ? m.wp_seq ?? this.onVehicle.map((_, i) => i + 2) : []
        this.emit('mission')
        break
      case 'map_reset':
        this.clearMap(true)
        break
      case 'error':
        this.addLog('error', m.message)
        break
      case 'payload': {
        const prev = this.payload
        this.payload = m
        this.payloadAt = performance.now()
        if (prev?.armed !== m.armed && prev) this.addLog(m.armed ? 'warn' : 'info', m.armed ? 'Sistema de entrega ARMADO' : 'Sistema de entrega desarmado')
        if (m.message && m.message !== prev?.message) this.addLog('warn', `Entrega: ${m.message}`)
        if (m.countdown && !prev?.countdown) {
          const names = m.countdown.slots.map((id) => m.slots.find((s) => s.id === id)?.name ?? id).join(', ')
          this.addLog('warn', `Contagem de ${Math.round(m.countdown.total_ms / 1000)} s para soltar ${names}`)
        }
        this.emit('payload')
        break
      }
      case 'payload_release':
        this.lastRelease = m.event
        this.lastReleaseAt = performance.now()
        this.addLog('ok', `Lançamento nº ${m.event.n}: ${m.event.name} a ${m.event.alt_rel.toFixed(1)} m${m.event.source !== 'estação' ? ` (${m.event.source})` : ''}`)
        this.emit('payload')
        break
      case 'payload_confirm':
        if (this.lastRelease?.n === m.event.n) {
          this.lastRelease = m.event
          this.lastReleaseAt = performance.now()
        }
        if (m.event.confirmed) this.addLog('ok', `Lançamento nº ${m.event.n}: chave confirmou que o pino de ${m.event.name} saiu`)
        else this.addLog('error', `Lançamento nº ${m.event.n}: a chave de ${m.event.name} continua fechada — o pino pode não ter saído`)
        this.emit('payload')
        break
    }
  }

  private onTelemetry(t: Telemetry) {
    const prev = this.telem
    this.telem = t
    this.lastTelemAt = performance.now()
    if (t.connected && !prev?.connected) PARAM_IDS.forEach((id) => this.send({ cmd: 'param_get', id }, true))
    if (prev && prev.connected !== t.connected) this.addLog(t.connected ? 'ok' : 'error', t.connected ? 'Veículo conectado' : 'Sem HEARTBEAT do veículo')
    if (prev && prev.armed !== t.armed) this.addLog(t.armed ? 'warn' : 'ok', t.armed ? 'Veículo armado' : 'Veículo desarmado')
    if (prev && prev.mode !== t.mode && t.connected) this.addLog('info', `Modo: ${t.mode}`)
    // Resumo do voo
    const now = t.t / 1000
    const pos = { lat: t.lat, lon: t.lon }
    if (t.connected && t.lat !== 0) {
      if (this.lastPos && t.armed) {
        const d = distance(this.lastPos, pos)
        if (d < 50) this.stats.distance += d
      }
      this.lastPos = pos
      if (t.armed && t.alt_rel > 0.3 && this.lastSampleAt) this.stats.flightS += Math.min(1, now - this.lastSampleAt)
      this.stats.maxAlt = Math.max(this.stats.maxAlt, t.alt_rel)
      this.stats.maxGs = Math.max(this.stats.maxGs, t.groundspeed)
    }
    if (now - (this.history.at(-1)?.t ?? 0) >= 0.5) {
      this.history.push({
        t: now,
        alt: t.alt_rel,
        gs: t.groundspeed,
        bat: t.battery.remaining,
        vib: Math.max(...t.vibration),
        link: t.msgs_per_sec,
        obs: Number.isFinite(this.nearest) ? Math.min(this.nearest, 100) : 100,
      })
      while (this.history.length && now - this.history[0].t > HISTORY_S + 5) this.history.shift()
    }
    this.lastSampleAt = now
    if (!this.origin && t.home) this.origin = { lat: t.home.lat, lon: t.home.lon }
    this.emit('telemetry')
  }

  private onBinary(buf: ArrayBuffer) {
    const f = decodeMapFrame(buf)
    if (!f) return
    if (f.kind === 'sectors') {
      this.sectors = f.distances
      this.sectorInc = f.incrementDeg
      let m = Infinity
      for (const d of f.distances) m = Math.min(m, d)
      this.nearest = m
      return
    }
    if (f.reset) this.clearMap(false)
    this.origin = { lat: f.originLat, lon: f.originLon }
    this.voxelM = f.voxelM
    for (let i = 0; i < f.e.length; i++) {
      const key = (f.e[i] + 32768) * 4294967296 + (f.n[i] + 32768) * 65536 + (f.u[i] + 32768)
      if (this.voxKeys.has(key)) continue
      this.voxKeys.add(key)
      this.vox.e.push(f.e[i])
      this.vox.n.push(f.n[i])
      this.vox.u.push(f.u[i])
      this.vox.cls.push(f.cls[i])
      if (f.cls[i] === 0) this.groundCells++
    }
    this.emit('map')
  }

  clearMap(announce: boolean) {
    this.vox = { e: [], n: [], u: [], cls: [] }
    this.voxKeys.clear()
    this.groundCells = 0
    if (announce) this.addLog('info', 'Mapa LiDAR zerado')
    this.emit('map')
  }

  voxelLatLon(i: number): LatLon {
    return enuToLatLon(this.origin!, this.vox.e[i] * this.voxelM, this.vox.n[i] * this.voxelM)
  }

  // ---------- log ----------
  addLog(level: LogLevel, text: string) {
    this.log.push({ t: Date.now(), level, text })
    if (this.log.length > 800) this.log.splice(0, this.log.length - 800)
    this.unread++
    this.emit('log')
  }
  markRead() {
    this.unread = 0
    this.emit('log')
  }

  // ---------- plano de missão ----------
  setPlan(items: MissionItem[], selected = this.selected) {
    this.plan = items
    this.selected = Math.min(selected, items.length - 1)
    if (this.upload.state !== 'sending') this.upload = { state: 'idle', text: '' }
    this.emit('mission')
  }
  select(i: number) {
    this.selected = i
    this.emit('mission')
  }
  uploadPlan() {
    if (!this.plan.length) return
    if (this.send({ cmd: 'mission_upload', items: this.plan, rtl_at_end: true })) {
      this.onVehicle = this.plan.map((p) => ({ ...p }))
      this.upload = { state: 'sending', text: 'Enviando missão…' }
      this.emit('mission')
    }
  }
  payloadName(id: number) {
    return this.payload?.slots.find((s) => s.id === id)?.name ?? `#${id}`
  }

  /** Índice do waypoint ativo no plano enviado, ou -1. */
  activeWaypoint(): number {
    const t = this.telem
    if (!t || t.mode !== 'AUTO') return -1
    const seq = this.onVehicleSeq.length ? this.onVehicleSeq : this.onVehicle.map((_, i) => i + 2)
    let i = -1
    seq.forEach((s, j) => { if (s <= t.mission_current) i = j })
    return i >= 0 && i < this.onVehicle.length ? i : -1
  }
}

function describe(c: ClientCommand): string {
  switch (c.cmd) {
    case 'arm': return c.arm ? 'Armar motores' : 'Desarmar motores'
    case 'mode': return `Mudar modo para ${c.mode}`
    case 'takeoff': return `Decolar para ${c.alt} m`
    case 'mission_upload': return `Enviar missão com ${c.items.length} waypoints`
    case 'mission_start': return 'Iniciar missão'
    case 'param_set': return `Parâmetro ${c.id} = ${c.value}`
    case 'param_get': return `Ler ${c.id}`
    case 'photo': return 'Tirar foto'
    case 'gimbal': return `Gimbal para ${c.pitch}°`
    case 'map_reset': return 'Zerar mapa LiDAR'
    case 'manual': return 'Controle manual'
    case 'payload_arm': return c.arm ? 'Armar sistema de entrega' : 'Desarmar sistema de entrega'
    case 'payload_release': return `Soltar ${c.slots.map((id) => station.payloadName(id)).join(', ')}`
    case 'payload_abort': return 'Abortar contagem de entrega'
    case 'payload_lock': return `Travar ${station.payloadName(c.slot)}`
    case 'payload_test': return `Testar ${station.payloadName(c.slot)}`
    case 'payload_loaded': return `${station.payloadName(c.slot)} marcado como ${c.loaded ? 'carregado' : 'vazio'}`
    case 'payload_config': return `Configuração de entrega salva (${c.slots.length} compartimentos)`
    case 'payload_reset_counter': return 'Zerar contador de lançamentos'
    case 'payload_get': return 'Ler estado da entrega'
  }
}

export const station = new Station()

/** Re-renderiza o componente quando algum dos canais muda. */
export function useChannels(...chs: Channel[]): void {
  const key = chs.join(',')
  useSyncExternalStore(
    (fn) => {
      const offs = key.split(',').map((c) => station.subscribe(c as Channel, fn))
      return () => offs.forEach((o) => o())
    },
    () => key.split(',').map((c) => station.version(c as Channel)).join(':'),
  )
}
