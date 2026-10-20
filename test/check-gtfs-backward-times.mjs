import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { buildNationalGtfsStore, disposeAllNationalGtfsStores } from '../src/server/national-gtfs-store.mjs'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-time-quarantine-'))
try {
  const { gtfsPath } = await writeCliFixtureInputs(root)
  const zip = await JSZip.loadAsync(await fs.readFile(gtfsPath))
  zip.file('trips.txt', await zip.file('trips.txt').async('string') + 'R1,WKD,BACK,0\nR1,WKD,DWELL,0\nR1,WKD,NIGHT,0\n')
  zip.file('stop_times.txt', await zip.file('stop_times.txt').async('string')
    + 'BACK,08:00:00,08:00:00,A,1\nBACK,08:10:00,08:10:00,X,2\nBACK,08:05:00,08:05:00,B,3\n'
    + 'DWELL,08:00:00,07:59:00,A,1\nDWELL,08:10:00,08:10:00,B,2\n'
    + 'NIGHT,23:50:00,23:50:00,A,1\nNIGHT,24:10:00,24:10:00,B,2\n')
  await fs.writeFile(gtfsPath, await zip.generateAsync({ type: 'nodebuffer' }))
  const digest = async () => createHash('sha256').update(await fs.readFile(gtfsPath)).digest('hex')
  const before = await digest(), progress = []
  const outputPath = path.join(root, 'routing.sqlite')
  await buildNationalGtfsStore({ zipPath: gtfsPath, outputPath, onProgress: message => progress.push(message) })
  const db = new DatabaseSync(outputPath, { readOnly: true })
  assert.equal(db.prepare("SELECT COUNT(*) n FROM connections WHERE trip_id IN ('BACK','DWELL')").get().n, 0, 'No valid prefix of a bad trip may remain')
  assert(db.prepare("SELECT COUNT(*) n FROM connections WHERE trip_id='T1'").get().n > 0)
  assert.equal(db.prepare("SELECT arrival FROM connections WHERE trip_id='NIGHT'").get().arrival, 87000, 'Published times after midnight are valid')
  const metadata = Object.fromEntries(db.prepare('SELECT key,value FROM metadata').all().map(row => [row.key, JSON.parse(row.value)]))
  assert.equal(metadata.featureInventory.quarantinedTimeTripCount, 2)
  assert.deepEqual(metadata.featureInventory.quarantinedTimeTripSamples, ['BACK', 'DWELL'])
  assert(metadata.routingLimitations.some(issue => issue.code === 'backward_trip_times' && issue.count === 2))
  assert(progress.some(message => message.phase === 'Timetable warning' && message.detail.includes('2 trip(s)')), 'Preparation must report quarantined service')
  db.close()
  assert.equal(await digest(), before, 'Never rewrite the imported ZIP')
  console.log('Backward-time preparation: valid service retained; malformed trips excluded atomically with diagnostics; after-midnight times and source archive preserved.')
} finally { disposeAllNationalGtfsStores(); await fs.rm(root, { recursive: true, force: true }) }
