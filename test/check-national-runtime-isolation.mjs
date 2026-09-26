import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { boundedInteger } from '../src/server/runtime/resource-limits.mjs'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { buildNationalGtfsStore, disposeAllNationalGtfsStores } from '../src/server/national-gtfs-store.mjs'
import { buildNationalOsmStore, compactNationalOsmRuntimeStore, disposeNationalOsmStore } from '../src/server/national-osm-store.mjs'
import { NationalRouteWorkerPool } from '../src/server/runtime/route-worker-pool.mjs'
import { createStreetPreparationManager } from '../src/server/street-preparation.mjs'
import { buildNativeStreetCchIndex } from '../src/server/native-routing-kernel.mjs'

for (const value of ['Infinity', 'NaN', '0', '-1']) assert.equal(boundedInteger(value, 128, 1, 1024), 128)
process.env.VIGO_ACTIVE_KERNEL_MAX_BYTES = '4194304'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-real-runtime-'))
const workerUrl = new URL('../src/server/national-route-worker.mjs', import.meta.url)
const pool = new NationalRouteWorkerPool(1, workerUrl)
const store = path.join(directory, 'project.sqlite')
const street = path.join(directory, 'street.sqlite')
const request = { origin: { stopId: 'A', coordinate: [-77.05, 38.9] }, destination: { stopId: 'B', coordinate: [-77.03, 38.91] }, serviceDate: '2026-09-14', departMinutes: 480, maxWalkKm: 0.1 }
const timeout = setTimeout(() => { console.error('Real routing lifecycle did not settle.'); process.exit(1) }, 60_000)
async function waitFor(predicate) {
  const end = Date.now() + 15_000
  while (!predicate()) {
    assert(Date.now() < end, 'Runtime state did not settle')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
try {
  const inputs = await writeCliFixtureInputs(directory)
  await buildNationalGtfsStore({ zipPath: inputs.gtfsPath, outputPath: store })
  await buildNationalOsmStore({ pbfPath: inputs.osmPath, outputPath: street })
  compactNationalOsmRuntimeStore(street, { requireDrive: true })
  buildNativeStreetCchIndex(street)
  disposeNationalOsmStore(street)
  disposeAllNationalGtfsStores()
  const largeArchive = await JSZip.loadAsync(await fs.readFile(inputs.gtfsPath))
  largeArchive.file('trips.txt', 'route_id,service_id,trip_id,direction_id\n' + Array.from({ length: 50000 }, (_, i) => `R1,WKD,T${i},0`).join('\n'))
  largeArchive.file('stop_times.txt', 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n' + Array.from({ length: 50000 }, (_, i) => `T${i},08:00:00,08:00:00,A,1\nT${i},08:30:00,08:30:00,B,2`).join('\n'))
  const largeZip = path.join(directory, 'large.zip'), largeStore = path.join(directory, 'large.sqlite')
  await fs.writeFile(largeZip, await largeArchive.generateAsync({ type: 'nodebuffer' }))
  await buildNationalGtfsStore({ zipPath: largeZip, outputPath: largeStore })
  disposeAllNationalGtfsStores()
  const context = { serviceDate: request.serviceDate }
  const guarded = await pool.prepare(largeStore, { context })
  assert.equal(guarded.activeServiceKernel?.reason, 'memory_estimate_guard', JSON.stringify(guarded))
  await pool.retire(largeStore)
  const realtimeArchive = await JSZip.loadAsync(await fs.readFile(inputs.gtfsPath))
  realtimeArchive.file('trips.txt', 'route_id,service_id,trip_id,direction_id\n' + Array.from({ length: 5000 }, (_, i) => `R1,WKD,T${i},0`).join('\n'))
  realtimeArchive.file('stop_times.txt', 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n' + Array.from({ length: 5000 }, (_, i) => `T${i},08:00:00,08:00:00,A,1\nT${i},08:30:00,08:30:00,B,2`).join('\n'))
  const realtimeZip = path.join(directory, 'realtime.zip'), realtimeStore = path.join(directory, 'realtime.sqlite')
  await fs.writeFile(realtimeZip, await realtimeArchive.generateAsync({ type: 'nodebuffer' }))
  await buildNationalGtfsStore({ zipPath: realtimeZip, outputPath: realtimeStore })
  disposeAllNationalGtfsStores()
  assert((await pool.prepare(realtimeStore, { context })).activeServiceKernel.ready)
  const realtimeSnapshot = { feedTimestamp: Math.floor(Date.now() / 1000), tripUpdates: Array.from({ length: 5000 }, (_, i) => ({ tripId: `T${i}`, startDate: '20260914', delaySeconds: 60 })) }
  await assert.rejects(pool.dispatch(realtimeStore, 'route', { ...request, routingDataMode: 'realtime', realtimeSnapshot }), { code: 'VIGO_REALTIME_MEMORY_LIMIT' })
  assert.equal((await pool.dispatch(realtimeStore, 'route', request)).status, 'ready', 'An oversized reconstruction must leave scheduled routing usable.')
  await pool.retire(realtimeStore)
  const [prepared, shared] = await Promise.all([pool.prepare(store, { context }), pool.prepare(store, { context })])
  assert(prepared.ready && shared.ready)
  assert.equal(pool.snapshot().prewarm.started, 3)
  const first = await pool.dispatch(store, 'route', request)
  assert.equal(first.status, 'ready')
  assert.equal(first.arriveMinutes, 510)
  const originalWorker = pool.clients.get(store).worker
  await assert.rejects(pool.dispatch(store, 'route', { invalid: () => {} }), { name: 'DataCloneError' })
  const active = pool.dispatch(store, 'route', request)
  const invalid = assert.rejects(pool.dispatch(store, 'route', { invalid: () => {} }), { name: 'DataCloneError' })
  const next = pool.dispatch(store, 'route', request)
  await Promise.all([active, invalid, next])
  assert.equal(pool.clients.get(store).worker, originalWorker)
  assert.equal(pool.snapshot().workers[0].failedJobs, 2)
  assert.equal(pool.snapshot().workers[0].active, false)

  // Kill the actual routing thread and verify the next request computes the
  // same journey after its source and native state are reopened.
  await originalWorker.terminate()
  await waitFor(() => !pool.clients.get(store).restarting)
  const recovered = await pool.dispatch(store, 'route', request)
  assert.equal(recovered.status, first.status)
  assert.equal(recovered.arriveMinutes, first.arriveMinutes)
  assert.deepEqual(recovered.legs, first.legs)
  assert.notEqual(pool.clients.get(store).worker, originalWorker)

  const manager = createStreetPreparationManager({ pool })
  const input = { projectId: 'city', storePath: street, workerStorePath: store, identity: 'streets', label: 'OSM' }
  const job = manager.start(input)
  assert.equal(manager.start(input), job)
  await waitFor(() => ['complete', 'failed'].includes(job.status))
  assert.equal(job.status, 'complete', job.error)
  assert(pool.isStreetPrepared(store, true))
  const walk = await pool.dispatch(store, 'street-route', { streetStorePath: street, origin: { coordinate: [-77.05, 38.9] }, destination: { coordinate: [-77.04, 38.905] }, mode: 'walk', departMinutes: 480, maxWalkKm: 5 })
  assert.equal(walk.status, 'ready', JSON.stringify(walk.diagnostics))
  await pool.retire(store)
  const rebuilt = manager.start(input)
  assert.notEqual(rebuilt.id, job.id)
  await waitFor(() => ['complete', 'failed'].includes(rebuilt.status))
  assert.equal(rebuilt.status, 'complete', rebuilt.error)
  const missing = manager.start({ ...input, storePath: path.join(directory, 'missing.sqlite'), identity: 'missing' })
  await waitFor(() => missing.status === 'failed')
  assert.equal(manager.start({ ...input, storePath: path.join(directory, 'missing.sqlite'), identity: 'missing' }), missing)

  // Occupy the only slot with a real resident City. Other stores wait without
  // spawning workers, and excess requests are rejected before admission.
  pool.setResidency(store, true)
  const pending = []
  const limit = pool.snapshot().maxPendingRequests
  for (let i = 0; i < limit; i++) pending.push(pool.dispatch(path.join(directory, `other-${i}`), 'route', request))
  const settled = Promise.allSettled(pending)
  await assert.rejects(pool.dispatch('overflow', 'route', request), error => error.code === 'VIGO_ROUTE_CAPACITY' && error.statusCode === 503)
  assert.equal(pool.snapshot().pendingDispatches, limit)
  assert.equal(pool.snapshot().workerCount, 1)
  await pool.closeAll()
  const results = await settled
  assert(results.every(result => result.status === 'rejected' && result.reason.code === 'VIGO_ROUTE_CLOSED'))
  assert.equal(pool.snapshot().pendingDispatches, 0)
  assert.equal(pool.snapshot().workerCount, 0)
  await assert.rejects(pool.dispatch(store, 'route', request), { code: 'VIGO_ROUTE_CLOSED' })
  console.log('Real GTFS/OSM lifecycle: shared preparation, exact journeys, transfer failure, thread death/recovery, street readiness, eviction, bounded admission and shutdown passed.')
} finally {
  await pool.closeAll()
  clearTimeout(timeout)
  disposeAllNationalGtfsStores()
  disposeNationalOsmStore(street)
  await fs.rm(directory, { recursive: true, force: true })
}
