// Reprodução de voo gravado (.tlog) e aviso de pré-voo com "fazer mesmo assim".

import { useState } from 'react'
import { station, useChannels } from '../lib/store'
import { fmtTime } from '../lib/format'
import { t } from '../lib/i18n'

const SPEEDS = [1, 2, 4, 8, 16]

export function ReplayBar() {
  useChannels('replay')
  const r = station.replay
  const [drag, setDrag] = useState<number | null>(null)
  if (!r) return null
  const pos = drag ?? r.t
  const send = (c: { speed?: number; paused?: boolean; seek?: number }) => station.send({ cmd: 'replay', ...c }, true)
  return (
    <div className="replay" role="group" aria-label={t('Reprodução do voo')}>
      <b className="rtag">{t('REPRODUÇÃO')}</b>
      <button className="btn" onClick={() => send({ paused: !r.paused })} aria-label={r.paused ? t('Continuar') : t('Pausar')}>{r.paused ? '▶' : '❚❚'}</button>
      <span className="rtime">{fmtTime(pos)}</span>
      <input type="range" min={0} max={Math.max(1, r.duration)} step={0.5} value={pos} aria-label={t('Posição no voo')}
        onChange={(e) => setDrag(+e.target.value)}
        onPointerUp={() => { if (drag !== null) send({ seek: drag }); setDrag(null) }}
        onKeyUp={() => { if (drag !== null) send({ seek: drag }); setDrag(null) }} />
      <span className="rtime">{fmtTime(r.duration)}</span>
      <select value={r.speed} onChange={(e) => send({ speed: +e.target.value })} aria-label={t('Velocidade da reprodução')}>
        {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
      </select>
      <small title={r.file}>{r.file.split(/[\\/]/).pop()}</small>
    </div>
  )
}

export function ForcePrompt() {
  useChannels('ui')
  const f = station.forceable
  if (!f) return null
  const what = f.cmd.cmd === 'takeoff' ? t('Decolar mesmo assim') : t('Iniciar mesmo assim')
  return (
    <div className="forcebox" role="alertdialog" aria-label={t('Verificação de pré-voo')}>
      <b>{t('Verificação de pré-voo')}</b>
      <p>{f.reason.replace(/^pré-voo \([^)]*\):\s*/, '')}</p>
      <p className="desc">{t('Ignore só se souber o motivo (ex.: voo indoor sem GPS). O piloto automático ainda faz as verificações dele.')}</p>
      <div className="brow">
        <button className="btn danger" onClick={() => station.forceLast()}>{what}</button>
        <button className="btn" autoFocus onClick={() => station.dismissForce()}>{t('Cancelar')}</button>
      </div>
    </div>
  )
}
