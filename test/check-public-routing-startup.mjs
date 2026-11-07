import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { createPublicRoutingGateway } from '../src/server/public-routing-gateway.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-public-startup-'))
const requests = [], leases = new Set(), gateways = []
let hold, entered = false, failure = false, malformed = false
const upstream = http.createServer(async (req, res) => {
  let text = ''; for await (const chunk of req) text += chunk
  const body = text ? JSON.parse(text) : {}
  requests.push({ path: req.url, body })
  if (req.url.endsWith('/routing-residency')) {
    if (body.resident) leases.add(body.leaseId); else leases.delete(body.leaseId)
  }
  if (req.url.endsWith('/national-route')) {
    entered = true
    if (hold) await hold.promise
    if (failure) { res.writeHead(503); res.end('{}'); return }
  }
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(req.url.includes('?detail=catalog') ? { project: {id:'bos2',name:'Boston',feeds:[]} }
    : req.url.endsWith('/agency') ? { snapshot: { tripUpdates: [], feedTimestamp: 1000 } }
    : req.url.endsWith('/national-ready') ? { routing: { ready: true } }
    : req.url.endsWith('/national-route') ? malformed ? { error: 'bad' } : { choices: [{ status: 'ready', destination: body.destination }] }
      : { residency: { resident: leases.size > 0 } }))
})
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
const warm = { mode: 'transit', routingDataMode: 'realtime', departNow: true,
  origin: { coordinate: [-71.05, 42.35] }, destination: { coordinate: [-71.07, 42.36] } }
const create = (extra = {}) => {
  const server = createPublicRoutingGateway({ upstream: `http://127.0.0.1:${upstream.address().port}`,
    publicOrigin: 'https://app.example.test', cityId: 'bos2', staticRoot: root,
    realtimeRequest: { sources: [] }, warmupRequests: [warm], ...extra })
  gateways.push(server); return server
}
const barrier = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const until = async predicate => {
  const end = Date.now() + 2000
  while (!predicate()) { assert(Date.now() < end, 'timed out'); await new Promise(r => setTimeout(r, 5)) }
}
try {
  const server = create()
  hold = barrier()
  const pending = server.prepareRouting()
  assert.equal(pending, server.prepareRouting(), 'startup is single-flight')
  await until(() => entered)
  assert.equal(server.listening, false, 'preparation happens before listening')
  assert.equal(leases.size, 1)
  assert(requests.findIndex(r => r.path.includes('?detail=catalog')) < requests.findIndex(r => r.path.endsWith('/national-route')), 'prepare catalog before serving visitors')
  assert(requests.findIndex(r => r.path.endsWith('/national-ready')) < requests.findIndex(r => r.path.endsWith('/national-route')), 'prime scheduled readiness before the first route')
  assert.equal(requests.find(r => r.path.endsWith('/national-route')).body.realtimeSnapshot, undefined)
  assert.equal(requests.find(r => r.path.endsWith('/national-ready')).body.routingDataMode, 'scheduled')
  assert.equal(requests.filter(r => r.path.endsWith('/agency')).length, 0, 'startup ignores legacy live-feed configuration')
  hold.resolve(); hold = null
  const prepared = await pending
  assert.deepEqual(prepared.modes, ['transit']); assert(prepared.ready)
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const destination = { coordinate: [-71.12, 42.37] }
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/projects/bos2/national-route`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...warm, destination }) })
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).choices[0].destination.coordinate, destination.coordinate)
  assert.equal(requests.filter(r => r.path.endsWith('/national-route')).length, 2, 'first visitor query is computed, not a cached startup result')
  const stopping = server.shutdown(); assert.equal(stopping, server.shutdown())
  await stopping; assert.equal(leases.size, 0, 'graceful shutdown releases the server-owned lease')

  assert.equal(requests.findLast(r => r.path.endsWith('/national-route')).body.realtimeSnapshot, undefined)
  assert.equal(requests.findLast(r => r.path.endsWith('/national-route')).body.routingDataMode, undefined)
  assert.equal(requests.findLast(r => r.path.endsWith('/national-route')).body.departNow, true)
  assert.equal(requests.filter(r => r.path.endsWith('/agency')).length, 0)

  for (const kind of ['http', 'malformed']) {
    failure = kind === 'http'; malformed = kind === 'malformed'
    const failed = create()
    await assert.rejects(failed.prepareRouting())
    assert.equal(failed.listening, false)
    assert.equal(leases.size, 0, 'failed startup releases its lease')
    await failed.shutdown()
  }
  failure = malformed = false
  entered = false; hold = barrier()
  const canceled = create()
  const startup = canceled.prepareRouting(); const rejected = assert.rejects(startup)
  await until(() => entered)
  await canceled.shutdown(); await rejected
  assert.equal(leases.size, 0, 'interrupted startup releases its lease')
  hold.resolve(); hold = null
  assert.throws(() => create({ warmupRequests: Array(5).fill(warm) }))
  assert.throws(() => create({ warmupRequests: [{ ...warm, origin: { coordinate: [0, 0] } }] }))
  console.log('Public routing startup: pre-listen scheduled preparation, live-input exclusion, single-flight startup, uncached visitor route, failure/cancellation cleanup and lease release passed.')
} finally {
  hold?.resolve()
  await Promise.all(gateways.map(server => server.shutdown()))
  upstream.closeAllConnections(); await new Promise(r => upstream.close(r))
  await fs.rm(root, { recursive: true, force: true })
}
