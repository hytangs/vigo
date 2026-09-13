import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { realtimeSnapshotFromFeeds } from '../src/server/realtime-snapshot.mjs'
import { createAgencyService } from '../src/server/agency-api.mjs'
import { createAgencyFixture, realtimeFixture, observationTime } from './fixtures/agency.mjs'

const stamp = '2026-09-13T12:00:00Z'
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

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agency-snapshot-'))
const file = path.join(directory, 'schedule.sqlite')
createAgencyFixture(file)
const sourceSnapshot = realtimeFixture()
let calls = 0
let now = observationTime * 1000
const agency = createAgencyService({ context: async () => ({ storePath: file, cityName: 'City X' }), inspectRealtime: async () => { calls++; return sourceSnapshot } }, { clock: () => now, provider: { available: false, model: null }, refreshMs: 60_000 })
try {
  const request = { urls: { tripUpdates: 'https://example.org/feed' } }
  await agency.connect('city', request)
  await agency.connect('city', request)
  assert.equal(calls, 1, 'A second client consumes the server snapshot, without another feed fetch')
  const live = await agency.state('city')
  const result = await agency.handle('city', { action: 'tool', name: 'realtime_status' })
  assert.equal(live.observedAt, result.data.observedAt)
  const skill = await agency.handle('city', { action: 'run-skill', id: 'network-health-summary' })
  assert.equal(skill.trace[1].result.generatedAt, live.generatedAt)
  assert.match(skill.answer, /City X has/)
  const recalled = await agency.handle('city', { action: 'tool', name: 'recall_notebook', arguments: { entryId: skill.entryId } })
  assert.equal(recalled.data.entries[0].observedAt, live.generatedAt)
  assert.equal(calls, 1, 'Notebook retrieval uses City evidence without fetching feeds or calling a model')
  sourceSnapshot.alerts = Array.from({ length: 600 }, (_, index) => ({ id: `network-${index}`, severity: 'SEVERE', header: 'Network notice', sourceUrl: sourceSnapshot.feeds[0].sourceUrl }))
  sourceSnapshot.tripUpdates[0].stopTimeUpdates[0].departure.delay = 300
  const capped = await agency.state('city')
  assert.equal(capped.events.length, 500)
  assert.equal(capped.events.some((event) => event.type === 'delay'), false)
  const scoped = await agency.state('city', { routeId: 'R', eventType: 'delay' })
  assert.equal(scoped.events.length, 1, 'Filter before limiting, so network notices cannot hide a route finding')
  assert.equal(scoped.events[0].routeId, 'R')
  await assert.rejects(agency.state('city', { routeId: 'missing' }), /Unknown route/)
  sourceSnapshot.alerts = []
  now += 181_000
  assert.equal((await agency.state('city')).counts.matchedTrips, 0, 'The same snapshot ages without a new fetch')
  assert.equal(calls, 1)
  await agency.disconnect('city')
  assert.equal((await agency.state('city')).connected, false)
  now = Date.parse('2026-10-02T12:00:00Z')
  await assert.rejects(agency.connect('city', request), /expired/)
  assert.equal(calls, 1, 'Timetable coverage is checked before any realtime network call')
  console.log('Agency snapshots: decoder identity, independent source clocks, partial errors, one server observation, calendar checks before fetch, shared tools/skills, aging, and disconnect passed.')
} finally { agency.close(); await fs.rm(directory, { recursive: true, force: true }) }
