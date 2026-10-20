// Longo alcance: cartas no mapa, rota por aerovias, navlog com vento e energia,
// navegação em voo (próximo fixo, destino, bingo, direto para, aeródromos próximos)
// e a configuração do perfil da aeronave.

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { station, useChannels } from '../lib/store'
import { clamp, wpName } from '../lib/format'
import { bearing, distance } from '../lib/geo'
import { chartsExpired, FT, type ChartLayers, type ChartPack } from '../lib/charts'
import { coordinate, parseRoute, type RoutePoint } from '../lib/route'
import { planRoute, routeThrough, type PlannedRoute, type ThroughLeg } from '../lib/planner'
import {
  fmtAlt, fmtDeg, fmtEnergy, fmtEte, fmtNavDist, fmtSpeed, fmtTas, KT, modePerf, PRESETS, reserveEnergy, soundSpeed, splitLegs, windTriangle,
  type Conflict, type LongRangeSettings, type Navlog, type Perf, type SpeedMode,
} from '../lib/navlog'
import { Icon } from './Icons'
import { t as tr, tk } from '../lib/i18n'
import { vehicleClass, type MissionItem } from '../types'

const lrSave = (patch: Partial<LongRangeSettings>) => station.saveSettings({ longRange: { ...station.settings.longRange, ...patch } })
const perfSave = (patch: Partial<Perf>) => lrSave({ perf: { ...station.settings.longRange.perf, ...patch } })

const LAYER_LABEL: [keyof ChartLayers, string][] = [
  ['low', tk('Aerovias inferiores (ENRC L)')],
  ['high', tk('Aerovias superiores (ENRC H)')],
  ['fixes', tk('Fixos')],
  ['navaids', tk('Auxílios (VOR, DME, NDB)')],
  ['airports', tk('Aeródromos')],
  ['airspace', tk('Espaços controlados (CTR, TMA, ATZ)')],
  ['restricted', tk('Áreas restritas, proibidas e perigosas')],
  ['fir', tk('FIR')],
  ['ama', tk('Altitude mínima de área (AMA)')],
]

// ---------- botão "Cartas" dos trilhos ----------

export function ChartsButton({ top }: { top: number }) {
  useChannels('ui', 'charts')
  const [open, setOpen] = useState(false)
  const s = station.settings
  const info = station.chartsInfo
  const have = !!station.charts
  return (
    <>
      <button className={`rb ${s.chartsOn && have ? 'on' : ''}`} title={tr('Cartas aeronáuticas: aerovias, fixos, aeródromos e espaços aéreos')} onClick={() => setOpen(!open)}>
        <Icon.chart />{tr('Cartas')}
      </button>
      {open && (
        <div className="menu chartmenu" style={{ left: 66, top }}>
          {!have && <div className="hint">{info?.busy ? tr('Baixando as cartas…') : tr('Sem cartas. Baixe em Configurar → Longo alcance.')}</div>}
          <label className="tog"><input type="checkbox" checked={s.chartsOn} disabled={!have} onChange={(e) => station.saveSettings({ chartsOn: e.target.checked })} />{tr('Mostrar cartas')}</label>
          {LAYER_LABEL.map(([k, l]) => (
            <label key={k} className="tog sub2"><input type="checkbox" checked={s.chartLayers[k]} disabled={!have || !s.chartsOn}
              onChange={(e) => station.saveSettings({ chartLayers: { ...s.chartLayers, [k]: e.target.checked } })} />{tr(l)}</label>
          ))}
          <label className="tog"><input type="checkbox" checked={s.longRange.chartBase} disabled={!have || !s.chartsOn} onChange={(e) => lrSave({ chartBase: e.target.checked })} />{tr('Fundo de carta (sem satélite)')}</label>
          {have && info?.effective && <div className={`hint ${chartsExpired(info.next) ? 'warn' : ''}`}>{chartsExpired(info.next) ? tr('Emenda vencida em {date}: baixe de novo.', { date: info.next ?? '' }) : tr('{source}, emenda de {date}', { source: info.source ?? '', date: info.effective })}</div>}
          <div className="brow"><button className="btn" onClick={() => setOpen(false)}>{tr('Fechar')}</button></div>
        </div>
      )}
    </>
  )
}

// ---------- Planejar: rota por aerovias ----------

/** Plano a partir de pontos de rota: tira a partida, põe as altitudes no teto e divide pernas longas. */
function buildPlan(points: RoutePoint[], replace: boolean) {
  const lr = station.settings.longRange
  const home = station.telem?.home ?? null
  const max = station.maxAlt()
  let pts = points
  // A partida (home ou aeródromo onde o veículo está) não vira waypoint: é de onde ele decola.
  const first = pts[0]
  if (first && (first.kind === 'home' || (first.kind === 'apt' && home && distance(first, home) < 5000))) pts = pts.slice(1)
  if (!pts.length) return
  let clipped = false
  const alt = (msl?: number) => {
    let a = msl === undefined ? lr.cruiseAlt : lr.altMsl ? msl : msl - (home?.alt ?? 0)
    if (a > max) {
      clipped = true
      a = max
    }
    return Math.round(clamp(a, 5, max))
  }
  const named = pts.map((p) => ({ ...p, name: p.id, alt: alt(p.alt) }))
  const items = splitLegs(home, named, lr.splitKm * 1000).map((p) => ({ lat: p.lat, lon: p.lon, alt: p.alt, name: p.name, via: p.via }))
  station.setPlan(replace ? items : [...station.plan, ...items], -1)
  station.addLog('cmd', tr('Rota gerada: {n} waypoints', { n: items.length }))
  if (clipped) station.addLog('warn', tr('Altitudes da rota limitadas ao teto do plano ({max} m); ajuste em Configurar → Longo alcance', { max }))
  station.mapApi?.fit(home ? [home, ...items] : items)
}

export function RouteForm() {
  useChannels('charts', 'telemetry', 'ui', 'mission')
  const text = station.routeText
  const setText = (v: string) => {
    station.routeText = v
    station.emit('ui')
  }
  const [replace, setReplace] = useState(true)
  const lr = station.settings.longRange
  const home = station.telem?.home ?? null
  const charts = station.charts
  // Interpretar é rápido (busca em largura numa aerovia): refaz a cada render.
  const parsed = text.trim() ? parseRoute(text, charts, home ?? station.mapApi?.center() ?? null) : null
  const homeAlt = home?.alt ?? null
  const max = station.maxAlt()
  const build = () => parsed?.points.length && buildPlan(parsed.points, replace)
  const usesLevels = parsed?.points.some((p) => p.alt !== undefined)
  return (
    <details id="route">
      <summary><Icon.chart />{tr('Rota por aerovias')}<span className="ch"><Icon.chevron /></span></summary>
      <div className="db">
        <div className="hint">{tr('Como no campo 15 do plano de voo: fixos, aerovias e DCT. Ex.: SBMT DCT PAI UZ6 MNS DCT SBEG. Aceita coordenadas (2330S04637W), HOME e grupos de nível (N0090A045).')}</div>
        <textarea className="route" rows={3} value={text} spellCheck={false} placeholder="SBMT DCT PAI UZ6 MNS DCT SBEG" onChange={(e) => setText(e.target.value)} aria-label={tr('Rota')} />
        {!charts && <div className="warnbox">{tr('Sem cartas: só coordenadas e HOME. Baixe as cartas em Configurar → Longo alcance.')}</div>}
        {parsed && (
          <div className="hint">
            {parsed.points.length ? <b>{parsed.points.map((p) => (p.via !== 'DCT' ? `${p.via} ${p.id}` : p.id)).join(' · ')}</b> : null}
            {parsed.errors.map((m, i) => <div key={`e${i}`} className="crit">{tr(m.text, m.vars)}</div>)}
            {parsed.warnings.map((m, i) => <div key={`w${i}`} className="warn">{tr(m.text, m.vars)}</div>)}
            {parsed.speed !== undefined && <div>{tr('Velocidade no plano: {v} (o navlog usa a do perfil: {p})', { v: fmtSpeed(parsed.speed, lr.units), p: fmtSpeed(lr.perf.cruise, lr.units) })}</div>}
          </div>
        )}
        <div className="grid2">
          <label>{tr('Referência das altitudes')}
            <select value={lr.altMsl ? 'msl' : 'rel'} title={tr('Converte as altitudes do plano pela elevação do home')} onChange={(e) => station.setAltReference(e.target.value === 'msl')}>
              <option value="rel">{tr('Sobre o home')}</option>
              <option value="msl">{tr('Nível do mar (MSL)')}</option>
            </select>
          </label>
          <label>{tr('Cruzeiro (m)')}<input type="number" min={5} max={max} value={lr.cruiseAlt} disabled={usesLevels} title={usesLevels ? tr('A rota tem grupo de nível: vale o nível dela') : ''}
            onChange={(e) => lrSave({ cruiseAlt: clamp(+e.target.value || 5, 5, max) })} /></label>
          <label>{tr('Dividir pernas acima de (km)')}<input type="number" min={0} max={500} value={lr.splitKm} onChange={(e) => lrSave({ splitKm: clamp(+e.target.value || 0, 0, 500) })} /></label>
          <label className="row"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />{tr('Substituir plano')}</label>
        </div>
        {lr.altMsl && homeAlt !== null && <div className="hint">{tr('Home a {h} m MSL. Teto do plano: {max} m MSL.', { h: Math.round(homeAlt), max })}</div>}
        {lr.altMsl && homeAlt === null && <div className="warnbox">{tr('Altitudes MSL precisam do home do veículo: conecte antes de enviar.')}</div>}
        <div className="brow"><button className="btn on" disabled={!parsed?.points.length} onClick={build}>{tr('Gerar plano da rota')}</button></div>
      </div>
    </details>
  )
}

// ---------- Planejar: plano automático ----------

const OPTION_LABEL: Record<string, string> = {
  'net-fast': tk('Aerovias · mais rápido'),
  'net-eco': tk('Aerovias · mais econômico'),
  'dct-fast': tk('Direto · mais rápido'),
  'dct-eco': tk('Direto · mais econômico'),
}

export function AutoPlan() {
  useChannels('charts', 'telemetry', 'ui')
  const lr = station.settings.longRange
  const u = lr.units
  const p = lr.perf
  const [from, setFrom] = useState('HOME')
  const [to, setTo] = useState('')
  const [airways, setAirways] = useState<'auto' | 'low' | 'high' | 'both'>('auto')
  const [avoid, setAvoid] = useState(true)
  const [joinKm, setJoinKm] = useState(80)
  const [res, setRes] = useState<{ key: string; r: PlannedRoute | null }[] | null>(null)
  const [err, setErr] = useState('')
  const [objective, setObjective] = useState<'fast' | 'eco'>('fast')
  const [maxDetour, setMaxDetour] = useState(1.6)
  const [through, setThrough] = useState<ThroughLeg[] | null>(null)
  const [undo, setUndo] = useState<MissionItem[] | null>(null)
  const home = station.telem?.home ?? null
  const charts = station.charts
  const place = (tok: string) => {
    const t = tok.trim().toUpperCase()
    if (!t) return null
    const ref = home ?? station.mapApi?.center() ?? null
    if ((t === 'HOME' || t === 'CASA') && ref) return { id: 'HOME', kind: 'home', lat: ref.lat, lon: ref.lon }
    const c = coordinate(t)
    if (c) return { id: t, kind: 'coord', ...c }
    return charts?.find(t, ref) ?? null
  }
  const cruiseMsl = lr.altMsl ? lr.cruiseAlt : lr.cruiseAlt + (home?.alt ?? 0)
  const run = () => {
    const a = place(from), b = place(to)
    if (!a || !b) return setErr(tr('Partida ou destino não encontrado nas cartas (use indicativo ICAO, fixo, coordenada ou HOME).'))
    setErr('')
    const base = { from: a, to: b, perf: p, wind: station.wind(), cruise: cruiseMsl, ground: home?.alt ?? 0, airways, avoid, join: joinKm * 1000 }
    setRes([
      { key: 'net-fast', r: planRoute(charts, { ...base, objective: 'fast', direct: false }) },
      { key: 'net-eco', r: planRoute(charts, { ...base, objective: 'eco', direct: false }) },
      { key: 'dct-fast', r: planRoute(charts, { ...base, objective: 'fast', direct: true }) },
      { key: 'dct-eco', r: planRoute(charts, { ...base, objective: 'eco', direct: true }) },
    ])
  }
  const use = (r: PlannedRoute) => {
    lrSave({ speedMode: r.mode })
    station.routeText = r.text
    buildPlan(r.points, true)
  }
  // Liga os waypoints que o operador pôs no mapa pelas aerovias, perna a perna.
  const linkPlan = () => {
    const start = home ?? station.mapApi?.center()
    if (!charts || !start || !station.plan.length) return
    const before = station.plan
    const r = routeThrough(charts, start, before, wpName, {
      objective, perf: p, wind: station.wind(), ground: home?.alt ?? 0, airways, avoid, join: joinKm * 1000,
      toMsl: (a) => (lr.altMsl ? a : a + (home?.alt ?? 0)), maxDetour,
    })
    station.setPlan(r.items.map((q) => ({ ...q }) as MissionItem), -1)
    lrSave({ speedMode: objective })
    setUndo(before)
    setThrough(r.legs)
    station.addLog('cmd', tr('Waypoints ligados pelas aerovias: {n} fixos acrescentados', { n: r.added }))
  }
  const fastest = res?.filter((x) => x.r).reduce<PlannedRoute | null>((b, x) => (!b || x.r!.time < b.time ? x.r : b), null)
  const cheapest = res?.filter((x) => x.r).reduce<PlannedRoute | null>((b, x) => (!b || x.r!.energy < b.energy ? x.r : b), null)
  return (
    <details id="autoplan">
      <summary><Icon.route />{tr('Plano automático')}<span className="ch"><Icon.chevron /></span></summary>
      <div className="db">
        <div className="hint">{tr('Calcula a rota da partida ao destino pelas aerovias (no sentido permitido) ou direto, com o vento, e compara o regime rápido com o econômico.')}</div>
        <div className="grid2">
          <label>{tr('Partida')}<input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="HOME" /></label>
          <label>{tr('Destino')}<input value={to} onChange={(e) => setTo(e.target.value)} placeholder="SBBR" onKeyDown={(e) => e.key === 'Enter' && run()} /></label>
          <label>{tr('Aerovias')}<select value={airways} onChange={(e) => setAirways(e.target.value as typeof airways)}>
            <option value="auto">{tr('Pela altitude')}</option><option value="low">{tr('Inferiores')}</option><option value="high">{tr('Superiores')}</option><option value="both">{tr('Todas')}</option>
          </select></label>
          <label>{tr('DCT até a aerovia (km)')}<input type="number" min={5} max={2000} value={joinKm} onChange={(e) => setJoinKm(clamp(+e.target.value || 80, 5, 2000))} /></label>
          <label className="row"><input type="checkbox" checked={avoid} onChange={(e) => setAvoid(e.target.checked)} />{tr('Evitar áreas R e P')}</label>
        </div>
        <div className="hint">{tr('Cruzeiro a {alt} MSL (Rota por aerovias → Cruzeiro), vento {w}.', { alt: fmtAlt(cruiseMsl, u), w: windText(lr) })}</div>
        <div className="brow"><button className="btn on" disabled={!to.trim()} onClick={run}>{tr('Calcular rotas')}</button></div>
        {err && <div className="warnbox">{err}</div>}
        {res?.map(({ key, r }) => (
          <div key={key} className="option">
            <div className="option-h">
              <b>{tr(OPTION_LABEL[key])}</b>
              {r && r === fastest && <span className="tag">{tr('mais rápida')}</span>}
              {r && r === cheapest && <span className="tag eco">{tr('mais econômica')}</span>}
            </div>
            {r ? (
              <>
                <div className="option-v">
                  <span>{fmtNavDist(r.dist, u)}</span><span>{fmtEte(r.time)}</span>
                  <span className={r.fits ? 'ok' : 'crit'}>{fmtEnergy(r.energy, p)}{r.fits ? '' : ` · ${tr('não cabe')}`}</span>
                </div>
                <code>{r.text}</code>
                {r.crosses.length > 0 && <div className="hint crit">{tr('Cruza {areas}', { areas: r.crosses.join(', ') })}</div>}
                {r.detour > 1.3 && <div className="hint warn">{tr('{x}× a distância direta: no nível de cruzeiro a rede de aerovias (ou o desvio das áreas) obriga a dar a volta.', { x: r.detour.toFixed(1) })}</div>}
                <div className="brow"><button className="btn" onClick={() => use(r)}>{tr('Usar esta rota')}</button></div>
              </>
            ) : <div className="hint">{charts ? tr('Sem caminho pelas aerovias com essas opções (aumente o DCT até a aerovia ou desligue o desvio).') : tr('Baixe as cartas para planejar pelas aerovias.')}</div>}
          </div>
        ))}
        {res && <div className="hint">{tr('O regime da rota escolhida passa a valer no navlog. Confira a rota com as cartas oficiais e o plano de voo junto ao órgão ATC.')}</div>}
        <div className="sub">{tr('Pelos waypoints do plano')}</div>
        <div className="hint">{tr('Ponha os waypoints no mapa (com Waypoint ligado) e ligue cada perna, do home ao último, pelas aerovias. Os seus pontos ficam, com altitude e entrega; os fixos entre eles herdam a altitude do ponto seguinte.')}</div>
        <div className="grid2">
          <label>{tr('Objetivo')}<select value={objective} onChange={(e) => setObjective(e.target.value as 'fast' | 'eco')}>
            <option value="fast">{tr('Mais rápido')}</option><option value="eco">{tr('Mais econômico')}</option>
          </select></label>
          <label>{tr('Volta máxima (× o direto)')}<input type="number" min={1} max={5} step={0.1} value={maxDetour} onChange={(e) => setMaxDetour(clamp(+e.target.value || 1.6, 1, 5))} /></label>
        </div>
        <div className="brow">
          <button className="btn on" disabled={!charts || !station.plan.length} onClick={linkPlan}>{tr('Ligar os waypoints pelas aerovias')}</button>
          <button className="btn" disabled={!undo} onClick={() => { if (undo) station.setPlan(undo, -1); setUndo(null); setThrough(null) }}>{tr('Desfazer')}</button>
        </div>
        {!station.plan.length && <div className="hint">{tr('O plano está vazio: clique no mapa para pôr os waypoints.')}</div>}
        {through?.map((l, i) => (
          <div key={i} className={`hint ${l.how === 'dct' && l.why ? 'warn' : ''}`}>
            <b>{l.from} → {l.to}</b> · {l.how === 'airways' ? <code>{l.text}</code> : l.why === 'detour' ? tr('direto: pelas aerovias seria {x}× a distância', { x: (l.detour ?? 0).toFixed(1) }) : l.why === 'no-path' ? tr('direto: sem aerovia que sirva para esta perna') : tr('direto: pontos muito próximos')}
            {' · '}{fmtNavDist(l.dist, u)}
          </div>
        ))}
      </div>
    </details>
  )
}

// ---------- Planejar: navlog ----------

const CONFLICT_TEXT: Record<Conflict['level'], string> = {
  crit: tk('{kind} {id} {name} ({hi} / {lo}): área restrita ou proibida na rota'),
  warn: tk('{kind} {id} {name} ({hi} / {lo}): área perigosa na rota'),
  info: tk('{kind} {id} {name} ({hi} / {lo}): espaço controlado, coordene com o órgão ATC'),
}

function conflictText(c: Conflict, legs: Navlog['legs']) {
  const leg = legs[c.leg]
  const where = leg ? `${leg.from}→${leg.to}` : ''
  if (c.kind === 'AMA') return tr('{where}: abaixo da altitude mínima de área ({ama}); sem garantia de separação de obstáculos', { where, ama: c.lo })
  if (c.kind === 'FIR' || c.kind === 'UIR' || c.kind === 'ADIZ') return tr('{where}: cruza a {kind} {id} {name}', { where, kind: c.kind, id: c.id, name: c.name })
  return `${where}: ${tr(CONFLICT_TEXT[c.level], { kind: c.kind, id: c.id, name: c.name, hi: c.hi, lo: c.lo })}`
}

/** Um aviso por espaço aéreo (o primeiro trecho em que aparece). */
function uniqueConflicts(nl: Navlog): Conflict[] {
  const seen = new Set<string>()
  const order = { crit: 0, warn: 1, info: 2 }
  return nl.conflicts.filter((c) => {
    const k = c.kind === 'AMA' ? `AMA${c.leg}` : `${c.kind}${c.id}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  }).sort((a, b) => order[a.level] - order[b.level])
}

function windText(lr: LongRangeSettings) {
  const w = station.wind()
  const src = lr.windSource === 'measured' && station.telem?.wind && station.telem.connected ? tr('medido') : tr('informado')
  return w.speed < 0.3 ? tr('calmo ({src})', { src }) : `${fmtDeg(w.dir)} / ${fmtSpeed(w.speed, lr.units)} (${src})`
}

export function NavlogSection() {
  useChannels('mission', 'telemetry', 'charts', 'ui')
  const [sheet, setSheet] = useState(false)
  const lr = station.settings.longRange
  const u = lr.units
  const p = lr.perf
  const nl = station.plan.length ? station.navlog(station.plan) : null
  const cls = vehicleClass(station.telem)
  return (
    <details id="navlog">
      <summary><Icon.route />{tr('Navlog e combustível')}<span className="ch"><Icon.chevron /></span></summary>
      <div className="db">
        {!station.telem?.home && <div className="hint">{tr('Sem home: conecte o veículo (ou o simulador) para calcular o navlog.')}</div>}
        {!station.plan.length && <div className="hint">{tr('Monte um plano para ver rumos, tempos e energia de cada perna.')}</div>}
        <div className="kv"><span>{tr('Vento')}</span><b>{windText(lr)}</b></div>
        <div className="kv"><span>{tr('Perfil')}</span><b>{fmtSpeed(p.cruise, u)} · {p.energy === 'battery' ? `${p.capacity} Wh · ${p.burn} W` : `${p.capacity} L · ${p.burn} L/h`}</b></div>
        <label className="num">{tr('Regime')}
          <select value={lr.speedMode} onChange={(e) => lrSave({ speedMode: e.target.value as SpeedMode })}>
            <option value="normal">{tr('Cruzeiro normal')}</option><option value="eco">{tr('Econômico')}</option><option value="fast">{tr('Rápido')}</option>
          </select>
          <small>{fmtTas(modePerf(p, lr.speedMode, (lr.altMsl ? lr.cruiseAlt : lr.cruiseAlt + (station.telem?.home?.alt ?? 0))).cruise, lr.altMsl ? lr.cruiseAlt : lr.cruiseAlt + (station.telem?.home?.alt ?? 0), u)}</small>
        </label>
        <label className="tog"><input type="checkbox" checked={lr.oneWay} onChange={(e) => lrSave({ oneWay: e.target.checked })} />
          {cls === 'copter' || cls === 'heli' ? tr('Só ida: no fim, pairar sobre o último ponto') : tr('Só ida: no fim, circular sobre o último ponto')}</label>
        {nl && (
          <>
            <div className="vals nlvals">
              <div className="val"><span>{tr('Distância')}</span><b>{fmtNavDist(nl.dist, u)}</b></div>
              <div className="val"><span>{tr('Tempo')}</span><b>{fmtEte(nl.time)}</b></div>
              <div className="val"><span>{tr('Energia')}</span><b>{fmtEnergy(nl.energy, p)}</b></div>
              <div className="val"><span>{tr('Sobra no fim')}</span><b className={nl.margin < 0 ? 'crit' : nl.margin < p.capacity * 0.1 ? 'warn' : 'ok'}>{fmtEnergy(nl.margin, p)}</b></div>
            </div>
            {nl.margin < 0 && <div className="warnbox crit">{tr('Não dá: faltam {e} além da reserva de {r} ({min} min).', { e: fmtEnergy(-nl.margin, p), r: fmtEnergy(nl.reserve, p), min: p.reserveMin })}</div>}
            <div className="kv"><span>{tr('Ponto de não retorno')}</span><b className={nl.pnr ? 'warn' : ''}>{nl.pnr ? tr('{d} · {t} após a decolagem', { d: fmtNavDist(nl.pnr.dist, u), t: fmtEte(nl.pnr.time) }) : nl.pnrBeyond ? tr('volta possível de qualquer ponto') : '—'}</b></div>
            {lr.oneWay && <div className="kv"><span>{tr('Ponto de igual tempo')}</span><b>{nl.etp ? tr('{d} · {t} após a decolagem', { d: fmtNavDist(nl.etp.dist, u), t: fmtEte(nl.etp.time) }) : '—'}</b></div>}
            {nl.toc && <div className="kv"><span>{tr('Fim da subida (TOC)')}</span><b>{fmtNavDist(nl.toc.dist, u)}</b></div>}
            {nl.tod && <div className="kv"><span>{tr('Início da descida (TOD)')}</span><b>{tr('{d} antes do pouso', { d: fmtNavDist(nl.dist - nl.tod.dist, u) })}</b></div>}
            {nl.supersonic && <div className="warnbox">{tr('Voo supersônico: o estrondo sônico sobre terra é proibido em muitos países. Confirme a rota sobre o mar ou a autorização.')}</div>}
            {nl.legs.some((l) => l.turnTight) && <div className="warnbox">{tr('Curvas que não cabem nas pernas na velocidade do perfil ({n}): veja o navlog completo. Afaste os pontos ou aumente WP_RADIUS.', { n: nl.legs.filter((l) => l.turnTight).length })}</div>}
            {lr.radioKm > 0 && <div className="kv"><span>{tr('Fora do rádio')}</span><b className={nl.legs.some((l) => l.noLink) ? 'warn' : 'ok'}>{nl.legs.some((l) => l.noLink) ? tr('{n} pernas (até {d} do home)', { n: nl.legs.filter((l) => l.noLink).length, d: fmtNavDist(nl.maxRange, u) }) : tr('rota toda no alcance')}</b></div>}
            <div className="legs">
              {nl.legs.map((l, i) => (
                <div key={i} className={`leg ${l.noLink ? 'nolink' : ''}`}>
                  <b>{l.to}</b><small>{l.via !== 'DCT' ? l.via : ''}</small>
                  <span>{fmtDeg(l.tc)}{l.mc !== null ? ` (${fmtDeg(l.mc)}M)` : ''} · {fmtNavDist(l.dist, u)} · {fmtEte(l.time)} · {fmtEnergy(l.energy, p)}</span>
                </div>
              ))}
            </div>
            {uniqueConflicts(nl).map((c, i) => <div key={i} className={`hint ${c.level === 'info' ? '' : c.level}`}>{conflictText(c, nl.legs)}</div>)}
            {!station.charts && <div className="hint">{tr('Sem cartas, o navlog não confere espaço aéreo nem declinação magnética.')}</div>}
            <div className="brow"><button className="btn" onClick={() => setSheet(true)}>{tr('Navlog completo')}</button></div>
          </>
        )}
      </div>
      {/* Fora do painel: o desfoque dele prenderia a folha dentro dele. */}
      {sheet && nl && createPortal(<NavlogSheet nl={nl} onClose={() => setSheet(false)} />, document.body)}
    </details>
  )
}

function NavlogSheet({ nl, onClose }: { nl: Navlog; onClose: () => void }) {
  const lr = station.settings.longRange
  const u = lr.units
  const p = lr.perf
  const rows = nl.legs.map((l) => [
    `${l.from} → ${l.to}`, l.via, fmtDeg(l.tc), l.mc !== null ? fmtDeg(l.mc) : '—', fmtDeg(l.hdg), fmtNavDist(l.dist, u), fmtTas(l.tas, Math.max(l.altA, l.altB), u), fmtSpeed(l.gs, u),
    fmtEte(l.time), fmtEte(l.cumTime), fmtAlt(l.altB, u), fmtEnergy(l.energy, p), fmtEnergy(p.capacity - l.cumEnergy, p),
    [
      l.ama !== null && l.altB < l.ama ? `AMA ${Math.round(l.ama / FT)} ft` : '',
      l.belowHorizon ? tr('abaixo do horizonte rádio') : l.noLink ? tr('sem rádio') : '',
      l.seg?.lo ? `${l.via} ${l.seg.lo.u === 'FL' ? 'FL' + l.seg.lo.v : l.seg.lo.v + ' ft'}+` : '',
      l.turnTight && l.turnR !== null && l.turnLead !== null ? tr('curva: raio {r}, antecipa {a}', { r: fmtNavDist(l.turnR, u), a: fmtNavDist(l.turnLead, u) }) : '',
    ].filter(Boolean).join(' · '),
  ])
  const head = [tr('Perna'), tr('Via'), tr('RV'), tr('RM'), tr('Proa'), tr('Dist.'), tr('VA'), tr('VS'), tr('ETE'), tr('Acum.'), tr('Alt. MSL'), tr('Gasto'), tr('Resta'), tr('Notas')]
  const copy = async () => {
    const txt = [head, ...rows].map((r) => r.join('\t')).join('\n')
    try {
      await navigator.clipboard.writeText(txt)
      station.addLog('ok', tr('Navlog copiado'))
    } catch {
      station.addLog('warn', tr('Não foi possível copiar'))
    }
  }
  return (
    <div className="sheet" role="dialog" aria-label={tr('Navlog')}>
      <div className="sheet-h">
        <b>{tr('Navlog')}</b>
        <span>{tr('Vento')} {windText(lr)} · {tr('reserva')} {fmtEnergy(nl.reserve, p)} ({p.reserveMin} min)</span>
        <button className="btn" onClick={copy}>{tr('Copiar')}</button>
        <button className="btn" onClick={onClose}>{tr('Fechar')}</button>
      </div>
      <div className="tblw sheet-b">
        <table className="mav">
          <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i} className={nl.legs[i].noLink ? 'nolink' : ''}>{r.map((c, j) => <td key={j} className={j === 12 && p.capacity - nl.legs[i].cumEnergy < 0 ? 'crit' : ''}>{c}</td>)}</tr>)}</tbody>
          <tfoot><tr><td>{tr('Total')}</td><td /><td /><td /><td /><td>{fmtNavDist(nl.dist, u)}</td><td /><td /><td>{fmtEte(nl.time)}</td><td /><td /><td>{fmtEnergy(nl.energy, p)}</td><td className={nl.margin < 0 ? 'crit' : ''}>{fmtEnergy(p.capacity - nl.energy, p)}</td><td /></tr></tfoot>
        </table>
      </div>
      <div className="hint sheet-f">{tr('RV/RM: rumo verdadeiro e magnético (declinação do fixo mais próximo nas cartas). VA: velocidade verdadeira (Mach pela atmosfera padrão). VS: velocidade no solo com o vento. Tempos sem subida e descida detalhadas: confira com o manual da aeronave.')}</div>
    </div>
  )
}

// ---------- Voar: painel de navegação ----------

export function NavPanel() {
  useChannels('telemetry', 'mission', 'charts', 'ui')
  const [collapsed, setCollapsed] = useState(false)
  const [divert, setDivert] = useState<string | null>(null)
  const [dto, setDto] = useState(-1)
  if (!station.navOpen) return null
  const t = station.telem
  const lr = station.settings.longRange
  const u = lr.units
  const p = lr.perf
  const live = station.live()
  const on = !!t?.connected && !station.replay
  const left = station.energyLeft()
  const reserve = reserveEnergy(p)
  const w = station.wind()
  const air = !!t?.armed && (t?.alt_rel ?? 0) > 1
  // Hora de chegada pelo relógio da telemetria (a ponte manda a hora de cada quadro).
  const clock = (s: number) => (Number.isFinite(s) && t ? new Date(t.t + s * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—')
  const near = t?.lat && station.charts ? station.charts.nearestAirports(t, 5, lr.onlyPublic) : []
  const alarm = live?.margin != null && live.margin < 0 ? 'crit' : live?.margin != null && live.margin < p.capacity * 0.1 ? 'warn' : ''
  const head = t ? (w.speed > 0.3 ? Math.cos(((w.dir - t.heading) * Math.PI) / 180) * w.speed : 0) : 0
  return (
    <aside className={`navp ${collapsed ? 'collapsed' : ''} ${alarm}`} aria-label={tr('Navegação')}>
      <button className="rp-h" onClick={() => setCollapsed(!collapsed)}>
        <Icon.chevronUp />{tr('Navegação')}
        {alarm === 'crit' && <span className="ems-state crit">BINGO</span>}
      </button>
      {!collapsed && (
        <div className="rp-b">
          <div className="vals">
            <div className="val"><span>{tr('Próximo')}{live?.next ? ` · ${live.next.name}` : ''}</span><b>{live?.next ? fmtNavDist(live.next.dist, u) : '—'}<small>{live?.next ? fmtEte(live.next.ete) : ''}</small></b></div>
            <div className="val"><span>{tr('Rumo / proa')}</span><b>{live?.next ? `${fmtDeg(live.next.dtk)}` : '—'}<small>{live?.next ? fmtDeg(live.next.hdg) : ''}</small></b></div>
            <div className="val"><span>{tr('Destino')}{live?.dest ? ` · ${live.dest.name}` : ''}</span><b>{live?.dest ? fmtNavDist(live.dest.dist, u) : '—'}<small>{live?.dest ? clock(live.dest.ete) : ''}</small></b></div>
            <div className="val"><span>{tr('Na chegada')}</span><b className={live?.dest?.energy != null && live.dest.energy < reserve ? 'crit' : ''}>{live?.dest?.energy != null ? fmtEnergy(live.dest.energy, p) : '—'}</b></div>
            <div className="val"><span>{tr('Home')}</span><b>{live?.home ? fmtNavDist(live.home.dist, u) : '—'}<small>{live?.home ? `${fmtDeg(live.home.brg)} · ${fmtEte(live.home.ete)}` : ''}</small></b></div>
            <div className="val"><span>{tr('Sobra voltando agora')}</span><b className={alarm || (live?.margin != null ? 'ok' : '')}>{live?.margin != null ? fmtEnergy(live.margin, p) : '—'}</b></div>
          </div>
          <div className="db tight">
            {live?.next?.xtk != null && <div className="kv"><span>{tr('Desvio lateral')}</span><b className={Math.abs(live.next.xtk) > 500 ? 'warn' : ''}>{fmtNavDist(Math.abs(live.next.xtk), u)} {live.next.xtk > 0 ? tr('à direita') : tr('à esquerda')}</b></div>}
            <div className="kv"><span>{tr('Vento')}</span><b>{windText(lr)}{t && w.speed > 0.3 ? ` · ${head >= 0 ? tr('de frente') : tr('de cauda')} ${fmtSpeed(Math.abs(head), u)}` : ''}</b></div>
            {t && <div className="kv"><span>{tr('Velocidade no ar')}</span><b>{fmtTas(t.airspeed, t.alt_msl, u)}</b></div>}
            <div className="kv"><span>{tr('Energia a bordo')}</span><b>{left !== null ? `${fmtEnergy(left, p)} · ${tr('reserva')} ${fmtEnergy(reserve, p)}` : tr('sem leitura')}</b></div>
            <div className="kv"><span>{tr('Consumo')}</span><b>{live ? `${live.burn.toFixed(p.energy === 'battery' ? 0 : 1)} ${p.energy === 'battery' ? 'W' : 'L/h'}${station.burnAvg === null ? ` (${tr('perfil')})` : ''}` : '—'}</b></div>
            {live?.reach != null && <div className="kv"><span>{tr('Alcance (sem vento)')}</span><b>{fmtNavDist(live.reach, u)}</b></div>}
            {alarm === 'crit' && <div className="warnbox crit">{tr('BINGO: volte agora. A energia que resta só cobre a volta direta ao home com a reserva.')}</div>}
            {station.onVehicle.length > 0 && (
              <>
                <div className="sub">{tr('Direto para')}</div>
                <div className="brow">
                  <select value={dto} onChange={(e) => setDto(+e.target.value)} aria-label={tr('Ponto da missão')}>
                    <option value={-1}>—</option>
                    {station.onVehicle.map((wp, i) => <option key={i} value={i}>{wp.name ?? String.fromCharCode(65 + (i % 26))}{t?.lat ? ` · ${fmtNavDist(distance(t, wp), u)}` : ''}</option>)}
                  </select>
                  <button className="btn" disabled={!on || dto < 0 || !station.onVehicleSeq[dto]} title={tr('Pula a missão para este ponto (entra em modo Missão se estiver no ar)')}
                    onClick={() => station.send({ cmd: 'mission_current', seq: station.onVehicleSeq[dto] })}>{tr('Ir direto')}</button>
                </div>
              </>
            )}
            <div className="sub">{tr('Aeródromos próximos')}</div>
            {!station.charts && <div className="hint">{tr('Baixe as cartas para ver aeródromos próximos.')}</div>}
            {near.map(({ a, d }) => {
              const brg = t ? bearing(t, a) : 0
              const gs = windTriangle(brg, p.cruise, w).gs
              const ete = gs > 0 ? d / gs : Infinity
              const need = (ete * (live?.burn ?? p.burn)) / 3600
              const ok = left === null ? null : left - need >= reserve
              const armed = divert === a.id
              return (
                <div key={a.id} className="apt">
                  <span><b>{a.id}</b> <small>{a.name}</small></span>
                  <span className={ok === false ? 'crit' : ok ? 'ok' : ''}>{fmtNavDist(d, u)} · {fmtDeg(brg)} · {fmtEte(ete)}</span>
                  <button className={`btn ${armed ? 'confirming' : ''}`} disabled={!on || !air}
                    title={tr('Vai já para o aeródromo no modo Guiado e fica circulando (ou pairando) sobre ele')}
                    onClick={() => {
                      if (!armed) return setDivert(a.id)
                      setDivert(null)
                      station.send({ cmd: 'goto', lat: a.lat, lon: a.lon })
                    }}>{armed ? tr('Confirmar') : tr('Desviar')}</button>
                </div>
              )
            })}
            <label className="tog"><input type="checkbox" checked={lr.onlyPublic} onChange={(e) => lrSave({ onlyPublic: e.target.checked })} />{tr('Só aeródromos públicos')}</label>
          </div>
        </div>
      )}
    </aside>
  )
}

// ---------- Configurar → Longo alcance ----------

function Num({ label, value, min, max, step = 1, unit, onChange, desc }: { label: string; value: number; min: number; max: number; step?: number; unit: string; desc?: string; onChange: (v: number) => void }) {
  const [d, setD] = useState(String(value))
  useEffect(() => setD(String(value)), [value])
  const commit = () => {
    const v = +d
    if (d === '' || Number.isNaN(v)) return setD(String(value))
    onChange(clamp(v, min, max))
  }
  return (
    <div className="field">
      <label>{label}{desc && <small>{desc}</small>}</label>
      <div className="fin"><input type="number" value={d} min={min} max={max} step={step} onChange={(e) => setD(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />{unit}</div>
    </div>
  )
}

function ChartsSetup() {
  useChannels('charts')
  const info = station.chartsInfo
  const st = station.chartsStatus
  const connected = station.conn === 'open'
  const [msg, setMsg] = useState('')
  const importFile = async (f: File) => {
    try {
      const pack = JSON.parse(await f.text()) as ChartPack
      if (pack.format !== 'aracua-charts') throw new Error(tr('o arquivo não é do formato aracua-charts'))
      station.send({ cmd: 'charts_import', pack })
      setMsg(tr('Enviado à ponte: {n} trechos de aerovia', { n: pack.airways?.length ?? 0 }))
    } catch (e) {
      setMsg(tr('Arquivo inválido: {e}', { e: String((e as Error).message ?? e) }))
    }
  }
  const exportFile = () => {
    if (!station.charts) return
    const blob = new Blob([JSON.stringify(station.charts.pack)], { type: 'application/json' })
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `cartas-${station.charts.pack.effective ?? 'aracua'}.json` })
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
  return (
    <div className="card"><h3>{tr('Cartas aeronáuticas')}</h3>
      <p className="desc">{tr('Aerovias, fixos, auxílios, aeródromos e espaços aéreos do DECEA (as mesmas das cartas ENRC do AISWEB). A ponte baixa uma vez e guarda em cartas.json para usar sem internet. Fora do Brasil, importe um arquivo no formato aracua-charts (veja docs/protocolo.md).')}</p>
      <div className="kv"><span>{tr('Situação')}</span><b className={info?.loaded ? (chartsExpired(info.next) ? 'warn' : 'ok') : ''}>
        {info?.busy ? tr('baixando…') : info?.loaded ? (chartsExpired(info.next) ? tr('emenda vencida') : tr('em dia')) : tr('sem cartas')}</b></div>
      {info?.loaded && (
        <>
          <div className="kv"><span>{tr('Fonte')}</span><b>{info.source}</b></div>
          <div className="kv"><span>{tr('Emenda')}</span><b>{info.effective ?? '—'}{info.next ? ` · ${tr('próxima em {d}', { d: info.next })}` : ''}</b></div>
          <div className="kv"><span>{tr('Baixadas em')}</span><b>{info.fetched ? new Date(info.fetched).toLocaleString() : '—'}</b></div>
          {info.counts && <div className="kv"><span>{tr('Conteúdo')}</span><b>{tr('{a} trechos de aerovia · {f} fixos · {ad} aeródromos · {s} espaços aéreos', { a: info.counts.airways, f: info.counts.fixes, ad: info.counts.airports, s: info.counts.airspaces })}</b></div>}
        </>
      )}
      {st && <div className="hint">{tr('Baixando {step} ({n} de {total})…', { step: st.step, n: st.done + 1, total: st.total })}</div>}
      {info?.error && <div className="warnbox crit">{info.error}</div>}
      {msg && <div className="hint">{msg}</div>}
      <div className="brow" style={{ margin: '10px 0' }}>
        <button className="btn on" disabled={!connected || !!info?.busy} onClick={() => station.send({ cmd: 'charts_fetch' })}><Icon.download />{info?.loaded ? tr('Atualizar do DECEA') : tr('Baixar do DECEA')}</button>
        <label className="btn" aria-disabled={!connected}>{tr('Importar arquivo…')}<input type="file" accept=".json,application/json" hidden disabled={!connected} onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} /></label>
        <button className="btn" disabled={!station.charts} onClick={exportFile}>{tr('Exportar')}</button>
        <button className="btn" disabled={!info?.loaded || !connected} onClick={() => station.send({ cmd: 'charts_clear' })}>{tr('Apagar')}</button>
      </div>
      <p className="desc">{tr('As cartas ajudam a planejar; não substituem as publicações oficiais, NOTAM nem a autorização do DECEA/ANAC para o voo.')}</p>
    </div>
  )
}

export function LongRangeSetup() {
  useChannels('ui', 'params', 'telemetry')
  const lr = station.settings.longRange
  const p = lr.perf
  const bat = p.energy === 'battery'
  const cruiseParam = station.params.get('AIRSPEED_CRUISE')
  const homeAlt = station.telem?.home?.alt ?? 0
  const cruiseMsl = lr.altMsl ? lr.cruiseAlt : lr.cruiseAlt + homeAlt
  const applyPreset = (k: string) => station.applyPreset(k)
  return (
    <>
      <h2>{tr('Longo alcance')}</h2>
      <p className="desc">{tr('Perfil da aeronave para o navlog, o ponto de não retorno e o alarme de bingo; altitudes, vento e as cartas aeronáuticas.')}</p>
      <ChartsSetup />
      <div className="card"><h3>{tr('Desempenho')}</h3>
        <div className="field">
          <label>{tr('Tipo de aeronave')}<small>{tr('preenche o perfil com valores típicos; ajuste depois aos da sua aeronave')}</small></label>
          <div className="fin"><select value="" onChange={(e) => applyPreset(e.target.value)}>
            <option value="">{tr('Escolher um perfil pronto…')}</option>
            {Object.entries(PRESETS).map(([k, pr]) => <option key={k} value={k}>{tr(pr.label)}</option>)}
          </select></div>
        </div>
        <div className="field">
          <label>{tr('Velocidade em')}<small>{tr('Mach para jatos, supersônicos e hipersônicos: a velocidade verdadeira sai da atmosfera padrão na altitude de cada perna')}</small></label>
          <div className="fin"><select value={p.mach > 0 ? 'mach' : 'tas'} onChange={(e) => perfSave(e.target.value === 'mach' ? { mach: Math.max(0.3, +(p.cruise / soundSpeed(cruiseMsl)).toFixed(2)) } : { mach: 0, cruise: p.mach * soundSpeed(cruiseMsl) })}>
            <option value="tas">{tr('Velocidade verdadeira')}</option><option value="mach">Mach</option>
          </select></div>
        </div>
        {p.mach > 0
          ? <Num label={tr('Mach de cruzeiro')} desc={tr('{v} no cruzeiro ({alt})', { v: fmtSpeed(p.mach * soundSpeed(cruiseMsl), lr.units), alt: fmtAlt(cruiseMsl, lr.units) })} value={p.mach} min={0.1} max={25} step={0.01} unit="M" onChange={(v) => perfSave({ mach: v })} />
          : <Num label={tr('Velocidade de cruzeiro')} desc={cruiseParam ? tr('AIRSPEED_CRUISE no veículo: {v} m/s', { v: cruiseParam }) : tr('velocidade verdadeira no ar')} value={+(p.cruise / (lr.units === 'aero' ? KT : 1 / 3.6)).toFixed(0)} min={1} max={20000} unit={lr.units === 'aero' ? 'kt' : 'km/h'}
            onChange={(v) => perfSave({ cruise: v * (lr.units === 'aero' ? KT : 1 / 3.6) })} />}
        <Num label={tr('Razão de subida')} value={p.climb} min={0.5} max={300} step={0.5} unit="m/s" onChange={(v) => perfSave({ climb: v })} />
        <Num label={tr('Razão de descida')} value={p.descent} min={0.5} max={300} step={0.5} unit="m/s" onChange={(v) => perfSave({ descent: v })} />
        <Num label={tr('Inclinação nas curvas')} desc={tr('raio de curva no cruzeiro: {r}', { r: fmtNavDist(((p.mach > 0 ? p.mach * soundSpeed(cruiseMsl) : p.cruise) ** 2) / (9.81 * Math.tan((p.bank * Math.PI) / 180)), lr.units) })} value={p.bank} min={5} max={60} unit="°" onChange={(v) => perfSave({ bank: v })} />
        <Num label={tr('Regime econômico: velocidade')} desc={tr('fração da de cruzeiro (velocidade de maior alcance)')} value={p.eco.speed} min={0.3} max={1} step={0.01} unit="×" onChange={(v) => perfSave({ eco: { ...p.eco, speed: v } })} />
        <Num label={tr('Regime econômico: consumo')} value={p.eco.burn} min={0.1} max={1} step={0.01} unit="×" onChange={(v) => perfSave({ eco: { ...p.eco, burn: v } })} />
        <Num label={tr('Regime rápido: velocidade')} value={p.fast.speed} min={1} max={3} step={0.01} unit="×" onChange={(v) => perfSave({ fast: { ...p.fast, speed: v } })} />
        <Num label={tr('Regime rápido: consumo')} value={p.fast.burn} min={1} max={6} step={0.01} unit="×" onChange={(v) => perfSave({ fast: { ...p.fast, burn: v } })} />
      </div>
      <div className="card"><h3>{tr('Energia')}</h3>
        <div className="field">
          <label>{tr('Fonte')}<small>{tr('A bateria usa a carga (%) da telemetria; o combustível, o nível da EFI ou do script (Configurar → Motor)')}</small></label>
          <div className="fin"><select value={p.energy} onChange={(e) => perfSave({ energy: e.target.value as Perf['energy'] })}>
            <option value="battery">{tr('Bateria')}</option><option value="fuel">{tr('Combustível')}</option>
          </select></div>
        </div>
        <Num label={tr('Capacidade utilizável')} value={p.capacity} min={1} max={100000} unit={bat ? 'Wh' : 'L'} onChange={(v) => perfSave({ capacity: v })} />
        <Num label={tr('Consumo em cruzeiro')} desc={tr('em voo, o medido substitui este')} value={p.burn} min={0.1} max={100000} step={bat ? 10 : 0.1} unit={bat ? 'W' : 'L/h'} onChange={(v) => perfSave({ burn: v })} />
        <Num label={tr('Consumo na subida')} desc={tr('múltiplo do de cruzeiro')} value={p.climbFactor} min={1} max={4} step={0.1} unit="×" onChange={(v) => perfSave({ climbFactor: v })} />
        <Num label={tr('Reserva final')} desc={tr('minutos de cruzeiro que sobram no pouso')} value={p.reserveMin} min={0} max={180} unit="min" onChange={(v) => perfSave({ reserveMin: v })} />
        <p className="desc">{tr('Autonomia: {t} de cruzeiro, {r} de reserva; alcance sem vento {d}.', { t: fmtEte((p.capacity / p.burn) * 3600), r: fmtEte(p.reserveMin * 60), d: fmtNavDist(((p.capacity - reserveEnergy(p)) / p.burn) * 3600 * modePerf(p, 'normal', cruiseMsl).cruise, lr.units) })}</p>
      </div>
      <div className="card"><h3>{tr('Rota e altitudes')}</h3>
        <Num label={tr('Teto do plano')} desc={tr('altura máxima sobre o home aceita nos waypoints (120 m é o limite comum para drones sem autorização especial)')} value={lr.maxAlt} min={10} max={60000} unit="m" onChange={(v) => lrSave({ maxAlt: v, cruiseAlt: Math.min(lr.cruiseAlt, v + (lr.altMsl ? station.telem?.home?.alt ?? 0 : 0)) })} />
        <Num label={tr('Alcance do rádio')} desc={tr('desenha o círculo e marca as pernas fora dele; 0 = não verificar')} value={lr.radioKm} min={0} max={5000} unit="km" onChange={(v) => lrSave({ radioKm: v })} />
        <div className="field">
          <label>{tr('Unidades de navegação')}</label>
          <div className="fin"><select value={lr.units} onChange={(e) => lrSave({ units: e.target.value as LongRangeSettings['units'] })}>
            <option value="aero">{tr('Aeronáuticas (NM, kt, ft)')}</option><option value="metric">{tr('Métricas (km, km/h, m)')}</option>
          </select></div>
        </div>
      </div>
      <div className="card"><h3>{tr('Vento')}</h3>
        <div className="field">
          <label>{tr('Vento nas contas')}<small>{tr('o ArduPilot estima o vento em voo (mensagem WIND)')}</small></label>
          <div className="fin"><select value={lr.windSource} onChange={(e) => lrSave({ windSource: e.target.value as LongRangeSettings['windSource'] })}>
            <option value="measured">{tr('Medido pelo veículo (quando houver)')}</option><option value="manual">{tr('Informado aqui')}</option>
          </select></div>
        </div>
        <Num label={tr('Vento de')} desc={tr('direção de onde sopra, verdadeira')} value={lr.wind.dir} min={0} max={359} unit="°" onChange={(v) => lrSave({ wind: { ...lr.wind, dir: v } })} />
        <Num label={tr('Velocidade do vento')} value={+(lr.wind.speed / (lr.units === 'aero' ? KT : 1 / 3.6)).toFixed(0)} min={0} max={200} unit={lr.units === 'aero' ? 'kt' : 'km/h'}
          onChange={(v) => lrSave({ wind: { ...lr.wind, speed: v * (lr.units === 'aero' ? KT : 1 / 3.6) } })} />
      </div>
    </>
  )
}
