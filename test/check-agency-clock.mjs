import assert from 'node:assert/strict'
import { currentTime } from '../src/agency/currentTime.mjs'

// Chicago switches at 08:00 UTC in March and 07:00 UTC in November.
for (const [instant, time, zone] of [
  ['2026-03-08T07:59:00Z', '1:59 AM', 'CST'],
  ['2026-03-08T08:00:00Z', '3:00 AM', 'CDT'],
  ['2026-11-01T06:59:00Z', '1:59 AM', 'CDT'],
  ['2026-11-01T07:00:00Z', '1:00 AM', 'CST'],
]) {
  const clock = currentTime(['America/Chicago'], 'America/New_York', instant).clocks[0]
  assert.equal(clock.time, time)
  assert.equal(clock.zoneLabel, zone)
}
const international = currentTime(['Asia/Kathmandu', 'Pacific/Auckland', 'America/Los_Angeles'], undefined, '2026-09-14T00:30:00Z')
assert.equal(international.clocks[0].time, '6:15 AM', 'Fractional offsets are computed, not rounded to hours')
assert.match(international.clocks[1].date, /Monday, September 14/)
assert.match(international.clocks[2].date, /Sunday, September 13/, 'The same instant can fall on the preceding local date')
assert.equal(currentTime(undefined, 'UTC', '2026-09-14T00:30:00Z').clocks[0].time, '12:30 AM')
assert.equal(currentTime(['Europe/Paris', 'Europe/Paris']).clocks.length, 1)
for (const zone of ['CST', '-06:00', 'America/Invented', '']) assert.throws(() => currentTime([zone], 'America/New_York'), /Unknown timezone/)
assert.throws(() => currentTime(), /no timezone configured/)
assert.throws(() => currentTime(['UTC'], undefined, 'invalid'), /server clock/)

console.log('Timezone conversion, DST and invalid-zone checks passed.')
