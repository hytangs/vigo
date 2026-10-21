import assert from 'node:assert/strict'
import { NationalRouteWorkerPool } from '../src/server/runtime/route-worker-pool.mjs'
import { takeRoutingJob, maximumPointBypasses } from '../src/server/runtime/routing-job-queue.mjs'

function order(operations) {
  const queue = operations.map((operation, id) => ({ operation, id }))
  const fairness = { bypasses: 0 }, result = []
  while (queue.length) result.push(takeRoutingJob(queue, fairness).id)
  return result
}
assert.deepEqual(order(['street-route-batch', 'route', 'street-route', 'street-route-batch']), [1, 2, 0, 3])
assert.deepEqual(order(['street-route-batch', 'street-route', 'street-route-batch', 'route']), [1, 3, 0, 2])
assert.deepEqual(order(['street-route-batch', 'prepare', 'route']), [0, 1, 2])
assert.deepEqual(order(['street-route-batch', 'unknown', 'route']), [0, 1, 2])
assert.deepEqual(order(['prepare', 'street-route-batch', 'route']), [0, 2, 1])
assert.deepEqual(order(['street-route-batch', ...Array(6).fill('route'), 'street-route-batch']), [1, 2, 3, 4, 0, 5, 6, 7])
assert.equal(maximumPointBypasses, 4)

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
  submit('street-route-batch', 'batch')
  for (let i = 1; i <= 6; i += 1) submit(i % 2 ? 'route' : 'street-route', `point${i}`)
  const cancel = new AbortController()
  const cancelled = assert.rejects(submit('route', 'cancelled', {}, cancel.signal), { name: 'AbortError' })
  pending.pop() // The rejection is consumed by assert.rejects.
  while ((pool.clients.get(store)?.queue.length ?? 0) < 8) {
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  cancel.abort()
  Atomics.store(gate, 0, 1); Atomics.notify(gate, 0)
  await Promise.all([...pending, cancelled])
  assert.deepEqual(results, ['active', 'point1', 'point2', 'point3', 'point4', 'batch', 'point5', 'point6'])
  assert.equal(pool.snapshot().workers[0].maximumPointBypasses, 4)
  console.log('Routing queue: point priority, bounded batch waiting, preparation barriers and cancellation passed.')
} finally {
  Atomics.store(gate, 0, 1); Atomics.notify(gate, 0)
  await pool.closeAll()
  clearTimeout(timeout)
}
