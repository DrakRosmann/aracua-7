// Cliente da ponte para os testes de ponta a ponta: conecta no WebSocket como a
// interface, manda comandos e espera condições na telemetria e nas mensagens.

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class Ponte {
  constructor(url) {
    this.url = url
    this.t = null
    this.msgs = []
    this.texts = []
    this.mission = null
    this.binary = 0
  }

  connect(timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      ws.binaryType = 'arraybuffer'
      const timer = setTimeout(() => reject(new Error(`sem conexão com ${this.url}`)), timeoutMs)
      ws.onopen = () => { clearTimeout(timer); this.ws = ws; resolve(this) }
      ws.onerror = () => { clearTimeout(timer); reject(new Error(`conexão recusada em ${this.url}`)) }
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') { this.binary++; return }
        const m = JSON.parse(ev.data)
        if (m.type === 'telemetry') this.t = m
        else this.msgs.push(m)
        if (m.type === 'statustext') this.texts.push(m.text)
        if (m.type === 'vehicle_mission') this.mission = m
        if (m.type === 'error') this.texts.push(`ERRO: ${m.message}`)
      }
    })
  }

  send(cmd) {
    this.ws.send(JSON.stringify(cmd))
  }

  /** Espera `pred()` ficar verdadeiro; falha com `desc` no prazo. */
  async until(pred, timeoutMs, desc) {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      try {
        if (pred()) return
      } catch { /* telemetria ainda não chegou */ }
      await sleep(100)
    }
    const t = this.t
    throw new Error(`prazo esgotado: ${desc}\n  estado: modo=${t?.mode} alt=${t?.alt_rel?.toFixed(1)} armado=${t?.armed} gps=${t?.gps?.fix}\n  últimas mensagens: ${this.texts.slice(-6).join(' | ')}`)
  }

  /** Próxima mensagem do tipo `type` (que chegar depois de agora). */
  async next(type, timeoutMs, pred = () => true) {
    const from = this.msgs.length
    let found = null
    await this.until(() => (found = this.msgs.slice(from).find((m) => m.type === type && pred(m))), timeoutMs, `mensagem ${type}`)
    return found
  }

  close() {
    this.ws?.close()
  }
}

/** Sobe um processo e o encerra no fim do teste. */
export function run(cmd, args, opts = {}) {
  const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts })
  p.log = []
  const keep = (d) => { p.log.push(...d.toString().split('\n').filter(Boolean)); if (p.log.length > 400) p.log.splice(0, p.log.length - 400) }
  p.stdout.on('data', keep)
  p.stderr.on('data', keep)
  return p
}

export const tempDir = (name) => mkdtempSync(join(tmpdir(), `aracua-${name}-`))

/** Distância em metros entre dois pontos {lat, lon}. */
export function metros(a, b) {
  const R = 6_371_000, r = Math.PI / 180
  const dl = (b.lat - a.lat) * r, dn = (b.lon - a.lon) * r
  const h = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dn / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** Ponto a `n` metros ao norte e `e` a leste de `p`. */
export function desloca(p, n, e) {
  return { lat: p.lat + n / 111_320, lon: p.lon + e / (111_320 * Math.cos((p.lat * Math.PI) / 180)) }
}

/** Executa os cenários em ordem e resume. */
export async function suite(nome, cenarios) {
  let falhas = 0
  // ONLY=texto roda só os cenários cujo título contém o texto.
  const only = process.env.ONLY
  cenarios = only ? cenarios.filter(([t]) => t.includes(only)) : cenarios
  for (const [titulo, fn] of cenarios) {
    const t0 = Date.now()
    try {
      await fn()
      console.log(`  ok   ${titulo} (${((Date.now() - t0) / 1000).toFixed(1)} s)`)
    } catch (e) {
      falhas++
      console.log(`  FALHOU ${titulo}\n    ${String(e.message ?? e).replaceAll('\n', '\n    ')}`)
    }
  }
  console.log(`${nome}: ${cenarios.length - falhas}/${cenarios.length} cenários ok`)
  return falhas
}
