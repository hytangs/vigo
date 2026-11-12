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
  console.log('Routing queue: arrival order and cancellation of waiting jobs passed.')
} finally {
  Atomics.store(gate, 0, 1); Atomics.notify(gate, 0)
  await pool.closeAll()
  clearTimeout(timeout)
}
