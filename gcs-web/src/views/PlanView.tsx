// Planejamento: waypoints no mapa, varredura LiDAR, envio ao veículo.

import { useEffect, useState } from 'react'
import { station, useChannels } from '../lib/store'
import { clamp, fmtDist, fmtDuration, wpName } from '../lib/format'
import { distance, survey, type LatLon } from '../lib/geo'
import { Icon } from '../components/Icons'
import { DropPicker } from '../components/Delivery'
import { vehicleClass, type MissionItem } from '../types'
import { t as tr } from '../lib/i18n'

function stats(plan: MissionItem[], home: LatLon | null) {
  if (!plan.length) return { d: 0, t: 0, pct: 0 }
  const start = home ?? plan[0]
  let d = 0, climb = plan[0].alt
  let prev: LatLon = start
  let prevAlt = plan[0].alt
  for (const w of plan) {
    d += distance(prev, w)
    climb += Math.abs(w.alt - prevAlt)
    prev = w
    prevAlt = w.alt
  }
  d += distance(prev, start)
  climb += prevAlt
  const speed = (station.params.get('WPNAV_SPEED') ?? 500) / 100
  const t = d / speed + climb / 2.5 + plan.length * 2
  // Consumo médio de um quadricóptero de 1,6 kg em cruzeiro (~20 A) sobre 5000 mAh.
  const pct = ((20 * t) / 3.6 / 5000) * 100
  return { d, t, pct }
}

function PlanRail() {
  useChannels('ui')
  return (
    <nav className="rail" aria-label={tr('Ferramentas de planejamento')}>
      <div className="rg">
        <button className={`rb ${station.addMode ? 'on' : ''}`} onClick={() => { station.addMode = !station.addMode; station.emit('ui') }}><Icon.pinAdd />{tr('Waypoint')}</button>
        <button className={`rb ${station.surveyPreview ? 'on' : ''}`} onClick={() => document.getElementById('survey')?.toggleAttribute('open')}><Icon.grid />{tr('Varredura')}</button>
        <button className="rb" onClick={() => station.telem?.lat && station.mapApi?.flyTo(station.telem)}><Icon.target />{tr('Veículo')}</button>
        <button className="rb" onClick={() => {
          const pts: LatLon[] = [...station.plan]
          if (station.telem?.home) pts.push(station.telem.home)
          station.mapApi?.fit(pts)
        }}><Icon.fit />{tr('Ajustar')}</button>
      </div>
      <div className="rg">
        <button className="rb" onClick={() => station.mapApi?.zoomBy(1)}><Icon.plus />{tr('Zoom')}</button>
        <button className="rb" onClick={() => station.mapApi?.zoomBy(-1)}><Icon.minus />{tr('Zoom')}</button>
      </div>
    </nav>
  )
}

function SurveyForm() {
  const [p, setP] = useState({ width: 160, height: 120, spacing: 30, alt: 45, northSouth: false, replace: true })
  const [open, setOpen] = useState(false)
  useEffect(() => {
    station.surveyPreview = open ? { width: p.width, height: p.height, spacing: p.spacing, northSouth: p.northSouth } : null
    station.emit('mission', 'ui')
  }, [open, p.width, p.height, p.spacing, p.northSouth])
  useEffect(() => () => { station.surveyPreview = null }, [])
  const across = p.northSouth ? p.width : p.height
  const lines = Math.floor(across / p.spacing) + 1
  const len = lines * (p.northSouth ? p.height : p.width) + (lines - 1) * p.spacing
  const num = (k: 'width' | 'height' | 'spacing' | 'alt', min: number, max: number) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setP({ ...p, [k]: clamp(+e.target.value || min, min, max) })
  const generate = () => {
    const c = station.mapApi?.center()
    if (!c) return
    const pts = survey(c, p.width, p.height, p.spacing, p.northSouth).map((q) => ({ ...q, alt: p.alt }))
    station.setPlan(p.replace ? pts : [...station.plan, ...pts], -1)
    station.addLog('cmd', tr('Varredura gerada: {n} waypoints', { n: pts.length }))
  }
  return (
    <details id="survey" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary><Icon.grid />{tr('Varredura LiDAR')}<span className="ch"><Icon.chevron /></span></summary>
      <div className="db">
        <div className="hint">{tr('Zigue-zague centrado no meio do mapa. Arraste o mapa para posicionar a área tracejada.')}</div>
        <div className="grid2">
          <label>{tr('Largura (m)')}<input type="number" value={p.width} onChange={num('width', 20, 2000)} /></label>
          <label>{tr('Altura (m)')}<input type="number" value={p.height} onChange={num('height', 20, 2000)} /></label>
          <label>{tr('Espaçamento (m)')}<input type="number" value={p.spacing} onChange={num('spacing', 5, 300)} /></label>
          <label>{tr('Altitude (m)')}<input type="number" value={p.alt} onChange={num('alt', 5, 120)} /></label>
          <label>{tr('Linhas')}<select value={p.northSouth ? 'ns' : 'ew'} onChange={(e) => setP({ ...p, northSouth: e.target.value === 'ns' })}><option value="ew">{tr('Leste–oeste')}</option><option value="ns">{tr('Norte–sul')}</option></select></label>
          <label className="row"><input type="checkbox" checked={p.replace} onChange={(e) => setP({ ...p, replace: e.target.checked })} />{tr('Substituir plano')}</label>
        </div>
        <div className="hint">{tr('{lines} linhas · {len} de percurso.', { lines, len: fmtDist(len) })} {p.spacing <= 40 ? tr('Com LiDAR de 90 m, esse espaçamento dá sobreposição.') : tr('Acima de 40 m podem sobrar faixas sem cobertura.')}</div>
        <div className="brow"><button className="btn on" onClick={generate}>{tr('Gerar varredura')}</button></div>
      </div>
    </details>
  )
}

function PlanPanel() {
  useChannels('mission', 'telemetry', 'params', 'ui', 'payload', 'replay')
  const [json, setJson] = useState<string | null>(null)
  const plan = station.plan
  const home = station.telem?.home ?? null
  const { d, t, pct } = stats(plan, home)
  const remaining = station.telem?.battery.remaining ?? -1
  const reserve = 20
  const tooLong = remaining >= 0 && plan.length > 0 && pct > remaining - reserve
  const set = (items: MissionItem[], sel = station.selected) => station.setPlan(items, sel)
  const move = (i: number, j: number) => {
    if (j < 0 || j >= plan.length) return
    const next = [...plan]
    ;[next[i], next[j]] = [next[j], next[i]]
    set(next, j)
  }
  const up = station.upload
  const connected = !!station.telem?.connected && !station.replay
  const cls = vehicleClass(station.telem)
  const wing = cls === 'plane' || cls === 'vtol'
  const vm = station.vehicleMission
  const same = !!vm && vm.items.length === plan.length && vm.items.every((w, i) => distance(w, plan[i]) < 0.5 && Math.abs(w.alt - plan[i].alt) < 0.5)
  const approach = station.settings.approachDeg
  return (
    <aside className="rp plan" aria-label={tr('Plano de missão')}>
      <div className="rp-h static">{tr('Plano de missão')}</div>
      <div className="rp-b">
        <div className="vals">
          <div className="val"><span>{tr('Waypoints')}</span><b>{plan.length}</b></div>
          <div className="val"><span>{tr('Distância total')}</span><b>{plan.length ? fmtDist(d) : '—'}</b></div>
          <div className="val"><span>{tr('Tempo estimado')}</span><b>{plan.length ? fmtDuration(t) : '—'}</b></div>
          <div className="val"><span>{tr('Bateria estimada')}</span><b>{plan.length ? `${pct.toFixed(0)}` : '—'}{plan.length ? <small>%</small> : null}</b></div>
        </div>
        <div className="db top-line">
          <label className="num">{tr('Altitude dos novos WPs')}
            <input type="number" min={5} max={120} value={station.settings.wpAlt} onChange={(e) => station.saveSettings({ wpAlt: clamp(+e.target.value || 40, 5, 120) })} /> m
          </label>
          <div className="hint">{tr('Com *Waypoint* ligado, clique no mapa para adicionar. Arraste um ponto para movê-lo.').split('*').map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part))}</div>
          {tooLong && <div className="warnbox">{tr('A rota pede cerca de {pct}% da bateria e restam {left}%. Reserve pelo menos {reserve}% para o retorno.', { pct: pct.toFixed(0), left: remaining, reserve })}</div>}
        </div>
        <div className="wplist">
          {plan.map((w, i) => (
            <div key={i} className={`wprow ${i === station.selected ? 'sel' : ''}`} onClick={() => { station.select(i); station.mapApi?.flyTo(w) }}>
              <span className="wpb">{wpName(i)}</span>
              <small>{fmtDist(distance(i ? plan[i - 1] : home ?? w, w))} {i ? tr('do anterior') : tr('do home')}{w.drop?.length ? <span className="dropb"> · ↓ {w.drop.map((id) => station.payloadName(id)).join(', ')}</span> : null}</small>
              <input type="number" min={5} max={120} value={Math.round(w.alt)} aria-label={tr('Altitude do waypoint {v0}', { v0: wpName(i) })} onClick={(e) => e.stopPropagation()}
                onChange={(e) => set(plan.map((x, j) => (j === i ? { ...x, alt: clamp(+e.target.value || x.alt, 5, 120) } : x)))} />
              <span onClick={(e) => e.stopPropagation()}>
                <button className="ib" aria-label={tr('Subir')} onClick={() => move(i, i - 1)}>↑</button>
                <button className="ib" aria-label={tr('Descer')} onClick={() => move(i, i + 1)}>↓</button>
                <button className="ib" aria-label={tr('Remover')} onClick={() => set(plan.filter((_, j) => j !== i), -1)}>✕</button>
              </span>
              {i === station.selected && <DropPicker index={i} />}
            </div>
          ))}
          {!plan.length && <div className="empty">{tr('Nenhum waypoint. Clique no mapa ou gere uma varredura.')}</div>}
        </div>
        <SurveyForm />
        {wing && (
          <div className="db top-line">
            <div className="sub">{tr('Fim da missão (asa fixa)')}</div>
            <label className="tog"><input type="checkbox" checked={station.settings.landAtEnd} onChange={(e) => station.saveSettings({ landAtEnd: e.target.checked })} />
              {cls === 'vtol' ? tr('Pousar na vertical no home') : tr('Pousar no home (aproximação e toque)')}</label>
            {station.settings.landAtEnd && cls === 'plane' && (
              <label className="num">{tr('Rumo do pouso')}
                <input type="number" min={0} max={359} placeholder={tr('auto')} value={approach ?? ''}
                  onChange={(e) => station.saveSettings({ approachDeg: e.target.value === '' ? null : ((Math.round(+e.target.value) % 360) + 360) % 360 })} /> °
              </label>
            )}
            <div className="hint">{station.settings.landAtEnd
              ? cls === 'vtol' ? tr('Volta ao home, para de pairar e desce na vertical.') : tr('Desce em rampa até o home contra o rumo escolhido (vazio = vindo do último waypoint). Escolha um rumo com o vento de frente e sem obstáculos.')
              : tr('Sem pouso: no fim, volta e circula sobre o home (RTL).')}</div>
            {plan.some((w) => w.drop?.length) && <div className="hint">{tr('Entrega em voo: a ponte calcula o ponto de soltura antes do alvo pela velocidade de cruzeiro ({v} m/s) e pela altura.', { v: station.params.get('AIRSPEED_CRUISE') ?? '?' })}</div>}
          </div>
        )}
        <div className="db top-line">
          <div className="brow">
            <button className="btn on" disabled={!plan.length || !connected || up.state === 'sending'} onClick={() => station.uploadPlan()}><Icon.upload />{tr('Enviar ao veículo')}</button>
            <button className="btn" disabled={up.state !== 'ok' || !connected} onClick={() => { station.send({ cmd: 'mission_start' }); station.setView('fly') }}>{tr('Iniciar missão')}</button>
          </div>
          {up.text && <div className={`hint ${up.state === 'error' ? 'crit' : up.state === 'ok' ? 'ok' : ''}`}>{up.text}</div>}
          <div className="brow">
            <button className="btn" disabled={!station.telem?.connected} title={tr('Lê de novo a missão gravada no veículo')} onClick={() => station.send({ cmd: 'mission_download' })}><Icon.download />{tr('Ler do veículo')}</button>
            <button className="btn" disabled={!vm?.items.length || same} onClick={() => station.planFromVehicle()}>{tr('Editar a missão do veículo')}</button>
          </div>
          {vm && <div className="hint">{vm.items.length ? (same ? tr('O veículo tem esta mesma missão.') : tr('O veículo tem outra missão ({n} waypoints), em tracejado no mapa.', { n: vm.items.length })) : tr('Nenhuma missão gravada no veículo.')}</div>}
          {!connected && plan.length > 0 && <div className="hint">{tr('Conecte um veículo para enviar a missão.')}</div>}
          <div className="brow">
            <button className="btn" disabled={plan.length < 2} onClick={() => set([...plan].reverse(), -1)}>{tr('Inverter ordem')}</button>
            <button className="btn" disabled={!plan.length} onClick={() => set([], -1)}>{tr('Limpar')}</button>
            <button className="btn" disabled={!plan.length} onClick={async () => {
              const txt = JSON.stringify({ formato: 'aracua-plan', versao: 1, itens: plan.map((w, i) => ({ nome: wpName(i), ...w })) }, null, 2)
              try {
                await navigator.clipboard.writeText(txt)
                setJson(null)
                station.addLog('ok', tr('Plano copiado em JSON'))
              } catch {
                setJson(txt)
              }
            }}>{tr('Copiar JSON')}</button>
          </div>
          {json && <textarea className="json" readOnly value={json} onFocus={(e) => e.target.select()} autoFocus aria-label={tr('Plano em JSON')} />}
        </div>
      </div>
    </aside>
  )
}

export function PlanView() {
  return (
    <>
      <PlanRail />
      <PlanPanel />
    </>
  )
}
