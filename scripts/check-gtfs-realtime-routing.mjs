import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  buildRoutingStoreFromSchedules,
  disposeNationalGtfsStore,
  routeNationalGtfsStore,
} from '../server/national-gtfs-store.mjs'

const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-gtfs-rt-routing-'))
const schedulePath = path.join(folder, 'schedule.json')
const storePath = path.join(folder, 'store.sqlite')

await fs.writeFile(schedulePath, JSON.stringify({
  stops: [
    { id: 'A', name: 'Realtime origin', lat: 0, lon: 0, locationType: 0 },
    { id: 'B', name: 'Realtime middle', lat: 0, lon: 0.01, locationType: 0 },
    { id: 'C', name: 'Realtime destination', lat: 0, lon: 0.02, locationType: 0 },
  ],
  routes: [{
    id: 'R',
    shortName: 'R',
    routeType: 3,
    scheduledTrips: [
      {
        tripId: 'T1',
        serviceId: 'weekday',
        serviceDays: ['weekday'],
        stopTimes: [
          { stopId: 'A', arrivalMinutes: 600, departureMinutes: 600, sequence: 1 },
          { stopId: 'B', arrivalMinutes: 610, departureMinutes: 610, sequence: 2 },
          { stopId: 'C', arrivalMinutes: 620, departureMinutes: 620, sequence: 3 },
        ],
      },
      {
        tripId: 'T2',
        serviceId: 'weekday',
        serviceDays: ['weekday'],
        stopTimes: [
          { stopId: 'A', arrivalMinutes: 630, departureMinutes: 630, sequence: 1 },
          { stopId: 'B', arrivalMinutes: 635, departureMinutes: 635, sequence: 2 },
          { stopId: 'C', arrivalMinutes: 640, departureMinutes: 640, sequence: 3 },
        ],
      },
    ],
  }],
  transferRules: [],
}))

await buildRoutingStoreFromSchedules({
  schedules: [{ feedId: 'fixture', schedulePath }],
  outputPath: storePath,
})

const request = {
  origin: { coordinate: [0, 0], label: 'Origin', source: 'map' },
  destination: { coordinate: [0.02, 0], label: 'Destination', source: 'map' },
  departMinutes: 600,
  serviceDay: 'weekday',
  serviceDate: '2026-08-21',
  maxWalkKm: 1.6,
  __disableDirectWalkDominance: true,
  __disableResultCache: true,
}

const firstRide = (plan) => plan.legs.find((leg) => leg.type === 'ride')
const realtime = (tripUpdates) => ({
  sourceUrl: 'https://cdn.mbta.com/realtime/TripUpdates.pb',
  feedTimestamp: Math.floor(Date.now() / 1000),
  tripUpdates,
})

const scheduled = routeNationalGtfsStore(storePath, request)
assert.equal(scheduled.status, 'ready')
assert.equal(scheduled.scheduleMode, 'exact')
assert.equal(firstRide(scheduled).tripId, 'fixture\u001fT1')
assert.equal(scheduled.arriveMinutes, 620)

const delayed = routeNationalGtfsStore(storePath, {
  ...request,
  realtimeSnapshot: realtime([{
    tripId: 'T1',
    startDate: '20260821',
    scheduleRelationship: 'SCHEDULED',
    delaySeconds: 300,
    stopTimeUpdates: [],
  }]),
})
assert.equal(delayed.status, 'ready')
assert.equal(delayed.scheduleMode, 'realtime-adjusted')
assert.equal(delayed.arriveMinutes, 625)
assert.equal(firstRide(delayed).scheduleMode, 'realtime-adjusted')
assert.equal(delayed.diagnostics.algorithm, 'rust_resident_query_overlay_connection_scan_one_to_many')
assert.equal(delayed.diagnostics.realtimeRouting.appliedTrips, 1)
assert.equal(delayed.diagnostics.realtimeRouting.replacedTrips, 1)

const stopTimed = routeNationalGtfsStore(storePath, {
  ...request,
  realtimeSnapshot: realtime([{
    tripId: 'T1',
    startDate: '20260821',
    scheduleRelationship: 'SCHEDULED',
    stopTimeUpdates: [{
      stopSequence: 3,
      stopId: 'fixture\u001fC',
      scheduleRelationship: 'SCHEDULED',
      arrival: { delay: 120 },
      departure: { delay: 120 },
    }],
  }]),
})
assert.equal(stopTimed.status, 'ready')
assert.equal(stopTimed.scheduleMode, 'realtime-adjusted')
assert.equal(stopTimed.arriveMinutes, 622)
assert.equal(firstRide(stopTimed).endMinutes, 622)

const delayedFromMiddle = routeNationalGtfsStore(storePath, {
  ...request,
  origin: { coordinate: [0.01, 0], label: 'Middle', source: 'map' },
  departMinutes: 605,
  realtimeSnapshot: realtime([{
    tripId: 'T1',
    startDate: '20260821',
    scheduleRelationship: 'SCHEDULED',
    delaySeconds: 300,
    stopTimeUpdates: [],
  }]),
})
assert.equal(delayedFromMiddle.status, 'ready')
assert.equal(firstRide(delayedFromMiddle).fromStopId, 'fixture\u001fB')
assert.equal(firstRide(delayedFromMiddle).startMinutes, 615)
assert.equal(delayedFromMiddle.arriveMinutes, 625)

const canceled = routeNationalGtfsStore(storePath, {
  ...request,
  realtimeSnapshot: realtime([{
    tripId: 'T1',
    startDate: '20260821',
    scheduleRelationship: 'CANCELED',
    stopTimeUpdates: [],
  }]),
})
assert.equal(canceled.status, 'ready')
assert.equal(canceled.scheduleMode, 'exact')
assert.equal(firstRide(canceled).tripId, 'fixture\u001fT2')
assert.equal(canceled.arriveMinutes, 640)
assert.equal(canceled.diagnostics.realtimeRouting.canceledTrips, 1)

const unmatched = routeNationalGtfsStore(storePath, {
  ...request,
  realtimeSnapshot: realtime([{
    tripId: 'not-in-static-feed',
    startDate: '20260821',
    scheduleRelationship: 'SCHEDULED',
    delaySeconds: 600,
    stopTimeUpdates: [],
  }]),
})
assert.equal(unmatched.status, 'ready')
assert.equal(unmatched.scheduleMode, 'exact')
assert.equal(firstRide(unmatched).tripId, 'fixture\u001fT1')
assert.equal(unmatched.arriveMinutes, 620)
assert.equal(unmatched.diagnostics.realtimeRouting.status, 'no_matches')
assert.equal(unmatched.diagnostics.realtimeRouting.unmatchedTrips, 1)

const stale = routeNationalGtfsStore(storePath, {
  ...request,
  realtimeSnapshot: {
    ...realtime([{
      tripId: 'T1',
      startDate: '20260821',
      scheduleRelationship: 'SCHEDULED',
      delaySeconds: 600,
      stopTimeUpdates: [],
    }]),
    feedTimestamp: Math.floor(Date.now() / 1000) - 181,
  },
})
assert.equal(stale.status, 'ready')
assert.equal(stale.scheduleMode, 'exact')
assert.equal(firstRide(stale).tripId, 'fixture\u001fT1')
assert.equal(stale.arriveMinutes, 620)
assert.equal(stale.diagnostics.realtimeRouting.status, 'stale_fallback')

disposeNationalGtfsStore(storePath)
console.log('GTFS-RT routing check passed (delay overlay, stale-trip replacement, cancellation, and scheduled fallback).')
