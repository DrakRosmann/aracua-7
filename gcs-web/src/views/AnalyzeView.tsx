// Análise: gráficos dos últimos 5 minutos, inspetor MAVLink, log e resumo.

import { useEffect, useRef, useState } from 'react'
import { station, useChannels } from '../lib/store'
import { clock, fmtDist, fmtTime } from '../lib/format'
import type { LogLevel, Sample } from '../types'
import { DeliveryLog } from '../components/Delivery'

const WINDOW = 300
type Metric = { k: keyof Omit<Sample, 't'>; name: string; unit: string; lo: number; hi?: number; min?: number; digits: number }
const METRICS: Metric[] = [
  { k: 'alt', name: 'Altitude relativa', unit: 'm', lo: 0, min: 20, digits: 1 },
  { k: 'gs', name: 'Velocidade de solo', unit: 'm/s', lo: 0, min: 10, digits: 1 },
  { k: 'bat', name: 'Bateria', unit: '%', lo: 0, hi: 100, digits: 0 },
  { k: 'vib', name: 'Vibração (maior eixo)', unit: 'm/s²', lo: 0, min: 20, digits: 1 },
  { k: 'link', name: 'Mensagens MAVLink', unit: '/s', lo: 0, min: 40, digits: 0 },
  { k: 'obs', name: 'Obstáculo mais próximo', unit: 'm', lo: 0, hi: 100, digits: 1 },
]

function niceMax(v: number) {
  const raw = v / 4, p = 10 ** Math.floor(Math.log10(raw))
  return 4 * ([1, 2, 5, 10].map((s) => s * p).find((s) => s >= raw) ?? 10 * p)
}
function sampleAt(t: number) {
  let best: Sample | null = null, bd = 1e9
  for (const s of station.history) {
    const d = Math.abs(s.t - t)
    if (d < bd) { bd = d; best = s }
  }
  return bd < 1.5 ? best : null
}
const ago = (s: number) => (s < 1 ? 'agora' : s < 60 ? `há ${Math.round(s)} s` : `há ${Math.floor(s / 60)} min ${Math.round(s % 60)} s`)

function Chart({ m, hover, setHover }: { m: Metric; hover: number | null; setHover: (t: number | null) => void }) {
  useChannels('telemetry')
  const cv = useRef<HTMLCanvasElement>(null)
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null)
  const hist = station.history
  const now = hist.at(-1)?.t ?? 0
  const hs = hover !== null ? sampleAt(hover) : null
  useEffect(() => {
    const c = cv.current!
    const r = c.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1)
    c.width = Math.round(r.width * d)
    c.height = Math.round(r.height * d)
    const ctx = c.getContext('2d')!
    ctx.setTransform(d, 0, 0, d, 0, 0)
    const w = r.width, h = r.height, x0 = 40, x1 = w - 10, y0 = 8, y1 = h - 20
    const vals = hist.map((s) => s[m.k])
    const hi = m.hi ?? niceMax(Math.max(m.min ?? 1, ...vals) * 1.05), lo = m.lo
    const X = (t: number) => x1 - ((now - t) / WINDOW) * (x1 - x0)
    const Y = (v: number) => y1 - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (y1 - y0)
    ctx.font = '10.5px Roboto, system-ui, sans-serif'
    ctx.fillStyle = '#8a919c'; ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
    for (let i = 0; i <= 4; i++) {
      const v = lo + ((hi - lo) * i) / 4, y = Y(v)
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke()
      ctx.fillText(Number.isInteger(v) ? String(v) : v.toFixed(1), x0 - 6, y)
    }
    ctx.textBaseline = 'top'
    for (let s = 0; s <= WINDOW; s += 60) {
      ctx.textAlign = s ? 'center' : 'right'
      ctx.fillText(s ? `−${s / 60} min` : 'agora', x1 - (s / WINDOW) * (x1 - x0), y1 + 5)
    }
    const pts = hist.filter((s) => now - s.t <= WINDOW)
    if (pts.length > 1) {
      ctx.beginPath()
      pts.forEach((s, i) => (i ? ctx.lineTo(X(s.t), Y(s[m.k])) : ctx.moveTo(X(s.t), Y(s[m.k]))))
      ctx.strokeStyle = '#3a78f2'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke()
      ctx.lineTo(X(pts.at(-1)!.t), y1); ctx.lineTo(X(pts[0].t), y1); ctx.closePath()
      ctx.fillStyle = 'rgba(58,120,242,0.13)'; ctx.fill()
      const e = pts.at(-1)!
      ctx.beginPath(); ctx.arc(X(e.t), Y(e[m.k]), 4, 0, 7); ctx.fillStyle = '#3a78f2'; ctx.fill()
      ctx.strokeStyle = '#1d2026'; ctx.lineWidth = 2; ctx.stroke()
    }
    if (hs) {
      const x = X(hs.t)
      ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke()
      ctx.beginPath(); ctx.arc(x, Y(hs[m.k]), 5, 0, 7); ctx.fillStyle = '#3a78f2'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke()
    }
  })
  const show = hs ?? hist.at(-1)
  const fmt = (v: number) => (m.k === 'obs' && v >= 100 ? '> 100' : v.toFixed(m.digits))
  return (
    <div className="chart">
      <header><span>{m.name}</span><b>{show ? fmt(show[m.k]) : '—'}<small>{m.unit}{hs ? ` · ${ago(now - hs.t)}` : ''}</small></b></header>
      <canvas ref={cv} aria-label={`Gráfico de ${m.name}`}
        onPointerMove={(e) => {
          const r = cv.current!.getBoundingClientRect(), x0 = 40, x1 = r.width - 10
          const x = Math.max(x0, Math.min(x1, e.clientX - r.left))
          setHover(now - ((x1 - x) / (x1 - x0)) * WINDOW)
          setTip({ x: e.clientX, y: e.clientY })
        }}
        onPointerLeave={() => { setHover(null); setTip(null) }} />
      {tip && hs && <div className="chtip" style={{ left: Math.min(tip.x + 14, innerWidth - 170), top: tip.y - 34 }}><b>{fmt(hs[m.k])} {m.unit}</b> · {ago(now - hs.t)}</div>}
    </div>
  )
}

function Charts() {
  const [hover, setHover] = useState<number | null>(null)
  const [csv, setCsv] = useState<string | null>(null)
  const copy = async () => {
    const h = station.history, t0 = h[0]?.t ?? 0
    const txt = ['tempo_s,altitude_m,vel_solo_ms,bateria_pct,vibracao_ms2,mavlink_msgs_s,obstaculo_m',
      ...h.map((s) => [(s.t - t0).toFixed(1), s.alt.toFixed(2), s.gs.toFixed(2), s.bat, s.vib.toFixed(2), s.link.toFixed(0), s.obs.toFixed(1)].join(','))].join('\n')
    try {
      await navigator.clipboard.writeText(txt)
      station.addLog('ok', `CSV copiado (${h.length} amostras)`)
      setCsv(null)
    } catch {
      setCsv(txt)
    }
  }
  return (
    <>
      <h2>Gráficos de voo</h2>
      <p className="desc">Últimos 5 minutos, amostrados a 2 Hz. Passe o cursor sobre um gráfico para ler o mesmo instante em todos.</p>
      <div className="brow"><button className="btn" onClick={copy}>Copiar CSV</button></div>
      {csv && <textarea className="json" readOnly value={csv} autoFocus onFocus={(e) => e.target.select()} aria-label="CSV" />}
      <div className="charts">{METRICS.map((m) => <Chart key={m.k} m={m} hover={hover} setHover={setHover} />)}</div>
    </>
  )
}

function Inspector() {
  useChannels('telemetry')
  const st = station.telem?.msg_stats ?? {}
  const rows = Object.entries(st).sort((a, b) => b[1].hz - a[1].hz)
  return (
    <>
      <h2>Inspetor MAVLink</h2>
      <p className="desc">Mensagens que a ponte recebe do veículo, com taxa atual e total.</p>
      <div className="tblw">
        <table className="mav">
          <thead><tr><th>Mensagem</th><th>Taxa</th><th>Recebidas</th></tr></thead>
          <tbody>
            {rows.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v.hz.toFixed(1)} Hz</td><td>{v.count.toLocaleString('pt-BR')}</td></tr>)}
            {!rows.length && <tr><td colSpan={3} className="empty">Nenhuma mensagem recebida ainda.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  )
}

const ICON: Record<LogLevel, string> = { info: '·', ok: '✓', warn: '⚠', error: '✕', cmd: '›' }
function Events() {
  useChannels('log')
  const [f, setF] = useState<'all' | LogLevel>('all')
  const list = station.log.filter((e) => f === 'all' || e.level === f).slice(-400).reverse()
  const opts: ['all' | LogLevel, string][] = [['all', 'Todos'], ['warn', 'Avisos'], ['error', 'Erros'], ['cmd', 'Comandos']]
  return (
    <>
      <h2>Log de eventos</h2>
      <p className="desc">Mensagens do veículo (STATUSTEXT), respostas a comandos e eventos da estação.</p>
      <div className="brow">{opts.map(([k, l]) => <button key={k} className={`btn ${f === k ? 'on' : ''}`} onClick={() => setF(k)}>{l}</button>)}</div>
      <div className="evlist">
        {list.map((e, i) => <div key={i}><span className="t">{clock(e.t)}</span><span className={e.level}>{ICON[e.level]}</span><span className={e.level}>{e.text}</span></div>)}
        {!list.length && <div><span /><span /><span className="t">Nada neste filtro.</span></div>}
      </div>
    </>
  )
}

function Summary() {
  useChannels('telemetry', 'map')
  const s = station.stats, t = station.telem
  const card = (title: string, v: string, unit = '', sub = '') => (
    <div className="scard"><h4>{title}</h4><b>{v}{unit && <small>{unit}</small>}</b>{sub && <div className="kv"><span>{sub}</span></div>}</div>
  )
  return (
    <>
      <h2>Resumo do voo</h2>
      <p className="desc">Totais desde que esta página foi aberta.</p>
      <div className="sumgrid">
        {card('Tempo de voo', fmtTime(s.flightS))}
        {card('Distância percorrida', fmtDist(s.distance))}
        {card('Altitude máxima', s.maxAlt.toFixed(1), 'm')}
        {card('Velocidade máxima', (s.maxGs * 3.6).toFixed(1), 'km/h', `${s.maxGs.toFixed(1)} m/s`)}
        {card('Bateria usada', t ? String(t.battery.consumed_mah) : '—', 'mAh', t ? `restam ${t.battery.remaining} %` : '')}
        {card('Fotos pedidas', String(s.photos))}
        {card('Lançamentos (entrega)', String(station.payload?.total ?? '—'), '', station.payload ? `${station.payload.loaded} carregados agora` : '')}
        {card('Área mapeada (LiDAR)', ((station.groundCells * 4 * station.voxelM ** 2) / 10000).toFixed(2), 'ha')}
        {card('Voxels no mapa 3D', station.vox.e.length.toLocaleString('pt-BR'))}
      </div>
    </>
  )
}

const TABS = [
  { id: 'graf', label: 'Gráficos de voo' },
  { id: 'mav', label: 'Inspetor MAVLink' },
  { id: 'ev', label: 'Log de eventos' },
  { id: 'ent', label: 'Lançamentos' },
  { id: 'res', label: 'Resumo do voo' },
] as const

export function AnalyzeView() {
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('graf')
  return (
    <section className="page" aria-label="Análise">
      <nav className="pnav">
        <div className="ph">Análise</div>
        {TABS.map((x) => <button key={x.id} className={tab === x.id ? 'on' : ''} onClick={() => setTab(x.id)}>{x.label}</button>)}
      </nav>
      <div className="pbody">
        {tab === 'graf' && <Charts />}
        {tab === 'mav' && <Inspector />}
        {tab === 'ev' && <Events />}
        {tab === 'ent' && <DeliveryLog />}
        {tab === 'res' && <Summary />}
      </div>
    </section>
  )
}
