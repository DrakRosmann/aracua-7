import { describe, expect, it } from 'vitest'
import { areaM2, emptyFence, fenceViolation, insideArea, sameFence } from './fence'
import { enuToLatLon } from './geo'

const home = { lat: -23.55, lon: -46.63 }
const square = (half: number) => [[-half, -half], [half, -half], [half, half], [-half, half]].map(([e, n]) => enuToLatLon(home, e, n))

describe('geocerca', () => {
  it('área de um quadrado de 200 m', () => {
    expect(areaM2(square(100))).toBeCloseTo(40_000, -2)
  })

  it('dentro, fora e área proibida', () => {
    const f = { ...emptyFence(), inclusion: [square(100)], exclusion: [square(10)] }
    expect(fenceViolation(enuToLatLon(home, 50, 0), f)).toBeNull()
    expect(fenceViolation(enuToLatLon(home, 150, 0), f)).toBe('outside')
    expect(fenceViolation(home, f)).toBe('forbidden')
    expect(insideArea(enuToLatLon(home, 99, 99), square(100))).toBe(true)
  })

  it('compara cercas ignorando ruído de arredondamento', () => {
    const a = { ...emptyFence(), inclusion: [square(100)] }
    const b = { ...emptyFence(), inclusion: [square(100).map((p) => ({ lat: p.lat + 1e-9, lon: p.lon }))] }
    expect(sameFence(a, b)).toBe(true)
    expect(sameFence(a, emptyFence())).toBe(false)
  })
})
