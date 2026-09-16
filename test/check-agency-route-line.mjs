import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgencyContext, serviceEpoch } from '../src/agency/agencyContext.mjs'
import { routeOperations, vehicleDetails, tripCalls } from '../src/agency/routeOperations.mjs'
import { createAgencyFixture, realtimeFixture, tripUpdate, observationTime } from './fixtures/agency.mjs'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agency-line-'))
let context
try {
  const file = path.join(directory, 'schedule.sqlite')
  createAgencyFixture(file)
  const db = new DatabaseSync(file)
  db.exec(`INSERT INTO stops VALUES('D','Branch',42.4,-71,'',0,'');
    INSERT INTO trips VALUES('RETURN','R','S','1'),('BRANCH','R','S','0'),('LOOP','R','S','0'),('ROUND','R','S','0');
    INSERT INTO connections VALUES
    (43500,43740,'RETURN','R','S','1','C','B',2),(43800,44040,'RETURN','R','S','1','B','A',8),
    (43500,43740,'BRANCH','R','S','0','A','D',10),
    (43500,43740,'LOOP','R','S','0','A','B',10),(43800,44040,'LOOP','R','S','0','B','A',30),(44100,44340,'LOOP','R','S','0','A','C',50),
    (43500,43740,'ROUND','R','S','0','A','B',10),(43800,44040,'ROUND','R','S','0','B','A',30);`)
  db.close()
  context = new AgencyContext(file, 'City X')
  const epoch = serviceEpoch('2026-09-13', 'Etc/UTC')
  const snapshot = realtimeFixture([tripUpdate('T1', 900, { stopTimeUpdates: [
    { stopId: 'A', stopSequence: 10, departure: { delay: 900 } },
    { stopId: 'B', stopSequence: 30, arrival: { time: epoch + 43860 }, departure: { time: epoch + 43980 } },
    { stopId: 'C', stopSequence: 90, arrival: { time: epoch + 44100 } },
  ] })])
  const vehicleSource = 'https://example.org/vehicles'
  snapshot.feeds.push({ sourceUrl: vehicleSource, kind: 'vehicles', feedTimestamp: observationTime })
  snapshot.vehicles = [{ id: 'vehicle-T1', label: '101', sourceUrl: vehicleSource, timestamp: observationTime,
    tripId: 'T1', routeId: 'R', directionId: 0, startDate: '20260913', stopId: 'B', currentStopSequence: 30, currentStatus: 'INCOMING_AT' }]
  const detail = () => vehicleDetails(context, snapshot, { vehicleId: 'vehicle-T1' }, observationTime)
  let vehicle = detail()
  assert.equal(vehicle.stop.name, 'Library', 'Vehicle stop wins over the first, potentially past TripUpdate stop')
  assert.deepEqual(vehicle.arrival, { scheduled: epoch + 43740, current: epoch + 43860 }, 'Arrival comes from the incoming connection, not its outgoing arrival')
  assert.deepEqual(vehicle.departure, { scheduled: epoch + 43800, current: epoch + 43980 })
  assert.equal(vehicle.delaySeconds, 120, 'Absolute same-stop times establish delay; trip-wide delay must not replace them')
  assert.equal(vehicle.delayKind, 'arrival')
  assert.equal(vehicle.callIndex, 1)
  assert.equal(vehicle.destination, 'Terminal')
  const line = routeOperations(context, snapshot, { routeId: 'R' }, observationTime)
  assert.equal(line.patterns.length, 5, 'Branches, loops and the reverse direction retain their actual sequences')
  assert.ok(line.patterns.some(pattern => pattern.directionId === '1' && pattern.stops.map(stop => stop.id).join() === 'C,B,A'))
  assert.ok(line.vehicles[0].patternId)
  assert.equal(tripCalls(context, 'T1').calls.at(-1).sequence, null, 'Do not invent a terminal sequence')

  snapshot.vehicles[0].stopId = 'C'; snapshot.vehicles[0].currentStopSequence = 10
  assert.equal(detail().callIndex, null, 'A terminal ID cannot contradict a retained sequence')
  snapshot.vehicles[0].currentStopSequence = 90
  vehicle = detail()
  assert.equal(vehicle.arrival.scheduled, epoch + 44040)
  assert.equal(vehicle.arrival.current, epoch + 44100)
  assert.equal(vehicle.departure.scheduled, null)
  assert.equal(vehicle.departure.current, null)
  snapshot.vehicles[0].stopId = 'B'; snapshot.vehicles[0].currentStopSequence = 30

  const update = snapshot.tripUpdates[0].stopTimeUpdates[1]
  update.arrival = { time: epoch + 43981 }
  assert.equal(detail().arrival.current, null)
  assert.equal(detail().departure.current, null)
  assert.match(detail().warnings.join(), /arrival after departure/, 'Vehicle and station views reject the same contradictory timing')
  update.arrival = { time: epoch + 42840, delay: 120 }
  assert.equal(detail().delaySeconds, -900, 'Explicit early time takes precedence over a conflicting delay; no magnitude heuristic')
  update.arrival = undefined
  vehicle = detail()
  assert.equal(vehicle.arrival.current, null, 'A departure prediction never becomes an arrival prediction')
  assert.equal(vehicle.departure.current, epoch + 43980)
  assert.equal(vehicle.delayKind, 'departure')
  update.scheduleRelationship = 'NO_DATA'
  assert.equal(detail().departure.current, null)
  update.scheduleRelationship = 'SKIPPED'
  assert.match(detail().warnings.join(), /skipped/)
  delete update.scheduleRelationship
  snapshot.tripUpdates.push({ ...snapshot.tripUpdates[0], id: 'duplicate' })
  assert.equal(detail().departure.current, null)
  assert.match(detail().warnings.join(), /Multiple/)
  snapshot.tripUpdates.pop()
  snapshot.tripUpdates[0].timestamp = observationTime - 181
  assert.equal(detail().departure.current, null)
  snapshot.tripUpdates[0].timestamp = observationTime
  snapshot.vehicles[0].timestamp = observationTime - 181
  assert.equal(detail().callIndex, null, 'Stale positions are retained outside the diagram')
  snapshot.vehicles[0].timestamp = observationTime + 181
  assert.equal(detail().fresh, false)
  snapshot.vehicles[0].timestamp = observationTime
  snapshot.vehicles[0].tripId = 'LOOP'; snapshot.vehicles[0].stopId = 'A'; delete snapshot.vehicles[0].currentStopSequence
  assert.equal(detail().callIndex, null, 'Repeated stops require an exact retained sequence')
  snapshot.vehicles[0].currentStopSequence = 50
  assert.equal(detail().callIndex, 2)
  snapshot.vehicles[0].tripId = 'ROUND'; snapshot.vehicles[0].currentStopSequence = 10
  assert.equal(detail().callIndex, 0, 'An exact retained sequence resolves a stop repeated at the terminal')
  delete snapshot.vehicles[0].currentStopSequence
  assert.equal(detail().callIndex, null)
  snapshot.vehicles[0].currentStopSequence = 90
  assert.equal(detail().callIndex, null, 'An unretained terminal sequence cannot disambiguate a repeated stop')
  snapshot.vehicles[0].tripId = 'LOOP'; snapshot.vehicles[0].currentStopSequence = 50
  snapshot.vehicles.push({ ...snapshot.vehicles[0], sourceUrl: 'other-feed' })
  assert.throws(detail, /ambiguous/)
  assert.equal(vehicleDetails(context, snapshot, { vehicleId: 'vehicle-T1', sourceUrl: vehicleSource }, observationTime).callIndex, 2)
  assert.throws(() => routeOperations(context, snapshot, { routeId: 'missing' }, observationTime), /exact route/)

  // A source can drop the current stop while VehiclePosition still reports it.
  // Later predictions must remain useful without being attributed to that stop.
  const nextSnapshot = realtimeFixture([tripUpdate('LOOP', 900, { vehicleId: 'loop-bus', stopTimeUpdates: [
    { stopId: 'C', stopSequence: 90, arrival: { time: epoch + 44440 } },
    { stopId: 'A', stopSequence: 50, arrival: { time: epoch + 44140 }, departure: { time: epoch + 44200 } },
    { stopId: 'B', stopSequence: 30, arrival: { time: epoch + 43840 }, departure: { time: epoch + 43900 } },
  ] })])
  nextSnapshot.feeds.push({ sourceUrl: vehicleSource, kind: 'vehicles', feedTimestamp: observationTime })
  nextSnapshot.vehicles = [{ id: 'loop-bus', sourceUrl: vehicleSource, timestamp: observationTime,
    tripId: 'LOOP', routeId: 'R', directionId: 0, startDate: '20260913', stopId: 'A', currentStopSequence: 10, currentStatus: 'STOPPED_AT' }]
  const nextDetail = () => vehicleDetails(context, nextSnapshot, { vehicleId: 'loop-bus' }, observationTime)
  const reports = nextSnapshot.tripUpdates[0].stopTimeUpdates
  let downstream = nextDetail()
  assert.equal(downstream.arrival.current, null)
  assert.equal(downstream.departure.current, null, 'A downstream prediction must never fill the reported stop’s missing time')
  assert.match(downstream.warnings.join(), /No prediction is supplied for this reported stop/)
  assert.deepEqual(downstream.nextPrediction, {
    stop: { id: 'B', stopId: 'B', name: 'Library' }, callIndex: 1,
    arrival: { scheduled: epoch + 43740, current: epoch + 43840 },
    departure: { scheduled: epoch + 43800, current: epoch + 43900 }, delayKind: 'arrival', delaySeconds: 100,
  }, 'Use the nearest downstream call in the timetable, not the first feed record')
  for (const relationship of ['SKIPPED', 'NO_DATA']) {
    reports[2].scheduleRelationship = relationship
    assert.equal(nextDetail().nextPrediction.callIndex, 2, `${relationship} cannot supply a downstream prediction`)
  }
  delete reports[2].scheduleRelationship
  reports.push({ ...reports[2] })
  assert.equal(nextDetail().nextPrediction.callIndex, 2, 'Duplicate reports for the nearest stop remain unresolved')
  reports.pop()
  reports[2].arrival.time = epoch + 43901
  assert.equal(nextDetail().nextPrediction.callIndex, 2, 'Contradictory arrival and departure cannot supply a downstream prediction')
  reports[2].arrival = { delay: 100 }
  assert.equal(nextDetail().nextPrediction.arrival.current, epoch + 43840, 'A stop-specific delay can resolve against its own scheduled arrival')
  reports[2].stopSequence = 50
  assert.equal(nextDetail().nextPrediction.callIndex, 2, 'Stop identity and sequence must agree')
  reports[2].stopSequence = 30
  reports[2].arrival = {}; reports[2].departure = {}
  downstream = nextDetail()
  assert.equal(downstream.nextPrediction.callIndex, 2, 'The repeated stop is resolved by its retained sequence')
  delete reports[1].stopSequence
  assert.equal(nextDetail().nextPrediction.callIndex, 3, 'An ambiguous repeated stop cannot be used as the next prediction')
  assert.equal(nextDetail().nextPrediction.departure.current, null, 'A terminal arrival does not invent a departure')
  reports[1].stopSequence = 50
  nextSnapshot.vehicles[0].currentStopSequence = 50
  assert.equal(nextDetail().nextPrediction.callIndex, 3, 'Past calls are excluded even if they have predictions')
  nextSnapshot.vehicles[0].stopId = 'C'; nextSnapshot.vehicles[0].currentStopSequence = 90
  assert.equal(nextDetail().nextPrediction, undefined, 'There is no downstream call beyond the terminal')
  nextSnapshot.vehicles[0].stopId = 'A'; nextSnapshot.vehicles[0].currentStopSequence = 10
  reports.push({ stopId: 'A', stopSequence: 10 })
  assert.match(nextDetail().warnings.join(), /No arrival or departure prediction is supplied for this reported stop/, 'A current-stop record without usable events must explain why the table shows another stop')
  assert.equal(nextDetail().nextPrediction.callIndex, 2)
  reports.at(-1).departure = { delay: 20 }
  assert.equal(nextDetail().warnings.length, 0, 'A supplied departure does not require an arrival prediction')
  reports.pop()
  reports.push({ stopId: 'A', stopSequence: 10, departure: { delay: 20 } }, { stopId: 'A', stopSequence: 10, departure: { delay: 30 } })
  assert.match(nextDetail().warnings.join(), /Multiple prediction records claim this reported stop/, 'Duplicate current-stop reports are distinguished from absent reports')
  assert.equal(nextDetail().nextPrediction.callIndex, 2, 'A duplicate current stop does not invalidate a distinct downstream call')
  reports.splice(-2)
  nextSnapshot.tripUpdates[0].timestamp = observationTime - 181
  assert.equal(nextDetail().nextPrediction, undefined, 'Stale trip reports cannot supply the next prediction')
  nextSnapshot.tripUpdates[0].timestamp = observationTime
  nextSnapshot.vehicles[0].timestamp = observationTime - 181
  assert.equal(nextDetail().nextPrediction, undefined, 'A stale position cannot establish which calls are downstream')
  nextSnapshot.vehicles[0].timestamp = observationTime
  nextSnapshot.tripUpdates[0].scheduleRelationship = 'CANCELED'
  assert.equal(nextDetail().nextPrediction, undefined)
  delete nextSnapshot.tripUpdates[0].scheduleRelationship
  nextSnapshot.tripUpdates.push({ ...nextSnapshot.tripUpdates[0], id: 'duplicate-loop-report' })
  assert.equal(nextDetail().nextPrediction, undefined, 'Ambiguous trip reports cannot supply the next prediction')
  console.log('Agency route line: bidirectional patterns, branches, loops, exact vehicle stops, separate current-stop and downstream predictions, terminal arrivals, duplicate identities, freshness and missing predictions passed.')
} finally { context?.close(); await fs.rm(directory, { recursive: true, force: true }) }
