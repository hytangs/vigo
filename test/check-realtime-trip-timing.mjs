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
assert.deepEqual(times(skipped), [[602, 602], [627, 627], [637, 637]])
assert.deepEqual(skipped.stopTimes.map(stop => stop.stopId), ['A', 'C', 'D'])
const skippedConflict = resolve([
  { stopSequence: 20, scheduleRelationship: 'SKIPPED' },
  { stopSequence: 30, arrival: { time: 605 * 60 }, departure: { time: 605 * 60 } },
])
assert.deepEqual(times(skippedConflict), [[600, 600], [605, 605], [615, 615]], 'A skipped call must not inject its scheduled time between actual predictions')
assert.deepEqual(times(resolve([
  { stopSequence: 20, scheduleRelationship: 'SKIPPED', departure: { delay: 120 } },
])), [[600, 600], [627, 627], [637, 637]], 'A provided skipped-call delay still propagates')
assert.equal(resolve([{ stopSequence: 20, scheduleRelationship: 'SKIPPED', departure: { time: .5 } }]).status, 'invalid')
assert.deepEqual(resolve(rows.map(row => ({ stopSequence: row.stop_sequence, scheduleRelationship: 'SKIPPED' }))).stopTimes, [])
assert.deepEqual(resolve(rows.slice(1).map(row => ({ stopSequence: row.stop_sequence, scheduleRelationship: 'SKIPPED' }))).stopTimes.map(stop => stop.stopId), ['A'])

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
assert.equal(resolve([{ stopSequence: 999, departure: { delay: 60 } }]).status, 'invalid')
assert.equal(resolve([{ stopId: 'unknown', departure: { delay: 60 } }]).status, 'invalid')
assert.equal(resolve([{ stopSequence: 20 }, { stopId: 'B' }]).status, 'invalid', 'Two forms of the same call must not silently override one another')
for (const stopSequence of [20.5, -1, 0x1_0000_0000, 'bad', true, '']) {
  assert.equal(resolve([{ stopSequence, stopId: 'B', departure: { delay: 60 } }]).status, 'invalid')
}
for (const value of [0.5, Infinity, 'bad', true, '']) {
  assert.equal(resolve([], value).status, 'invalid')
  assert.equal(resolve([{ stopSequence: 20, departure: { delay: value } }]).status, 'invalid')
  assert.equal(resolve([{ stopSequence: 20, departure: { time: value, delay: 0 } }]).status, 'invalid', 'A malformed time must not silently fall back to delay')
}
assert.equal(resolve([], 1 << 20).status, 'invalid', 'Reject times outside the native packed time domain before kernel compilation')
assert.equal(resolve([{ stopSequence: 20, departure: { time: 1 << 20 } }]).status, 'invalid')
assert.equal(resolve([{ stopSequence: 20, departure: { time: -1 } }]).status, 'invalid')
assert.equal(resolve([{ stopSequence: 20, departure: 'bad' }]).status, 'invalid')
for (const converted of [Infinity, 123.5, 1 << 20]) {
  assert.equal(resolveRealtimeTripTimes(rows, { stopTimeUpdates: [{ stopSequence: 20, departure: { time: 1 } }] }, () => converted).status, 'invalid')
}
assert.equal(resolveRealtimeTripTimes(rows, { stopTimeUpdates: [{ stopSequence: 20, departure: { time: 1 } }] }, () => {
  throw new RangeError('Invalid date')
}).status, 'invalid', 'A bad epoch conversion must reject just that trip')
assert.deepEqual(times(resolve([{ stopSequence: '20', departure: { delay: '120' } }])),
  [[600, 600], [610, 617], [627, 627], [637, 637]])
assert.equal(resolve([], undefined, rows.map((row, index) => index === 1 ? { ...row, stop_sequence: 10 } : row)).status, 'invalid')
assert.equal(resolve([], undefined, rows.map((row, index) => index === 1 ? { ...row, arrival: row.arrival + .5 } : row)).status, 'invalid')
const compactRows = rows.map((row, index) => index === rows.length - 1
  ? { ...row, stop_sequence: 31, stop_sequence_inferred: true } : row)
const terminalPrediction = [{ stopSequence: 40, stopId: 'D', arrival: { delay: 60 } }]
const restoredTerminal = resolve(terminalPrediction, undefined, compactRows)
assert.deepEqual(times(restoredTerminal), [[600, 600], [610, 615], [625, 625], [636, 636]])
assert.equal(restoredTerminal.stopTimes.at(-1).sequence, 40)
assert.equal(resolve(terminalPrediction, undefined, compactRows.map(row => ({ ...row, stop_sequence_inferred: false }))).status, 'invalid')
assert.equal(resolve([{ stopSequence: 20, stopId: 'D', arrival: { delay: 60 } }], undefined, compactRows).status, 'invalid')
assert.equal(resolve([{ stopSequence: 31, stopId: 'D' }, ...terminalPrediction], undefined, compactRows).status, 'invalid')
assert.equal(resolve([...terminalPrediction, { stopSequence: 50, stopId: 'D' }], undefined, compactRows).status, 'invalid')
assert.deepEqual(times(resolve([{ stopSequence: 10, departure: { delay: -60 } }])),
  [[599, 599], [609, 614], [624, 624], [634, 634]])
assert.equal(resolve([{ stopSequence: 10, arrival: { delay: 0 }, departure: { delay: -60 } }]).status, 'invalid', 'Explicit contradictory predictions remain invalid')
const namespacedRows = rows.map(row => ({ ...row, stop_id: `feedA\u001f${row.stop_id}` }))
assert.equal(resolve([{ stopSequence: 20, stopId: 'feedB\u001fB', arrival: { delay: 60 } }], undefined, namespacedRows).status, 'invalid')
assert.equal(resolve([{ stopId: 'feedB\u001fB', arrival: { delay: 60 } }], undefined, namespacedRows).status, 'invalid')
assert.equal(resolve([{ stopId: 'feedA\u001fB', arrival: { delay: 60 } }], undefined, namespacedRows).status, 'ready')
assert.equal(resolve([{ stopId: 'B', arrival: { delay: 60 } }], undefined, namespacedRows).status, 'ready')

// An early first prediction can precede an omitted, scheduled prefix. Exclude
// only that unusable past prefix; do not invent actual times for omitted calls.
const serviceEpoch = Date.parse('2026-09-15T04:00:00Z') / 1000
const epochAt = minutes => serviceEpoch + minutes * 60
const clock = { nowSeconds: epochAt(620), feedTimestamp: epochAt(620) }
const earlySuffix = {
  timestamp: epochAt(619),
  stopTimeUpdates: [
    { stopSequence: 30, arrival: { time: epochAt(605) }, departure: { time: epochAt(607) } },
    { stopSequence: 40, arrival: { time: epochAt(620) }, departure: { time: epochAt(620) } },
  ],
}
const resolveSuffix = (update = earlySuffix, options = clock, timetable = rows) =>
  resolveRealtimeTripTimes(timetable, update, epoch => epoch - serviceEpoch, options)
const before = structuredClone({ rows, earlySuffix })
const trimmed = resolveSuffix()
assert.deepEqual(times(trimmed), [[605, 607], [620, 620]])
assert.deepEqual(trimmed.stopTimes.map(stop => stop.stopId), ['C', 'D'])
assert.equal(trimmed.omittedPastPrefixStops, 2)
assert.deepEqual({ rows, earlySuffix }, before, 'Resolving a suffix must not mutate the shared scheduled timetable or supplied snapshot')
assert.deepEqual(resolveSuffix(earlySuffix, { ...clock, nowSeconds: epochAt(650) }), trimmed,
  'An unchanged snapshot keeps the same resolved suffix as the query clock advances')
assert.equal(resolveSuffix(earlySuffix, {}).status, 'invalid', 'No supplied clock must retain conservative rejection')
assert.equal(resolveSuffix(earlySuffix, { nowSeconds: clock.nowSeconds }).status, 'invalid', 'A source clock is required')
assert.equal(resolveSuffix(earlySuffix, { ...clock, nowSeconds: epochAt(619) }).status, 'invalid', 'A future feed timestamp cannot authorize prefix omission')
assert.equal(resolveSuffix({ ...earlySuffix, timestamp: epochAt(621) }).status, 'invalid', 'A future record timestamp cannot authorize prefix omission')
assert.equal(resolveSuffix({ ...earlySuffix, timestamp: epochAt(614) }).status, 'invalid', 'The record clock must also establish that every prefix departure is past')
assert.equal(resolveSuffix(earlySuffix, { ...clock, feedTimestamp: epochAt(615) }).status, 'invalid', 'A departure exactly at the snapshot boundary is not past')
assert.equal(resolveSuffix(earlySuffix, { ...clock, feedTimestamp: epochAt(614) }).status, 'invalid', 'A future scheduled prefix cannot be removed')
assert.equal(resolveSuffix({ ...earlySuffix, delaySeconds: 0 }).status, 'invalid', 'An explicit trip delay prevents treating the prefix as unreported')
assert.equal(resolveSuffix({ ...earlySuffix, stopTimeUpdates: [{ stopSequence: 30, arrival: { delay: -1200 }, departure: { delay: -1080 } }] }).status,
  'invalid', 'Delay alone cannot establish that the first prediction is in the past')
for (const previous of [
  { stopSequence: 20, arrival: { time: epochAt(610) }, departure: { time: epochAt(615) } },
  { stopSequence: 10, scheduleRelationship: 'NO_DATA' },
  { stopSequence: 10, scheduleRelationship: 'SKIPPED' },
]) {
  assert.equal(resolveSuffix({ ...earlySuffix, stopTimeUpdates: [previous, ...earlySuffix.stopTimeUpdates] }).status,
    'invalid', 'Never discard an earlier explicit stop update to repair a conflict')
}
assert.equal(resolveSuffix({ ...earlySuffix, stopTimeUpdates: [
  earlySuffix.stopTimeUpdates[0],
  { stopSequence: 40, arrival: { time: epochAt(604) }, departure: { time: epochAt(604) } },
] }).status, 'invalid', 'A second contradiction remains invalid after the prefix is excluded')
assert.equal(resolveSuffix({ ...earlySuffix, stopTimeUpdates: [
  { stopSequence: 30, arrival: { time: epochAt(607) }, departure: { time: epochAt(605) } },
] }).status, 'invalid', 'Contradictory arrival/departure predictions must not become valid through trimming')
const departureOnly = resolveSuffix({ ...earlySuffix, stopTimeUpdates: [
  { stopSequence: 30, departure: { time: epochAt(607) } },
] })
assert.deepEqual(times(departureOnly), [[607, 607], [617, 617]])
assert.equal(departureOnly.omittedPastPrefixStops, 2)

// Minimal excerpts from the retained Boston snapshot: Route 70 trip 78477452
// and Green-D trip 77744710. A past prediction can still carry uncertainty;
// preserving it does not reclassify that prediction as observed passage.
for (const fixture of [
  {
    timestamp: 1789518962,
    rows: [[41, '883321', 74160], [42, '88334', 74280], [43, '88335', 74280]],
    predictions: [[42, '88334', 1789518750, 1789518750], [43, '88335', 1789518759, 1789518759]],
  },
  {
    timestamp: 1789518954, uncertainty: 60,
    rows: [[480, '70179', 74040], [490, '70177', 74220], [500, '70175', 74400]],
    predictions: [[490, '70177', 1789518803, 1789518842], [500, '70175', 1789518989, 1789519033]],
  },
]) {
  const timetable = fixture.rows.map(([stop_sequence, stop_id, time]) => ({ stop_sequence, stop_id, arrival: time, departure: time }))
  const update = {
    timestamp: fixture.timestamp, sourceFeedTimestamp: 1789518986,
    stopTimeUpdates: fixture.predictions.map(([stopSequence, stopId, arrival, departure]) => ({
      stopSequence, stopId, arrival: { time: arrival, uncertainty: fixture.uncertainty }, departure: { time: departure, uncertainty: fixture.uncertainty },
    })),
  }
  const result = resolveSuffix(update, { nowSeconds: 1789518986 }, timetable)
  assert.equal(result.status, 'ready')
  assert.equal(result.omittedPastPrefixStops, 1)
  assert.deepEqual(result.stopTimes.map(stop => [stop.arrival, stop.departure]),
    fixture.predictions.map(([, , arrival, departure]) => [arrival - serviceEpoch, departure - serviceEpoch]))
}
console.log('Realtime timing passed: dwell, propagation, NO_DATA, skipped calls, exact identity, guarded past-prefix omission, malformed records, and native numeric bounds.')
