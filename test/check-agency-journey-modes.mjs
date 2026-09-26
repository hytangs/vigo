import assert from 'node:assert/strict'

import { journeyBreakdown, journeyDuration } from '../src/agency/journeyResults.mjs'

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

console.log('Saved journey continuity, mode evidence and duration accounting passed.')
