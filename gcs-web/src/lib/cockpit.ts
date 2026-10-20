// Aba Painel: layouts de instrumentos que o operador troca como num painel de avião
// e as luzes de alerta (CAS). Funções puras; a tela fica em components/Cockpit.tsx.

import { tk } from './i18n'
import { buildPanel, issues, type EngineSettings } from './engine'
import type { Telemetry } from '../types'

export type InstrumentId =
  | 'pfd' | 'nd' | 'camera' | 'hud' | 'ems' | 'fuel' | 'asi' | 'adi' | 'alt' | 'vsi' | 'turn' | 'dg' | 'radar' | 'data' | 'none'

export const INSTRUMENT_LABEL: Record<InstrumentId, string> = {
  pfd: tk('PFD: horizonte, fitas e rumo'),
  nd: tk('HSI / navegação'),
  camera: tk('Câmera'),
  hud: tk('Câmera com HUD'),
  ems: tk('Motor (EMS)'),
  fuel: tk('Combustível'),
  asi: tk('Velocímetro'),
  adi: tk('Horizonte artificial'),
  alt: tk('Altímetro'),
  vsi: tk('Variômetro'),
  turn: tk('Indicador de curva'),
  dg: tk('Giro direcional'),
  radar: tk('Radar LiDAR'),
  data: tk('Dados de voo'),
  none: tk('Vazio'),
}

export type LayoutId = 'g1' | 'g2' | 'g3' | 'g4' | 'g5' | 'g6'

/** Áreas do CSS grid de cada layout; a ordem das letras é a ordem dos espaços. */
export const LAYOUTS: Record<LayoutId, { label: string; areas: string[]; cols: string; rows: string }> = {
  g1: { label: tk('Uma tela'), areas: ['a'], cols: '1fr', rows: '1fr' },
  g2: { label: tk('Duas telas'), areas: ['a b'], cols: '1fr 1fr', rows: '1fr' },
  g3: { label: tk('Grande + duas'), areas: ['a b', 'a c'], cols: '1.45fr 1fr', rows: '1fr 1fr' },
  g4: { label: tk('Quatro telas'), areas: ['a b', 'c d'], cols: '1fr 1fr', rows: '1fr 1fr' },
  g5: { label: tk('Glass cockpit (PFD, MFD e três)'), areas: ['a a b b', 'c d e e'], cols: '1fr 1fr 1fr 1fr', rows: '1.5fr 1fr' },
  g6: { label: tk('Seis instrumentos (clássico)'), areas: ['a b c', 'd e f'], cols: '1fr 1fr 1fr', rows: '1fr 1fr' },
}

export const slotCount = (l: LayoutId) => new Set(LAYOUTS[l].areas.join(' ').split(' ')).size

export interface CockpitSettings {
  layout: LayoutId
  /** Instrumento de cada espaço, guardado por layout (trocar de layout e voltar não perde nada). */
  slots: Record<LayoutId, InstrumentId[]>
  /** Glareshield com o painel do piloto automático em cima. */
  mcp: boolean
  /** Faixa de luzes de alerta embaixo. */
  cas: boolean
}

export const DEFAULT_COCKPIT: CockpitSettings = {
  layout: 'g3',
  slots: {
    g1: ['hud'],
    g2: ['pfd', 'camera'],
    g3: ['pfd', 'camera', 'nd'],
    g4: ['pfd', 'nd', 'camera', 'ems'],
    g5: ['pfd', 'camera', 'ems', 'radar', 'nd'],
    g6: ['asi', 'adi', 'alt', 'turn', 'dg', 'vsi'],
  },
  mcp: true,
  cas: true,
}

/** Instrumentos do layout, completando com os padrões se a configuração salva for mais curta. */
export function slotsOf(s: CockpitSettings, l: LayoutId = s.layout): InstrumentId[] {
  const n = slotCount(l)
  const saved = s.slots[l] ?? []
  return Array.from({ length: n }, (_, i) => (saved[i] && saved[i] in INSTRUMENT_LABEL ? saved[i] : DEFAULT_COCKPIT.slots[l][i] ?? 'none'))
}

export function setSlot(s: CockpitSettings, i: number, id: InstrumentId): CockpitSettings {
  const cur = slotsOf(s)
  cur[i] = id
  return { ...s, slots: { ...s.slots, [s.layout]: cur } }
}

// ---------- Luzes de alerta (CAS) ----------

export type Light = 'off' | 'ok' | 'warn' | 'crit'
export interface Annunciator { id: string; text: string; light: Light; title: string }

/** Painel de luzes, como os anunciadores de cabine: apagada = normal ou não se aplica. */
export function annunciators(t: Telemetry | null, o: { engine: EngineSettings; nearest: number; fenceOn: boolean | null; apOff: boolean }): Annunciator[] {
  const a = (id: string, text: string, light: Light, title: string): Annunciator => ({ id, text, light, title })
  if (!t?.connected) return [a('link', 'LINK', 'crit', tk('Sem conexão com o veículo'))]
  const out: Annunciator[] = []
  out.push(a('arm', t.armed ? 'ARMED' : 'SAFE', t.armed ? 'warn' : 'ok', t.armed ? tk('Motores armados') : tk('Motores desarmados')))
  const link = t.heartbeat_age_ms > 1500 || t.drop_rate_comm > 10 ? 'crit' : t.drop_rate_comm > 3 ? 'warn' : 'off'
  out.push(a('link', 'LINK', link, tk('Enlace de telemetria: atraso do HEARTBEAT e perda no veículo')))
  const gps = t.gps.fix_type < 3 ? 'crit' : t.gps.sats < 8 || t.gps.hdop > 2 ? 'warn' : 'off'
  out.push(a('gps', 'GPS', gps, tk('GPS: fix 3D, satélites e HDOP')))
  const rem = t.battery.remaining
  const bat = rem >= 0 && rem <= 15 ? 'crit' : rem >= 0 && rem <= 30 ? 'warn' : 'off'
  out.push(a('bat', 'BATT', bat, tk('Carga da bateria')))
  out.push(a('sens', 'SENS', t.sensors_healthy ? 'off' : 'crit', tk('Sensores do piloto automático (SYS_STATUS)')))
  const vib = Math.max(...t.vibration)
  out.push(a('vib', 'VIBR', vib > 60 ? 'crit' : vib > 30 ? 'warn' : 'off', tk('Vibração (m/s²)')))
  const eng = t.propulsion ? issues(buildPanel(t, o.engine)) : []
  out.push(a('eng', 'ENG', eng.some((i) => i.level === 'crit') ? 'crit' : eng.length ? 'warn' : 'off', tk('Motor fora da faixa (painel do motor)')))
  // Leituras abaixo de 20 cm são inválidas (sensor encostado ou sem retorno).
  const near = o.nearest > 0.2 ? o.nearest : Infinity
  out.push(a('avoid', 'PROX', near < 6 ? 'crit' : near < 12 ? 'warn' : 'off', tk('Obstáculo perto (LiDAR)')))
  if (o.fenceOn !== null) out.push(a('fence', 'FENCE', o.fenceOn ? 'ok' : 'off', tk('Geocerca ligada')))
  const ap = t.ap
  if (ap) out.push(a('ap', 'A/P', ap.engaged ? 'ok' : o.apOff ? 'crit' : 'off', tk('Piloto automático')))
  return out
}
