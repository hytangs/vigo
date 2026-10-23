import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { buildNationalGtfsStore, routeNationalGtfsStore, disposeAllNationalGtfsStores } from '../src/server/national-gtfs-store.mjs'
// Regression for https://github.com/transitmatters/futures-explorer/issues/295.
// OVERLAP reproduces the published timing example without copying the source feed.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-time-repair-'))
try {
  const { gtfsPath } = await writeCliFixtureInputs(root)
  const zip = await JSZip.loadAsync(await fs.readFile(gtfsPath))
  zip.file('trips.txt', await zip.file('trips.txt').async('string') + 'R1,WKD,BACK,0\nR1,WKD,DWELL,0\nR1,WKD,NIGHT,0\nR1,WKD,HUGE,0\nR1,WKD,OVERLAP,0\n')
  zip.file('stop_times.txt', await zip.file('stop_times.txt').async('string')
    + 'BACK,08:00:00,08:00:00,A,1\nBACK,08:10:00,08:10:00,X,2\nBACK,08:00:00,08:00:00,B,3\n'
    + 'DWELL,08:00:00,07:59:00,A,1\nDWELL,08:10:00,08:10:00,B,2\n'
    + 'HUGE,08:00:00,08:00:00,A,1\nHUGE,08:10:00,08:10:00,X,2\nHUGE,07:59:59,07:59:59,B,3\n'
    + 'OVERLAP,16:29:21,16:33:58,A,1\nOVERLAP,16:30:05,16:30:05,X,2\nOVERLAP,16:40:00,16:40:00,B,3\n'
    + 'NIGHT,23:50:00,23:50:00,A,1\nNIGHT,24:10:00,24:10:00,B,2\n')
  await fs.writeFile(gtfsPath, await zip.generateAsync({ type: 'nodebuffer' }))
  const digest = async () => createHash('sha256').update(await fs.readFile(gtfsPath)).digest('hex')
  const before = await digest(), progress = []
  const outputPath = path.join(root, 'routing.sqlite')
  await buildNationalGtfsStore({ zipPath: gtfsPath, outputPath, onProgress: message => progress.push(message) })
  const db = new DatabaseSync(outputPath, { readOnly: true })
  assert.equal(db.prepare("SELECT COUNT(*) n FROM connections WHERE trip_id='HUGE'").get().n, 0, 'No valid prefix of a bad trip may remain')
  assert(db.prepare("SELECT COUNT(*) n FROM connections WHERE trip_id='T1'").get().n > 0)
  assert.equal(db.prepare("SELECT arrival FROM connections WHERE trip_id='NIGHT'").get().arrival, 87000, 'Published times after midnight are valid')
  const metadata = Object.fromEntries(db.prepare('SELECT key,value FROM metadata').all().map(row => [row.key, JSON.parse(row.value)]))
  assert.equal(metadata.featureInventory.quarantinedTimeTripCount, 1)
  assert.deepEqual(metadata.featureInventory.quarantinedTimeTripSamples, ['HUGE'])
  assert(metadata.routingLimitations.some(issue => issue.code === 'backward_trip_times' && issue.count === 1))
  assert(progress.some(message => message.phase === 'Timetable warning' && message.detail.includes('3 trip(s)')), 'Preparation must report repaired service')
  assert.equal(metadata.featureInventory.repairedTimeTripCount, 3)
  assert(metadata.routingLimitations.some(issue => issue.code === 'repaired_trip_times' && issue.exactness === 'approximate'))
  assert.equal(db.prepare("SELECT arrival FROM connections WHERE trip_id='BACK' AND stop_sequence=2").get().arrival, 29400)
  assert.equal(db.prepare("SELECT departure FROM connections WHERE trip_id='DWELL'").get().departure, 28800)
  const overlap = db.prepare("SELECT departure,arrival FROM connections WHERE trip_id='OVERLAP' ORDER BY stop_sequence").all()
  assert.deepEqual(overlap.map(row => [row.departure, row.arrival]), [[59638, 59638], [59638, 60000]])
  assert.equal(db.prepare('SELECT COUNT(*) n FROM connections WHERE arrival < departure').get().n, 0)
  db.close()
  const plan = routeNationalGtfsStore(outputPath, {
    origin: { coordinate: [-77.050, 38.900], label: 'Alpha', source: 'map' },
    destination: { coordinate: [-77.030, 38.910], label: 'Bravo', source: 'map' },
    departMinutes: 989, serviceDay: 'weekday', serviceDate: '2026-07-15', maxWalkKm: 0.01,
  })
  assert.equal(plan.status, 'ready')
  assert.equal(plan.arriveMinutes, 1000)
  assert.equal(plan.legs.find(leg => leg.type === 'ride').tripId, 'OVERLAP')
  assert.equal(await digest(), before, 'Never rewrite the imported ZIP')
  console.log('Backward-time preparation: small regressions repaired; large regressions excluded atomically with diagnostics; after-midnight times and source archive preserved.')
} finally { disposeAllNationalGtfsStores(); await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) }
