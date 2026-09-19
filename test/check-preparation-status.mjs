import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { preparationState, preparationTasks, taskPercent, updateProjectJob } from '../src/app/preparation.ts'
import { buildRoutingActivity } from '../src/app/routingPlan.ts'

const job = (status, patch = {}) => ({
  id: 'osm-1', kind: 'national-osm-import', label: 'city.osm.pbf', status,
  progress: 0.45, createdAt: '2026-09-13T10:00:00Z', phase: 'Building street indexes', ...patch,
})
const kinds = ['national-osm-import']
assert.equal(preparationState(false, [], kinds).status, 'missing')
assert.equal(preparationState(false, [job('queued')], kinds).label, 'Queued')
assert.equal(preparationState(false, [job('running')], kinds).status, 'working')
assert.equal(preparationState(false, [job('running', { statusError: 'Connection lost' })], kinds).status, 'paused')
assert.equal(preparationState(false, [job('failed', { error: 'Invalid PBF' })], kinds).detail, 'Invalid PBF')
assert.equal(preparationState(false, [job('cancelled')], kinds).label, 'Cancelled')
assert.equal(preparationState(true, [job('complete')], kinds).status, 'ready')
assert.equal(preparationState(true, [job('failed')], kinds).status, 'ready', 'A failed replacement must not erase an existing ready network')
assert.equal(preparationState(false, [job('complete')], kinds).status, 'missing', 'Historical completion alone cannot establish current readiness')
assert.equal(taskPercent(job('queued')), undefined)
assert.equal(taskPercent(job('running', { progress: undefined })), undefined)
assert.equal(taskPercent(job('running', { progress: 1 })), 99, 'Only server completion can show 100%')
assert.equal(taskPercent(job('complete')), 100)
const recent = preparationTasks([
  job('failed', { id: 'old', createdAt: '2026-09-12T10:00:00Z' }), job('running'),
  job('running', { id: 'merge', kind: 'national-gtfs-merge' }),
], [], { 'osm-1': 'Connection lost' })
assert.deepEqual(recent.map((task) => task.id), ['osm-1', 'merge'])
assert.equal(recent[0].statusError, 'Connection lost')
const projects = [{ id: 'a', feeds: [], jobs: [] }, { id: 'b', feeds: [], jobs: [] }]
const updated = updateProjectJob(projects, 'a', job('running'))
assert.equal(updated[1], projects[1], 'A job update must not touch another City')
assert.equal(updated[0].feeds, projects[0].feeds, 'Job updates must retain feed identity')
assert.equal(updateProjectJob(updated, 'a', job('complete'))[0].jobs.length, 1)
assert.equal(projects[0].jobs.length, 0)

for (const routingMode of ['walk', 'drive']) {
  const routing = { routingMode, routingError: '', routingPlan: null, storeBackedRouting: false,
    routingStoreReady: false, hasOrigin: false, hasDestination: false, routingLoading: false,
    routingInputReady: false, routingServiceDate: '2026-09-13' }
  assert.equal(buildRoutingActivity({ ...routing, routingStreetState: 'missing' }).kind, 'blocked')
  assert.equal(buildRoutingActivity({ ...routing, routingStreetState: 'loading' }).title, 'Preparing walking and driving')
  assert.equal(buildRoutingActivity({ ...routing, routingStreetState: 'ready' }).title, 'Pick origin', 'Prepared street modes must not wait for a GTFS timetable')
}

const cacheDir = await mkdtemp(path.join(tmpdir(), 'vigo-preparation-check-'))
const server = await createServer({ configFile: false, cacheDir, plugins: [react()], server: { middlewareMode: true, hmr: false }, appType: 'custom' })
try {
  const { AnalyzePanel } = await server.ssrLoadModule('/src/components/AnalyzePanel.tsx')
  const { BackgroundTasks } = await server.ssrLoadModule('/src/components/BackgroundTasks.tsx')
  const props = {
    mode: 'single', origin: null, serviceDate: '2026-09-13', departMinutes: 480,
    maxWalkKm: 1.2, walkSpeedKph: 4.8, cutoffMinutes: 45, cases: [], feeds: [],
    comparisonFeedIds: [], routes: [], stops: [], analysis: null, preparationTasks: [],
    routingStoreAvailable: true, streetGraphAvailable: false,
  }
  const render = (patch) => renderToStaticMarkup(createElement(AnalyzePanel, { ...props, ...patch }))
  const missing = render({})
  assert.doesNotMatch(missing, /reach-data-setup|View tasks/)
  assert.match(missing, /class="reach-run" disabled/)
  const working = render({ preparationTasks: [job('running')] })
  assert.doesNotMatch(working, /reach-data-setup|View tasks/)
  assert.match(working, /Data is being prepared/)
  assert.doesNotMatch(working, /Import needed|Import OSM|Add an OSM/)
  assert.match(working, /class="reach-run" disabled/)
  const ready = render({ streetGraphAvailable: true })
  assert.match(ready, /Click the map to choose an origin/)
  const runnable = render({ streetGraphAvailable: true, origin: { label: 'Origin', coordinates: [0, 0], source: 'map' } })
  assert.doesNotMatch(runnable, /class="reach-run" disabled/)
  const comparing = render({ mode: 'compare', streetGraphAvailable: true, preparationTasks: [job('running', { kind: 'national-gtfs-import' })] })
  assert.match(comparing, /Data is being prepared/)
  const panel = (tasks) => renderToStaticMarkup(createElement(BackgroundTasks, { tasks, open: true }))
  assert.match(panel([job('running')]), /value="45"/)
  assert.doesNotMatch(panel([job('running', { progress: undefined })]), /<progress[^>]*value=/)
  assert.match(panel([job('running', { statusError: 'Connection lost' })]), /Reconnect to task/)
  assert.doesNotMatch(panel([job('failed')]), /Reconnect to task/)
  const schedules = panel([job('running', { kind: 'vehicle-schedules', label: 'Boston · 2026-09-16', phase: 'Loading schedules · 45/100 routes' })])
  assert.match(schedules, /Static vehicle schedules/)
  assert.match(schedules, /Loading schedules · 45\/100 routes/)
  assert.match(schedules, /value="45"/)
  assert.match(panel([job('failed', { kind: 'vehicle-schedules' })]), /Retry preparation/)
  assert.match(panel([job('complete', { kind: 'vehicle-schedules' })]), /Complete/)
  const streets = panel([job('running', { kind: 'street-runtime-prepare', progress: undefined, phase: 'Opening driving street snapshot' })])
  assert.match(streets, /Walking and driving/)
  assert.match(streets, /Opening driving street snapshot/)
  assert.doesNotMatch(streets, /<progress[^>]*value=/)
  assert.match(panel([job('failed', { kind: 'street-runtime-prepare' })]), /Retry preparation/)
  console.log('Preparation status passed: City isolation, queued/loading/processing/ready/failure states, reconnect, honest progress, and Reach gating.')
} finally {
  await server.close()
  await rm(cacheDir, { recursive: true, force: true })
}
