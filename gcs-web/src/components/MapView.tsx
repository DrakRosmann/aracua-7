// Mapa de satélite com veículo, trilha, missão, geocerca e camada LiDAR.

import { useEffect, useRef } from 'react'
import type * as GeoJSON from 'geojson'
import { Map as MlMap, Marker, setWorkerUrl, type GeoJSONSource, type MapMouseEvent } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import { station } from '../lib/store'
import { PROTOCOL_URL, setupTiles } from '../lib/tiles'
import { fenceIsEmpty, sameFence, type FenceData } from '../lib/fence'
import { circle, enuToLatLon, rectangle, survey, type LatLon } from '../lib/geo'
import { wpName } from '../lib/format'
import { vehicleClass, type VehicleClass } from '../types'
import { t as tr } from '../lib/i18n'

setWorkerUrl(workerUrl)

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
const MAX_OBSTACLE_POINTS = 60_000
const MAX_GROUND_POINTS = 40_000
/** No 3D cada voxel vira um bloco (polígono extrudado): limite menor para manter a fluidez. */
const MAX_BLOCKS = 25_000

/** Silhueta vista de cima, com a proa para cima (o mapa gira pelo rumo). */
const SILHOUETTE: Record<VehicleClass, string> = {
  copter: `<path d="M-11-11L11 11M11-11L-11 11" stroke="#fff" stroke-width="3.5"/>
    ${[[-11, -11], [11, -11], [-11, 11], [11, 11]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="6" fill="rgba(20,22,27,.6)" stroke="#fff" stroke-width="2"/>`).join('')}
    <path class="nose" d="M0-9L6 4H-6Z"/>`,
  heli: `<circle r="17" fill="none" stroke="#fff" stroke-width="1.5" stroke-dasharray="3 3"/>
    <path d="M-16 0H16M0-16V16" stroke="#fff" stroke-width="2.5"/>
    <ellipse cy="-2" rx="5" ry="8" fill="rgba(20,22,27,.6)" stroke="#fff" stroke-width="2"/>
    <path d="M0 6V18M-4 17H4" stroke="#fff" stroke-width="2.5"/><path class="nose" d="M0-9L4-3H-4Z"/>`,
  plane: `<path d="M0-17C2-17 2.5-14 2.5-11V-3L17 3V6.5L2.5 3.5V11L7 14.5V17L0 15L-7 17V14.5L-2.5 11V3.5L-17 6.5V3L-2.5-3V-11C-2.5-14-2-17 0-17Z" fill="rgba(20,22,27,.6)" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
    <path class="nose" d="M0-16L2-11H-2Z"/>`,
  vtol: `<path d="M0-17C2-17 2.5-14 2.5-11V-3L17 3V6.5L2.5 3.5V11L7 14.5V17L0 15L-7 17V14.5L-2.5 11V3.5L-17 6.5V3L-2.5-3V-11C-2.5-14-2-17 0-17Z" fill="rgba(20,22,27,.6)" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
    ${[[-10, -8], [10, -8], [-10, 11], [10, 11]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="4.5" fill="none" stroke="#fff" stroke-width="1.5"/>`).join('')}
    <path class="nose" d="M0-16L2-11H-2Z"/>`,
  rover: `<rect x="-9" y="-14" width="18" height="28" rx="4" fill="rgba(20,22,27,.6)" stroke="#fff" stroke-width="2"/>
    <path class="nose" d="M0-11L5-4H-5Z"/>`,
}

function vehicleElement() {
  const el = document.createElement('div')
  el.className = 'veh-marker'
  el.innerHTML = `<div class="ring"></div><svg class="quad" viewBox="-20 -20 40 40" aria-hidden="true">${SILHOUETTE.copter}</svg><span class="lbl">Aracuã-7</span>`
  return el
}

function wpElement(i: number) {
  const el = document.createElement('div')
  el.className = 'wp-marker'
  el.innerHTML = `<b>${wpName(i)}</b><small></small>`
  return el
}

export function MapView() {
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const s = station.settings
    const t0 = station.telem
    setupTiles(s.tileUrl, s.keepTiles)
    const map = new MlMap({
      container: box.current!,
      style: {
        version: 8,
        sources: { sat: { type: 'raster', tiles: [PROTOCOL_URL], tileSize: 256, maxzoom: 19, attribution: s.tileAttribution } },
        layers: [{ id: 'sat', type: 'raster', source: 'sat' }],
      },
      center: t0 && t0.lat ? [t0.lon, t0.lat] : [-46.63331, -23.55052],
      zoom: 17,
      dragRotate: false,
      pitchWithRotate: false,
      attributionControl: { compact: true },
    })
    map.touchZoomRotate.disableRotation()
    map.touchPitch.disable()

    const vehicle = new Marker({ element: vehicleElement() }).setLngLat(map.getCenter())
    const home = new Marker({ element: Object.assign(document.createElement('div'), { className: 'home-marker', textContent: 'H' }) })
    let wpMarkers: Marker[] = []
    const trail: [number, number][] = []
    let loaded = false

    station.mapApi = {
      center: () => ({ lat: map.getCenter().lat, lon: map.getCenter().lng }),
      zoom: () => map.getZoom(),
      bounds: () => {
        const b = map.getBounds()
        return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() }
      },
      zoomBy: (d) => map.easeTo({ zoom: map.getZoom() + d, duration: 250 }),
      flyTo: (p) => map.easeTo({ center: [p.lon, p.lat], duration: 600 }),
      fit: (pts) => {
        if (!pts.length) return
        const lons = pts.map((p) => p.lon), lats = pts.map((p) => p.lat)
        map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], {
          padding: { top: 90, bottom: 90, left: 110, right: 360 }, maxZoom: 19, duration: 600,
        })
      },
    }

    const src = (id: string) => map.getSource(id) as GeoJSONSource | undefined

    map.on('load', () => {
      for (const id of ['fence', 'fenceareas', 'drawing', 'trail', 'route', 'vmission', 'survey', 'voxels', 'voxels3d']) map.addSource(id, { type: 'geojson', data: EMPTY })
      map.addLayer({ id: 'voxels', type: 'circle', source: 'voxels', paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 0.6, 18, 2.2, 20, 5],
        'circle-color': ['case', ['==', ['get', 'c'], 0], 'rgba(0,229,255,0.35)',
          ['interpolate', ['linear'], ['get', 'u'], 0, '#3bd4ff', 15, '#7cf29c', 30, '#ffd23f', 45, '#ff6b3d']],
        'circle-opacity': ['case', ['==', ['get', 'c'], 0], 0.45, 0.9],
      } })
      // Áreas da geocerca: verde = permitida, vermelho = proibida; tracejado = rascunho ainda não enviado.
      const fcolor = ['match', ['get', 'kind'], 'inclusion', '#2fcf5f', '#ef4a3c'] as unknown as string
      map.addLayer({ id: 'fence-fill', type: 'fill', source: 'fenceareas', paint: { 'fill-color': fcolor, 'fill-opacity': ['match', ['get', 'kind'], 'inclusion', 0.06, 0.22] as unknown as number } })
      map.addLayer({ id: 'fence-line', type: 'line', source: 'fenceareas', filter: ['==', ['get', 'draft'], false], paint: { 'line-color': fcolor, 'line-width': 2.5 } })
      map.addLayer({ id: 'fence-draft', type: 'line', source: 'fenceareas', filter: ['==', ['get', 'draft'], true], paint: { 'line-color': fcolor, 'line-width': 2, 'line-dasharray': [3, 2] } })
      map.addLayer({ id: 'drawing-line', type: 'line', source: 'drawing', paint: { 'line-color': '#f2c94c', 'line-width': 2.5, 'line-dasharray': [2, 1.5] } })
      map.addLayer({ id: 'drawing-pts', type: 'circle', source: 'drawing', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#f2c94c', 'circle-stroke-color': '#1b1d21', 'circle-stroke-width': 1.5 } })
      map.addLayer({ id: 'voxels3d', type: 'fill-extrusion', source: 'voxels3d', layout: { visibility: 'none' }, paint: {
        'fill-extrusion-color': ['interpolate', ['linear'], ['get', 'u'], 0, '#3bd4ff', 15, '#7cf29c', 30, '#ffd23f', 45, '#ff6b3d'],
        'fill-extrusion-base': ['get', 'u'],
        'fill-extrusion-height': ['get', 'top'],
        'fill-extrusion-opacity': 0.85,
      } })
      map.addLayer({ id: 'fence', type: 'line', source: 'fence', paint: { 'line-color': '#ef4a3c', 'line-width': 2, 'line-dasharray': [4, 3], 'line-opacity': 0.8 } })
      map.addLayer({ id: 'survey-fill', type: 'fill', source: 'survey', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#3a78f2', 'fill-opacity': 0.12 } })
      map.addLayer({ id: 'survey-line', type: 'line', source: 'survey', paint: { 'line-color': '#8fb6ff', 'line-width': 1.5, 'line-dasharray': [3, 2] } })
      map.addLayer({ id: 'vmission', type: 'line', source: 'vmission', paint: { 'line-color': '#f2c94c', 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': 0.85 } })
      map.addLayer({ id: 'trail', type: 'line', source: 'trail', paint: { 'line-color': '#2fcf5f', 'line-width': 2.5, 'line-opacity': 0.8 } })
      map.addLayer({ id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 3, 'line-dasharray': [0.1, 2.2] } })
      loaded = true
      onMission()
      onMap(true)
      onParams()
      onUi()
    })

    // ---- veículo, trilha, seguir ----
    let lastFollow = 0
    const onTelemetry = () => {
      const t = station.telem
      if (!t || !t.lat) return
      vehicle.setLngLat([t.lon, t.lat])
      if (!vehicle.getElement().isConnected) vehicle.addTo(map)
      const el = vehicle.getElement()
      const svg = el.querySelector('.quad') as SVGElement
      const cls = vehicleClass(t)
      if (svg.dataset.cls !== cls) {
        svg.dataset.cls = cls
        svg.innerHTML = SILHOUETTE[cls]
      }
      svg.style.transform = `rotate(${t.heading}deg)`
      el.classList.toggle('armed', t.armed)
      el.classList.toggle('lost', !t.connected)
      el.classList.toggle('avoid', station.nearest < 6 && t.armed)
      if (t.home) {
        home.setLngLat([t.home.lon, t.home.lat])
        if (!home.getElement().isConnected) {
          home.addTo(map)
          onParams()
        }
      }
      const last = trail.at(-1)
      if (t.armed && t.alt_rel > 0.3 && (!last || Math.hypot((last[0] - t.lon) * 1e5, (last[1] - t.lat) * 1e5) > 1.5)) {
        trail.push([t.lon, t.lat])
        if (trail.length > 3000) trail.shift()
        if (loaded) src('trail')?.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: trail } })
      }
      const now = performance.now()
      if (station.follow && station.view === 'fly' && now - lastFollow > 900) {
        lastFollow = now
        map.easeTo({ center: [t.lon, t.lat], duration: 850, easing: (x) => x })
      }
      updateActiveWp()
    }

    // ---- missão ----
    const updateActiveWp = () => {
      const active = station.view === 'fly' ? station.activeWaypoint() : -1
      wpMarkers.forEach((m, i) => m.getElement().classList.toggle('cur', i === active))
    }
    const onMission = () => {
      const planning = station.view === 'plan'
      // Em voo vale o que está no veículo; planejando, o rascunho (e o do veículo tracejado).
      const plan = planning || !station.onVehicle.length ? station.plan : station.onVehicle
      if (wpMarkers.length !== plan.length) {
        wpMarkers.forEach((m) => m.remove())
        wpMarkers = plan.map((_, i) => {
          const m = new Marker({ element: wpElement(i), draggable: true })
          m.on('dragend', () => {
            const p = m.getLngLat()
            const next = station.plan.map((w, j) => (j === i ? { ...w, lat: p.lat, lon: p.lng } : w))
            station.setPlan(next, i)
          })
          m.getElement().addEventListener('click', (ev) => {
            ev.stopPropagation()
            station.select(i)
          })
          return m
        })
      }
      plan.forEach((w, i) => {
        const m = wpMarkers[i]
        m.setLngLat([w.lon, w.lat]).setDraggable(planning)
        const el = m.getElement()
        el.classList.toggle('sel', planning && i === station.selected)
        const drops = w.drop?.length ? `↓ ${w.drop.map((id) => station.payloadName(id)).join(', ')}` : ''
        ;(el.querySelector('small') as HTMLElement).textContent = planning ? `${Math.round(w.alt)} m${drops ? ` · ${drops}` : ''}` : drops
        el.classList.toggle('drop', !!drops)
        if (!el.isConnected) m.addTo(map)
      })
      updateActiveWp()
      if (!loaded) return
      const t = station.telem
      const coords = plan.map((w) => [w.lon, w.lat])
      if (planning && t?.home) coords.unshift([t.home.lon, t.home.lat])
      src('route')?.setData(coords.length > 1 ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } } : EMPTY)
      const vm = station.onVehicle
      const differs = planning && vm.length > 0 && (vm.length !== plan.length || vm.some((w, i) => w.lat !== plan[i].lat || w.lon !== plan[i].lon))
      const vcoords = vm.map((w) => [w.lon, w.lat])
      if (t?.home) vcoords.unshift([t.home.lon, t.home.lat])
      src('vmission')?.setData(differs && vcoords.length > 1 ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: vcoords } } : EMPTY)
      const sp = station.surveyPreview
      if (planning && sp) {
        const c = station.mapApi!.center()
        const pts = survey(c, sp.width, sp.height, sp.spacing, sp.northSouth)
        src('survey')?.setData({ type: 'FeatureCollection', features: [
          { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [rectangle(c, sp.width, sp.height)] } },
          { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts.map((p) => [p.lon, p.lat]) } },
        ] })
      } else src('survey')?.setData(EMPTY)
    }

    // ---- LiDAR ----
    let mapDirty = true
    const onMap = (force = false) => {
      mapDirty = true
      if (force) flushVoxels()
    }
    const flushVoxels = () => {
      if (!loaded || !mapDirty) return
      mapDirty = false
      const o = station.origin
      const v = station.vox
      if (!o || !v.e.length) {
        src('voxels')?.setData(EMPTY)
        src('voxels3d')?.setData(EMPTY)
        return
      }
      if (station.map3d) {
        // Blocos do tamanho do voxel; o chão fica de fora (o satélite já mostra).
        const h = station.voxelM / 2
        const blocks: GeoJSON.Feature[] = []
        for (let i = v.e.length - 1; i >= 0 && blocks.length < MAX_BLOCKS; i--) {
          if (v.cls[i] === 0) continue
          const c = station.voxelLatLon(i)
          const ring = [[-h, -h], [h, -h], [h, h], [-h, h], [-h, -h]].map(([de, dn]) => {
            const p = enuToLatLon(c, de, dn)
            return [p.lon, p.lat]
          })
          const u = v.u[i] * station.voxelM
          blocks.push({ type: 'Feature', properties: { u, top: u + station.voxelM }, geometry: { type: 'Polygon', coordinates: [ring] } })
        }
        src('voxels3d')?.setData({ type: 'FeatureCollection', features: blocks })
        return
      }
      const feats: GeoJSON.Feature[] = []
      const total = v.e.length
      const groundStep = Math.max(1, Math.ceil(station.groundCells / MAX_GROUND_POINTS))
      let obstacles = 0, ground = 0
      for (let i = total - 1; i >= 0; i--) {
        const c = v.cls[i]
        if (c === 0) {
          if (ground++ % groundStep) continue
        } else if (obstacles++ >= MAX_OBSTACLE_POINTS) continue
        const p: LatLon = station.voxelLatLon(i)
        feats.push({ type: 'Feature', properties: { c, u: v.u[i] * station.voxelM }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } })
      }
      src('voxels')?.setData({ type: 'FeatureCollection', features: feats })
    }
    const voxTimer = setInterval(flushVoxels, 1000)

    // ---- geocerca por polígonos ----
    const fenceFeatures = (f: FenceData, draft: boolean): GeoJSON.Feature[] => {
      const ring = (pts: { lat: number; lon: number }[]) => [...pts, pts[0]].map((p) => [p.lon, p.lat])
      return [
        ...f.inclusion.map((p) => ({ kind: 'inclusion', ring: ring(p) })),
        ...f.exclusion.map((p) => ({ kind: 'exclusion', ring: ring(p) })),
        ...f.circles_inclusion.map((c) => ({ kind: 'inclusion', ring: circle(c, c.radius, 64) })),
        ...f.circles_exclusion.map((c) => ({ kind: 'exclusion', ring: circle(c, c.radius, 64) })),
      ].map(({ kind, ring }) => ({ type: 'Feature', properties: { kind, draft }, geometry: { type: 'Polygon', coordinates: [ring] } }))
    }
    const onFence = () => {
      if (!loaded) return
      const planning = station.view === 'plan'
      const vf = station.vehicleFence
      const feats = vf ? fenceFeatures(vf, false) : []
      // Planejando: o rascunho aparece tracejado quando difere do que está no veículo.
      if (planning && !fenceIsEmpty(station.fenceDraft) && !sameFence(station.fenceDraft, vf)) feats.push(...fenceFeatures(station.fenceDraft, true))
      src('fenceareas')?.setData({ type: 'FeatureCollection', features: feats })
      const d = station.drawing
      const dfeats: GeoJSON.Feature[] = d ? [
        ...(d.pts.length > 1 ? [{ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: [...d.pts, ...(d.pts.length > 2 ? [d.pts[0]] : [])].map((p) => [p.lon, p.lat]) } }] : []),
        ...d.pts.map((p) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] } })),
      ] : []
      src('drawing')?.setData({ type: 'FeatureCollection', features: dfeats })
    }

    // ---- geocerca (dos parâmetros do veículo) ----
    const onParams = () => {
      const t = station.telem
      const r = station.params.get('FENCE_RADIUS')
      const on = station.params.get('FENCE_ENABLE')
      if (!loaded) return
      src('fence')?.setData(t?.home && r && on !== 0 ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: circle(t.home, r) } } : EMPTY)
    }

    // ---- 3D: inclina o mapa e libera a rotação (dois dedos no tablet, botão direito no mouse) ----
    let is3d = false
    const set3d = (on: boolean) => {
      is3d = on
      if (on) {
        map.dragRotate.enable()
        map.touchZoomRotate.enableRotation()
        map.touchPitch.enable()
        map.easeTo({ pitch: 60, duration: 600 })
      } else {
        map.dragRotate.disable()
        map.touchZoomRotate.disableRotation()
        map.touchPitch.disable()
        map.easeTo({ pitch: 0, bearing: 0, duration: 600 })
      }
      onMap(true)
    }

    const onUi = () => {
      if (loaded) {
        map.setLayoutProperty('voxels', 'visibility', station.lidarLayer && !station.map3d ? 'visible' : 'none')
        map.setLayoutProperty('voxels3d', 'visibility', station.lidarLayer && station.map3d ? 'visible' : 'none')
      }
      if (station.map3d !== is3d) set3d(station.map3d)
      map.getCanvas().style.cursor = station.view === 'plan' && (station.addMode || station.drawing) ? 'crosshair' : ''
      onMission()
      onFence()
    }

    map.on('dragstart', () => {
      if (station.follow) {
        station.follow = false
        station.emit('ui')
      }
    })
    map.on('click', (e: MapMouseEvent) => {
      if (station.view !== 'plan') return
      if (station.drawing) return station.addDrawPoint({ lat: e.lngLat.lat, lon: e.lngLat.lng })
      if (!station.addMode) return
      const alt = station.settings.wpAlt
      station.setPlan([...station.plan, { lat: e.lngLat.lat, lon: e.lngLat.lng, alt }], station.plan.length)
    })
    map.on('moveend', () => station.surveyPreview && station.view === 'plan' && onMission())

    // ---- pontos de lançamento (sistema de entrega) ----
    let dropMarkers = new Map<number, Marker>()
    const onPayload = () => {
      const log = station.payload?.log ?? []
      const keep = new Set<number>()
      for (const e of log.slice(0, 100)) {
        if (!e.lat && !e.lon) continue
        keep.add(e.n)
        let m = dropMarkers.get(e.n)
        if (!m) {
          const el = document.createElement('div')
          el.className = 'drop-marker'
          el.innerHTML = `<b>${e.n}</b>`
          el.title = tr('Lançamento nº {n} · {name} a {alt_rel} m', { n: e.n, name: e.name, alt_rel: e.alt_rel.toFixed(1) })
          m = new Marker({ element: el }).setLngLat([e.lon, e.lat]).addTo(map)
          dropMarkers.set(e.n, m)
        }
        m.getElement().classList.toggle('bad', e.confirmed === false)
      }
      for (const [n, m] of dropMarkers) if (!keep.has(n)) { m.remove(); dropMarkers.delete(n) }
    }
    // Nomes dos compartimentos aparecem nos waypoints com entrega.
    const onPayloadAll = () => { onPayload(); if (station.plan.some((w) => w.drop?.length)) onMission() }

    const offs = [
      station.subscribe('payload', onPayloadAll),
      station.subscribe('telemetry', onTelemetry),
      station.subscribe('mission', onMission),
      station.subscribe('fence', onFence),
      station.subscribe('map', () => onMap()),
      station.subscribe('params', onParams),
      station.subscribe('ui', onUi),
    ]
    onTelemetry()
    return () => {
      offs.forEach((o) => o())
      dropMarkers.forEach((m) => m.remove())
      dropMarkers = new Map()
      clearInterval(voxTimer)
      station.mapApi = null
      map.remove()
    }
  }, [])

  return <div ref={box} className="map" aria-label={tr('Mapa')} />
}
