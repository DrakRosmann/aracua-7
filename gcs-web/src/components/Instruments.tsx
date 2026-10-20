// Instrumentos circulares: atitude + altitude, velocímetro, bússola e radar LiDAR.
// Desenham em canvas a cada quadro, lendo a telemetria mais recente sem re-render.

import { station } from '../lib/store'
import { useCanvasLoop } from '../lib/canvas'
import type { Telemetry } from '../types'
import { t as tr } from '../lib/i18n'
import { soundSpeed } from '../lib/navlog'

const DEG = Math.PI / 180
/** Ciano dos valores selecionados no piloto automático (como no avião). */
const SEL = '#36c9f0'
const F = (w: number, s: number) => `${w} ${Math.round(s)}px Roboto, system-ui, sans-serif`


function drawAttitude(ctx: CanvasRenderingContext2D, w: number, h: number, t: Telemetry | null) {
  const alt = t?.alt_rel ?? 0, roll = t?.roll ?? 0, pitch = t?.pitch ?? 0
  const R = h / 2 - 9, cx = w - h / 2, cy = h / 2, tw = w - h, k = h / 150
  const span = 20, ppm = (h - 44 * k) / (2 * span), tx = tw - 14
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 1.3
  for (let v = Math.ceil((alt - span) / 2) * 2; v <= alt + span; v += 2) {
    const y = cy - (v - alt) * ppm, l = v % 10 === 0 ? 12 : 6
    ctx.beginPath(); ctx.moveTo(tx, y); ctx.lineTo(tx - l, y); ctx.stroke()
  }
  // ALT SEL na fita (preso na borda quando fora da escala).
  const ap = t?.ap
  if (ap) {
    const ys = Math.max(10 * k, Math.min(h - 10 * k, cy - (ap.alt_sel - alt) * ppm))
    ctx.fillStyle = SEL; ctx.globalAlpha = ap.engaged ? 1 : 0.55
    ctx.beginPath(); ctx.moveTo(tx + 1, ys); ctx.lineTo(tx + 9, ys - 6); ctx.lineTo(tx + 9, ys + 6); ctx.closePath(); ctx.fill()
    ctx.globalAlpha = 1
  }
  ctx.fillStyle = '#fff'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
  ctx.font = F(400, 11 * k)
  ctx.fillText(`${Math.round(alt + span)} m`, tx - 18, 18 * k)
  ctx.fillText(`${Math.round(alt - span)} m`, tx - 18, h - 18 * k)
  ctx.font = F(400, (Math.abs(alt) >= 10_000 ? 23 : 30) * k); ctx.fillText(alt.toFixed(0), tx - 34 * k, cy + 1)
  ctx.font = F(400, 11 * k); ctx.fillText('m', tx - 20 * k, cy + 6 * k)
  // horizonte
  ctx.save()
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.clip()
  ctx.translate(cx, cy); ctx.rotate(-roll * DEG)
  const ppd = R / 30, off = pitch * ppd
  ctx.fillStyle = '#3a8ee6'; ctx.fillRect(-R * 2, -R * 3 + off, R * 4, R * 3)
  ctx.fillStyle = '#5fb832'; ctx.fillRect(-R * 2, off, R * 4, R * 3)
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6
  ctx.beginPath(); ctx.moveTo(-R * 2, off); ctx.lineTo(R * 2, off); ctx.stroke()
  ctx.lineWidth = 1.3; ctx.font = F(400, 10 * k); ctx.fillStyle = '#fff'
  for (const p of [-20, -10, 10, 20]) {
    const y = off - p * ppd, L = R * 0.36
    ctx.beginPath(); ctx.moveTo(-L, y); ctx.lineTo(L, y); ctx.stroke()
    ctx.textAlign = 'right'; ctx.fillText(String(p), -L - 4, y)
    ctx.textAlign = 'left'; ctx.fillText(String(p), L + 4, y)
  }
  for (const p of [-15, -5, 5, 15]) {
    const y = off - p * ppd, L = R * 0.14
    ctx.beginPath(); ctx.moveTo(-L, y); ctx.lineTo(L, y); ctx.stroke()
  }
  ctx.restore()
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.4
  for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
    const th = (-90 + a) * DEG, l = a % 30 === 0 ? 8 : 5
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(th) * R, cy + Math.sin(th) * R); ctx.lineTo(cx + Math.cos(th) * (R - l), cy + Math.sin(th) * (R - l)); ctx.stroke()
  }
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(-roll * DEG)
  ctx.fillStyle = '#ef4a3c'; ctx.beginPath(); ctx.moveTo(0, -R + 10); ctx.lineTo(-6, -R); ctx.lineTo(6, -R); ctx.closePath(); ctx.fill()
  ctx.restore()
  ctx.strokeStyle = '#f5b43a'; ctx.lineWidth = 3.5; ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(cx - R * 0.55, cy); ctx.lineTo(cx - R * 0.2, cy); ctx.lineTo(cx - R * 0.12, cy + 6)
  ctx.moveTo(cx + R * 0.55, cy); ctx.lineTo(cx + R * 0.2, cy); ctx.lineTo(cx + R * 0.12, cy + 6)
  ctx.stroke(); ctx.lineCap = 'butt'
  ctx.fillStyle = '#f5b43a'; ctx.beginPath(); ctx.arc(cx, cy, 3, 0, 7); ctx.fill()
  ctx.strokeStyle = '#16181c'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(cx, cy, R + 1, 0, 7); ctx.stroke()
}

/** Fundos de escala do velocímetro (km/h): do multirrotor ao hipersônico. */
const SPEED_SCALES = [80, 200, 400, 1000, 2500, 8000]

/** Escala que cabe a velocidade atual e a de cruzeiro do avião, com folga. */
export function speedScale(kmh: number, cruiseKmh = 0): number {
  const need = Math.max(kmh * 1.05, cruiseKmh * 1.25)
  return SPEED_SCALES.find((s) => s >= need) ?? SPEED_SCALES.at(-1)!
}

function drawSpeed(ctx: CanvasRenderingContext2D, w: number, h: number, t: Telemetry | null) {
  const cx = w / 2, cy = h / 2, R = w / 2 - 6, k = w / 150
  const kmh = (t?.groundspeed ?? 0) * 3.6
  const S = speedScale(kmh, (station.params.get('AIRSPEED_CRUISE') ?? 0) * 3.6)
  const A = (v: number) => (135 + (Math.max(0, Math.min(S, v)) / S) * 270) * DEG
  for (let i = 0; i < 60; i++) {
    const tt = i / 60
    const c = tt < 0.5 ? [47 + tt * 2 * 198, 207 - tt * 2 * 27, 95 - tt * 2 * 37] : [245 - (tt - 0.5) * 2 * 6, 180 - (tt - 0.5) * 2 * 106, 58]
    ctx.strokeStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`
    ctx.lineWidth = 5 * k
    ctx.beginPath(); ctx.arc(cx, cy, R - 3 * k, A(tt * S), A(((i + 1) / 60) * S) + 0.01); ctx.stroke()
  }
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.3; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.font = F(400, 11 * k)
  const step = S / 16
  for (let i = 0; i <= 16; i++) {
    const v = i * step, a = A(v), l = i % 2 === 0 ? 9 * k : 5 * k
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * (R - 9 * k), cy + Math.sin(a) * (R - 9 * k)); ctx.lineTo(cx + Math.cos(a) * (R - 9 * k - l), cy + Math.sin(a) * (R - 9 * k - l)); ctx.stroke()
    if (i % 2 === 0 && k > 0.8) ctx.fillText(v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : String(Math.round(v)), cx + Math.cos(a) * (R - 30 * k), cy + Math.sin(a) * (R - 30 * k))
  }
  const a = A(kmh)
  ctx.strokeStyle = '#3a78f2'; ctx.lineWidth = 3
  ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * (R - 40 * k), cy + Math.sin(a) * (R - 40 * k)); ctx.lineTo(cx + Math.cos(a) * (R - 8 * k), cy + Math.sin(a) * (R - 8 * k)); ctx.stroke()
  ctx.fillStyle = '#fff'; ctx.font = F(400, (kmh >= 1000 ? 23 : 28) * k); ctx.fillText(String(Math.round(kmh)), cx, cy + 2 * k)
  // Perto do som e acima dele, o Mach (velocidade no ar sobre a do som na altitude).
  const mach = t ? t.airspeed / soundSpeed(t.alt_msl) : 0
  ctx.font = F(500, 10 * k); ctx.fillText(mach >= 0.5 ? `KM / H · M${mach.toFixed(2)}` : 'KM / H', cx, cy + R * 0.62)
}

function drawCompass(ctx: CanvasRenderingContext2D, w: number, h: number, t: Telemetry | null) {
  const cx = w / 2, cy = h / 2, R = w / 2 - 6, hdg = t?.heading ?? 0
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5
  for (let d = 0; d < 360; d += 10) {
    const a = (d - hdg - 90) * DEG, l = d % 30 === 0 ? 12 : 6
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * (R - 2), cy + Math.sin(a) * (R - 2)); ctx.lineTo(cx + Math.cos(a) * (R - 2 - l), cy + Math.sin(a) * (R - 2 - l)); ctx.stroke()
  }
  ctx.font = F(500, 12); ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  for (const [d, l] of [[0, 'N'], [90, 'L'], [180, 'S'], [270, 'O']] as const) {
    const a = (d - hdg - 90) * DEG
    ctx.fillText(l, cx + Math.cos(a) * (R - 26), cy + Math.sin(a) * (R - 26))
  }
  // Marcador do rumo selecionado (HDG SEL).
  const ap = t?.ap
  if (ap) {
    const a = (ap.hdg - hdg - 90) * DEG
    ctx.save(); ctx.translate(cx + Math.cos(a) * (R - 3), cy + Math.sin(a) * (R - 3)); ctx.rotate(a + Math.PI / 2)
    ctx.fillStyle = SEL; ctx.globalAlpha = ap.engaged && ap.lateral === 'hdg' ? 1 : 0.55
    ctx.beginPath(); ctx.moveTo(-8, 0); ctx.lineTo(8, 0); ctx.lineTo(8, 8); ctx.lineTo(3, 8); ctx.lineTo(0, 4); ctx.lineTo(-3, 8); ctx.lineTo(-8, 8); ctx.closePath(); ctx.fill()
    ctx.restore()
  }
  ctx.fillStyle = '#ef4a3c'; ctx.beginPath(); ctx.moveTo(cx, cy - R + 10); ctx.lineTo(cx - 6, cy - R); ctx.lineTo(cx + 6, cy - R); ctx.closePath(); ctx.fill()
  ctx.fillStyle = '#fff'; ctx.font = F(400, 26); ctx.fillText(`${Math.round(hdg) % 360}°`, cx + 2, cy + 1)
  if (ap?.engaged && ap.lateral === 'hdg') { ctx.fillStyle = SEL; ctx.font = F(500, 11); ctx.fillText(`HDG ${String(Math.round(ap.hdg) % 360).padStart(3, '0')}`, cx, cy + 24) }
}

function drawRadar(ctx: CanvasRenderingContext2D, w: number, h: number, t: Telemetry | null) {
  const cx = w / 2, cy = h / 2, R = w / 2 - 8, range = 30, s = R / range
  ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 1
  for (const r of [10, 20, 30]) { ctx.beginPath(); ctx.arc(cx, cy, r * s, 0, 7); ctx.stroke() }
  const sec = station.sectors
  if (sec) {
    const inc = station.sectorInc * DEG
    for (let i = 0; i < sec.length; i++) {
      const d = sec[i]
      if (!Number.isFinite(d) || d > range) continue
      const a = i * inc - Math.PI / 2
      ctx.fillStyle = d < 6 ? 'rgba(239,74,60,0.85)' : d < 12 ? 'rgba(245,180,58,0.75)' : 'rgba(47,207,95,0.55)'
      ctx.beginPath(); ctx.arc(cx, cy, d * s, a - inc / 2, a + inc / 2); ctx.arc(cx, cy, Math.min(R, d * s + 5), a + inc / 2, a - inc / 2, true); ctx.closePath(); ctx.fill()
    }
  }
  const na = -(t?.heading ?? 0) * DEG
  ctx.font = F(500, 11); ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText('N', cx + Math.sin(na) * (R - 12), cy - Math.cos(na) * (R - 12))
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx, cy - 7); ctx.lineTo(cx + 5, cy + 5); ctx.lineTo(cx - 5, cy + 5); ctx.closePath(); ctx.stroke()
  ctx.font = F(500, 9); ctx.fillStyle = '#a2a9b4'
  ctx.fillText(sec ? `LIDAR · ${Number.isFinite(station.nearest) ? station.nearest.toFixed(1) + ' m' : tr('livre')}` : tr('LIDAR · sem dados'), cx, cy + R * 0.55)
}

export function AttitudeTape() {
  return <canvas ref={useCanvasLoop(drawAttitude)} id="cvAtt" aria-label={tr('Atitude e altitude')} />
}
export function Speedometer() {
  return <canvas ref={useCanvasLoop(drawSpeed)} id="cvSpeed" className="dial" aria-label={tr('Velocidade')} />
}
export function Compass() {
  return <canvas ref={useCanvasLoop(drawCompass)} id="cvCompass" className="dial" aria-label={tr('Bússola')} />
}
export function ObstacleRadar() {
  return <canvas ref={useCanvasLoop(drawRadar)} id="cvRadar" className="dial" aria-label={tr('Radar de obstáculos')} />
}
/** Radar de obstáculos ocupando o espaço todo (aba Painel). */
export function RadarScope() {
  return <canvas ref={useCanvasLoop(drawRadar)} className="ck-cv" aria-label={tr('Radar de obstáculos')} />
}
