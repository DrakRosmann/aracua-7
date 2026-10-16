// Configuração: resumo do veículo, parâmetros do ArduCopter e da estação.

import { useEffect, useState, type ReactNode } from 'react'
import { station, useChannels, PARAM_IDS } from '../lib/store'
import { clamp } from '../lib/format'
import { DeliverySetup } from '../components/Delivery'

type Kind = { t: 'number'; unit?: string; scale?: number; min: number; max: number; step?: number } | { t: 'bool' } | { t: 'select'; options: [number, string][] }

function ParamField({ id, label, desc, kind }: { id: string; label: string; desc?: string; kind: Kind }) {
  useChannels('params')
  const raw = station.params.get(id)
  const scale = kind.t === 'number' ? kind.scale ?? 1 : 1
  const shown = raw === undefined ? '' : String(+(raw / scale).toFixed(2))
  const [draft, setDraft] = useState(shown)
  const [pending, setPending] = useState<number | null>(null)
  useEffect(() => setDraft(shown), [shown])
  useEffect(() => {
    if (pending !== null && raw !== undefined && Math.abs(raw - pending) < 1e-3) setPending(null)
  }, [raw, pending])
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
        {kind.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
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
    <div className="field">
      <label htmlFor={id}>{label}<small>{desc}{desc ? ' · ' : ''}<code>{id}</code></small></label>
      <div className="fin">
        {input}
        <span className="pstate">{raw === undefined ? 'lendo…' : pending !== null ? 'enviando…' : ''}</span>
      </div>
    </div>
  )
}

function Summary() {
  useChannels('telemetry', 'params', 'conn')
  const t = station.telem
  const ok = (b: boolean | undefined) => <span className={b ? 'ok' : 'crit'}>{b === undefined ? '—' : b ? 'OK' : 'ATENÇÃO'}</span>
  const p = (id: string, scale = 1, unit = '') => (station.params.has(id) ? `${+(station.params.get(id)! / scale).toFixed(1)} ${unit}` : '—')
  return (
    <>
      <h2>Resumo do veículo</h2>
      <p className="desc">{t?.connected ? 'Estado atual lido do piloto automático.' : 'Nenhum veículo conectado. Os dados aparecem quando a ponte receber HEARTBEAT.'}</p>
      <div className="sumgrid">
        <div className="scard"><h4>Veículo {ok(t?.connected)}</h4>
          <div className="kv"><span>Tipo</span><b>{t?.vehicle_type || '—'}</b></div>
          <div className="kv"><span>Piloto automático</span><b>{t?.autopilot || '—'}</b></div>
          <div className="kv"><span>SYSID</span><b>{t?.system_id ?? '—'}</b></div>
          <div className="kv"><span>Estado</span><b>{t?.system_status || '—'}</b></div></div>
        <div className="scard"><h4>Sensores {ok(t?.sensors_healthy)}</h4>
          <div className="kv"><span>GNSS</span><b>{t ? `${t.gps.fix} · ${t.gps.sats} sat` : '—'}</b></div>
          <div className="kv"><span>HDOP</span><b>{t ? t.gps.hdop.toFixed(2) : '—'}</b></div>
          <div className="kv"><span>Vibração máx.</span><b>{t ? `${Math.max(...t.vibration).toFixed(1)} m/s²` : '—'}</b></div>
          <div className="kv"><span>LiDAR</span><b>{station.sectors ? 'recebendo' : 'sem dados'}</b></div></div>
        <div className="scard"><h4>Energia {ok(t ? t.battery.remaining > 25 : undefined)}</h4>
          <div className="kv"><span>Carga</span><b>{t ? `${t.battery.remaining} %` : '—'}</b></div>
          <div className="kv"><span>Tensão</span><b>{t ? `${t.battery.voltage.toFixed(2)} V` : '—'}</b></div>
          <div className="kv"><span>Failsafe em</span><b>{p('BATT_LOW_MAH', 1, 'mAh')}</b></div></div>
        <div className="scard"><h4>Segurança</h4>
          <div className="kv"><span>Geocerca</span><b>{station.params.get('FENCE_ENABLE') ? p('FENCE_RADIUS', 1, 'm') : station.params.has('FENCE_ENABLE') ? 'desligada' : '—'}</b></div>
          <div className="kv"><span>Altitude RTL</span><b>{p('RTL_ALT', 100, 'm')}</b></div>
          <div className="kv"><span>Anticolisão</span><b>{station.params.has('AVOID_ENABLE') ? (station.params.get('AVOID_ENABLE') ? `até ${p('AVOID_DIST_MAX', 1, 'm')}` : 'desligada') : '—'}</b></div></div>
        <div className="scard"><h4>Ponte</h4>
          <div className="kv"><span>Conexão</span><b>{station.conn}</b></div>
          <div className="kv"><span>Versão</span><b>{station.hello?.version ?? '—'}</b></div>
          <div className="kv"><span>MAVLink</span><b>{station.hello?.mavlink ?? '—'}</b></div></div>
      </div>
      <div className="brow" style={{ marginTop: 14 }}>
        <button className="btn" disabled={!t?.connected} onClick={() => PARAM_IDS.forEach((id) => station.send({ cmd: 'param_get', id }, true))}>Reler parâmetros</button>
      </div>
    </>
  )
}

function StationSettings() {
  useChannels('ui')
  const s = station.settings
  const [d, setD] = useState(s)
  const field = (k: keyof typeof s, label: string, desc: string, type = 'text') => (
    <div className="field">
      <label htmlFor={`st_${k}`}>{label}<small>{desc}</small></label>
      <div className="fin"><input id={`st_${k}`} type={type} value={d[k]} onChange={(e) => setD({ ...d, [k]: type === 'number' ? +e.target.value : e.target.value })} /></div>
    </div>
  )
  return (
    <>
      <h2>Estação</h2>
      <p className="desc">Configurações deste computador. Ficam salvas no navegador.</p>
      <div className="card">
        {field('bridgeUrl', 'Endereço da ponte', 'WebSocket do aracua-bridge')}
        {field('videoUrl', 'Vídeo da câmera', 'MJPEG, HLS (.m3u8) ou MP4; ex.: saída do MediaMTX')}
        {field('tileUrl', 'Mapa de fundo', 'URL de tiles raster com {z}/{x}/{y}; recarregue a página para aplicar')}
        {field('takeoffAlt', 'Altitude de decolagem', 'metros, usada pelo botão Decolar', 'number')}
      </div>
      <div className="brow" style={{ marginTop: 14 }}>
        <button className="btn on" onClick={() => station.saveSettings({ ...d, takeoffAlt: clamp(d.takeoffAlt, 2, 120) })}>Salvar</button>
        <button className="btn" onClick={() => setD(station.settings)}>Descartar</button>
      </div>
    </>
  )
}

const PAGES = [
  { id: 'resumo', label: 'Resumo' },
  { id: 'seg', label: 'Segurança' },
  { id: 'voo', label: 'Parâmetros de voo' },
  { id: 'entrega', label: 'Entrega' },
  { id: 'estacao', label: 'Estação' },
] as const

export function SetupView() {
  const [page, setPage] = useState<(typeof PAGES)[number]['id']>('resumo')
  return (
    <section className="page" aria-label="Configuração">
      <nav className="pnav">
        <div className="ph">Configuração</div>
        {PAGES.map((p) => <button key={p.id} className={page === p.id ? 'on' : ''} onClick={() => setPage(p.id)}>{p.label}</button>)}
      </nav>
      <div className="pbody">
        {page === 'resumo' && <Summary />}
        {page === 'seg' && (
          <>
            <h2>Segurança</h2>
            <p className="desc">Failsafes do ArduCopter. Cada mudança é gravada no veículo na hora, inclusive em voo.</p>
            <div className="card"><h3>Geocerca</h3>
              <ParamField id="FENCE_ENABLE" label="Geocerca ativa" kind={{ t: 'bool' }} />
              <ParamField id="FENCE_RADIUS" label="Raio máximo" desc="distância do home" kind={{ t: 'number', unit: 'm', min: 30, max: 10000 }} />
            </div>
            <div className="card"><h3>Retorno e energia</h3>
              <ParamField id="RTL_ALT" label="Altitude de retorno" desc="sobe até ela antes de voltar" kind={{ t: 'number', unit: 'm', scale: 100, min: 2, max: 300 }} />
              <ParamField id="BATT_LOW_MAH" label="Reserva de bateria" desc="failsafe abaixo desta carga" kind={{ t: 'number', unit: 'mAh', min: 0, max: 20000, step: 50 }} />
              <ParamField id="BATT_FS_LOW_ACT" label="Ação com bateria baixa" kind={{ t: 'select', options: [[0, 'Só avisar'], [1, 'Pousar'], [2, 'Retornar (RTL)'], [3, 'SmartRTL ou RTL'], [4, 'SmartRTL ou pousar']] }} />
              <ParamField id="FS_GCS_ENABLE" label="Perda da estação de solo" kind={{ t: 'select', options: [[0, 'Desligado'], [1, 'Retornar (RTL)'], [3, 'SmartRTL ou RTL'], [5, 'Pousar']] }} />
            </div>
            <div className="card"><h3>Anticolisão (LiDAR via OBSTACLE_DISTANCE)</h3>
              <ParamField id="AVOID_ENABLE" label="Anticolisão" kind={{ t: 'select', options: [[0, 'Desligada'], [7, 'Ligada (cerca + proximidade)']] }} />
              <ParamField id="AVOID_DIST_MAX" label="Distância de frenagem" kind={{ t: 'number', unit: 'm', min: 1, max: 30 }} />
            </div>
          </>
        )}
        {page === 'voo' && (
          <>
            <h2>Parâmetros de voo</h2>
            <p className="desc">Velocidades usadas pelo piloto automático e pelos sticks.</p>
            <div className="card">
              <ParamField id="WPNAV_SPEED" label="Velocidade em missão" kind={{ t: 'number', unit: 'm/s', scale: 100, min: 0.5, max: 20, step: 0.5 }} />
              <ParamField id="LOIT_SPEED" label="Velocidade máxima manual" desc="modo Posição" kind={{ t: 'number', unit: 'm/s', scale: 100, min: 0.5, max: 20, step: 0.5 }} />
              <ParamField id="PILOT_SPEED_UP" label="Velocidade de subida" kind={{ t: 'number', unit: 'm/s', scale: 100, min: 0.5, max: 8, step: 0.5 }} />
              <ParamField id="PILOT_TKOFF_ALT" label="Altitude de decolagem pelo rádio" kind={{ t: 'number', unit: 'm', scale: 100, min: 0, max: 100 }} />
            </div>
          </>
        )}
        {page === 'entrega' && <DeliverySetup />}
        {page === 'estacao' && <StationSettings />}
      </div>
    </section>
  )
}
