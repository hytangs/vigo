import assert from 'node:assert/strict'
import { NationalRouteWorkerPool } from '../src/server/runtime/route-worker-pool.mjs'

const pool = new NationalRouteWorkerPool(1, new URL('./fixtures/mock-national-route-worker.mjs', import.meta.url))
const timeout = setTimeout(() => {
  console.error('Worker queue did not recover after a rejected request.')
  process.exit(1)
}, 10_000)
try {
  const first = await pool.dispatch('fixture', 'route', {})
  const controller = new AbortController()
  await assert.rejects(
    pool.dispatch('fixture', 'route', { invalid: () => {} }, controller.signal),
    { name: 'DataCloneError' },
  )
  controller.abort()
  const second = await pool.dispatch('fixture', 'route', {})
  assert.equal(second.diagnostics.workerInstance, first.diagnostics.workerInstance)

  // Exercise the same failure when it is dequeued from a worker completion,
  // rather than from the initial dispatch call's Promise executor.
  const slow = pool.dispatch('fixture', 'route', { testDelayMs: 100 })
  const invalid = assert.rejects(pool.dispatch('fixture', 'route', { invalid: () => {} }), { name: 'DataCloneError' })
  const next = pool.dispatch('fixture', 'route', {})
  await Promise.all([slow, invalid, next])
  const worker = pool.snapshot().workers[0]
  assert.equal(worker.failedJobs, 2)
  assert.equal(worker.active, false)
  assert.equal(worker.queued, 0)
  assert.equal(worker.generation, 1)
  console.log('Worker transfer failures reject only the failed job; queued requests retain the prepared worker.')
} finally {
  await pool.closeAll()
  clearTimeout(timeout)
}
