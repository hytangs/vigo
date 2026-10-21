import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Map as MapLibreMap } from '../../src/app/mapRuntime'
import App from '../../src/App'
import { emptyCityProject } from '../../src/app/projectState'
import { city } from '../../src/state/city'
import { openNetworkView, openProject, openPathfinderView, openAnalyzeView } from '../../src/state/navigation'
import '../../src/App.css'
import '../../src/index.css'

const store = { schemaVersion: 'vigo.routing.store.v4', status: 'ready', routingEligibility: 'exact', fileName: 'test.sqlite', bytes: 10, connectionCount: 20, builtAt: '2026-01-01' }
const makeCity = id => ({ ...emptyCityProject(), id, name: id, storagePath: '/fixture/' + id, routingStore: store,
  summary: { feeds: 1, routes: 1, stops: 2, transferCandidates: 0, qualityScore: 100 },
  feeds: [{ id: 'feed', name: 'Transit', source: 'local-file', importedAt: '2026-01-01', routeCount: 1, stopCount: 2, tripCount: 1, requiredTables: {}, optionalTables: {}, warnings: [], routeMetrics: [], stopMetrics: [], routingStore: store }],
})
const projects = [makeCity('one')]
const config = { configured: true, setupRequired: false, storageRoot: '/fixture', appearance: 'light', accent: 'graphite', basemap: 'none', offline: { localServer: true, storageWritable: true } }
const saved = new Map()
let liveMap
const originalAddLayer = MapLibreMap.prototype.addLayer
MapLibreMap.prototype.addLayer = function(...args) { liveMap = this; return originalAddLayer.apply(this, args) }
window.fetch = async (input, options = {}) => {
  const url = new URL(String(input), location.href)
  if (url.pathname === '/api/health') return Response.json({ ok: true, version: 'test', config, offline: config.offline })
  if (url.pathname === '/api/config') return Response.json({ config })
  if (url.pathname === '/api/projects') return Response.json({ projects })
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/(.+))?$/)
  if (match) {
    const [, id, endpoint] = match
    if (!endpoint) return Response.json({ project: projects.find(p => p.id === id) })
    if (endpoint === 'scenarios') {
      const entry = saved.get(id) ?? { library: null, revision: 0 }
      if (options.method === 'PUT') {
        const body = JSON.parse(options.body)
        if (body.baseRevision !== entry.revision) return Response.json(entry, { status: 409 })
        saved.set(id, { library: body.library, revision: entry.revision + 1 })
      }
      return Response.json(saved.get(id) ?? entry)
    }
    if (endpoint === 'routing-residency') return Response.json({ residency: {} })
    if (endpoint === 'national-ready') return Response.json({routing:{ready:true}})
  }
  return Response.json({ error: 'No fixture data' }, { status: 404 })
}
flushSync(() => createRoot(document.getElementById('root')).render(<App />))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const check = (value, label) => { if (!value) throw Error(label) }
const until = async (read, label) => {
  for (let n = 0; n < 400; n++) { if (read()) return; await pause(25) }
  throw Error(label + ': ' + document.body.innerText)
}

window.checkTransitions = async () => {
  await until(() => city.get().projects.length === 1, 'Cities did not load')
  flushSync(() => openProject('one'))
  await until(() => liveMap?.isStyleLoaded(), 'Map did not load')
  await pause(700)
  liveMap.jumpTo({ center: [-71.05, 42.35], zoom: 11 })
  const canvas = liveMap.getCanvas()
  const rail = document.querySelector('.sidebar-rail')
  const frame = document.querySelector('.app-frame')
  const bounds = JSON.stringify(frame.getBoundingClientRect().toJSON())
  const camera = () => JSON.stringify([liveMap.getCenter(), liveMap.getZoom(), liveMap.getBearing(), liveMap.getPitch()])
  const initialCamera = camera()
  const failures = new Set()
  for (const name of ['Route', 'Reach', 'Network', 'Reach', 'Route', 'Network']) {
    const button = rail.querySelector(`[aria-label="${name === 'Reach' ? 'Analyze' : name}"]`)
    button.focus()
    flushSync(() => button.click())
    check(document.activeElement === button, 'Navigation lost keyboard focus on ' + name)
    for (let n = 0; n < 24; n++) {
      await new Promise(requestAnimationFrame)
      if (document.querySelector('.sidebar-rail') !== rail) failures.add('Navigation rail remounted on ' + name)
      if (document.querySelector('.maplibregl-canvas') !== canvas) failures.add('Map remounted on ' + name)
      if (JSON.stringify(frame.getBoundingClientRect().toJSON()) !== bounds) failures.add('Frame moved on ' + name)
      if (camera() !== initialCamera) failures.add('Camera moved on ' + name)
      const panel = document.querySelector(name === 'Network' ? '.agency-panel' : '.sidebar-panel')
      if (getComputedStyle(panel).transform !== 'none') failures.add('Panel frame animates on ' + name)
    }
  }
  for (const button of document.querySelectorAll('.agency-tabs button')) {
    check(button.querySelector('svg'), 'Network tab icon missing')
    const label = button.querySelector('span')
    check(label.scrollWidth <= label.clientWidth, 'Network tab label truncated')
  }
  const more = document.querySelector('.agency-more > summary').getBoundingClientRect()
  check(more.right <= document.querySelector('.agency-panel').getBoundingClientRect().right, 'Network tools clipped')
  check(!failures.size, [...failures].join('; '))
  return { ok: true, transitions: 6, framesPerTransition: 24 }
}

window.showWorkspace = name => { flushSync(name === 'Route' ? openPathfinderView : name === 'Reach' ? openAnalyzeView : openNetworkView) }
