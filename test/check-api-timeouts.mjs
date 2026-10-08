import assert from 'node:assert/strict'
import http from 'node:http'
import { apiJson, apiProgressJson } from '../src/app/api.ts'

const originalFetch = globalThis.fetch, originalSetTimeout = globalThis.setTimeout
const server = http.createServer((request, response) => {
  if (request.url.endsWith('header-stall')) return
  response.setHeader('Content-Type', 'application/json')
  if (request.url === '/api/projects') { response.write('{"cities":'); return }
  response.write('{"type":"progress","progress":{"phase":"Working"}}\n')
  if (request.url !== '/steady') return
  let sent = 0
  const interval = setInterval(() => {
    if (++sent === 6) { clearInterval(interval); response.end('{"type":"complete","answer":42}\n') }
    else response.write('{"type":"progress","progress":{"phase":"Working"}}\n')
  }, 60)
  response.on('close', () => clearInterval(interval))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
// Compress the UI's deadline clock, while keeping real HTTP reads and aborts.
globalThis.setTimeout = (fn, delay, ...args) => originalSetTimeout(fn, [15_000, 120_000].includes(delay) ? 200 : delay, ...args)
globalThis.fetch = (input, init) => originalFetch(new URL(input, base), init)
try {
  await assert.rejects(apiJson('/api/projects'), /did not respond within 15 seconds/, 'The deadline must cover a stalled JSON body')
  await assert.rejects(apiJson('/header-stall'), /did not respond within 120 seconds/)
  await assert.rejects(apiProgressJson('/header-stall', {}, () => {}), /stopped responding for two minutes/)
  await assert.rejects(apiProgressJson('/body-stall', {}, () => {}), /stopped responding for two minutes/)
  const updates = []
  assert.equal((await apiProgressJson('/steady', {}, update => updates.push(update))).answer, 42)
  assert.equal(updates.length, 6, 'An advancing stream may outlast the idle deadline')
  for (const request of [signal => apiJson('/api/projects', { signal }), signal => apiProgressJson('/body-stall', { signal }, () => {})]) {
    const controller = new AbortController(), reason = new Error('Selection changed')
    const pending = request(controller.signal)
    const timer = originalSetTimeout(() => controller.abort(reason), 30)
    try { await assert.rejects(pending, error => error === reason || error.name === 'AbortError') }
    finally { clearTimeout(timer) }
  }
  console.log('HTTP deadlines cover headers and bodies, progressing streams remain active, and user cancellation is preserved.')
} finally {
  globalThis.fetch = originalFetch; globalThis.setTimeout = originalSetTimeout
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
