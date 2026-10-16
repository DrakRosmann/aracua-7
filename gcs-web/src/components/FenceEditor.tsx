// Geocerca por polígonos na tela Planejar: desenhar áreas permitidas e proibidas,
// conferir a missão contra elas e enviar ao veículo.

import { station, useChannels } from '../lib/store'
import { areaM2, fenceIsEmpty, fenceViolation, sameFence } from '../lib/fence'
import { wpName } from '../lib/format'
import { Icon } from './Icons'
import { t } from '../lib/i18n'

const ha = (m2: number) => (m2 >= 10_000 ? `${(m2 / 10_000).toFixed(1)} ha` : `${Math.round(m2)} m²`)

export function FenceEditor() {
  useChannels('fence', 'mission', 'telemetry', 'params', 'replay')
  const f = station.fenceDraft
  const d = station.drawing
  const connected = !!station.telem?.connected && !station.replay
  const onVehicle = sameFence(f, station.vehicleFence)
  const up = station.fenceUpload
  const polyOn = ((station.params.get('FENCE_TYPE') ?? 0) & 4) !== 0
  const enabled = (station.params.get('FENCE_ENABLE') ?? 0) > 0
  // Waypoints que caem fora da área permitida ou dentro de uma proibida.
  const bad = fenceIsEmpty(f) ? [] : station.plan.map((w, i) => [i, fenceViolation(w, f)] as const).filter(([, v]) => v)
  const home = station.telem?.home
  const homeBad = home && !fenceIsEmpty(f) ? fenceViolation(home, f) : null

  const row = (kind: 'inclusion' | 'exclusion', i: number, label: string, area: number, n: number) => (
    <div className={`fencerow ${kind}`} key={`${kind}${i}`}>
      <span className="sw" />
      <span>{label}<small>{t('{n} vértices · {area}', { n, area: ha(area) })}</small></span>
      <button className="ib" aria-label={t('Remover')} onClick={() => station.removeFenceArea(kind, i)}>✕</button>
    </div>
  )

  return (
    <details id="fence">
      <summary><Icon.fence />{t('Geocerca')}<span className="ch"><Icon.chevron /></span></summary>
      <div className="db">
        <div className="hint">{t('O veículo tem de ficar dentro de todas as áreas permitidas (verde) e fora das proibidas (vermelho). Ao violar, o ArduPilot faz a ação de FENCE_ACTION (padrão: RTL).')}</div>
        {f.inclusion.map((p, i) => row('inclusion', i, t('Área permitida {n}', { n: i + 1 }), areaM2(p), p.length))}
        {f.exclusion.map((p, i) => row('exclusion', i, t('Área proibida {n}', { n: i + 1 }), areaM2(p), p.length))}
        {f.circles_inclusion.map((c, i) => (
          <div className="fencerow inclusion" key={`ci${i}`}><span className="sw" /><span>{t('Círculo permitido')}<small>{t('raio {r} m', { r: Math.round(c.radius) })}</small></span>
            <button className="ib" aria-label={t('Remover')} onClick={() => station.removeFenceArea('circles_inclusion', i)}>✕</button></div>
        ))}
        {f.circles_exclusion.map((c, i) => (
          <div className="fencerow exclusion" key={`ce${i}`}><span className="sw" /><span>{t('Círculo proibido')}<small>{t('raio {r} m', { r: Math.round(c.radius) })}</small></span>
            <button className="ib" aria-label={t('Remover')} onClick={() => station.removeFenceArea('circles_exclusion', i)}>✕</button></div>
        ))}
        {fenceIsEmpty(f) && !d && <div className="empty">{t('Nenhuma área. O raio FENCE_RADIUS em volta do home continua valendo.')}</div>}

        {d ? (
          <div className="drawbox">
            <b>{d.kind === 'inclusion' ? t('Desenhando área permitida') : t('Desenhando área proibida')}</b>
            <span>{t('Clique no mapa para marcar os vértices ({n} até agora).', { n: d.pts.length })}</span>
            <div className="brow">
              <button className="btn on" disabled={d.pts.length < 3} onClick={() => station.finishDrawing()}>{t('Concluir')}</button>
              <button className="btn" disabled={!d.pts.length} onClick={() => station.undoDrawPoint()}>{t('Desfazer ponto')}</button>
              <button className="btn" onClick={() => station.cancelDrawing()}>{t('Cancelar')}</button>
            </div>
          </div>
        ) : (
          <div className="brow">
            <button className="btn" onClick={() => station.startDrawing('inclusion')}>{t('+ Área permitida')}</button>
            <button className="btn" onClick={() => station.startDrawing('exclusion')}>{t('+ Área proibida')}</button>
          </div>
        )}

        {bad.length > 0 && (
          <div className="warnbox">{t('Waypoints que violam a geocerca: {list}. O veículo vai acionar o failsafe ao chegar neles.', { list: bad.map(([i]) => wpName(i)).join(', ') })}</div>
        )}
        {homeBad && <div className="warnbox">{t('O home está fora da área permitida ou dentro de uma proibida: o ArduPilot não deixa armar assim.')}</div>}

        <div className="brow">
          <button className="btn on" disabled={!connected || !!d || up.state === 'sending' || onVehicle} onClick={() => station.uploadFence()}><Icon.upload />{t('Enviar geocerca')}</button>
          <button className="btn" disabled={!connected} onClick={() => station.send({ cmd: 'fence_download' })}><Icon.download />{t('Ler do veículo')}</button>
          <button className="btn" disabled={fenceIsEmpty(f)} onClick={() => station.clearFenceDraft()}>{t('Apagar áreas')}</button>
        </div>
        {!onVehicle && !station.fenceEdited && station.vehicleFence && <div className="hint">{t('Rascunho diferente do veículo.')}</div>}
        {!onVehicle && station.fenceEdited && (
          <div className="hint">{t('Alterações não enviadas (tracejado no mapa).')} <button className="link" onClick={() => station.fenceFromVehicle()}>{t('Voltar ao que está no veículo')}</button></div>
        )}
        {onVehicle && station.vehicleFence && <div className="hint ok">{t('O veículo tem esta geocerca.')}</div>}
        {up.text && up.state !== 'ok' && <div className={`hint ${up.state === 'error' ? 'crit' : ''}`}>{up.text}</div>}
        {station.params.has('FENCE_ENABLE') && (!enabled || !polyOn) && !fenceIsEmpty(station.vehicleFence) && (
          <div className="warnbox">{!enabled ? t('FENCE_ENABLE está desligado: a geocerca não está valendo.') : t('FENCE_TYPE sem o bit 4: o ArduPilot ignora os polígonos.')}</div>
        )}
      </div>
    </details>
  )
}
