import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { createPublicRoutingGateway, publicRouteInput } from '../src/server/public-routing-gateway.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-public-routing-'))
await fs.writeFile(path.join(root, 'index.html'), '<html><body>VIGO</body></html>')
await fs.writeFile(path.join(root, 'vigo.mjs'), 'private server source')
let requests = [], release
const upstream = http.createServer(async (req, res) => {
  let body = ''
  for await (const part of req) body += part
  requests.push({ url: req.url, body: body ? JSON.parse(body) : null })
  if (req.url.endsWith('/national-route') && release) await new Promise(resolve => { release.resolve = resolve })
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(req.url.startsWith('/api/projects/bos2?') ? { project: {
    id: 'bos2', name: 'Boston', storagePath: '/var/private/cities/bos2', jobs: [{ sourcePath: '/var/private/a.zip' }], artifacts: [],
    routingStore: { status: 'ready' }, osmStreetIndex: { status: 'ready', snapshotPath: '/var/private/snapshot', driveEdgeCount: 3 },
    feeds: [{ id: 'mbta', routeCount: 10, sourcePath: '/var/private/a.zip', mapPreview: {
      routes: [{ id: 'line', points: Array(1000).fill([-71, 42]) }], stopPairs: [],
      stops: [
        { id: 'west', lon: -72, lat: 42 }, { id: 'east', lon: -70, lat: 42 },
        { id: 'north', lon: -71, lat: 43 }, { id: 'south', lon: -71, lat: 41 },
        { id: 'interior', lon: -71, lat: 42 },
      ],
    } }],
  } } : { snapshot: { fetchedAt: '2026-11-05T12:00:00Z' }, choices: [], path: '/var/private/city', ready: true }))
})
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
const gateway = createPublicRoutingGateway({ upstream: `http://127.0.0.1:${upstream.address().port}`, publicOrigin: 'https://app.example.test', cityId: 'bos2', staticRoot: root, maxActive: 1 })
gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening')
const base = `http://127.0.0.1:${gateway.address().port}`
const query = { mode: 'bike', origin: { coordinate: [-71.1, 42.3], label: 'A' }, destination: { coordinate: [-71.09, 42.31], label: 'B' }, departMinutes: 480, serviceDate: '2026-11-05', bike: { profile: 'balanced', speedKph: 18 } }
const post = body => fetch(base + '/api/projects/bos2/national-route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const hostStatus = host => new Promise((resolve, reject) => {
  http.get(base + '/api/projects', { headers: { Host: host } }, response => { response.resume(); resolve(response.statusCode) }).on('error', reject)
})
try {
  assert.match(await (await fetch(base)).text(), /data-vigo-public-city="bos2"/)
  for (const target of ['/vigo.mjs', '/main.mjs', '/assets/x.map', '/api/config', '/api/storage', '/api/projects/other', '/api/projects/bos2/scenarios', '/api/projects/bos2/reproducibility']) assert((await fetch(base + target)).status >= 400, target)
  for (const target of ['/api/projects', '/api/config', '/api/realtime/inspect', '/api/projects/bos2/agency', '/api/projects/bos2/national-osm-import', '/api/projects/bos2/wheelchair-prepare', '/api/projects/bos2/reach']) assert.equal((await fetch(base + target, { method: 'POST' })).status, 403, target)
  assert.equal((await fetch(base + '/api/projects/bos2', { method: 'DELETE' })).status, 403)
  assert.equal((await fetch(base + '/api/projects', { headers: { Origin: 'https://evil.test' } })).status, 403)
  assert.equal(await hostStatus('evil.test'), 403)
  assert.equal((await fetch(base + '/api/projects', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403)
  const catalog = await (await fetch(base + '/api/projects')).json()
  assert.equal(catalog.projects.length, 1)
  assert(!JSON.stringify(catalog).includes('/private/'))
  assert.deepEqual(catalog.projects[0].jobs, [])
  assert.deepEqual(catalog.projects[0].artifacts, [])
  const preview = catalog.projects[0].feeds[0].mapPreview
  assert.equal(catalog.projects[0].feeds[0].routeCount, 10)
  assert.deepEqual(new Set(preview.stops.map(stop => stop.id)), new Set(['west', 'east', 'north', 'south']), 'initial map extent must survive removal of network geometry')
  assert.deepEqual(preview.routes, [])
  assert(preview.stops.every(stop => Array.isArray(stop.routes)), 'extent stops retain the frontend stop schema')
  assert.equal(preview.coverage.capped, true)
  assert(JSON.stringify(catalog).length < 2000, 'routing startup must not download full network geometry')
  const liveGateway = createPublicRoutingGateway({ upstream: `http://127.0.0.1:${upstream.address().port}`, publicOrigin: 'https://app.example.test', cityId: 'bos2', staticRoot: root, realtimeRequest: { provider: 'test' } })
  liveGateway.listen(0, '127.0.0.1'); await once(liveGateway, 'listening')
  try {
    const response = await fetch(`http://127.0.0.1:${liveGateway.address().port}/api/projects/bos2/national-route`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...query, mode: 'transit', routingDataMode: 'realtime', realtimeSnapshot: { forged: true } }) })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('server-timing'), /^routing;dur=/)
    assert.equal(requests.at(-1).body.realtimeSnapshot, undefined)
    assert.equal(requests.at(-1).body.routingDataMode, 'scheduled')
    assert.equal(requests.filter(r => r.url.endsWith('/agency')).length, 0, 'legacy feed configuration must never fetch live observations')
    const catalog = await (await fetch(`http://127.0.0.1:${liveGateway.address().port}/api/projects`)).json()
    assert.equal(catalog.projects[0].publicRouting.realtime, false)
  } finally {
    liveGateway.closeAllConnections()
    await new Promise(resolve => liveGateway.close(resolve))
  }
  const before = requests.length
  for (const extra of [{ scenario: {} }, { feedIds: ['private'] }, { maxWalkKm: 100 }, { departureWindowMinutes: 100 }, { waypoints: Array(4).fill(query.origin) }, { origin: { coordinate: [0, 0] } }]) assert.equal((await post({ ...query, ...extra })).status, 400)
  assert.equal(requests.length, before, 'invalid inputs must not reach the local server')
  assert.equal((await post({ ...query, ignored: 'x'.repeat(20000) })).status, 413)
  const input = { ...query, feedId: '/private/path', sourcePath: '/private/path', realtimeSnapshot: { forged: true }, maxStreetKm: 999999, leaseId: 'forged' }
  assert.equal((await post(input)).status, 200)
  const forwarded = requests.at(-1).body
  assert.equal(forwarded.feedId, '__project__')
  assert.equal(forwarded.maxStreetKm, 100)
  assert.equal(forwarded.sourcePath, undefined)
  assert.equal(forwarded.realtimeSnapshot, undefined)
  assert.equal(forwarded.leaseId, undefined)
  assert.throws(() => publicRouteInput({ ...query, bike: { profile: 'quiet', speedKph: 1000 } }))
  for (const speedKph of [5, 40]) {
    const bike = { profile: 'quiet', speedKph, maxLts: 2 }
    assert.deepEqual(publicRouteInput({ ...query, bike }).bike, bike)
  }
  assert.throws(() => publicRouteInput({ ...query, bike: { ...query.bike, maxLts: 0 } }))
  assert.throws(() => publicRouteInput({ ...query, bike: { ...query.bike, maxLts: '2' } }))
  release = {}
  const first = post(query)
  while (!release.resolve) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal((await post(query)).status, 429, 'concurrent queries are bounded')
  release.resolve(); release = null
  assert.equal((await first).status, 200)
  for (let i = 0; i < 30; i++) await post(query)
  assert.equal((await post(query)).status, 429, 'query rate is bounded')
  const now = Date.now
  try {
    Date.now = () => now() + 60_000
    assert.equal((await post(query)).status, 200, 'A new minute releases expired visitor budgets')
  } finally { Date.now = now }
  console.log('Public routing gateway: isolation, origin checks, hidden files, metadata redaction, input bounds, concurrency and rate limits passed.')
} finally {
  gateway.closeAllConnections(); upstream.closeAllConnections()
  await Promise.all([new Promise(resolve => gateway.close(resolve)), new Promise(resolve => upstream.close(resolve))])
  await fs.rm(root, { recursive: true, force: true })
}
