// Geocerca por polígonos: áreas permitidas (o veículo tem de ficar dentro de todas) e
// proibidas. Mesmo formato que a ponte manda em `vehicle_fence`.

import { distance, latLonToEnu, type LatLon } from './geo'

export interface FenceCircle {
  lat: number
  lon: number
  radius: number
}

export interface FenceData {
  inclusion: LatLon[][]
  exclusion: LatLon[][]
  circles_inclusion: FenceCircle[]
  circles_exclusion: FenceCircle[]
}

export const emptyFence = (): FenceData => ({ inclusion: [], exclusion: [], circles_inclusion: [], circles_exclusion: [] })

export function fenceIsEmpty(f: FenceData | null | undefined): boolean {
  return !f || (!f.inclusion.length && !f.exclusion.length && !f.circles_inclusion.length && !f.circles_exclusion.length)
}

/** Ponto dentro do polígono (raio cruzando as arestas). */
export function insideArea(p: LatLon, poly: LatLon[]): boolean {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j]
    if (a.lat > p.lat !== b.lat > p.lat && p.lon < ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon) c = !c
  }
  return c
}

/** Área do polígono em m². */
export function areaM2(poly: LatLon[]): number {
  if (poly.length < 3) return 0
  const o = poly[0]
  const xy = poly.map((p) => latLonToEnu(o, p))
  let a = 0
  for (let i = 0; i < xy.length; i++) {
    const p = xy[i], q = xy[(i + 1) % xy.length]
    a += p.e * q.n - q.e * p.n
  }
  return Math.abs(a) / 2
}

/** Por que o ponto viola a cerca, ou null se está liberado. */
export function fenceViolation(p: LatLon, f: FenceData): 'outside' | 'forbidden' | null {
  if (f.inclusion.some((poly) => !insideArea(p, poly)) || f.circles_inclusion.some((c) => distance(p, c) > c.radius)) return 'outside'
  if (f.exclusion.some((poly) => insideArea(p, poly)) || f.circles_exclusion.some((c) => distance(p, c) < c.radius)) return 'forbidden'
  return null
}

export function sameFence(a: FenceData | null, b: FenceData | null): boolean {
  const norm = (f: FenceData | null) => JSON.stringify(f ?? emptyFence(), (_, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v))
  return norm(a) === norm(b)
}
