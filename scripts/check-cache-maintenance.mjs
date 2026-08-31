import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startInMemoryVigoApi } from './lib/in-memory-vigo-api.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-cache-maintenance-'))
const projectsRoot = path.join(fixtureRoot, 'projects')
const configRoot = path.join(fixtureRoot, 'config')
const configPath = path.join(configRoot, 'config.json')
const projectRoot = path.join(projectsRoot, 'cache-fixture', '.vigo')
const stagingRoot = path.join(projectRoot, 'staging')
const routingStore = path.join(projectRoot, 'routing', 'project.sqlite')
const evidenceFile = path.join(projectRoot, 'artifacts', 'evidence.json')
let apiRuntime

async function exists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function writeStagingFixture() {
  await fs.mkdir(stagingRoot, { recursive: true })
  await fs.writeFile(path.join(stagingRoot, 'abandoned-upload.zip'), Buffer.alloc(4_096, 7))
}

async function startApi() {
  apiRuntime = await startInMemoryVigoApi({
    repositoryRoot,
    environment: {
      VIGO_CONFIG_DIR: configRoot,
      VIGO_PROJECTS_DIR: '',
    },
  })
}

async function requestJson(apiPath, options = {}) {
  const response = await apiRuntime.requestJson(apiPath, options)
  assert.equal(response.status, 200, `${options.method ?? 'GET'} ${apiPath} failed: ${response.text}`)
  return response.body
}

try {
  await fs.mkdir(configRoot, { recursive: true })
  await fs.mkdir(path.dirname(routingStore), { recursive: true })
  await fs.mkdir(path.dirname(evidenceFile), { recursive: true })
  await fs.writeFile(routingStore, 'durable routing store')
  await fs.writeFile(evidenceFile, '{"durable":true}\n')
  await writeStagingFixture()
  await fs.writeFile(configPath, `${JSON.stringify({
    schemaVersion: 'vigo.config.v1',
    storageRoot: projectsRoot,
    appearance: 'dark',
    accent: 'blue',
    basemap: 'none',
    automaticCacheCleanup: false,
  }, null, 2)}\n`)

  await startApi()
  const disabledConfig = await requestJson('/api/config')
  assert.equal(disabledConfig.config.automaticCacheCleanup, false)
  assert.equal(await exists(stagingRoot), true, 'Disabled automatic cleanup must preserve staging on startup.')

  const preview = await requestJson('/api/cache-maintenance')
  assert.equal(preview.cache.schemaVersion, 'vigo.cache_maintenance.preview.v1')
  assert.equal(preview.cache.disk.staging.fileCount, 1)
  assert(preview.cache.estimatedFreedBytes >= 4_096)
  assert(preview.cache.preserved.includes('gtfs-routing-stores'))
  assert(preview.cache.preserved.includes('jobs-and-evidence'))

  const enabledConfig = await requestJson('/api/config', {
    method: 'PATCH',
    body: JSON.stringify({ automaticCacheCleanup: true }),
  })
  assert.equal(enabledConfig.config.automaticCacheCleanup, true)

  const cleaned = await requestJson('/api/cache-maintenance', {
    method: 'POST',
    body: JSON.stringify({}),
  })
  assert.equal(cleaned.schemaVersion, 'vigo.cache_maintenance.result.v1')
  assert.equal(cleaned.reason, 'manual')
  assert.equal(cleaned.removedFileCount, 1)
  assert(cleaned.freedBytes >= 4_096)
  assert.equal(await exists(stagingRoot), false)
  assert.equal(await exists(routingStore), true, 'Cache cleanup must preserve the routing store.')
  assert.equal(await exists(evidenceFile), true, 'Cache cleanup must preserve evidence.')

  await apiRuntime.stop()
  apiRuntime = null
  await writeStagingFixture()
  await startApi()
  assert.equal(await exists(stagingRoot), false, 'Enabled automatic cleanup must remove abandoned staging on startup.')
  assert.equal(await exists(routingStore), true)
  assert.equal(await exists(evidenceFile), true)

  console.log(JSON.stringify({
    status: 'passed',
    automaticStartupCleanup: true,
    manualCleanup: true,
    preserved: ['routing-store', 'evidence'],
  }, null, 2))
} finally {
  await apiRuntime?.stop().catch(() => {})
  await fs.rm(fixtureRoot, { recursive: true, force: true })
}
