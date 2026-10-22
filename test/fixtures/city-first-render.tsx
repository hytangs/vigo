import { createRoot } from 'react-dom/client'
import { VigoMap } from '../../src/VigoMap'
import type { MapPreview } from '../../src/domain'
import { Map } from '../../src/app/mapRuntime'
import { markCityNavigation } from '../../src/app/mapFirstRenderTelemetry'

/** Real Studio component: local transit must render while a basemap tile is stalled. */
export async function checkCityFirstRender(lateCatalog = false) {
  const container = document.createElement('div')
  container.style.cssText = 'position:relative;width:512px;height:512px'
  document.body.append(container)
  const css = document.createElement('style')
  css.textContent = '.vigo-map,.maplibre-canvas {width:100%;height:100%}'
  document.head.append(css)
  const root = createRoot(container)
  const originalFetch = window.fetch
  const originalAddSource = Map.prototype.addSource
  const originalSetStyle = Map.prototype.setStyle
  // Keep a source pending before the first global load event. This exercises
  // catalog arrival while the style is editable but isStyleLoaded() is false.
  Map.prototype.setStyle = function (style, options) {
    map = this
    if (lateCatalog && style && typeof style === 'object') {
      style = { ...style, sources: { ...style.sources, 'startup-pending': {
        type: 'vector', tiles: ['vigo://studio/pending-basemap/{z}/{x}/{y}.mvt'],
      } }, layers: [...style.layers, { id: 'startup-pending', type: 'fill', source: 'startup-pending', 'source-layer': 'water' }] }
    }
    return originalSetStyle.call(this, style, options)
  }
  let map: Map | undefined
  Map.prototype.addSource = function (...args) { map = this; return originalAddSource.apply(this, args) }
  window.fetch = async (input, init) => String(input).startsWith('https://tiles.openfreemap.org/styles/')
    ? new Response(JSON.stringify({ version: 8, sources: { openmaptiles: {
        type: 'vector', tiles: ['vigo://studio/pending-basemap/{z}/{x}/{y}.mvt'],
      } }, layers: [{ id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water' }] }))
    : originalFetch(input, init)
  const preview = { routes: [
    { id: 'network::rail', routeId: 'rail', shortName: 'R', color: '#da291c', coordinates: [], stopIds: [], points: [], tripCount: 200 },
    { id: 'network::bus', routeId: 'bus', shortName: 'B', color: '#ffc72c', coordinates: [], stopIds: [], points: [], tripCount: 80 },
  ], stops: [], stopPairs: [] } as unknown as MapPreview
  let ready: Record<string, unknown> | undefined
  const bridge = { postMessage(message: Record<string, unknown>) { if (message.action === 'mapReady' && Number(message.routeFeatures) >= 2) ready = message } }
  Object.assign(window, { vigoDesktop: bridge })
  try {
    markCityNavigation()
    const render = (catalogReady: boolean) => root.render(<VigoMap projectId="fixture" preview={catalogReady ? preview : { routes: [], stops: [], stopPairs: [] }} feedName="Fixture"
      networkTiles={catalogReady ? { scope: '__bundle__', revision: 'stalled-basemap', bounds: [[-0.005, -0.005], [0.005, 0.005]] } : undefined}
      layers={{ routes: true, stops: true, access: false, transfers: false }} networkLens="network"
      basemap="dark" appearance="light" selectedRouteId="" selectedStopId=""
      vehicleFrame={{ mode: 'schedule', vehicles: [], tripUpdateCount: 0, alertCount: 0 }}
      onSelectRoute={() => {}} onSelectStop={() => {}} />)
    render(!lateCatalog)
    const deadline = performance.now() + 10000
    if (lateCatalog) {
      while (!map?.getSource('startup-pending')) {
        if (performance.now() > deadline) throw Error('Pending basemap did not start before the catalog')
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      if (map.isStyleLoaded()) throw Error('The pending source must hold isStyleLoaded false')
      render(true)
    }
    while (!ready) {
      if (performance.now() > deadline) throw Error('Local transit waited for the stalled basemap')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    if (!map?.getSource('osm') || map.isSourceLoaded('osm')) throw Error('The fixture did not keep its basemap pending')
    if (Number(ready.routeFeatures) < 2) throw Error('Local transit routes did not render')
    return { localTransitBeforeBasemap: true, lateCatalog, routeFeatures: ready.routeFeatures }
  } finally {
    root.unmount()
    container.remove(); css.remove()
    Map.prototype.addSource = originalAddSource
    Map.prototype.setStyle = originalSetStyle
    window.fetch = originalFetch
    Reflect.deleteProperty(window, 'vigoDesktop')
  }
}
