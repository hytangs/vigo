import assert from 'node:assert/strict'
import { explicitClocks, assertRequestedClock, journeyTimeIssue, journeyTimeFacts } from '../src/agency/journeyTimeContract.mjs'

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
console.log('Journey time validation and wait accounting passed.')
