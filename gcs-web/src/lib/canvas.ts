// Laço de desenho dos instrumentos em canvas: redesenha a cada quadro com a telemetria
// mais recente, sem re-render do React, no tamanho (e na densidade de pixels) do elemento.

import { useEffect, useRef } from 'react'
import { station } from './store'
import type { Telemetry } from '../types'

export function useCanvasLoop(draw: (ctx: CanvasRenderingContext2D, w: number, h: number, t: Telemetry | null) => void) {
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
