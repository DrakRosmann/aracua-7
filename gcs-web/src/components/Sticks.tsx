// Sticks virtuais e teclado → MANUAL_CONTROL a 10 Hz, só nos modos manuais.

import { useEffect, useRef, useState } from 'react'
import { station, useChannels } from '../lib/store'
import { MANUAL_MODES, vehicleClass } from '../types'
import { t as tr } from '../lib/i18n'

type Axis = { x: number; y: number }
const KEYS = ['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']

function Stick({ label, onMove, value }: { label: string; onMove: (a: Axis) => void; value: Axis }) {
  const el = useRef<HTMLDivElement>(null)
  const active = useRef(false)
  const move = (e: React.PointerEvent) => {
    const r = el.current!.getBoundingClientRect()
    let x = ((e.clientX - r.left) / r.width) * 2 - 1
    let y = -(((e.clientY - r.top) / r.height) * 2 - 1)
    const m = Math.hypot(x, y)
    if (m > 1) { x /= m; y /= m }
    onMove({ x, y })
  }
  const end = () => { active.current = false; onMove({ x: 0, y: 0 }) }
  const r = 38
  return (
    <div className="stickw">
      <div
        ref={el}
        className="stick"
        onPointerDown={(e) => { active.current = true; el.current!.setPointerCapture(e.pointerId); move(e) }}
        onPointerMove={(e) => active.current && move(e)}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <div className="knob" style={{ transform: `translate(${value.x * r}px, ${-value.y * r}px)` }} />
      </div>
      <span>{label} <b>{value.y.toFixed(2)} / {value.x.toFixed(2)}</b></span>
    </div>
  )
}

export function Sticks() {
  useChannels('telemetry')
  const [left, setLeft] = useState<Axis>({ x: 0, y: 0 })
  const [right, setRight] = useState<Axis>({ x: 0, y: 0 })
  const keys = useRef<Record<string, boolean>>({})
  const [enabled, setEnabled] = useState(false)
  const t = station.telem
  const manual = !!t?.armed && MANUAL_MODES[vehicleClass(t)].has(t.mode)

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
      if (KEYS.includes(k)) { keys.current[k] = true; e.preventDefault() }
    }
    const up = (e: KeyboardEvent) => { keys.current[e.key.length === 1 ? e.key.toLowerCase() : e.key] = false }
    const blur = () => { keys.current = {} }
    addEventListener('keydown', down)
    addEventListener('keyup', up)
    addEventListener('blur', blur)
    return () => { removeEventListener('keydown', down); removeEventListener('keyup', up); removeEventListener('blur', blur) }
  }, [])

  const state = useRef({ left, right })
  state.current = { left, right }
  useEffect(() => {
    if (!enabled) return
    const id = setInterval(() => {
      const t = station.telem
      // O controle de videogame, quando está comandando, tem a vez.
      if (!t?.armed || !MANUAL_MODES[vehicleClass(t)].has(t.mode) || station.padActive) return
      const k = keys.current
      const kv = (a: string, b: string) => (k[a] ? 1 : 0) - (k[b] ? 1 : 0)
      const { left: L, right: R } = state.current
      const thr = Math.abs(L.y) > 0.02 ? L.y : kv('w', 's')
      const yaw = Math.abs(L.x) > 0.02 ? L.x : kv('d', 'a')
      const pit = Math.abs(R.y) > 0.02 ? R.y : kv('ArrowUp', 'ArrowDown')
      const rol = Math.abs(R.x) > 0.02 ? R.x : kv('ArrowRight', 'ArrowLeft')
      // MANUAL_CONTROL: x = arfagem (frente +), y = rolagem, z = acelerador 0…1 (0,5 = manter), r = guinada
      station.send({ cmd: 'manual', x: pit, y: rol, z: 0.5 + thr / 2, r: yaw }, true)
    }, 100)
    return () => clearInterval(id)
  }, [enabled])

  return (
    <>
      <label className="tog"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> {tr('Controle virtual ativo')}</label>
      <div className="hint">
        {!enabled ? tr('Ligue para comandar pelos sticks ou pelo teclado. O rádio controle físico continua tendo prioridade.')
          : manual ? tr('Enviando comandos: W/S sobe e desce, A/D gira, setas movem.')
          : tr('Os comandos só valem armado em Posição, PosHold, Altitude ou Estabilizado.')}
      </div>
      <div className="sticks" aria-disabled={!enabled}>
        <Stick label={tr('Acel./Guinada')} value={left} onMove={setLeft} />
        <Stick label={tr('Arfagem/Rolagem')} value={right} onMove={setRight} />
      </div>
    </>
  )
}
