import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import JSZip from 'jszip'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readNationalGtfsStoreMetadata } from '../src/server/national-gtfs-store.mjs'
import { normalizeReceivedRoutingPlan } from '../src/app/routingPlan.ts'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { startInMemoryVigoApi } from './helpers/in-memory-vigo-api.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliPath = path.join(repositoryRoot, 'public', 'vigo.mjs')
const serviceDate = '2026-07-15'
const projectId = 'interface-parity'
let apiRuntime

function finiteOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null
}

function canonicalLeg(leg) {
  return {
    type: String(leg?.type ?? ''),
    travelMode: String(leg?.travelMode ?? ''),
    walkSource: leg?.type === 'walk' ? String(leg?.walkSource ?? '') : null,
    routeId: leg?.type === 'ride' ? String(leg?.routeId ?? '') : null,
    routeShortName: leg?.type === 'ride' ? String(leg?.routeShortName ?? '') : null,
    tripId: leg?.type === 'ride' ? String(leg?.tripId ?? '') : null,
    fromStopId: leg?.fromStopId == null ? null : String(leg.fromStopId),
    toStopId: leg?.toStopId == null ? null : String(leg.toStopId),
    startMinutes: finiteOrNull(leg?.startMinutes),
    endMinutes: finiteOrNull(leg?.endMinutes),
    durationMinutes: finiteOrNull(leg?.durationMinutes),
    stopCount: finiteOrNull(leg?.stopCount),
  }
}

/**
 * Interface adapters add IDs, labels, process timing, cache state, geometry,
 * and serialization metadata. This projection retains only route semantics
 * and deterministic engine identities that every public surface must preserve.
 */
function canonicalPlan(plan) {
  const diagnostics = plan?.diagnostics ?? {}
  return {
    status: String(plan?.status ?? ''),
    travelMode: String(plan?.travelMode ?? ''),
    timePreference: String(plan?.timePreference ?? ''),
    departMinutes: finiteOrNull(plan?.departMinutes),
    arriveMinutes: finiteOrNull(plan?.arriveMinutes),
    durationMinutes: finiteOrNull(plan?.durationMinutes),
    waitMinutes: finiteOrNull(plan?.waitMinutes),
    walkMinutes: finiteOrNull(plan?.walkMinutes),
    rideMinutes: finiteOrNull(plan?.rideMinutes),
    transfers: finiteOrNull(plan?.transfers),
    originStopId: plan?.origin?.stopId == null ? null : String(plan.origin.stopId),
    destinationStopId: plan?.destination?.stopId == null ? null : String(plan.destination.stopId),
    legs: Array.isArray(plan?.legs) ? plan.legs
      .filter((leg) => !(leg.type === 'walk' && leg.walkSource === 'station-selection' && leg.durationMinutes === 0))
      .map(canonicalLeg) : [],
    diagnostics: {
      algorithm: String(diagnostics.algorithm ?? ''),
      methodRequested: String(diagnostics.methodRequested ?? ''),
      methodUsed: Array.isArray(diagnostics.methodUsed)
        ? diagnostics.methodUsed.map(String)
        : String(diagnostics.methodUsed ?? ''),
      methodState: String(diagnostics.methodState ?? ''),
      optimality: String(diagnostics.optimality ?? ''),
      scheduleMode: String(diagnostics.scheduleMode ?? ''),
      timingPrecision: String(diagnostics.timingPrecision ?? ''),
      serviceDate: String(diagnostics.serviceDate ?? diagnostics.resolvedServiceDate ?? ''),
      serviceDay: String(diagnostics.serviceDay ?? ''),
      searchProfile: String(diagnostics.searchProfile ?? ''),
      searchStrategy: String(diagnostics.searchStrategy ?? ''),
      walkingNetwork: String(diagnostics.walkingNetwork ?? ''),
      walkingPolicyId: String(diagnostics.walkingPolicyId ?? ''),
      scannedDepartures: finiteOrNull(diagnostics.scannedDepartures),
      relaxedStops: finiteOrNull(diagnostics.relaxedStops),
    },
  }
}

function fixtureProject(storeMetadata) {
  const timestamp = new Date(0).toISOString()
  return {
    id: projectId,
    schemaVersion: 'vigo.project.v1',
    name: 'Interface parity fixture',
    region: 'Fixture',
    createdAt: timestamp,
    updatedAt: timestamp,
    feeds: [],
    jobs: [],
    artifacts: [],
    routingStore: {
      schemaVersion: 'vigo.routing.store.v1',
      status: 'ready',
      fileName: 'project.sqlite',
      storeId: storeMetadata.storeId,
      stopCount: storeMetadata.stopCount,
      routeCount: storeMetadata.routeCount,
      tripCount: storeMetadata.tripCount,
      connectionCount: storeMetadata.connectionCount,
    },
    osmStreetIndex: {
      schemaVersion: 'vigo.street.store.v4',
      status: 'ready',
      fileName: 'street-index.sqlite',
      cch: { ready: true, format: 'fixture' },
    },
  }
}

async function startApi(projectsPath, configPath) {
  apiRuntime = await startInMemoryVigoApi({
    repositoryRoot,
    environment: {
      VIGO_PROJECTS_DIR: projectsPath,
      VIGO_CONFIG_DIR: configPath,
      VIGO_ROUTE_WORKER_IDLE_MS: '5000',
      VIGO_ROUTE_PREWARM_IDLE_MS: '5000',
    },
  })
  return apiRuntime.baseUrl
}

async function stopApi() {
  await apiRuntime?.stop()
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    ...options,
  })
}

async function httpPlan(apiUrl) {
  const response = await apiRuntime.fetch(
    new URL(`api/projects/${projectId}/national-route`, apiUrl),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        origin: {
          stopId: 'A',
          coordinate: [-77.050, 38.900],
          label: 'Alpha',
          source: 'stop',
        },
        destination: {
          stopId: 'B',
          coordinate: [-77.030, 38.910],
          label: 'Bravo',
          source: 'stop',
        },
        departMinutes: 7 * 60 + 55,
        arriveMinutes: 7 * 60 + 55,
        timePreference: 'depart',
        serviceDay: 'weekday',
        serviceDate,
        allowServiceDateFallback: false,
        maxWalkKm: 0.2,
        departureWindowMinutes: 0,
      }),
    },
  )
  const payload = await response.json().catch(() => ({}))
  assert.equal(response.status, 200, `production HTTP route failed: ${JSON.stringify(payload)}`)
  assert.equal(payload?.choices?.length, 1, 'Fixed-departure HTTP must expose its canonical plan as the sole choice.')
  assert.deepEqual(payload.choices[0], payload.plan, 'HTTP choice zero must be the exact canonical plan.')
  assert.equal(payload.plan.diagnostics?.searchStats?.heuristicMode, 'none', 'HTTP must not expose heuristic routing controls.')
  assert.equal(
    Object.hasOwn(payload.plan.diagnostics?.searchStats ?? {}, 'heuristicWeight'),
    false,
    'HTTP must not retain the retired heuristic-weight control.',
  )
  assert.equal(payload.plan.status, 'ready')
  assert(!Object.hasOwn(payload.plan.diagnostics?.searchStats ?? {}, 'resultCachePolicy'))
  return payload.plan
}

function cliBatchPlan(cityPath, temporaryRoot) {
  const odPath = path.join(temporaryRoot, 'od.csv')
  const csvPath = path.join(temporaryRoot, 'routes.csv')
  fs.writeFileSync(odPath, 'id,origin_stop_id,destination_stop_id\nparity,A,B\n')
  const result = runCli([
    'route',
    `--city=${cityPath}`,
    `--input=${odPath}`,
    `--output=${csvPath}`,
    '--time=07:55',
    '--time-preference=depart',
    '--service-day=weekday',
    `--service-date=${serviceDate}`,
    '--max-walk=0.2',
    '--departure-window=0',
  ])
  assert.equal(result.status, 0, `JS CLI batch failed: ${result.stderr}`)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.schemaVersion, 'vigo.result.route.v1')
  assert.equal(payload.results?.length, 1)
  return payload.results[0].plan
}

function pythonStreamPlan(cityPath) {
  const result = runCli([
    '_route-stream',
    `--city=${cityPath}`,
    '--time=07:55',
    '--time-preference=depart',
    '--service-day=weekday',
    `--service-date=${serviceDate}`,
    '--max-walk=0.2',
    '--departure-window=0',
  ], {
    input: `${JSON.stringify({
      id: 'parity',
      origin: 'A',
      destination: 'B',
    })}\n`,
  })
  assert.equal(result.status, 0, `Python route stream failed: ${result.stderr}`)
  const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].schemaVersion, 'vigo.result.route.v1')
  assert.equal(rows[0].status, 'ok')
  return rows[0].plan
}

assert(fs.existsSync(cliPath), 'Built production CLI is missing. Run npm run build:cli.')
const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'vigo-interface-parity-'))
try {
  const projectsPath = path.join(temporaryRoot, 'projects')
  const configPath = path.join(temporaryRoot, 'config')
  const projectMetaPath = path.join(projectsPath, projectId, '.vigo')
  const storePath = path.join(projectMetaPath, 'routing', 'project.sqlite')
  await fsp.mkdir(path.dirname(projectMetaPath), { recursive: true })
  const { gtfsPath, osmPath } = await writeCliFixtureInputs(temporaryRoot)
  const zip = await JSZip.loadAsync(await fsp.readFile(gtfsPath))
  // Transit must beat the fixture's valid end-to-end walk, which is otherwise
  // the only nondominated choice for these nearby endpoints.
  zip.file('stop_times.txt', (await zip.file('stop_times.txt').async('string'))
    .replaceAll('08:10:00', '08:03:00').replaceAll('08:15:00', '08:04:00').replaceAll('08:30:00', '08:10:00'))
  for (const [file, rows] of [
    ['routes.txt', 'DIRECT,fixture,DIRECT,Direct service,3\n'],
    ['trips.txt', 'DIRECT,WKD,TD,0\n'],
    ['stop_times.txt', 'TD,08:00:00,08:00:00,A,1\nTD,08:12:00,08:12:00,B,2\n'],
  ]) zip.file(file, await zip.file(file).async('string') + rows)
  await fsp.writeFile(gtfsPath, await zip.generateAsync({ type: 'nodebuffer' }))
  const built = runCli([
    'build',
    `--gtfs=${gtfsPath}`,
    `--osm=${osmPath}`,
    `--output=${projectMetaPath}`,
  ])
  assert.equal(built.status, 0, `City build failed: ${built.stderr}`)
  const metadata = readNationalGtfsStoreMetadata(storePath)

  await fsp.writeFile(
    path.join(projectMetaPath, 'project.json'),
    `${JSON.stringify(fixtureProject(metadata), null, 2)}\n`,
  )

  const apiUrl = await startApi(projectsPath, configPath)
  const plans = {
    http: await httpPlan(apiUrl),
    cliBatch: cliBatchPlan(projectMetaPath, temporaryRoot),
    pythonStream: pythonStreamPlan(projectMetaPath),
  }
  const signatures = Object.fromEntries(
    Object.entries(plans).map(([surface, plan]) => [surface, canonicalPlan(plan)]),
  )
  for (const surface of ['cliBatch', 'pythonStream']) {
    assert.deepEqual(
      signatures[surface],
      signatures.http,
      `${surface} diverged from the production HTTP route signature.`,
    )
  }

  // Studio displays the same route after presentation-only normalization.
  const desktopPlan = normalizeReceivedRoutingPlan(structuredClone(plans.http))
  assert.deepEqual(
    canonicalPlan(desktopPlan),
    canonicalPlan(plans.http),
    'Studio presentation normalization changed route semantics.',
  )

  const matrixResponse = await apiRuntime.fetch(
    new URL(`api/projects/${projectId}/national-matrix`, apiUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ origins: [plans.http.origin],
        destinations: Array.from({ length: 1024 }, () => plans.http.destination),
        departMinutes: 475, serviceDate, serviceDay: 'weekday', maxWalkKm: 0.2 }),
    },
  )
  const matrixBody = await matrixResponse.json()
  assert.equal(matrixResponse.status, 200, JSON.stringify(matrixBody))
  assert.equal(matrixBody.matrix.rows.length, 1024)
  assert.equal(matrixBody.matrix.diagnostics.forwardSearches, 1)
  assert(matrixBody.matrix.rows.every((row) => row.status === 'ready' && row.arriveMinutes === 490))

  const arriveResponse = await apiRuntime.fetch(new URL(`api/projects/${projectId}/national-route`, apiUrl), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ origin: plans.http.origin, destination: plans.http.destination,
      timePreference: 'arrive', arriveMinutes: 510, serviceDate, serviceDay: 'weekday', maxWalkKm: 0.2 }),
  })
  const arriveReference = (await arriveResponse.json()).plan
  assert.equal(arriveResponse.status, 200)
  assert.equal(arriveReference.status, 'ready')
  for (const timePreference of ['depart', 'arrive']) {
    for (const manyOrigins of [false, true]) {
      const response = await apiRuntime.fetch(new URL(`api/projects/${projectId}/national-matrix`, apiUrl), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          origins: Array(manyOrigins ? 1024 : 1).fill(plans.http.origin),
          destinations: Array(manyOrigins ? 1 : 1024).fill(plans.http.destination),
          timePreference, arriveMinutes: 510, departMinutes: 475,
          serviceDate, serviceDay: 'weekday', maxWalkKm: 0.2,
        }),
      })
      const body = await response.json()
      assert.equal(response.status, 200, JSON.stringify(body))
      assert.equal(body.matrix.rows.length, 1024)
      assert.equal(body.matrix.diagnostics[timePreference === 'arrive' ? 'reverseSearches' : 'forwardSearches'], 1)
      assert(body.matrix.rows.every(row => row.status === 'ready'))
      if (timePreference === 'arrive') {
        assert(body.matrix.rows.every(row => Math.abs(row.departMinutes - arriveReference.departMinutes) < 1e-9 && row.arriveMinutes === 510))
      }
    }
  }

  for (const timePreference of ['depart', 'arrive']) {
    for (const maxTransfers of [0, 1]) {
      const query = { origin: plans.http.origin, destination: plans.http.destination,
        timePreference, departMinutes: 475, arriveMinutes: 495,
        serviceDate, serviceDay: 'weekday', maxWalkKm: 0.2, maxTransfers }
      const response = await apiRuntime.fetch(new URL(`api/projects/${projectId}/national-route`, apiUrl), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(query),
      })
      const body = await response.json()
      assert.equal(response.status, 200, JSON.stringify(body))
      assert.equal(body.plan.status, 'ready')
      // All services depart at 08:00. Arrive-by has time for the direct trip.
      const direct = timePreference === 'arrive' || maxTransfers === 0
      assert.deepEqual([body.plan.arriveMinutes, body.plan.transfers], direct ? [492, 0] : [490, 1])
      const stream = runCli(['_route-stream', `--city=${projectMetaPath}`, `--service-date=${serviceDate}`,
        '--max-walk=0.2'], { input: JSON.stringify({ id: 'capped', origin: 'A', destination: 'B',
          timePreference, time: timePreference === 'arrive' ? '08:15' : '07:55', maxTransfers }) + '\n' })
      assert.equal(stream.status, 0, stream.stderr)
      assert.deepEqual(canonicalPlan(JSON.parse(stream.stdout).plan), canonicalPlan(body.plan))
      const matrixResponse = await apiRuntime.fetch(new URL(`api/projects/${projectId}/national-matrix`, apiUrl), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...query, origins: [query.origin], destinations: [query.destination] }),
      })
      const matrix = (await matrixResponse.json()).matrix
      assert.equal(matrixResponse.status, 200)
      const field = timePreference === 'arrive' ? 'departMinutes' : 'arriveMinutes'
      assert.equal(matrix.rows[0][field], body.plan[field])
    }
  }

  const alternativesResponse = await apiRuntime.fetch(
    new URL(`api/projects/${projectId}/national-route`, apiUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ origin: plans.http.origin, destination: plans.http.destination,
        departMinutes: 475, serviceDate, serviceDay: 'weekday', maxWalkKm: 0.2,
        timePreference: 'depart', departureWindowMinutes: 10, departureWindowDirection: 'forward' }),
    },
  )
  const alternatives = await alternativesResponse.json()
  assert.equal(alternativesResponse.status, 200, JSON.stringify(alternatives))
  const metrics = (choices) => choices.map((plan) => [plan.arriveMinutes, plan.transfers])
  assert.deepEqual(metrics(alternatives.choices), [[490, 1], [492, 0]],
    'Production HTTP must expose the slightly slower direct service.')
  assert.deepEqual(metrics(alternatives.choices.map((plan) => normalizeReceivedRoutingPlan(structuredClone(plan)))),
    metrics(alternatives.choices), 'Studio normalization must preserve the alternative journeys.')
  const requestPath = path.join(temporaryRoot, 'alternative-request.json')
  await fsp.writeFile(requestPath, JSON.stringify({ origin: 'A', destination: 'B' }))
  const alternativeCli = runCli(['route', `--city=${projectMetaPath}`, `--request=${requestPath}`,
    '--time=07:55', `--service-date=${serviceDate}`, '--max-walk=0.2', '--departure-window=10'])
  assert.equal(alternativeCli.status, 0, alternativeCli.stderr)
  assert.deepEqual(metrics(JSON.parse(alternativeCli.stdout).choices), metrics(alternatives.choices),
    'CLI JSON must preserve the same meaningful alternatives as HTTP.')
  const alternativeBatch = runCli(['route', `--city=${projectMetaPath}`,
    `--input=${path.join(temporaryRoot, 'od.csv')}`, `--output=${path.join(temporaryRoot, 'alternatives.csv')}`,
    '--time=07:55', `--service-date=${serviceDate}`, '--max-walk=0.2', '--departure-window=10'])
  assert.equal(alternativeBatch.status, 0, alternativeBatch.stderr)
  assert.deepEqual(metrics(JSON.parse(alternativeBatch.stdout).results[0].choices), metrics(alternatives.choices))
  const alternativeStream = runCli(['_route-stream', `--city=${projectMetaPath}`,
    '--time=07:55', `--service-date=${serviceDate}`, '--max-walk=0.2', '--departure-window=10'], {
    input: `${JSON.stringify({ id: 'alternatives', origin: 'A', destination: 'B' })}\n`,
  })
  assert.equal(alternativeStream.status, 0, alternativeStream.stderr)
  assert.deepEqual(metrics(JSON.parse(alternativeStream.stdout).choices), metrics(alternatives.choices))

  console.log(JSON.stringify({
    schemaVersion: 'vigo.routing.interface-parity.check.v1',
    status: 'passed',
    fixture: {
      serviceDate,
      storeId: metadata.storeId,
      stops: metadata.stopCount,
      routes: metadata.routeCount,
      trips: metadata.tripCount,
      connections: metadata.connectionCount,
    },
    interfaces: {
      productionHttp: 'src/server/vigo-api.mjs -> national-route worker',
      desktop: 'route result -> normalizeReceivedRoutingPlan',
      javascriptBatch: 'public/vigo.mjs route',
      pythonStream: 'public/vigo.mjs _route-stream',
    },
    excludedInterfaceFields: [
      'plan IDs and human labels',
      'geometry coordinates and display metadata',
      'zero-duration station-selection legs removed by presentation normalization',
      'process, request, materialization, and serialization timings',
      'worker-lifecycle state',
      'CLI schema wrappers and request IDs',
    ],
    desktopPresentationBoundary: {
      rawLegCount: plans.http.legs.length,
      normalizedLegCount: desktopPlan.legs.length,
      presentationLegChange: desktopPlan.legs.length - plans.http.legs.length,
    },
    canonical: signatures.http,
  }, null, 2))
} finally {
  await stopApi()
  await fsp.rm(temporaryRoot, { recursive: true, force: true })
}
