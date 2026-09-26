import assert from 'node:assert/strict'
import { briefingFacts } from '../src/agency/briefing.mjs'
const stamp = '2026-09-13T12:00:00Z'
const record = (tool, data) => ({ tool, result: { ok: true, data, generatedAt: stamp, provenance: ['fixture'], warnings: [] } })
const overview = record('network_overview', { observation: { connected: true, counts: { vehicles: 270, alerts: 79, matchedTrips: 996, unresolvedTrips: 41 }, feeds: [{ kind: 'tripUpdates', status: 'fresh' }] } })
const gaps = record('anomaly_scan', { events: [{ routeName: 'River', stopName: 'Library', evidence: { observedHeadwaySeconds: 1500, scheduledHeadwaySeconds: 600 } }] })
const delays = record('anomaly_scan', { events: [{ routeName: 'Hill', stopName: 'Square', evidence: { delaySeconds: 720 } }] })
const trace = [overview, gaps, delays]
const facts = briefingFacts(trace)
assert.equal(facts.length, 2, 'Routine feed counts and healthy timestamps do not crowd out service findings')
assert.match(facts[0].text, /25 minute gap.*15 minutes longer.*10 minutes/)
assert.match(facts[1].text, /12 minutes late/)
console.log('Briefing facts preserve measured values and evidence references.')
