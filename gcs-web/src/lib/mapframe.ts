// Decodificação dos quadros binários do mapa LiDAR (AVX1 e AOB1).

export interface VoxelFrame {
  kind: 'voxels'
  reset: boolean
  originLat: number
  originLon: number
  originAlt: number
  voxelM: number
  /** Trios [leste, norte, cima] em voxels, mais classe; empacotados. */
  e: Int16Array
  n: Int16Array
  u: Int16Array
  cls: Uint8Array
}

export interface SectorFrame {
  kind: 'sectors'
  incrementDeg: number
  maxRangeM: number
  /** Distância em metros por setor (proa = 0, horário); Infinity = livre. */
  distances: Float32Array
}

export function decodeMapFrame(buf: ArrayBuffer): VoxelFrame | SectorFrame | null {
  if (buf.byteLength < 8) return null
  const dv = new DataView(buf)
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3))
  if (dv.getUint16(4, true) !== 1) return null
  if (magic === 'AVX1') {
    if (buf.byteLength < 36) return null
    const count = dv.getUint32(32, true)
    if (buf.byteLength !== 36 + count * 8) return null
    const e = new Int16Array(count), n = new Int16Array(count), u = new Int16Array(count), cls = new Uint8Array(count)
    for (let i = 0; i < count; i++) {
      const o = 36 + i * 8
      e[i] = dv.getInt16(o, true)
      n[i] = dv.getInt16(o + 2, true)
      u[i] = dv.getInt16(o + 4, true)
      cls[i] = dv.getUint8(o + 6)
    }
    return {
      kind: 'voxels',
      reset: (dv.getUint16(6, true) & 1) === 1,
      originLat: dv.getFloat64(8, true),
      originLon: dv.getFloat64(16, true),
      originAlt: dv.getFloat32(24, true),
      voxelM: dv.getFloat32(28, true),
      e, n, u, cls,
    }
  }
  if (magic === 'AOB1') {
    const count = dv.getUint16(6, true)
    if (buf.byteLength !== 16 + count * 2) return null
    const distances = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      const cm = dv.getUint16(16 + i * 2, true)
      distances[i] = cm === 0xffff ? Infinity : cm / 100
    }
    return { kind: 'sectors', incrementDeg: dv.getFloat32(8, true), maxRangeM: dv.getFloat32(12, true), distances }
  }
  return null
}
