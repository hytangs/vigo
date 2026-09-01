import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startInMemoryVigoApi } from './lib/in-memory-vigo-api.mjs'

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
      JSON.stringify(crypto.createHash('sha256').update(`${projectId}:routing`).digest('hex')),
    )
    insert.run('storeId', JSON.stringify(projectId))
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
      VIGO_ROUTE_WORKER_URL: pathToFileURL(path.join(repositoryRoot, 'scripts', 'fixtures', 'mock-national-route-worker.mjs')).href,
      VIGO_ROUTE_WORKER_IDLE_MS: '250',
      VIGO_ROUTE_WORKER_MAX_STORES: '2',
      VIGO_ROUTE_RESPONSE_CACHE_MAX_ENTRIES: '4',
      // Give the fixture a deterministic margin between its cooperative
      // short-job completion and the forced-restart boundary. Production keeps
      // the lower default; this check validates the relative lifecycle rules.
      VIGO_ROUTE_CANCEL_GRACE_MS: '300',
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
  assert.deepEqual(second, first, 'A serialized route-cache hit must preserve the exact HTTP response body.')
  assert.equal(
    second.plan.diagnostics.workerInstance,
    first.plan.diagnostics.workerInstance,
    'Normal requests for one store must reuse its warm worker.',
  )

  const quickController = new AbortController()
  const quickObsoleteRoute = postRoute(
    apiUrl,
    projectIds[0],
    { departMinutes: 480.5, testDelayMs: 200 },
    quickController.signal,
  )
  await waitForActiveRoute(apiUrl, first.plan.diagnostics.workerInstance)
  quickController.abort()
  await assert.rejects(quickObsoleteRoute, (error) => error?.name === 'AbortError')
  const quickReplacement = await postRoute(apiUrl, projectIds[0], { departMinutes: 480.75 })
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
  const slowRoute = postRoute(apiUrl, projectIds[0], { testDelayMs: 1_500 }, slowController.signal)
  await new Promise((resolve) => setTimeout(resolve, 80))
  const duringSlow = await health(apiUrl)
  assert(duringSlow.elapsedMs < 250, `Health took ${duringSlow.elapsedMs.toFixed(1)} ms while route worker was busy.`)
  assert.equal(duringSlow.body.ok, true)
  slowController.abort()
  await assert.rejects(slowRoute, (error) => error?.name === 'AbortError')

  const afterAbortStartedAt = performance.now()
  const afterAbort = await postRoute(apiUrl, projectIds[0], { departMinutes: 481 })
  const afterAbortMs = performance.now() - afterAbortStartedAt
  assert(afterAbortMs < 750, `Replacement worker took ${afterAbortMs.toFixed(1)} ms after cancellation.`)
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

  const retainedRouteStartedAt = performance.now()
  const retainedRoute = await postRoute(apiUrl, projectIds[0], { departMinutes: 480.75 })
  const retainedRouteMs = performance.now() - retainedRouteStartedAt
  assert.equal(retainedRoute.plan.id, quickReplacement.plan.id, 'The bounded response cache must retain a recent successful exact result after worker retirement.')
  assert(retainedRouteMs < 100, `Retained route took ${retainedRouteMs.toFixed(1)} ms after worker retirement.`)
  const retainedHealth = await health(apiUrl)
  assert.equal(retainedHealth.body.routingRuntime.workerCount, 0, 'A retained exact response must not recreate the retired worker.')
  assert(retainedHealth.body.routingRuntime.responseCache.hits >= 2)
  assert(retainedHealth.body.routingRuntime.responseCache.estimatedBytes <= retainedHealth.body.routingRuntime.responseCache.maxBytes)
  const mutatedStorePath = path.join(projectsPath, projectIds[0], '.vigo', 'routing', 'project.sqlite')
  const originalStoreStats = await fs.stat(mutatedStorePath, { bigint: true })
  const mutatedDatabase = new DatabaseSync(mutatedStorePath)
  try {
    mutatedDatabase.prepare("UPDATE metadata SET value=? WHERE key='sourceFingerprint'")
      .run(JSON.stringify('f'.repeat(64)))
  } finally {
    mutatedDatabase.close()
  }
  await fs.utimes(mutatedStorePath, fixtureTimestamp, fixtureTimestamp)
  const mutatedStoreStats = await fs.stat(mutatedStorePath, { bigint: true })
  assert.equal(mutatedStoreStats.size, originalStoreStats.size, 'The mutation fixture must retain the exact store byte length.')
  assert.equal(mutatedStoreStats.mtimeNs, originalStoreStats.mtimeNs, 'The mutation fixture must restore the exact modification time.')
  const refreshedArtifactRoute = await postRoute(apiUrl, projectIds[0], { departMinutes: 480.75 })
  assert.notEqual(
    refreshedArtifactRoute.plan.id,
    quickReplacement.plan.id,
    'A canonical fingerprint change at the same path, size, and mtime must bypass retained responses.',
  )
  const retainedRefreshedRoute = await postRoute(apiUrl, projectIds[0], { departMinutes: 480.75 })
  assert.equal(
    retainedRefreshedRoute.plan.id,
    refreshedArtifactRoute.plan.id,
    'The refreshed canonical store generation must establish its own reusable response-cache entry.',
  )
  const boundedCacheHealth = await health(apiUrl)
  assert.equal(boundedCacheHealth.body.routingRuntime.responseCache.entries, 4)
  assert.equal(boundedCacheHealth.body.routingRuntime.responseCache.maxEntries, 4)
  assert(boundedCacheHealth.body.routingRuntime.responseCache.evictions >= 1, 'The oldest retained response must be evicted at the entry cap.')

  console.log(JSON.stringify({
    check: 'national-runtime-isolation',
    healthDuringSlowMs: Number(duringSlow.elapsedMs.toFixed(1)),
    nextRequestAfterAbortMs: Number(afterAbortMs.toFixed(1)),
    maxWorkers: boundedHealth.body.routingRuntime.maxWorkers,
    idleWorkerCount: idleHealth.body.routingRuntime.workerCount,
    retainedRouteMs: Number(retainedRouteMs.toFixed(1)),
    sameSizeAndMtimeFingerprintMutation: true,
    responseCache: boundedCacheHealth.body.routingRuntime.responseCache,
    processRssBytes: boundedHealth.body.routingRuntime.processRssBytes,
    processRssGrowthBytes,
    maxWorkerHeapBytes,
  }, null, 2))
} finally {
  await apiRuntime?.stop()
  await fs.rm(folder, { recursive: true, force: true })
}
