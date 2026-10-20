// Rota escrita como no campo 15 do plano de voo: "SBSP DCT NIBGA UZ6 ANDEM DCT SBBR".
// Aerovias viram a sequência de fixos entre a entrada e a saída; aceita DCT, coordenadas
// (2330S04637W, -23.5,-46.6), HOME e grupos de velocidade/nível (N0090A045, K0160F075).

import { FT, type ChartIndex, type ChartSegment, type Place } from './charts'
import type { LatLon } from './geo'
import { tk } from './i18n'

export interface RoutePoint extends Place {
  /** Como se chega a este ponto: DCT ou o nome da aerovia. */
  via: string
  /** Altitude pedida no grupo de nível (m acima do nível do mar); senão, a de cruzeiro do plano. */
  alt?: number
  /** Trecho de aerovia que termina aqui. */
  seg?: ChartSegment
}

/** Mensagem com o texto (traduzido na tela) e as variáveis. */
export interface RouteMsg { text: string; vars?: Record<string, string | number> }

export interface ParsedRoute {
  points: RoutePoint[]
  errors: RouteMsg[]
  warnings: RouteMsg[]
  /** Velocidade (m/s) do primeiro grupo de velocidade/nível. */
  speed?: number
}

const KT = 1852 / 3600

/** "N0450F350" → velocidade em m/s e altitude em metros. */
export function speedLevel(tok: string): { speed: number; alt: number } | null {
  const m = /^([NKM])(\d{3,4})([FASM])(\d{3,4})$/.exec(tok)
  if (!m) return null
  const v = +m[2], l = +m[4]
  const speed = m[1] === 'N' ? v * KT : m[1] === 'K' ? v / 3.6 : (v / 100) * 295
  const alt = m[3] === 'F' || m[3] === 'A' ? l * 100 * FT : l * 10
  return { speed, alt }
}

/** Coordenada ICAO (23S046W, 2330S04637W, 233015S0463712W) ou decimal (-23.5,-46.6). */
export function coordinate(tok: string): LatLon | null {
  const d = /^(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/.exec(tok)
  if (d) {
    const lat = +d[1], lon = +d[2]
    return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null
  }
  const m = /^(\d{2})(\d{2})?(\d{2})?([NS])(\d{3})(\d{2})?(\d{2})?([EW])$/.exec(tok)
  if (!m || (m[2] === undefined) !== (m[6] === undefined) || (m[3] === undefined) !== (m[7] === undefined)) return null
  const lat = (+m[1] + +(m[2] ?? 0) / 60 + +(m[3] ?? 0) / 3600) * (m[4] === 'S' ? -1 : 1)
  const lon = (+m[5] + +(m[6] ?? 0) / 60 + +(m[7] ?? 0) / 3600) * (m[8] === 'W' ? -1 : 1)
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null
}

const IGNORED = new Set(['IFR', 'VFR', 'Y', 'Z'])

export function parseRoute(text: string, charts: ChartIndex | null, home: LatLon | null): ParsedRoute {
  const out: ParsedRoute = { points: [], errors: [], warnings: [] }
  const toks = text.toUpperCase().split(/\s+/).filter(Boolean)
  let airway: string | null = null
  let alt: number | undefined
  const last = () => out.points.at(-1) ?? null
  const place = (tok: string): Place | null => {
    if (tok === 'HOME' || tok === 'CASA') return home ? { id: 'HOME', kind: 'home', ...home } : null
    const c = coordinate(tok)
    if (c) return { id: tok, kind: 'coord', ...c }
    return charts?.find(tok, last() ?? home) ?? null
  }
  for (const raw of toks) {
    const [tok, group] = raw.split('/')
    const sl = speedLevel(tok)
    if (sl && group === undefined) {
      out.speed ??= sl.speed
      alt = sl.alt
      continue
    }
    if (IGNORED.has(tok)) continue
    if (tok === 'DCT') {
      if (airway) out.errors.push({ text: tk('Aerovia {aw} sem fixo de saída'), vars: { aw: airway } })
      airway = null
      continue
    }
    const aw = !airway && last() ? charts?.graph.get(tok) : undefined
    if (aw?.has(last()!.id)) {
      airway = tok
      continue
    }
    if (aw && !charts!.fixes.has(tok) && !charts!.airports.has(tok)) {
      out.errors.push({ text: tk('{from} não está na {aw}'), vars: { from: last()!.id, aw: tok } })
      continue
    }
    const p = place(tok)
    if (!p) {
      out.errors.push(charts ? { text: tk('{tok}: não encontrado nas cartas'), vars: { tok } } : { text: tk('{tok}: baixe as cartas para usar fixos e aerovias'), vars: { tok } })
      continue
    }
    const prev = last()
    if (airway && prev) {
      const path = charts!.airwayPath(airway, prev.id, p.id)
      if (!path) {
        out.errors.push({ text: tk('{fix} não está na {aw} a partir de {from}; ligado direto'), vars: { fix: p.id, aw: airway, from: prev.id } })
        out.points.push({ ...p, via: 'DCT', alt })
      } else {
        for (const s of path.steps) out.points.push({ ...s.fix, via: airway, alt, seg: s.seg })
        // O ponto pedido mantém o tipo e o nome que o operador escreveu (aeródromo no fim da aerovia).
        Object.assign(out.points.at(-1)!, { kind: p.kind, name: p.name ?? out.points.at(-1)!.name })
        if (path.against.length) {
          // Muitos trechos seguidos: resume como primeiro…último.
          const a = path.against
          const legs = a.length > 2 ? `${a[0].split('–')[0]}–${a.at(-1)!.split('–')[1]} (${a.length})` : a.join(', ')
          out.warnings.push({ text: tk('{aw}: {legs} é de mão única no sentido contrário'), vars: { aw: airway, legs } })
        }
      }
    } else {
      out.points.push({ ...p, via: 'DCT', alt })
    }
    airway = null
    if (group !== undefined) {
      const g = speedLevel(group)
      if (g) {
        out.speed ??= g.speed
        alt = g.alt
      } else out.errors.push({ text: tk('{tok}: grupo de velocidade/nível inválido'), vars: { tok: group } })
    }
  }
  if (airway) out.errors.push({ text: tk('Aerovia {aw} sem fixo de saída'), vars: { aw: airway } })
  // O grupo de nível vem depois da partida (SBSP N0090A045 …): a partida fica no mesmo nível.
  const lvl = out.points.find((p) => p.alt !== undefined)?.alt
  for (const p of out.points) {
    if (p.alt !== undefined) break
    p.alt = lvl
  }
  return out
}
