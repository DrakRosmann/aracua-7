// Estado central da estação: conexão com a ponte, telemetria, log, parâmetros,
// plano de missão e mapa LiDAR. Componentes React assinam "canais" para
// renderizar só quando o que lhes interessa muda.

import { useSyncExternalStore } from 'react'
import { distance, enuToLatLon, type LatLon } from './geo'
import { decodeMapFrame } from './mapframe'
import { desktop, describeLink, isDesktop, saveLink, savedLink, type LinkConfig, type LinkStatus } from './desktop'
import { MANUAL_MODES, vehicleClass, type CalibEvent, type ClientCommand, type LogEntry, type LogLevel, type MissionItem, type PayloadState, type ReleaseEvent, type ReplayState, type Sample, type ServerMessage, type Telemetry, type VehicleMission } from '../types'
import { paramIdsFor } from './params'
import { emptyFence, type FenceData } from './fence'
import type { MaintenanceState } from '../types'
import { setupTiles, type Bounds } from './tiles'
import { wpName } from './format'
import { getLang, setLang, t as tr, tk, type Lang } from './i18n'
import { AlertTracker, buildPanel, DEFAULT_ENGINE, fuelPercent, issues, type EngineSettings } from './engine'
import { ChartIndex, DEFAULT_LAYERS, type ChartLayers, type ChartsInfo } from './charts'
import { computeNavlog, DEFAULT_LONG_RANGE, liveNav, PRESETS, reserveEnergy, type Live, type LongRangeSettings, type Navlog, type Wind } from './navlog'
import { DEFAULT_COCKPIT, type CockpitSettings } from './cockpit'
import { DEFAULT_PAD, effectiveThrottle, PadButtons, pickPad, readManual, type Manual, type PadAction, type PadSettings, type PadSnapshot } from './gamepad'

// Origens de lançamento que a ponte manda (em português, traduzidas na tela).
tk('missão'); tk('externo'); tk('estação')

export type Channel = 'telemetry' | 'log' | 'params' | 'mission' | 'map' | 'ui' | 'conn' | 'payload' | 'link' | 'replay' | 'calib' | 'fence' | 'maint' | 'pad' | 'charts'
export type View = 'fly' | 'plan' | 'setup' | 'analyze' | 'panel'

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
  /** Tipo de motor, células, tanque e faixas do painel do motor. */
  engine: EngineSettings
  /** Controle de videogame: eixos, botões e acelerador. */
  gamepad: PadSettings
  /** Aba Painel: layout, instrumentos de cada espaço, glareshield e alertas. */
  cockpit: CockpitSettings
  /** Longo alcance: perfil da aeronave, vento, unidades, altitudes e rota. */
  longRange: LongRangeSettings
  /** Camadas das cartas aeronáuticas no mapa. */
  chartLayers: ChartLayers
  /** Mostrar as cartas no mapa. */
  chartsOn: boolean
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
  engine: DEFAULT_ENGINE,
  gamepad: DEFAULT_PAD,
  cockpit: DEFAULT_COCKPIT,
  longRange: DEFAULT_LONG_RANGE,
  chartLayers: DEFAULT_LAYERS,
  chartsOn: true,
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem('aracua.settings')
    const q = new URLSearchParams(location.search).get('bridge')
    const s = { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) }
    if (q) s.bridgeUrl = q
    s.engine = { ...DEFAULT_ENGINE, ...s.engine }
    s.gamepad = { ...DEFAULT_PAD, ...s.gamepad, modes: { ...DEFAULT_PAD.modes, ...s.gamepad?.modes } }
    s.cockpit = { ...DEFAULT_COCKPIT, ...s.cockpit, slots: { ...DEFAULT_COCKPIT.slots, ...s.cockpit?.slots } }
    if (!(s.cockpit.layout in DEFAULT_COCKPIT.slots)) s.cockpit.layout = DEFAULT_COCKPIT.layout
    const dp = DEFAULT_LONG_RANGE.perf, sp = s.longRange?.perf
    s.longRange = {
      ...DEFAULT_LONG_RANGE, ...s.longRange, wind: { ...DEFAULT_LONG_RANGE.wind, ...s.longRange?.wind },
      perf: { ...dp, ...sp, eco: { ...dp.eco, ...sp?.eco }, fast: { ...dp.fast, ...sp?.fast } },
    }
    s.chartLayers = { ...DEFAULT_LAYERS, ...s.chartLayers }
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
  /** Mapa inclinado com os voxels do LiDAR em blocos 3D. */
  map3d = false
  addMode = true
  videoBig = false
  /** Painel de entrega visível na tela de voo. */
  // Em tablet o painel de entrega começa fechado, para sobrar mapa.
  deliveryOpen = !(typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse) and (max-width: 1180px)').matches)
  /** Painel do motor visível na tela de voo. */
  engineOpen = false
  /** Painel do piloto automático visível e quando ele desligou sozinho (alarme). */
  apOpen = false
  apOffAt = 0
  /** Inclinação do gimbal pedida (graus), comum ao controle e ao painel. */
  gimbalPitch = -30
  /** Painel de navegação (longo alcance) visível na tela de voo. */
  navOpen = false
  /** Rota digitada em Planejar (campo 15), mantida ao trocar de aba. */
  routeText = ''

  // Cartas aeronáuticas (vêm da ponte) e o andamento do download.
  charts: ChartIndex | null = null
  chartsInfo: ChartsInfo | null = null
  chartsStatus: { step: string; done: number; total: number } | null = null
  /** Consumo medido agora (W ou L/h), suavizado. */
  burnAvg: number | null = null
  /** Energia já não basta para voltar com a reserva (avisado uma vez). */
  bingo = false
  private lastLiveAt = 0
  private navMemo: { key: string; v: Navlog | null } = { key: '', v: null }

  // Controle de videogame
  pad: PadSnapshot | null = null
  /** O controle está mandando MANUAL_CONTROL agora (os sticks virtuais param). */
  padActive = false
  /** Saída atual dos sticks e andamento de um botão de segurar, para a tela. */
  padOut: Manual | null = null
  padHold: { action: PadAction; pct: number } | null = null
  private padButtons = new PadButtons()
  private padHeld = 0
  private padLastZ = 0.5
  private padLastSend = 0
  private padLastTick = 0
  private padLastEmit = 0
  private padNeutral = 0
  private padUnfocusedWarned = false
  private engineAlerts = new AlertTracker()
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
  /** Geocerca no veículo (lida dele ou enviada daqui) e o rascunho em edição. */
  vehicleFence: FenceData | null = null
  fenceDraft: FenceData = emptyFence()
  /** O rascunho foi mexido desde que veio do veículo. */
  fenceEdited = false
  fenceUpload: { state: 'idle' | 'sending' | 'ok' | 'error'; text: string } = { state: 'idle', text: '' }
  /** Área sendo desenhada no mapa. */
  drawing: { kind: 'inclusion' | 'exclusion'; pts: LatLon[] } | null = null
  /** Registro de manutenção (vem da ponte). */
  maint: MaintenanceState | null = null
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
      // Simulador com aeronave grande: o perfil de longo alcance acompanha (mesmos nomes).
      if (c.kind === 'simulator' && c.airframe && c.airframe !== 'small') this.applyPreset(c.airframe)
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
        // O veículo não guarda nomes: os da rota voltam pelo plano, ponto a ponto.
        this.onVehicle = m.items.map((w) => {
          const p = this.plan.find((q) => q.name && Math.abs(q.lat - w.lat) < 1e-6 && Math.abs(q.lon - w.lon) < 1e-6)
          return { ...w, name: w.name ?? p?.name, via: p?.via }
        })
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
      case 'vehicle_fence': {
        const { type: _t, ...f } = m
        this.vehicleFence = f
        // O rascunho segue o veículo enquanto o operador não mexeu nele.
        if (!this.fenceEdited) this.fenceDraft = structuredClone(f)
        this.emit('fence')
        break
      }
      case 'fence_upload':
        this.fenceUpload = m.ok
          ? { state: 'ok', text: tr('Geocerca enviada ({count} itens)', { count: m.count }) }
          : { state: 'error', text: tr('Falha no envio da geocerca: {result}', { result: m.result }) }
        if (m.ok) this.fenceEdited = false
        this.addLog(m.ok ? 'ok' : 'error', this.fenceUpload.text)
        this.emit('fence')
        break
      case 'maintenance':
        this.maint = m
        this.emit('maint')
        break
      case 'charts_info': {
        const was = this.chartsInfo
        this.chartsInfo = m
        if (m.busy) this.chartsStatus ??= { step: '', done: 0, total: 1 }
        else this.chartsStatus = null
        if (!m.loaded) this.charts = null
        // Cartas novas na ponte: pede só se forem diferentes das que já temos.
        else if (!m.busy && m.id !== this.charts?.id) this.send({ cmd: 'charts_get' }, true)
        if (was?.busy && !m.busy && m.loaded && !m.error) this.addLog('ok', tr('Cartas atualizadas: {source}, emenda de {date}', { source: m.source ?? '', date: m.effective ?? '?' }))
        if (m.error && m.error !== was?.error) this.addLog('error', tr('Cartas: {msg}', { msg: m.error }))
        this.emit('charts')
        break
      }
      case 'charts_status':
        this.chartsStatus = { step: m.step, done: m.done, total: m.total }
        this.emit('charts')
        break
      case 'charts': {
        const { type: _t, ...pack } = m
        this.charts = new ChartIndex(pack)
        this.emit('charts', 'mission')
        break
      }
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

  // ---------- longo alcance ----------

  /** Teto das altitudes no plano: `maxAlt` é altura sobre o home; em MSL soma a elevação dele. */
  maxAlt() {
    const lr = this.settings.longRange
    return lr.altMsl ? lr.maxAlt + (this.telem?.home?.alt ?? 0) : lr.maxAlt
  }

  /** Troca a referência das altitudes (home ↔ MSL) convertendo o plano, o cruzeiro e os novos WPs. */
  setAltReference(msl: boolean) {
    const lr = this.settings.longRange
    if (msl === lr.altMsl) return
    const h = this.telem?.home?.alt
    if (h === undefined) return this.saveSettings({ longRange: { ...lr, altMsl: msl } })
    const d = msl ? h : -h
    const conv = (a: number) => Math.max(5, Math.round(a + d))
    this.saveSettings({ longRange: { ...lr, altMsl: msl, cruiseAlt: conv(lr.cruiseAlt) }, wpAlt: conv(this.settings.wpAlt) })
    if (this.plan.length) this.setPlan(this.plan.map((w) => ({ ...w, alt: conv(w.alt) })))
  }

  /** Aplica um perfil pronto de aeronave (Configurar → Longo alcance, ou ao abrir o simulador). */
  applyPreset(key: string) {
    const pr = PRESETS[key]
    if (!pr) return
    this.setAltReference(pr.altMsl)
    const cur = this.settings.longRange
    this.saveSettings({ longRange: { ...cur, perf: { ...cur.perf, ...pr.perf }, maxAlt: pr.maxAlt, cruiseAlt: pr.altMsl ? pr.cruiseAlt : Math.min(pr.cruiseAlt, pr.maxAlt), splitKm: pr.splitKm } })
    this.addLog('ok', tr('Perfil: {name}', { name: tr(pr.label) }))
  }

  /** Vento usado nas contas: o medido pelo piloto automático (arredondado) ou o digitado. */
  wind(): Wind {
    const lr = this.settings.longRange
    const w = this.telem?.wind
    if (lr.windSource === 'measured' && w && this.telem?.connected) return { dir: Math.round(w.dir / 5) * 5 % 360, speed: Math.round(w.speed * 2) / 2 }
    return lr.wind
  }

  /** Energia que resta a bordo (Wh ou L), pela telemetria; null se não der para saber. */
  energyLeft(): number | null {
    const t = this.telem
    const p = this.settings.longRange.perf
    if (!t?.connected) return null
    if (p.energy === 'battery') return t.battery.remaining >= 0 ? (t.battery.remaining / 100) * p.capacity : null
    const f = this.fuel()
    return f ? f.liters ?? (f.pct / 100) * p.capacity : null
  }

  /**
   * Combustível a bordo: % do tanque (FUEL do script ou consumo da EFI com o tanque de Configurar →
   * Motor), litros (FUEL_L, ou o % sobre o tanque conhecido), consumo e autonomia; null sem leitura.
   */
  fuel(): { pct: number; liters: number | null; flowLph: number | null; endurance: number | null; reservePct: number | null } | null {
    const t = this.telem
    if (!t?.connected || !t.propulsion) return null
    const pct = fuelPercent(t.propulsion, this.settings.engine)
    if (pct === null) return null
    const lr = this.settings.longRange.perf
    const named = t.propulsion.named.FUEL_L
    const tank = this.settings.engine.tankL > 0 ? this.settings.engine.tankL : lr.energy === 'fuel' ? lr.capacity : 0
    const liters = named !== undefined ? named : tank > 0 ? (pct / 100) * tank : null
    const cm3min = t.propulsion.efi?.fuel_flow
    const flowLph = cm3min != null && cm3min > 0 ? cm3min * 0.06 : null
    const endurance = liters !== null && flowLph ? (liters / flowLph) * 3600 : null
    const reservePct = lr.energy === 'fuel' && lr.capacity > 0 ? Math.min(100, (reserveEnergy(lr) / lr.capacity) * 100) : null
    return { pct, liters, flowLph, endurance, reservePct }
  }

  /** Navlog do plano em edição (ou da missão no veículo), refeito só quando algo muda. */
  navlog(items: MissionItem[] = this.view === 'plan' || !this.onVehicle.length ? this.plan : this.onVehicle): Navlog | null {
    const t = this.telem
    const home = t?.home
    if (!home || !items.length) return null
    const lr = this.settings.longRange
    const w = this.wind()
    const key = [items === this.plan ? 'p' : 'v', this.version('mission'), JSON.stringify(lr), this.charts?.id, home.lat, home.lon, home.alt, w.dir, w.speed, this.settings.landAtEnd].join('|')
    if (this.navMemo.key !== key) {
      this.navMemo = {
        key,
        v: computeNavlog({
          home, points: items.map((p, i) => ({ ...p, name: p.name ?? wpName(i) })), altMsl: lr.altMsl, perf: lr.perf, wind: w,
          charts: this.charts, returnHome: !lr.oneWay, radio: lr.radioKm * 1000, mode: lr.speedMode,
        }),
      }
    }
    return this.navMemo.v
  }

  /** Navegação em voo: próximo ponto, destino, volta ao home e margem de energia. */
  live(): Live | null {
    const t = this.telem
    if (!t?.connected || !t.lat) return null
    const route = this.onVehicle.map((w, i) => ({ ...w, name: w.name ?? wpName(i) }))
    return liveNav({
      pos: t, altMsl: t.alt_msl, mode: this.settings.longRange.speedMode, perf: this.settings.longRange.perf, wind: this.wind(), home: t.home, left: this.energyLeft(),
      burnNow: this.burnAvg, route, active: this.activeWaypoint(),
    })
  }

  /** Consumo medido e o aviso de "bingo" (energia só para voltar), uma vez por segundo. */
  private checkEnergy(t: Telemetry) {
    const p = this.settings.longRange.perf
    const now = performance.now()
    let burn: number | null = null
    if (p.energy === 'battery' && t.battery.current > 0.5) burn = t.battery.voltage * t.battery.current
    const flow = t.propulsion?.efi?.fuel_flow
    if (p.energy === 'fuel' && flow != null && flow > 0) burn = flow * 0.06 // cm³/min → L/h
    if (burn !== null && t.armed) this.burnAvg = this.burnAvg === null ? burn : this.burnAvg + (burn - this.burnAvg) * 0.02
    if (!t.armed) this.burnAvg = null
    if (now - this.lastLiveAt < 1000) return
    this.lastLiveAt = now
    const airborne = t.armed && (t.alt_rel > 2 || t.groundspeed > 5)
    const m = airborne ? this.live()?.margin ?? null : null
    if (m === null) {
      this.bingo = false
      return
    }
    if (m < 0 && !this.bingo) {
      this.bingo = true
      this.addLog('error', tr('BINGO: a energia que resta só dá para voltar ao home agora (com a reserva). Retorne.'))
    } else if (m > 0.03 * p.capacity && this.bingo) {
      this.bingo = false
    }
  }

  /** Motor/bateria fora da faixa com o veículo armado: avisa no log (vermelho também no aviso da tela). */
  private checkEngine(t: Telemetry) {
    if (!t.connected || !t.armed || !t.propulsion) return this.engineAlerts.reset()
    for (const i of this.engineAlerts.update(issues(buildPanel(t, this.settings.engine)), Date.now())) {
      this.addLog(i.level === 'crit' ? 'error' : 'warn', tr('Motor: {text}', { text: i.text }))
    }
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
    this.checkEngine(t)
    this.checkEnergy(t)
    // Piloto automático desligou sem o operador pedir: alarme sonoro, como no avião.
    if (prev?.ap?.engaged && t.ap && !t.ap.engaged && t.ap.message) {
      this.apOffAt = Date.now()
      this.apOpen = true
      this.apAlarm()
      this.emit('ui')
    }
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

  // ---------- controle de videogame ----------
  /** Lê o controle a 20 Hz. A Gamepad API não tem eventos de eixo: só consultando. */
  startPad() {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function' || this.padLastTick) return
    addEventListener('gamepadconnected', (e) => this.addLog('ok', tr('Controle conectado: {id}', { id: (e as GamepadEvent).gamepad.id })))
    addEventListener('gamepaddisconnected', (e) => this.addLog(this.padActive ? 'error' : 'warn', tr('Controle desconectado: {id}', { id: (e as GamepadEvent).gamepad.id })))
    this.padLastTick = performance.now()
    setInterval(() => this.padTick(), 50)
  }

  private padTick() {
    const now = performance.now()
    const dt = Math.min(0.2, (now - this.padLastTick) / 1000)
    this.padLastTick = now
    const s = this.settings.gamepad
    const t = this.telem
    const cls = vehicleClass(t)
    const had = this.pad
    const p = pickPad(navigator.getGamepads(), s.id)
    this.pad = p
    // Sem foco, o navegador congela as leituras: manda sticks neutros até voltar.
    const focused = !document.hidden && document.hasFocus()
    const armedManual = !!t?.connected && t.armed && MANUAL_MODES[cls].has(t.mode) && !this.replay
    let sending = false
    if (p && s.enabled && focused) {
      this.padUnfocusedWarned = false
      for (const a of this.padButtons.update(p.buttons.map((b) => b.pressed), s.buttons, now)) this.padAction(a)
      this.padHold = this.padButtons.holdProgress(s.buttons, now)
      if (!t?.armed) this.padHeld = 0
      const r = readManual(p, s, cls, this.padHeld, dt)
      this.padHeld = r.held
      this.padOut = r.m
      if (armedManual) {
        sending = true
        if (now - this.padLastSend >= 100) {
          this.send({ cmd: 'manual', ...r.m }, true)
          this.padLastSend = now
          this.padLastZ = r.m.z
        }
      }
    } else {
      this.padButtons.reset()
      this.padHold = null
      this.padOut = null
      if (p && s.enabled && !focused && this.padActive) {
        // Controle ainda conectado: segura o veículo parado em vez de largar o comando.
        sending = armedManual
        if (!this.padUnfocusedWarned) this.addLog('warn', tr('Janela sem foco: mandando sticks neutros pelo controle'))
        this.padUnfocusedWarned = true
        if (sending && now - this.padLastSend >= 100) this.sendNeutral(cls, now)
      }
    }
    if (this.padActive && !sending) {
      this.padNeutral = 10
      if (!p && t?.armed) this.addLog('error', tr('Controle perdido em voo: sticks neutros por 1 s; depois o veículo volta ao rádio ou ao failsafe'))
    }
    if (!sending && this.padNeutral > 0 && now - this.padLastSend >= 100) {
      this.padNeutral--
      if (t?.armed) this.sendNeutral(cls, now)
    }
    this.padActive = sending
    if ((p || had) && now - this.padLastEmit >= 100) {
      this.padLastEmit = now
      this.emit('pad')
    }
  }

  /** Sticks no centro; o acelerador fica onde estava quando ele não volta sozinho para o meio. */
  private sendNeutral(cls: ReturnType<typeof vehicleClass>, now: number) {
    const mode = effectiveThrottle(this.settings.gamepad, cls)
    const z = mode === 'center' || (mode === 'triggers' && cls !== 'plane') ? 0.5 : this.padLastZ
    this.send({ cmd: 'manual', x: 0, y: 0, z, r: 0 }, true)
    this.padLastSend = now
  }

  private padAction(a: PadAction) {
    const t = this.telem
    if (!t?.connected || this.replay) return
    const cls = vehicleClass(t)
    const mode = (m: string) => this.send({ cmd: 'mode', mode: m })
    const gimbal = (pitch: number) => {
      this.gimbalPitch = Math.max(-90, Math.min(20, pitch))
      this.send({ cmd: 'gimbal', pitch: this.gimbalPitch })
      this.emit('ui')
    }
    switch (a) {
      case 'arm':
        if (!t.armed) this.send({ cmd: 'arm', arm: true })
        else if (t.alt_rel < 0.5 && t.groundspeed < 1) this.send({ cmd: 'arm', arm: false })
        else this.addLog('warn', tr('Controle: em voo não desarma; pouse primeiro'))
        break
      case 'rtl': mode('RTL'); break
      case 'land':
        if (cls === 'copter' || cls === 'heli') mode('LAND')
        else if (cls === 'vtol') mode('QLAND')
        else this.addLog('warn', tr('Avião: para pousar, use Retornar ou uma missão com pouso'))
        break
      case 'pause': mode(cls === 'rover' ? 'HOLD' : 'LOITER'); break
      case 'photo': this.send({ cmd: 'photo' }); this.stats.photos++; break
      case 'gimbal_up': gimbal(this.gimbalPitch + 10); break
      case 'gimbal_down': gimbal(this.gimbalPitch - 10); break
      case 'gimbal_center': gimbal(0); break
      case 'ap_toggle': {
        const ap = t.ap
        if (ap) this.send({ cmd: 'autopilot', engage: !ap.engaged })
        break
      }
      case 'mode1': case 'mode2': case 'mode3': {
        const m = this.settings.gamepad.modes[cls]?.[+a.slice(4) - 1]
        if (m) mode(m)
        break
      }
      case 'none': break
    }
  }

  /** O piloto automático desligou sozinho há pouco (luz e "AP OFF" piscando). */
  apAlarmOn() {
    return Date.now() - this.apOffAt < 6000
  }

  /** Três toques descendentes (o "cavalry charge" do desligamento do piloto automático). */
  private apAlarm() {
    try {
      const ac = new AudioContext()
      for (let i = 0; i < 3; i++) {
        for (const [f, dt] of [[1400, 0], [1050, 0.12]] as const) {
          const o = ac.createOscillator(), g = ac.createGain()
          const t0 = ac.currentTime + i * 0.36 + dt
          o.type = 'square'
          o.frequency.value = f
          g.gain.setValueAtTime(0.08, t0)
          g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.11)
          o.connect(g).connect(ac.destination)
          o.start(t0)
          o.stop(t0 + 0.12)
        }
      }
      setTimeout(() => ac.close(), 1500)
    } catch {
      /* sem áudio */
    }
  }

  /** Vibra o controle em uso (erros e alertas vermelhos). */
  private rumble() {
    const gp = this.pad ? navigator.getGamepads()[this.pad.index] : null
    const act = (gp as (Gamepad & { vibrationActuator?: { playEffect?: (t: string, p: object) => Promise<unknown> } }) | null)?.vibrationActuator
    act?.playEffect?.('dual-rumble', { duration: 300, strongMagnitude: 0.9, weakMagnitude: 0.5 }).catch(() => {})
  }

  // ---------- log ----------
  addLog(level: LogLevel, text: string) {
    if (level === 'error' && this.padActive) this.rumble()
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
    const lr = this.settings.longRange
    if (this.send({
      cmd: 'mission_upload', items: this.plan, rtl_at_end: !lr.oneWay,
      land_at_end: wing && this.settings.landAtEnd && !lr.oneWay, approach_deg: this.settings.approachDeg, cruise_ms: cruise,
      alt_msl: lr.altMsl, loiter_at_end: lr.oneWay,
    })) {
      this.onVehicle = this.plan.map((p) => ({ ...p }))
      this.upload = { state: 'sending', text: tr('Enviando missão…') }
      this.emit('mission')
    }
  }
  // ---------- geocerca ----------
  startDrawing(kind: 'inclusion' | 'exclusion') {
    this.drawing = { kind, pts: [] }
    this.emit('fence', 'ui')
  }
  addDrawPoint(p: LatLon) {
    if (!this.drawing) return
    this.drawing.pts.push(p)
    this.emit('fence')
  }
  undoDrawPoint() {
    this.drawing?.pts.pop()
    this.emit('fence')
  }
  finishDrawing() {
    const d = this.drawing
    if (d && d.pts.length >= 3) {
      this.fenceDraft[d.kind].push(d.pts)
      this.fenceEdited = true
    }
    this.drawing = null
    this.emit('fence', 'ui')
  }
  cancelDrawing() {
    this.drawing = null
    this.emit('fence', 'ui')
  }
  removeFenceArea(kind: 'inclusion' | 'exclusion' | 'circles_inclusion' | 'circles_exclusion', i: number) {
    this.fenceDraft[kind].splice(i, 1)
    this.fenceEdited = true
    this.emit('fence')
  }
  clearFenceDraft() {
    this.fenceDraft = emptyFence()
    this.fenceEdited = true
    this.emit('fence')
  }
  fenceFromVehicle() {
    this.fenceDraft = structuredClone(this.vehicleFence ?? emptyFence())
    this.fenceEdited = false
    this.emit('fence')
  }
  uploadFence() {
    if (this.send({ cmd: 'fence_upload', fence: this.fenceDraft, enable: true })) {
      this.fenceUpload = { state: 'sending', text: tr('Enviando geocerca…') }
      this.emit('fence')
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
    case 'mission_current': return tr('Direto para o item {seq} da missão', { seq: c.seq })
    case 'goto': return tr('Desviar para {lat}, {lon}', { lat: c.lat.toFixed(4), lon: c.lon.toFixed(4) })
    case 'charts_fetch': return tr('Baixar cartas aeronáuticas')
    case 'charts_get': return tr('Ler cartas da ponte')
    case 'charts_import': return tr('Importar cartas ({n} trechos de aerovia)', { n: c.pack.airways.length })
    case 'charts_clear': return tr('Apagar cartas')
    case 'replay': return c.seek !== undefined ? tr('Reprodução: pular') : c.paused !== undefined ? (c.paused ? tr('Reprodução: pausar') : tr('Reprodução: continuar')) : tr('Reprodução a {speed}×', { speed: c.speed ?? 1 })
    case 'calibrate': return tr('Calibrar: {what}', { what: tr({ accel: tk('acelerômetro (6 posições)'), level: tk('nivelar'), gyro: tk('giroscópio'), compass: tk('bússola'), compass_accept: tk('aceitar bússola'), compass_cancel: tk('cancelar bússola') }[c.kind]) })
    case 'accel_pos': return tr('Calibração: posição {position} pronta', { position: c.position })
    case 'reboot': return tr('Reiniciar controladora')
    case 'fence_upload': return tr('Enviar geocerca ({n} áreas)', { n: c.fence.inclusion.length + c.fence.exclusion.length + c.fence.circles_inclusion.length + c.fence.circles_exclusion.length })
    case 'fence_download': return tr('Ler geocerca do veículo')
    case 'maintenance_get': return tr('Ler registro de manutenção')
    case 'maintenance_config': return tr('Salvar configuração de manutenção')
    case 'maintenance_done': return tr('Tarefa de manutenção feita')
    case 'maintenance_note': return tr('Anotação de manutenção')
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
    case 'autopilot': {
      if (c.engage !== undefined) return c.engage ? tr('Ligar piloto automático') : tr('Desligar piloto automático')
      const parts = [
        c.lateral && c.lateral.toUpperCase(), c.vertical && (c.vertical === 'vs' ? 'V/S' : 'ALT'),
        c.hdg !== undefined && `HDG ${Math.round(c.hdg)}°`, c.alt !== undefined && `ALT SEL ${c.alt} m`,
        c.vs !== undefined && `V/S ${c.vs} m/s`, c.spd !== undefined && `SPD ${c.spd} m/s`, c.spd_on !== undefined && `SPD ${c.spd_on ? 'on' : 'off'}`,
      ].filter(Boolean)
      return tr('Piloto automático: {what}', { what: parts.join(', ') })
    }
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
