import { useEffect, useRef, useState } from 'react'
import { station, useChannels, type View } from '../lib/store'
import { clock } from '../lib/format'
import { FLIGHT_MODES, MODE_LABEL } from '../types'
import { BatteryIcon, Icon } from './Icons'
import { DeliveryChip } from './Delivery'
import { describeLink, isDesktop } from '../lib/desktop'

type Menu = null | 'veh' | 'mode' | 'arm' | 'msgs'

function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close()
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close()
    document.addEventListener('mousedown', h)
    document.addEventListener('keydown', k)
    return () => {
      document.removeEventListener('mousedown', h)
      document.removeEventListener('keydown', k)
    }
  }, [open, close])
  return ref
}

const TABS: { v: View; label: string; icon: () => React.JSX.Element }[] = [
  { v: 'setup', label: 'Configurar', icon: Icon.gear },
  { v: 'plan', label: 'Planejar', icon: Icon.pin },
  { v: 'fly', label: 'Voo', icon: Icon.plane },
  { v: 'analyze', label: 'Analisar', icon: Icon.analyze },
]

export function TopBar() {
  useChannels('telemetry', 'conn', 'ui', 'log')
  const [menu, setMenu] = useState<Menu>(null)
  const close = () => setMenu(null)
  const ref = useOutside(menu !== null, close)
  const t = station.telem
  const connected = station.conn === 'open' && !!t?.connected
  const bars = !connected ? 0 : t!.radio ? Math.round((t!.radio.rssi / 254) * 5) : t!.msgs_per_sec > 40 ? 5 : t!.msgs_per_sec > 20 ? 4 : t!.msgs_per_sec > 8 ? 3 : 1
  const toggle = (m: Menu) => setMenu(menu === m ? null : m)

  return (
    <header className="top" ref={ref}>
      <div className="grp">
        <button className="tb veh" onClick={() => toggle('veh')} aria-haspopup="true" aria-expanded={menu === 'veh'}>
          <span className={`dot ${connected ? 'on' : ''}`} />
          <span>Aracuã-7</span>
          <Icon.chevron />
        </button>
        {TABS.map(({ v, label, icon: I }) => (
          <button key={v} className={`tb ${station.view === v ? 'act' : ''}`} title={label} onClick={() => station.setView(v)}>
            <I />
            <span className="lbl">{label}</span>
          </button>
        ))}
      </div>
      <div className="sp" />
      <div className="grp">
        <DeliveryChip />
        <button className="pill" onClick={() => toggle('mode')} disabled={!connected}>
          {t?.connected ? MODE_LABEL[t.mode] ?? t.mode : station.conn === 'open' ? 'Sem veículo' : 'Desconectado'}
          <Icon.chevron size={12} />
        </button>
        <button className={`pill ${t?.armed ? 'armed' : ''}`} onClick={() => toggle('arm')} disabled={!connected}>
          {t?.armed ? 'Armado' : 'Desarmado'}
        </button>
        <button className="tb" title="Mensagens" onClick={() => { toggle('msgs'); station.markRead() }} style={{ position: 'relative' }}>
          <Icon.megaphone />
          {station.unread > 0 && menu !== 'msgs' && <span className="badge">{Math.min(99, station.unread)}</span>}
        </button>
        <div className="stat gps" title="GNSS">
          <Icon.satellite />
          <small><span>{t?.gps.sats ?? '—'}</span><span>{t ? t.gps.hdop.toFixed(1) : '—'}</span></small>
        </div>
        <div className="stat link" title="Link de rádio">
          <Icon.radio />
          <span className="bars">{[4, 6, 9, 11, 14].map((hh, i) => <i key={i} className={i < bars ? 'on' : ''} style={{ height: hh }} />)}</span>
        </div>
        <div className="stat" title="Bateria" style={{ paddingRight: 14 }}>
          <BatteryIcon pct={t?.battery.remaining ?? 0} />
          <span style={{ fontSize: 14 }}>{t && t.battery.remaining >= 0 ? `${t.battery.remaining}%` : '—'}</span>
        </div>
      </div>

      {menu === 'veh' && <VehicleMenu close={close} />}
      {menu === 'mode' && (
        <div className="menu" style={{ top: 40, right: 250 }}>
          {FLIGHT_MODES.map((m) => (
            <button key={m} className={t?.mode === m ? 'on' : ''} onClick={() => { station.send({ cmd: 'mode', mode: m }); close() }}>
              {MODE_LABEL[m]} <small>{m}</small>
            </button>
          ))}
        </div>
      )}
      {menu === 'arm' && t && (
        <div className="menu confirm" style={{ top: 40, right: 150 }}>
          {!t.armed ? (
            <>
              <p>Armar os motores? As hélices vão girar.</p>
              <div className="brow"><button className="btn danger" onClick={() => { station.send({ cmd: 'arm', arm: true }); close() }}>Armar</button><button className="btn" onClick={close}>Cancelar</button></div>
            </>
          ) : t.alt_rel > 0.5 ? (
            <>
              <p>O veículo está em voo ({t.alt_rel.toFixed(0)} m). Desarmar agora faz ele cair.</p>
              <div className="brow"><button className="btn" onClick={() => { station.send({ cmd: 'mode', mode: 'LAND' }); close() }}>Pousar</button><button className="btn danger" onClick={() => { station.send({ cmd: 'arm', arm: false, force: true }); close() }}>Forçar desarme</button></div>
            </>
          ) : (
            <>
              <p>Desarmar os motores?</p>
              <div className="brow"><button className="btn danger" onClick={() => { station.send({ cmd: 'arm', arm: false }); close() }}>Desarmar</button><button className="btn" onClick={close}>Cancelar</button></div>
            </>
          )}
        </div>
      )}
      {menu === 'msgs' && <Messages />}
    </header>
  )
}

function VehicleMenu({ close }: { close: () => void }) {
  const t = station.telem
  const [url, setUrl] = useState(station.settings.bridgeUrl)
  return (
    <div className="menu vehcard" style={{ top: 48, left: 8 }}>
      <h4><span className={`dot ${t?.connected ? 'on' : ''}`} />Aracuã-7 · {t?.connected ? 'conectado' : station.conn === 'open' ? 'ponte ok, sem veículo' : 'desconectado'}</h4>
      <div className="kv"><span>Ponte</span><b>{station.hello ? `${station.hello.bridge} ${station.hello.version}` : '—'}</b></div>
      <div className="kv"><span>MAVLink</span><b>{station.hello?.mavlink ?? '—'}</b></div>
      <div className="kv"><span>Sistema</span><b>{t?.connected ? `SYSID ${t.system_id} · ${t.vehicle_type}` : '—'}</b></div>
      <div className="kv"><span>Piloto automático</span><b>{t?.autopilot || '—'}</b></div>
      <div className="kv"><span>Estado</span><b>{t?.connected ? t.system_status : '—'}</b></div>
      {isDesktop ? (
        <>
          <div className="kv"><span>Conexão</span><b>{describeLink(station.link?.running ? station.link.config : null)}</b></div>
          <div className="brow" style={{ marginTop: 8 }}>
            <button className="btn on" onClick={() => { station.openLinkDialog(); close() }}>Trocar conexão</button>
            {station.link?.running && <button className="btn" onClick={() => { station.stopLink(); close() }}>Desconectar</button>}
            <button className="btn" onClick={() => { station.setView('setup'); close() }}>Configurar veículo</button>
          </div>
        </>
      ) : (
        <>
          <label className="field-inline" htmlFor="bridgeUrl">Endereço da ponte
            <input id="bridgeUrl" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && station.saveSettings({ bridgeUrl: url })} />
          </label>
          <div className="brow">
            <button className="btn on" onClick={() => { station.saveSettings({ bridgeUrl: url }); if (url === station.settings.bridgeUrl) station.connect(); close() }}>Reconectar</button>
            <button className="btn" onClick={() => { station.setView('setup'); close() }}>Configurar veículo</button>
          </div>
        </>
      )}
    </div>
  )
}

function Messages() {
  useChannels('log')
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight
  })
  return (
    <div className="menu msgs" style={{ top: 48, right: 130 }}>
      <div className="log" ref={box}>
        {station.log.slice(-200).map((e, i) => (
          <div key={i}><span className="t">{clock(e.t)}</span><span className={e.level}>{e.text}</span></div>
        ))}
        {!station.log.length && <div className="t">Nenhuma mensagem ainda.</div>}
      </div>
    </div>
  )
}
