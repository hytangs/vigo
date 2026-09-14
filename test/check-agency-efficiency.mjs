import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { mock } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { AgencyContext, serviceEpoch, localDate, rawId } from '../src/agency/agencyContext.mjs'
import { agencyClock } from '../src/agency/agencyClock.mjs'
import { deriveOperationalState } from '../src/agency/realtimeIntelligence.mjs'
import { matchCall, tripCalls } from '../src/agency/routeOperations.mjs'
import { WeightedLruCache } from '../src/server/weighted-lru-cache.mjs'
import { createAgencyFixture, observationTime, realtimeFixture } from './fixtures/agency.mjs'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agency-efficiency-'))
let context
try {
  const file = path.join(directory, 'timetable.sqlite')
  createAgencyFixture(file)
  const db = new DatabaseSync(file)
  db.exec("INSERT INTO calendar_dates VALUES('S',20260914,2)")
  db.close()
  context = new AgencyContext(file, 'City X')
  const trip = context.tripById.get('T1'), statement = context.referenceDepartures
  let reads = 0
  context.referenceDepartures = { all(...args) { reads++; return statement.all(...args) } }
  const reference = (date, from, to) => statement.all('A', from, to).filter(row => context.activeServices(date).has(row.service_id))
  for (let seconds = 0; seconds <= 180; seconds++) {
    const from = 43500 + seconds, to = 44700 + seconds
    assert.deepEqual(context.expectedDepartures(trip, 'A', '2026-09-13', from, to), reference('2026-09-13', from, to), 'Moving exact bounds must match an uncached SQL read, including inclusive endpoints.')
  }
  assert.equal(reads, 1, 'Advancing seconds within a static window does not repeat its SQL query.')
  assert.deepEqual(context.expectedDepartures(trip, 'A', '2026-09-14', 43500, 44700), [], 'Calendar exceptions remain part of the cache identity.')
  assert.deepEqual(context.expectedDepartures({ ...trip, direction_id: '1' }, 'A', '2026-09-13', 43500, 44700), [], 'Directions cannot share filtered timetable rows.')
  context.referenceCache = new WeightedLruCache({ maxEntries: 2 })
  for (const [from, to] of [[43500, 44700], [43199, 43200], [46800, 46801], [43500, 44700]]) {
    assert.deepEqual(context.expectedDepartures(trip, 'A', '2026-09-13', from, to), reference('2026-09-13', from, to))
  }
  assert.equal(context.referenceCache.size, 2)
  assert.ok(context.referenceCache.snapshot().evictions > 0, 'Eviction is exercised, not just configured.')
  context.tripCache = new WeightedLruCache({ maxEntries: 1 })
  const first = tripCalls(context, 'T1')
  assert.equal(tripCalls(context, 'T1'), first, 'Repeated station and vehicle reads reuse indexed calls.')
  tripCalls(context, 'T2')
  assert.deepEqual(tripCalls(context, 'T1'), first, 'Eviction reloads the same scheduled sequence.')
  assert.ok(context.tripCache.snapshot().evictions > 0)

  const Format = Intl.DateTimeFormat
  let constructed = 0
  const formatter = mock.method(Intl, 'DateTimeFormat', function (...args) { constructed++; return new Format(...args) })
  const readClocks = () => {
    serviceEpoch('2026-09-13', 'Asia/Kathmandu')
    localDate(observationTime, 'Asia/Kathmandu')
    agencyClock(new Date(observationTime * 1000).toISOString(), 'Asia/Kathmandu')
  }
  try {
    readClocks()
    const cold = constructed
    for (let i = 0; i < 100; i++) readClocks()
    assert.equal(constructed, cold, 'Warm clock reads never construct another timezone formatter.')
    assert.throws(() => serviceEpoch('2026-02-30', 'Asia/Kathmandu'), /Invalid service date/)
    assert.throws(() => serviceEpoch('2026-09-13', 'invalid/timezone'))
  } finally { formatter.mock.restore() }

  const snapshot = realtimeFixture()
  assert.equal(deriveOperationalState(context, snapshot, observationTime).counts.matchedTrips, 3)
  assert.equal(deriveOperationalState(context, snapshot, observationTime + 181).counts.matchedTrips, 0, 'Only static timetable data is cached; reporting freshness still advances.')
} finally { context?.close(); await fs.rm(directory, { recursive: true, force: true }) }

// Compare indexed matching with the prior linear definition across repeated
// stops, scoped IDs, conflicting sequences and the unretained terminal sequence.
function linearMatch(calls, stopId, sequence) {
  const finite = Number.isFinite
  const same = (a, b) => String(b).includes('\u001f') ? a === b : rawId(a) === rawId(b)
  if (!stopId && !finite(sequence)) return null
  const indexed = calls.map((call, index) => ({ ...call, index }))
  if (finite(sequence)) {
    const exact = indexed.filter(call => call.sequence === sequence)
    if (exact.length) return exact.length === 1 && (!stopId || same(exact[0].stopId, stopId)) ? exact[0] : null
  }
  const candidates = indexed.filter(call => stopId && same(call.stopId, stopId))
  if (finite(sequence) && (candidates[0]?.sequence !== null || sequence <= Math.max(...calls.map(call => call.sequence ?? -1)))) return null
  return candidates.length === 1 ? candidates[0] : null
}
for (const calls of [[], [{ stopId: 'A', sequence: 0 }], [{ stopId: 'A', sequence: 10 }, { stopId: 'B', sequence: 10 }, { stopId: 'A', sequence: null }], [{ stopId: 'one\u001fA', sequence: 10 }, { stopId: 'two\u001fA', sequence: 30 }, { stopId: 'C', sequence: null }]]) {
  for (const id of [undefined, '', 'A', 'B', 'C', 'one\u001fA', 'two\u001fA', 'missing']) {
    for (const sequence of [undefined, null, -1, 0, 10, 30, 90]) assert.deepEqual(matchCall(calls, id, sequence), linearMatch(calls, id, sequence))
  }
}
let stopReads = 0
const longTrip = Array.from({ length: 2000 }, (_, sequence) => ({ sequence, get stopId() { stopReads++; return `stop-${sequence}` } }))
matchCall(longTrip, 'stop-0', 0)
const indexReads = stopReads
for (let i = 0; i < 2000; i++) assert.equal(matchCall(longTrip, `stop-${i}`, i).index, i)
assert.equal(stopReads, indexReads, 'Matching every report reuses the stop index instead of rereading the entire trip per report.')
console.log('Agency efficiency: exact window reuse, bounded eviction, formatter reuse, indexed matching parity and advancing freshness passed.')
