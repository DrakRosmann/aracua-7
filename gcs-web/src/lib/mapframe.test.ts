// Confere o decodificador da interface contra os quadros de referência em docs/fixtures,
// os mesmos usados pelos testes da ponte (Rust) e do código de bordo (C++).

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeMapFrame } from './mapframe'

const fixture = (name: string) => {
  const b = readFileSync(new URL(`../../../docs/fixtures/${name}`, import.meta.url))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

describe('decodeMapFrame', () => {
  it('lê o AVX1 de referência', () => {
    const f = decodeMapFrame(fixture('avx1_exemplo.bin'))
    if (f?.kind !== 'voxels') throw new Error('esperava voxels')
    expect(f.reset).toBe(true)
    expect(f.originLat).toBe(-23.55052)
    expect(f.originLon).toBe(-46.63331)
    expect(f.originAlt).toBe(760)
    expect(f.voxelM).toBe(0.5)
    expect([...f.e]).toEqual([-3, 100, 32767])
    expect([...f.n]).toEqual([7, -250, -32768])
    expect([...f.u]).toEqual([12, 0, -1])
    expect([...f.cls]).toEqual([1, 0, 1])
  })

  it('lê o AOB1 de referência', () => {
    const f = decodeMapFrame(fixture('aob1_exemplo.bin'))
    if (f?.kind !== 'sectors') throw new Error('esperava setores')
    expect(f.distances.length).toBe(72)
    expect(f.incrementDeg).toBe(5)
    expect(f.maxRangeM).toBe(40)
    expect(f.distances[0]).toBeCloseTo(1.5)
    expect(f.distances[18]).toBeCloseTo(4.2)
    expect(f.distances[1]).toBe(Infinity)
  })

  it('recusa quadros truncados ou desconhecidos', () => {
    const avx = fixture('avx1_exemplo.bin')
    expect(decodeMapFrame(avx.slice(0, avx.byteLength - 1))).toBeNull()
    expect(decodeMapFrame(new TextEncoder().encode('XXXX\x01\x00\x00\x00').buffer as ArrayBuffer)).toBeNull()
    expect(decodeMapFrame(new ArrayBuffer(4))).toBeNull()
  })
})
