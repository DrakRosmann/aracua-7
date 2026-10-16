// Tela de voo: trilho de ações, painel de instrumentos, câmera e mostradores.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { station, useChannels } from '../lib/store'
import { cardinal, fmtDist, fmtTime } from '../lib/format'
import { distance } from '../lib/geo'
import { Icon } from '../components/Icons'
import { AttitudeTape, Compass, ObstacleRadar, Speedometer } from '../components/Instruments'
import { Sticks } from '../components/Sticks'
import { CountdownOverlay, DeliveryPanel, ReleaseFlash } from '../components/Delivery'

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
  const on = !!t?.connected
  const air = !!t?.armed && (t?.alt_rel ?? 0) > 0.5
  const alt = station.settings.takeoffAlt
  const actions: [string, () => void][] = [
    ['Iniciar missão', () => station.send({ cmd: 'mission_start' })],
    ['Pousar aqui', () => station.send({ cmd: 'mode', mode: 'LAND' })],
    ['Tirar foto', () => { station.send({ cmd: 'photo' }); station.stats.photos++ }],
    ['Freio (parar já)', () => station.send({ cmd: 'mode', mode: 'BRAKE' })],
  ]
  return (
    <nav className="rail" aria-label="Ações de voo">
      <div className="rg">
        <button className="rb" disabled={!on || air} title={`Decola até ${alt} m no modo Guiado`} onClick={() => station.send({ cmd: 'takeoff', alt })}><Icon.takeoff />Decolar</button>
        <button className="rb" disabled={!on || !t?.armed} onClick={() => station.send({ cmd: 'mode', mode: 'RTL' })}><Icon.land />Retornar</button>
        <button className="rb" disabled={!on || !air} title="Segura a posição (Loiter)" onClick={() => station.send({ cmd: 'mode', mode: 'LOITER' })}><Icon.pause />Pausar</button>
        <button className={`rb ${act ? 'on' : ''}`} disabled={!on} onClick={() => setAct(!act)}><Icon.play />Ação</button>
      </div>
      <div className="rg">
        <button className={`rb ${station.follow ? 'on' : ''}`} onClick={() => { station.follow = !station.follow; station.emit('ui') }}><Icon.target />Seguir</button>
        <button className={`rb ${station.lidarLayer ? 'on' : ''}`} onClick={() => { station.lidarLayer = !station.lidarLayer; station.emit('ui') }}><Icon.layers />LiDAR</button>
        <button className={`rb ${station.deliveryOpen ? 'on' : ''}`} onClick={() => { station.deliveryOpen = !station.deliveryOpen; station.emit('ui') }}><Icon.drop />Entrega</button>
        <button className="rb" onClick={() => station.mapApi?.zoomBy(1)}><Icon.plus />Zoom</button>
        <button className="rb" onClick={() => station.mapApi?.zoomBy(-1)}><Icon.minus />Zoom</button>
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
  useChannels('telemetry', 'params', 'map')
  const [collapsed, setCollapsed] = useState(innerWidth < 760)
  const [tilt, setTilt] = useState(-30)
  const t = station.telem
  const home = t?.home
  const dHome = t && home ? distance(home, t) : NaN
  const wi = station.activeWaypoint()
  const wp = wi >= 0 ? station.onVehicle[wi] : null
  const avoidOn = (station.params.get('AVOID_ENABLE') ?? 0) > 0
  const n = station.nearest
  const v = (x: number | undefined, d = 1) => (x === undefined || Number.isNaN(x) ? '—' : x.toFixed(d))

  return (
    <aside className={`rp ${collapsed ? 'collapsed' : ''}`} aria-label="Instrumentos">
      <button className="rp-h" onClick={() => setCollapsed(!collapsed)}><Icon.chevronUp />Instrumentos</button>
      <div className="rp-b">
        <Section title="Valores" icon={<Icon.values />} open>
          <div className="vals">
            <Val label="Altitude" value={v(t?.alt_rel)} unit="m" />
            <Val label="Vel. solo" value={v(t?.groundspeed)} unit="m/s" />
            <Val label="Rumo" value={t ? `${Math.round(t.heading)}°` : '—'} unit={t ? cardinal(t.heading) : ''} />
            <Val label="Tempo de voo" value={fmtTime(station.stats.flightS)} />
            <Val label="Vel. vertical" value={t ? `${t.climb >= 0 ? '+' : ''}${t.climb.toFixed(1)}` : '—'} unit="m/s" />
            <Val label="Dist. home" value={Number.isFinite(dHome) ? fmtDist(dHome) : '—'} />
            <Val label="Alt. MSL" value={v(t?.alt_msl)} unit="m" />
            <Val label="Próximo WP" value={wp && t ? String.fromCharCode(65 + wi) : '—'} unit={wp && t ? fmtDist(distance(wp, t)) : ''} />
          </div>
        </Section>
        <div className="avrow">
          <Icon.lidar />Anticolisão
          <b className={!avoidOn ? '' : n < 6 ? 'warn' : 'ok'}>{!station.params.has('AVOID_ENABLE') ? '—' : !avoidOn ? 'INATIVA' : n < 6 ? 'FREANDO' : 'ATIVA'}</b>
        </div>
        <Section title="Câmera" icon={<Icon.camera />}>
          <div className="db">
            <div className="brow">
              <button className="btn" onClick={() => { station.send({ cmd: 'photo' }); station.stats.photos++ }}>Tirar foto</button>
              <button className="btn" onClick={() => { station.videoBig = !station.videoBig; station.emit('ui') }}>Ampliar vídeo</button>
            </div>
            <label className="rng" htmlFor="gimbal">Gimbal
              <input id="gimbal" type="range" min={-90} max={20} value={tilt} onChange={(e) => setTilt(+e.target.value)} onPointerUp={() => station.send({ cmd: 'gimbal', pitch: tilt })} onKeyUp={() => station.send({ cmd: 'gimbal', pitch: tilt })} />
              <b>{tilt}°</b>
            </label>
            <div className="hint">Endereço do vídeo em Configurar → Estação.</div>
          </div>
        </Section>
        <Section title="Pilotagem" icon={<Icon.sticks />}>
          <div className="db"><Sticks /></div>
        </Section>
        <Section title="LiDAR" icon={<Icon.lidar />}>
          <div className="db tight">
            <div className="kv"><span>Voxels no mapa</span><b>{station.vox.e.length.toLocaleString('pt-BR')}</b></div>
            <div className="kv"><span>Área mapeada</span><b>{((station.groundCells * station.voxelM * station.voxelM * 4) / 10000).toFixed(2)} ha</b></div>
            <div className="kv"><span>Obstáculo mais próximo</span><b className={n < 6 ? 'crit' : n < 12 ? 'warn' : ''}>{Number.isFinite(n) ? `${n.toFixed(1)} m` : station.sectors ? 'livre' : 'sem dados'}</b></div>
            <div className="brow"><button className="btn" onClick={() => station.send({ cmd: 'map_reset' })}>Zerar mapa</button></div>
          </div>
        </Section>
        <Section title="Sensores" icon={<Icon.pulse />}>
          <div className="db tight">
            <div className="sub">Atitude</div>
            <div className="kv"><span>Rolagem / arfagem</span><b>{t ? `${t.roll.toFixed(1)}° / ${t.pitch.toFixed(1)}°` : '—'}</b></div>
            <div className="kv"><span>Vibração X/Y/Z</span><b className={t && Math.max(...t.vibration) > 30 ? 'crit' : ''}>{t ? t.vibration.map((x) => x.toFixed(1)).join(' / ') : '—'}</b></div>
            <div className="kv"><span>Clipping</span><b>{t ? t.clipping.join(' / ') : '—'}</b></div>
            <div className="sub">GNSS</div>
            <div className="kv"><span>Fix / satélites</span><b>{t ? `${t.gps.fix} · ${t.gps.sats}` : '—'}</b></div>
            <div className="kv"><span>HDOP</span><b>{t ? t.gps.hdop.toFixed(2) : '—'}</b></div>
            <div className="kv"><span>Lat / lon</span><b>{t ? `${t.lat.toFixed(6)}, ${t.lon.toFixed(6)}` : '—'}</b></div>
            <div className="sub">Energia</div>
            <div className="kv"><span>Tensão / corrente</span><b>{t ? `${t.battery.voltage.toFixed(1)} V / ${t.battery.current.toFixed(1)} A` : '—'}</b></div>
            <div className="kv"><span>Consumido</span><b>{t ? `${t.battery.consumed_mah} mAh` : '—'}</b></div>
            <div className="sub">Outros</div>
            <div className="kv"><span>Telêmetro</span><b>{t?.rangefinder != null ? `${t.rangefinder.toFixed(2)} m` : '—'}</b></div>
            <div className="kv"><span>Sensores saudáveis</span><b className={t && !t.sensors_healthy ? 'crit' : 'ok'}>{t ? (t.sensors_healthy ? 'sim' : 'não') : '—'}</b></div>
          </div>
        </Section>
        <Section title="Comunicação" icon={<Icon.antenna />}>
          <div className="db tight">
            <div className="kv"><span>Ponte</span><b className={station.conn === 'open' ? 'ok' : 'crit'}>{station.conn === 'open' ? 'conectada' : station.conn === 'connecting' ? 'conectando…' : 'desconectada'}</b></div>
            <div className="kv"><span>Mensagens MAVLink</span><b>{t ? `${t.msgs_per_sec.toFixed(0)}/s` : '—'}</b></div>
            <div className="kv"><span>Último HEARTBEAT</span><b>{t && t.heartbeat_age_ms < 1e9 ? `${(t.heartbeat_age_ms / 1000).toFixed(1)} s` : '—'}</b></div>
            <div className="kv"><span>RSSI local / remoto</span><b>{t?.radio ? `${t.radio.rssi} / ${t.radio.remrssi}` : '—'}</b></div>
            <div className="kv"><span>Ruído / erros</span><b>{t?.radio ? `${t.radio.noise} / ${t.radio.rxerrors}` : '—'}</b></div>
            <div className="kv"><span>Perda (veículo)</span><b>{t ? `${t.drop_rate_comm.toFixed(1)} %` : '—'}</b></div>
          </div>
        </Section>
      </div>
    </aside>
  )
}

function CameraPip() {
  useChannels('ui')
  const url = station.settings.videoUrl
  const big = station.videoBig
  const img = useRef<HTMLImageElement>(null)
  // Erro vale só para a URL que falhou; trocar o endereço tenta de novo.
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const err = failedUrl === url
  const setErr = () => setFailedUrl(url)
  const isVideo = /\.(m3u8|mp4|webm)(\?|$)/i.test(url)
  return (
    <button className={`pip ${big ? 'big' : ''}`} onClick={() => { station.videoBig = !big; station.emit('ui') }} title={big ? 'Reduzir' : 'Ampliar vídeo'}>
      {url && !err ? (
        isVideo ? <video src={url} autoPlay muted playsInline onError={setErr} /> : <img ref={img} src={url} alt="Vídeo da câmera" onError={setErr} />
      ) : (
        <span className="novideo">{url ? 'Sem sinal de vídeo' : 'Sem vídeo configurado'}</span>
      )}
    </button>
  )
}

function FlightTime() {
  useChannels('telemetry')
  return <div className="ftime"><span>Tempo de voo</span><b>{fmtTime(station.stats.flightS)}</b></div>
}

function Toast() {
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
      <AttitudeTape />
      <FlightTime />
      <DeliveryPanel />
      <ReleaseFlash />
      <CountdownOverlay />
      <Toast />
    </>
  )
}

