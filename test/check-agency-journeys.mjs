import assert from 'node:assert/strict'
import { createToolRegistry, failedToolResult } from '../src/agency/toolRegistry.mjs'
import { queryAgency } from '../src/agency/queryAgent.mjs'

const stops = ['Library', 'Depot', 'Town Hall'].map((name, i) => ({ stop_id: `S${i}`, name, lon: i + 10, lat: i + 20 }))
const routes = [{ id: 'R1', name: '1', short_name: '1' }, { id: 'R2', name: '2', short_name: '2' }]
const context = { stopIndex: new Map(stops.map(s => [s.stop_id, s])), routeIndex: new Map(routes.map(r => [r.id, r])), overview: () => ({ cityName: 'City X' }),
  resolve({ query, kind }) { const items = kind === 'route' ? routes : stops; const matches = items.filter(s => s.name === query || query === 'Ambiguous').map(s => ({ id: s.stop_id || s.id, name: s.name })); return { matches, total: matches.length, ambiguous: matches.length > 1 } },
}
const state = { generatedAt: '2026-09-13T12:00:00Z', feeds: [], routes, trips: [], events: routes.map(r => ({ id: r.id, routeId: r.id, title: 'Delay', evidence: { delaySeconds: 60 }, sourceRefs: [] })), warnings: [] }
let request, routeCalls = 0
const callTool = createToolRegistry({ context, state, adapters: { route: async args => {
  request = args; routeCalls++
  return { plan: { status: 'ready', origin: args.origin, destination: args.destination, durationMinutes: 12, legs: [{ type: 'ride', fromName: args.origin.label, toName: args.destination.label }], diagnostics: {} } }
} } })
const input = { origin: { stopName: 'Library' }, destination: { stopName: 'Town Hall' }, serviceDate: '2026-09-13', arriveBy: '16:00', maxTransfers: 0 }
const result = await callTool('route_plan', input)
assert.equal(request.timePreference, 'arrive')
assert.equal(request.arriveMinutes, 960)
assert.equal(request.maxTransfers, 0, 'No-transfer requests must not be lost as falsy values')
assert.equal(request.origin.stopId, 'S0')
assert.equal(request.destination.stopId, 'S2')
assert.deepEqual(result.data.request, { serviceDate: '2026-09-13', departTime: undefined, arriveBy: '16:00', maxTransfers: 0, via: [] })
const ordered = { origin: input.origin, destination: input.destination, serviceDate: input.serviceDate, departTime: '09:15', waypoints: [{ stopName: 'Depot' }] }
await callTool('route_plan', ordered)
assert.equal(request.departMinutes, 555)
assert.deepEqual(request.waypoints.map(p => p.stopId), ['S1'])
const named = await callTool('route_plan', { ...input, origin: { lat: 20, lon: 10, label: 'Library entrance' }, destination: { lat: 22, lon: 12, label: 'Restaurant' } })
assert.equal(request.origin.label, 'Library entrance')
assert.equal(named.data.resolved[1].label, 'Restaurant', 'Checked coordinate endpoints retain their names in the journey card')
const before = routeCalls
await assert.rejects(callTool('route_plan', { ...input, waypoints: ordered.waypoints }), /cannot combine/)
await assert.rejects(callTool('route_plan', { ...input, departTime: '15:00' }), /either a departure/)
await assert.rejects(callTool('route_plan', { ...input, wheelchair: true }), /Unknown/)
assert.equal(routeCalls, before, 'Unsupported requirements never get silently removed before execution')
let ambiguity
try { await callTool('route_plan', { ...input, origin: { stopName: 'Ambiguous' } }) } catch (error) { ambiguity = failedToolResult(error, state.generatedAt) }
assert.equal(ambiguity.ok, false)
assert.equal(ambiguity.data.clarification.matches.length, 3, 'The model receives candidates instead of a guessed endpoint')
assert.equal(routeCalls, before)
let clockRound = 0
const clockAnswer = await queryAgency({ question: 'Arrive by 16:00', context, state,
  callTool: async () => ({ ...result, data: { ...result.data, plan: { status: 'ready', departMinutes: 938, arriveMinutes: 957, legs: [{ type: 'ride', startMinutes: 938, endMinutes: 957 }] } } }),
  provider: { available: true, complete: async messages => {
    if (++clockRound === 1) return { tool_calls: [{ id: 'journey', function: { name: 'route_plan', arguments: JSON.stringify(input) } }] }
    const plan = JSON.parse(messages.filter(message => message.role !== 'system').at(-1).content.split('\n').slice(1).join('\n')).data.plan
    assert.equal(plan.departTime, '15:38')
    assert.equal(plan.arriveTime, '15:57')
    assert.equal(plan.legs[0].startTime, '15:38')
    assert.equal(plan.departMinutes, undefined, 'The model receives formatted clocks rather than a clock conversion problem')
    return { content: 'Leave at 15:38 and arrive at 15:57. [1]' }
  } },
})
assert.match(clockAnswer.answer, /Leave at 15:38 and arrive at 15:57/)
const comparison = await callTool('realtime_status', { routeNames: ['1', '2'] })
assert.deepEqual(comparison.data.scope.routeIds, ['R1', 'R2'])
assert.equal(comparison.data.routes.length, 2)
assert.equal((await callTool('anomaly_scan', { routeNames: ['2'] })).data.events.length, 1)
await assert.rejects(callTool('realtime_status', { routeNames: ['missing'] }), /Resolve the route/)

let started = 0, release
const barrier = new Promise(resolve => { release = resolve })
const timeout = setTimeout(() => release(), 1000)
let round = 0
const answer = await queryAgency({ question: 'Compare two routes', context, state, callTool: async () => {
  if (++started === 2) release()
  await barrier
  assert.equal(started, 2, 'Independent read tools overlap rather than serially waiting for each other')
  return { ok: true, data: { rows: [{ value: 1 }] }, warnings: [], provenance: [] }
}, provider: { available: true, complete: async () => ++round === 1 ? { tool_calls: ['a','b'].map(id => ({ id, function: { name: 'gtfs_query', arguments: '{}' } })) } : { content: 'Both comparisons are ready. [1] [2]', usage: { prompt_tokens: 40, completion_tokens: 10 } } } })
clearTimeout(timeout)
assert.equal(answer.timing.modelCalls, 2)
assert.equal(answer.timing.inputTokens, 40)
assert.deepEqual(answer.citations, [1, 2], 'Concurrent completion does not reorder source references')
assert.deepEqual(answer.trace.map(t => t.tool), ['gtfs_query', 'gtfs_query'])
const followup = await queryAgency({ question: 'Same route, arrive by 17:00 instead', context, state, callTool, history: [{ question: 'Earlier trip', answer: 'Earlier result', requests: [{ tool: 'route_plan', arguments: input }] }], provider: { available: true, complete: async messages => {
  assert.match(messages[0].content, /previousRequests.*Library.*16:00.*maxTransfers/s)
  return { content: 'I can retain your endpoints and no-transfer requirement when checking the new deadline.' }
} } })
assert.match(followup.answer, /retain your endpoints and no-transfer requirement/)
console.log('Agency journeys: named endpoints, ambiguity, ordered stops, deadlines, transfer limits, multi-route scope, concurrent reads, timing and follow-up request context passed.')
