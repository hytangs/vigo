import assert from 'node:assert/strict'
import { NationalRouteWorkerPool } from '../src/server/runtime/route-worker-pool.mjs'
import { createRetiredRouting } from '../src/server/runtime/retired-routing.mjs'

// The worker now serves preparation and street-route-batch jobs in arrival
// order; a request cancelled while it waits must never reach the worker.
// Hold the first worker job until every later request is actually enqueued,
// avoiding timing assumptions about worker startup or a busy host.
const worker = new URL('data:text/javascript,' + encodeURIComponent(`
  import { parentPort } from 'node:worker_threads';
  parentPort.on('message', ({id, request}) => {
    if (request.gate) Atomics.wait(new Int32Array(request.gate), 0, 0);
    // hold: [release, runs]. Each run counts itself; it waits while release is
    // 0, on its first run only when holdOnce is set.
    if (request.hold) {
      const hold = new Int32Array(request.hold);
      const run = Atomics.add(hold, 1, 1);
      Atomics.notify(hold, 1);
      if (!request.holdOnce || run === 0) Atomics.wait(hold, 0, 0);
    }
    parentPort.postMessage({id, type:'complete', result:request.name});
  });
`))
const pool = new NationalRouteWorkerPool(1, worker)
const store = '/synthetic-routing-queue'
const gate = new Int32Array(new SharedArrayBuffer(4))
const results = []
const pending = []
const submit = (operation, name, request = {}, signal) => {
  const promise = pool.dispatch(store, operation, { name, ...request }, signal)
    .then(value => { results.push(value); return value })
  pending.push(promise)
  return promise
}
const timeout = setTimeout(() => { console.error('Routing queue test timed out'); process.exit(1) }, 30_000)
try {
  submit('street-route-batch', 'active', { gate: gate.buffer })
  for (let i = 1; i <= 6; i += 1) submit('street-route-batch', `batch${i}`)
  const cancel = new AbortController()
  const cancelled = assert.rejects(submit('street-route-batch', 'cancelled', {}, cancel.signal), { name: 'AbortError' })
  pending.pop() // The rejection is consumed by assert.rejects.
  while ((pool.clients.get(store)?.queue.length ?? 0) < 7) {
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  cancel.abort()
  Atomics.store(gate, 0, 1); Atomics.notify(gate, 0)
  await Promise.all([...pending, cancelled])
  assert.deepEqual(results, ['active', 'batch1', 'batch2', 'batch3', 'batch4', 'batch5', 'batch6'])

  // A same-library refresh is transparent: the job the worker is running is
  // stopped and runs once more on a fresh worker; queued work waits and runs.
  const holder = () => new Int32Array(new SharedArrayBuffer(8))
  const runs = async (hold, count) => {
    while (Atomics.load(hold, 1) < count) await new Promise(resolve => setTimeout(resolve, 1))
  }
  const held = holder()
  const running = pool.dispatch(store, 'gtfs-route-analysis', { name: 'running', hold: held.buffer, holdOnce: true })
  const queued = pool.dispatch(store, 'gtfs-route-analysis', { name: 'queued' })
  await runs(held, 1)
  await pool.retire(store)
  assert.deepEqual(await Promise.all([running, queued]), ['running', 'queued'])
  assert.equal(Atomics.load(held, 1), 2, 'The stopped job ran once more after the refresh')

  // It runs again only once: a second refresh while it runs again fails it.
  const stuck = holder()
  const twice = pool.dispatch(store, 'gtfs-route-analysis', { name: 'twice', hold: stuck.buffer })
  const twiceSettled = assert.rejects(twice, { code: 'VIGO_ROUTE_REFRESHED' })
  await runs(stuck, 1)
  await pool.retire(store)
  await runs(stuck, 2)
  await pool.retire(store)
  await twiceSettled

  // A library switch (reset) during a refresh refuses the work instead.
  const switched = holder()
  const refused = pool.dispatch(store, 'gtfs-route-analysis', { name: 'switched', hold: switched.buffer, holdOnce: true })
  const refusedSettled = assert.rejects(refused, { code: 'VIGO_ROUTE_RESET' })
  await runs(switched, 1)
  await Promise.all([pool.retire(store), pool.reset()])
  await refusedSettled
  assert.equal(Atomics.load(switched, 1), 1, 'Work of the previous library never ran again')
  assert.equal(await pool.dispatch(store, 'gtfs-route-analysis', { name: 'after-reset' }), 'after-reset')

  // Two-phase fence through Studio's helper: while the mutation replaces the
  // store, the interrupted job and one arriving meanwhile wait and no worker
  // opens it; both run once the mutation settles, also when it throws.
  const nativeReleases = []
  const fakeNative = {
    retire: async () => { const release = () => nativeReleases.push('file'); return release },
    retireCity: async () => { const release = () => nativeReleases.push('city'); return release },
  }
  const withRetiredRouting = createRetiredRouting(fakeNative, pool)
  for (const failing of [false, true]) {
    const fenced = holder()
    const interrupted = pool.dispatch(store, 'gtfs-route-analysis', { name: 'interrupted', hold: fenced.buffer, holdOnce: true })
    await runs(fenced, 1)
    let arriving
    const mutation = withRetiredRouting({ files: [store] }, async () => {
      arriving = pool.dispatch(store, 'gtfs-route-analysis', { name: 'arriving' })
      await new Promise(resolve => setTimeout(resolve, 40))
      assert.equal(pool.clients.has(store), false, 'No worker opens the store while it is replaced')
      assert.equal(Atomics.load(fenced, 1), 1, 'The interrupted job waits for the release')
      if (failing) throw new Error('replacement failed')
      return 'replaced'
    })
    if (failing) await assert.rejects(mutation, /replacement failed/)
    else assert.equal(await mutation, 'replaced')
    assert.deepEqual(await Promise.all([interrupted, arriving]), ['interrupted', 'arriving'])
    assert.equal(Atomics.load(fenced, 1), 2)
  }
  assert.deepEqual(nativeReleases, ['file', 'file'], 'The native fence is released after a failed mutation too')

  // A release that never comes does not wedge the store: past the hold limit
  // waiting work fails as being updated, and new work runs again.
  const lossy = new NationalRouteWorkerPool(1, worker, { holdMs: 80 })
  try {
    await lossy.retire(store, { hold: true })
    await assert.rejects(lossy.dispatch(store, 'gtfs-route-analysis', { name: 'held-forever' }), { code: 'VIGO_ROUTE_UPDATING' })
    assert.equal(await lossy.dispatch(store, 'gtfs-route-analysis', { name: 'after-expiry' }), 'after-expiry')
  } finally { await lossy.closeAll() }
  console.log('Routing queue: arrival order, cancellation, refresh re-run, two-phase fence, hold expiry and reset refusal passed.')
} finally {
  Atomics.store(gate, 0, 1); Atomics.notify(gate, 0)
  await pool.closeAll()
  clearTimeout(timeout)
}
