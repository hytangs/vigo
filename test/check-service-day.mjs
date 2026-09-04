import assert from 'node:assert/strict'
import { resolveServiceDay, serviceDayForDate } from '../src/server/service-day.mjs'

assert.equal(serviceDayForDate('2026-07-17'), 'weekday')
assert.equal(serviceDayForDate('2026-07-18'), 'saturday')
assert.equal(serviceDayForDate('2026-07-19'), 'sunday')
assert.equal(resolveServiceDay('2026-07-18'), 'saturday')
assert.equal(resolveServiceDay('2026-07-18', 'weekday'), 'weekday')
assert.throws(() => serviceDayForDate('2026-02-30'), /Invalid service date/)
assert.throws(() => resolveServiceDay('2026-07-18', 'holiday'), /weekday, saturday, or sunday/)

console.log('Service-day derivation passed.')
