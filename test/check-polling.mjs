import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { startPolling } from '../src/app/polling.ts'

const previousDocument = globalThis.document
const document = Object.assign(new EventTarget(), { hidden: false })
globalThis.document = document
mock.timers.enable({ apis: ['setTimeout'] })
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const requests = []
let poll
try {
  poll = startPolling(signal => new Promise((resolve, reject) => requests.push({ signal, resolve, reject })), 10_000)
  await flush()
  assert.equal(requests.length, 1)
  mock.timers.tick(30_000)
  const manual = poll.refresh()
  await flush()
  assert.equal(requests.length, 1, 'A slow request and repeated manual refreshes share one operation')
  requests[0].resolve()
  await manual
  mock.timers.tick(9_999)
  await flush()
  assert.equal(requests.length, 1, 'Cadence starts after completion, not request start')
  mock.timers.tick(1)
  await flush()
  assert.equal(requests.length, 2)
  requests[1].reject(new Error('Offline'))
  await flush()
  mock.timers.tick(10_000)
  await flush()
  assert.equal(requests.length, 3, 'A failed refresh can recover at the next interval')
  document.hidden = true
  document.dispatchEvent(new Event('visibilitychange'))
  requests[2].resolve()
  await flush()
  mock.timers.tick(60_000)
  await flush()
  assert.equal(requests.length, 3, 'No background polling while hidden')
  document.hidden = false
  document.dispatchEvent(new Event('visibilitychange'))
  await flush()
  assert.equal(requests.length, 4, 'Returning to the app refreshes immediately')
  poll.stop()
  assert.equal(requests[3].signal.aborted, true, 'Cleanup cancels the active request')
  requests[3].resolve()
  await flush()
  document.dispatchEvent(new Event('visibilitychange'))
  mock.timers.tick(60_000)
  await flush()
  assert.equal(requests.length, 4, 'Cleanup removes timers and visibility listeners')
  let stoppedReads = 0
  poll = startPolling(async () => { stoppedReads++ }, 10_000)
  poll.stop()
  await flush()
  assert.equal(stoppedReads, 0, 'Stopping before the first microtask prevents the read')
  poll = startPolling(async () => requests.push({}), 10_000, { immediate: false })
  await flush()
  assert.equal(requests.length, 4, 'Connecting a feed does not immediately fetch it twice')
  mock.timers.tick(10_000)
  await flush()
  assert.equal(requests.length, 5)
} finally {
  poll?.stop()
  mock.timers.reset()
  if (previousDocument === undefined) delete globalThis.document
  else globalThis.document = previousDocument
}
console.log('Polling: sequential requests, coalesced manual refresh, failure recovery, visibility pause and cleanup passed.')
