import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildNationalOsmWalkStore, disposeNationalOsmStore } from '../src/server/national-osm-store.mjs'
import { disposeNativeRoutingKernel } from '../src/server/native-routing-kernel.mjs'

const size = 14
const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-surface-reuse-'))
const store = path.join(folder, 'street.sqlite')
const point = (x, y) => [-71 + x * 0.0005, 42 + y * 0.0005]
function writeGraph() {
  const db = new DatabaseSync(store)
  db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE walk_nodes(node_id INTEGER PRIMARY KEY,lat REAL NOT NULL,lon REAL NOT NULL);
    CREATE TABLE edges(from_node INTEGER NOT NULL,to_node INTEGER NOT NULL,distance_m REAL NOT NULL,way_id INTEGER NOT NULL);
    CREATE TABLE drive_nodes(node_id INTEGER PRIMARY KEY,lat REAL NOT NULL,lon REAL NOT NULL);
    CREATE TABLE drive_edges(from_node INTEGER,to_node INTEGER,distance_m REAL,travel_time_s REAL,way_id INTEGER,road_class INTEGER);
    CREATE INDEX walk_nodes_lat_lon ON walk_nodes(lat,lon);
    CREATE INDEX edges_from ON edges(from_node); CREATE INDEX edges_to ON edges(to_node);
    CREATE INDEX drive_nodes_lat_lon ON drive_nodes(lat,lon);
    CREATE INDEX drive_edges_from ON drive_edges(from_node); CREATE INDEX drive_edges_to ON drive_edges(to_node);
    INSERT INTO metadata VALUES ('schemaVersion','"vigo.street.store.v6"'),('sourceModel','"pbf"'),('storageLayout','"walk-drive-role-tables-v2"'); BEGIN;`)
  const node = db.prepare('INSERT INTO walk_nodes VALUES (?,?,?)')
  const edge = db.prepare('INSERT INTO edges VALUES (?,?,?,?)')
  let edges = 0
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const id = y * size + x, [lon, lat] = point(x, y)
    node.run(id, lat, lon)
    for (const [dx, dy, distance] of [[1, 0, 41.3], [0, 1, 55.7]]) {
      if (x + dx >= size || y + dy >= size) continue
      // Directed streets and a disconnected island exercise non-Euclidean reach.
      if (x === size - 3 && dx === 1) continue
      const to = id + dx + dy * size
      edge.run(id, to, distance, ++edges)
      if ((x + y) % 4 !== 0) edge.run(to, id, distance, ++edges)
    }
  }
  db.prepare('INSERT INTO metadata VALUES (?,?)').run('nodeCount', String(size * size))
  db.prepare('INSERT INTO metadata VALUES (?,?)').run('edgeCount', String(edges))
  db.exec('COMMIT'); db.close()
  assert.equal(buildNationalOsmWalkStore(store, { force: true, persist: true }).ready, true)
}
try {
  writeGraph()
  // The JavaScript street-surface wrapper was removed; only the fixture build is checked here.
  console.log('Scenario street surface fixture: walk store build passed.')
} finally {
  disposeNativeRoutingKernel(store); disposeNationalOsmStore(store)
  await fs.rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
