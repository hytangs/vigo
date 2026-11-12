// Switching library resets Studio's runtimes instead of closing them: after
// A → B → A in one API process, imports (which prepare transfers in the
// preparation pool), routes (native runtime) and route analysis (preparation
// pool) all work, and no work of the library left behind keeps a City open.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startInMemoryVigoApi } from './helpers/in-memory-vigo-api.mjs'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-library-switch-'))
let api
try {
  const inputs = await writeCliFixtureInputs(directory)
  const configDirectory = path.join(directory, 'config')
  const libraries = { a: path.join(directory, 'library-a'), b: path.join(directory, 'library-b') }
  for (const library of [configDirectory, ...Object.values(libraries)]) await fs.mkdir(library, { recursive: true })
  await fs.writeFile(path.join(configDirectory, 'config.json'), JSON.stringify({ storageRoot: libraries.a }))
  const barrier = path.join(directory, 'route-barrier')
  api = await startInMemoryVigoApi({ repositoryRoot: path.resolve(import.meta.dirname, '..'), environment: {
    VIGO_CONFIG_DIR: configDirectory, VIGO_PROJECTS_DIR: '', VIGO_ROUTE_PROJECT_PREWARM: '0',
    VIGO_TEST_ROUTE_BARRIER: barrier,
  } })
  const request = async (url, method = 'GET', body, status = 200) => {
    const response = await api.requestJson(url, { method, ...(body === undefined ? {} : { body }) })
    assert.equal(response.status, status, `${method} ${url}: ${JSON.stringify(response.body)}`)
    return response.body
  }
  const switchTo = async library => {
    const result = await request('/api/config', 'PATCH', { storageRoot: library })
    assert.equal(result.config.storageRoot, library)
  }
  const wait = async (base, job) => {
    const deadline = Date.now() + 60_000
    while (['queued', 'running'].includes(job.status) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 30))
      job = (await request(`${base}/national-gtfs-job?jobId=${job.id}`)).job
    }
    assert.equal(job.status, 'complete', JSON.stringify(job))
    return job
  }
  // A City in the current library: streets, then a timetable whose transfers
  // the preparation pool links to them.
  const createCity = async name => {
    const { project } = await request('/api/projects', 'POST', { name }, 201)
    const base = `/api/projects/${project.id}`
    await wait(base, (await request(`${base}/national-osm-import`, 'POST', { sourcePath: inputs.osmPath }, 202)).job)
    const imported = await wait(base, (await request(`${base}/national-gtfs-import`, 'POST', {
      sourcePath: inputs.gtfsPath, preloadServiceDate: '2026-07-15',
    }, 202)).job)
    return { base, feedId: imported.result.feedId }
  }
  const routeBody = { mode: 'transit', feedId: '__project__',
    origin: { source: 'map', coordinate: [-77.05, 38.9], label: 'Alpha' },
    destination: { source: 'map', coordinate: [-77.03, 38.91], label: 'Bravo' },
    serviceDate: '2026-07-15', serviceDay: 'weekday', routingDataMode: 'scheduled',
    timePreference: 'depart', departMinutes: 475, maxWalkKm: 0.6, allowLongWalk: false }
  const route = base => request(`${base}/national-route`, 'POST', routeBody)
  const analyze = (city) => request(`${city.base}/gtfs-route-analysis`, 'POST', { feedId: city.feedId, routeId: 'R1', serviceDate: '2026-07-15' })
  const resident = async () => (await request('/api/health')).nativeRuntime.residentCities.map(city => city.root)

  await switchTo(libraries.a)
  const a = await createCity('Library A')
  assert.equal((await route(a.base)).choices[0].status, 'ready')
  await analyze(a)
  assert((await resident()).some(root => root.startsWith(libraries.a)), 'Library A is open before the switch')

  // A route of library A that has selected its City but not yet reached the
  // native runtime when the library changes is refused when it gets there;
  // it never reopens A. The barrier holds it across the switch.
  await fs.writeFile(barrier, '')
  const inFlight = api.requestJson(`${a.base}/national-route`, { method: 'POST', body: routeBody })
  const reached = Date.now() + 30_000
  while (!(await fs.access(`${barrier}.reached`).then(() => true, () => false))) {
    assert(Date.now() < reached, 'The in-flight route reached the barrier')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  await switchTo(libraries.b)
  await fs.rm(barrier)
  const refused = await inFlight
  assert.notEqual(refused.status, 200, 'Work begun under library A is refused after the switch')
  assert.match(JSON.stringify(refused.body), /library changed/)
  assert(!(await resident()).some(root => root.startsWith(libraries.a)), 'No work of library A reopened it after the switch')

  // The preparation pool and the native runtime serve library B without a restart.
  const b = await createCity('Library B')
  assert.equal((await route(b.base)).choices[0].status, 'ready')
  await analyze(b)

  // And library A again.
  await switchTo(libraries.a)
  assert.equal((await route(a.base)).choices[0].status, 'ready')
  await analyze(a)
  const health = await request('/api/health')
  assert.equal(health.nativeRuntime.admission.pending, 0, 'No admitted native work is left behind')
  assert.equal(health.nativeRuntime.epoch, 2, 'Each switch reset the native runtime once')
  console.log('Library switch: imports, routes and route analysis work after A → B → A without a restart; switched-away work never reopens its City.')
} finally {
  await api?.stop()
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
