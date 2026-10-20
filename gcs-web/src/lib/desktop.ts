// Integração com o aplicativo desktop (Tauri). No navegador nada disso roda:
// a ponte é iniciada à mão e a interface só conecta no WebSocket.

import { t as tr, tk } from './i18n'

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export type SimVehicle = 'copter' | 'heli' | 'plane' | 'vtol'

export const SIM_VEHICLES: { id: SimVehicle; label: string }[] = [
  { id: 'copter', label: tk('Multirrotor') },
  { id: 'heli', label: tk('Helicóptero') },
  { id: 'plane', label: tk('Avião') },
  { id: 'vtol', label: tk('VTOL') },
]

export type SimPropulsion = 'electric' | 'combustion' | 'jet' | 'hybrid'

export const SIM_PROPULSION: { id: SimPropulsion; label: string }[] = [
  { id: 'electric', label: tk('Elétrico') },
  { id: 'combustion', label: tk('Combustão') },
  { id: 'jet', label: tk('Turbina') },
  { id: 'hybrid', label: tk('Híbrido') },
]

export type SimAirframe = 'small' | 'piston' | 'jet' | 'supersonic' | 'hypersonic'

/** Aeronaves do simulador (avião); as grandes têm o motor delas e casam com os perfis de longo alcance. */
export const SIM_AIRFRAMES: { id: SimAirframe; label: string }[] = [
  { id: 'small', label: tk('Pequeno') },
  { id: 'piston', label: tk('Pistão, longo alcance') },
  { id: 'jet', label: tk('Jato M0,78') },
  { id: 'supersonic', label: tk('Supersônico M2') },
  { id: 'hypersonic', label: tk('Hipersônico M6') },
]

export type LinkConfig =
  | { kind: 'simulator'; lat?: number; lon?: number; vehicle?: SimVehicle; propulsion?: SimPropulsion; airframe?: SimAirframe; time_scale?: number }
  | { kind: 'serial'; port: string; baud: number }
  | { kind: 'udp'; listen: string }
  | { kind: 'tcp'; address: string }
  | { kind: 'replay'; file: string }

export interface LinkStatus {
  running: boolean
  config: LinkConfig | null
  exit_code: number | null
  bridge_url: string
  /** Vídeo da câmera do simulador, quando ele está rodando. */
  camera_url?: string | null
  log: string[]
}

export interface FlightLog {
  name: string
  path: string
  bytes: number
  /** Segundos desde 1970. */
  modified: number
}

export interface PortInfo {
  name: string
  description: string
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

export const desktop = {
  serialPorts: () => call<PortInfo[]>('serial_ports'),
  start: (config: LinkConfig) => call<LinkStatus>('start_link', { config }),
  stop: () => call<LinkStatus>('stop_link'),
  status: () => call<LinkStatus>('link_status'),
  logs: () => call<FlightLog[]>('list_logs'),
}

export function describeLink(c: LinkConfig | null): string {
  if (!c) return tr('desconectado')
  switch (c.kind) {
    case 'simulator': {
      const big = c.airframe && c.airframe !== 'small' ? SIM_AIRFRAMES.find((a) => a.id === c.airframe) : null
      const what = big ? tr(big.label) : `${tr(SIM_VEHICLES.find((v) => v.id === (c.vehicle ?? 'copter'))?.label ?? '')} · ${tr(SIM_PROPULSION.find((p) => p.id === (c.propulsion ?? 'electric'))?.label ?? '')}`
      return `${tr('Simulador')} · ${what}${c.time_scale && c.time_scale > 1 ? ` · ${c.time_scale}×` : ''}`
    }
    case 'serial': return `${tr('Rádio')} ${c.port} · ${c.baud}`
    case 'udp': return `UDP ${c.listen}`
    case 'tcp': return `TCP ${c.address}`
    case 'replay': return `${tr('Reprodução')} · ${c.file.split(/[\\/]/).pop()}`
  }
}

const KEY = 'aracua.link'

export function savedLink(): LinkConfig | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as LinkConfig) : null
  } catch {
    return null
  }
}

export function saveLink(c: LinkConfig) {
  try {
    localStorage.setItem(KEY, JSON.stringify(c))
  } catch {
    /* sem armazenamento: só não lembra na próxima vez */
  }
}
