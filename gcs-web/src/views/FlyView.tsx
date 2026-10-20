// Tela de voo: trilho de ações, painel de instrumentos, câmera e mostradores.

import { useEffect, useState, type ReactNode } from 'react'
import { station, useChannels } from '../lib/store'
import { cardinal, fmtDist, fmtTime } from '../lib/format'
import { distance } from '../lib/geo'
import { Icon } from '../components/Icons'
import { AttitudeTape, Compass, ObstacleRadar, Speedometer } from '../components/Instruments'
import { Sticks } from '../components/Sticks'
import { CameraFeed } from '../components/Camera'
import { PadStatus } from '../components/Gamepad'
import { AutopilotPanel } from '../components/Autopilot'
import { CountdownOverlay, DeliveryPanel, ReleaseFlash } from '../components/Delivery'
import { EnginePanel } from '../components/Engine'
import { ForcePrompt, ReplayBar } from '../components/Replay'
import { ChartsButton, NavPanel } from '../components/LongRange'
import { FuelDial } from '../components/Fuel'
import { vehicleClass } from '../types'
import { t as tr } from '../lib/i18n'

function Section({ title, icon, open, children }: { title: string; icon: ReactNode; open?: boolean; children: ReactNode }) {
  return (
    <details open={open}>
      <summary>{icon}{title}<span className="ch"><Icon.chevron /></span></summary>
      {children}
    </details>
  )
}

function FlyRail() {
  useChannels('ui', 'telemetry')
  const [act, setAct] = useState(false)
  const t = station.telem
  const on = !!t?.connected && !station.replay
  const air = !!t?.armed && (t?.alt_rel ?? 0) > 0.5
  const alt = station.settings.takeoffAlt
  const cls = vehicleClass(t)
  const wing = cls === 'plane' || cls === 'vtol'
  // Cada tipo de veículo "para" e pousa de um jeito.
  const pause = cls === 'rover' ? { mode: 'HOLD', title: tr('Para o veículo (Hold)') }
    : wing ? { mode: 'LOITER', title: tr('Circula sobre o ponto atual (Loiter)') }
      : { mode: 'LOITER', title: tr('Segura a posição (Loiter)') }
  const takeoffTitle = cls === 'rover' ? tr('Veículo terrestre: não decola')
    : wing ? (cls === 'vtol' ? tr('Decolagem automática (modo TAKEOFF) até {alt} m, na vertical', { alt }) : tr('Decolagem automática (modo TAKEOFF) até {alt} m, em linha reta', { alt }))
      : tr('Decola até {alt} m no modo Guiado', { alt })
  const actions: [string, () => void][] = [
    [tr('Iniciar missão'), () => station.send({ cmd: 'mission_start' })],
    ...(cls === 'copter' || cls === 'heli' ? [[tr('Pousar aqui'), () => station.send({ cmd: 'mode', mode: 'LAND' })] as [string, () => void]] : []),
    ...(cls === 'vtol' ? [[tr('Pousar na vertical aqui'), () => station.send({ cmd: 'mode', mode: 'QLAND' })] as [string, () => void]] : []),
    [tr('Tirar foto'), () => { station.send({ cmd: 'photo' }); station.stats.photos++ }],
    ...(cls === 'copter' || cls === 'heli' ? [[tr('Freio (parar já)'), () => station.send({ cmd: 'mode', mode: 'BRAKE' })] as [string, () => void]] : []),
  ]
  return (
    <nav className="rail" aria-label={tr('Ações de voo')}>
      <div className="rg">
        <button className="rb" disabled={!on || air || cls === 'rover'} title={takeoffTitle} onClick={() => station.send({ cmd: 'takeoff', alt })}><Icon.takeoff />{tr('Decolar')}</button>
        <button className="rb" disabled={!on || !t?.armed} onClick={() => station.send({ cmd: 'mode', mode: 'RTL' })}><Icon.land />{tr('Retornar')}</button>
        <button className="rb" disabled={!on || (!air && cls !== 'rover')} title={pause.title} onClick={() => station.send({ cmd: 'mode', mode: pause.mode })}><Icon.pause />{wing ? tr('Circular') : tr('Pausar')}</button>
        <button className={`rb ${act ? 'on' : ''}`} disabled={!on} onClick={() => setAct(!act)}><Icon.play />{tr('Ação')}</button>
      </div>
      <div className="rg">
        <button className={`rb ${station.follow ? 'on' : ''}`} onClick={() => { station.follow = !station.follow; station.emit('ui') }}><Icon.target />{tr('Seguir')}</button>
        <button className={`rb ${station.lidarLayer ? 'on' : ''}`} onClick={() => { station.lidarLayer = !station.lidarLayer; station.emit('ui') }}><Icon.layers />{tr('LiDAR')}</button>
        <button className={`rb ${station.map3d ? 'on' : ''}`} title={tr('Mapa inclinado com os obstáculos do LiDAR em 3D; gire com o botão direito ou com dois dedos')} onClick={() => { station.map3d = !station.map3d; station.emit('ui') }}><Icon.cube />{tr('3D')}</button>
        <button className={`rb ${station.deliveryOpen ? 'on' : ''}`} onClick={() => { station.deliveryOpen = !station.deliveryOpen; station.emit('ui') }}><Icon.drop />{tr('Entrega')}</button>
        <button className={`rb ${station.engineOpen ? 'on' : ''}`} title={tr('Painel do motor: rotação, temperaturas, combustível, bateria e gerador')} onClick={() => { station.engineOpen = !station.engineOpen; station.emit('ui') }}><Icon.engine />{tr('Motor')}</button>
        <button className={`rb ${station.apOpen ? 'on' : ''} ${station.telem?.ap?.engaged ? 'apon' : ''}`} title={tr('Piloto automático: rumo, altitude, velocidade vertical e velocidade, como num avião')} onClick={() => { station.apOpen = !station.apOpen; station.emit('ui') }}><Icon.yoke />{tr('A/P')}</button>
        <button className={`rb ${station.navOpen ? 'on' : ''} ${station.bingo ? 'bingo' : ''}`} title={tr('Navegação de longo alcance: próximo fixo, destino, energia para voltar, direto para e aeródromos próximos')} onClick={() => { station.navOpen = !station.navOpen; station.emit('ui') }}><Icon.route />{tr('Nav')}</button>
        <ChartsButton top={300} />
        <button className="rb" onClick={() => station.mapApi?.zoomBy(1)}><Icon.plus />{tr('Zoom')}</button>
        <button className="rb" onClick={() => station.mapApi?.zoomBy(-1)}><Icon.minus />{tr('Zoom')}</button>
      </div>
      {act && (
        <div className="menu" style={{ left: 66, top: 180 }}>
          {actions.map(([l, f]) => <button key={l} onClick={() => { f(); setAct(false) }}>{l}</button>)}
        </div>
      )}
    </nav>
  )
}

function Val({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return <div className="val"><span>{label}</span><b>{value}{unit && <small>{unit}</small>}</b></div>
}

function FlyPanel() {
  useChannels('telemetry', 'params', 'map', 'ui')
  const tilt = station.gimbalPitch
  const setTilt = (v: number) => { station.gimbalPitch = v; station.emit('ui') }
  const [collapsed, setCollapsed] = useState(innerWidth < 760 || (innerWidth < 1180 && matchMedia('(pointer: coarse)').matches))
  const t = station.telem
  const home = t?.home
  const dHome = t && home ? distance(home, t) : NaN
  const wi = station.activeWaypoint()
  const wp = wi >= 0 ? station.onVehicle[wi] : null
  const avoidOn = (station.params.get('AVOID_ENABLE') ?? 0) > 0
  const n = station.nearest
  const cls = vehicleClass(t)
  // Multirrotor freia diante do obstáculo; asa fixa não para: só avisa.
  const close = (cls === 'plane' || cls === 'vtol') && !t?.mode.startsWith('Q') ? tr('OBSTÁCULO PERTO') : tr('FREANDO')
  const v = (x: number | undefined, d = 1) => (x === undefined || Number.isNaN(x) ? '—' : x.toFixed(d))

  return (
    <aside className={`rp ${collapsed ? 'collapsed' : ''}`} aria-label={tr('Instrumentos')}>
      <button className="rp-h" onClick={() => setCollapsed(!collapsed)}><Icon.chevronUp />{tr('Instrumentos')}</button>
      <div className="rp-b">
        <Section title={tr('Valores')} icon={<Icon.values />} open>
          <div className="vals">
            <Val label={tr('Altitude')} value={v(t?.alt_rel)} unit="m" />
            <Val label={tr('Vel. solo')} value={v(t?.groundspeed)} unit="m/s" />
            <Val label={tr('Rumo')} value={t ? `${Math.round(t.heading)}°` : '—'} unit={t ? cardinal(t.heading) : ''} />
            <Val label={tr('Tempo de voo')} value={fmtTime(station.stats.flightS)} />
            <Val label={tr('Vel. vertical')} value={t ? `${t.climb >= 0 ? '+' : ''}${t.climb.toFixed(1)}` : '—'} unit="m/s" />
            <Val label={tr('Dist. home')} value={Number.isFinite(dHome) ? fmtDist(dHome) : '—'} />
            <Val label={tr('Alt. MSL')} value={v(t?.alt_msl)} unit="m" />
            <Val label={tr('Próximo WP')} value={wp && t ? String.fromCharCode(65 + wi) : '—'} unit={wp && t ? fmtDist(distance(wp, t)) : ''} />
          </div>
        </Section>
        <div className="avrow">
          <Icon.lidar />{tr('Anticolisão')}
          <b className={!avoidOn ? '' : n < 6 ? 'warn' : 'ok'}>{!station.params.has('AVOID_ENABLE') ? '—' : !avoidOn ? tr('INATIVA') : n < 6 ? close : tr('ATIVA')}</b>
        </div>
        <Section title={tr('Câmera')} icon={<Icon.camera />}>
          <div className="db">
            <div className="brow">
              <button className="btn" onClick={() => { station.send({ cmd: 'photo' }); station.stats.photos++ }}>{tr('Tirar foto')}</button>
              <button className="btn" onClick={() => { station.videoBig = !station.videoBig; station.emit('ui') }}>{tr('Ampliar vídeo')}</button>
            </div>
            <label className="rng" htmlFor="gimbal">Gimbal
              <input id="gimbal" type="range" min={-90} max={20} value={tilt} onChange={(e) => setTilt(+e.target.value)} onPointerUp={() => station.send({ cmd: 'gimbal', pitch: tilt })} onKeyUp={() => station.send({ cmd: 'gimbal', pitch: tilt })} />
              <b>{tilt}°</b>
            </label>
            <div className="hint">{tr('Endereço do vídeo em Configurar → Estação.')}</div>
          </div>
        </Section>
        <Section title={tr('Pilotagem')} icon={<Icon.sticks />}>
          <div className="db"><PadStatus /><Sticks /></div>
        </Section>
        <Section title={tr('LiDAR')} icon={<Icon.lidar />}>
          <div className="db tight">
            <div className="kv"><span>{tr('Voxels no mapa')}</span><b>{station.vox.e.length.toLocaleString('pt-BR')}</b></div>
            <div className="kv"><span>{tr('Área mapeada')}</span><b>{((station.groundCells * station.voxelM * station.voxelM * 4) / 10000).toFixed(2)} ha</b></div>
            <div className="kv"><span>{tr('Obstáculo mais próximo')}</span><b className={n < 6 ? 'crit' : n < 12 ? 'warn' : ''}>{Number.isFinite(n) ? `${n.toFixed(1)} m` : station.sectors ? tr('livre') : tr('sem dados')}</b></div>
            <div className="brow"><button className="btn" onClick={() => station.send({ cmd: 'map_reset' })}>{tr('Zerar mapa')}</button></div>
          </div>
        </Section>
        <Section title={tr('Sensores')} icon={<Icon.pulse />}>
          <div className="db tight">
            <div className="sub">{tr('Atitude')}</div>
            <div className="kv"><span>{tr('Rolagem / arfagem')}</span><b>{t ? `${t.roll.toFixed(1)}° / ${t.pitch.toFixed(1)}°` : '—'}</b></div>
            <div className="kv"><span>{tr('Vibração X/Y/Z')}</span><b className={t && Math.max(...t.vibration) > 30 ? 'crit' : ''}>{t ? t.vibration.map((x) => x.toFixed(1)).join(' / ') : '—'}</b></div>
            <div className="kv"><span>{tr('Clipping')}</span><b>{t ? t.clipping.join(' / ') : '—'}</b></div>
            <div className="sub">GNSS</div>
            <div className="kv"><span>{tr('Fix / satélites')}</span><b>{t ? `${t.gps.fix} · ${t.gps.sats}` : '—'}</b></div>
            <div className="kv"><span>HDOP</span><b>{t ? t.gps.hdop.toFixed(2) : '—'}</b></div>
            <div className="kv"><span>{tr('Lat / lon')}</span><b>{t ? `${t.lat.toFixed(6)}, ${t.lon.toFixed(6)}` : '—'}</b></div>
            <div className="sub">{tr('Energia')}</div>
            <div className="kv"><span>{tr('Tensão / corrente')}</span><b>{t ? tr('{voltage} V / {current} A', { voltage: t.battery.voltage.toFixed(1), current: t.battery.current.toFixed(1) }) : '—'}</b></div>
            <div className="kv"><span>{tr('Consumido')}</span><b>{t ? `${t.battery.consumed_mah} mAh` : '—'}</b></div>
            <div className="sub">{tr('Outros')}</div>
            <div className="kv"><span>{tr('Telêmetro')}</span><b>{t?.rangefinder != null ? `${t.rangefinder.toFixed(2)} m` : '—'}</b></div>
            <div className="kv"><span>{tr('Sensores saudáveis')}</span><b className={t && !t.sensors_healthy ? 'crit' : 'ok'}>{t ? (t.sensors_healthy ? tr('sim') : tr('não')) : '—'}</b></div>
          </div>
        </Section>
        <Section title={tr('Comunicação')} icon={<Icon.antenna />}>
          <div className="db tight">
            <div className="kv"><span>{tr('Ponte')}</span><b className={station.conn === 'open' ? 'ok' : 'crit'}>{station.conn === 'open' ? 'conectada' : station.conn === 'connecting' ? 'conectando…' : 'desconectada'}</b></div>
            <div className="kv"><span>{tr('Mensagens MAVLink')}</span><b>{t ? `${t.msgs_per_sec.toFixed(0)}/s` : '—'}</b></div>
            <div className="kv"><span>{tr('Último HEARTBEAT')}</span><b>{t && t.heartbeat_age_ms < 1e9 ? `${(t.heartbeat_age_ms / 1000).toFixed(1)} s` : '—'}</b></div>
            <div className="kv"><span>{tr('RSSI local / remoto')}</span><b>{t?.radio ? `${t.radio.rssi} / ${t.radio.remrssi}` : '—'}</b></div>
            <div className="kv"><span>{tr('Ruído / erros')}</span><b>{t?.radio ? `${t.radio.noise} / ${t.radio.rxerrors}` : '—'}</b></div>
            <div className="kv"><span>{tr('Perda (veículo)')}</span><b>{t ? `${t.drop_rate_comm.toFixed(1)} %` : '—'}</b></div>
          </div>
        </Section>
      </div>
    </aside>
  )
}

function CameraPip() {
  useChannels('ui')
  const big = station.videoBig
  return (
    <button className={`pip ${big ? 'big' : ''}`} onClick={() => { station.videoBig = !big; station.emit('ui') }} title={big ? tr('Reduzir') : tr('Ampliar vídeo')}>
      <CameraFeed />
    </button>
  )
}

function FlightTime() {
  useChannels('telemetry')
  return <div className="ftime"><span>{tr('Tempo de voo')}</span><b>{fmtTime(station.stats.flightS)}</b></div>
}

export function Toast() {
  useChannels('log')
  const last = station.log.at(-1)
  const [expired, setExpired] = useState(0)
  const errAt = last?.level === 'error' ? last.t : 0
  useEffect(() => {
    if (!errAt) return
    const id = setTimeout(() => setExpired(errAt), 4000)
    return () => clearTimeout(id)
  }, [errAt])
  if (!last || !errAt || expired === errAt) return null
  return <div className="toast" role="alert">{last.text}</div>
}

export function FlyView() {
  return (
    <>
      <FlyRail />
      <FlyPanel />
      <CameraPip />
      <ObstacleRadar />
      <Compass />
      <Speedometer />
      <FuelDial />
      <AttitudeTape />
      <FlightTime />
      <DeliveryPanel />
      <EnginePanel />
      <AutopilotPanel />
      <NavPanel />
      <ReleaseFlash />
      <CountdownOverlay />
      <Toast />
      <ReplayBar />
      <ForcePrompt />
    </>
  )
}

