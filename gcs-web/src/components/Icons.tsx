import type { ReactNode } from 'react'

const S = ({ children, fill = false, size }: { children: ReactNode; fill?: boolean; size?: number }) => (
  <svg className={fill ? 'i f' : 'i'} viewBox="0 0 24 24" style={size ? { width: size, height: size } : undefined} aria-hidden="true">
    {children}
  </svg>
)

export const Icon = {
  chevron: (p: { size?: number }) => <S size={p.size ?? 14}><path d="M6 9l6 6 6-6" /></S>,
  chevronUp: () => <S size={14}><path d="M6 15l6-6 6 6" /></S>,
  gear: () => <S><circle cx="12" cy="12" r="3" /><path d="M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" /><circle cx="12" cy="12" r="6.6" /></S>,
  pin: () => <S><path d="M12 21s-6-5.6-6-10.5a6 6 0 0 1 12 0C18 15.4 12 21 12 21z" /><circle cx="12" cy="10.5" r="2.2" /></S>,
  pinAdd: () => <S><path d="M12 21s-6-5.6-6-10.5a6 6 0 0 1 12 0C18 15.4 12 21 12 21z" /><path d="M12 7.5v6M9 10.5h6" /></S>,
  plane: () => <S fill><path d="M21.5 12c0-.9-.7-1.5-1.6-1.5h-5.3L10.3 3H8.4l2.1 7.5H5.6L4 8.4H2.5l1.1 3.6-1.1 3.6H4l1.6-2.1h4.9L8.4 21h1.9l4.3-7.5h5.3c.9 0 1.6-.6 1.6-1.5z" /></S>,
  analyze: () => <S><path d="M14 3H6v18h6" /><path d="M14 3l4 4v4" /><circle cx="17" cy="16.5" r="3" /><path d="M19.2 18.7 22 21.5" /></S>,
  megaphone: () => <S><path d="M3 10v4h3l7 4.5v-13L6 10H3z" /><path d="M16.5 9a4 4 0 0 1 0 6" /></S>,
  satellite: () => <S><path d="M9.5 9.5l5 5" /><path d="M12.5 6.5l5 5-3 3-5-5z" /><path d="M4 4l4.5 4.5M15.5 15.5 20 20" /><path d="M3 8l5-5M16 21l5-5" /></S>,
  radio: () => <S><rect x="3" y="9" width="18" height="10" rx="3" /><circle cx="8" cy="14" r="1.8" /><circle cx="16" cy="14" r="1.8" /><path d="M8 9V4M16 9V4" /></S>,
  takeoff: () => <S><path d="M3 20.5h18" /><path d="M4 14.5l3-1 2.2 1.4 8.3-4.6a1.7 1.7 0 0 1 1.6 3L8.5 18.8 4 14.5z" /></S>,
  land: () => <S><path d="M3 20.5h18" /><path d="M4.5 8.5 7 8l1.3 2.4 8.9 2.3a1.7 1.7 0 0 1-.8 3.3L4.8 13z" /></S>,
  pause: () => <S fill><rect x="6.5" y="5" width="4" height="14" rx="1" /><rect x="13.5" y="5" width="4" height="14" rx="1" /></S>,
  play: () => <S fill><path d="M7 4.5v15l12-7.5z" /></S>,
  target: () => <S><circle cx="12" cy="12" r="6.5" /><circle cx="12" cy="12" r="1.5" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" /></S>,
  layers: () => <S><path d="M12 3 2.5 8l9.5 5 9.5-5L12 3z" /><path d="M2.5 13l9.5 5 9.5-5" /></S>,
  engine: () => <S><path d="M4 9h2V7h4V5h4v2h3l2 3h1.5v5H19l-2 3h-6l-2-2H6v-3H4z" /><path d="M2 10.5v4" /></S>,
  plus: () => <S><path d="M12 6v12M6 12h12" /></S>,
  minus: () => <S><path d="M6 12h12" /></S>,
  grid: () => <S><rect x="3.5" y="3.5" width="17" height="17" rx="1" /><path d="M7 7h10v3.3H7v3.4h10V17H7" /></S>,
  fit: () => <S><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></S>,
  upload: () => <S><path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 16v4h16v-4" /></S>,
  fence: () => <S><path d="M4 20V8l2-3 2 3v12M10 20V8l2-3 2 3v12M16 20V8l2-3 2 3v12M3 11h18M3 16h18" /></S>,
  cube: () => <S><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" /></S>,
  download: () => <S><path d="M12 4v12M7 11l5 5 5-5" /><path d="M4 16v4h16v-4" /></S>,
  values: () => <S><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /></S>,
  camera: () => <S><rect x="3" y="7" width="13" height="11" rx="2" /><path d="M16 11l5-3v9l-5-3" /></S>,
  sticks: () => <S><circle cx="8" cy="14" r="4" /><circle cx="16" cy="14" r="4" /><path d="M8 10V4M16 10V4" /></S>,
  lidar: () => <S><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4" /><path d="M12 12l6-6" /></S>,
  pulse: () => <S><path d="M3 12h4l2-6 4 12 2-6h6" /></S>,
  drop: () => <S><path d="M5 4h14v7H5z" /><path d="M9 4v3h6V4" /><path d="M12 14v7M8.5 17.5 12 21l3.5-3.5" /></S>,
  antenna: () => <S><path d="M5 12a7 7 0 0 1 14 0M8.5 12a3.5 3.5 0 0 1 7 0" /><path d="M12 12v9" /></S>,
}

/** Bateria com nível de preenchimento. */
export function BatteryIcon({ pct }: { pct: number }) {
  const p = Math.max(0, Math.min(100, pct)) / 100
  const color = p < 0.2 ? 'var(--red)' : p < 0.35 ? 'var(--amber)' : 'var(--green)'
  return (
    <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="7.5" y="4" width="9" height="17" rx="1.5" />
      <path d="M10 2h4" />
      <rect x="9.3" y={6 + 13 * (1 - p)} width="5.4" height={13 * p} rx=".5" style={{ fill: color, stroke: 'none' }} />
    </svg>
  )
}
