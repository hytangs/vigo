import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { compileNativeGtfsConnections } from '../src/server/native-routing-kernel.mjs'
import { createHash } from 'node:crypto'
const baseline = JSON.parse(fs.readFileSync(new URL('./fixtures/gtfs-connections-052.json', import.meta.url))).cases
const digest = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex')
import { createRoutingStoreSchema } from '../src/server/gtfs/store-schema.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-connection-parity-'))
const tables = ['connections', 'connection_permissions', 'trips', 'trip_shapes', 'trip_details']
function contents(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()]))
  } finally { db.close() }
}
function fixture(name, { rows, trips = ['T'], frequencies = [], excluded = [] }) {
  const store = path.join(root, `${name}.sqlite`), stagePath = path.join(root, `${name}-stops.sqlite`)
  const db = new DatabaseSync(store), stage = new DatabaseSync(stagePath)
  createRoutingStoreSchema(db)
  db.exec("INSERT INTO stops VALUES('A','A',0,0,NULL,0,NULL),('B','B',0,1,NULL,0,NULL),('C','C',0,2,NULL,0,NULL)")
  for (const trip of trips) {
    db.prepare('INSERT INTO trips VALUES(?,?,?,?)').run(trip, 'R', 'D', null)
    db.prepare('INSERT INTO trip_details VALUES(?,?,?)').run(trip, 'To 车站', null)
    db.prepare('INSERT INTO trip_shapes VALUES(?,?)').run(trip, 'shape')
  }
  for (const frequency of frequencies) db.prepare('INSERT INTO frequencies VALUES(?,?,?,?,?)').run(...frequency)
  stage.exec('CREATE TABLE stop_times(trip_id TEXT,stop_sequence INTEGER,stop_id TEXT,arrival INTEGER,departure INTEGER,can_board INTEGER,can_alight INTEGER,pickup_type INTEGER,drop_off_type INTEGER); CREATE INDEX stop_times_trip_sequence ON stop_times(trip_id,stop_sequence)')
  for (const row of rows) stage.prepare('INSERT INTO stop_times VALUES(?,?,?,?,?,?,?,?,?)').run(...row, 0, 0)
  db.close(); stage.close()
  return { store, stagePath, excluded }
}
function compare(name, data, errorPattern) {
  const f = fixture(name, data), nativePath = `${f.store}.native`
  fs.copyFileSync(f.store, nativePath)
  const before = contents(nativePath)
  const runNative = () => compileNativeGtfsConnections({ storePath: nativePath, stopTimesPath: f.stagePath, excludedTripIds: f.excluded, cacheKib: 4096 })
  if (errorPattern) {
    assert.throws(runNative, errorPattern, `${name}: native rejection`)
    assert.deepEqual(contents(nativePath), before, `${name}: native failure must roll back all connections and frequency metadata`)
  } else {
    assert.deepEqual(runNative(), baseline[name].counters, `${name}: retained counters`)
    assert.equal(digest(contents(nativePath)), baseline[name].rowsSha256, `${name}: retained persisted rows`)
  }
  return { counters: baseline[name]?.counters, rows: contents(nativePath) }
}
try {
  const stop = (sequence, id, arrival, departure = arrival, board = 1, alight = 1, trip = 'T') => [trip, sequence, id, arrival, departure, board, alight]
  compare('empty', { rows: [] })
  compare('singleton', { rows: [stop(1, 'A', 0)] })
  const gap = compare('gap-and-after-midnight', { rows: [stop(4, 'C', 90060, null, 1, 0), stop(1, 'A', null, 90000, 0), stop(2, 'B', null)] })
  assert.equal(gap.counters.bridgedUntimedGapCount, 1)
  assert.deepEqual(Object.values(gap.rows.connection_permissions[0]), ['T', 1, 0, 0])
  const frequency = compare('overlapping-exact-windows', { rows: [stop(1, 'A', 100), stop(2, 'B', 120)], frequencies: [['T', 100, 160, 30, 1], ['T', 130, 190, 30, 1]] })
  assert.equal(frequency.counters.connectionCount, 4)
  assert.equal(frequency.counters.exactFrequencyExpandedTripCount, 4)
  compare('untimed-first-frequency', { rows: [stop(1, 'A', null), stop(2, 'B', 120), stop(3, 'C', 140)], frequencies: [['T', 100, 160, 30, 1]] })
  compare('excluded-inexact', { rows: [stop(1, 'A', 100), stop(2, 'B', 120)], excluded: ['T'], frequencies: [['T', 100, 160, 30, 0]] })
  compare('missing-stop', { rows: [stop(1, 'A', 100), stop(2, 'B', 120), stop(3, 'missing', 130)], frequencies: [['T', 100, 160, 30, 1]] }, /Broken GTFS reference stop_times.stop_id/)
  compare('missing-trip', { rows: [stop(1, 'A', 100, 100, 1, 1, 'absent')] }, /Broken GTFS reference stop_times.trip_id/)
  compare('duplicate-sequence', { rows: [stop(1, 'A', 100), stop(1, 'B', 120)] }, /Non-increasing or duplicate GTFS stop_sequence/)
  compare('non-monotone', { rows: [stop(1, 'A', 100), stop(2, 'B', 90)] }, /Non-monotone GTFS trip time/)
  compare('excluded-still-validates', { rows: [stop(1, 'A', 100), stop(2, 'B', 90)], excluded: ['T'] }, /Non-monotone GTFS trip time/)
  compare('expansion-bound', { rows: [stop(1, 'A', 100), stop(2, 'B', 120)], frequencies: [['T', 0, 100000, 1, 1]] }, /supported expansion bound/)
  compare('frequency-id-collision', { trips: ['T', 'T#frequency-100'], rows: [stop(1, 'A', 100), stop(2, 'B', 120)], frequencies: [['T', 100, 100, 1, 1]] }, /UNIQUE constraint failed/)
  let seed = 80321
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n }
  for (let trial = 0; trial < 80; trial++) {
    const trips = [], rows = [], frequencies = [], excluded = []
    for (let i = 0; i < 8; i++) {
      const trip = `scope\u001f车站-${trial}-${i}`
      trips.push(trip)
      const start = 80000 + random(1000), length = 2 + random(15)
      for (let j = 0; j < length; j++) rows.push(stop(j * 2, ['A', 'B', 'C'][random(3)], j && random(5) === 0 ? null : start + j * 120, j && random(5) === 0 ? null : start + j * 120 + 10, random(2), random(2), trip))
      if (random(3) === 0) frequencies.push([trip, start, start + 1800, 600, 1])
      if (random(6) === 0) excluded.push(trip)
    }
    compare(`seed-${trial}`, { trips, rows: rows.reverse(), frequencies, excluded })
  }
  const f = fixture('bad-paths', { rows: [] })
  assert.throws(() => compileNativeGtfsConnections({ storePath: f.store, stopTimesPath: f.store, excludedTripIds: [], cacheKib: 4096 }), /distinct/)
  assert.throws(() => compileNativeGtfsConnections({ storePath: `${f.store}.missing`, stopTimesPath: f.stagePath, excludedTripIds: [], cacheKib: 4096 }))
  assert.equal(fs.existsSync(`${f.store}.missing`), false)
  assert.throws(() => compileNativeGtfsConnections({ storePath: f.store, stopTimesPath: f.stagePath, excludedTripIds: [], cacheKib: 0 }), /cacheKiB/)
  console.log('Rust GTFS compiler regression: 80 seeded feeds, scoped identities, gaps, frequencies, permissions, malformed input and native rollback passed.')
} finally { fs.rmSync(root, { recursive: true, force: true }) }
