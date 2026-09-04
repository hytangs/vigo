import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startInMemoryVigoApi } from './helpers/in-memory-vigo-api.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-city-data-'))
const projectsRoot = path.join(fixtureRoot, 'projects')
const configRoot = path.join(fixtureRoot, 'config')
let apiRuntime

async function jsonResponse(response, expectedStatus, label) {
  const text = await response.text()
  assert.equal(response.status, expectedStatus, `${label}: ${text}`)
  return text ? JSON.parse(text) : null
}

try {
  apiRuntime = await startInMemoryVigoApi({
    repositoryRoot,
    environment: {
      VIGO_CONFIG_DIR: configRoot,
      VIGO_PROJECTS_DIR: projectsRoot,
    },
  })

  const created = await jsonResponse(await apiRuntime.fetch('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Reset fixture', region: 'Test region' }),
  }), 201, 'create City')
  const projectId = created.project.id
  const projectRoot = path.join(projectsRoot, projectId)
  const metaRoot = path.join(projectRoot, '.vigo')
  const projectFile = path.join(metaRoot, 'project.json')
  const routingStore = {
    schemaVersion: 'vigo.routing.store.v1',
    status: 'ready',
    fileName: 'fixture.sqlite',
    bytes: 4_096,
  }
  const project = {
    ...JSON.parse(await fs.readFile(projectFile, 'utf8')),
    summary: {
      feeds: 1,
      routes: 17,
      stops: 42,
      transferCandidates: 6,
      qualityScore: 97,
    },
    feeds: [{
      id: 'fixture-feed',
      name: 'Fixture feed',
      routeCount: 17,
      stopCount: 42,
      tripCount: 90,
      transferCandidates: 6,
      qualityScore: 97,
      routingStore,
    }],
    jobs: [{ id: 'job-fixture', status: 'complete' }],
    artifacts: [{ id: 'artifact-fixture', sourceFeedIds: ['fixture-feed'] }],
    routingStore,
    osmStreetIndex: {
      schemaVersion: 'vigo.street.store.v3',
      status: 'ready',
      fileName: 'fixture.osm.pbf',
      sourceBytes: 2_048,
      bytes: 2_048,
      nodeCount: 10,
      edgeCount: 18,
      wayCount: 8,
      builtAt: new Date().toISOString(),
    },
  }
  await fs.writeFile(projectFile, `${JSON.stringify(project, null, 2)}\n`)
  await Promise.all([
    fs.writeFile(path.join(metaRoot, 'routing', 'fixture.sqlite'), Buffer.alloc(4_096, 1)),
    fs.writeFile(path.join(metaRoot, 'osm', 'street-index.sqlite'), Buffer.alloc(2_048, 2)),
    fs.writeFile(path.join(metaRoot, 'jobs', 'job-fixture.json'), JSON.stringify(project.jobs[0])),
    fs.writeFile(path.join(metaRoot, 'artifacts', 'artifact-fixture.json'), JSON.stringify(project.artifacts[0])),
    fs.mkdir(path.join(metaRoot, 'staging'), { recursive: true }),
    fs.writeFile(path.join(projectRoot, 'user-notes.txt'), 'This user-owned file must survive.\n'),
  ])
  await fs.writeFile(path.join(metaRoot, 'staging', 'upload.part'), Buffer.alloc(1_024, 3))

  const previewBody = await jsonResponse(
    await apiRuntime.fetch(`/api/projects/${projectId}/city-data`),
    200,
    'inspect City data',
  )
  assert.equal(previewBody.data.city.name, project.name)
  assert.equal(previewBody.data.counts.feeds, 1)
  assert.equal(previewBody.data.counts.routes, 17)
  assert.equal(previewBody.data.counts.stops, 42)
  assert.equal(previewBody.data.hasData, true)
  assert(previewBody.data.estimatedFreedBytes >= 7_168)
  assert(previewBody.data.fileCount >= 5)

  const rejectedBody = await jsonResponse(await apiRuntime.fetch(
    `/api/projects/${projectId}/city-data`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'wrong City' }),
    },
  ), 400, 'reject mismatched confirmation')
  assert.match(rejectedBody.error, /exact City name/i)
  await fs.access(path.join(metaRoot, 'routing', 'fixture.sqlite'))

  const cleanedBody = await jsonResponse(await apiRuntime.fetch(
    `/api/projects/${projectId}/city-data`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: project.name }),
    },
  ), 200, 'reset City data')
  assert.equal(cleanedBody.ok, true)
  assert.equal(cleanedBody.city.id, projectId)
  assert.equal(cleanedBody.city.name, project.name)
  assert.equal(cleanedBody.city.region, project.region)
  assert.equal(cleanedBody.city.createdAt, project.createdAt)
  assert.deepEqual(cleanedBody.city.summary, {
    feeds: 0,
    routes: 0,
    stops: 0,
    transferCandidates: 0,
    qualityScore: 0,
  })
  assert.deepEqual(cleanedBody.city.feeds, [])
  assert.equal(cleanedBody.city.routingStore, null)
  assert.equal(cleanedBody.city.osmStreetIndex, null)
  assert(cleanedBody.reset.freedBytes >= 7_168)
  assert.equal(cleanedBody.data.hasData, false)
  assert.equal(cleanedBody.data.fileCount, 0)

  await fs.access(path.join(projectRoot, 'user-notes.txt'))
  await fs.access(path.join(projectRoot, 'README.md'))
  await fs.access(path.join(projectRoot, 'DATA_MANIFEST.json'))
  for (const managedDirectory of ['routing', 'osm', 'jobs', 'artifacts']) {
    assert.deepEqual(await fs.readdir(path.join(metaRoot, managedDirectory)), [])
  }
  await assert.rejects(fs.access(path.join(metaRoot, 'staging', 'upload.part')))

  const listed = await jsonResponse(
    await apiRuntime.fetch('/api/projects'),
    200,
    'list preserved City',
  )
  assert.equal(listed.projects.length, 1)
  assert.equal(listed.projects[0].id, projectId)
  assert.equal(listed.projects[0].summary.feeds, 0)

  const removed = await jsonResponse(
    await apiRuntime.fetch(`/api/projects/${projectId}`, { method: 'DELETE' }),
    200,
    'remove City',
  )
  assert.deepEqual(removed.projects, [])
  await assert.rejects(fs.access(projectRoot))

  console.log(JSON.stringify({
    check: 'city-data',
    confirmation: 'exact-city-name',
    preserved: ['city-identity', 'city-root-user-files'],
    removed: ['timetables', 'street-index', 'jobs', 'artifacts', 'staging'],
    freedBytes: cleanedBody.reset.freedBytes,
  }, null, 2))
} finally {
  await apiRuntime?.stop()
  await fs.rm(fixtureRoot, { recursive: true, force: true })
}
