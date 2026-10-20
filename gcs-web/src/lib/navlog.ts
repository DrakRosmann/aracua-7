// Planejamento e acompanhamento de voos longos: perfil da aeronave, triângulo do vento,
// navlog perna a perna (rumo, proa, velocidade no solo, tempo, energia), ponto de não
// retorno (PNR), ponto de igual tempo (ETP), espaço aéreo cruzado e, em voo, o quanto
// sobra para voltar ("bingo"). Vale de drones a aeronaves supersônicas e hipersônicas:
// com Mach de cruzeiro, a velocidade verdadeira sai da atmosfera padrão (ISA) na altitude,
// e em alta velocidade contam a subida e a descida longas (TOC/TOD) e o raio de curva.
// Funções puras: a tela e a loja usam as mesmas.

import { FT, fmtLimit, limitM, REGIONS, type ChartIndex, type ChartSegment } from './charts'
import { angleDiff, bearing, distance, intermediate, inRing, type LatLon } from './geo'
import { tk } from './i18n'

/** Desempenho da aeronave para o planejamento. */
export interface Perf {
  /** Velocidade verdadeira de cruzeiro (m/s). */
  cruise: number
  climb: number
  descent: number
  /** battery: capacidade em Wh e consumo em W; fuel: litros e L/h. */
  energy: 'battery' | 'fuel'
  capacity: number
  burn: number
  /** Subindo, o consumo é este múltiplo do de cruzeiro. */
  climbFactor: number
  /** Reserva final, em minutos de cruzeiro. */
  reserveMin: number
  /** Mach de cruzeiro (supersônicos, hipersônicos, jatos); 0 = usa `cruise`. */
  mach: number
  /** Inclinação nas curvas (graus), para o raio de curva. */
  bank: number
  /** Modos econômico e rápido: multiplicadores da velocidade e do consumo de cruzeiro. */
  eco: { speed: number; burn: number }
  fast: { speed: number; burn: number }
}

export type SpeedMode = 'normal' | 'eco' | 'fast'

export interface Wind { dir: number; speed: number }

export interface LongRangeSettings {
  perf: Perf
  /** measured = o vento estimado pelo piloto automático, quando houver. */
  windSource: 'measured' | 'manual'
  wind: Wind
  /** aero = NM, kt e pés; metric = km, km/h e metros. */
  units: 'aero' | 'metric'
  /** Altitudes do plano acima do nível do mar (MSL) em vez de relativas ao home. */
  altMsl: boolean
  /** Altitude de cruzeiro dos pontos gerados pela rota (na referência escolhida). */
  cruiseAlt: number
  /** Teto das altitudes no plano. */
  maxAlt: number
  /** Divide pernas mais longas que isso (km) em pontos no grande círculo; 0 = não divide. */
  splitKm: number
  /** Voo só de ida: no fim circula (ou paira) sobre o último ponto em vez de voltar. */
  oneWay: boolean
  /** Alcance do enlace de telemetria (km); 0 = desconhecido. */
  radioKm: number
  /** Aeródromos próximos: só os de uso público. */
  onlyPublic: boolean
  /** Fundo liso de carta no lugar do satélite. */
  chartBase: boolean
  /** Regime de cruzeiro usado no navlog e na missão. */
  speedMode: SpeedMode
}

export const DEFAULT_LONG_RANGE: LongRangeSettings = {
  perf: {
    cruise: 22, climb: 3, descent: 3, energy: 'battery', capacity: 1000, burn: 450, climbFactor: 1.6, reserveMin: 15,
    mach: 0, bank: 30, eco: { speed: 0.85, burn: 0.72 }, fast: { speed: 1.12, burn: 1.4 },
  },
  windSource: 'measured',
  wind: { dir: 0, speed: 0 },
  units: 'aero',
  altMsl: false,
  cruiseAlt: 120,
  maxAlt: 120,
  splitKm: 0,
  oneWay: false,
  radioKm: 0,
  onlyPublic: true,
  chartBase: false,
  speedMode: 'normal',
}

export const NM = 1852
export const KT = NM / 3600
const G = 9.80665

/** Velocidade do som (m/s) na atmosfera padrão ISA, até 51 km. */
export function soundSpeed(altM: number): number {
  const h = Math.max(0, altM)
  const T = h < 11_000 ? 288.15 - 0.0065 * h
    : h < 20_000 ? 216.65
      : h < 32_000 ? 216.65 + 0.001 * (h - 20_000)
        : h < 47_000 ? 228.65 + 0.0028 * (h - 32_000)
          : 270.65
  return Math.sqrt(1.4 * 287.053 * T)
}

/** Desempenho no regime pedido e na altitude (m MSL): velocidade verdadeira e consumo. */
export function modePerf(p: Perf, mode: SpeedMode, altM: number): Perf {
  const base = p.mach > 0 ? p.mach * soundSpeed(altM) : p.cruise
  const f = mode === 'eco' ? p.eco : mode === 'fast' ? p.fast : { speed: 1, burn: 1 }
  return { ...p, cruise: base * f.speed, burn: p.burn * f.burn, mach: 0 }
}

/** Raio de curva coordenada (m) na velocidade e inclinação dadas. */
export const turnRadius = (tas: number, bank: number) => (tas * tas) / (G * Math.tan((Math.max(5, Math.min(75, bank)) * Math.PI) / 180))

/** Horizonte rádio (m) entre uma antena a h1 e outra a h2 metros (refração padrão, k = 4/3). */
export const radioHorizon = (h1: number, h2: number) => 4120 * (Math.sqrt(Math.max(0, h1)) + Math.sqrt(Math.max(0, h2)))

/** Triângulo do vento: proa, velocidade no solo e correção para voar o rumo `tc`. */
export function windTriangle(tc: number, tas: number, w: Wind): { hdg: number; gs: number; wca: number } {
  if (tas <= 0) return { hdg: tc, gs: 0, wca: 0 }
  const a = ((w.dir - tc) * Math.PI) / 180
  const s = (w.speed * Math.sin(a)) / tas
  if (Math.abs(s) >= 1) return { hdg: tc, gs: 0, wca: 0 }
  const wca = Math.asin(s)
  const gs = tas * Math.cos(wca) - w.speed * Math.cos(a)
  return { hdg: (tc + (wca * 180) / Math.PI + 360) % 360, gs: Math.max(0, gs), wca: (wca * 180) / Math.PI }
}

/** Consumo por segundo em cruzeiro (Wh/s ou L/s). */
const perSec = (p: Perf) => p.burn / 3600
/** Energia da reserva final. */
export const reserveEnergy = (p: Perf) => (p.reserveMin / 60) * p.burn

export interface NavPoint extends LatLon {
  name: string
  /** DCT ou aerovia. */
  via?: string
  /** Altitude na referência do plano. */
  alt: number
  seg?: ChartSegment
}

export interface Conflict {
  leg: number
  id: string
  kind: string
  name: string
  lo: string
  hi: string
  /** crit: proibida/restrita; warn: perigosa ou abaixo da AMA; info: espaço controlado, FIR. */
  level: 'crit' | 'warn' | 'info'
}

export interface Leg {
  from: string
  to: string
  via: string
  a: LatLon
  b: LatLon
  dist: number
  /** Rumo verdadeiro e magnético (se houver declinação nas cartas). */
  tc: number
  mc: number | null
  hdg: number
  gs: number
  time: number
  energy: number
  /** Altitudes MSL no começo e no fim da perna (m). */
  altA: number
  altB: number
  /** Maior AMA cruzada (m MSL). */
  ama: number | null
  seg?: ChartSegment
  /** Parte da perna fora do alcance do rádio (distância ou horizonte). */
  noLink: boolean
  /** Parte da perna abaixo do horizonte rádio do home. */
  belowHorizon: boolean
  /** Velocidade verdadeira e Mach na perna. */
  tas: number
  mach: number
  /** Curva no fim da perna: raio e antecipação (m); `turnTight` quando não cabe nas pernas. */
  turnR: number | null
  turnLead: number | null
  turnTight: boolean
  /** Acumulados no fim da perna. */
  cumDist: number
  cumTime: number
  cumEnergy: number
  /** Retorno ao home no fim do plano. */
  isReturn?: boolean
}

export interface Navlog {
  legs: Leg[]
  dist: number
  time: number
  energy: number
  reserve: number
  /** Energia que sobra no pouso além da reserva (negativa = não dá). */
  margin: number
  /** Ponto de não retorno: até aqui ainda dá para voltar direto ao home com a reserva intacta. */
  pnr: { pos: LatLon; dist: number; time: number } | null
  /** O plano inteiro cabe com volta direta ao home de qualquer ponto. */
  pnrBeyond: boolean
  /** Ponto de igual tempo entre voltar ao home e seguir ao destino (voo só de ida). */
  etp: { pos: LatLon; dist: number; time: number } | null
  conflicts: Conflict[]
  maxRange: number
  /** Fim da subida e início da descida (subidas e descidas longas em alta velocidade). */
  toc: { pos: LatLon; dist: number } | null
  tod: { pos: LatLon; dist: number } | null
  /** Alguma perna acima de Mach 1. */
  supersonic: boolean
}

export interface NavInput {
  /** Home com altitude MSL (m). */
  home: LatLon & { alt: number }
  points: NavPoint[]
  altMsl: boolean
  perf: Perf
  wind: Wind
  charts: ChartIndex | null
  /** Termina voltando ao home. */
  returnHome: boolean
  /** Alcance do rádio em metros; 0 = sem verificação. */
  radio: number
  /** Regime de cruzeiro (padrão: normal). */
  mode?: SpeedMode
}

/** Tempo e energia de uma perna com subida/descida simultâneas. */
function legCost(dist: number, gs: number, dh: number, p: Perf) {
  const cruise = gs > 0 ? dist / gs : Infinity
  const climbT = dh > 0 ? dh / p.climb : 0
  const descT = dh < 0 ? -dh / p.descent : 0
  const time = Math.max(cruise, climbT, descT)
  return { time, energy: time * perSec(p) + climbT * perSec(p) * (p.climbFactor - 1) }
}

/** Tempo e energia para ir direto de p ao home, no vento. */
function directCost(p: LatLon, home: LatLon, perf: Perf, w: Wind) {
  const d = distance(p, home)
  if (d < 1) return { time: 0, energy: 0 }
  const { gs } = windTriangle(bearing(p, home), perf.cruise, w)
  return legCost(d, gs, 0, perf)
}

/** Ponto a `d` metros do começo das pernas. */
function along(legs: Leg[], d: number): LatLon | null {
  for (const l of legs) {
    const d0 = l.cumDist - l.dist
    if (d <= l.cumDist) return intermediate(l.a, l.b, l.dist > 0 ? Math.max(0, d - d0) / l.dist : 0)
  }
  return null
}

export function computeNavlog(inp: NavInput): Navlog {
  const { home, wind, charts } = inp
  const mode = inp.mode ?? 'normal'
  // Reserva e capacidade do perfil como está; velocidade e consumo pelo regime e pela altitude de cada perna.
  const perf = inp.perf
  const msl = (alt: number) => (inp.altMsl ? alt : alt + home.alt)
  const pts: NavPoint[] = [{ name: 'HOME', lat: home.lat, lon: home.lon, alt: inp.altMsl ? home.alt : 0 }, ...inp.points]
  if (inp.returnHome && inp.points.length) pts.push({ name: 'HOME', lat: home.lat, lon: home.lon, alt: inp.points.at(-1)!.alt, via: 'DCT' })
  const legs: Leg[] = []
  let cumDist = 0, cumTime = 0, cumEnergy = 0, maxRange = 0
  const conflicts: Conflict[] = []
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const dist = distance(a, b)
    const tc = dist > 1 ? bearing(a, b) : 0
    // Saindo do home sobe do chão; no fim (volta ao home) a descida para o pouso fica de fora.
    const altA = i === 1 ? home.alt : msl(a.alt)
    const altB = msl(b.alt)
    const lp = modePerf(perf, mode, Math.max(altA, altB))
    const { hdg, gs } = windTriangle(tc, lp.cruise, wind)
    const { time, energy } = legCost(dist, gs, altB - altA, lp)
    cumDist += dist
    cumTime += time
    cumEnergy += energy
    const v = charts?.magVar(intermediate(a, b, 0.5)) ?? null
    const samples = Math.max(2, Math.min(400, Math.ceil(dist / 2000)))
    let noLink = false, belowHorizon = false, ama: number | null = null
    const hit = new Set<number>()
    // Só os espaços cuja caixa encosta na perna; os contornos enormes (FIR, CTA) a cada ~20 km.
    const near = charts ? charts.crossing(a, b) : []
    // Altitude ao longo da perna: sobe (ou desce) no começo, na razão do perfil, e segue nivelado.
    const dh = altB - altA
    const vDist = Math.max(1, (Math.abs(dh) / (dh > 0 ? perf.climb : perf.descent)) * lp.cruise * 0.75)
    for (let k = 0; k <= samples; k++) {
      const p = intermediate(a, b, k / samples)
      const r = distance(home, p)
      maxRange = Math.max(maxRange, r)
      if (inp.radio > 0 && r > inp.radio) noLink = true
      // Antena a ~2 m do chão no home; a altura da aeronave conta sobre o home (o terreno no meio não entra).
      if (r > radioHorizon(2, altA + dh * Math.min(1, (dist * k) / samples / vDist) - home.alt)) belowHorizon = true
      for (const j of near) {
        const ring = charts!.pack.airspaces[j].ring
        if (hit.has(j) || (ring.length > 1000 && k % 10 && k !== samples)) continue
        const [w, s, e, n] = charts!.boxes[j]
        if (p.lon < w || p.lon > e || p.lat < s || p.lat > n || !inRing(p, ring)) continue
        hit.add(j)
      }
    }
    const lo = Math.min(altA, altB), hi = Math.max(altA, altB)
    for (const j of hit) {
      const s = charts!.pack.airspaces[j]
      if (s.kind === 'AMA') {
        const m = limitM(s.lo) ?? 0
        ama = Math.max(ama ?? 0, m)
        continue
      }
      // Limites "do solo" usam a elevação do home: aproximação, o terreno muda ao longo da rota.
      const sLo = limitM(s.lo, home.alt) ?? 0, sHi = limitM(s.hi, home.alt) ?? Infinity
      if (!REGIONS.includes(s.kind) && (hi < sLo || lo > sHi)) continue
      const level = s.kind === 'P' || s.kind === 'R' ? 'crit' : s.kind === 'D' ? 'warn' : 'info'
      conflicts.push({ leg: legs.length, id: s.id, kind: s.kind, name: s.name, lo: fmtLimit(s.lo), hi: fmtLimit(s.hi), level })
    }
    if (ama !== null && lo < ama) conflicts.push({ leg: legs.length, id: 'AMA', kind: 'AMA', name: '', lo: `${Math.round(ama / FT)} ft`, hi: '', level: 'warn' })
    legs.push({
      from: a.name, to: b.name, via: b.via ?? 'DCT', a, b, dist, tc, mc: v === null ? null : (tc - v + 360) % 360, hdg, gs, time, energy,
      altA, altB, ama, seg: b.seg, noLink: noLink || (inp.radio > 0 && belowHorizon), belowHorizon, cumDist, cumTime, cumEnergy,
      isReturn: inp.returnHome && i === pts.length - 1 && i > 1,
      tas: lp.cruise, mach: lp.cruise / soundSpeed(Math.max(altA, altB)), turnR: null, turnLead: null, turnTight: false,
    })
  }
  // Curvas: em alta velocidade o raio passa de dezenas de quilômetros e a curva "come" as pernas.
  for (let i = 0; i + 1 < legs.length; i++) {
    const l = legs[i], n = legs[i + 1]
    const turn = Math.abs(angleDiff(l.tc, n.tc))
    if (l.dist < 1 || n.dist < 1 || turn < 2) continue
    const r = turnRadius(Math.max(l.tas, n.tas), perf.bank)
    const lead = turn >= 170 ? r : r * Math.tan(((turn / 2) * Math.PI) / 180)
    l.turnR = r
    l.turnLead = lead
    l.turnTight = lead > Math.min(l.dist, n.dist) / 2
  }
  // TOC e TOD: a subida do home até o cruzeiro e a descida final, sobre o chão, na velocidade de subida/descida.
  let toc: Navlog['toc'] = null, tod: Navlog['tod'] = null
  const first = legs[0]
  if (first && first.altB - home.alt > 50) {
    const d = ((first.altB - home.alt) / perf.climb) * first.tas * 0.75
    const pos = along(legs, d)
    if (pos) toc = { pos, dist: d }
  }
  const lastLeg = legs.at(-1)
  if (lastLeg && inp.returnHome && lastLeg.altB - home.alt > 50) {
    const total = lastLeg.cumDist
    const d = total - ((lastLeg.altB - home.alt) / perf.descent) * lastLeg.tas * 0.85
    const pos = d > 0 ? along(legs, d) : null
    if (pos) tod = { pos, dist: d }
  }
  const reserve = reserveEnergy(perf)
  const usable = perf.capacity - reserve
  // PNR e ETP: amostras ao longo das pernas de ida.
  const out = legs.filter((l) => !l.isReturn)
  let pnr: Navlog['pnr'] = null, etp: Navlog['etp'] = null
  let pnrBeyond = out.length > 0
  const destTotal = out.at(-1)?.cumTime ?? 0
  let prevEtp: number | null = null
  for (let li = 0; li < out.length && (!pnr || !etp); li++) {
    const l = out[li]
    const t0 = l.cumTime - l.time, e0 = l.cumEnergy - l.energy, d0 = l.cumDist - l.dist
    const n = Math.max(4, Math.min(200, Math.ceil(l.dist / 2000)))
    const lp = modePerf(perf, mode, l.altB)
    for (let k = 0; k <= n; k++) {
      const f = k / n
      const p = intermediate(l.a, l.b, f)
      const t = t0 + l.time * f, e = e0 + l.energy * f, d = d0 + l.dist * f
      const back = directCost(p, home, lp, wind)
      if (!pnr && e + back.energy > usable) {
        pnr = { pos: p, dist: d, time: t }
        pnrBeyond = false
      }
      // ETP: tempo para seguir até o destino = tempo para voltar ao home.
      const diff = destTotal - t - back.time
      if (!etp && !inp.returnHome && prevEtp !== null && prevEtp > 0 && diff <= 0) etp = { pos: p, dist: d, time: t }
      prevEtp = diff
    }
  }
  const last = legs.at(-1)
  return {
    legs, dist: last?.cumDist ?? 0, time: last?.cumTime ?? 0, energy: last?.cumEnergy ?? 0, reserve,
    margin: usable - (last?.cumEnergy ?? 0), pnr, pnrBeyond, etp, conflicts, maxRange, toc, tod,
    supersonic: legs.some((l) => l.mach >= 1),
  }
}

/** Divide pernas mais longas que `maxM` em pontos do grande círculo (mesma altitude e via). */
export function splitLegs(start: LatLon | null, pts: NavPoint[], maxM: number): NavPoint[] {
  if (maxM <= 0) return pts
  const out: NavPoint[] = []
  let prev: LatLon | null = start
  for (const p of pts) {
    if (prev) {
      const n = Math.ceil(distance(prev, p) / maxM)
      for (let k = 1; k < n; k++) out.push({ ...intermediate(prev, p, k / n), name: `${p.name}-${n - k}`, alt: p.alt, via: p.via })
    }
    out.push(p)
    prev = p
  }
  return out
}

// ---------- em voo ----------

export interface LiveInput {
  pos: LatLon
  /** Altitude atual MSL (m), para o Mach. */
  altMsl?: number
  mode?: SpeedMode
  perf: Perf
  wind: Wind
  home: LatLon | null
  /** Energia restante (Wh ou L), se a telemetria permitir saber. */
  left: number | null
  /** Consumo agora (W ou L/h); null usa o do perfil. */
  burnNow: number | null
  /** Rota no veículo e índice do ponto ativo (−1 fora de AUTO). */
  route: { lat: number; lon: number; name?: string }[]
  active: number
}

export interface Live {
  next: { name: string; dist: number; dtk: number; hdg: number; ete: number; xtk: number | null } | null
  dest: { name: string; dist: number; ete: number; energy: number | null } | null
  home: { dist: number; brg: number; ete: number; energy: number } | null
  /** Sobra além da reserva voltando direto ao home agora (Wh ou L); negativa = bingo. */
  margin: number | null
  /** Distância que ainda dá para voar em linha reta, gastando até a reserva (sem vento). */
  reach: number | null
  burn: number
}

export function liveNav(i: LiveInput): Live {
  const mp = modePerf(i.perf, i.mode ?? 'normal', i.altMsl ?? 0)
  const burn = i.burnNow !== null && i.burnNow > 0 ? i.burnNow : mp.burn
  const perf: Perf = { ...mp, burn }
  const energyFor = (sec: number) => (sec * burn) / 3600
  const homeCost = i.home ? directCost(i.pos, i.home, perf, i.wind) : null
  const home = i.home && homeCost ? { dist: distance(i.pos, i.home), brg: bearing(i.pos, i.home), ete: homeCost.time, energy: homeCost.energy } : null
  let next: Live['next'] = null, dest: Live['dest'] = null
  if (i.active >= 0 && i.active < i.route.length) {
    const w = i.route[i.active]
    const prev = i.active > 0 ? i.route[i.active - 1] : i.home
    const dtk = bearing(i.pos, w)
    const { hdg, gs } = windTriangle(dtk, perf.cruise, i.wind)
    const d = distance(i.pos, w)
    let xtk: number | null = null
    if (prev) {
      const along = bearing(prev, w)
      const off = distance(prev, i.pos)
      xtk = Math.sin(((angleDiff(along, bearing(prev, i.pos))) * Math.PI) / 180) * off
    }
    next = { name: w.name ?? '', dist: d, dtk, hdg, ete: gs > 0 ? d / gs : Infinity, xtk }
    let dd = d, tt = next.ete
    for (let k = i.active + 1; k < i.route.length; k++) {
      const a = i.route[k - 1], b = i.route[k]
      const l = distance(a, b)
      const g = windTriangle(bearing(a, b), perf.cruise, i.wind).gs
      dd += l
      tt += g > 0 ? l / g : Infinity
    }
    const last = i.route.at(-1)!
    dest = { name: last.name ?? '', dist: dd, ete: tt, energy: i.left === null ? null : i.left - energyFor(tt) }
  }
  const reserve = reserveEnergy(perf)
  const margin = i.left === null || !home ? null : i.left - reserve - home.energy
  const reach = i.left === null ? null : Math.max(0, ((i.left - reserve) / burn) * 3600 * perf.cruise)
  return { next, dest, home, margin, reach, burn }
}

// ---------- unidades ----------

export function fmtNavDist(m: number, units: 'aero' | 'metric'): string {
  if (!Number.isFinite(m)) return '—'
  if (units === 'aero') return m / NM >= 100 ? `${Math.round(m / NM)} NM` : `${(m / NM).toFixed(1)} NM`
  return m >= 100_000 ? `${Math.round(m / 1000)} km` : `${(m / 1000).toFixed(1)} km`
}

export function fmtSpeed(ms: number, units: 'aero' | 'metric'): string {
  return units === 'aero' ? `${Math.round(ms / KT)} kt` : `${Math.round(ms * 3.6)} km/h`
}

/** Velocidade com o Mach, para quem voa perto ou acima do som: "M2.02 · 1160 kt". */
export function fmtTas(ms: number, altM: number, units: 'aero' | 'metric'): string {
  const m = ms / soundSpeed(altM)
  return m >= 0.5 ? `M${m.toFixed(2)} · ${fmtSpeed(ms, units)}` : fmtSpeed(ms, units)
}

export interface Preset {
  label: string
  perf: Partial<Perf>
  maxAlt: number
  cruiseAlt: number
  altMsl: boolean
  splitKm: number
}

/** Perfis prontos: do drone elétrico ao hipersônico (valores típicos; ajuste ao seu). */
export const PRESETS: Record<string, Preset> = {
  drone: { label: tk('Drone elétrico de asa fixa'), maxAlt: 120, cruiseAlt: 120, altMsl: false, splitKm: 0,
    perf: { cruise: 22, mach: 0, climb: 3, descent: 3, energy: 'battery', capacity: 1000, burn: 450, climbFactor: 1.6, reserveMin: 15, bank: 30 } },
  piston: { label: tk('Avião a pistão / VANT grande'), maxAlt: 4500, cruiseAlt: 2500, altMsl: true, splitKm: 0,
    perf: { cruise: 55, mach: 0, climb: 4, descent: 4, energy: 'fuel', capacity: 150, burn: 28, climbFactor: 1.4, reserveMin: 45, bank: 25 } },
  jet: { label: tk('Jato subsônico (Mach 0,78)'), maxAlt: 13000, cruiseAlt: 11000, altMsl: true, splitKm: 200,
    perf: { mach: 0.78, cruise: 230, climb: 12, descent: 12, energy: 'fuel', capacity: 8000, burn: 2600, climbFactor: 1.8, reserveMin: 45, bank: 25 } },
  supersonic: { label: tk('Supersônico (Mach 2)'), maxAlt: 18500, cruiseAlt: 17000, altMsl: true, splitKm: 300,
    perf: { mach: 2, cruise: 590, climb: 40, descent: 25, energy: 'fuel', capacity: 100000, burn: 22000, climbFactor: 1.5, reserveMin: 30, bank: 30 } },
  hypersonic: { label: tk('Hipersônico (Mach 6)'), maxAlt: 40000, cruiseAlt: 30000, altMsl: true, splitKm: 500,
    perf: { mach: 6, cruise: 1810, climb: 120, descent: 80, energy: 'fuel', capacity: 40000, burn: 45000, climbFactor: 1.4, reserveMin: 10, bank: 20 } },
}

/** Altitude em pés (arredondada a 10) ou metros. */
export function fmtAlt(m: number, units: 'aero' | 'metric'): string {
  return units === 'aero' ? `${Math.round(m / FT / 10) * 10} ft` : `${Math.round(m)} m`
}

/** "1h23" / "12 min" / "45 s". */
export function fmtEte(s: number): string {
  if (!Number.isFinite(s)) return '—'
  if (s >= 3600) {
    const m = Math.round(s / 60)
    return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
  }
  return s >= 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`
}

export function fmtEnergy(v: number, p: Perf): string {
  if (!Number.isFinite(v)) return '—'
  return p.energy === 'battery' ? `${Math.round(v)} Wh` : `${v.toFixed(v < 10 ? 1 : 0)} L`
}

export const fmtDeg = (d: number) => `${String(Math.round(d) % 360).padStart(3, '0')}°`
