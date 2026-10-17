// Painel do piloto automático no estilo de avião (MCP): anunciador de modos (FMA)
// em cima e, embaixo, as janelas de SPD, HDG, ALT e V/S com botões de modo.
// Quem voa é a ponte (bridge/src/autopilot.rs); aqui só se escolhe e se mostra.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { station, useChannels } from '../lib/store'
import { num, t as tr } from '../lib/i18n'
import { vehicleClass, type AutopilotPatch, type AutopilotState } from '../types'

const send = (p: AutopilotPatch) => station.send({ cmd: 'autopilot', ...p })
/** Agora (ms); fora do corpo do componente para deixar claro que só compara prazos. */
const now = () => Date.now()
const pad3 = (h: number) => String(Math.round(((h % 360) + 360) % 360)).padStart(3, '0')

/** Janela com valor ajustável: botões −/+, roda do mouse (Shift = passo grande) e digitação. */
function Window({ label, value, fmt, step, big, min, max, wrap, onSet, children }: {
  label: string; value: number; fmt: (v: number) => string; step: number; big: number; min: number; max: number
  wrap?: boolean; onSet: (v: number) => void; children?: ReactNode
}) {
  const [draft, setDraft] = useState<string | null>(null)
  // Valor local enquanto o operador gira: a ponte confirma pela telemetria logo depois.
  const [local, setLocal] = useState<{ v: number; at: number } | null>(null)
  const timer = useRef(0)
  const shown = local && now() - local.at < 1500 ? local.v : value
  const fix = (v: number) => (wrap ? ((v % 360) + 360) % 360 : Math.max(min, Math.min(max, +v.toFixed(2))))
  const nudge = (d: number) => {
    const v = fix(shown + d)
    setLocal({ v, at: Date.now() })
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => onSet(v), 150)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  const commit = () => {
    if (draft !== null && draft.trim() !== '' && Number.isFinite(+draft.replace(',', '.'))) {
      const v = fix(+draft.replace(',', '.'))
      setLocal({ v, at: Date.now() })
      onSet(v)
    }
    setDraft(null)
  }
  return (
    <div className="mcp-w">
      <span className="mcp-l">{label}</span>
      <div className="mcp-knob" onWheel={(e) => { e.preventDefault(); nudge((e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? big : step)) }}>
        <button aria-label={tr('{l} menos', { l: label })} onClick={(e) => nudge(-(e.shiftKey ? big : step))}>−</button>
        {draft === null
          ? <button className="mcp-v" title={tr('Clique para digitar; roda do mouse ajusta (Shift = passo grande)')} onClick={() => setDraft(fmt(shown))}>{fmt(shown)}</button>
          : <input className="mcp-v" autoFocus aria-label={label} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setDraft(null) }} />}
        <button aria-label={tr('{l} mais', { l: label })} onClick={(e) => nudge(e.shiftKey ? big : step)}>+</button>
      </div>
      <div className="mcp-bs">{children}</div>
    </div>
  )
}

function ModeBtn({ on, label, title, disabled, onClick }: { on: boolean; label: string; title: string; disabled?: boolean; onClick: () => void }) {
  return <button className={`mcp-b ${on ? 'on' : ''}`} title={title} disabled={disabled} aria-pressed={on} onClick={onClick}>{label}</button>
}

/** Anunciador de modos: ativos em verde, armados em branco, como no avião. */
function Fma({ ap, wing, off }: { ap: AutopilotState; wing: boolean; off: boolean }) {
  const e = ap.engaged
  const spd = !e ? '' : wing ? (ap.spd_on ? `SPD ${num(ap.spd, 0)}` : tr('CRZ')) : `GS ${num(ap.spd, 1)}`
  const lat = !e ? '' : ap.lateral === 'nav' ? 'NAV' : `HDG ${pad3(ap.hdg)}`
  const vert = !e ? '' : ap.vertical === 'nav' ? 'VNAV' : ap.vertical === 'vs' ? `VS ${ap.alt_sel >= (station.telem?.alt_rel ?? 0) ? '+' : '−'}${num(ap.vs, 1)}` : `ALT ${Math.round(ap.alt_hold)}`
  const armedAlt = e && ap.vertical === 'vs' ? `ALTS ${Math.round(ap.alt_sel)}` : ''
  return (
    <div className="fma" role="status" aria-live="polite">
      <span>{spd}</span>
      <span>{lat}</span>
      <span>{vert}{armedAlt && <em>{armedAlt}</em>}</span>
      <span className={e ? 'ap on' : off ? 'ap off' : 'ap'}>{e ? 'AP' : off ? 'AP OFF' : '—'}</span>
    </div>
  )
}

export function AutopilotPanel() {
  useChannels('telemetry', 'ui')
  const [collapsed, setCollapsed] = useState(false)
  if (!station.apOpen) return null
  const t = station.telem
  const ap = t?.ap
  const cls = vehicleClass(t)
  const wing = cls === 'plane' || cls === 'vtol'
  const on = !!t?.connected && !station.replay
  const canEngage = on && !!t?.armed && (t?.alt_rel ?? 0) > 2 && cls !== 'rover'
  const off = !!ap && !ap.engaged && !!ap.message && now() - station.apOffAt < 6000
  return (
    <aside className={`mcp ${collapsed ? 'collapsed' : ''} ${ap?.engaged ? 'engaged' : ''} ${off ? 'alarm' : ''}`} aria-label={tr('Piloto automático')}>
      <button className="rp-h" onClick={() => setCollapsed(!collapsed)}>
        <span className="mcp-chev">▴</span>{tr('Piloto automático')}
        {ap && <Fma ap={ap} wing={wing} off={off} />}
      </button>
      {!collapsed && (
        !ap ? <p className="mcp-empty">{on ? tr('A ponte não tem piloto automático (atualize o aracua-bridge).') : tr('Sem veículo conectado.')}</p> : (
          <div className="mcp-face">
            <Window label={wing ? 'IAS' : 'GS'} value={ap.spd} fmt={(v) => num(v, wing ? 0 : 1)} step={wing ? 1 : 0.5} big={5} min={0} max={wing ? 60 : 20} onSet={(v) => send({ spd: v })}>
              {wing
                ? <ModeBtn on={ap.spd_on} label="SPD" title={tr('Mantém a velocidade escolhida; desligado, voa na de cruzeiro (AIRSPEED_CRUISE)')} onClick={() => send({ spd_on: !ap.spd_on })} />
                : <span className="mcp-note">{tr('m/s no rumo')}</span>}
            </Window>
            <Window label="HDG" value={ap.hdg} fmt={pad3} step={1} big={10} min={0} max={359} wrap onSet={(v) => send({ hdg: v })}>
              <ModeBtn on={!!ap.engaged && ap.lateral === 'hdg'} label="HDG" title={tr('Voa no rumo selecionado')} disabled={!ap.engaged} onClick={() => send({ lateral: 'hdg' })} />
              <ModeBtn on={false} label="SYNC" title={tr('Rumo selecionado = rumo atual')} disabled={!t} onClick={() => send({ hdg: Math.round(t!.heading) })} />
            </Window>
            <div className="mcp-w nav">
              <span className="mcp-l">NAV</span>
              <ModeBtn on={!!ap.engaged && ap.lateral === 'nav'} label="NAV" title={tr('Segue a missão do veículo (modo AUTO), com as altitudes dela')} disabled={!ap.engaged || !station.vehicleMission?.items.length} onClick={() => send({ lateral: 'nav' })} />
            </div>
            <Window label="ALT" value={ap.alt_sel} fmt={(v) => String(Math.round(v))} step={5} big={50} min={1} max={5000} onSet={(v) => send({ alt: v })}>
              <ModeBtn on={!!ap.engaged && ap.vertical === 'alt'} label="ALT" title={tr('Segura a altitude atual')} disabled={!ap.engaged} onClick={() => send({ vertical: 'alt' })} />
              <ModeBtn on={false} label="SYNC" title={tr('Altitude selecionada = altitude atual')} disabled={!t} onClick={() => send({ alt: Math.max(1, Math.round(t!.alt_rel)) })} />
            </Window>
            <Window label="V/S" value={ap.vs} fmt={(v) => num(v, 1)} step={0.5} big={2} min={0.5} max={wing ? 10 : 5} onSet={(v) => send({ vs: v })}>
              <ModeBtn on={!!ap.engaged && ap.vertical === 'vs'} label="V/S" title={tr('Sobe ou desce até a ALT selecionada nesse ritmo (m/s) e nivela nela')} disabled={!ap.engaged} onClick={() => send({ vertical: 'vs' })} />
            </Window>
            <div className="mcp-w ap">
              <span className="mcp-l">A/P</span>
              <button className={`mcp-ap ${ap.engaged ? 'on' : ''}`} disabled={!ap.engaged && !canEngage}
                title={ap.engaged ? tr('Desliga: o multirrotor segura a posição e o avião circula (LOITER)') : canEngage ? tr('Liga no rumo, altitude e velocidade atuais') : tr('Só em voo: armado e acima de 2 m')}
                onClick={() => send({ engage: !ap.engaged })}>AP<i /></button>
            </div>
          </div>
        )
      )}
      {!collapsed && ap && (
        <p className="mcp-hint">
          {off ? <b>{tr('Desligado: {m}', { m: ap.message ?? '' })}</b>
            : ap.engaged ? (wing ? tr('Avião em GUIDED: rumo, altitude e velocidade pelos comandos GUIDED_CHANGE_* (ArduPlane 4.5+).') : tr('Multirrotor em GUIDED: a ponte manda velocidade e rumo 5 vezes por segundo.'))
            : tr('Os valores podem ser escolhidos antes de ligar. Mudar de modo pelo rádio ou por failsafe desliga o A/P, com aviso.')}
        </p>
      )}
    </aside>
  )
}
