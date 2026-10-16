// Testes de ponta a ponta contra o veículo simulado (fake-vehicle):
//   node tests/simulador.mjs
// Usa bridge/target/debug (compile antes com `cargo build --bins` em bridge/).

import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Ponte, run, sleep, suite, tempDir, metros, desloca } from './ponte.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bin = (n) => process.env[`${n.toUpperCase().replace('-', '_')}_BIN`] ?? join(root, 'bridge', 'target', process.env.PROFILE ?? 'debug', n)
let port = 28700

/** Ponte + simulador em portas próprias (não esbarram num app aberto). */
async function pilha({ vehicle = 'copter', bridgeArgs = [], sim = true } = {}) {
  const p = { ws: ++port, mav: ++port, map: ++port }
  const dir = tempDir('teste')
  const ponte = run(bin('aracua-bridge'), [
    '--ws', `127.0.0.1:${p.ws}`, '--mavlink', `udpin:127.0.0.1:${p.mav}`, '--map-udp', `127.0.0.1:${p.map}`,
    '--payload-file', join(dir, 'entrega.json'), '--log-dir', join(dir, 'logs'), ...bridgeArgs,
  ])
  await sleep(400)
  const veiculo = sim ? run(bin('fake-vehicle'), ['--vehicle', vehicle, '--mavlink', `udpout:127.0.0.1:${p.mav}`, '--map', `127.0.0.1:${p.map}`]) : null
  return {
    ...p, dir, ponte, veiculo, url: `ws://127.0.0.1:${p.ws}`,
    async cliente(query = '') {
      const c = await new Ponte(this.url + query).connect()
      await c.until(() => c.t?.connected && c.t.home, 15_000, 'veículo conectado com home')
      return c
    },
    stop() { this.ponte.kill(); veiculo?.kill() },
  }
}

const HOME = { lat: -23.55052, lon: -46.63331 }

async function voarMissao(c, { items, ...rest }, decolar = 30) {
  c.send({ cmd: 'mission_upload', items, ...rest })
  const up = await c.next('mission_upload', 15_000)
  if (!up.ok) throw new Error(`envio recusado: ${up.result}`)
  await c.until(() => c.mission?.items.length === items.length, 5_000, 'missão do veículo atualizada')
  if (decolar) {
    c.send({ cmd: 'takeoff', alt: decolar })
    await c.until(() => c.t.alt_rel > decolar * 0.8, 90_000, `subir a ${decolar} m`)
  } else {
    c.send({ cmd: 'arm', arm: true })
    await c.until(() => c.t.armed, 10_000, 'armar')
  }
  c.send({ cmd: 'mission_start' })
  await c.until(() => c.t.mode === 'AUTO', 10_000, 'entrar em AUTO')
}

const falhas = await suite('Ponte + simulador', [
  ['token: recusa sem token e aceita com ele', async () => {
    const s = await pilha({ bridgeArgs: ['--token', 'segredo'], sim: false })
    try {
      const sem = await new Ponte(s.url).connect().then(() => true, () => false)
      if (sem) throw new Error('conectou sem token')
      const errado = await new Ponte(`${s.url}/?token=outro`).connect().then(() => true, () => false)
      if (errado) throw new Error('conectou com token errado')
      const c = await new Ponte(`${s.url}/?token=segredo`).connect()
      c.close()
    } finally { s.stop() }
  }],

  ['token: escutando na rede, a ponte gera um e recusa quem não tem', async () => {
    const p = ++port
    const ponte = run(bin('aracua-bridge'), ['--ws', `0.0.0.0:${p}`, '--mavlink', `udpin:127.0.0.1:${++port}`, '--map-udp', `127.0.0.1:${++port}`, '--no-log', '--payload-file', join(tempDir('t'), 'e.json')])
    try {
      await sleep(600)
      const linha = ponte.log.find((l) => l.includes('?token='))
      if (!linha) throw new Error('não mostrou o token no log')
      const token = linha.match(/token=([0-9a-f]{32})/)[1]
      const sem = await new Ponte(`ws://127.0.0.1:${p}`).connect().then(() => true, () => false)
      if (sem) throw new Error('conectou sem token')
      ;(await new Ponte(`ws://127.0.0.1:${p}/?token=${token}`).connect()).close()
    } finally { ponte.kill() }
  }],

  ['multirrotor: missão com entrega no ponto, download e retorno', async () => {
    const s = await pilha()
    try {
      const c = await s.cliente()
      c.send({ cmd: 'payload_arm', arm: true })
      const alvo = { ...desloca(HOME, 60, 40), alt: 25, drop: [1] }
      await voarMissao(c, { items: [{ ...desloca(HOME, 40, -30), alt: 30 }, alvo] })
      const rel = await c.next('payload_release', 120_000)
      const d = metros(rel.event, alvo)
      if (d > 5) throw new Error(`soltou a ${d.toFixed(1)} m do alvo`)
      if (rel.event.source !== 'missão') throw new Error(`origem ${rel.event.source}`)
      await c.until(() => !c.t.armed && c.t.alt_rel < 0.5, 180_000, 'pousar no RTL e desarmar')
      if (metros(c.t, HOME) > 5) throw new Error('pousou longe do home')
      c.close()
    } finally { s.stop() }
  }],

  ['download: ponte reiniciada lê a missão que está no veículo', async () => {
    const s = await pilha()
    try {
      const c = await s.cliente()
      const items = [{ ...desloca(HOME, 50, 0), alt: 30 }, { ...desloca(HOME, 50, 50), alt: 35, drop: [2] }, { ...desloca(HOME, 0, 50), alt: 30 }]
      c.send({ cmd: 'mission_upload', items })
      if (!(await c.next('mission_upload', 15_000)).ok) throw new Error('envio recusado')
      c.close()
      s.ponte.kill()
      await sleep(500)
      // Ponte nova, mesmo veículo: tem de baixar sozinha.
      const nova = run(bin('aracua-bridge'), ['--ws', `127.0.0.1:${s.ws}`, '--mavlink', `udpin:127.0.0.1:${s.mav}`, '--map-udp', `127.0.0.1:${s.map}`, '--no-log', '--payload-file', join(s.dir, 'entrega.json')])
      s.ponte = nova
      await sleep(500)
      const c2 = await s.cliente()
      await c2.until(() => c2.mission, 15_000, 'missão baixada do veículo')
      const m = c2.mission
      if (m.items.length !== 3) throw new Error(`${m.items.length} waypoints em vez de 3`)
      if (JSON.stringify(m.items[1].drop) !== '[2]') throw new Error(`entregas: ${JSON.stringify(m.items.map((w) => w.drop))}`)
      if (metros(m.items[2], items[2]) > 0.5) throw new Error('posição do waypoint mudou')
      if (!m.rtl_at_end) throw new Error('perdeu o RTL do fim')
      c2.close()
    } finally { s.stop() }
  }],

  ['avião: solta em voo antes do alvo e pousa no home', async () => {
    const s = await pilha({ vehicle: 'plane' })
    try {
      const c = await s.cliente()
      if (c.t.vehicle_class !== 'plane') throw new Error(`classe ${c.t.vehicle_class}`)
      c.send({ cmd: 'payload_arm', arm: true })
      c.send({ cmd: 'payload_config', slots: [{ id: 1, name: 'ENT1', actuator: { type: 'servo', channel: 5, pwm_locked: 1100, pwm_released: 1900 }, switch_bit: 0, mass_g: 250, enabled: true }], settings: { countdown_s: 3, min_alt_m: 5, require_armed: true, relock_s: 0, salvo_interval_s: 0.8, mission_hold_s: 4 } })
      const alvo = { ...desloca(HOME, 500, 0), alt: 40, drop: [1] }
      await voarMissao(c, { items: [{ ...desloca(HOME, 250, 200), alt: 50 }, alvo, { ...desloca(HOME, 400, -300), alt: 50 }], land_at_end: true, cruise_ms: 18 })
      const rel = await c.next('payload_release', 240_000)
      const d = metros(rel.event, alvo)
      const lead = 18 * Math.sqrt((2 * 40) / 9.81) * 0.85
      if (Math.abs(d - lead) > 15) throw new Error(`soltou a ${d.toFixed(0)} m do alvo; esperado ~${lead.toFixed(0)} m antes`)
      const pos = []
      const tk = setInterval(() => c.t && pos.push(`${c.t.mode} cur=${c.t.mission_current} alt=${c.t.alt_rel.toFixed(1)} gs=${c.t.groundspeed.toFixed(1)} home=${metros(c.t, HOME).toFixed(0)}`), 5000)
      try {
        await c.until(() => !c.t.armed && c.t.alt_rel < 0.5, 400_000, 'pousar no fim da missão e desarmar')
      } catch (e) {
        throw new Error(`${e.message}\n  trajetória: ${pos.slice(-12).join(' | ')}`)
      } finally { clearInterval(tk) }
      const dh = metros(c.t, HOME)
      if (dh > 150) throw new Error(`parou a ${dh.toFixed(0)} m do home`)
      c.close()
    } finally { s.stop() }
  }],

  ['VTOL: decola e pousa na vertical pela missão', async () => {
    const s = await pilha({ vehicle: 'vtol' })
    try {
      const c = await s.cliente()
      await voarMissao(c, { items: [{ ...desloca(HOME, 300, 300), alt: 40 }], land_at_end: true }, 0)
      await c.until(() => c.t.alt_rel > 20 && c.t.groundspeed < 3, 60_000, 'subir pairando')
      await c.until(() => c.t.groundspeed > 12, 90_000, 'seguir como avião')
      await c.until(() => !c.t.armed && c.t.alt_rel < 0.5, 300_000, 'pousar e desarmar')
      if (metros(c.t, HOME) > 6) throw new Error(`pousou a ${metros(c.t, HOME).toFixed(0)} m do home`)
      c.close()
    } finally { s.stop() }
  }],

  ['gravação e reprodução do voo', async () => {
    const s = await pilha()
    let replay
    try {
      const c = await s.cliente()
      c.send({ cmd: 'takeoff', alt: 15 })
      await c.until(() => c.t.alt_rel > 12, 60_000, 'decolar')
      c.send({ cmd: 'mode', mode: 'LAND' })
      await c.until(() => !c.t.armed, 60_000, 'pousar')
      c.close()
      await sleep(1500) // a ponte descarrega o log a cada segundo
      const logs = readdirSync(join(s.dir, 'logs')).filter((f) => f.endsWith('.tlog'))
      if (logs.length !== 1) throw new Error(`${logs.length} arquivos .tlog`)
      const rp = ++port
      replay = run(bin('aracua-bridge'), ['--ws', `127.0.0.1:${rp}`, '--replay', join(s.dir, 'logs', logs[0]), '--replay-speed', '8', '--map-udp', `127.0.0.1:${++port}`, '--payload-file', join(s.dir, 'r.json')])
      await sleep(500)
      const r = await new Ponte(`ws://127.0.0.1:${rp}`).connect()
      const hello = await r.next('hello', 3_000).catch(() => r.msgs.find((m) => m.type === 'hello'))
      if (!hello?.replay) throw new Error('hello sem replay: true')
      await r.until(() => r.t?.armed, 30_000, 'ver o veículo armar na reprodução')
      await r.until(() => r.t?.alt_rel > 10, 30_000, 'ver a decolagem na reprodução')
      r.send({ cmd: 'arm', arm: false })
      const err = await r.next('error', 3_000)
      if (!err.message.includes('reproduzindo')) throw new Error(`comando não foi barrado: ${err.message}`)
      r.send({ cmd: 'replay', paused: true })
      await r.until(() => r.msgs.at(-1)?.type === 'replay' ? r.msgs.at(-1).paused : r.msgs.filter((m) => m.type === 'replay').at(-1)?.paused, 3_000, 'pausar')
      const t0 = r.msgs.filter((m) => m.type === 'replay').at(-1).t
      await sleep(1500)
      if (r.msgs.filter((m) => m.type === 'replay').at(-1).t !== t0) throw new Error('o tempo andou pausado')
      if (!r.t.connected) throw new Error('veículo "sumiu" com a reprodução pausada')
      r.send({ cmd: 'replay', seek: 0, speed: 16 })
      await r.until(() => r.msgs.filter((m) => m.type === 'replay').at(-1).t < t0, 3_000, 'voltar ao começo')
      r.close()
    } finally { s.stop(); replay?.kill() }
  }],

  ['calibração do acelerômetro (6 posições) e da bússola', async () => {
    const s = await pilha()
    try {
      const c = await s.cliente()
      c.send({ cmd: 'calibrate', kind: 'accel' })
      for (let pos = 1; pos <= 6; pos++) {
        await c.next('calib', 5_000, (m) => m.kind === 'accel' && m.position === pos)
        c.send({ cmd: 'accel_pos', position: pos })
      }
      await c.next('calib', 5_000, (m) => m.kind === 'accel' && m.status === 'success')
      c.send({ cmd: 'calibrate', kind: 'compass' })
      await c.next('calib', 5_000, (m) => m.kind === 'compass' && m.pct > 0)
      const rep = await c.next('calib', 15_000, (m) => m.kind === 'compass_report')
      if (rep.status !== 'success') throw new Error(`bússola: ${rep.status}`)
      c.send({ cmd: 'takeoff', alt: 10 })
      await c.until(() => c.t.armed, 10_000, 'armar depois da calibração')
      c.send({ cmd: 'calibrate', kind: 'level' })
      const e = await c.next('error', 3_000)
      if (!e.message.includes('desarmados')) throw new Error('calibrou armado')
      c.close()
    } finally { s.stop() }
  }],

  ['rádio: canais na telemetria', async () => {
    const s = await pilha()
    try {
      const c = await s.cliente()
      await c.until(() => c.t.rc?.length === 8, 5_000, '8 canais de rádio')
      if (c.t.rc[2] > 1200) throw new Error(`acelerador em ${c.t.rc[2]}`)
      c.close()
    } finally { s.stop() }
  }],
])

process.exit(falhas ? 1 : 0)
