// Testes de ponta a ponta contra o SITL oficial do ArduPilot (ArduCopter e ArduPlane):
//   SITL_DIR=pasta node tests/sitl.mjs
// SITL_DIR precisa ter arducopter, arduplane, copter.parm e plane.parm
// (ver tests/baixar-sitl.sh). SPEEDUP acelera a simulação (padrão 3).

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Ponte, run, sleep, suite, tempDir, metros, desloca } from './ponte.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SITL = process.env.SITL_DIR ?? join(root, 'tests', '.sitl')
const SPEEDUP = process.env.SPEEDUP ?? '3'
const bridgeBin = process.env.ARACUA_BRIDGE_BIN ?? join(root, 'bridge', 'target', process.env.PROFILE ?? 'debug', 'aracua-bridge')
const HOME = { lat: -35.363262, lon: 149.165237 } // CMAC, campo de testes do ArduPilot
let instance = 0

async function pilha(firmware, model, parm) {
  const i = instance++
  const dir = tempDir(`sitl-${model}`)
  const sitl = run(join(SITL, firmware), ['--model', model, '--speedup', SPEEDUP, '--home', `${HOME.lat},${HOME.lon},584,353`, '--defaults', join(SITL, parm), `-I${i}`], { cwd: dir })
  await sleep(1500)
  const ws = 29700 + i
  const ponte = run(bridgeBin, ['--mavlink', `tcpout:127.0.0.1:${5760 + 10 * i}`, '--ws', `127.0.0.1:${ws}`, '--map-udp', `127.0.0.1:${29800 + i}`, '--payload-file', join(dir, 'entrega.json'), '--log-dir', join(dir, 'logs')])
  await sleep(800)
  const c = await new Ponte(`ws://127.0.0.1:${ws}`).connect()
  return { c, dir, stop() { c.close(); ponte.kill(); sitl.kill() }, sitl, ponte }
}

/** Repete o comando até a condição valer (o ArduPilot recusa enquanto o EKF não está pronto). */
async function insistir(c, cmd, pred, timeoutMs, desc) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    c.send(cmd)
    for (let k = 0; k < 30; k++) {
      if (pred()) return
      await sleep(200)
    }
  }
  throw new Error(`prazo esgotado: ${desc}\n  últimas mensagens: ${c.texts.slice(-8).join(' | ')}`)
}

const falhas = await suite('Ponte + SITL do ArduPilot', [
  ['ArduCopter: pré-voo, missão com entrega, download, RTL e pouso', async () => {
    const s = await pilha('arducopter', '+', 'copter.parm')
    const { c } = s
    try {
      await c.until(() => c.t?.connected, 30_000, 'HEARTBEAT do SITL')
      if (c.t.vehicle_class !== 'copter') throw new Error(`classe ${c.t.vehicle_class}`)
      // Missão vazia no veículo: o download automático traz só o home.
      await c.until(() => c.mission, 20_000, 'download automático da missão')
      if (c.mission.items.length) throw new Error('missão inesperada no SITL novo')
      await c.until(() => c.t.gps.fix_type >= 3 && c.t.home, 120_000, 'GPS 3D e home')

      const alvo = { ...desloca(HOME, 80, 60), alt: 25, drop: [1] }
      c.send({ cmd: 'mission_upload', items: [{ ...desloca(HOME, 60, -40), alt: 30 }, alvo] })
      const up = await c.next('mission_upload', 20_000)
      if (!up.ok) throw new Error(`envio: ${up.result}`)
      c.mission = null
      c.send({ cmd: 'mission_download' })
      await c.until(() => c.mission, 20_000, 'download pedido')
      if (c.mission.items.length !== 2 || JSON.stringify(c.mission.items[1].drop) !== '[1]') throw new Error(`download: ${JSON.stringify(c.mission.items)}`)
      if (!c.mission.rtl_at_end) throw new Error('download sem RTL')

      await insistir(c, { cmd: 'takeoff', alt: 20 }, () => c.t.alt_rel > 5, 180_000, 'armar e decolar')
      await c.until(() => c.t.alt_rel > 17, 60_000, 'subir a 20 m')
      c.send({ cmd: 'mission_start' })
      await c.until(() => c.t.mode === 'AUTO', 15_000, 'AUTO')
      const rel = await c.next('payload_release', 240_000)
      if (rel.event.source !== 'missão') throw new Error(`lançamento atribuído a ${rel.event.source}`)
      const d = metros(rel.event, alvo)
      if (d > 8) throw new Error(`a entrega saiu a ${d.toFixed(1)} m do alvo`)
      // O item RTL da missão roda dentro do AUTO (o ArduCopter não troca de modo).
      await c.until(() => c.texts.some((t) => t.includes('RTL')), 120_000, 'item RTL no fim da missão')
      await c.until(() => !c.t.armed, 240_000, 'pousar e desarmar')
      if (metros(c.t, HOME) > 10) throw new Error(`pousou a ${metros(c.t, HOME).toFixed(0)} m do home`)
    } finally { s.stop() }
  }],

  ['ArduPlane: decolagem TAKEOFF, missão e pouso com DO_LAND_START', async () => {
    const s = await pilha('arduplane', 'plane', 'plane.parm')
    const { c } = s
    try {
      await c.until(() => c.t?.connected, 30_000, 'HEARTBEAT do SITL')
      if (c.t.vehicle_class !== 'plane') throw new Error(`classe ${c.t.vehicle_class} (${c.t.vehicle_type})`)
      await c.until(() => c.t.gps.fix_type >= 3 && c.t.home, 120_000, 'GPS 3D e home')
      // Missão para o norte (a pista do CMAC aponta para 353°) e pouso de volta.
      const items = [{ ...desloca(HOME, 600, 0), alt: 60 }, { ...desloca(HOME, 900, 300), alt: 60 }, { ...desloca(HOME, 500, 500), alt: 50 }]
      c.send({ cmd: 'mission_upload', items, land_at_end: true, approach_deg: 353 })
      const up = await c.next('mission_upload', 20_000)
      if (!up.ok) throw new Error(`envio: ${up.result}`)
      c.mission = null
      c.send({ cmd: 'mission_download' })
      await c.until(() => c.mission, 20_000, 'download pedido')
      if (c.mission.items.length !== 3 || !c.mission.land_at_end) throw new Error(`download: ${JSON.stringify(c.mission)}`)

      await insistir(c, { cmd: 'takeoff', alt: 40 }, () => c.t.armed && c.t.mode === 'TAKEOFF', 180_000, 'TAKEOFF e armar')
      await c.until(() => c.t.alt_rel > 30, 120_000, 'subir na decolagem')
      if (c.t.airspeed < 10) throw new Error(`voando a ${c.t.airspeed} m/s`)
      c.send({ cmd: 'mission_start' })
      await c.until(() => c.t.mode === 'AUTO', 15_000, 'AUTO')
      await c.until(() => c.t.alt_rel < 3 && c.t.groundspeed < 3, 600_000, 'pousar na pista')
      await c.until(() => !c.t.armed, 120_000, 'desarmar depois do pouso')
      const d = metros(c.t, HOME)
      if (d > 250) throw new Error(`parou a ${d.toFixed(0)} m do home`)
    } finally { s.stop() }
  }],
])

process.exit(falhas ? 1 : 0)
