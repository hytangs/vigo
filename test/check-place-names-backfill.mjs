import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { copyFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { writeOsmFixture } from './helpers/basemap-fixture.mjs'
import { backfillPlaceNames } from '../src/server/place-names-backfill.mjs'
import { describeNativePlaces } from '../src/server/native-routing-kernel.mjs'

const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-place-backfill-'))
const pbfPath = path.join(folder, 'names.pbf')
const streetPath = path.join(folder, 'street.sqlite')
const points = [[0.00005, 0.00005], [0.0015, 0.0016], [5, 5]]
const expected = ['Main St & Cross St', 'City Park', null]
const labels = (values) => values.map((value) => value?.label ?? null)
const hash = async (file) => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')
let db
try {
  writeOsmFixture(pbfPath, ({ way }) => {
    way([[-0.004, 0], [0, 0], [0.004, 0]], { highway: 'primary', name: 'Main Street' })
    way([[0, -0.004], [0, 0], [0, 0.004]], { highway: 'secondary', name: 'Cross Street' })
    way([[-0.002, -0.004], [-0.002, 0.004]], { highway: 'primary', name: 'Tunnel', tunnel: 'yes' })
    way([[0.0007, 0.0015], [0.0023, 0.0015]], { highway: 'footway', name: 'Park Path' })
    way([[0.0005, 0.0005], [0.0025, 0.0005], [0.0025, 0.0025], [0.0005, 0.0025], [0.0005, 0.0005]], { leisure: 'park', name: 'City Park' })
  })
  const fingerprint = await hash(pbfPath)
  db = new DatabaseSync(streetPath)
  // A sealed City need not retain raw graph/node tables. Preserve unrelated rows.
  db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE map_features(id INTEGER PRIMARY KEY, geometry BLOB);
    INSERT INTO map_features VALUES(1,x'00112233');`)
  const setMeta = db.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)')
  setMeta.run('sourceFingerprint', JSON.stringify(fingerprint))
  setMeta.run('storageLayout', JSON.stringify('runtime-snapshots-v1'))
  const basemap = db.prepare('SELECT * FROM map_features').all()
  const originalMetadata = db.prepare('SELECT * FROM metadata ORDER BY key').all()
  db.close(); db = null
  const before = await hash(streetPath)

  const wrongPbf = path.join(folder, 'wrong.pbf')
  writeOsmFixture(wrongPbf, ({ way }) => way([[1, 1], [1, 2]], { highway: 'primary', name: 'Wrong Street' }))
  await assert.rejects(backfillPlaceNames({ streetPath, pbfPath: wrongPbf }), /fingerprint does not match/)
  assert.equal(await hash(streetPath), before, 'Wrong-source failure must not write any City bytes')
  const changingPbf = path.join(folder, 'changing.pbf')
  await fs.copyFile(pbfPath, changingPbf)
  await assert.rejects(backfillPlaceNames({ streetPath, pbfPath: changingPbf,
    onProgress({ phase, progress }) {
      if (phase === 'Selecting named ways' && progress === 1) copyFileSync(wrongPbf, changingPbf)
    },
  }), /fingerprint does not match/)
  assert.equal(await hash(streetPath), before, 'A source change between passes must leave the City unchanged')
  const controller = new AbortController()
  await assert.rejects(backfillPlaceNames({ streetPath, pbfPath, signal: controller.signal,
    onProgress({ phase }) { if (phase === 'Resolving named-way geometry') controller.abort() },
  }), { name: 'AbortError' })
  assert.equal(await hash(streetPath), before, 'Cancellation must leave the City unchanged')

  assert.deepEqual(await describeNativePlaces(streetPath, '', points), [null, null, null])
  const result = await backfillPlaceNames({ streetPath, pbfPath })
  assert.equal(result.built, true)
  assert.equal(result.streets, 2)
  assert.equal(result.areas, 1)
  assert.equal(result.skippedWays, 0)
  assert.deepEqual(labels(await describeNativePlaces(streetPath, '', points)), expected, 'A warm native lookup reloads after backfill')
  db = new DatabaseSync(streetPath)
  assert.deepEqual(db.prepare('SELECT * FROM map_features').all(), basemap)
  assert.deepEqual(db.prepare("SELECT * FROM metadata WHERE key!='placeNames' ORDER BY key").all(), originalMetadata)
  db.close(); db = null
  const completed = await hash(streetPath)
  const completedStat = await fs.stat(streetPath)
  assert.equal((await backfillPlaceNames({ streetPath, pbfPath })).built, false)
  assert.equal(await hash(streetPath), completed, 'A repeated upgrade is read-only')
  assert.equal((await fs.stat(streetPath)).mtimeMs, completedStat.mtimeMs)

  db = new DatabaseSync(streetPath)
  db.exec('DROP TABLE place_streets')
  db.close(); db = null
  assert.equal((await backfillPlaceNames({ streetPath, pbfPath })).built, true, 'Repair a missing table even when its receipt remains')
  assert.deepEqual(labels(await describeNativePlaces(streetPath, '', points)), expected)

  // Publication failure rolls back table replacement as well as the receipt.
  db = new DatabaseSync(streetPath)
  db.exec(`DELETE FROM metadata WHERE key='placeNames';
    UPDATE place_streets SET name='Existing Street';
    CREATE TRIGGER refuse_names BEFORE INSERT ON metadata WHEN NEW.key='placeNames'
      BEGIN SELECT RAISE(ABORT,'test publication failure'); END;`)
  const oldNames = db.prepare('SELECT * FROM place_streets').all()
  db.close(); db = null
  await assert.rejects(backfillPlaceNames({ streetPath, pbfPath }), /test publication failure/)
  db = new DatabaseSync(streetPath)
  assert.deepEqual(db.prepare('SELECT * FROM place_streets').all(), oldNames)
  assert.equal(db.prepare("SELECT count(*) AS n FROM metadata WHERE key='placeNames'").get().n, 0)
  db.exec('DROP TRIGGER refuse_names; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0')
  // Pin an old read snapshot so commits cannot checkpoint into the main file.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE); BEGIN')
  db.prepare('SELECT count(*) FROM place_streets').get()
  await describeNativePlaces(streetPath, '', points)
  const mainHash = await hash(streetPath)
  await backfillPlaceNames({ streetPath, pbfPath })
  assert.equal(await hash(streetPath), mainHash, 'WAL-only regression really leaves the main file unchanged')
  assert.deepEqual(labels(await describeNativePlaces(streetPath, '', points)), expected, 'WAL-only upgrades invalidate the native cache')
  db.exec('COMMIT')
  db.close(); db = null
  assert.equal((await fs.readdir(folder)).some((name) => name.startsWith('.place-names-')), false, 'Success and failures clean staging data')
  console.log(JSON.stringify({ status: 'passed', streets: result.streets, areas: result.areas,
    checks: ['source mismatch', 'source changed between passes', 'cancellation', 'basemap/metadata preservation', 'warm reload', 'idempotence', 'incomplete index repair', 'publication rollback', 'WAL reload', 'staging cleanup'] }))
} finally {
  db?.close()
  await fs.rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
