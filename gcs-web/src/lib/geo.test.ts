import { describe, expect, it } from 'vitest'
import { distance, enuToLatLon, latLonToEnu } from './geo'

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
