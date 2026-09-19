import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startInMemoryVigoApi } from './helpers/in-memory-vigo-api.mjs'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { inspectNationalStaticTopologySidecar, nationalStaticTopologySidecarPath } from '../src/server/national-gtfs-store.mjs'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-source-removal-'))
let runtime
try {
  const inputs = await writeCliFixtureInputs(directory)
  runtime = await startInMemoryVigoApi({ repositoryRoot, environment: {
    VIGO_CONFIG_DIR: path.join(directory, 'config'), VIGO_PROJECTS_DIR: path.join(directory, 'cities'),
  } })
  const request = async (url, method = 'GET', body, status = 200) => {
    const response = await runtime.fetch(url, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const result = await response.json()
    assert.equal(response.status, status, JSON.stringify(result))
    return result
  }
  const { project } = await request('/api/projects', 'POST', { name: 'Source removal fixture' }, 201)
  const base = `/api/projects/${project.id}`
  const meta = path.join(directory, 'cities', project.id, '.vigo')
  const projectFile = path.join(meta, 'project.json')
  const waitForJob = async (job) => {
    const deadline = Date.now() + 60_000
    while (['running', 'queued'].includes(job.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 30))
      job = (await request(`${base}/national-gtfs-job?jobId=${job.id}`)).job
    }
    assert.equal(job.status, 'complete', JSON.stringify(job))
    return job
  }
  await waitForJob((await request(`${base}/national-osm-import`, 'POST', { sourcePath: inputs.osmPath }, 202)).job)
  const feedIds = []
  for (let index = 0; index < 3; index++) {
    const { job } = await request(`${base}/national-gtfs-import`, 'POST', { sourcePath: inputs.gtfsPath, preloadServiceDate: '2026-07-16' }, 202)
    if (index === 0) await request(`${base}/city-source`, 'DELETE', { kind: 'osm', confirmation: 'fixture.osm.pbf' }, 409)
    feedIds.push((await waitForJob(job)).result.feedId)
  }
  const removeFeed = (feedId, status = 200) => request(`${base}/city-source`, 'DELETE', { kind: 'gtfs', feedId, confirmation: feedId }, status)
  const readMetadata = async () => JSON.parse(await fs.readFile(projectFile, 'utf8'))
  let city = (await request(base)).project
  assert.equal(city.feeds.length, 3)
  await fs.writeFile(path.join(directory, 'cities', project.id, 'user-notes.txt'), 'Keep me')
  await fs.mkdir(path.join(meta, 'agency'), { recursive: true })
  await fs.writeFile(path.join(meta, 'agency', 'retained-note.txt'), 'Keep this notebook')
  await fs.writeFile(path.join(meta, 'rebuild-manifest.json'), '{}')
  const original = await fs.readFile(projectFile, 'utf8')
  await request(`${base}/city-source`, 'DELETE', { kind: 'gtfs', feedId: feedIds[0], confirmation: 'wrong' }, 400)
  await removeFeed('../not-a-feed', 404)
  assert.equal(await fs.readFile(projectFile, 'utf8'), original, 'Rejected deletion cannot change City metadata')

  // Open the Network context so deletion must release its SQLite handle too.
  await request(`${base}/agency`)
  const manifestPath = path.join(directory, 'cities', project.id, 'DATA_MANIFEST.json')
  const manifest = await fs.readFile(manifestPath)
  await fs.rm(manifestPath)
  await fs.mkdir(manifestPath)
  await removeFeed(feedIds[0], 500)
  assert.deepEqual((await readMetadata()).feeds.map((feed) => feed.id), JSON.parse(original).feeds.map((feed) => feed.id), 'A metadata write failure restores the original sources')
  await fs.access(path.join(meta, 'routing', `${feedIds[0]}.sqlite`))
  await fs.access(path.join(meta, 'routing', 'project.sqlite'))
  await fs.rm(manifestPath, { recursive: true })
  await fs.writeFile(manifestPath, manifest)
  city = (await removeFeed(feedIds[0])).city
  assert.deepEqual(city.feeds.map((feed) => feed.id).sort(), feedIds.slice(1).sort())
  assert.equal(city.osmStreetIndex.status, 'ready')
  const merge = city.jobs.find((job) => job.kind === 'national-gtfs-merge')
  assert(merge, 'Deleting one of three feeds starts a combined store for the remaining two')
  await waitForJob(merge)
  let metadata = await readMetadata()
  assert.equal(metadata.routingStore.status, 'ready')
  const routingFiles = await fs.readdir(path.join(meta, 'routing'))
  assert(!routingFiles.some((name) => name.startsWith(`${feedIds[0]}.sqlite`)))
  assert(!metadata.jobs.some((job) => job.feedId === feedIds[0]))
  assert(!metadata.artifacts.some((artifact) => artifact.sourceFeedIds.includes(feedIds[0])))
  await assert.rejects(fs.access(path.join(meta, 'rebuild-manifest.json')))

  const storePaths = [...new Set([metadata.routingStore.fileName, ...metadata.feeds.map((feed) => feed.routingStore.fileName)])].map((name) => path.join(meta, 'routing', name))
  const transferCounts = (storePath) => {
    const db = new DatabaseSync(storePath, { readOnly: true })
    try { return Object.fromEntries(db.prepare('SELECT provenance, COUNT(*) AS count FROM transfer_provenance GROUP BY provenance').all().map((row) => [row.provenance, row.count])) }
    finally { db.close() }
  }
  const before = storePaths.map(transferCounts)
  assert(before.some((counts) => counts.osm_certified_radial > 0), 'Fixture must contain real OSM-derived transfers')
  await request(`${base}/agency`)
  city = (await request(`${base}/city-source`, 'DELETE', { kind: 'osm', confirmation: 'fixture.osm.pbf' })).city
  assert.equal(city.osmStreetIndex, null)
  assert.equal(city.feeds.length, 2)
  assert.equal(city.routingStore.status, 'ready')
  assert.deepEqual(await fs.readdir(path.join(meta, 'osm')), [])
  for (const [index, storePath] of storePaths.entries()) {
    const counts = transferCounts(storePath)
    assert.equal(counts.osm_certified_radial, undefined)
    const { osm_certified_radial, ...declared } = before[index]
    assert.deepEqual(counts, declared, 'OSM removal preserves GTFS-declared transfers')
    assert.equal(inspectNationalStaticTopologySidecar(storePath, nationalStaticTopologySidecarPath(storePath)).ready, true, 'Routing topology must match the surviving transfers')
  }
  await request(`${base}/city-source`, 'DELETE', { kind: 'osm', confirmation: 'fixture.osm.pbf' }, 404)
  city = (await removeFeed(feedIds[1])).city
  assert.equal(city.feeds.length, 1)
  metadata = await readMetadata()
  assert.equal(metadata.routingStore.fileName, metadata.feeds[0].routingStore.fileName)
  await assert.rejects(fs.access(path.join(meta, 'routing', 'project.sqlite')))
  city = (await removeFeed(feedIds[2])).city
  assert.deepEqual(city.feeds, [])
  assert.equal(city.routingStore, null)
  assert.equal(city.summary.routes, 0)
  assert.equal(city.summary.stops, 0)
  assert.deepEqual(await fs.readdir(path.join(meta, 'routing')), [])
  assert.equal(await fs.readFile(path.join(meta, 'agency', 'retained-note.txt'), 'utf8'), 'Keep this notebook')
  assert.equal(await fs.readFile(path.join(directory, 'cities', project.id, 'user-notes.txt'), 'utf8'), 'Keep me')
  await fs.access(inputs.gtfsPath)
  await fs.access(inputs.osmPath)
  assert.equal((await request('/api/projects')).projects.length, 1, 'The City remains after its last source is deleted')
  console.log('City source deletion passed: confirmation, busy imports, rollback, GTFS 3→2→1→0, combined-store rebuild, Network handles, OSM transfer removal, current topology, preserved notebook and source files.')
} catch (error) {
  console.error(runtime?.log().slice(-6000))
  throw error
} finally {
  await runtime?.stop()
  await fs.rm(directory, { recursive: true, force: true })
}
