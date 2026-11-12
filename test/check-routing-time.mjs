import assert from 'node:assert/strict'
import { routingMinute } from '../src/server/number-utils.mjs'

const studio = value => routingMinute(value, 'time', 480)
for (const value of [0, 480, 1799, '1799']) assert.equal(studio(value), Number(value))
for (const value of [-1, 1800, 1801, 2880, 0.5, null, true, '', NaN, Infinity]) assert.throws(() => studio(value))
assert.equal(studio(undefined), 480)
console.log('Routing time boundaries preserve the Studio clock limit.')
