import { buildScheduleFixture } from './helpers/schedule-fixture.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  disposeNationalGtfsStore,
  prepareNationalGtfsStore,
  prepareNationalGtfsNativeCoordinateAccess,
  prepareNationalGtfsRoutingReadiness,
  prepareNationalGtfsRoutingContext,
} from '../src/server/national-gtfs-store.mjs'
import {
  compactNationalOsmRuntimeStore,
  disposeNationalOsmStore,
} from '../src/server/national-osm-store.mjs'
import { buildWalkSnapshot } from './helpers/street-snapshots.mjs'
import { buildNativeStreetCchIndex, disposeNativeRoutingKernel } from '../src/server/native-routing-kernel.mjs'
import { processFixtureDirectory } from './helpers/fixture-process.mjs'

const folder = await processFixtureDirectory(import.meta.url, 'vigo-stop-access-index-')
const schedulePath = path.join(folder, 'schedule.json')
const storePath = path.join(folder, 'routing.sqlite')
const streetPath = path.join(folder, 'street.sqlite')
const usefulPrimaryStreetPath = path.join(folder, 'street-useful-primary.sqlite')
const scope = 'crowded'
const reachableCoordinate = [0.0085, 0]
const transferLinkedRailCoordinate = [0.0095, 0]
const colocatedStationCoordinate = [0.03, 0]

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
  await buildScheduleFixture({
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
      ('schemaVersion', '"vigo.street.store.v6"'),
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
  const streetPreparation = buildWalkSnapshot(streetPath)
  assert.equal(streetPreparation.ready, true)
  const usefulPrimaryPreparation = buildWalkSnapshot(usefulPrimaryStreetPath)
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

  const routingSource = await fs.readFile(path.join(import.meta.dirname, '..', 'src', 'server', 'national-gtfs-store.mjs'), 'utf8')
  const streetSource = await fs.readFile(path.join(import.meta.dirname, '..', 'src', 'server', 'national-osm-store.mjs'), 'utf8')
  assert(!routingSource.includes('expandedAccessRetryRequest'), 'The bounded expanded-access retry must be absent.')
  assert(!routingSource.includes('nearestStopsSqlFallback'),
    'Coordinate access must not retain a SQL query fallback after the resident access index is admitted.')
  assert(!routingSource.includes('const destinationByStop = new Map'),
    'The removed SQL route fallback must not reappear after the resident failure boundary.')
  assert(!streetSource.includes('directThresholdKm'), 'A close straight chord must not be labeled as graph-backed OSM access.')

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
  })
  assert.equal(timetableOnlyRouting.activeServiceKernel.ready, true)
  assert.equal(timetableOnlyRouting.activeServiceKernel.persistenceState, 'loaded')
  assert.equal(timetableOnlyRouting.accessMaterialization.ready, false,
    'A persisted exact timetable must become ready before coordinate-access materialization.')
  assert.equal(timetableOnlyRouting.routeGeometry, null)
  const completedAccessMaterialization = prepareNationalGtfsStore(storePath)
  assert.equal(completedAccessMaterialization.accessMaterialization.ready, true,
    'The deferred access graph must remain available to exact routing on demand.')
  // Preparing coordinate access persists the street profile snapshots that
  // in-process routing used to write on its first query with each street store.
  prepareNationalGtfsNativeCoordinateAccess(storePath, streetPath)
  prepareNationalGtfsNativeCoordinateAccess(storePath, usefulPrimaryStreetPath)
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
  const alternateAccess = prepareNationalGtfsNativeCoordinateAccess(storePath, streetPath)
  assert.notEqual(alternateAccess.profileKey, reloadedAccess.profileKey)
  assert.notEqual(alternateAccess.snapshotPath, reloadedAccess.snapshotPath,
    'Profiles sharing the coordinate-access version prefix must retain separate snapshots.')
  disposeNativeRoutingKernel(usefulPrimaryStreetPath)
  const retainedAccess = prepareNationalGtfsNativeCoordinateAccess(storePath, usefulPrimaryStreetPath)
  assert.equal(retainedAccess.persistenceState, 'loaded',
    'Preparing another street profile must not overwrite an existing compatible snapshot.')

} finally {
  disposeNationalGtfsStore(storePath)
  disposeNationalOsmStore(streetPath)
  disposeNationalOsmStore(usefulPrimaryStreetPath)
}
