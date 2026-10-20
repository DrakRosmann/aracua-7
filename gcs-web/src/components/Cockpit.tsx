// Aba Painel: pilotagem por instrumentos. Glareshield com o piloto automático em cima,
// espaços de instrumentos que o operador troca (como num painel de avião) e luzes de
// alerta embaixo. Tela cheia com F ou pelo botão.

import { FuelGauge } from './Fuel'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { station, useChannels } from '../lib/store'
import { annunciators, DEFAULT_COCKPIT, INSTRUMENT_LABEL, LAYOUTS, setSlot, slotsOf, type InstrumentId, type LayoutId } from '../lib/cockpit'
import { fmtDist, fmtTime } from '../lib/format'
import { distance } from '../lib/geo'
import { num, t as tr } from '../lib/i18n'
import { ApFma, McpFace } from './Autopilot'
import { Icon } from './Icons'
import { CameraFeed } from './Camera'
import { EngineFace } from './Engine'
import { AirspeedGauge, AltimeterGauge, AttitudeGauge, HeadingGauge, HudOverlay, NavDisplay, PFD, TurnGauge, VsiGauge } from './Gauges'
import { RadarScope } from './Instruments'

function Camera({ hud }: { hud: boolean }) {
  useChannels('ui')
  const tilt = station.gimbalPitch
  const gimbal = (p: number) => {
    station.gimbalPitch = Math.max(-90, Math.min(20, p))
    station.send({ cmd: 'gimbal', pitch: station.gimbalPitch })
    station.emit('ui')
  }
  return (
    <div className="ck-cam">
      <CameraFeed />
      {hud && <HudOverlay />}
      <div className="ck-camctl">
        <button onClick={() => gimbal(tilt + 10)} title={tr('Gimbal para cima')}>▲</button>
        <span>{tilt}°</span>
        <button onClick={() => gimbal(tilt - 10)} title={tr('Gimbal para baixo')}>▼</button>
        <button onClick={() => { station.send({ cmd: 'photo' }); station.stats.photos++ }} title={tr('Tirar foto')}>●</button>
      </div>
    </div>
  )
}

function FlightData() {
  useChannels('telemetry', 'mission')
  const t = station.telem
  const wi = station.activeWaypoint()
  const wp = wi >= 0 ? station.onVehicle[wi] : null
  const v = (x: number | undefined, d = 1) => (x === undefined || !t ? '—' : num(x, d))
  const rows: [string, string, string?][] = [
    [tr('Altitude'), v(t?.alt_rel), 'm'], [tr('Alt. MSL'), v(t?.alt_msl), 'm'],
    [tr('Vel. solo'), v(t?.groundspeed), 'm/s'], [tr('Vel. ar'), v(t?.airspeed), 'm/s'],
    [tr('Vel. vertical'), t ? `${t.climb >= 0 ? '+' : ''}${num(t.climb, 1)}` : '—', 'm/s'], [tr('Rumo'), t ? `${Math.round(t.heading)}°` : '—'],
    [tr('Dist. home'), t?.home ? fmtDist(distance(t, t.home)) : '—'], [tr('Próximo WP'), wp && t ? `${String.fromCharCode(65 + wi)} · ${fmtDist(distance(t, wp))}` : '—'],
    [tr('Bateria'), t ? `${t.battery.remaining} % · ${num(t.battery.voltage, 1)} V` : '—'], [tr('Corrente'), v(t?.battery.current), 'A'],
    ['GNSS', t ? `${t.gps.fix} · ${t.gps.sats}` : '—'], [tr('Tempo de voo'), fmtTime(station.stats.flightS)],
  ]
  return (
    <div className="ck-data">
      {rows.map(([k, val, u]) => <div key={k}><span>{k}</span><b>{val}{u && val !== '—' ? <small>{u}</small> : null}</b></div>)}
    </div>
  )
}

function Instrument({ id }: { id: InstrumentId }) {
  switch (id) {
    case 'pfd': return <PFD />
    case 'nd': return <NavDisplay />
    case 'camera': return <Camera hud={false} />
    case 'hud': return <Camera hud />
    case 'ems': return <div className="ck-ems"><EngineFace /></div>
    case 'fuel': return <FuelGauge />
    case 'asi': return <AirspeedGauge />
    case 'adi': return <AttitudeGauge />
    case 'alt': return <AltimeterGauge />
    case 'vsi': return <VsiGauge />
    case 'turn': return <TurnGauge />
    case 'dg': return <HeadingGauge />
    case 'radar': return <RadarScope />
    case 'data': return <FlightData />
    case 'none': return null
  }
}

function UtcClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return <span>UTC <b>{now.toISOString().slice(11, 19)}</b></span>
}

function Cas() {
  useChannels('telemetry', 'map', 'params')
  const fence = station.params.has('FENCE_ENABLE') ? !!station.params.get('FENCE_ENABLE') : null
  const list = annunciators(station.telem, {
    engine: station.settings.engine, nearest: station.nearest, fenceOn: fence,
    apOff: !!station.telem?.ap?.message && station.apAlarmOn(),
  })
  const t = station.telem
  return (
    <div className="ck-cas" role="status" aria-label={tr('Alertas')}>
      <div className="ck-lights">
        {list.map((a) => <span key={a.id} className={`ck-light ${a.light}`} title={tr(a.title)}>{a.text}</span>)}
      </div>
      <div className="ck-clock">
        <span>{tr('VOO')} <b>{fmtTime(station.stats.flightS)}</b></span>
        <UtcClock />
        {t?.connected && <span>{tr('MODO')} <b>{t.mode}</b></span>}
      </div>
    </div>
  )
}

function Slot({ i, id, edit }: { i: number; id: InstrumentId; edit: boolean }) {
  const s = station.settings.cockpit
  return (
    <div className={`ck-slot ${edit ? 'edit' : ''}`} style={{ gridArea: 'abcdef'[i] }}>
      <div className="ck-inst"><Instrument id={id} /></div>
      {edit && (
        <label className="ck-pick">
          <span>{tr('Espaço {n}', { n: i + 1 })}</span>
          <select value={id} onChange={(e) => station.saveSettings({ cockpit: setSlot(s, i, e.target.value as InstrumentId) })}>
            {(Object.keys(INSTRUMENT_LABEL) as InstrumentId[]).map((k) => <option key={k} value={k}>{tr(INSTRUMENT_LABEL[k])}</option>)}
          </select>
        </label>
      )}
    </div>
  )
}

function ToolBtn({ on, title, onClick, children }: { on?: boolean; title: string; onClick: () => void; children: ReactNode }) {
  return <button className={`ck-tb ${on ? 'on' : ''}`} title={title} aria-pressed={on} onClick={onClick}>{children}</button>
}

export function CockpitView() {
  useChannels('ui')
  const root = useRef<HTMLElement>(null)
  const [edit, setEdit] = useState(false)
  const [full, setFull] = useState(false)
  const s = station.settings.cockpit
  const layout = LAYOUTS[s.layout]
  const slots = slotsOf(s)
  const toggleFull = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    else root.current?.requestFullscreen?.().catch(() => {})
  }
  useEffect(() => {
    const on = () => setFull(!!document.fullscreenElement)
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return
      if (e.key === 'f' || e.key === 'F') toggleFull()
    }
    document.addEventListener('fullscreenchange', on)
    addEventListener('keydown', key)
    return () => { document.removeEventListener('fullscreenchange', on); removeEventListener('keydown', key) }
  }, [])
  const save = (patch: Partial<typeof s>) => station.saveSettings({ cockpit: { ...s, ...patch } })
  return (
    <section ref={root} className={`cockpit ${full ? 'full' : ''}`} aria-label={tr('Painel de instrumentos')}>
      <div className="ck-glare">
        {s.mcp && <div className="ck-mcp"><McpFace /></div>}
        <div className="ck-right">
          {s.mcp && <ApFma />}
          <div className="ck-tools">
            <select aria-label={tr('Layout do painel')} value={s.layout} onChange={(e) => save({ layout: e.target.value as LayoutId })}>
              {(Object.keys(LAYOUTS) as LayoutId[]).map((k) => <option key={k} value={k}>{tr(LAYOUTS[k].label)}</option>)}
            </select>
            <ToolBtn on={edit} title={tr('Trocar os instrumentos de cada espaço')} onClick={() => setEdit(!edit)}>{edit ? tr('Pronto') : tr('Trocar instrumentos')}</ToolBtn>
            <ToolBtn on={s.mcp} title={tr('Piloto automático em cima')} onClick={() => save({ mcp: !s.mcp })}>A/P</ToolBtn>
            <ToolBtn on={s.cas} title={tr('Luzes de alerta embaixo')} onClick={() => save({ cas: !s.cas })}>CAS</ToolBtn>
            {edit && <ToolBtn title={tr('Volta os instrumentos padrão de todos os layouts')} onClick={() => save({ slots: DEFAULT_COCKPIT.slots })}>{tr('Padrão')}</ToolBtn>}
            <ToolBtn on={full} title={tr('Tela cheia (F)')} onClick={toggleFull}><Icon.fit /></ToolBtn>
          </div>
        </div>
      </div>
      <div className="ck-grid" style={{ gridTemplateAreas: layout.areas.map((r) => `"${r}"`).join(' '), gridTemplateColumns: layout.cols, gridTemplateRows: layout.rows }}>
        {slots.map((id, i) => <Slot key={`${s.layout}-${i}`} i={i} id={id} edit={edit} />)}
      </div>
      {s.cas && <Cas />}
    </section>
  )
}
