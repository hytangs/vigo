import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgencyContext } from '../src/agency/agencyContext.mjs'
import { deriveOperationalState } from '../src/agency/realtimeIntelligence.mjs'
import { vehicleGap } from '../src/agency/vehicleIndicators.ts'
import { createAgencyService } from '../src/server/agency-api.mjs'
import { eventSentences } from '../src/agency/communications.mjs'
import { summarizeEvidence } from '../src/agency/evidenceSummary.mjs'
import { briefingFacts } from '../src/agency/briefing.mjs'
import { compactResult } from '../src/agency/queryAgent.mjs'
import { observationReportMarkdown } from '../src/agency/observationExport.ts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import react from '@vitejs/plugin-react'
import { createSsrTestServer } from './helpers/ssr-test-server.mjs'
import { createAgencyFixture, observationTime as now, realtimeFixture, tripUpdate, sourceUrl } from './fixtures/agency.mjs'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-reordered-bunching-'))
const file = path.join(directory, 'schedule.sqlite')
createAgencyFixture(file)
const db = new DatabaseSync(file)
db.exec("INSERT INTO trips VALUES('T4','R','S','0'); INSERT INTO connections VALUES(45300,45540,'T4','R','S','0','A','B',10)")
db.close()
const context = new AgencyContext(file, 'Test city')
const snapshot = realtimeFixture([tripUpdate('T1', 600), tripUpdate('T2', 0, { stopTimeUpdates: [] }), tripUpdate('T3', -587), tripUpdate('T4', -1181)])
snapshot.counts = { vehicles: 4, tripUpdates: 4, alerts: 0, other: 0 }
snapshot.vehicles = snapshot.tripUpdates.map((update, index) => ({ id: update.vehicleId, tripId: update.tripId, routeId: 'R', startDate: update.startDate, lat: 42, lon: -71 + index / 1000,
  timestamp: now, sourceFeedTimestamp: now, sourceUrl, currentStopSequence: update.tripId === 'T2' ? 30 : 10 }))
const derive = value => deriveOperationalState(context, value, now)
const reordered = state => state.events.filter(event => event.evidence.comparisonBasis === 'reordered-predictions')
const agency = createAgencyService({ context: async () => ({ storePath: file, cityName: 'Test city' }), inspectRealtime: async () => snapshot },
  { clock: () => now * 1000, provider: { available: false }, refreshMs: 60_000 })
const server = await createSsrTestServer({ configFile: false, plugins: [react()], cacheDir: path.join(directory, 'cache') })
try {
  const { buildServiceVehicleFrame } = await server.ssrLoadModule('/src/serviceVehicles.ts')
  const { AgencyEvidence } = await server.ssrLoadModule('/src/components/AgencyEvidence.tsx')
  const frame = (events, input = snapshot) => {
    const original = Date.now
    Date.now = () => now * 1000
    try { return buildServiceVehicleFrame({ mode: 'live', preview: { routes: [], stops: [] }, realtimeSnapshot: input, operationalEvents: events, scheduledVehicles: [] }) }
    finally { Date.now = original }
  }
  const state = derive(snapshot)
  const event = reordered(state)[0]
  assert.deepEqual(event.evidence.tripIds, ['T1', 'T3'])
  assert.equal(event.evidence.observedHeadwaySeconds, 13)
  assert.equal(event.evidence.scheduledHeadwaySeconds, 600, 'Use a local interval, not the 20-minute sum across the overtaken trip')
  assert.equal(event.severity, 'critical')
  assert.ok(event.sourceRefs.some(ref => ref.includes('vehicle-T2')), 'Retain the position evidence that accounts for the overtaken trip')
  assert.equal(state.measurements.intervals.some(row => row.tripIds.join() === 'T1,T3'), false, 'Do not count this as a complete scheduled headway')
  await agency.connect('city', { urls: { tripUpdates: sourceUrl } })
  const live = await agency.state('city')
  for (const id of ['vehicle-T1', 'vehicle-T3', 'vehicle-T4']) {
    assert.equal(vehicleGap(snapshot.vehicles.find(vehicle => vehicle.id === id), snapshot, live.mapOperationalEvents, now)?.severity, 'critical', `${id} receives the indicator through the real API map payload`)
  }
  const displayed = frame(live.mapOperationalEvents)
  for (const id of ['vehicle-T1', 'vehicle-T3', 'vehicle-T4']) assert.match(displayed.vehicles.find(vehicle => vehicle.id === id).indicatorLabel, /↔/)
  assert.equal(displayed.vehicles.flatMap(vehicle => vehicle.bunchingLinks).length, 2)
  assert.match(displayed.vehicles[0].card.metrics.find(metric => metric.value.includes('spacing')).value, /13 sec spacing · local scheduled interval 10 min/)
  const evidencePanel = renderToStaticMarkup(createElement(AgencyEvidence, { event, state: live, projectId: 'city', onBack() {}, onLocate() {}, onUpdate() {} }))
  assert.match(evidencePanel, /Local scheduled interval.*own scheduled separation is 20 min/)
  assert.doesNotMatch(evidencePanel, /undefined|NaN/)
  const result = { ok: true, data: { events: [event], total: 1 }, provenance: event.sourceRefs, warnings: [] }
  const trace = [{ tool: 'anomaly_scan', result }]
  assert.match(summarizeEvidence(trace), /smallest local scheduled interval is 10 minutes.*scheduled 20 minutes apart/)
  assert.match(eventSentences(event, context)[0].text, /smallest local scheduled interval after trip reordering/)
  assert.match(briefingFacts(trace)[0].text, /smallest local scheduled interval after trip reordering/)
  const compact = JSON.parse(compactResult(result, 'anomaly_scan')).data.events[0].evidence
  assert.equal(compact.comparisonBasis, 'reordered-predictions')
  assert.equal(compact.scheduledPairSeparationMinutes, 20)
  assert.equal(compact.interveningTrips[0].basis, 'position')
  assert.match(observationReportMarkdown(live, { exportedAt: live.generatedAt }), /smallest local scheduled interval 600 s; scheduled separation of these trips 1200 s/)
  for (const patch of [{ timestamp: now - 181 }, { timestamp: now + 181 }, { startDate: '20260912' }, { startTime: 'different' }, { currentStopSequence: 10 }, { currentStopSequence: 999 }, { stopId: 'A' }, { routeId: 'other' }, { id: 'other' }]) {
    const changed = structuredClone(snapshot)
    Object.assign(changed.vehicles[1], patch)
    assert.equal(reordered(derive(changed)).length, 0, 'Unverified progress cannot excuse an intervening trip')
  }
  const duplicate = structuredClone(snapshot)
  duplicate.vehicles.push({ ...duplicate.vehicles[1], id: 'duplicate' })
  assert.equal(reordered(derive(duplicate)).length, 0)
  const stale = structuredClone(snapshot)
  stale.tripUpdates[1].timestamp = now - 181
  assert.equal(reordered(derive(stale)).length, 0)
  const noReport = structuredClone(snapshot)
  noReport.tripUpdates.splice(1, 1)
  assert.equal(reordered(derive(noReport)).length, 0)
  const duplicateUpdate = structuredClone(snapshot)
  duplicateUpdate.tripUpdates.push(structuredClone(duplicateUpdate.tripUpdates[1]))
  assert.equal(reordered(derive(duplicateUpdate)).length, 0)
  for (const patch of [{ feedTimestamp: now - 181 }, { error: 'Unavailable' }]) {
    const invalidFeed = structuredClone(snapshot)
    Object.assign(invalidFeed.feeds[0], patch)
    assert.equal(reordered(derive(invalidFeed)).length, 0)
  }
  const predictedOnly = structuredClone(snapshot)
  predictedOnly.vehicles = []
  predictedOnly.tripUpdates[1].stopTimeUpdates = [{ stopId: 'A', stopSequence: 10, departure: { delay: -40 } }]
  assert.equal(reordered(derive(predictedOnly))[0].evidence.interveningTrips[0].basis, 'prediction', 'Fresh predictions can establish reordered compression without positions')
  const reversed = structuredClone(snapshot)
  reversed.tripUpdates[0].stopTimeUpdates[0].departure.delay = 617
  assert.ok(reordered(derive(reversed)).some(event => event.evidence.predictedOrderReversed), 'The excluded leading trip is still found after its prediction crosses its new neighbor')
  const simultaneous = structuredClone(snapshot)
  simultaneous.tripUpdates[2].stopTimeUpdates[0].departure.delay = -600
  assert.equal(reordered(derive(simultaneous))[0].evidence.observedHeadwaySeconds, 0)
  const agedSupport = structuredClone(snapshot)
  agedSupport.vehicles[1].timestamp = now - 179
  assert.equal(reordered(derive(agedSupport))[0].observedAt, new Date((now - 179) * 1000).toISOString(), 'The event ages with its oldest supporting report')
  const ordinary = structuredClone(snapshot)
  ordinary.tripUpdates[0].stopTimeUpdates[0].departure.delay = 200
  assert.equal(reordered(derive(ordinary)).length, 0, 'Reordering must not turn 413-second spacing into an alert against a 600-second service')
  // Both reordered and scheduled pairs can end at T3; compacting by T3 alone
  // would discard one pair and leave its other member without a map indicator.
  snapshot.tripUpdates[1].stopTimeUpdates = [{ stopId: 'A', stopSequence: 10, departure: { delay: -40 } }]
  const shared = await agency.state('city')
  assert.ok(shared.mapOperationalEvents.some(event => event.evidence.tripIds?.join() === 'T1,T3'))
  assert.ok(shared.mapOperationalEvents.some(event => event.evidence.tripIds?.join() === 'T2,T3'))
  const sharedFrame = frame(shared.mapOperationalEvents)
  assert.equal(sharedFrame.vehicles.find(vehicle => vehicle.id === 'vehicle-T3').bunchingLinks.length, 2, 'Both links survive when two pairs share the same later scheduled bus')
  const strongerGap = { ...event, id: 'wider', type: 'service-gap', severity: 'critical', vehicleId: 'vehicle-T3', tripId: 'T3', evidence: { scheduledHeadwaySeconds: 600, observedHeadwaySeconds: 2400 } }
  assert.equal(frame([...shared.mapOperationalEvents, strongerGap]).vehicles.find(vehicle => vehicle.id === 'vehicle-T3').bunchingLinks.length, 2, 'A stronger gap warning must not hide supported bunching links')
  console.log('Reordered bunching: three-bus indicators, pair retention, conservative baseline, exact identity, freshness, and metric separation passed.')
} finally { await server.close(); agency.close(); context.close(); await fs.rm(directory, { recursive: true, force: true }) }
