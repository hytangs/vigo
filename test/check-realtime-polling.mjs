// `vigo serve --realtime-poll`: the server polls GTFS-RT itself, publishes one
// immutable snapshot per change, and realtime Routes without their own
// snapshot use it. Feeds are real protobuf served from loopback.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { PbfWriter } from 'pbf'
import { decodeGtfsRealtimeFeed } from '../src/server/gtfs-realtime-decoder.mjs'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary as binary } from './helpers/standalone-runtime.mjs'

const root = path.resolve(import.meta.dirname, '..')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-realtime-poll-'))
const city = path.join(directory, 'city')
const token = 'realtime-poll-test-token-123'
const apiKey = 'secret-feed-key-0042'
const base = { requireTransitRide: true, serviceDate: '2026-07-15', time: '07:55', origin: { stopId: 'A' }, destination: { stopId: 'B' }, maxWalkKm: 0.2, diagnostics: 'trace' }
let checks = 0
let feed = { status: 200, body: Buffer.alloc(0) }
let alertFeed = Buffer.alloc(0)
let feedRequests = 0

// GTFS-RT FeedMessage: header (1) and entities (2) with trip updates (3).
function encode({ timestamp = Math.floor(Date.now() / 1000), trips = [] }) {
  const pbf = new PbfWriter()
  pbf.writeMessage(1, (header, w) => {
    w.writeStringField(1, '2.0')
    w.writeVarintField(2, 0)
    w.writeVarintField(3, header.timestamp)
  }, { timestamp })
  for (const trip of trips) {
    pbf.writeMessage(2, (entity, w) => {
      w.writeStringField(1, `entity-${entity.tripId}`)
      w.writeMessage(3, (update, u) => {
        u.writeMessage(1, (t, d) => {
          d.writeStringField(1, t.tripId)
          if (t.canceled) d.writeVarintField(4, 3)
        }, update)
        if (update.delay != null) u.writeVarintField(5, update.delay)
      }, entity)
    }, trip)
  }
  return Buffer.from(pbf.finish())
}
// Alert entities (5): informed route (5.2), effect (7) and English header (10).
function encodeAlerts(alerts, timestamp = Math.floor(Date.now() / 1000)) {
  const pbf = new PbfWriter()
  pbf.writeMessage(1, (header, w) => { w.writeStringField(1, '2.0'); w.writeVarintField(3, header.timestamp) }, { timestamp })
  for (const alert of alerts) {
    pbf.writeMessage(2, (entity, w) => {
      w.writeStringField(1, entity.id)
      w.writeMessage(5, (a, x) => {
        x.writeMessage(5, (route, e) => e.writeStringField(2, route), a.routeId)
        x.writeVarintField(7, a.effect)
        x.writeMessage(10, (text, t) => t.writeMessage(1, (value, u) => { u.writeStringField(1, value); u.writeStringField(2, 'en') }, text), a.header)
      }, entity)
    }, alert)
  }
  return Buffer.from(pbf.finish())
}

const feedServer = http.createServer((request, response) => {
  feedRequests++
  if (request.url === '/alerts.pb') {
    response.writeHead(200).end(alertFeed)
    return
  }
  if (request.headers['x-api-key'] !== apiKey) {
    response.writeHead(403).end()
    return
  }
  response.writeHead(feed.status, { 'content-type': 'application/x-protobuf' }).end(feed.body)
})
let server
try {
  const { gtfsPath, osmPath } = await writeCliFixtureInputs(directory)
  execFileSync(process.execPath, [path.join(root, 'public/vigo.mjs'), 'build', `--gtfs=${gtfsPath}`, `--osm=${osmPath}`, `--output=${city}`], { stdio: ['ignore', 'ignore', 'pipe'] })
  await new Promise(resolve => feedServer.listen(0, '127.0.0.1', resolve))
  const feedUrl = `http://127.0.0.1:${feedServer.address().port}/realtime/TripUpdates.pb?key=${apiKey}`
  feed.body = encode({ trips: [{ tripId: 'T2', delay: 600 }] })
  // The fixture is valid GTFS-RT for Studio's decoder too.
  assert.equal(decodeGtfsRealtimeFeed(feed.body).entity[0].tripUpdate.delay, 600); checks++

  const settings = path.join(directory, 'realtime.json')
  alertFeed = encodeAlerts([])
  const alertUrl = `http://127.0.0.1:${feedServer.address().port}/alerts.pb`
  fs.writeFileSync(settings, JSON.stringify({ intervalSeconds: 5, timeoutSeconds: 2,
    sources: [{ url: feedUrl, kind: 'tripUpdates', headers: { 'x-api-key': apiKey } }, { url: alertUrl, kind: 'alerts' }] }))
  for (const [bad, pattern] of [
    [{ sources: [{ url: 'http://example.test/feed.pb' }] }, /HTTPS/],
    [{ sources: [{ url: feedUrl, kind: 'vehicles' }] }, /kind/],
    [{ sources: [{ url: feedUrl }], intervalSeconds: 1 }, /interval/],
  ]) {
    const file = path.join(directory, 'bad.json')
    fs.writeFileSync(file, JSON.stringify(bad))
    const result = await new Promise(resolve => {
      const child = spawn(binary, ['serve', '--city', city, '--port', '0', '--realtime-poll', file], { env: { PATH: '' } })
      let text = ''
      child.stderr.on('data', data => { text += data })
      child.on('exit', code => resolve({ code, text }))
    })
    assert.notEqual(result.code, 0); assert.match(result.text, pattern); checks++
  }

  server = spawn(binary, ['serve', '--city', city, '--port', '0', '--realtime-poll', settings], { env: { PATH: '', VIGO_API_TOKEN: token, RAYON_NUM_THREADS: '2' } })
  const port = await new Promise((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${text}`)), 60_000)
    server.stderr.on('data', data => { text += data; const m = text.match(/listening on 127\.0\.0\.1:(\d+)/); if (m) { clearTimeout(timer); resolve(Number(m[1])) } })
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${text}`)) })
  })
  const origin = `http://127.0.0.1:${port}`
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const get = async route => (await fetch(`${origin}${route}`, { headers })).json()
  const route = async request => {
    const response = await fetch(`${origin}/v1/route`, { method: 'POST', headers, body: JSON.stringify(request) })
    const result = await response.json()
    assert.equal(response.status, 200, JSON.stringify(result))
    return result
  }
  const generation = async minimum => {
    for (let i = 0; i < 200; i++) {
      const status = await get('/v1/realtime')
      if (status.generation >= minimum) return status
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`No live generation ${minimum}: ${JSON.stringify(await get('/v1/realtime'))}`)
  }

  const first = await generation(1)
  assert.equal(first.status, 'fresh'); assert.equal(first.tripUpdates, 1)
  assert.equal(first.sources[0].status, 'ok'); assert.equal(first.sources[0].entities.tripUpdates, 1)
  assert.equal(first.sources[1].status, 'ok'); assert.equal(first.alerts, 0)
  // Status never echoes feed URLs, query strings or credentials.
  assert(!JSON.stringify(first).includes(apiKey) && !JSON.stringify(first).includes('TripUpdates.pb')); checks++

  const scheduled = await route(base)
  assert.equal(scheduled.trace.arrivalMinutes, 510); checks++
  const live = await route({ ...base, routingDataMode: 'realtime' })
  assert.equal(live.trace.arrivalMinutes, 520)
  assert.equal(live.query.dataMode, 'realtime')
  assert.equal(live.meta.realtime.snapshot.source, 'server')
  assert.equal(live.meta.realtime.snapshot.id, first.snapshotId)
  assert.equal(live.meta.realtime.appliedTrips, 1); checks++
  // An inline snapshot overrides the server's feeds for its own query.
  const inline = await route({ ...base, routingDataMode: 'realtime', realtimeSnapshot: { feedTimestamp: Math.floor(Date.now() / 1000), tripUpdates: [] } })
  assert.equal(inline.trace.arrivalMinutes, 510)
  assert.equal(inline.meta.realtime.snapshot, undefined); checks++

  // A new publication is installed and its view derived while the server is
  // idle, so the next live query reuses it instead of preparing a timetable.
  feed.body = encode({ trips: [{ tripId: 'T2', delay: 300 }] })
  const second = await generation(first.generation + 1)
  assert.notEqual(second.snapshotId, first.snapshotId)
  await new Promise(resolve => setTimeout(resolve, 1000))
  const warmed = await route({ ...base, routingDataMode: 'realtime' })
  assert.equal(warmed.trace.arrivalMinutes, 515)
  assert.equal(warmed.meta.realtime.snapshot.id, second.snapshotId)
  assert.equal(warmed.trace.timing.timetablePreparation, undefined, 'warmed view was prepared on the query path'); checks++
  // Identical content does not publish a new generation.
  await new Promise(resolve => setTimeout(resolve, 6000))
  assert.equal((await get('/v1/realtime')).snapshotId, second.snapshotId); checks++

  const canceled = encode({ trips: [{ tripId: 'T1', canceled: true }, { tripId: 'T2', canceled: true }] })
  feed.body = canceled
  await generation(second.generation + 1)
  assert.equal((await route({ ...base, routingDataMode: 'realtime' })).trace.status, 'blocked')
  assert.equal((await route(base)).trace.arrivalMinutes, 510, 'scheduled routing ignores live feeds'); checks++

  // Live Service Alerts: NO_SERVICE removes a route; other effects annotate legs.
  feed.body = encode({ trips: [{ tripId: 'T2', delay: 600 }] })
  alertFeed = encodeAlerts([{ id: 'r2-suspended', routeId: 'R2', effect: 1, header: 'R2 suspended' }])
  const suspended = await generation((await get('/v1/realtime')).generation + 1)
  if (suspended.alerts === 0) await generation(suspended.generation + 1)
  const blocked = await route({ ...base, routingDataMode: 'realtime' })
  assert.equal(blocked.trace.status, 'blocked')
  assert.equal(blocked.meta.realtime.alerts.noService, 1); checks++
  alertFeed = encodeAlerts([{ id: 'r1-detour', routeId: 'R1', effect: 4, header: 'R1 detour' }])
  for (let i = 0; i < 200 && (await route({ ...base, routingDataMode: 'realtime' })).trace.status === 'blocked'; i++) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const annotated = await route({ ...base, routingDataMode: 'realtime' })
  assert.equal(annotated.trace.arrivalMinutes, 520)
  assert.deepEqual(annotated.journey.legs.filter(l => l.type === 'transit').map(l => l.alerts?.[0]?.header), ['R1 detour', undefined]); checks++
  feed.body = canceled
  await generation((await get('/v1/realtime')).generation + 1)

  // A failed read keeps the last good records and reports the failure;
  // malformed protobuf is rejected as a whole.
  const before = await get('/v1/realtime')
  feed = { status: 200, body: Buffer.from([0x0a, 0xff]) }
  for (let i = 0; i < 100 && (await get('/v1/realtime')).sources[0].status !== 'failed'; i++) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const failed = await get('/v1/realtime')
  assert.equal(failed.sources[0].status, 'failed')
  assert.match(failed.sources[0].lastError, /malformed/)
  assert.equal(failed.tripUpdates, before.tripUpdates)
  const retained = await route({ ...base, routingDataMode: 'realtime' })
  assert.equal(retained.trace.status, 'blocked')
  assert.equal(retained.meta.realtime.coverage.complete, false); checks++
  assert(feedRequests >= 4)

  console.log(`Realtime polling passed (${checks} checks: protobuf trip update and alert feeds, publication, idle warm-up, inline override, cancellation, live alerts, failure retention, redacted status).`)
} finally {
  server?.kill()
  feedServer.close()
  fs.rmSync(directory, { recursive: true, force: true })
}
