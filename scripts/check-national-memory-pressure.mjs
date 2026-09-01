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
const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-national-pressure-'))
const projectsPath = path.join(folder, 'projects')
const configPath = path.join(folder, 'config')
const projectIds = ['pressure-project-a', 'pressure-project-b']
let apiRuntime

async function writeFixtureProject() {
  for (const projectId of projectIds) {
    const metaPath = path.join(projectsPath, projectId, '.vigo')
    const fileName = `${projectId}.sqlite`
    await fs.mkdir(path.join(metaPath, 'routing'), { recursive: true })
    await fs.writeFile(path.join(metaPath, 'project.json'), `${JSON.stringify({
      id: projectId,
      schemaVersion: 'vigo.project.v1',
      name: projectId,
      feeds: [],
      jobs: [],
      artifacts: [],
      routingStore: { schemaVersion: 'vigo.routing.store.v1', status: 'ready', fileName },
    })}\n`)
    const database = new DatabaseSync(path.join(metaPath, 'routing', fileName))
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
  }
}

async function startApi() {
  apiRuntime = await startInMemoryVigoApi({
    repositoryRoot,
    environment: {
      VIGO_PROJECTS_DIR: projectsPath,
      VIGO_CONFIG_DIR: configPath,
      VIGO_ROUTE_WORKER_URL: pathToFileURL(path.join(repositoryRoot, 'scripts', 'fixtures', 'mock-national-route-worker.mjs')).href,
      VIGO_ROUTE_WORKER_IDLE_MS: '10000',
      VIGO_ROUTE_WORKER_MAX_STORES: '2',
      VIGO_ROUTE_WORKER_RSS_BUDGET_BYTES: String(256 * 1024 * 1024),
      VIGO_MOCK_REPORTED_RSS_BYTES: String(600 * 1024 * 1024),
      VIGO_MOCK_REPORTED_ISOLATE_BYTES: String(600 * 1024 * 1024),
    },
  })
  return apiRuntime.baseUrl
}

async function route(apiUrl, projectId, body = {}) {
  const response = await apiRuntime.fetch(
    new URL(`api/projects/${projectId}/national-route`, apiUrl),
    {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      origin: {
        coordinate: [6.1, 46.2],
        stopId: 'fixture-origin',
        source: 'national-search',
      },
      destination: {
        coordinate: [8.5, 47.4],
        stopId: 'fixture-destination',
        source: 'national-search',
      },
      departMinutes: 480,
      ...body,
    }),
    },
  )
  if (response.status !== 200) assert.fail(`Route returned ${response.status}: ${await response.text()}`)
  return response.json()
}

async function health(apiUrl) {
  const response = await apiRuntime.fetch(new URL('api/health', apiUrl))
  assert.equal(response.status, 200)
  return (await response.json()).routingRuntime
}

async function waitFor(apiUrl, predicate, label, timeoutMs = 3_000) {
  const deadline = performance.now() + timeoutMs
  let runtime
  while (performance.now() < deadline) {
    runtime = await health(apiUrl)
    if (predicate(runtime)) return runtime
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  assert.fail(`${label}: ${JSON.stringify(runtime)}`)
}

try {
  await writeFixtureProject()
  const apiUrl = await startApi()
  const quick = await route(apiUrl, projectIds[0], { departMinutes: 480 })
  const slow = route(apiUrl, projectIds[0], {
    departMinutes: 481,
    testDelayMs: 4_000,
  })

  const pressuredActive = await waitFor(
    apiUrl,
    (runtime) => runtime.memoryPressure && runtime.workers.some((worker) => worker.active),
    'Active pressured worker was not observable',
    6_000,
  )
  assert.equal(pressuredActive.mainProcessRssBytes, pressuredActive.processRssBytes)
  assert(pressuredActive.aggregateResidentRssBytes >= 600 * 1024 * 1024)
  assert(pressuredActive.workerProcessRssMaxBytes >= 600 * 1024 * 1024)
  assert(pressuredActive.workerIsolateResidentEstimateBytes > 0)
  assert.equal(pressuredActive.workers[0].processRssScope, 'process-wide-snapshot')

  await Promise.all([quick, slow])
  const retained = await waitFor(
    apiUrl,
    (runtime) => runtime.workerCount === 1 && runtime.memoryPressure,
    'The sole recent pressured worker was not retained',
  )
  assert.equal(retained.memory.pressureEvictions, 0)

  await route(apiUrl, projectIds[1], { departMinutes: 482 })
  const retired = await waitFor(
    apiUrl,
    (runtime) => (
      runtime.workerCount === 1
      && runtime.memory.pressureEvictions >= 1
      && runtime.workers[0]?.storeFile === `${projectIds[1]}.sqlite`
    ),
    'The older idle pressured worker was not retired',
  )
  assert.equal(retired.memory.activeWorkerTerminationCount, 0, 'Memory pressure must never terminate active jobs.')
  assert(retired.memory.peakAggregateResidentRssBytes >= 600 * 1024 * 1024)

  console.log(JSON.stringify({
    check: 'national-memory-pressure',
    budgetBytes: pressuredActive.rssBudgetBytes,
    aggregateResidentRssBytes: pressuredActive.aggregateResidentRssBytes,
    workerProcessRssMaxBytes: pressuredActive.workerProcessRssMaxBytes,
    workerIsolateResidentEstimateBytes: pressuredActive.workerIsolateResidentEstimateBytes,
    retainedMostRecentStore: retired.workers[0].storeFile,
    pressureEvictions: retired.memory.pressureEvictions,
    activeWorkerTerminationCount: retired.memory.activeWorkerTerminationCount,
  }, null, 2))
} finally {
  await apiRuntime?.stop()
  await fs.rm(folder, { recursive: true, force: true })
}
