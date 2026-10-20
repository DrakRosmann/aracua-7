// Tipos do protocolo com a ponte (ver docs/protocolo.md).

import { t, tk } from './lib/i18n'
import type { FenceData } from './lib/fence'
import type { ChartPack, ChartsInfo } from './lib/charts'

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
  /** Canais do rádio em PWM (µs). */
  rc: number[]
  rc_rssi: number
  msgs_per_sec: number
  msg_stats: Record<string, { count: number; hz: number }>
  /** Motor e energia (ver docs/protocolo.md); ausente em pontes antigas. */
  propulsion?: Propulsion
  /** Piloto automático da ponte (`autopilot` é o nome do firmware); ausente em pontes antigas. */
  ap?: AutopilotState
  /** Vento estimado pelo piloto automático (de onde sopra, graus verdadeiros; m/s). */
  wind?: { dir: number; speed: number; speed_z: number } | null
}

/** Piloto automático estilo avião (ver bridge/src/autopilot.rs). */
export interface AutopilotState {
  engaged: boolean
  lateral: 'hdg' | 'nav'
  vertical: 'alt' | 'vs' | 'nav'
  hdg: number
  alt_sel: number
  alt_hold: number
  vs: number
  spd: number
  spd_on: boolean
  /** Por que desligou sozinho; null se foi o operador. */
  message: string | null
}

export interface AutopilotPatch {
  engage?: boolean
  lateral?: 'hdg' | 'nav'
  vertical?: 'alt' | 'vs'
  hdg?: number
  alt?: number
  vs?: number
  spd?: number
  spd_on?: boolean
}

// ---------- Motor e energia ----------

export interface BatteryPack {
  id: number
  /** all, propulsion, avionics, payload ou unknown. */
  function: string
  voltage: number
  /** A; positiva descarregando, negativa carregando. */
  current: number | null
  consumed_mah: number | null
  energy_wh: number | null
  remaining: number | null
  temperature: number | null
  /** Tensão de cada célula; vazia quando só há o total. */
  cells: number[]
  time_remaining_s: number | null
  charge_state: string
  faults: string[]
  age_ms: number
}

export interface EscTelemetry { n: number; rpm: number; temperature: number; voltage: number; current: number; consumed_mah: number; age_ms: number }

/** EFI_STATUS: injeção de motor a pistão ou ECU de turbina; null = sem leitura. */
export interface EfiStatus {
  healthy: boolean
  ecu_index: number | null
  rpm: number | null
  fuel_consumed: number | null
  fuel_flow: number | null
  engine_load: number | null
  throttle: number | null
  cht: number | null
  egt: number | null
  intake_pressure: number | null
  intake_temperature: number | null
  barometric_pressure: number | null
  ignition_voltage: number | null
  fuel_pressure: number | null
  age_ms: number
}

export interface GeneratorStatus {
  /** Bits de MAV_GENERATOR_STATUS_FLAG ligados (ex.: generating, charging). */
  status: string[]
  rpm: number | null
  battery_current: number | null
  load_current: number | null
  power_w: number | null
  bus_voltage: number
  rectifier_temperature: number | null
  generator_temperature: number | null
  runtime_s: number | null
  maintenance_s: number | null
  age_ms: number
}

export interface Propulsion {
  batteries: BatteryPack[]
  escs: EscTelemetry[]
  efi: EfiStatus | null
  generator: GeneratorStatus | null
  rpm: [number | null, number | null]
  /** NAMED_VALUE_FLOAT/INT de scripts: H2O, CHT2, EGT2, OILT, OILP, FUEL, TURB_ST, PUMP_V… */
  named: Record<string, number>
}

export type ServerMessage =
  | Telemetry
  | { type: 'hello'; bridge: string; version: string; mavlink: string; replay?: boolean; log_file?: string | null }
  | { type: 'statustext'; severity: number; text: string }
  | { type: 'ack'; command: string; result: string }
  | { type: 'param'; id: string; value: number; index: number; count: number }
  | { type: 'mission_upload'; ok: boolean; result: string; count: number; wp_seq?: number[] }
  | { type: 'map_reset' }
  | { type: 'error'; message: string }
  | PayloadState
  | { type: 'payload_release'; event: ReleaseEvent }
  | { type: 'payload_confirm'; event: ReleaseEvent }
  | VehicleMission
  | ReplayState
  | CalibEvent
  | ({ type: 'vehicle_fence' } & FenceData)
  | { type: 'fence_upload'; ok: boolean; result: string; count: number }
  | MaintenanceState
  | ChartsInfo
  | { type: 'charts_status'; step: string; done: number; total: number }
  | ({ type: 'charts' } & ChartPack)

export interface MaintBattery { id: number; name: string; cycles: number; flight_s: number; max_cycles: number; retired: boolean }
export interface MaintTask {
  id: number; name: string; every_h: number; every_flights: number
  since_h: number; since_flights: number; used: number; due: boolean; done_at: number | null
}
export interface MaintFlight { n: number; start: number; duration_s: number; max_alt: number; distance_m: number; battery: number | null; vehicle: string }

/** Registro de manutenção guardado pela ponte. */
export interface MaintenanceState {
  type: 'maintenance'
  airframe: string
  flight_s: number
  flights: number
  arm_cycles: number
  batteries: MaintBattery[]
  active_battery: number | null
  tasks: MaintTask[]
  history: MaintFlight[]
  notes: { t: number; text: string }[]
  flying_s: number | null
}

/** Missão que está no veículo (lida dele ou acabada de enviar). */
export interface VehicleMission {
  type: 'vehicle_mission'
  items: MissionItem[]
  wp_seq: number[]
  rtl_at_end: boolean
  land_at_end: boolean
  ignored: number
  count: number
  /** Termina circulando sobre o último waypoint (voo só de ida). */
  loiter_at_end?: boolean
  /** Altitudes acima do nível do mar. */
  alt_msl?: boolean
}

export interface ReplayState {
  type: 'replay'
  file: string
  t: number
  duration: number
  speed: number
  paused: boolean
}

export type CalibEvent =
  | { type: 'calib'; kind: 'accel'; status: 'position' | 'success' | 'failed'; position: number }
  | { type: 'calib'; kind: 'compass'; compass: number; pct: number; attempt: number; status: string }
  | { type: 'calib'; kind: 'compass_report'; compass: number; fitness: number; autosaved: boolean; status: string }

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
  /** Nome do fixo ou aeródromo (rota por aerovias); só na estação, o veículo não guarda. */
  name?: string
  /** Aerovia (ou DCT) pela qual se chega ao ponto; só na estação. */
  via?: string
}

export type ClientCommand =
  | { cmd: 'arm'; arm: boolean; force?: boolean }
  | { cmd: 'mode'; mode: string }
  | { cmd: 'takeoff'; alt: number; force?: boolean }
  | { cmd: 'mission_upload'; items: MissionItem[]; rtl_at_end?: boolean; land_at_end?: boolean; approach_deg?: number | null; cruise_ms?: number; alt_msl?: boolean; loiter_at_end?: boolean }
  | { cmd: 'mission_current'; seq: number }
  | { cmd: 'goto'; lat: number; lon: number; alt?: number }
  | { cmd: 'charts_fetch'; url?: string }
  | { cmd: 'charts_get' }
  | { cmd: 'charts_import'; pack: ChartPack }
  | { cmd: 'charts_clear' }
  | { cmd: 'mission_download' }
  | { cmd: 'mission_start'; force?: boolean }
  | { cmd: 'replay'; speed?: number; paused?: boolean; seek?: number }
  | { cmd: 'calibrate'; kind: 'accel' | 'level' | 'gyro' | 'compass' | 'compass_accept' | 'compass_cancel' }
  | { cmd: 'accel_pos'; position: number }
  | { cmd: 'reboot' }
  | { cmd: 'fence_upload'; fence: FenceData; enable?: boolean }
  | { cmd: 'fence_download' }
  | { cmd: 'maintenance_get' }
  | { cmd: 'maintenance_config'; airframe: string; batteries: Omit<MaintBattery, 'flight_s'>[]; active_battery: number | null; tasks: Pick<MaintTask, 'id' | 'name' | 'every_h' | 'every_flights'>[] }
  | { cmd: 'maintenance_done'; task: number; note?: string }
  | { cmd: 'maintenance_note'; text: string }
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
  | ({ cmd: 'autopilot' } & AutopilotPatch)

// ---------- Tipos de veículo e modos de voo ----------

/** copter = multirrotor e heli = helicóptero (ArduCopter); plane e vtol (ArduPlane); rover (ArduRover). */
export type VehicleClass = 'copter' | 'heli' | 'plane' | 'vtol' | 'rover'

export const CLASS_LABEL: Record<VehicleClass, string> = {
  copter: tk('Multirrotor'),
  heli: tk('Helicóptero'),
  plane: tk('Avião'),
  vtol: tk('VTOL'),
  rover: tk('Terrestre'),
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
  STABILIZE: tk('Estabilizado'),
  ALT_HOLD: tk('Altitude'),
  LOITER: tk('Posição'),
  POSHOLD: tk('PosHold'),
  GUIDED: tk('Guiado'),
  AUTO: tk('Missão'),
  RTL: tk('Retornar'),
  LAND: tk('Pouso'),
  BRAKE: tk('Freio'),
  SMART_RTL: tk('Retorno inteligente'),
  MANUAL: tk('Manual'),
  ACRO: tk('Acro'),
  TRAINING: tk('Treino'),
  FBWA: tk('Assistido (FBWA)'),
  FBWB: tk('Altitude (FBWB)'),
  CRUISE: tk('Cruzeiro'),
  CIRCLE: tk('Círculo'),
  TAKEOFF: tk('Decolagem'),
  QSTABILIZE: tk('Q Estabilizado'),
  QHOVER: tk('Q Pairar'),
  QLOITER: tk('Q Posição'),
  QLAND: tk('Q Pouso'),
  QRTL: tk('Q Retornar'),
  HOLD: tk('Parado'),
  STEERING: tk('Direção'),
}

/** Nome do modo para mostrar. LOITER no avião é circular, não pairar. */
export function modeLabel(mode: string, cls: VehicleClass): string {
  if (mode === 'LOITER' && (cls === 'plane' || cls === 'vtol')) return t('Circular')
  if (mode === 'LOITER' && cls === 'rover') return t('Segurar posição')
  return MODE_LABEL[mode] ? t(MODE_LABEL[mode]) : mode
}

export function classLabel(cls: VehicleClass): string {
  return t(CLASS_LABEL[cls])
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
