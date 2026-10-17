import { describe, expect, it } from 'vitest'
import { AlertTracker, bands, buildPanel, DEFAULT_ENGINE, detectKind, issues, level, LIMIT_DEFS, scaleLimit } from './engine'
import type { Propulsion, Telemetry } from '../types'

const prop = (p: Partial<Propulsion> = {}): Propulsion => ({ batteries: [], escs: [], efi: null, generator: null, rpm: [null, null], named: {}, ...p })
const efi = (rpm: number, cht: number | null = 150, egt: number | null = 600) => ({
  healthy: true, ecu_index: 0, rpm, fuel_consumed: 400, fuel_flow: 50, engine_load: 50, throttle: 50, cht, egt,
  intake_pressure: null, intake_temperature: null, barometric_pressure: null, ignition_voltage: null, fuel_pressure: null, age_ms: 100,
})
const tel = (p: Propulsion) => ({ connected: true, armed: true, battery: { voltage: 24, current: 10, remaining: 70, consumed_mah: 1500 }, propulsion: p }) as unknown as Telemetry

describe('motor', () => {
  it('nível pelas faixas', () => {
    const l = LIMIT_DEFS.cht.def
    expect(level(60, l)).toBe('warn')
    expect(level(150, l)).toBe('ok')
    expect(level(230, l)).toBe('warn')
    expect(level(260, l)).toBe('crit')
    expect(level(null, l)).toBe('none')
    expect(level(5, { min: 0, max: 10, redLo: null, yelLo: null, yelHi: null, redHi: null })).toBe('none')
  })

  it('faixas cobrem a escala na ordem', () => {
    const b = bands(LIMIT_DEFS.cell.def)
    expect(b.map((x) => x.level)).toEqual(['crit', 'warn', 'ok', 'warn', 'crit'])
    expect(b[0].from).toBe(3)
    expect(b.at(-1)!.to).toBe(4.35)
    expect(scaleLimit(LIMIT_DEFS.cell.def, 6).redLo).toBeCloseTo(19.8)
  })

  it('detecta o tipo de motor', () => {
    expect(detectKind(prop())).toBe('electric')
    expect(detectKind(prop({ efi: efi(5000) }))).toBe('combustion')
    expect(detectKind(prop({ efi: efi(90_000) }))).toBe('jet')
    expect(detectKind(prop({ efi: efi(0), named: { TURB_ST: 1 } }))).toBe('jet')
  })

  it('combustão: cilindros pela EFI e pelos scripts', () => {
    const p = buildPanel(tel(prop({ efi: efi(5200, 180, 700), named: { CHT2: 260, EGT2: 690, FUEL: 8 } })), DEFAULT_ENGINE)
    expect(p.kind).toBe('combustion')
    const cht = p.bars.find((m) => m.id === 'cht')!
    expect(cht.rows).toEqual([{ label: '1', value: 180 }, { label: '2', value: 260 }])
    expect(p.dials[1].rows[0].value).toBe(260)
    const keys = issues(p).map((i) => `${i.key}=${i.level}`)
    expect(keys).toContain('cht:2=crit')
    expect(keys).toContain('fuel:=crit')
    expect(keys.filter((k) => k.startsWith('chtMax'))).toEqual([])
  })

  it('elétrico: células e ESCs', () => {
    const cells = [4.0, 4.01, 3.9, 4.0, 4.0, 4.0]
    const p = buildPanel(tel(prop({
      batteries: [{ id: 0, function: 'propulsion', voltage: 23.91, current: 20, consumed_mah: 1000, energy_wh: 20, remaining: 70, temperature: 35, cells, time_remaining_s: null, charge_state: 'ok', faults: [], age_ms: 0 }],
      escs: [1, 2, 3, 4].map((n) => ({ n, rpm: 7000, temperature: n === 3 ? 105 : 50, voltage: 23.9, current: 5, consumed_mah: 250, age_ms: 0 })),
    })), DEFAULT_ENGINE)
    expect(p.kind).toBe('electric')
    expect(p.cells?.delta).toBeCloseTo(0.11)
    const keys = issues(p).map((i) => `${i.key}=${i.level}`)
    expect(keys).toContain('escTemp:3=crit')
    expect(keys).toContain('cellDelta=crit')
    expect(p.bars.find((m) => m.id === 'volts')!.lim.redLo).toBeCloseTo(19.8)
  })

  it('turbina: estado e tanque pela EFI', () => {
    const p = buildPanel(tel(prop({ efi: efi(110_000, null, 810), named: { TURB_ST: 4 } })), { ...DEFAULT_ENGINE, tankL: 2 })
    expect(p.kind).toBe('jet')
    expect(p.state?.text).toBe('FUNCIONANDO')
    expect(p.fuelPct).toBeCloseTo(80)
    expect(issues(p).some((i) => i.key === 'egtJet:' && i.level === 'crit')).toBe(true)
  })

  it('avisa ao piorar e só repete depois de normalizar', () => {
    const a = new AlertTracker(1000)
    const w = { key: 'x', level: 'warn' as const, text: 'x' }
    const c = { ...w, level: 'crit' as const }
    expect(a.update([w], 0)).toHaveLength(1)
    expect(a.update([w], 100)).toHaveLength(0)
    expect(a.update([c], 200)).toHaveLength(1)
    expect(a.update([w], 300)).toHaveLength(0)
    expect(a.update([c], 400)).toHaveLength(0)
    expect(a.update([], 500)).toHaveLength(0)
    expect(a.update([], 1600)).toHaveLength(0)
    expect(a.update([w], 1700)).toHaveLength(1)
  })
})
