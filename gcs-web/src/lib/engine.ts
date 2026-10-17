// Painel do motor: o que mostrar para cada tipo de propulsão (elétrico, combustão,
// turbina), as faixas verde/amarela/vermelha de cada grandeza e os alertas.
// Funções puras: a tela (EnginePanel) e a loja (alertas no log) usam as mesmas.

import { t, tk } from './i18n'
import type { BatteryPack, GeneratorStatus, Propulsion, Telemetry } from '../types'

export type EngineKind = 'electric' | 'combustion' | 'jet'
export type Level = 'ok' | 'warn' | 'crit' | 'none'

/** Escala do mostrador e limites; null = sem esse limite. */
export interface Limit {
  min: number
  max: number
  redLo: number | null
  yelLo: number | null
  yelHi: number | null
  redHi: number | null
}

const L = (min: number, max: number, redLo: number | null, yelLo: number | null, yelHi: number | null, redHi: number | null): Limit =>
  ({ min, max, redLo, yelLo, yelHi, redHi })

/** Grandezas com faixas configuráveis em Configurar → Motor. */
export const LIMIT_DEFS = {
  rpm: { label: tk('Rotação do motor'), unit: 'rpm', def: L(0, 7000, null, null, 6200, 6500) },
  n1: { label: tk('Rotação N1 da turbina'), unit: 'rpm', def: L(0, 130_000, null, null, 120_000, 125_000) },
  cht: { label: tk('Temperatura do cabeçote (CHT)'), unit: '°C', def: L(0, 300, null, 80, 220, 250) },
  egt: { label: tk('Temperatura do escape (EGT)'), unit: '°C', def: L(0, 900, null, null, 760, 820) },
  egtJet: { label: tk('EGT da turbina'), unit: '°C', def: L(0, 900, null, null, 750, 800) },
  coolant: { label: tk('Temperatura da água'), unit: '°C', def: L(0, 130, null, 50, 100, 110) },
  oilT: { label: tk('Temperatura do óleo'), unit: '°C', def: L(0, 150, null, 50, 110, 125) },
  oilP: { label: tk('Pressão do óleo'), unit: 'bar', def: L(0, 8, 1, 2, 5.5, 6.5) },
  fuel: { label: tk('Combustível'), unit: '%', def: L(0, 100, 10, 25, null, null) },
  cell: { label: tk('Tensão por célula'), unit: 'V', def: L(3, 4.35, 3.3, 3.5, 4.22, 4.3) },
  cellDelta: { label: tk('Desequilíbrio entre células'), unit: 'V', def: L(0, 0.3, null, null, 0.05, 0.1) },
  soc: { label: tk('Carga da bateria'), unit: '%', def: L(0, 100, 15, 30, null, null) },
  current: { label: tk('Corrente da bateria'), unit: 'A', def: L(0, 150, null, null, 100, 130) },
  battTemp: { label: tk('Temperatura da bateria'), unit: '°C', def: L(-10, 80, 0, 10, 50, 60) },
  escTemp: { label: tk('Temperatura dos ESCs'), unit: '°C', def: L(0, 120, null, null, 80, 100) },
  motorRpm: { label: tk('Rotação dos motores elétricos'), unit: 'rpm', def: L(0, 12_000, null, null, 10_500, 11_500) },
  genTemp: { label: tk('Temperatura do gerador'), unit: '°C', def: L(0, 130, null, null, 90, 105) },
  rectTemp: { label: tk('Temperatura do retificador'), unit: '°C', def: L(0, 120, null, null, 80, 95) },
} as const

export type LimitId = keyof typeof LIMIT_DEFS

/** Faixas que fazem sentido para cada tipo de motor (o gerador vale para todos). */
export const LIMITS_BY_KIND: Record<EngineKind, LimitId[]> = {
  electric: ['soc', 'cell', 'cellDelta', 'current', 'battTemp', 'escTemp', 'motorRpm', 'genTemp', 'rectTemp'],
  combustion: ['rpm', 'cht', 'egt', 'coolant', 'oilT', 'oilP', 'fuel', 'cell', 'genTemp', 'rectTemp'],
  jet: ['n1', 'egtJet', 'fuel', 'cell', 'genTemp', 'rectTemp'],
}

export const KIND_LABEL: Record<EngineKind, string> = {
  electric: tk('Elétrico'),
  combustion: tk('Combustão'),
  jet: tk('Turbina'),
}

export interface EngineSettings {
  /** auto = decide pela telemetria (EFI → combustão; N1 alto ou TURB_ST → turbina; senão elétrico). */
  kind: 'auto' | EngineKind
  /** Células da bateria principal; 0 = da telemetria ou estimado pela tensão. */
  cells: number
  /** Capacidade do tanque em litros (0 = desconhecida); com ela, nível e autonomia vêm do consumo da EFI. */
  tankL: number
  limits: Partial<Record<LimitId, Limit>>
}

export const DEFAULT_ENGINE: EngineSettings = { kind: 'auto', cells: 0, tankL: 0, limits: {} }

export function limitOf(s: EngineSettings, id: LimitId): Limit {
  return s.limits[id] ?? LIMIT_DEFS[id].def
}

const hasThresholds = (l: Limit) => l.redLo !== null || l.yelLo !== null || l.yelHi !== null || l.redHi !== null

export function level(v: number | null | undefined, l: Limit | null): Level {
  if (v === null || v === undefined || !Number.isFinite(v) || !l || !hasThresholds(l)) return 'none'
  if (l.redLo !== null && v < l.redLo) return 'crit'
  if (l.redHi !== null && v > l.redHi) return 'crit'
  if (l.yelLo !== null && v < l.yelLo) return 'warn'
  if (l.yelHi !== null && v > l.yelHi) return 'warn'
  return 'ok'
}

/** Faixas coloridas da escala, da menor para a maior. */
export function bands(l: Limit): { from: number; to: number; level: Level }[] {
  const cuts = [l.min, ...[l.redLo, l.yelLo, l.yelHi, l.redHi].filter((x): x is number => x !== null && x > l.min && x < l.max), l.max]
  const pts = [...new Set(cuts)].sort((a, b) => a - b)
  const out: { from: number; to: number; level: Level }[] = []
  for (let i = 0; i + 1 < pts.length; i++) out.push({ from: pts[i], to: pts[i + 1], level: hasThresholds(l) ? level((pts[i] + pts[i + 1]) / 2, l) : 'none' })
  return out
}

/** Posição (0–1) do valor na escala. */
export const frac = (v: number, l: Limit) => (l.max === l.min ? 0 : Math.max(0, Math.min(1, (v - l.min) / (l.max - l.min))))

/** Limite por célula vira limite da bateria inteira. */
export const scaleLimit = (l: Limit, k: number): Limit => {
  const m = (x: number | null) => (x === null ? null : +(x * k).toFixed(3))
  return { min: l.min * k, max: l.max * k, redLo: m(l.redLo), yelLo: m(l.yelLo), yelHi: m(l.yelHi), redHi: m(l.redHi) }
}

export function detectKind(p: Propulsion | undefined): EngineKind {
  if (!p) return 'electric'
  if ('TURB_ST' in p.named || (p.efi?.rpm ?? 0) > 25_000) return 'jet'
  if (p.efi) return 'combustion'
  return 'electric'
}

export function engineKind(tm: Telemetry | null | undefined, s: EngineSettings): EngineKind {
  return s.kind === 'auto' ? detectKind(tm?.propulsion) : s.kind
}

/** Bateria principal: a de propulsão, senão a 0, senão a primeira; sem BATTERY_STATUS, o SYS_STATUS. */
export function mainPack(tm: Telemetry): BatteryPack {
  const packs = tm.propulsion?.batteries ?? []
  const b = packs.find((p) => p.function === 'propulsion') ?? packs.find((p) => p.id === 0) ?? packs[0]
  if (b) return b
  return {
    id: 0, function: 'unknown', voltage: tm.battery.voltage, current: tm.battery.current, consumed_mah: tm.battery.consumed_mah,
    energy_wh: null, remaining: tm.battery.remaining >= 0 ? tm.battery.remaining : null, temperature: null, cells: [],
    time_remaining_s: null, charge_state: '', faults: [], age_ms: 0,
  }
}

export function cellCount(b: BatteryPack, s: EngineSettings): number {
  if (b.cells.length > 1) return b.cells.length
  if (s.cells > 0) return s.cells
  return b.voltage > 0 ? Math.ceil(b.voltage / 4.3) : 1
}

export interface Row { label: string; value: number | null }

/** Um mostrador (ponteiro ou barra), com uma ou mais leituras na mesma escala. */
export interface Meter {
  id: string
  /** Nome completo (alertas) e rótulo curto (tela), já traduzidos. */
  name: string
  short: string
  unit: string
  digits: number
  lim: Limit
  rows: Row[]
}

export interface GenView {
  g: GeneratorStatus
  meters: Meter[]
  stale: boolean
}

export interface Panel {
  kind: EngineKind
  dials: Meter[]
  bars: Meter[]
  pack: BatteryPack
  cells: { values: number[]; lim: Limit; delta: number; deltaLim: Limit } | null
  /** Outras baterias (aviônica, carga…). */
  others: BatteryPack[]
  generator: GenView | null
  /** Estado da turbina (TURB_ST), já traduzido. */
  state: { text: string; level: Level } | null
  fuelPct: number | null
  /** A fonte principal parou de mandar dados. */
  stale: boolean
}

export const TURBINE_STATES: [string, Level][] = [
  [tk('DESLIGADA'), 'none'], [tk('PRONTA'), 'ok'], [tk('IGNIÇÃO'), 'warn'], [tk('ACELERANDO'), 'warn'],
  [tk('FUNCIONANDO'), 'ok'], [tk('RESFRIANDO'), 'warn'], [tk('FALHA'), 'crit'],
]

export const STALE_MS = 3000

const num = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? null : v)
const named = (p: Propulsion, ...keys: string[]) => {
  for (const k of keys) if (k in p.named) return num(p.named[k])
  return null
}

/** Leituras por cilindro: CHT1…CHT8 dos scripts, ou a da EFI como cilindro 1 mais CHT2…CHT8. */
function cylinders(p: Propulsion, key: 'CHT' | 'EGT', efi: number | null): Row[] {
  const vals: (number | null)[] = []
  if (`${key}1` in p.named) vals.push(named(p, `${key}1`))
  else if (efi !== null) vals.push(efi)
  for (let i = 2; i <= 8; i++) if (`${key}${i}` in p.named) vals.push(named(p, `${key}${i}`))
  return vals.map((value, i) => ({ label: vals.length > 1 ? String(i + 1) : '', value }))
}

export function fuelPercent(p: Propulsion, s: EngineSettings): number | null {
  const n = named(p, 'FUEL')
  if (n !== null) return n
  const used = num(p.efi?.fuel_consumed)
  if (s.tankL > 0 && used !== null) return Math.max(0, 100 * (1 - used / 1000 / s.tankL))
  return null
}

export function buildPanel(tm: Telemetry, s: EngineSettings): Panel {
  const p: Propulsion = tm.propulsion ?? { batteries: [], escs: [], efi: null, generator: null, rpm: [null, null], named: {} }
  const kind = engineKind(tm, s)
  const lim = (id: LimitId) => limitOf(s, id)
  const meter = (id: string, name: string, short: string, unit: string, l: Limit, rows: Row[], digits = 0): Meter =>
    ({ id, name: t(name), short: t(short), unit, digits, lim: l, rows })
  const one = (value: number | null) => [{ label: '', value }]

  const pack = mainPack(tm)
  const nCells = cellCount(pack, s)
  const volts = meter('volts', tk('Tensão da bateria'), tk('VOLTS'), 'V', scaleLimit(lim('cell'), nCells), one(num(pack.voltage) || null), 1)
  const fuelPct = fuelPercent(p, s)
  const efi = p.efi
  const dials: Meter[] = []
  const bars: Meter[] = []
  let stale = false
  let state: Panel['state'] = null

  if (kind === 'electric') {
    // Média dos motores girando (o empurrador do VTOL para no voo pairado e vice-versa).
    const spinning = p.escs.map((e) => e.rpm).filter((r) => r > 100)
    const rpm = spinning.length ? spinning.reduce((a, b) => a + b, 0) / spinning.length : p.escs.length ? 0 : num(p.rpm[0])
    dials.push(meter('motorRpm', tk('Rotação dos motores elétricos'), tk('RPM'), 'rpm', lim('motorRpm'), one(rpm)))
    dials.push(meter('soc', tk('Carga da bateria'), tk('CARGA'), '%', lim('soc'), one(num(pack.remaining))))
    bars.push(volts)
    bars.push(meter('current', tk('Corrente da bateria'), tk('CORRENTE'), 'A', lim('current'), one(num(pack.current)), 1))
    if (pack.temperature !== null) bars.push(meter('battTemp', tk('Temperatura da bateria'), tk('TEMP. BAT'), '°C', lim('battTemp'), one(pack.temperature)))
    if (p.escs.length) {
      const rows = (f: (e: Propulsion['escs'][number]) => number) => p.escs.map((e) => ({ label: String(e.n), value: f(e) }))
      bars.push(meter('escTemp', tk('Temperatura dos ESCs'), tk('ESC °C'), '°C', lim('escTemp'), rows((e) => e.temperature)))
      if (p.escs.length > 1) bars.push(meter('motorRpmEach', tk('Rotação dos motores elétricos'), tk('RPM'), 'rpm', lim('motorRpm'), rows((e) => e.rpm)))
      stale = p.escs.every((e) => e.age_ms > STALE_MS)
    }
  } else {
    stale = !efi || efi.age_ms > STALE_MS
    const rpm = num(efi?.rpm) ?? num(p.rpm[0])
    const cht = cylinders(p, 'CHT', num(efi?.cht))
    const egt = cylinders(p, 'EGT', num(efi?.egt))
    if (kind === 'combustion') {
      const coolant = named(p, 'H2O', 'COOLANT')
      dials.push(meter('rpm', tk('Rotação do motor'), tk('RPM'), 'rpm', lim('rpm'), one(rpm)))
      if (coolant !== null) dials.push(meter('coolant', tk('Temperatura da água'), tk('H2O'), '°C', lim('coolant'), one(coolant)))
      else {
        const hottest = cht.reduce<number | null>((m, r) => (r.value === null ? m : Math.max(m ?? -Infinity, r.value)), null)
        dials.push(meter('chtMax', tk('Temperatura do cabeçote (CHT)'), tk('CHT'), '°C', lim('cht'), one(hottest)))
      }
      bars.push(volts)
      if (fuelPct !== null) bars.push(meter('fuel', tk('Combustível'), tk('COMBUST.'), '%', lim('fuel'), one(fuelPct)))
      if (cht.length) bars.push(meter('cht', tk('Temperatura do cabeçote (CHT)'), tk('CHT'), '°C', lim('cht'), cht))
      if (egt.length) bars.push(meter('egt', tk('Temperatura do escape (EGT)'), tk('EGT'), '°C', lim('egt'), egt))
      const oilT = named(p, 'OILT'), oilP = named(p, 'OILP')
      if (oilT !== null) bars.push(meter('oilT', tk('Temperatura do óleo'), tk('ÓLEO °C'), '°C', lim('oilT'), one(oilT)))
      if (oilP !== null) bars.push(meter('oilP', tk('Pressão do óleo'), tk('ÓLEO P'), 'bar', lim('oilP'), one(oilP), 1))
    } else {
      dials.push(meter('n1', tk('Rotação N1 da turbina'), tk('N1'), 'rpm', lim('n1'), one(rpm)))
      dials.push(meter('egtJet', tk('EGT da turbina'), tk('EGT'), '°C', lim('egtJet'), one(egt[0]?.value ?? null)))
      bars.push(volts)
      if (fuelPct !== null) bars.push(meter('fuel', tk('Combustível'), tk('COMBUST.'), '%', lim('fuel'), one(fuelPct)))
      const flow = num(efi?.fuel_flow)
      if (flow !== null) bars.push(meter('flow', tk('Fluxo de combustível'), tk('FLUXO'), 'mL/min', L(0, Math.max(600, Math.ceil(flow / 100) * 100), null, null, null, null), one(flow)))
      const pump = named(p, 'PUMP_V')
      if (pump !== null) bars.push(meter('pump', tk('Tensão da bomba'), tk('BOMBA'), 'V', L(0, 6, null, null, null, null), one(pump), 2))
      const st = named(p, 'TURB_ST')
      if (st !== null) {
        const [text, lv] = TURBINE_STATES[Math.round(st)] ?? [tk('ESTADO {n}'), 'warn' as Level]
        state = { text: t(text, { n: st }), level: lv }
      }
    }
    const thr = num(efi?.throttle)
    if (thr !== null) bars.push(meter('throttle', tk('Acelerador'), tk('ACEL.'), '%', L(0, 100, null, null, null, null), one(thr)))
  }

  const cells = pack.cells.length > 1
    ? { values: pack.cells, lim: lim('cell'), delta: Math.max(...pack.cells) - Math.min(...pack.cells), deltaLim: lim('cellDelta') }
    : null

  let generator: GenView | null = null
  if (p.generator) {
    const g = p.generator
    const gm: Meter[] = []
    if (g.rpm !== null) gm.push(meter('genRpm', tk('Rotação do gerador'), tk('RPM'), 'rpm', L(0, Math.max(9000, Math.ceil(g.rpm / 1000) * 1000), null, null, null, null), one(g.rpm)))
    if (g.power_w !== null) gm.push(meter('genPower', tk('Potência gerada'), tk('POTÊNCIA'), 'W', L(0, Math.max(2000, Math.ceil(g.power_w / 500) * 500), null, null, null, null), one(g.power_w)))
    if (g.generator_temperature !== null) gm.push(meter('genTemp', tk('Temperatura do gerador'), tk('TEMP. GER'), '°C', lim('genTemp'), one(g.generator_temperature)))
    if (g.rectifier_temperature !== null) gm.push(meter('rectTemp', tk('Temperatura do retificador'), tk('RETIF.'), '°C', lim('rectTemp'), one(g.rectifier_temperature)))
    generator = { g, meters: gm, stale: g.age_ms > STALE_MS }
  }

  const others = (tm.propulsion?.batteries ?? []).filter((b) => b !== pack)
  return { kind, dials, bars, pack, cells, others, generator, state, fuelPct, stale }
}

// ---------- Gerador ----------

const GEN_FLAG: Record<string, string> = {
  off: tk('Desligado'), ready: tk('Pronto'), generating: tk('Gerando'), charging: tk('Carregando'),
  reduced_power: tk('Potência reduzida'), maxpower: tk('Potência máxima'), overtemp_warning: tk('Temperatura alta'),
  overtemp_fault: tk('Superaquecido'), electronics_overtemp_warning: tk('Eletrônica quente'),
  electronics_overtemp_fault: tk('Eletrônica superaquecida'), electronics_fault: tk('Falha na eletrônica'),
  powersource_fault: tk('Falha na fonte de energia'), communication_warning: tk('Falha de comunicação'),
  cooling_warning: tk('Arrefecimento com problema'), power_rail_fault: tk('Falha no barramento'),
  overcurrent_fault: tk('Sobrecorrente'), battery_overcharge_current_fault: tk('Corrente de carga excessiva'),
  overvoltage_fault: tk('Sobretensão'), battery_undervolt_fault: tk('Bateria com tensão baixa'),
  start_inhibited: tk('Partida bloqueada'), maintenance_required: tk('Manutenção necessária'),
  warming_up: tk('Aquecendo'), idle: tk('Marcha lenta'),
}

export function genFlag(f: string): { text: string; level: Level } {
  const lv: Level = f.endsWith('_fault') ? 'crit' : f.endsWith('_warning') || f === 'maintenance_required' || f === 'start_inhibited' ? 'warn' : 'ok'
  return { text: GEN_FLAG[f] ? t(GEN_FLAG[f]) : f, level: lv }
}

// ---------- Alertas ----------

export interface Issue { key: string; level: 'warn' | 'crit'; text: string }

const fmt = (v: number, digits: number) => v.toFixed(digits)

/** Tudo que está fora da faixa verde agora. */
export function issues(panel: Panel): Issue[] {
  const out: Issue[] = []
  const add = (key: string, lv: Level, text: string) => { if (lv === 'warn' || lv === 'crit') out.push({ key, level: lv, text }) }
  // Barras primeiro: elas dizem qual cilindro/ESC; o ponteiro repete o pior valor.
  const meters = [...panel.bars, ...panel.dials, ...(panel.generator?.meters ?? [])]
  const seen = new Set<string>()
  for (const m of meters) {
    for (const r of m.rows) {
      // O mesmo valor em dois mostradores (ex.: CHT no ponteiro e na barra) alerta uma vez.
      const key = `${m.name}|${r.value}`
      if (r.value === null || seen.has(key)) continue
      seen.add(key)
      add(`${m.id}:${r.label}`, level(r.value, m.lim), `${m.name}${r.label ? ` ${r.label}` : ''}: ${fmt(r.value, m.digits)} ${m.unit}`)
    }
  }
  if (panel.cells) {
    const lo = Math.min(...panel.cells.values), hi = Math.max(...panel.cells.values)
    add('cellLo', level(lo, panel.cells.lim), t('Célula mais baixa: {v} V', { v: lo.toFixed(2) }))
    add('cellHi', level(hi, panel.cells.lim), t('Célula mais alta: {v} V', { v: hi.toFixed(2) }))
    add('cellDelta', level(panel.cells.delta, panel.cells.deltaLim), t('Desequilíbrio entre células: {v} V', { v: panel.cells.delta.toFixed(2) }))
  }
  for (const f of panel.pack.faults) add(`packFault:${f}`, 'crit', t('Bateria: falha {f}', { f }))
  for (const f of panel.generator?.g.status ?? []) {
    const g = genFlag(f)
    add(`gen:${f}`, g.level, t('Gerador: {f}', { f: g.text }))
  }
  if (panel.state?.level === 'crit') add('turbine', 'crit', t('Turbina: {s}', { s: panel.state.text }))
  return out
}

const RANK: Record<Level, number> = { none: 0, ok: 0, warn: 1, crit: 2 }

/**
 * Decide quando avisar: na primeira vez que um item fica amarelo ou vermelho e quando
 * piora. Para avisar de novo no mesmo nível, o item precisa ter voltado ao normal por
 * `holdMs` (evita repetir a cada oscilação em cima do limite).
 */
export class AlertTracker {
  private state = new Map<string, { level: number; lowSince: number }>()
  private holdMs: number
  constructor(holdMs = 10_000) {
    this.holdMs = holdMs
  }

  update(list: Issue[], now: number): Issue[] {
    const fired: Issue[] = []
    const seen = new Set<string>()
    for (const i of list) {
      seen.add(i.key)
      const r = RANK[i.level]
      const s = this.state.get(i.key)
      if (!s || r > s.level) {
        fired.push(i)
        this.state.set(i.key, { level: r, lowSince: 0 })
      } else if (r < s.level) {
        if (!s.lowSince) s.lowSince = now
        else if (now - s.lowSince >= this.holdMs) this.state.set(i.key, { level: r, lowSince: 0 })
      } else s.lowSince = 0
    }
    for (const [k, s] of this.state) {
      if (seen.has(k)) continue
      if (!s.lowSince) s.lowSince = now
      else if (now - s.lowSince >= this.holdMs) this.state.delete(k)
    }
    return fired
  }

  reset() {
    this.state.clear()
  }
}
