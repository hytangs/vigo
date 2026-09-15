import React from 'react'
import { createRoot } from 'react-dom/client'
import { Map } from '../../src/app/mapRuntime'
import { VigoMap } from '../../src/VigoMap'
import 'maplibre-gl/dist/maplibre-gl.css'

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
      vehicleFrame={{ mode: 'live', vehicles: [], tripUpdateCount: 0, alertCount: 0, fetchedAt: new Date().toISOString() }} />)
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
    return { routeRedrawsDuringRefresh: 0, accessibilityRedrawsDuringRefresh: 0, retainedPanZoom: true, newResultFocus: true }
  } finally {
    root.unmount()
    Map.prototype.addSource = addSource
    Map.prototype.fitBounds = fitBounds
    container.remove(); style.remove()
  }
}
