import React from 'react'
import { createRoot } from 'react-dom/client'
import { Map, addProtocol, removeProtocol } from '../../src/app/mapRuntime'
import { VigoMap } from '../../src/VigoMap'
import 'maplibre-gl/dist/maplibre-gl.css'

export async function runMapStartupChecks() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const style = document.createElement('style')
  style.textContent = '.map-stage,.maplibre-canvas{width:700px;height:600px;position:relative}'
  document.head.appendChild(style)
  const check = (value, message) => { if (!value) throw Error(message) }
  const pause = () => new Promise(resolve => setTimeout(resolve, 30))
  const wait = async (predicate, message) => {
    const until = performance.now() + 4000
    while (!predicate()) { if (performance.now() > until) throw Error(message); await pause() }
  }
  const addSource = Map.prototype.addSource, remove = Map.prototype.remove
  const instances = new Set(), pendingTiles = new Set(), rasterStartedAt = new WeakMap()
  let map, root, rasterRequests = 0, removedMaps = 0
  addProtocol('vigo-test-raster', (_request, controller) => {
    rasterRequests++
    return new Promise((_resolve, reject) => {
      const pending = { reject }
      pendingTiles.add(pending)
      controller.signal.addEventListener('abort', () => {
        pendingTiles.delete(pending)
        reject(new DOMException('Fixture tile cancelled', 'AbortError'))
      }, { once: true })
    })
  })
  Map.prototype.addSource = function(id, spec, ...args) {
    map = this
    instances.add(this)
    if (id === 'osm') rasterStartedAt.set(this, performance.now())
    return addSource.call(this, id, id === 'osm' ? { ...spec, tiles: ['vigo-test-raster://tiles/{z}/{x}/{y}.png'] } : spec, ...args)
  }
  Map.prototype.remove = function(...args) { removedMaps++; return remove.apply(this, args) }
  const empty = { type: 'FeatureCollection', features: [] }
  const analysisBounds = [-71.3,42.18,-70.9,42.56]
  const area = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { cutoffMinutes: 45 },
    geometry: { type: 'Polygon', coordinates: [[[-71.3,42.18],[-70.9,42.18],[-70.9,42.56],[-71.3,42.56],[-71.3,42.18]]] },
  }] }
  const analysis = { surface: { displayBounds: analysisBounds, contours: { baseline: empty, scenario: empty }, areas: { baseline: area, scenario: area } }, scenario: { routes: empty } }
  const preview = {
    routes: [{ id: 'R', routeId: 'R', shortName: 'R', longName: 'Fixture', color: '#007f76', stopIds: ['A','B'], tripCount: 1, coordinates: [[-71.06,42.36],[-71.04,42.36]], points: [] }],
    stops: [{ id: 'A', name: 'Boston A', lat: 42.36, lon: -71.06, x: 0, y: 0, routes: ['R'], tripCount: 1, transferScore: 0 }, { id: 'B', name: 'Boston B', lat: 42.36, lon: -71.04, x: 0, y: 0, routes: ['R'], tripCount: 1, transferScore: 0 }],
    stopPairs: [],
  }
  const origin = { label: 'From', source: 'map', coordinate: [-71.06,42.36] }
  const destination = { label: 'To', source: 'map', coordinate: [-71.04,42.36] }
  const base = {
    preview, feedName: 'Startup fixture', basemap: 'streets', appearance: 'light', networkLens: 'network',
    layers: { routes: false, stops: false, segments: false, transfers: false, coverage: false, scenario: false, access: false },
    selectedRouteId: '', selectedStopId: '', vehicleFrame: { mode: 'live', vehicles: [], tripUpdateCount: 0, alertCount: 0 },
    onSelectRoute() {}, onSelectStop() {},
  }
  const cases = [
    { name: 'Route before choosing endpoints', camera: 'city', props: { focusMode: 'routing', preview: { ...preview, routes: [] } } },
    { name: 'Analyze with a retained Reach result', camera: 'reach', props: { focusMode: 'scenario', reachResult: analysis, routingOrigin: origin, preview: { ...preview, routes: [] } } },
    { name: 'Network with all GTFS layers hidden', props: { focusMode: 'network' } },
    { name: 'Map without a GTFS preview', props: { focusMode: 'network', preview: { routes: [], stops: [], stopPairs: [] } } },
  ]
  const results = []
  try {
    for (const entry of cases) {
      map = null
      root = createRoot(container)
      let props = { ...base, ...entry.props }
      const render = patch => { props = { ...props, ...patch }; root.render(<VigoMap {...props} />) }
      const requestCount = rasterRequests
      const startedAt = performance.now()
      render()
      await wait(() => map?.getSource('osm'), `${entry.name}: raster source was never requested without visible GTFS features`)
      await wait(() => rasterRequests > requestCount, `${entry.name}: raster tiles did not start`)
      check(pendingTiles.size > 0 && !map.isSourceLoaded('osm'), 'Fixture must hold raster tiles pending')
      await wait(() => !map.isMoving(), `${entry.name}: initial camera did not settle`)
      if (entry.camera === 'city') {
        const center = map.getCenter()
        check(Math.abs(center.lng + 71.05) < 0.05 && Math.abs(center.lat - 42.36) < 0.05 && map.getZoom() > 8,
          'Fresh Route must open at the imported City even when its transit layers are hidden')
        check(preview.stops.every(stop => map.getBounds().contains([stop.lon, stop.lat])), 'Initial City camera must include imported stops')
      }
      if (entry.camera === 'reach') {
        check(map.getBounds().contains(analysisBounds.slice(0,2)) && map.getBounds().contains(analysisBounds.slice(2)),
          'A completed Analyze result must retain its Reach extent instead of zooming back to the origin pin')
      }
      const instance = map, count = instances.size, removals = removedMaps
      render({ focusMode: 'routing', reachResult: null, routingEnabled: true, routingOrigin: origin, routingDestination: destination })
      await wait(() => map.getLayer('vigo-routing-pins') && map.queryRenderedFeatures({ layers: ['vigo-routing-pins'] }).length === 2,
        `${entry.name}: pending basemap tiles blocked local Route endpoints`)
      render({ focusMode: 'scenario', routingEnabled: false, routingDestination: null, reachResult: analysis })
      await wait(() => map.getLayer('vigo-scenario-area') && map.queryRenderedFeatures({ layers: ['vigo-scenario-area'] }).length > 0,
        `${entry.name}: pending basemap tiles blocked the Reach surface`)
      render({ focusMode: 'routing', reachResult: null, routingEnabled: true, routingDestination: destination })
      await wait(() => map.queryRenderedFeatures({ layers: ['vigo-routing-pins'] }).length === 2, `${entry.name}: Route did not return`)
      check(map === instance && instances.size === count && removedMaps === removals,
        'Route and Analyze navigation must reuse the existing renderer')
      check(!container.querySelector('[role="alert"]'), 'Optional raster loading must not become a fatal map error')
      results.push({ view: entry.name, rasterStartMs: Number((rasterStartedAt.get(instance) - startedAt).toFixed(1)), camera: entry.camera ?? 'unconstrained' })
      root.unmount(); root = null
      await pause()
    }
    return { initialViews: results, rasterStartedWithoutVisibleGtfs: true, localLayersBeforeTiles: true, initialCityCamera: true, retainedReachCamera: true, routeAnalyzeRendererReused: true }
  } finally {
    root?.unmount()
    for (const pending of pendingTiles) pending.reject(new DOMException('Fixture complete', 'AbortError'))
    Map.prototype.addSource = addSource
    Map.prototype.remove = remove
    removeProtocol('vigo-test-raster')
    container.remove(); style.remove()
  }
}

export async function runMapRefreshChecks() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const style = document.createElement('style')
  style.textContent = '.map-stage,.maplibre-canvas{width:700px;height:600px;position:relative}'
  document.head.appendChild(style)
  const root = createRoot(container)
  const check = (value, message) => { if (!value) throw Error(message) }
  const pause = () => new Promise(resolve => setTimeout(resolve, 50))
  const wait = async predicate => {
    const until = performance.now() + 15000
    while (!predicate()) { if (performance.now() > until) throw Error('Map timed out: ' + predicate); await pause() }
  }
  const addSource = Map.prototype.addSource, fitBounds = Map.prototype.fitBounds
  let map, fits = 0
  const updates = []
  Map.prototype.addSource = function(id, ...args) {
    map = this
    const result = addSource.call(this, id, ...args)
    const source = this.getSource(id)
    if (source.setData) {
      const submit = source.setData
      source.setData = function(...values) { updates.push(id); return submit.apply(this, values) }
    }
    return result
  }
  Map.prototype.fitBounds = function(...args) { fits++; return fitBounds.apply(this, args) }
  const empty = { type: 'FeatureCollection', features: [] }
  const area = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { cutoffMinutes: 45 },
    geometry: { type: 'Polygon', coordinates: [[[-0.015,-0.015],[0.015,-0.015],[0.015,0.015],[-0.015,0.015],[-0.015,-0.015]]] },
  }] }
  const analysis = {
    surface: { displayBounds: [-0.02,-0.02,0.02,0.02], contours: { baseline: empty, scenario: empty }, areas: { baseline: area, scenario: area } },
    scenario: { routes: empty },
  }
  let props = {
    preview: { routes: [], stops: [], stopPairs: [] }, feedName: 'City X',
    layers: { routes: false, stops: true }, basemap: 'none', appearance: 'light', networkLens: 'network',
    selectedRouteId: '', selectedStopId: '', focusMode: 'routing',
    routingOrigin: { id: 'A', label: 'From', source: 'map', coordinate: [-0.01,0] },
    routingDestination: { id: 'B', label: 'To', source: 'map', coordinate: [0.01,0] },
    routingEnabled: true, onSelectRoute() {}, onSelectStop() {},
  }
  async function render(patch = {}) {
    props = { ...props, ...patch }
    // These represent parent rerenders from feeds or preparation progress.
    root.render(<VigoMap {...props} routingWaypoints={[]} scenarioSketchStops={[]} scenarioSketchGeometry={[]}
      vehicleFrame={props.vehicleFrame || { mode: 'live', vehicles: [], tripUpdateCount: 0, alertCount: 0, fetchedAt: new Date().toISOString() }} />)
    await pause()
    await wait(() => map?.loaded() && !map.isMoving())
  }
  try {
    await render()
    await wait(() => map.queryRenderedFeatures({ layers: ['vigo-routing-pins'] }).length > 0)
    map.jumpTo({ center: [0.003,0.002], zoom: 14 })
    const beforeRoute = { fits, updates: updates.length, center: map.getCenter().toArray(), zoom: map.getZoom() }
    for (let i = 0; i < 5; i++) await render()
    check(fits === beforeRoute.fits && updates.length === beforeRoute.updates, 'Background renders must not redraw Route layers or move its camera')
    check(JSON.stringify(map.getCenter().toArray()) === JSON.stringify(beforeRoute.center) && map.getZoom() === beforeRoute.zoom, 'Route pan/zoom must stay put')
    const latePreview = { routes: [], stopPairs: [], stops: [
      { id: 'late-a', name: 'Late A', lon: 10, lat: 45, routes: [], tripCount: 0, transferScore: 0 },
      { id: 'late-b', name: 'Late B', lon: 10.1, lat: 45.1, routes: [], tripCount: 0, transferScore: 0 },
    ] }
    await render({ preview: latePreview })
    check(fits === beforeRoute.fits && JSON.stringify(map.getCenter().toArray()) === JSON.stringify(beforeRoute.center)
      && map.getZoom() === beforeRoute.zoom, 'Late City preview data must not displace an existing Route camera')

    await render({ focusMode: 'scenario', reachResult: analysis, routingEnabled: false, routingDestination: null })
    await wait(() => map.queryRenderedFeatures({ layers: ['vigo-scenario-area'] }).length > 0)
    map.jumpTo({ center: [0.004,0.003], zoom: 15 })
    const beforeReach = { fits, updates: updates.length, center: map.getCenter().toArray(), zoom: map.getZoom() }
    for (let i = 0; i < 5; i++) await render()
    check(fits === beforeReach.fits && updates.length === beforeReach.updates, 'Background renders must not redraw Accessibility layers or refit the surface')
    for (const patch of [{ scenarioCutoffMinutes: 30 }, { scenarioView: 'comparison' }, { scenarioRenderMode: 'streets' }]) await render(patch)
    check(fits === beforeReach.fits, 'Changing display controls must not reset the camera')
    check(JSON.stringify(map.getCenter().toArray()) === JSON.stringify(beforeReach.center) && map.getZoom() === beforeReach.zoom, 'Accessibility pan/zoom must stay put')
    await render({ reachResult: { ...analysis, surface: { ...analysis.surface, displayBounds: [-0.01,-0.01,0.01,0.01] } } })
    check(fits === beforeReach.fits + 1, 'A newly computed accessibility result must still fit once')
    const resultCamera = { fits, center: map.getCenter().toArray(), zoom: map.getZoom() }
    await render({ preview: { ...latePreview, stops: latePreview.stops.map(stop => ({ ...stop, lon: stop.lon + 2 })) } })
    check(fits === resultCamera.fits && JSON.stringify(map.getCenter().toArray()) === JSON.stringify(resultCamera.center)
      && map.getZoom() === resultCamera.zoom, 'Late City preview data must not override a completed Analyze result extent')
    const indicatorFrame = { mode: 'live', tripUpdateCount: 1, alertCount: 0, vehicles: [{ id: 'V', source: 'live', coordinate: [0,0], serviceKey: 'R', routeId: 'R', routeShortName: 'R', routeColor: '#007f76', tripId: 'T', gapSeverity: 'critical', crowded: true, indicatorLabel: '30 min gap · scheduled 10 min · Full', card: { title: 'V', metrics: [] } }] }
    await render({ focusMode: 'network', reachResult: null, routingOrigin: null, preview: { routes: [], stops: [], stopPairs: [] }, layers: { routes: true, stops: false }, vehicleFrame: indicatorFrame })
    map.jumpTo({ center: [0,0], zoom: 14 })
    await wait(() => map.queryRenderedFeatures({ layers: ['vigo-vehicle-gap-ring'] }).length > 0)
    check(map.queryRenderedFeatures({ layers: ['vigo-vehicle-occupancy-ring'] }).length > 0, 'Crowding and gap rings render independently on the same vehicle')
    await render({ layers: { routes: false, stops: false } })
    check(map.getLayoutProperty('vigo-vehicle-gap-ring', 'visibility') === 'none', 'Vehicle layer toggle hides gap indicators too')
    return { routeRedrawsDuringRefresh: 0, accessibilityRedrawsDuringRefresh: 0, retainedPanZoom: true, newResultFocus: true, latePreviewPreservesFocusedCamera: true }
  } finally {
    root.unmount()
    Map.prototype.addSource = addSource
    Map.prototype.fitBounds = fitBounds
    container.remove(); style.remove()
  }
}
