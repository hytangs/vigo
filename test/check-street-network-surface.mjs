import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  buildNationalOsmWalkStore,
  compactNationalOsmRuntimeStore,
  disposeNationalOsmStore,
} from '../src/server/national-osm-store.mjs'

const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-street-surface-'))
const storePath = path.join(folder, 'street.sqlite')
function buildFixture() {
  const db = new DatabaseSync(storePath)
  db.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE walk_nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE edges(from_node INTEGER NOT NULL, to_node INTEGER NOT NULL, distance_m REAL NOT NULL, way_id INTEGER NOT NULL);
    CREATE INDEX walk_nodes_lat_lon ON walk_nodes(lat,lon);
    CREATE INDEX edges_from ON edges(from_node);
    CREATE INDEX edges_to ON edges(to_node);
    CREATE TABLE drive_nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE drive_edges(
      from_node INTEGER NOT NULL,
      to_node INTEGER NOT NULL,
      distance_m REAL NOT NULL,
      travel_time_s REAL NOT NULL,
      way_id INTEGER NOT NULL,
      road_class INTEGER NOT NULL
    );
    CREATE INDEX drive_nodes_lat_lon ON drive_nodes(lat,lon);
    CREATE INDEX drive_edges_from ON drive_edges(from_node);
    CREATE INDEX drive_edges_to ON drive_edges(to_node);
    INSERT INTO metadata VALUES
      ('schemaVersion', '"vigo.street.store.v6"'),
      ('sourceModel', '"pbf"'),
      ('storageLayout', '"walk-drive-role-tables-v2"'),
      ('nodeCount', '6'),
      ('edgeCount', '4');
    INSERT INTO nodes VALUES
      (1, 42.0000, -71.0000),
      (2, 42.0000, -70.9990),
      (3, 42.0010, -70.9990),
      (4, 42.0020, -70.9990),
      (5, 42.0025, -70.9985),
      (6, 42.0025, -70.9980);
    INSERT INTO walk_nodes SELECT * FROM nodes;
    INSERT INTO edges VALUES
      (1, 2, 82, 1),
      (2, 3, 111, 2),
      (3, 4, 111, 3),
      (5, 6, 42, 4);
    INSERT INTO drive_nodes SELECT * FROM nodes;
  `)
  db.close()
}

try {
  buildFixture()
  const nativeStore = buildNationalOsmWalkStore(storePath, { force: true, persist: true })
  assert.equal(nativeStore.ready, true, nativeStore.error)
  assert.equal(nativeStore.snapshotStatus, 'written')
  assert.equal(
    compactNationalOsmRuntimeStore(storePath).storageLayout,
    'runtime-snapshots-v1',
  )
  disposeNationalOsmStore(storePath)
  console.log(JSON.stringify({ ok: true, storageLayout: 'runtime-snapshots-v1' }))
} finally {
  disposeNationalOsmStore(storePath)
  await fs.rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
