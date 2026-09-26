import assert from 'node:assert/strict'
import http from 'node:http'
import { apiJson, apiProgressJson } from '../src/app/api.ts'

const server = http.createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/x-ndjson')
  if (request.url === '/unavailable') { response.writeHead(503); response.end(JSON.stringify({ error: 'The selected City is still opening.' })); return }
  if (request.url === '/invalid') { response.write('not-json\n'); return }
  if (request.url === '/interrupted') { response.end('{"type":"progress","progress":{"detail":"Working"}}\n'); return }
  const wire = Buffer.from('{"type":"progress","progress":{"detail":"Checking…"}}\n{"type":"preliminary","answer":"初步"}\n{"type":"complete","answer":"完成"}\n')
  for (const byte of wire) {
    if (response.destroyed) break
    response.write(Buffer.from([byte]))
    await new Promise(resolve => setImmediate(resolve))
  }
  // Deliberately keep the real connection open after terminal completion.
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
try {
  const progress = [], preliminary = []
  const result = await apiProgressJson(`${base}/stream`, { signal: AbortSignal.timeout(5000) }, item => progress.push(item), item => preliminary.push(item))
  assert.equal(result.answer, '完成')
  assert.equal(progress[0].detail, 'Checking…')
  assert.equal(preliminary[0].answer, '初步')
  await assert.rejects(apiProgressJson(`${base}/invalid`, { signal: AbortSignal.timeout(5000) }, () => {}))
  await assert.rejects(apiProgressJson(`${base}/interrupted`, {}, () => {}), /ended before returning/)
  await assert.rejects(apiProgressJson(`${base}/stream`, {}, () => { throw Error('View closed') }), /View closed/)
  await assert.rejects(apiJson(`${base}/unavailable`), error => error.statusCode === 503 && /selected City is still opening/.test(error.message))
  console.log('Actual HTTP streaming preserves UTF-8, progress, terminal completion, failure and server remediation.')
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
