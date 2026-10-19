import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Map as MapLibreMap } from '../../src/app/mapRuntime'
import App from '../../src/App'
import { emptyCityProject } from '../../src/app/projectState'
import { city } from '../../src/state/city'
import { shell, setQuery } from '../../src/state/shell'
import { route, routingNetwork, routeScenario, clearRouting } from '../../src/state/route'
import { analyze, analysisPointFromMap, changeReachMaxWalkKm } from '../../src/state/analyze'
import { scenarioLibrary } from '../../src/state/scenarios'
import { openProject, openPathfinderView, openAnalyzeView, applyCitySelection } from '../../src/state/navigation'
import '../../src/App.css'
import '../../src/index.css'

const store = { schemaVersion: 'vigo.routing.store.v4', status: 'ready', routingEligibility: 'exact', fileName: 'test.sqlite', bytes: 10, connectionCount: 20, builtAt: '2026-01-01' }
const makeCity = id => ({ ...emptyCityProject(), id, name: id, storagePath: '/fixture/' + id, routingStore: store,
  summary: { feeds: 1, routes: 1, stops: 2, transferCandidates: 0, qualityScore: 100 },
  feeds: [{ id: 'feed', name: 'Transit', source: 'local-file', importedAt: '2026-01-01', routeCount: 1, stopCount: 2, tripCount: 1, requiredTables: {}, optionalTables: {}, warnings: [], routeMetrics: [], stopMetrics: [], routingStore: store }],
})
const projects = [makeCity('one'), makeCity('two')]
const config = { configured: true, setupRequired: false, storageRoot: '/fixture', appearance: 'light', accent: 'graphite', basemap: 'none', offline: { localServer: true, storageWritable: true } }
const saved = new Map()
const placeRequests = []
let liveMap, cameraFits = 0
const originalAddControl = MapLibreMap.prototype.addControl
MapLibreMap.prototype.addControl = function(...args) { liveMap = this; return originalAddControl.apply(this, args) }
const originalFitBounds = MapLibreMap.prototype.fitBounds
MapLibreMap.prototype.fitBounds = function(...args) { cameraFits++; return originalFitBounds.apply(this, args) }
let failDetail = false, detailReads = 0
window.fetch = async (input, options = {}) => {
  const url = new URL(String(input), location.href)
  if (url.pathname === '/api/health') return Response.json({ ok: true, version: 'test', config, offline: config.offline })
  if (url.pathname === '/api/config') return Response.json({ config })
  if (url.pathname === '/api/projects') return Response.json({ projects })
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/(.+))?$/)
  if (match) {
    const [, id, endpoint] = match
    if (!endpoint) {
      detailReads++
      return failDetail ? Response.json({ error: 'City temporarily unavailable' }, { status: 503 }) : Response.json({ project: projects.find(p => p.id === id) })
    }
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
    if (endpoint === 'place') return url.searchParams.has('points')
      ? new Promise(resolve => placeRequests.push({ signal: options.signal, reply: labels => resolve(Response.json({ places: labels.map(label => label ? { label } : null) })) }))
      : Response.json({ places: [] })
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
window.checkStores = async () => {
  await until(() => city.get().projects.length === 2, 'Cities did not load')
  flushSync(() => { openProject('one'); openPathfinderView() })
  await until(() => document.querySelector('.maplibregl-canvas'), 'Map did not mount')
  await until(() => scenarioLibrary().saveState === 'saved', 'Scenarios did not load')
  const canvas = document.querySelector('.maplibregl-canvas')
  await pause(700)
  const counts = () => ({ ...window.__vigoRenderCounts })
  const before = counts()
  const start = performance.now()
  for (let n = 0; n < 30; n++) flushSync(() => setQuery('station ' + n))
  const after = counts()
  for (const name of ['App', 'RouteSurface', 'VigoMap']) check(after[name] === before[name], 'Search re-rendered ' + name + ': ' + JSON.stringify({ before, after }))
  const searchMs = performance.now() - start
  flushSync(() => setQuery(''))

  // Use the actual search field and Enter handler, while local naming is slow.
  const search = text => {
    flushSync(() => setQuery(text))
    flushSync(() => document.querySelector('.search-palette input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  }
  search('42.30,-71.00 to 42.30,-71.10')
  await until(() => placeRequests.length === 1 && liveMap.getBounds().contains([-71, 42.3]), 'First coordinate search did not move the map')
  await pause(500)
  const firstFits = cameraFits
  const firstNames = placeRequests[0]
  search('41,11 to 41.01,11.01')
  await until(() => placeRequests.length === 2 && cameraFits > firstFits, 'Second coordinates with the same role labels did not reframe the map')
  await until(() => liveMap.getBounds().contains([11, 41]) && liveMap.getBounds().contains([11.01, 41.01]), 'Map did not reach the new endpoints')
  await pause(500)
  check(liveMap.getZoom() > 12, 'Typed coordinates should frame the endpoints, not retain the map-click overview zoom')
  const namedFits = cameraFits
  const rawOrigin = route.get().routingOrigin
  placeRequests[1].reply(['New Street & Cross Street', 'Market Square'])
  await until(() => document.querySelector('.pathfinder-location-stack')?.textContent.includes('New Street & Cross Street'), 'Coordinate labels did not resolve in the real sidebar')
  check(document.body.textContent.includes('Market Square'), 'Destination name missing')
  check(route.get().routingOrigin === rawOrigin, 'Naming replaced the engine input')
  firstNames.reply(['Old Street', 'Old destination'])
  await pause(100)
  check(!document.body.textContent.includes('Old Street'), 'An older search replaced the displayed location')
  check(cameraFits === namedFits, 'A label-only response moved the camera again')
  search('41,11 to 41.01,11.01')
  await until(() => cameraFits > namedFits, 'Resubmitting a journey did not focus already-visible endpoints')
  await pause(500)
  check(placeRequests.length === 2, 'Unchanged coordinates should reuse their resolved local names')
  check(document.querySelector('.maplibregl-canvas') === canvas, 'Coordinate search remounted the map')
  window.coordinateSearchEvidence = { origin: [11, 41], destination: [11.01, 41.01], labels: ['New Street & Cross Street', 'Market Square'], center: liveMap.getCenter().toArray() }
  await new Promise(resolve => { window.coordinateSearchCaptured = resolve; window.coordinateSearchScreenshot = true })
  flushSync(clearRouting)

  // Saved scenarios still flow through the persistence owner to the workspace stores.
  flushSync(() => scenarioLibrary().setScenarioDrafts(current => [{ ...current[0], name: 'Saved plan' }]))
  await until(() => saved.get('one')?.library.scenarios[0].name === 'Saved plan', 'Scenario edit did not save')
  const id = scenarioLibrary().scenarioDrafts[0].id
  flushSync(() => routingNetwork().onChange(id))
  await until(() => document.querySelector('[aria-label="Route network"]')?.value === id, 'Route scenario selection did not update')
  check(routeScenario().request?.feedIds.join() === 'feed', 'Route scenario lost its timetable group')
  check(routeScenario().request?.scenario.name === 'Saved plan', 'Route scenario request used an old plan')

  flushSync(openAnalyzeView)
  await until(() => document.querySelector('.reach-surface'), 'Analyze did not open')
  check(document.querySelector('.maplibregl-canvas') === canvas, 'Workspace change remounted the map')
  await pause(100)
  const analyzeBefore = counts()
  flushSync(() => changeReachMaxWalkKm(0.8))
  await pause(20)
  check(counts().App === analyzeBefore.App, 'Analyze settings re-rendered the shell')
  check(counts().RouteSurface === analyzeBefore.RouteSurface, 'Non-map Analyze setting re-rendered map')
  flushSync(() => analysisPointFromMap({ coordinate: [4.9, 52.37], label: 'Canal Street', source: 'map', named: true }))
  check(analyze.get().analysisOrigin?.label === 'Canal Street', 'Named coordinate lost its street label')

  const oldSetter = scenarioLibrary().setScenarioDrafts
  flushSync(() => applyCitySelection('two'))
  await until(() => scenarioLibrary().saveState === 'saved', 'Second City did not load')
  flushSync(() => oldSetter(current => [{ ...current[0], name: 'Wrong City' }]))
  check(scenarioLibrary().scenarioDrafts[0].name !== 'Wrong City', 'Old City callback changed the new City')
  check(route.get().routeScenarioId === '' && !analyze.get().analysisOrigin, 'City switch retained prior workspace inputs')
  failDetail = true
  const readsBefore = detailReads
  flushSync(() => openProject('one'))
  await until(() => shell.get().apiError.includes('temporarily unavailable'), 'City load failure did not surface')
  await pause(250)
  check(detailReads - readsBefore === 1, 'Failed City loading retried in a render loop')
  return { passed: true, failedLoadBounded: true, unrelatedSearchUpdates: 30, shellAndMapRenders: 0, searchUpdateMs: searchMs, persistentMap: true, savedScenarios: true, scenarioRouting: true, namedCoordinate: true, coordinateSearch: window.coordinateSearchEvidence, cityIsolation: true }
}
