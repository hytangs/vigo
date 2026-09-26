import { matrixItineraryReference } from './helpers/matrix-itinerary-reference.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { DatabaseSync } from 'node:sqlite'
import { buildNationalGtfsStore, buildNationalStaticTopologySidecar, buildRoutingStoreFromSchedules, disposeNationalGtfsStore, ensureNationalGtfsStopAccessRoles, inspectNationalGtfsAccessCandidates, mergeNationalGtfsStores, nationalFeedSummary, prepareNationalGtfsRoutingContext, readNationalGtfsPreview, readNationalGtfsStoreMetadata, routeNationalGtfsDepartureWindow, routeNationalGtfsMatrix, routeNationalGtfsStore } from '../src/server/national-gtfs-store.mjs'
import {
  buildNationalOsmWalkStore,
  compactNationalOsmRuntimeStore,
  disposeNationalOsmStore,
  nationalOsmWayWalkable,
  nationalOsmWalkDirections,
  prepareNationalOsmNativeStore,
} from '../src/server/national-osm-store.mjs'
import {
  clipNationalShapeCoordinates,
  clipNationalShapeCoordinatesThroughStops,
  deduplicateNationalRouteCoordinates,
} from '../src/server/national-route-geometry.mjs'
import { buildNativeStreetCchIndex } from '../src/server/native-routing-kernel.mjs'
import { startInMemoryVigoApi } from './helpers/in-memory-vigo-api.mjs'
import { finalizeCurrentStreetFixture } from './helpers/street-fixture.mjs'
import { processFixtureDirectory } from './helpers/fixture-process.mjs'
import { blockedPlan } from '../src/server/gtfs/route-results.mjs'
import { disposeAllNationalGtfsStores } from '../src/server/national-gtfs-store.mjs'

const unavailableAccessDiagnostic = blockedPlan(
  { serviceDate: '2026-07-12', horizonMinutes: 240, maxTransfers: 3 }, 480, 1.2,
  'No reachable station', 'Generic failure', {
    accessAvailability: {
      origin: { status: 'outside_selected_budget' },
      destination: { status: 'diagnostic_unavailable', detail: 'Fixture probe failure' },
    },
  },
)
assert.equal(unavailableAccessDiagnostic.diagnostics.failureCode, 'access_diagnostic_unavailable')
assert.equal(unavailableAccessDiagnostic.diagnostics.failure.retryable, true)
assert.equal(unavailableAccessDiagnostic.title, 'Access diagnostic unavailable')
assert.deepEqual(unavailableAccessDiagnostic.diagnostics.searchLimits, {
  maxWalkKm: 1.2, walkingLimitScope: 'per_endpoint', horizonMinutes: 240,
  horizonScope: 'timetable_scan',
  maxTransfers: 3, requireTransitRide: true,
})

async function rebuildFixtureRoutingDerivedArtifacts(storePath) {
  const database = new DatabaseSync(storePath)
  try {
    database.exec(`
      DELETE FROM metadata WHERE key IN ('stopAccessRoleIndexVersion', 'stopAccessRoleCount');
      DROP TABLE IF EXISTS stop_modes;
      CREATE TABLE stop_modes AS
        SELECT COALESCE(NULLIF(s.parent_station, ''), c.from_stop_id) AS stop_id,
          r.route_type AS route_type, COUNT(*) AS departure_count
        FROM connections c
        JOIN stops s ON s.stop_id=c.from_stop_id
        JOIN routes r ON r.route_id=c.route_id
        LEFT JOIN connection_permissions permission
          ON permission.trip_id=c.trip_id AND permission.stop_sequence=c.stop_sequence
        WHERE COALESCE(permission.can_board, 1)=1
        GROUP BY COALESCE(NULLIF(s.parent_station, ''), c.from_stop_id), r.route_type;
      CREATE UNIQUE INDEX stop_modes_stop_type ON stop_modes(stop_id, route_type);
      CREATE INDEX stop_modes_type_stop ON stop_modes(route_type, stop_id);
    `)
  } finally {
    database.close()
  }
  await ensureNationalGtfsStopAccessRoles(storePath)
  await buildNationalStaticTopologySidecar({
    storePath,
    outputPath: `${storePath}.static-topology.sqlite`,
    minimumFreeBytes: 128 * 1024 * 1024,
    force: true,
  })
}

assert.deepEqual(nationalOsmWalkDirections({ 'oneway:foot': 'yes' }), { forward: true, backward: false })
assert.deepEqual(nationalOsmWalkDirections({ 'oneway:foot': '-1' }), { forward: false, backward: true })
assert.deepEqual(nationalOsmWalkDirections({ conveying: 'forward', 'foot:forward': 'no' }), { forward: false, backward: false })
assert.deepEqual(nationalOsmWalkDirections({ conveying: 'yes' }), { forward: false, backward: false })
assert.deepEqual(nationalOsmWalkDirections({ conveying: 'reversible' }), { forward: false, backward: false })
assert.deepEqual(nationalOsmWalkDirections({ 'foot:backward': 'no' }), { forward: true, backward: false })
assert.equal(
  nationalOsmWayWalkable({ highway: 'path', access: 'no', foot: 'permissive' }),
  true,
  'A pedestrian-specific permission must override a general OSM access denial.',
)
assert.equal(
  nationalOsmWayWalkable({ highway: 'path', access: 'no' }),
  false,
  'A general OSM access denial remains binding without a pedestrian-specific permission.',
)
assert.equal(
  nationalOsmWayWalkable({ highway: 'footway', access: 'private' }),
  false,
  'An unqualified private way must not enter the public pedestrian graph.',
)
for (const access of [undefined, 'yes', 'permissive']) {
  assert.equal(nationalOsmWayWalkable({ highway: 'footway', access, foot: 'private' }), false,
    'Private pedestrian access must not become a public shortcut through a general mode permission.')
}
assert.equal(
  nationalOsmWayWalkable({ highway: 'footway', access: 'private', foot: 'permissive' }),
  true,
  'An explicit pedestrian permission must override private general access.',
)
assert.equal(
  nationalOsmWayWalkable({ highway: 'path', access: 'yes', foot: 'no' }),
  false,
  'A pedestrian-specific denial must override general OSM access.',
)
assert.equal(
  nationalOsmWayWalkable({
    highway: 'unclassified',
    access: 'no',
    foot: 'yes',
    'sidewalk:both': 'separate',
  }),
  false,
  'A restricted carriageway must not duplicate its explicitly separate pedestrian geometry.',
)
assert.equal(
  nationalOsmWayWalkable({
    highway: 'unclassified',
    foot: 'yes',
    'sidewalk:both': 'separate',
  }),
  true,
  'Separate sidewalks alone must not remove an otherwise walkable road needed for graph connectivity.',
)
assert.equal(
  nationalOsmWayWalkable({
    highway: 'path',
    access: 'no',
    foot: 'permissive',
    'sidewalk:both': 'separate',
  }),
  true,
  'Separate-sidewalk metadata must not suppress the pedestrian way itself.',
)
assert.deepEqual(
  clipNationalShapeCoordinates(
    [[0, 0], [0.01, 0], [0.02, 0], [0.03, 0]],
    [0.009, 0],
    [0.021, 0],
  ),
  [[0.009, 0], [0.01, 0], [0.02, 0], [0.021, 0]],
  'Shape clipping belongs to the post-search geometry module and must preserve boarding and alighting coordinates.',
)

assert.deepEqual(
  clipNationalShapeCoordinatesThroughStops(
    [[0, 0], [0.001, 0], [0.002, 0], [0.001, 0.0001], [0, 0], [-0.001, 0]],
    [[0.001, 0], [0.002, 0], [0.001, 0.0001]],
  ),
  [[0.001, 0], [0.002, 0], [0.001, 0.0001]],
  'Intermediate scheduled stops must disambiguate the correct monotone section of a looped GTFS shape.',
)
assert.deepEqual(
  deduplicateNationalRouteCoordinates([
    [0, 0],
    [1, 1],
    [1, 1],
    [2, 2],
  ]),
  [[0, 0], [1, 1], [2, 2]],
  'Route geometry must not retain redundant consecutive interior positions.',
)
assert.deepEqual(
  deduplicateNationalRouteCoordinates([[1, 1], [1, 1]]),
  [[1, 1], [1, 1]],
  'A zero-length route line must retain the two GeoJSON positions.',
)

const folder = await processFixtureDirectory(import.meta.url, 'vigo-national-store-')
const zipPath = path.join(folder, 'fixture.zip')
const storePath = path.join(folder, 'fixture.sqlite')
const kernelFallbackStorePath = path.join(folder, 'fixture-kernel-fallback.sqlite')
const weekdayTemplateStorePath = path.join(folder, 'fixture-weekday-template.sqlite')
const transferShortcutStorePath = path.join(folder, 'fixture-transfer-shortcut.sqlite')
const transferOnlyStorePath = path.join(folder, 'fixture-transfer-only.sqlite')
const legacyAccessStorePath = path.join(folder, 'fixture-legacy-access.sqlite')
const parentModeAccessStorePath = path.join(folder, 'fixture-parent-mode-access.sqlite')
const parentModeAccessStreetPath = path.join(folder, 'fixture-parent-mode-access-street.sqlite')
const gapZipPath = path.join(folder, 'fixture-gap.zip')
const gapStorePath = path.join(folder, 'fixture-gap.sqlite')
const legacyGapStorePath = path.join(folder, 'fixture-gap-legacy.sqlite')
const sectionGapStorePath = path.join(folder, 'fixture-section-gap.sqlite')
const directWalkStreetPath = path.join(folder, 'fixture-direct-walk-street.sqlite')
const shortTransitSchedulePath = path.join(folder, 'fixture-short-transit-schedule.json')
const shortTransitStorePath = path.join(folder, 'fixture-short-transit.sqlite')
const accessBoundSchedulePath = path.join(folder, 'fixture-access-bound-schedule.json')
const accessBoundStorePath = path.join(folder, 'fixture-access-bound.sqlite')
const incompleteCoverageStorePath = path.join(folder, 'fixture-incomplete-coverage.sqlite')
const denseAccessSchedulePath = path.join(folder, 'fixture-dense-access-schedule.json')
const denseAccessStorePath = path.join(folder, 'fixture-dense-access.sqlite')
const denseAccessStreetPath = path.join(folder, 'fixture-dense-access-street.sqlite')
const completeEgressSchedulePath = path.join(folder, 'fixture-complete-egress-schedule.json')
const completeEgressStorePath = path.join(folder, 'fixture-complete-egress.sqlite')
const completeEgressStreetPath = path.join(folder, 'fixture-complete-egress-street.sqlite')
const cacheTruthStorePath = path.join(folder, 'fixture-cache-truth.sqlite')
const matrixUpperBoundStorePath = path.join(folder, 'fixture-matrix-upper-bound.sqlite')
const matrixCycleSchedulePath = path.join(folder, 'fixture-matrix-cycle-schedule.json')
const matrixCycleStorePath = path.join(folder, 'fixture-matrix-cycle.sqlite')
const matrixHorizonSchedulePath = path.join(folder, 'fixture-matrix-horizon-schedule.json')
const matrixHorizonStorePath = path.join(folder, 'fixture-matrix-horizon.sqlite')
const migratedStorePath = path.join(folder, 'migrated.sqlite')
const transferSlackStorePath = path.join(folder, 'transfer-slack.sqlite')
const rawFeedAPath = path.join(folder, 'raw-feed-a.zip')
const rawFeedBPath = path.join(folder, 'raw-feed-b.zip')
const rawStoreAPath = path.join(folder, 'raw-feed-a.sqlite')
const rawStoreBPath = path.join(folder, 'raw-feed-b.sqlite')
const mergedRawStorePath = path.join(folder, 'merged-raw.sqlite')
const arriveTransferStorePath = path.join(folder, 'arrive-transfer.sqlite')
const arriveTransferLegacyStorePath = path.join(folder, 'arrive-transfer-legacy.sqlite')
const fallbackRailFeedPath = path.join(folder, 'fallback-rail.zip')
const fallbackBusFeedPath = path.join(folder, 'fallback-bus.zip')
const fallbackRailStorePath = path.join(folder, 'fallback-rail.sqlite')
const fallbackBusStorePath = path.join(folder, 'fallback-bus.sqlite')
const fallbackMergedStorePath = path.join(folder, 'fallback-merged.sqlite')
const fallbackStreetPath = path.join(folder, 'fallback-street.sqlite')
const invalidRawStorePath = path.join(folder, 'invalid-raw.sqlite')
const failedMergePath = path.join(folder, 'failed-merge.sqlite')
const cleanupMergePath = path.join(folder, 'cleanup-merge.sqlite')

const denseRouteCatalogStorePath = path.join(folder, 'dense-route-catalog.sqlite')

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function prepareRustFixtureStreetStore(storePath) {
  const snapshot = buildNationalOsmWalkStore(storePath, {
    force: true,
    persist: true,
  })
  assert.equal(snapshot.ready, true)
  assert.equal(
    compactNationalOsmRuntimeStore(storePath).storageLayout,
    'runtime-snapshots-v1',
  )
  disposeNationalOsmStore(storePath)
  const native = prepareNationalOsmNativeStore(storePath)
  assert.equal(native.ready, true)
  assert.equal(native.source, 'rust_mmap_node_api')
  assert(buildNativeStreetCchIndex(storePath).loaded.nodeCount > 0)
  return native
}

async function buildDenseRouteCatalogFixture(storePath) {
  const zip = new JSZip()
  zip.file('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon\nA,Alpha,42.38,-71.10\nB,Bravo,42.39,-71.09\n')
  zip.file('routes.txt', [
    'route_id,route_short_name,route_long_name,route_type,route_color',
    'R1,1,Dense route,3,cc0000', 'R1B,1,Dense route variant,3,cc0000',
    'R2,2,Second route,3,0066cc', 'R3,3,Third route,3,00aa66',
    'R4,4,Fourth route,3,aa6600', 'R_FIVE,5,Fifth route,3,6600aa',
    'R6,6,Sixth route,3,008888', 'R7,7,Inactive route,3,777777', '',
  ].join('\n'))
  const trips = ['route_id,service_id,trip_id,direction_id']
  const times = ['trip_id,arrival_time,departure_time,stop_id,stop_sequence']
  const time = (seconds) => `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  const add = (routeId, tripId, departure) => {
    trips.push(`${routeId},S,${tripId},0`)
    times.push(`${tripId},${time(departure)},${time(departure)},A,1`,
      `${tripId},${time(departure + 60)},${time(departure + 60)},B,2`)
  }
  for (let index = 0; index < 2_001; index += 1) add('R1', `a-dense-${String(index).padStart(4, '0')}`, index)
  for (let index = 0; index < 3; index += 1) add('R1B', `variant-${index}`, 5_000 + index)
  for (let routeNumber = 2; routeNumber <= 6; routeNumber += 1) {
    const routeId = routeNumber === 5 ? 'R_FIVE' : `R${routeNumber}`
    add(routeId, `z-${routeId}`, 10_000 + routeNumber)
  }
  zip.file('trips.txt', `${trips.join('\n')}\n`)
  zip.file('stop_times.txt', `${times.join('\n')}\n`)
  zip.file('calendar_dates.txt', 'service_id,date,exception_type\nS,20260716,1\n')
  const zipPath = `${storePath}.zip`
  await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer' }))
  await buildNationalGtfsStore({ zipPath, outputPath: storePath })
}

async function startFixtureApi(projectsPath, configPath) {
  return startInMemoryVigoApi({
    repositoryRoot,
    environment: {
      VIGO_PROJECTS_DIR: projectsPath,
      VIGO_CONFIG_DIR: configPath,
    },
  })
}

async function runNodeJsonFixture({ source, args, env = {}, label }) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source, ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  assert.equal(exitCode, 0, `${label} child failed: ${stderr}`)
  return JSON.parse(stdout)
}

async function runOversizedSourcePreflightFixture(routingStorePath) {
  const modulePath = path.join(repositoryRoot, 'src', 'server', 'national-gtfs-store.mjs')
  const source = `
    import { pathToFileURL } from 'node:url'
    const routing = await import(pathToFileURL(process.argv[1]).href)
    const storePath = process.argv[2]
    const context = routing.prepareNationalGtfsRoutingContext(storePath, {
      serviceDate: '2026-07-12',
      serviceDay: 'sunday',
    })
    const request = {
      origin: { coordinate: [8.0000, 47.0000], label: 'Oversized Alpha', source: 'stop', stopId: 'A' },
      destination: { coordinate: [8.0200, 47.0200], label: 'Oversized Charlie', source: 'stop', stopId: 'C' },
      departMinutes: 480,
      serviceDate: '2026-07-12',
      serviceDay: 'sunday',
      maxWalkKm: 0.25,
      forceStaticTopologyLowerBound: true,
    }
    let productionError = null
    try {
      routing.routeNationalGtfsStore(storePath, request)
    } catch (error) {
      productionError = { code: error.code, message: error.message }
    }
    process.stdout.write(JSON.stringify({
      preflight: context.activeServiceKernelPreflight,
      staticTopology: context.staticTopology,
      activeServiceKernel: context.activeServiceKernel,
      productionError,
    }))
  `
  return runNodeJsonFixture({
    source,
    args: [modulePath, routingStorePath],
    env: {
      VIGO_ACTIVE_KERNEL_MAX_SEGMENTS: '1',
      VIGO_ACTIVE_KERNEL_MAX_SOURCE_CONNECTIONS: '1',
      VIGO_ACTIVE_KERNEL_PERSIST: '0',
    },
    label: 'Oversized-source preflight',
  })
}

async function runConfiguredEndpointOverheadFixture(routingStorePath, streetStorePath) {
  const modulePath = path.join(repositoryRoot, 'src', 'server', 'national-gtfs-store.mjs')
  const osmModulePath = path.join(repositoryRoot, 'src', 'server', 'national-osm-store.mjs')
  const source = `
    import { pathToFileURL } from 'node:url'
    const routing = await import(pathToFileURL(process.argv[1]).href)
    const osm = await import(pathToFileURL(process.argv[2]).href)
    osm.prepareNationalOsmNativeStore(process.argv[4])
    const plan = routing.routeNationalGtfsStore(process.argv[3], {
      requireTransitRide: false,
      origin: { coordinate: [0, 0], label: 'Overhead origin', source: 'map' },
      destination: { coordinate: [0.0009, 0], label: 'Overhead destination', source: 'map' },
      departMinutes: 480,
      serviceDate: '2026-07-12',
      serviceDay: 'sunday',
      maxWalkKm: 0.2,
      streetStorePath: process.argv[4],
    })
    process.stdout.write(JSON.stringify({
      status: plan.status,
      travelMode: plan.travelMode,
      durationMinutes: plan.durationMinutes,
      algorithm: plan.diagnostics?.algorithm,
      optimality: plan.diagnostics?.optimality,
      transitLowerBoundMinutes: plan.diagnostics?.transitLowerBoundMinutes,
    }))
  `
  return runNodeJsonFixture({
    source,
    args: [modulePath, osmModulePath, routingStorePath, streetStorePath],
    env: {
      VIGO_ROUTING_WALK_OVERHEAD_SECONDS: '60',
      VIGO_ACTIVE_KERNEL_PERSIST: '0',
    },
    label: 'Configured endpoint-overhead dominance',
  })
}

try {
  await buildDenseRouteCatalogFixture(denseRouteCatalogStorePath)
  const denseRouteCatalogPreview = readNationalGtfsPreview(denseRouteCatalogStorePath, {
    routeCount: 8,
    stopCount: 2,
    tripCount: 2_009,
    routeLimit: 8,
  })
  assert.deepEqual(
    denseRouteCatalogPreview.routes.map((route) => route.routeId).sort(),
    ['R1', 'R1B', 'R2', 'R3', 'R4', 'R6', 'R_FIVE'],
    'An indexed SQLite route catalog must not lose routes behind dense early connection rows.',
  )
  const denseRouteCatalogSummary = nationalFeedSummary(denseRouteCatalogStorePath, {
    sourceFile: 'dense-route-catalog.zip',
    sourceBytes: 1,
    storeId: 'dense-route-catalog',
    builtAt: '2026-07-15T12:00:00.000Z',
    routeCount: 8,
    stopCount: 2,
    tripCount: 2_009,
    transferCount: 0,
    calendarDateCount: 0,
    frequencyCount: 0,
    tableProfiles: [],
    bytes: 1,
    connectionCount: 2_006,
  }, 'dense-route-catalog')
  assert.deepEqual(
    denseRouteCatalogSummary.routeMetrics.map((route) => route.routeId).sort(),
    ['R1', 'R1B', 'R2', 'R3', 'R4', 'R6', 'R7', 'R_FIVE'],
    'The route catalog must retain inactive SQLite route rows even when they have no drawable trip.',
  )
  const denseRoute = denseRouteCatalogSummary.routeMetrics.find((route) => route.routeId === 'R1')
  const denseBranch = denseRouteCatalogSummary.routeMetrics.find((route) => route.routeId === 'R1B')
  assert.equal(denseRoute?.serviceVariantCount, 1, 'A GTFS route_id must remain one public service identity.')
  assert.equal(denseRoute?.tripCount, 2_001)
  assert.equal(denseBranch?.tripCount, 3, 'A same-name branch must retain its own indexed trip count.')

  const directWalkStreet = new DatabaseSync(directWalkStreetPath)
  directWalkStreet.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE walk_nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE edges(from_node INTEGER NOT NULL, to_node INTEGER NOT NULL, distance_m REAL NOT NULL, way_id INTEGER NOT NULL);
    CREATE INDEX walk_nodes_lat_lon ON walk_nodes(lat,lon);
    CREATE INDEX edges_from ON edges(from_node);
    CREATE INDEX edges_to ON edges(to_node);
    INSERT INTO metadata VALUES('schemaVersion', '"vigo.street.store.v4"');
    INSERT INTO metadata VALUES('sourceModel', '"pbf"');
    INSERT INTO walk_nodes VALUES
      (1, 0, 0), (2, 0, 0.0009),
      (3, 0.01, 0), (4, 0.01, 0.0016),
      (5, 0.02, 0), (6, 0.02, 0.0009),
      (7, 0.03, 0), (8, 0.03, 0.00225),
      (9, 47, 8), (10, 47.01, 8.01), (11, 47.02, 8.02),
      (12, 0, -0.0009), (13, 0, 0.0018);
    INSERT INTO edges VALUES
      (1, 2, 101, 1), (2, 1, 101, 1),
      (12, 1, 100, 4), (1, 12, 100, 4),
      (2, 13, 100, 5), (13, 2, 100, 5),
      (3, 4, 178, 2), (4, 3, 178, 2),
      (7, 8, 250, 3), (8, 7, 250, 3);
  `)
  finalizeCurrentStreetFixture(directWalkStreet)
  directWalkStreet.close()
  prepareRustFixtureStreetStore(directWalkStreetPath)

  const shortTransitSchedule = {
    stops: [
      { id: 'SHORT_A', name: 'Short transit origin', lat: 0, lon: 0, locationType: 0 },
      { id: 'SHORT_B', name: 'Short transit destination', lat: 0, lon: 0.0009, locationType: 0 },
      { id: 'LONG_A', name: 'Long-walk transit origin', lat: 0.03, lon: 0, locationType: 0 },
      { id: 'LONG_B', name: 'Long-walk transit destination', lat: 0.03, lon: 0.00225, locationType: 0 },
    ],
    routes: [
      {
        id: 'SHORT', shortName: 'SHORT', routeType: 3,
        scheduledTrips: [{
          tripId: 'short-1',
          serviceId: 'sunday',
          serviceDays: ['sunday'],
          stopTimes: [
            { stopId: 'SHORT_A', arrivalMinutes: 480, departureMinutes: 480, sequence: 1 },
            { stopId: 'SHORT_B', arrivalMinutes: 480.5, departureMinutes: 480.5, sequence: 2 },
          ],
        }],
      },
      {
        id: 'EQUAL', shortName: 'EQUAL', routeType: 3,
        scheduledTrips: [{
          tripId: 'equal-1',
          serviceId: 'sunday',
          serviceDays: ['sunday'],
          stopTimes: [
            { stopId: 'SHORT_A', arrivalMinutes: 540, departureMinutes: 540, sequence: 1 },
            { stopId: 'SHORT_B', arrivalMinutes: 540, departureMinutes: 540, sequence: 2 },
          ],
        }],
      },
      {
        id: 'WALK_TIE', shortName: 'WALK_TIE', routeType: 3,
        scheduledTrips: [{
          tripId: 'walk-tie-1',
          serviceId: 'sunday',
          serviceDays: ['sunday'],
          stopTimes: [
            { stopId: 'SHORT_A', arrivalMinutes: 600, departureMinutes: 600, sequence: 1 },
            { stopId: 'SHORT_B', arrivalMinutes: 601.2625, departureMinutes: 601.2625, sequence: 2 },
          ],
        }],
      },
      {
        id: 'LONG', shortName: 'LONG', routeType: 3,
        scheduledTrips: [{
          tripId: 'long-1',
          serviceId: 'sunday',
          serviceDays: ['sunday'],
          stopTimes: [
            { stopId: 'LONG_A', arrivalMinutes: 480, departureMinutes: 480, sequence: 1 },
            { stopId: 'LONG_B', arrivalMinutes: 490, departureMinutes: 490, sequence: 2 },
          ],
        }],
      },
    ],
    transferRules: [],
  }
  await fs.writeFile(shortTransitSchedulePath, JSON.stringify(shortTransitSchedule))
  await buildRoutingStoreFromSchedules({
    schedules: [{ feedId: 'short', schedulePath: shortTransitSchedulePath }],
    outputPath: shortTransitStorePath,
  })

  const accessBoundSchedule = {
    stops: [
      { id: 'ACCESS_A', name: 'Access-bound origin stop', lat: 0, lon: -0.0009, locationType: 0 },
      { id: 'ACCESS_B', name: 'Access-bound destination stop', lat: 0, lon: 0.0018, locationType: 0 },
    ],
    routes: [{
      id: 'SLOW', shortName: 'SLOW', routeType: 3,
      scheduledTrips: [{
        tripId: 'slow-1',
        serviceId: 'sunday',
        serviceDays: ['sunday'],
        stopTimes: [
          { stopId: 'ACCESS_A', arrivalMinutes: 482, departureMinutes: 482, sequence: 1 },
          { stopId: 'ACCESS_B', arrivalMinutes: 483, departureMinutes: 483, sequence: 2 },
        ],
      }],
    }],
    transferRules: [],
  }
  await fs.writeFile(accessBoundSchedulePath, JSON.stringify(accessBoundSchedule))
  await buildRoutingStoreFromSchedules({
    schedules: [{ feedId: 'access-bound', schedulePath: accessBoundSchedulePath }],
    outputPath: accessBoundStorePath,
  })
  await fs.copyFile(accessBoundStorePath, incompleteCoverageStorePath)
  const incompleteCoverageStore = new DatabaseSync(incompleteCoverageStorePath)
  try {
    const setMetadata = incompleteCoverageStore.prepare(
      'INSERT OR REPLACE INTO metadata(key, value) VALUES(?, ?)',
    )
    setMetadata.run('serviceModel', JSON.stringify('exact-date-multi-feed'))
    setMetadata.run('sourceStores', JSON.stringify([
      {
        scope: 'access-bound',
        storeId: 'access-bound',
        sourceFingerprint: 'access-bound',
        sourceFile: 'access-bound.zip',
      },
      {
        scope: 'missing-scope',
        storeId: 'missing-scope',
        sourceFingerprint: 'missing-scope',
        sourceFile: 'missing-scope.zip',
      },
    ]))
  } finally {
    incompleteCoverageStore.close()
  }
  const singleFeedAccessBoundStore = new DatabaseSync(accessBoundStorePath)
  try {
    singleFeedAccessBoundStore.prepare(
      "UPDATE metadata SET value='\"exact-date\"' WHERE key='serviceModel'",
    ).run()
    singleFeedAccessBoundStore.prepare(
      "UPDATE metadata SET value='[]' WHERE key='sourceStores'",
    ).run()
  } finally {
    singleFeedAccessBoundStore.close()
  }

  // Dense reachable candidates can consume the street helper's default
  // 12-result budget before it returns a slightly farther, correct-direction
  // stop on the same mode. One decoy still produces a valid but
  // 20-minute-slower route, so no-path-only recovery cannot repair this case.
  const denseDecoyStops = Array.from({ length: 12 }, (_value, index) => ({
    id: `D${String(index + 1).padStart(2, '0')}`,
    name: `Dense decoy ${index + 1}`,
    lat: index === 0 ? 0 : 0.0009 + index * 0.00002,
    lon: index === 0 ? -0.0009 : -0.0004,
    locationType: 0,
  }))
  const denseSchedule = {
    stops: [
      ...denseDecoyStops,
      { id: 'USEFUL', name: 'Useful boarding stop', lat: 0, lon: 0.00135, locationType: 0 },
      { id: 'DEST', name: 'Dense destination', lat: 0, lon: 0.004, locationType: 0 },
      { id: 'OTHER', name: 'Other terminus', lat: 0.01, lon: 0, locationType: 0 },
    ],
    routes: [
      {
        id: 'SLOW', shortName: 'SLOW', routeType: 3,
        scheduledTrips: [
          {
            tripId: 'slow-1', serviceId: 'weekday', serviceDays: ['weekday'],
            stopTimes: [
              { stopId: 'D01', arrivalMinutes: 485, departureMinutes: 485, sequence: 1 },
              { stopId: 'DEST', arrivalMinutes: 515, departureMinutes: 515, sequence: 2 },
            ],
          },
          {
            tripId: 'slow-2', serviceId: 'weekday', serviceDays: ['weekday'],
            stopTimes: [
              { stopId: 'D01', arrivalMinutes: 600, departureMinutes: 600, sequence: 1 },
              { stopId: 'DEST', arrivalMinutes: 630, departureMinutes: 630, sequence: 2 },
            ],
          },
        ],
      },
      {
        id: 'FAST', shortName: 'FAST', routeType: 3,
        scheduledTrips: [{
          tripId: 'fast-1', serviceId: 'weekday', serviceDays: ['weekday'],
          stopTimes: [
            { stopId: 'USEFUL', arrivalMinutes: 485, departureMinutes: 485, sequence: 1 },
            { stopId: 'DEST', arrivalMinutes: 495, departureMinutes: 495, sequence: 2 },
          ],
        }],
      },
      ...denseDecoyStops.slice(1).map((stop) => ({
        id: `DECOY-${stop.id}`, shortName: `DECOY-${stop.id}`, routeType: 3,
        scheduledTrips: [1, 2].map((trip) => ({
          tripId: `decoy-${stop.id}-${trip}`,
          serviceId: 'weekday',
          serviceDays: ['weekday'],
          stopTimes: [
            { stopId: stop.id, arrivalMinutes: 540 + trip * 30, departureMinutes: 540 + trip * 30, sequence: 1 },
            { stopId: 'OTHER', arrivalMinutes: 550 + trip * 30, departureMinutes: 550 + trip * 30, sequence: 2 },
          ],
        })),
      })),
    ],
    transferRules: [],
  }
  await fs.writeFile(denseAccessSchedulePath, JSON.stringify(denseSchedule))
  await buildRoutingStoreFromSchedules({
    schedules: [{ feedId: 'dense', schedulePath: denseAccessSchedulePath }],
    outputPath: denseAccessStorePath,
  })
  const denseAccessStreet = new DatabaseSync(denseAccessStreetPath)
  denseAccessStreet.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE walk_nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE edges(from_node INTEGER NOT NULL, to_node INTEGER NOT NULL, distance_m REAL NOT NULL, way_id INTEGER NOT NULL);
    CREATE INDEX walk_nodes_lat_lon ON walk_nodes(lat,lon);
    CREATE INDEX edges_from ON edges(from_node);
    CREATE INDEX edges_to ON edges(to_node);
    INSERT INTO metadata VALUES('schemaVersion', '"vigo.street.store.v4"');
    INSERT INTO metadata VALUES('sourceModel', '"pbf"');
    INSERT INTO walk_nodes VALUES
      (1, 0, 0), (2, 0, -0.0009), (3, 0, 0.00135), (4, 0, 0.004), (16, 0.01, 0),
      (17, 0, 0.0044),
      (5, 0.00092, -0.0004), (6, 0.00094, -0.0004), (7, 0.00096, -0.0004),
      (8, 0.00098, -0.0004), (9, 0.001, -0.0004), (10, 0.00102, -0.0004),
      (11, 0.00104, -0.0004), (12, 0.00106, -0.0004), (13, 0.00108, -0.0004),
      (14, 0.0011, -0.0004), (15, 0.00112, -0.0004);
    INSERT INTO edges VALUES
      (1, 2, 100, 1), (2, 1, 100, 1),
      (1, 5, 101, 4), (5, 1, 101, 4),
      (1, 6, 102, 5), (6, 1, 102, 5),
      (1, 7, 103, 6), (7, 1, 103, 6),
      (1, 8, 104, 7), (8, 1, 104, 7),
      (1, 9, 105, 8), (9, 1, 105, 8),
      (1, 10, 106, 9), (10, 1, 106, 9),
      (1, 11, 107, 10), (11, 1, 107, 10),
      (1, 12, 108, 11), (12, 1, 108, 11),
      (1, 13, 109, 12), (13, 1, 109, 12),
      (1, 14, 110, 13), (14, 1, 110, 13),
      (1, 15, 111, 14), (15, 1, 111, 14),
      (1, 3, 150, 2), (3, 1, 150, 2),
      (3, 4, 300, 3), (4, 3, 300, 3),
      (4, 17, 45.32, 15), (17, 4, 45.32, 15);
  `)
  finalizeCurrentStreetFixture(denseAccessStreet)
  denseAccessStreet.close()
  prepareRustFixtureStreetStore(denseAccessStreetPath)

  const completeEgressSchedule = {
    stops: [
      { id: 'ORIGIN', name: 'Egress origin', lat: 0, lon: 0, locationType: 0 },
      { id: 'X', name: 'Useful alighting stop', lat: 0, lon: 0.01, locationType: 0 },
      { id: 'Y', name: 'Unnecessary connector stop', lat: 0, lon: 0.011, locationType: 0 },
    ],
    routes: [
      {
        id: 'MAIN', shortName: 'MAIN', routeType: 3,
        scheduledTrips: [{
          tripId: 'main-1', serviceId: 'weekday', serviceDays: ['weekday'],
          stopTimes: [
            { stopId: 'ORIGIN', arrivalMinutes: 480, departureMinutes: 480, sequence: 1 },
            { stopId: 'X', arrivalMinutes: 490, departureMinutes: 490, sequence: 2 },
          ],
        }],
      },
      {
        id: 'CONNECTOR', shortName: 'CONNECTOR', routeType: 3,
        scheduledTrips: [{
          tripId: 'connector-1', serviceId: 'weekday', serviceDays: ['weekday'],
          stopTimes: [
            { stopId: 'X', arrivalMinutes: 500, departureMinutes: 500, sequence: 1 },
            { stopId: 'Y', arrivalMinutes: 501, departureMinutes: 501, sequence: 2 },
          ],
        }],
      },
    ],
    transferRules: [],
  }
  await fs.writeFile(completeEgressSchedulePath, JSON.stringify(completeEgressSchedule))
  await buildRoutingStoreFromSchedules({
    schedules: [{ feedId: 'egress', schedulePath: completeEgressSchedulePath }],
    outputPath: completeEgressStorePath,
  })
  const completeEgressStreet = new DatabaseSync(completeEgressStreetPath)
  completeEgressStreet.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE walk_nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE edges(from_node INTEGER NOT NULL, to_node INTEGER NOT NULL, distance_m REAL NOT NULL, way_id INTEGER NOT NULL);
    CREATE INDEX walk_nodes_lat_lon ON walk_nodes(lat,lon);
    CREATE INDEX edges_from ON edges(from_node);
    CREATE INDEX edges_to ON edges(to_node);
    INSERT INTO metadata VALUES('schemaVersion', '"vigo.street.store.v4"');
    INSERT INTO metadata VALUES('sourceModel', '"pbf"');
    INSERT INTO walk_nodes VALUES (1, 0, 0.01), (2, 0, 0.011), (3, 0, 0.012);
    INSERT INTO edges VALUES
      (1, 2, 100, 1), (2, 1, 100, 1),
      (2, 3, 100, 2), (3, 2, 100, 2);
  `)
  finalizeCurrentStreetFixture(completeEgressStreet)
  completeEgressStreet.close()
  prepareRustFixtureStreetStore(completeEgressStreetPath)

  const zip = new JSZip()
  zip.file('stops.txt', [
    'stop_id,stop_name,stop_lat,stop_lon,location_type',
    'A,Alpha,47.0000,8.0000,0',
    'B,Bravo,47.0100,8.0100,0',
    'C,Charlie,47.0200,8.0200,0',
  ].join('\n'))
  zip.file('routes.txt', [
    'route_id,route_short_name,route_long_name,route_type,route_color',
    'R1,1,Alpha Bravo,2,cc0000',
    'R2,2,Bravo Charlie,2,0066cc',
  ].join('\n'))
  zip.file('trips.txt', [
    'route_id,service_id,trip_id,direction_id,shape_id',
    'R1,S,t1,0,shape-r1',
    'R2,S,t2,0,',
  ].join('\n'))
  zip.file('shapes.txt', [
    'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence',
    'shape-r1,47.0000,8.0000,1',
    'shape-r1,47.0040,8.0030,2',
    'shape-r1,47.0070,8.0080,3',
    'shape-r1,47.0100,8.0100,4',
  ].join('\n'))
  zip.file('stop_times.txt', [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    't1,08:05:00,08:05:00,A,1',
    't1,08:15:00,08:15:00,B,2',
    't2,08:20:00,08:20:00,B,1',
    't2,08:30:00,08:30:00,C,2',
  ].join('\n'))
  zip.file('calendar.txt', 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n')
  zip.file('calendar_dates.txt', 'service_id,date,exception_type\nS,20260712,1\n')
  zip.file('transfers.txt', 'from_stop_id,to_stop_id,transfer_type,min_transfer_time\nB,B,0,0\n')
  await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))

  const result = await buildNationalGtfsStore({ zipPath, outputPath: storePath })
  assert.equal(result.stopTimeCount, 4)
  assert.equal(result.connectionCount, 2)
  assert.equal(result.shapePointCount, 4)
  assert.equal(readNationalGtfsStoreMetadata(storePath).schemaVersion, 'vigo.routing.store.v1')
  const oversizedSourcePreflight = await runOversizedSourcePreflightFixture(storePath)
  assert.equal(oversizedSourcePreflight.preflight.eligible, false)
  assert.equal(oversizedSourcePreflight.preflight.reason, 'source_connection_guard')
  assert.equal(
    oversizedSourcePreflight.staticTopology.routingRole,
    'analysis_only',
    'Routing prewarm must not materialize the analysis-only reverse topology graph.',
  )
  assert.equal(oversizedSourcePreflight.activeServiceKernel.reason, 'source_connection_guard')
  assert.equal(
    oversizedSourcePreflight.productionError.code,
    'resident_timetable_kernel_required',
    'The production path must fail explicitly instead of switching to SQLite.',
  )
  const indexedStore = new DatabaseSync(storePath, { readOnly: true })
  assert.equal(
    indexedStore.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='index' AND name='trips_route'").get()?.present,
    1,
    'New national stores must index trips by route for bounded preview counts.',
  )
  indexedStore.close()

  const feedSummary = nationalFeedSummary(storePath, result, 'fixture-feed')
  const drawableRoutes = feedSummary.mapPreview.routes.filter((route) => (
    route.geometrySource === 'stop_sequence'
      && route.tripCount > 0
      && route.stopIds.length >= 2
      && route.coordinates.length >= 2
      && route.coordinates.every((coordinate) => coordinate.length === 2 && coordinate.every(Number.isFinite))
  ))
  assert(drawableRoutes.length >= 1, 'A shape-less national feed must expose a finite stop-sequence route preview.')
  assert.equal(drawableRoutes.find((route) => route.routeId === 'R1')?.tripCount, 1)
  assert.equal(feedSummary.mapPreview.routes.reduce((sum, route) => sum + route.tripCount, 0), result.tripCount)
  assert.equal(feedSummary.mapPreview.coverage.tripCountStrategy, 'exact-indexed')

  const repairProjectId = 'national-preview-repair'
  const repairFeedId = 'fixture-feed'
  const repairProjectsPath = path.join(folder, 'projects')
  const repairConfigPath = path.join(folder, 'config')
  const repairMetaPath = path.join(repairProjectsPath, repairProjectId, '.vigo')
  const repairTransportPath = path.join(repairMetaPath, 'transport', `${repairFeedId}.json`)
  const { routeMetrics: _routeMetrics, stopMetrics: _stopMetrics, mapPreview: _mapPreview, ...storedFeed } = feedSummary
  const repairProject = {
    schemaVersion: 'vigo.project.v1',
    id: repairProjectId,
    name: 'National preview repair',
    region: 'Fixture',
    createdAt: result.builtAt,
    updatedAt: result.builtAt,
    storagePath: path.join(repairProjectsPath, repairProjectId),
    summary: { feeds: 1, routes: result.routeCount, stops: result.stopCount, transferCandidates: result.transferCount, qualityScore: 100 },
    feeds: [storedFeed],
    jobs: [],
    artifacts: [],
  }
  await fs.mkdir(path.join(repairMetaPath, 'routing'), { recursive: true })
  await Promise.all([
    fs.copyFile(storePath, path.join(repairMetaPath, 'routing', `${repairFeedId}.sqlite`)),
    fs.writeFile(path.join(repairMetaPath, 'project.json'), JSON.stringify(repairProject)),
  ])
  const fixtureApi = await startFixtureApi(repairProjectsPath, repairConfigPath)
  let firstRepairMs = 0
  let secondRepairMs = 0
  try {
    const firstStartedAt = performance.now()
    const firstResponse = await fixtureApi.requestJson(
      `/api/projects/${repairProjectId}`,
    )
    const firstProject = firstResponse.body.project
    firstRepairMs = performance.now() - firstStartedAt
    assert.equal(firstResponse.status, 200)
    assert.equal(firstProject.feeds[0].routeMetrics.length, result.routeCount, 'Project transport must keep the complete SQLite route catalog.')
    assert.equal(firstProject.feeds[0].mapPreview.routes.length, result.routeCount, 'A drawable but incomplete indexed preview must be repaired from SQLite.')
    assert(firstProject.feeds[0].mapPreview.routes.some((route) => route.geometrySource === 'stop_sequence' && route.tripCount > 0 && route.coordinates.length >= 2))
    await assert.rejects(
      fs.stat(repairTransportPath),
      (error) => error?.code === 'ENOENT',
      'Project hydration must not recreate a transport JSON sidecar.',
    )

    const secondStartedAt = performance.now()
    const secondResponse = await fixtureApi.requestJson(
      `/api/projects/${repairProjectId}`,
    )
    secondRepairMs = performance.now() - secondStartedAt
    assert.equal(secondResponse.status, 200)
    await assert.rejects(fs.stat(repairTransportPath), (error) => error?.code === 'ENOENT')
  } finally {
    await fixtureApi.stop()
  }

  const plan = routeNationalGtfsStore(storePath, {
    origin: { coordinate: [8.0000, 47.0000], label: 'Alpha origin', source: 'map' },
    destination: { coordinate: [8.0200, 47.0200], label: 'Charlie destination', source: 'map' },
    departMinutes: 8 * 60,
    serviceDay: 'sunday',
    serviceDate: '2026-07-12',
    maxWalkKm: 0.25,
  })
  assert.equal(plan.status, 'ready')
  assert.deepEqual(plan.legs.filter((leg) => leg.type === 'ride').map((leg) => leg.routeShortName), ['1', '2'])
  assert.equal(plan.legs.find((leg) => leg.type === 'ride')?.geometrySource, 'shape')
  assert.equal(plan.legs.find((leg) => leg.type === 'ride')?.coordinates.length, 4)
  assert.equal(plan.transfers, 1)
  assert(plan.durationMinutes >= 30 && plan.durationMinutes <= 32)
  assert.equal(plan.travelMode, 'transit', 'Long national routes must remain scheduled transit itineraries.')

  const compactKernelContext = prepareNationalGtfsRoutingContext(storePath, {
    serviceDate: '2026-07-12',
    serviceDay: 'sunday',
  })
  assert.equal(compactKernelContext.activeServiceKernel.ready, true, 'Prewarm must compile the bounded Rust active-service kernel.')
  assert.equal(compactKernelContext.activeServiceKernel.activeSegments, 2)
  assert.equal(compactKernelContext.activeServiceKernel.engine, 'rust_exact_connection_scan')
  assert.equal(compactKernelContext.activeServiceKernel.heuristicMode, 'none')
  assert(
    compactKernelContext.activeServiceKernel.nativeMemoryBudget.limitBytes === null
      || compactKernelContext.activeServiceKernel.nativeMemoryBudget.usedBytes
        <= compactKernelContext.activeServiceKernel.nativeMemoryBudget.limitBytes,
  )
  const compactKernelPlan = routeNationalGtfsStore(storePath, {
    origin: { coordinate: [8.0000, 47.0000], label: 'Kernel Alpha origin', source: 'map' },
    destination: { coordinate: [8.0200, 47.0200], label: 'Kernel Charlie destination', source: 'map' },
    departMinutes: 8 * 60,
    serviceDay: 'sunday',
    serviceDate: '2026-07-12',
    maxWalkKm: 0.25,
  })
  assert.equal(compactKernelPlan.status, 'ready')
  assert.equal(compactKernelPlan.legs.find((leg) => leg.type === 'ride')?.geometrySource, 'shape')
  assert.equal(compactKernelPlan.diagnostics.algorithm, 'rust_exact_connection_scan_bounded_pareto_no_heuristic')
  assert.deepEqual(
    compactKernelPlan.diagnostics.methodUsed,
    ['rust_timetable_kernel', 'rust_exact_bounded_nondominated_frontier'],
  )
  assert.deepEqual(
    compactKernelPlan.legs.filter((leg) => leg.type === 'ride').map((leg) => [leg.routeId, leg.tripId, leg.startMinutes, leg.endMinutes]),
    plan.legs.filter((leg) => leg.type === 'ride').map((leg) => [leg.routeId, leg.tripId, leg.startMinutes, leg.endMinutes]),
    'The compact engine must preserve the SQLite exact ride chain and times.',
  )
  assert.equal(compactKernelPlan.arriveMinutes, plan.arriveMinutes)
  assert.equal(compactKernelPlan.durationMinutes, plan.durationMinutes)
  assert(Number.isFinite(compactKernelPlan.diagnostics.searchStats.engineQueryMs))
  const retainedRoleAdmission = await ensureNationalGtfsStopAccessRoles(storePath)
  assert.equal(retainedRoleAdmission.built, false)
  const compactKernelRepeatedAfterRoleAdmission = routeNationalGtfsStore(storePath, {
    origin: { coordinate: [8.0000, 47.0000], label: 'Kernel Alpha origin', source: 'map' },
    destination: { coordinate: [8.0200, 47.0200], label: 'Kernel Charlie destination', source: 'map' },
    departMinutes: 8 * 60,
    serviceDay: 'sunday',
    serviceDate: '2026-07-12',
    maxWalkKm: 0.25,
  })
  assert.equal(compactKernelRepeatedAfterRoleAdmission.status, 'ready')
  assert(!Object.hasOwn(compactKernelRepeatedAfterRoleAdmission.diagnostics.searchStats, 'cacheHit'))
  assert.deepEqual(
    compactKernelRepeatedAfterRoleAdmission.legs,
    compactKernelPlan.legs,
    'Read-only stop-role admission must preserve a freshly computed route.',
  )
  const compactKernelFreshPlan = routeNationalGtfsStore(storePath, {
    origin: { coordinate: [8.0000, 47.0000], label: 'Fresh Alpha origin', source: 'map' },
    destination: { coordinate: [8.0200, 47.0200], label: 'Fresh Charlie destination', source: 'map' },
    departMinutes: 8 * 60 + 1,
    serviceDay: 'sunday',
    serviceDate: '2026-07-12',
    maxWalkKm: 0.25,
  })
  assert.equal(compactKernelFreshPlan.status, 'ready')
  assert(!Object.hasOwn(compactKernelFreshPlan.diagnostics.searchStats, 'resultCache'))

  const inactiveKernelContext = prepareNationalGtfsRoutingContext(storePath, {
    serviceDate: '2026-07-19',
    serviceDay: 'sunday',
  })
  assert.equal(inactiveKernelContext.activeServiceKernel.ready, false)
  const restoredKernelContext = prepareNationalGtfsRoutingContext(storePath, {
    serviceDate: '2026-07-12',
    serviceDay: 'sunday',
  })
  assert.equal(restoredKernelContext.activeServiceKernel.ready, true)
  assert.equal(restoredKernelContext.activeServiceKernel.contextCacheHit, true, 'A repeated service set in the same process must restore the bounded in-memory context.')

  disposeNationalGtfsStore(storePath)
  const reloadedKernelContext = prepareNationalGtfsRoutingContext(storePath, {
    serviceDate: '2026-07-12',
    serviceDay: 'sunday',
  })
  assert.equal(reloadedKernelContext.activeServiceKernel.ready, true)
  assert.equal(reloadedKernelContext.activeServiceKernel.persistenceState, 'loaded', 'A later process/service activation must load the versioned compact snapshot instead of recompiling it.')
  assert.equal(reloadedKernelContext.activeServiceKernel.compileMs, 0)

  await fs.copyFile(storePath, kernelFallbackStorePath)
  const compactKernelFallbackContext = prepareNationalGtfsRoutingContext(kernelFallbackStorePath, {
    serviceDate: '2026-07-12',
    serviceDay: 'sunday',
  })
  assert.equal(
    compactKernelFallbackContext.activeServiceKernel.ready,
    true,
    'The Rust exact timetable kernel must not depend on a static-topology sidecar.',
  )
  const compactKernelFallbackRequest = {
    origin: { coordinate: [8.0000, 47.0000], label: 'Fallback Alpha origin', source: 'map' },
    destination: { coordinate: [8.0200, 47.0200], label: 'Fallback Charlie destination', source: 'map' },
    departMinutes: 8 * 60,
    serviceDay: 'sunday',
    serviceDate: '2026-07-12',
    maxWalkKm: 0.25,
  }
  const topologyIndependentPlan = routeNationalGtfsStore(
    kernelFallbackStorePath,
    compactKernelFallbackRequest,
  )
  assert.equal(topologyIndependentPlan.status, 'ready')
  assert.match(topologyIndependentPlan.diagnostics.algorithm, /^rust_exact_connection_scan/)
  for (const departureMinutes of [8 * 60, 8 * 60 + 4, 8 * 60 + 5, 8 * 60 + 6]) {
    const parityRequest = {
      origin: { coordinate: [8.0000, 47.0000], label: `Parity Alpha ${departureMinutes}`, source: 'stop', stopId: 'A' },
      destination: { coordinate: [8.0200, 47.0200], label: `Parity Charlie ${departureMinutes}`, source: 'stop', stopId: 'C' },
      departMinutes: departureMinutes,
      serviceDay: 'sunday',
      serviceDate: '2026-07-12',
      maxWalkKm: 0.25,
    }
    const exactCandidate = routeNationalGtfsStore(storePath, parityRequest)
    if (exactCandidate.status === 'ready') {
      assert.equal(exactCandidate.diagnostics.searchStats.heuristicMode, 'none')
      assert.equal(exactCandidate.diagnostics.searchStats.heuristicWeight, undefined)
      assert.match(exactCandidate.diagnostics.algorithm, /^rust_exact_connection_scan_/)
      assert.match(exactCandidate.diagnostics.optimality, /earliest_arrival/)
    }
  }

  await fs.copyFile(storePath, weekdayTemplateStorePath)
  const weekdayTemplateStore = new DatabaseSync(weekdayTemplateStorePath)
  weekdayTemplateStore.prepare("UPDATE metadata SET value='\"weekday-template\"' WHERE key='serviceModel'").run()
  weekdayTemplateStore.close()
  await buildNationalStaticTopologySidecar({
    storePath: weekdayTemplateStorePath,
    outputPath: `${weekdayTemplateStorePath}.static-topology.sqlite`,
    minimumFreeBytes: 128 * 1024 * 1024,
  })
  const weekdayTemplateFallback = routeNationalGtfsStore(weekdayTemplateStorePath, {
    origin: { coordinate: [8.0000, 47.0000], label: 'Template origin', source: 'map' },
    destination: { coordinate: [8.0200, 47.0200], label: 'Template destination', source: 'map' },
    departMinutes: 8 * 60,
    serviceDay: 'sunday',
    serviceDate: '2027-07-11',
    allowServiceDateFallback: true,
    maxWalkKm: 0.25,
  })
  assert.equal(weekdayTemplateFallback.status, 'ready')
  assert.equal(weekdayTemplateFallback.diagnostics.requestedServiceDate, '2027-07-11')
  assert.equal(weekdayTemplateFallback.diagnostics.resolvedServiceDate, '2026-07-12')
  assert.equal(weekdayTemplateFallback.diagnostics.serviceDateFallbackApplied, true)
  assert.match(weekdayTemplateFallback.detail, /timetable for 2026-07-12 \(fallback from 2027-07-11\)/)

  const denseAccessRequest = {
    origin: { coordinate: [0, 0], label: 'Dense access origin', source: 'map' },
    destination: { coordinate: [0.004, 0], label: 'Dense access destination', source: 'map' },
    departMinutes: 8 * 60,
    serviceDay: 'weekday',
    serviceDate: '2026-07-13',
    maxWalkKm: 1,
    streetStorePath: denseAccessStreetPath,
  }
  const denseAccessTransit = routeNationalGtfsStore(denseAccessStorePath, {
    ...denseAccessRequest,
    __disableDirectWalkDominance: true,
  })
  assert.equal(denseAccessTransit.status, 'ready')
  assert.equal(denseAccessTransit.title, 'FAST', 'OSM must choose the useful stop beyond a dense crow-flight decoy prefix.')
  assert.equal(denseAccessTransit.diagnostics.expandedStreetAccessRetry, undefined, 'The removed bounded-access retry must not appear in public diagnostics.')
  assert.equal(denseAccessTransit.diagnostics.coordinateAccessFrontier, 'complete_osm_reachable')
  assert(denseAccessTransit.durationMinutes < 20, 'The useful primary access stop must beat the reachable slow decoy route.')

  assert.equal(routeNationalGtfsStore(denseAccessStorePath, denseAccessRequest).travelMode, 'transit')
  denseAccessRequest.requireTransitRide = false
  for (const timePreference of ['depart', 'arrive']) {
    const endpointRequest = {
      ...denseAccessRequest, requireTransitRide: true, timePreference, arriveMinutes: 540,
      origin: { coordinate: [0.00002, 0.00003], label: 'Off-node origin', source: 'map' },
      destination: { coordinate: [0.00402, 0.00003], label: 'Off-node destination', source: 'map' },
    }
    const connected = routeNationalGtfsStore(denseAccessStorePath, endpointRequest)
    assert.equal(connected.status, 'ready')
    assert.deepEqual(connected.legs[0].endpointConnector.coordinates[0], endpointRequest.origin.coordinate,
      'Transit output must retain the coordinate connector already charged by the native access search.')
    assert.equal(connected.legs[0].endpointConnector.streetPathVerified, false)
    assert.deepEqual(connected.legs.at(-1).endpointConnector.coordinates.at(-1), endpointRequest.destination.coordinate,
      'Egress must expose its connection to the requested coordinate separately from the OSM path.')
  }

  const competitiveWalk = routeNationalGtfsStore(denseAccessStorePath, denseAccessRequest)
  assert.equal(competitiveWalk.status, 'ready')
  assert.equal(competitiveWalk.travelMode, 'walk', 'A verified OSM walk longer than two minutes must replace a slower materialized transit itinerary.')
  assert(competitiveWalk.durationMinutes > 2 && competitiveWalk.durationMinutes < denseAccessTransit.durationMinutes)
  assert.equal(competitiveWalk.diagnostics.algorithm, 'osm_direct_walk_vs_transit')
  assert.equal(competitiveWalk.diagnostics.optimality, 'direct_walk_dominates_materialized_transit_plan')
  assert.equal(competitiveWalk.diagnostics.transitAlternativeMinutes, denseAccessTransit.durationMinutes)
  const competitiveArriveByWalk = routeNationalGtfsStore(
    denseAccessStorePath,
    {
      ...denseAccessRequest,
      timePreference: 'arrive',
      arriveMinutes: 500,
    },
  )
  assert.equal(competitiveArriveByWalk.status, 'ready')
  assert.equal(
    competitiveArriveByWalk.travelMode,
    'walk',
    'Arrive-by must compare direct walking after proving the transit boundary.',
  )
  assert.equal(competitiveArriveByWalk.timePreference, 'arrive')
  assert.equal(competitiveArriveByWalk.arriveMinutes, 500)
  const competitiveArriveMatrix = routeNationalGtfsMatrix(denseAccessStorePath, {
    ...denseAccessRequest, timePreference: 'arrive', arriveMinutes: 500,
    origins: [denseAccessRequest.origin], destinations: [denseAccessRequest.destination],
  })
  assert.equal(competitiveArriveMatrix.rows[0].departMinutes, competitiveArriveByWalk.departMinutes)
  assert.equal(competitiveArriveMatrix.rows[0].arriveMinutes, 500)
  assert.equal(
    competitiveArriveByWalk.diagnostics.algorithm,
    'osm_direct_walk_latest_departure',
    'A walking arrive-by winner must use its exact deadline-relative departure, not a transit-event candidate.',
  )
  assert(
    Math.abs(
      competitiveArriveByWalk.arriveMinutes
        - competitiveArriveByWalk.departMinutes
        - competitiveArriveByWalk.durationMinutes,
    ) <= 0.002,
    'The walking arrive-by timeline must remain internally consistent after public rounding.',
  )
  const cachedTransitOnly = routeNationalGtfsStore(denseAccessStorePath, {
    ...denseAccessRequest,
    __disableDirectWalkDominance: true,
  })
  assert.equal(cachedTransitOnly.travelMode, 'transit')
  const cachedCompetitiveWalk = routeNationalGtfsStore(denseAccessStorePath, {
    ...denseAccessRequest,
  })
  assert.equal(
    cachedCompetitiveWalk.travelMode,
    'walk',
    'A transit-only matrix/cache entry must not suppress a later point-route walking winner.',
  )
  const denseAccessWindowRequest = {
    ...denseAccessRequest,
    __disableDirectWalkDominance: true,
    departureWindowMinutes: 10,
    stepMinutes: 1,
  }
  const denseAccessWindow = routeNationalGtfsDepartureWindow(
    denseAccessStorePath,
    denseAccessWindowRequest,
  )
  assert.equal(
    denseAccessWindow.profile.coordinateAccessFrontierPreparations,
    1,
    'A coordinate departure window must prepare exactly one endpoint-access frontier.',
  )
  assert(
    denseAccessWindow.profile.timetableRouteSearches > 1,
    'The fixture must exercise reuse across more than one timetable search.',
  )
  assert.equal(
    denseAccessWindow.profile.coordinateAccessFrontierReuses,
    denseAccessWindow.profile.timetableRouteSearches,
    'Every timetable search in one departure window must reuse the identity-bound endpoint frontier.',
  )
  assert.equal(
    denseAccessWindow.profile.coordinateAccessFrontierIdentity,
    'gtfs-store-object+gtfs-storage+street-path+street-storage+coordinates+walk-envelope',
  )
  const roundedWitnessNumber = (value) => (
    Number.isFinite(value) ? Number(value.toFixed(6)) : value
  )
  const exactScheduledWitness = (candidate) => ({
    status: candidate.status,
    travelMode: candidate.travelMode,
    departMinutes: roundedWitnessNumber(candidate.departMinutes),
    arriveMinutes: roundedWitnessNumber(candidate.arriveMinutes),
    durationMinutes: roundedWitnessNumber(candidate.durationMinutes),
    waitMinutes: roundedWitnessNumber(candidate.waitMinutes),
    walkMinutes: roundedWitnessNumber(candidate.walkMinutes),
    rideMinutes: roundedWitnessNumber(candidate.rideMinutes),
    transfers: candidate.transfers,
    rides: candidate.legs.filter((leg) => leg.type === 'ride').map((leg) => [
      leg.routeId,
      leg.tripId,
      roundedWitnessNumber(leg.startMinutes),
      roundedWitnessNumber(leg.endMinutes),
      leg.fromStopId,
      leg.toStopId,
    ]),
  })
  for (const windowCandidate of denseAccessWindow.profile.plans) {
    const independentlyPrepared = routeNationalGtfsStore(
      denseAccessStorePath,
      {
        ...denseAccessWindowRequest,
        departMinutes: windowCandidate.departMinutes,
        departureWindowMinutes: 0,
      },
    )
    assert.deepEqual(
      exactScheduledWitness(windowCandidate),
      exactScheduledWitness(independentlyPrepared),
      `Shared endpoint access must preserve the independently prepared exact witness at ${windowCandidate.departMinutes}.`,
    )
  }
  const denseAccessArriveBy = routeNationalGtfsStore(
    denseAccessStorePath,
    {
      ...denseAccessRequest,
      __disableDirectWalkDominance: true,
      timePreference: 'arrive',
      arriveMinutes: 500,
    },
  )
  assert.equal(denseAccessArriveBy.status, 'ready')
  assert.equal(denseAccessArriveBy.timePreference, 'arrive')
  assert.equal(denseAccessArriveBy.travelMode, 'transit')
  assert.equal(
    denseAccessArriveBy.legs.find((leg) => leg.type === 'ride')?.tripId,
    'dense\u001ffast-1',
  )
  assert.equal(
    denseAccessArriveBy.diagnostics.searchStats
      .coordinateAccessFrontierPreparations,
    1,
    'Arrive-by must prepare exactly one endpoint frontier before candidate verification.',
  )
  assert.equal(
    denseAccessArriveBy.diagnostics.searchStats.arriveByVerifiedCandidates,
    1,
    'The dense fixture must resolve its exact boundary in one reverse scan.',
  )
  assert.equal(
    denseAccessArriveBy.diagnostics.searchStats.arriveByCandidates,
    1,
    'Ordinary arrive-by must retain only the exact boundary selected by the reverse scan.',
  )
  assert.equal(
    denseAccessArriveBy.diagnostics.searchStats.arriveByCandidateSource,
    'rust_exact_reverse_scan',
    'Ordinary arrive-by must not enumerate the presentation-recovery frontier.',
  )
  assert.equal(
    denseAccessArriveBy.diagnostics.searchStats
      .coordinateAccessFrontierReuses,
    0,
    'Ordinary arrive-by must materialize from the prepared endpoint frontier without re-entering the public route path.',
  )
  assert.equal(
    denseAccessArriveBy.diagnostics.searchStats.arriveBySearchStrategy,
    'rust_exact_reverse_connection_scan',
  )
  assert.equal(
    denseAccessArriveBy.diagnostics.searchStats.arriveByReverseScans,
    1,
    'Exact arrive-by must not repeat the timetable scan.',
  )
  const denseAccessBalancedArriveBy = routeNationalGtfsStore(
    denseAccessStorePath,
    {
      ...denseAccessRequest,
      __disableDirectWalkDominance: true,
      timePreference: 'arrive',
      arriveMinutes: 500,
      routingPreference: 'balanced',
    },
  )
  assert.equal(denseAccessBalancedArriveBy.status, 'ready')
  assert.equal(
    denseAccessBalancedArriveBy.diagnostics.searchStats
      .arriveByFeasibilityRoutingPreference,
    'fastest',
    'Latest-departure feasibility must remain monotone under the exact fastest objective.',
  )
  assert.equal(
    denseAccessBalancedArriveBy.diagnostics.searchStats
      .arriveByRequestedRoutingPreference,
    'balanced',
  )
  assert.equal(
    denseAccessBalancedArriveBy.diagnostics.searchStats
      .arriveByRequestedPreferenceVerificationPerformed,
    true,
  )
  assert.equal(
    denseAccessBalancedArriveBy.diagnostics.searchStats
      .arriveByRequestedPreferenceMetDeadline,
    true,
  )
  assert(
    denseAccessBalancedArriveBy.diagnostics.searchStats.selectedArrivalSeconds
      <= 500 * 60,
    'The balanced choice retained at the exact latest-departure boundary must still meet the deadline.',
  )
  const quantizedDeadlineRequest = {
    ...denseAccessRequest,
    destination: {
      coordinate: [0.0044, 0],
      label: 'Dense quantized destination',
      source: 'map',
    },
    __disableDirectWalkDominance: true,
  }
  const quantizedDeadlineDepartPlan = routeNationalGtfsStore(
    denseAccessStorePath,
    quantizedDeadlineRequest,
  )
  assert.equal(quantizedDeadlineDepartPlan.status, 'ready')
  assert.equal(
    quantizedDeadlineDepartPlan.diagnostics.searchStats.selectedArrivalSeconds
      % 60,
    34,
    'The fixture must expose a public-minute rounding boundary at 34 seconds.',
  )
  const quantizedDeadlineArriveBy = routeNationalGtfsStore(
    denseAccessStorePath,
    {
      ...quantizedDeadlineRequest,
      timePreference: 'arrive',
      // Public arrive-by inputs are minute-granular. The native boundary still
      // verifies candidate arrivals to the second beneath that contract.
      arriveMinutes: Math.ceil(quantizedDeadlineDepartPlan.arriveMinutes),
    },
  )
  assert.equal(quantizedDeadlineArriveBy.status, 'ready')
  assert.equal(
    quantizedDeadlineArriveBy.timePreference,
    'arrive',
  )
  assert(
    quantizedDeadlineArriveBy.diagnostics.searchStats.selectedArrivalSeconds
      <= quantizedDeadlineArriveBy.arriveMinutes * 60,
    'Arrive-by must verify the exact selected arrival against the integral public deadline.',
  )
  assert.throws(
    () => routeNationalGtfsStore(
      denseAccessStorePath,
      {
        ...quantizedDeadlineRequest,
        departMinutes: 8 * 60 + 0.5,
      },
    ),
    /integral minute/,
    'The public routing contract must reject sub-minute numeric departure times instead of silently rounding them.',
  )

  const completeEgressRequest = {
    origin: {
      coordinate: [0, 0], label: 'Egress origin', source: 'stop',
      stopId: 'egress\u001fORIGIN',
    },
    destination: { coordinate: [0.012, 0], label: 'Destination', source: 'map' },
    departMinutes: 480,
    serviceDay: 'weekday',
    serviceDate: '2026-07-13',
    maxWalkKm: 0.5,
    streetStorePath: completeEgressStreetPath,
    __destinationAccessStopIds: ['egress\u001fY'],
  }
  const exactConnectorPlan = routeNationalGtfsStore(completeEgressStorePath, completeEgressRequest)
  assert.deepEqual(
    exactConnectorPlan.legs.filter((leg) => leg.type === 'ride').map((leg) => leg.routeShortName),
    ['MAIN', 'CONNECTOR'],
    'The timetable result must retain the destination-access connector selected by the routing objective.',
  )
  assert.equal(exactConnectorPlan.status, 'ready')
  assert.equal(exactConnectorPlan.travelMode, 'transit')
  assert.match(exactConnectorPlan.diagnostics.algorithm, /^rust_exact_connection_scan_/)

  const completeEgressPlan = routeNationalGtfsStore(completeEgressStorePath, {
    ...completeEgressRequest,
    __destinationAccessStopIds: undefined,
  })
  assert.equal(completeEgressPlan.status, 'ready')
  assert.deepEqual(
    completeEgressPlan.legs.filter((leg) => leg.type === 'ride').map((leg) => leg.routeShortName),
    ['MAIN'],
    'Complete egress coverage must alight from the main line and walk instead of waiting for an unnecessary one-minute connector.',
  )
  assert(
    completeEgressPlan.arriveMinutes < exactConnectorPlan.arriveMinutes,
    'The direct egress walk must arrive before the wait-plus-one-minute connector itinerary.',
  )
  assert.equal(completeEgressPlan.diagnostics.coordinateAccessFrontier, 'complete_osm_reachable')
  assert.match(completeEgressPlan.diagnostics.algorithm, /^rust_exact_connection_scan_/)

  const shortWalkRequest = {
    requireTransitRide: false,
    origin: { coordinate: [0, 0], label: 'Short walk origin', source: 'map' },
    destination: { coordinate: [0.0009, 0], label: 'Short walk destination', source: 'map' },
    departMinutes: 8 * 60,
    serviceDay: 'sunday',
    serviceDate: '2026-07-12',
    maxWalkKm: 0.2,
    streetStorePath: directWalkStreetPath,
  }
  const fasterShortTransitPlan = routeNationalGtfsStore(
    shortTransitStorePath,
    shortWalkRequest,
  )
  assert.equal(fasterShortTransitPlan.status, 'ready')
  assert.equal(
    fasterShortTransitPlan.travelMode,
    'transit',
    'A 30-second scheduled ride must beat the graph-verified 75.75-second walk when coordinate endpoint overhead is zero.',
  )
  assert.equal(fasterShortTransitPlan.durationMinutes, 0.5)
  assert.deepEqual(
    fasterShortTransitPlan.legs
      .filter((leg) => leg.type === 'ride')
      .map((leg) => leg.routeShortName),
    ['SHORT'],
  )
  const accessBudgetExceeded = routeNationalGtfsStore(shortTransitStorePath, {
    ...shortWalkRequest,
    origin: { coordinate: [0.00225, 0.03], label: 'Budget-limited origin', source: 'map' },
    destination: {
      coordinate: [0.00225, 0.03],
      label: 'Exact long destination',
      source: 'stop',
      stopId: 'short\u001fLONG_B',
    },
    __originAccessStopIds: ['short\u001fLONG_A'],
    __disableDirectWalkDominance: true,
  })
  assert.equal(accessBudgetExceeded.status, 'blocked')
  assert.equal(accessBudgetExceeded.diagnostics.failureCode, 'access_budget_exceeded')
  assert.equal(accessBudgetExceeded.title, 'Walking limit exceeded')
  assert.equal(accessBudgetExceeded.detail, accessBudgetExceeded.diagnostics.failure.message)
  assert.equal(
    accessBudgetExceeded.diagnostics.accessAvailability.origin.status,
    'outside_selected_budget',
  )

  const streetAccessUnverified = routeNationalGtfsStore(shortTransitStorePath, {
    ...shortWalkRequest,
    origin: { coordinate: [0, 0.02], label: 'Disconnected street origin', source: 'map' },
    destination: {
      coordinate: [0.00225, 0.03],
      label: 'Exact long destination',
      source: 'stop',
      stopId: 'short\u001fLONG_B',
    },
    maxWalkKm: 0.6,
    __originAccessStopIds: ['short\u001fLONG_A'],
    __disableDirectWalkDominance: true,
  })
  assert.equal(streetAccessUnverified.status, 'blocked')
  assert.equal(streetAccessUnverified.diagnostics.failureCode, 'street_access_unverified')
  assert.equal(streetAccessUnverified.title, 'Street access unverified')
  const unverifiedHint = streetAccessUnverified.diagnostics.accessAvailability.origin
  assert.equal(unverifiedHint.nearestStop.distanceKind, 'straight_line')
  assert.equal(unverifiedHint.nearestStop.walkMinutes, undefined,
    'Geometric proximity must not be presented as a verified walking time.')
  assert.equal(
    streetAccessUnverified.diagnostics.accessAvailability.origin.status,
    'street_access_unverified',
  )
  // Repeat after cached queries, and exercise both departure and arrival
  // paths: the wider explanatory probe must honor the same cache policy.
  for (const timePreference of ['depart', 'arrive']) {
    for (let repeat = 0; repeat < 2; repeat += 1) {
      const plan = routeNationalGtfsStore(shortTransitStorePath, {
        ...shortWalkRequest,
        origin: streetAccessUnverified.origin,
        destination: streetAccessUnverified.destination,
        maxWalkKm: 0.6,
        timePreference,
        arriveMinutes: 600,
        requireTransitRide: true,
        __originAccessStopIds: ['short\u001fLONG_A'],
        __disableNativeStreetPathCache: true,
      })
      assert.equal(plan.status, 'blocked')
      assert.equal(plan.maxWalkKm, 0.6, 'Diagnostic probes must not relax the actual request.')
      for (const hint of Object.values(plan.diagnostics.accessAvailability).filter(Boolean)) {
        assert.equal(hint.cacheDisabled, true)
        assert.equal(hint.cacheHit, false)
        assert.equal(hint.probeComplete, true)
      }
    }
  }
  const transitReadyWholeLegWalkRequest = {
    ...shortWalkRequest,
    origin: {
      coordinate: [0, 0.03],
      label: 'Transit-ready whole-leg walk origin',
      source: 'map',
    },
    destination: {
      coordinate: [0.00225, 0.03],
      label: 'Transit-ready whole-leg walk destination',
      source: 'map',
    },
    maxStreetKm: 0.3,
  }
  const transitReadyWholeLegWalk = routeNationalGtfsStore(
    shortTransitStorePath,
    transitReadyWholeLegWalkRequest,
  )
  assert.equal(transitReadyWholeLegWalk.status, 'ready')
  assert.equal(
    transitReadyWholeLegWalk.travelMode,
    'walk',
    'A faster whole-leg walk must compete with a ready transit plan outside the smaller endpoint access budget.',
  )
  assert(
    transitReadyWholeLegWalk.legs[0].distanceKm
      > transitReadyWholeLegWalkRequest.maxWalkKm,
  )
  assert.equal(
    transitReadyWholeLegWalk.diagnostics.algorithm,
    'osm_direct_walk_vs_transit',
  )
  assert.equal(
    transitReadyWholeLegWalk.diagnostics.directWalkEnvelope.accessEgressLimitKm,
    transitReadyWholeLegWalkRequest.maxWalkKm,
  )
  assert.equal(
    transitReadyWholeLegWalk.diagnostics.directWalkEnvelope.directWalkLimitKm,
    transitReadyWholeLegWalkRequest.maxStreetKm,
  )
  assert.equal(
    transitReadyWholeLegWalk.diagnostics.directWalkEnvelope.exceedsAccessEgressLimit,
    true,
  )
  assert.equal(
    transitReadyWholeLegWalk.diagnostics.directWalkStreetPathReused,
    false,
    'A narrow-envelope street miss must not suppress the wider legal whole-leg walk search.',
  )
  // A walk can win now while a later departure catches faster transit. Reuse
  // only the proven interval, including when the moving horizon admits a trip.
  for (const shortHorizon of [false, true]) {
    const schedulePath = path.join(folder, `walk-window-${shortHorizon}.json`)
    const windowStorePath = path.join(folder, `walk-window-${shortHorizon}.sqlite`)
    const stops = shortTransitSchedule.stops.filter((stop) => stop.id.startsWith('LONG_'))
      .map((stop) => shortHorizon && stop.id === 'LONG_B' ? { ...stop, lon: 0.001125 } : stop)
    const trips = [{ id: 'LATER', departure: 485, arrival: shortHorizon ? 485.5 : 487, to: 'LONG_B' }]
    if (shortHorizon) {
      stops.push({ id: 'LONG_C', name: 'Direct destination', lat: 0.03, lon: 0.00225, locationType: 0 })
      trips.push({ id: 'OUTSIDE', departure: 486 + 1 / 60, arrival: 486 + 2 / 60, to: 'LONG_C' })
    }
    await fs.writeFile(schedulePath, JSON.stringify({
      stops,
      routes: trips.map((trip) => ({
        id: trip.id, shortName: trip.id, routeType: 3,
        scheduledTrips: [{
          tripId: trip.id, serviceId: 'sunday', serviceDays: ['sunday'],
          stopTimes: [
            { stopId: 'LONG_A', arrivalMinutes: trip.departure, departureMinutes: trip.departure, sequence: 1 },
            { stopId: trip.to, arrivalMinutes: trip.arrival, departureMinutes: trip.arrival, sequence: 2 },
          ],
        }],
      })),
      transferRules: [],
    }))
    await buildRoutingStoreFromSchedules({ schedules: [{ feedId: 'walk-window', schedulePath }], outputPath: windowStorePath })
    try {
      const query = {
        ...transitReadyWholeLegWalkRequest,
        departMinutes: shortHorizon ? 482 : 480,
        departureWindowMinutes: shortHorizon ? 2 : 5,
        departureWindowDirection: 'forward',
        ...(shortHorizon ? { horizonMinutes: 4 } : {}),
      }
      const window = routeNationalGtfsDepartureWindow(windowStorePath, query)
      const routeSummary = (plan) => [plan.status, plan.travelMode, plan.arriveMinutes, plan.transfers,
        plan.legs.filter((leg) => leg.type === 'ride').map((leg) => leg.tripId)]
      for (const plan of window.profile.plans) {
        assert.deepEqual(routeSummary(plan), routeSummary(routeNationalGtfsStore(windowStorePath, {
          ...query, departureWindowMinutes: 0, departMinutes: plan.departMinutes,
        })), 'Reusing a walking result must match a fresh timetable query at every departure.')
      }
      assert.equal(window.profile.plans[0].travelMode, 'walk')
      assert.equal(window.profile.plans[0].diagnostics.searchStats.boundedSearchSkipped,
        'direct_walk_beats_exact_earliest_transit_arrival')
      assert(!window.profile.plans[0].diagnostics.searchStats.nativeTimetableKernel?.pareto,
        'A proven winning walk must skip the bounded native pass.')
      assert.equal(window.profile.plans.at(-1).travelMode, 'transit')
      if (shortHorizon) {
        assert(window.profile.plans[1].legs.some((leg) => leg.routeShortName === 'OUTSIDE'),
          'The reuse interval must stop before the moving horizon admits a faster trip.')
      } else {
        assert(window.profile.directWalkSampleReuses > 0)
        assert(window.profile.routeSearches < window.profile.sampleCount)
      }
    } finally {
      disposeNationalGtfsStore(windowStorePath)
    }
  }
  const transitReadyWholeLegWalkArriveBy = routeNationalGtfsStore(
    shortTransitStorePath,
    {
      ...transitReadyWholeLegWalkRequest,
      timePreference: 'arrive',
      arriveMinutes: 490,
    },
  )
  assert.equal(transitReadyWholeLegWalkArriveBy.status, 'ready')
  assert.equal(transitReadyWholeLegWalkArriveBy.travelMode, 'walk')
  assert.equal(
    transitReadyWholeLegWalkArriveBy.diagnostics.algorithm,
    'osm_direct_walk_latest_departure',
  )
  assert.equal(transitReadyWholeLegWalkArriveBy.arriveMinutes, 490)
  assert(
    transitReadyWholeLegWalkArriveBy.departMinutes > 480,
    'The end-to-end walk must leave later than the ready transit alternative while meeting the same deadline.',
  )
  const sourceEqualTimePlan = routeNationalGtfsStore(shortTransitStorePath, {
    ...shortWalkRequest,
    departMinutes: 9 * 60,
  })
  const sourceEqualTimeLeg = sourceEqualTimePlan.legs.find((leg) => leg.type === 'ride')
  assert.equal(sourceEqualTimePlan.status, 'ready')
  assert.equal(sourceEqualTimePlan.travelMode, 'transit')
  assert.equal(sourceEqualTimePlan.durationMinutes, 0)
  assert.equal(sourceEqualTimeLeg?.sourceEqualTime, true)
  assert.equal(sourceEqualTimeLeg?.sourceEqualTimeConnectionCount, 1)
  assert.equal(sourceEqualTimeLeg?.sourceTimestampQuality, 'equal-whole-minute')
  assert.equal(sourceEqualTimePlan.diagnostics.timingPrecision, 'source-equal-time')

  const tiedDirectWalkPlan = routeNationalGtfsStore(shortTransitStorePath, {
    ...shortWalkRequest,
    departMinutes: 10 * 60,
  })
  assert.equal(tiedDirectWalkPlan.status, 'ready')
  assert.equal(tiedDirectWalkPlan.travelMode, 'walk')
  assert.equal(tiedDirectWalkPlan.durationMinutes, 1.263)
  assert.equal(
    tiedDirectWalkPlan.diagnostics.algorithm,
    'osm_direct_walk_vs_transit',
    'A walk-only path must win an exact arrival tie because it has zero boardings.',
  )
  assert.equal(sourceEqualTimePlan.diagnostics.sourceEqualTimeRideCount, 1)
  assert.equal(sourceEqualTimePlan.diagnostics.sourceEqualTimeConnectionCount, 1)
  assert.match(sourceEqualTimePlan.detail, /1 ride published within one timestamp/)

  const configuredOverheadWalk = await runConfiguredEndpointOverheadFixture(
    storePath,
    directWalkStreetPath,
  )
  assert.equal(configuredOverheadWalk.status, 'ready')
  assert.equal(configuredOverheadWalk.travelMode, 'walk')
  assert.equal(configuredOverheadWalk.algorithm, 'osm_direct_walk_dominance')
  assert.equal(
    configuredOverheadWalk.optimality,
    'direct_walk_strictly_dominates_configured_endpoint_overhead_lower_bound',
  )
  assert.equal(configuredOverheadWalk.transitLowerBoundMinutes, 2)
  assert(configuredOverheadWalk.durationMinutes < configuredOverheadWalk.transitLowerBoundMinutes)

  const accessFrontierWalk = routeNationalGtfsStore(
    accessBoundStorePath,
    shortWalkRequest,
  )
  assert.equal(accessFrontierWalk.status, 'ready')
  assert.equal(accessFrontierWalk.travelMode, 'walk')
  assert.equal(
    accessFrontierWalk.diagnostics.algorithm,
    'osm_direct_walk_service_anchor_lower_bound',
  )
  assert.equal(
    accessFrontierWalk.diagnostics.optimality,
    'direct_walk_strictly_dominates_exact_service_anchor_lower_bound',
  )
  assert.equal(
    accessFrontierWalk.diagnostics.coordinateAccessLowerBound,
    'global_role_eligible_public_anchor_chord_certificate',
  )
  assert(accessFrontierWalk.diagnostics.originAccessLowerBoundSeconds > 0)
  assert(accessFrontierWalk.diagnostics.destinationEgressLowerBoundSeconds > 0)
  assert.equal(
    accessFrontierWalk.diagnostics.serviceAccessAnchorProfile
      ?.chordLowerBoundFactor,
    0.98,
  )
  assert.equal(
    accessFrontierWalk.diagnostics.serviceAccessAnchorProfile
      ?.distanceKernel,
    'single_pass_precomputed_unit_chord',
  )
  assert.equal(
    accessFrontierWalk.diagnostics.serviceAccessAnchorProfile?.scanPasses,
    1,
  )
  assert.equal(
    accessFrontierWalk.diagnostics.transitServiceCoverageProbe
      ?.resolutionStrategy,
    'single_feed_exact_date_global_anchor_superset_no_service_enumeration',
    'A single-feed exact-date anchor proof must not enumerate an unused active-service set.',
  )
  assert.equal(
    accessFrontierWalk.diagnostics.transitEndpointLowerBoundSeconds,
    accessFrontierWalk.diagnostics.originAccessLowerBoundSeconds
      + accessFrontierWalk.diagnostics.destinationEgressLowerBoundSeconds,
  )
  assert(
    accessFrontierWalk.durationMinutes * 60
      < accessFrontierWalk.diagnostics.transitEndpointLowerBoundSeconds,
  )
  const cachedAnchorProfileWalk = routeNationalGtfsStore(
    accessBoundStorePath,
    {
      ...shortWalkRequest,
      departMinutes: shortWalkRequest.departMinutes + 1,
    },
  )
  assert.equal(
    cachedAnchorProfileWalk.diagnostics.serviceAccessAnchorProfile?.cacheHit,
    true,
    'A distinct short-walk request must reuse the immutable service-anchor profile.',
  )
  assert.equal(
    cachedAnchorProfileWalk.durationMinutes,
    accessFrontierWalk.durationMinutes,
  )

  const incompleteCoverageWalk = routeNationalGtfsStore(
    incompleteCoverageStorePath,
    {
      ...shortWalkRequest,
      requireCompleteServiceCoverage: true,
    },
  )
  assert.equal(incompleteCoverageWalk.status, 'ready')
  assert.equal(incompleteCoverageWalk.travelMode, 'walk')
  assert.equal(
    incompleteCoverageWalk.diagnostics.algorithm,
    'osm_direct_walk_incomplete_service_coverage',
  )
  assert.equal(
    incompleteCoverageWalk.diagnostics.optimality,
    'graph_verified_direct_walk_when_required_service_coverage_is_incomplete',
  )
  assert.equal(
    incompleteCoverageWalk.diagnostics.transitSearchAttempted,
    false,
  )
  assert.equal(
    incompleteCoverageWalk.diagnostics.transitFailureCode,
    'incomplete_service_coverage',
  )
  assert.equal(
    incompleteCoverageWalk.diagnostics.resolvedServiceScopeCount,
    1,
  )
  assert.equal(
    incompleteCoverageWalk.diagnostics.availableServiceScopeCount,
    2,
  )
  const incompleteCoverageWholeLegWalk = routeNationalGtfsStore(
    incompleteCoverageStorePath,
    {
      ...shortWalkRequest,
      origin: {
        coordinate: [0, 0.03],
        label: 'Incomplete-coverage whole-leg origin',
        source: 'map',
      },
      destination: {
        coordinate: [0.00225, 0.03],
        label: 'Incomplete-coverage whole-leg destination',
        source: 'map',
      },
      maxStreetKm: 0.3,
      requireCompleteServiceCoverage: true,
    },
  )
  assert.equal(
    incompleteCoverageWholeLegWalk.status,
    'blocked',
    'Strict required-service coverage must not broaden its narrow preflight walk into an unsupported whole-network fallback.',
  )
  const incompleteCoverageExactStops = routeNationalGtfsStore(
    incompleteCoverageStorePath,
    {
      ...shortWalkRequest,
      origin: {
        coordinate: [-0.0009, 0],
        label: 'Exact incomplete origin',
        source: 'stop',
        stopId: 'access-bound\u001fACCESS_A',
      },
      destination: {
        coordinate: [0.0018, 0],
        label: 'Exact incomplete destination',
        source: 'stop',
        stopId: 'access-bound\u001fACCESS_B',
      },
      maxStreetKm: 0.5,
      requireCompleteServiceCoverage: true,
    },
  )
  assert.equal(
    incompleteCoverageExactStops.status,
    'blocked',
    'Incomplete required service coverage must not inject a direct-walk fallback into the exact-stop contract.',
  )

  const accessFrontierWalkWindow = routeNationalGtfsDepartureWindow(
    accessBoundStorePath,
    {
      ...shortWalkRequest,
      departureWindowMinutes: 1,
      stepMinutes: 1,
    },
  )
  assert.equal(accessFrontierWalkWindow.profile.sampleCount, 3)
  assert.equal(accessFrontierWalkWindow.profile.readyCount, 3)
  assert.equal(
    accessFrontierWalkWindow.profile.routeSearches,
    1,
    'A complete endpoint-access proof must be reused across the remaining departure samples.',
  )
  assert(accessFrontierWalkWindow.profile.plans.every((candidate) => (
    candidate.travelMode === 'walk'
    && candidate.diagnostics.algorithm === 'osm_direct_walk_access_frontier_dominance'
  )))

  const shortWalkPlan = routeNationalGtfsStore(storePath, shortWalkRequest)
  assert.equal(shortWalkPlan.status, 'ready')
  assert.equal(shortWalkPlan.travelMode, 'walk', 'A graph-verified short walk must remain available when no supported transit path exists.')
  assert(shortWalkPlan.durationMinutes < 2)
  assert.equal(shortWalkPlan.legs.length, 1)
  assert.equal(shortWalkPlan.legs[0].walkSource, 'osm')
  assert.equal(shortWalkPlan.legs.filter((leg) => leg.type === 'ride').length, 0)
  assert.equal(shortWalkPlan.diagnostics.algorithm, 'osm_direct_walk_no_transit_fallback')
  assert.equal(
    shortWalkPlan.diagnostics.optimality,
    'graph_verified_direct_walk_when_no_supported_transit_path',
  )

  const shortWalkArriveBy = routeNationalGtfsStore(storePath, {
    ...shortWalkRequest,
    timePreference: 'arrive',
    departMinutes: 9 * 60,
    arriveMinutes: 9 * 60,
  })
  assert.equal(shortWalkArriveBy.status, 'ready')
  assert.equal(shortWalkArriveBy.travelMode, 'walk')
  assert.equal(shortWalkArriveBy.timePreference, 'arrive')
  assert.equal(shortWalkArriveBy.arriveMinutes, 9 * 60)
  assert.equal(Number((shortWalkArriveBy.departMinutes + shortWalkArriveBy.durationMinutes).toFixed(3)), 9 * 60)

  const recoveredOffNetworkOrigin = [0, 0.001]
  const recoveredOffNetworkDestination = [0.0009, 0]
  const recoveredOffNetworkWalk = routeNationalGtfsStore(storePath, {
    ...shortWalkRequest,
    origin: {
      coordinate: recoveredOffNetworkOrigin,
      label: 'Recovered off-network walk origin',
      source: 'map',
    },
    destination: {
      coordinate: recoveredOffNetworkDestination,
      label: 'Recovered off-network walk destination',
      source: 'map',
    },
    timePreference: 'arrive',
    arriveMinutes: 9 * 60,
    maxStreetKm: 0.3,
  })
  assert.equal(recoveredOffNetworkWalk.status, 'ready')
  assert.equal(recoveredOffNetworkWalk.travelMode, 'walk')
  assert.equal(recoveredOffNetworkWalk.arriveMinutes, 9 * 60)
  assert.equal(
    recoveredOffNetworkWalk.diagnostics.algorithm,
    'osm_direct_walk_no_transit_fallback',
  )
  assert.equal(
    recoveredOffNetworkWalk.diagnostics.transitFailureCode,
    'access_unreachable',
  )
  assert.equal(
    recoveredOffNetworkWalk.diagnostics.directWalkFallback.exceedsAccessEgressLimit,
    true,
  )
  assert(recoveredOffNetworkWalk.legs[0].distanceKm > shortWalkRequest.maxWalkKm)
  assert(recoveredOffNetworkWalk.legs[0].distanceKm <= 0.3)
  assert.deepEqual(
    recoveredOffNetworkWalk.legs[0].coordinates[0],
    recoveredOffNetworkOrigin,
  )
  assert.deepEqual(
    recoveredOffNetworkWalk.legs[0].coordinates.at(-1),
    recoveredOffNetworkDestination,
  )

  const shortWalkWindow = routeNationalGtfsDepartureWindow(storePath, {
    ...shortWalkRequest,
    departureWindowMinutes: 1,
    stepMinutes: 1,
  })
  assert.equal(shortWalkWindow.plan.travelMode, 'walk')
  assert.equal(shortWalkWindow.choices.length, 1)
  assert.equal(shortWalkWindow.profile.sampleCount, 3)
  assert.equal(shortWalkWindow.profile.readyCount, 3)
  assert.equal(
    shortWalkWindow.profile.routeSearches,
    3,
    'With zero endpoint overhead, each departure sample must compete with the timetable before a walk fallback is accepted.',
  )
  assert(shortWalkWindow.profile.plans.every((candidate) => candidate.travelMode === 'walk' && candidate.status === 'ready'))

  const disconnectedShortWalk = routeNationalGtfsStore(storePath, {
    ...shortWalkRequest,
    origin: { coordinate: [0, 0.02], label: 'Disconnected short origin', source: 'map' },
    destination: { coordinate: [0.0009, 0.02], label: 'Disconnected short destination', source: 'map' },
  })
  assert.equal(disconnectedShortWalk.status, 'blocked')
  assert.equal(disconnectedShortWalk.travelMode, 'transit', 'Disconnected OSM points must fall through without a straight-line walk estimate.')

  const wholeLegWalkRequest = {
    ...shortWalkRequest,
    routingDataMode: 'scheduled',
    mode: 'transit',
    origin: { coordinate: [0, 0.03], label: 'Whole-leg walk origin', source: 'map' },
    destination: { coordinate: [0.00225, 0.03], label: 'Whole-leg walk destination', source: 'map' },
    maxStreetKm: 0.3,
  }
  const wholeLegWalkBeyondTransitAccess = routeNationalGtfsStore(storePath, wholeLegWalkRequest)
  assert.equal(wholeLegWalkBeyondTransitAccess.status, 'ready')
  assert.equal(
    wholeLegWalkBeyondTransitAccess.travelMode,
    'walk',
    'A graph-verified whole-leg walk must not be capped by the per-endpoint transit access budget.',
  )
  assert(wholeLegWalkBeyondTransitAccess.legs[0].distanceKm > shortWalkRequest.maxWalkKm)
  assert.equal(wholeLegWalkBeyondTransitAccess.maxWalkKm, shortWalkRequest.maxWalkKm)
  assert.equal(
    wholeLegWalkBeyondTransitAccess.diagnostics.directWalkFallback.accessEgressLimitKm,
    shortWalkRequest.maxWalkKm,
  )
  assert.equal(
    wholeLegWalkBeyondTransitAccess.diagnostics.directWalkFallback.directWalkLimitKm,
    0.3,
  )
  assert.equal(
    wholeLegWalkBeyondTransitAccess.diagnostics.directWalkFallback.directWalkLimitScope,
    'end-to-end',
  )
  assert.equal(
    wholeLegWalkBeyondTransitAccess.diagnostics.directWalkFallback.exceedsAccessEgressLimit,
    true,
  )
  assert.equal(
    wholeLegWalkBeyondTransitAccess.diagnostics.searchStats.directWalkFallbackMs,
    wholeLegWalkBeyondTransitAccess.diagnostics.directWalkFallback.streetSearchMs,
  )
  assert.equal(
    wholeLegWalkBeyondTransitAccess.diagnostics.searchStats.directWalkFallbackSettledNodes,
    wholeLegWalkBeyondTransitAccess.diagnostics.directWalkFallback.nativeSettledNodes,
  )
  assert.equal(
    wholeLegWalkBeyondTransitAccess.diagnostics.searchStats.directWalkFallbackChainSkippedNodes,
    wholeLegWalkBeyondTransitAccess.diagnostics.directWalkFallback.nativeChainSkippedNodes,
  )
  assert.equal(
    wholeLegWalkBeyondTransitAccess.diagnostics.searchStats.directWalkFallbackContractedArcRelaxations,
    wholeLegWalkBeyondTransitAccess.diagnostics.directWalkFallback.nativeContractedArcRelaxations,
  )

  const wholeLegWalkOutsideStreetEnvelope = routeNationalGtfsStore(storePath, {
    ...wholeLegWalkRequest,
    maxStreetKm: 0.24,
  })
  assert.equal(
    wholeLegWalkOutsideStreetEnvelope.status,
    'blocked',
    'The independent whole-leg street envelope must remain an enforced bound.',
  )
  const wholeLegWalkPolicies = [
    [wholeLegWalkBeyondTransitAccess, 0.3, false],
    [wholeLegWalkOutsideStreetEnvelope, 0.24, false],
    [routeNationalGtfsStore(storePath, { ...wholeLegWalkRequest, allowLongWalk: false }), 0.2, false],
    [routeNationalGtfsStore(storePath, { ...wholeLegWalkRequest, requireTransitRide: true }), 0.3, true],
  ]
  for (const [plan, directWalkLimitKm, requireTransitRide] of wholeLegWalkPolicies) {
    const provenance = plan.diagnostics.routingDataProvenance
    assert.equal(plan.status, plan === wholeLegWalkBeyondTransitAccess ? 'ready' : 'blocked')
    assert.equal(provenance.searchParameters.travelMode, 'transit')
    assert.equal(provenance.searchParameters.directWalkLimitKm, directWalkLimitKm)
    assert.equal(provenance.searchParameters.requireTransitRide, requireTransitRide)
    assert.equal(provenance.staticTimetableIdentity, wholeLegWalkBeyondTransitAccess.diagnostics.routingDataProvenance.staticTimetableIdentity)
    assert.equal(provenance.streetIdentity, wholeLegWalkBeyondTransitAccess.diagnostics.routingDataProvenance.streetIdentity)
  }
  assert.equal(
    new Set(wholeLegWalkPolicies.map(([plan]) => plan.diagnostics.routingDataProvenance.reproducibilityKey)).size,
    wholeLegWalkPolicies.length,
    'The same dated endpoints must have distinct provenance for different enforced whole-leg walking policies and transit requirements.',
  )

  const justOverThresholdWalk = routeNationalGtfsStore(storePath, {
    ...shortWalkRequest,
    origin: { coordinate: [0, 0.01], label: 'Two minute origin', source: 'map' },
    destination: { coordinate: [0.0016, 0.01], label: 'Two minute destination', source: 'map' },
  })
  assert.equal(justOverThresholdWalk.status, 'ready')
  assert.equal(
    justOverThresholdWalk.travelMode,
    'walk',
    'A graph-verified direct walk within maxWalkKm must remain available when transit is blocked.',
  )
  assert.equal(justOverThresholdWalk.legs.length, 1)
  assert.equal(justOverThresholdWalk.legs[0].walkSource, 'osm')
  assert.equal(justOverThresholdWalk.diagnostics.algorithm, 'osm_direct_walk_no_transit_fallback')
  assert.equal(
    justOverThresholdWalk.diagnostics.optimality,
    'graph_verified_direct_walk_when_no_supported_transit_path',
  )
  assert.equal(justOverThresholdWalk.diagnostics.transitFailureCode, 'access_unreachable')

  const justOverThresholdWalkArriveBy = routeNationalGtfsStore(storePath, {
    ...shortWalkRequest,
    origin: { coordinate: [0, 0.01], label: 'Two minute origin', source: 'map' },
    destination: { coordinate: [0.0016, 0.01], label: 'Two minute destination', source: 'map' },
    timePreference: 'arrive',
    arriveMinutes: 9 * 60,
  })
  assert.equal(justOverThresholdWalkArriveBy.status, 'ready')
  assert.equal(justOverThresholdWalkArriveBy.travelMode, 'walk')
  assert.equal(justOverThresholdWalkArriveBy.arriveMinutes, 9 * 60)
  assert.equal(
    justOverThresholdWalkArriveBy.diagnostics.algorithm,
    'osm_direct_walk_no_transit_fallback',
  )

  const justOverThresholdWalkWindow = routeNationalGtfsDepartureWindow(storePath, {
    ...shortWalkRequest,
    origin: { coordinate: [0, 0.03], label: 'Alternative walk origin', source: 'map' },
    destination: { coordinate: [0.00225, 0.03], label: 'Alternative walk destination', source: 'map' },
    maxWalkKm: 0.2,
    maxStreetKm: 0.2,
    alternativeMaxWalkKm: 0.3,
    departureWindowMinutes: 1,
    departureWindowDirection: 'forward',
  })
  const directAlternative = justOverThresholdWalkWindow.choices.find((choice) => choice.travelMode === 'walk')
  assert(directAlternative, 'A graph-verified direct walk within the alternative budget must remain a full A-to-B choice.')
  assert.equal(directAlternative.choiceLabel, 'Walk only')
  assert.equal(directAlternative.legs.length, 1)
  assert.equal(directAlternative.legs[0].walkSource, 'osm')
  assert.equal(directAlternative.diagnostics.alternativeStrategy, 'long_walk_direct')
  assert.equal(justOverThresholdWalkWindow.profile.alternativeWalkSearches, 1)

  const shortWalkPairwiseMatrix = matrixItineraryReference(storePath, {
    requireTransitRide: false,
    origins: [shortWalkRequest.origin],
    destinations: [shortWalkRequest.destination],
    departMinutes: shortWalkRequest.departMinutes,
    serviceDay: shortWalkRequest.serviceDay,
    serviceDate: shortWalkRequest.serviceDate,
    maxWalkKm: shortWalkRequest.maxWalkKm,
    streetStorePath: directWalkStreetPath,
    matrixStrategy: 'pairwise',
  })
  assert.equal(shortWalkPairwiseMatrix.rows[0].status, 'ready',
    'Coordinate transit Matrix must retain the same direct-walk alternative as Route.')
  assert.equal(shortWalkPairwiseMatrix.rows[0].durationMinutes, shortWalkPlan.durationMinutes)

  await fs.copyFile(storePath, cacheTruthStorePath)
  const cacheTruthStore = new DatabaseSync(cacheTruthStorePath)
  cacheTruthStore.prepare('UPDATE connections SET departure=?, arrival=? WHERE trip_id=?').run(11 * 3600 + 50 * 60, 12 * 3600, 't2')
  cacheTruthStore.close()
  await buildNationalStaticTopologySidecar({
    storePath: cacheTruthStorePath,
    outputPath: `${cacheTruthStorePath}.static-topology.sqlite`,
    minimumFreeBytes: 128 * 1024 * 1024,
  })
  const cacheTruthRequest = {
    origin: { coordinate: [8.0000, 47.0000], label: 'Long horizon origin', source: 'map' },
    destination: { coordinate: [8.0200, 47.0200], label: 'Long horizon destination', source: 'map' },
    departMinutes: 8 * 60,
    serviceDay: 'sunday',
    serviceDate: '2026-07-12',
    maxWalkKm: 0.25,
  }
  const longHorizonPlan = routeNationalGtfsStore(cacheTruthStorePath, {
    ...cacheTruthRequest,
    horizonMinutes: 480,
  })
  assert.equal(longHorizonPlan.status, 'ready')
  const shortHorizonPlan = routeNationalGtfsStore(cacheTruthStorePath, {
    ...cacheTruthRequest,
    horizonMinutes: 180,
  })
  assert.equal(shortHorizonPlan.status, 'blocked', 'A cached long-horizon result must not leak into a shorter horizon request.')
  const relabeledPlan = routeNationalGtfsStore(cacheTruthStorePath, {
    ...cacheTruthRequest,
    horizonMinutes: 480,
    origin: { ...cacheTruthRequest.origin, label: 'Fresh origin label' },
  })
  assert.equal(relabeledPlan.origin.label, 'Fresh origin label')
  assert.equal(relabeledPlan.legs[0]?.fromName, 'Fresh origin label')

  await buildNationalGtfsStore({ zipPath, outputPath: cacheTruthStorePath })
  const rebuiltSamePathPlan = routeNationalGtfsStore(cacheTruthStorePath, { ...cacheTruthRequest, horizonMinutes: 480 })
  assert.equal(rebuiltSamePathPlan.status, 'ready')
  assert(
    rebuiltSamePathPlan.durationMinutes >= 30 && rebuiltSamePathPlan.durationMinutes <= 32,
    'Rebuilding a GTFS store at the same path must invalidate open database and route-result caches.',
  )
  assert.equal(rebuiltSamePathPlan.diagnostics.searchStats?.cacheHit, undefined)

  await fs.copyFile(storePath, transferShortcutStorePath)
  const transferShortcutStore = new DatabaseSync(transferShortcutStorePath)
  transferShortcutStore.prepare('INSERT OR REPLACE INTO transfers VALUES(?,?,?,?)').run('A', 'C', 0, 60)
  transferShortcutStore.prepare(`
    INSERT OR REPLACE INTO transfer_provenance(
      from_stop_id, to_stop_id, provenance, evidence_fingerprint, path_distance_m
    ) VALUES(?,?,'gtfs_transfer',NULL,NULL)
  `).run('A', 'C')
  transferShortcutStore.close()
  await buildNationalStaticTopologySidecar({
    storePath: transferShortcutStorePath,
    outputPath: `${transferShortcutStorePath}.static-topology.sqlite`,
    minimumFreeBytes: 128 * 1024 * 1024,
  })
  const transferShortcutPlan = routeNationalGtfsStore(transferShortcutStorePath, {
    origin: { coordinate: [8.0000, 47.0000], label: 'Alpha transfer shortcut', source: 'map' },
    destination: { coordinate: [8.0200, 47.0200], label: 'Charlie transfer shortcut', source: 'map' },
    departMinutes: 8 * 60,
    serviceDay: 'sunday',
    serviceDate: '2026-07-12',
    maxWalkKm: 0.25,
  })
  assert.equal(transferShortcutPlan.status, 'ready')
  assert.deepEqual(
    transferShortcutPlan.legs.filter((leg) => leg.type === 'ride').map((leg) => leg.routeShortName),
    ['1', '2'],
    'A transfer-only shortcut must not dominate a later ride-bearing transit path.',
  )
  const preboardingShortcutStore = new DatabaseSync(transferShortcutStorePath)
  preboardingShortcutStore.prepare('INSERT OR REPLACE INTO transfers VALUES(?,?,?,?)').run('A', 'B', 0, 60)
  preboardingShortcutStore.prepare(`
    INSERT OR REPLACE INTO transfer_provenance(
      from_stop_id, to_stop_id, provenance, evidence_fingerprint, path_distance_m
    ) VALUES(?,?,'gtfs_transfer',NULL,NULL)
  `).run('A', 'B')
  preboardingShortcutStore.close()
  await buildNationalStaticTopologySidecar({
    storePath: transferShortcutStorePath,
    outputPath: `${transferShortcutStorePath}.static-topology.sqlite`,
    minimumFreeBytes: 128 * 1024 * 1024,
  })
  const streetGuardedPreboardingPlan = routeNationalGtfsStore(transferShortcutStorePath, {
    origin: {
      coordinate: [8.0000, 47.0000],
      label: 'Street-backed origin with stale stop',
      source: 'map',
      stopId: 'C',
    },
    destination: { coordinate: [8.0200, 47.0200], label: 'Street-backed destination', source: 'map' },
    departMinutes: 8 * 60,
    serviceDay: 'sunday',
    serviceDate: '2026-07-12',
    maxWalkKm: 0.25,
    streetStorePath: directWalkStreetPath,
  })
  assert.deepEqual(
    streetGuardedPreboardingPlan.legs.filter((leg) => leg.type === 'ride').map((leg) => leg.routeShortName),
    ['1', '2'],
    'A map point with a street access model must walk to its boarding stop instead of chaining GTFS transfers before the first ride.',
  )
  const firstStreetGuardedRide = streetGuardedPreboardingPlan.legs.findIndex((leg) => leg.type === 'ride')
  assert(!streetGuardedPreboardingPlan.legs.slice(0, firstStreetGuardedRide).some((leg) => leg.walkSource === 'transfer'))

  const earlyShortcutStore = new DatabaseSync(transferShortcutStorePath)
  earlyShortcutStore.prepare('INSERT INTO routes VALUES(?,?,?,?,?)').run('R-EARLY', 'EARLY', 'Early transfer trap', 3, 'cc00cc')
  earlyShortcutStore.prepare('INSERT INTO trips VALUES(?,?,?,?)').run('early-transfer-trap', 'R-EARLY', 'S', '0')
  earlyShortcutStore.prepare('INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?)')
    .run(8 * 3600 + 5 * 60, 8 * 3600 + 10 * 60, 'early-transfer-trap', 'R-EARLY', 'S', '0', 'B', 'C', 1)
  earlyShortcutStore.close()
  await buildNationalStaticTopologySidecar({
    storePath: transferShortcutStorePath,
    outputPath: `${transferShortcutStorePath}.static-topology.sqlite`,
    minimumFreeBytes: 128 * 1024 * 1024,
  })
  const transferShortcutMatrix = routeNationalGtfsMatrix(transferShortcutStorePath, {
    origins: [{
      coordinate: [8.0000, 47.0000],
      label: 'Alpha matrix shortcut with stale stop',
      source: 'map',
      stopId: 'C',
    }],
    destinations: Array.from({ length: 16 }, (_value, index) => ({
      coordinate: [8.0200 + index * 0.000001, 47.0200],
      label: `Charlie matrix shortcut ${index}`,
      source: 'map',
    })),
    departMinutes: 8 * 60,
    serviceDay: 'sunday',
    serviceDate: '2026-07-12',
    maxWalkKm: 0.25,
    streetStorePath: directWalkStreetPath,
    matrixStrategy: 'shared',
  })
  assert.equal(transferShortcutMatrix.rows[0].status, 'ready')
  assert(
    transferShortcutMatrix.rows[0].arriveMinutes >= plan.arriveMinutes,
    'Shared matrix arrival must be backed by a scheduled ride, not the earlier transfer-only shortcut.',
  )

  await fs.copyFile(transferShortcutStorePath, transferOnlyStorePath)
  const transferOnlyStore = new DatabaseSync(transferOnlyStorePath)
  transferOnlyStore.exec('DELETE FROM connections; DELETE FROM trips;')
  transferOnlyStore.close()
  await buildNationalStaticTopologySidecar({
    storePath: transferOnlyStorePath,
    outputPath: `${transferOnlyStorePath}.static-topology.sqlite`,
    minimumFreeBytes: 128 * 1024 * 1024,
  })
  const transferOnlyPlan = routeNationalGtfsStore(transferOnlyStorePath, {
    origin: { coordinate: [8.0000, 47.0000], label: 'Alpha transfer only', source: 'map' },
    destination: { coordinate: [8.0200, 47.0200], label: 'Charlie transfer only', source: 'map' },
    departMinutes: 8 * 60,
    serviceDay: 'sunday',
    serviceDate: '2026-07-12',
    maxWalkKm: 0.25,
  })
  assert.equal(transferOnlyPlan.status, 'blocked', 'Transfer/access walking alone is not a transit itinerary.')
  const transferOnlyMatrix = routeNationalGtfsMatrix(transferOnlyStorePath, {
    origins: [{ coordinate: [8.0000, 47.0000], label: 'Alpha transfer-only matrix', source: 'map' }],
    destinations: [{ coordinate: [8.0200, 47.0200], label: 'Charlie transfer-only matrix', source: 'map' }],
    departMinutes: 8 * 60,
    serviceDay: 'sunday',
    serviceDate: '2026-07-12',
    maxWalkKm: 0.25,
    matrixStrategy: 'shared',
  })
  assert.equal(transferOnlyMatrix.rows[0].status, 'blocked', 'Shared matrix must reject transfer/access-only reachability.')

  await fs.copyFile(storePath, legacyAccessStorePath)
  const legacyAccessStore = new DatabaseSync(legacyAccessStorePath)
  legacyAccessStore.exec('DROP TABLE stop_modes;')
  legacyAccessStore.prepare('INSERT INTO stops VALUES(?,?,?,?,?,?,?)').run('A_PARENT', 'Alpha station', 47, 8, null, 1, null)
  legacyAccessStore.prepare('UPDATE stops SET parent_station=? WHERE stop_id=?').run('A_PARENT', 'A')
  const insertLegacyLocalStop = legacyAccessStore.prepare('INSERT INTO stops VALUES(?,?,?,?,?,?,?)')
  for (let index = 0; index < 12; index += 1) {
    insertLegacyLocalStop.run(`L${index}`, `Local ${index}`, 46.9992 + index * 0.00002, 8, null, 0, null)
  }
  legacyAccessStore.close()
  assert.throws(
    () => routeNationalGtfsStore(legacyAccessStorePath, {
      origin: { coordinate: [8.0000, 46.9992], label: 'Ordinary map click', source: 'map' },
      destination: { coordinate: [8.0200, 47.0200], label: 'Charlie destination', source: 'map' },
      departMinutes: 8 * 60,
      serviceDay: 'sunday',
      serviceDate: '2026-07-12',
      maxWalkKm: 0.25,
    }),
    (error) => error?.code === 'VIGO_ROUTING_STORE_ADMISSION_FAILED'
      && error?.reason === 'required_table_missing',
    'Stale v1 stores without the current stop_modes schema must be rebuilt, not silently routed through a compatibility path.',
  )

  await fs.copyFile(storePath, parentModeAccessStorePath)
  const parentModeAccessStore = new DatabaseSync(parentModeAccessStorePath)
  parentModeAccessStore.prepare('INSERT INTO stops VALUES(?,?,?,?,?,?,?)').run('A_PARENT', 'Alpha station', 47, 8, null, 1, null)
  parentModeAccessStore.prepare('UPDATE stops SET parent_station=? WHERE stop_id=?').run('A_PARENT', 'A')
  parentModeAccessStore.prepare('UPDATE stops SET lon=? WHERE stop_id=?').run(8.002, 'A')
  parentModeAccessStore.prepare('INSERT INTO stops VALUES(?,?,?,?,?,?,?)').run('A_ENTRANCE', 'Alpha public entrance', 47, 8, 'A_PARENT', 2, null)
  parentModeAccessStore.prepare('INSERT INTO stops VALUES(?,?,?,?,?,?,?)').run('C_PARENT', 'Charlie station', 47.02, 8.02, null, 1, null)
  parentModeAccessStore.prepare('UPDATE stops SET parent_station=? WHERE stop_id=?').run('C_PARENT', 'C')
  const insertParentModeLocalStop = parentModeAccessStore.prepare('INSERT INTO stops VALUES(?,?,?,?,?,?,?)')
  for (let index = 0; index < 12; index += 1) {
    insertParentModeLocalStop.run(`M${index}`, `Mode local ${index}`, 46.9992 + index * 0.00002, 8, null, 0, null)
  }
  insertParentModeLocalStop.run('T_PARENT', 'Busy tram parent', 46.9992, 8.0001, null, 1, null)
  insertParentModeLocalStop.run('T_PLATFORM', 'Busy tram platform', 46.9992, 8.0001, 'T_PARENT', 0, null)
  insertParentModeLocalStop.run('T_END', 'Busy tram terminus', 46.98, 7.98, null, 0, null)
  parentModeAccessStore.prepare('INSERT INTO routes VALUES(?,?,?,?,?)').run('TR', 'T', 'Busy tram', 0, 'cc6600')
  const insertTramTrip = parentModeAccessStore.prepare('INSERT INTO trips VALUES(?,?,?,?)')
  const insertTramConnection = parentModeAccessStore.prepare('INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?)')
  for (let index = 0; index < 12; index += 1) {
    const tripId = `tram-${index}`
    const departure = 9 * 3600 + index * 60
    insertTramTrip.run(tripId, 'TR', 'S', '0')
    insertTramConnection.run(departure, departure + 5 * 60, tripId, 'TR', 'S', '0', 'T_PLATFORM', 'T_END', 1)
  }
  parentModeAccessStore.prepare('UPDATE connections SET departure=? WHERE trip_id=?').run(8 * 3600 + 4 * 60, 't1')
  parentModeAccessStore.close()
  await rebuildFixtureRoutingDerivedArtifacts(parentModeAccessStorePath)
  const parentModeAccessStreet = new DatabaseSync(parentModeAccessStreetPath)
  parentModeAccessStreet.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE walk_nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE edges(from_node INTEGER NOT NULL, to_node INTEGER NOT NULL, distance_m REAL NOT NULL, way_id INTEGER NOT NULL);
    CREATE INDEX walk_nodes_lat_lon ON walk_nodes(lat,lon);
    CREATE INDEX edges_from ON edges(from_node);
    CREATE INDEX edges_to ON edges(to_node);
    INSERT INTO metadata VALUES('schemaVersion', '"vigo.street.store.v4"');
    INSERT INTO metadata VALUES('sourceModel', '"pbf"');
    INSERT INTO walk_nodes VALUES(1, 46.9992, 8), (2, 47, 8), (3, 47.02, 8.02);
    INSERT INTO edges VALUES(1, 2, 100, 1), (2, 1, 100, 1);
  `)
  finalizeCurrentStreetFixture(parentModeAccessStreet)
  parentModeAccessStreet.close()
  prepareRustFixtureStreetStore(parentModeAccessStreetPath)
  const parentModeAccessPlan = routeNationalGtfsStore(parentModeAccessStorePath, {
    origin: { coordinate: [8.0000, 46.9992], label: 'Parent station map click', source: 'map' },
    destination: { coordinate: [8.0200, 47.0200], label: 'Charlie destination', source: 'map' },
    departMinutes: 8 * 60,
    serviceDay: 'sunday',
    serviceDate: '2026-07-12',
    maxWalkKm: 0.3,
    streetStorePath: parentModeAccessStreetPath,
  })
  assert(parentModeAccessPlan.legs[0].distanceKm > 0.25,
    'Station access must include the street-to-platform distance, not a free parent alias.')
  for (const timePreference of ['depart', 'arrive']) {
    const detailed = routeNationalGtfsMatrix(parentModeAccessStorePath, {
      origins: [parentModeAccessPlan.origin], destinations: [parentModeAccessPlan.destination],
      timePreference, departMinutes: 480, arriveMinutes: 525,
      serviceDay: 'sunday', serviceDate: '2026-07-12',
      maxWalkKm: 0.3, streetStorePath: parentModeAccessStreetPath,
      includeJourneys: true, includeGeometry: true,
    })
    assert.equal(detailed.rows[0].journey.status, 'ready')
    assert(detailed.rows[0].journey.legs.every((leg) => Array.isArray(leg.coordinates)),
      'Matrix geometry must retain both directed endpoint witnesses across coordinate queries.')
  }
  assert.equal(routeNationalGtfsStore(parentModeAccessStorePath, {
    origin: parentModeAccessPlan.origin, destination: parentModeAccessPlan.destination,
    departMinutes: 480, serviceDay: 'sunday', serviceDate: '2026-07-12',
    maxWalkKm: 0.25, streetStorePath: parentModeAccessStreetPath,
  }).status, 'blocked', 'The complete platform access exceeds a 250 m walking budget.')
  assert.equal(parentModeAccessPlan.status, 'ready', 'Heavy-rail platform service must promote its public entrance even when a busier tram stop is nearby.')
  const parentCandidates = inspectNationalGtfsAccessCandidates(parentModeAccessStorePath, parentModeAccessPlan.origin, {
    streetStorePath: parentModeAccessStreetPath, maxWalkKm: 0.3, accessRole: 'origin',
  }).candidates
  assert(['A', 'T_PLATFORM'].every(id => parentCandidates.some(candidate => candidate.stopId === id)),
    'The complete access frontier must retain both reachable services.')
  assert.equal(parentModeAccessPlan.legs.find((leg) => leg.type === 'ride')?.fromStopId, 'A')
  assert.equal(parentModeAccessPlan.legs.find((leg) => leg.type === 'ride')?.startMinutes, 8 * 60 + 4)
  assert.equal(parentModeAccessPlan.diagnostics.originStreetPathVerified, false,
    'An entrance record without a declared interior path cannot certify the street-to-platform walk.')
  assert.equal(parentModeAccessPlan.legs[0].stationAccessStatus, 'unverified')
  assert.equal(parentModeAccessPlan.legs[0].streetSegmentVerified, true,
    'The narrower native street witness remains available.')
  assert.equal(parentModeAccessPlan.snappedOrigin?.lon, 8.002, 'The exact search must board the platform reached through its parent entrance, not bind A to the street-side entrance record.')
  assert.equal(
    parentModeAccessPlan.legs.filter((leg) => leg.type === 'ride').at(-1)?.toStopId,
    'C',
    'Map egress at a terminal station must retain the platform that has arrivals but no departures.',
  )

  const tokenOwnershipRequest = {
    origin: { coordinate: [8.0000, 46.9992], label: 'Token ownership origin', source: 'map' },
    destination: { coordinate: [8.0200, 47.0200], label: 'Charlie platform', source: 'stop', stopId: 'C' },
    departMinutes: 8 * 60,
    serviceDay: 'sunday',
    serviceDate: '2026-07-12',
    maxWalkKm: 0.3,
    streetStorePath: parentModeAccessStreetPath,
  }
  assert.equal(routeNationalGtfsStore(parentModeAccessStorePath, tokenOwnershipRequest).status, 'ready')
  const offStreetTransitPlan = routeNationalGtfsStore(parentModeAccessStorePath, {
    ...tokenOwnershipRequest,
    origin: { coordinate: [8.0001, 46.9992], label: 'Intervening coordinate query', source: 'map' },
  })
  assert.equal(offStreetTransitPlan.status, 'ready')
  assert.notDeepEqual(
    offStreetTransitPlan.legs[0]?.coordinates?.[0],
    offStreetTransitPlan.origin.coordinate,
    'Transit access geometry must begin on the verified OSM path, not draw a straight jump from an off-street map click.',
  )
  const refreshedTokenPlan = routeNationalGtfsStore(parentModeAccessStorePath, tokenOwnershipRequest)
  assert.equal(
    refreshedTokenPlan.status,
    'ready',
    'A repeated map-to-stop request must obtain a fresh Rust predecessor token after another coordinate query.',
  )
  assert(
    refreshedTokenPlan.legs[0]?.coordinates?.length >= 2,
    'Fresh endpoint-token materialization must retain the routed access geometry.',
  )

  const terminalDestinationAccess = inspectNationalGtfsAccessCandidates(
    parentModeAccessStorePath,
    { coordinate: [8.02, 47.02], label: 'Charlie terminal', source: 'map' },
    { streetStorePath: parentModeAccessStreetPath, maxWalkKm: 0.3, accessRole: 'destination' },
  )
  const terminalOriginAccess = inspectNationalGtfsAccessCandidates(
    parentModeAccessStorePath,
    { coordinate: [8.02, 47.02], label: 'Charlie terminal', source: 'map' },
    { streetStorePath: parentModeAccessStreetPath, maxWalkKm: 0.3, accessRole: 'origin' },
  )
  assert(
    terminalDestinationAccess.candidates.some((candidate) => candidate.stopId === 'C'),
    'Destination station expansion must admit an arrival-only terminal platform.',
  )
  assert(
    !terminalOriginAccess.candidates.some((candidate) => candidate.stopId === 'C'),
    'Origin station expansion must not present an arrival-only platform as a boardable stop.',
  )

  const staleMapStopIdPlan = routeNationalGtfsStore(parentModeAccessStorePath, {
    origin: { coordinate: [8.0000, 46.9992], label: 'Map point with stale stop id', source: 'map', stopId: 'T_PLATFORM' },
    destination: { coordinate: [8.0200, 47.0200], label: 'Charlie destination', source: 'map' },
    departMinutes: 8 * 60,
    serviceDay: 'sunday',
    serviceDate: '2026-07-12',
    maxWalkKm: 0.3,
    streetStorePath: parentModeAccessStreetPath,
  })
  assert.equal(staleMapStopIdPlan.status, 'ready', 'A legacy map payload must not be forced onto its stale stopId.')
  assert.equal(staleMapStopIdPlan.legs.find((leg) => leg.type === 'ride')?.fromStopId, 'A')

  const gapZip = new JSZip()
  gapZip.file('stops.txt', [
    'stop_id,stop_name,stop_lat,stop_lon,location_type',
    'G0,Gap origin,47.1000,8.1000,0',
    'G1,Untimed intermediate,47.1050,8.1050,0',
    'G2,Gap bridge,47.1100,8.1100,0',
    'G3,Gap destination,47.1150,8.1150,0',
  ].join('\n'))
  gapZip.file('routes.txt', 'route_id,route_short_name,route_long_name,route_type,route_color\nGR,G,Gap route,2,663399\n')
  gapZip.file('trips.txt', 'route_id,service_id,trip_id,direction_id\nGR,GS,gt,0\n')
  gapZip.file('stop_times.txt', [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    'gt,08:00:00,08:00:00,G0,1',
    'gt,,,G1,2',
    'gt,08:20:00,08:20:00,G2,3',
    'gt,08:30:00,08:30:00,G3,4',
  ].join('\n'))
  gapZip.file('calendar.txt', 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nGS,1,1,1,1,1,1,1,20260101,20261231\n')
  await fs.writeFile(gapZipPath, await gapZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  const gapBuild = await buildNationalGtfsStore({ zipPath: gapZipPath, outputPath: gapStorePath })
  assert.equal(gapBuild.connectionCount, 2, 'Untimed intermediate stops must bridge adjacent timed anchors without disconnecting the trip.')
  const gapPlan = routeNationalGtfsStore(gapStorePath, {
    origin: { coordinate: [8.1000, 47.1000], label: 'Gap map origin', source: 'map' },
    destination: { coordinate: [8.1150, 47.1150], label: 'Gap map destination', source: 'map' },
    departMinutes: 7 * 60 + 58,
    serviceDay: 'monday',
    serviceDate: '2026-07-13',
    maxWalkKm: 0.2,
  })
  assert.equal(gapPlan.status, 'ready')
  assert.equal(gapPlan.legs.filter((leg) => leg.type === 'ride').length, 1)
  assert.deepEqual(gapPlan.legs.find((leg) => leg.type === 'ride')?.coordinates, [
    [8.1, 47.1],
    [8.11, 47.11],
    [8.115, 47.115],
  ])

  await fs.copyFile(gapStorePath, legacyGapStorePath)
  const legacyGapStore = new DatabaseSync(legacyGapStorePath)
  legacyGapStore.exec('DELETE FROM connections;')
  const insertLegacyGapConnection = legacyGapStore.prepare('INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?)')
  insertLegacyGapConnection.run(8 * 3600, 8 * 3600 + 10 * 60, 'gt', 'GR', 'GS', '0', 'G0', 'G1', 1)
  insertLegacyGapConnection.run(8 * 3600 + 20 * 60, 8 * 3600 + 30 * 60, 'gt', 'GR', 'GS', '0', 'G2', 'G3', 4)
  legacyGapStore.close()
  await rebuildFixtureRoutingDerivedArtifacts(legacyGapStorePath)
  const legacyGapPlan = routeNationalGtfsStore(legacyGapStorePath, {
    origin: { coordinate: [8.1000, 47.1000], label: 'Legacy gap origin', source: 'map' },
    destination: { coordinate: [8.1150, 47.1150], label: 'Legacy gap destination', source: 'map' },
    departMinutes: 7 * 60 + 58,
    serviceDay: 'monday',
    serviceDate: '2026-07-13',
    maxWalkKm: 0.2,
  })
  assert.equal(legacyGapPlan.status, 'ready', 'A monotone same-trip legacy gap must bridge its surrounding timed segments.')
  assert.equal(legacyGapPlan.diagnostics.bridgedUntimedGapCount, 1)
  assert.equal(legacyGapPlan.scheduleMode, 'interpolated-stop-time-gap')
  assert.equal(legacyGapPlan.diagnostics.scheduleMode, 'interpolated-stop-time-gap')
  assert.equal(legacyGapPlan.diagnostics.timingPrecision, 'degraded')
  assert.match(legacyGapPlan.diagnostics.optimality, /interpolated_stop_time_gap/)
  assert.match(legacyGapPlan.detail, /interpolated stop-time gap.*degraded timing precision/)
  assert.doesNotMatch(legacyGapPlan.detail, /exact local timetable/)
  assert.deepEqual(legacyGapPlan.legs.find((leg) => leg.type === 'ride')?.coordinates, [
    [8.1, 47.1],
    [8.105, 47.105],
    [8.11, 47.11],
    [8.115, 47.115],
  ])

  await fs.copyFile(gapStorePath, sectionGapStorePath)
  const sectionGapStore = new DatabaseSync(sectionGapStorePath)
  sectionGapStore.exec('DELETE FROM connections; DELETE FROM trips;')
  sectionGapStore.prepare('INSERT INTO routes VALUES(?,?,?,?,?)').run('UR', 'U', 'Gap connector', 2, '336699')
  sectionGapStore.prepare('INSERT INTO trips VALUES(?,?,?,?)').run('gt', 'GR', 'GS', '0')
  sectionGapStore.prepare('INSERT INTO trips VALUES(?,?,?,?)').run('ut', 'UR', 'GS', '0')
  const insertSectionGapConnection = sectionGapStore.prepare('INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?)')
  insertSectionGapConnection.run(8 * 3600, 8 * 3600 + 10 * 60, 'gt', 'GR', 'GS', '0', 'G0', 'G1', 1)
  insertSectionGapConnection.run(8 * 3600 + 20 * 60, 8 * 3600 + 30 * 60, 'gt', 'GR', 'GS', '0', 'G2', 'G3', 2)
  insertSectionGapConnection.run(8 * 3600 + 5 * 60, 8 * 3600 + 15 * 60, 'ut', 'UR', 'GS', '0', 'G0', 'G2', 1)
  sectionGapStore.close()
  await rebuildFixtureRoutingDerivedArtifacts(sectionGapStorePath)
  const sectionGapRequest = {
    origin: { coordinate: [8.1000, 47.1000], label: 'Section gap origin', source: 'map' },
    destination: { coordinate: [8.1150, 47.1150], label: 'Section gap destination', source: 'map' },
    departMinutes: 7 * 60 + 58,
    serviceDay: 'monday',
    serviceDate: '2026-07-13',
    maxWalkKm: 0.2,
  }
  const sectionGapPlan = routeNationalGtfsStore(sectionGapStorePath, sectionGapRequest)
  assert.equal(sectionGapPlan.status, 'ready', 'A later boardable section of a disconnected trip must remain available after another trip reaches it.')
  assert.deepEqual(sectionGapPlan.legs.filter((leg) => leg.type === 'ride').map((leg) => leg.tripId), ['ut', 'gt'])
  const sectionGapMatrix = routeNationalGtfsMatrix(sectionGapStorePath, {
    origins: [sectionGapRequest.origin],
    destinations: [sectionGapRequest.destination],
    departMinutes: sectionGapRequest.departMinutes,
    serviceDay: sectionGapRequest.serviceDay,
    serviceDate: sectionGapRequest.serviceDate,
    maxWalkKm: sectionGapRequest.maxWalkKm,
    matrixStrategy: 'shared',
  })
  assert.equal(sectionGapMatrix.rows[0].status, 'ready', 'Shared matrix search must also board a later safe section after an unsafe continuity break.')

  const arriveByPlan = routeNationalGtfsStore(storePath, {
    origin: { coordinate: [8.0000, 47.0000], label: 'Alpha origin', source: 'map' },
    destination: { coordinate: [8.0200, 47.0200], label: 'Charlie destination', source: 'map' },
    arriveMinutes: 8 * 60 + 31,
    timePreference: 'arrive',
    serviceDay: 'sunday',
    serviceDate: '2026-07-12',
    maxWalkKm: 0.25,
  })
  assert.equal(arriveByPlan.status, 'ready')
  assert.equal(arriveByPlan.timePreference, 'arrive')
  assert.equal(arriveByPlan.departMinutes, 8 * 60 + 5)
  assert.equal(arriveByPlan.arriveMinutes, 8 * 60 + 30)
  assert.equal(arriveByPlan.diagnostics.algorithm, 'rust_exact_arrive_by_reverse_scan')

  const departureWindow = routeNationalGtfsDepartureWindow(storePath, {
    origin: { coordinate: [8.0000, 47.0000], label: 'Alpha origin', source: 'map' },
    destination: { coordinate: [8.0200, 47.0200], label: 'Charlie destination', source: 'map' },
    departMinutes: 8 * 60,
    departureWindowMinutes: 10,
    serviceDay: 'sunday',
    serviceDate: '2026-07-12',
    maxWalkKm: 0.25,
  })
  assert.equal(departureWindow.profile.sampleCount, 21)
  assert.equal(departureWindow.profile.plans.length, 21)
  assert(departureWindow.profile.routeSearches < departureWindow.profile.sampleCount)
  assert(departureWindow.choices.some((choice) => choice.departMinutes === 8 * 60))

  assert.throws(
    () => routeNationalGtfsStore(storePath, {
      origin: { coordinate: [8.0000, 47.0000], label: 'Fractional origin', source: 'map' },
      destination: { coordinate: [8.0200, 47.0200], label: 'Fractional destination', source: 'map' },
      departMinutes: 8 * 60 + 0.5,
      serviceDay: 'sunday',
      serviceDate: '2026-07-12',
      maxWalkKm: 0.25,
    }),
    /integral minute/,
    'Direct GTFS routing must reject fractional departure minutes.',
  )
  assert.throws(
    () => routeNationalGtfsDepartureWindow(storePath, {
      origin: { coordinate: [8.0000, 47.0000], label: 'Fractional window origin', source: 'map' },
      destination: { coordinate: [8.0200, 47.0200], label: 'Fractional window destination', source: 'map' },
      departMinutes: 8 * 60,
      departureWindowMinutes: 1.5,
      serviceDay: 'sunday',
      serviceDate: '2026-07-12',
      maxWalkKm: 0.25,
    }),
    /integral minute/,
    'Departure-window routing must reject fractional window sizes.',
  )

  const forwardDepartureWindow = routeNationalGtfsDepartureWindow(storePath, {
    origin: { coordinate: [8.0000, 47.0000], label: 'Alpha origin', source: 'map' },
    destination: { coordinate: [8.0200, 47.0200], label: 'Charlie destination', source: 'map' },
    departMinutes: 8 * 60,
    departureWindowMinutes: 20,
    departureWindowDirection: 'forward',
    serviceDay: 'sunday',
    serviceDate: '2026-07-12',
    maxWalkKm: 0.25,
  })
  assert.equal(forwardDepartureWindow.profile.sampleCount, 21)
  assert.equal(forwardDepartureWindow.profile.beforeMinutes, 0)
  assert.equal(forwardDepartureWindow.profile.afterMinutes, 20)
  assert(forwardDepartureWindow.profile.plans.every((plan) => plan.departMinutes >= 8 * 60))

  const alpha = { coordinate: [8.0000, 47.0000], label: 'Alpha origin', source: 'map' }
  const bravo = { coordinate: [8.0100, 47.0100], label: 'Bravo', source: 'map' }
  const charlie = { coordinate: [8.0200, 47.0200], label: 'Charlie', source: 'map' }
  assert.throws(
    () => routeNationalGtfsMatrix(storePath, {
      origins: [alpha],
      destinations: [bravo],
      departMinutes: 8 * 60 + 0.5,
      serviceDay: 'sunday',
      serviceDate: '2026-07-12',
      maxWalkKm: 0.25,
      matrixStrategy: 'shared',
    }),
    /integral minute/,
    'Matrix routing must reject fractional departure minutes.',
  )
  const matrixKernelContext = prepareNationalGtfsRoutingContext(storePath, {
    serviceDate: '2026-07-12',
    serviceDay: 'sunday',
  })
  assert.equal(matrixKernelContext.activeServiceKernel.ready, true)
  const matrix = routeNationalGtfsMatrix(storePath, {
    origins: [alpha, alpha, bravo],
    destinations: [bravo, charlie, charlie],
    departMinutes: 8 * 60,
    serviceDay: 'sunday',
    serviceDate: '2026-07-12',
    maxWalkKm: 0.25,
    matrixStrategy: 'shared',
  })
  assert.equal(matrix.rows.length, 9)
  assert.equal(matrix.diagnostics.uniqueOrigins, 2)
  assert.equal(matrix.diagnostics.uniqueDestinations, 2)
  assert.equal(matrix.diagnostics.forwardSearches, 2)
  const alphaCharlie = matrix.rows.find((row) => row.originIndex === 0 && row.destinationIndex === 1)
  assert.equal(alphaCharlie.status, plan.status)
  assert.equal(alphaCharlie.durationMinutes, plan.durationMinutes)
  assert.equal(alphaCharlie.arriveMinutes, plan.arriveMinutes)

  const oneToMany = routeNationalGtfsMatrix(storePath, {
    origins: [alpha], destinations: [bravo, charlie], departMinutes: 8 * 60,
    serviceDay: 'sunday', serviceDate: '2026-07-12', maxWalkKm: 0.25, matrixStrategy: 'shared',
  })
  assert.equal(oneToMany.diagnostics.forwardSearches, 1)
  assert.equal(oneToMany.rows.length, 2)
  assert.equal(oneToMany.diagnostics.matrixEngine, 'rust_exact_connection_scan_one_to_many')

  const largeOneToMany = routeNationalGtfsMatrix(storePath, {
    origins: [alpha], destinations: Array.from({ length: 100_000 }, (_, i) => i % 2 ? charlie : bravo),
    departMinutes: 480, serviceDay: 'sunday', serviceDate: '2026-07-12', maxWalkKm: 0.25,
  })
  assert.equal(largeOneToMany.rows.length, 100_000)
  assert.equal(largeOneToMany.diagnostics.forwardSearches, 1,
    'Large destination sets must share one timetable scan, without 256-target splitting.')
  for (const [index, row] of largeOneToMany.rows.entries()) {
    assert.deepEqual(row, { ...oneToMany.rows[index % 2], destinationIndex: index })
  }
  assert.throws(() => routeNationalGtfsMatrix(storePath, {
    origins: [alpha, bravo], destinations: Array(50_001).fill(charlie),
  }), /100,000 OD pairs/)

  const arriveMatrixRequest = { origins: [alpha, bravo], destinations: [bravo, charlie],
    timePreference: 'arrive', arriveMinutes: 525, serviceDay: 'sunday', serviceDate: '2026-07-12',
    maxWalkKm: 0.25, horizonMinutes: 180 }
  const arriveMatrix = routeNationalGtfsMatrix(storePath, arriveMatrixRequest)
  assert.equal(arriveMatrix.diagnostics.reverseSearches, 2)
  assert.equal(arriveMatrix.diagnostics.forwardSearches, 0)
  for (const timePreference of ['depart', 'arrive']) for (const includeGeometry of [false, true]) {
    const detailed = routeNationalGtfsMatrix(storePath, { ...arriveMatrixRequest, timePreference,
      departMinutes: 480, maxTransfers: 3, includeJourneys: true, includeGeometry })
    for (const row of detailed.rows) {
      assert.equal(Boolean(row.journey), row.status === 'ready')
      if (!row.journey) continue
      assert(row.journey.transfers <= 3)
      assert(Math.abs(row.journey.durationMinutes - row.journey.walkMinutes
        - row.journey.rideMinutes - row.journey.waitMinutes) < 0.005)
      if (includeGeometry) assert(row.journey.legs.every((leg) => Array.isArray(leg.coordinates)))
      if (timePreference === 'arrive') assert(row.journey.arriveMinutes <= arriveMatrixRequest.arriveMinutes)
    }
  }
  for (const row of arriveMatrix.rows) {
    const point = routeNationalGtfsStore(storePath, { ...arriveMatrixRequest,
      origin: arriveMatrixRequest.origins[row.originIndex], destination: arriveMatrixRequest.destinations[row.destinationIndex],
      routingPreference: 'fastest' })
    assert.equal(row.status, point.status)
    assert.equal(row.departMinutes, point.status === 'ready' ? point.departMinutes : null)
    assert.equal(row.arriveMinutes, 525)
    assert.equal(row.durationMinutes, point.status === 'ready' ? 525 - point.departMinutes : null)
  }
  const largeArriveManyToOne = routeNationalGtfsMatrix(storePath, { ...arriveMatrixRequest,
    origins: Array.from({ length: 100_000 }, (_, i) => i % 2 ? bravo : alpha), destinations: [charlie] })
  assert.equal(largeArriveManyToOne.rows.length, 100_000)
  assert.equal(largeArriveManyToOne.diagnostics.reverseSearches, 1)
  for (const [i, row] of largeArriveManyToOne.rows.entries()) {
    assert.deepEqual(row, { ...arriveMatrix.rows[(i % 2) * 2 + 1], originIndex: i, destinationIndex: 0 })
  }
  const shortArriveMatrix = routeNationalGtfsMatrix(storePath, { ...arriveMatrixRequest,
    origins: [alpha], destinations: [charlie], horizonMinutes: 1 })
  assert.equal(shortArriveMatrix.rows[0].status, 'blocked', 'Arrive-by Matrix must honor the requested short horizon.')
  const shortArriveRoute = routeNationalGtfsStore(storePath, { ...arriveMatrixRequest,
    origin: alpha, destination: charlie, horizonMinutes: 1, maxTransfers: 3 })
  assert.equal(shortArriveRoute.status, 'blocked', 'Route must use the same short arrive-by horizon as Matrix.')
  assert.throws(() => routeNationalGtfsMatrix(storePath, { ...arriveMatrixRequest, arriveMinutes: 525.5 }), /integral minute/)

  const shortHorizonRequest = {
    origins: [alpha],
    destinations: [charlie],
    departMinutes: 8 * 60,
    serviceDay: 'sunday',
    serviceDate: '2026-07-12',
    maxWalkKm: 0.25,
    horizonMinutes: 10,
  }
  const shortHorizonShared = routeNationalGtfsMatrix(storePath, {
    ...shortHorizonRequest,
    matrixStrategy: 'shared',
  })
  const shortHorizonPairwise = matrixItineraryReference(storePath, {
    ...shortHorizonRequest,
    matrixStrategy: 'pairwise',
  })
  assert.deepEqual(
    shortHorizonShared.rows,
    shortHorizonPairwise.rows,
    'An explicit short matrix horizon must be honored identically by shared and pairwise routing.',
  )
  assert.equal(shortHorizonShared.rows[0].status, 'blocked')

  await fs.writeFile(matrixHorizonSchedulePath, JSON.stringify({
    stops: [
      { id: 'O', name: 'Horizon origin', lat: 47, lon: 8 },
      { id: 'X', name: 'In-horizon alighting', lat: 47, lon: 8.01 },
      { id: 'D', name: 'Post-horizon transfer destination', lat: 47, lon: 8.02 },
      { id: 'Z', name: 'Destination service witness', lat: 47, lon: 8.03 },
    ],
    transferRules: [{
      fromStopId: 'X', toStopId: 'D', transferType: 2, minTransferTimeSeconds: 120,
    }],
    routes: [{
      routeId: 'IN', shortName: 'IN', routeType: 3,
      scheduledTrips: [{
        tripId: 'in-horizon', serviceId: 'SUN', serviceDays: ['sunday'],
        stopTimes: [
          { stopId: 'O', sequence: 1, arrivalMinutes: 480, departureMinutes: 480 },
          { stopId: 'X', sequence: 2, arrivalMinutes: 489, departureMinutes: 489 },
        ],
      }],
    }, {
      routeId: 'RESIDENT', shortName: 'RESIDENT', routeType: 3,
      scheduledTrips: [{
        tripId: 'destination-resident', serviceId: 'SUN', serviceDays: ['sunday'],
        stopTimes: [
          { stopId: 'D', sequence: 1, arrivalMinutes: 600, departureMinutes: 600 },
          { stopId: 'Z', sequence: 2, arrivalMinutes: 610, departureMinutes: 610 },
        ],
      }],
    }],
  }))
  await buildRoutingStoreFromSchedules({
    schedules: [{ feedId: 'matrix-horizon', schedulePath: matrixHorizonSchedulePath }],
    outputPath: matrixHorizonStorePath,
  })
  const terminalEgressMatrixRequest = {
    origins: [{
      stopId: 'matrix-horizon\u001fO', coordinate: [8, 47], label: 'Horizon origin', source: 'stop',
    }],
    destinations: [{
      stopId: 'matrix-horizon\u001fD', coordinate: [8.02, 47], label: 'Transfer destination', source: 'stop',
    }],
    departMinutes: 480,
    horizonMinutes: 10,
    serviceDate: '2026-07-12',
    serviceDay: 'sunday',
    maxWalkKm: 0.2,
    // A matrix request always has the fastest scalar contract, even if a
    // point-only preference is accidentally supplied by the caller.
    routingPreference: 'balanced',
  }
  const terminalEgressShared = routeNationalGtfsMatrix(matrixHorizonStorePath, {
    ...terminalEgressMatrixRequest,
    matrixStrategy: 'shared',
  })
  const terminalEgressPairwise = matrixItineraryReference(matrixHorizonStorePath, {
    ...terminalEgressMatrixRequest,
    matrixStrategy: 'pairwise',
  })
  assert.deepEqual(
    terminalEgressShared.rows,
    terminalEgressPairwise.rows,
    'Shared and pairwise matrices must share scan-horizon semantics for terminal post-ride egress.',
  )
  assert.equal(terminalEgressShared.rows[0].status, 'ready')
  assert.equal(terminalEgressShared.rows[0].durationMinutes, 11)

  const unreachable = { coordinate: [-40, -40], label: 'Outside fixture coverage', source: 'map' }
  const unreachableRequest = {
    origins: [alpha],
    destinations: [charlie, unreachable],
    departMinutes: 8 * 60,
    serviceDay: 'sunday',
    serviceDate: '2026-07-12',
    maxWalkKm: 0.25,
  }
  const unreachableShared = routeNationalGtfsMatrix(storePath, {
    ...unreachableRequest,
    matrixStrategy: 'shared',
  })
  const unreachablePairwise = matrixItineraryReference(storePath, {
    ...unreachableRequest,
    matrixStrategy: 'pairwise',
  })
  assert.deepEqual(
    unreachableShared.rows,
    unreachablePairwise.rows,
    'Kernel one-to-many must preserve pairwise parity when a destination is outside the routable network.',
  )
  assert.equal(unreachableShared.rows[1].status, 'blocked')

  const matrixIdentitySchedulePath = path.join(folder, 'matrix-point-identity.json')
  const matrixIdentityStorePath = path.join(folder, 'matrix-point-identity.sqlite')
  await fs.writeFile(matrixIdentitySchedulePath, JSON.stringify({
    stops: [
      { id: 'O1', name: 'Co-located origin one', lat: 47, lon: 8 },
      { id: 'O2', name: 'Co-located origin two', lat: 47, lon: 8 },
      { id: 'U', name: 'Unserved co-located origin', lat: 47, lon: 8 },
      { id: 'D1', name: 'Co-located destination one', lat: 47, lon: 8.01 },
      { id: 'D2', name: 'Co-located destination two', lat: 47, lon: 8.01 },
    ],
    routes: [
      {
        id: 'FAST', shortName: 'FAST', routeType: 3,
        scheduledTrips: [{
          tripId: 'fast', serviceId: 'SUN', serviceDays: ['sunday'],
          stopTimes: [
            { stopId: 'O1', sequence: 1, arrivalMinutes: 480, departureMinutes: 480 },
            { stopId: 'D1', sequence: 2, arrivalMinutes: 490, departureMinutes: 490 },
          ],
        }],
      },
      {
        id: 'O1-D2', shortName: 'O1-D2', routeType: 3,
        scheduledTrips: [{
          tripId: 'o1-d2', serviceId: 'SUN', serviceDays: ['sunday'],
          stopTimes: [
            { stopId: 'O1', sequence: 1, arrivalMinutes: 480, departureMinutes: 480 },
            { stopId: 'D2', sequence: 2, arrivalMinutes: 500, departureMinutes: 500 },
          ],
        }],
      },
      {
        id: 'O2-D1', shortName: 'O2-D1', routeType: 3,
        scheduledTrips: [{
          tripId: 'o2-d1', serviceId: 'SUN', serviceDays: ['sunday'],
          stopTimes: [
            { stopId: 'O2', sequence: 1, arrivalMinutes: 480, departureMinutes: 480 },
            { stopId: 'D1', sequence: 2, arrivalMinutes: 510, departureMinutes: 510 },
          ],
        }],
      },
      {
        id: 'O2-D2', shortName: 'O2-D2', routeType: 3,
        scheduledTrips: [{
          tripId: 'o2-d2', serviceId: 'SUN', serviceDays: ['sunday'],
          stopTimes: [
            { stopId: 'O2', sequence: 1, arrivalMinutes: 480, departureMinutes: 480 },
            { stopId: 'D2', sequence: 2, arrivalMinutes: 520, departureMinutes: 520 },
          ],
        }],
      },
    ],
  }))
  await buildRoutingStoreFromSchedules({
    schedules: [{ feedId: 'matrix-id', schedulePath: matrixIdentitySchedulePath }],
    outputPath: matrixIdentityStorePath,
  })
  const matrixIdentityDestinations = [
    { stopId: 'matrix-id\u001fD1', coordinate: [8.01, 47], label: 'Destination one', source: 'stop' },
    { stopId: 'matrix-id\u001fD2', coordinate: [8.01, 47], label: 'Destination two', source: 'stop' },
  ]
  const matrixIdentity = matrixItineraryReference(matrixIdentityStorePath, {
    origins: [
      { stopId: 'matrix-id\u001fO1', coordinate: [8, 47], label: 'Origin one', source: 'stop' },
      { stopId: 'matrix-id\u001fO2', coordinate: [8, 47], label: 'Origin two', source: 'stop' },
    ],
    destinations: matrixIdentityDestinations,
    departMinutes: 480,
    serviceDate: '2026-07-12',
    serviceDay: 'sunday',
    maxWalkKm: 0.2,
    matrixStrategy: 'pairwise',
  })
  assert.equal(matrixIdentity.diagnostics.uniqueOrigins, 2)
  assert.equal(matrixIdentity.diagnostics.uniqueDestinations, 2)
  assert.deepEqual(matrixIdentity.rows.map((row) => row.durationMinutes), [10, 20, 30, 40],
    'Co-located explicit stops must remain distinct matrix origins and destinations.')

  const matrixIdentityContext = prepareNationalGtfsRoutingContext(matrixIdentityStorePath, {
    serviceDate: '2026-07-12',
    serviceDay: 'sunday',
  })
  assert.equal(matrixIdentityContext.activeServiceKernel.ready, true)
  const noKernelOrigin = routeNationalGtfsMatrix(matrixIdentityStorePath, {
    origins: [{ stopId: 'matrix-id\u001fU', coordinate: [8, 47], label: 'Unserved', source: 'stop' }],
    destinations: [matrixIdentityDestinations[0]],
    departMinutes: 480,
    serviceDate: '2026-07-12',
    serviceDay: 'sunday',
    maxWalkKm: 0.2,
    matrixStrategy: 'shared',
  })
  assert.equal(noKernelOrigin.rows[0].status, 'blocked')
  for (const field of [
    'scannedDepartures', 'upperBoundSeedScans', 'seededDestinationUpperBounds',
    'relaxedStops', 'poppedStates', 'expandedTripRuns', 'dominatedTripBoardings', 'engineQueryMs',
  ]) {
    assert(Number.isFinite(noKernelOrigin.diagnostics[field]), `No-origin matrix diagnostic ${field} must be numeric.`)
  }

  await fs.writeFile(matrixCycleSchedulePath, JSON.stringify({
    stops: [
      { id: 'O', name: 'Cycle origin', lat: 47, lon: 7.98 },
      { id: 'S', name: 'Shared station', lat: 47, lon: 8, locationType: 1 },
      { id: 'P1', name: 'Shared station platform 1', lat: 47, lon: 8, parentStationId: 'S' },
      { id: 'X', name: 'Turnaround', lat: 47.01, lon: 8.01 },
      { id: 'P2', name: 'Shared station platform 2', lat: 47, lon: 8.0001, parentStationId: 'S' },
      { id: 'D', name: 'Cycle destination', lat: 47, lon: 8.02 },
    ],
    transferRules: [
      { fromStopId: 'X', toStopId: 'X', transferType: 0, minTransferTimeSeconds: 60 },
      { fromStopId: 'P1', toStopId: 'P1', transferType: 0, minTransferTimeSeconds: 60 },
      { fromStopId: 'P2', toStopId: 'P2', transferType: 0, minTransferTimeSeconds: 60 },
      { fromStopId: 'P1', toStopId: 'P2', transferType: 3, minTransferTimeSeconds: 0 },
      { fromStopId: 'P2', toStopId: 'P1', transferType: 3, minTransferTimeSeconds: 0 },
    ],
    routes: [{
      routeId: 'IN', shortName: 'IN', routeType: 3,
      scheduledTrips: [{
        tripId: 'in', serviceId: 'SUN', serviceDays: ['sunday'],
        stopTimes: [
          { stopId: 'O', sequence: 1, arrivalMinutes: 450, departureMinutes: 450 },
          { stopId: 'P1', sequence: 2, arrivalMinutes: 470, departureMinutes: 470 },
        ],
      }],
    }, {
      routeId: 'OUT', shortName: 'OUT', routeType: 3,
      scheduledTrips: [{
        tripId: 'out', serviceId: 'SUN', serviceDays: ['sunday'],
        stopTimes: [
          { stopId: 'P1', sequence: 1, arrivalMinutes: 480, departureMinutes: 480 },
          { stopId: 'X', sequence: 2, arrivalMinutes: 490, departureMinutes: 490 },
        ],
      }],
    }, {
      routeId: 'BACK', shortName: 'BACK', routeType: 3,
      scheduledTrips: [{
        tripId: 'back', serviceId: 'SUN', serviceDays: ['sunday'],
        stopTimes: [
          { stopId: 'X', sequence: 1, arrivalMinutes: 495, departureMinutes: 495 },
          { stopId: 'P2', sequence: 2, arrivalMinutes: 505, departureMinutes: 505 },
        ],
      }],
    }, {
      routeId: 'ONWARD', shortName: 'ONWARD', routeType: 3,
      scheduledTrips: [{
        tripId: 'onward', serviceId: 'SUN', serviceDays: ['sunday'],
        stopTimes: [
          { stopId: 'P2', sequence: 1, arrivalMinutes: 510, departureMinutes: 510 },
          { stopId: 'D', sequence: 2, arrivalMinutes: 520, departureMinutes: 520 },
        ],
      }],
    }],
  }))
  await buildRoutingStoreFromSchedules({
    schedules: [{ feedId: 'matrix-cycle', schedulePath: matrixCycleSchedulePath }],
    outputPath: matrixCycleStorePath,
  })
  const matrixCycleRequest = {
    origins: [{
      stopId: 'matrix-cycle\u001fP1', coordinate: [8, 47], label: 'Platform 1', source: 'stop',
    }],
    destinations: [{
      stopId: 'matrix-cycle\u001fP2', coordinate: [8.0001, 47], label: 'Platform 2', source: 'stop',
    }],
    departMinutes: 480,
    serviceDate: '2026-07-12',
    serviceDay: 'sunday',
    maxWalkKm: 0.2,
  }
  const matrixCycleShared = routeNationalGtfsMatrix(matrixCycleStorePath, {
    ...matrixCycleRequest,
    matrixStrategy: 'shared',
  })
  const matrixCyclePairwise = matrixItineraryReference(matrixCycleStorePath, {
    ...matrixCycleRequest,
    matrixStrategy: 'pairwise',
  })
  assert.deepEqual(
    matrixCycleShared.rows,
    matrixCyclePairwise.rows,
    'Shared and pairwise matrices must expose the same represented-graph optimum for an endpoint-return cycle.',
  )
  assert.equal(matrixCycleShared.rows[0].status, 'ready')
  assert.equal(matrixCycleShared.rows[0].durationMinutes, 25)
  assert.equal(matrixCycleShared.diagnostics.forwardSearches, 1)
  assert.equal(matrixCycleShared.diagnostics.returnedStationCyclePolicy, 'represented')

  const cyclePointRequest = {
    origin: matrixCycleRequest.origins[0],
    destination: matrixCycleRequest.destinations[0],
    departMinutes: matrixCycleRequest.departMinutes,
    serviceDate: matrixCycleRequest.serviceDate,
    serviceDay: matrixCycleRequest.serviceDay,
    maxWalkKm: matrixCycleRequest.maxWalkKm,
    __disableDirectWalkDominance: true,
  }
  // A parent-station return is an advisory, not proof that the GTFS path is
  // infeasible: this fixture forbids the direct platform change.
  const cyclePoint = routeNationalGtfsStore(matrixCycleStorePath, cyclePointRequest)
  assert.equal(cyclePoint.status, 'ready')
  assert.equal(cyclePoint.arriveMinutes, 505)
  assert.equal(cyclePoint.diagnostics.returnedStationCycle.stationGroupId, 'matrix-cycle\u001fS')
  const cycleArriveBy = routeNationalGtfsStore(matrixCycleStorePath, {
    ...cyclePointRequest, timePreference: 'arrive', arriveMinutes: 505,
  })
  assert.equal(cycleArriveBy.status, 'ready')
  assert.equal(cycleArriveBy.departMinutes, 480)
  assert.equal(cycleArriveBy.arriveMinutes, 505)
  disposeNationalGtfsStore(matrixCycleStorePath)
  assert.equal(routeNationalGtfsStore(matrixCycleStorePath, cyclePointRequest).arriveMinutes, 505)

  const internalCycleMatrixRequest = {
    origins: [{
      stopId: 'matrix-cycle\u001fO', coordinate: [7.98, 47], label: 'Cycle origin', source: 'stop',
    }],
    destinations: [{
      stopId: 'matrix-cycle\u001fD', coordinate: [8.02, 47], label: 'Cycle destination', source: 'stop',
    }],
    departMinutes: 450,
    serviceDate: '2026-07-12',
    serviceDay: 'sunday',
    maxWalkKm: 0.2,
  }
  const internalCycleShared = routeNationalGtfsMatrix(matrixCycleStorePath, {
    ...internalCycleMatrixRequest,
    matrixStrategy: 'shared',
  })
  const internalCyclePairwise = matrixItineraryReference(matrixCycleStorePath, {
    ...internalCycleMatrixRequest,
    matrixStrategy: 'pairwise',
  })
  assert.deepEqual(
    internalCycleShared.rows,
    internalCyclePairwise.rows,
    'Represented matrix parity must hold when the returned station group is internal to the path.',
  )
  assert.equal(internalCycleShared.rows[0].status, 'ready')
  assert.equal(internalCycleShared.rows[0].durationMinutes, 70)
  const internalCyclePointRequest = {
    origin: internalCycleMatrixRequest.origins[0],
    destination: internalCycleMatrixRequest.destinations[0],
    departMinutes: internalCycleMatrixRequest.departMinutes,
    serviceDate: internalCycleMatrixRequest.serviceDate,
    serviceDay: internalCycleMatrixRequest.serviceDay,
    maxWalkKm: internalCycleMatrixRequest.maxWalkKm,
    __disableDirectWalkDominance: true,
  }
  const internalCycle = routeNationalGtfsStore(matrixCycleStorePath, internalCyclePointRequest)
  assert.equal(internalCycle.status, 'ready')
  assert.equal(internalCycle.arriveMinutes, 520)
  assert.equal(internalCycle.legs.filter((leg) => leg.type === 'ride').length, 4)
  assert.equal(internalCycle.diagnostics.returnedStationCycle.stationGroupId, 'matrix-cycle\u001fS')

  await fs.copyFile(storePath, matrixUpperBoundStorePath)
  const matrixUpperBoundStore = new DatabaseSync(matrixUpperBoundStorePath)
  matrixUpperBoundStore.prepare('INSERT INTO routes VALUES(?,?,?,?,?)').run('R3', '3', 'Alpha Charlie direct', 2, '339966')
  matrixUpperBoundStore.prepare('INSERT INTO trips VALUES(?,?,?,?)').run('direct', 'R3', 'S', '0')
  matrixUpperBoundStore.prepare('INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?)')
    .run(8 * 3600 + 8 * 60, 8 * 3600 + 27 * 60, 'direct', 'R3', 'S', '0', 'A', 'C', 1)
  const insertLateTrip = matrixUpperBoundStore.prepare('INSERT INTO trips VALUES(?,?,?,?)')
  const insertLateConnection = matrixUpperBoundStore.prepare('INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?)')
  for (let index = 0; index < 128; index += 1) {
    const tripId = `late-${index}`
    const lateDeparture = 10 * 3600 + index * 120
    insertLateTrip.run(tripId, 'R3', 'S', '0')
    insertLateConnection.run(lateDeparture, lateDeparture + 20 * 60, tripId, 'R3', 'S', '0', 'A', 'C', 1)
  }
  matrixUpperBoundStore.close()
  await rebuildFixtureRoutingDerivedArtifacts(matrixUpperBoundStorePath)
  const upperBoundRequest = {
    origins: [alpha], destinations: [bravo, charlie], departMinutes: 8 * 60,
    serviceDay: 'sunday', serviceDate: '2026-07-12', maxWalkKm: 0.25,
  }
  const upperBoundShared = routeNationalGtfsMatrix(matrixUpperBoundStorePath, { ...upperBoundRequest, matrixStrategy: 'shared' })
  const upperBoundPairwise = matrixItineraryReference(matrixUpperBoundStorePath, {
    ...upperBoundRequest,
    matrixStrategy: 'pairwise',
  })
  assert.deepEqual(upperBoundShared.rows, upperBoundPairwise.rows, 'Feasible matrix upper bounds must preserve exact pairwise arrival parity.')
  assert.equal(
    upperBoundShared.diagnostics.matrixEngine,
    'rust_exact_connection_scan_one_to_many',
  )
  assert.equal(upperBoundShared.diagnostics.seededDestinationUpperBounds, 0)
  assert.equal(upperBoundShared.diagnostics.upperBoundSeedScans, 0)
  assert.equal(upperBoundShared.diagnostics.upperBoundedForwardSearches, 0)
  assert(Number.isFinite(upperBoundShared.diagnostics.engineQueryMs))

  const manyToOne = routeNationalGtfsMatrix(storePath, {
    origins: [alpha, bravo], destinations: [charlie], departMinutes: 8 * 60,
    serviceDay: 'sunday', serviceDate: '2026-07-12', maxWalkKm: 0.25,
  })
  assert.equal(manyToOne.diagnostics.matrixStrategy, 'shared')
  assert.equal(manyToOne.diagnostics.forwardSearches, 2)
  assert.equal(manyToOne.diagnostics.destinationAccessComputations, 1)
  assert.equal(manyToOne.rows.length, 2)

  const schedulePaths = [path.join(folder, 'feed-a.json'), path.join(folder, 'feed-b.json')]
  const schedule = (routeId, shortName, from, to, depart, arrive) => ({
    schemaVersion: 'vigo.routing.schedule.v1', routeCount: 1, tripCount: 1, stopTimeCount: 2,
    stops: [from, to],
    routes: [{
      id: routeId, routeId, shortName, longName: shortName, routeType: 2, color: '#336699',
      scheduledTrips: [{
        tripId: `${routeId}-trip`, serviceId: 'daily', serviceDays: ['weekday', 'saturday', 'sunday'], routeId,
        firstDepartureMinutes: depart, lastArrivalMinutes: arrive,
        stopTimes: [
          { stopId: from.id, sequence: 1, departureMinutes: depart, arrivalMinutes: depart, progress: 0 },
          { stopId: to.id, sequence: 2, departureMinutes: arrive, arrivalMinutes: arrive, progress: 1 },
        ],
      }],
    }],
  })
  await fs.writeFile(schedulePaths[0], JSON.stringify(schedule('A', 'A',
    { id: 'origin', name: 'Origin', lat: 47, lon: 8 },
    { id: 'interchange-a', name: 'Interchange A', lat: 47.01, lon: 8.01 }, 485, 495)))
  await fs.writeFile(schedulePaths[1], JSON.stringify(schedule('B', 'B',
    { id: 'interchange-b', name: 'Interchange B', lat: 47.0102, lon: 8.0102 },
    { id: 'destination', name: 'Destination', lat: 47.02, lon: 8.02 }, 500, 510)))
  const migrated = await buildRoutingStoreFromSchedules({
    schedules: [{ feedId: 'feed-a', schedulePath: schedulePaths[0] }, { feedId: 'feed-b', schedulePath: schedulePaths[1] }],
    outputPath: migratedStorePath,
  })
  assert.equal(migrated.connectionCount, 2)
  const migratedTransferStore = new DatabaseSync(migratedStorePath)
  migratedTransferStore.prepare('INSERT INTO transfers VALUES(?,?,?,?)').run(
    'feed-a\u001finterchange-a',
    'feed-b\u001finterchange-b',
    0,
    120,
  )
  migratedTransferStore.prepare(`
    INSERT INTO transfer_provenance(
      from_stop_id, to_stop_id, provenance, evidence_fingerprint, path_distance_m
    ) VALUES(?,?,'schedule_transfer',NULL,NULL)
  `).run('feed-a\u001finterchange-a', 'feed-b\u001finterchange-b')
  migratedTransferStore.close()
  await rebuildFixtureRoutingDerivedArtifacts(migratedStorePath)
  const migratedPlan = routeNationalGtfsStore(migratedStorePath, {
    origin: alpha, destination: charlie, departMinutes: 480, serviceDay: 'sunday', serviceDate: '2026-07-12', maxWalkKm: 0.25,
  })
  assert.equal(migratedPlan.status, 'ready')
  assert.deepEqual(migratedPlan.legs.filter((leg) => leg.type === 'ride').map((leg) => leg.routeShortName), ['A', 'B'])

  await fs.copyFile(migratedStorePath, transferSlackStorePath)
  const transferSlackStore = new DatabaseSync(transferSlackStorePath)
  transferSlackStore.prepare("UPDATE connections SET departure=?, arrival=? WHERE route_id LIKE '%B'").run(498 * 60, 508 * 60)
  transferSlackStore.close()
  await rebuildFixtureRoutingDerivedArtifacts(transferSlackStorePath)
  const transferSlackPlan = routeNationalGtfsStore(transferSlackStorePath, {
    origin: alpha, destination: charlie, departMinutes: 480,
    serviceDay: 'sunday', serviceDate: '2026-07-12', maxWalkKm: 0.25,
  })
  assert.equal(transferSlackPlan.status, 'ready', 'The physical cross-feed transfer must consume the generic boarding allowance instead of adding it twice.')
  assert.equal(
    transferSlackPlan.legs.filter((leg) => leg.type === 'ride')[1]?.startMinutes,
    498,
    'A transfer-complete arrival must be allowed to board the 08:18 connection.',
  )

  const rawFeed = async ({ zipPath: output, prefix, from, to, depart, arrive }) => {
    const fixture = new JSZip()
    fixture.file('stops.txt', [
      'stop_id,stop_name,stop_lat,stop_lon,location_type',
      `${from.id},${from.name},${from.lat},${from.lon},0`,
      `${to.id},${to.name},${to.lat},${to.lon},0`,
    ].join('\n'))
    fixture.file('routes.txt', `route_id,route_short_name,route_long_name,route_type\n${prefix},${prefix},${prefix},2\n`)
    fixture.file('trips.txt', `route_id,service_id,trip_id,direction_id\n${prefix},S,${prefix}-trip,0\n`)
    fixture.file('stop_times.txt', [
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
      `${prefix}-trip,${depart},${depart},${from.id},1`,
      `${prefix}-trip,${arrive},${arrive},${to.id},2`,
    ].join('\n'))
    fixture.file('calendar.txt', 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n')
    fixture.file('calendar_dates.txt', 'service_id,date,exception_type\nS,20260712,1\n')
    await fs.writeFile(output, await fixture.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  }
  await rawFeed({ zipPath: rawFeedAPath, prefix: 'RA', from: { id: 'O', name: 'Origin', lat: 47, lon: 8 }, to: { id: 'XA', name: 'Exchange A', lat: 47.01, lon: 8.01 }, depart: '08:05:00', arrive: '08:15:00' })
  await rawFeed({ zipPath: rawFeedBPath, prefix: 'RB', from: { id: 'XB', name: 'Exchange B', lat: 47.0101, lon: 8.0101 }, to: { id: 'D', name: 'Destination', lat: 47.02, lon: 8.02 }, depart: '08:20:00', arrive: '08:30:00' })
  await buildNationalGtfsStore({ zipPath: rawFeedAPath, outputPath: rawStoreAPath })
  await buildNationalGtfsStore({ zipPath: rawFeedBPath, outputPath: rawStoreBPath })
  const mergedRaw = await mergeNationalGtfsStores({
    stores: [{ scope: 'feed-a', storePath: rawStoreAPath }, { scope: 'feed-b', storePath: rawStoreBPath }],
    outputPath: mergedRawStorePath,
  })
  assert.equal(mergedRaw.connectionCount, 2)
  assert.equal(mergedRaw.serviceModel, 'exact-date-multi-feed')
  const mergedRawTransferStore = new DatabaseSync(mergedRawStorePath)
  mergedRawTransferStore.prepare('INSERT INTO transfers VALUES(?,?,?,?)').run(
    'feed-a\u001fXA',
    'feed-b\u001fXB',
    0,
    120,
  )
  mergedRawTransferStore.prepare(`
    INSERT INTO transfer_provenance(
      from_stop_id, to_stop_id, provenance, evidence_fingerprint, path_distance_m
    ) VALUES(?,?,'gtfs_transfer',NULL,NULL)
  `).run('feed-a\u001fXA', 'feed-b\u001fXB')
  mergedRawTransferStore.close()
  await rebuildFixtureRoutingDerivedArtifacts(mergedRawStorePath)
  const rawMetadataA = readNationalGtfsStoreMetadata(rawStoreAPath)
  const rawMetadataB = readNationalGtfsStoreMetadata(rawStoreBPath)
  const mergedRawMetadata = readNationalGtfsStoreMetadata(mergedRawStorePath)
  assert.equal(
    mergedRawMetadata.sourceFingerprint,
    `feed-a:${rawMetadataA.sourceFingerprint}|feed-b:${rawMetadataB.sourceFingerprint}`,
  )
  assert.deepEqual(
    mergedRawMetadata.featureInventory,
    Object.fromEntries(Object.keys(rawMetadataA.featureInventory).map((key) => [
      key,
      Number(rawMetadataA.featureInventory[key] ?? 0) + Number(rawMetadataB.featureInventory[key] ?? 0),
    ])),
    'A multi-feed store must preserve the complete summed import feature inventory.',
  )
  assert.deepEqual(
    mergedRawMetadata.sourceStores.map((source) => source.sourceFingerprint),
    [rawMetadataA.sourceFingerprint, rawMetadataB.sourceFingerprint],
    'A multi-feed store must retain each component content fingerprint.',
  )
  const mergedRawPlan = routeNationalGtfsStore(mergedRawStorePath, {
    origin: alpha, destination: charlie, departMinutes: 480, serviceDay: 'sunday', serviceDate: '2026-07-12', maxWalkKm: 0.25,
  })
  assert.equal(mergedRawPlan.status, 'ready')
  assert.deepEqual(mergedRawPlan.legs.filter((leg) => leg.type === 'ride').map((leg) => leg.routeShortName), ['RA', 'RB'])

  await fs.copyFile(mergedRawStorePath, arriveTransferStorePath)
  const arriveTransferStore = new DatabaseSync(arriveTransferStorePath)
  arriveTransferStore.prepare('UPDATE stops SET lat=?, lon=? WHERE stop_id=?').run(47.03, 8.03, 'feed-b\u001fXB')
  arriveTransferStore.prepare('INSERT OR REPLACE INTO transfers VALUES(?,?,?,?)').run('feed-a\u001fXA', 'feed-b\u001fXB', 0, 120)
  arriveTransferStore.close()
  await rebuildFixtureRoutingDerivedArtifacts(arriveTransferStorePath)
  await fs.copyFile(arriveTransferStorePath, arriveTransferLegacyStorePath)
  const arriveTransferLegacyStore = new DatabaseSync(arriveTransferLegacyStorePath)
  assert.equal(
    arriveTransferLegacyStore.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='index' AND name='connections_to_arrival_cover'",
    ).get()?.present ?? 0,
    0,
    'Current routing stores intentionally omit the redundant reverse SQLite index.',
  )
  arriveTransferLegacyStore.close()
  const explicitCrossFeedArriveRequest = {
    origin: { coordinate: [8.01, 47.01], label: 'Cross-feed transfer origin', source: 'map' },
    destination: { coordinate: [8.02, 47.02], label: 'Cross-feed transfer destination', source: 'map' },
    arriveMinutes: 8 * 60 + 31,
    timePreference: 'arrive',
    serviceDay: 'sunday',
    serviceDate: '2026-07-12',
    maxWalkKm: 0.2,
  }
  const explicitCrossFeedArrivePlan = routeNationalGtfsStore(arriveTransferStorePath, explicitCrossFeedArriveRequest)
  assert.equal(explicitCrossFeedArrivePlan.status, 'ready', 'Reverse arrive-by must traverse an explicit transfer before the first ride.')
  assert.equal(explicitCrossFeedArrivePlan.diagnostics.algorithm, 'rust_exact_arrive_by_reverse_scan')
  assert.equal(explicitCrossFeedArrivePlan.legs.find((leg) => leg.type === 'ride')?.tripId, 'feed-b\u001fRB-trip')
  assert(explicitCrossFeedArrivePlan.legs.some((leg) => leg.walkSource === 'transfer' && leg.fromStopId === 'feed-a\u001fXA' && leg.toStopId === 'feed-b\u001fXB'))
  const noReverseIndexArrivePlan = routeNationalGtfsStore(
    arriveTransferLegacyStorePath,
    explicitCrossFeedArriveRequest,
  )
  assert.equal(noReverseIndexArrivePlan.status, 'ready', 'Native arrive-by must not require a duplicate reverse SQLite index.')

  const fallbackRail = new JSZip()
  fallbackRail.file('stops.txt', [
    'stop_id,stop_name,stop_lat,stop_lon,location_type',
    'RO,Rail Origin,47.0000,8.0000,0',
    'RX,Rail Exchange,47.0100,8.0100,0',
    'RD,Rail Destination,47.0200,8.0200,0',
  ].join('\n'))
  fallbackRail.file('routes.txt', [
    'route_id,route_short_name,route_long_name,route_type',
    'DIRECT,Rail direct,Rail direct,1',
    'CONNECTOR,Rail connector,Rail connector,1',
  ].join('\n'))
  fallbackRail.file('trips.txt', [
    'route_id,service_id,trip_id,direction_id',
    'DIRECT,R,DIRECT-trip,0',
    'CONNECTOR,R,CONNECTOR-trip,0',
  ].join('\n'))
  fallbackRail.file('stop_times.txt', [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    'DIRECT-trip,08:10:00,08:10:00,RO,1',
    'DIRECT-trip,08:50:00,08:50:00,RD,2',
    'CONNECTOR-trip,08:20:00,08:20:00,RX,1',
    'CONNECTOR-trip,08:30:00,08:30:00,RD,2',
  ].join('\n'))
  fallbackRail.file('calendar.txt', [
    'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
    'R,1,1,1,1,1,0,0,20250101,20261231',
  ].join('\n'))
  fallbackRail.file('calendar_dates.txt', 'service_id,date,exception_type\n')

  const fallbackBus = new JSZip()
  fallbackBus.file('stops.txt', [
    'stop_id,stop_name,stop_lat,stop_lon,location_type',
    'BO,Bus Origin,46.9900,7.9900,0',
    'BX,Bus Exchange,47.0101,8.0101,0',
  ].join('\n'))
  fallbackBus.file('routes.txt', 'route_id,route_short_name,route_long_name,route_type\nBUS,Bus,Bus,3\n')
  fallbackBus.file('trips.txt', 'route_id,service_id,trip_id,direction_id\nBUS,B,BUS-trip,0\n')
  fallbackBus.file('stop_times.txt', [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    'BUS-trip,08:05:00,08:05:00,BO,1',
    'BUS-trip,08:15:00,08:15:00,BX,2',
  ].join('\n'))
  fallbackBus.file('calendar.txt', [
    'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
    'B,1,1,1,1,1,0,0,20250101,20251227',
  ].join('\n'))
  fallbackBus.file('calendar_dates.txt', 'service_id,date,exception_type\n')

  await Promise.all([
    fs.writeFile(fallbackRailFeedPath, await fallbackRail.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })),
    fs.writeFile(fallbackBusFeedPath, await fallbackBus.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })),
  ])
  await Promise.all([
    buildNationalGtfsStore({ zipPath: fallbackRailFeedPath, outputPath: fallbackRailStorePath }),
    buildNationalGtfsStore({ zipPath: fallbackBusFeedPath, outputPath: fallbackBusStorePath }),
  ])
  await mergeNationalGtfsStores({
    stores: [{ scope: 'rail', storePath: fallbackRailStorePath }, { scope: 'bus', storePath: fallbackBusStorePath }],
    outputPath: fallbackMergedStorePath,
  })
  const fallbackTransferStore = new DatabaseSync(fallbackMergedStorePath)
  fallbackTransferStore.prepare('INSERT INTO transfers VALUES(?,?,?,?)').run(
    'bus\u001fBX',
    'rail\u001fRX',
    0,
    120,
  )
  fallbackTransferStore.prepare(`
    INSERT INTO transfer_provenance(
      from_stop_id, to_stop_id, provenance, evidence_fingerprint, path_distance_m
    ) VALUES(?,?,'gtfs_transfer',NULL,NULL)
  `).run('bus\u001fBX', 'rail\u001fRX')
  fallbackTransferStore.close()
  await rebuildFixtureRoutingDerivedArtifacts(fallbackMergedStorePath)
  const fallbackStreet = new DatabaseSync(fallbackStreetPath)
  fallbackStreet.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE walk_nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE edges(from_node INTEGER NOT NULL, to_node INTEGER NOT NULL, distance_m REAL NOT NULL, way_id INTEGER NOT NULL);
    CREATE INDEX walk_nodes_lat_lon ON walk_nodes(lat,lon);
    CREATE INDEX edges_from ON edges(from_node);
    CREATE INDEX edges_to ON edges(to_node);
    INSERT INTO metadata VALUES('schemaVersion', '"vigo.street.store.v4"');
    INSERT INTO metadata VALUES('sourceModel', '"pbf"');
    INSERT INTO walk_nodes VALUES
      (1, 46.9900, 7.9900),
      (2, 47.0101, 8.0101),
      (3, 47.0200, 8.0200);
  `)
  finalizeCurrentStreetFixture(fallbackStreet)
  fallbackStreet.close()
  prepareRustFixtureStreetStore(fallbackStreetPath)
  const smartEarlierDateContext = prepareNationalGtfsRoutingContext(fallbackMergedStorePath, {
    serviceDate: '2025-07-12',
    serviceDay: 'saturday',
    requireCompleteServiceCoverage: true,
  })
  assert.deepEqual(
    smartEarlierDateContext.serviceDateOptions,
    [
      { date: '2025-07-11', relation: 'earlier', recommended: true },
      { date: '2025-07-14', relation: 'later', recommended: false },
    ],
    'An incomplete date must recommend the closest actually complete date, preferring an earlier date when it is closer.',
  )
  const fallbackRequest = {
    origin: alpha,
    destination: charlie,
    departMinutes: 480,
    serviceDay: 'monday',
    serviceDate: '2026-07-13',
    maxWalkKm: 0.25,
  }
  const partialExactPlan = routeNationalGtfsStore(fallbackMergedStorePath, fallbackRequest)
  assert.equal(partialExactPlan.status, 'ready')
  assert.deepEqual(partialExactPlan.legs.filter((leg) => leg.type === 'ride').map((leg) => leg.routeShortName), ['Rail direct'])
  assert.equal(partialExactPlan.diagnostics.requestedServiceDate, '2026-07-13')
  assert.equal(partialExactPlan.diagnostics.resolvedServiceDate, '2026-07-13')
  assert.equal(partialExactPlan.diagnostics.serviceDateFallbackApplied, false)
  assert.equal(partialExactPlan.diagnostics.requestedServiceScopeCount, 1)

  const fallbackPlan = routeNationalGtfsStore(fallbackMergedStorePath, { ...fallbackRequest, allowServiceDateFallback: true })
  assert.equal(fallbackPlan.status, 'ready')
  assert.deepEqual(fallbackPlan.legs.filter((leg) => leg.type === 'ride').map((leg) => leg.routeShortName), ['Rail direct'])
  assert.equal(fallbackPlan.diagnostics.requestedServiceDate, '2026-07-13')
  assert.equal(fallbackPlan.diagnostics.resolvedServiceDate, '2026-07-13')
  assert.equal(fallbackPlan.diagnostics.serviceDateFallbackApplied, false)
  assert.match(fallbackPlan.detail, /exact local timetable/)

  const fallbackRequiredRequest = {
    ...fallbackRequest,
    origin: { coordinate: [7.99, 46.99], label: 'Bus-only origin', source: 'map' },
  }
  const fallbackRequiredExact = routeNationalGtfsStore(fallbackMergedStorePath, fallbackRequiredRequest)
  assert.equal(fallbackRequiredExact.status, 'blocked')
  const fallbackRequiredPlan = routeNationalGtfsStore(fallbackMergedStorePath, { ...fallbackRequiredRequest, allowServiceDateFallback: true })
  assert.equal(fallbackRequiredPlan.status, 'ready')
  assert.deepEqual(fallbackRequiredPlan.legs.filter((leg) => leg.type === 'ride').map((leg) => leg.routeShortName), ['Bus', 'Rail connector'])
  assert.equal(fallbackRequiredPlan.diagnostics.requestedServiceDate, '2026-07-13')
  assert.equal(fallbackRequiredPlan.diagnostics.resolvedServiceDate, '2025-12-22')
  assert.equal(fallbackRequiredPlan.diagnostics.serviceDateFallbackApplied, true)
  assert.equal(fallbackRequiredPlan.diagnostics.resolvedServiceScopeCount, 2)
  assert.match(fallbackRequiredPlan.detail, /timetable for 2025-12-22 \(fallback from 2026-07-13\)/)
  const coordinateFallbackWindow = routeNationalGtfsDepartureWindow(
    fallbackMergedStorePath,
    {
      ...fallbackRequiredRequest,
      allowServiceDateFallback: true,
      departureWindowMinutes: 10,
      departureWindowDirection: 'forward',
      stepMinutes: 1,
      streetStorePath: fallbackStreetPath,
    },
  )
  assert.equal(
    coordinateFallbackWindow.profile.coordinateAccessFrontierPreparations,
    1,
    'A fallback departure window must still prepare one endpoint frontier.',
  )
  assert(
    coordinateFallbackWindow.profile.timetableRouteSearches > 1,
    'The fallback fixture must cross more than one timetable search.',
  )
  assert(
    coordinateFallbackWindow.profile.coordinateAccessFrontierReuses
      > coordinateFallbackWindow.profile.timetableRouteSearches,
    'Fallback retries and later samples must retain the same valid request-local frontier.',
  )
  const readyCoordinateFallbackPlans = coordinateFallbackWindow.profile.plans
    .filter((candidate) => candidate.status === 'ready')
  assert(readyCoordinateFallbackPlans.length > 0)
  assert(readyCoordinateFallbackPlans.every((candidate) => (
    candidate.diagnostics?.serviceDateFallbackApplied === true
    && candidate.diagnostics?.resolvedServiceDate === '2025-12-22'
  )))
  const coordinateFallbackArriveBy = routeNationalGtfsStore(
    fallbackMergedStorePath,
    {
      ...fallbackRequiredRequest,
      allowServiceDateFallback: true,
      timePreference: 'arrive',
      arriveMinutes: 8 * 60 + 31,
      streetStorePath: fallbackStreetPath,
    },
  )
  assert.equal(coordinateFallbackArriveBy.status, 'ready')
  assert.equal(
    coordinateFallbackArriveBy.diagnostics.serviceDateFallbackApplied,
    true,
  )
  assert.equal(
    coordinateFallbackArriveBy.diagnostics.resolvedServiceDate,
    '2025-12-22',
  )
  assert.equal(
    coordinateFallbackArriveBy.diagnostics.searchStats
      .coordinateAccessFrontierPreparations,
    1,
    'A standalone arrive-by fallback must retain one request-wide endpoint preparation.',
  )
  assert.equal(
    coordinateFallbackArriveBy.diagnostics.searchStats
      .coordinateAccessFrontierInherited,
    true,
    'The fallback arrive-by retry must explicitly inherit the identity-bound endpoint frontier.',
  )
  assert.equal(
    coordinateFallbackArriveBy.diagnostics.searchStats
      .coordinateAccessFrontierPreparedHere,
    false,
  )
  assert(
    coordinateFallbackArriveBy.diagnostics.searchStats
      .coordinateAccessFrontierReuses
      > coordinateFallbackArriveBy.diagnostics.searchStats
        .coordinateAccessFrontierArriveByReuses,
    'Request-wide reuse must include the service-date retry handoff as well as arrive-by candidate verification.',
  )

  const coveredRequest = { ...fallbackRequest, serviceDate: '2025-07-14' }
  const coveredExactPlan = routeNationalGtfsStore(fallbackMergedStorePath, coveredRequest)
  const coveredOptInPlan = routeNationalGtfsStore(fallbackMergedStorePath, { ...coveredRequest, allowServiceDateFallback: true })
  assert.equal(coveredOptInPlan.diagnostics.resolvedServiceDate, '2025-07-14')
  assert.equal(coveredOptInPlan.diagnostics.serviceDateFallbackApplied, false)
  assert.equal(coveredOptInPlan.arriveMinutes, coveredExactPlan.arriveMinutes)
  assert.deepEqual(
    coveredOptInPlan.legs.filter((leg) => leg.type === 'ride').map((leg) => leg.routeShortName),
    coveredExactPlan.legs.filter((leg) => leg.type === 'ride').map((leg) => leg.routeShortName),
  )
  assert.match(coveredOptInPlan.detail, /exact local timetable/)

  await fs.copyFile(rawStoreAPath, invalidRawStorePath)
  const invalidStore = new DatabaseSync(invalidRawStorePath)
  invalidStore.exec("DELETE FROM metadata WHERE key='sourceFingerprint'")
  invalidStore.close()
  await assert.rejects(() => mergeNationalGtfsStores({
    stores: [{ scope: 'valid', storePath: rawStoreAPath }, { scope: 'invalid', storePath: invalidRawStorePath }],
    outputPath: failedMergePath,
    removeSourcesAfterMerge: true,
  }), /lacks a source identity/)
  await fs.access(rawStoreAPath)
  await fs.access(invalidRawStorePath)
  await assert.rejects(() => fs.access(failedMergePath))
  await assert.rejects(() => mergeNationalGtfsStores({
    stores: [{ scope: 'feed-a', storePath: rawStoreAPath }, { scope: 'feed-b', storePath: rawStoreBPath }],
    outputPath: rawStoreAPath,
    removeSourcesAfterMerge: true,
  }), /must differ from every source store/)
  await fs.access(rawStoreAPath)
  await fs.access(rawStoreBPath)
  await mergeNationalGtfsStores({
    stores: [{ scope: 'feed-a', storePath: rawStoreAPath }, { scope: 'feed-b', storePath: rawStoreBPath }],
    outputPath: cleanupMergePath,
    removeSourcesAfterMerge: true,
  })
  await fs.access(cleanupMergePath)
  await assert.rejects(() => fs.access(rawStoreAPath))
  await assert.rejects(() => fs.access(rawStoreBPath))

  console.log(`National routing-store fixture passed (${result.buildSeconds}s build / ${plan.diagnostics.searchStats.queryMs}ms depart end-to-end / ${denseAccessArriveBy.diagnostics.searchStats.arriveByNativeEngineQueryMs}ms arrive-by timetable / ${firstRepairMs.toFixed(1)}ms repair / ${secondRepairMs.toFixed(1)}ms warm read).`)
} finally {
  disposeAllNationalGtfsStores()
  for (const streetPath of [parentModeAccessStreetPath, directWalkStreetPath, denseAccessStreetPath,
    completeEgressStreetPath, fallbackStreetPath]) disposeNationalOsmStore(streetPath)
}
