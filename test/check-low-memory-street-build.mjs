import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { PbfWriter } from 'pbf'

// Exercise the actual importer beyond the former 50,000-edge RAM gate.
const originalTotalmem = os.totalmem
os.totalmem = () => 1024 ** 3
syncBuiltinESMExports()
const { buildNationalOsmStore, compactNationalOsmRuntimeStore, disposeNationalOsmStore } = await import('../src/server/national-osm-store.mjs')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-low-memory-streets-'))
const pbfPath = path.join(root, 'streets.pbf')
function message(write) { const p = new PbfWriter(); write(p); return Buffer.from(p.finish()) }
function block(type, raw) {
  const blob = message(p => { p.writeBytesField(1, raw); p.writeVarintField(2, raw.length) })
  const header = message(p => { p.writeStringField(1, type); p.writeVarintField(3, blob.length) })
  const length = Buffer.alloc(4); length.writeUInt32BE(header.length)
  return Buffer.concat([length, header, blob])
}
const nodes = 25001
fs.writeFileSync(pbfPath, Buffer.concat([
  block('OSMHeader', message(p => p.writeStringField(4, 'OsmSchema-V0.6'))),
  block('OSMData', message(p => {
    p.writeMessage(1, (_, q) => { for (const s of ['', 'highway', 'residential']) q.writeStringField(1, s) })
    p.writeMessage(2, (_, q) => {
      for (let i = 1; i <= nodes; i++) q.writeMessage(1, (_, n) => {
        n.writeSVarintField(1, i); n.writeSVarintField(8, 423000000); n.writeSVarintField(9, -711000000 + i * 10)
      })
      q.writeMessage(3, (_, w) => {
        w.writeVarintField(1, 1); w.writePackedVarint(2, [1]); w.writePackedVarint(3, [2]); w.writePackedSVarint(8, Array(nodes).fill(1))
      })
    })
  })),
]))
function sourceRows(file) {
  const db = new DatabaseSync(file, { readOnly:true })
  try { return db.prepare('SELECT count(*) AS n FROM edges').get().n } finally { db.close() }
}
try {
  const store = path.join(root, 'street.sqlite')
  const result = await buildNationalOsmStore({pbfPath, outputPath:store, includeDriving:false})
  assert.equal(result.edgeCount, 50000)
  assert.equal(result.walkAccelerator.snapshotStatus, 'written')
  const snapshot = `${store}.street-accelerator-v7.bin`
  fs.renameSync(snapshot, `${snapshot}.saved`)
  assert.throws(() => compactNationalOsmRuntimeStore(store), /Cannot seal.*not persisted/)
  assert.equal(sourceRows(store), 50000, 'missing snapshot must not destroy source graph')
  fs.writeFileSync(snapshot, 'broken')
  assert.throws(() => compactNationalOsmRuntimeStore(store), /Cannot seal/)
  assert.equal(sourceRows(store), 50000, 'damaged snapshot must not destroy source graph')
  fs.renameSync(`${snapshot}.saved`, snapshot)
  assert.equal(compactNationalOsmRuntimeStore(store).storageLayout, 'runtime-snapshots-v1')
  disposeNationalOsmStore(store)
  const failed = path.join(root, 'failed.sqlite')
  fs.mkdirSync(`${failed}.street-accelerator-v7.bin`)
  await assert.rejects(buildNationalOsmStore({pbfPath, outputPath:failed, includeDriving:false}), /Pedestrian accelerator preparation failed/)
  assert.equal(sourceRows(failed), 50000, 'write failure must retain source graph')
  disposeNationalOsmStore(failed)
  const drive = path.join(root, 'drive.sqlite')
  await buildNationalOsmStore({pbfPath, outputPath:drive, includeDriving:true})
  fs.mkdirSync(`${drive}.drive-accelerator-v2.bin`)
  assert.throws(() => compactNationalOsmRuntimeStore(drive), /Drive snapshot could not be prepared/)
  assert.equal(sourceRows(drive), 50000, 'drive write failure must retain source graph')
  disposeNationalOsmStore(drive)
  console.log('Low-memory import and missing, damaged, unwritable accelerator safeguards passed.')
} finally {
  os.totalmem = originalTotalmem; syncBuiltinESMExports()
  fs.rmSync(root, {recursive:true,force:true})
}
