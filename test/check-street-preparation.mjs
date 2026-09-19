import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { createStreetPreparationManager } from '../src/server/street-preparation.mjs'
import { startInMemoryVigoApi } from './helpers/in-memory-vigo-api.mjs'

// Failed Drive preparation cannot masquerade as full runtime readiness.
let ready = false, calls = 0, fail = true
const manager = createStreetPreparationManager({ pool: {
  isStreetPrepared: () => ready,
  async dispatch() {
    calls += 1
    if (fail) throw new Error('Driving snapshot unavailable')
    ready = true
    return { streetStore: { ready: true, accelerated: true, drive: { ready: true, accelerated: true } } }
  },
} })
const input = { projectId: 'unit', storePath: '/unit/streets', identity: 'v1', label: 'OSM' }
const first = manager.start(input)
assert.equal(manager.start(input), first)
await new Promise(setImmediate)
assert.equal(first.status, 'failed')
assert.match(first.error, /Driving/)
assert.equal(manager.start(input), first, 'Failure must stay visible until an explicit retry')
fail = false
const retried = manager.start({ ...input, retry: true })
await new Promise(setImmediate)
assert.equal(retried.status, 'complete')
assert.equal(manager.start(input), retried)
ready = false
const afterEviction = manager.start(input)
assert.notEqual(afterEviction.id, retried.id, 'An evicted worker must be prepared again')
await new Promise(setImmediate)
assert.equal(afterEviction.status, 'complete')
assert.equal(calls, 3)

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-street-background-'))
const projectsPath = path.join(root, 'projects')
const projectId = 'streets-only'
const meta = path.join(projectsPath, projectId, '.vigo')
let api
const post = (resident, leaseId = 'test-city') => api.requestJson(`/api/projects/${projectId}/street-residency`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resident, leaseId }),
})
try {
  await fs.mkdir(path.join(meta, 'osm'), { recursive: true })
  const store = new DatabaseSync(path.join(meta, 'osm', 'street-index.sqlite'))
  store.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const insert = store.prepare('INSERT INTO metadata VALUES(?,?)')
  insert.run('schemaVersion', JSON.stringify('vigo.street.store.v4'))
  insert.run('sourceModel', JSON.stringify('pbf'))
  store.close()
  await fs.writeFile(path.join(meta, 'project.json'), JSON.stringify({
    id: projectId, name: 'Streets only', schemaVersion: 'vigo.project.v1', feeds: [], jobs: [], artifacts: [],
    osmStreetIndex: { status: 'ready', fileName: 'city.osm.pbf', builtAt: '2026-09-13', schemaVersion: 'vigo.street.store.v4', cch: { ready: true } },
  }))
  api = await startInMemoryVigoApi({ repositoryRoot, environment: {
    VIGO_PROJECTS_DIR: projectsPath, VIGO_CONFIG_DIR: path.join(root, 'config'),
    VIGO_ROUTE_WORKER_URL: pathToFileURL(path.join(repositoryRoot, 'test/fixtures/mock-national-route-worker.mjs')).href,
    VIGO_MOCK_STREET_PREPARE_DELAY_MS: '1200', VIGO_ROUTE_PREWARM_IDLE_MS: '1000',
  } })
  const started = await post(true)
  assert.equal(started.status, 200, started.text)
  assert(['queued', 'running'].includes(started.body.job.status), 'Starting City preparation must return before the worker finishes')
  const again = await post(true, 'second-window')
  assert.equal(again.body.job.id, started.body.job.id, 'Two windows must share preparation')
  await post(false, 'second-window')
  const phases = new Set()
  let completed
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const polled = await api.requestJson(`/api/projects/${projectId}/national-gtfs-job?jobId=${started.body.job.id}`)
    assert.equal(polled.status, 200, polled.text)
    phases.add(polled.body.job.phase)
    if (polled.body.job.status === 'complete') { completed = polled.body.job; break }
    assert.notEqual(polled.body.job.status, 'failed', polled.text)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert(completed, 'Background preparation did not finish')
  assert(phases.has('Opening walking street snapshot'))
  assert(phases.has('Opening driving street snapshot'))
  assert.deepEqual(completed.result.modes, { walk: true, drive: true })
  const retained = await post(true)
  assert.equal(retained.body.job.id, completed.id, 'Ready City must reuse its live worker')
  assert.equal(retained.body.residency.leaseCount, 1, 'Refreshing a lease must not leak additional leases')
  const walk = await api.requestJson(`/api/projects/${projectId}/national-route`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'walk', departMinutes: 0, origin: { lon: 1, lat: 1 }, destination: { lon: 2, lat: 2 } }),
  })
  assert.equal(walk.status, 200, 'Walking must work without a timetable, not just prepare without one')
  assert.equal(walk.body.plan.travelMode, 'walk')
  const metadata = JSON.parse(await fs.readFile(path.join(meta, 'project.json'), 'utf8'))
  assert.deepEqual(metadata.jobs, [], 'Runtime preparation must not be saved as durable import readiness')
  assert.equal((await api.requestJson(`/api/projects/wrong-city/national-gtfs-job?jobId=${completed.id}`)).status, 404)
  await post(false)

  // When a timetable arrives, streets share that resident worker. Subsequent
  // transit-only admission must retain the Drive kernel already loaded there.
  await fs.mkdir(path.join(meta, 'routing'))
  const timetable = new DatabaseSync(path.join(meta, 'routing', 'project.sqlite'))
  timetable.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  timetable.prepare('INSERT INTO metadata VALUES(?,?)').run('schemaVersion', JSON.stringify('vigo.routing.store.v1'))
  timetable.prepare('INSERT INTO metadata VALUES(?,?)').run('transferSemanticsVersion', JSON.stringify('vigo.routing.transfers.v3'))
  timetable.close()
  await fs.writeFile(path.join(meta, 'project.json'), JSON.stringify({ ...metadata,
    routingStore: { status: 'ready', schemaVersion: 'vigo.routing.store.v1', fileName: 'project.sqlite' },
  }))
  const shared = await post(true)
  assert.equal(shared.status, 200, shared.text)
  assert.notEqual(shared.body.job.id, completed.id)
  let sharedJob = shared.body.job
  const sharedDeadline = Date.now() + 8_000
  while (sharedJob.status !== 'complete' && Date.now() < sharedDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    sharedJob = (await api.requestJson(`/api/projects/${projectId}/national-gtfs-job?jobId=${sharedJob.id}`)).body.job
    assert.notEqual(sharedJob.status, 'failed')
  }
  assert.equal(sharedJob.status, 'complete')
  const transit = await api.requestJson(`/api/projects/${projectId}/routing-residency`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resident: true, leaseId: 'transit', serviceDate: '2026-09-13' }),
  })
  assert.equal(transit.status, 200, transit.text)
  assert.equal(transit.body.residency.reachPreparation.ready, true)
  assert.equal((await post(true)).body.job.id, sharedJob.id, 'Transit access must not erase prepared Drive readiness')
  const runtime = (await api.requestJson('/api/health')).body.routingRuntime
  assert.equal(runtime.workers.find((worker) => worker.storeFile === 'project.sqlite').streetStore.drive.accelerated, true)
  await post(false)
  await api.stop()
  api = null
  console.log('Street preparation passed: nonblocking City start, both modes, shared work, residency, failure/retry, eviction, and no GTFS prerequisite.')
} finally {
  await api?.stop()
  await fs.rm(root, { recursive: true, force: true })
}
