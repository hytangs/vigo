import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgencyContext, serviceEpoch } from '../src/agency/agencyContext.mjs'
import { deriveOperationalState, createObservationHistory } from '../src/agency/realtimeIntelligence.mjs'
import { createAgencyFixture, observationTime, realtimeFixture, tripUpdate, sourceUrl } from './fixtures/agency.mjs'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-agency-'))
const file = path.join(directory, 'schedule.sqlite')
createAgencyFixture(file)
let context = new AgencyContext(file, 'City X')
const derive = (snapshot) => deriveOperationalState(context, snapshot, observationTime)
try {
  assert.equal(context.coverage(observationTime).valid, true)
  assert.equal(context.coverage(Date.parse('2026-10-01T12:00:00Z') / 1000).valid, false)
  assert.equal(serviceEpoch('2026-03-08', 'America/New_York'), Date.parse('2026-03-08T04:00:00Z') / 1000)
  assert.equal(serviceEpoch('2026-11-01', 'America/New_York'), Date.parse('2026-11-01T05:00:00Z') / 1000)
  const normal = derive(realtimeFixture())
  assert.equal(normal.events.length, 0)
  assert.equal(normal.routes[0].headway, 'matches-schedule')
  const delayed = derive(realtimeFixture([tripUpdate('T1', 1200)]))
  assert.equal(delayed.events.find((event) => event.type === 'delay').evidence.delaySeconds, 1200)
  assert.equal(delayed.events[0].vehicleId, 'vehicle-T1')
  assert.equal(delayed.routes[0].headway, 'unknown')
  const compressed = derive(realtimeFixture([tripUpdate('T1', 300), tripUpdate('T2')]))
  assert.equal(compressed.events.find((event) => event.type === 'bunching').evidence.headwayRatio, 0.5)
  const late = realtimeFixture([tripUpdate('T1', 300), tripUpdate('T2')])
  const laterClock = observationTime + 360
  late.feeds[0].feedTimestamp = laterClock
  late.tripUpdates.forEach((update) => { update.timestamp = laterClock })
  assert.equal(deriveOperationalState(context, late, laterClock).events.find((event) => event.type === 'bunching').evidence.observedHeadwaySeconds, 300, 'Keep a late departure whose scheduled time has already passed')
  const duplicateStop = tripUpdate('T1', 300)
  duplicateStop.stopTimeUpdates.push({ ...duplicateStop.stopTimeUpdates[0], departure: { delay: 900 } })
  assert.equal(derive(realtimeFixture([duplicateStop])).events.length, 0, 'Conflicting stop predictions stay unknown')
  const wider = derive(realtimeFixture([tripUpdate('T1'), tripUpdate('T2', 600)]))
  const gap = wider.events.find((event) => event.type === 'service-gap')
  assert.equal(gap.evidence.observedHeadwaySeconds, 1200)
  assert.equal(gap.evidence.expectedDepartures, 2)
  assert.equal(gap.evidence.reportingTrips, 2)
  const missing = derive(realtimeFixture([tripUpdate('T1'), tripUpdate('T3', 600)]))
  assert.equal(missing.events.some((event) => event.type === 'service-gap'), false)
  assert.equal(missing.routes[0].headway, 'unknown')
  const duplicate = derive(realtimeFixture([tripUpdate('T1', 300), tripUpdate('T1', 600)]))
  assert.equal(duplicate.counts.unresolvedTrips, 2)
  assert.equal(duplicate.events.length, 0)
  assert.equal(context.matchTrip(tripUpdate('T1', 0, { directionId: 1 }), '2026-09-13').trip, undefined)
  assert.equal(context.matchTrip(tripUpdate('T1', 0, { startDate: '20260231' }), '2026-09-13').trip, undefined)
  assert.throws(() => serviceEpoch('2026-02-31', 'Etc/UTC'), /Invalid/)
  const cancelled = derive(realtimeFixture([tripUpdate('T1', 0, { scheduleRelationship: 'CANCELED' })]))
  assert.equal(cancelled.events[0].type, 'cancellation')
  const skipped = derive(realtimeFixture([tripUpdate('T1', 0, { stopTimeUpdates: [{ stopId: 'B', stopSequence: 30, scheduleRelationship: 'SKIPPED' }] })]))
  assert.equal(skipped.events[0].type, 'skipped-stop')
  const terminal = derive(realtimeFixture([tripUpdate('T1', 0, { stopTimeUpdates: [{ stopId: 'C', stopSequence: 31, departure: { delay: 1200 } }] })]))
  assert.equal(terminal.events.length, 0, 'Do not invent terminal sequence 31')
  const arrivalOnly = derive(realtimeFixture([tripUpdate('T1', 0, { stopTimeUpdates: [{ stopId: 'A', arrival: { delay: 1200 } }] })]))
  assert.equal(arrivalOnly.events.length, 0)
  const stale = realtimeFixture()
  stale.feeds[0].feedTimestamp -= 181
  assert.equal(derive(stale).counts.matchedTrips, 0)
  assert.equal(derive(stale).events[0].type, 'stale-data')
  const unknown = realtimeFixture()
  delete unknown.feeds[0].feedTimestamp
  assert.equal(derive(unknown).feeds[0].status, 'unknown')
  assert.equal(derive(unknown).counts.matchedTrips, 0)
  const mixed = realtimeFixture()
  mixed.feeds.push({ sourceUrl: 'https://example.org/vehicles.pb', kind: 'vehicles', feedTimestamp: observationTime - 900 })
  assert.equal(derive(mixed).feeds[1].status, 'stale')
  assert.equal(derive(mixed).counts.matchedTrips, 3)
  const alert = realtimeFixture()
  alert.alerts.push({ id: 'alert', sourceUrl, severity: 'SEVERE', header: 'River stop closed', routeIds: ['R'], stopIds: ['A'], activePeriods: [{ start: observationTime - 60, end: observationTime + 60 }] })
  assert.equal(derive(alert).events[0].severity, 'critical')
  context.routes.push({ ...context.routes[0], route_id: 'second\u001fR' })
  const ambiguousAlert = derive(alert).events.find((event) => event.type === 'service-alert')
  assert.deepEqual(ambiguousAlert.routeIds, [])
  alert.alerts[0].sourceScope = 'second'
  assert.deepEqual(derive(alert).events.find((event) => event.type === 'service-alert').routeIds, ['second\u001fR'])
  delete alert.alerts[0].sourceScope
  context.routes.pop()
  alert.alerts[0].activePeriods[0].end = observationTime
  assert.equal(derive(alert).counts.alerts, 0)
  const station = { stop_id: 'STA', name: 'River Station', lat: 42.36, lon: -71.06, location_type: 1 }
  context.stops.push(station); context.stopIndex.set('STA', station); context.stopIndex.get('A').parent_station = 'STA'
  assert.equal(context.resolve({ query: 'River', kind: 'stop' }).matches[0].id, 'STA', 'Use the declared parent station for place names')
  assert.equal(context.resolve({ query: 'A', kind: 'stop' }).matches[0].id, 'A', 'An explicit platform ID retains its identity')
  const history = createObservationHistory()
  assert.equal(history.update(delayed).tripHistory.T1.length, 1)
  assert.equal(history.update(delayed).tripHistory.T1.length, 1)
  context.close()
  const db = new DatabaseSync(file)
  db.exec("INSERT INTO calendar_dates VALUES('S',20260913,2)")
  db.close()
  context = new AgencyContext(file, 'City X')
  assert.equal(context.coverage(observationTime).valid, false, 'Calendar removals override regular service')
  assert.equal(derive(realtimeFixture()).counts.matchedTrips, 0)
  console.log('Agency realtime: schedule dates, DST, exact stops, delay, headways, missing reports, cancellation, skipped stops, independent freshness, alerts, history passed.')
} finally {
  context.close()
  await fs.rm(directory, { recursive: true, force: true })
}
