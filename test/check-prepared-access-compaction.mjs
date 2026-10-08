import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadPreparedAccessContext, persistPreparedAccessContext } from '../src/server/prepared-access-context.mjs'
import { decodeRoutingSnapshot, encodeRoutingSnapshot } from '../src/server/routing-snapshot.mjs'
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-access-compaction-'))
const a = { stop_id: 'A', lat: 42, lon: -71, location_type: 0 }, b = { ...a, stop_id: 'B', lon: -71.01 }
const index = { ready: true, anchorCount: 2, cellCount: 1, anchors: [a,b], cells: new Map([['cell',[a,b]]]),
  profilesByStop: new Map(), directProfilesByStop: new Map(), directServiceStopIds: new Set(['A','B']),
  departureServiceStopIds: new Set(['A']), arrivalServiceStopIds: new Set(['B']) }
const store = { storePath: path.join(directory,'fixture.sqlite'), sourceArtifactIdentity: 'fixture', metadata:{stopCount:2},
  transfers:new Map([['A',Array.from({length:2000},(_,i)=>({from_stop_id:'A',to_stop_id:'B',transfer_type:2,min_transfer_time:i+.25,
    provenance:'gtfs_pathway',evidence_fingerprint:'immutable evidence '.repeat(12),path_distance_m:i*.1}))]]),
  transferShortcuts:new Map(),stationMembers:new Map(),stopRecords:new Map([['A',a],['B',b]]),
  forbiddenTransferPairs:new Set(['B:A']),declaredPathwayStops:new Set(['A','B']),
  rawTransferCount:2000,rawForbiddenTransferCount:1,resolvedTransferCount:2000,stopAccessIndex:index }
try {
  const saved=persistPreparedAccessContext(store,'policy');assert.equal(saved.persistenceState,'written')
  const loaded=loadPreparedAccessContext(store,'policy');assert.equal(loaded.persistenceState,'loaded')
  assert.deepEqual(loaded.materialized.transfers,store.transfers)
  assert.strictEqual(loaded.materialized.stopAccessIndex.anchors[0],loaded.materialized.stopRecords.get('A'))
  assert.strictEqual(loaded.materialized.stopAccessIndex.cells.get('cell')[0],loaded.materialized.stopRecords.get('A'))
  assert.equal(loadPreparedAccessContext(store,'other-policy').persistenceState,'rejected')
  const packed=fs.readFileSync(saved.snapshotPath), decoded=decodeRoutingSnapshot(packed)
  const expandedBytes = Buffer.byteLength(JSON.stringify([...store.transfers]))
  assert(packed.length < expandedBytes / 5)
  decoded.metadata.schemaVersion = 'vigo.routing.access-context.v1'
  fs.writeFileSync(saved.snapshotPath, encodeRoutingSnapshot(decoded.metadata, decoded.arrays))
  assert.equal(loadPreparedAccessContext(store, 'policy').persistenceState, 'rejected')
  decoded.metadata.schemaVersion = 'vigo.routing.access-context.v2'
  decoded.metadata.materialized.transfers[0][1][0].evidenceIndex = 999999
  fs.writeFileSync(saved.snapshotPath, encodeRoutingSnapshot(decoded.metadata, decoded.arrays))
  assert.equal(loadPreparedAccessContext(store, 'policy').persistenceState, 'rejected')
  console.log(`Prepared access: ${expandedBytes} expanded transfer bytes to ${packed.length} total bytes; exact costs, shared records and obsolete-format rejection passed.`)
} finally {fs.rmSync(directory,{recursive:true,force:true})}
