// Combustível: mostrador na tela de voo e na aba Painel e o indicador da barra de cima.
// Faixas do limite "Combustível" de Configurar → Motor (vermelho e amarelo embaixo).

import { station, useChannels } from '../lib/store'
import { useCanvasLoop } from '../lib/canvas'
import { level, limitOf } from '../lib/engine'
import { fmtEte } from '../lib/navlog'
import { Icon } from './Icons'
import { t as tr } from '../lib/i18n'

const DEG = Math.PI / 180
const F = (w: number, s: number) => `${w} ${Math.round(s)}px Roboto, system-ui, sans-serif`
const COLOR = { ok: '#2fcf5f', warn: '#f5b43a', crit: '#ef4a3c', none: '#a2a9b4' }

/** Litros: 146 L, 9,8 kL, 97 kL. */
function fmtLiters(l: number): string {
  if (l >= 10_000) return `${Math.round(l / 1000)} kL`
  if (l >= 1000) return `${(l / 1000).toFixed(1)} kL`
  return `${l.toFixed(l < 10 ? 1 : 0)} L`
}

function fuelLevel(pct: number) {
  return level(pct, limitOf(station.settings.engine, 'fuel'))
}

function drawFuel(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const f = station.fuel()
  const cx = w / 2, cy = h / 2 + h * 0.06, R = Math.min(w, h) / 2 - 6, k = Math.min(w, h) / 150
  // Arco de 240° de E (vazio) a F (cheio), com as faixas.
  const A = (pct: number) => (150 + (Math.max(0, Math.min(100, pct)) / 100) * 240) * DEG
  const lim = limitOf(station.settings.engine, 'fuel')
  const red = lim.redLo ?? 0, yel = lim.yelLo ?? red
  ctx.lineWidth = 7 * k
  for (const [a, b, c] of [[0, red, COLOR.crit], [red, yel, COLOR.warn], [yel, 100, COLOR.ok]] as const) {
    if (b <= a) continue
    ctx.strokeStyle = c
    ctx.beginPath(); ctx.arc(cx, cy, R - 6 * k, A(a), A(b)); ctx.stroke()
  }
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.3; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  for (let p = 0; p <= 100; p += 12.5) {
    const a = A(p), l = p % 25 === 0 ? 9 * k : 5 * k
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * (R - 12 * k), cy + Math.sin(a) * (R - 12 * k)); ctx.lineTo(cx + Math.cos(a) * (R - 12 * k - l), cy + Math.sin(a) * (R - 12 * k - l)); ctx.stroke()
  }
  ctx.font = F(600, 12 * k)
  ctx.fillText('E', cx + Math.cos(A(0)) * (R - 30 * k), cy + Math.sin(A(0)) * (R - 30 * k))
  ctx.fillText('F', cx + Math.cos(A(100)) * (R - 30 * k), cy + Math.sin(A(100)) * (R - 30 * k))
  // Reserva do perfil de longo alcance: um traço ciano no arco.
  if (f?.reservePct != null) {
    const a = A(f.reservePct)
    ctx.strokeStyle = '#36c9f0'; ctx.lineWidth = 3
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * (R - 1 * k), cy + Math.sin(a) * (R - 1 * k)); ctx.lineTo(cx + Math.cos(a) * (R - 16 * k), cy + Math.sin(a) * (R - 16 * k)); ctx.stroke()
  }
  ctx.font = F(500, 9.5 * k); ctx.fillStyle = '#a2a9b4'
  ctx.fillText(tr('COMBUSTÍVEL'), cx, cy - R * 0.42)
  if (!f) {
    ctx.fillStyle = '#a2a9b4'; ctx.font = F(400, 22 * k); ctx.fillText('—', cx, cy + 4 * k)
    return
  }
  const lv = fuelLevel(f.pct)
  const a = A(f.pct)
  ctx.strokeStyle = COLOR[lv]; ctx.lineWidth = 3; ctx.lineCap = 'round'
  ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * (R * 0.22), cy + Math.sin(a) * (R * 0.22)); ctx.lineTo(cx + Math.cos(a) * (R - 10 * k), cy + Math.sin(a) * (R - 10 * k)); ctx.stroke()
  ctx.lineCap = 'butt'
  ctx.fillStyle = lv === 'crit' ? COLOR.crit : '#fff'; ctx.font = F(400, 26 * k)
  ctx.fillText(`${Math.round(f.pct)}%`, cx, cy + 4 * k)
  ctx.fillStyle = '#cfd4db'; ctx.font = F(500, 10.5 * k)
  if (f.liters !== null) ctx.fillText(fmtLiters(f.liters), cx, cy + R * 0.36)
  if (f.endurance !== null) ctx.fillText(fmtEte(f.endurance), cx, cy + R * 0.58)
}

/** Mostrador da tela de voo; só aparece quando há leitura de combustível. */
export function FuelDial() {
  useChannels('telemetry')
  const f = station.fuel()
  const lv = f ? fuelLevel(f.pct) : 'none'
  const title = f ? tr('Combustível {pct}%{l}{e}', {
    pct: Math.round(f.pct),
    l: f.liters !== null ? ` · ${fmtLiters(f.liters)}` : '',
    e: f.endurance !== null ? ` · ${tr('autonomia {t}', { t: fmtEte(f.endurance) })}` : '',
  }) : ''
  if (!f) return null
  return <FuelCanvas id="cvFuel" className={`dial ${lv === 'crit' ? 'fuelcrit' : ''}`} title={title} />
}

function FuelCanvas(p: { id?: string; className: string; title?: string }) {
  return <canvas ref={useCanvasLoop(drawFuel)} {...p} aria-label={tr('Combustível')} />
}

/** Instrumento da aba Painel (ocupa o espaço todo). */
export function FuelGauge() {
  return <FuelCanvas className="ck-cv" />
}

/** Indicador da barra de cima, ao lado da bateria. */
export function FuelStat() {
  useChannels('telemetry')
  const f = station.fuel()
  if (!f) return null
  const lv = fuelLevel(f.pct)
  return (
    <div className={`stat fuel ${lv}`} title={[
      tr('Combustível'), f.liters !== null ? fmtLiters(f.liters) : '', f.flowLph !== null ? `${f.flowLph.toFixed(f.flowLph < 100 ? 1 : 0)} L/h` : '',
      f.endurance !== null ? tr('autonomia {t}', { t: fmtEte(f.endurance) }) : '',
    ].filter(Boolean).join(' · ')}>
      <Icon.fuel />
      <span style={{ fontSize: 14 }}>{Math.round(f.pct)}%</span>
      {f.endurance !== null && <small className="fuel-end">{fmtEte(f.endurance)}</small>}
    </div>
  )
}
