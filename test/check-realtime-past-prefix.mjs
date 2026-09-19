import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { buildNationalGtfsStore, disposeNationalGtfsStore, routeNationalGtfsStore } from '../src/server/national-gtfs-store.mjs'

const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-realtime-past-prefix-'))
const stores = []
const originalNow = Date.now
const serviceEpoch = Date.parse('2026-09-15T00:00:00Z') / 1000
const epochAt = minutes => serviceEpoch + minutes * 60
const stops = ['A', 'B', 'C', 'D', 'E']
const originalCalls = [['A', 580], ['B', 590], ['C', 600], ['D', 610], ['E', 620]]
const suffixCalls = [['C', 589], ['D', 602], ['E', 610]]
const clock = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`

async function build(name, calls) {
  const archive = new JSZip()
  archive.file('agency.txt', 'agency_id,agency_name,agency_url,agency_timezone\nfixture,Fixture,https://example.test,UTC\n')
  archive.file('stops.txt', `stop_id,stop_name,stop_lat,stop_lon\n${stops.map((id, index) => `${id},${id},0,${index * .1}`).join('\n')}\n`)
  archive.file('routes.txt', 'route_id,agency_id,route_short_name,route_type\nR,fixture,R,3\n')
  archive.file('trips.txt', 'route_id,service_id,trip_id\nR,day,main\n')
  archive.file('calendar_dates.txt', 'service_id,date,exception_type\nday,20260915,1\n')
  archive.file('stop_times.txt', `trip_id,arrival_time,departure_time,stop_id,stop_sequence\n${calls.map(([id, time]) =>
    `main,${clock(time)},${clock(time)},${id},${stops.indexOf(id) + 1}`).join('\n')}\n`)
  const zipPath = path.join(folder, `${name}.zip`)
  const storePath = path.join(folder, `${name}.sqlite`)
  await fs.writeFile(zipPath, await archive.generateAsync({ type: 'nodebuffer' }))
  await buildNationalGtfsStore({ zipPath, outputPath: storePath })
  stores.push(storePath)
  return storePath
}

const point = stopId => ({ stopId, source: 'stop', coordinate: [stops.indexOf(stopId) * .1, 0] })
const request = (from, timePreference, changes = {}) => ({
  origin: point(from), destination: point('E'), serviceDate: '2026-09-15',
  timePreference, ...(timePreference === 'depart' ? { departMinutes: 580 } : { arriveMinutes: 610 }),
  maxWalkKm: .2, __disableDirectWalkDominance: true, ...changes,
})
const rides = plan => plan.legs?.filter(leg => leg.type === 'ride') ?? []
const witness = plan => ({
  status: plan.status,
  ...(plan.status === 'ready' ? {
    departMinutes: plan.departMinutes, arriveMinutes: plan.arriveMinutes,
    rides: rides(plan).map(leg => [leg.tripId, leg.fromStopId, leg.toStopId, leg.startMinutes, leg.endMinutes]),
  } : {}),
})
const realtimeSnapshot = {
  sourceUrl: 'https://example.test/past-prefix.pb', feedTimestamp: epochAt(600),
  tripUpdates: [{
    tripId: 'main', startDate: '20260915', sourceFeedTimestamp: epochAt(600), timestamp: epochAt(600) - 10,
    stopTimeUpdates: suffixCalls.map(([stopId, time]) => ({
      stopId, stopSequence: stops.indexOf(stopId) + 1,
      arrival: { time: epochAt(time), uncertainty: 60 }, departure: { time: epochAt(time), uncertainty: 60 },
    })),
  }],
}

try {
  const baseStore = await build('original', originalCalls)
  const literalStore = await build('literal-suffix', suffixCalls)
  const sameRequest = request('D', 'depart', { departMinutes: 600, routingDataMode: 'realtime', realtimeSnapshot })

  // The timestamp is accepted within the ordinary future tolerance, but it
  // cannot establish that the unreported prefix is past until the clock crosses.
  Date.now = () => (realtimeSnapshot.feedTimestamp - 1) * 1000
  const before = routeNationalGtfsStore(baseStore, sameRequest)
  assert.equal(before.status, 'ready', before.detail)
  assert.equal(before.arriveMinutes, 620)
  assert.equal(before.diagnostics.realtimeRouting.appliedTrips, 0)
  assert.equal(before.diagnostics.realtimeRouting.invalidTrips, 1)
  assert.equal(before.diagnostics.realtimeRouting.omittedPastPrefixStops, 0)

  Date.now = () => (realtimeSnapshot.feedTimestamp + 1) * 1000
  const after = routeNationalGtfsStore(baseStore, sameRequest)
  assert.equal(after.status, 'ready', after.detail)
  assert.equal(after.arriveMinutes, 610, 'Crossing the source timestamp must invalidate the cached scheduled fallback')
  assert.equal(after.diagnostics.realtimeRouting.appliedTrips, 1)
  assert.equal(after.diagnostics.realtimeRouting.invalidTrips, 0)
  assert.equal(after.diagnostics.realtimeRouting.pastPrefixTrips, 1)
  assert.equal(after.diagnostics.realtimeRouting.omittedPastPrefixStops, 2)
  assert.notEqual(after.diagnostics.realtimeRouting.snapshotId, before.diagnostics.realtimeRouting.snapshotId)

  let pairs = 0
  for (const from of ['A', 'B', 'C', 'D']) {
    for (const timePreference of ['depart', 'arrive']) {
      for (const routingPreference of ['fastest', 'balanced']) {
        const input = request(from, timePreference, { routingPreference })
        const realtime = routeNationalGtfsStore(baseStore, { ...input, routingDataMode: 'realtime', realtimeSnapshot })
        const literal = routeNationalGtfsStore(literalStore, { ...input, routingDataMode: 'scheduled' })
        const label = `${from} to E, ${timePreference}, ${routingPreference}`
        assert.deepEqual(witness(realtime), witness(literal), label)
        assert.equal(realtime.diagnostics.realtimeRouting.omittedPastPrefixStops, 2, label)
        if (from === 'A' || from === 'B') {
          assert.equal(realtime.status, 'blocked', `${label}: omitted prefix must have no boarding opportunity`)
          assert.deepEqual(rides(realtime), [], label)
        } else {
          assert.equal(realtime.status, 'ready', label)
          assert.equal(rides(realtime)[0].startMinutes, from === 'C' ? 589 : 602, label)
          assert.equal(rides(realtime)[0].endMinutes, 610, label)
        }
        pairs++
      }
    }
  }
  const missed = routeNationalGtfsStore(baseStore, request('C', 'depart', {
    departMinutes: 590, routingDataMode: 'realtime', realtimeSnapshot,
  }))
  assert.equal(missed.status, 'blocked', 'The replaced trip must not retain its original, later scheduled departure')

  Date.now = () => (realtimeSnapshot.feedTimestamp + 30) * 1000
  const later = routeNationalGtfsStore(baseStore, sameRequest)
  assert.deepEqual(witness(later), witness(after))
  assert.equal(later.diagnostics.realtimeRouting.snapshotId, after.diagnostics.realtimeRouting.snapshotId,
    'An unchanged fresh snapshot must keep a stable compiled identity after the source clock crossing')
  console.log(`Realtime past-prefix check passed (${pairs} native/literal comparisons, prefix boarding exclusion, and future-header cache crossing).`)
} finally {
  Date.now = originalNow
  for (const store of stores) disposeNationalGtfsStore(store)
  await fs.rm(folder, { recursive: true, force: true })
}
