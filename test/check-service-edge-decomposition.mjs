import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import JSZip from 'jszip'
import { buildNationalGtfsStore } from '../src/server/national-gtfs-store.mjs'
import {
  buildNationalOsmDriveStore,
  buildNationalOsmWalkStore,
  compactNationalOsmRuntimeStore,
  disposeNationalOsmStore,
} from '../src/server/national-osm-store.mjs'
import { buildServiceEdgeDecomposition } from '../src/server/service-decomposition.mjs'

// Resident street indexes retain native memory maps until process exit.
// Let the parent remove the fixture only after the worker releases them.
if (process.argv[2] !== '--worker') {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-service-edge-'))
  try {
    execFileSync(process.execPath, [import.meta.filename, '--worker', folder], { stdio: 'inherit' })
  } finally {
    await fs.rm(folder, { recursive: true, force: true })
  }
} else {
  await checkServiceEdges(process.argv[3])
}

async function writeFeed(filePath, routeId, shapeId) {
  const zip = new JSZip()
  zip.file('stops.txt', [
    'stop_id,stop_name,stop_lat,stop_lon,location_type',
    'A,Stop A,47.0000,8.0000,0',
    'B,Stop B,47.0000,8.0050,0',
    'C,Stop C,47.0000,8.0100,0',
  ].join('\n'))
  zip.file('routes.txt', [
    'route_id,route_short_name,route_long_name,route_type',
    `${routeId},${routeId},Test line,3`,
  ].join('\n'))
  zip.file('trips.txt', [
    'route_id,service_id,trip_id,direction_id,shape_id',
    `${routeId},S,trip-1,0,${shapeId}`,
  ].join('\n'))
  zip.file('stop_times.txt', [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    'trip-1,08:00:00,08:00:00,A,1',
    'trip-1,08:05:00,08:05:00,B,2',
    'trip-1,08:10:00,08:10:00,C,3',
  ].join('\n'))
  zip.file('shapes.txt', [
    'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence',
    `${shapeId},47.0000,8.0000,1`,
    `${shapeId},47.0000,8.0050,2`,
    `${shapeId},47.0000,8.0100,3`,
  ].join('\n'))
  zip.file('calendar_dates.txt', [
    'service_id,date,exception_type',
    'S,20260720,1',
  ].join('\n'))
  await fs.writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }))
}

async function checkServiceEdges(folder) {
  const baselineZip = path.join(folder, 'baseline.zip')
  const comparisonZip = path.join(folder, 'comparison.zip')
  const baselineStore = path.join(folder, 'baseline.sqlite')
  const comparisonStore = path.join(folder, 'comparison.sqlite')
  const streetStore = path.join(folder, 'street.sqlite')
  await writeFeed(baselineZip, 'R1', 'shape-1')
  await writeFeed(comparisonZip, 'R99', 'shape-99')
  await buildNationalGtfsStore({ zipPath: baselineZip, outputPath: baselineStore })
  await buildNationalGtfsStore({ zipPath: comparisonZip, outputPath: comparisonStore })

  const street = new DatabaseSync(streetStore)
  street.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
    CREATE INDEX walk_nodes_lat_lon ON walk_nodes(lat,lon);
    CREATE INDEX edges_from ON edges(from_node);
    CREATE INDEX drive_nodes_lat_lon ON drive_nodes(lat,lon);
    CREATE INDEX drive_edges_from ON drive_edges(from_node);
    INSERT INTO metadata VALUES('schemaVersion', '"vigo.street.store.v3"');
    INSERT INTO metadata VALUES('sourceModel', '"pbf"');
    INSERT INTO metadata VALUES('sourceFingerprint', '"fixture"');
    INSERT INTO metadata VALUES('storageLayout', '"walk-drive-role-tables-v2"');
    INSERT INTO metadata VALUES('driveNodeStorage', '"walk-shared-plus-drive-only-v1"');
    INSERT INTO metadata VALUES('driveIndexState', '"ready"');
    INSERT INTO metadata VALUES('nodeCount', '3');
    INSERT INTO metadata VALUES('walkNodeCount', '3');
    INSERT INTO metadata VALUES('edgeCount', '4');
    INSERT INTO metadata VALUES('driveNodeCount', '3');
    INSERT INTO metadata VALUES('driveEdgeCount', '4');
    INSERT INTO metadata VALUES('drivingWeightModel', '"osm-maxspeed-or-highway-default-free-flow-seconds-v1"');
    INSERT INTO metadata VALUES('roadClassCatalog', '["residential"]');
    INSERT INTO walk_nodes VALUES
      (1,47.0000,8.0000),(2,47.0000,8.0050),(3,47.0000,8.0100);
    INSERT INTO edges VALUES
      (1,2,380,11),(2,1,380,11),(2,3,380,12),(3,2,380,12);
    INSERT INTO drive_edges VALUES
      (1,2,380,30,11,1),(2,1,380,30,11,1),
      (2,3,380,30,12,1),(3,2,380,30,12,1);
  `)
  street.close()
  assert.equal(buildNationalOsmWalkStore(streetStore, { force: true, persist: true }).ready, true)
  assert.equal(buildNationalOsmDriveStore(streetStore, { force: true, persist: true, prepareNative: false }).ready, true)
  assert.equal(compactNationalOsmRuntimeStore(streetStore, { requireDrive: true }).storageLayout, 'runtime-snapshots-v1')
  disposeNationalOsmStore(streetStore)

  const result = buildServiceEdgeDecomposition({
    baselineStorePath: baselineStore,
    comparisonStorePath: comparisonStore,
    streetStorePath: streetStore,
  })
  assert.equal(result.schemaVersion, 'vigo.service-edge-decomposition.v1')
  assert.equal(result.representation, 'directed_osm_drive_edge')
  assert.equal(result.diagnostics.routeIdentifierIndependent, true)
  assert.equal(result.diagnostics.matching.baseline.matched, 1)
  assert.equal(result.diagnostics.matching.comparison.matched, 1)
  assert.equal(result.featureCollection.features.length, 2)
  assert(result.featureCollection.features.every((feature) => feature.properties.serviceIndicator === 2))
  assert(result.featureCollection.features.every((feature) => feature.properties.baseTripCount === 1))
  assert(result.featureCollection.features.every((feature) => feature.properties.comparisonTripCount === 1))
  console.log('service edge decomposition checks passed')
}
