// Camadas das cartas aeronáuticas no MapLibre, com as convenções das cartas ENRC:
// aerovias inferiores e superiores, fixos (triângulos), VOR/DME, NDB, aeródromos,
// espaços controlados, áreas R/P/D, FIR e a grade de altitude mínima (AMA).

import type * as GeoJSON from 'geojson'
import { addProtocol, type ExpressionSpecification, type GeoJSONSource, type Map as MlMap } from 'maplibre-gl'
import glyphs0 from '../assets/glyphs/0-255.pbf?url'
import glyphs256 from '../assets/glyphs/256-511.pbf?url'
import glyphs8192 from '../assets/glyphs/8192-8447.pbf?url'
import { airportFeatures, airspaceFeatures, airwayFeatures, CONTROLLED, fixFeatures, SPECIAL, type ChartIndex, type ChartLayers } from '../lib/charts'

/** Fonte dos rótulos: embutida no app (o mapa precisa funcionar sem internet). */
export const FONT = ['Open Sans Semibold']
export const GLYPHS = 'aracua-glyphs://{fontstack}/{range}'
const GLYPH_FILES: Record<string, string> = { '0-255': glyphs0, '256-511': glyphs256, '8192-8447': glyphs8192 }

let glyphsReady = false
export function setupGlyphs() {
  if (glyphsReady) return
  glyphsReady = true
  addProtocol('aracua-glyphs', async (params) => {
    const range = params.url.split('/').pop() ?? ''
    const file = GLYPH_FILES[range]
    // Faixas sem arquivo (alfabetos que as cartas não usam) voltam vazias, sem erro.
    if (!file) return { data: new ArrayBuffer(0) }
    return { data: await (await fetch(file)).arrayBuffer() }
  })
}

const EMPTY = { type: 'FeatureCollection' as const, features: [] }
export const CHART_SOURCES = ['ch-airways', 'ch-fixes', 'ch-airports', 'ch-airspaces'] as const

/** Ícones desenhados em canvas (o estilo não tem sprite). */
function icon(draw: (c: CanvasRenderingContext2D) => void, size = 32) {
  const cv = document.createElement('canvas')
  cv.width = cv.height = size
  const c = cv.getContext('2d')!
  c.lineWidth = 2.5
  c.strokeStyle = c.fillStyle = '#ffffff'
  draw(c)
  return c.getImageData(0, 0, size, size)
}

function addIcons(map: MlMap) {
  const add = (name: string, img: ImageData) => !map.hasImage(name) && map.addImage(name, img, { pixelRatio: 2, sdf: true })
  add('ic-wpt', icon((c) => {
    c.beginPath(); c.moveTo(16, 6); c.lineTo(26, 24); c.lineTo(6, 24); c.closePath(); c.stroke()
  }))
  add('ic-wpt-aw', icon((c) => {
    c.beginPath(); c.moveTo(16, 6); c.lineTo(26, 24); c.lineTo(6, 24); c.closePath(); c.fill()
  }))
  add('ic-vor', icon((c) => {
    c.beginPath()
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i
      c.lineTo(16 + Math.cos(a) * 11, 16 + Math.sin(a) * 11)
    }
    c.closePath(); c.stroke()
    c.beginPath(); c.arc(16, 16, 2.5, 0, Math.PI * 2); c.fill()
  }))
  add('ic-vordme', icon((c) => {
    c.strokeRect(4, 4, 24, 24)
    c.beginPath()
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i
      c.lineTo(16 + Math.cos(a) * 9, 16 + Math.sin(a) * 9)
    }
    c.closePath(); c.stroke()
    c.beginPath(); c.arc(16, 16, 2.5, 0, Math.PI * 2); c.fill()
  }))
  add('ic-dme', icon((c) => {
    c.strokeRect(7, 7, 18, 18)
    c.beginPath(); c.arc(16, 16, 2.5, 0, Math.PI * 2); c.fill()
  }))
  add('ic-ndb', icon((c) => {
    c.beginPath(); c.arc(16, 16, 3, 0, Math.PI * 2); c.fill()
    for (const r of [7, 10.5, 14]) for (let i = 0; i < 12; i++) {
      const a = (Math.PI / 6) * i + r / 10
      c.beginPath(); c.arc(16 + Math.cos(a) * r, 16 + Math.sin(a) * r, 1.1, 0, Math.PI * 2); c.fill()
    }
  }))
  add('ic-apt', icon((c) => {
    c.beginPath(); c.arc(16, 16, 10, 0, Math.PI * 2); c.stroke()
    c.beginPath(); c.arc(16, 16, 5, 0, Math.PI * 2); c.fill()
  }))
  add('ic-apt-priv', icon((c) => {
    c.beginPath(); c.arc(16, 16, 7, 0, Math.PI * 2); c.stroke()
  }))
  add('ic-mark', icon((c) => {
    c.beginPath(); c.moveTo(16, 3); c.lineTo(29, 16); c.lineTo(16, 29); c.lineTo(3, 16); c.closePath(); c.fill()
  }))
}

const text = (field: ExpressionSpecification | string, size: number, color: string, extra: Record<string, unknown> = {}) => ({
  layout: { 'text-field': typeof field === 'string' ? ['get', field] : field, 'text-font': FONT, 'text-size': size, ...extra } as never,
  paint: { 'text-color': color, 'text-halo-color': 'rgba(10,14,20,0.9)', 'text-halo-width': 1.4 } as never,
})

const kindIs = (kinds: string[]): ExpressionSpecification => ['in', ['get', 'kind'], ['literal', kinds]]

/** Cria as fontes e camadas das cartas (antes das camadas da missão, que ficam por cima). */
export function addChartLayers(map: MlMap) {
  addIcons(map)
  for (const id of CHART_SOURCES) map.addSource(id, { type: 'geojson', data: EMPTY })
  map.addLayer({ id: 'ch-bg', type: 'background', layout: { visibility: 'none' }, paint: { 'background-color': '#0f1b26' } })
  // Espaços aéreos.
  map.addLayer({ id: 'ch-ama', type: 'line', source: 'ch-airspaces', filter: kindIs(['AMA']), paint: { 'line-color': '#8a94a6', 'line-width': 0.6, 'line-opacity': 0.6 } })
  map.addLayer({ id: 'ch-ama-label', type: 'symbol', source: 'ch-airspaces', filter: kindIs(['AMA']), minzoom: 6, ...text('label', 13, '#c3cad6') })
  map.addLayer({ id: 'ch-fir', type: 'line', source: 'ch-airspaces', filter: kindIs(['FIR', 'UIR', 'ADIZ']), paint: { 'line-color': '#9aa4b5', 'line-width': 2.2, 'line-dasharray': [6, 3, 1, 3] } })
  map.addLayer({ id: 'ch-ctl-fill', type: 'fill', source: 'ch-airspaces', filter: kindIs(['CTR', 'ATZ']), paint: { 'fill-color': '#3a78f2', 'fill-opacity': 0.06 } })
  map.addLayer({ id: 'ch-ctl', type: 'line', source: 'ch-airspaces', filter: kindIs(CONTROLLED), paint: {
    'line-color': ['match', ['get', 'kind'], 'CTR', '#5b9bff', 'ATZ', '#5b9bff', 'TMA', '#c58bff', '#7f8cff'],
    'line-width': ['match', ['get', 'kind'], 'TMA', 1.8, 1.4],
    'line-dasharray': ['match', ['get', 'kind'], 'CTR', ['literal', [4, 2]], 'ATZ', ['literal', [2, 2]], ['literal', [1, 0]]],
  } })
  map.addLayer({ id: 'ch-spc-fill', type: 'fill', source: 'ch-airspaces', filter: kindIs(SPECIAL), paint: {
    'fill-color': ['match', ['get', 'kind'], 'D', '#f5b43a', '#ef4a3c'], 'fill-opacity': ['match', ['get', 'kind'], 'P', 0.22, 0.12],
  } })
  map.addLayer({ id: 'ch-spc', type: 'line', source: 'ch-airspaces', filter: kindIs(SPECIAL), paint: {
    'line-color': ['match', ['get', 'kind'], 'D', '#f5b43a', '#ef4a3c'], 'line-width': 1.6,
  } })
  // CTA/UTA cobrem estados inteiros: o rótulo se repetiria em cada tile; o balão do clique diz o que são.
  map.addLayer({ id: 'ch-as-label', type: 'symbol', source: 'ch-airspaces', filter: kindIs(['CTR', 'TMA', 'ATZ', ...SPECIAL]), minzoom: 8,
    ...text('label', 10.5, '#d9c2ff', { 'text-max-width': 14 }) })
  // Aerovias.
  const awPaint = (color: string) => ({
    'line-color': color,
    'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.8, 9, 1.8] as ExpressionSpecification,
    'line-opacity': 0.9,
  })
  map.addLayer({ id: 'ch-aw-low', type: 'line', source: 'ch-airways', filter: ['!', ['get', 'upper']], paint: awPaint('#4fc3f7') })
  map.addLayer({ id: 'ch-aw-high', type: 'line', source: 'ch-airways', filter: ['get', 'upper'], paint: awPaint('#c5a3ff') })
  const awLabel = (id: string, upper: boolean, color: string) => map.addLayer({
    id, type: 'symbol', source: 'ch-airways', filter: upper ? ['get', 'upper'] : ['!', ['get', 'upper']], minzoom: 6,
    ...text(['step', ['zoom'], ['get', 'aw'], 8, ['concat', ['get', 'aw'], '\n', ['get', 'lim']]], 11, color,
      { 'symbol-placement': 'line-center', 'text-rotation-alignment': 'viewport', 'text-padding': 4 }),
  })
  awLabel('ch-aw-low-label', false, '#9fdcff')
  awLabel('ch-aw-high-label', true, '#dcc8ff')
  // Fixos e auxílios.
  map.addLayer({ id: 'ch-fix', type: 'symbol', source: 'ch-fixes', filter: ['all', ['==', ['get', 'kind'], 'wpt'], ['any', ['get', 'aw'], ['>=', ['zoom'], 9]]], minzoom: 6,
    layout: {
      'icon-image': ['case', ['get', 'aw'], 'ic-wpt-aw', 'ic-wpt'], 'icon-size': 0.9, 'icon-allow-overlap': true,
      'text-field': ['step', ['zoom'], '', 8, ['get', 'id']], 'text-font': FONT, 'text-size': 10, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true,
    },
    paint: { 'icon-color': '#e8edf3', 'text-color': '#e8edf3', 'text-halo-color': 'rgba(10,14,20,0.9)', 'text-halo-width': 1.3 },
  })
  map.addLayer({ id: 'ch-navaid', type: 'symbol', source: 'ch-fixes', filter: ['!=', ['get', 'kind'], 'wpt'], minzoom: 5,
    layout: {
      'icon-image': ['concat', 'ic-', ['get', 'kind']], 'icon-size': 1.1, 'icon-allow-overlap': true,
      'text-field': ['step', ['zoom'], ['get', 'id'], 8, ['get', 'label']], 'text-font': FONT, 'text-size': 11, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-optional': true,
    },
    paint: { 'icon-color': '#7cf29c', 'text-color': '#a9f7c0', 'text-halo-color': 'rgba(10,14,20,0.9)', 'text-halo-width': 1.3 },
  })
  map.addLayer({ id: 'ch-apt', type: 'symbol', source: 'ch-airports', filter: ['any', ['get', 'pub'], ['>=', ['zoom'], 9]], minzoom: 5,
    layout: {
      'icon-image': ['case', ['get', 'pub'], 'ic-apt', 'ic-apt-priv'], 'icon-size': ['case', ['get', 'ifr'], 1.15, 0.9], 'icon-allow-overlap': true,
      'text-field': ['get', 'id'], 'text-font': FONT, 'text-size': 11, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-optional': true,
    },
    paint: { 'icon-color': ['case', ['get', 'ifr'], '#ffd23f', '#f2c94c'], 'text-color': '#ffe08a', 'text-halo-color': 'rgba(10,14,20,0.9)', 'text-halo-width': 1.3 },
  })
}

/** Camadas por interruptor do operador. */
const GROUPS: Record<keyof ChartLayers, string[]> = {
  low: ['ch-aw-low', 'ch-aw-low-label'],
  high: ['ch-aw-high', 'ch-aw-high-label'],
  fixes: ['ch-fix'],
  navaids: ['ch-navaid'],
  airports: ['ch-apt'],
  airspace: ['ch-ctl', 'ch-ctl-fill', 'ch-as-label'],
  restricted: ['ch-spc', 'ch-spc-fill'],
  fir: ['ch-fir'],
  ama: ['ch-ama', 'ch-ama-label'],
}

export function applyChartVisibility(map: MlMap, on: boolean, layers: ChartLayers, base: boolean) {
  for (const [k, ids] of Object.entries(GROUPS) as [keyof ChartLayers, string[]][]) {
    for (const id of ids) map.setLayoutProperty(id, 'visibility', on && layers[k] ? 'visible' : 'none')
  }
  // Os rótulos dos espaços controlados também valem para as áreas R/P/D.
  if (on && !layers.airspace && layers.restricted) map.setLayoutProperty('ch-as-label', 'visibility', 'visible')
  map.setLayoutProperty('ch-bg', 'visibility', on && base ? 'visible' : 'none')
  map.setLayoutProperty('sat', 'visibility', on && base ? 'none' : 'visible')
}

export function setChartData(map: MlMap, c: ChartIndex | null) {
  const set = (id: string, data: GeoJSON.FeatureCollection) => (map.getSource(id) as GeoJSONSource | undefined)?.setData(data)
  set('ch-airways', c ? airwayFeatures(c) : EMPTY)
  set('ch-fixes', c ? fixFeatures(c) : EMPTY)
  set('ch-airports', c ? airportFeatures(c) : EMPTY)
  set('ch-airspaces', c ? airspaceFeatures(c) : EMPTY)
}

/** Camadas clicáveis (tocar num fixo no planejamento o põe na rota). */
export const PICKABLE = ['ch-fix', 'ch-navaid', 'ch-apt']
export const INFO_LAYERS = [...PICKABLE, 'ch-spc-fill', 'ch-ctl-fill', 'ch-aw-low', 'ch-aw-high']
