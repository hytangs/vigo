import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import {
  buildNationalGtfsStore,
  compactNationalGtfsRuntimeStore,
  readNationalGtfsStoreMetadata,
} from '../server/national-gtfs-store.mjs'
import { normalizeReceivedRoutingPlan } from '../src/app/routingContracts.ts'
import { startInMemoryVigoApi } from './lib/in-memory-vigo-api.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliPath = path.join(repositoryRoot, 'dist-cli', 'vigo.mjs')
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
    legs: Array.isArray(plan?.legs) ? plan.legs.map(canonicalLeg) : [],
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

function canonicalTransitCore(plan) {
  const signature = canonicalPlan(plan)
  return {
    ...signature,
    legs: signature.legs.filter((leg) => leg.type === 'ride'),
  }
}

async function writeGtfsFixture(zipPath) {
  const zip = new JSZip()
  const fixedDate = new Date('2020-01-01T00:00:00.000Z')
  const addFile = (name, contents) => zip.file(name, contents, { date: fixedDate })
  addFile(
    'agency.txt',
    'agency_id,agency_name,agency_url,agency_timezone\nfixture,Fixture Transit,https://example.test,America/New_York\n',
  )
  addFile(
    'stops.txt',
    [
      'stop_id,stop_name,stop_lat,stop_lon',
      'A,Alpha,38.900,-77.050',
      'X,Transfer,38.905,-77.040',
      'B,Bravo,38.910,-77.030',
      '',
    ].join('\n'),
  )
  addFile(
    'routes.txt',
    [
      'route_id,agency_id,route_short_name,route_long_name,route_type',
      'R1,fixture,R1,First Route,3',
      'R2,fixture,R2,Second Route,3',
      '',
    ].join('\n'),
  )
  addFile(
    'trips.txt',
    [
      'route_id,service_id,trip_id,direction_id',
      'R1,WKD,T1,0',
      'R2,WKD,T2,0',
      '',
    ].join('\n'),
  )
  addFile(
    'stop_times.txt',
    [
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
      'T1,08:00:00,08:00:00,A,1',
      'T1,08:10:00,08:10:00,X,2',
      'T2,08:15:00,08:15:00,X,1',
      'T2,08:30:00,08:30:00,B,2',
      '',
    ].join('\n'),
  )
  addFile(
    'calendar.txt',
    [
      'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
      'WKD,1,1,1,1,1,0,0,20260101,20261231',
      '',
    ].join('\n'),
  )
  await fsp.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
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
  assert.match(
    payload.plan.diagnostics?.algorithm ?? '',
    /^rust_exact_connection_scan_(?:scalar|bounded_pareto)_no_heuristic$/u,
    'HTTP must use the exact Rust timetable kernel.',
  )
  assert.deepEqual(
    payload.plan.diagnostics?.searchStats?.engineInvocationsThisPass,
    { rustTimetable: 1, sqlite: 0 },
    'HTTP must perform one native timetable search without a SQLite routing pass.',
  )
  return payload.plan
}

function cliBatchPlan(storePath, temporaryRoot) {
  const odPath = path.join(temporaryRoot, 'od.csv')
  const csvPath = path.join(temporaryRoot, 'routes.csv')
  const jsonPath = path.join(temporaryRoot, 'routes.json')
  fs.writeFileSync(odPath, 'id,origin_stop_id,destination_stop_id\nparity,A,B\n')
  const result = runCli([
    'route',
    `--store=${storePath}`,
    `--od=${odPath}`,
    `--out=${csvPath}`,
    `--json-out=${jsonPath}`,
    '--time=07:55',
    '--time-preference=depart',
    '--service-day=weekday',
    `--service-date=${serviceDate}`,
    '--max-walk=0.2',
    '--departure-window=0',
  ])
  assert.equal(result.status, 0, `JS CLI batch failed: ${result.stderr}`)
  const payload = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  assert.equal(payload.schemaVersion, 'vigo.cli.route-results.v1')
  assert.equal(payload.results?.length, 1)
  return payload.results[0].plan
}

function cliNdjsonPlan(storePath) {
  const result = runCli([
    'route-ndjson',
    `--store=${storePath}`,
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
  assert.equal(result.status, 0, `persistent NDJSON CLI failed: ${result.stderr}`)
  const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].schemaVersion, 'vigo.cli.route-result.v1')
  assert.equal(rows[0].status, 'ok')
  return rows[0].plan
}

assert(fs.existsSync(cliPath), 'Built production CLI is missing. Run npm run build:cli.')
const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'vigo-interface-parity-'))
try {
  const zipPath = path.join(temporaryRoot, 'fixture.zip')
  const projectsPath = path.join(temporaryRoot, 'projects')
  const configPath = path.join(temporaryRoot, 'config')
  const projectMetaPath = path.join(projectsPath, projectId, '.vigo')
  const storePath = path.join(projectMetaPath, 'routing', 'project.sqlite')
  await fsp.mkdir(path.dirname(storePath), { recursive: true })
  await writeGtfsFixture(zipPath)
  await buildNationalGtfsStore({ zipPath, outputPath: storePath })
  compactNationalGtfsRuntimeStore(storePath)
  const metadata = readNationalGtfsStoreMetadata(storePath)

  await fsp.writeFile(
    path.join(projectMetaPath, 'project.json'),
    `${JSON.stringify(fixtureProject(metadata), null, 2)}\n`,
  )

  const apiUrl = await startApi(projectsPath, configPath)
  const plans = {
    http: await httpPlan(apiUrl),
    cliBatch: cliBatchPlan(storePath, temporaryRoot),
    cliNdjson: cliNdjsonPlan(storePath),
  }
  const signatures = Object.fromEntries(
    Object.entries(plans).map(([surface, plan]) => [surface, canonicalPlan(plan)]),
  )
  for (const surface of ['cliBatch', 'cliNdjson']) {
    assert.deepEqual(
      signatures[surface],
      signatures.http,
      `${surface} diverged from the production HTTP route signature.`,
    )
  }

  // The desktop does not issue an independent route. useNationalRouting
  // normalizes the HTTP plan for presentation after that response arrives.
  // Its documented boundary removes zero-distance access/egress cards (and
  // can merge adjacent walk cards); it must preserve the scheduled transit
  // core, aggregate times, transfer count, and engine identities.
  const desktopPlan = normalizeReceivedRoutingPlan(structuredClone(plans.http))
  assert.deepEqual(
    canonicalTransitCore(desktopPlan),
    canonicalTransitCore(plans.http),
    'Desktop presentation normalization changed scheduled transit semantics.',
  )
  assert.equal(desktopPlan.legs.length, plans.http.legs.length - 2)
  assert(
    plans.http.legs.filter((leg) => leg.type === 'walk' && leg.durationMinutes === 0 && leg.distanceKm === 0).length === 2,
    'The fixture must exercise the desktop-only no-op access/egress-card boundary.',
  )

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
      productionHttp: 'server/vigo-api.mjs -> national-route worker',
      desktop: 'production HTTP result -> normalizeReceivedRoutingPlan (removes no-op walk cards; scheduled core unchanged)',
      javascriptBatch: 'dist-cli/vigo.mjs route',
      persistentNdjson: 'dist-cli/vigo.mjs route-ndjson',
    },
    excludedInterfaceFields: [
      'plan IDs and human labels',
      'geometry coordinates and display metadata',
      'process, request, materialization, and serialization timings',
      'cache-hit and worker-lifecycle state',
      'CLI schema wrappers and request IDs',
    ],
    desktopPresentationBoundary: {
      rawLegCount: plans.http.legs.length,
      normalizedLegCount: desktopPlan.legs.length,
      noOpWalkCardsRemoved: plans.http.legs.length - desktopPlan.legs.length,
    },
    canonical: signatures.http,
  }, null, 2))
} finally {
  await stopApi()
  await fsp.rm(temporaryRoot, { recursive: true, force: true })
}
