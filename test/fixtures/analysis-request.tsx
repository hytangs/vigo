import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import App from '../../src/App'
import { emptyCityProject } from '../../src/app/projectState'
import '../../src/App.css'
import '../../src/index.css'

const requests = []
const store = { schemaVersion: 'vigo.routing.store.v4', status: 'ready', routingEligibility: 'exact', fileName: 'test.sqlite', bytes: 10, connectionCount: 20, builtAt: '2026-01-01' }
const project = { ...emptyCityProject(), id: 'test-city', name: 'Test City', region: 'Synthetic fixture', routingStore: store,
  summary: { feeds: 2, routes: 2, stops: 4, transferCandidates: 0, qualityScore: 100 }, osmStreetIndex: { status: 'ready', bytes: 10, builtAt: '2026-01-01' },
  feeds: ['first', 'second'].map(id => ({ id, name: id, source: 'local-file', provider: 'Test', importedAt: '2026-01-01', routeCount: 1, stopCount: 2, tripCount: 1, transferCandidates: 0, qualityScore: 100, requiredTables: {}, optionalTables: {}, warnings: [], routeMetrics: [], stopMetrics: [], routingStore: store })),
}
const config = { schemaVersion: 'vigo.config.v1', configured: true, setupRequired: false, storageRoot: '/fixture/cities', appearance: 'light', accent: 'graphite', basemap: 'none', offline: { localServer: true, storageWritable: true } }
let savedScenarios = { library: null, revision: 0 }
window.fetch = async (input, options = {}) => {
  const url = String(input)
  if (url === '/api/health') return Response.json({ ok: true, version: '0.5.0', config, offline: config.offline })
  if (url === '/api/config') return Response.json({ config })
  if (url === '/api/projects') return Response.json({ projects: [project] })
  if (url === '/api/projects/test-city') return Response.json({ project })
  if (url === '/api/projects/test-city/scenarios') {
    if (!options.method || options.method === 'GET') return Response.json(savedScenarios)
    const body = JSON.parse(options.body)
    savedScenarios = { revision: savedScenarios.revision + 1, library: { ...body.library, revision: savedScenarios.revision + 1 } }
    return Response.json(savedScenarios)
  }
  if (url === '/api/projects/test-city/reach') {
    requests.push(JSON.parse(options.body))
    // This fixture checks App request wiring; engine computation has its own real HTTP tests.
    return Response.json({ error: 'Request recorded' }, { status: 400 })
  }
  return Response.json({ error: 'Unused fixture endpoint: ' + url }, { status: 400 })
}
flushSync(() => createRoot(document.getElementById('root')).render(<App />))
const assert = (condition, message) => { if (!condition) throw Error(message) }
const until = async read => {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 20)) }
  throw Error('Fixture timed out: ' + document.body.innerText)
}
function fill(element, value) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, String(value))
  flushSync(() => element.dispatchEvent(new Event('input', { bubbles: true })))
}
function field(name) {
  return [...document.querySelectorAll('.reach-settings-list label')].find(label => label.querySelector('span')?.textContent === name).querySelector('input')
}
window.checkAnalysisRequest = async () => {
  await until(() => document.querySelector('.city-card-open'))
  flushSync(() => document.querySelector('.city-card-open').click())
  await until(() => document.querySelector('.sidebar-rail [aria-label="Analyze"]'))
  flushSync(() => document.querySelector('.sidebar-rail [aria-label="Analyze"]').click())
  await until(() => document.querySelector('.analysis-origin-toggle'))
  flushSync(() => document.querySelector('.analysis-origin-toggle').click())
  document.querySelector('.analysis-origin-coordinate-disclosure').open = true
  fill(document.querySelector('input[min="-90"]'), 42.360123456)
  fill(document.querySelector('input[min="-180"]'), -71.058987654)
  flushSync(() => document.querySelector('.analysis-origin-confirm').click())
  await until(() => !document.querySelector('.reach-run').disabled)
  document.querySelector('.reach-advanced').open = true
  fill(field('Time budget'), 37.25); fill(field('Maximum transit rides'), 1)
  fill(field('Final walk limit'), 0.35); fill(field('Walking speed'), 4.65)
  flushSync(() => document.querySelector('.reach-run').click())
  await until(() => requests.length === 1 && !document.querySelector('.reach-run').textContent.includes('Cancel'))
  flushSync(() => [...document.querySelectorAll('.reach-mode-tabs button')].find(button => button.textContent === 'Compare').click())
  for (const box of document.querySelectorAll('.reach-comparison-feed-option input')) {
    if (!box.checked) flushSync(() => box.click())
  }
  await until(() => !document.querySelector('.reach-run').disabled)
  flushSync(() => document.querySelector('.reach-run').click())
  // Compare measures the reference (the Baseline group) once, then each selected timetable against it.
  await until(() => requests.length === 4 && !document.querySelector('.reach-run').textContent.includes('Cancel'))
  assert(requests[1].feedIds.join() === 'first,second' && !requests[1].baselineFeedIds, 'Compare did not measure its reference first')
  assert(requests.slice(2).every(request => request.baselineFeedIds?.join() === 'first,second' && request.feedIds.length === 1), 'Compare variants lost their reference')
  // A single run adds round-minute display bands below the exact budget; comparisons compute the budget only.
  assert(JSON.stringify(requests[0].cutoffsMinutes) === '[10,20,30,37.25]', 'Single Reach must band below the exact budget')
  for (const request of requests.slice(1)) {
    assert(JSON.stringify(request.cutoffsMinutes) === '[37.25]', 'App computed an unrequested time window')
  }
  for (const request of requests) {
    assert(request.maxTransfers === 0 && request.maxWalkKm === 0.35 && request.walkSpeedKph === 4.65, 'App lost precise travel limits')
    assert(request.origin.coordinate[0] === -71.058987654 && request.origin.coordinate[1] === 42.360123456, 'Origin precision was lost')
  }
  fill(field('Maximum transit rides'), '')
  flushSync(() => document.querySelector('.reach-run').click())
  await until(() => requests.length === 7 && !document.querySelector('.reach-run').textContent.includes('Cancel'))
  assert(requests.slice(4).every(request => !('maxTransfers' in request)), 'Automatic ride limit was serialized as a number')
  return { singleAndComparison: true, exactLimits: true, noHiddenWindow: true, automaticLimit: true, requests: requests.length }
}
