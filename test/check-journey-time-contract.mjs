import assert from 'node:assert/strict'
import { explicitClocks, assertRequestedClock, journeyTimeIssue, journeyTimeFacts } from '../src/agency/journeyTimeContract.mjs'
import { queryAgency } from '../src/agency/queryAgent.mjs'
assert.deepEqual(explicitClocks('10am from Victoria Seafood to Golden Gate at 10am?'), ['10:00'])
assert.deepEqual(explicitClocks('Route 10, 12am, 12:30 PM, 25:00'), ['00:00', '12:30', '25:00'])
for (const args of [{}, { departTime: '02:11' }, { departTime: '22:00' }]) assert.throws(() => assertRequestedClock('at 10am', args), /explicitly supplied/)
assertRequestedClock('at 10am', { arriveBy: '10:00' })
assertRequestedClock('leave now', {})
const bad = { departMinutes: 131, arriveMinutes: 305.5, legs: [{ type: 'walk', startMinutes: 131, endMinutes: 135 }, { type: 'ride', startMinutes: 285, endMinutes: 300 }] }
assert.match(journeyTimeIssue(bad, { departTime: '10:00' }), /before/)
assert.equal(journeyTimeFacts(bad, { departTime: '02:11' }).initialWaitMinutes, 150)
assert.match(journeyTimeFacts(bad, {}).warning, /150 minutes/)
const good = { departMinutes: 600, arriveMinutes: 633.033, legs: [{ type: 'walk', startMinutes: 600, endMinutes: 602.833 }, { type: 'ride', startMinutes: 604, endMinutes: 627 }] }
assert.equal(journeyTimeIssue(good, { departTime: '10:00' }), null)
assert.match(journeyTimeIssue(good, { arriveBy: '10:00' }), /misses/)
assert.match(journeyTimeIssue(good, { departTime: '10:00', arriveBy: '11:00' }), /both/)
assert.equal(journeyTimeFacts(good, {}).warning, undefined)
let round = 0, executed = []
const args = { origin: 'Victoria Seafood', destination: 'New Golden Gate Seafood', modes: ['transit'] }
const reply = await queryAgency({ question: '10am from Victoria Seafood to New Golden Gate Seafood', context: { overview: () => ({ cityName: 'Boston' }) }, state: { generatedAt: '2026-09-16T06:11:00Z', routes: [], events: [] },
 callTool: async (name, input) => { executed.push(input); return { ok: true, data: {}, warnings: [], provenance: [] } },
 provider: { available: true, complete: async () => ++round <= 2 ? { tool_calls: [{ id: String(round), function: { name: 'route_plan', arguments: JSON.stringify({ ...args, ...(round === 2 ? { departTime: '10:00' } : {}) }) } }] } : { content: 'Checked the requested departure.' } },
})
assert.equal(executed.length, 1, 'Missing explicit time must never reach the router')
assert.equal(executed[0].departTime, '10:00')
assert.ok(reply.trace.some(item => item.result.ok === false))
console.log('Journey time contract checks passed')
const { createToolRegistry } = await import('../src/agency/toolRegistry.mjs')
const route = createToolRegistry({ context: { timezone: 'America/New_York', stopIndex: new Map(), routeIndex: new Map() }, state: { generatedAt: '2026-09-16T06:11:00Z', routes: [], feeds: [], events: [] }, adapters: { route: async () => ({ plan: { ...bad, status: 'ready', travelMode: 'transit', durationMinutes: 174.5 } }) } })
const rejected = await route('route_plan', { origin: { lat: 42.35, lon: -71.12 }, destination: { lat: 42.35, lon: -71.06 }, serviceDate: '2026-09-16', departTime: '10:00', modes: ['transit'], routingDataMode: 'scheduled' })
assert.equal(rejected.data.journeys[0].status, 'unavailable')
assert.match(rejected.data.journeys[0].reason, /before the requested departure/)
assert.equal(rejected.data.plan, undefined)
