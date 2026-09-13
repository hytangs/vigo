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
  console.log('Agency route line: bidirectional patterns, branches, loops, exact vehicle stops, separate schedule/current arrival and departure, terminal arrivals, duplicate identities, freshness and missing predictions passed.')
} finally { context?.close(); await fs.rm(directory, { recursive: true, force: true }) }
