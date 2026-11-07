import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import edge from '../src/server/public-routing-edge.mjs'
import { createPublicRoutingGateway } from '../src/server/public-routing-gateway.mjs'
import { apiJson, apiProgressJson } from '../src/app/api.ts'

const request = (path = '/', init = {}) => new Request(`https://app.vigo.city${path}`, init)
let calls = 0
const unavailable = { ROUTING: { fetch() { calls++; throw Error('private origin and tunnel details') } } }
const page = await edge.fetch(request('/', { headers: { Accept: 'text/html' } }), unavailable)
assert.equal(page.status, 503)
assert.match(page.headers.get('Content-Type'), /text\/html/)
assert.equal(page.headers.get('Cache-Control'), 'no-store')
assert.equal(page.headers.get('Retry-After'), '30')
const html = await page.text(), csp = page.headers.get('Content-Security-Policy')
const nonce = /nonce="([a-f0-9]+)"/.exec(html)[1]
assert(csp.includes(`script-src 'nonce-${nonce}'`))
assert(csp.includes("frame-ancestors 'none'"))
assert.match(html, /Routing is temporarily unavailable/)
assert.match(html, /window.location.replace\('https:\/\/vigo.city\/'\)/)
assert.match(html, /remaining=8/)
assert.match(html, /Stay here/)
assert(!html.includes('private origin'))
assert(!/<(?:script|link|img)[^>]+(?:src|href)=["']https?:/i.test(html), 'offline page has no remote dependencies')
const before = calls
const preview = await edge.fetch(request('/offline'), unavailable)
assert.equal(preview.status, 503)
assert.equal(calls, before, 'offline page does not call the origin')
assert.equal(await (await edge.fetch(request('/offline', { method: 'HEAD' }), unavailable)).text(), '')
const api = await edge.fetch(request('/api/health'), unavailable)
assert.match(api.headers.get('Content-Type'), /application\/json/)
assert.equal(api.headers.get('X-Vigo-Offline'), '1')
assert.deepEqual(await api.json(), { error: 'Routing is temporarily unavailable.', code: 'ROUTING_OFFLINE' })
for (const status of [502, 504, 521, 522, 523, 524, 530]) {
  const response = await edge.fetch(request('/api/health'), { ROUTING: { fetch: async () => new Response('private failure', { status }) } })
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('X-Vigo-Offline'), '1')
}
for (const status of [200, 400, 403, 404, 429, 503]) {
  const response = await edge.fetch(request('/api/projects/bos2/address-search'), { ROUTING: { fetch: async () => new Response('original response', { status }) } })
  assert.equal(response.status, status)
  assert.equal(await response.text(), 'original response', 'ordinary query failures are not global outages')
}
assert.equal((await edge.fetch(request('/api/health', { headers: { 'Sec-Fetch-Site': 'cross-site' } }), unavailable)).status, 403)
assert.equal((await edge.fetch(request('/offline', { headers: { 'Sec-Fetch-Site': 'cross-site' } }), unavailable)).status, 503)
assert.equal((await edge.fetch(request('/offline', { method: 'DELETE' }), unavailable)).status, 403)
assert.equal((await edge.fetch(new Request('https://evil.example/offline'), unavailable)).status, 404)

// A vanished local API is distinguished from request failures by the gateway.
const closed = http.createServer(); closed.listen(0, '127.0.0.1'); await once(closed, 'listening')
const upstream = `http://127.0.0.1:${closed.address().port}`
await new Promise(resolve => closed.close(resolve))
const gateway = createPublicRoutingGateway({ upstream, publicOrigin: 'https://app.vigo.city', cityId: 'bos2', staticRoot: process.cwd() })
gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening')
try {
  const response = await fetch(`http://127.0.0.1:${gateway.address().port}/api/health`)
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('X-Vigo-Offline'), '1')
} finally { await gateway.shutdown() }

const originalFetch = globalThis.fetch, originalDocument = globalThis.document, originalWindow = globalThis.window
const navigations = []
try {
  globalThis.document = { documentElement: { dataset: { vigoPublicCity: 'bos2' } } }
  globalThis.window = { location: { replace: url => navigations.push(url) } }
  for (const call of [() => apiJson('/api/health'), () => apiProgressJson('/api/route', {}, () => {})]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Offline' }), { status: 503, headers: { 'X-Vigo-Offline': '1' } })
    await assert.rejects(call(), /Offline/)
  }
  assert.deepEqual(navigations, ['/offline', '/offline'])
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Busy' }), { status: 503 })
  await assert.rejects(apiJson('/api/route'), /Busy/)
  assert.equal(navigations.length, 2)
  globalThis.document.documentElement.dataset = {}
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Offline' }), { status: 503, headers: { 'X-Vigo-Offline': '1' } })
  await assert.rejects(apiJson('/api/health'), /Offline/)
  assert.equal(navigations.length, 2, 'Studio does not navigate to the public fallback')
} finally {
  globalThis.fetch = originalFetch
  if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument
  if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow
}
console.log('Public offline fallback: independent HTML, safe countdown destination, JSON API errors, security boundaries, gateway outage detection, and public-only navigation passed.')
