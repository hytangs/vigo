import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { startInMemoryVigoApi } from './lib/in-memory-vigo-api.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-sqlite-import-'))
const projectsRoot = path.join(fixtureRoot, 'projects')
const configRoot = path.join(fixtureRoot, 'config')
let apiRuntime

function fixtureGtfsZip() {
  const zip = new JSZip()
  zip.file('agency.txt', 'agency_id,agency_name,agency_url,agency_timezone\nfixture,Fixture Transit,https://example.test,America/New_York\n')
  zip.file('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon\nA,Alpha,42.3500,-71.0600\nB,Beta,42.3550,-71.0550\nC,Gamma,42.3600,-71.0500\n')
  zip.file('routes.txt', 'route_id,agency_id,route_short_name,route_long_name,route_type,route_color\nR,fixture,1,Fixture Line,3,005DAA\n')
  zip.file('trips.txt', 'route_id,service_id,trip_id,direction_id\nR,WKD,T1,0\n')
  zip.file('stop_times.txt', 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,08:00:00,08:00:00,A,1\nT1,08:10:00,08:10:00,B,2\nT1,08:20:00,08:20:00,C,3\n')
  zip.file('calendar.txt', 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWKD,1,1,1,1,1,0,0,20260101,20261231\n')
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

async function startApi() {
  apiRuntime = await startInMemoryVigoApi({
    repositoryRoot,
    requestTimeoutMs: 30_000,
    environment: {
      VIGO_CONFIG_DIR: configRoot,
      VIGO_PROJECTS_DIR: projectsRoot,
      VIGO_ROUTE_PROJECT_PREWARM: '0',
    },
  })
  return apiRuntime
}

async function stopApi() {
  await apiRuntime?.stop()
}

async function responseJson(response, expectedStatus, label) {
  assert.equal(
    response.status,
    expectedStatus,
    `${label} returned ${response.status}: ${response.text || response.error || ''}`,
  )
  return response.body ?? {}
}

async function waitForJob(runtime, projectId, jobId) {
  const deadline = performance.now() + 30_000
  let latest
  while (performance.now() < deadline) {
    latest = await responseJson(await runtime.requestJson(
      `/api/projects/${encodeURIComponent(projectId)}/national-gtfs-job?jobId=${encodeURIComponent(jobId)}`,
    ), 200, 'poll GTFS SQLite build')
    if (latest.job.status === 'complete') return latest.job
    if (latest.job.status === 'failed') assert.fail(`GTFS SQLite build failed: ${latest.job.error}`)
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  assert.fail(`GTFS SQLite build timed out: ${JSON.stringify(latest)}`)
}

async function allFiles(root) {
  const files = []
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...await allFiles(entryPath))
    else files.push(entryPath)
  }
  return files
}

try {
  const runtime = await startApi()
  const created = await responseJson(await runtime.requestJson('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'SQLite Import Fixture', region: 'Fixture' }),
  }), 201, 'create fixture project')
  const projectId = created.project.id
  const zip = await fixtureGtfsZip()
  const upload = await responseJson(await runtime.requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/national-gtfs-upload?fileName=fixture.zip&preloadServiceDate=2026-07-13&preloadServiceDay=weekday`,
    {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: zip,
  }), 202, 'upload GTFS ZIP')
  const completed = await waitForJob(runtime, projectId, upload.job.id)
  assert.equal(completed.stagedUpload, true)
  assert.equal(completed.sourcePath, undefined)
  assert.equal(completed.result.preload.serviceDate, '2026-07-13')
  assert.equal(completed.result.preload.persistenceState, 'written')
  assert.equal(completed.result.preload.engine, 'rust_exact_connection_scan')
  assert.equal(completed.result.preload.heuristicMode, 'none')
  assert.equal(completed.result.preload.nativeTimetableReady, true)
  assert.equal(
    Object.hasOwn(completed.result.preload, 'calibrationSearchCount'),
    false,
    'The native exact kernel must not retain the retired calibration-search contract.',
  )

  const detailResponse = await runtime.requestJson(`/api/projects/${encodeURIComponent(projectId)}`)
  const detailText = detailResponse.text
  assert.equal(detailResponse.status, 200)
  assert(detailText.length < 2_000_000, `Project detail is unexpectedly large: ${detailText.length} bytes`)
  const detail = JSON.parse(detailText).project
  assert.equal(detail.feeds.length, 1)
  assert.equal(detail.feeds[0].routingStore.status, 'ready')
  assert.equal(detail.feeds[0].routingStore.connectionCount, 2)
  assert(!detailText.includes('routingSchedule'))
  assert(!detailText.includes('osmWalkAsset'))

  const projectRoot = path.join(projectsRoot, projectId)
  const files = await allFiles(projectRoot)
  const relativeFiles = files.map((file) => path.relative(projectRoot, file).split(path.sep).join('/'))
  assert(relativeFiles.some((file) => /^\.vigo\/routing\/feed_[^/]+\.sqlite$/.test(file)), relativeFiles.join('\n'))
  assert(!relativeFiles.some((file) => /^\.vigo\/routing\/.*\.json$/.test(file)), relativeFiles.join('\n'))
  assert(!relativeFiles.some((file) => /^\.vigo\/(?:transport|index|feeds)\//.test(file)), relativeFiles.join('\n'))
  assert(!relativeFiles.includes('.vigo/osm/walk-network.json'))
  const storedProject = JSON.parse(await fs.readFile(path.join(projectRoot, '.vigo', 'project.json'), 'utf8'))
  assert(!('routeMetrics' in storedProject.feeds[0]))
  assert(!('stopMetrics' in storedProject.feeds[0]))
  assert(!('mapPreview' in storedProject.feeds[0]))
  const stagedFiles = await fs.readdir(path.join(projectRoot, '.vigo', 'staging')).catch(() => [])
  assert.deepEqual(stagedFiles, [])

  for (const action of ['feeds', 'routing-schedule', 'osm-walk']) {
    const response = await runtime.requestJson(`/api/projects/${encodeURIComponent(projectId)}/${action}`, {
      method: action === 'feeds' ? 'POST' : 'GET',
      headers: action === 'feeds' ? { 'content-type': 'application/json' } : undefined,
      body: action === 'feeds' ? '{}' : undefined,
    })
    assert.equal(response.status, 404, `Legacy endpoint ${action} is still reachable.`)
  }

  await responseJson(await runtime.requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/national-osm-upload?fileName=streets.geojson`,
    { method: 'POST', body: Buffer.from('{}') },
  ), 400, 'reject legacy OSM GeoJSON')

  console.log(JSON.stringify({
    ok: true,
    projectId,
    detailBytes: Buffer.byteLength(detailText),
    connectionCount: detail.feeds[0].routingStore.connectionCount,
    legacyEndpoints: 'removed',
    storage: 'sqlite-only-no-transport-json',
    cliContract: 'canonical-native-engine',
  }, null, 2))
} finally {
  await stopApi()
  await fs.rm(fixtureRoot, { recursive: true, force: true })
}
