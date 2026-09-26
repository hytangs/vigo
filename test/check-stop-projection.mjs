import assert from 'node:assert/strict'
import { projectAccessProfileToTimetable } from '../src/server/gtfs/stop-projection.mjs'

const kernel = { stopIndex: new Map([['a', 0], ['b', 4]]) }
const record = { profileKey: 'first', profileMembers: [{ stop_id: 'a' }, { stop_id: 'missing' }] }
const first = projectAccessProfileToTimetable(record, kernel)
assert.deepEqual([...first], [0, 0xffff_ffff])
assert.equal(projectAccessProfileToTimetable(record, kernel), first)
for (let index = 0; index < 100; index += 1) {
  record.profileKey = `replacement-${index}`
  record.profileMembers = [{ stop_id: 'b' }]
  const projection = projectAccessProfileToTimetable(record, kernel)
  assert.deepEqual([...projection], [4])
  assert.equal(projectAccessProfileToTimetable(record, kernel), projection)
}
record.profileKey = 'first'
record.profileMembers = [{ stop_id: 'a' }, { stop_id: 'missing' }]
const restored = projectAccessProfileToTimetable(record, kernel)
assert.notEqual(restored, first, 'Historical profiles must be recomputed instead of accumulating in the cache.')
assert.deepEqual(restored, first)
const replacementRecord = { ...record, profileMembers: [{ stop_id: 'b' }] }
assert.deepEqual([...projectAccessProfileToTimetable(replacementRecord, kernel)], [4])
const otherKernel = { stopIndex: new Map([['a', 7]]) }
assert.deepEqual([...projectAccessProfileToTimetable(record, otherKernel)], [7, 0xffff_ffff])
console.log('Stop projections reuse only the current profile and isolate street records and timetables.')
