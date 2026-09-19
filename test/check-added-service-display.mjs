import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { addedTripIndex } from '../src/agency/addedTrips.mjs'
import { AgencyContext } from '../src/agency/agencyContext.mjs'
import { routeOperations, vehicleDetails } from '../src/agency/routeOperations.mjs'
import { createAgencyFixture, realtimeFixture, observationTime } from './fixtures/agency.mjs'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-added-service-'))
let context
try {
  const file = path.join(directory, 'schedule.sqlite')
  createAgencyFixture(file)
  context = new AgencyContext(file, 'City X')
  const update = { id: 'ADDED-123', tripId: 'ADDED-123', routeId: 'R', directionId: 0, startDate: '20260913', startTime: '12:00:00', scheduleRelationship: 'ADDED',
    vehicleId: 'extra', sourceUrl: 'https://example.org/trips', timestamp: observationTime,
    stopTimeUpdates: [{ stopId: 'A', stopSequence: 10, departure: { time: observationTime + 10 } },
      { stopId: 'B', stopSequence: 30, arrival: { time: observationTime + 100 }, departure: { time: observationTime + 120 } },
      { stopId: 'C', stopSequence: 90, arrival: { time: observationTime + 220 } }] }
  const snapshot = realtimeFixture([update])
  update.sourceUrl = snapshot.feeds[0].sourceUrl
  snapshot.feeds.push({ sourceUrl: 'https://example.org/vehicles', kind: 'vehicles', feedTimestamp: observationTime })
  const vehicle = { id: 'extra', tripId: update.tripId, routeId: 'R', directionId: 0, startDate: update.startDate, startTime: update.startTime, scheduleRelationship: 'ADDED',
    sourceUrl: 'https://example.org/vehicles', timestamp: observationTime, stopId: 'B', currentStopSequence: 30, currentStatus: 'STOPPED_AT' }
  snapshot.vehicles = [vehicle]
  const line = () => routeOperations(context, snapshot, { routeId: 'R', includeTrips: true, tripId: update.tripId }, observationTime)
  let result = line()
  assert.ok(result.trips.some(trip => trip.id === update.tripId && trip.added), 'Added trips are selectable beside scheduled trips')
  assert.equal(result.trip.status, 'Added service')
  assert.deepEqual(result.trip.calls[1].departure, { scheduled: null, current: observationTime + 120 })
  assert.equal(result.trip.calls[1].progress, 'At stop')
  assert.equal(result.vehicles[0].callIndex, 1)
  assert.ok(result.vehicles[0].patternId, 'Added vehicle is placed on the line')
  assert.equal(result.vehicles[0].delaySeconds, null)
  assert.ok(result.trip.calls.every(call => call.arrival.scheduled === null && call.departure.scheduled === null))
  const calls = update.stopTimeUpdates
  update.stopTimeUpdates = calls.slice(2)
  result = line()
  assert.deepEqual(result.trip.calls.map(call => call.stop.id), ['B', 'C'], 'A partial feed retains the reported vehicle stop without inventing passed stops')
  assert.equal(result.trip.calls[0].departure.current, null)
  assert.equal(result.vehicles[0].nextPrediction.stop.id, 'C')
  snapshot.tripUpdates = []
  result = line()
  assert.equal(result.trip.status, 'Added service · position only')
  assert.equal(result.trip.calls.length, 1)
  assert.equal(result.trip.calls[0].stop.id, 'B')
  assert.ok(result.vehicles[0].patternId, 'Vehicle-only added trips remain visible')
  snapshot.tripUpdates = [update]
  update.stopTimeUpdates = calls
  snapshot.vehicles = []
  assert.equal(line().trip.calls[1].departure.current, observationTime + 120, 'Predictions do not require a vehicle position')
  snapshot.vehicles = [vehicle]
  update.timestamp = observationTime - 181
  assert.equal(line().trip.status, 'Stale report')
  assert.equal(line().trip.calls[1].departure.current, null)
  assert.equal(vehicleDetails(context, snapshot, { vehicleId: 'extra' }, observationTime).departure.current, null)
  update.timestamp = observationTime
  snapshot.tripUpdates.push({ ...update, id: 'duplicate' })
  assert.equal(line().trip.status, 'Unresolved reports')
  assert.equal(line().vehicles[0].callIndex, null)
  snapshot.tripUpdates.pop()
  update.stopTimeUpdates = [{ ...calls[0], stopId: 'missing' }]
  assert.equal(line().vehicles[0].callIndex, null, 'Unknown stops cannot create a fabricated line')
  update.stopTimeUpdates = [calls[0], { ...calls[1], stopSequence: 10 }]
  assert.equal(line().vehicles[0].callIndex, null, 'Duplicate sequences cannot establish placement')
  update.stopTimeUpdates = calls
  update.scheduleRelationship = vehicle.scheduleRelationship = 'NEW'
  assert.equal(line().trip.status, 'Added service')
  update.scheduleRelationship = 'CANCELED'
  assert.equal(line().trip.status, 'CANCELED')
  assert.equal(line().vehicles[0].callIndex, null, 'Cancellation overrides the added vehicle descriptor')
  assert.ok(line().trip.calls.every(call => call.departure.current === null))
  update.scheduleRelationship = 'NEW'
  update.startDate = vehicle.startDate = '20260912'
  const today = routeOperations(context, snapshot, { routeId: 'R', includeTrips: true }, observationTime)
  assert.ok(!today.trips.some(trip => trip.added), 'Service dates stay isolated')
  update.startDate = vehicle.startDate = '20260913'
  update.scheduleRelationship = vehicle.scheduleRelationship = 'SCHEDULED'
  assert.throws(line, /active timetable trip/, 'Unknown scheduled IDs are not silently treated as added service')
  const scoped = { timezone: 'Etc/UTC', tripById: new Map(),
    routeIndex: new Map(['east', 'west'].map(scope => [`${scope}\u001fR`, { route_id: `${scope}\u001fR` }])),
    stopIndex: new Map(['east', 'west'].flatMap(scope => ['A','B','C'].map(id => [`${scope}\u001f${id}`, { stop_id: `${scope}\u001f${id}` }]))) }
  update.scheduleRelationship = 'ADDED'
  assert.equal(addedTripIndex(scoped, { tripUpdates: [update] }, () => true).entries.length, 0, 'Colliding raw route IDs do not choose an arbitrary feed')
  update.sourceScope = 'east'
  const indexed = addedTripIndex(scoped, { tripUpdates: [update] }, () => true).entries[0]
  assert.equal(indexed.id, 'east\u001fADDED-123')
  assert.ok(indexed.calls.every(call => call.stopId.startsWith('east\u001f')), 'Stop identities remain within the resolved feed')
  const conflict = addedTripIndex(scoped, { tripUpdates: [update], vehicles: [{ ...vehicle, sourceScope: 'east', directionId: 1 }] }, () => true).entries[0]
  assert.equal(conflict.ambiguous, true, 'Conflicting trip directions do not establish a line position')
  console.log('Added service line placement and trip timetable regressions passed.')
} finally {
  context?.close()
  await fs.rm(directory, { recursive: true, force: true })
}
