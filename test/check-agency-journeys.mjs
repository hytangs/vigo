import assert from 'node:assert/strict'
import { agencyClock } from '../src/agency/agencyClock.mjs'

const utcAfterMidnight = '2026-09-14T03:19:00Z'
assert.deepEqual(agencyClock(utcAfterMidnight, 'America/Los_Angeles'), { date: '2026-09-13', time: '20:19', weekday: 'Sunday', timezone: 'America/Los_Angeles', zoneLabel: 'PDT' })
assert.equal(agencyClock(utcAfterMidnight, 'Asia/Tokyo').date, '2026-09-14')
assert.equal(agencyClock('2026-03-08T09:59:00Z', 'America/Los_Angeles').time, '01:59')
assert.equal(agencyClock('2026-03-08T10:00:00Z', 'America/Los_Angeles').time, '03:00', 'Use the actual daylight-saving offset, not a fixed subtraction')
assert.equal(agencyClock(utcAfterMidnight, null), null, 'An unknown agency timezone must not use the computer timezone')
import { createToolRegistry, failedToolResult } from '../src/agency/toolRegistry.mjs'
import { queryAgency } from '../src/agency/queryAgent.mjs'
import { journeyTime } from '../src/agency/journeyInputs.mjs'
import { calculateWalk, walkingAssessment } from '../src/agency/walking.mjs'

const stops = ['Library', 'Depot', 'Town Hall'].map((name, i) => ({ stop_id: `S${i}`, name, lon: i + 10, lat: i + 20 }))
const routes = [{ id: 'R1', name: '1', short_name: '1' }, { id: 'R2', name: '2', short_name: '2' }]
const context = { stopIndex: new Map(stops.map(s => [s.stop_id, s])), routeIndex: new Map(routes.map(r => [r.id, r])), overview: () => ({ cityName: 'City X' }),
  resolve({ query, kind }) { const items = kind === 'route' ? routes : stops; const matches = items.filter(s => s.name === query || query === 'Ambiguous').map(s => ({ id: s.stop_id || s.id, name: s.name })); return { method: 'exact', matches, total: matches.length, ambiguous: matches.length > 1 } },
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
assert.deepEqual(result.data.request, { serviceDate: '2026-09-13', departTime: undefined, arriveBy: '16:00', timezone: undefined, maxTransfers: 0, via: [] })
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
  assert.match(messages[1].content, /previousRequests.*Library.*16:00.*maxTransfers/s)
  return { content: 'I can retain your endpoints and no-transfer requirement when checking the new deadline.' }
} } })
assert.match(followup.answer, /retain your endpoints and no-transfer requirement/)

const station = { stop_id: 'station', name: 'Central', location_type: 1, lon: 10, lat: 20 }
const entrances = ['disconnected', 'north', 'south'].map((name, i) => ({ stop_id: name, name, parent_station: 'station', location_type: 2, lon: 10 + i, lat: 20 }))
const walkingContext = { ...context, stopIndex: new Map([station, ...entrances].map(stop => [stop.stop_id, stop])) }
let matrixCalls = 0, walkingRequest
const walkingAdapters = {
  streetMatrix: async ({ origins, destinations }) => {
    matrixCalls++
    return { rows: origins.flatMap((from, originIndex) => destinations.map((to, destinationIndex) => {
      // Nearest entrance is disconnected. The two intermediate-station legs
      // favour different entrances: minima must not teleport through it.
      const blocked = from.stopId === 'disconnected' || to.stopId === 'disconnected'
      const km = to.stopId === 'north' ? 0.2 : to.stopId === 'south' ? 0.5 : from.stopId === 'north' ? 1 : 0.3
      return { originIndex, destinationIndex, status: blocked ? 'blocked' : 'ready', distanceKm: blocked ? null : km }
    })) }
  },
  route: async input => {
    walkingRequest = input
    return { plan: { status: 'ready', travelMode: 'walk', durationMinutes: 10, legs: [{ type: 'walk', distanceKm: 0.8 }] } }
  },
}
const stroll = { origin: { lat: 20, lon: 9 }, destination: { lat: 20, lon: 14 }, waypoints: [{ stopId: 'station' }], minimumDistanceMiles: 1, timeBudgetMinutes: 40 }
const measured = await calculateWalk(walkingContext, null, walkingAdapters, stroll)
assert.equal(walkingRequest.waypoints[0].stopId, 'south', 'Choose the shortest complete walk through one recorded entrance, not separate leg minima')
assert.equal(matrixCalls, 2)
assert.equal(measured.data.entrances[0].station, 'Central')
assert.equal(measured.data.assessment.meetsMinimumDistance, false)
assert.equal(measured.data.assessment.minutesAfterWalking, 30)
assert.equal(measured.data.assessment.fitsIncludingActivities, null, 'Forty minutes cannot be declared sufficient when ordering/eating duration is unknown')
assert.match(measured.warnings.join(' '), /inside the station/)
assert.equal(walkingAssessment({ distanceMeters: 1609.344, durationMinutes: 20 }, { minimumDistanceMiles: 1, timeBudgetMinutes: 40, activityMinutes: 20 }).meetsMinimumDistance, true)
assert.equal(walkingAssessment({ distanceMeters: 1609.343, durationMinutes: 20 }, { minimumDistanceMiles: 1 }).meetsMinimumDistance, false, 'Do not round a sub-mile path into a pass')
assert.equal(walkingAssessment(null, { minimumDistanceMiles: 1 }).meetsMinimumDistance, null)
await calculateWalk(walkingContext, null, walkingAdapters, { origin: stroll.origin, destination: stroll.destination })
assert.equal(matrixCalls, 2, 'Arbitrary map coordinates never get moved to convenient station entrances')
const disconnected = { ...walkingAdapters, streetMatrix: async () => ({ rows: [] }) }
await assert.rejects(calculateWalk(walkingContext, null, disconnected, stroll), /No connected walk/)

const comparisonsTool = createToolRegistry({ context: walkingContext, state, adapters: walkingAdapters })
const comparisons = await comparisonsTool('walk_compare', { origin: stroll.origin, destinations: [{ stopId: 'station' }, stroll.destination], minimumDistanceMiles: 1, pairwise: true })
assert.equal(comparisons.data.comparisons.length, 4, 'Compare origin-to-candidates and both directed pairs')
assert.ok(comparisons.data.comparisons.every(row => row.assessment.meetsMinimumDistance === false))
const mixed = await comparisonsTool('walk_compare', { origin: stroll.origin, destinations: [stroll.destination, { stopId: 'missing' }] })
assert.ok(mixed.data.comparisons[0].walking)
assert.equal(mixed.data.comparisons[1].walking, null, 'Retain a failed candidate beside successful calculations')
assert.match(mixed.data.comparisons[1].error, /Unknown stop/)
const visitPlaces = [
  { id: 'osm:node/1', name: 'Takeout', address: '1 Market Street', lon: 11, lat: 20, sourceUrl: 'https://www.openstreetmap.org/node/1', category: { key: 'amenity', value: 'fast_food' } },
  { id: 'osm:node/2', name: 'Private Garden', address: '2 Market Street', lon: 12, lat: 20, sourceUrl: 'https://www.openstreetmap.org/node/2', category: { key: 'leisure', value: 'park' } },
  { id: 'osm:node/3', name: 'Town Common', address: '3 Market Street', lon: 13, lat: 20, sourceUrl: 'https://www.openstreetmap.org/node/3', category: { key: 'leisure', value: 'park' } },
]
const visitTool = createToolRegistry({ context, state, places: {
  search: async ({ osmTag }) => ({ matches: osmTag === 'leisure:park' ? visitPlaces.slice(1) : visitPlaces.slice(0, 1) }),
  resolve: id => visitPlaces.find(place => place.id === id),
  details: async id => ({ url: 'https://www.openstreetmap.org/', tags: id.endsWith('/1') ? { takeaway: 'yes' } : id.endsWith('/2') ? { access: 'private' } : {} }),
}, adapters: { route: async input => ({ plan: { ...input, status: 'ready', travelMode: 'walk', durationMinutes: input.destination.coordinate[0], legs: [{ type: 'walk', distanceKm: 1 }] } }) } })
const visitArgs = { origin: 'Library', visits: [{ query: 'takeout', osmTag: 'amenity:fast_food' }, { osmTag: 'leisure:park' }], timeBudgetMinutes: 40 }
const outing = await visitTool('find_walk', visitArgs)
await assert.rejects(visitTool('find_walk', { ...visitArgs, visits: [{ query: 'public park' }] }), /osmTag/)
assert.equal(outing.data.visits.at(-1).name, 'Town Common', 'A shorter explicitly private park must not win')
assert.equal(outing.data.comparison.checked, 2)
assert.equal(outing.data.comparison.restricted, 1)
assert.equal(outing.data.assessment.fitsIncludingActivities, null)
const outingAnswer = await queryAgency({ question: 'Takeout and a park in 40 minutes', context, state, callTool: visitTool, provider: { available: true, complete: async () => ({ tool_calls: [{ id: 'outing', function: { name: 'find_walk', arguments: JSON.stringify(visitArgs) } }] }) } })
assert.equal(outingAnswer.timing.modelCalls, 1, 'The complete measured outing needs no second model pass to repeat numbers')
assert.equal(outingAnswer.aiGenerated, false, 'Distinguish server-rendered evidence from model prose')
assert.match(outingAnswer.answer, /Town Common.*\n.*\n.*27 minutes/s)
assert.doesNotMatch(outingAnswer.answer, /Private Garden|inside stations/)
assert.match(outingAnswer.answer, /public access.*not confirmed/)
console.log('Agency journeys: named endpoints, ambiguity, ordered stops, deadlines, transfer limits, multi-route scope, concurrent reads, timing and follow-up request context passed.')

// The server supplies a real local clock; the model does not invent one.
assert.deepEqual(journeyTime({}, '2026-09-14T01:00:00Z', 'America/Los_Angeles'), { serviceDate: '2026-09-13', departTime: '18:00' })
assert.deepEqual(journeyTime({}, '2026-09-14T01:00:00Z', 'Asia/Tokyo'), { serviceDate: '2026-09-14', departTime: '10:00' })
assert.deepEqual(journeyTime({ arriveBy: '24:30' }, state.generatedAt, 'UTC'), { serviceDate: '2026-09-13', arriveBy: '24:30' })
assert.deepEqual(journeyTime({ serviceDate: '2026-10-01', departTime: '25:10' }), { serviceDate: '2026-10-01', departTime: '25:10' })
assert.throws(() => journeyTime({}, state.generatedAt, null), /timezone/)
assert.throws(() => journeyTime({ serviceDate: '2026-10-01' }, state.generatedAt, 'UTC'), /selected date/)
assert.throws(() => journeyTime({ arriveBy: '18:00', departTime: '17:00' }, state.generatedAt, 'UTC'), /either/)
const nowTool = createToolRegistry({ context: { ...context, timezone: 'America/Los_Angeles' }, state: { ...state, generatedAt: '2026-09-14T01:00:00Z' }, adapters: { route: async args => { assert.equal(args.serviceDate, '2026-09-13'); assert.equal(args.departMinutes, 1080); return { plan: { legs: [] } } } } })
const now = await nowTool('route_plan', { origin: input.origin, destination: input.destination })
assert.equal(now.data.request.timezone, 'America/Los_Angeles')
assert.match(now.data.request.timeAssumption, /Current City date/)
const plainNames = await callTool('route_plan', { ...input, origin: 'Library', destination: 'Town Hall' })
assert.equal(plainNames.data.resolved[0].stopId, 'S0', 'Plain names resolve against exact GTFS identity before public place search')
await assert.rejects(callTool('route_plan', { ...input, origin: '' }), /empty/)
await assert.rejects(callTool('route_plan', { ...input, origin: 12 }), /place name/)
await assert.rejects(callTool('route_plan', { ...input, origin: null }), /object/)
await assert.rejects(callTool('route_plan', { ...input, origin: 'Ambiguous' }), /Which stop/)
const candidates = query => [{ id: `osm:node/${query === 'Museum' ? 1 : 2}`, name: query, lat: 20, lon: 10 }]
const { resolveJourneyPoints } = await import('../src/agency/journeyInputs.mjs')
await assert.rejects(resolveJourneyPoints(context, { search: async ({query}) => ({ matches: [...candidates(query), { ...candidates(query)[0], id: 'osm:node/3' }] }) }, { origin: 'Museum', destination: 'Park' }), error => {
  assert.equal(error.details.endpoints.length, 2, 'Both unresolved endpoints are returned in the same round')
  assert.deepEqual(error.details.endpoints.map(item => item.query), ['Museum', 'Park'])
  assert.match(error.details.nextStep, /calculate the requested journey now/)
  return true
})
await assert.rejects(resolveJourneyPoints(context, { search: async () => ({ matches: [] }) }, { origin: 'Library', destination: 'Unknown place' }), error => {
  assert.equal(error.details.resolved[0].stopId, 'S0', 'A failed second endpoint does not discard the first resolved identity')
  return true
})
const cachedPlace = { id: 'osm:node/42', name: 'Passenger terminal', label: 'Passenger terminal · Airport Road', lat: 20, lon: 10, sourceUrl: 'https://example.test/map/42', category: { key: 'highway', value: 'bus_stop' } }
const localPlaces = { named: query => query === cachedPlace.label ? [cachedPlace] : [], resolve: id => { assert.equal(id, cachedPlace.id); return cachedPlace }, search: () => assert.fail('Known exact names and IDs must not repeat the network lookup') }
for (const origin of [cachedPlace.label, cachedPlace.id, { placeQuery: cachedPlace.label }]) {
  const path = await resolveJourneyPoints(context, localPlaces, { origin, destination: 'Library' })
  assert.equal(path.resolved[0].placeId, cachedPlace.id)
}
await assert.rejects(resolveJourneyPoints(context, { ...localPlaces,
  resolve: () => ({ ...cachedPlace, category: { key: 'aeroway', value: 'aerodrome' } }),
  search: async ({ query }) => { assert.equal(query, cachedPlace.name); return { matches: [cachedPlace] } },
}, { origin: cachedPlace.id, destination: 'Library' }), error => {
  assert.match(error.message, /passenger arrival point/)
  assert.equal(error.details.endpoints[0].matches[0].lat, cachedPlace.lat, 'The follow-up has passenger location coordinates without another model search round')
  assert.equal(error.details.resolved[0].lat, 20, 'A resolved endpoint keeps its coordinates across clarification')
  return true
})
const airfields = [41, 42].map(id => ({ ...cachedPlace, id: `osm:way/${id}`, category: { key: 'aeroway', value: 'aerodrome' } }))
await assert.rejects(resolveJourneyPoints(context, {
  search: async () => ({ matches: airfields }),
  details: async id => id === airfields[0].id ? { tags: { iata: 'XYZ', icao: 'KXYZ', name: 'Source name' } } : Promise.reject(new Error('Source unavailable')),
}, { origin: 'Library', destination: 'XYZ airport' }), error => {
  assert.equal(error.details.status, 'needs_location_choice', 'Multiple retrieved locations are a choice, not a failed lookup')
  assert.deepEqual(error.details.endpoints[0].matches[0].identifiers, { iata: 'XYZ', icao: 'KXYZ' })
  assert.equal(error.details.endpoints[0].matches[1].identifiers, undefined, 'A failed detail request must not invent an airport code')
  assert.equal(error.details.resolved[0].stopId, 'S0')
  return true
})
