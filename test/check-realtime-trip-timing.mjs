import assert from 'node:assert/strict'
import { resolveRealtimeTripTimes } from '../src/server/realtime-trip-timing.mjs'

const rows = [
  ['A', 600, 600], ['B', 610, 615], ['C', 625, 625], ['D', 635, 635],
].map(([stop_id, arrival, departure], i) => ({ stop_id, stop_sequence: (i + 1) * 10, arrival: arrival * 60, departure: departure * 60 }))
const resolve = (stopTimeUpdates, delaySeconds, timetable = rows) => resolveRealtimeTripTimes(timetable, { stopTimeUpdates, delaySeconds }, time => time)
const times = result => {
  assert.equal(result.status, 'ready')
  return result.stopTimes.map(stop => [stop.arrival / 60, stop.departure / 60])
}
assert.deepEqual(times(resolve([], 300)), [[605, 605], [615, 620], [630, 630], [640, 640]])
for (const delay of [120, -60]) {
  assert.deepEqual(times(resolve([{ stopSequence: 20, arrival: { delay }, departure: { delay } }])),
    [[600, 600], [610 + delay / 60, 615 + delay / 60], [625 + delay / 60, 625 + delay / 60], [635 + delay / 60, 635 + delay / 60]])
}
assert.deepEqual(times(resolve([
  { stopSequence: 20, arrival: { delay: 120 }, departure: { delay: 60 } },
  { stopSequence: 40, arrival: { delay: 0 }, departure: { delay: 0 } },
], 300)), [[605, 605], [612, 616], [626, 626], [635, 635]])
// Epoch times take precedence over conflicting delay fields. The conversion
// callback here uses service seconds so the expected values are explicit.
assert.deepEqual(times(resolve([{ stopId: 'B', arrival: { time: 612 * 60, delay: 900 }, departure: { time: 616 * 60 } }])),
  [[600, 600], [612, 616], [626, 626], [636, 636]])
assert.deepEqual(times(resolve([{ stopSequence: 20, arrival: { delay: 120 } }])),
  [[600, 600], [612, 617], [627, 627], [637, 637]])
assert.deepEqual(times(resolve([{ stopSequence: 20, departure: { delay: 120 } }])),
  [[600, 600], [610, 617], [627, 627], [637, 637]])
for (const scheduleRelationship of ['NO_DATA', 2]) {
  assert.deepEqual(times(resolve([{ stopSequence: 20, scheduleRelationship }], 300)),
    [[605, 605], [610, 615], [625, 625], [635, 635]])
}
assert.deepEqual(times(resolve([
  { stopSequence: 20, arrival: { delay: 120 }, departure: { delay: 120 } },
  { stopSequence: 30, scheduleRelationship: 'NO_DATA' },
])), [[600, 600], [612, 617], [625, 625], [635, 635]])
const skipped = resolve([{ stopSequence: 20, scheduleRelationship: 'SKIPPED' }], 120)
assert.deepEqual(times(skipped), [[602, 602], [612, 617], [627, 627], [637, 637]])
assert.equal(skipped.stopTimes[1].canBoard, false)
assert.equal(skipped.stopTimes[1].canAlight, false)

const loop = rows.map((row, i) => ({ ...row, stop_id: i === 2 ? 'A' : row.stop_id }))
assert.deepEqual(times(resolve([{ stopSequence: 30, stopId: 'A', arrival: { delay: 60 }, departure: { delay: 60 } }], undefined, loop)),
  [[600, 600], [610, 615], [626, 626], [636, 636]])
assert.equal(resolve([{ stopId: 'A', departure: { delay: 60 } }], undefined, loop).status, 'invalid')
assert.equal(resolve([{ stopSequence: 20, stopId: 'C', departure: { delay: 60 } }]).status, 'invalid')
assert.equal(resolve([{ stopSequence: 20 }, { stopSequence: 20 }]).status, 'invalid')
assert.equal(resolve([{ stopSequence: 20, arrival: { delay: 600 }, departure: { delay: 0 } }]).status, 'invalid')
assert.equal(resolve([{ stopSequence: 20, arrival: { delay: -1200 }, departure: { delay: -1200 } }]).status, 'invalid')
assert.equal(resolve([{ stopSequence: 20, scheduleRelationship: 'UNSCHEDULED' }]).status, 'unsupported')
assert.deepEqual(times(resolve(undefined)), [[600, 600], [610, 615], [625, 625], [635, 635]])
assert.equal(resolve({}).status, 'invalid')
assert.equal(resolve([], Number.MAX_VALUE).status, 'invalid')
console.log('Realtime timing passed: dwell, forward delay, NO_DATA, skipped calls, loop identity, and contradictory timestamps.')
