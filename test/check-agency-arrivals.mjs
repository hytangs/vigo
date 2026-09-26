import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgencyContext } from '../src/agency/agencyContext.mjs'
import { deriveOperationalState } from '../src/agency/realtimeIntelligence.mjs'
import { createToolRegistry } from '../src/agency/toolRegistry.mjs'
import { compactResult } from '../src/agency/queryAgent.mjs'
import { stopBoard } from '../src/agency/stopBoard.mjs'
import { describeVehicleArrival } from '../src/agency/vehicleTrip.mjs'
import { createAgencyFixture, realtimeFixture, tripUpdate, observationTime } from './fixtures/agency.mjs'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agency-arrivals-'))
let context
try {
  const file = path.join(directory, 'schedule.sqlite')
  createAgencyFixture(file)
  const db = new DatabaseSync(file)
  db.exec(`INSERT INTO routes VALUES('Q','Q','Other route',3,'336699');
    INSERT INTO trips VALUES('Q1','Q','S','1');
    INSERT INTO connections VALUES(43920,44160,'Q1','Q','S','1','B','A',10);`)
  db.close()
  context = new AgencyContext(file, 'City X')
  const snapshot = realtimeFixture([tripUpdate('T1', 0, { scheduleRelationship: 'CANCELED' })])
  const state = deriveOperationalState(context, snapshot, observationTime)
  const callTool = createToolRegistry({ context, state, snapshot })
  const result = await callTool('stop_arrivals', { stopId: 'B' })
  assert.deepEqual((await callTool('stop_arrivals', { stopId: 'Library' })).data.board, result.data.board, 'An exact station name uses the same identity and board without an extra model round')
  await assert.rejects(callTool('stop_arrivals', { stopId: 'Lib' }), /exact stop/, 'A unique partial match is not silently accepted as an exact station')
  assert.deepEqual(new Set(result.data.board.rows.map(row => row.routeId)), new Set(['R', 'Q']))
  assert.equal(result.data.board.rows.find(row => row.routeId === 'R').tripId, 'T2', 'A cancelled trip cannot be the next service')
  assert.ok(result.data.board.rows.every(row => row.kind === 'departure'))
  const arrivalOnly = realtimeFixture([tripUpdate('T1', 0, { stopTimeUpdates: [{ stopId: 'B', stopSequence: 30, arrival: { delay: 120 } }] })])
  const departureRow = stopBoard(context, arrivalOnly, { stopId: 'B', event: 'departure' }, observationTime).rows.find(row => row.tripId === 'T1')
  assert.equal(departureRow.status, 'scheduled', 'An arrival prediction is not a live departure prediction')
  assert.equal(departureRow.departure.current, null)
  assert.ok(departureRow.arrival.current, 'Retain the separately reported arrival in evidence')
  assert.ok(!stopBoard(context, arrivalOnly, { stopId: 'B', event: 'departure' }, observationTime + 660).rows.some(row => row.tripId === 'T1'), 'An arrival-only report cannot move a past scheduled departure into the future')
  assert.equal(result.data.board.rows.find(row => row.routeId === 'R').departure.scheduled, observationTime + 1200)
  assert.equal((await callTool('stop_arrivals', { stopId: 'B', routeId: 'Q' })).data.board.rows.length, 1)
  assert.equal((await callTool('stop_arrivals', { stopId: 'Library', routeId: 'Other route' })).data.board.rows[0].routeId, 'Q', 'Exact route display names resolve to indexed IDs')
  assert.equal((await callTool('stop_arrivals', { stopId: 'C', routeId: 'R' })).data.board.rows.length, 0, 'Terminal arrivals must not become departures')
  await assert.rejects(callTool('stop_arrivals', { stopId: 'wrong-city::B' }), /exact stop/)
  await assert.rejects(callTool('stop_arrivals', { stopId: 'B', routeId: 'missing' }), /exact indexed route/)
  assert.throws(() => stopBoard(context, null, { stopId: 'B', windowMinutes: Infinity }), /window/)
  const afterService = observationTime + 2 * 3600
  assert.equal(stopBoard(context, null, { stopId: 'B' }, afterService).rows.length, 0)
  const tomorrow = stopBoard(context, null, { stopId: 'B', windowMinutes: 1440, event: 'departure', nextPerRoute: true }, afterService)
  assert.equal(tomorrow.rows.length, 2, 'Next-service lookup reaches across a service break')
  assert.ok(tomorrow.rows.every(row => row.serviceDate === '2026-09-14'))
  const compact = JSON.parse(compactResult(result, 'stop_arrivals'))
  assert.equal(compact.data.rows.find(row => row.route === 'R').departure.scheduled.time, '12:20')
  assert.equal(compact.data.rows.find(row => row.route === 'R').departure.predicted, null)
  assert.doesNotMatch(JSON.stringify(compact), /example.org/, 'Feed URLs stay out of model context')

  const destinationTime = observationTime + 27 * 60
  const targetUpdate = tripUpdate('T2', 0, { vehicleId: 'fleet-42', vehicleLabel: '42', stopTimeUpdates: [
    { stopId: 'B', stopSequence: 30, arrival: { delay: 60 }, departure: { delay: 60 } },
    { stopId: 'C', stopSequence: 50, arrival: { time: destinationTime } },
  ] })
  const laterAssignment = tripUpdate('T3', 0, { vehicleId: 'fleet-42', vehicleLabel: '42' })
  const fleet = realtimeFixture([tripUpdate('T1'), targetUpdate, laterAssignment])
  fleet.feeds.push({ sourceUrl: 'vehicles', kind: 'vehicles', feedTimestamp: observationTime })
  const position = { id: 'fleet-42', label: '42', sourceUrl: 'vehicles', timestamp: observationTime, tripId: 'T2', routeId: 'R', startDate: '20260913', stopId: 'B', currentStopSequence: 30, currentStatus: 'IN_TRANSIT_TO' }
  fleet.vehicles = [position]
  const vehicleBoard = (options = {}) => stopBoard(context, fleet, { stopId: 'C', vehicleId: '42', event: 'arrival', nextPerRoute: true, ...options }, observationTime)
  const target = vehicleBoard()
  assert.deepEqual(target.rows.map(row => row.tripId), ['T2'], 'Filter the current vehicle trip before next-route reduction; exclude the earlier bus and advance assignments')
  assert.equal(target.vehicle.label, '42')
  assert.equal(target.rows[0].arrival.current, destinationTime, 'Use the requested terminal prediction, not the vehicle’s current stop')
  assert.equal(target.rows[0].departure.current, null, 'Never fabricate a terminal departure')
  assert.equal(target.rows[0].arrival.scheduled, observationTime + 24 * 60)
  assert.match(describeVehicleArrival(target), /Vehicle 42 on R.*Terminal.*12:27.*27 min.*Scheduled arrival: 12:24/s)
  assert.deepEqual(vehicleBoard({ vehicleId: 'fleet-42' }).rows, target.rows, 'Public labels and internal IDs resolve to the same vehicle')


  targetUpdate.scheduleRelationship = 'CANCELED'
  assert.match(describeVehicleArrival(vehicleBoard()), /cancelled/)
  delete targetUpdate.scheduleRelationship
  targetUpdate.stopTimeUpdates[1].scheduleRelationship = 'SKIPPED'
  assert.match(describeVehicleArrival(vehicleBoard()), /skip Terminal/)
  delete targetUpdate.stopTimeUpdates[1].scheduleRelationship
  delete targetUpdate.stopTimeUpdates[1].arrival
  targetUpdate.stopTimeUpdates[1].departure = { time: destinationTime }
  assert.equal(vehicleBoard().rows[0].arrival.current, null)
  assert.match(describeVehicleArrival(vehicleBoard()), /no reported arrival prediction/, 'A departure is not an arrival ETA')
  delete targetUpdate.stopTimeUpdates[1].departure
  targetUpdate.stopTimeUpdates[1].arrival = { time: destinationTime }
  targetUpdate.vehicleId = 'different-bus'
  assert.equal(vehicleBoard().rows[0].status, 'unresolved')
  assert.equal(vehicleBoard().rows[0].arrival.current, null, 'Conflicting vehicle assignments cannot supply an ETA')
  targetUpdate.vehicleId = 'fleet-42'
  targetUpdate.timestamp = observationTime - 181
  assert.match(describeVehicleArrival(vehicleBoard()), /no fresh arrival prediction/)
  targetUpdate.timestamp = observationTime
  fleet.vehicles.push({ ...position, id: 'other-42' })
  assert.match(vehicleBoard().vehicle.issue, /More than one/)
  fleet.vehicles.pop()
  assert.match(vehicleBoard({ vehicleId: 'unknown' }).vehicle.issue, /not identified/)
  assert.match(vehicleBoard({ routeId: 'Q' }).vehicle.issue, /not currently reported/)
  assert.equal(vehicleBoard({ stopId: 'A' }).rows.length, 0, 'A fresh position past the requested call suppresses its old ETA')
  position.stopId = 'C'; position.currentStopSequence = 50; position.currentStatus = 'STOPPED_AT'
  assert.match(describeVehicleArrival(vehicleBoard()), /reported at Terminal now/)
  fleet.vehicles = []
  assert.match(vehicleBoard().vehicle.issue, /More than one/, 'No position means advance assignments cannot be chosen as the current trip')
  fleet.tripUpdates.pop()
  assert.equal(vehicleBoard().rows[0].arrival.current, destinationTime, 'A single exact fresh TripUpdate works without GPS')
  targetUpdate.timestamp = observationTime - 181
  assert.match(vehicleBoard().vehicle.issue, /out of date/)

} finally { context?.close(); await fs.rm(directory, { recursive: true, force: true }) }
console.log('Agency arrivals: shared station board, exact route scope, cancellations, departure semantics, overnight next service and fleet-board computation passed.')
