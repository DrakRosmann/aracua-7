import { describe, expect, it } from 'vitest'
import { DEFAULT_PAD, MODE1, PadButtons, pickPad, readManual, shape, type PadSnapshot } from './gamepad'

const pad = (axes: number[], pressed: number[] = [], extra: Partial<PadSnapshot> = {}): PadSnapshot => ({
  id: 'Xbox Wireless Controller', index: 0, mapping: 'standard', connected: true, axes,
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 })),
  ...extra,
})

describe('controle', () => {
  it('zona morta e expo', () => {
    expect(shape(0.05, 0.08, 0.3)).toBe(0)
    expect(shape(1, 0.08, 0.3)).toBeCloseTo(1)
    expect(shape(-1, 0.08, 0.3)).toBeCloseTo(-1)
    // Sai de zero suave logo depois da zona morta e o expo reduz o meio do curso.
    expect(shape(0.1, 0.08, 0)).toBeCloseTo(0.0217, 3)
    expect(shape(0.54, 0.08, 0.5)).toBeLessThan(shape(0.54, 0.08, 0))
    expect(shape(NaN, 0.08, 0.3)).toBe(0)
  })

  it('modo 2: esquerdo acelera e gira, direito inclina; para cima é positivo', () => {
    // Esquerdo para cima e para a direita, direito para a frente e para a esquerda.
    const { m } = readManual(pad([1, -1, -1, -1]), { ...DEFAULT_PAD, expo: 0 }, 'copter', 0, 0.05)
    expect(m.z).toBeCloseTo(1)
    expect(m.r).toBeCloseTo(1)
    expect(m.x).toBeCloseTo(1)
    expect(m.y).toBeCloseTo(-1)
    // Soltos: centrado = manter (0,5).
    expect(readManual(pad([0, 0, 0, 0]), DEFAULT_PAD, 'copter', 0, 0.05).m).toEqual({ x: 0, y: 0, z: 0.5, r: 0 })
    // Modo 1: acelerador no direito.
    expect(readManual(pad([0, 0, 0, -1]), { ...DEFAULT_PAD, axes: MODE1 }, 'copter', 0, 0.05).m.z).toBeCloseTo(1)
  })

  it('acelerador incremental no avião fica onde parou', () => {
    let held = 0
    for (let i = 0; i < 20; i++) held = readManual(pad([0, -1, 0, 0]), DEFAULT_PAD, 'plane', held, 0.05).held
    expect(held).toBeCloseTo(0.6, 1)
    const solto = readManual(pad([0, 0, 0, 0]), DEFAULT_PAD, 'plane', held, 0.05)
    expect(solto.m.z).toBeCloseTo(held)
    expect(readManual(pad([0, 1, 0, 0]), DEFAULT_PAD, 'plane', 0.01, 1).m.z).toBe(0)
  })

  it('gatilhos: RT sobe, LT desce; no avião RT é o acelerador', () => {
    const s = { ...DEFAULT_PAD, throttleMode: 'triggers' as const }
    expect(readManual(pad([0, 0, 0, 0], [7]), s, 'copter', 0, 0.05).m.z).toBe(1)
    expect(readManual(pad([0, 0, 0, 0], [6]), s, 'copter', 0, 0.05).m.z).toBe(0)
    expect(readManual(pad([0, 0, 0, 0]), s, 'copter', 0, 0.05).m.z).toBe(0.5)
    expect(readManual(pad([0, 0, 0, 0]), s, 'plane', 0, 0.05).m.z).toBe(0)
  })

  it('armar só segurando; o resto ao apertar, uma vez', () => {
    const b = new PadButtons()
    const map = DEFAULT_PAD.buttons
    const press = (ids: number[]) => Array.from({ length: 17 }, (_, i) => ids.includes(i))
    expect(b.update(press([1]), map, 0)).toEqual(['rtl'])
    expect(b.update(press([1]), map, 100)).toEqual([])
    expect(b.update(press([9]), map, 200)).toEqual([])
    expect(b.holdProgress(map, 950)?.pct).toBeCloseTo(0.5)
    expect(b.update(press([9]), map, 1000)).toEqual([])
    expect(b.update(press([9]), map, 1700)).toEqual(['arm'])
    expect(b.update(press([9]), map, 3000)).toEqual([])
    expect(b.holdProgress(map, 3000)).toBeNull()
    // Soltou antes do tempo: não arma.
    b.update(press([]), map, 3100)
    b.update(press([9]), map, 3200)
    expect(b.update(press([]), map, 4000)).toEqual([])
  })

  it('escolhe o controle preferido ou o primeiro', () => {
    const a = pad([], [], { id: 'A', index: 0 }), c = pad([], [], { id: 'C', index: 2 })
    expect(pickPad([a, null, c], 'C')?.id).toBe('C')
    expect(pickPad([null, a, c], 'zzz')?.id).toBe('A')
    expect(pickPad([{ ...a, connected: false }], '')).toBeNull()
  })
})
