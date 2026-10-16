// Tipos do protocolo com a ponte (ver docs/protocolo.md).

export interface Telemetry {
  type: 'telemetry'
  t: number
  connected: boolean
  heartbeat_age_ms: number
  system_id: number
  autopilot: string
  vehicle_type: string
  /** Classe usada para escolher modos e comandos (ver VehicleClass). */
  vehicle_class: VehicleClass
  armed: boolean
  mode: string
  custom_mode: number
  system_status: string
  lat: number
  lon: number
  alt_msl: number
  alt_rel: number
  heading: number
  roll: number
  pitch: number
  yaw: number
  roll_rate: number
  pitch_rate: number
  yaw_rate: number
  vn: number
  ve: number
  vd: number
  groundspeed: number
  airspeed: number
  climb: number
  throttle: number
  battery: { voltage: number; current: number; remaining: number; consumed_mah: number }
  gps: { fix_type: number; fix: string; sats: number; hdop: number }
  home: { lat: number; lon: number; alt: number } | null
  rangefinder: number | null
  vibration: [number, number, number]
  clipping: [number, number, number]
  radio: { rssi: number; remrssi: number; noise: number; remnoise: number; rxerrors: number; fixed: number } | null
  drop_rate_comm: number
  sensors_healthy: boolean
  mission_current: number
  mission_count: number
  msgs_per_sec: number
  msg_stats: Record<string, { count: number; hz: number }>
}

export type ServerMessage =
  | Telemetry
  | { type: 'hello'; bridge: string; version: string; mavlink: string }
  | { type: 'statustext'; severity: number; text: string }
  | { type: 'ack'; command: string; result: string }
  | { type: 'param'; id: string; value: number; index: number; count: number }
  | { type: 'mission_upload'; ok: boolean; result: string; count: number; wp_seq?: number[] }
  | { type: 'map_reset' }
  | { type: 'error'; message: string }
  | PayloadState
  | { type: 'payload_release'; event: ReleaseEvent }
  | { type: 'payload_confirm'; event: ReleaseEvent }

// ---------- Sistema de entrega ----------

export type Actuator =
  | { type: 'servo'; channel: number; pwm_locked: number; pwm_released: number }
  | { type: 'relay'; relay: number }

export interface PayloadSlot {
  id: number
  name: string
  actuator: Actuator
  /** Bit da chave de confirmação (0–5 na placa); null = sem chave. */
  switch_bit: number | null
  mass_g: number
  enabled: boolean
  loaded: boolean
  releases: number
  /** Estado lido da chave: true = pino travado; null = sem leitura. */
  switch_locked?: boolean | null
  pwm?: number | null
}

export interface PayloadSettings {
  countdown_s: number
  min_alt_m: number
  require_armed: boolean
  relock_s: number
  salvo_interval_s: number
  mission_hold_s: number
}

export interface ReleaseEvent {
  n: number
  slot: number
  name: string
  t: number
  lat: number
  lon: number
  alt_rel: number
  groundspeed: number
  mass_g: number
  source: string
  confirmed: boolean | null
}

export interface PayloadState {
  type: 'payload'
  armed: boolean
  slots: PayloadSlot[]
  settings: PayloadSettings
  total: number
  loaded: number
  onboard_g: number
  switches_ok: boolean
  countdown: { slots: number[]; remaining_ms: number; total_ms: number } | null
  message: string | null
  log: ReleaseEvent[]
}

export interface MissionItem {
  lat: number
  lon: number
  alt: number
  /** Compartimentos de entrega soltos neste ponto. */
  drop?: number[]
}

export type ClientCommand =
  | { cmd: 'arm'; arm: boolean; force?: boolean }
  | { cmd: 'mode'; mode: string }
  | { cmd: 'takeoff'; alt: number }
  | { cmd: 'mission_upload'; items: MissionItem[]; rtl_at_end?: boolean }
  | { cmd: 'mission_start' }
  | { cmd: 'manual'; x: number; y: number; z: number; r: number }
  | { cmd: 'param_get'; id: string }
  | { cmd: 'param_set'; id: string; value: number }
  | { cmd: 'photo' }
  | { cmd: 'gimbal'; pitch: number; yaw?: number }
  | { cmd: 'map_reset' }
  | { cmd: 'payload_arm'; arm: boolean }
  | { cmd: 'payload_release'; slots: number[] }
  | { cmd: 'payload_abort' }
  | { cmd: 'payload_lock'; slot: number }
  | { cmd: 'payload_test'; slot: number }
  | { cmd: 'payload_loaded'; slot: number; loaded: boolean }
  | { cmd: 'payload_config'; slots: PayloadSlot[]; settings: PayloadSettings }
  | { cmd: 'payload_reset_counter' }
  | { cmd: 'payload_get' }

// ---------- Tipos de veículo e modos de voo ----------

/** copter = multirrotor e heli = helicóptero (ArduCopter); plane e vtol (ArduPlane); rover (ArduRover). */
export type VehicleClass = 'copter' | 'heli' | 'plane' | 'vtol' | 'rover'

export const CLASS_LABEL: Record<VehicleClass, string> = {
  copter: 'Multirrotor',
  heli: 'Helicóptero',
  plane: 'Avião',
  vtol: 'VTOL',
  rover: 'Terrestre',
}

const COPTER_MENU = ['STABILIZE', 'ALT_HOLD', 'LOITER', 'POSHOLD', 'GUIDED', 'AUTO', 'RTL', 'LAND', 'BRAKE']
const PLANE_MENU = ['MANUAL', 'STABILIZE', 'FBWA', 'FBWB', 'CRUISE', 'TAKEOFF', 'LOITER', 'CIRCLE', 'GUIDED', 'AUTO', 'RTL']

/** Modos oferecidos no menu, por tipo de veículo (os nomes são os do firmware). */
export const MODES_BY_CLASS: Record<VehicleClass, string[]> = {
  copter: COPTER_MENU,
  heli: COPTER_MENU,
  plane: PLANE_MENU,
  vtol: [...PLANE_MENU, 'QSTABILIZE', 'QHOVER', 'QLOITER', 'QLAND', 'QRTL'],
  rover: ['MANUAL', 'ACRO', 'STEERING', 'HOLD', 'LOITER', 'GUIDED', 'AUTO', 'RTL'],
}

const COPTER_MANUAL = ['STABILIZE', 'ALT_HOLD', 'LOITER', 'POSHOLD']
const PLANE_MANUAL = ['MANUAL', 'STABILIZE', 'FBWA', 'FBWB', 'CRUISE', 'ACRO', 'TRAINING']

/** Modos em que os sticks virtuais comandam o veículo. */
export const MANUAL_MODES: Record<VehicleClass, Set<string>> = {
  copter: new Set(COPTER_MANUAL),
  heli: new Set(COPTER_MANUAL),
  plane: new Set(PLANE_MANUAL),
  vtol: new Set([...PLANE_MANUAL, 'QSTABILIZE', 'QHOVER', 'QLOITER']),
  rover: new Set(['MANUAL', 'ACRO', 'STEERING']),
}

const MODE_LABEL: Record<string, string> = {
  STABILIZE: 'Estabilizado',
  ALT_HOLD: 'Altitude',
  LOITER: 'Posição',
  POSHOLD: 'PosHold',
  GUIDED: 'Guiado',
  AUTO: 'Missão',
  RTL: 'Retornar',
  LAND: 'Pouso',
  BRAKE: 'Freio',
  SMART_RTL: 'Retorno inteligente',
  MANUAL: 'Manual',
  ACRO: 'Acro',
  TRAINING: 'Treino',
  FBWA: 'Assistido (FBWA)',
  FBWB: 'Altitude (FBWB)',
  CRUISE: 'Cruzeiro',
  CIRCLE: 'Círculo',
  TAKEOFF: 'Decolagem',
  QSTABILIZE: 'Q Estabilizado',
  QHOVER: 'Q Pairar',
  QLOITER: 'Q Posição',
  QLAND: 'Q Pouso',
  QRTL: 'Q Retornar',
  HOLD: 'Parado',
  STEERING: 'Direção',
}

/** Nome do modo para mostrar. LOITER no avião é circular, não pairar. */
export function modeLabel(mode: string, cls: VehicleClass): string {
  if (mode === 'LOITER' && (cls === 'plane' || cls === 'vtol')) return 'Circular'
  if (mode === 'LOITER' && cls === 'rover') return 'Segurar posição'
  return MODE_LABEL[mode] ?? mode
}

export function vehicleClass(t: Telemetry | null | undefined): VehicleClass {
  return t?.vehicle_class ?? 'copter'
}

export type LogLevel = 'info' | 'ok' | 'warn' | 'error' | 'cmd'
export interface LogEntry {
  t: number
  level: LogLevel
  text: string
}

export interface Sample {
  t: number
  alt: number
  gs: number
  bat: number
  vib: number
  link: number
  obs: number
}
