import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { startInMemoryVigoApi } from './helpers/in-memory-vigo-api.mjs'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { disposeNationalGtfsStore, prepareNationalGtfsNativeCoordinateAccess } from '../src/server/national-gtfs-store.mjs'
import { disposeNativeRoutingKernel } from '../src/server/native-routing-kernel.mjs'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-studio-frequency-'))
let runtime
try {
  const inputs = await writeCliFixtureInputs(directory)
  runtime = await startInMemoryVigoApi({ repositoryRoot: path.resolve(import.meta.dirname, '..'),
    ...(process.env.VIGO_TEST_SERVER ? { serverPath: process.env.VIGO_TEST_SERVER } : {}),
    ...(process.env.VIGO_TEST_EXECUTABLE ? { executable: process.env.VIGO_TEST_EXECUTABLE } : {}), environment: {
    VIGO_CONFIG_DIR: path.join(directory, 'config'), VIGO_PROJECTS_DIR: path.join(directory, 'cities'),
  } })
  const request = async (url, method = 'GET', body, status = 200) => {
    const response = await runtime.fetch(url, { method, headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) })
    const result = await response.json()
    assert.equal(response.status, status, JSON.stringify(result))
    return result
  }
  for (const mixed of [false, true]) {
    const zip = await JSZip.loadAsync(await fs.readFile(inputs.gtfsPath))
    zip.file('frequencies.txt', 'trip_id,start_time,end_time,headway_secs,exact_times\nT1,07:00:00,11:00:00,600,0\nT2,07:00:00,11:00:00,900,0\n')
    if (mixed) {
      zip.file('trips.txt', (await zip.file('trips.txt').async('string')).trimEnd() + '\nR1,WKD,LATE,0\n')
      zip.file('stop_times.txt', (await zip.file('stop_times.txt').async('string')).trimEnd()
        + '\nLATE,23:00:00,23:00:00,A,1\nLATE,23:10:00,23:10:00,X,2\n')
    }
    const sourcePath = path.join(directory, `${mixed ? 'mixed' : 'frequency'}.zip`)
    await fs.writeFile(sourcePath, await zip.generateAsync({ type: 'nodebuffer' }))
    const { project } = await request('/api/projects', 'POST', { name: mixed ? 'Mixed timetable' : 'Frequency timetable' }, 201)
    const base = `/api/projects/${project.id}`
    const wait = async job => {
      const deadline = Date.now() + 60_000
      while (['running', 'queued'].includes(job.status) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 30))
        job = (await request(`${base}/national-gtfs-job?jobId=${job.id}`)).job
      }
      assert.equal(job.status, 'complete', JSON.stringify(job))
      return job
    }
    const imported = await wait((await request(`${base}/national-gtfs-import`, 'POST', {
      sourcePath, preloadServiceDate: '2026-07-15',
    }, 202)).job)
    assert.equal(imported.result.preload.engine, 'rust_frequency_timetable')
    assert.equal(imported.result.preload.nativeTimetableReady, false, 'Import does not claim activation before streets exist')
    await wait((await request(`${base}/national-osm-import`, 'POST', { sourcePath: inputs.osmPath }, 202)).job)
    if (!mixed) {
      // A prior compiler may produce a different graph from the same PBF.
      // Runtime readers reject its incompatible indexes; an explicit reimport
      // must replace them instead of attempting to reuse that generation.
      const streetDirectory = path.join(directory, 'cities', project.id, '.vigo', 'osm')
      const routingDirectory = path.join(directory, 'cities', project.id, '.vigo', 'routing')
      const storePath = path.join(routingDirectory, (await fs.readdir(routingDirectory)).find(name => name.endsWith('.sqlite') && !name.endsWith('.static-topology.sqlite')))
      const streetPath = path.join(streetDirectory, 'street-index.sqlite')
      const access = prepareNationalGtfsNativeCoordinateAccess(storePath, streetPath)
      const staleProfile = await fs.readFile(access.snapshotPath)
      staleProfile.writeBigUInt64LE(staleProfile.readBigUInt64LE(24) ^ 1n, 24)
      await fs.writeFile(access.snapshotPath, staleProfile)
      disposeNationalGtfsStore(storePath)
      disposeNativeRoutingKernel(streetPath)
      const manifests = (await fs.readdir(streetDirectory)).filter(name => name.endsWith('.manifest.json'))
      assert.equal(manifests.length, 2, 'Both walking and driving indexes were prepared')
      for (const name of manifests) {
        const file = path.join(streetDirectory, name)
        const manifest = JSON.parse(await fs.readFile(file, 'utf8'))
        manifest.nodeCount += 1
        await fs.writeFile(file, JSON.stringify(manifest))
      }
      // The reimport rewrites the street files in place. Nothing may map them
      // until it ends (Windows refuses to replace mapped files): while the job
      // runs the City is never resident in the native runtime, and no
      // preparation worker (whose routing-access warm-up maps the street
      // hierarchy) runs for it.
      const cityRoot = path.join(directory, 'cities', project.id, '.vigo')
      let reimport = (await request(`${base}/national-osm-import`, 'POST', { sourcePath: inputs.osmPath }, 202)).job
      const reimportDeadline = Date.now() + 60_000
      while (['running', 'queued'].includes(reimport.status) && Date.now() < reimportDeadline) {
        const health = await request('/api/health')
        const resident = health.nativeRuntime.residentCities.map(city => city.root)
        assert(!resident.some(root => root === cityRoot || root.startsWith(`${cityRoot}${path.sep}`)),
          `The City reopened while its streets were being replaced: ${JSON.stringify(resident)}`)
        assert.equal(health.routingRuntime.workerCount, 0, 'A preparation worker ran while the streets were being replaced')
        await new Promise(resolve => setTimeout(resolve, 10))
        reimport = (await request(`${base}/national-gtfs-job?jobId=${reimport.id}`)).job
      }
      assert.equal(reimport.status, 'complete', JSON.stringify(reimport))
      const retainedProfile = await fs.readFile(access.snapshotPath).catch(error => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
      assert(!retainedProfile || !retainedProfile.equals(staleProfile), 'Street replacement must discard access profiles tied to the previous CCH')
    }
    const catalog = (await request(`${base}?detail=catalog`)).project.feeds[0].mapPreview
    assert.deepEqual(catalog.stops.map(stop => stop.id).sort(), ['A', 'B', 'X'], 'Frequency stops must be selectable on the map')
    assert.equal(catalog.routes.length, 2)
    assert(catalog.routes.every(route => route.stopCount >= 2), 'Frequency-only routes retain their stops')
    if (!mixed) assert(catalog.routes.every(route => route.firstDepartureMinutes === undefined), 'Template offsets must not be shown as fixed departures')
    const routeBody = { mode: 'transit', feedId: '__project__',
      origin: { source: 'map', coordinate: [-77.05, 38.9], label: 'Alpha' },
      destination: { source: 'map', coordinate: [-77.03, 38.91], label: 'Bravo' },
      serviceDate: '2026-07-15', serviceDay: 'weekday', routingDataMode: 'scheduled',
      timePreference: 'depart', departMinutes: 480, maxWalkKm: 0.2, allowLongWalk: false }
    const ordinary = (await request(`${base}/national-route`, 'POST', routeBody)).choices[0]
    assert.equal(ordinary.status, 'ready', JSON.stringify(ordinary))
    assert(ordinary.legs.some(leg => leg.type === 'ride'), 'The ordinary request must exercise frequency transit')
    const bike = (await request(`${base}/national-route`, 'POST', { ...routeBody, mode: 'bike', bike: { profile: 'quiet', speedKph: 18 } })).choices[0]
    assert.equal(bike.status, 'ready', 'Studio street import must prepare bicycle routing')
    const reachBody = { origin: routeBody.origin, serviceDate: routeBody.serviceDate,
      departMinutes: 480, mode: 'transit', rasterSize: 48, radiusKm: 2,
      maxWalkKm: 0.2, cutoffsMinutes: [45], includeStreetEdges: false,
      monteCarlo: { startMinutes: 480, endMinutes: 482, draws: 8, seed: 42, percentiles: [50] } }
    const first = (await request(`${base}/reach`, 'POST', reachBody)).result
    // GTFS frequencies are concrete departures every headway, so the
    // distribution takes one sample per departure minute (480 and 481), not
    // random draws.
    assert.equal(first.distributions.baseline.sampling.stochastic, false)
    assert.equal(first.distributions.baseline.sampling.sampleCount, 2)
    const repeated = (await request(`${base}/reach`, 'POST', reachBody)).result
    assert.deepEqual(first.distributions, repeated.distributions)
    const after = (await request(`${base}/national-route`, 'POST', routeBody)).choices[0]
    assert.deepEqual(after.legs, ordinary.legs, 'Sampling must not change ordinary transit journeys')
  }
  console.log('Studio pure/mixed frequency imports, imported bike routing, deterministic Monte Carlo and ordinary transit isolation passed.')
} finally {
  await runtime?.stop()
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
