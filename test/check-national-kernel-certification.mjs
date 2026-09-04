import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { DatabaseSync } from 'node:sqlite'
import {
  buildNationalGtfsStore,
  disposeNationalGtfsStore,
  prepareNationalGtfsRoutingContext,
  routeNativeParetoWithRestrictionFallback,
  routeNationalGtfsStore,
} from '../src/server/national-gtfs-store.mjs'
import {
  buildNationalOsmWalkStore,
  compactNationalOsmRuntimeStore,
  disposeNationalOsmStore,
  prepareNationalOsmNativeStore,
} from '../src/server/national-osm-store.mjs'
import { buildNativeStreetCchIndex } from '../src/server/native-routing-kernel.mjs'

const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-kernel-certification-'))
const gtfsPath = path.join(folder, 'three-ride-suffix.zip')
const routingStorePath = path.join(folder, 'three-ride-suffix.sqlite')
const streetStorePath = path.join(folder, 'three-ride-suffix-street.sqlite')

const paretoCalls = []
const paretoFallback = routeNativeParetoWithRestrictionFallback((_kernel, request) => {
  paretoCalls.push(request)
  return request.restrictionMode === 'anchor-only'
    ? { supported: true, status: 'ready', reason: null, restrictionMode: 'anchor-only', queryMs: 0.4 }
    : { supported: false, status: 'unsupported', reason: 'origin_outside_kernel', restrictionMode: 'anchor+both', queryMs: 0.2 }
}, {}, { departure: 480 * 60 })
assert.equal(paretoFallback.raw.status, 'ready')
assert.equal(paretoFallback.combinedQueryMs, 0.6)
assert.equal(paretoFallback.restrictionFallback.status, 'passed')
assert.deepEqual(paretoCalls.map((request) => request.restrictionMode ?? null), [null, 'anchor-only'])

function csv(lines) {
  return `${lines.join('\n')}\n`
}

async function buildRawGtfsFixture() {
  const zip = new JSZip()
  zip.file('stops.txt', csv([
    'stop_id,stop_name,stop_lat,stop_lon,location_type',
    'O,Origin,0.0000,0.0000,0',
    'A,First interchange,0.0000,0.0040,0',
    'X,Second interchange,0.0000,0.0100,0',
    'Y,Connector terminus,0.0000,0.0110,0',
  ]))
  zip.file('routes.txt', csv([
    'route_id,route_short_name,route_long_name,route_type',
    'R1,R1,Origin to first interchange,3',
    'R2,R2,First to second interchange,3',
    'R3,R3,Unnecessary final connector,3',
    'RF,FAST,Earlier arrival with longer egress,3',
    'RL,LOWWALK,Later arrival with shorter egress,3',
  ]))
  zip.file('trips.txt', csv([
    'route_id,service_id,trip_id,direction_id',
    'R1,SERVICE,T1,0',
    'R2,SERVICE,T2,0',
    'R3,SERVICE,T3,0',
    'RF,SERVICE,TF,0',
    'RL,SERVICE,TL,0',
  ]))
  zip.file('stop_times.txt', csv([
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    'T1,08:00:00,08:00:00,O,1',
    'T1,08:05:00,08:05:00,A,2',
    'T2,08:08:00,08:08:00,A,1',
    'T2,08:11:00,08:11:00,X,2',
    'T3,08:20:00,08:20:00,X,1',
    'T3,08:21:00,08:21:00,Y,2',
    'TF,09:00:00,09:00:00,O,1',
    'TF,09:04:00,09:04:00,X,2',
    'TL,09:00:00,09:00:00,O,1',
    'TL,09:05:24,09:05:24,Y,2',
  ]))
  zip.file('calendar_dates.txt', csv([
    'service_id,date,exception_type',
    'SERVICE,20260713,1',
  ]))
  await fs.writeFile(gtfsPath, await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  }))
}

function buildStreetFixture() {
  const db = new DatabaseSync(streetStorePath)
  db.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE walk_nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE edges(from_node INTEGER NOT NULL, to_node INTEGER NOT NULL, distance_m REAL NOT NULL, way_id INTEGER NOT NULL);
    CREATE TABLE drive_nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE drive_edges(
      from_node INTEGER NOT NULL,
      to_node INTEGER NOT NULL,
      distance_m REAL NOT NULL,
      travel_time_s REAL NOT NULL,
      way_id INTEGER NOT NULL,
      road_class INTEGER NOT NULL
    );
    CREATE INDEX walk_nodes_lat_lon ON walk_nodes(lat, lon);
    CREATE INDEX edges_from ON edges(from_node);
    CREATE INDEX edges_to ON edges(to_node);
    CREATE INDEX drive_nodes_lat_lon ON drive_nodes(lat,lon);
    CREATE INDEX drive_edges_from ON drive_edges(from_node);
    CREATE INDEX drive_edges_to ON drive_edges(to_node);
    INSERT INTO metadata VALUES
      ('schemaVersion', '"vigo.street.store.v3"'),
      ('sourceModel', '"pbf"'),
      ('nodeCount', '5'),
      ('edgeCount', '6'),
      ('driveNodeCount', '0'),
      ('driveEdgeCount', '0'),
      ('storageLayout', '"walk-drive-role-tables-v2"'),
      ('driveNodeStorage', '"walk-shared-plus-drive-only-v1"'),
      ('driveIndexState', '"ready"');
    INSERT INTO walk_nodes VALUES
      (1, 0.0000, 0.0100),
      (2, 0.0000, 0.0110),
      (3, 0.0000, 0.0120),
      (4, 0.0000, 0.0000),
      (5, 0.0000, 0.0040);
    INSERT INTO edges VALUES
      (1, 2, 100, 1),
      (2, 1, 100, 1),
      (2, 3, 100, 2),
      (3, 2, 100, 2),
      (4, 5, 445, 3),
      (5, 4, 445, 3);
  `)
  db.close()
  assert.equal(buildNationalOsmWalkStore(streetStorePath, {
    force: true,
    persist: true,
  }).ready, true)
  assert.equal(
    compactNationalOsmRuntimeStore(streetStorePath).storageLayout,
    'runtime-snapshots-v1',
  )
  disposeNationalOsmStore(streetStorePath)
  assert.equal(prepareNationalOsmNativeStore(streetStorePath).ready, true)
  assert(buildNativeStreetCchIndex(streetStorePath).loaded.nodeCount > 0)
}

try {
  await buildRawGtfsFixture()
  buildStreetFixture()
  await buildNationalGtfsStore({
    zipPath: gtfsPath,
    outputPath: routingStorePath,
  })

  const context = prepareNationalGtfsRoutingContext(routingStorePath, {
    serviceDate: '2026-07-13',
    serviceDay: 'weekday',
  })
  const prepared = context.activeServiceKernel
  assert.equal(prepared.ready, true, JSON.stringify(prepared))
  assert.equal(prepared.engine, 'rust_exact_connection_scan')
  assert.equal(prepared.heuristicMode, 'none')
  assert.equal(context.nativeTimetableKernel?.algorithm, 'exact_connection_scan_no_heuristic')
  assert.equal(context.nativeTimetableKernel?.zeroCopyArrays, true)
  assert(
    Number.isFinite(prepared.nativeMemoryBudget?.usedBytes)
      && (
        prepared.nativeMemoryBudget.limitBytes === null
        || prepared.nativeMemoryBudget.usedBytes <= prepared.nativeMemoryBudget.limitBytes
      ),
    'The complete Rust timetable image and workspaces must fit an explicitly configured memory guard when one is enabled.',
  )
  assert(
    context.nativeTimetableKernel?.nativeIndexBytes > 0
      && context.nativeTimetableKernel?.workspaceBytes > 0,
    'Rust must disclose retained native indexes and exact-search workspaces.',
  )

  const threeRideRequest = {
    origin: {
      coordinate: [0, 0],
      label: 'Origin',
      source: 'stop',
      stopId: 'O',
    },
    destination: {
      coordinate: [0.012, 0],
      label: 'Destination',
      source: 'map',
    },
    departMinutes: 8 * 60,
    serviceDay: 'weekday',
    serviceDate: '2026-07-13',
    maxWalkKm: 0.5,
    streetStorePath,
    __destinationAccessStopIds: ['Y'],
  }
  const threeRidePlan = routeNationalGtfsStore(routingStorePath, threeRideRequest)
  assert.equal(threeRidePlan.status, 'ready', JSON.stringify(threeRidePlan, null, 2))
  assert.deepEqual(
    threeRidePlan.legs.filter((leg) => leg.type === 'ride').map((leg) => leg.routeShortName),
    ['R1', 'R2', 'R3'],
  )
  assert.equal(
    threeRidePlan.diagnostics.algorithm,
    'rust_exact_connection_scan_bounded_pareto_no_heuristic',
  )
  assert.deepEqual(
    threeRidePlan.diagnostics.methodUsed,
    ['rust_timetable_kernel', 'rust_exact_bounded_nondominated_frontier'],
  )
  assert.equal(threeRidePlan.diagnostics.paretoCertification?.status, 'passed')
  assert.equal(
    threeRidePlan.diagnostics.paretoCertification?.certifier,
    'rust_exact_bounded_nondominated_frontier',
  )
  assert.equal(threeRidePlan.diagnostics.searchStats?.heuristicMode, 'none')
  assert.deepEqual(
    threeRidePlan.diagnostics.searchStats?.engineInvocationsThisPass,
    { rustTimetable: 1, sqlite: 0 },
  )
  assert.equal(
    threeRidePlan.diagnostics.searchStats?.activeServiceKernel?.tripRunDedupStorage,
    'rust_fixed_round_run_layers',
  )

  const twoRidePlan = routeNationalGtfsStore(routingStorePath, {
    origin: { coordinate: [0, 0], label: 'Origin', source: 'stop', stopId: 'O' },
    destination: { coordinate: [0.01, 0], label: 'Second interchange', source: 'stop', stopId: 'X' },
    departMinutes: 8 * 60,
    serviceDay: 'weekday',
    serviceDate: '2026-07-13',
    maxWalkKm: 0.2,
    __disableDirectWalkDominance: true,
  })
  assert.equal(twoRidePlan.status, 'ready', JSON.stringify(twoRidePlan, null, 2))
  assert.deepEqual(
    twoRidePlan.legs.filter((leg) => leg.type === 'ride').map((leg) => leg.routeShortName),
    ['R1', 'R2'],
  )
  assert.equal(
    twoRidePlan.diagnostics.algorithm,
    'rust_exact_connection_scan_bounded_pareto_no_heuristic',
  )

  const balancedPlan = routeNationalGtfsStore(routingStorePath, {
    origin: { coordinate: [0, 0], label: 'Origin', source: 'stop', stopId: 'O' },
    destination: { coordinate: [0.01, 0], label: 'Second interchange', source: 'stop', stopId: 'X' },
    departMinutes: 8 * 60,
    serviceDay: 'weekday',
    serviceDate: '2026-07-13',
    maxWalkKm: 0.2,
    routingPreference: 'balanced',
    __disableDirectWalkDominance: true,
  })
  assert.equal(balancedPlan.status, 'ready', JSON.stringify(balancedPlan, null, 2))
  assert.equal(balancedPlan.diagnostics.searchProfile, 'balanced')
  assert.match(
    balancedPlan.diagnostics.optimality,
    /^balanced_generalized_selection_over_exact.*nondominated_frontier$/,
  )
  assert(
    balancedPlan.diagnostics.balancedGeneralizedSelection?.terminalCandidatesEvaluated > 1,
    'Balanced routing must evaluate the exact Rust nondominated terminal frontier.',
  )

  const oneRidePlan = routeNationalGtfsStore(routingStorePath, {
    origin: { coordinate: [0, 0], label: 'Origin', source: 'stop', stopId: 'O' },
    destination: { coordinate: [0.004, 0], label: 'First interchange', source: 'stop', stopId: 'A' },
    departMinutes: 8 * 60,
    serviceDay: 'weekday',
    serviceDate: '2026-07-13',
    maxWalkKm: 0.2,
  })
  assert.equal(oneRidePlan.status, 'ready')
  assert.deepEqual(
    oneRidePlan.legs.filter((leg) => leg.type === 'ride').map((leg) => leg.routeShortName),
    ['R1'],
  )
  assert.equal(
    oneRidePlan.diagnostics.algorithm,
    'rust_exact_connection_scan_scalar_no_heuristic',
  )

  const oneBoardingTradeoffRequest = {
    origin: { coordinate: [0, 0], label: 'Origin', source: 'stop', stopId: 'O' },
    destination: { coordinate: [0.012, 0], label: 'Destination', source: 'map' },
    departMinutes: 9 * 60,
    serviceDay: 'weekday',
    serviceDate: '2026-07-13',
    maxWalkKm: 0.5,
    __destinationAccessStopIds: ['X', 'Y'],
    __disableDirectWalkDominance: true,
  }
  const fastestOneBoardingPlan = routeNationalGtfsStore(routingStorePath, {
    ...oneBoardingTradeoffRequest,
    routingPreference: 'fastest',
  })
  assert.equal(
    fastestOneBoardingPlan.status,
    'ready',
    JSON.stringify(fastestOneBoardingPlan, null, 2),
  )
  assert.deepEqual(
    fastestOneBoardingPlan.legs
      .filter((leg) => leg.type === 'ride')
      .map((leg) => leg.routeShortName),
    ['FAST'],
  )
  assert.equal(
    fastestOneBoardingPlan.diagnostics.algorithm,
    'rust_exact_connection_scan_scalar_no_heuristic',
    'Strict fastest routing must retain the one-boarding scalar shortcut.',
  )
  assert.equal(fastestOneBoardingPlan.diagnostics.paretoCertification, undefined)

  const balancedOneBoardingPlan = routeNationalGtfsStore(routingStorePath, {
    ...oneBoardingTradeoffRequest,
    routingPreference: 'balanced',
  })
  assert.equal(
    balancedOneBoardingPlan.status,
    'ready',
    JSON.stringify(balancedOneBoardingPlan, null, 2),
  )
  assert.deepEqual(
    balancedOneBoardingPlan.legs
      .filter((leg) => leg.type === 'ride')
      .map((leg) => leg.routeShortName),
    ['LOWWALK'],
    'Balanced routing must select the later one-seat route with the shorter egress walk.',
  )
  assert.equal(
    balancedOneBoardingPlan.diagnostics.algorithm,
    'rust_exact_connection_scan_bounded_pareto_no_heuristic',
  )
  assert.equal(balancedOneBoardingPlan.diagnostics.paretoCertification?.status, 'passed')
  assert.equal(balancedOneBoardingPlan.diagnostics.paretoCertification?.candidateBoardings, 1)
  assert.equal(balancedOneBoardingPlan.diagnostics.paretoCertification?.certifiedBoardings, 1)
  const oneBoardingSelection = balancedOneBoardingPlan.diagnostics.balancedGeneralizedSelection
  assert.equal(oneBoardingSelection?.selectedRole, 'nondominated_generalized_cost')
  assert(
    oneBoardingSelection.terminalCandidatesEvaluated > 1,
    'The one-boarding certifier must evaluate more than the scalar terminal witness.',
  )
  assert(
    oneBoardingSelection.selected.arrivalSeconds
      > oneBoardingSelection.earliestArrivalWitness.arrivalSeconds,
    'The balanced selection must be later than the exact earliest-arrival witness.',
  )
  assert(
    oneBoardingSelection.selected.walkingSeconds
      < oneBoardingSelection.earliestArrivalWitness.walkingSeconds,
    'The balanced selection must reduce walking relative to the earliest witness.',
  )
  assert(
    oneBoardingSelection.selected.generalizedSeconds
      < oneBoardingSelection.earliestArrivalWitness.generalizedSeconds,
    'The lower-walking one-seat route must improve balanced generalized cost.',
  )

  const productionSource = await fs.readFile(
    path.join(import.meta.dirname, '..', 'src', 'server', 'national-gtfs-store.mjs'),
    'utf8',
  )
  for (const retiredControl of ['__kernelHeuristic', '__kernelExhaustiveTraversal', '__k5EvidenceCorridor']) {
    assert.equal(
      productionSource.includes(retiredControl),
      false,
      `Production routing retained retired control ${retiredControl}.`,
    )
  }

  process.stdout.write(JSON.stringify({
    check: 'national-kernel-certification',
    status: 'passed',
    engine: prepared.engine,
    nativeMemoryBudget: prepared.nativeMemoryBudget,
    threeRideRoutes: threeRidePlan.legs
      .filter((leg) => leg.type === 'ride')
      .map((leg) => leg.routeShortName),
    twoRideRoutes: twoRidePlan.legs
      .filter((leg) => leg.type === 'ride')
      .map((leg) => leg.routeShortName),
    balancedTerminalCandidates:
      balancedPlan.diagnostics.balancedGeneralizedSelection?.terminalCandidatesEvaluated,
    oneBoardingBalancedTradeoff: {
      fastestRoute: fastestOneBoardingPlan.legs
        .filter((leg) => leg.type === 'ride')
        .map((leg) => leg.routeShortName),
      balancedRoute: balancedOneBoardingPlan.legs
        .filter((leg) => leg.type === 'ride')
        .map((leg) => leg.routeShortName),
      selection: oneBoardingSelection,
    },
    retiredControlSurfaceAbsent: true,
  }, null, 2) + '\n')
} finally {
  disposeNationalGtfsStore(routingStorePath)
  disposeNationalOsmStore(streetStorePath)
  await fs.rm(folder, { recursive: true, force: true })
}
