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
      schemaVersion: 'vigo.routing.store.v4',
      status: 'ready',
      fileName: 'project.sqlite',
      storeId: storeMetadata.storeId,
      stopCount: storeMetadata.stopCount,
      routeCount: storeMetadata.routeCount,
      tripCount: storeMetadata.tripCount,
      connectionCount: storeMetadata.connectionCount,
    },
    osmStreetIndex: {
      schemaVersion: 'vigo.street.store.v6',
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
  if (['route','matrix','reach','stream'].includes(args[0])) args = [...args, '--diagnostics=trace']
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
  assert.equal(payload.selectedPlanId, payload.choices[0].id)
  assert.equal(Object.hasOwn(payload, 'plan'), false, 'Studio sends each journey once.')
  assert.equal(payload.choices[0].diagnostics?.searchStats?.heuristicMode, undefined, 'Studio excludes internal search settings.')
  assert.equal(
    Object.hasOwn(payload.choices[0].diagnostics?.searchStats ?? {}, 'heuristicWeight'),
    false,
    'HTTP must not retain the retired heuristic-weight control.',
  )
  assert.equal(payload.choices[0].status, 'ready')
  assert(!Object.hasOwn(payload.choices[0].diagnostics?.searchStats ?? {}, 'resultCachePolicy'))
  return payload.choices[0]
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
    '--service-day=weekday',
    `--service-date=${serviceDate}`,
    '--max-walk=0.2',
  ])
  assert.equal(result.status, 0, `JS CLI batch failed: ${result.stderr}`)
  const envelope = JSON.parse(result.stdout)
  const payload = envelope.trace ?? envelope
  assert.equal(payload.schemaVersion, 'vigo.result.route.v1')
  assert.equal(payload.results?.length, 1)
  return payload.results[0].plan
}

function pythonStreamPlan(cityPath) {
  const result = runCli([
    'stream',
    `--city=${cityPath}`,
    '--time=07:55',
    '--service-day=weekday',
    `--service-date=${serviceDate}`,
    '--max-walk=0.2',
  ], {
    input: `${JSON.stringify({
      kind: 'route', id: 'parity',
      origin: 'A',
      destination: 'B',
    })}\n`,
  })
  assert.equal(result.status, 0, `Python route stream failed: ${result.stderr}`)
  const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line).trace)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].schemaVersion, 'vigo.result.route.v1')
  assert.equal(rows[0].status, 'ready')
  return rows[0].result
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

  // Real HTTP waypoint routing must keep fractional leg clocks, in both
  // directions, instead of reapplying the public whole-minute input check.
  const orderedPoints = [
    { coordinate: [-77.050, 38.900], label: 'Origin', source: 'map' },
    { coordinate: [-77.03999, 38.90501], label: 'Via', source: 'map' },
    { coordinate: [-77.030, 38.910], label: 'Destination', source: 'map' },
  ]
  for (const mode of ['walk', 'drive', 'transit']) {
    for (const timePreference of ['depart', 'arrive']) {
      const request = {
        origin: orderedPoints[0], waypoints: [orderedPoints[1]], destination: orderedPoints[2],
        mode, timePreference, departMinutes: timePreference === 'arrive' ? 510 : 475,
        arriveMinutes: 510, serviceDate, serviceDay: 'weekday', maxWalkKm: 0.2,
      }
      const response = await apiRuntime.fetch(new URL(`api/projects/${projectId}/national-route`, apiUrl), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
      })
      const body = await response.json()
      assert.equal(response.status, 200, `${mode} ${timePreference} waypoints: ${JSON.stringify(body)}`)
      assert.equal(body.choices[0].status, 'ready', `${mode} ${timePreference}: ${body.choices[0].detail}`)
      assert.equal(body.choices[0].waypoints.length, 1)
      const firstSegmentEnd = body.choices[0].legs.filter(leg => leg.orderedSegmentIndex === 0).at(-1).endMinutes
      const secondSegmentStart = body.choices[0].legs.find(leg => leg.orderedSegmentIndex === 1).startMinutes
      assert(secondSegmentStart >= firstSegmentEnd - 0.002, 'A following leg cannot leave before reaching the waypoint.')
      if (mode !== 'transit') {
        assert(!Number.isInteger(firstSegmentEnd), 'Fixture must exercise a fractional intermediate clock.')
        assert(Math.abs(secondSegmentStart - firstSegmentEnd) < 0.002, 'Street waypoints must not add rounding waits.')
      }
      const requestPath = path.join(temporaryRoot, 'ordered-route.json')
      await fsp.writeFile(requestPath, JSON.stringify(request))
      const cli = runCli(['route', `--city=${projectMetaPath}`, `--request=${requestPath}`,
        `--service-date=${serviceDate}`, `--time=${timePreference === 'arrive' ? '08:30' : '07:55'}`,
        '--max-walk=0.2'])
      assert.equal(cli.status, 0, `${mode} ${timePreference} CLI waypoints: ${cli.stderr}`)
      assert.deepEqual(canonicalPlan(JSON.parse(cli.stdout).trace.result), canonicalPlan(body.choices[0]),
        `${mode} ${timePreference} ordered HTTP/CLI parity`)
    }
  }
  for (const timePreference of ['depart', 'arrive']) {
    const request = { origin: orderedPoints[0], waypoints: [orderedPoints[1]], destination: orderedPoints[2],
      mode: 'transit', timePreference, departMinutes: 510, arriveMinutes: 510,
      serviceDate: '2026-07-19', maxWalkKm: 0.2, requireTransitRide: true }
    const response = await apiRuntime.fetch(new URL(`api/projects/${projectId}/national-route`, apiUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.choices[0].status, 'blocked', 'Inactive service must preserve the failed waypoint component.')
    const requestPath = path.join(temporaryRoot, 'blocked-ordered-route.json')
    await fsp.writeFile(requestPath, JSON.stringify(request))
    const cli = runCli(['route', `--city=${projectMetaPath}`, `--request=${requestPath}`,
      '--service-date=2026-07-19', '--time=08:30', '--max-walk=0.2'])
    assert.equal(cli.status, 0, cli.stderr)
    assert.deepEqual(canonicalPlan(JSON.parse(cli.stdout).trace.result), canonicalPlan(body.choices[0]),
      `${timePreference} blocked waypoint HTTP/CLI parity`)
  }
  for (const total of [8, 9]) {
    const points = Array.from({ length: total }, (_, index) => orderedPoints[index % 3])
    const response = await apiRuntime.fetch(new URL(`api/projects/${projectId}/national-route`, apiUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        origin: points[0], waypoints: points.slice(1, -1), destination: points.at(-1),
        mode: 'walk', departMinutes: 475, serviceDate,
      }),
    })
    const body = await response.json()
    assert.equal(response.status, total === 8 ? 200 : 400, JSON.stringify(body))
    if (total === 8) assert.equal(body.choices[0].waypoints.length, 6)
  }

  const fractionalInput = await apiRuntime.fetch(new URL(`api/projects/${projectId}/national-route`, apiUrl), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      origin: orderedPoints[0], waypoints: [orderedPoints[1]], destination: orderedPoints[2],
      mode: 'walk', departMinutes: 475.5, __allowSubMinuteTimes: true, serviceDate,
    }),
  })
  assert.equal(fractionalInput.status, 400, 'Private flags must not bypass initial public time validation.')

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
  const arriveReference = (await arriveResponse.json()).choices[0]
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
      assert.equal(body.choices[0].status, 'ready')
      // All services depart at 08:00. Arrive-by has time for the direct trip.
      const direct = timePreference === 'arrive' || maxTransfers === 0
      assert.deepEqual([body.choices[0].arriveMinutes, body.choices[0].transfers], direct ? [492, 0] : [490, 1])
      const stream = runCli(['stream', `--city=${projectMetaPath}`, `--service-date=${serviceDate}`,
        '--max-walk=0.2'], { input: JSON.stringify({ kind: 'route', id: 'capped', origin: 'A', destination: 'B',
          timePreference, time: timePreference === 'arrive' ? '08:15' : '07:55', maxTransfers }) + '\n' })
      assert.equal(stream.status, 0, stream.stderr)
      assert.deepEqual(canonicalPlan(JSON.parse(stream.stdout).trace.result), canonicalPlan(body.choices[0]))
      const explicitStream = runCli(['stream', `--city=${projectMetaPath}`, `--service-date=${serviceDate}`,
        '--max-walk=0.2'], {
        input: JSON.stringify({ id: 'capped-route', kind: 'route', origin: 'A', destination: 'B',
          timePreference, time: timePreference === 'arrive' ? '08:15' : '07:55', maxTransfers }) + '\n',
      })
      assert.equal(explicitStream.status, 0, explicitStream.stderr)
      assert.deepEqual(canonicalPlan(JSON.parse(explicitStream.stdout).trace.result), canonicalPlan(body.choices[0]),
        'Each stream route must use its requested transfer cap instead of the process default.')
      const matrixResponse = await apiRuntime.fetch(new URL(`api/projects/${projectId}/national-matrix`, apiUrl), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...query, origins: [query.origin], destinations: [query.destination] }),
      })
      const matrix = (await matrixResponse.json()).matrix
      assert.equal(matrixResponse.status, 200)
      const field = timePreference === 'arrive' ? 'departMinutes' : 'arriveMinutes'
      assert.equal(matrix.rows[0][field], body.choices[0][field])
    }
  }


  const reachCaps = [0, 1, undefined, 0]
  const walkLimits = [false, true, false]
  const walkQueries = walkLimits.map((allowLongWalk, index) => ({ id: `walk-limit-${index}`, kind: 'matrix',
    origins: [{ coordinate: [-77.050, 38.900] }], destinations: [{ coordinate: [-77.030, 38.910] }],
    serviceDate, mode: 'transit', time: '20:00', horizonMinutes: 60, maxWalkKm: 0.2,
    requireTransitRide: false, allowLongWalk }))
  const walkStream = runCli(['stream', `--city=${projectMetaPath}`, `--service-date=${serviceDate}`], {
    input: walkQueries.map(q => JSON.stringify(q)).join('\n') + '\n',
  })
  assert.equal(walkStream.status, 0, walkStream.stderr)
  const walkMatrices = walkStream.stdout.trim().split('\n').map(line => JSON.parse(line).trace ?? JSON.parse(line))
  for (const [index, request] of walkQueries.entries()) {
    const expected = request.allowLongWalk ? 'ready' : 'blocked'
    assert.equal(walkMatrices[index].rows[0].status, expected,
      'Streamed Matrix must preserve the direct-walking limit independently for every request.')
    const single = runCli(['matrix', `--city=${projectMetaPath}`, '--request=-'], { input: JSON.stringify(request) })
    assert.equal(single.status, 0, single.stderr)
    assert.equal(JSON.parse(single.stdout).trace.rows[0].status, expected)
    const response = await apiRuntime.fetch(new URL(`api/projects/${projectId}/national-matrix`, apiUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, departMinutes: 1200, serviceDay: 'weekday' }),
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).matrix.rows[0].status, expected)
    const route = { ...request, origin: request.origins[0], destination: request.destinations[0] }
    route.kind = 'route'; delete route.origins; delete route.destinations
    const pointStream = runCli(['stream', `--city=${projectMetaPath}`, `--service-date=${serviceDate}`], {
      input: JSON.stringify(route) + '\n',
    })
    assert.equal(pointStream.status, 0, pointStream.stderr)
    assert.equal(JSON.parse(pointStream.stdout).trace.result.status, expected,
      'Streamed Route must preserve the same direct-walking limit.')
  }
  const streamedReach = runCli(['stream', `--city=${projectMetaPath}`, `--service-date=${serviceDate}`,
    '--max-walk=0.2'], {
    input: reachCaps.map((maxTransfers, index) => JSON.stringify({
      id: `reach-cap-${index}`, kind: 'reach', origin: 'A', time: '07:55',
      maxTransfers, cutoffsMinutes: [20], rasterSize: 48, includeStreetEdges: false,
    })).join('\n') + '\n',
  })
  assert.equal(streamedReach.status, 0, streamedReach.stderr)
  const reachResults = streamedReach.stdout.trim().split('\n').map(line => JSON.parse(line).trace ?? JSON.parse(line))
  assert.equal(reachResults.length, reachCaps.length)
  for (const [index, result] of reachResults.entries()) {
    const cap = reachCaps[index]
    assert.equal(result.status, 'ready')
    assert.equal(result.query.maxTransfers, cap)
    assert.equal(result.stops.find(stop => stop.stopId === 'B').durationMinutes, cap === 0 ? 17 : 15,
      'Each Reach request owns its transfer cap; omitting it restores unrestricted boarding.')
  }

  for (const minimumTransferBufferMinutes of [0, 2]) {
    const selection = { allowStreetTransfers: false, minimumTransferBufferMinutes }
    const query = { origin: plans.http.origin, destination: plans.http.destination,
      timePreference: 'depart', departMinutes: 475, serviceDate, serviceDay: 'weekday', maxWalkKm: 0.2, ...selection }
    const response = await apiRuntime.fetch(new URL(`api/projects/${projectId}/national-route`, apiUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(query),
    })
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.choices[0].arriveMinutes, minimumTransferBufferMinutes ? 492 : 490)
    assert.equal(body.choices[0].diagnostics.routingDataProvenance.searchParameters.allowStreetTransfers, false)
    assert.equal(body.choices[0].diagnostics.routingDataProvenance.searchParameters.minimumTransferBufferMinutes, minimumTransferBufferMinutes)
    const input = { kind: 'route', id: 'transfer-selection', origin: 'A', destination: 'B', ...selection }
    const stream = runCli(['stream', `--city=${projectMetaPath}`, '--time=07:55',
      `--service-date=${serviceDate}`, '--max-walk=0.2'], { input: JSON.stringify(input) + '\n' })
    assert.equal(stream.status, 0, stream.stderr)
    assert.deepEqual(canonicalPlan(JSON.parse(stream.stdout).trace.result), canonicalPlan(body.choices[0]))
    const selectionPath = path.join(temporaryRoot, 'selection-request.json')
    await fsp.writeFile(selectionPath, JSON.stringify(input))
    const jsonRoute = runCli(['route', `--city=${projectMetaPath}`, `--request=${selectionPath}`,
      '--time=07:55', `--service-date=${serviceDate}`, '--max-walk=0.2'])
    assert.equal(jsonRoute.status, 0, jsonRoute.stderr)
    assert.deepEqual(canonicalPlan(JSON.parse(jsonRoute.stdout).trace.result), canonicalPlan(body.choices[0]))
    const matrixResponse = await apiRuntime.fetch(new URL(`api/projects/${projectId}/national-matrix`, apiUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...query, origins: [query.origin], destinations: [query.destination] }),
    })
    const matrix = (await matrixResponse.json()).matrix
    assert.equal(matrixResponse.status, 200)
    assert.equal(matrix.rows[0].arriveMinutes, body.choices[0].arriveMinutes)
    await fsp.writeFile(selectionPath, JSON.stringify({ origins: ['A'], destinations: ['B'], ...selection }))
    const jsonMatrix = runCli(['matrix', `--city=${projectMetaPath}`, `--request=${selectionPath}`,
      '--time=07:55', `--service-date=${serviceDate}`, '--max-walk=0.2'])
    assert.equal(jsonMatrix.status, 0, jsonMatrix.stderr)
    assert.equal(JSON.parse(jsonMatrix.stdout).trace.rows[0].arriveMinutes, body.choices[0].arriveMinutes)
  }

  for (const timePreference of ['depart', 'arrive']) {
    const short = { origin: { coordinate: [-77.048, 38.901] }, destination: { coordinate: [-77.0479, 38.90105] },
      timePreference, departMinutes: 475, arriveMinutes: 475, serviceDate, maxWalkKm: .2, allowLongWalk: false }
    const response = await apiRuntime.fetch(new URL(`api/projects/${projectId}/national-route`, apiUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(short) })
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.choices[0].status, 'ready'); assert.equal(body.choices[0].travelMode, 'walk')
    assert(body.choices[0].durationMinutes < 1 && body.choices[0].legs.every(l => l.type !== 'ride'))
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
  assert.deepEqual(metrics(JSON.parse(alternativeCli.stdout).trace.choices), metrics(alternatives.choices),
    'CLI JSON must preserve the same meaningful alternatives as HTTP.')
  const alternativeBatch = runCli(['route', `--city=${projectMetaPath}`,
    `--input=${path.join(temporaryRoot, 'od.csv')}`, `--output=${path.join(temporaryRoot, 'alternatives.csv')}`,
    '--time=07:55', `--service-date=${serviceDate}`, '--max-walk=0.2', '--departure-window=10'])
  assert.equal(alternativeBatch.status, 0, alternativeBatch.stderr)
  assert.deepEqual(metrics(JSON.parse(alternativeBatch.stdout).trace.results[0].choices), metrics(alternatives.choices))
  const alternativeStream = runCli(['stream', `--city=${projectMetaPath}`,
    '--time=07:55', `--service-date=${serviceDate}`, '--max-walk=0.2'], {
    input: `${JSON.stringify({ kind: 'route', id: 'alternatives', origin: 'A', destination: 'B', departureWindowMinutes: 10 })}\n`,
  })
  assert.equal(alternativeStream.status, 0, alternativeStream.stderr)
  assert.deepEqual(metrics(JSON.parse(alternativeStream.stdout).trace.choices), metrics(alternatives.choices))

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
      pythonStream: 'public/vigo.mjs stream',
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
