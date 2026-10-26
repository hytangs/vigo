import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startInMemoryVigoApi } from './helpers/in-memory-vigo-api.mjs'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-authorized-import-'))
let runtime
try {
  const inputs = await writeCliFixtureInputs(directory, { terminalAccess: true, terminalNodeTags: { 5: { barrier: 'gate' } } })
  runtime = await startInMemoryVigoApi({ repositoryRoot: path.resolve(import.meta.dirname, '..'), environment: {
    VIGO_CONFIG_DIR: path.join(directory, 'config'), VIGO_PROJECTS_DIR: path.join(directory, 'cities'),
  } })
  const request = async (url, method = 'GET', body, status = 200) => {
    const response = await runtime.fetch(url, { method, headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) })
    const result = await response.json()
    assert.equal(response.status, status, JSON.stringify(result))
    return result
  }
  const { project } = await request('/api/projects', 'POST', { name: 'Authorized endpoint fixture' }, 201)
  const base = `/api/projects/${project.id}`
  const overlayPath = path.join(directory, 'cities', project.id, '.vigo', 'osm', 'street-index.sqlite.terminal-access-v1.json')
  const wait = async (job, expected = 'complete') => {
    const deadline = Date.now() + 60_000
    while (['running', 'queued'].includes(job.status) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 30))
      job = (await request(`${base}/national-gtfs-job?jobId=${job.id}`)).job
    }
    assert.equal(job.status, expected, JSON.stringify(job))
    return job
  }
  await request(`${base}/national-osm-import`, 'POST', { sourcePath: inputs.osmPath, privateAccess: 'all' }, 400)
  await request(`${base}/national-osm-import`, 'POST', { sourcePath: inputs.osmPath, privateAccess: 'endpoints' }, 409)
  await wait((await request(`${base}/national-gtfs-import`, 'POST', {
    sourcePath: inputs.gtfsPath, preloadServiceDate: '2026-07-15',
  }, 202)).job)
  const route = async expected => {
    const result = await request(`${base}/national-route`, 'POST', { mode: 'transit', feedId: '__project__',
      origin: { source: 'map', coordinate: [-77.054, 38.9], label: 'Residence' },
      destination: { source: 'map', coordinate: [-77.03, 38.91], label: 'School' },
      serviceDate: '2026-07-15', serviceDay: 'weekday', routingDataMode: 'scheduled',
      timePreference: 'depart', departMinutes: 475, maxWalkKm: 0.6, allowLongWalk: false })
    assert.equal(result.choices[0].status, expected, JSON.stringify(result))
  }
  // The browser upload path must carry the selected permission, not default it.
  const uploaded = await runtime.fetch(`${base}/national-osm-upload?fileName=fixture.osm.pbf&privateAccess=endpoints`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: await fs.readFile(inputs.osmPath),
  })
  assert.equal(uploaded.status, 202, await uploaded.clone().text())
  const job = await wait((await uploaded.json()).job)
  assert.equal(job.privateAccess, 'endpoints')
  assert.equal(job.result.terminalAccess.model, 'authorized_endpoints')
  assert.equal((await request(base)).project.osmStreetIndex.terminalAccess.model, 'authorized_endpoints')
  await fs.access(overlayPath)
  await route('ready')
  const reachBody = { origin: { source: 'map', coordinate: [-77.054, 38.9], label: 'Residence' },
    serviceDate: '2026-07-15', serviceDay: 'weekday', departMinutes: 475, mode: 'transit',
    rasterSize: 64, radiusKm: 1, maxWalkKm: 0.6, cutoffsMinutes: [1, 5, 10], surfaceSampling: 'street' }
  const reach = await request(`${base}/reach`, 'POST', reachBody)
  assert.equal(reach.result.request.surfaceSampling, 'street', 'Studio retains street sampling with endpoint access')
  await request(`${base}/reach`, 'POST', { ...reachBody, includeStreetEdges: true })
  await request(`${base}/reach`, 'POST', { ...reachBody, scenario: { excludedRouteIds: ['R1'] } })
  // Retry retains authorization even if another import previously used public.
  const broken = path.join(directory, 'retry.osm.pbf')
  await fs.writeFile(broken, 'Invalid PBF')
  assert((await request('/api/health')).nativeRuntime.residentCities.length > 0, 'Prior routing keeps the City and its street snapshot open')
  const replacement = (await request(`${base}/national-osm-import`, 'POST', {
    sourcePath: broken, privateAccess: 'endpoints',
  }, 202)).job
  const replacing = (await request('/api/health'))
  assert.equal(replacing.routingRuntime.workerCount, 0, 'Street replacement retires timetable workers before writing snapshots')
  assert.equal(replacing.nativeRuntime.residentCities.length, 0, 'Street replacement closes the native City before writing snapshots')
  const failed = await wait(replacement, 'failed')
  await fs.copyFile(inputs.osmPath, broken)
  const retried = await wait((await request(`${base}/national-job-retry`, 'POST', { jobId: failed.id }, 202)).job)
  assert.equal(retried.privateAccess, 'endpoints')
  await route('ready')
  await wait((await request(`${base}/national-osm-import`, 'POST', { sourcePath: inputs.osmPath, privateAccess: 'public' }, 202)).job)
  assert.equal((await request(base)).project.osmStreetIndex.terminalAccess.model, 'public')
  await assert.rejects(fs.access(overlayPath), { code: 'ENOENT' }, 'Public replacement removes the previous private overlay')
  await route('blocked')
  console.log('Authorized access: upload, local import, retry, validation, gate routing and return to public passed.')
} finally {
  await runtime?.stop()
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
