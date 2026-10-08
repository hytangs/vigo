import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import App from '../../src/App'
import { emptyCityProject } from '../../src/app/projectState'
import '../../src/App.css'
import '../../src/index.css'

let requests = [], writes = [], activeWrites = 0, maxWrites = 0
const store = { schemaVersion: 'vigo.routing.store.v4', status: 'ready', routingEligibility: 'exact', fileName: 'test.sqlite', bytes: 10, connectionCount: 20, builtAt: '2026-01-01' }
const project = { ...emptyCityProject(), id: 'test-city', name: 'Test City', region: 'Synthetic fixture', summary: { feeds: 2, routes: 2, stops: 4, transferCandidates: 0, qualityScore: 100 }, osmStreetIndex: { status: 'ready', bytes: 10, builtAt: '2026-01-01' },
  feeds: ['first', 'second'].map(id => ({ id, name: id, source: 'local-file', provider: 'Test', importedAt: '2026-01-01', routeCount: 1, stopCount: 2, tripCount: 1, transferCandidates: 0, qualityScore: 100, requiredTables: {}, optionalTables: {}, warnings: [], routeMetrics: [], stopMetrics: [], routingStore: store })),
}
let projects = [project]
let releaseProjectRead, failProjectRead = false
const initialProjectRead = new Promise(resolve => { releaseProjectRead = resolve })
let config = { schemaVersion: 'vigo.config.v1', configured: true, setupRequired: false, storageRoot: '/fixture/cities', appearance: 'light', accent: 'graphite', basemap: 'none', canChangeStorageRoot: true, offline: { localServer: true, storageWritable: true, gtfsImport: true, offlineBasemap: true } }
window.fetch = async (input, options = {}) => {
  const url = String(input)
  requests.push(url)
  if (url === '/api/health') return Response.json({ ok: true, version: '0.5.0', config, offline: config.offline })
  if (url === '/api/config') {
    if (options.method === 'PATCH') {
      const change = JSON.parse(options.body); writes.push(change); activeWrites++; maxWrites = Math.max(maxWrites, activeWrites)
      await new Promise(resolve => setTimeout(resolve, 30))
      config = { ...config, ...change }; activeWrites--
    }
    return Response.json({ config })
  }
  if (url === '/api/projects') {
    await initialProjectRead
    return failProjectRead ? Response.json({ error: 'City library unavailable' }, { status: 503 }) : Response.json({ projects })
  }
  if (url === '/api/storage') return Response.json({ capacityBytes: 1024 ** 4, availableBytes: 17 * 1024 ** 3 })
  return Response.json({ error: 'Unexpected request: ' + url }, { status: 400 })
}
const root = createRoot(document.getElementById('root'))
flushSync(() => root.render(<App />))
const assert = (condition, message) => { if (!condition) throw Error(message) }
const until = async read => { const deadline = Date.now() + 5000; while (Date.now() < deadline) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 20)) } throw Error('Fixture timed out') }
window.checkAppSettings = async () => {
  assert(document.querySelector('.city-library-loading')?.textContent.includes('Loading Cities'), 'Initial City loading state is missing')
  assert(!document.querySelector('.city-library-empty'), 'Unread library shown as empty')
  releaseProjectRead()
  await until(() => document.querySelector('.city-library-card'))
  requests = []
  flushSync(() => document.querySelector('.city-library-actions button').click())
  await until(() => document.querySelector('.settings-themes'))
  await new Promise(resolve => setTimeout(resolve, 120))
  const unwanted = requests.filter(url => /street-prepare|routing-residency|street-residency|national-routing-merge|\/projects\/test-city(?:\?|$)/.test(url))
  assert(!unwanted.length, 'Settings activated routing or map loading: ' + unwanted.join(','))
  assert([...document.querySelectorAll('.sidebar-rail button')].every(button => !button.disabled), 'Settings traps a prepared City behind disabled navigation')
  const themes = [...document.querySelectorAll('.settings-theme')]
  flushSync(() => themes[1].click())
  flushSync(() => document.querySelectorAll('.settings-maps button')[0].click())
  flushSync(() => themes[0].click())
  await until(() => writes.length === 3 && activeWrites === 0)
  assert(maxWrites === 1, 'Preference writes race')
  assert(writes.every(write => Object.keys(write).length === 1), 'Preference change overwrites unrelated settings')
  assert(config.appearance === 'light' && config.basemap === 'offline', 'Rapid preferences lost')
  flushSync(() => document.querySelector('.sidebar-rail [aria-label="Route"]').click())
  assert(!document.querySelector('.empty-intake'), 'Route from Settings returns to City setup')
  await until(() => document.querySelector('.pathfinder-query'))
  projects = []
  failProjectRead = true
  flushSync(() => root.render(null))
  flushSync(() => root.render(<App />))
  await until(() => document.querySelector('.city-library [role=alert]'))
  assert(!document.querySelector('.city-library-empty'), 'Failed library shown as empty')
  failProjectRead = false
  flushSync(() => document.querySelector('.city-library [role=alert] button').click())
  await until(() => document.querySelector('.city-library-empty'))
  flushSync(() => document.querySelector('.city-library-actions button').click())
  await until(() => document.querySelector('.settings-themes'))
  assert(!document.querySelector('.setup-dialog'), 'Empty library launches setup instead of Settings')
  return { honestLibraryLoading: true, failedLibraryRetry: true, noRoutingLoad: true, noMapHydration: true, noAutomaticMerge: true, directRouteNavigation: true, serializedPartialPreferences: true, emptyLibrarySettings: true }
}
