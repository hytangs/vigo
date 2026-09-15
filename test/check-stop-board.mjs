import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgencyContext, serviceEpoch } from '../src/agency/agencyContext.mjs'
import { stopBoard, indexedBoardStop } from '../src/agency/stopBoard.mjs'
import { createAgencyService } from '../src/server/agency-api.mjs'
import { createAgencyFixture, realtimeFixture, tripUpdate, observationTime, sourceUrl } from './fixtures/agency.mjs'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stop-board-'))
let context
try {
  const file = path.join(directory, 'schedule.sqlite')
  createAgencyFixture(file)
  const db = new DatabaseSync(file)
  db.exec(`INSERT INTO stops VALUES('station','Library station',42.37,-71.05,'',1,''),('B2','Library opposite',42.37,-71.05,'station',0,'2');
    UPDATE stops SET parent_station='station',platform_code='1' WHERE stop_id='B';
    INSERT INTO trips VALUES('BACK','R','S','1'),('NIGHT','R','S','0'),('LOOP','R','S','0'),('FREQ','R','S','0');
    INSERT INTO connections VALUES
    (43500,43740,'BACK','R','S','1','C','B2',10),(43800,44040,'BACK','R','S','1','B2','A',30),
    (86700,86940,'NIGHT','R','S','0','A','B',10),
    (43500,43740,'LOOP','R','S','0','B','A',10),(43800,44040,'LOOP','R','S','0','A','B',30),
    (43500,43740,'FREQ','R','S','0','A','B',10);
    INSERT INTO frequencies VALUES('FREQ',43200,50000,600,0);`)
  db.close()
  context = new AgencyContext(file, 'City X')
  assert.equal(indexedBoardStop(context, 'feed-a::B', ['feed-a']), 'B', 'Single-feed Studio IDs resolve through the known source')
  assert.throws(() => indexedBoardStop(context, 'wrong-feed::B', ['feed-a']), /exact stop/)
  assert.throws(() => indexedBoardStop(context, 'feed-a::B', ['feed-a', 'feed-b']), /exact stop/, 'Never discard a multi-feed identity')
  const merged = { stopIndex: new Map([['feed-a\u001fB', {}], ['feed-b\u001fB', {}]]), scopes: ['feed-a', 'feed-b'] }
  assert.equal(indexedBoardStop(merged, 'feed-b::B', ['feed-a', 'feed-b']), 'feed-b\u001fB')
  assert.throws(() => indexedBoardStop(merged, 'B', ['feed-a', 'feed-b']), /exact stop/)
  const epoch = serviceEpoch('2026-09-13', 'Etc/UTC')
  const report = tripUpdate('T1', 0, { stopTimeUpdates: [{ stopId: 'B', stopSequence: 30, arrival: { time: epoch + 43860 }, departure: { time: epoch + 43980 } }, { stopId: 'C', stopSequence: 90, arrival: { time: epoch + 44200 } }] })
  const snapshot = realtimeFixture([report])
  const board = (stopId = 'B', now = observationTime) => stopBoard(context, snapshot, { stopId }, now)
  let result = board()
  assert.equal(result.routeCount, 1, 'Multiple trips and opposite directions do not become multiple routes')
  const row = () => board().rows.find(row => row.tripId === 'T1')
  assert.equal(result.stop.id, 'station', 'A platform opens the declared parent station')
  assert.ok(result.rows.some(row => row.directionId === '1' && row.platform === '2'), 'Opposite platforms and directions appear together')
  assert.equal(row().arrival.scheduled, epoch + 43740)
  assert.equal(row().arrival.current, epoch + 43860)
  assert.equal(row().departure.current, epoch + 43980)
  assert.equal(row().vehicleId, 'vehicle-T1', 'TripUpdate identity is available without GPS')
  assert.equal(row().status, 'live')
  assert.equal(result.feeds[0].status, 'fresh')
  assert.equal(row().stopSequence, 30)
  assert.equal(row().source.stopSequence, 30)
  assert.equal(row().source.url, sourceUrl)
  assert.deepEqual(row().source.arrival, report.stopTimeUpdates[0].arrival, 'Source event remains available for inspection')
  report.vehicleLabel = '101-102'
  assert.equal(row().vehicleLabel, '101-102', 'A reported consist label must not be replaced with the internal vehicle ID')
  const reportedArrival = report.stopTimeUpdates[0].arrival
  report.stopTimeUpdates[0].arrival = { time: epoch + 44000 }
  assert.equal(row().status, 'unresolved', 'Arrival after departure is a contradictory prediction')
  assert.equal(row().arrival.current, null)
  assert.equal(row().departure.current, null)
  assert.equal(row().source.arrival.time, epoch + 44000, 'Retain contradictory source values without advertising them as an ETA')
  assert.match(row().timingIssue, /arrival after departure/)
  report.stopTimeUpdates[0].arrival = reportedArrival
  const early = tripUpdate('T3', 0, { stopTimeUpdates: [{ stopId: 'B', stopSequence: 30, arrival: { delay: -1020 }, departure: { delay: -1020 } }] })
  snapshot.tripUpdates.push(early)
  const earlyRow = board().rows.find(row => row.tripId === 'T3')
  assert.equal(earlyRow.status, 'live', 'A 17-minute early prediction alone is not an identity failure')
  assert.equal(earlyRow.arrival.current - earlyRow.arrival.scheduled, -1020)
  snapshot.tripUpdates.pop()
  assert.equal(board('C').rows.find(row => row.tripId === 'T1').arrival.current, epoch + 44200, 'Terminal arrival retained')
  assert.equal(board('C').rows.find(row => row.tripId === 'T1').departure.scheduled, null)
  assert.ok(!result.rows.some(row => row.tripId === 'FREQ'), 'Frequency templates are not advertised as specific arrivals')
  assert.equal(board('A').rows.find(row => row.tripId === 'T1').kind, 'departure', 'Origin departure must not be labeled arrival')
  delete report.stopTimeUpdates[0].arrival
  assert.equal(row().kind, 'departure', 'Departure-only prediction stays labeled as departure')
  assert.equal(row().arrival.current, null)
  report.stopTimeUpdates[0].arrival = { time: epoch + 43860 }
  report.stopTimeUpdates[0].scheduleRelationship = 'SKIPPED'
  assert.equal(row().status, 'skipped')
  assert.equal(row().arrival.current, null)
  report.stopTimeUpdates[0].scheduleRelationship = 'NO_DATA'
  assert.equal(row().status, 'scheduled')
  delete report.stopTimeUpdates[0].scheduleRelationship
  report.scheduleRelationship = 'CANCELED'
  assert.equal(row().status, 'cancelled')
  delete report.scheduleRelationship
  snapshot.tripUpdates.push({ ...report, id: 'duplicate', sourceUrl: 'https://example.org/duplicate' })
  assert.equal(row().status, 'unresolved')
  assert.equal(row().arrival.current, null)
  snapshot.tripUpdates.pop()
  report.timestamp = observationTime - 181
  assert.equal(row().status, 'stale')
  assert.equal(row().arrival.current, null)
  report.timestamp = observationTime + 181
  assert.equal(row().status, 'stale')
  report.timestamp = observationTime
  snapshot.feeds[0].feedTimestamp = undefined
  assert.equal(row().arrival.current, null, 'Unknown feed time is not fresh')
  snapshot.feeds[0].feedTimestamp = observationTime
  snapshot.feeds[0].error = 'Fetch failed'
  assert.equal(board().feeds[0].status, 'error', 'Recent timestamp does not hide a failed source refresh')
  assert.equal(row().status, 'stale')
  delete snapshot.feeds[0].error
  snapshot.tripUpdates.push(tripUpdate('LOOP', 0, { stopTimeUpdates: [{ stopId: 'B', arrival: { time: epoch + 44100 } }] }))
  assert.ok(board().rows.filter(row => row.tripId === 'LOOP').every(row => row.arrival.current === null), 'Repeated stops require an exact occurrence')
  snapshot.feeds.push({ sourceUrl: 'vehicles', kind: 'vehicles', feedTimestamp: observationTime })
  snapshot.vehicles = [{ id: 'vehicle-T1', label: '101', sourceUrl: 'vehicles', timestamp: observationTime, tripId: 'T1', routeId: 'R', startDate: '20260913', stopId: 'B', currentStopSequence: 30, currentStatus: 'STOPPED_AT' }]
  assert.equal(row().atStop, true)
  assert.equal(row().vehicleLabel, '101')
  snapshot.vehicles[0].stopId = 'C'; snapshot.vehicles[0].currentStopSequence = 90
  assert.ok(!row(), 'A fresh vehicle beyond the selected call must not appear as approaching')
  snapshot.vehicles[0].timestamp = observationTime - 181
  assert.ok(row(), 'Stale vehicle position cannot suppress a current prediction')
  const midnight = serviceEpoch('2026-09-14', 'Etc/UTC')
  result = stopBoard(context, null, { stopId: 'B' }, midnight)
  assert.equal(result.rows.find(row => row.tripId === 'NIGHT').serviceDate, '2026-09-13', 'After-midnight service keeps its original service day')
  assert.ok(result.warnings.length)
  assert.throws(() => board('unknown'), /exact stop/)
  assert.ok(stopBoard(context, null, { stopId: 'B' }, Date.parse('2026-10-01T12:00:00Z') / 1000).warnings.length, 'Expired schedule is explained')
  const service = createAgencyService({ context: async () => ({ storePath: file, cityName: 'City X', agencyDirectory: path.join(directory, 'agency'), feedIds: ['feed-a'] }) }, { clock: () => observationTime * 1000 })
  try {
    assert.equal((await service.handle('city-x', { action: 'stop-board', stopId: 'feed-a::B' })).stop.id, 'station')
    await assert.rejects(service.handle('city-x', { action: 'stop-board', stopId: 'wrong-feed::B', feedIds: ['wrong-feed'] }), /exact stop/, 'Source mappings come from server metadata, not the request')
  } finally { service.close() }
  console.log('Stop board: station grouping, both directions, vehicle identities, separate arrival/departure, terminals, cancellations, skipped stops, duplicate/unknown/stale reports, loops, midnight and schedule fallback passed.')
} finally { context?.close(); await fs.rm(directory, { recursive: true, force: true }) }
