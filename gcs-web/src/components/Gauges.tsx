// Instrumentos de cabine para a aba Painel: PFD e HSI das telas digitais e os seis
// analógicos clássicos (velocímetro, horizonte, altímetro, curva, giro direcional e
// variômetro). Cada um desenha em canvas no tamanho do espaço onde for colocado.

import { station } from '../lib/store'
import { distance, type LatLon } from '../lib/geo'
import { vehicleClass, type Telemetry } from '../types'
import { useCanvasLoop } from '../lib/canvas'
import { t as tr } from '../lib/i18n'

const DEG = Math.PI / 180
const F = (w: number, s: number) => `${w} ${Math.max(6, Math.round(s))}px Roboto, system-ui, sans-serif`
const MONO = (s: number) => `500 ${Math.max(6, Math.round(s))}px 'Roboto Mono', ui-monospace, monospace`
const C = { sky: '#2f7fd8', ground: '#8a5a2b', white: '#f2f4f7', yellow: '#f5c33a', sel: '#36c9f0', mag: '#e05ad8', green: '#2fcf5f', amber: '#f5b43a', red: '#ef4a3c', tape: 'rgba(10,12,16,0.55)', dim: '#9aa3ae' }
type Draw = (ctx: CanvasRenderingContext2D, w: number, h: number, t: Telemetry | null) => void

const wing = (t: Telemetry | null) => ['plane', 'vtol'].includes(vehicleClass(t))
/** Velocidade que o piloto lê: do ar no avião (se houver sensor), do solo no multirrotor. */
const speedOf = (t: Telemetry | null) => (!t ? 0 : wing(t) && t.airspeed > 0 ? t.airspeed : t.groundspeed)
const pad3 = (h: number) => String(Math.round(((h % 360) + 360) % 360) % 360).padStart(3, '0')
const CARD: Record<number, string> = { 0: 'N', 90: 'L', 180: 'S', 270: 'O' }

function bearing(a: LatLon, b: LatLon): number {
  const φ1 = a.lat * DEG, φ2 = b.lat * DEG, dλ = (b.lon - a.lon) * DEG
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return ((Math.atan2(y, x) / DEG) + 360) % 360
}

const fmtD = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`)

/** Horizonte (céu, terra, escada de arfagem) recortado pela área atual. */
function horizon(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, roll: number, pitch: number, ppd: number, ladderW: number, fs: number) {
  ctx.save()
  ctx.translate(cx, cy); ctx.rotate(-roll * DEG)
  const off = pitch * ppd
  ctx.fillStyle = C.sky; ctx.fillRect(-R * 3, -R * 6 + off, R * 6, R * 6)
  ctx.fillStyle = C.ground; ctx.fillRect(-R * 3, off, R * 6, R * 6)
  ctx.strokeStyle = C.white; ctx.lineWidth = 1.6
  ctx.beginPath(); ctx.moveTo(-R * 3, off); ctx.lineTo(R * 3, off); ctx.stroke()
  ctx.lineWidth = 1.2; ctx.fillStyle = C.white; ctx.font = F(500, fs); ctx.textBaseline = 'middle'
  for (let p = -40; p <= 40; p += 2.5) {
    if (p === 0) continue
    const y = off - p * ppd
    if (Math.abs(y) > R * 1.1) continue
    const major = p % 10 === 0, mid = p % 5 === 0
    const L = major ? ladderW : mid ? ladderW * 0.55 : ladderW * 0.25
    ctx.beginPath(); ctx.moveTo(-L, y); ctx.lineTo(L, y); ctx.stroke()
    if (major) {
      ctx.textAlign = 'right'; ctx.fillText(String(Math.abs(p)), -L - 4, y)
      ctx.textAlign = 'left'; ctx.fillText(String(Math.abs(p)), L + 4, y)
    }
  }
  ctx.restore()
}

/** Escala de rolagem (arco em cima) com o ponteiro que gira com o avião. */
function rollScale(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, roll: number) {
  ctx.strokeStyle = C.white; ctx.fillStyle = C.white; ctx.lineWidth = 1.4
  for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
    const th = (-90 + a) * DEG, l = a % 30 === 0 ? 10 : 6
    if (a === 0) {
      ctx.beginPath(); ctx.moveTo(cx, cy - r); ctx.lineTo(cx - 6, cy - r - 9); ctx.lineTo(cx + 6, cy - r - 9); ctx.closePath(); ctx.fill()
      continue
    }
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(th) * r, cy + Math.sin(th) * r); ctx.lineTo(cx + Math.cos(th) * (r + l), cy + Math.sin(th) * (r + l)); ctx.stroke()
  }
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(-roll * DEG)
  ctx.fillStyle = C.yellow; ctx.beginPath(); ctx.moveTo(0, -r + 1); ctx.lineTo(-7, -r + 11); ctx.lineTo(7, -r + 11); ctx.closePath(); ctx.fill()
  ctx.restore()
}

/** Símbolo do avião (fixo), em amarelo. */
function aircraft(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  ctx.fillStyle = C.yellow; ctx.strokeStyle = '#111'; ctx.lineWidth = 1
  for (const sg of [-1, 1]) {
    ctx.beginPath()
    ctx.moveTo(cx + sg * s * 0.95, cy - 3); ctx.lineTo(cx + sg * s * 0.35, cy - 3); ctx.lineTo(cx + sg * s * 0.35, cy + 9)
    ctx.lineTo(cx + sg * s * 0.25, cy + 9); ctx.lineTo(cx + sg * s * 0.25, cy + 3); ctx.lineTo(cx + sg * s * 0.95, cy + 3); ctx.closePath()
    ctx.fill(); ctx.stroke()
  }
  ctx.fillRect(cx - 3, cy - 3, 6, 6); ctx.strokeRect(cx - 3, cy - 3, 6, 6)
}

/** Fita vertical (velocidade ou altitude) com caixa de leitura no centro. */
function tape(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, v: number, o: {
  span: number; minor: number; major: number; right: boolean; digits: number; label: string; bug?: number | null; bugOn?: boolean; red?: [number, number] | null; floor?: number
}) {
  const cy = y + h / 2, ppu = h / (2 * o.span), fs = Math.max(9, Math.min(15, w * 0.24))
  ctx.save()
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip()
  ctx.fillStyle = C.tape; ctx.fillRect(x, y, w, h)
  if (o.red) {
    const [a, b] = o.red
    const ya = cy - (a - v) * ppu, yb = cy - (b - v) * ppu
    ctx.fillStyle = C.red; ctx.fillRect(o.right ? x : x + w - 6, Math.min(ya, yb), 6, Math.abs(yb - ya))
  }
  ctx.strokeStyle = C.white; ctx.fillStyle = C.white; ctx.lineWidth = 1.2; ctx.font = F(400, fs); ctx.textBaseline = 'middle'
  const start = Math.ceil((v - o.span) / o.minor) * o.minor
  for (let u = start; u <= v + o.span; u += o.minor) {
    if (o.floor !== undefined && u < o.floor) continue
    const yy = cy - (u - v) * ppu, major = Math.abs(u / o.major - Math.round(u / o.major)) < 1e-6
    const l = major ? 10 : 5
    ctx.beginPath()
    if (o.right) { ctx.moveTo(x, yy); ctx.lineTo(x + l, yy) } else { ctx.moveTo(x + w, yy); ctx.lineTo(x + w - l, yy) }
    ctx.stroke()
    if (major) { ctx.textAlign = o.right ? 'left' : 'right'; ctx.fillText(String(Math.round(u)), o.right ? x + 14 : x + w - 14, yy) }
  }
  if (o.bug !== null && o.bug !== undefined) {
    const yb = Math.max(y + 6, Math.min(y + h - 6, cy - (o.bug - v) * ppu))
    ctx.fillStyle = C.sel; ctx.globalAlpha = o.bugOn ? 1 : 0.5
    const bx = o.right ? x : x + w
    const d = o.right ? 1 : -1
    ctx.beginPath(); ctx.moveTo(bx, yb - 7); ctx.lineTo(bx + d * 8, yb - 7); ctx.lineTo(bx + d * 8, yb - 3); ctx.lineTo(bx + d * 4, yb); ctx.lineTo(bx + d * 8, yb + 3); ctx.lineTo(bx + d * 8, yb + 7); ctx.lineTo(bx, yb + 7); ctx.closePath(); ctx.fill()
    ctx.globalAlpha = 1
  }
  ctx.restore()
  // Caixa de leitura.
  const bh = fs * 2.1, bw = w + 6
  const bx = o.right ? x - 6 : x
  ctx.fillStyle = '#000'; ctx.strokeStyle = C.white; ctx.lineWidth = 1.3
  ctx.beginPath(); ctx.rect(bx, cy - bh / 2, bw, bh); ctx.fill(); ctx.stroke()
  ctx.fillStyle = C.white; ctx.font = MONO(fs * 1.3); ctx.textAlign = 'center'
  ctx.fillText(v.toFixed(o.digits), bx + bw / 2, cy + 1)
  ctx.font = F(500, fs * 0.8); ctx.fillStyle = C.dim
  ctx.fillText(o.label, x + w / 2, y - fs * 0.7)
}

/** Faixa de rumo horizontal (embaixo do PFD). */
function headingStrip(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, hdg: number, bug: number | null, bugOn: boolean) {
  const span = 40, ppd = w / (2 * span), cx = x + w / 2, fs = Math.max(9, Math.min(14, h * 0.32))
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip()
  ctx.fillStyle = C.tape; ctx.fillRect(x, y, w, h)
  ctx.strokeStyle = C.white; ctx.fillStyle = C.white; ctx.lineWidth = 1.2; ctx.font = F(500, fs); ctx.textAlign = 'center'; ctx.textBaseline = 'top'
  for (let d = Math.ceil((hdg - span) / 5) * 5; d <= hdg + span; d += 5) {
    const xx = cx + (d - hdg) * ppd, dd = ((d % 360) + 360) % 360
    ctx.beginPath(); ctx.moveTo(xx, y); ctx.lineTo(xx, y + (dd % 10 === 0 ? 9 : 5)); ctx.stroke()
    if (dd % 30 === 0) ctx.fillText(CARD[dd] ?? String(dd / 10), xx, y + 11)
  }
  if (bug !== null) {
    let db = ((bug - hdg + 540) % 360) - 180
    db = Math.max(-span, Math.min(span, db))
    const xb = cx + db * ppd
    ctx.fillStyle = C.sel; ctx.globalAlpha = bugOn ? 1 : 0.5
    ctx.beginPath(); ctx.moveTo(xb - 7, y); ctx.lineTo(xb + 7, y); ctx.lineTo(xb + 7, y + 7); ctx.lineTo(xb + 3, y + 7); ctx.lineTo(xb, y + 3); ctx.lineTo(xb - 3, y + 7); ctx.lineTo(xb - 7, y + 7); ctx.closePath(); ctx.fill()
    ctx.globalAlpha = 1
  }
  ctx.restore()
  ctx.fillStyle = '#000'; ctx.strokeStyle = C.white; ctx.lineWidth = 1.3
  const bw = fs * 3.2, bh = fs * 1.6
  ctx.beginPath(); ctx.rect(cx - bw / 2, y - bh + 2, bw, bh); ctx.fill(); ctx.stroke()
  ctx.fillStyle = C.white; ctx.font = MONO(fs * 1.15); ctx.textBaseline = 'middle'; ctx.textAlign = 'center'
  ctx.fillText(pad3(hdg), cx, y - bh / 2 + 2)
}

/** Valor selecionado (ciano) numa caixa no alto da fita, como no PFD de verdade. */
function selBox(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, text: string) {
  const fs = Math.max(10, Math.min(15, w * 0.24)), h = fs * 1.5
  ctx.fillStyle = '#000'; ctx.fillRect(x, y, w, h)
  ctx.strokeStyle = '#2a2e35'; ctx.lineWidth = 1; ctx.strokeRect(x, y, w, h)
  ctx.fillStyle = C.sel; ctx.font = MONO(fs); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText(text, x + w / 2, y + h / 2 + 1)
}

// ---------- PFD ----------

const drawPFD: Draw = (ctx, w, h, t) => {
  ctx.fillStyle = '#05070a'; ctx.fillRect(0, 0, w, h)
  const ap = t?.ap
  const fmaH = Math.max(18, h * 0.07), hdgH = Math.max(26, h * 0.1)
  const spdW = Math.max(48, w * 0.12), altW = Math.max(56, w * 0.14), vsiW = Math.max(22, w * 0.045)
  const top = fmaH + 22, bottom = h - hdgH - 4
  const ax0 = spdW + 14, ax1 = w - altW - vsiW - 18
  const cx = (ax0 + ax1) / 2, cy = (top + bottom) / 2
  const R = Math.min(ax1 - ax0, bottom - top) / 2
  const roll = t?.roll ?? 0, pitch = t?.pitch ?? 0
  const ppd = (bottom - top) / 50
  // Horizonte ocupa a área central inteira (estilo glass cockpit).
  ctx.save(); ctx.beginPath(); ctx.rect(0, top - 6, w, bottom - top + 12); ctx.clip()
  horizon(ctx, cx, cy, Math.max(w, h), roll, pitch, ppd, R * 0.32, Math.max(9, R * 0.075))
  ctx.restore()
  rollScale(ctx, cx, cy, R * 0.92, roll)
  aircraft(ctx, cx, cy, R * 0.55)
  // Velocidade.
  const v = speedOf(t), isWing = wing(t)
  const stall = station.params.get('AIRSPEED_MIN') ?? null
  tape(ctx, 8, top, spdW, bottom - top, v, {
    span: isWing ? 15 : 8, minor: 1, major: isWing ? 5 : 2, right: false, digits: 1, label: isWing && (t?.airspeed ?? 0) > 0 ? 'IAS m/s' : 'GS m/s',
    bug: ap ? ap.spd : null, bugOn: !!ap?.engaged && (!isWing || ap.spd_on), red: isWing && stall ? [0, stall] : null, floor: 0,
  })
  if (ap && (!isWing || ap.spd_on)) selBox(ctx, 8, top, spdW, ap.spd.toFixed(isWing ? 0 : 1))
  // Altitude e ALT SEL.
  const alt = t?.alt_rel ?? 0
  const ax = w - altW - vsiW - 10
  tape(ctx, ax, top, altW, bottom - top, alt, { span: 25, minor: 1, major: 5, right: true, digits: 1, label: 'ALT m', bug: ap ? ap.alt_sel : null, bugOn: !!ap?.engaged })
  if (ap) selBox(ctx, ax, top, altW, String(Math.round(ap.alt_sel)))
  // Variômetro.
  const vx = w - vsiW - 4, vs = t?.climb ?? 0, vmax = 6
  ctx.fillStyle = C.tape; ctx.fillRect(vx, top, vsiW, bottom - top)
  ctx.strokeStyle = C.white; ctx.fillStyle = C.white; ctx.lineWidth = 1; ctx.font = F(400, Math.max(8, vsiW * 0.38)); ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
  for (const s of [-6, -4, -2, 0, 2, 4, 6]) {
    const yy = cy - (s / vmax) * (bottom - top) / 2 * 0.92
    ctx.beginPath(); ctx.moveTo(vx, yy); ctx.lineTo(vx + (s === 0 ? 8 : 5), yy); ctx.stroke()
    if (s !== 0 && vsiW > 26) ctx.fillText(String(Math.abs(s)), vx + 8, yy)
  }
  const yv = cy - (Math.max(-vmax, Math.min(vmax, vs)) / vmax) * (bottom - top) / 2 * 0.92
  ctx.strokeStyle = C.green; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(vx + vsiW, cy); ctx.lineTo(vx + 2, yv); ctx.stroke()
  ctx.fillStyle = C.green; ctx.font = MONO(Math.max(9, vsiW * 0.42)); ctx.textAlign = 'center'
  ctx.fillText(`${vs >= 0 ? '+' : ''}${vs.toFixed(1)}`, vx + vsiW / 2, vs >= 0 ? top - 10 : bottom + 10)
  // Rumo.
  headingStrip(ctx, ax0, h - hdgH, ax1 - ax0, hdgH - 2, t?.heading ?? 0, ap ? ap.hdg : null, !!ap?.engaged && ap.lateral === 'hdg')
  // FMA: modo do veículo e do piloto automático.
  const cells = ap?.engaged
    ? [(isWing ? (ap.spd_on ? `SPD ${Math.round(ap.spd)}` : 'CRZ') : `GS ${ap.spd.toFixed(1)}`), ap.lateral === 'nav' ? 'NAV' : `HDG ${pad3(ap.hdg)}`, ap.vertical === 'nav' ? 'VNAV' : ap.vertical === 'vs' ? `VS ${ap.vs.toFixed(1)}` : `ALT ${Math.round(ap.alt_hold)}`, 'AP']
    : [t?.mode ?? '—', '', '', t?.armed ? tr('ARMADO') : tr('DESARM.')]
  const cw = w / 4
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, fmaH)
  ctx.font = MONO(fmaH * 0.6); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  cells.forEach((c, i) => {
    ctx.fillStyle = ap?.engaged ? C.green : i === 3 && t?.armed ? C.amber : C.white
    ctx.fillText(c, cw * i + cw / 2, fmaH / 2 + 1)
    if (i) { ctx.strokeStyle = '#2a2e35'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cw * i, 2); ctx.lineTo(cw * i, fmaH - 2); ctx.stroke() }
  })
  if (!t?.connected) { ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, fmaH, w, h - fmaH); ctx.fillStyle = C.amber; ctx.font = F(600, Math.max(12, h * 0.05)); ctx.fillText(tr('SEM DADOS'), w / 2, h / 2) }
}

// ---------- HSI / navegação ----------

function rose(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, hdg: number) {
  ctx.strokeStyle = C.white; ctx.fillStyle = C.white; ctx.lineWidth = 1.4; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  for (let d = 0; d < 360; d += 5) {
    const a = (d - hdg - 90) * DEG, l = d % 10 === 0 ? r * 0.08 : r * 0.04
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); ctx.lineTo(cx + Math.cos(a) * (r - l), cy + Math.sin(a) * (r - l)); ctx.stroke()
    if (d % 30 === 0) {
      ctx.save(); ctx.translate(cx + Math.cos(a) * r * 0.8, cy + Math.sin(a) * r * 0.8); ctx.rotate(a + Math.PI / 2)
      ctx.font = F(CARD[d] ? 700 : 500, r * (CARD[d] ? 0.13 : 0.1)); ctx.fillText(CARD[d] ?? String(d / 10), 0, 0)
      ctx.restore()
    }
  }
}

function hdgBug(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, rel: number, on: boolean) {
  const a = (rel - 90) * DEG
  ctx.save(); ctx.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r); ctx.rotate(a + Math.PI / 2)
  ctx.fillStyle = C.sel; ctx.globalAlpha = on ? 1 : 0.5
  ctx.beginPath(); ctx.moveTo(-9, -2); ctx.lineTo(9, -2); ctx.lineTo(9, 8); ctx.lineTo(4, 8); ctx.lineTo(0, 3); ctx.lineTo(-4, 8); ctx.lineTo(-9, 8); ctx.closePath(); ctx.fill()
  ctx.restore()
}

function pointer(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, rel: number, color: string, double: boolean) {
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(rel * DEG)
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2.2
  const lines = double ? [-4, 4] : [0]
  for (const dx of lines) { ctx.beginPath(); ctx.moveTo(dx, r * 0.62); ctx.lineTo(dx, r * 0.28); ctx.moveTo(dx, -r * 0.28); ctx.lineTo(dx, -r * 0.62); ctx.stroke() }
  ctx.beginPath(); ctx.moveTo(0, -r * 0.7); ctx.lineTo(-8, -r * 0.58); ctx.lineTo(8, -r * 0.58); ctx.closePath(); ctx.fill()
  ctx.restore()
}

const drawND: Draw = (ctx, w, h, t) => {
  ctx.fillStyle = '#05070a'; ctx.fillRect(0, 0, w, h)
  const hdg = t?.heading ?? 0
  const cx = w / 2, cy = h / 2 + h * 0.03, r = Math.min(w, h * 0.92) / 2 - 16
  rose(ctx, cx, cy, r, hdg)
  // Linha de fé e leitura do rumo.
  ctx.fillStyle = C.white; ctx.beginPath(); ctx.moveTo(cx, cy - r + 2); ctx.lineTo(cx - 7, cy - r - 10); ctx.lineTo(cx + 7, cy - r - 10); ctx.closePath(); ctx.fill()
  ctx.fillStyle = '#000'; ctx.strokeStyle = C.white; ctx.lineWidth = 1.3
  const fs = Math.max(11, r * 0.11)
  ctx.beginPath(); ctx.rect(cx - fs * 1.6, cy - r - 12 - fs * 1.4, fs * 3.2, fs * 1.4); ctx.fill(); ctx.stroke()
  ctx.fillStyle = C.white; ctx.font = MONO(fs); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText(pad3(hdg), cx, cy - r - 12 - fs * 0.7)
  const ap = t?.ap
  if (ap) hdgBug(ctx, cx, cy, r, ap.hdg - hdg, ap.engaged && ap.lateral === 'hdg')
  // Ponteiros: próximo waypoint (magenta) e casa (verde, duplo).
  const wi = station.activeWaypoint()
  const wp = wi >= 0 ? station.onVehicle[wi] : null
  const fsS = Math.max(10, Math.min(14, w * 0.03))
  ctx.font = F(500, fsS); ctx.textBaseline = 'top'
  if (t && wp) {
    pointer(ctx, cx, cy, r, bearing(t, wp) - hdg, C.mag, false)
    ctx.fillStyle = C.mag; ctx.textAlign = 'right'
    ctx.fillText(`WP ${String.fromCharCode(65 + wi)} · ${fmtD(distance(t, wp))}`, w - 8, 8)
    const gs = t.groundspeed
    if (gs > 0.5) ctx.fillText(`ETE ${Math.floor(distance(t, wp) / gs / 60)}:${String(Math.round((distance(t, wp) / gs) % 60)).padStart(2, '0')}`, w - 8, 8 + fsS * 1.3)
  }
  if (t?.home && t.connected) {
    const dh = distance(t, t.home)
    if (dh > 2) pointer(ctx, cx, cy, r, bearing(t, t.home) - hdg, C.green, true)
    ctx.fillStyle = C.green; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'
    ctx.fillText(`HOME ${fmtD(dh)}`, 8, h - 8)
  }
  // Trajetória sobre o solo (losango) e o avião no centro.
  if (t && t.groundspeed > 1) {
    const trk = Math.atan2(t.ve, t.vn) / DEG
    const a = (trk - hdg - 90) * DEG
    ctx.fillStyle = C.white
    ctx.save(); ctx.translate(cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.9); ctx.rotate(Math.PI / 4); ctx.fillRect(-4, -4, 8, 8); ctx.restore()
  }
  ctx.strokeStyle = C.yellow; ctx.lineWidth = 3; ctx.lineCap = 'round'
  const s = r * 0.12
  ctx.beginPath(); ctx.moveTo(cx, cy - s); ctx.lineTo(cx, cy + s); ctx.moveTo(cx - s * 0.9, cy - s * 0.1); ctx.lineTo(cx + s * 0.9, cy - s * 0.1); ctx.moveTo(cx - s * 0.4, cy + s * 0.9); ctx.lineTo(cx + s * 0.4, cy + s * 0.9); ctx.stroke()
  ctx.lineCap = 'butt'
  ctx.fillStyle = C.white; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.font = F(500, fsS)
  ctx.fillText(`GS ${(t?.groundspeed ?? 0).toFixed(1)} m/s`, 8, 8)
  if (t && wing(t) && t.airspeed > 0) ctx.fillText(`TAS ${t.airspeed.toFixed(1)}`, 8, 8 + fsS * 1.3)
  if (ap) { ctx.fillStyle = C.sel; ctx.textBaseline = 'bottom'; ctx.textAlign = 'right'; ctx.fillText(`HDG ${pad3(ap.hdg)}`, w - 8, h - 8) }
}

// ---------- Seis instrumentos analógicos ----------

/** Moldura redonda com fundo preto; devolve centro e raio. */
function bezel(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 6
  ctx.fillStyle = '#05070a'; ctx.fillRect(0, 0, w, h)
  const g = ctx.createRadialGradient(cx, cy, R * 0.9, cx, cy, R + 5)
  g.addColorStop(0, '#2a2e35'); g.addColorStop(1, '#0d0f12')
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R + 5, 0, 7); ctx.fill()
  ctx.fillStyle = '#0b0c0f'; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.fill()
  return { cx, cy, R }
}

function needle(ctx: CanvasRenderingContext2D, cx: number, cy: number, a: number, len: number, width: number, color = C.white) {
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(a)
  ctx.fillStyle = color
  ctx.beginPath(); ctx.moveTo(-width, len * 0.12); ctx.lineTo(0, -len); ctx.lineTo(width, len * 0.12); ctx.closePath(); ctx.fill()
  ctx.restore()
  ctx.fillStyle = '#333'; ctx.beginPath(); ctx.arc(cx, cy, Math.max(4, width * 1.3), 0, 7); ctx.fill()
}

function dialTicks(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, from: number, to: number, a0: number, a1: number, minor: number, major: number, label: (v: number) => string | null) {
  ctx.strokeStyle = C.white; ctx.fillStyle = C.white; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = F(500, R * 0.13)
  for (let v = from; v <= to + 1e-6; v += minor) {
    const a = (a0 + (a1 - a0) * (v - from) / (to - from)) * DEG
    const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6
    ctx.lineWidth = isMajor ? 2 : 1
    const l = isMajor ? R * 0.12 : R * 0.06
    ctx.beginPath(); ctx.moveTo(cx + Math.sin(a) * R * 0.95, cy - Math.cos(a) * R * 0.95); ctx.lineTo(cx + Math.sin(a) * (R * 0.95 - l), cy - Math.cos(a) * (R * 0.95 - l)); ctx.stroke()
    const s = isMajor ? label(v) : null
    if (s) ctx.fillText(s, cx + Math.sin(a) * R * 0.7, cy - Math.cos(a) * R * 0.7)
  }
}

function arcBand(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, a0: number, a1: number, color: string, width: number) {
  ctx.strokeStyle = color; ctx.lineWidth = width
  ctx.beginPath(); ctx.arc(cx, cy, r, (a0 - 90) * DEG, (a1 - 90) * DEG); ctx.stroke()
}

const drawASI: Draw = (ctx, w, h, t) => {
  const { cx, cy, R } = bezel(ctx, w, h)
  const isWing = wing(t)
  const max = isWing ? Math.max(40, Math.ceil(((station.params.get('AIRSPEED_MAX') ?? 30) * 1.25) / 10) * 10) : 25
  const A = (v: number) => 20 + (Math.max(0, Math.min(max, v)) / max) * 320
  if (isWing) {
    const vmin = station.params.get('AIRSPEED_MIN') ?? 12, vmaxp = station.params.get('AIRSPEED_MAX') ?? 30
    arcBand(ctx, cx, cy, R * 0.9, A(vmin), A(vmaxp), C.green, R * 0.05)
    arcBand(ctx, cx, cy, R * 0.9, A(vmaxp), A(vmaxp * 1.15), C.amber, R * 0.05)
    arcBand(ctx, cx, cy, R * 0.9, A(vmaxp * 1.15) - 1, A(vmaxp * 1.15) + 1, C.red, R * 0.12)
  }
  dialTicks(ctx, cx, cy, R, 0, max, 20, 340, isWing ? 2 : 1, isWing ? 10 : 5, (v) => String(v))
  ctx.fillStyle = C.dim; ctx.font = F(500, R * 0.11); ctx.fillText(isWing && (t?.airspeed ?? 0) > 0 ? 'IAS' : 'GS', cx, cy - R * 0.3); ctx.fillText('m/s', cx, cy + R * 0.45)
  const v = speedOf(t)
  ctx.fillStyle = C.white; ctx.font = MONO(R * 0.15); ctx.fillText(v.toFixed(1), cx, cy + R * 0.3)
  const ap = t?.ap
  if (ap?.engaged && (!isWing || ap.spd_on)) {
    const a = A(ap.spd) * DEG
    ctx.fillStyle = C.sel; ctx.beginPath(); ctx.arc(cx + Math.sin(a) * R * 0.97, cy - Math.cos(a) * R * 0.97, R * 0.04, 0, 7); ctx.fill()
  }
  needle(ctx, cx, cy, A(v) * DEG, R * 0.85, R * 0.035)
}

const drawADI: Draw = (ctx, w, h, t) => {
  const { cx, cy, R } = bezel(ctx, w, h)
  ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R * 0.97, 0, 7); ctx.clip()
  horizon(ctx, cx, cy, R, t?.roll ?? 0, t?.pitch ?? 0, R / 35, R * 0.28, R * 0.08)
  ctx.restore()
  rollScale(ctx, cx, cy, R * 0.78, t?.roll ?? 0)
  aircraft(ctx, cx, cy, R * 0.5)
}

const drawAlt: Draw = (ctx, w, h, t) => {
  const { cx, cy, R } = bezel(ctx, w, h)
  const alt = t?.alt_rel ?? 0
  dialTicks(ctx, cx, cy, R, 0, 100, 0, 360, 2, 10, (v) => (v < 100 ? String(v / 10) : null))
  ctx.fillStyle = C.dim; ctx.font = F(500, R * 0.1); ctx.fillText('ALT', cx, cy - R * 0.3); ctx.fillText('×10 m', cx, cy - R * 0.17)
  // Janela numérica (como o tambor dos altímetros modernos).
  ctx.fillStyle = '#000'; ctx.strokeStyle = '#555'; ctx.lineWidth = 1
  ctx.beginPath(); ctx.rect(cx - R * 0.33, cy + R * 0.22, R * 0.66, R * 0.22); ctx.fill(); ctx.stroke()
  ctx.fillStyle = C.white; ctx.font = MONO(R * 0.16); ctx.fillText(`${alt.toFixed(0)} m`, cx, cy + R * 0.34)
  const ap = t?.ap
  if (ap) {
    const a = ((ap.alt_sel % 100) / 100) * 2 * Math.PI
    ctx.fillStyle = C.sel; ctx.globalAlpha = ap.engaged ? 1 : 0.5
    ctx.beginPath(); ctx.arc(cx + Math.sin(a) * R * 0.97, cy - Math.cos(a) * R * 0.97, R * 0.04, 0, 7); ctx.fill(); ctx.globalAlpha = 1
  }
  // Ponteiro curto: centenas; longo: metros dentro dos 100.
  needle(ctx, cx, cy, ((alt / 1000) % 1) * 2 * Math.PI, R * 0.5, R * 0.05)
  needle(ctx, cx, cy, ((alt / 100) % 1) * 2 * Math.PI, R * 0.85, R * 0.03)
}

const drawVSI: Draw = (ctx, w, h, t) => {
  const { cx, cy, R } = bezel(ctx, w, h)
  const max = 10
  // 0 às 9 horas; subida para cima, descida para baixo (até ±170°).
  const A = (v: number) => -90 + (Math.max(-max, Math.min(max, v)) / max) * 170
  ctx.strokeStyle = C.white; ctx.fillStyle = C.white; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  for (let v = -max; v <= max; v += 1) {
    const a = A(v) * DEG, major = v % 2 === 0
    ctx.lineWidth = major ? 2 : 1
    const l = major ? R * 0.12 : R * 0.06
    ctx.beginPath(); ctx.moveTo(cx + Math.sin(a) * R * 0.95, cy - Math.cos(a) * R * 0.95); ctx.lineTo(cx + Math.sin(a) * (R * 0.95 - l), cy - Math.cos(a) * (R * 0.95 - l)); ctx.stroke()
    if (major && Math.abs(v) !== max) { ctx.font = F(500, R * 0.13); ctx.fillText(String(Math.abs(v)), cx + Math.sin(a) * R * 0.7, cy - Math.cos(a) * R * 0.7) }
  }
  ctx.fillStyle = C.dim; ctx.font = F(500, R * 0.1); ctx.fillText(tr('SOBE'), cx - R * 0.05, cy - R * 0.32); ctx.fillText(tr('DESCE'), cx - R * 0.05, cy + R * 0.32); ctx.fillText('V/S m/s', cx + R * 0.38, cy - R * 0.08)
  const vs = t?.climb ?? 0
  ctx.fillStyle = C.white; ctx.font = MONO(R * 0.13); ctx.fillText(`${vs >= 0 ? '+' : ''}${vs.toFixed(1)}`, cx + R * 0.38, cy + R * 0.1)
  needle(ctx, cx, cy, A(vs) * DEG, R * 0.85, R * 0.035)
}

const drawTurn: Draw = (ctx, w, h, t) => {
  const { cx, cy, R } = bezel(ctx, w, h)
  // Curva padrão (3°/s) alinha a asa com as marcas L/R a 20°.
  const rate = t?.yaw_rate ?? 0
  const bank = Math.max(-35, Math.min(35, (rate / 3) * 20))
  // Marcas de nível e de curva padrão.
  ctx.strokeStyle = C.white; ctx.lineWidth = 4
  for (const a of [-20, 0, 20]) {
    const th = a * DEG
    const x1 = cx + Math.cos(th) * R * 0.68, y1 = cy + Math.sin(th) * R * 0.68
    const x2 = cx + Math.cos(th) * R * 0.85, y2 = cy + Math.sin(th) * R * 0.85
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(2 * cx - x1, y1); ctx.lineTo(2 * cx - x2, y2); ctx.stroke()
  }
  ctx.fillStyle = C.white; ctx.font = F(700, R * 0.13); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText(tr('E'), cx - R * 0.8, cy + R * 0.42); ctx.fillText(tr('D'), cx + R * 0.8, cy + R * 0.42)
  ctx.font = F(500, R * 0.09); ctx.fillStyle = C.dim; ctx.fillText(tr('CURVA COORDENADA'), cx, cy - R * 0.55); ctx.fillText('2 MIN', cx, cy + R * 0.82)
  // Avião visto de trás, inclinado pela taxa de curva.
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(bank * DEG)
  ctx.strokeStyle = C.white; ctx.lineWidth = R * 0.05; ctx.lineCap = 'round'
  ctx.beginPath(); ctx.moveTo(-R * 0.62, 0); ctx.lineTo(R * 0.62, 0); ctx.moveTo(0, 0); ctx.lineTo(0, -R * 0.14); ctx.moveTo(-R * 0.15, -R * 0.1); ctx.lineTo(R * 0.15, -R * 0.1); ctx.stroke()
  ctx.fillStyle = C.white; ctx.beginPath(); ctx.arc(0, 0, R * 0.07, 0, 7); ctx.fill()
  ctx.restore(); ctx.lineCap = 'butt'
  // Bola (derrapagem): aceleração lateral estimada = v·ω − g·tan(rolagem).
  const v = t?.groundspeed ?? 0, roll = t?.roll ?? 0
  const lat = (v * rate * DEG - 9.81 * Math.tan(roll * DEG)) / 9.81
  const bx = cx + Math.max(-1, Math.min(1, lat * 3)) * R * 0.32, by = cy + R * 0.5
  ctx.fillStyle = '#1b1e23'; ctx.strokeStyle = '#666'; ctx.lineWidth = 1
  ctx.beginPath(); ctx.roundRect(cx - R * 0.42, by - R * 0.09, R * 0.84, R * 0.18, R * 0.09); ctx.fill(); ctx.stroke()
  ctx.strokeStyle = C.white; ctx.beginPath(); ctx.moveTo(cx - R * 0.1, by - R * 0.09); ctx.lineTo(cx - R * 0.1, by + R * 0.09); ctx.moveTo(cx + R * 0.1, by - R * 0.09); ctx.lineTo(cx + R * 0.1, by + R * 0.09); ctx.stroke()
  ctx.fillStyle = '#000'; ctx.strokeStyle = C.white; ctx.beginPath(); ctx.arc(bx, by, R * 0.075, 0, 7); ctx.fill(); ctx.stroke()
}

const drawDG: Draw = (ctx, w, h, t) => {
  const { cx, cy, R } = bezel(ctx, w, h)
  const hdg = t?.heading ?? 0
  rose(ctx, cx, cy, R * 0.92, hdg)
  const ap = t?.ap
  if (ap) hdgBug(ctx, cx, cy, R * 0.92, ap.hdg - hdg, ap.engaged && ap.lateral === 'hdg')
  ctx.fillStyle = C.amber; ctx.beginPath(); ctx.moveTo(cx, cy - R * 0.92); ctx.lineTo(cx - 6, cy - R * 0.92 - 10); ctx.lineTo(cx + 6, cy - R * 0.92 - 10); ctx.closePath(); ctx.fill()
  // Avião fixo no centro.
  ctx.strokeStyle = C.amber; ctx.lineWidth = 3; ctx.lineCap = 'round'
  const s = R * 0.3
  ctx.beginPath(); ctx.moveTo(cx, cy - s); ctx.lineTo(cx, cy + s * 0.9); ctx.moveTo(cx - s * 0.85, cy - s * 0.1); ctx.lineTo(cx + s * 0.85, cy - s * 0.1); ctx.moveTo(cx - s * 0.35, cy + s * 0.75); ctx.lineTo(cx + s * 0.35, cy + s * 0.75); ctx.stroke()
  ctx.lineCap = 'butt'
  ctx.fillStyle = C.white; ctx.font = MONO(R * 0.13); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText(`${pad3(hdg)}°`, cx, cy + R * 0.48)
}

// ---------- HUD sobre a câmera ----------

const drawHUD: Draw = (ctx, w, h, t) => {
  if (!t?.connected) return
  const G = '#5dff8a', cx = w / 2, cy = h / 2, fs = Math.max(11, Math.min(18, h * 0.035))
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 3
  ctx.strokeStyle = G; ctx.fillStyle = G; ctx.lineWidth = 1.6
  // Horizonte e escada de arfagem, girando com a rolagem.
  const ppd = h / 60
  ctx.save(); ctx.beginPath(); ctx.rect(w * 0.18, h * 0.12, w * 0.64, h * 0.72); ctx.clip()
  ctx.translate(cx, cy); ctx.rotate(-t.roll * DEG)
  const off = t.pitch * ppd
  ctx.beginPath(); ctx.moveTo(-w, off); ctx.lineTo(-w * 0.06, off); ctx.moveTo(w * 0.06, off); ctx.lineTo(w, off); ctx.stroke()
  ctx.font = F(500, fs * 0.8); ctx.textBaseline = 'middle'
  for (const p of [-20, -15, -10, -5, 5, 10, 15, 20]) {
    const y = off - p * ppd, L = w * 0.08
    ctx.setLineDash(p < 0 ? [6, 5] : [])
    ctx.beginPath(); ctx.moveTo(-L - w * 0.03, y); ctx.lineTo(-w * 0.03, y); ctx.moveTo(w * 0.03, y); ctx.lineTo(L + w * 0.03, y); ctx.stroke()
    ctx.setLineDash([])
    ctx.textAlign = 'right'; ctx.fillText(String(p), -L - w * 0.035, y)
    ctx.textAlign = 'left'; ctx.fillText(String(p), L + w * 0.035, y)
  }
  ctx.restore()
  // Mira fixa (W).
  ctx.lineWidth = 2.2
  ctx.beginPath(); ctx.moveTo(cx - 28, cy); ctx.lineTo(cx - 12, cy); ctx.lineTo(cx - 6, cy + 8); ctx.lineTo(cx, cy); ctx.lineTo(cx + 6, cy + 8); ctx.lineTo(cx + 12, cy); ctx.lineTo(cx + 28, cy); ctx.stroke()
  ctx.lineWidth = 1.6
  // Rumo em cima.
  const span = 30, tw = w * 0.4, ppdh = tw / (2 * span), ty = h * 0.07
  ctx.font = F(500, fs * 0.85); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
  for (let d = Math.ceil((t.heading - span) / 5) * 5; d <= t.heading + span; d += 5) {
    const x = cx + (d - t.heading) * ppdh, dd = ((d % 360) + 360) % 360
    ctx.beginPath(); ctx.moveTo(x, ty); ctx.lineTo(x, ty + (dd % 10 === 0 ? 10 : 5)); ctx.stroke()
    if (dd % 10 === 0) ctx.fillText(CARD[dd] ?? pad3(dd).slice(0, 2), x, ty - 2)
  }
  ctx.beginPath(); ctx.moveTo(cx, ty + 12); ctx.lineTo(cx - 6, ty + 20); ctx.lineTo(cx + 6, ty + 20); ctx.closePath(); ctx.fill()
  ctx.font = MONO(fs); ctx.textBaseline = 'top'; ctx.fillText(pad3(t.heading), cx, ty + 22)
  // Velocidade à esquerda, altitude e V/S à direita.
  const box = (x: number, text: string, sub: string, align: CanvasTextAlign) => {
    ctx.textAlign = align; ctx.textBaseline = 'middle'
    ctx.font = MONO(fs * 1.3); ctx.fillText(text, x, cy)
    ctx.font = F(500, fs * 0.75); ctx.fillText(sub, x, cy - fs * 1.4)
  }
  box(w * 0.14, speedOf(t).toFixed(1), wing(t) && t.airspeed > 0 ? 'IAS m/s' : 'GS m/s', 'right')
  box(w * 0.86, t.alt_rel.toFixed(1), 'ALT m', 'left')
  ctx.font = MONO(fs * 0.85); ctx.textAlign = 'left'; ctx.fillText(`VS ${t.climb >= 0 ? '+' : ''}${t.climb.toFixed(1)}`, w * 0.86, cy + fs * 1.5)
  // Rodapé: modo, piloto automático e bateria.
  ctx.font = F(600, fs * 0.9); ctx.textBaseline = 'bottom'
  ctx.textAlign = 'left'; ctx.fillText(`${t.mode}${t.armed ? '' : ' · ' + tr('DESARM.')}`, w * 0.04, h - h * 0.04)
  const ap = t.ap
  if (ap?.engaged) { ctx.textAlign = 'center'; ctx.fillText(`AP · ${ap.lateral === 'nav' ? 'NAV' : 'HDG ' + pad3(ap.hdg)} · ${ap.vertical === 'vs' ? 'VS → ' + Math.round(ap.alt_sel) : ap.vertical === 'nav' ? 'VNAV' : 'ALT ' + Math.round(ap.alt_hold)}`, cx, h - h * 0.04) }
  ctx.textAlign = 'right'
  ctx.fillStyle = t.battery.remaining >= 0 && t.battery.remaining <= 20 ? C.red : G
  ctx.fillText(`BAT ${t.battery.remaining >= 0 ? t.battery.remaining + ' %' : t.battery.voltage.toFixed(1) + ' V'}`, w * 0.96, h - h * 0.04)
  ctx.restore()
}

export function PFD() {
  return <canvas ref={useCanvasLoop(drawPFD)} className="ck-cv" aria-label={'PFD'} />
}
export function NavDisplay() {
  return <canvas ref={useCanvasLoop(drawND)} className="ck-cv" aria-label={'HSI'} />
}
export function AirspeedGauge() {
  return <canvas ref={useCanvasLoop(drawASI)} className="ck-cv" aria-label={tr('Velocímetro')} />
}
export function AttitudeGauge() {
  return <canvas ref={useCanvasLoop(drawADI)} className="ck-cv" aria-label={tr('Horizonte artificial')} />
}
export function AltimeterGauge() {
  return <canvas ref={useCanvasLoop(drawAlt)} className="ck-cv" aria-label={tr('Altímetro')} />
}
export function VsiGauge() {
  return <canvas ref={useCanvasLoop(drawVSI)} className="ck-cv" aria-label={tr('Variômetro')} />
}
export function TurnGauge() {
  return <canvas ref={useCanvasLoop(drawTurn)} className="ck-cv" aria-label={tr('Indicador de curva')} />
}
export function HeadingGauge() {
  return <canvas ref={useCanvasLoop(drawDG)} className="ck-cv" aria-label={tr('Giro direcional')} />
}
export function HudOverlay() {
  return <canvas ref={useCanvasLoop(drawHUD)} className="ck-cv" aria-label={'HUD'} />
}
