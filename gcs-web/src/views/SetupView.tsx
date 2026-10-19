// Configuração: resumo do veículo, parâmetros do firmware (por tipo de veículo),
// calibração, entrega e a própria estação.

import { useEffect, useState, type ReactNode } from 'react'
import { station, useChannels } from '../lib/store'
import { clamp } from '../lib/format'
import { DeliverySetup } from '../components/Delivery'
import { Calibration } from '../components/Calibration'
import { OfflineMap } from '../components/OfflineMap'
import { MaintenanceView } from '../components/Maintenance'
import { EngineSetup } from '../components/Engine'
import { PadSetup } from '../components/Gamepad'
import { flightCards, rtlAltParam, safetyCards, type PCard, type PField } from '../lib/params'
import { t, tk } from '../lib/i18n'
import { classLabel, vehicleClass } from '../types'

/** Sem resposta do veículo depois disso, o parâmetro não existe neste firmware. */
const MISSING_AFTER_MS = 5000

function ParamField({ id, label, desc, kind }: PField) {
  useChannels('params')
  const raw = station.params.get(id)
  const scale = kind.t === 'number' ? kind.scale ?? 1 : 1
  const shown = raw === undefined ? '' : String(+(raw / scale).toFixed(2))
  const [draft, setDraft] = useState(shown)
  const [pending, setPending] = useState<number | null>(null)
  const [missingAt, setMissingAt] = useState(0)
  useEffect(() => setDraft(shown), [shown])
  useEffect(() => {
    if (pending !== null && raw !== undefined && Math.abs(raw - pending) < 1e-3) setPending(null)
  }, [raw, pending])
  // Sem resposta no prazo: "indisponível" (o pedido mais recente é o que conta).
  const asked = station.paramAsked.get(id)
  useEffect(() => {
    if (raw !== undefined || asked === undefined) return
    const h = setTimeout(() => setMissingAt(asked), Math.max(0, asked + MISSING_AFTER_MS - Date.now()))
    return () => clearTimeout(h)
  }, [raw, asked])
  const missing = raw === undefined && asked !== undefined && missingAt === asked && !!station.telem?.connected
  const commit = (value: number) => {
    if (!Number.isFinite(value)) return
    setPending(value)
    station.send({ cmd: 'param_set', id, value })
  }
  let input: ReactNode
  if (kind.t === 'bool') {
    input = <input type="checkbox" id={id} checked={!!raw} disabled={raw === undefined} onChange={(e) => commit(e.target.checked ? 1 : 0)} />
  } else if (kind.t === 'select') {
    input = (
      <select id={id} value={raw ?? ''} disabled={raw === undefined} onChange={(e) => commit(+e.target.value)}>
        {raw === undefined && <option value="">—</option>}
        {raw !== undefined && !kind.options.some(([v]) => v === raw) && <option value={raw}>{t('outro ({v})', { v: raw })}</option>}
        {kind.options.map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}
      </select>
    )
  } else {
    const send = () => {
      const v = clamp(+draft, kind.min, kind.max)
      if (draft === '' || Number.isNaN(+draft)) return setDraft(shown)
      if (String(v) !== shown) commit(v * scale)
      setDraft(String(v))
    }
    input = (
      <>
        <input type="number" id={id} value={draft} min={kind.min} max={kind.max} step={kind.step ?? 1} disabled={raw === undefined}
          onChange={(e) => setDraft(e.target.value)} onBlur={send} onKeyDown={(e) => e.key === 'Enter' && send()} />
        {kind.unit}
      </>
    )
  }
  return (
    <div className={`field${missing ? ' missing' : ''}`}>
      <label htmlFor={id}>{t(label)}<small>{desc ? t(desc) : ''}{desc ? ' · ' : ''}<code>{id}</code></small></label>
      <div className="fin">
        {input}
        <span className="pstate">{missing ? t('indisponível neste firmware') : raw === undefined ? t('lendo…') : pending !== null ? t('enviando…') : ''}</span>
      </div>
    </div>
  )
}

function Cards({ cards }: { cards: PCard[] }) {
  return cards.map((c) => (
    <div className="card" key={c.title}><h3>{t(c.title)}</h3>
      {c.fields.map((f) => <ParamField key={f.id} {...f} />)}
    </div>
  ))
}

const CONN_LABEL = { open: tk('conectada'), connecting: tk('conectando…'), closed: tk('desconectada') } as Record<string, string>

function Summary() {
  useChannels('telemetry', 'params', 'conn', 'replay')
  const tm = station.telem
  const cls = vehicleClass(tm)
  const ok = (b: boolean | undefined) => <span className={b ? 'ok' : 'crit'}>{b === undefined ? '—' : b ? 'OK' : t('ATENÇÃO')}</span>
  const p = (id: string, scale = 1, unit = '') => (station.params.has(id) ? `${+(station.params.get(id)! / scale).toFixed(1)} ${unit}` : '—')
  const [rtlId, rtlScale] = rtlAltParam(cls)
  return (
    <>
      <h2>{t('Resumo do veículo')}</h2>
      <p className="desc">{tm?.connected ? t('Estado atual lido do piloto automático.') : t('Nenhum veículo conectado. Os dados aparecem quando a ponte receber HEARTBEAT.')}</p>
      <div className="sumgrid">
        <div className="scard"><h4>{t('Veículo')} {ok(tm?.connected)}</h4>
          <div className="kv"><span>{t('Tipo')}</span><b>{tm?.connected ? `${classLabel(cls)} · ${tm.vehicle_type}` : '—'}</b></div>
          <div className="kv"><span>{t('Piloto automático')}</span><b>{tm?.autopilot || '—'}</b></div>
          <div className="kv"><span>SYSID</span><b>{tm?.system_id ?? '—'}</b></div>
          <div className="kv"><span>{t('Estado')}</span><b>{tm?.system_status || '—'}</b></div></div>
        <div className="scard"><h4>{t('Sensores')} {ok(tm?.sensors_healthy)}</h4>
          <div className="kv"><span>GNSS</span><b>{tm ? `${tm.gps.fix} · ${tm.gps.sats} sat` : '—'}</b></div>
          <div className="kv"><span>HDOP</span><b>{tm ? tm.gps.hdop.toFixed(2) : '—'}</b></div>
          <div className="kv"><span>{t('Vibração máx.')}</span><b>{tm ? `${Math.max(...tm.vibration).toFixed(1)} m/s²` : '—'}</b></div>
          <div className="kv"><span>LiDAR</span><b>{station.sectors ? t('recebendo') : t('sem dados')}</b></div></div>
        <div className="scard"><h4>{t('Energia')} {ok(tm ? tm.battery.remaining > 25 : undefined)}</h4>
          <div className="kv"><span>{t('Carga')}</span><b>{tm ? `${tm.battery.remaining} %` : '—'}</b></div>
          <div className="kv"><span>{t('Tensão')}</span><b>{tm ? `${tm.battery.voltage.toFixed(2)} V` : '—'}</b></div>
          <div className="kv"><span>{t('Failsafe em')}</span><b>{p('BATT_LOW_MAH', 1, 'mAh')}</b></div></div>
        <div className="scard"><h4>{t('Segurança')}</h4>
          <div className="kv"><span>{t('Geocerca')}</span><b>{station.params.get('FENCE_ENABLE') ? p('FENCE_RADIUS', 1, 'm') : station.params.has('FENCE_ENABLE') ? t('desligada') : '—'}</b></div>
          <div className="kv"><span>{t('Altitude RTL')}</span><b>{p(rtlId, rtlScale, 'm')}</b></div>
          {(cls === 'plane' || cls === 'vtol')
            ? <div className="kv"><span>{t('Cruzeiro')}</span><b>{p('AIRSPEED_CRUISE', 1, 'm/s')}</b></div>
            : <div className="kv"><span>{t('Anticolisão')}</span><b>{station.params.has('AVOID_ENABLE') ? (station.params.get('AVOID_ENABLE') ? t('até {d}', { d: p('AVOID_DIST_MAX', 1, 'm') }) : t('desligada')) : '—'}</b></div>}
        </div>
        <div className="scard"><h4>{t('Ponte')}</h4>
          <div className="kv"><span>{t('Conexão')}</span><b>{t(CONN_LABEL[station.conn] ?? station.conn)}</b></div>
          <div className="kv"><span>{t('Versão')}</span><b>{station.hello?.version ?? '—'}</b></div>
          <div className="kv"><span>MAVLink</span><b>{station.hello?.mavlink ?? '—'}</b></div>
          <div className="kv"><span>{t('Gravando em')}</span><b title={station.hello?.log_file ?? ''}>{station.hello?.replay ? t('reprodução') : station.hello?.log_file?.split(/[\\/]/).pop() ?? t('não grava')}</b></div></div>
      </div>
      <div className="brow" style={{ marginTop: 14 }}>
        <button className="btn" disabled={!tm?.connected} onClick={() => station.requestParams()}>{t('Reler parâmetros')}</button>
      </div>
    </>
  )
}

type Settings = typeof station.settings

function StationSettings() {
  useChannels('ui')
  const s = station.settings
  const [d, setD] = useState(s)
  const field = (k: 'bridgeUrl' | 'videoUrl' | 'tileUrl' | 'tileAttribution' | 'takeoffAlt', label: string, desc: string, type = 'text') => (
    <div className="field">
      <label htmlFor={`st_${k}`}>{label}<small>{desc}</small></label>
      <div className="fin"><input id={`st_${k}`} type={type} value={d[k]} onChange={(e) => setD({ ...d, [k]: type === 'number' ? +e.target.value : e.target.value })} /></div>
    </div>
  )
  const choice = <K extends 'lang' | 'theme'>(k: K, label: string, opts: [Settings[K], string][]) => (
    <div className="field">
      <label htmlFor={`st_${k}`}>{label}</label>
      <div className="fin">
        <select id={`st_${k}`} value={s[k]} onChange={(e) => station.saveSettings({ [k]: e.target.value })}>
          {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
    </div>
  )
  return (
    <>
      <h2>{t('Estação')}</h2>
      <p className="desc">{t('Configurações deste computador. Ficam salvas no navegador.')}</p>
      <div className="card"><h3>{t('Aparência')}</h3>
        {choice('lang', t('Idioma'), [['pt', 'Português (Brasil)'], ['en', 'English']])}
        {choice('theme', t('Tema'), [['auto', t('Automático (do sistema)')], ['dark', t('Escuro')], ['light', t('Claro')]])}
        <p className="desc">{t('As mensagens da ponte e do piloto automático aparecem como o veículo as manda.')}</p>
      </div>
      <div className="card">
        {!station.link && field('bridgeUrl', t('Endereço da ponte'), t('WebSocket do aracua-bridge; inclua ?token=… se a ponte pedir'))}
        {field('videoUrl', t('Vídeo da câmera'), t('MJPEG, HLS (.m3u8) ou MP4; ex.: saída do MediaMTX. Vazio no app: a câmera do simulador'))}
        {field('tileUrl', t('Mapa de fundo'), t('URL de tiles raster com {z}/{x}/{y}; recarregue a página para aplicar'))}
        {field('tileAttribution', t('Créditos do mapa'), t('mostrados no canto do mapa'))}
        {field('takeoffAlt', t('Altitude de decolagem'), t('metros, usada pelo botão Decolar'), 'number')}
      </div>
      <div className="brow" style={{ marginTop: 14 }}>
        <button className="btn on" onClick={() => station.saveSettings({ ...d, lang: s.lang, theme: s.theme, keepTiles: s.keepTiles, takeoffAlt: clamp(d.takeoffAlt, 2, 120) })}>{t('Salvar')}</button>
        <button className="btn" onClick={() => setD(station.settings)}>{t('Descartar')}</button>
      </div>
      <OfflineMap />
    </>
  )
}

const PAGES = [
  { id: 'resumo', label: tk('Resumo') },
  { id: 'seg', label: tk('Segurança') },
  { id: 'voo', label: tk('Parâmetros de voo') },
  { id: 'cal', label: tk('Calibração') },
  { id: 'motor', label: tk('Motor') },
  { id: 'controle', label: tk('Controle') },
  { id: 'entrega', label: tk('Entrega') },
  { id: 'manut', label: tk('Manutenção') },
  { id: 'estacao', label: tk('Estação') },
] as const

export function SetupView() {
  useChannels('telemetry')
  const [page, setPage] = useState<(typeof PAGES)[number]['id']>('resumo')
  const cls = vehicleClass(station.telem)
  const firmware = cls === 'plane' || cls === 'vtol' ? 'ArduPlane' : cls === 'rover' ? 'ArduRover' : 'ArduCopter'
  return (
    <section className="page" aria-label={t('Configuração')}>
      <nav className="pnav">
        <div className="ph">{t('Configuração')}</div>
        {PAGES.map((p) => <button key={p.id} className={page === p.id ? 'on' : ''} onClick={() => setPage(p.id)}>{t(p.label)}</button>)}
      </nav>
      <div className="pbody">
        {page === 'resumo' && <Summary />}
        {page === 'seg' && (
          <>
            <h2>{t('Segurança')}</h2>
            <p className="desc">{t('Failsafes do {fw} ({cls}). Cada mudança é gravada no veículo na hora, inclusive em voo.', { fw: firmware, cls: classLabel(cls) })}</p>
            <Cards cards={safetyCards(cls)} />
          </>
        )}
        {page === 'voo' && (
          <>
            <h2>{t('Parâmetros de voo')}</h2>
            <p className="desc">{t('Ajustes do {fw} para {cls}.', { fw: firmware, cls: classLabel(cls) })}</p>
            <Cards cards={flightCards(cls)} />
          </>
        )}
        {page === 'cal' && <Calibration />}
        {page === 'motor' && <EngineSetup />}
        {page === 'controle' && <PadSetup />}
        {page === 'entrega' && <DeliverySetup />}
        {page === 'manut' && <MaintenanceView />}
        {page === 'estacao' && <StationSettings />}
      </div>
    </section>
  )
}
