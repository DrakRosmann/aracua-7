// Controle de videogame: estado no painel Pilotagem da tela de voo e a página
// Configurar → Controle (eixos, botões, acelerador, modos e teste ao vivo).

import { useEffect, useState } from 'react'
import { station, useChannels } from '../lib/store'
import {
  ACTION_LABEL, AXIS_NAMES, axisValue, BUTTON_NAMES, DEFAULT_PAD, effectiveThrottle, MODE1, MODE2,
  type AxisMap, type PadAction, type PadSettings, type ThrottleMode,
} from '../lib/gamepad'
import { MANUAL_MODES, MODES_BY_CLASS, classLabel, modeLabel, vehicleClass } from '../types'
import { num, t as tr, tk } from '../lib/i18n'

const short = (id: string) => id.replace(/\s*\(.*?Vendor: \w+.*?\)/i, '').replace(/\s+/g, ' ').trim()

/** Barra de −1…1 (ou 0…1) com o valor. */
function Meter({ v, unsigned = false }: { v: number; unsigned?: boolean }) {
  const left = unsigned ? 0 : Math.min(50, 50 + v * 50)
  const width = unsigned ? v * 100 : Math.abs(v) * 50
  return <span className={`padm ${unsigned ? 'u' : ''}`}><i style={{ left: `${left}%`, width: `${width}%` }} /></span>
}

export function PadStatus() {
  useChannels('pad', 'telemetry', 'ui')
  const s = station.settings.gamepad
  const p = station.pad
  const t = station.telem
  const cls = vehicleClass(t)
  const o = station.padOut
  const toggle = (enabled: boolean) => station.saveSettings({ gamepad: { ...s, enabled } })
  const state = !p ? tr('Nenhum controle. Conecte (USB ou Bluetooth) e aperte um botão.')
    : !s.enabled ? tr('Controle encontrado; ligue para pilotar com ele.')
    : station.padActive ? tr('Comandando o veículo.')
    : !t?.armed ? tr('Pronto. Segure Start 1,5 s para armar (num modo manual).')
    : !MANUAL_MODES[cls].has(t.mode) ? tr('Pronto; os sticks só valem nos modos manuais.')
    : tr('Pronto.')
  return (
    <div className={`padst ${station.padActive ? 'on' : ''}`}>
      <label className="tog"><input type="checkbox" checked={s.enabled} onChange={(e) => toggle(e.target.checked)} /> {tr('Usar controle de videogame')}</label>
      <div className="hint">{p && <b>{short(p.id)} · </b>}{state}</div>
      {station.padHold && (
        <div className="padhold">{tr(ACTION_LABEL[station.padHold.action])}<Meter v={station.padHold.pct} unsigned /></div>
      )}
      {o && s.enabled && (
        <div className="padout">
          <span>{tr('Acel.')}<Meter v={o.z} unsigned /></span>
          <span>{tr('Guinada')}<Meter v={o.r} /></span>
          <span>{tr('Arfagem')}<Meter v={o.x} /></span>
          <span>{tr('Rolagem')}<Meter v={o.y} /></span>
        </div>
      )}
    </div>
  )
}

// ---------- Configurar → Controle ----------

const FUNCS: [keyof PadSettings['axes'], string, string][] = [
  ['throttle', tk('Acelerador'), tk('empurre o stick do acelerador para cima')],
  ['yaw', tk('Guinada'), tk('empurre o stick da guinada para a direita')],
  ['pitch', tk('Arfagem'), tk('empurre o stick da arfagem para a frente (cima)')],
  ['roll', tk('Rolagem'), tk('empurre o stick da rolagem para a direita')],
]
const THROTTLE: [ThrottleMode, string][] = [
  ['auto', tk('Automático: incremental no avião, centrado nos demais')],
  ['center', tk('Centrado: stick no meio mantém (multirrotor segura a altitude)')],
  ['incremental', tk('Incremental: o stick sobe e desce o acelerador, que fica onde parou')],
  ['triggers', tk('Gatilhos: RT sobe e LT desce (no avião, RT é o acelerador)')],
]
const THROTTLE_NOW: Record<Exclude<ThrottleMode, 'auto'>, string> = { center: tk('centrado'), incremental: tk('incremental'), triggers: tk('gatilhos') }
const ACTIONS = Object.keys(ACTION_LABEL) as PadAction[]

export function PadSetup() {
  useChannels('pad', 'ui', 'telemetry')
  const saved = station.settings.gamepad
  const [d, setD] = useState<PadSettings>(saved)
  const [detect, setDetect] = useState<{ fn: keyof PadSettings['axes']; base: number[] } | null>(null)
  const p = station.pad
  const cls = vehicleClass(station.telem)
  const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads().filter((g): g is Gamepad => !!g) : []
  const nAxes = Math.max(4, p?.axes.length ?? 0)
  const nButtons = Math.max(17, p?.buttons.length ?? 0)

  // Detectar eixo: o primeiro que se mexer bastante desde o clique, com o sentido do movimento.
  useEffect(() => {
    if (!detect) return
    const off = station.subscribe('pad', () => {
      const ax = station.pad?.axes
      if (!ax) return
      const moved = ax.map((v, i) => v - (detect.base[i] ?? 0)).findIndex((dv) => Math.abs(dv) > 0.6)
      if (moved < 0) return
      const dv = ax[moved] - (detect.base[moved] ?? 0)
      setD((cur) => ({ ...cur, axes: { ...cur.axes, [detect.fn]: { axis: moved, invert: dv < 0 } } }))
      setDetect(null)
    })
    return () => { off() }
  }, [detect])

  const setAxis = (fn: keyof PadSettings['axes'], m: Partial<AxisMap>) => setD({ ...d, axes: { ...d.axes, [fn]: { ...d.axes[fn], ...m } } })
  const setMode = (i: number, m: string) => {
    const cur = [...d.modes[cls]] as [string, string, string]
    cur[i] = m
    setD({ ...d, modes: { ...d.modes, [cls]: cur } })
  }
  const dirty = JSON.stringify(d) !== JSON.stringify(saved)
  const btnName = (i: number) => (p && p.mapping !== 'standard' ? tr('Botão {n}', { n: i }) : BUTTON_NAMES[i] ? tr(BUTTON_NAMES[i]) : tr('Botão {n}', { n: i }))
  const axisName = (i: number) => (p && p.mapping !== 'standard' ? tr('Eixo {n}', { n: i }) : AXIS_NAMES[i] ? tr(AXIS_NAMES[i]) : tr('Eixo {n}', { n: i }))

  return (
    <>
      <h2>{tr('Controle')}</h2>
      <p className="desc">{tr('Pilote com um controle de Xbox, 8BitDo, PlayStation ou similar, por USB ou Bluetooth. Os sticks viram MANUAL_CONTROL nos modos manuais e os botões disparam ações. Fica salvo neste computador.')}</p>

      <div className="card"><h3>{tr('Dispositivo')}</h3>
        <div className="field">
          <label htmlFor="pad_dev">{tr('Controle')}<small>{p ? (p.mapping === 'standard' ? tr('layout padrão reconhecido') : tr('layout desconhecido: confira os eixos e botões abaixo')) : tr('nenhum: conecte e aperte um botão com esta janela em foco')}</small></label>
          <div className="fin">
            <select id="pad_dev" value={d.id} onChange={(e) => setD({ ...d, id: e.target.value })}>
              <option value="">{tr('O primeiro conectado')}</option>
              {pads.map((g) => <option key={g.index} value={g.id}>{short(g.id)}</option>)}
              {d.id && !pads.some((g) => g.id === d.id) && <option value={d.id}>{short(d.id)} ({tr('desconectado')})</option>}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="pad_on">{tr('Usar controle de videogame')}<small>{tr('também liga e desliga na tela de voo, em Pilotagem')}</small></label>
          <div className="fin"><input id="pad_on" type="checkbox" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} /></div>
        </div>
        <p className="desc">{tr('8BitDo: use o modo X-input (Xbox) ou Switch para o layout padrão; no modo D-input os eixos podem vir trocados, use Detectar.')}</p>
      </div>

      <div className="card"><h3>{tr('Sticks')}</h3>
        <div className="brow" style={{ marginBottom: 10 }}>
          <button className="btn" onClick={() => setD({ ...d, axes: MODE2 })}>{tr('Modo 2 (acelerador à esquerda)')}</button>
          <button className="btn" onClick={() => setD({ ...d, axes: MODE1 })}>{tr('Modo 1 (acelerador à direita)')}</button>
        </div>
        <table className="padtab">
          <thead><tr><th>{tr('Função')}</th><th>{tr('Eixo')}</th><th>{tr('Inverter')}</th><th>{tr('Saída')}</th><th /></tr></thead>
          <tbody>
            {FUNCS.map(([fn, label, how]) => (
              <tr key={fn}>
                <th>{tr(label)}</th>
                <td>
                  <select aria-label={`${tr(label)} · ${tr('Eixo')}`} value={d.axes[fn].axis} onChange={(e) => setAxis(fn, { axis: +e.target.value })}>
                    {Array.from({ length: nAxes }, (_, i) => <option key={i} value={i}>{axisName(i)}</option>)}
                  </select>
                </td>
                <td><input type="checkbox" aria-label={`${tr(label)} · ${tr('Inverter')}`} checked={d.axes[fn].invert} onChange={(e) => setAxis(fn, { invert: e.target.checked })} /></td>
                <td>{p ? <Meter v={axisValue(p, d.axes[fn], d)} /> : '—'}</td>
                <td>
                  <button className={`btn ${detect?.fn === fn ? 'on' : ''}`} disabled={!p} title={tr(how)}
                    onClick={() => setDetect(detect?.fn === fn ? null : { fn, base: [...(p?.axes ?? [])] })}>
                    {detect?.fn === fn ? tr(how) : tr('Detectar')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="field">
          <label htmlFor="pad_dz">{tr('Zona morta')}<small>{tr('ignora o stick perto do centro (folga do controle)')}</small></label>
          <div className="fin"><input id="pad_dz" type="range" min={0} max={0.3} step={0.01} value={d.deadzone} onChange={(e) => setD({ ...d, deadzone: +e.target.value })} /><b>{num(d.deadzone * 100, 0)} %</b></div>
        </div>
        <div className="field">
          <label htmlFor="pad_expo">{tr('Expo')}<small>{tr('mais precisão perto do centro, mesma força no fim do curso')}</small></label>
          <div className="fin"><input id="pad_expo" type="range" min={0} max={1} step={0.05} value={d.expo} onChange={(e) => setD({ ...d, expo: +e.target.value })} /><b>{num(d.expo * 100, 0)} %</b></div>
        </div>
        <div className="field">
          <label htmlFor="pad_thr">{tr('Acelerador')}<small>{tr('agora, para {cls}: {m}', { cls: classLabel(cls), m: tr(THROTTLE_NOW[effectiveThrottle(d, cls)]) })}</small></label>
          <div className="fin">
            <select id="pad_thr" value={d.throttleMode} onChange={(e) => setD({ ...d, throttleMode: e.target.value as ThrottleMode })}>
              {THROTTLE.map(([k, l]) => <option key={k} value={k}>{tr(l)}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div className="card"><h3>{tr('Botões')}</h3>
        <p className="desc">{tr('Aperte um botão para ver qual é. Armar exige segurar 1,5 s; em voo o controle não desarma.')}</p>
        <div className="padbtns">
          {Array.from({ length: nButtons }, (_, i) => (
            <label key={i} className={p?.buttons[i]?.pressed ? 'hit' : ''}>
              <span>{btnName(i)}</span>
              <select value={d.buttons[i] ?? 'none'} onChange={(e) => setD({ ...d, buttons: { ...d.buttons, [i]: e.target.value as PadAction } })}>
                {ACTIONS.map((a) => <option key={a} value={a}>{a.startsWith('mode') && d.modes[cls]?.[+a.slice(4) - 1] ? `${tr(ACTION_LABEL[a])}: ${modeLabel(d.modes[cls][+a.slice(4) - 1], cls)}` : tr(ACTION_LABEL[a])}</option>)}
              </select>
            </label>
          ))}
        </div>
      </div>

      <div className="card"><h3>{tr('Modos dos botões · {cls}', { cls: classLabel(cls) })}</h3>
        {[0, 1, 2].map((i) => (
          <div className="field" key={i}>
            <label htmlFor={`pad_m${i}`}>{tr(ACTION_LABEL[`mode${i + 1}` as PadAction])}</label>
            <div className="fin">
              <select id={`pad_m${i}`} value={d.modes[cls]?.[i] ?? ''} onChange={(e) => setMode(i, e.target.value)}>
                <option value="">{tr('— nada —')}</option>
                {MODES_BY_CLASS[cls].map((m) => <option key={m} value={m}>{modeLabel(m, cls)} ({m})</option>)}
              </select>
            </div>
          </div>
        ))}
      </div>

      <div className="brow" style={{ marginTop: 14 }}>
        <button className="btn on" disabled={!dirty} onClick={() => station.saveSettings({ gamepad: d })}>{tr('Salvar')}</button>
        <button className="btn" disabled={!dirty} onClick={() => setD(saved)}>{tr('Descartar')}</button>
        <button className="btn" onClick={() => setD({ ...DEFAULT_PAD, enabled: d.enabled, id: d.id })}>{tr('Padrão')}</button>
      </div>

      <div className="card"><h3>{tr('Segurança')}</h3>
        <p className="desc">{tr('Os sticks só comandam com o veículo armado num modo manual; o rádio controle, se houver, continua tendo prioridade. Se a janela perder o foco, a estação manda sticks neutros (o multirrotor segura a posição) até ela voltar. Se o controle desconectar, manda sticks neutros por 1 s e para: depois de RC_OVERRIDE_TIME o veículo volta ao rádio ou entra no failsafe configurado. Erros vibram o controle.')}</p>
      </div>
    </>
  )
}
