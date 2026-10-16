// Registro de manutenção (Configurar → Manutenção): horas e voos da aeronave, baterias,
// tarefas periódicas, histórico de voos e anotações. Quem conta é a ponte.

import { useState } from 'react'
import { station, useChannels } from '../lib/store'
import { fmtDist, fmtTime } from '../lib/format'
import { getLang, t } from '../lib/i18n'
import type { MaintBattery, MaintTask } from '../types'

const hours = (s: number) => `${(s / 3600).toFixed(1)} h`
const when = (ms: number) => new Date(ms).toLocaleString(getLang() === 'pt' ? 'pt-BR' : 'en-US', { dateStyle: 'short', timeStyle: 'short' })

type DraftBattery = Omit<MaintBattery, 'flight_s'>
type DraftTask = Pick<MaintTask, 'id' | 'name' | 'every_h' | 'every_flights'>

function Editor({ onClose }: { onClose: () => void }) {
  const m = station.maint!
  const [airframe, setAirframe] = useState(m.airframe)
  const [bats, setBats] = useState<DraftBattery[]>(m.batteries.map(({ flight_s: _f, ...b }) => b))
  const [active, setActive] = useState<number | null>(m.active_battery)
  const [tasks, setTasks] = useState<DraftTask[]>(m.tasks.map(({ id, name, every_h, every_flights }) => ({ id, name, every_h, every_flights })))
  const nextId = (xs: { id: number }[]) => Math.max(0, ...xs.map((x) => x.id)) + 1
  const save = () => {
    if (station.send({ cmd: 'maintenance_config', airframe, batteries: bats, active_battery: active, tasks })) onClose()
  }
  return (
    <div className="card"><h3>{t('Editar')}</h3>
      <div className="field"><label htmlFor="mt_air">{t('Aeronave')}</label>
        <div className="fin"><input id="mt_air" value={airframe} maxLength={60} onChange={(e) => setAirframe(e.target.value)} /></div></div>
      <div className="sub">{t('Baterias')}</div>
      {bats.map((b, i) => (
        <div className="mrow" key={b.id}>
          <input type="radio" name="activebat" checked={active === b.id} disabled={b.retired} aria-label={t('Em uso')} onChange={() => setActive(b.id)} />
          <input value={b.name} maxLength={30} aria-label={t('Nome')} onChange={(e) => setBats(bats.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <label>{t('ciclos')}<input type="number" min={0} value={b.cycles} onChange={(e) => setBats(bats.map((x, j) => (j === i ? { ...x, cycles: Math.max(0, Math.round(+e.target.value)) } : x)))} /></label>
          <label>{t('limite')}<input type="number" min={0} value={b.max_cycles} onChange={(e) => setBats(bats.map((x, j) => (j === i ? { ...x, max_cycles: Math.max(0, Math.round(+e.target.value)) } : x)))} /></label>
          <label className="tog"><input type="checkbox" checked={b.retired} onChange={(e) => { setBats(bats.map((x, j) => (j === i ? { ...x, retired: e.target.checked } : x))); if (e.target.checked && active === b.id) setActive(null) }} />{t('aposentada')}</label>
          <button className="ib" aria-label={t('Remover')} onClick={() => { setBats(bats.filter((_, j) => j !== i)); if (active === b.id) setActive(null) }}>✕</button>
        </div>
      ))}
      <div className="brow"><button className="btn" onClick={() => { const id = nextId(bats); setBats([...bats, { id, name: t('Bateria {n}', { n: id }), cycles: 0, max_cycles: 300, retired: false }]) }}>{t('+ Bateria')}</button></div>
      <div className="sub">{t('Tarefas periódicas')}</div>
      {tasks.map((k, i) => (
        <div className="mrow" key={k.id}>
          <input className="grow" value={k.name} maxLength={80} aria-label={t('Tarefa')} onChange={(e) => setTasks(tasks.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <label>{t('a cada (h)')}<input type="number" min={0} step={0.5} value={k.every_h} onChange={(e) => setTasks(tasks.map((x, j) => (j === i ? { ...x, every_h: Math.max(0, +e.target.value) } : x)))} /></label>
          <label>{t('ou voos')}<input type="number" min={0} value={k.every_flights} onChange={(e) => setTasks(tasks.map((x, j) => (j === i ? { ...x, every_flights: Math.max(0, Math.round(+e.target.value)) } : x)))} /></label>
          <button className="ib" aria-label={t('Remover')} onClick={() => setTasks(tasks.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <div className="brow"><button className="btn" onClick={() => setTasks([...tasks, { id: nextId(tasks), name: '', every_h: 10, every_flights: 0 }])}>{t('+ Tarefa')}</button></div>
      <div className="brow" style={{ marginTop: 12 }}>
        <button className="btn on" onClick={save}>{t('Salvar')}</button>
        <button className="btn" onClick={onClose}>{t('Cancelar')}</button>
      </div>
    </div>
  )
}

function TaskRow({ k }: { k: MaintTask }) {
  const [note, setNote] = useState<string | null>(null)
  const limit = [k.every_h ? t('{h} h', { h: k.every_h }) : '', k.every_flights ? t('{n} voos', { n: k.every_flights }) : ''].filter(Boolean).join(t(' ou '))
  return (
    <div className={`task ${k.due ? 'due' : k.used > 0.8 ? 'soon' : ''}`}>
      <div className="th">
        <b>{k.name}</b>
        <small>{t('a cada {limit} · desde a última: {h} h, {n} voos', { limit, h: k.since_h.toFixed(1), n: k.since_flights })}{k.done_at ? ` · ${when(k.done_at)}` : ''}</small>
      </div>
      <i className="bar"><b style={{ width: `${Math.min(100, k.used * 100)}%` }} /></i>
      {note === null ? (
        <button className={`btn ${k.due ? 'on' : ''}`} onClick={() => setNote('')}>{t('Feita')}</button>
      ) : (
        <span className="donebox">
          <input value={note} autoFocus maxLength={200} placeholder={t('observação (opcional)')} onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { station.send({ cmd: 'maintenance_done', task: k.id, note }); setNote(null) } if (e.key === 'Escape') setNote(null) }} />
          <button className="btn on" onClick={() => { station.send({ cmd: 'maintenance_done', task: k.id, note }); setNote(null) }}>{t('Registrar')}</button>
        </span>
      )}
    </div>
  )
}

export function MaintenanceView() {
  useChannels('maint', 'conn')
  const [editing, setEditing] = useState(false)
  const [note, setNote] = useState('')
  const m = station.maint
  if (!m) return <><h2>{t('Manutenção')}</h2><p className="desc">{t('Aguardando a ponte enviar o registro de manutenção.')}</p></>
  const due = m.tasks.filter((k) => k.due)
  const bat = m.batteries.find((b) => b.id === m.active_battery)
  return (
    <>
      <h2>{t('Manutenção')} · {m.airframe}</h2>
      <p className="desc">{t('A ponte conta o tempo no ar de cada voo (do armar ao desarmar) e soma um ciclo na bateria em uso. Fica gravado na ponte, junto com o resto da estação.')}</p>
      <div className="sumgrid">
        <div className="scard"><h4>{t('Horas de voo')}</h4><b>{hours(m.flight_s)}</b></div>
        <div className="scard"><h4>{t('Voos')}</h4><b>{m.flights}</b></div>
        <div className="scard"><h4>{t('Vezes armado')}</h4><b>{m.arm_cycles}</b></div>
        <div className="scard"><h4>{t('Bateria em uso')}</h4><b>{bat ? bat.name : '—'}</b>{bat && <small>{t('{n} ciclos', { n: bat.cycles })}{bat.max_cycles ? ` / ${bat.max_cycles}` : ''}</small>}</div>
        <div className="scard"><h4>{t('Agora')}</h4><b>{m.flying_s != null ? fmtTime(m.flying_s) : '—'}</b><small>{m.flying_s != null ? t('armado, contando') : t('desarmado')}</small></div>
      </div>
      {due.length > 0 && <div className="warnbox" style={{ marginTop: 12 }}>{t('Vencidas: {list}', { list: due.map((k) => k.name).join(', ') })}</div>}
      {bat && bat.max_cycles > 0 && bat.cycles >= bat.max_cycles && <div className="warnbox">{t('{name} passou do limite de ciclos: considere aposentar.', { name: bat.name })}</div>}
      {!m.active_battery && <div className="hint warn">{t('Nenhuma bateria em uso: os ciclos não estão sendo contados.')}</div>}

      {editing ? <Editor onClose={() => setEditing(false)} /> : (
        <>
          <div className="card"><h3>{t('Tarefas')}</h3>
            {m.tasks.map((k) => <TaskRow key={k.id} k={k} />)}
            {!m.tasks.length && <div className="empty">{t('Nenhuma tarefa cadastrada.')}</div>}
          </div>
          <div className="card"><h3>{t('Baterias')}</h3>
            <div className="tblw"><table className="mav"><thead><tr><th>{t('Nome')}</th><th>{t('Ciclos')}</th><th>{t('Horas')}</th><th>{t('Estado')}</th></tr></thead>
              <tbody>{m.batteries.map((b) => (
                <tr key={b.id} className={b.retired ? 'muted' : ''}><td>{b.name}{b.id === m.active_battery ? ` · ${t('em uso')}` : ''}</td><td>{b.cycles}{b.max_cycles ? ` / ${b.max_cycles}` : ''}</td><td>{hours(b.flight_s)}</td>
                  <td>{b.retired ? t('aposentada') : b.max_cycles && b.cycles >= b.max_cycles ? <span className="crit">{t('no limite')}</span> : t('ok')}</td></tr>
              ))}</tbody></table></div>
          </div>
          <div className="brow"><button className="btn" onClick={() => setEditing(true)}>{t('Editar aeronave, baterias e tarefas')}</button></div>
        </>
      )}

      <div className="card"><h3>{t('Anotações')}</h3>
        <div className="brow">
          <input className="grow" value={note} maxLength={500} placeholder={t('ex.: trocado o GPS, motor 3 com ruído')} onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && note.trim()) { station.send({ cmd: 'maintenance_note', text: note }); setNote('') } }} />
          <button className="btn on" disabled={!note.trim()} onClick={() => { station.send({ cmd: 'maintenance_note', text: note }); setNote('') }}>{t('Anotar')}</button>
        </div>
        {m.notes.slice(0, 30).map((n, i) => <div className="note" key={i}><small>{when(n.t)}</small> {n.text}</div>)}
      </div>

      <div className="card"><h3>{t('Voos')}</h3>
        <div className="tblw"><table className="mav"><thead><tr><th>{t('Nº')}</th><th>{t('Início')}</th><th>{t('Duração')}</th><th>{t('Alt. máx.')}</th><th>{t('Distância')}</th><th>{t('Bateria')}</th></tr></thead>
          <tbody>
            {m.history.slice(0, 50).map((f) => (
              <tr key={f.n}><td>{f.n}</td><td>{when(f.start)}</td><td>{fmtTime(f.duration_s)}</td><td>{f.max_alt.toFixed(0)} m</td><td>{fmtDist(f.distance_m)}</td>
                <td>{m.batteries.find((b) => b.id === f.battery)?.name ?? '—'}</td></tr>
            ))}
            {!m.history.length && <tr><td colSpan={6} className="empty">{t('Nenhum voo registrado ainda.')}</td></tr>}
          </tbody></table></div>
      </div>
    </>
  )
}
