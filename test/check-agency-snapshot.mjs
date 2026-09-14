import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { realtimeSnapshotFromFeed, realtimeSnapshotFromFeeds } from '../src/server/realtime-snapshot.mjs'
import { gtfsRealtimeEnums } from '../src/server/gtfs-realtime-decoder.mjs'
import { createAgencyService } from '../src/server/agency-api.mjs'
import { createAgencyFixture, realtimeFixture, observationTime } from './fixtures/agency.mjs'

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
for (const [enumObject, record, read] of [
  [gtfsRealtimeEnums.FeedHeader.Incrementality, value => realtimeSnapshotFromFeed({ header: { incrementality: value } }, 'fixture', stamp), snapshot => snapshot.incrementality],
  ...['VehicleStopStatus', 'CongestionLevel', 'OccupancyStatus'].map((name, i) => { const field = ['currentStatus', 'congestionLevel', 'occupancyStatus'][i]; return [gtfsRealtimeEnums.VehiclePosition[name], value => normalize([{ id: 'v', vehicle: { [field]: value } }]), snapshot => snapshot.vehicles[0][field]] }),
  ...['Cause', 'Effect', 'SeverityLevel'].map((name, i) => { const field = ['cause', 'effect', 'severityLevel'][i]; return [gtfsRealtimeEnums.Alert[name], value => normalize([{ id: 'a', alert: { [field]: value } }]), snapshot => snapshot.alerts[0][i === 2 ? 'severity' : field]] }),
  [gtfsRealtimeEnums.TripDescriptor.ScheduleRelationship, value => normalize([{ id: 't', tripUpdate: { trip: { scheduleRelationship: value } } }]), snapshot => snapshot.tripUpdates[0].scheduleRelationship],
  [gtfsRealtimeEnums.StopTimeUpdate.ScheduleRelationship, value => normalize([{ id: 't', tripUpdate: { stopTimeUpdate: [{ scheduleRelationship: value }] } }]), snapshot => snapshot.tripUpdates[0].stopTimeUpdates[0].scheduleRelationship],
]) {
  for (const value of [...Object.values(enumObject), -1, 999, '0', null, undefined, NaN]) {
    const expected = Object.entries(enumObject).find(([, code]) => code === value)?.[0]
    assert.equal(read(record(value)), expected, 'Enum lookup retains strict numeric matching, including unknown values.')
  }
}
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

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agency-snapshot-'))
const file = path.join(directory, 'schedule.sqlite')
createAgencyFixture(file)
const sourceSnapshot = realtimeFixture()
let calls = 0
let now = observationTime * 1000
const provider = { available: false, model: null }
const agency = createAgencyService({ context: async () => ({ storePath: file, cityName: 'City X' }), inspectRealtime: async () => { calls++; return sourceSnapshot } }, { clock: () => now, provider, refreshMs: 60_000 })
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
  assert.match(skill.answer, /Reporting trips currently match the timetable/)
  const recalled = await agency.handle('city', { action: 'tool', name: 'recall_notebook', arguments: { entryId: skill.entryId } })
  assert.equal(recalled.data.entries[0].observedAt, live.generatedAt)
  assert.equal(calls, 1, 'Notebook retrieval uses City evidence without fetching feeds or calling a model')
  await agency.handle('city', { action: 'skill-install', skill: {
    id: 'partial-study', name: 'Partial study', description: 'Exercise a failed tool after a completed check.', instructions: 'Read the network, then the selected route.', inputs: [],
    steps: [{ tool: 'network_overview' }, { tool: 'service_alerts', arguments: { routeId: 'missing-route' } }, { tool: 'realtime_status' }],
  } })
  const partial = await agency.handle('city', { action: 'run-skill', id: 'partial-study' })
  assert.match(partial.answer, /Study incomplete\. 1 of 3 checks completed/)
  assert.equal(partial.trace.length, 2)
  assert.equal(partial.trace[1].result.ok, false)
  const saved = await agency.handle('city', { action: 'notebook-entry', id: partial.entryId })
  assert.deepEqual(saved.entries[0].answer.trace, partial.trace, 'A failed later step must not discard the saved investigation')
  const stop = new AbortController()
  const stopped = await agency.handle('city', { action: 'run-skill', id: 'network-health-summary' }, stop.signal, (activity) => { if (activity.phase === 'skill-0' && activity.progress === 1) stop.abort() })
  assert.match(stopped.answer, /Study stopped\. 1 of 3 checks completed/)
  assert.equal(stopped.trace.length, 1)
  assert.ok((await agency.handle('city', { action: 'notebook-entry', id: stopped.entryId })).entries.length)
  await agency.handle('city', { action: 'skill-install', skill: { id: 'alert-summary', name: 'Alert evidence summary', description: 'Exercise cancellation during model interpretation.', instructions: 'Summarize the published notice.', inputs: [], steps: [{tool:'realtime_status'},{tool:'service_alerts'},{tool:'service_alerts'}] } })
  const summaryStop = new AbortController()
  sourceSnapshot.alerts.push({ id: 'summary-check', header: 'River service notice', sourceUrl: sourceSnapshot.feeds[0].sourceUrl })
  provider.available = true
  provider.complete = async () => { summaryStop.abort(); throw new Error('Summary interrupted') }
  const stoppedSummary = await agency.handle('city', { action: 'run-skill', id: 'alert-summary' }, summaryStop.signal)
  assert.match(stoppedSummary.answer, /Study stopped\. 3 of 3 checks completed/)
  assert.match(stoppedSummary.answer, /River service notice/, 'A cancelled summary retains the supplied service evidence')
  assert.equal(stoppedSummary.aiGenerated, false)
  assert.ok(stoppedSummary.entryId, 'Cancellation during AI summarization must also retain all completed checks')
  provider.available = false
  sourceSnapshot.alerts = []
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
