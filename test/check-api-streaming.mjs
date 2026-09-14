import assert from 'node:assert/strict'
import { apiProgressJson } from '../src/app/api.ts'

const originalFetch = globalThis.fetch
const encoder = new TextEncoder()
let cancelled = false, body
function response(chunks, close = true) {
  cancelled = false
  body = new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); if (close) controller.close() },
    cancel() { cancelled = true },
  })
  globalThis.fetch = async () => new Response(body)
}
const bytes = text => encoder.encode(text)
try {
  const progress = [], preliminary = []
  const wire = bytes('{"type":"progress","progress":{"detail":"Checking…"}}\n{"type":"preliminary","answer":"初步"}\n{"type":"complete","answer":"完成"}')
  response([...wire].map(byte => Uint8Array.of(byte)))
  assert.equal((await apiProgressJson('/test', {}, item => progress.push(item), item => preliminary.push(item))).answer, '完成')
  assert.equal(progress[0].detail, 'Checking…')
  assert.equal(preliminary[0].answer, '初步')
  assert.equal(body.locked, false, 'Completed requests release the stream reader')

  for (const content of ['{"type":"error","error":"Study failed"}\n', 'not-json\n']) {
    response([bytes(content)], false)
    await assert.rejects(apiProgressJson('/test', {}, () => {}))
    assert.equal(cancelled, true, 'Rejected streams must cancel upstream work')
    assert.equal(body.locked, false)
  }
  response([bytes('{"type":"progress","progress":{"detail":"Working"}}\n')], false)
  await assert.rejects(apiProgressJson('/test', {}, () => { throw new Error('View closed') }), /View closed/)
  assert.equal(cancelled, true, 'A failed consumer must also release its connection')

  response([bytes('{"type":"complete","answer":"Ready"}\n')], false)
  const deadline = AbortSignal.timeout(1000)
  const timeout = new Promise((_, reject) => deadline.addEventListener('abort', () => reject(new Error('Completion waited for the socket to close')), { once: true }))
  const keepAlive = setInterval(() => {}, 1000)
  try { assert.equal((await Promise.race([apiProgressJson('/test', {}, () => {}), timeout])).answer, 'Ready') }
  finally { clearInterval(keepAlive) }
  assert.equal(cancelled, true)
  assert.equal(body.locked, false)

  response([bytes('{"type":"progress","progress":{"detail":"Interrupted"}}\n')])
  await assert.rejects(apiProgressJson('/test', {}, () => {}), /ended before returning/)
  assert.equal(body.locked, false)
} finally { globalThis.fetch = originalFetch }
console.log('API streaming: chunk boundaries, terminal completion, interrupted results and upstream cleanup passed.')
