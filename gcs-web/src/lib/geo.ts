// Geometria plana local (bom até alguns quilômetros do home).

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
