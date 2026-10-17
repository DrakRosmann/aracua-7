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
async function pilha({ vehicle = 'copter', propulsion = 'electric', bridgeArgs = [], sim = true } = {}) {
  const p = { ws: ++port, mav: ++port, map: ++port }
  const dir = tempDir('teste')
  const ponte = run(bin('aracua-bridge'), [
    '--ws', `127.0.0.1:${p.ws}`, '--mavlink', `udpin:127.0.0.1:${p.mav}`, '--map-udp', `127.0.0.1:${p.map}`,
    '--payload-file', join(dir, 'entrega.json'), '--maintenance-file', join(dir, 'manutencao.json'), '--log-dir', join(dir, 'logs'), ...bridgeArgs,
  ])
  await sleep(400)
  const veiculo = sim ? run(bin('fake-vehicle'), ['--vehicle', vehicle, '--propulsion', propulsion, '--mavlink', `udpout:127.0.0.1:${p.mav}`, '--map', `127.0.0.1:${p.map}`]) : null
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
    const ponte = run(bin('aracua-bridge'), ['--ws', `0.0.0.0:${p}`, '--mavlink', `udpin:127.0.0.1:${++port}`, '--map-udp', `127.0.0.1:${++port}`, '--no-log', '--payload-file', join(tempDir('t'), 'e.json'), '--maintenance-file', join(tempDir('t'), 'e.json') + '.manut'])
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
      const nova = run(bin('aracua-bridge'), ['--ws', `127.0.0.1:${s.ws}`, '--mavlink', `udpin:127.0.0.1:${s.mav}`, '--map-udp', `127.0.0.1:${s.map}`, '--no-log', '--payload-file', join(s.dir, 'entrega.json'), '--maintenance-file', join(s.dir, 'entrega.json') + '.manut'])
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
      replay = run(bin('aracua-bridge'), ['--ws', `127.0.0.1:${rp}`, '--replay', join(s.dir, 'logs', logs[0]), '--replay-speed', '8', '--map-udp', `127.0.0.1:${++port}`, '--payload-file', join(s.dir, 'r.json'), '--maintenance-file', join(s.dir, 'r.json') + '.manut'])
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

  ['geocerca: envia, lê de volta e o veículo volta ao sair da área permitida', async () => {
    const s = await pilha()
    try {
      const c = await s.cliente()
      const sq = (half) => [[-half, -half], [half, -half], [half, half], [-half, half]].map(([e, n]) => desloca(HOME, n, e))
      const fence = { inclusion: [sq(120)], exclusion: [sq(15).map((p) => ({ lat: p.lat + 0.0006, lon: p.lon }))], circles_inclusion: [], circles_exclusion: [] }
      c.send({ cmd: 'fence_upload', fence })
      const up = await c.next('fence_upload', 15_000)
      if (!up.ok || up.count !== 8) throw new Error(`envio da geocerca: ${JSON.stringify(up)}`)
      // Ponte nova lê a cerca do veículo sozinha (depois da missão).
      s.ponte.kill()
      await sleep(500)
      s.ponte = run(bin('aracua-bridge'), ['--ws', `127.0.0.1:${s.ws}`, '--mavlink', `udpin:127.0.0.1:${s.mav}`, '--map-udp', `127.0.0.1:${s.map}`, '--no-log', '--payload-file', join(s.dir, 'entrega.json'), '--maintenance-file', join(s.dir, 'm.json')])
      await sleep(500)
      const c2 = await s.cliente()
      await c2.until(() => c2.msgs.some((m) => m.type === 'vehicle_fence'), 15_000, 'geocerca lida do veículo')
      const vf = c2.msgs.filter((m) => m.type === 'vehicle_fence').at(-1)
      if (vf.inclusion.length !== 1 || vf.exclusion.length !== 1 || vf.inclusion[0].length !== 4) throw new Error(`geocerca lida: ${JSON.stringify(vf)}`)
      if (metros(vf.inclusion[0][2], fence.inclusion[0][2]) > 0.5) throw new Error('vértice mudou de lugar')
      // Missão com um ponto fora da área permitida: o veículo tem de voltar (RTL).
      await voarMissao(c2, { items: [{ ...desloca(HOME, 60, 0), alt: 25 }, { ...desloca(HOME, 250, 0), alt: 25 }] })
      await c2.until(() => c2.t.mode === 'RTL', 90_000, 'RTL ao sair da área permitida')
      if (!c2.texts.some((t) => t.includes('Geocerca violada'))) throw new Error('sem aviso de geocerca violada')
      c2.close()
    } finally { s.stop() }
  }],

  ['manutenção: conta o voo e o ciclo da bateria', async () => {
    const s = await pilha()
    try {
      const c = await s.cliente()
      await c.until(() => c.msgs.some((m) => m.type === 'maintenance'), 5_000, 'registro de manutenção')
      const m0 = c.msgs.filter((m) => m.type === 'maintenance').at(-1)
      if (!m0 || m0.flights !== 0) throw new Error(`registro inicial: ${JSON.stringify(m0)}`)
      c.send({ cmd: 'takeoff', alt: 12 })
      await c.until(() => c.t.alt_rel > 10, 60_000, 'decolar')
      await sleep(4000)
      c.send({ cmd: 'mode', mode: 'LAND' })
      await c.until(() => !c.t.armed, 60_000, 'pousar e desarmar')
      await c.until(() => c.msgs.some((x) => x.type === 'maintenance' && x.flights === 1), 5_000, 'voo registrado')
      const m = c.msgs.filter((x) => x.type === 'maintenance' && x.flights === 1).at(-1)
      if (m.flight_s < 8) throw new Error(`tempo de voo ${m.flight_s} s`)
      const bat = m.batteries.find((b) => b.id === m.active_battery)
      if (bat?.cycles !== 1) throw new Error(`ciclos da bateria: ${bat?.cycles}`)
      if (m.history[0]?.max_alt < 10) throw new Error(`altura máxima ${m.history[0]?.max_alt}`)
      c.send({ cmd: 'maintenance_done', task: m.tasks[0].id, note: 'teste' })
      const m2 = await c.next('maintenance', 5_000, (x) => x.notes.some((n) => n.text.includes('teste')))
      if (m2.tasks[0].since_flights !== 0) throw new Error('a tarefa não zerou')
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

  ['motor elétrico: ESCs girando e bateria com células', async () => {
    const s = await pilha()
    try {
      const c = await s.cliente()
      await c.until(() => c.t.propulsion?.batteries[0]?.cells.length === 6, 5_000, 'bateria 6S com células')
      const b = c.t.propulsion.batteries[0]
      if (Math.abs(b.voltage - c.t.battery.voltage) > 0.3) throw new Error(`pack ${b.voltage} V, SYS_STATUS ${c.t.battery.voltage} V`)
      c.send({ cmd: 'takeoff', alt: 10 })
      await c.until(() => c.t.propulsion.escs.length === 4 && c.t.propulsion.escs.every((e) => e.rpm > 3000), 20_000, '4 ESCs acima de 3000 rpm')
      c.close()
    } finally { s.stop() }
  }],

  ['motor a combustão, turbina e híbrido', async () => {
    for (const [vehicle, propulsion, ok, what] of [
      ['plane', 'combustion', (p) => p.efi?.rpm > 1500 && p.named.CHT2 > 25 && p.named.FUEL > 80, 'EFI com rotação, CHT2 e tanque'],
      ['plane', 'jet', (p) => p.named.TURB_ST === 4 && p.efi?.rpm > 30_000 && p.efi.cht === null, 'turbina funcionando (TURB_ST 4)'],
      ['vtol', 'hybrid', (p) => p.generator?.status.includes('generating') && p.generator.power_w > 0 && p.escs.length === 5, 'gerador gerando'],
    ]) {
      const s = await pilha({ vehicle, propulsion })
      try {
        const c = await s.cliente()
        if (propulsion !== 'hybrid' && c.t.propulsion.escs.length) throw new Error(`${propulsion}: não devia ter ESC`)
        c.send({ cmd: 'arm', arm: true })
        await c.until(() => c.t.armed && ok(c.t.propulsion), 20_000, `${propulsion}: ${what}`)
        c.close()
      } finally { s.stop() }
    }
  }],
])

process.exit(falhas ? 1 : 0)
