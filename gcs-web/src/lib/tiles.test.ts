import { describe, expect, it } from 'vitest'
import { countTiles, tileAt, tilesIn, tileUrl } from './tiles'

describe('tiles', () => {
  it('acha o tile de um ponto', () => {
    expect(tileAt(0, 0, 1)).toEqual({ x: 1, y: 1 })
    expect(tileAt(-180, 85, 2)).toEqual({ x: 0, y: 0 })
    // São Paulo, z 10 (conferido no OpenStreetMap).
    expect(tileAt(-46.63331, -23.55052, 10)).toEqual({ x: 379, y: 580 })
  })

  it('conta e lista os tiles da área', () => {
    const b = { west: -46.64, south: -23.556, east: -46.627, north: -23.545 }
    const list = tilesIn(b, 14, 17)
    expect(list.length).toBe(countTiles(b, 14, 17))
    expect(new Set(list.map((t) => `${t.z}/${t.x}/${t.y}`)).size).toBe(list.length)
    expect(list.filter((t) => t.z === 14).length).toBeGreaterThanOrEqual(1)
    // Cada zoom a mais multiplica por ~4.
    expect(countTiles(b, 18, 18)).toBeGreaterThan(3 * countTiles(b, 17, 17))
  })

  it('monta a URL do servidor', () => {
    expect(tileUrl('https://s/{z}/{y}/{x}', { z: 3, x: 1, y: 2 })).toBe('https://s/3/2/1')
  })
})
