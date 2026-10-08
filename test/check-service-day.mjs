import assert from 'node:assert/strict'
import { resolveServiceDay, serviceDayForDate } from '../src/server/service-day.mjs'
import { serviceClock, serviceEpochSeconds } from '../src/server/gtfs/service-clock.mjs'

assert.equal(serviceDayForDate('2026-07-17'), 'weekday')
assert.equal(serviceDayForDate('2026-07-18'), 'saturday')
assert.equal(serviceDayForDate('2026-07-19'), 'sunday')
assert.equal(resolveServiceDay('2026-07-18'), 'saturday')
assert.equal(resolveServiceDay('2026-07-18', 'weekday'), 'weekday')
assert.throws(() => serviceDayForDate('2026-02-30'), /Invalid service date/)
assert.throws(() => resolveServiceDay('2026-07-18', 'holiday'), /weekday, saturday, or sunday/)

const epoch = iso => Date.parse(iso) / 1000
const autumn = serviceClock('2026-11-01', 'America/New_York')
assert.equal(autumn(epoch('2026-11-01T05:30:00Z')), 1800)
assert.equal(autumn(epoch('2026-11-01T06:30:00Z')), 5400)
const spring = serviceClock('2026-03-08', 'America/New_York')
assert.equal(spring(epoch('2026-03-08T06:30:00Z')), 9000)
assert.equal(spring(epoch('2026-03-08T07:30:00Z')), 12600)
assert.equal(serviceClock('2026-07-17', 'Asia/Kathmandu')(epoch('2026-07-17T20:15:00Z')), 26 * 3600)
assert.throws(() => serviceEpochSeconds('2026-02-30', 'UTC'), /Invalid service date/)
assert.throws(() => serviceEpochSeconds('2026-07-17', 'Not/A_Timezone'), /time zone|timezone/i)

console.log('Service-day derivation passed.')
