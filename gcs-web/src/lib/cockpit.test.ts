import { describe, expect, it } from 'vitest'
import { annunciators, DEFAULT_COCKPIT, LAYOUTS, setSlot, slotCount, slotsOf, type CockpitSettings } from './cockpit'
import { DEFAULT_ENGINE } from './engine'
import type { Telemetry } from '../types'

const tel = (p: Partial<Telemetry> = {}) => ({
  connected: true, armed: false, heartbeat_age_ms: 100, drop_rate_comm: 0, sensors_healthy: true, vibration: [5, 5, 5],
  gps: { fix_type: 3, fix: '3D_FIX', sats: 14, hdop: 0.8 }, battery: { voltage: 24, current: 1, remaining: 80, consumed_mah: 0 }, ...p,
}) as Telemetry
const opt = { engine: DEFAULT_ENGINE, nearest: Infinity, fenceOn: true, apOff: false }
const light = (t: Telemetry, id: string, o = opt) => annunciators(t, o).find((a) => a.id === id)?.light

describe('painel', () => {
  it('cada layout tem um padrão para cada espaço', () => {
    for (const l of Object.keys(LAYOUTS) as (keyof typeof LAYOUTS)[]) {
      expect(DEFAULT_COCKPIT.slots[l]).toHaveLength(slotCount(l))
      expect(slotsOf({ ...DEFAULT_COCKPIT, layout: l })).toHaveLength(slotCount(l))
    }
  })

  it('troca o instrumento só do layout atual e completa configurações antigas', () => {
    const s = setSlot(DEFAULT_COCKPIT, 1, 'hud')
    expect(slotsOf(s)).toEqual(['pfd', 'hud', 'nd'])
    expect(slotsOf(s, 'g4')).toEqual(DEFAULT_COCKPIT.slots.g4)
    const old = { ...DEFAULT_COCKPIT, layout: 'g4', slots: { ...DEFAULT_COCKPIT.slots, g4: ['adi', 'bogus'] } } as unknown as CockpitSettings
    expect(slotsOf(old)).toEqual(['adi', 'nd', 'camera', 'ems'])
  })

  it('luzes de alerta', () => {
    expect(annunciators(tel({ connected: false }), opt)).toEqual([expect.objectContaining({ id: 'link', light: 'crit' })])
    expect(light(tel(), 'gps')).toBe('off')
    expect(light(tel({ gps: { fix_type: 2, fix: '2D', sats: 5, hdop: 3 } }), 'gps')).toBe('crit')
    expect(light(tel({ battery: { voltage: 21, current: 10, remaining: 25, consumed_mah: 0 } }), 'bat')).toBe('warn')
    expect(light(tel({ battery: { voltage: 20, current: 10, remaining: 10, consumed_mah: 0 } }), 'bat')).toBe('crit')
    expect(light(tel({ armed: true }), 'arm')).toBe('warn')
    expect(light(tel({ sensors_healthy: false }), 'sens')).toBe('crit')
    expect(light(tel(), 'avoid', { ...opt, nearest: 4 })).toBe('crit')
    expect(light(tel(), 'fence', { ...opt, fenceOn: null })).toBeUndefined()
    const ap = { engaged: false, lateral: 'hdg', vertical: 'alt', hdg: 0, alt_sel: 0, alt_hold: 0, vs: 1, spd: 0, spd_on: false, message: 'x' } as const
    expect(light(tel({ ap }), 'ap', { ...opt, apOff: true })).toBe('crit')
    expect(light(tel({ ap: { ...ap, engaged: true } }), 'ap')).toBe('ok')
  })
})
