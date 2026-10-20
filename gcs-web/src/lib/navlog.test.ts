import { describe, expect, it } from 'vitest'
import { ChartIndex, chartsExpired, fmtLimit, limitM, type ChartPack } from './charts'
import { distance } from './geo'
import { coordinate, parseRoute, speedLevel } from './route'
import { computeNavlog, DEFAULT_LONG_RANGE, fmtEte, fmtNavDist, fmtTas, KT, liveNav, modePerf, NM, PRESETS, radioHorizon, soundSpeed, splitLegs, turnRadius, windTriangle, type Perf } from './navlog'
import { planRoute, restrictedOn, routeText, routeThrough } from './planner'

// Carta de brinquedo: aerovia W1 de ALFA a DELTA (DELTA–CHARL só no sentido W1 de ida),
// VOR BRV, aeródromos SBAA e SBDD, uma área restrita no meio do caminho e uma AMA.
const pack: ChartPack = {
  format: 'aracua-charts', version: 1, source: 'teste', fetched: 1,
  effective: '2026-10-01', next: '2026-10-29',
  fixes: [
    { id: 'ALFA', kind: 'wpt', lat: -23.0, lon: -46.0, var: -21 },
    { id: 'BRV', kind: 'vordme', lat: -22.5, lon: -46.0, freq: '113.10', var: -21 },
    { id: 'CHARL', kind: 'wpt', lat: -22.0, lon: -46.0 },
    { id: 'DELTA', kind: 'wpt', lat: -21.5, lon: -46.0 },
    { id: 'BRV', kind: 'wpt', lat: -10.0, lon: -40.0 },
  ],
  airports: [
    { id: 'SBAA', name: 'Partida', lat: -23.2, lon: -46.0, elev: 700, ifr: true, public: true },
    { id: 'SBDD', name: 'Destino', lat: -21.3, lon: -46.0, elev: 900, ifr: true, public: true },
    { id: 'SDPR', name: 'Fazenda', lat: -22.9, lon: -46.1, ifr: false, public: false },
  ],
  airways: [
    { airway: 'W1', upper: false, rnav: true, from: 'ALFA', to: 'BRV', seq: 10, dir: 'both', lo: { v: 45, u: 'FL', r: 'STD' }, hi: { v: 145, u: 'FL', r: 'STD' }, coords: [[-46, -23], [-46, -22.5]] },
    { airway: 'W1', upper: false, rnav: true, from: 'BRV', to: 'CHARL', seq: 20, dir: 'both', coords: [[-46, -22.5], [-46, -22]] },
    { airway: 'W1', upper: false, rnav: true, from: 'CHARL', to: 'DELTA', seq: 30, dir: 'back', coords: [[-46, -22], [-46, -21.5]] },
  ],
  airspaces: [
    { id: 'SBR001', kind: 'R', name: 'TIRO', lo: { v: 0, u: 'FT', r: 'SFC' }, hi: { v: 5000, u: 'FT', r: 'MSL' }, ring: [[-46.1, -22.3], [-45.9, -22.3], [-45.9, -22.2], [-46.1, -22.2], [-46.1, -22.3]] },
    { id: 'SBR002', kind: 'R', name: 'ALTO', lo: { v: 100, u: 'FL', r: 'STD' }, hi: { v: 200, u: 'FL', r: 'STD' }, ring: [[-46.1, -22.8], [-45.9, -22.8], [-45.9, -22.7], [-46.1, -22.7], [-46.1, -22.8]] },
    { id: 'AMA1', kind: 'AMA', name: 'AMA1', lo: { v: 4200, u: 'FT', r: 'STD' }, ring: [[-47, -23], [-45, -23], [-45, -21], [-47, -21], [-47, -23]] },
  ],
}
const charts = new ChartIndex(pack)
const home = { lat: -23.2, lon: -46.0 }

describe('cartas', () => {
  it('limites verticais em metros e como nas cartas', () => {
    expect(limitM({ v: 245, u: 'FL', r: 'STD' })).toBeCloseTo(7467.6, 1)
    expect(limitM({ v: 999, u: 'FL', r: 'STD' })).toBe(Infinity)
    expect(limitM({ v: 500, u: 'FT', r: 'SFC' }, 700)).toBeCloseTo(852.4, 1)
    expect(fmtLimit({ v: 45, u: 'FL', r: 'STD' })).toBe('FL045')
    expect(fmtLimit({ v: 0, u: 'FT', r: 'SFC' })).toBe('SFC')
    expect(fmtLimit({ v: 500, u: 'FT', r: 'SFC' })).toBe('500 ft AGL')
  })

  it('acha fixos pelo mais próximo e aeródromos pelo indicativo', () => {
    expect(charts.find('BRV', home)?.lat).toBe(-22.5)
    expect(charts.find('BRV', { lat: -10, lon: -40.1 })?.kind).toBe('wpt')
    expect(charts.find('BRV')?.kind).toBe('vordme')
    expect(charts.find('SBDD')?.kind).toBe('apt')
    expect(charts.find('XXXXX')).toBeNull()
    expect(charts.nearestAirports(home, 5).map((x) => x.a.id)).toEqual(['SBAA', 'SBDD'])
    expect(charts.nearestAirports(home, 5, false).map((x) => x.a.id)).toContain('SDPR')
    expect(charts.magVar({ lat: -22.4, lon: -46 })).toBe(-21)
  })

  it('caminho pela aerovia e sentido único', () => {
    const p = charts.airwayPath('W1', 'ALFA', 'DELTA')!
    expect(p.steps.map((s) => s.fix.id)).toEqual(['BRV', 'CHARL', 'DELTA'])
    expect(p.against).toEqual(['CHARL–DELTA'])
    const back = charts.airwayPath('W1', 'DELTA', 'ALFA')!
    expect(back.steps.map((s) => s.fix.id)).toEqual(['CHARL', 'BRV', 'ALFA'])
    expect(back.against).toEqual([])
    expect(charts.airwayPath('W1', 'ALFA', 'SBDD')).toBeNull()
  })

  it('vencimento da emenda', () => {
    expect(chartsExpired('2026-10-29', Date.parse('2026-10-20T12:00:00Z'))).toBe(false)
    expect(chartsExpired('2026-10-29', Date.parse('2026-10-29T00:00:01Z'))).toBe(true)
    expect(chartsExpired(null)).toBe(false)
  })
})

describe('rota', () => {
  it('grupos de velocidade/nível e coordenadas', () => {
    expect(speedLevel('N0090A045')!.speed).toBeCloseTo(46.3, 1)
    expect(speedLevel('N0090A045')!.alt).toBeCloseTo(1371.6, 1)
    expect(speedLevel('K0160S0150')).toEqual({ speed: 160 / 3.6, alt: 1500 })
    expect(speedLevel('SBSP')).toBeNull()
    expect(coordinate('2330S04637W')).toEqual({ lat: -23.5, lon: -(46 + 37 / 60) })
    expect(coordinate('23S046W')).toEqual({ lat: -23, lon: -46 })
    expect(coordinate('-23.5,-46.6')).toEqual({ lat: -23.5, lon: -46.6 })
    expect(coordinate('2330S046W')).toBeNull()
  })

  it('expande a aerovia entre a entrada e a saída', () => {
    const r = parseRoute('sbaa N0090A045 DCT ALFA W1 DELTA DCT SBDD', charts, home)
    expect(r.errors).toEqual([])
    expect(r.points.map((p) => `${p.id}:${p.via}`)).toEqual(['SBAA:DCT', 'ALFA:DCT', 'BRV:W1', 'CHARL:W1', 'DELTA:W1', 'SBDD:DCT'])
    expect(r.points[2].kind).toBe('vordme')
    expect(r.points[2].seg?.lo?.v).toBe(45)
    expect(r.points[4].alt).toBeCloseTo(1371.6, 1)
    expect(r.speed).toBeCloseTo(90 * KT, 3)
    expect(r.warnings.map((w) => w.vars?.legs)).toEqual(['CHARL–DELTA'])
  })

  it('aponta erros sem perder o resto da rota', () => {
    const r = parseRoute('HOME ALFA W1 SBDD NADA 2200S04600W W1', charts, home)
    expect(r.points.map((p) => p.id)).toEqual(['HOME', 'ALFA', 'SBDD', '2200S04600W'])
    expect(r.points[2].via).toBe('DCT')
    expect(r.errors.map((e) => e.text)).toEqual([
      '{fix} não está na {aw} a partir de {from}; ligado direto',
      '{tok}: não encontrado nas cartas',
      '{from} não está na {aw}',
    ])
    expect(parseRoute('ALFA', null, home).errors[0].text).toBe('{tok}: baixe as cartas para usar fixos e aerovias')
    expect(parseRoute('-23.1,-46.1 HOME', null, home).points.length).toBe(2)
  })
})

describe('navlog', () => {
  const perf: Perf = { cruise: 25, climb: 2, descent: 3, energy: 'battery', capacity: 4000, burn: 600, climbFactor: 1.5, reserveMin: 20, mach: 0, bank: 30, eco: { speed: 0.8, burn: 0.6 }, fast: { speed: 1.2, burn: 1.5 } }

  it('triângulo do vento', () => {
    const head = windTriangle(0, 25, { dir: 0, speed: 5 })
    expect(head.gs).toBeCloseTo(20, 6)
    expect(head.hdg).toBeCloseTo(0, 6)
    const cross = windTriangle(0, 25, { dir: 90, speed: 5 })
    expect(cross.hdg).toBeCloseTo(11.54, 1)
    expect(cross.gs).toBeCloseTo(Math.sqrt(25 ** 2 - 25), 3)
    expect(windTriangle(0, 10, { dir: 90, speed: 12 }).gs).toBe(0)
  })

  it('pernas, tempos, energia, PNR e espaço aéreo', () => {
    const r = parseRoute('ALFA W1 DELTA', charts, home)
    const points = r.points.map((p) => ({ ...p, name: p.id, alt: 600 }))
    const nl = computeNavlog({ home: { ...home, alt: 700 }, points, altMsl: false, perf, wind: { dir: 0, speed: 5 }, charts, returnHome: true, radio: 100_000 })
    expect(nl.legs.map((l) => l.to)).toEqual(['ALFA', 'BRV', 'CHARL', 'DELTA', 'HOME'])
    expect(nl.legs[1].via).toBe('W1')
    expect(nl.legs[1].tc).toBeCloseTo(0, 0)
    expect(nl.legs[1].mc).toBeCloseTo(21, 0)
    expect(nl.legs[1].gs).toBeCloseTo(20, 3)
    expect(nl.legs.at(-1)!.gs).toBeCloseTo(30, 3)
    expect(nl.legs.at(-1)!.isReturn).toBe(true)
    // Primeira perna sobe 600 m a 2 m/s: 300 s de subida, mais curta que o voo horizontal.
    expect(nl.legs[0].altA).toBe(700)
    expect(nl.legs[0].altB).toBe(1300)
    expect(nl.dist).toBeCloseTo(2 * distance(home, { lat: -21.5, lon: -46 }), -3)
    const sum = nl.legs.reduce((s, l) => s + l.energy, 0)
    expect(nl.energy).toBeCloseTo(sum, 6)
    expect(nl.reserve).toBe(200)
    expect(nl.margin).toBeCloseTo(3800 - sum, 6)
    expect(nl.margin).toBeGreaterThan(0)
    // A restrita baixa (até 5000 ft) é cruzada a 1300 m (4265 ft); a alta (FL100+), não.
    const ids = nl.conflicts.map((c) => `${c.id}:${c.level}`)
    expect(ids).toContain('SBR001:crit')
    expect(ids).not.toContain('SBR002:crit')
    // AMA de 4200 ft (1280 m): a 1300 m passa raspando; a subida inicial fica abaixo.
    expect(nl.conflicts.filter((c) => c.kind === 'AMA').map((c) => c.leg)).toEqual([0])
    // 4000 Wh a 600 W: a volta cabe de qualquer ponto; com 1500 Wh, o PNR fica no meio da ida.
    expect(nl.pnr).toBeNull()
    expect(nl.pnrBeyond).toBe(true)
    const tight = computeNavlog({ home: { ...home, alt: 700 }, points, altMsl: false, perf: { ...perf, capacity: 1500 }, wind: { dir: 0, speed: 5 }, charts, returnHome: true, radio: 100_000 })
    expect(tight.pnr).not.toBeNull()
    expect(tight.margin).toBeLessThan(0)
    expect(tight.pnr!.dist).toBeGreaterThan(0)
    expect(tight.pnr!.dist).toBeLessThan(tight.dist / 2)
    // Rádio de 100 km: DELTA fica a ~190 km do home.
    expect(nl.legs[3].noLink).toBe(true)
    expect(nl.legs[0].noLink).toBe(false)
  })

  it('ETP de um voo só de ida', () => {
    const points = [{ name: 'SBDD', lat: -21.3, lon: -46.0, alt: 1500 }]
    const calm = computeNavlog({ home: { ...home, alt: 700 }, points, altMsl: true, perf, wind: { dir: 0, speed: 0 }, charts: null, returnHome: false, radio: 0 })
    expect(calm.legs.length).toBe(1)
    expect(calm.etp!.dist / calm.dist).toBeCloseTo(0.5, 1)
    // Vento de frente: o ponto de igual tempo vai para perto do destino.
    const wind = computeNavlog({ home: { ...home, alt: 700 }, points, altMsl: true, perf, wind: { dir: 0, speed: 8 }, charts: null, returnHome: false, radio: 0 })
    expect(wind.etp!.dist).toBeGreaterThan(calm.etp!.dist)
  })

  it('divide pernas longas no grande círculo', () => {
    const pts = splitLegs(home, [{ name: 'X', lat: -21.3, lon: -46, alt: 100, via: 'W1' }], 50_000)
    expect(pts.map((p) => p.name)).toEqual(['X-4', 'X-3', 'X-2', 'X-1', 'X'])
    expect(pts.every((p) => p.alt === 100 && p.via === 'W1')).toBe(true)
    expect(splitLegs(home, pts, 0)).toBe(pts)
  })

  it('em voo: próximo ponto, destino, volta e bingo', () => {
    const route = [{ lat: -22.5, lon: -46, name: 'BRV' }, { lat: -21.5, lon: -46, name: 'DELTA' }]
    const l = liveNav({ pos: { lat: -22.9, lon: -46.01 }, perf, wind: { dir: 0, speed: 0 }, home, left: 1000, burnNow: null, route, active: 0 })
    expect(l.next!.name).toBe('BRV')
    expect(l.next!.dist).toBeCloseTo(distance({ lat: -22.9, lon: -46.01 }, route[0]), 3)
    expect(l.next!.xtk).toBeLessThan(0)
    expect(l.dest!.dist).toBeGreaterThan(l.next!.dist + 100_000)
    expect(l.home!.dist).toBeCloseTo(distance({ lat: -22.9, lon: -46.01 }, home), 3)
    expect(l.margin!).toBeCloseTo(1000 - 200 - (l.home!.dist / 25) * 600 / 3600, 3)
    expect(l.reach!).toBeCloseTo(((1000 - 200) / 600) * 3600 * 25, 3)
    const bingo = liveNav({ pos: { lat: -21.5, lon: -46 }, perf, wind: { dir: 180, speed: 10 }, home, left: 300, burnNow: 900, route, active: -1 })
    expect(bingo.margin!).toBeLessThan(0)
    expect(bingo.next).toBeNull()
    expect(bingo.burn).toBe(900)
  })

  it('unidades', () => {
    expect(fmtNavDist(NM * 12.34, 'aero')).toBe('12.3 NM')
    expect(fmtNavDist(250_000, 'metric')).toBe('250 km')
    expect(fmtEte(5000)).toBe('1h23')
    expect(fmtEte(600)).toBe('10 min')
    expect(DEFAULT_LONG_RANGE.maxAlt).toBe(120)
  })
})

describe('alta velocidade', () => {
  const base: Perf = { cruise: 25, climb: 40, descent: 25, energy: 'fuel', capacity: 100000, burn: 22000, climbFactor: 1.5, reserveMin: 30, mach: 2, bank: 30, eco: { speed: 0.85, burn: 0.7 }, fast: { speed: 1.1, burn: 1.4 } }

  it('atmosfera padrão e Mach', () => {
    expect(soundSpeed(0)).toBeCloseTo(340.3, 0)
    expect(soundSpeed(11_000)).toBeCloseTo(295.1, 0)
    expect(soundSpeed(15_000)).toBeCloseTo(295.1, 0)
    expect(soundSpeed(30_000)).toBeCloseTo(301.8, 0)
    expect(modePerf(base, 'normal', 17_000).cruise).toBeCloseTo(590.2, 0)
    expect(modePerf(base, 'eco', 17_000).cruise).toBeCloseTo(590.2 * 0.85, 0)
    expect(modePerf(base, 'fast', 17_000).burn).toBe(22000 * 1.4)
    expect(modePerf({ ...base, mach: 0 }, 'normal', 17_000).cruise).toBe(25)
    expect(fmtTas(590, 17_000, 'aero')).toBe('M2.00 · 1147 kt')
    expect(fmtTas(25, 0, 'metric')).toBe('90 km/h')
  })

  it('raio de curva e horizonte rádio', () => {
    expect(turnRadius(590, 30) / 1000).toBeCloseTo(61.5, 0)
    expect(turnRadius(22, 30)).toBeCloseTo(85.5, 0)
    expect(radioHorizon(2, 120) / 1000).toBeCloseTo(51, 0)
    expect(radioHorizon(2, 17_000) / 1000).toBeCloseTo(543, -1)
  })

  it('navlog supersônico: TOC, TOD, Mach e curvas que não cabem', () => {
    const points = [
      { name: 'A', lat: -23.2, lon: -40, alt: 17_000 },
      { name: 'B', lat: -15, lon: -40, alt: 17_000 },
      { name: 'C', lat: -15.3, lon: -39.7, alt: 17_000 },
    ]
    const nl = computeNavlog({ home: { ...home, alt: 700 }, points, altMsl: true, perf: base, wind: { dir: 0, speed: 0 }, charts: null, returnHome: true, radio: 600_000 })
    expect(nl.supersonic).toBe(true)
    expect(nl.legs[1].mach).toBeCloseTo(2, 2)
    // Subida de 16,3 km a 40 m/s: ~407 s a 75% de Mach 2 → ~180 km.
    expect(nl.toc!.dist / 1000).toBeCloseTo(180, -1)
    expect(nl.tod!.dist).toBeLessThan(nl.dist)
    // B→C tem ~45 km; virar ~135° a Mach 2 pede antecipação de ~150 km.
    expect(nl.legs[1].turnTight).toBe(true)
    expect(nl.legs[1].turnR! / 1000).toBeCloseTo(61.5, 0)
    // Subindo a 17 km o horizonte rádio passa de 500 km: A (613 km) fica abaixo dele; o começo da subida, não.
    expect(nl.legs[0].belowHorizon).toBe(true)
    const near = computeNavlog({ home: { ...home, alt: 700 }, points: [{ name: 'P', lat: -23.2, lon: -42, alt: 17_000 }], altMsl: true, perf: base, wind: { dir: 0, speed: 0 }, charts: null, returnHome: false, radio: 600_000 })
    expect(near.legs[0].belowHorizon).toBe(false)
    const low = computeNavlog({ home: { ...home, alt: 700 }, points: points.map((p) => ({ ...p, alt: 820 })), altMsl: true, perf: { ...base, mach: 0 }, wind: { dir: 0, speed: 0 }, charts: null, returnHome: false, radio: 600_000 })
    expect(low.legs[1].belowHorizon).toBe(true)
    expect(low.legs[1].noLink).toBe(true)
  })

  it('perfis prontos são coerentes', () => {
    for (const [k, p] of Object.entries(PRESETS)) {
      expect(p.cruiseAlt, k).toBeLessThanOrEqual(p.maxAlt)
      expect(p.perf.burn! > 0 && p.perf.capacity! > 0, k).toBe(true)
    }
    expect(PRESETS.hypersonic.perf.mach).toBe(6)
  })
})

describe('plano automático', () => {
  const perf: Perf = { ...DEFAULT_LONG_RANGE.perf, cruise: 25, burn: 100, capacity: 2000 }
  const from = { id: 'SBAA', kind: 'apt', lat: -23.2, lon: -46.0 }
  const to = { id: 'SBDD', kind: 'apt', lat: -21.3, lon: -46.0 }
  const req = { from, to, perf, direct: false, wind: { dir: 0, speed: 0 }, cruise: 1500, ground: 700, airways: 'auto' as const, avoid: false, join: 100_000 }

  it('vai pela aerovia no sentido permitido e escreve o campo 15', () => {
    // CHARL→DELTA é só de DELTA para CHARL: indo para o norte, a rede para em CHARL e sai por DCT.
    // Entrada e saída por DCT de até 80 km; CHARL–DELTA é contramão, então sai em CHARL.
    const r = planRoute(charts, { ...req, objective: 'fast', join: 80_000 })!
    expect(r.points.map((p) => `${p.via}>${p.id}`)).toEqual(['DCT>ALFA', 'W1>BRV', 'W1>CHARL', 'DCT>SBDD'])
    expect(r.text).toBe('SBAA DCT ALFA W1 CHARL DCT SBDD')
    expect(r.mode).toBe('fast')
    const back = planRoute(charts, { ...req, from: to, to: from, objective: 'eco', join: 80_000 })!
    expect(back.text).toBe('SBDD DCT DELTA W1 ALFA DCT SBAA')
    expect(back.mode).toBe('eco')
  })

  it('direto, mais rápido e mais econômico', () => {
    const d = planRoute(charts, { ...req, objective: 'fast', direct: true })!
    const f = planRoute(charts, { ...req, objective: 'fast', join: 80_000 })!
    const e = planRoute(charts, { ...req, objective: 'eco', join: 80_000 })!
    expect(d.text).toBe('SBAA DCT SBDD')
    expect(d.detour).toBe(1)
    expect(f.detour).toBeCloseTo(1, 2) // a W1 está na linha reta entre os dois
    expect(d.dist).toBeLessThanOrEqual(f.dist)
    expect(f.time).toBeLessThan(e.time)
    expect(e.energy).toBeLessThan(f.energy)
    // O direto passa pela restrita SBR001 (até 5000 ft, cruzeiro a 1500 m = 4921 ft).
    expect(d.crosses).toEqual(['R SBR001'])
  })

  it('desvia de área restrita e diz quando não há caminho', () => {
    expect(restrictedOn(charts, { lat: -22.5, lon: -46 }, { lat: -22, lon: -46 }, 1500, 700)).toEqual(['R SBR001'])
    // Com o desvio ligado, BRV–CHARL (que cruza a SBR001) fica de fora e não sobra rota.
    expect(planRoute(charts, { ...req, objective: 'fast', avoid: true, join: 30_000 })).toBeNull()
    expect(planRoute(null, { ...req, objective: 'fast' })).toBeNull()
    expect(routeText('HOME', [])).toBe('HOME')
  })
})

describe('aerovias entre os waypoints do plano', () => {
  const perf: Perf = { ...DEFAULT_LONG_RANGE.perf, cruise: 25, burn: 100, capacity: 2000 }
  const base = { objective: 'fast' as const, perf, wind: { dir: 0, speed: 0 }, ground: 700, airways: 'auto' as const, avoid: false, join: 80_000, toMsl: (a: number) => a + 700, maxDetour: 1.5 }

  it('liga home → A → B pelas aerovias e mantém os pontos do operador', () => {
    const pts = [
      { lat: -21.35, lon: -46.05, alt: 800, drop: [2] },
      { lat: -21.3, lon: -45.4, alt: 900 },
    ]
    const r = routeThrough(charts, home, pts, (i) => String.fromCharCode(65 + i), base)
    // Home (perto de SBAA) → A pela W1 (ALFA, BRV, CHARL) e A → B direto: não há aerovia para lá.
    expect(r.items.map((p) => p.name)).toEqual(['ALFA', 'BRV', 'CHARL', 'A', 'B'])
    expect(r.items.map((p) => (p as { via: string }).via)).toEqual(['DCT', 'W1', 'W1', 'DCT', 'DCT'])
    expect(r.items.slice(0, 3).every((p) => p.alt === 800)).toBe(true)
    expect((r.items[3] as { drop?: number[] }).drop).toEqual([2])
    expect(r.added).toBe(3)
    expect(r.legs.map((l) => `${l.how}:${l.why ?? ''}`)).toEqual(['airways:', 'dct:no-path'])
    expect(r.legs[0].text).toBe('HOME DCT ALFA W1 CHARL DCT A')
  })

  it('volta grande demais fica direta', () => {
    const r = routeThrough(charts, home, [{ lat: -21.35, lon: -46.05, alt: 800 }], () => 'X', { ...base, maxDetour: 1.0001 })
    expect(r.legs[0]).toMatchObject({ how: 'dct', why: 'detour' })
    expect(r.items.map((p) => p.name)).toEqual(['X'])
  })
})
