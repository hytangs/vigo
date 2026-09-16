import assert from 'node:assert/strict'
import { createToolRegistry, toolDefinitions } from '../src/agency/toolRegistry.mjs'
import { createJourneyChoices } from '../src/agency/journeyChoices.mjs'
import { describeJourneys, journeyBreakdown, journeyDuration, verifyJourneyModes } from '../src/agency/journeyResults.mjs'
import { queryAgency } from '../src/agency/queryAgent.mjs'
import { journeyPlanEvidence } from '../src/agency/journeyEvidence.mjs'

const corruptEvidence = journeyPlanEvidence({ departMinutes: 0, durationMinutes: 20, legs: [
  { type: 'walk', toStopId: 'Salem', startMinutes: 0, endMinutes: 5 },
  { type: 'ride', fromStopId: 'Boston', startMinutes: 10, endMinutes: 20 },
] })
assert.equal(corruptEvidence.status, 'blocked')
assert.equal(corruptEvidence.legs, undefined, 'Invalid saved trips must not become evidence in follow-up answers')
assert.equal(corruptEvidence.durationMinutes, undefined)

const leg = (type, startMinutes, endMinutes, routeShortName) => ({ type, startMinutes, endMinutes, durationMinutes: endMinutes - startMinutes, fromName: 'Boarding stop', toName: 'Next stop', routeShortName, distanceKm: 1 })
const transit = { travelMode: 'transit', status: 'ready', durationMinutes: 121.5, departMinutes: 220, arriveMinutes: 341.5, legs: [
  leg('walk', 220, 238.9), leg('ride', 278.5, 303.2, 'R'), leg('ride', 305, 307, 'R'), leg('walk', 307, 313), leg('ride', 325, 335, 'B'), leg('walk', 335, 341.5),
] }
const drive = { travelMode: 'drive', status: 'ready', durationMinutes: 17.25, departMinutes: 220, arriveMinutes: 237.25, legs: [leg('drive', 220, 237.25)] }
assert.equal(journeyDuration(121.5), '2 hr 2 min')
assert.equal(journeyDuration(59.9), '1 hr')
assert.equal(journeyDuration(0.5), '<1 min')
assert.equal(journeyDuration(NaN), 'Unavailable')
const costs = journeyBreakdown(transit)
assert.ok(Math.abs(costs.wait - 53.4) < 0.001)
assert.ok(Math.abs(costs.walk + costs.ride + costs.wait - transit.durationMinutes) < 0.001)
assert.ok(Math.abs(costs.longestWait.minutes - 39.6) < 0.001)
assert.equal(costs.longestWait.route, 'R')
assert.equal(journeyBreakdown({ departMinutes: 210, legs: [leg('ride', 220, 230)] }).wait, 10, 'A leading wait is part of the journey')

const context = { timezone: 'UTC', stopIndex: new Map(), routeIndex: new Map(), resolve: () => ({ matches: [], method: 'none' }), overview: () => ({ cityName: 'City X' }) }
const state = { generatedAt: '2026-09-14T03:40:00Z', feeds: [], events: [], routes: [], trips: [], policy: { freshnessSeconds: 90 } }
let lookups = 0, failDrive = false, failTransit = false
const calls = []
const places = { search: async ({ query }) => { lookups++; return { matches: [{ id: query, name: query, lat: 40, lon: query === 'Origin' ? -70 : -71, sourceUrl: 'https://example.com/places' }] } } }
const callTool = createToolRegistry({ context, state, places, adapters: { route: async args => {
  calls.push(args)
  if (args.mode === 'drive' && failDrive) throw new Error('The driving street index is not ready.')
  if (args.mode === 'transit' && failTransit) return { plan: { status: 'blocked', travelMode: 'transit', legs: [], detail: 'No transit journey at this time.' } }
  return { plan: { ...(args.mode === 'transit' ? transit : drive), origin: args.origin, destination: args.destination } }
} } })
const input = { origin: 'Origin', destination: 'Destination', modes: ['transit', 'drive'], maxTransfers: 0 }
const complete = await callTool('route_plan', input)
assert.equal(lookups, 2, 'Each place is resolved once for the entire comparison')
assert.deepEqual(calls.map(call => call.mode), input.modes)
assert.deepEqual(calls[0].origin, calls[1].origin)
assert.deepEqual(calls[0].destination, calls[1].destination)
assert.equal(calls[0].departMinutes, calls[1].departMinutes)
assert.equal(calls[0].serviceDate, calls[1].serviceDate)
assert.equal(calls[0].maxTransfers, 0)
assert.equal(calls[1].maxTransfers, undefined, 'Transit constraints do not leak into the driving engine request')
assert.equal(calls[1].realtimeSnapshot, undefined, 'GTFS predictions are not driving traffic')
assert.deepEqual(complete.data.completion, { complete: true, missing: [] })
assert.deepEqual(complete.data.request.modes, input.modes)
assert.match(describeJourneys(complete.data), /Transit: 2 hr 2 min.*Drive: 17 min/)
assert.match(describeJourneys(complete.data), /40 min before R/)
assert.match(describeJourneys(complete.data), /walking, waiting, and riding/)
assert.match(complete.warnings.join(' '), /do not include live traffic/)
assert.doesNotMatch(describeJourneys(complete.data), /leaving later|leave later|saving|will reduce/i, 'Another departure time requires another computation')

failDrive = true
const partial = await callTool('route_plan', input)
assert.equal(partial.data.plan.travelMode, 'transit', 'A failed drive check retains the usable transit route')
assert.equal(partial.data.journeys[1].status, 'unavailable')
assert.equal(partial.data.completion.complete, true, 'Every requested output is accounted for, including explicit unavailability')
assert.match(describeJourneys(partial.data), /Drive: unavailable/)
assert.match(describeJourneys(partial.data), /driving street index is not ready/)
failDrive = false; failTransit = true
const driveOnly = await callTool('route_plan', input)
assert.equal(driveOnly.data.plan.travelMode, 'drive', 'No transit path must not discard a usable drive result')
assert.match(describeJourneys(driveOnly.data), /No transit journey at this time/)
failTransit = false

assert.deepEqual(verifyJourneyModes(input.modes, { plan: transit }).missing, ['drive'])
assert.deepEqual(verifyJourneyModes(input.modes, { journeys: [complete.data.journeys[0], complete.data.journeys[0]] }).missing, input.modes)
assert.equal(verifyJourneyModes(['drive'], { journeys: [{ mode: 'drive', status: 'ready', plan: transit }] }).complete, false)
assert.equal(verifyJourneyModes(['drive'], { journeys: [{ mode: 'drive', status: 'unavailable' }] }).complete, false, 'An unavailable output must explain what happened')
assert.equal(verifyJourneyModes(['drive'], { journeys: [{ mode: 'drive', status: 'ready', plan: { ...drive, durationMinutes: NaN } }] }).complete, false)
assert.match(describeJourneys({ journeys: [{ mode: 'drive', status: 'ready' }] }), /Drive: unavailable/, 'A malformed result remains readable without inventing a duration')

const choices = createJourneyChoices(toolDefinitions.find(tool => tool.name === 'route_plan'))
assert.ok(choices.definition().parameters.required.includes('explain'))
choices.arguments({ ...input, when: 'now', explain: false })
assert.equal(choices.finishWithJourney(), true, 'Ordinary directions use the direct result path')
choices.arguments({ ...input, when: 'now', explain: true })
assert.equal(choices.finishWithJourney(), false, 'Explicit analysis returns the computed evidence to the model')
assert.throws(() => choices.arguments({ ...input, when: 'now', explain: false, resultUse: 'continue' }), /one journey completion/)
assert.ok(choices.definition().parameters.required.includes('modes'), 'The model must enumerate modes rather than inherit transit')
const request = choices.arguments({ ...input, when: 'now', resultUse: 'answer' })
choices.observe(request, { ok: true, data: { status: 'needs_location_choice', clarification: { endpoints: [{ endpoint: 1, matches: [{ id: 'destination', name: 'Destination', lat: 40, lon: -71 }] }], resolved: [{ endpoint: 0, label: 'Origin', lat: 40, lon: -70 }] } } })
assert.deepEqual(choices.arguments({ destination: '1' }).modes, input.modes, 'A coordinate choice cannot narrow the retained mode set')
assert.throws(() => choices.arguments({ destination: '1', modes: ['transit'] }), /Unknown/)

let modelCalls = 0
const answer = await queryAgency({ question: 'How long from Origin to Destination by transit and by drive?', context, state, callTool,
  provider: { available: true, complete: async () => {
    modelCalls++
    return { tool_calls: [{ id: 'compare', function: { name: 'route_plan', arguments: JSON.stringify({ ...input, when: 'now', resultUse: 'answer' }) } }] }
  } },
})
assert.equal(modelCalls, 1, 'Both modes are computed in one tool workflow, without an extra prose-generation pass')
assert.match(answer.answer, /Transit: 2 hr 2 min.*Drive: 17 min/)
assert.equal(answer.aiGenerated, false)
assert.deepEqual(answer.citations, [1])
let incompleteCalls = 0
const incomplete = await queryAgency({ question: 'Transit and driving?', context, state, callTool: async () => ({ ...complete, data: { plan: transit } }),
  provider: { available: true, complete: async () => ++incompleteCalls === 1
    ? { tool_calls: [{ id: 'compare', function: { name: 'route_plan', arguments: JSON.stringify({ ...input, when: 'now', resultUse: 'answer' }) } }] }
    : { content: 'Both modes are complete. Driving takes 2 minutes.' } },
})
assert.equal(incompleteCalls, 2, 'An incomplete result cannot trigger automatic completion')
assert.match(incomplete.answer, /missing a verified result for: drive/)
assert.doesNotMatch(incomplete.answer, /Driving takes 2|Both modes are complete/)
console.log('Journey comparison: requested modes, shared places/time, partial failures, completion checks and wait interpretation passed.')
