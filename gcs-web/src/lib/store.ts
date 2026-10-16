// Estado central da estação: conexão com a ponte, telemetria, log, parâmetros,
// plano de missão e mapa LiDAR. Componentes React assinam "canais" para
// renderizar só quando o que lhes interessa muda.

import { useSyncExternalStore } from 'react'
import { distance, enuToLatLon, type LatLon } from './geo'
import { decodeMapFrame } from './mapframe'
import { desktop, describeLink, isDesktop, saveLink, savedLink, type LinkConfig, type LinkStatus } from './desktop'
import { vehicleClass, type CalibEvent, type ClientCommand, type LogEntry, type LogLevel, type MissionItem, type PayloadState, type ReleaseEvent, type ReplayState, type Sample, type ServerMessage, type Telemetry, type VehicleMission } from '../types'
import { paramIdsFor } from './params'
import { setupTiles, type Bounds } from './tiles'
import { getLang, setLang, t as tr, tk, type Lang } from './i18n'

// Origens de lançamento que a ponte manda (em português, traduzidas na tela).
tk('missão'); tk('externo'); tk('estação')

export type Channel = 'telemetry' | 'log' | 'params' | 'mission' | 'map' | 'ui' | 'conn' | 'payload' | 'link' | 'replay' | 'calib'
export type View = 'fly' | 'plan' | 'setup' | 'analyze'

export interface Settings {
  bridgeUrl: string
  tileUrl: string
  tileAttribution: string
  videoUrl: string
  takeoffAlt: number
  wpAlt: number
  /** Asa fixa: missões terminam pousando (sequência de pouso) em vez de só circular no home. */
  landAtEnd: boolean
  /** Rumo final do pouso do avião, em graus; null = segue do último waypoint. */
  approachDeg: number | null
  lang: Lang
  theme: 'dark' | 'light' | 'auto'
  /** Guarda no computador os tiles vistos com rede (mapa offline). */
  keepTiles: boolean
}

const DEFAULT_SETTINGS: Settings = {
  bridgeUrl: `ws://${location.hostname || '127.0.0.1'}:8765`,
  tileUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  tileAttribution: 'Imagens © Esri, Maxar, Earthstar Geographics',
  videoUrl: '',
  takeoffAlt: 20,
  wpAlt: 40,
  landAtEnd: true,
  approachDeg: null,
  lang: getLang(),
  theme: 'dark',
  keepTiles: true,
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem('aracua.settings')
    const q = new URLSearchParams(location.search).get('bridge')
    const s = { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) }
    if (q) s.bridgeUrl = q
    // No app desktop a ponte é local e iniciada pelo próprio app.
    if (isDesktop) s.bridgeUrl = 'ws://127.0.0.1:8765'
    applyLook(s)
    return s
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}


/** Língua e tema na página. */
let themeWatch = false
function applyLook(s: Settings) {
  if (!themeWatch && typeof matchMedia !== 'undefined') {
    themeWatch = true
    matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => applyLook(station.settings))
  }
  setLang(s.lang)
  if (typeof document !== 'undefined') {
    const dark = s.theme === 'dark' || (s.theme === 'auto' && !matchMedia('(prefers-color-scheme: light)').matches)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }
}

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
  mapApi: { center(): LatLon; zoom(): number; bounds(): Bounds; zoomBy(d: number): void; flyTo(p: LatLon): void; fit(pts: LatLon[]): void } | null = null

  conn: 'connecting' | 'open' | 'closed' = 'closed'
  hello: { bridge: string; version: string; mavlink: string; replay?: boolean; log_file?: string | null } | null = null
  telem: Telemetry | null = null
  lastTelemAt = 0

  log: LogEntry[] = []
  unread = 0
  params = new Map<string, number>()
  /** Quando cada parâmetro foi pedido (para dizer "não existe neste firmware"). */
  paramAsked = new Map<string, number>()

  /** Missão que está no veículo (lida dele ou enviada daqui). */
  vehicleMission: VehicleMission | null = null
  /** Reprodução de voo gravado em andamento. */
  replay: ReplayState | null = null
  /** Andamento das calibrações. */
  calib: { accel: { status: string; position: number } | null; compass: Record<number, { pct: number; status: string; fitness?: number }> } = { accel: null, compass: {} }
  /** Captura dos extremos do rádio na calibração. */
  rcCapture: { min: number[]; max: number[] } | null = null
  /** Último comando barrado pelo pré-voo da ponte, para "fazer mesmo assim". */
  forceable: { cmd: ClientCommand; reason: string } | null = null
  private lastForceable: ClientCommand | null = null

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
    // Textos montados no carregamento só mudam de língua recarregando.
    const relang = patch.lang !== undefined && patch.lang !== this.settings.lang
    this.settings = { ...this.settings, ...patch }
    applyLook(this.settings)
    setupTiles(this.settings.tileUrl, this.settings.keepTiles)
    try {
      localStorage.setItem('aracua.settings', JSON.stringify(this.settings))
    } catch {
      /* armazenamento indisponível: vale só nesta sessão */
    }
    if (relang) return location.reload()
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
    if (this.link) this.settings.bridgeUrl = this.link.bridge_url
    const last = savedLink()
    if (!this.link?.running && last) await this.startLink(last)
    else if (!this.link?.running) this.openLinkDialog()
    // A ponte pode morrer sozinha (rádio desconectado, porta ocupada).
    clearInterval(this.linkPoll)
    this.linkPoll = window.setInterval(async () => {
      const was = this.link?.running
      this.link = await desktop.status().catch(() => this.link)
      if (was && !this.link?.running) {
        this.linkError = this.link?.exit_code != null ? tr('A ponte parou (código {code}). Veja o log abaixo.', { code: this.link.exit_code }) : tr('A ponte parou. Veja o log abaixo.')
        this.addLog('error', tr('A ponte encerrou; escolha a conexão de novo'))
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
      this.settings.bridgeUrl = this.link.bridge_url
      if (c.kind !== 'replay') saveLink(c)
      this.linkDialog = false
      this.addLog('ok', tr('Conexão: {v0}', { v0: describeLink(c) }))
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
      this.addLog('error', tr('Endereço da ponte inválido: {bridgeUrl}', { bridgeUrl: this.settings.bridgeUrl }))
      this.emit('conn')
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => {
      this.retry = 0
      this.conn = 'open'
      this.addLog('ok', tr('Conectado à ponte em {bridgeUrl}', { bridgeUrl: this.settings.bridgeUrl }))
      this.emit('conn')
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      const was = this.conn
      this.conn = 'closed'
      if (was === 'open') this.addLog('warn', tr('Conexão com a ponte perdida; tentando de novo'))
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
      if (!quiet) this.addLog('warn', tr('Sem conexão com a ponte: comando não enviado'))
      return false
    }
    this.ws.send(JSON.stringify(cmd))
    if (!quiet) this.addLog('cmd', describe(cmd))
    if (cmd.cmd === 'takeoff' || cmd.cmd === 'mission_start') this.lastForceable = cmd
    return true
  }

  /** Lê de novo os parâmetros que a interface usa para este tipo de veículo. */
  requestParams() {
    const now = Date.now()
    for (const id of paramIdsFor(vehicleClass(this.telem))) {
      this.paramAsked.set(id, now)
      this.send({ cmd: 'param_get', id }, true)
    }
    this.emit('params')
  }

  // ---------- mensagens da ponte ----------
  private onJson(m: ServerMessage) {
    switch (m.type) {
      case 'telemetry':
        this.onTelemetry(m)
        break
      case 'hello':
        this.hello = m
        this.replay = null
        this.clearMap(false)
        if (m.replay) this.addLog('info', tr('Reproduzindo voo gravado ({file}); comandos ao veículo desligados', { file: m.mavlink.replace('reprodução: ', '') }))
        this.emit('conn', 'replay')
        break
      case 'vehicle_mission': {
        const first = !this.vehicleMission
        this.vehicleMission = m
        this.onVehicle = m.items.map((w) => ({ ...w }))
        this.onVehicleSeq = m.wp_seq
        if (first || this.upload.state !== 'sending') {
          this.addLog('info', m.items.length
            ? tr('Missão no veículo: {n} waypoints', { n: m.items.length }) + (m.land_at_end ? tr(', termina pousando') : m.rtl_at_end ? tr(', termina com RTL') : '')
              + (m.ignored ? tr(' ({n} itens que a estação não mostra)', { n: m.ignored }) : '')
            : tr('Nenhuma missão no veículo'))
        }
        this.emit('mission')
        break
      }
      case 'replay':
        this.replay = m
        this.emit('replay')
        break
      case 'calib':
        this.onCalib(m)
        break
      case 'statustext':
        this.addLog(SEVERITY[m.severity] ?? 'info', m.text)
        break
      case 'ack': {
        const ok = m.result === 'MAV_RESULT_ACCEPTED'
        const cmd = m.command.replace('MAV_CMD_', '').toLowerCase().replaceAll('_', ' ')
        this.addLog(ok ? 'ok' : 'warn', `${ok ? tr('Aceito') : tr('Recusado')}: ${cmd}${ok ? '' : ` (${m.result.replace('MAV_RESULT_', '')})`}`)
        break
      }
      case 'param':
        this.params.set(m.id, m.value)
        this.emit('params')
        break
      case 'mission_upload':
        this.upload = m.ok
          ? { state: 'ok', text: tr('Missão enviada ({count} itens)', { count: m.count }) }
          : { state: 'error', text: tr('Falha no envio: {result}', { result: m.result }) }
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
        // Barrado pelo pré-voo da ponte: oferece fazer mesmo assim (com confirmação na tela).
        const kind = m.message.startsWith('pré-voo (decolar)') ? 'takeoff' : m.message.startsWith('pré-voo (iniciar missão)') ? 'mission_start' : null
        if (kind && this.lastForceable?.cmd === kind) {
          this.forceable = { cmd: this.lastForceable, reason: m.message }
          this.emit('ui')
        }
        break
      case 'payload': {
        const prev = this.payload
        this.payload = m
        this.payloadAt = performance.now()
        if (prev?.armed !== m.armed && prev) this.addLog(m.armed ? 'warn' : 'info', m.armed ? tr('Sistema de entrega ARMADO') : tr('Sistema de entrega desarmado'))
        if (m.message && m.message !== prev?.message) this.addLog('warn', tr('Entrega: {msg}', { msg: m.message }))
        if (m.countdown && !prev?.countdown) {
          const names = m.countdown.slots.map((id) => m.slots.find((s) => s.id === id)?.name ?? id).join(', ')
          this.addLog('warn', tr('Contagem de {v0} s para soltar {names}', { v0: Math.round(m.countdown.total_ms / 1000), names }))
        }
        this.emit('payload')
        break
      }
      case 'payload_release':
        this.lastRelease = m.event
        this.lastReleaseAt = performance.now()
        this.addLog('ok', tr('Lançamento nº {n}: {name} a {alt} m', { n: m.event.n, name: m.event.name, alt: m.event.alt_rel.toFixed(1) }) + (m.event.source !== 'estação' ? ` (${tr(m.event.source)})` : ''))
        this.emit('payload')
        break
      case 'payload_confirm':
        if (this.lastRelease?.n === m.event.n) {
          this.lastRelease = m.event
          this.lastReleaseAt = performance.now()
        }
        if (m.event.confirmed) this.addLog('ok', tr('Lançamento nº {n}: chave confirmou que o pino de {name} saiu', { n: m.event.n, name: m.event.name }))
        else this.addLog('error', tr('Lançamento nº {n}: a chave de {name} continua fechada — o pino pode não ter saído', { n: m.event.n, name: m.event.name }))
        this.emit('payload')
        break
    }
  }

  setRcCapture(on: boolean) {
    this.rcCapture = on ? { min: [], max: [] } : null
    this.emit('calib')
  }

  private onTelemetry(t: Telemetry) {
    const prev = this.telem
    this.telem = t
    if (this.rcCapture) {
      const r = this.rcCapture
      t.rc.forEach((v, i) => {
        if (v > 800 && v < 2200) {
          r.min[i] = Math.min(r.min[i] ?? v, v)
          r.max[i] = Math.max(r.max[i] ?? v, v)
        }
      })
    }
    this.lastTelemAt = performance.now()
    if ((t.connected && !prev?.connected) || (prev && t.vehicle_class !== prev.vehicle_class)) this.requestParams()
    if (prev && prev.connected !== t.connected) this.addLog(t.connected ? 'ok' : 'error', t.connected ? tr('Veículo conectado') : tr('Sem HEARTBEAT do veículo'))
    if (prev && prev.armed !== t.armed) this.addLog(t.armed ? 'warn' : 'ok', t.armed ? tr('Veículo armado') : tr('Veículo desarmado'))
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

  private onCalib(m: CalibEvent) {
    if (m.kind === 'accel') {
      this.calib.accel = { status: m.status, position: m.position }
      if (m.status === 'success') this.addLog('ok', tr('Calibração do acelerômetro concluída'))
      if (m.status === 'failed') this.addLog('error', tr('Calibração do acelerômetro falhou'))
    } else if (m.kind === 'compass') {
      this.calib.compass[m.compass] = { pct: m.pct, status: m.status }
    } else {
      this.calib.compass[m.compass] = { pct: 100, status: m.status, fitness: m.fitness }
      this.addLog(m.status === 'success' ? 'ok' : 'error', m.status === 'success' ? tr('Bússola {n}: calibrada (ajuste {f})', { n: m.compass + 1, f: m.fitness.toFixed(1) }) : tr('Bússola {n}: {status}', { n: m.compass + 1, status: m.status }))
    }
    this.emit('calib')
  }

  /** Faz o comando barrado pelo pré-voo, ignorando as verificações da ponte. */
  forceLast() {
    const f = this.forceable
    this.forceable = null
    if (f && (f.cmd.cmd === 'takeoff' || f.cmd.cmd === 'mission_start')) this.send({ ...f.cmd, force: true })
    this.emit('ui')
  }

  dismissForce() {
    this.forceable = null
    this.emit('ui')
  }

  clearMap(announce: boolean) {
    this.vox = { e: [], n: [], u: [], cls: [] }
    this.voxKeys.clear()
    this.groundCells = 0
    if (announce) this.addLog('info', tr('Mapa LiDAR zerado'))
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
    const cls = vehicleClass(this.telem)
    const wing = cls === 'plane' || cls === 'vtol'
    const cruise = this.params.get('AIRSPEED_CRUISE') ?? (this.params.has('TRIM_ARSPD_CM') ? this.params.get('TRIM_ARSPD_CM')! / 100 : undefined)
    if (this.send({
      cmd: 'mission_upload', items: this.plan, rtl_at_end: true,
      land_at_end: wing && this.settings.landAtEnd, approach_deg: this.settings.approachDeg, cruise_ms: cruise,
    })) {
      this.onVehicle = this.plan.map((p) => ({ ...p }))
      this.upload = { state: 'sending', text: tr('Enviando missão…') }
      this.emit('mission')
    }
  }
  /** Copia a missão do veículo para o plano em edição. */
  planFromVehicle() {
    const m = this.vehicleMission
    if (!m) return
    this.setPlan(m.items.map((w) => ({ ...w, drop: w.drop?.length ? [...w.drop] : undefined })), -1)
    this.addLog('ok', tr('Plano carregado do veículo ({length} waypoints)', { length: m.items.length }))
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
    case 'arm': return c.arm ? tr('Armar motores') : tr('Desarmar motores')
    case 'mode': return tr('Mudar modo para {mode}', { mode: c.mode })
    case 'takeoff': return tr('Decolar para {alt} m', { alt: c.alt }) + (c.force ? tr(' (sem pré-voo)') : '')
    case 'mission_upload': return tr('Enviar missão com {length} waypoints', { length: c.items.length })
    case 'mission_start': return c.force ? tr('Iniciar missão (sem pré-voo)') : tr('Iniciar missão')
    case 'mission_download': return tr('Ler missão do veículo')
    case 'replay': return c.seek !== undefined ? tr('Reprodução: pular') : c.paused !== undefined ? (c.paused ? tr('Reprodução: pausar') : tr('Reprodução: continuar')) : tr('Reprodução a {speed}×', { speed: c.speed ?? 1 })
    case 'calibrate': return tr('Calibrar: {what}', { what: tr({ accel: tk('acelerômetro (6 posições)'), level: tk('nivelar'), gyro: tk('giroscópio'), compass: tk('bússola'), compass_accept: tk('aceitar bússola'), compass_cancel: tk('cancelar bússola') }[c.kind]) })
    case 'accel_pos': return tr('Calibração: posição {position} pronta', { position: c.position })
    case 'reboot': return tr('Reiniciar controladora')
    case 'param_set': return tr('Parâmetro {id} = {value}', { id: c.id, value: c.value })
    case 'param_get': return `Ler ${c.id}`
    case 'photo': return tr('Tirar foto')
    case 'gimbal': return tr('Gimbal para {pitch}°', { pitch: c.pitch })
    case 'map_reset': return tr('Zerar mapa LiDAR')
    case 'manual': return tr('Controle manual')
    case 'payload_arm': return c.arm ? tr('Armar sistema de entrega') : tr('Desarmar sistema de entrega')
    case 'payload_release': return tr('Soltar {names}', { names: c.slots.map((id) => station.payloadName(id)).join(', ') })
    case 'payload_abort': return tr('Abortar contagem de entrega')
    case 'payload_lock': return tr('Travar {name}', { name: station.payloadName(c.slot) })
    case 'payload_test': return tr('Testar {name}', { name: station.payloadName(c.slot) })
    case 'payload_loaded': return c.loaded ? tr('{name} marcado como carregado', { name: station.payloadName(c.slot) }) : tr('{name} marcado como vazio', { name: station.payloadName(c.slot) })
    case 'payload_config': return tr('Configuração de entrega salva ({length} compartimentos)', { length: c.slots.length })
    case 'payload_reset_counter': return tr('Zerar contador de lançamentos')
    case 'payload_get': return tr('Ler estado da entrega')
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
