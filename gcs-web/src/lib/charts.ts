// Cartas aeronáuticas (vêm da ponte; ver bridge/src/charts.rs e docs/protocolo.md):
// índice de fixos e aeródromos, grafo das aerovias, limites verticais em metros e o
// GeoJSON das camadas do mapa, desenhadas como nas cartas ENRC.

import type * as GeoJSON from 'geojson'
import { distance, type LatLon } from './geo'

export const FT = 0.3048

/** Limite vertical: valor, unidade (FT, FL ou M) e referência (SFC, MSL ou STD). */
export interface Limit { v: number; u: string; r: string }

export interface ChartFix {
  id: string
  /** wpt, vor, vordme, dme ou ndb. */
  kind: string
  lat: number
  lon: number
  name?: string
  freq?: string
  /** Declinação magnética (graus, leste positiva). */
  var?: number
}

export interface ChartAirport { id: string; name: string; lat: number; lon: number; elev?: number; ifr: boolean; public: boolean }

export interface ChartSegment {
  airway: string
  upper: boolean
  rnav: boolean
  from: string
  to: string
  seq: number
  /** both, fwd (de `from` para `to`) ou back. */
  dir: string
  lo?: Limit
  hi?: Limit
  mea?: Limit
  coords: [number, number][]
}

export interface ChartAirspace { id: string; kind: string; name: string; lo?: Limit; hi?: Limit; ring: [number, number][] }

export interface ChartPack {
  format: string
  version: number
  source: string
  fetched: number
  effective?: string
  next?: string
  fixes: ChartFix[]
  airports: ChartAirport[]
  airways: ChartSegment[]
  airspaces: ChartAirspace[]
}

export interface ChartsInfo {
  type: 'charts_info'
  loaded: boolean
  id: number | null
  source: string | null
  fetched: number | null
  effective: string | null
  next: string | null
  counts: { fixes: number; airports: number; airways: number; airspaces: number } | null
  bytes: number | null
  busy: boolean
  error: string | null
}

/** Camadas das cartas que o operador liga e desliga. */
export interface ChartLayers {
  low: boolean
  high: boolean
  fixes: boolean
  navaids: boolean
  airports: boolean
  airspace: boolean
  restricted: boolean
  fir: boolean
  ama: boolean
}

export const DEFAULT_LAYERS: ChartLayers = { low: true, high: false, fixes: true, navaids: true, airports: true, airspace: true, restricted: true, fir: false, ama: false }

/** Espaços controlados, áreas especiais e grandes regiões, como o mapa separa. */
export const CONTROLLED = ['CTR', 'TMA', 'ATZ', 'CTA', 'UTA']
export const SPECIAL = ['R', 'P', 'D']
export const REGIONS = ['FIR', 'UIR', 'ADIZ']

/** Altitude do limite em metros acima do nível do mar; SFC soma a elevação do terreno dada. */
export function limitM(l: Limit | undefined, ground = 0): number | null {
  if (!l) return null
  if (l.u === 'FL') return l.v >= 999 ? Infinity : l.v * 100 * FT
  const m = l.u === 'M' ? l.v : l.v * FT
  return l.r === 'SFC' ? ground + m : m
}

/** Limite como nas cartas: FL245, 3500 ft, SFC, UNL. */
export function fmtLimit(l?: Limit): string {
  if (!l) return '—'
  if (l.u === 'FL') return l.v >= 999 ? 'UNL' : `FL${String(Math.round(l.v)).padStart(3, '0')}`
  if (l.v === 0 && l.r === 'SFC') return 'SFC'
  return `${Math.round(l.v)} ${l.u === 'M' ? 'm' : 'ft'}${l.r === 'SFC' ? ' AGL' : ''}`
}

/** Algo que pode ser ponto de rota: fixo, auxílio, aeródromo ou coordenada. */
export interface Place extends LatLon {
  id: string
  /** wpt, vor, vordme, dme, ndb, apt, coord ou home. */
  kind: string
  name?: string
  var?: number
}

interface Edge { to: string; seg: ChartSegment; forward: boolean; ok: boolean }

/** Trechos percorridos numa aerovia, com o fixo de chegada de cada um. */
export interface AirwayPath { steps: { fix: Place; seg: ChartSegment }[]; against: string[] }

type BBox = [number, number, number, number]

function bbox(ring: [number, number][]): BBox {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
  for (const [x, y] of ring) {
    if (x < w) w = x
    if (x > e) e = x
    if (y < s) s = y
    if (y > n) n = y
  }
  return [w, s, e, n]
}

export class ChartIndex {
  readonly fixes = new Map<string, ChartFix[]>()
  readonly airports = new Map<string, ChartAirport>()
  /** Aerovia → fixo → trechos que saem dele. */
  readonly graph = new Map<string, Map<string, Edge[]>>()
  /** Fixos usados por alguma aerovia (aparecem antes, ao afastar o mapa). */
  readonly onAirway = new Set<string>()
  readonly boxes: BBox[]
  readonly pack: ChartPack

  constructor(pack: ChartPack) {
    this.pack = pack
    for (const f of pack.fixes) {
      const l = this.fixes.get(f.id)
      if (l) l.push(f)
      else this.fixes.set(f.id, [f])
    }
    for (const a of pack.airports) if (!this.airports.has(a.id)) this.airports.set(a.id, a)
    for (const s of pack.airways) {
      let g = this.graph.get(s.airway)
      if (!g) this.graph.set(s.airway, (g = new Map()))
      const add = (from: string, e: Edge) => {
        const l = g.get(from)
        if (l) l.push(e)
        else g.set(from, [e])
      }
      add(s.from, { to: s.to, seg: s, forward: true, ok: s.dir !== 'back' })
      add(s.to, { to: s.from, seg: s, forward: false, ok: s.dir !== 'fwd' })
      this.onAirway.add(s.from)
      this.onAirway.add(s.to)
    }
    this.boxes = pack.airspaces.map((a) => bbox(a.ring))
  }

  get id() {
    return this.pack.fetched
  }

  /** Aeródromo, fixo ou auxílio com esse nome; havendo vários, o mais perto de `near`. */
  find(id: string, near?: LatLon | null): Place | null {
    const a = this.airports.get(id)
    if (a && id.length === 4) return { id, kind: 'apt', lat: a.lat, lon: a.lon, name: a.name }
    const list = this.fixes.get(id)
    if (!list?.length) return a ? { id, kind: 'apt', lat: a.lat, lon: a.lon, name: a.name } : null
    // Auxílio e fixo com o mesmo nome: perto do ponto anterior vence; sem referência, o auxílio.
    const pick = near
      ? list.reduce((b, f) => (distance(near, f) < distance(near, b) ? f : b))
      : list.find((f) => f.kind !== 'wpt') ?? list[0]
    return { id, kind: pick.kind, lat: pick.lat, lon: pick.lon, name: pick.name, var: pick.var }
  }

  /** Caminho pela aerovia de `from` a `to` (busca em largura, nos dois sentidos). */
  airwayPath(airway: string, from: string, to: string): AirwayPath | null {
    const g = this.graph.get(airway)
    if (!g?.has(from) || !g.has(to) || from === to) return null
    const prev = new Map<string, { at: string; e: Edge }>()
    const queue = [from]
    const seen = new Set([from])
    while (queue.length) {
      const cur = queue.shift()!
      if (cur === to) break
      for (const e of g.get(cur) ?? []) {
        if (seen.has(e.to)) continue
        seen.add(e.to)
        prev.set(e.to, { at: cur, e })
        queue.push(e.to)
      }
    }
    if (!prev.has(to)) return null
    const steps: AirwayPath['steps'] = []
    const against: string[] = []
    for (let at = to; at !== from;) {
      const { at: back, e } = prev.get(at)!
      const end = e.forward ? e.seg.coords.at(-1)! : e.seg.coords[0]
      const fix = this.fixes.get(at)?.find((f) => Math.abs(f.lat - end[1]) < 0.01 && Math.abs(f.lon - end[0]) < 0.01)
      steps.unshift({ fix: { id: at, kind: fix?.kind ?? 'wpt', lat: fix?.lat ?? end[1], lon: fix?.lon ?? end[0], name: fix?.name, var: fix?.var }, seg: e.seg })
      if (!e.ok) against.unshift(`${back}–${at}`)
      at = back
    }
    return { steps, against }
  }

  /** Aeródromos mais próximos de p. */
  nearestAirports(p: LatLon, n = 5, onlyPublic = true): { a: ChartAirport; d: number }[] {
    const out: { a: ChartAirport; d: number }[] = []
    for (const a of this.pack.airports) {
      if (onlyPublic && !a.public) continue
      // Corte rápido antes da conta exata (1° ≈ 111 km).
      if (Math.abs(a.lat - p.lat) > 5 || Math.abs(a.lon - p.lon) > 6) continue
      out.push({ a, d: distance(p, a) })
    }
    return out.sort((x, y) => x.d - y.d).slice(0, n)
  }

  /** Declinação magnética do fixo mais próximo que a tenha (até 300 km), ou null. */
  magVar(p: LatLon): number | null {
    let best: number | null = null, bd = 300_000
    for (const list of this.fixes.values()) {
      for (const f of list) {
        if (f.var === undefined || Math.abs(f.lat - p.lat) > 3 || Math.abs(f.lon - p.lon) > 3) continue
        const d = distance(p, f)
        if (d < bd) {
          bd = d
          best = f.var
        }
      }
    }
    return best
  }

  /** Espaços aéreos cuja caixa cruza a caixa da perna a→b (folga de ~0,1° para a curvatura). */
  crossing(a: LatLon, b: LatLon): number[] {
    const w = Math.min(a.lon, b.lon) - 0.1, e = Math.max(a.lon, b.lon) + 0.1
    const s = Math.min(a.lat, b.lat) - 0.1, n = Math.max(a.lat, b.lat) + 0.1
    const out: number[] = []
    this.boxes.forEach(([bw, bs, be, bn], i) => {
      if (be >= w && bw <= e && bn >= s && bs <= n) out.push(i)
    })
    return out
  }

  /** Espaços aéreos cuja caixa contém o ponto (o teste fino é com inRing). */
  candidates(p: LatLon): number[] {
    const out: number[] = []
    this.boxes.forEach(([w, s, e, n], i) => {
      if (p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n) out.push(i)
    })
    return out
  }
}

// ---------- GeoJSON das camadas ----------

const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features })

export function airwayFeatures(c: ChartIndex): GeoJSON.FeatureCollection {
  return fc(c.pack.airways.map((s) => ({
    type: 'Feature',
    properties: { aw: s.airway, upper: s.upper, rnav: s.rnav, oneway: s.dir !== 'both', lim: `${fmtLimit(s.hi)}/${fmtLimit(s.lo)}` },
    geometry: { type: 'LineString', coordinates: s.coords },
  })))
}

export function fixFeatures(c: ChartIndex): GeoJSON.FeatureCollection {
  return fc(c.pack.fixes.map((f) => ({
    type: 'Feature',
    properties: { id: f.id, kind: f.kind, aw: c.onAirway.has(f.id), label: f.kind === 'wpt' ? f.id : `${f.id} ${f.freq ?? ''}`.trim() },
    geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
  })))
}

export function airportFeatures(c: ChartIndex): GeoJSON.FeatureCollection {
  return fc(c.pack.airports.map((a) => ({
    type: 'Feature',
    properties: { id: a.id, name: a.name, ifr: a.ifr, pub: a.public },
    geometry: { type: 'Point', coordinates: [a.lon, a.lat] },
  })))
}

export function airspaceFeatures(c: ChartIndex): GeoJSON.FeatureCollection {
  return fc(c.pack.airspaces.map((a) => {
    // AMA como na ENRC: centenas de pés (067 = 6700 ft).
    const label = a.kind === 'AMA'
      ? String(Math.ceil((limitM(a.lo) ?? 0) / FT / 100)).padStart(3, '0')
      : `${a.kind} ${a.name}\n${fmtLimit(a.hi)} / ${fmtLimit(a.lo)}`
    return { type: 'Feature', properties: { id: a.id, kind: a.kind, label }, geometry: { type: 'Polygon', coordinates: [a.ring] } }
  }))
}

/** A emenda das cartas já venceu (o DECEA publica uma nova a cada ciclo AIRAC de 28 dias). */
export function chartsExpired(next: string | null | undefined, now = Date.now()): boolean {
  if (!next) return false
  const t = Date.parse(`${next}T00:00:00Z`)
  return Number.isFinite(t) && now >= t
}
