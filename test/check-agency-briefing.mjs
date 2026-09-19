import assert from 'node:assert/strict'
import { briefingFacts, synthesizeEvidence } from '../src/agency/briefing.mjs'
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
const provider = { available: true, model: 'fixture', complete: async () => ({ tool_calls: [{ function: { name: 'write_briefing', arguments: '{"factIds":[1,2],"text":"Invented: all routes cancelled"}' } }] }) }
const summary = await synthesizeEvidence({ trace, provider })
assert.deepEqual(summary.citations, [2, 3])
assert.doesNotMatch(summary.text, /270|996|Invented|all routes cancelled/)
assert.match(summary.scopeNote, /not every departure/)
assert.match((await synthesizeEvidence({ trace, provider: { available: false } })).text, /25 minute gap/)
assert.match((await synthesizeEvidence({ trace: [overview], provider })).text, /does not establish/)
const stale = structuredClone(overview)
stale.result.data.observation.feeds[0].status = 'stale'
assert.match(briefingFacts([stale])[0].text, /out of date/)
await assert.rejects(synthesizeEvidence({ trace, provider: { ...provider, complete: async () => ({ tool_calls: [null] }) } }), /did not return a briefing/)
console.log('Agency briefing: service-first wording, exact schedule differences, source citations, coverage limits, fallback, and malformed model responses passed.')
