// Calibração guiada: acelerômetro (6 posições ou só nivelar), bússola, giroscópio e rádio.

import { station, useChannels } from '../lib/store'
import { t } from '../lib/i18n'

const positions = () => ['', t('Nivelado, sobre uma superfície plana'), t('Deitado sobre o lado esquerdo'), t('Deitado sobre o lado direito'),
  t('Nariz para baixo'), t('Nariz para cima'), t('De costas (de cabeça para baixo)')]

function blocked(): string | null {
  const tm = station.telem
  if (station.replay) return t('Reproduzindo um voo gravado: calibração desligada.')
  if (!tm?.connected) return t('Conecte um veículo para calibrar.')
  if (tm.armed) return t('Desarme os motores para calibrar.')
  return null
}

function calibLog() {
  return station.log.filter((e) => /calibrat|place vehicle|trim ok|gyro|compass|mag/i.test(e.text) || /calibra|bússola/i.test(e.text)).slice(-4)
}

function Accel() {
  const a = station.calib.accel
  const why = blocked()
  const step = a?.status === 'position' ? a.position : 0
  return (
    <div className="card"><h3>{t('Acelerômetro')}</h3>
      <p className="desc">{t('Nivelar basta quando a placa foi montada reta. A calibração completa pede seis posições; segure o veículo parado em cada uma.')}</p>
      {step > 0 ? (
        <div className="calstep">
          <b>{t('Posição {n} de 6', { n: step })}</b>
          <span>{positions()[step]}</span>
          <button className="btn on" onClick={() => station.send({ cmd: 'accel_pos', position: step })}>{t('Pronto, nesta posição')}</button>
        </div>
      ) : (
        <div className="brow">
          <button className="btn" disabled={!!why} onClick={() => station.send({ cmd: 'calibrate', kind: 'level' })}>{t('Nivelar (rápido)')}</button>
          <button className="btn on" disabled={!!why} onClick={() => station.send({ cmd: 'calibrate', kind: 'accel' })}>{t('Calibração completa (6 posições)')}</button>
        </div>
      )}
      {a?.status === 'success' && <div className="hint ok">{t('Acelerômetro calibrado.')}</div>}
      {a?.status === 'failed' && <div className="hint crit">{t('A calibração falhou: repita, com o veículo bem parado em cada posição.')}</div>}
    </div>
  )
}

function Compass() {
  const c = station.calib.compass
  const ids = Object.keys(c).map(Number)
  const running = ids.some((i) => c[i].pct < 100 && !['success', 'failed'].includes(c[i].status))
  const done = ids.length > 0 && ids.every((i) => c[i].status === 'success')
  const why = blocked()
  return (
    <div className="card"><h3>{t('Bússola')}</h3>
      <p className="desc">{t('Gire o veículo devagar em todas as direções (como se desenhasse uma esfera) até as barras completarem. Longe de metal e de motores ligados.')}</p>
      {ids.map((i) => (
        <div className="calbar" key={i}>
          <span>{t('Bússola {n}', { n: i + 1 })}</span>
          <i><b style={{ width: `${c[i].pct}%` }} className={c[i].status === 'failed' ? 'bad' : ''} /></i>
          <small>{c[i].status === 'success' ? t('ok · ajuste {f}', { f: c[i].fitness?.toFixed(1) ?? '—' }) : c[i].status === 'failed' ? t('falhou') : `${c[i].pct}%`}</small>
        </div>
      ))}
      <div className="brow">
        {!running && <button className="btn on" disabled={!!why} onClick={() => { station.calib.compass = {}; station.send({ cmd: 'calibrate', kind: 'compass' }) }}>{ids.length ? t('Calibrar de novo') : t('Iniciar calibração da bússola')}</button>}
        {running && <button className="btn danger" onClick={() => station.send({ cmd: 'calibrate', kind: 'compass_cancel' })}>{t('Cancelar')}</button>}
        {done && <button className="btn" disabled={!!why} onClick={() => station.send({ cmd: 'reboot' })}>{t('Reiniciar controladora')}</button>}
      </div>
      {done && <div className="hint ok">{t('Bússola salva. Reinicie a controladora para usar a calibração nova.')}</div>}
    </div>
  )
}

function Radio() {
  const tm = station.telem
  const rc = tm?.rc ?? []
  const range = station.rcCapture
  const thr = (station.params.get('RCMAP_THROTTLE') ?? 3) - 1
  const unmoved = range ? rc.map((_, i) => i).filter((i) => i < 4 && (range.max[i] ?? 0) - (range.min[i] ?? 0) < 300) : []
  const save = () => {
    if (!range) return
    rc.forEach((v, i) => {
      const lo = range.min[i], hi = range.max[i]
      if (lo === undefined || hi === undefined || hi - lo < 300) return
      const n = i + 1
      station.send({ cmd: 'param_set', id: `RC${n}_MIN`, value: lo })
      station.send({ cmd: 'param_set', id: `RC${n}_MAX`, value: hi })
      station.send({ cmd: 'param_set', id: `RC${n}_TRIM`, value: i === thr ? lo : Math.min(hi, Math.max(lo, v)) })
    })
    station.setRcCapture(false)
    station.addLog('ok', t('Calibração do rádio gravada'))
  }
  return (
    <div className="card"><h3>{t('Rádio')}</h3>
      <p className="desc">{t('Ligue o rádio, clique em Capturar e leve todos os sticks e chaves aos extremos. Depois, deixe os sticks no centro (acelerador embaixo) e salve.')}</p>
      {!rc.length && <div className="hint">{t('Sem canais do rádio (RC_CHANNELS) ainda.')}</div>}
      <div className="rcgrid">
        {rc.map((v, i) => (
          <div className="calbar" key={i}>
            <span>{t('Canal {n}', { n: i + 1 })}{i === thr ? ` · ${t('acel.')}` : ''}</span>
            <i>
              {range && range.min[i] !== undefined && <u style={{ left: `${((range.min[i] - 800) / 1400) * 100}%`, width: `${((range.max[i] - range.min[i]) / 1400) * 100}%` }} />}
              <b className="pos" style={{ left: `${((Math.min(2200, Math.max(800, v)) - 800) / 1400) * 100}%` }} />
            </i>
            <small>{v}</small>
          </div>
        ))}
      </div>
      <div className="brow">
        {!range ? (
          <button className="btn on" disabled={!rc.length || !!blocked()} onClick={() => station.setRcCapture(true)}>{t('Capturar extremos')}</button>
        ) : (
          <>
            <button className="btn on" disabled={unmoved.length === 4} onClick={save}>{t('Salvar calibração')}</button>
            <button className="btn" onClick={() => station.setRcCapture(false)}>{t('Cancelar')}</button>
          </>
        )}
      </div>
      {range && unmoved.length > 0 && <div className="hint warn">{t('Ainda sem curso suficiente nos canais {list}.', { list: unmoved.map((i) => i + 1).join(', ') })}</div>}
    </div>
  )
}

export function Calibration() {
  useChannels('calib', 'telemetry', 'log', 'params', 'replay')
  const why = blocked()
  const recent = calibLog()
  return (
    <>
      <h2>{t('Calibração')}</h2>
      <p className="desc">{why ?? t('Faça com o veículo desarmado e as hélices removidas.')}</p>
      <Accel />
      <Compass />
      <div className="card"><h3>{t('Giroscópio')}</h3>
        <p className="desc">{t('Deixe o veículo parado por alguns segundos.')}</p>
        <div className="brow"><button className="btn" disabled={!!why} onClick={() => station.send({ cmd: 'calibrate', kind: 'gyro' })}>{t('Calibrar giroscópio')}</button></div>
      </div>
      <Radio />
      {recent.length > 0 && (
        <div className="card"><h3>{t('Mensagens do veículo')}</h3>
          {recent.map((e, i) => <div className="hint" key={i}>{e.text}</div>)}
        </div>
      )}
    </>
  )
}
