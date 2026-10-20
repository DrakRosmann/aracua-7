import { describe, expect, it } from 'vitest'
import { alongTrack, angleDiff, bearing, crossTrack, destination, distance, enuToLatLon, greatCircle, inRing, intermediate, latLonToEnu } from './geo'

describe('geo', () => {
  const home = { lat: -23.55052, lon: -46.63331 }

  it('ENU ↔ lat/lon ida e volta', () => {
    const p = enuToLatLon(home, 120, -80)
    const back = latLonToEnu(home, p)
    expect(back.e).toBeCloseTo(120, 6)
    expect(back.n).toBeCloseTo(-80, 6)
  })

  it('distância bate com o deslocamento local', () => {
    expect(distance(home, enuToLatLon(home, 300, 400))).toBeCloseTo(500, -1)
    expect(distance(home, home)).toBe(0)
  })
})

describe('grande círculo', () => {
  const gru = { lat: -23.4356, lon: -46.4731 }
  const bsb = { lat: -15.8711, lon: -47.9186 }

  it('rumo e distância de Guarulhos a Brasília', () => {
    expect(distance(gru, bsb) / 1000).toBeCloseTo(853, -1)
    expect(bearing(gru, bsb)).toBeCloseTo(350, 0)
  })

  it('destino e ponto intermediário ficam no círculo', () => {
    const d = distance(gru, bsb)
    const p = destination(gru, bearing(gru, bsb), d)
    expect(distance(p, bsb)).toBeLessThan(5)
    const mid = intermediate(gru, bsb, 0.5)
    expect(distance(gru, mid)).toBeCloseTo(d / 2, -1)
    const pts = greatCircle(gru, bsb, 100_000)
    expect(pts.length).toBe(10)
    expect(pts[0]).toEqual(gru)
    expect(pts.at(-1)).toEqual(bsb)
  })

  it('desvio lateral e distância percorrida na perna', () => {
    const a = { lat: 0, lon: 0 }, b = { lat: 0, lon: 1 }
    const p = { lat: -0.01, lon: 0.5 }
    expect(crossTrack(a, b, p)).toBeCloseTo(1112, -1)
    expect(alongTrack(a, b, p)).toBeCloseTo(55_597, -2)
    expect(alongTrack(a, b, { lat: 0, lon: -0.1 })).toBeLessThan(0)
    expect(angleDiff(350, 10)).toBe(20)
    expect(angleDiff(10, 350)).toBe(-20)
  })

  it('ponto no polígono', () => {
    const sq: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]
    expect(inRing({ lat: 0.5, lon: 0.5 }, sq)).toBe(true)
    expect(inRing({ lat: 1.5, lon: 0.5 }, sq)).toBe(false)
  })
})
