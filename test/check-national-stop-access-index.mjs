import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import {
  buildRoutingStoreFromSchedules,
  disposeNationalGtfsStore,
  inspectNationalGtfsAccessCandidates,
  prepareNationalGtfsStore,
  prepareNationalGtfsNativeCoordinateAccess,
  prepareNationalGtfsRoutingReadiness,
  prepareNationalGtfsRoutingContext,
  routeNationalGtfsStore,
} from '../src/server/national-gtfs-store.mjs'
import {
  buildNationalOsmWalkStore,
  compactNationalOsmRuntimeStore,
  disposeNationalOsmStore,
  streetPathBetween,
} from '../src/server/national-osm-store.mjs'
import { buildNativeStreetCchIndex, disposeNativeRoutingKernel } from '../src/server/native-routing-kernel.mjs'

const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-stop-access-index-'))
const schedulePath = path.join(folder, 'schedule.json')
const storePath = path.join(folder, 'routing.sqlite')
const streetPath = path.join(folder, 'street.sqlite')
const usefulPrimaryStreetPath = path.join(folder, 'street-useful-primary.sqlite')
const scope = 'crowded'
const scoped = (id) => `${scope}\u001f${id}`
const origin = [0, 0]
const reachableCoordinate = [0.0085, 0]
const transferLinkedRailCoordinate = [0.0095, 0]
const colocatedStationCoordinate = [0.03, 0]
const maxWalkKm = 1.2

const disconnectedCoordinates = []
for (let x = -5; x <= 5; x += 1) {
  for (let y = -5; y <= 5; y += 1) {
    const lon = x * 0.0011
    const lat = y * 0.0011
    const radius = Math.hypot(lon, lat)
    if (radius < 0.0024 || radius > 0.0065) continue
    disconnectedCoordinates.push([lon, lat])
  }
}
disconnectedCoordinates.sort((left, right) => Math.hypot(...left) - Math.hypot(...right) || left[0] - right[0] || left[1] - right[1])
disconnectedCoordinates.length = 40

const busAccessStops = disconnectedCoordinates.map((coordinate, index) => ({
  id: `X${String(index).padStart(2, '0')}`,
  name: `Disconnected ${index}`,
  lat: coordinate[1],
  lon: coordinate[0],
}))
busAccessStops.push({ id: 'R', name: 'First reachable stop', lat: reachableCoordinate[1], lon: reachableCoordinate[0] })
const accessStops = [
  ...busAccessStops,
  { id: 'RS', name: 'Transfer-linked rail station', lat: transferLinkedRailCoordinate[1], lon: transferLinkedRailCoordinate[0], locationType: 1 },
  { id: 'RSP', name: 'Transfer-linked rail station', lat: transferLinkedRailCoordinate[1], lon: transferLinkedRailCoordinate[0], parentStationId: 'RS' },
  { id: 'CS', name: 'Coordinate-only rail station', lat: colocatedStationCoordinate[1], lon: colocatedStationCoordinate[0], locationType: 1 },
  { id: 'CSP', name: 'Coordinate-only rail station', lat: colocatedStationCoordinate[1], lon: colocatedStationCoordinate[0], parentStationId: 'CS' },
]
const deadEndStops = busAccessStops
  .filter((stop) => stop.id !== 'R')
  .map((stop, index) => ({ id: `Z${String(index).padStart(2, '0')}`, name: `Dead end ${index}`, lat: 0.1, lon: index * 0.0001 }))
const scheduledTrips = busAccessStops.map((stop, index) => ({
  tripId: `T${String(index).padStart(2, '0')}`,
  serviceId: 'WK',
  serviceDays: ['weekday'],
  stopTimes: [
    { stopId: stop.id, sequence: 1, arrivalMinutes: 480 + index, departureMinutes: 480 + index },
    {
      stopId: stop.id === 'R' ? 'D' : `Z${String(index).padStart(2, '0')}`,
      sequence: 2,
      arrivalMinutes: 500 + index,
      departureMinutes: 500 + index,
    },
  ],
}))
const schedule = {
  stops: [...accessStops, ...deadEndStops, { id: 'D', name: 'Destination', lat: 0, lon: 0.02 }],
  transferRules: [
    { fromStopId: 'R', toStopId: 'RS', transferType: 2, minTransferTimeSeconds: 180 },
    { fromStopId: 'RS', toStopId: 'R', transferType: 2, minTransferTimeSeconds: 180 },
  ],
  routes: [{
    routeId: 'B', shortName: 'B', longName: 'Fixture bus', routeType: 3, scheduledTrips,
  }, {
    routeId: 'S21', shortName: 'S21', longName: 'Nearby rail', routeType: 2,
    scheduledTrips: [{
      tripId: 'S21-direct', serviceId: 'WK', serviceDays: ['weekday'],
      stopTimes: [
        { stopId: 'RSP', sequence: 1, arrivalMinutes: 510, departureMinutes: 510 },
        { stopId: 'D', sequence: 2, arrivalMinutes: 520, departureMinutes: 520 },
      ],
    }, {
      tripId: 'S21-coordinate-only', serviceId: 'WK', serviceDays: ['weekday'],
      stopTimes: [
        { stopId: 'CSP', sequence: 1, arrivalMinutes: 540, departureMinutes: 540 },
        { stopId: 'D', sequence: 2, arrivalMinutes: 550, departureMinutes: 550 },
      ],
    }],
  }],
}

try {
  await fs.writeFile(schedulePath, `${JSON.stringify(schedule)}\n`)
  await buildRoutingStoreFromSchedules({
    schedules: [{ feedId: scope, schedulePath }],
    outputPath: storePath,
  })

  const street = new DatabaseSync(streetPath)
  street.exec(`
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
    CREATE INDEX drive_nodes_lat_lon ON drive_nodes(lat, lon);
    CREATE INDEX drive_edges_from ON drive_edges(from_node);
    CREATE INDEX drive_edges_to ON drive_edges(to_node);
    INSERT INTO metadata VALUES
      ('schemaVersion', '"vigo.street.store.v4"'),
      ('sourceModel', '"pbf"'),
      ('nodeCount', '43'),
      ('edgeCount', '2'),
      ('driveNodeCount', '0'),
      ('driveEdgeCount', '0'),
      ('storageLayout', '"walk-drive-role-tables-v2"'),
      ('driveNodeStorage', '"walk-shared-plus-drive-only-v1"'),
      ('driveIndexState', '"ready"');
    INSERT INTO nodes VALUES(1, 0, 0), (2, 0, 0.0085), (500, 0, 0.0095);
    INSERT INTO walk_nodes VALUES(1, 0, 0), (2, 0, 0.0085), (500, 0, 0.0095);
    INSERT INTO edges VALUES(1, 2, 950, 1), (2, 1, 950, 1);
    INSERT INTO drive_nodes VALUES(1, 0, 0), (2, 0, 0.0085);
    INSERT INTO drive_edges VALUES
      (1, 2, 950, 90, 1, 1),
      (2, 1, 950, 90, 1, 1);
  `)
  const insertNode = street.prepare('INSERT INTO walk_nodes VALUES(?,?,?)')
  const insertAllNode = street.prepare('INSERT INTO nodes VALUES(?,?,?)')
  disconnectedCoordinates.forEach((coordinate, index) => {
    insertNode.run(100 + index, coordinate[1], coordinate[0])
    insertAllNode.run(100 + index, coordinate[1], coordinate[0])
  })
  street.close()
  await fs.copyFile(streetPath, usefulPrimaryStreetPath)
  const usefulPrimaryStreet = new DatabaseSync(usefulPrimaryStreetPath)
  const firstDisconnectedDistanceM = Math.max(1, Math.round(Math.hypot(...disconnectedCoordinates[0]) * 111_000))
  usefulPrimaryStreet.prepare('INSERT INTO edges VALUES(?,?,?,?)').run(1, 100, firstDisconnectedDistanceM, 2)
  usefulPrimaryStreet.prepare('INSERT INTO edges VALUES(?,?,?,?)').run(100, 1, firstDisconnectedDistanceM, 2)
  usefulPrimaryStreet.prepare('UPDATE metadata SET value=? WHERE key=?').run('4', 'edgeCount')
  usefulPrimaryStreet.close()
  const streetPreparation = buildNationalOsmWalkStore(streetPath, { force: true })
  assert.equal(streetPreparation.ready, true)
  const usefulPrimaryPreparation = buildNationalOsmWalkStore(usefulPrimaryStreetPath, { force: true })
  assert.equal(usefulPrimaryPreparation.ready, true)
  assert.equal(
    compactNationalOsmRuntimeStore(streetPath).storageLayout,
    'runtime-snapshots-v1',
  )
  assert.equal(
    compactNationalOsmRuntimeStore(usefulPrimaryStreetPath).storageLayout,
    'runtime-snapshots-v1',
  )
  disposeNationalOsmStore(streetPath)
  disposeNationalOsmStore(usefulPrimaryStreetPath)
  assert(buildNativeStreetCchIndex(streetPath).loaded.nodeCount > 0)
  assert(buildNativeStreetCchIndex(usefulPrimaryStreetPath).loaded.nodeCount > 0)

  const point = { coordinate: origin, label: 'Crowded map point', source: 'map' }
  const primary = inspectNationalGtfsAccessCandidates(storePath, point, { maxWalkKm, limit: 12 })
  assert.equal(primary.candidates.some((candidate) => candidate.stopId === scoped('R')), false,
    'The geometric inspection control must reproduce the crowded-stop miss without an OSM frontier.')

  const startedAt = performance.now()
  const recovered = inspectNationalGtfsAccessCandidates(storePath, point, {
    maxWalkKm,
    limit: 12,
    streetStorePath: streetPath,
  })
  const wallMs = performance.now() - startedAt
  const reachable = recovered.candidates.find((candidate) => candidate.stopId === scoped('R'))
  assert(reachable, 'The complete OSM frontier must expose every street-reachable in-budget stop.')
  const transferLinkedRail = recovered.candidates.find((candidate) => candidate.stopId === scoped('RSP'))
  assert(transferLinkedRail,
    'The complete native frontier must expose the nearby rail platform.')
  if (transferLinkedRail.accessTransferFromStopId !== undefined) {
    assert.equal(transferLinkedRail.accessTransferFromStopId, scoped('R'))
    assert(transferLinkedRail.accessTransferSeconds > 0 && transferLinkedRail.accessTransferSeconds <= 180)
  }
  assert.equal(transferLinkedRail.streetPathVerified, false,
    'A published station link is modeled separately from a verified OSM path.')
  assert.equal(reachable.accessCandidateClass, 'complete-native-directed-frontier')
  assert.equal(reachable.accessSearchComplete, true)
  assert.equal(recovered.diagnostics.completeStreetAccessFrontier, true)
  assert(recovered.candidates.every((candidate) => candidate.distanceKm <= maxWalkKm),
    'Complete access must not relax the selected walking budget.')
  assert(wallMs < 1_000, `Complete access inspection took ${wallMs.toFixed(3)} ms.`)
  const zeroLengthPath = streetPathBetween(streetPath, origin, origin, maxWalkKm)
  assert.equal(zeroLengthPath?.distanceKm, 0)
  assert.equal(zeroLengthPath?.exactCoordinateIdentity, true)
  assert.deepEqual(zeroLengthPath?.coordinates, [origin, origin])

  const colocated = inspectNationalGtfsAccessCandidates(storePath, {
    coordinate: colocatedStationCoordinate,
    label: 'Coordinate-only rail station',
    source: 'map',
  }, {
    maxWalkKm,
    streetStorePath: streetPath,
    accessRole: 'origin',
  })
  const colocatedPlatform = colocated.candidates.find(
    (candidate) => candidate.stopId === scoped('CSP'),
  )
  assert(colocatedPlatform,
    'An exact station-coordinate identity must survive when the station centroid cannot snap to OSM.')
  assert.equal(colocatedPlatform.distanceKm, 0)
  assert.equal(colocatedPlatform.exactStopAccess, true)
  assert.equal(colocatedPlatform.accessCandidateClass, 'exact-coordinate-colocation')
  assert.equal(colocatedPlatform.accessSearchComplete, true)
  const colocatedPlan = routeNationalGtfsStore(storePath, {
    origin: {
      coordinate: colocatedStationCoordinate,
      label: 'Coordinate-only rail station',
      source: 'map',
    },
    destination: {
      coordinate: [0.02, 0],
      label: 'Destination stop',
      source: 'map',
    },
    departMinutes: 539,
    serviceDate: '2025-12-08',
    serviceDay: 'weekday',
    allowServiceDateFallback: true,
    maxWalkKm,
    horizonMinutes: 30,
    streetStorePath: streetPath,
  })
  assert.equal(colocatedPlan.status, 'ready')
  const colocatedWalkLegs = colocatedPlan.legs.filter((leg) => leg.type === 'walk')
  assert.equal(colocatedWalkLegs.length, 2)
  for (const leg of colocatedWalkLegs) {
    assert.equal(leg.durationMinutes, 0)
    assert.equal(leg.distanceKm, 0)
    assert.equal(leg.coordinates.length, 1)
    assert.deepEqual(leg.coordinates[0], leg.coordinates.at(-1))
  }

  const reachableButUselessPrimary = inspectNationalGtfsAccessCandidates(storePath, point, {
    maxWalkKm,
    limit: 12,
    streetStorePath: usefulPrimaryStreetPath,
  })
  const completeReachable = reachableButUselessPrimary.candidates.find((candidate) => candidate.stopId === scoped('R'))
  assert(completeReachable,
    'A nearer reachable but useless stop must not hide a farther useful stop from the complete frontier.')
  assert.equal(completeReachable.streetPathVerified, true)
  assert.equal(completeReachable.accessSearchComplete, true)

  const routingSource = await fs.readFile(path.join(import.meta.dirname, '..', 'src', 'server', 'national-gtfs-store.mjs'), 'utf8')
  const streetSource = await fs.readFile(path.join(import.meta.dirname, '..', 'src', 'server', 'national-osm-store.mjs'), 'utf8')
  const nativeSource = await fs.readFile(path.join(import.meta.dirname, '..', 'src', 'server', 'native-routing-kernel.mjs'), 'utf8')
  assert(!routingSource.includes('expandedAccessRetryRequest'), 'The bounded expanded-access retry must be absent.')
  assert(routingSource.includes('routeNativeCoordinateFrontiers'),
    'Coordinate access must use the complete Rust directed frontier.')
  assert(!routingSource.includes('nearestStopsSqlFallback'),
    'Coordinate access must not retain a SQL query fallback after the resident access index is admitted.')
  assert(!routingSource.includes('const destinationByStop = new Map'),
    'The removed SQL route fallback must not reappear after the resident failure boundary.')
  assert(!streetSource.includes('directThresholdKm'), 'A close straight chord must not be labeled as graph-backed OSM access.')
  assert(nativeSource.includes('streetPathVerified: !linked || linkStreetVerified !== 0'),
    'GTFS station links must not be reported as verified street geometry.')

  const preparedRouting = prepareNationalGtfsRoutingContext(storePath, {
    serviceDate: '2025-12-08',
    serviceDay: 'weekday',
    allowServiceDateFallback: true,
  })
  assert.equal(preparedRouting.activeServiceKernel.ready, true,
    'Expanded-access routing must be exercised through the production Rust kernel.')
  assert.equal(preparedRouting.accessMaterialization.ready, true)
  const timetableSnapshots = (await fs.readdir(folder))
    .filter((name) => name.startsWith('routing.sqlite.active-service-kernel.'))
    .filter((name) => name.endsWith('.bin'))
  assert(timetableSnapshots.length >= 1, 'The readiness regression requires a persisted timetable snapshot.')
  disposeNationalGtfsStore(storePath)
  const admittedReadiness = prepareNationalGtfsRoutingReadiness(storePath)
  assert.equal(admittedReadiness.ready, true)
  assert.equal(admittedReadiness.activeServiceKernel.reason, 'background_preparation')
  assert.equal(admittedReadiness.transferSemanticsAdmission.ready, false)
  assert.equal(admittedReadiness.accessMaterialization.ready, false)
  const timetableOnlyRouting = prepareNationalGtfsRoutingContext(storePath, {
    serviceDate: '2025-12-08',
    serviceDay: 'weekday',
    allowServiceDateFallback: true,
    prepareAccess: false,
    prewarmRouteGeometry: false,
    prewarmRoutingPipeline: false,
  })
  assert.equal(timetableOnlyRouting.activeServiceKernel.ready, true)
  assert.equal(timetableOnlyRouting.activeServiceKernel.persistenceState, 'loaded')
  assert.equal(timetableOnlyRouting.accessMaterialization.ready, false,
    'A persisted exact timetable must become ready before coordinate-access materialization.')
  assert.equal(timetableOnlyRouting.routeGeometry, null)
  const completedAccessMaterialization = prepareNationalGtfsStore(storePath)
  assert.equal(completedAccessMaterialization.accessMaterialization.ready, true,
    'The deferred access graph must remain available to exact routing on demand.')
  const recoveredPlan = routeNationalGtfsStore(storePath, {
    origin: point,
    destination: { coordinate: [0.02, 0], label: 'Destination stop', source: 'stop', stopId: scoped('D') },
    departMinutes: 480,
    serviceDate: '2025-12-08',
    serviceDay: 'weekday',
    allowServiceDateFallback: true,
    maxWalkKm,
    horizonMinutes: 180,
    streetStorePath: usefulPrimaryStreetPath,
  })
  assert.equal(recoveredPlan.status, 'ready', 'The exact router must see the useful stop in its first complete access search.')
  assert([recoveredPlan.diagnostics.methodUsed].flat().includes('rust_timetable_kernel'))
  assert.match(
    recoveredPlan.diagnostics.algorithm,
    /^rust_exact_connection_scan_(?:scalar|bounded_pareto)_no_heuristic$/u,
  )
  assert.equal(recoveredPlan.diagnostics.expandedStreetAccessRetry, undefined)
  assert.equal(recoveredPlan.diagnostics.coordinateAccessFrontier, 'complete_osm_reachable')
  assert.equal(recoveredPlan.diagnostics.originStreetPathVerified, false)
  assert(recoveredPlan.legs.some((leg) => leg.type === 'ride' && leg.routeShortName === 'S21' && leg.fromStopId === scoped('RSP')),
    'The direct rail boarding must dominate riding away from a nearby transfer-linked station.')
  const accessProfileSnapshots = (await fs.readdir(folder))
    .filter((name) => name.startsWith('routing.sqlite.native-access-profile.'))
    .filter((name) => name.endsWith('.bin'))
  assert(accessProfileSnapshots.length >= 1 && accessProfileSnapshots.length <= 2)
  const accessProfileSnapshot = path.join(folder, accessProfileSnapshots[0])
  assert((await fs.stat(accessProfileSnapshot)).size > 0)
  disposeNativeRoutingKernel(usefulPrimaryStreetPath)
  const reloadedAccess = prepareNationalGtfsNativeCoordinateAccess(
    storePath,
    usefulPrimaryStreetPath,
  )
  assert.equal(reloadedAccess.persistenceState, 'loaded')

  console.log(JSON.stringify({
    schemaVersion: 'vigo.national.stop-access-index.check.v1',
    status: 'passed',
    primaryCandidateCount: primary.candidates.length,
    primaryContainsReachable: false,
    recoveredCandidateCount: recovered.candidates.length,
    recoveredStopId: reachable.stopId,
    completeSecondaryRecoveredStopId: completeReachable.stopId,
    completePlanStatus: recoveredPlan.status,
    recoveryClass: reachable.accessCandidateClass,
    completeCandidateCount: recovered.candidates.length,
    maxWalkKm,
    wallMs: Number(wallMs.toFixed(3)),
    nativeAccessPersistence: reloadedAccess.persistenceState,
    readinessActiveKernelState: admittedReadiness.activeServiceKernel.reason,
    readinessTransferValidationDeferred: admittedReadiness.transferSemanticsAdmission.ready === false,
    timetableReadinessPersistence: timetableOnlyRouting.activeServiceKernel.persistenceState,
    timetableReadinessAccessDeferred: timetableOnlyRouting.accessMaterialization.ready === false,
    streetStrategy: streetPreparation.strategy,
  }, null, 2))
} finally {
  await fs.rm(folder, { recursive: true, force: true })
}
