export const fmtTime = (s: number) => {
  const t = Math.max(0, Math.floor(s))
  return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

export const fmtDist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`)

export const fmtDuration = (s: number) =>
  s >= 3600 ? `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')} min`
    : s >= 60 ? `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')} s` : `${Math.round(s)} s`

export const clock = (ms: number) => new Date(ms).toLocaleTimeString('pt-BR', { hour12: false })

export const cardinal = (deg: number) => ['N', 'NE', 'L', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(((deg % 360) + 360) % 360 / 45) % 8]

export const wpName = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : String(i + 1))

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
