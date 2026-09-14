import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startInMemoryVigoApi } from './helpers/in-memory-vigo-api.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-national-runtime-'))
const projectsPath = path.join(folder, 'projects')
const configPath = path.join(folder, 'config')
const projectIds = ['runtime-a', 'runtime-b', 'runtime-c']
let apiRuntime
const fixtureTimestamp = new Date('2026-01-01T00:00:00.000Z')

function fixtureProject(projectId) {
  return {
    id: projectId,
    schemaVersion: 'vigo.project.v1',
    name: projectId,
    feeds: [],
    jobs: [],
    artifacts: [],
    routingStore: {
      schemaVersion: 'vigo.routing.store.v1',
      status: 'ready',
      fileName: 'project.sqlite',
    },
  }
}

async function writeFixtureProject(projectId) {
  const metaPath = path.join(projectsPath, projectId, '.vigo')
  const storePath = path.join(metaPath, 'routing', 'project.sqlite')
  await fs.mkdir(path.join(metaPath, 'routing'), { recursive: true })
  await fs.writeFile(path.join(metaPath, 'project.json'), `${JSON.stringify(fixtureProject(projectId))}\n`)
  const database = new DatabaseSync(storePath)
  try {
    database.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const insert = database.prepare('INSERT INTO metadata(key,value) VALUES(?,?)')
    insert.run('schemaVersion', JSON.stringify('vigo.routing.store.v1'))
    insert.run(
      'sourceFingerprint',
      JSON.stringify(`${projectId}:routing`),
    )
    insert.run('storeId', JSON.stringify(projectId))
    insert.run('transferSemanticsVersion', JSON.stringify('vigo.routing.transfers.v3'))
  } finally {
    database.close()
  }
  await fs.utimes(storePath, fixtureTimestamp, fixtureTimestamp)
}

async function startApi() {
  apiRuntime = await startInMemoryVigoApi({
    repositoryRoot,
    environment: {
      VIGO_PROJECTS_DIR: projectsPath,
      VIGO_CONFIG_DIR: configPath,
      VIGO_ROUTE_WORKER_URL: pathToFileURL(path.join(repositoryRoot, 'test', 'fixtures', 'mock-national-route-worker.mjs')).href,
      VIGO_ROUTE_WORKER_IDLE_MS: '250',
      VIGO_ROUTE_WORKER_MAX_STORES: '2',
      // Give the fixture a deterministic margin between its cooperative
      // short-job completion and the forced-restart boundary. Production keeps
      // the lower default; this check validates the relative lifecycle rules.
      VIGO_ROUTE_CANCEL_GRACE_MS: '1000',
    },
  })
  return apiRuntime.baseUrl
}

async function postRoute(apiUrl, projectId, body = {}, signal) {
  const response = await apiRuntime.fetch(
    new URL(`api/projects/${projectId}/national-route`, apiUrl),
    {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      origin: {
        lat: 46.2,
        lon: 6.1,
        stopId: 'fixture-origin',
        source: 'national-search',
      },
      destination: {
        lat: 47.4,
        lon: 8.5,
        stopId: 'fixture-destination',
        source: 'national-search',
      },
      departMinutes: 480,
      ...body,
    }),
    signal,
    },
  )
  if (response.status !== 200) assert.fail(`Route returned ${response.status}: ${await response.text()}`)
  return response.json()
}

async function health(apiUrl) {
  const startedAt = performance.now()
  const response = await apiRuntime.fetch(new URL('api/health', apiUrl))
  const elapsedMs = performance.now() - startedAt
  assert.equal(response.status, 200)
  return { body: await response.json(), elapsedMs }
}

async function waitForActiveRoute(apiUrl, workerInstance, timeoutMs = 1_000) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const snapshot = await health(apiUrl)
    const worker = snapshot.body.routingRuntime.workers.find(
      (candidate) => candidate.workerInstance === workerInstance,
    )
    if (worker?.active === true && worker.activeOperation === 'route') return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`Route did not become active within ${timeoutMs} ms.`)
}

try {
  await Promise.all(projectIds.map(writeFixtureProject))
  const apiUrl = await startApi()
  const baselineHealth = await health(apiUrl)
  assert.equal(baselineHealth.body.routingRuntime.workerCount, 0)

  const first = await postRoute(apiUrl, projectIds[0])
  const second = await postRoute(apiUrl, projectIds[0])
  assert.notEqual(second.plan.id, first.plan.id, 'Repeated Route requests must compute fresh results.')
  assert.equal(
    second.plan.diagnostics.workerInstance,
    first.plan.diagnostics.workerInstance,
    'Normal requests for one store must reuse its warm worker.',
  )

  const quickController = new AbortController()
  const quickObsoleteRoute = postRoute(
    apiUrl,
    projectIds[0],
    { departMinutes: 481, testDelayMs: 200 },
    quickController.signal,
  )
  await waitForActiveRoute(apiUrl, first.plan.diagnostics.workerInstance)
  quickController.abort()
  await assert.rejects(quickObsoleteRoute, (error) => error?.name === 'AbortError')
  const quickReplacement = await postRoute(apiUrl, projectIds[0], { departMinutes: 482 })
  assert.equal(
    quickReplacement.plan.diagnostics.workerInstance,
    first.plan.diagnostics.workerInstance,
    'Cancelling an ordinary short route must preserve the prepared worker and discard only the obsolete result.',
  )
  const afterQuickCancellation = await health(apiUrl)
  const preservedWorker = afterQuickCancellation.body.routingRuntime.workers.find(
    (worker) => worker.workerInstance === first.plan.diagnostics.workerInstance,
  )
  assert.equal(preservedWorker?.abandonedJobs, 1)
  assert.equal(preservedWorker?.forcedCancellationRestarts, 0)

  const slowController = new AbortController()
  const slowRoute = postRoute(apiUrl, projectIds[0], { testDelayMs: 5_000 }, slowController.signal)
  await new Promise((resolve) => setTimeout(resolve, 80))
  const duringSlow = await health(apiUrl)
  assert(duringSlow.elapsedMs < 250, `Health took ${duringSlow.elapsedMs.toFixed(1)} ms while route worker was busy.`)
  assert.equal(duringSlow.body.ok, true)
  slowController.abort()
  await assert.rejects(slowRoute, (error) => error?.name === 'AbortError')

  const afterAbortStartedAt = performance.now()
  const afterAbort = await postRoute(apiUrl, projectIds[0], { departMinutes: 481 })
  const afterAbortMs = performance.now() - afterAbortStartedAt
  assert(afterAbortMs < 2_500, `Replacement worker took ${afterAbortMs.toFixed(1)} ms after cancellation.`)
  assert.notEqual(
    afterAbort.plan.diagnostics.workerInstance,
    first.plan.diagnostics.workerInstance,
    'A route exceeding the bounded cancellation grace must restart only that store worker.',
  )
  const afterForcedRestart = await health(apiUrl)
  const replacementWorker = afterForcedRestart.body.routingRuntime.workers.find(
    (worker) => worker.workerInstance === afterAbort.plan.diagnostics.workerInstance,
  )
  assert.equal(replacementWorker?.prepared, false, 'A lazy replacement route must not report a separate timetable prewarm that did not occur.')
  assert.equal(replacementWorker?.preparedContext, undefined)
  assert.equal(replacementWorker?.lastRouteContext?.operation, 'route')
  assert.equal(replacementWorker?.lastOperation, 'route')
  assert.equal(
    replacementWorker?.completedJobs,
    Number(preservedWorker?.completedJobs ?? 0) + 1,
    'A forced-cancellation replacement must retry the lazy route exactly once without duplicate preparation.',
  )

  await postRoute(apiUrl, projectIds[1])
  await postRoute(apiUrl, projectIds[2])
  const boundedHealth = await health(apiUrl)
  assert(boundedHealth.body.routingRuntime, 'Health must expose bounded route-worker diagnostics.')
  assert(boundedHealth.body.routingRuntime.workerCount <= 2, 'At most two store workers may remain resident.')
  assert(Number.isFinite(boundedHealth.body.routingRuntime.processRssBytes))
  assert(
    boundedHealth.body.routingRuntime.workers.every((worker) => Number.isFinite(worker.heapUsedBytes)),
    'Worker-isolate heap usage must be observable.',
  )
  assert(
    boundedHealth.body.routingRuntime.workers.every((worker) => Number.isFinite(worker.processRssBytes)),
    'Workers must report the process RSS observed at completion.',
  )
  const processRssGrowthBytes = boundedHealth.body.routingRuntime.processRssBytes
    - baselineHealth.body.routingRuntime.processRssBytes
  assert(
    processRssGrowthBytes < 128 * 1024 * 1024,
    `Mock worker pool grew process RSS by ${(processRssGrowthBytes / 1024 / 1024).toFixed(1)} MiB.`,
  )
  const maxWorkerHeapBytes = Math.max(...boundedHealth.body.routingRuntime.workers.map((worker) => worker.heapUsedBytes))
  assert(maxWorkerHeapBytes < 64 * 1024 * 1024, 'Mock worker isolate heap exceeded 64 MiB.')

  await new Promise((resolve) => setTimeout(resolve, 400))
  const idleHealth = await health(apiUrl)
  assert.equal(idleHealth.body.routingRuntime.workerCount, 0, 'Idle route workers must exit and release their store caches.')

  const resumedRouteStartedAt = performance.now()
  const resumedRoute = await postRoute(apiUrl, projectIds[0], { departMinutes: 482 })
  const resumedRouteMs = performance.now() - resumedRouteStartedAt
  assert.notEqual(resumedRoute.plan.id, quickReplacement.plan.id)
  assert.notEqual(
    resumedRoute.plan.diagnostics.workerInstance,
    quickReplacement.plan.diagnostics.workerInstance,
    'A fresh Route after worker retirement must create a new worker.',
  )
  assert(resumedRouteMs < 750, `Fresh route took ${resumedRouteMs.toFixed(1)} ms after worker retirement.`)
  const resumedHealth = await health(apiUrl)
  assert.equal(resumedHealth.body.routingRuntime.responseCache, undefined)
  assert.equal(resumedHealth.body.routingRuntime.workerCount, 1)

  // Both slots are pinned by open Cities. Walking must reuse the City's worker
  // instead of waiting for an impossible third street-keyed slot.
  for (const projectId of projectIds.slice(0, 2)) {
    const metaPath = path.join(projectsPath, projectId, '.vigo')
    const project = fixtureProject(projectId)
    project.osmStreetIndex = { status: 'ready', cch: { ready: true } }
    await fs.mkdir(path.join(metaPath, 'osm'), { recursive: true })
    const street = new DatabaseSync(path.join(metaPath, 'osm', 'street-index.sqlite'))
    street.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT); INSERT INTO metadata VALUES ('schemaVersion','"vigo.street.store.v4"'), ('sourceModel','"pbf"');`)
    street.close()
    await fs.writeFile(path.join(metaPath, 'project.json'), JSON.stringify(project))
    const leased = await apiRuntime.fetch(new URL(`api/projects/${projectId}/routing-residency`, apiUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resident: true, leaseId: 'walking-test' }) })
    assert.equal(leased.status, 200)
    await postRoute(apiUrl, projectId)
  }
  const leasedHealth = (await health(apiUrl)).body.routingRuntime
  assert.equal(leasedHealth.residentRoutingStores, 2)
  assert.equal(leasedHealth.workerCount, 2, 'Both leased slots must actually be occupied before testing walking')
  const walk = await postRoute(apiUrl, projectIds[0], { mode: 'walk' }, AbortSignal.timeout(3000))
  assert.equal(walk.plan.travelMode, 'walk')
  assert.equal(walk.plan.diagnostics.workerInstance, resumedRoute.plan.diagnostics.workerInstance)
  const matrix = await apiRuntime.fetch(new URL(`api/projects/${projectIds[0]}/national-street-matrix`, apiUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'walk', origins: [[6.1, 46.2]], destinations: [[6.2, 46.3]] }), signal: AbortSignal.timeout(3000) })
  assert.equal(matrix.status, 200)
  assert.equal((await matrix.json()).matrix.diagnostics.workerInstance, walk.plan.diagnostics.workerInstance)
  assert.equal((await health(apiUrl)).body.routingRuntime.workerCount, 2)

  console.log(JSON.stringify({
    check: 'national-runtime-isolation',
    healthDuringSlowMs: Number(duringSlow.elapsedMs.toFixed(1)),
    nextRequestAfterAbortMs: Number(afterAbortMs.toFixed(1)),
    maxWorkers: boundedHealth.body.routingRuntime.maxWorkers,
    idleWorkerCount: idleHealth.body.routingRuntime.workerCount,
    resumedRouteMs: Number(resumedRouteMs.toFixed(1)),
    resultReuse: false,
    processRssBytes: boundedHealth.body.routingRuntime.processRssBytes,
    processRssGrowthBytes,
    maxWorkerHeapBytes,
  }, null, 2))
} finally {
  await apiRuntime?.stop()
  await fs.rm(folder, { recursive: true, force: true })
}
