// Painel do motor (EMS) na tela de voo e sua configuração em Configurar → Motor.
// Mostradores redondos para as grandezas principais, barras com faixas verde/amarela/
// vermelha, células da bateria, gerador e uma faixa com horas, voo e autonomia.

import { useState } from 'react'
import { station, useChannels } from '../lib/store'
import { fmtTime } from '../lib/format'
import {
  bands, buildPanel, detectKind, frac, genFlag, KIND_LABEL, level, LIMIT_DEFS, LIMITS_BY_KIND, limitOf,
  engineKind, type EngineKind, type EngineSettings, type Level, type Limit, type LimitId, type Meter, type Panel,
} from '../lib/engine'
import { num, t as tr, tk } from '../lib/i18n'
import { Icon } from './Icons'

const fmtVal = (v: number | null, digits: number) => (v === null ? '—' : digits === 0 ? Math.round(v).toLocaleString(station.settings.lang === 'pt' ? 'pt-BR' : 'en-US') : num(v, digits))

const worst = (m: Meter): Level => m.rows.reduce<Level>((w, r) => {
  const l = level(r.value, m.lim)
  return l === 'crit' || w === 'crit' ? 'crit' : l === 'warn' || w === 'warn' ? 'warn' : l === 'ok' || w === 'ok' ? 'ok' : 'none'
}, 'none')

// ---------- Mostrador redondo ----------

const A0 = 150, SWEEP = 240
const polar = (a: number, r: number) => [60 + Math.cos((a * Math.PI) / 180) * r, 58 + Math.sin((a * Math.PI) / 180) * r]
function arc(f0: number, f1: number, r: number) {
  const a0 = A0 + SWEEP * f0, a1 = A0 + SWEEP * f1
  const [x0, y0] = polar(a0, r), [x1, y1] = polar(a1, r)
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`
}

function Dial({ m }: { m: Meter }) {
  const v = m.rows[0]?.value ?? null
  const lv = level(v, m.lim)
  const a = A0 + SWEEP * (v === null ? 0 : frac(v, m.lim))
  const [nx, ny] = polar(a, 38)
  return (
    <svg className="ems-dial" viewBox="0 0 120 108" role="img" aria-label={`${m.name}: ${fmtVal(v, m.digits)} ${m.unit}`}>
      <path d={arc(0, 1, 44)} className="emsd-track" />
      {bands(m.lim).map((b, i) => <path key={i} d={arc(frac(b.from, m.lim), frac(b.to, m.lim), 44)} className={`emsd-band ${b.level}`} />)}
      {v !== null && <line x1="60" y1="58" x2={nx} y2={ny} className="emsd-needle" />}
      <circle cx="60" cy="58" r="4" className="emsd-hub" />
      <text x="60" y="84" className="emsd-label">{m.short}</text>
      <text x="60" y="103" className={`emsd-val ${lv}`}>{fmtVal(v, m.digits)}</text>
    </svg>
  )
}

// ---------- Barra ----------

function Strip({ value, lim }: { value: number | null; lim: Limit }) {
  return (
    <span className="emsb-strip">
      {bands(lim).map((b, i) => (
        <i key={i} className={b.level} style={{ left: `${frac(b.from, lim) * 100}%`, width: `${(frac(b.to, lim) - frac(b.from, lim)) * 100}%` }} />
      ))}
      {value !== null && <em style={{ left: `${frac(value, lim) * 100}%` }} />}
    </span>
  )
}

function Bar({ m }: { m: Meter }) {
  const multi = m.rows.length > 1
  return (
    <div className="emsb" title={m.name}>
      <div className="emsb-h"><span>{m.short}</span>{!multi && <b className={level(m.rows[0].value, m.lim)}>{fmtVal(m.rows[0].value, m.digits)}<small>{m.unit}</small></b>}</div>
      {m.rows.map((r) => (
        <div key={r.label} className={`emsb-row ${multi ? '' : 'solo'}`}>
          {multi && <i>{r.label}</i>}
          <Strip value={r.value} lim={m.lim} />
          {multi && <b className={level(r.value, m.lim)}>{fmtVal(r.value, m.digits)}</b>}
        </div>
      ))}
    </div>
  )
}

function Cells({ c }: { c: NonNullable<Panel['cells']> }) {
  const lo = Math.min(...c.values), hi = Math.max(...c.values)
  return (
    <div className="emsb" title={tr('Tensão por célula')}>
      <div className="emsb-h"><span>{tr('CÉLULAS')}</span><b className={level(c.delta, c.deltaLim)}>Δ {num(c.delta, 2)}<small>V</small></b></div>
      <div className="ems-cells">
        {c.values.map((v, i) => (
          <span key={i} className={level(v, c.lim)} title={`${tr('Célula {n}', { n: i + 1 })}: ${num(v, 3)} V`}>
            <i style={{ height: `${Math.max(4, frac(v, c.lim) * 100)}%` }} />
          </span>
        ))}
      </div>
      <div className="ems-cellinfo">{tr('mín. {lo} · máx. {hi} V', { lo: num(lo, 2), hi: num(hi, 2) })}</div>
    </div>
  )
}

function Generator({ gv }: { gv: NonNullable<Panel['generator']> }) {
  const g = gv.g
  const charging = g.battery_current !== null && g.battery_current < 0
  return (
    <div className={`ems-gen ${gv.stale ? 'stale' : ''}`}>
      <div className="ems-sub">{tr('Gerador')}
        <span className="ems-flags">{g.status.map((f) => { const x = genFlag(f); return <span key={f} className={x.level}>{x.text}</span> })}</span>
      </div>
      <div className="ems-genbars">{gv.meters.map((m) => <Bar key={m.id} m={m} />)}</div>
      <div className="ems-kvs">
        <span>{tr('Barramento')}<b>{num(g.bus_voltage, 1)} V</b></span>
        <span>{tr('Carga')}<b>{g.load_current === null ? '—' : `${num(g.load_current, 1)} A`}</b></span>
        <span>{charging ? tr('Carregando bateria') : tr('Bateria fornece')}<b>{g.battery_current === null ? '—' : `${num(Math.abs(g.battery_current), 1)} A`}</b></span>
        <span>{tr('Funcionamento')}<b>{g.runtime_s === null ? '—' : `${num(g.runtime_s / 3600, 1)} h`}</b></span>
        <span>{tr('Manutenção em')}<b className={g.maintenance_s !== null && g.maintenance_s <= 0 ? 'crit' : ''}>{g.maintenance_s === null ? '—' : `${num(g.maintenance_s / 3600, 0)} h`}</b></span>
      </div>
    </div>
  )
}

/** Horas, voo e os números de consumo/autonomia de cada tipo de motor. */
function stats(panel: Panel, s: EngineSettings): [string, string, Level?][] {
  const tm = station.telem!
  const hours = station.maint ? `${num(station.maint.flight_s / 3600, 1)} h` : '—'
  const out: [string, string, Level?][] = [[tr('HORAS'), hours], [tr('VOO'), fmtTime(station.stats.flightS)]]
  const pack = panel.pack
  if (panel.kind === 'electric') {
    const cur = pack.current ?? tm.battery.current
    out.push([tr('POTÊNCIA'), `${num((pack.voltage * cur) / 1000, 2)} kW`])
    out.push([tr('ENERGIA'), pack.energy_wh !== null ? `${num(pack.energy_wh, 0)} Wh` : pack.consumed_mah !== null ? `${pack.consumed_mah} mAh` : '—'])
    let left = pack.time_remaining_s
    if (left === null && pack.remaining !== null && pack.consumed_mah !== null && pack.remaining < 98 && cur > 0.5) {
      const cap = pack.consumed_mah / (1 - pack.remaining / 100)
      left = ((cap * pack.remaining) / 100 / cur) * 3.6
    }
    out.push([tr('AUTONOMIA'), left === null ? '—' : fmtTime(left), left !== null && left < 180 ? 'crit' : left !== null && left < 360 ? 'warn' : undefined])
  } else {
    const efi = tm.propulsion?.efi
    const flow = efi?.fuel_flow ?? null
    out.push([tr('FLUXO'), flow === null ? '—' : `${num((flow * 60) / 1000, 2)} L/h`])
    out.push([tr('CONSUMIDO'), efi?.fuel_consumed == null ? '—' : `${num(efi.fuel_consumed / 1000, 2)} L`])
    const left = s.tankL > 0 && panel.fuelPct !== null && flow ? ((s.tankL * panel.fuelPct) / 100 / (flow / 1000)) * 60 : null
    out.push([tr('AUTONOMIA'), left === null ? '—' : fmtTime(left), left !== null && left < 300 ? 'crit' : left !== null && left < 600 ? 'warn' : undefined])
  }
  return out
}

/** Mostrador do motor (o "vidro" do EMS), usado no painel flutuante e na aba Painel. */
export function EngineFace() {
  useChannels('telemetry', 'maint')
  const tm = station.telem
  const s = station.settings.engine
  const panel = tm?.connected ? buildPanel(tm, s) : null
  return (
    <div className="ems-face">
      {!panel ? <p className="ems-empty">{tr('Sem veículo conectado.')}</p> : (
        <>
          {panel.stale && <p className="ems-empty">{panel.kind === 'electric' ? tr('Sem telemetria dos ESCs: mostrando só a bateria.') : tr('Sem dados da EFI (EFI_STATUS). Confira EFI_TYPE e a taxa de telemetria.')}</p>}
          <div className="ems-main">
            <div className="ems-dials">{panel.dials.map((m) => <Dial key={m.id} m={m} />)}</div>
            <div className="ems-bars">
              {panel.bars.map((m) => <Bar key={m.id} m={m} />)}
              {panel.cells && <Cells c={panel.cells} />}
            </div>
          </div>
          {panel.generator && <Generator gv={panel.generator} />}
          {panel.others.length > 0 && (
            <div className="ems-kvs">
              {panel.others.map((b) => (
                <span key={b.id}>{tr('Bateria {n}', { n: b.id + 1 })}{b.function !== 'unknown' && b.function !== 'all' ? ` · ${b.function}` : ''}
                  <b>{num(b.voltage, 1)} V{b.remaining !== null ? ` · ${b.remaining} %` : ''}</b></span>
              ))}
            </div>
          )}
          <div className="ems-strip">
            {stats(panel, s).map(([k, v, lv]) => <span key={k}>{k}<b className={lv ?? ''}>{v}</b></span>)}
          </div>
        </>
      )}
    </div>
  )
}

export function EnginePanel() {
  useChannels('telemetry', 'ui')
  const [collapsed, setCollapsed] = useState(false)
  if (!station.engineOpen) return null
  const tm = station.telem
  const panel = tm?.connected ? buildPanel(tm, station.settings.engine) : null
  const all = panel ? [...panel.dials, ...panel.bars] : []
  const alarm = all.some((m) => worst(m) === 'crit') ? 'crit' : all.some((m) => worst(m) === 'warn') ? 'warn' : ''
  return (
    <aside className={`ems ${collapsed ? 'collapsed' : ''} ${alarm}`} aria-label={tr('Painel do motor')}>
      <button className="rp-h" onClick={() => setCollapsed(!collapsed)}>
        <Icon.chevronUp />{tr('Motor')}
        {panel && <span className="ems-kind">{tr(KIND_LABEL[panel.kind])}</span>}
        {panel?.state && <span className={`ems-state ${panel.state.level}`}>{panel.state.text}</span>}
      </button>
      {!collapsed && <EngineFace />}
    </aside>
  )
}

// ---------- Configurar → Motor ----------

const KINDS: ['auto' | EngineKind, string][] = [
  ['auto', tk('Automático (pela telemetria)')],
  ['electric', tk('Elétrico (ESCs e bateria)')],
  ['combustion', tk('Combustão (pistão, com EFI)')],
  ['jet', tk('Turbina a jato')],
]
const COLS: [keyof Limit, string][] = [
  ['min', tk('Escala mín.')], ['redLo', tk('Vermelho abaixo de')], ['yelLo', tk('Amarelo abaixo de')],
  ['yelHi', tk('Amarelo acima de')], ['redHi', tk('Vermelho acima de')], ['max', tk('Escala máx.')],
]

export function EngineSetup() {
  useChannels('ui', 'telemetry')
  const saved = station.settings.engine
  const [d, setD] = useState<EngineSettings>(saved)
  const tm = station.telem
  const kind = engineKind(tm, d)
  const ids: LimitId[] = LIMITS_BY_KIND[kind]
  const setLimit = (id: LimitId, k: keyof Limit, raw: string) => {
    const cur = limitOf(d, id)
    const nullable = k !== 'min' && k !== 'max'
    const v = raw.trim() === '' ? (nullable ? null : cur[k]) : +raw
    if (v !== null && !Number.isFinite(v)) return
    setD({ ...d, limits: { ...d.limits, [id]: { ...cur, [k]: v } } })
  }
  const dirty = JSON.stringify(d) !== JSON.stringify(saved)
  return (
    <>
      <h2>{tr('Motor')}</h2>
      <p className="desc">{tr('Painel do motor da tela de voo (botão Motor) e alertas no log quando algo sai da faixa com o veículo armado. Fica salvo neste computador.')}</p>
      <div className="card"><h3>{tr('Propulsão')}</h3>
        <div className="field">
          <label htmlFor="eng_kind">{tr('Tipo de motor')}<small>{tm?.connected ? tr('Detectado: {k}', { k: tr(KIND_LABEL[detectKind(tm.propulsion)]) }) : ''}</small></label>
          <div className="fin">
            <select id="eng_kind" value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as EngineSettings['kind'] })}>
              {KINDS.map(([v, l]) => <option key={v} value={v}>{tr(l)}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="eng_cells">{tr('Células da bateria')}<small>{tr('0 = pela telemetria ou estimado pela tensão (ex.: 6 para 6S)')}</small></label>
          <div className="fin"><input id="eng_cells" type="number" min={0} max={24} value={d.cells} onChange={(e) => setD({ ...d, cells: Math.max(0, Math.round(+e.target.value || 0)) })} /></div>
        </div>
        <div className="field">
          <label htmlFor="eng_tank">{tr('Tanque de combustível')}<small>{tr('litros; com ele o nível e a autonomia saem do consumo da EFI (0 = usar o sensor FUEL)')}</small></label>
          <div className="fin"><input id="eng_tank" type="number" min={0} step={0.1} value={d.tankL} onChange={(e) => setD({ ...d, tankL: Math.max(0, +e.target.value || 0) })} />L</div>
        </div>
      </div>
      <div className="card"><h3>{tr('Faixas de operação · {k}', { k: tr(KIND_LABEL[kind]) })}</h3>
        <p className="desc">{tr('Use os limites do manual do motor, da bateria e dos ESCs. Campo vazio = sem esse limite.')}</p>
        <div className="eng-lims">
          <table>
            <thead><tr><th />{COLS.map(([k, l]) => <th key={k}>{tr(l)}</th>)}</tr></thead>
            <tbody>
              {ids.map((id) => {
                const l = limitOf(d, id)
                return (
                  <tr key={id}>
                    <th>{tr(LIMIT_DEFS[id].label)} <small>{LIMIT_DEFS[id].unit}</small></th>
                    {COLS.map(([k]) => (
                      <td key={k} className={`c-${k}`}>
                        <input type="number" aria-label={`${tr(LIMIT_DEFS[id].label)} · ${tr(COLS.find((c) => c[0] === k)![1])}`} value={l[k] ?? ''} step="any" onChange={(e) => setLimit(id, k, e.target.value)} />
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="brow" style={{ marginTop: 14 }}>
        <button className="btn on" disabled={!dirty} onClick={() => station.saveSettings({ engine: d })}>{tr('Salvar')}</button>
        <button className="btn" disabled={!dirty} onClick={() => setD(saved)}>{tr('Descartar')}</button>
        <button className="btn" onClick={() => setD({ ...d, limits: Object.fromEntries(Object.entries(d.limits).filter(([k]) => !ids.includes(k as LimitId))) })}>{tr('Faixas padrão')}</button>
        <button className="btn" onClick={() => { station.engineOpen = true; station.setView('fly') }}>{tr('Abrir o painel na tela de voo')}</button>
      </div>
      <div className="card"><h3>{tr('De onde vêm os dados')}</h3>
        <p className="desc">{tr('Elétrico: BATTERY_STATUS (células, temperatura) e ESC_TELEMETRY (rotação, temperatura e corrente de cada ESC; BLHeli/DShot ou DroneCAN). Combustão e turbina: EFI_STATUS (EFI_TYPE) e RPM. Gerador: GENERATOR_STATUS (RichenPower, Loweheiser, célula de combustível).')}</p>
        <p className="desc">{tr('Sensores sem mensagem própria entram por NAMED_VALUE_FLOAT de um script Lua: CHT1…CHT8 e EGT1…EGT8 (por cilindro), H2O (água, °C), OILT (°C), OILP (bar), FUEL (%), PUMP_V (bomba da turbina, V) e TURB_ST (0 desligada, 1 pronta, 2 ignição, 3 acelerando, 4 funcionando, 5 resfriando, 6 falha).')}</p>
      </div>
    </>
  )
}
