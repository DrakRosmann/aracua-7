// Mapa offline: os tiles de fundo passam pelo protocolo `aracua-tile://`, que lê
// primeiro do IndexedDB e só vai à rede quando o tile não está guardado. Os tiles
// vistos com rede são guardados também, e uma área inteira pode ser baixada antes
// de ir a campo sem internet.

import { addProtocol } from 'maplibre-gl'

export const TILE_PROTOCOL = 'aracua-tile'
/** Teto de uma área baixada de uma vez (respeito ao servidor de tiles e ao disco). */
export const MAX_DOWNLOAD_TILES = 4000

const DB = 'aracua-tiles'
const STORE = 'tiles'

export interface Bounds { west: number; south: number; east: number; north: number }
export interface TileId { z: number; x: number; y: number }

/** Tile XYZ (Web Mercator) que contém o ponto. */
export function tileAt(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z
  const la = Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180
  const x = Math.floor(((lon + 180) / 360) * n)
  const y = Math.floor(((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n)
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) }
}

/** Todos os tiles que cobrem a área entre os zooms dados (inclusive). */
export function tilesIn(b: Bounds, minZ: number, maxZ: number): TileId[] {
  const out: TileId[] = []
  for (let z = minZ; z <= maxZ; z++) {
    const a = tileAt(b.west, b.north, z)
    const c = tileAt(b.east, b.south, z)
    for (let x = a.x; x <= c.x; x++) for (let y = a.y; y <= c.y; y++) out.push({ z, x, y })
  }
  return out
}

export function countTiles(b: Bounds, minZ: number, maxZ: number): number {
  let n = 0
  for (let z = minZ; z <= maxZ; z++) {
    const a = tileAt(b.west, b.north, z)
    const c = tileAt(b.east, b.south, z)
    n += (c.x - a.x + 1) * (c.y - a.y + 1)
  }
  return n
}

export function tileUrl(template: string, { z, x, y }: TileId): string {
  return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
}

let dbp: Promise<IDBDatabase> | null = null
function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1)
    r.onupgradeneeded = () => r.result.createObjectStore(STORE)
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
  return dbp
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

async function get(key: string): Promise<ArrayBuffer | undefined> {
  try {
    return await req((await db()).transaction(STORE).objectStore(STORE).get(key))
  } catch {
    return undefined
  }
}

async function put(key: string, data: ArrayBuffer) {
  try {
    await req((await db()).transaction(STORE, 'readwrite').objectStore(STORE).put(data, key))
  } catch {
    // Sem IndexedDB (aba privada, cota cheia): o mapa só não fica guardado.
  }
}

async function has(key: string): Promise<boolean> {
  try {
    return (await req((await db()).transaction(STORE).objectStore(STORE).count(key))) > 0
  } catch {
    return false
  }
}

export async function cacheStats(): Promise<{ tiles: number; bytes: number }> {
  try {
    const store = (await db()).transaction(STORE).objectStore(STORE)
    const tiles = await req(store.count())
    const est = await navigator.storage?.estimate?.()
    return { tiles, bytes: est?.usage ?? 0 }
  } catch {
    return { tiles: 0, bytes: 0 }
  }
}

export async function clearCache() {
  await req((await db()).transaction(STORE, 'readwrite').objectStore(STORE).clear())
}

let template = ''
let saveVisited = true

/** Liga o protocolo; chamar antes de criar o mapa. */
export function setupTiles(tpl: string, keepVisited: boolean) {
  template = tpl
  saveVisited = keepVisited
  if (setupTiles.done) return
  setupTiles.done = true
  addProtocol(TILE_PROTOCOL, async (params, abort) => {
    const [z, x, y] = params.url.slice(TILE_PROTOCOL.length + 3).split('/').map(Number)
    const url = tileUrl(template, { z, x, y })
    const cached = await get(url)
    if (cached) return { data: cached }
    const r = await fetch(url, { signal: abort.signal })
    if (!r.ok) throw new Error(`tile ${r.status}`)
    const data = await r.arrayBuffer()
    // Cópia: o MapLibre pode transferir o buffer original para outra thread.
    if (saveVisited) void put(url, data.slice(0))
    return { data }
  })
}
setupTiles.done = false

/** URL do tile para a fonte raster do MapLibre. */
export const PROTOCOL_URL = `${TILE_PROTOCOL}://{z}/{x}/{y}`

/**
 * Baixa os tiles da área para uso sem rede. Pula os que já estão guardados.
 * Quatro downloads de cada vez, para não abusar do servidor.
 */
export async function downloadArea(b: Bounds, minZ: number, maxZ: number, onProgress: (done: number, total: number, failed: number) => void, signal: AbortSignal) {
  const list = tilesIn(b, minZ, maxZ)
  if (list.length > MAX_DOWNLOAD_TILES) throw new Error(`área grande demais (${list.length} tiles)`)
  let done = 0, failed = 0, next = 0
  const worker = async () => {
    while (next < list.length && !signal.aborted) {
      const url = tileUrl(template, list[next++])
      try {
        if (!(await has(url))) {
          const r = await fetch(url, { signal })
          if (!r.ok) throw new Error(String(r.status))
          await put(url, await r.arrayBuffer())
        }
      } catch {
        if (!signal.aborted) failed++
      }
      onProgress(++done, list.length, failed)
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
  return { done, failed, total: list.length }
}
