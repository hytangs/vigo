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
import { stopBoard } from '../src/agency/stopBoard.mjs'
import { scheduledServiceWindow } from '../src/agency/serviceWindow.mjs'
import { WeightedLruCache } from '../src/server/weighted-lru-cache.mjs'
import { createAgencyFixture, observationTime, realtimeFixture, tripUpdate } from './fixtures/agency.mjs'

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

const scopedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agency-schedule-efficiency-'))
try {
  const file = path.join(scopedDirectory, 'schedule.sqlite')
  createAgencyFixture(file)
  const db = new DatabaseSync(file)
  db.exec(`
    INSERT INTO stops VALUES('D','D',0,0,'',0,''),('E','E',0,0,'',0,'');
    INSERT INTO calendar VALUES('ADDED',0,0,0,0,0,0,0,20260901,20260930);
    INSERT INTO calendar_dates VALUES('ADDED',20260913,1),('S',20260914,2);
    INSERT INTO trips VALUES('A-added','R','ADDED','0'),('NIGHT','R','S','0'),('OTHER','R','S','0'),('other'||char(31)||'T1','R','S','0'),('FREQ','R','S','0');
    INSERT INTO connections VALUES
      (43600,43900,'A-added','R','ADDED','0','D','E',10),
      (86700,87000,'NIGHT','R','S','0','A','B',10),
      (43600,43900,'OTHER','R','S','0','D','E',10),
      (43600,43900,'other'||char(31)||'T1','R','S','0','D','E',10),
      (43600,43900,'FREQ','R','S','0','A','B',10);
    INSERT INTO frequencies VALUES('FREQ',43200,50000,600,0);
  `)
  db.close()
  context = new AgencyContext(file, 'City X')
  const loaded = []
  const read = context.tripDepartures.bind(context)
  context.tripDepartures = id => { loaded.push(id); return read(id) }
  for (const record of [tripUpdate('T2'), tripUpdate('T1'), tripUpdate('FREQ'), tripUpdate('missing'), tripUpdate('T2', 0, { directionId: 1 }), tripUpdate('T2', 0, { startDate: '20260231' }), tripUpdate('T2', 0, { sourceScope: 'other' })]) {
    const before = loaded.length
    const identity = context.matchTripIdentity(record, '2026-09-13')
    assert.equal(loaded.length, before, 'Resolving identity does not load trip geometry or stop times.')
    const { departures, epoch, ...fullIdentity } = context.matchTrip(record, '2026-09-13')
    assert.deepEqual(identity, fullIdentity, 'Identity-only checks retain the complete matcher’s admission rules.')
  }
  loaded.length = 0
  const board = stopBoard(context, realtimeFixture([tripUpdate('T1', 60), tripUpdate('T2', 60), tripUpdate('OTHER', 60)]), { stopId: 'A' }, observationTime)
  assert.ok(board.rows.some(row => row.tripId === 'T2' && row.status === 'live'))
  assert.equal(board.rows.find(row => row.tripId === 'T1').status, 'scheduled', 'A trip at another station still makes an unscoped identity ambiguous.')
  assert.ok(!loaded.includes('OTHER') && !loaded.includes('other\u001fT1'), 'A station board never loads stop times for reports on unrelated trips.')

  // Retain the previous full-scan definition as an independent oracle for
  // interval boundaries, active-calendar ordering and frequency exclusions.
  const spans = context.db.prepare('SELECT trip_id, MIN(departure) AS first, MAX(arrival) AS last FROM connections GROUP BY trip_id').all()
  const originalWindow = (from, to) => {
    const trips = [], excluded = new Set()
    const noon = Date.parse(`${localDate(from, context.timezone)}T12:00:00Z`)
    for (let offset = -Math.ceil(Math.max(...spans.map(row => row.last)) / 86400); ; offset++) {
      const serviceDate = new Date(noon + offset * 86400000).toISOString().slice(0, 10)
      if (serviceDate > localDate(to, context.timezone)) break
      const epoch = serviceEpoch(serviceDate, context.timezone), active = context.activeServices(serviceDate)
      for (const row of spans) {
        const trip = context.tripById.get(row.trip_id)
        if (!trip || !active.has(trip.service_id)) continue
        const seconds = Math.max(0, Math.min(to, epoch + row.last) - Math.max(from, epoch + row.first))
        if (!seconds) continue
        if (context.frequencyTrips.has(trip.trip_id)) { excluded.add(trip.trip_id); continue }
        trips.push({ key: JSON.stringify([trip.trip_id, serviceDate]), tripId: trip.trip_id, routeId: trip.route_id, directionId: trip.direction_id, serviceDate, seconds, startsAt: epoch + row.first, endsAt: epoch + row.last })
      }
    }
    return { trips, excludedFrequencyTemplates: excluded.size }
  }
  for (const [date, zone] of [['2026-09-13', 'Etc/UTC'], ['2026-09-14', 'Etc/UTC'], ['2026-09-13', 'Asia/Kathmandu'], ['2026-11-01', 'America/New_York']]) {
    context.timezone = zone
    const start = serviceEpoch(date, zone)
    for (const [from, to] of [[0, 1800], [43500, 43900], [44040, 44400], [86300, 88000], [0, 86400], [43500, 43500]]) {
      assert.deepEqual(scheduledServiceWindow(context, start + from, start + to), originalWindow(start + from, start + to))
    }
  }
  const lookup = mock.method(context.tripById, 'get')
  try {
    scheduledServiceWindow(context, observationTime, observationTime + 1800)
    assert.equal(lookup.mock.callCount(), 0, 'A warm service window does not repeatedly resolve every trip in the feed.')
  } finally { lookup.mock.restore() }
} finally { context?.close(); await fs.rm(scopedDirectory, { recursive: true, force: true }) }
console.log('Agency efficiency: exact window reuse, bounded eviction, formatter reuse, indexed matching, scoped timetable reads, calendar parity and advancing freshness passed.')
