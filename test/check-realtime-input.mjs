import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { buildNationalGtfsCityStore, routeNationalGtfsStore, disposeNationalGtfsStore } from '../src/server/national-gtfs-store.mjs'
import { PbfWriter } from 'pbf'
import { realtimeSources, maximumRealtimeSources } from '../src/shared/realtime-sources.mjs'
import { mbtaRealtimeSources, realtimeRequestFromSources } from '../src/app/realtime.ts'
import { inspectRealtimeFeed } from '../src/server/realtime-inspector.mjs'
import { resolveRealtimeTripTimes } from '../src/server/realtime-trip-timing.mjs'

assert.deepEqual(realtimeRequestFromSources(mbtaRealtimeSources), { sources: mbtaRealtimeSources })
assert.equal(realtimeSources({ sources: [{ url: 'https://transit.example/updates', kind: 'tripUpdates' }] }).length, 1, 'Trip predictions do not require a vehicle feed.')
assert.equal(realtimeSources({ url: mbtaRealtimeSources[0].url }).length, 3, 'Saved MBTA connections migrate.')
assert.equal(realtimeSources({ url: `https://viz.rt.gtfs.zone/#rt_tu=${encodeURIComponent(mbtaRealtimeSources[1].url)}` })[0].kind, 'tripUpdates')
assert.equal(realtimeSources({ sources: [mbtaRealtimeSources[0], mbtaRealtimeSources[0]] }).length, 1)
for (const url of ['', 'invalid', 'file:///tmp/feed.pb', 'https://user:secret@transit.example/feed']) {
  assert.throws(() => realtimeSources({ sources: [{ url }] }))
}
assert.throws(() => realtimeSources({ sources: Array.from({ length: maximumRealtimeSources + 1 }, () => mbtaRealtimeSources[0]) }), /1 to/)
assert.throws(() => realtimeSources({ sources: ['north', 'south'].map(sourceScope => ({ ...mbtaRealtimeSources[0], sourceScope })) }), /two static/)

// Real protobuf documents over a real HTTP socket exercise the production
// URL policy, decoder and aggregation. No transport or provider is replaced.
const now = Math.floor(Date.now() / 1000)
function document(delay, incrementality = 0) {
  const pbf = new PbfWriter()
  pbf.writeMessage(1, (_, out) => { out.writeStringField(1, '2.0'); out.writeVarintField(2, incrementality); out.writeVarintField(3, now) })
  pbf.writeMessage(2, (_, out) => {
    out.writeStringField(1, 'same-entity')
    out.writeMessage(3, (_, trip) => {
      trip.writeMessage(1, (_, descriptor) => { descriptor.writeStringField(1, 'same-trip'); descriptor.writeStringField(3, '20260926') })
      trip.writeMessage(2, (_, stop) => {
        stop.writeVarintField(1, 2)
        stop.writeMessage(3, (_, departure) => departure.writeVarintField(1, delay))
      })
    })
  })
  return Buffer.from(pbf.finish())
}
const documents = new Map([['/north', document(120)], ['/south', document(300)], ['/differential', document(0, 1)]])
const server = http.createServer((request, response) => {
  const bytes = documents.get(request.url)
  response.writeHead(bytes ? 200 : 404, { 'content-type': 'application/x-protobuf' }); response.end(bytes)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-multi-feed-'))
const store = path.join(directory, 'routing.sqlite')
const previous = process.env.VIGO_UNSAFE_ALLOW_PRIVATE_REALTIME
process.env.VIGO_UNSAFE_ALLOW_PRIVATE_REALTIME = '1'
try {
  const origin = `http://127.0.0.1:${server.address().port}`
  const sources = ['north', 'south'].map(sourceScope => ({ url: `${origin}/${sourceScope}`, kind: 'tripUpdates', sourceScope }))
  const snapshot = await inspectRealtimeFeed({ sources: [...sources, { url: `${origin}/differential` }] })
  assert.deepEqual(snapshot.tripUpdates.map(update => update.sourceScope), ['north', 'south'])
  assert.equal(snapshot.feeds[0].sourceScope, 'north')
  assert.equal(snapshot.feeds[2].error.includes('DIFFERENTIAL'), true)
  assert.equal(snapshot.freshness.status, 'unknown', 'A failed source cannot yield an all-fresh batch.')
  assert.equal(snapshot.tripUpdates[0].delaySeconds, undefined, 'A stop prediction cannot become a trip-wide delay.')
  const rows = [0, 1, 2].map(i => ({ stop_id: `S${i}`, stop_sequence: i + 1, arrival: 36000 + i * 600, departure: 36000 + i * 600 }))
  const timing = resolveRealtimeTripTimes(rows, snapshot.tripUpdates[0], epoch => epoch)
  assert.deepEqual(timing.stopTimes.map(stop => stop.departure), [36000, 36720, 37320], 'Only the reported stop and downstream calls inherit its delay.')
  assert.equal(resolveRealtimeTripTimes(rows, { stopTimeUpdates: [{ stopSequence: 3 }, { stopSequence: 2 }] }, epoch => epoch).status, 'invalid')
  const feeds = []
  for (const [scope, longitude] of [['north', 0], ['south', 10]]) {
    const zip = new JSZip()
    zip.file('agency.txt', 'agency_id,agency_name,agency_url,agency_timezone\nA,Agency,https://example.test,UTC\n')
    zip.file('stops.txt', `stop_id,stop_name,stop_lat,stop_lon\n${[0, 1, 2].map(i => `S${i},Stop ${i},0,${longitude + i * .1}`).join('\n')}\n`)
    zip.file('routes.txt', 'route_id,agency_id,route_short_name,route_type\nR,A,R,3\n')
    zip.file('trips.txt', 'route_id,service_id,trip_id\nR,day,same-trip\n')
    zip.file('calendar_dates.txt', 'service_id,date,exception_type\nday,20260926,1\n')
    zip.file('stop_times.txt', `trip_id,arrival_time,departure_time,stop_id,stop_sequence\n${[0, 1, 2].map(i => `same-trip,10:${i}0:00,10:${i}0:00,S${i},${i + 1}`).join('\n')}\n`)
    const zipPath = path.join(directory, `${scope}.zip`)
    await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer' }))
    feeds.push({ scope, path: zipPath })
  }
  await buildNationalGtfsCityStore({ feeds, outputPath: store })
  for (const [scope, longitude, arrival] of [['north', 0, 622], ['south', 10, 625]]) {
    for (const timePreference of ['depart', 'arrive']) {
      const result = routeNationalGtfsStore(store, {
        origin: { source: 'stop', stopId: `${scope}\u001fS0`, coordinate: [longitude, 0] },
        destination: { source: 'stop', stopId: `${scope}\u001fS2`, coordinate: [longitude + .2, 0] },
        serviceDate: '2026-09-26', serviceDay: 'saturday', departMinutes: 590, arriveMinutes: 640,
        timePreference, maxWalkKm: .1, routingDataMode: 'realtime', realtimeSnapshot: snapshot,
      })
      assert.equal(result.status, 'ready', result.detail)
      assert.equal(result.legs.find(leg => leg.type === 'ride').startMinutes, 600, 'A downstream stop delay must not change origin boarding.')
      assert.equal(result.arriveMinutes, arrival, 'Identical trip IDs remain isolated by their static GTFS source.')
      assert.equal(result.diagnostics.realtimeRouting.status, 'partial')
      assert.equal(result.diagnostics.realtimeRouting.coverage.failedFeeds, 1)
      assert.equal(result.diagnostics.realtimeRouting.coverage.complete, false)
    }
  }
  const raw = await inspectRealtimeFeed({ sources: [sources[0]] }, { feedIds: ['north'], sourceScopes: [''] })
  assert.equal(raw.tripUpdates[0].sourceScope, undefined, 'A single-feed City keeps its raw IDs.')
  await assert.rejects(inspectRealtimeFeed({ sources }, { feedIds: ['north'] }), /no longer in this City/)
  const failed = await inspectRealtimeFeed({ sources: [{ url: `${origin}/absent` }] })
  assert.equal(failed.feeds[0].error.includes('404'), true)
  assert.equal(failed.counts.tripUpdates, 0)
} finally {
  if (previous === undefined) delete process.env.VIGO_UNSAFE_ALLOW_PRIVATE_REALTIME
  else process.env.VIGO_UNSAFE_ALLOW_PRIVATE_REALTIME = previous
  await new Promise(resolve => server.close(resolve))
  disposeNationalGtfsStore(store)
  await fs.rm(directory, { recursive: true, force: true })
}
console.log('Multiple live feeds preserve static source identity, independent failures, and downstream-only predictions.')
