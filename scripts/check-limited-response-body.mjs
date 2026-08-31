import assert from 'node:assert/strict'
import { readResponseBodyLimited } from '../server/limited-response-body.mjs'

const accepted = await readResponseBodyLimited(
  new Response(new Uint8Array([1, 2, 3])),
  3,
  'fixture',
)
assert.deepEqual([...accepted], [1, 2, 3])

await assert.rejects(
  () => readResponseBodyLimited(
    new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '3' } }),
    2,
    'fixture',
  ),
  (error) => error.code === 'response_too_large',
)

let cancelled = false
const streaming = new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(new Uint8Array([1, 2]))
    controller.enqueue(new Uint8Array([3, 4]))
  },
  cancel() {
    cancelled = true
  },
}))
await assert.rejects(
  () => readResponseBodyLimited(streaming, 3, 'fixture'),
  (error) => error.code === 'response_too_large',
)
assert.equal(cancelled, true)

console.log('Bounded response streaming check passed.')
