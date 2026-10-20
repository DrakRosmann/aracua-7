// Geometria: plana local (bom até alguns quilômetros do home) e de grande círculo (voos longos).

const M_PER_DEG = 111_320

export interface LatLon {
  lat: number
  lon: number
}

export function enuToLatLon(origin: LatLon, e: number, n: number): LatLon {
  return {
    lat: origin.lat + n / M_PER_DEG,
    lon: origin.lon + e / (M_PER_DEG * Math.cos((origin.lat * Math.PI) / 180)),
  }
}

export function latLonToEnu(origin: LatLon, p: LatLon): { e: number; n: number } {
  return {
    e: (p.lon - origin.lon) * M_PER_DEG * Math.cos((origin.lat * Math.PI) / 180),
    n: (p.lat - origin.lat) * M_PER_DEG,
  }
}

/** Distância em metros entre dois pontos (haversine). */
export function distance(a: LatLon, b: LatLon): number {
  const R = 6_371_000
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLon = ((b.lon - a.lon) * Math.PI) / 180
  const la1 = (a.lat * Math.PI) / 180
  const la2 = (b.lat * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Polígono aproximando um círculo, para desenhar a geocerca. */
export function circle(center: LatLon, radius_m: number, steps = 96): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI
    const p = enuToLatLon(center, Math.sin(a) * radius_m, Math.cos(a) * radius_m)
    out.push([p.lon, p.lat])
  }
  return out
}

/** Padrão em zigue-zague para mapeamento, centrado em `center`. */
export function survey(center: LatLon, width: number, height: number, spacing: number, northSouth: boolean): LatLon[] {
  const pts: LatLon[] = []
  const across = northSouth ? width : height
  const n = Math.floor(across / spacing)
  for (let k = 0; k <= n; k++) {
    const o = -across / 2 + k * spacing
    let a: [number, number], b: [number, number]
    if (northSouth) {
      a = [o, -height / 2]
      b = [o, height / 2]
    } else {
      a = [-width / 2, o]
      b = [width / 2, o]
    }
    if (k % 2) [a, b] = [b, a]
    pts.push(enuToLatLon(center, a[0], a[1]), enuToLatLon(center, b[0], b[1]))
  }
  return pts
}

export function rectangle(center: LatLon, width: number, height: number): [number, number][] {
  return [
    [-width / 2, -height / 2],
    [width / 2, -height / 2],
    [width / 2, height / 2],
    [-width / 2, height / 2],
    [-width / 2, -height / 2],
  ].map(([e, n]) => {
    const p = enuToLatLon(center, e, n)
    return [p.lon, p.lat]
  })
}

// ---------- grande círculo (voos longos) ----------

const R_EARTH = 6_371_000
const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

/** Rumo verdadeiro inicial de a para b, 0–360°. */
export function bearing(a: LatLon, b: LatLon): number {
  const la1 = rad(a.lat), la2 = rad(b.lat), dl = rad(b.lon - a.lon)
  const y = Math.sin(dl) * Math.cos(la2)
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dl)
  return (deg(Math.atan2(y, x)) + 360) % 360
}

/** Ponto a `d` metros de `p` no rumo `brg` (grande círculo). */
export function destination(p: LatLon, brg: number, d: number): LatLon {
  const la1 = rad(p.lat), lo1 = rad(p.lon), b = rad(brg), dr = d / R_EARTH
  const la2 = Math.asin(Math.sin(la1) * Math.cos(dr) + Math.cos(la1) * Math.sin(dr) * Math.cos(b))
  const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(dr) * Math.cos(la1), Math.cos(dr) - Math.sin(la1) * Math.sin(la2))
  return { lat: deg(la2), lon: ((deg(lo2) + 540) % 360) - 180 }
}

/** Ponto na fração `f` (0–1) do grande círculo entre a e b. */
export function intermediate(a: LatLon, b: LatLon, f: number): LatLon {
  const d = distance(a, b) / R_EARTH
  if (d < 1e-9) return { ...a }
  const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d)
  const la1 = rad(a.lat), lo1 = rad(a.lon), la2 = rad(b.lat), lo2 = rad(b.lon)
  const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2)
  const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2)
  const z = A * Math.sin(la1) + B * Math.sin(la2)
  return { lat: deg(Math.atan2(z, Math.hypot(x, y))), lon: deg(Math.atan2(y, x)) }
}

/** Pontos do grande círculo de a a b, um a cada `step` metros no máximo (para desenhar ou voar). */
export function greatCircle(a: LatLon, b: LatLon, step = 20_000): LatLon[] {
  const n = Math.max(1, Math.ceil(distance(a, b) / step))
  return Array.from({ length: n + 1 }, (_, i) => (i === 0 ? { ...a } : i === n ? { ...b } : intermediate(a, b, i / n)))
}

/** Desvio lateral (m) de p em relação à perna a→b: positivo à direita. */
export function crossTrack(a: LatLon, b: LatLon, p: LatLon): number {
  const d13 = distance(a, p) / R_EARTH
  return Math.asin(Math.sin(d13) * Math.sin(rad(bearing(a, p) - bearing(a, b)))) * R_EARTH
}

/** Quanto de a→b já foi percorrido (m) até a projeção de p na perna. */
export function alongTrack(a: LatLon, b: LatLon, p: LatLon): number {
  const d13 = distance(a, p) / R_EARTH
  const xt = crossTrack(a, b, p) / R_EARTH
  const at = Math.acos(Math.max(-1, Math.min(1, Math.cos(d13) / Math.cos(xt)))) * R_EARTH
  return Math.cos(rad(bearing(a, p) - bearing(a, b))) < 0 ? -at : at
}

/** Diferença angular b − a em −180…180. */
export function angleDiff(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180
}

/** Ponto dentro do polígono (anel [lon, lat]), por paridade de cruzamentos. */
export function inRing(p: LatLon, ring: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if (yi > p.lat !== yj > p.lat && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
