import assert from 'node:assert/strict'
import { NationalRouteWorkerPool } from '../src/server/runtime/route-worker-pool.mjs'

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
  console.log('Routing queue: arrival order, cancellation of waiting jobs, refresh re-run and reset refusal passed.')
} finally {
  Atomics.store(gate, 0, 1); Atomics.notify(gate, 0)
  await pool.closeAll()
  clearTimeout(timeout)
}
