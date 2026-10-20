// Plano de voo automático: da partida ao destino pela rede de aerovias (Dijkstra no grafo
// dos trechos, respeitando o sentido único), entrando e saindo dela por DCT, ou direto.
// "Mais rápido" voa no regime rápido e minimiza o tempo; "mais econômico", no regime
// econômico e minimiza a energia; os dois com o vento. Pelas aerovias, pode desviar de
// áreas restritas e proibidas no nível de cruzeiro.

import { limitM, type ChartIndex, type ChartSegment, type Place } from './charts'
import { bearing, distance, intermediate, inRing, type LatLon } from './geo'
import { modePerf, reserveEnergy, windTriangle, type Perf, type SpeedMode, type Wind } from './navlog'
import type { RoutePoint } from './route'

export type Objective = 'fast' | 'eco'

export interface PlanRequest {
  from: Place
  to: Place
  objective: Objective
  /** Direto (grande círculo) em vez de pelas aerovias. */
  direct: boolean
  perf: Perf
  wind: Wind
  /** Altitude de cruzeiro (m MSL). */
  cruise: number
  /** Elevação do home (m MSL), para os limites "do solo". */
  ground: number
  /** Aerovias usadas: auto escolhe pela altitude (superiores a partir do FL245). */
  airways: 'auto' | 'low' | 'high' | 'both'
  /** Não cruzar áreas restritas (R) e proibidas (P) no nível de cruzeiro. */
  avoid: boolean
  /** Distância máxima de um DCT para entrar ou sair da rede (m). */
  join: number
}

export interface PlannedRoute {
  objective: Objective
  direct: boolean
  mode: SpeedMode
  points: RoutePoint[]
  /** Rota no formato do campo 15 ("SBSP DCT RDE Z21 CTB DCT SBCT"). */
  text: string
  dist: number
  time: number
  energy: number
  /** Cabe na energia do perfil com a reserva (só ida). */
  fits: boolean
  /** Áreas R/P cruzadas (só no direto: as aerovias desviam quando `avoid`). */
  crosses: string[]
  /** Distância da rota sobre a direta (1 = direto). */
  detour: number
}

const FL245 = 245 * 100 * 0.3048

/** Nó do grafo: fixo numa posição (há fixos de mesmo nome em lugares diferentes). */
const key = (id: string, c: [number, number]) => `${id}@${c[1].toFixed(3)},${c[0].toFixed(3)}`

interface Edge { to: string; seg: ChartSegment | null; dist: number; a: LatLon; b: LatLon }

/** Heap binário mínimo, pequeno e suficiente para alguns milhares de nós. */
class Heap {
  private h: [number, string][] = []
  push(v: [number, string]) {
    const h = this.h
    h.push(v)
    for (let i = h.length - 1; i > 0;) {
      const p = (i - 1) >> 1
      if (h[p][0] <= h[i][0]) break
      ;[h[p], h[i]] = [h[i], h[p]]
      i = p
    }
  }
  pop(): [number, string] | undefined {
    const h = this.h
    const top = h[0]
    const last = h.pop()
    if (h.length && last) {
      h[0] = last
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1
        let m = i
        if (l < h.length && h[l][0] < h[m][0]) m = l
        if (r < h.length && h[r][0] < h[m][0]) m = r
        if (m === i) break
        ;[h[m], h[i]] = [h[i], h[m]]
        i = m
      }
    }
    return top
  }
  get size() {
    return this.h.length
  }
}

/** Áreas R/P cruzadas pela perna a→b no nível dado (nomes). */
export function restrictedOn(c: ChartIndex, a: LatLon, b: LatLon, alt: number, ground: number): string[] {
  const out: string[] = []
  const near = c.crossing(a, b).filter((j) => {
    const s = c.pack.airspaces[j]
    if (s.kind !== 'R' && s.kind !== 'P') return false
    const lo = limitM(s.lo, ground) ?? 0, hi = limitM(s.hi, ground) ?? Infinity
    return alt >= lo && alt <= hi
  })
  if (!near.length) return out
  const n = Math.max(2, Math.min(300, Math.ceil(distance(a, b) / 1500)))
  const hit = new Set<number>()
  for (let k = 0; k <= n; k++) {
    const p = intermediate(a, b, k / n)
    for (const j of near) {
      if (hit.has(j)) continue
      const [w, s, e, nn] = c.boxes[j]
      if (p.lon < w || p.lon > e || p.lat < s || p.lat > nn || !inRing(p, c.pack.airspaces[j].ring)) continue
      hit.add(j)
      out.push(`${c.pack.airspaces[j].kind} ${c.pack.airspaces[j].id}`)
    }
  }
  return out
}

function summarize(req: PlanRequest, mode: SpeedMode, points: RoutePoint[]) {
  const p = modePerf(req.perf, mode, req.cruise)
  let dist = 0, time = 0, prev: LatLon = req.from
  for (const q of points) {
    const d = distance(prev, q)
    const gs = windTriangle(bearing(prev, q), p.cruise, req.wind).gs
    dist += d
    time += gs > 0 ? d / gs : Infinity
    prev = q
  }
  // Subida até o cruzeiro, com o consumo maior.
  const climbT = Math.max(0, req.cruise - req.ground) / p.climb
  const energy = (time * p.burn) / 3600 + (climbT * p.burn * (p.climbFactor - 1)) / 3600
  return { dist, time, energy, fits: energy <= req.perf.capacity - reserveEnergy(req.perf) }
}

/** Texto do campo 15: fixos de entrada/saída de cada aerovia e DCT entre eles. */
export function routeText(fromId: string, points: RoutePoint[]): string {
  const out = [fromId]
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const next = points[i + 1]
    // Dentro da mesma aerovia, os fixos do meio ficam implícitos.
    if (p.via !== 'DCT' && next && next.via === p.via) continue
    out.push(p.via, p.id)
  }
  return out.join(' ')
}

export function planRoute(c: ChartIndex | null, req: PlanRequest): PlannedRoute | null {
  const mode: SpeedMode = req.objective
  const to: RoutePoint = { ...req.to, via: 'DCT', alt: req.cruise }
  const direct = (): PlannedRoute => {
    const points = [to]
    return {
      detour: 1,
      objective: req.objective, direct: true, mode, points, text: routeText(req.from.id, points), ...summarize(req, mode, points),
      crosses: c ? restrictedOn(c, req.from, req.to, req.cruise, req.ground) : [],
    }
  }
  if (req.direct) return direct()
  if (!c) return null

  const upper = req.airways === 'high' || (req.airways === 'auto' && req.cruise >= FL245)
  const lower = req.airways === 'low' || req.airways === 'both' || (req.airways === 'auto' && req.cruise < FL245)
  const both = req.airways === 'both'
  const p = modePerf(req.perf, mode, req.cruise)
  const cost = (a: LatLon, b: LatLon, d: number) => {
    const gs = windTriangle(bearing(a, b), p.cruise, req.wind).gs
    if (gs <= 0) return Infinity
    return req.objective === 'eco' ? (d / gs) * p.burn : d / gs
  }

  // Grafo: trechos das aerovias no sentido permitido.
  const adj = new Map<string, Edge[]>()
  const pos = new Map<string, { id: string; at: LatLon; kind: string }>()
  const blocked = new Map<ChartSegment, boolean>()
  const add = (from: string, e: Edge) => {
    const l = adj.get(from)
    if (l) l.push(e)
    else adj.set(from, [e])
  }
  // Aerovias inferior e superior no mesmo trecho: fica uma só (a do nível de cruzeiro), para a rota
  // não alternar entre as duas a cada fixo.
  const preferUpper = req.cruise >= FL245
  const segs = [...c.pack.airways].sort((x, y) => Number(x.upper !== preferUpper) - Number(y.upper !== preferUpper))
  const seen = new Set<string>()
  for (const s of segs) {
    if (!(both || (s.upper ? upper : lower))) continue
    const pair = s.from < s.to ? `${s.from}|${s.to}` : `${s.to}|${s.from}`
    if (seen.has(pair)) continue
    seen.add(pair)
    const a0 = s.coords[0], b0 = s.coords.at(-1)!
    const ka = key(s.from, a0), kb = key(s.to, b0)
    const a = { lat: a0[1], lon: a0[0] }, b = { lat: b0[1], lon: b0[0] }
    pos.set(ka, { id: s.from, at: a, kind: c.find(s.from, a)?.kind ?? 'wpt' })
    pos.set(kb, { id: s.to, at: b, kind: c.find(s.to, b)?.kind ?? 'wpt' })
    const d = distance(a, b)
    if (s.dir !== 'back') add(ka, { to: kb, seg: s, dist: d, a, b })
    if (s.dir !== 'fwd') add(kb, { to: ka, seg: s, dist: d, a: b, b: a })
  }
  const isBlocked = (e: Edge) => {
    if (!req.avoid) return false
    if (!e.seg) return restrictedOn(c, e.a, e.b, req.cruise, req.ground).length > 0
    let v = blocked.get(e.seg)
    if (v === undefined) blocked.set(e.seg, (v = restrictedOn(c, e.a, e.b, req.cruise, req.ground).length > 0))
    return v
  }
  // Entrada e saída da rede por DCT: os fixos de aerovia mais próximos da partida e do destino, até `join`.
  const S = '#start', E = '#end'
  const nearest = (q: LatLon, k: number) => [...pos.entries()]
    .map(([id, v]) => ({ id, d: distance(q, v.at) }))
    .filter((x) => x.d <= req.join)
    .sort((x, y) => x.d - y.d)
    .slice(0, k)
  for (const { id, d } of nearest(req.from, 10)) add(S, { to: id, seg: null, dist: d, a: req.from, b: pos.get(id)!.at })
  for (const { id, d } of nearest(req.to, 10)) add(id, { to: E, seg: null, dist: d, a: pos.get(id)!.at, b: req.to })

  // Dijkstra com parada no destino.
  const best = new Map<string, number>([[S, 0]])
  const prev = new Map<string, { from: string; e: Edge }>()
  const heap = new Heap()
  heap.push([0, S])
  while (heap.size) {
    const [g, u] = heap.pop()!
    if (u === E) break
    if (g > (best.get(u) ?? Infinity)) continue
    for (const e of adj.get(u) ?? []) {
      // DCT de entrada/saída custa 15% a mais: com custo parecido, fica a aerovia (como um despachante faria)
      // e o DCT não corta caminho até o meio dela.
      const ng = g + cost(e.a, e.b, e.dist) * (e.seg ? 1 : 1.15)
      if (ng >= (best.get(e.to) ?? Infinity) || isBlocked(e)) continue
      best.set(e.to, ng)
      prev.set(e.to, { from: u, e })
      heap.push([ng, e.to])
    }
  }
  if (!prev.has(E)) return null
  const points: RoutePoint[] = []
  for (let at = E; at !== S;) {
    const { from, e } = prev.get(at)!
    if (at === E) points.unshift(to)
    else {
      const n = pos.get(at)!
      points.unshift({ id: n.id, kind: n.kind, lat: n.at.lat, lon: n.at.lon, via: 'DCT', alt: req.cruise, seg: e.seg ?? undefined })
    }
    if (e.seg) points[0].via = e.seg.airway
    at = from
  }
  // O destino entra por DCT a partir do último fixo (a não ser que seja o próprio fixo).
  const last = points.at(-2)
  if (last && distance(last, to) < 50) {
    Object.assign(to, { via: last.via, seg: last.seg })
    points.splice(points.length - 2, 1)
  }
  const sum = summarize(req, mode, points)
  return { objective: req.objective, direct: false, mode, points, text: routeText(req.from.id, points), ...sum, crosses: [], detour: sum.dist / Math.max(1, distance(req.from, req.to)) }
}

// ---------- pelos waypoints do plano ----------

/** Waypoint do operador (lat, lon, altitude na referência do plano e o resto que ele carrega). */
export interface UserPoint extends LatLon { alt: number; name?: string }

export interface ThroughLeg {
  from: string
  to: string
  /** Rota da perna: aerovias, DCT (sem caminho ou volta grande demais) ou direto por escolha. */
  how: 'airways' | 'dct'
  text: string
  dist: number
  /** Por que ficou DCT, se ficou. */
  why?: 'no-path' | 'detour'
  /** Volta da melhor rota pelas aerovias (× o direto), quando ficou direto por isso. */
  detour?: number
}

export interface ThroughResult<T extends UserPoint> {
  /** Plano novo: os pontos do operador (como eram) e os fixos das aerovias entre eles. */
  items: (T | (LatLon & { alt: number; name: string; via: string }))[]
  legs: ThroughLeg[]
  /** Fixos acrescentados. */
  added: number
}

/**
 * Liga os waypoints do plano pelas aerovias, perna a perna, do home ao último. Os pontos do
 * operador ficam (com altitude, entrega e nome); os fixos entre eles herdam a altitude do ponto
 * seguinte. Uma perna fica direta quando não há caminho ou quando ele passa de `maxDetour` vezes a
 * distância direta.
 */
export function routeThrough<T extends UserPoint>(
  c: ChartIndex, start: LatLon, pts: T[], name: (i: number) => string,
  req: Omit<PlanRequest, 'from' | 'to' | 'direct' | 'cruise'> & { toMsl: (alt: number) => number; maxDetour: number },
): ThroughResult<T> {
  const items: ThroughResult<T>['items'] = []
  const legs: ThroughLeg[] = []
  let prev: Place = { id: 'HOME', kind: 'home', lat: start.lat, lon: start.lon }
  let added = 0
  pts.forEach((p, i) => {
    const id = p.name ?? name(i)
    const to: Place = { id, kind: 'user', lat: p.lat, lon: p.lon }
    const d = distance(prev, to)
    const one = (airways: PlanRequest['airways']) => planRoute(c, { ...req, airways, from: prev, to, direct: false, cruise: req.toMsl(p.alt) })
    let r = d < 1000 ? null : one(req.airways)
    // As aerovias do nível (só superiores lá em cima) não servem: tenta com todas e fica com a menor volta.
    if (d >= 1000 && req.airways !== 'both' && (!r || r.detour > req.maxDetour)) {
      const all = one('both')
      if (all && (!r || all.detour < r.detour)) r = all
    }
    // Um caminho que só pula de fixo em fixo por DCT não usa aerovia nenhuma: fica direto.
    const why = !r || r.points.every((q) => q.via === 'DCT') ? 'no-path' : r.detour > req.maxDetour ? 'detour' : undefined
    if (r && !why) {
      for (const q of r.points.slice(0, -1)) {
        items.push({ lat: q.lat, lon: q.lon, alt: p.alt, name: q.id, via: q.via })
        added++
      }
      legs.push({ from: prev.id, to: id, how: 'airways', text: r.text, dist: r.dist })
      items.push({ ...p, name: id, via: r.points.at(-1)!.via })
    } else {
      legs.push({ from: prev.id, to: id, how: 'dct', text: `${prev.id} DCT ${id}`, dist: d, why: d < 1000 ? undefined : why, detour: r?.detour })
      items.push({ ...p, name: id, via: 'DCT' })
    }
    prev = to
  })
  return { items, legs, added }
}
