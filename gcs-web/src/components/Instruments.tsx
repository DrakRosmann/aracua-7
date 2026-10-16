// Instrumentos circulares: atitude + altitude, velocímetro, bússola e radar LiDAR.
// Desenham em canvas a cada quadro, lendo a telemetria mais recente sem re-render.

import { useEffect, useRef } from 'react'
import { station } from '../lib/store'
import type { Telemetry } from '../types'

const DEG = Math.PI / 180
const F = (w: number, s: number) => `${w} ${Math.round(s)}px Roboto, system-ui, sans-serif`

function useCanvasLoop(draw: (ctx: CanvasRenderingContext2D, w: number, h: number, t: Telemetry | null) => void) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let raf = 0
    const loop = () => {
      const cv = ref.current
      if (cv && cv.offsetParent !== null) {
        const r = cv.getBoundingClientRect()
        const d = Math.min(2, devicePixelRatio || 1)
        const W = Math.max(1, Math.round(r.width * d)), H = Math.max(1, Math.round(r.height * d))
        if (cv.width !== W || cv.height !== H) {
          cv.width = W
          cv.height = H
        }
        const ctx = cv.getContext('2d')!
        ctx.setTransform(d, 0, 0, d, 0, 0)
        ctx.clearRect(0, 0, r.width, r.height)
        draw(ctx, r.width, r.height, station.telem)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [draw])
  return ref
}

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
  ctx.fillStyle = '#fff'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
  ctx.font = F(400, 11 * k)
  ctx.fillText(`${Math.round(alt + span)} m`, tx - 18, 18 * k)
  ctx.fillText(`${Math.round(alt - span)} m`, tx - 18, h - 18 * k)
  ctx.font = F(400, 30 * k); ctx.fillText(alt.toFixed(0), tx - 34 * k, cy + 1)
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

function drawSpeed(ctx: CanvasRenderingContext2D, w: number, h: number, t: Telemetry | null) {
  const cx = w / 2, cy = h / 2, R = w / 2 - 6, k = w / 150
  const kmh = (t?.groundspeed ?? 0) * 3.6
  const A = (v: number) => (135 + (Math.max(0, Math.min(80, v)) / 80) * 270) * DEG
  for (let i = 0; i < 60; i++) {
    const tt = i / 60
    const c = tt < 0.5 ? [47 + tt * 2 * 198, 207 - tt * 2 * 27, 95 - tt * 2 * 37] : [245 - (tt - 0.5) * 2 * 6, 180 - (tt - 0.5) * 2 * 106, 58]
    ctx.strokeStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`
    ctx.lineWidth = 5 * k
    ctx.beginPath(); ctx.arc(cx, cy, R - 3 * k, A(tt * 80), A(((i + 1) / 60) * 80) + 0.01); ctx.stroke()
  }
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.3; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.font = F(400, 11 * k)
  for (let v = 0; v <= 80; v += 5) {
    const a = A(v), l = v % 10 === 0 ? 9 * k : 5 * k
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * (R - 9 * k), cy + Math.sin(a) * (R - 9 * k)); ctx.lineTo(cx + Math.cos(a) * (R - 9 * k - l), cy + Math.sin(a) * (R - 9 * k - l)); ctx.stroke()
    if (v % 10 === 0 && k > 0.8) ctx.fillText(String(v), cx + Math.cos(a) * (R - 30 * k), cy + Math.sin(a) * (R - 30 * k))
  }
  const a = A(kmh)
  ctx.strokeStyle = '#3a78f2'; ctx.lineWidth = 3
  ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * (R - 40 * k), cy + Math.sin(a) * (R - 40 * k)); ctx.lineTo(cx + Math.cos(a) * (R - 8 * k), cy + Math.sin(a) * (R - 8 * k)); ctx.stroke()
  ctx.fillStyle = '#fff'; ctx.font = F(400, 28 * k); ctx.fillText(String(Math.round(kmh)), cx, cy + 2 * k)
  ctx.font = F(500, 10 * k); ctx.fillText('KM / H', cx, cy + R * 0.62)
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
  ctx.fillStyle = '#ef4a3c'; ctx.beginPath(); ctx.moveTo(cx, cy - R + 10); ctx.lineTo(cx - 6, cy - R); ctx.lineTo(cx + 6, cy - R); ctx.closePath(); ctx.fill()
  ctx.fillStyle = '#fff'; ctx.font = F(400, 26); ctx.fillText(`${Math.round(hdg) % 360}°`, cx + 2, cy + 1)
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
  ctx.fillText(sec ? `LIDAR · ${Number.isFinite(station.nearest) ? station.nearest.toFixed(1) + ' m' : 'livre'}` : 'LIDAR · sem dados', cx, cy + R * 0.55)
}

export function AttitudeTape() {
  return <canvas ref={useCanvasLoop(drawAttitude)} id="cvAtt" aria-label="Atitude e altitude" />
}
export function Speedometer() {
  return <canvas ref={useCanvasLoop(drawSpeed)} id="cvSpeed" className="dial" aria-label="Velocidade" />
}
export function Compass() {
  return <canvas ref={useCanvasLoop(drawCompass)} id="cvCompass" className="dial" aria-label="Bússola" />
}
export function ObstacleRadar() {
  return <canvas ref={useCanvasLoop(drawRadar)} id="cvRadar" className="dial" aria-label="Radar de obstáculos" />
}
