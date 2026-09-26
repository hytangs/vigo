import assert from 'node:assert/strict'

import { realtimeSnapshotFromFeed, realtimeSnapshotFromFeeds } from '../src/server/realtime-snapshot.mjs'

import { observationTime } from './fixtures/agency.mjs'

const stamp = '2026-09-13T12:00:00Z'
const normalize = entities => realtimeSnapshotFromFeed({ header: { timestamp: observationTime, incrementality: 0 }, entity: entities }, 'fixture', stamp, 'application/x-protobuf')
const mixed = { id: 'mixed', vehicle: { trip: { directionId: 0 }, position: { latitude: 0, longitude: 0, speed: 0 }, currentStopSequence: 0, currentStatus: 0, occupancyPercentage: 0 },
  tripUpdate: { trip: { tripId: 'T1', scheduleRelationship: 0 }, stopTimeUpdate: [{ stopId: 'A', stopSequence: 0, arrival: { delay: -12, uncertainty: 0 }, departure: { time: 0 } }] } }
const input = [mixed, { id: 'removed', isDeleted: true, vehicle: mixed.vehicle, tripUpdate: mixed.tripUpdate }, { id: 'notice', alert: { headerText: { translation: [{ language: 'en', text: 'Notice' }] } } }]
const retainedInput = structuredClone(input), normalized = normalize(input)
assert.deepEqual(input, retainedInput, 'Normalization must not mutate the shared decoded feed.')
assert.deepEqual(normalized.counts, { vehicles: 1, tripUpdates: 1, alerts: 1, other: 0 })
assert.equal(normalized.entityCount, 2, 'Deleted entities are excluded, while a multi-kind entity is counted once.')
assert.equal(normalize([{ id: 'unknown' }]).counts.other, 1)
assert.equal(normalized.vehicles[0].entityId, 'mixed')
assert.equal(normalized.vehicles[0].directionId, 0)
assert.equal(normalized.vehicles[0].lat, 0)
assert.equal(normalized.vehicles[0].lon, 0)
assert.equal(normalized.vehicles[0].speed, 0)
assert.equal(normalized.vehicles[0].occupancyPercentage, 0)
assert.equal(normalized.vehicles[0].currentStatus, 'INCOMING_AT')
assert.equal(normalized.tripUpdates[0].stopTimeUpdates[0].arrival.delay, -12)
assert.equal(normalized.tripUpdates[0].stopTimeUpdates[0].arrival.uncertainty, 0)
assert.equal(normalized.tripUpdates[0].stopTimeUpdates[0].departure.time, 0)
assert.equal(normalized.tripUpdates[0].stopTimeUpdates[0].stopSequence, 0)
assert.equal(normalized.alerts[0].header, 'Notice')
assert.equal(normalize([{ id: 'unknown', tripUpdate: { trip: { scheduleRelationship: 999 } } }]).tripUpdates[0].scheduleRelationship, 'UNKNOWN', 'Unknown relationships cannot silently become scheduled service.')
const snapshot = realtimeSnapshotFromFeeds([
  { sourceUrl: 'https://example.org/trips', kind: 'tripUpdates', fetchedAt: stamp, feed: { header: { timestamp: observationTime - 250, gtfsRealtimeVersion: '2.0' }, entity: [
    { id: 'trip-entity', tripUpdate: { trip: { tripId: 'T1', routeId: 'R', directionId: 0, startDate: '20260913', startTime: '12:05:00' }, vehicle: { id: 'V1' }, timestamp: observationTime - 250, stopTimeUpdate: [] } },
  ] } },
  { sourceUrl: 'https://example.org/vehicles', kind: 'vehicles', fetchedAt: stamp, feed: { header: { timestamp: observationTime, gtfsRealtimeVersion: '2.0' }, entity: [{ id: 'vehicle-entity', vehicle: { trip: { tripId: 'T1', directionId: 0 }, vehicle: { id: 'V1' }, timestamp: observationTime, currentStopSequence: 10 } }] } },
  { sourceUrl: 'https://example.org/alerts', kind: 'alerts', fetchedAt: stamp, feed: { header: { gtfsRealtimeVersion: '2.0' }, entity: [] } },
])
assert.equal(snapshot.tripUpdates[0].directionId, 0)
assert.equal(snapshot.tripUpdates[0].vehicleId, 'V1')
assert.equal(snapshot.tripUpdates[0].startTime, '12:05:00')
assert.equal(snapshot.tripUpdates[0].sourceUrl, 'https://example.org/trips')
assert.equal(snapshot.tripUpdates[0].sourceFeedTimestamp, observationTime - 250)
assert.equal(snapshot.vehicles[0].entityId, 'vehicle-entity')
assert.equal(snapshot.vehicles[0].currentStopSequence, 10)
assert.equal(snapshot.feeds[2].feedTimestamp, undefined)
assert.equal(snapshot.feedTimestamp, undefined, 'An unknown source time cannot become a fresh aggregate timestamp')
assert.equal(snapshot.freshness.status, 'stale')
const failed = realtimeSnapshotFromFeeds([{ sourceUrl: 'https://example.org/feed', kind: 'feed', fetchedAt: stamp, error: 'Fixture failure' }])
assert.equal(failed.freshness.status, 'unknown')
assert.equal(failed.feeds[0].error, 'Fixture failure')

const future = realtimeSnapshotFromFeeds([{ sourceUrl: 'https://example.org/future', kind: 'tripUpdates', fetchedAt: stamp, feed: { header: { timestamp: observationTime + 181 }, entity: [] } }])
assert.equal(future.freshness.status, 'unknown', 'A future feed header must not become fresh through age clamping')

const cars = [{ label: '1462', carriageSequence: 1, occupancyStatus: 2, occupancyPercentage: 0 }, { carriageSequence: 2, occupancyPercentage: -1 }]
const train = normalize([{ id: 'train', vehicle: { multiCarriageDetails: cars } }]).vehicles[0]
assert.equal(train.occupancyStatus, undefined)
assert.deepEqual(train.carriages, [{ label: '1462', carriageSequence: 1, occupancyStatus: 'FEW_SEATS_AVAILABLE', occupancyPercentage: 0 }, { carriageSequence: 2 }])
assert.equal(normalize([{ id: 'train', vehicle: { multiCarriageDetails: [cars[1]] } }]).vehicles[0].carriages, undefined, 'Invalid carriage sequences must be discarded')

console.log('Realtime decoding and source-clock normalization passed.')
