// Integração com o aplicativo desktop (Tauri). No navegador nada disso roda:
// a ponte é iniciada à mão e a interface só conecta no WebSocket.

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export type LinkConfig =
  | { kind: 'simulator'; lat?: number; lon?: number }
  | { kind: 'serial'; port: string; baud: number }
  | { kind: 'udp'; listen: string }
  | { kind: 'tcp'; address: string }

export interface LinkStatus {
  running: boolean
  config: LinkConfig | null
  exit_code: number | null
  bridge_url: string
  log: string[]
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
}

export function describeLink(c: LinkConfig | null): string {
  if (!c) return 'desconectado'
  switch (c.kind) {
    case 'simulator': return 'Simulador'
    case 'serial': return `Rádio ${c.port} · ${c.baud}`
    case 'udp': return `UDP ${c.listen}`
    case 'tcp': return `TCP ${c.address}`
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
