// Controle de videogame (Xbox, 8BitDo, DualShock…) pela Gamepad API: sticks viram
// MANUAL_CONTROL e botões viram ações (armar, RTL, modos, foto, gimbal).
// Funções puras; a leitura periódica e o envio ficam na loja (store.ts).

import { tk } from './i18n'
import type { VehicleClass } from '../types'

export interface AxisMap { axis: number; invert: boolean }

export type PadAction =
  | 'none' | 'arm' | 'rtl' | 'land' | 'pause' | 'photo'
  | 'gimbal_up' | 'gimbal_down' | 'gimbal_center' | 'mode1' | 'mode2' | 'mode3'

/** center: stick no meio = manter (0,5); incremental: o stick move o acelerador, que fica onde parou;
 *  triggers: RT sobe e LT desce (asa fixa: RT é o acelerador); auto: incremental no avião, centrado no resto. */
export type ThrottleMode = 'auto' | 'center' | 'incremental' | 'triggers'

export interface PadSettings {
  enabled: boolean
  /** Controle preferido (id da Gamepad API); vazio = o primeiro conectado. */
  id: string
  throttleMode: ThrottleMode
  deadzone: number
  expo: number
  axes: { throttle: AxisMap; yaw: AxisMap; pitch: AxisMap; roll: AxisMap }
  /** Ação de cada botão, pelo índice da Gamepad API. */
  buttons: Record<string, PadAction>
  /** Modos dos botões mode1…mode3, por tipo de veículo (nomes do firmware). */
  modes: Record<VehicleClass, [string, string, string]>
}

/** Layout "standard" da Gamepad API (Xbox, 8BitDo em X-input): eixo para cima = −1. */
export const MODE2: PadSettings['axes'] = {
  throttle: { axis: 1, invert: true }, yaw: { axis: 0, invert: false },
  pitch: { axis: 3, invert: true }, roll: { axis: 2, invert: false },
}
export const MODE1: PadSettings['axes'] = {
  throttle: { axis: 3, invert: true }, yaw: { axis: 0, invert: false },
  pitch: { axis: 1, invert: true }, roll: { axis: 2, invert: false },
}

export const DEFAULT_PAD: PadSettings = {
  enabled: false,
  id: '',
  throttleMode: 'auto',
  deadzone: 0.08,
  expo: 0.3,
  axes: MODE2,
  buttons: {
    0: 'pause', 1: 'rtl', 2: 'photo', 3: 'mode1', 4: 'mode2', 5: 'mode3',
    8: 'land', 9: 'arm', 12: 'gimbal_up', 13: 'gimbal_down', 14: 'gimbal_center',
  },
  modes: {
    copter: ['ALT_HOLD', 'STABILIZE', 'POSHOLD'],
    heli: ['ALT_HOLD', 'STABILIZE', 'POSHOLD'],
    plane: ['FBWA', 'MANUAL', 'CRUISE'],
    vtol: ['QHOVER', 'FBWA', 'QLOITER'],
    rover: ['MANUAL', 'STEERING', 'ACRO'],
  },
}

/** Nomes dos botões no layout standard (Xbox / 8BitDo). */
export const BUTTON_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View / Select', 'Menu / Start', 'L3', 'R3',
  tk('Direcional ↑'), tk('Direcional ↓'), tk('Direcional ←'), tk('Direcional →'), tk('Guia / Home')]
export const AXIS_NAMES = [tk('Stick esq. ↔'), tk('Stick esq. ↕'), tk('Stick dir. ↔'), tk('Stick dir. ↕')]

export const ACTION_LABEL: Record<PadAction, string> = {
  none: tk('— nada —'),
  arm: tk('Armar / desarmar (segurar 1,5 s)'),
  rtl: tk('Retornar (RTL)'),
  land: tk('Pousar aqui'),
  pause: tk('Pausar / circular'),
  photo: tk('Tirar foto'),
  gimbal_up: tk('Gimbal para cima'),
  gimbal_down: tk('Gimbal para baixo'),
  gimbal_center: tk('Gimbal no horizonte'),
  mode1: tk('Modo 1'),
  mode2: tk('Modo 2'),
  mode3: tk('Modo 3'),
}

/** Ações que exigem segurar o botão (evita armar sem querer). */
export const HOLD_MS: Partial<Record<PadAction, number>> = { arm: 1500 }

/** O que a loja precisa de um Gamepad (permite testar sem navegador). */
export interface PadSnapshot {
  id: string
  index: number
  mapping: string
  connected: boolean
  axes: readonly number[]
  buttons: readonly { pressed: boolean; value: number }[]
}

/** Zona morta reescalada (o stick sai de 0 suave) e expo (mais precisão perto do centro). */
export function shape(v: number, deadzone: number, expo: number): number {
  const a = Math.abs(v)
  if (!Number.isFinite(v) || a <= deadzone) return 0
  const n = Math.min(1, (a - deadzone) / (1 - deadzone))
  return Math.sign(v) * ((1 - expo) * n + expo * n * n * n)
}

export function axisValue(p: PadSnapshot, m: AxisMap, s: PadSettings): number {
  const raw = p.axes[m.axis] ?? 0
  return shape(m.invert ? -raw : raw, s.deadzone, s.expo)
}

export function effectiveThrottle(s: PadSettings, cls: VehicleClass): Exclude<ThrottleMode, 'auto'> {
  return s.throttleMode === 'auto' ? (cls === 'plane' ? 'incremental' : 'center') : s.throttleMode
}

export interface Manual { x: number; y: number; z: number; r: number }

/**
 * Sticks → MANUAL_CONTROL (x = arfagem para a frente +, y = rolagem, z = acelerador 0…1, r = guinada).
 * `held` é o acelerador guardado no modo incremental; devolve o novo.
 */
export function readManual(p: PadSnapshot, s: PadSettings, cls: VehicleClass, held: number, dt: number): { m: Manual; held: number } {
  const thr = axisValue(p, s.axes.throttle, s)
  const mode = effectiveThrottle(s, cls)
  let z: number
  if (mode === 'incremental') {
    // Curso inteiro em ~1,7 s com o stick no fim.
    held = Math.max(0, Math.min(1, held + thr * dt * 0.6))
    z = held
  } else if (mode === 'triggers') {
    const rt = p.buttons[7]?.value ?? 0, lt = p.buttons[6]?.value ?? 0
    z = cls === 'plane' ? rt : 0.5 + (rt - lt) / 2
  } else z = 0.5 + thr / 2
  return {
    m: { x: axisValue(p, s.axes.pitch, s), y: axisValue(p, s.axes.roll, s), z: Math.max(0, Math.min(1, z)), r: axisValue(p, s.axes.yaw, s) },
    held,
  }
}

/** Escolhe o controle: o preferido, se estiver conectado, senão o primeiro. */
export function pickPad(pads: readonly (PadSnapshot | null)[], id: string): PadSnapshot | null {
  const live = pads.filter((p): p is PadSnapshot => !!p && p.connected)
  return live.find((p) => p.id === id) ?? live[0] ?? null
}

/**
 * Bordas dos botões: ação comum dispara ao apertar; as de `HOLD_MS` disparam uma vez
 * quando o botão fica apertado o tempo todo.
 */
export class PadButtons {
  private down = new Map<number, number>()
  private fired = new Set<number>()

  update(pressed: readonly boolean[], map: Record<string, PadAction>, now: number): PadAction[] {
    const out: PadAction[] = []
    pressed.forEach((on, i) => {
      const a = map[i] ?? 'none'
      if (!on) {
        this.down.delete(i)
        this.fired.delete(i)
        return
      }
      if (!this.down.has(i)) this.down.set(i, now)
      if (a === 'none' || this.fired.has(i)) return
      const hold = HOLD_MS[a] ?? 0
      if (now - this.down.get(i)! >= hold) {
        this.fired.add(i)
        out.push(a)
      }
    })
    return out
  }

  /** Andamento (0–1) do botão de segurar mais adiantado, para mostrar na tela. */
  holdProgress(map: Record<string, PadAction>, now: number): { action: PadAction; pct: number } | null {
    let best: { action: PadAction; pct: number } | null = null
    for (const [i, t0] of this.down) {
      const a = map[i] ?? 'none'
      const hold = HOLD_MS[a]
      if (!hold || this.fired.has(i)) continue
      const pct = Math.min(1, (now - t0) / hold)
      if (!best || pct > best.pct) best = { action: a, pct }
    }
    return best
  }

  reset() {
    this.down.clear()
    this.fired.clear()
  }
}
