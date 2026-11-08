import assert from 'node:assert/strict'
import { routingMinute, studioRoutingMinuteLimit, gtfsRoutingMinuteMaximum } from '../src/server/number-utils.mjs'

const studio = value => routingMinute(value, 'time', 480, studioRoutingMinuteLimit, true)
for (const value of [0, 480, 1799, '1799']) assert.equal(studio(value), Number(value))
for (const value of [-1, 1800, 1801, 2880, 0.5, null, true, '', NaN, Infinity]) assert.throws(() => studio(value))
assert.equal(studio(undefined), 480)
assert.equal(routingMinute(gtfsRoutingMinuteMaximum, 'time'), 2880)
assert.throws(() => routingMinute(gtfsRoutingMinuteMaximum + 1, 'time'))
assert.equal(routingMinute(4319, 'time', 480, 4319), 4319)
assert.throws(() => routingMinute(4320, 'time', 480, 4319))
console.log('Routing time boundaries preserve explicit Studio, GTFS and public clock limits.')
