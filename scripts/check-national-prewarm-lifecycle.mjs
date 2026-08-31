import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startInMemoryVigoApi } from './lib/in-memory-vigo-api.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const timingBudgetMultiplier = process.env.CI ? 2 : 1
const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-national-prewarm-'))
const projectsPath = path.join(folder, 'projects')
const configPath = path.join(folder, 'config')
const projectIds = [
  'prewarm-a',
  'prewarm-b',
  'prewarm-c',
  'prewarm-slow',
  'prewarm-evict',
  'prewarm-repair',
  'prewarm-outside-coverage',
]
let apiRuntime

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
    osmStreetIndex: {
      schemaVersion: 'vigo.street.store.v1',
      status: 'ready',
      fileName: 'street-index.sqlite',
      cch: { ready: true, format: 'fixture' },
    },
  }
}

function fixtureStorePath(projectId) {
  return path.join(projectsPath, projectId, '.vigo', 'routing', 'project.sqlite')
}

function fixtureStreetStorePath(projectId) {
  return path.join(projectsPath, projectId, '.vigo', 'osm', 'street-index.sqlite')
}

function storeKey(projectId) {
  return crypto.createHash('sha1').update(fixtureStorePath(projectId)).digest('hex').slice(0, 10)
}

async function writeFixtureProject(projectId) {
  const metaPath = path.join(projectsPath, projectId, '.vigo')
  await fs.mkdir(path.join(metaPath, 'routing'), { recursive: true })
  await fs.mkdir(path.join(metaPath, 'osm'), { recursive: true })
  await fs.writeFile(path.join(metaPath, 'project.json'), `${JSON.stringify(fixtureProject(projectId))}\n`)
  await fs.writeFile(fixtureStorePath(projectId), '')
  await fs.writeFile(fixtureStreetStorePath(projectId), '')
  if (projectId === 'prewarm-outside-coverage') {
    const database = new DatabaseSync(fixtureStorePath(projectId))
    try {
      database.exec(`
        CREATE TABLE calendar (
          service_id TEXT NOT NULL,
          start_date INTEGER NOT NULL,
          end_date INTEGER NOT NULL
        );
        CREATE TABLE calendar_dates (
          service_id TEXT NOT NULL,
          date INTEGER NOT NULL,
          exception_type INTEGER NOT NULL
        );
        INSERT INTO calendar (service_id, start_date, end_date)
        VALUES ('fixture-service', 20250101, 20251231);
      `)
    } finally {
      database.close()
    }
  }
}

async function startApi() {
  apiRuntime = await startInMemoryVigoApi({
    repositoryRoot,
    environment: {
      VIGO_PROJECTS_DIR: projectsPath,
      VIGO_CONFIG_DIR: configPath,
      VIGO_ROUTE_WORKER_URL: pathToFileURL(path.join(repositoryRoot, 'scripts', 'fixtures', 'mock-national-route-worker.mjs')).href,
      VIGO_ROUTE_WORKER_IDLE_MS: '1000',
      VIGO_ROUTE_PREWARM_IDLE_MS: '1000',
      VIGO_ROUTE_WORKER_MAX_STORES: '2',
      VIGO_ROUTE_PREWARM_WAIT_TIMEOUT_MS: '1000',
      VIGO_ROUTE_PREWARM_HARD_TIMEOUT_MS: '60000',
      VIGO_MOCK_READINESS_DELAY_MS: '80',
      VIGO_MOCK_PREPARE_DELAY_MS: '200',
      VIGO_MOCK_SLOW_SERVICE_DATE: '2099-01-01',
      VIGO_MOCK_SLOW_PREPARE_DELAY_MS: '1250',
      VIGO_MOCK_STALE_TOPOLOGY_PROJECT: 'prewarm-repair',
      VIGO_MOCK_BLOCKED_SERVICE_DATE: '2028-07-13',
    },
  })
  return apiRuntime.baseUrl
}

async function responseJson(response, label) {
  const body = await response.json().catch(() => ({}))
  assert.equal(response.status, 200, `${label} returned ${response.status}: ${JSON.stringify(body)}`)
  return body
}

async function openProject(apiUrl, projectId) {
  const startedAt = performance.now()
  const body = await responseJson(
    await apiRuntime.fetch(new URL(`api/projects/${projectId}`, apiUrl)),
    `GET ${projectId}`,
  )
  return { body, elapsedMs: performance.now() - startedAt }
}

async function readyResponse(apiUrl, projectId, body = {}, signal) {
  return apiRuntime.fetch(new URL(`api/projects/${projectId}/national-ready`, apiUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
}

async function readyProject(apiUrl, projectId, body = {}, signal) {
  return responseJson(await readyResponse(apiUrl, projectId, body, signal), `ready ${projectId}`)
}

async function routeProject(apiUrl, projectId, body = {}) {
  return responseJson(await apiRuntime.fetch(new URL(`api/projects/${projectId}/national-route`, apiUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      origin: { coordinate: [6.1, 46.2], source: 'map' },
      destination: { coordinate: [8.5, 47.4], source: 'map' },
      departMinutes: 480,
      serviceDate: '2026-07-13',
      serviceDay: 'weekday',
      ...body,
    }),
  }), `route ${projectId}`)
}

async function matrixProject(apiUrl, projectId, body = {}) {
  return responseJson(await apiRuntime.fetch(new URL(`api/projects/${projectId}/national-matrix`, apiUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      origins: [{ coordinate: [6.1, 46.2], source: 'map' }],
      destinations: [
        { coordinate: [8.5, 47.4], source: 'map' },
        { coordinate: [8.6, 47.5], source: 'map' },
      ],
      departMinutes: 480,
      serviceDate: '2026-07-13',
      serviceDay: 'weekday',
      ...body,
    }),
  }), `matrix ${projectId}`)
}

async function setRoutingResidency(apiUrl, projectId, resident, leaseId = 'test-workspace') {
  return responseJson(await apiRuntime.fetch(new URL(`api/projects/${projectId}/routing-residency`, apiUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resident, leaseId }),
  }), `routing residency ${projectId}`)
}

async function health(apiUrl) {
  return responseJson(await apiRuntime.fetch(new URL('api/health', apiUrl)), 'health')
}

async function waitForHealth(apiUrl, predicate, label, timeoutMs = 3_000) {
  const deadline = performance.now() + timeoutMs
  let latest
  while (performance.now() < deadline) {
    latest = await health(apiUrl)
    if (predicate(latest.routingRuntime)) return latest.routingRuntime
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`${label}. Latest runtime: ${JSON.stringify(latest?.routingRuntime)}`)
}

try {
  await Promise.all(projectIds.map(writeFixtureProject))
  const apiUrl = await startApi()
  assert.equal((await health(apiUrl)).routingRuntime.workerCount, 0)

  const openedA = await openProject(apiUrl, projectIds[0])
  assert(openedA.elapsedMs < 150 * timingBudgetMultiplier, `Project detail waited ${openedA.elapsedMs.toFixed(1)} ms for background prewarm.`)
  const readinessStartedAt = performance.now()
  const concurrentReady = await Promise.all(Array.from({ length: 6 }, () => readyProject(apiUrl, projectIds[0])))
  const readinessElapsedMs = performance.now() - readinessStartedAt
  assert(readinessElapsedMs < 250 * timingBudgetMultiplier, `Timetable admission waited ${readinessElapsedMs.toFixed(1)} ms for background access preparation.`)
  assert(concurrentReady.every(({ routing }) => routing.ready === true))
  assert(concurrentReady.every(({ routing }) => routing.prepareCount === 1), 'Concurrent readiness calls must share one prepare operation.')
  assert(concurrentReady.every(({ routing }) => routing.prepareRequest?.readinessOnly === true), 'Desktop readiness must stop at the exact timetable boundary.')
  assert(concurrentReady.every(({ routing }) => routing.prepareRequest?.serviceDate === undefined), 'Store admission must be reusable across service-date changes.')
  assert(concurrentReady.every(({ routing }) => routing.prepareRequest?.streetStorePath === undefined), 'Timetable readiness must not block on the selected project street index.')
  assert(concurrentReady.every(({ routing }) => routing.streetPrepareCount === 0), 'Timetable readiness must not hydrate the street accelerator.')
  assert(concurrentReady.every(({ routing }) => routing.streetStore?.deferred === true), 'Readiness must report deferred coordinate access explicitly.')
  assert(concurrentReady.every(({ routing }) => routing.accessMaterialization?.ready === false), 'Readiness must leave the coordinate-access object graph deferred.')
  assert(concurrentReady.every(({ routing }) => routing.transferSemanticsAdmission?.ready === false), 'The full transfer scan must run in the exact background preparation job.')
  assert(concurrentReady.every(({ routing }) => routing.activeServiceKernel?.reason === 'background_preparation'), 'The active-date kernel must not delay the Pathfinder ready announcement.')
  assert(concurrentReady.every(({ routing }) => routing.accessPreparation?.state === 'warming'), 'Cold readiness must disclose the background exact preparation state.')
  assert.equal(new Set(concurrentReady.map(({ routing }) => routing.workerInstance)).size, 1)

  const readyA = await waitForHealth(
    apiUrl,
    (runtime) => runtime.workers.some((worker) => worker.storeKey === storeKey(projectIds[0]) && worker.routingAccessPrepared),
    'Project A did not complete background coordinate-access preparation',
  )
  assert.equal(readyA.prewarm.started, 1)
  assert.equal(readyA.prewarm.completed, 1)
  assert(readyA.prewarm.coalesced >= 5)
  assert(readyA.workers.some((worker) => worker.storeKey === storeKey(projectIds[0]) && worker.streetStore?.accelerated === true), 'Runtime health must expose prepared street-store state for the selected worker.')
  assert.equal(readyA.prewarm.inFlight, 0)
  assert.equal(readyA.routingAccessPrewarm.started, 1)
  assert.equal(readyA.routingAccessPrewarm.completed, 1)
  assert(readyA.routingAccessPrewarm.coalesced >= 5)
  assert.equal(readyA.routingAccessPrewarm.inFlight, 0)
  assert(!Object.prototype.hasOwnProperty.call(readyA.prewarm, 'scheduled'), 'The runtime must not expose a retired project-selection timer.')
  const matrixA = await matrixProject(apiUrl, projectIds[0], {
    serviceDate: concurrentReady[0].routing.requestedRoutingContext.serviceDate,
    serviceDay: concurrentReady[0].routing.requestedRoutingContext.serviceDay,
  })
  assert.equal(matrixA.matrix.rows.length, 2)
  assert.equal(
    matrixA.matrix.diagnostics.workerInstance,
    concurrentReady[0].routing.workerInstance,
    'Matrix routing must reuse the prepared per-store worker instead of spawning a fresh isolate.',
  )
  const matrixRuntimeA = await health(apiUrl).then(({ routingRuntime }) => routingRuntime)
  const matrixWorkerA = matrixRuntimeA.workers.find((worker) => worker.storeKey === storeKey(projectIds[0]))
  assert.equal(matrixRuntimeA.prewarm.started, 1, 'Matrix dispatch must not repeat preparation for the same context.')
  assert.equal(matrixWorkerA?.lastOperation, 'matrix')
  assert.equal(matrixWorkerA?.completedJobs, 3, 'Prepared matrix routing should reuse one timetable preparation and one access preparation.')
  assert.equal(matrixWorkerA?.operationCounts?.prepare, 1)
  assert.equal(matrixWorkerA?.operationCounts?.['prepare-routing-access'], 1)
  const residentA = await setRoutingResidency(apiUrl, projectIds[0], true)
  assert.equal(residentA.residency.resident, true)
  assert.equal(residentA.residency.leaseCount, 1)
  await new Promise((resolve) => setTimeout(resolve, 1_100))
  assert(
    (await health(apiUrl)).routingRuntime.workers.some((worker) => worker.storeKey === storeKey(projectIds[0])),
    'A desktop workspace lease must keep its prepared Pathfinder worker resident.',
  )
  const releasedA = await setRoutingResidency(apiUrl, projectIds[0], false)
  assert.equal(releasedA.residency.resident, false)

  await openProject(apiUrl, projectIds[1])
  const controller = new AbortController()
  const abortedWaiter = readyProject(apiUrl, projectIds[1], {}, controller.signal)
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(abortedWaiter, (error) => error?.name === 'AbortError')
  const readyB = await waitForHealth(
    apiUrl,
    (runtime) => runtime.workers.some((worker) => worker.storeKey === storeKey(projectIds[1]) && worker.prepared),
    'Shared prewarm was cancelled with its HTTP waiter',
  )
  const explicitB = await readyProject(apiUrl, projectIds[1])
  assert.equal(explicitB.routing.prepareCount, 1, 'An aborted readiness waiter must not restart completed cold work.')
  assert.equal(explicitB.routing.streetPrepareCount, 0, 'An aborted readiness waiter must not move street work back into timetable readiness.')
  assert.equal(readyB.workerCount, 2)

  await openProject(apiUrl, projectIds[2])
  await readyProject(apiUrl, projectIds[2])
  const readyC = await waitForHealth(
    apiUrl,
    (runtime) => runtime.workers.some((worker) => worker.storeKey === storeKey(projectIds[2]) && worker.prepared),
    'Project C did not become prepared',
  )
  assert(readyC.workerCount <= 2)
  assert(readyC.residentStoreCount <= 2)
  const readyCWorker = readyC.workers.find((worker) => worker.storeKey === storeKey(projectIds[2]))

  await routeProject(apiUrl, projectIds[2])
  const beforeDelete = await health(apiUrl)
  assert.equal(beforeDelete.routingRuntime.responseCache.entries, 1)
  const routedCWorker = beforeDelete.routingRuntime.workers.find((worker) => worker.storeKey === storeKey(projectIds[2]))
  assert.equal(routedCWorker?.prepared, true, 'A lazy route must preserve an existing explicit prewarm lease.')
  assert.equal(
    routedCWorker?.preparedContext,
    readyCWorker?.preparedContext,
    'A lazy route must not relabel an earlier explicit prewarm as the routed service context.',
  )
  assert.equal(routedCWorker?.lastRouteContext?.requestedServiceDate, '2026-07-13')
  assert.equal(routedCWorker?.lastRouteContext?.resolvedServiceDate, '2026-07-13')
  assert.equal(routedCWorker?.lastRouteContext?.requireCompleteServiceCoverage, true)
  assert.equal(routedCWorker?.transferAdmission?.ready, true)
  assert.equal(routedCWorker?.operationCounts?.prepare, 1)
  assert.equal(routedCWorker?.operationCounts?.['prepare-routing-access'], 2,
    'A route for a different service context must prepare that context once after the default background warmup.')
  assert.equal(routedCWorker?.operationCounts?.route, 1)
  assert.equal(routedCWorker?.lastOperation, 'route')
  const exactReadyC = await readyProject(apiUrl, projectIds[2], {
    serviceDate: '2026-07-13',
    serviceDay: 'weekday',
  })
  assert.equal(exactReadyC.routing.prepareCount, 1, 'Changing the service date must reuse the date-independent store admission result.')
  const distinctRouteC = await routeProject(apiUrl, projectIds[2], {
    origin: { coordinate: [6.2, 46.3], source: 'map' },
    destination: { coordinate: [8.6, 47.5], source: 'map' },
  })
  assert.deepEqual(distinctRouteC.plan.origin.coordinate, [6.2, 46.3])
  assert.deepEqual(distinctRouteC.plan.destination.coordinate, [8.6, 47.5])
  const afterDistinctRoute = await health(apiUrl)
  const distinctCWorker = afterDistinctRoute.routingRuntime.workers.find((worker) => worker.storeKey === storeKey(projectIds[2]))
  assert.equal(afterDistinctRoute.routingRuntime.responseCache.entries, 2)
  assert.equal(distinctCWorker?.operationCounts?.prepare, 1)
  assert.equal(distinctCWorker?.operationCounts?.['prepare-routing-access'], 2, 'A new timetable context must prepare its matching coordinate-access context once.')
  assert.equal(distinctCWorker?.operationCounts?.['prepare-transfers'], undefined, 'Pathfinder readiness must use the coalesced routing-access operation.')
  assert.equal(distinctCWorker?.operationCounts?.route, 2)
  assert.equal(distinctCWorker?.lastOperation, 'route')
  const deleteResponse = await apiRuntime.fetch(
    new URL(`api/projects/${projectIds[2]}`, apiUrl),
    { method: 'DELETE' },
  )
  await responseJson(deleteResponse, `delete ${projectIds[2]}`)
  const afterDelete = await health(apiUrl)
  assert(!afterDelete.routingRuntime.workers.some((worker) => worker.storeKey === storeKey(projectIds[2])), 'Deleted project worker must be retired immediately.')
  assert.equal(afterDelete.routingRuntime.responseCache.entries, 0, 'Deleted-project route responses must be invalidated.')
  assert.equal(afterDelete.routingRuntime.responseCache.invalidations, 2)

  await openProject(apiUrl, projectIds[3])
  const slowStartedAt = performance.now()
  const slowReady = await readyProject(apiUrl, projectIds[3], {
    serviceDate: '2099-01-01',
    serviceDay: 'weekday',
  })
  const slowReadinessMs = performance.now() - slowStartedAt
  assert(slowReadinessMs < 500, `Slow exact-kernel preparation delayed readiness by ${slowReadinessMs.toFixed(1)} ms.`)
  assert.equal(slowReady.routing.activeServiceKernel?.reason, 'background_preparation')
  const slowReadyRuntime = await waitForHealth(
    apiUrl,
    (runtime) => runtime.workers.some((worker) => worker.storeKey === storeKey(projectIds[3]) && worker.routingAccessPrepared),
    'Slow exact preparation did not finish in the background',
    5_000,
  )
  const slowWorker = slowReadyRuntime.workers.find((worker) => worker.storeKey === storeKey(projectIds[3]))
  assert.equal(slowReadyRuntime.prewarm.waitTimedOut, 0)
  assert.equal(slowReadyRuntime.prewarm.hardTimedOut, 0)
  assert.equal(slowReadyRuntime.prewarm.failed, 0)
  assert.equal(slowReadyRuntime.prewarm.waitTimeoutMs, 1_000)
  assert.equal(slowReadyRuntime.prewarm.hardTimeoutMs, 60_000)
  const slowRetry = await readyProject(apiUrl, projectIds[3], {
    serviceDate: '2099-01-01',
    serviceDay: 'weekday',
  })
  assert.equal(slowRetry.routing.alreadyWarm, true)
  assert.equal(slowRetry.routing.accessPreparation?.state, 'ready')
  assert.equal(slowRetry.routing.prepareCount, 1, 'Reopening Pathfinder must reuse the admitted timetable worker.')
  assert.equal(slowRetry.routing.workerInstance, slowWorker?.workerInstance, 'Background exact preparation must not restart the shared worker.')

  await openProject(apiUrl, projectIds[4])
  const readyBeforeEviction = await readyProject(apiUrl, projectIds[4], {
    serviceDate: '2026-07-13',
    serviceDay: 'weekday',
  })
  const evictedWorkerInstance = readyBeforeEviction.routing.workerInstance
  await waitForHealth(
    apiUrl,
    (runtime) => !runtime.workers.some((worker) => worker.storeKey === storeKey(projectIds[4])),
    'Prepared-only worker did not expire for the route recovery regression',
    4_000,
  )
  const recoveredRoute = await routeProject(apiUrl, projectIds[4])
  const recoveredRuntime = await waitForHealth(
    apiUrl,
    (runtime) => runtime.workers.some((worker) => (
      worker.storeKey === storeKey(projectIds[4])
      && worker.lastOperation === 'route'
    )),
    'A cold route did not complete through the lazy timetable path',
  )
  const recoveredWorker = recoveredRuntime.workers.find((worker) => worker.storeKey === storeKey(projectIds[4]))
  assert.notEqual(recoveredRoute.plan.diagnostics.workerInstance, evictedWorkerInstance, 'The eviction fixture must route in a new worker instance.')
  assert.equal(recoveredRoute.plan.diagnostics.workerInstance, recoveredWorker?.workerInstance)
  assert.equal(recoveredWorker?.completedJobs, 2, 'A cold route dispatch must admit transfers once and route once.')
  assert.equal(recoveredWorker?.prepared, false, 'Lazy routing must not report an explicit prewarm operation that did not occur.')
  assert.equal(recoveredWorker?.preparedContext, undefined)
  assert.equal(recoveredWorker?.lastRouteContext?.requestedServiceDate, '2026-07-13')
  assert.equal(recoveredWorker?.lastRouteContext?.resolvedServiceDate, '2026-07-13')
  assert.equal(recoveredWorker?.operationCounts?.prepare, undefined)
  assert.equal(recoveredWorker?.operationCounts?.['prepare-routing-access'], 1)
  assert.equal(recoveredWorker?.operationCounts?.route, 1)

  const repairedRoute = await routeProject(apiUrl, projectIds[5])
  assert.equal(repairedRoute.plan.status, 'ready')
  const repairedRuntime = await waitForHealth(
    apiUrl,
    (runtime) => runtime.workers.some((worker) => (
      worker.storeKey === storeKey(projectIds[5])
      && worker.lastOperation === 'route'
    )),
    'A stale derived topology was not repaired by the bounded lazy route path',
  )
  const repairedWorker = repairedRuntime.workers.find(
    (worker) => worker.storeKey === storeKey(projectIds[5]),
  )
  assert.equal(
    repairedWorker?.operationCounts?.['prepare-routing-access'],
    1,
    'Derived recovery must not repeat routing-access admission.',
  )
  assert.equal(
    repairedWorker?.operationCounts?.['prepare-derived'],
    1,
    'A stale topology must execute exactly one derived-artifact repair.',
  )
  assert.equal(
    repairedWorker?.operationCounts?.route,
    2,
    'The failed exact route may be retried once after the structured topology repair.',
  )
  assert.equal(repairedWorker?.failedJobs, 1)
  assert.equal(recoveredWorker?.transferAdmission?.ready, true)
  assert.equal(recoveredWorker?.streetStore?.accelerated, true)

  const outsideCoverageRoute = await routeProject(apiUrl, projectIds[6], {
    serviceDate: '2028-07-13',
    serviceDay: 'weekday',
  })
  assert.equal(outsideCoverageRoute.plan.status, 'blocked')
  const cachedOutsideCoverageRoute = await routeProject(apiUrl, projectIds[6], {
    serviceDate: '2028-07-13',
    serviceDay: 'weekday',
  })
  assert.equal(cachedOutsideCoverageRoute.plan.id, outsideCoverageRoute.plan.id)
  const outsideCoverageRuntime = await waitForHealth(
    apiUrl,
    (runtime) => runtime.workers.some((worker) => (
      worker.storeKey === storeKey(projectIds[6])
      && worker.lastOperation === 'route'
    )),
    'An outside-coverage route did not reach the exact route core',
  )
  const outsideCoverageWorker = outsideCoverageRuntime.workers.find(
    (worker) => worker.storeKey === storeKey(projectIds[6]),
  )
  assert.equal(
    outsideCoverageWorker?.operationCounts?.['prepare-transfers'],
    undefined,
    'An exact outside-coverage route must not prepare an unusable transfer frontier.',
  )
  assert.equal(
    outsideCoverageWorker?.operationCounts?.['prepare-street'],
    1,
    'An exact outside-coverage route must retain pedestrian-kernel admission.',
  )
  assert.equal(outsideCoverageWorker?.operationCounts?.route, 1)
  assert.equal(outsideCoverageRuntime.responseCache.hits, 1)

  const realWorkerSource = await fs.readFile(path.join(repositoryRoot, 'server', 'national-route-worker.mjs'), 'utf8')
  assert(
    realWorkerSource.includes('prepareNationalOsmNativeStore')
      && realWorkerSource.includes("import('./national-osm-store.mjs')"),
    'The production route worker must own Rust street-kernel preparation in the same isolate that serves routes.',
  )
  assert(!realWorkerSource.includes('prepareNationalOsmStore,'), 'The production worker must not hydrate the duplicate JavaScript pedestrian graph.')
  assert(realWorkerSource.includes('const streetStore = await prepareStreetStore(request)'), 'The production prepare result must report street accelerator readiness.')
  assert(realWorkerSource.includes("operation === 'prepare-routing-access'"), 'The production worker must finish coordinate access after timetable readiness.')
  assert(realWorkerSource.includes('prepareNationalGtfsRoutingReadiness'), 'The production readiness operation must use the bounded timetable admission path.')
  assert(!realWorkerSource.includes("from './national-gtfs-store.mjs'"), 'A standalone walk must not eagerly load the GTFS backend.')
  assert(!realWorkerSource.includes('fallbackReady: true'), 'Production route workers must not retain an interactive SQLite street fallback.')
  assert(realWorkerSource.includes('VIGO_STREET_ACCELERATOR_REQUIRED'), 'Missing pedestrian accelerators must fail with an explicit rebuild contract.')
  assert(realWorkerSource.includes('routeNationalGtfsMatrix'), 'The prepared route worker must own matrix routing.')
  assert(realWorkerSource.includes("operation === 'matrix'"), 'The prepared route worker must expose a matrix operation.')
  const apiSource = await fs.readFile(path.join(repositoryRoot, 'server', 'vigo-api.mjs'), 'utf8')
  assert(apiSource.includes('nationalRoutePrewarmHardTimeoutMs'), 'Shared cold builds must retain a separate hard safety limit.')
  assert(apiSource.includes('waitForPromiseWithTimeoutAndSignal'), 'Readiness callers must have a bounded wait that does not own shared work.')
  const interactiveRouteSource = apiSource.slice(
    apiSource.indexOf('async function runSingleNationalRoute'),
    apiSource.indexOf('async function runNationalRoute'),
  )
  assert(interactiveRouteSource.includes('dispatchLazyNationalTransitRoute('), 'Interactive transit routing must use the bounded lazy route dispatcher.')
  assert(!interactiveRouteSource.includes('dispatchPrepared('), 'Interactive routing must not duplicate a timetable prewarm before the exact route preflight.')
  const lazyRouteDispatcherSource = apiSource.slice(
    apiSource.indexOf('async function dispatchLazyNationalTransitRoute'),
    apiSource.indexOf('async function runSingleNationalRoute'),
  )
  assert(lazyRouteDispatcherSource.includes("'prepare-transfers'"), 'Interactive transit routing must admit exact transfer and street inputs before dispatch.')
  assert(
    lazyRouteDispatcherSource.includes('routingDateOutsideCompleteCoverage(')
      && lazyRouteDispatcherSource.includes("'prepare-street'"),
    'Exact outside-coverage routes must bypass unusable transfer-frontier preparation.',
  )
  assert(lazyRouteDispatcherSource.includes("windowMinutes ? 'window' : 'route'"), 'Interactive routing must dispatch the lazy exact route core.')
  assert(lazyRouteDispatcherSource.includes("error?.code === 'VIGO_ROUTE_WORKER_RESTARTED'"), 'A forced worker restart must retry the complete lazy admission sequence once.')
  assert(lazyRouteDispatcherSource.includes("error?.code === 'resident_timetable_kernel_required'"), 'A stale exact topology must retain its structured worker error code.')
  assert(lazyRouteDispatcherSource.includes("'prepare-derived'"), 'A stale topology must use the bounded derived-artifact recovery operation.')
  assert(!apiSource.includes('national-matrix-worker.mjs'), 'Matrix routing must not create a fresh worker for every request.')

  console.log(JSON.stringify({
    check: 'national-prewarm-lifecycle',
    projectOpenMs: Number(openedA.elapsedMs.toFixed(1)),
    timetableAdmissionMs: Number(readinessElapsedMs.toFixed(1)),
    slowExactPreparationAdmissionMs: Number(slowReadinessMs.toFixed(1)),
    prewarm: recoveredRuntime.prewarm,
    maxWorkers: recoveredRuntime.maxWorkers,
    residentStoreCount: recoveredRuntime.residentStoreCount,
  }, null, 2))
} finally {
  await apiRuntime?.stop()
  await fs.rm(folder, { recursive: true, force: true })
}
