import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { mock } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { AgencyContext, serviceEpoch } from '../src/agency/agencyContext.mjs'
import { deriveOperationalState, createObservationHistory } from '../src/agency/realtimeIntelligence.mjs'
import { diagnoseNetwork, compactDiagnosis } from '../src/agency/networkDiagnosis.mjs'
import { networkNarrative } from '../src/agency/networkNarrative.mjs'
import { networkSynthesisFacts } from '../src/agency/networkSynthesis.mjs'
import { serviceConcentrations } from '../src/agency/serviceConcentrations.mjs'
import { scheduledServiceWindow } from '../src/agency/serviceWindow.mjs'
import { briefingStatus, briefingPreferences, defaultBriefingPreferences } from '../src/agency/briefingSchedule.mjs'
import { createAgencyService } from '../src/server/agency-api.mjs'
import { createAgencyFixture, observationTime as now, realtimeFixture, tripUpdate } from './fixtures/agency.mjs'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'network-diagnosis-'))
const file = path.join(directory, 'schedule.sqlite')
let context, service, coverageReads
try {
  createAgencyFixture(file)
  const db = new DatabaseSync(file)
  db.exec(`INSERT INTO routes VALUES('L','L','Local',3,'009999'),('OFF','OFF','Not scheduled',3,'999999');
    INSERT INTO trips VALUES('L1','L','S','0');
    INSERT INTO connections VALUES (43500,43740,'L1','L','S','0','A','B',10),(43800,44040,'L1','L','S','0','B','C',30);`)
  db.close()
  context = new AgencyContext(file, 'City X')
  const assess = (snapshot, at = now) => diagnoseNetwork(context, deriveOperationalState(context, snapshot, at))
  const healthy = assess(realtimeFixture())
  assert.equal(healthy.network.matchingTrips, 3)
  assert.equal(healthy.network.measuredPairs, 2, 'Matching pairs must be retained, not only anomalies')
  assert.equal(healthy.routes.length, 3, 'All indexed routes have a state, including unknown and not scheduled')
  assert.deepEqual(healthy.routes.find(row => row.id === 'L').patterns, ['unreported'])
  assert.deepEqual(healthy.routes.find(row => row.id === 'OFF').patterns, ['no_scheduled_service'])
  assert.equal(healthy.coverage.reportingShare, 1380 / 1920)
  assert.equal(healthy.coverage.unknownTrips, 1)
  assert.match(networkNarrative(healthy).overview, /Unreported service.*unknown/)
  assert.equal(healthy.network.totalDelaySeconds, 0)

  // Equal timetable offsets can preserve spacing. Give the briefing both
  // denominators so it need not mistake universal lateness for frequency loss.
  const uniformLate = assess(realtimeFixture(['T1', 'T2', 'T3'].map(id => tripUpdate(id, 600))))
  const uniformFact = networkSynthesisFacts(uniformLate).find(row => row.kind === 'route' && row.routeId === 'R')
  assert.equal(uniformFact.later, uniformFact.reportingTrips)
  assert.ok(uniformFact.comparedDeparturePairs > 0)
  assert.equal(uniformFact.widerPairs, 0)
  assert.equal(uniformFact.closerPairs, 0)
  assert.equal(uniformFact.retainedLateness.longestWindowMinutes, null, 'No history must not imply zero-duration disruption')
  const noSpacing = structuredClone(uniformLate)
  Object.assign(noSpacing.routes.find(route => route.id === 'R'), { measuredPairs: 0, widerPairs: 0, closerPairs: 0, widest: null })
  const unknownSpacing = networkSynthesisFacts(noSpacing).find(row => row.kind === 'route' && row.routeId === 'R')
  assert.equal(unknownSpacing.comparedDeparturePairs, 0, 'Unknown spacing stays distinguishable from measured equal spacing')
  assert.deepEqual(uniformFact.predictionExtent.stopNames, [...new Set(uniformLate.routes.find(route => route.id === 'R').trips.map(row => row.stopName))])

  const updates = [tripUpdate('T1', 0), tripUpdate('T2', 300), tripUpdate('T3', 1200), tripUpdate('L1', 300, { routeId: 'L' })]
  const late = assess(realtimeFixture(updates))
  assert.equal(late.network.laterTrips, 3)
  assert.equal(late.network.p90DeviationSeconds, 1200, 'Quantiles must support the claimed fraction even in small samples')
  assert.equal(late.routes.find(row => row.id === 'R').maxDelaySeconds, 1200, 'A scheduled departure delayed beyond the prediction horizon still counts')
  assert.equal(late.network.leadingDelayRoute.id, 'R')
  assert.equal(late.network.leadingDelayRoute.share, 1500 / 1800, 'Delay exposure is trip-weighted, not one vote per route')
  assert.match(networkNarrative(late).overview, /widespread among reporting routes/)

  const subminute = structuredClone(late)
  for (const route of subminute.routes) route.widest = { predictedSeconds: 1741, scheduledSeconds: 1740, maxIncreaseSeconds: 1, stopName: 'Reference stop' }
  assert.ok(networkNarrative(subminute).sections.every(section => section.id !== 'spacing'), 'Rounded equal intervals must not become a longer-wait headline')

  const cancelled = assess(realtimeFixture([tripUpdate('T1', 0, { scheduleRelationship: 'CANCELED' })]))
  assert.equal(cancelled.network.cancelledTrips, 1)
  assert.equal(cancelled.coverage.reportingScheduledTrips, 1)
  assert.equal(cancelled.network.measuredTrips, 0, 'A cancellation report is coverage, never an on-time timing sample')
  const stale = assess(realtimeFixture(), now + 181)
  assert.equal(stale.status, 'prediction_coverage_unavailable')
  assert.equal(stale.coverage.reportingShare, 0)
  assert.doesNotMatch(networkNarrative(stale).overview, /normal|healthy/)
  const arrivalOnly = assess(realtimeFixture([tripUpdate('T1', 0, { stopTimeUpdates: [{ stopSequence: 10, arrival: { delay: 100 } }] })]))
  assert.equal(arrivalOnly.network.measuredTrips, 0)
  const duplicates = assess(realtimeFixture([tripUpdate('T1'), tripUpdate('T1')]))
  assert.equal(duplicates.network.measuredTrips, 0)

  const full = id => tripUpdate(id, 300, { routeId: id === 'L1' ? 'L' : 'R', stopTimeUpdates: [{ stopSequence: 10, departure: { delay: 300 } }, { stopSequence: 30, departure: { delay: 300 } }] })
  const sharedState = deriveOperationalState(context, realtimeFixture([full('T1'), full('L1')]), now)
  const original = structuredClone(sharedState.measurements)
  const shared = diagnoseNetwork(context, sharedState)
  assert.equal(shared.concentrations.length, 1)
  assert.equal(shared.concentrations[0].tripCount, 2, 'Two stops per trip must not become four affected vehicles')
  assert.equal(shared.concentrations[0].segmentCount, 2)
  assert.deepEqual(shared.concentrations[0].routeIds, ['L', 'R'])
  assert.deepEqual(sharedState.measurements, original, 'Diagnosis must not mutate the shared realtime observation')
  assert.equal(shared.network.measuredTrips, 2)
  const reversed = structuredClone(original.departures)
  for (const row of reversed.filter(row => row.routeId === 'L')) [row.stopId, row.toStopId] = [row.toStopId, row.stopId]
  assert.equal(serviceConcentrations(context, reversed).length, 0, 'Opposite directions are not the same directed corridor')
  const later = structuredClone(original.departures)
  for (const row of later.filter(row => row.routeId === 'L')) { row.predictedTime += 3600; row.scheduledTime += 3600 }
  assert.equal(serviceConcentrations(context, later).length, 0, 'Non-overlapping delay windows are separate')
  const different = structuredClone(original.departures)
  for (const row of different.filter(row => row.routeId === 'L')) { row.stopId = 'elsewhere'; row.toStopId = 'other' }
  assert.equal(serviceConcentrations(context, different).length, 0)
  assert.equal(compactDiagnosis(shared).routes.some(row => 'trips' in row), false)

  const spatialContext = { stopIndex: new Map(['A','B','C','D'].map(id => [id,{stop_id:id,name:id}])) }
  const segments = [['A','B',0,10],['B','C',9,30],['A','D',25,35]].flatMap(([stopId,toStopId,scheduledTime,predictedTime]) => ['R','S'].map(routeId => ({stopId,toStopId,scheduledTime,predictedTime,delaySeconds:predictedTime-scheduledTime,routeId,tripId:routeId,serviceDate:'2026-09-14',directionId:'0'})))
  const clusters = serviceConcentrations(spatialContext,segments)
  assert.equal(clusters.length,2,'An aggregate time envelope cannot create a false spatial/time edge')
  assert.deepEqual(serviceConcentrations(spatialContext,[...segments].reverse()),clusters,'Clustering and labels must not depend on feed order')

  const history = createObservationHistory()
  const first = deriveOperationalState(context, realtimeFixture([tripUpdate('T1', 300)]), now)
  history.update(first)
  const repeatedSnapshot = realtimeFixture([tripUpdate('T1', 300)])
  repeatedSnapshot.fetchedAt = new Date((now + 60) * 1000).toISOString()
  const repeatedState = deriveOperationalState(context, repeatedSnapshot, now + 60)
  Object.assign(repeatedState, history.update(repeatedState))
  assert.equal(diagnoseNetwork(context, repeatedState).routes.find(row => row.id === 'R').continued.length, 0, 'A re-fetched timestamp is not a new observation')
  repeatedSnapshot.tripUpdates[0].timestamp = now + 60
  repeatedSnapshot.fetchedAt = new Date((now + 61) * 1000).toISOString()
  const updated = deriveOperationalState(context, repeatedSnapshot, now + 60)
  Object.assign(updated, history.update(updated))
  assert.equal(diagnoseNetwork(context, updated).routes.find(row => row.id === 'R').continued[0].seconds, 60)

  const midnightFile = path.join(directory, 'midnight.sqlite')
  createAgencyFixture(midnightFile)
  const midnightDb = new DatabaseSync(midnightFile)
  midnightDb.exec('UPDATE connections SET departure=departure+43200,arrival=arrival+43200;')
  midnightDb.close()
  const midnight = new AgencyContext(midnightFile, 'City X')
  try {
    const start = Date.parse('2026-09-14T00:00:00Z') / 1000
    const window = scheduledServiceWindow(midnight, start, start + 1800)
    assert.equal(window.trips.length, 3)
    assert.ok(window.trips.every(row => row.serviceDate === '2026-09-13'), 'After-midnight trips belong to the preceding service date')
  } finally { midnight.close() }
  assert.equal(serviceEpoch('2026-11-01', 'America/New_York'), Date.parse('2026-11-01T05:00Z') / 1000, 'GTFS service clock uses local noon minus twelve hours through DST')

  let clock = now * 1000, modelCalls = 0
  const snapshot = realtimeFixture(updates)
  const options = { clock: () => clock, provider: { available: false, model: 'fixture', complete: async () => { modelCalls++; throw Error('Not needed for computed diagnosis') } } }
  const adapters = { context: async () => ({ storePath: file, cityName: 'City X', agencyDirectory: path.join(directory, 'agency') }), inspectRealtime: async () => snapshot }
  service = createAgencyService(adapters, options)
  await service.connect('x', { sourceUrl: 'fixture' })
  coverageReads = mock.method(AgencyContext.prototype, 'coverage')
  const [a, b] = await Promise.all([service.handle('x', { action: 'briefing' }), service.handle('x', { action: 'briefing' })])
  const sharedReads = coverageReads.mock.callCount()
  assert.equal(a.entryId, b.entryId, 'Concurrent tabs share one assessment')
  assert.equal(modelCalls, 0, 'Network diagnosis incurs no LLM latency')
  assert.equal(a.diagnosis.routes.length, 3)
  const live = await service.state('x')
  assert.equal('measurements' in live, false)
  assert.equal('trips' in live, false)
  coverageReads.mock.resetCalls()
  assert.deepEqual(await service.handle('x', { action: 'briefing' }), a, 'Returning a retained briefing preserves its entire answer and observation time.')
  assert.equal(coverageReads.mock.callCount(), 0, 'A retained briefing must not rebuild current network state before returning.')
  const forced = await service.handle('x', { action: 'briefing', force: true })
  assert.notEqual(forced.entryId, a.entryId)
  assert.ok(coverageReads.mock.callCount() > 0, 'Force refresh obtains current evidence.')
  assert.equal(coverageReads.mock.callCount(), sharedReads, 'Concurrent readers require no more assessment work than one forced refresh.')
  coverageReads.mock.resetCalls()
  clock += 15 * 60000
  assert.equal((await service.handle('x', { action: 'briefing-latest' })).current, false)
  assert.notEqual((await service.handle('x', { action: 'briefing' })).entryId, forced.entryId)
  assert.ok(coverageReads.mock.callCount() > 0, 'Expiry obtains current evidence rather than extending the retained answer.')
  await service.handle('x', { action: 'briefing-settings', preferences: { intervalMinutes: 60, automatic: false } })
  service.close(); service = createAgencyService(adapters, options)
  assert.deepEqual((await service.handle('x', { action: 'briefing-latest' })).preferences, { intervalMinutes: 60, automatic: false })
  assert.throws(() => briefingPreferences({ intervalMinutes: 1, automatic: true }), /15, 30, or 60/)
  assert.equal(briefingStatus({ answer: { generatedAt: new Date(clock).toISOString() } }, defaultBriefingPreferences, clock, 'same').current, false, 'Legacy anomaly text must not be presented as a current assessment')
  assert.equal(briefingStatus({ answer: a }, defaultBriefingPreferences, now * 1000, 'changed').current, false, 'A timetable replacement invalidates the briefing')
  assert.equal(briefingStatus({ answer: a }, defaultBriefingPreferences, now * 1000 - 1, a.scheduleIdentity).current, false)
  console.log('Network assessment: all routes, complete comparisons, distinct trips, weighted coverage, spatial/time/direction identity, source-clock history, overnight service, cache/expiry/persistence, and no LLM overhead passed.')
} finally { coverageReads?.mock.restore(); service?.close(); context?.close(); await fs.rm(directory, { recursive: true, force: true }) }
