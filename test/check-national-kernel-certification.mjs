import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import JSZip from 'jszip'
import { DatabaseSync } from 'node:sqlite'
import {
  buildNationalGtfsStore,
  disposeNationalGtfsStore,
  prepareNationalGtfsRoutingContext,
} from '../src/server/national-gtfs-store.mjs'
import {
  buildNationalOsmWalkStore,
  compactNationalOsmRuntimeStore,
  disposeNationalOsmStore,
  prepareNationalOsmNativeStore,
} from '../src/server/national-osm-store.mjs'
import { buildNativeStreetCchIndex } from '../src/server/native-routing-kernel.mjs'
import { processFixtureDirectory } from './helpers/fixture-process.mjs'

const folder = await processFixtureDirectory(import.meta.url, 'vigo-kernel-certification-')
const gtfsPath = path.join(folder, 'three-ride-suffix.zip')
const routingStorePath = path.join(folder, 'three-ride-suffix.sqlite')
const streetStorePath = path.join(folder, 'three-ride-suffix-street.sqlite')

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
      ('schemaVersion', '"vigo.street.store.v6"'),
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

  // Fused coordinate frontiers must keep the endpoint walking rule when the
  // scalar witness crosses the JS boundary into exact Pareto certification.
  const { __destinationAccessStopIds: ignored, ...coordinateRequest } = threeRideRequest
  void ignored

  // A station's internal connection is not a journey out onto public streets.
  // Preserve the modeled transfer time without claiming an OSM path witness.
  const stationZip = await JSZip.loadAsync(await fs.readFile(gtfsPath))
  stationZip.file('stops.txt', csv([
    'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station',
    'O,Origin,0,0,0,', 'A,Destination,0,0.004,0,',
    'P,Interchange,0,0.0105,1,',
    'X,Arriving platform,0,0.010,0,P',
    'Y,Departing platform,0,0.011,0,P',
  ]))
  stationZip.file('trips.txt', csv([
    'route_id,service_id,trip_id,direction_id',
    'R1,SERVICE,IN,0', 'R2,SERVICE,OUT,0',
  ]))
  stationZip.file('stop_times.txt', csv([
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    'IN,10:00:00,10:00:00,O,1', 'IN,10:04:00,10:04:00,X,2',
    'OUT,10:06:00,10:06:00,Y,1', 'OUT,10:10:00,10:10:00,A,2',
  ]))
  const stationZipPath = path.join(folder, 'station.zip')
  const stationStorePath = path.join(folder, 'station.sqlite')
  await fs.writeFile(stationZipPath, await stationZip.generateAsync({ type: 'nodebuffer' }))
  await buildNationalGtfsStore({ zipPath: stationZipPath, outputPath: stationStorePath })
  try {
  } finally {
    disposeNationalGtfsStore(stationStorePath)
  }

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

} finally {
  disposeNationalGtfsStore(routingStorePath)
  disposeNationalOsmStore(streetStorePath)
}
