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
  prepareNationalGtfsStore,
} from '../server/national-gtfs-store.mjs'

const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-store-admission-'))
const zipPath = path.join(folder, 'fixture.zip')
const storePath = path.join(folder, 'fixture.sqlite')

function csv(lines) {
  return `${lines.join('\n')}\n`
}

async function buildFixture() {
  const zip = new JSZip()
  zip.file('stops.txt', csv([
    'stop_id,stop_name,stop_lat,stop_lon,location_type',
    'O,Origin,42.3500,-71.0600,0',
    'D,Destination,42.3600,-71.0500,0',
  ]))
  zip.file('routes.txt', csv([
    'route_id,route_short_name,route_long_name,route_type',
    'R,R,Admission fixture,3',
  ]))
  zip.file('trips.txt', csv([
    'route_id,service_id,trip_id,direction_id',
    'R,S,T,0',
  ]))
  zip.file('stop_times.txt', csv([
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    'T,08:00:00,08:00:00,O,1',
    'T,08:10:00,08:10:00,D,2',
  ]))
  zip.file('calendar_dates.txt', csv([
    'service_id,date,exception_type',
    'S,20260717,1',
  ]))
  await fs.writeFile(zipPath, await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  }))
  await buildNationalGtfsStore({ zipPath, outputPath: storePath })
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
  disposeNationalGtfsStore(candidatePath)
  assert.throws(
    () => prepareNationalGtfsStore(candidatePath),
    (error) => {
      assert.equal(error?.code, 'VIGO_ROUTING_STORE_ADMISSION_FAILED')
      assert.equal(error?.reason, reason)
      assert.match(error.message, /Rebuild the routing store from the source GTFS/)
      return true
    },
  )
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}

try {
  await buildFixture()

  const prepared = prepareNationalGtfsStore(storePath)
  assert.deepEqual(prepared.storeAdmission, {
    status: 'admitted',
    schemaVersion: 'vigo.routing.store.v1',
    requiredTableCount: 14,
    requiredIndexCount: 13,
    departureIndexState: 'ready',
    metadataRows: prepared.storeAdmission.metadataRows,
    metadataBudgetBytes: 4 * 1024 * 1024,
    admissionMs: prepared.storeAdmission.admissionMs,
    integrityScan: 'not_run_on_open',
    authoritativeConnection: 'read_only',
    temporaryState: 'connection_local',
  })
  assert(Number.isFinite(prepared.storeAdmission.admissionMs))

  // Service activation inserts into TEMP.active_services on the same read-only
  // connection. A nonzero count proves this request-local write path remains
  // operational after the main database was made immutable.
  const routingContext = prepareNationalGtfsRoutingContext(storePath, {
    serviceDate: '2026-07-17',
    serviceDay: 'friday',
  })
  assert.equal(routingContext.activeServices, 1)
  disposeNationalGtfsStore(storePath)

  // Confirm the underlying SQLite invariant independently: TEMP remains
  // writable, while the authoritative main database rejects mutation.
  const readOnly = new DatabaseSync(storePath, { readOnly: true })
  readOnly.exec('CREATE TEMP TABLE admission_probe(value INTEGER); INSERT INTO admission_probe VALUES(1);')
  assert.equal(readOnly.prepare('SELECT value FROM admission_probe').get().value, 1)
  assert.throws(
    () => readOnly.exec("UPDATE metadata SET value='\"tampered\"' WHERE key='schemaVersion'"),
    /readonly database/,
  )
  readOnly.close()

  const wrongVersionPath = await mutatedCopy(
    'wrong-version',
    "UPDATE metadata SET value='\"vigo.routing.store.v0\"' WHERE key='schemaVersion';",
  )
  assertAdmissionRejected(wrongVersionPath, 'schema_version_mismatch')

  const staleV1Path = await mutatedCopy('stale-v1', 'DROP TABLE stop_modes;')
  assertAdmissionRejected(staleV1Path, 'required_table_missing')

  const malformedColumnsPath = await mutatedCopy(
    'malformed-columns',
    'ALTER TABLE stops RENAME COLUMN platform_code TO platform;',
  )
  assertAdmissionRejected(malformedColumnsPath, 'table_schema_mismatch')

  const missingIndexPath = await mutatedCopy('missing-index', 'DROP INDEX trips_service;')
  assertAdmissionRejected(missingIndexPath, 'required_index_missing')

  const malformedIndexPath = await mutatedCopy(
    'malformed-index',
    'DROP INDEX trips_service; CREATE INDEX trips_service ON trips(trip_id);',
  )
  assertAdmissionRejected(malformedIndexPath, 'index_columns_mismatch')

  const malformedMetadataPath = await mutatedCopy(
    'malformed-metadata',
    "UPDATE metadata SET value='not-json' WHERE key='storeId';",
  )
  assertAdmissionRejected(malformedMetadataPath, 'metadata_malformed')

  const oversizedMetadataPath = await mutatedCopy(
    'oversized-metadata',
    "UPDATE metadata SET value=hex(zeroblob(600000)) WHERE key='storeId';",
  )
  assertAdmissionRejected(oversizedMetadataPath, 'metadata_budget_exceeded')

  const missingPath = path.join(folder, 'does-not-exist.sqlite')
  assertAdmissionRejected(missingPath, 'sqlite_open_failed')
  await assert.rejects(fs.stat(missingPath), (error) => error?.code === 'ENOENT')

  const admissionSamples = []
  for (let sample = 0; sample < 25; sample += 1) {
    disposeNationalGtfsStore(storePath)
    admissionSamples.push(prepareNationalGtfsStore(storePath).storeAdmission.admissionMs)
  }
  disposeNationalGtfsStore(storePath)

  console.log(JSON.stringify({
    status: 'passed',
    currentBuilderStoreAdmitted: true,
    authoritativeConnection: 'read_only',
    temporaryActiveServices: 'writable',
    rejectionContracts: [
      'wrong_version',
      'stale_v1_table_set',
      'malformed_table_columns',
      'missing_index',
      'malformed_index',
      'malformed_metadata',
      'oversized_metadata',
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
  disposeNationalGtfsStore(storePath)
  await fs.rm(folder, { recursive: true, force: true })
}
