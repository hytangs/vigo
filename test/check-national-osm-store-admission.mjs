import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  disposeNationalOsmStore,
  nationalOsmStoreDiagnostics,
} from '../src/server/national-osm-store.mjs'

const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-osm-admission-'))
const storePath = path.join(folder, 'street.sqlite')

function buildFixture() {
  const db = new DatabaseSync(storePath)
  db.exec(`
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
    CREATE INDEX drive_edges_from ON drive_edges(from_node);
    INSERT INTO metadata VALUES
      ('schemaVersion', '"vigo.street.store.v4"'),
      ('sourceModel', '"pbf"'),
      ('storageLayout', '"walk-drive-role-tables-v2"'),
      ('driveNodeStorage', '"walk-shared-plus-drive-only-v1"'),
      ('driveIndexState', '"ready"'),
      ('nodeCount', '2'),
      ('edgeCount', '2'),
      ('driveNodeCount', '2'),
      ('driveEdgeCount', '2');
    INSERT INTO walk_nodes VALUES(1,42.0,-71.0),(2,42.0,-70.999);
    INSERT INTO edges VALUES(1,2,82,1),(2,1,82,1);
    INSERT INTO drive_nodes VALUES(1,42.0,-71.0),(2,42.0,-70.999);
    INSERT INTO drive_edges VALUES
      (1,2,82,6,1,1),
      (2,1,82,6,1,1);
  `)
  db.close()
}

async function mutatedCopy(name, sql) {
  const copyPath = path.join(folder, `${name}.sqlite`)
  await fs.copyFile(storePath, copyPath)
  const db = new DatabaseSync(copyPath)
  db.exec(sql)
  db.close()
  return copyPath
}

function assertAdmissionRejected(candidatePath, reason) {
  disposeNationalOsmStore(candidatePath)
  assert.throws(
    () => nationalOsmStoreDiagnostics(candidatePath),
    (error) => {
      assert.equal(error?.code, 'VIGO_STREET_STORE_ADMISSION_FAILED')
      assert.equal(error?.reason, reason)
      assert.match(error.message, /Rebuild the street index from the source OSM PBF/)
      return true
    },
  )
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}

try {
  buildFixture()
  const diagnostics = nationalOsmStoreDiagnostics(storePath)
  assert.equal(diagnostics.storeAdmission.status, 'admitted')
  assert.equal(diagnostics.storeAdmission.schemaVersion, 'vigo.street.store.v4')
  assert.equal(diagnostics.storeAdmission.sourceModel, 'pbf')
  assert.equal(diagnostics.storeAdmission.requiredTableCount, 5)
  assert.equal(diagnostics.storeAdmission.requiredIndexCount, 3)
  disposeNationalOsmStore(storePath)

  assertAdmissionRejected(
    await mutatedCopy('wrong-version', "UPDATE metadata SET value='\"vigo.street.store.v0\"' WHERE key='schemaVersion';"),
    'schema_version_mismatch',
  )
  assertAdmissionRejected(
    await mutatedCopy('stale-private-access-semantics', "UPDATE metadata SET value='\"vigo.street.store.v3\"' WHERE key='schemaVersion';"),
    'schema_version_mismatch',
  )
  assertAdmissionRejected(
    await mutatedCopy('json-source', "UPDATE metadata SET value='\"json\"' WHERE key='sourceModel';"),
    'source_model_mismatch',
  )
  assertAdmissionRejected(
    await mutatedCopy('missing-drive-nodes', 'DROP TABLE drive_nodes;'),
    'required_table_missing',
  )
  assertAdmissionRejected(
    await mutatedCopy('missing-index', 'DROP INDEX edges_from;'),
    'required_index_missing',
  )
  const missingPath = path.join(folder, 'missing.sqlite')
  assertAdmissionRejected(missingPath, 'sqlite_open_failed')
  await assert.rejects(fs.stat(missingPath), (error) => error?.code === 'ENOENT')

  const admissionSamples = []
  for (let sample = 0; sample < 25; sample += 1) {
    disposeNationalOsmStore(storePath)
    admissionSamples.push(nationalOsmStoreDiagnostics(storePath).storeAdmission.admissionMs)
  }
  disposeNationalOsmStore(storePath)
  console.log(JSON.stringify({
    status: 'passed',
    requiredObjectsPresent: true,
    authoritativeConnection: 'read_only',
    rejectionReasons: [
      'wrong_version',
      'stale_private_access_semantics',
      'json_source_model',
      'missing_table',
      'missing_index',
      'missing_file_no_create',
    ],
    admissionSamples: admissionSamples.length,
    admissionMs: {
      min: Math.min(...admissionSamples),
      p50: percentile(admissionSamples, 0.5),
      p95: percentile(admissionSamples, 0.95),
      max: Math.max(...admissionSamples),
    },
    integrityScanOnOpen: false,
  }, null, 2))
} finally {
  disposeNationalOsmStore(storePath)
  await fs.rm(folder, { recursive: true, force: true })
}
