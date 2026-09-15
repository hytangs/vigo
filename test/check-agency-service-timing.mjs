import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgencyContext } from '../src/agency/agencyContext.mjs'
import { deriveOperationalState } from '../src/agency/realtimeIntelligence.mjs'
import { createToolRegistry } from '../src/agency/toolRegistry.mjs'
import { serviceTiming } from '../src/agency/serviceTiming.mjs'
import { queryAgency } from '../src/agency/queryAgent.mjs'
import { normalizeArguments, validateArguments } from '../src/agency/toolArguments.mjs'
import { publicReply } from '../src/agency/publicReply.mjs'
import { createAgencyFixture, realtimeFixture, tripUpdate, observationTime } from './fixtures/agency.mjs'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agency-service-timing-'))
let context
try {
  const file = path.join(directory, 'schedule.sqlite')
  createAgencyFixture(file)
  const db = new DatabaseSync(file)
  db.exec(`INSERT INTO trips VALUES('BACK','R','S','1'),('SHORT','R','S','1');
    INSERT INTO connections VALUES
    (43920,44520,'BACK','R','S','1','C','B',10),(44520,45120,'BACK','R','S','1','B','A',20),
    (44400,44700,'SHORT','R','S','1','B','A',10);`)
  db.close()
  context = new AgencyContext(file, 'City X')
  const now = observationTime + 900
  const update = tripUpdate('T1', 0, { vehicleId: 'fleet-42', vehicleLabel: '42', timestamp: now, stopTimeUpdates: [
    { stopId: 'A', stopSequence: 10, departure: { time: observationTime + 360 } },
    { stopId: 'C', stopSequence: 50, arrival: { time: observationTime + 1020 } },
  ] })
  const snapshot = realtimeFixture([update, tripUpdate('T3', 0, { timestamp: now, vehicleId: 'fleet-42' })])
  snapshot.feeds[0].feedTimestamp = now
  snapshot.feeds.push({ kind: 'vehicles', sourceUrl: 'vehicles', feedTimestamp: now })
  const position = { id: 'fleet-42', label: '42', sourceUrl: 'vehicles', timestamp: now, tripId: 'T1', routeId: 'R', startDate: '20260913', stopId: 'B', currentStopSequence: 30, currentStatus: 'INCOMING_AT' }
  snapshot.vehicles = [position, { ...position, id: 'fleet-84', label: '84', tripId: 'T2' }, { ...position, id: 'old', tripId: 'T3', timestamp: now - 181 }]
  const state = deriveOperationalState(context, snapshot, now)
  state.tripHistory = { 'T1/2026-09-13': [{ at: new Date((observationTime + 240) * 1000).toISOString(), stopId: 'A', delaySeconds: 60 }] }
  const check = args => serviceTiming(context, snapshot, state, args, now)
  const fleet = check({ view: 'vehicles', routeId: 'River service' })
  assert.deepEqual(fleet.vehicles.map(vehicle => vehicle.id), ['fleet-42', 'fleet-84'])
  assert.equal(fleet.rows[0]['reported stop'], 'Library')
  assert.equal(fleet.rows[1]['schedule comparison'], 'No comparison', 'An absent prediction is not on time')
  assert.match(fleet.summary, /2 vehicles.*fresh location/)
  snapshot.vehicles.push({ ...position, sourceUrl: 'duplicate' }); snapshot.feeds.push({ kind: 'vehicles', sourceUrl: 'duplicate', feedTimestamp: now })
  assert.equal(check({ view: 'vehicles', routeId: 'R' }).vehicles.length, 1, 'Conflicting source identities do not inflate the fleet count')
  snapshot.vehicles.pop(); snapshot.feeds.pop()

  const trip = check({ view: 'trip', vehicleId: '42', routeId: 'R' })
  assert.equal(trip.terminals.departure.station, 'River', 'The trip origin, not the currently selected terminal, supplies the departure')
  assert.equal(trip.terminals.departure.scheduled, observationTime + 300)
  assert.equal(trip.terminals.departure.predicted, observationTime + 360)
  assert.equal(trip.terminals.departure.actual, null, 'A prediction in the past is not a measured departure')
  assert.equal(trip.terminals.retainedDeparture.predicted, observationTime + 360)
  assert.match(trip.summary, /was scheduled to leave River.*actual departure time is not recorded/)
  assert.doesNotMatch(trip.summary, /will arrive|upcoming time/)
  update.scheduleRelationship = 'CANCELED'
  assert.match(check({ view: 'trip', vehicleId: '42' }).summary, /cancelled/)
  delete update.scheduleRelationship
  delete update.stopTimeUpdates[0].departure
  assert.equal(check({ view: 'trip', vehicleId: '42' }).terminals.departure.predicted, null)
  assert.match(check({ view: 'trip', vehicleId: 'missing' }).summary, /not identified/)
  const cycle = check({ view: 'cycle', routeId: 'R' })
  assert.equal(cycle.roundTrips.length, 1, 'Unmatched short-turn terminals do not supply a return leg')
  assert.deepEqual(cycle.roundTrips[0].seconds, { min: 29 * 60, max: 29 * 60 })
  assert.match(cycle.summary, /29 min.*excluding terminal layovers/)
  assert.match(cycle.summary, /Current full-cycle time is not verified/)
  assert.match(cycle.summary, /headway is the spacing/)
  const noReturn = serviceTiming(context, snapshot, state, { view: 'cycle', routeId: 'R' }, observationTime + 7200)
  assert.equal(noReturn.roundTrips.length, 0)
  assert.match(noReturn.summary, /does not supply both sides/)

  const callTool = createToolRegistry({ context, snapshot, state })
  for (const [question, args, expected] of [
    ['Which buses are on R now?', { view: 'vehicles', routeId: 'R' }, /2 vehicles/],
    ['When did vehicle 42 leave its terminal?', { view: 'trip', vehicleId: '42' }, /actual departure time is not recorded/],
    ['How long is a full cycle on R now?', { view: 'cycle', routeId: 'R' }, /29 min.*excluding terminal layovers/],
  ]) {
    let calls = 0
    const result = await queryAgency({ question, context, state, callTool, provider: { available: true, model: 'fixture', complete: async (_messages, tools) => {
      assert.equal(++calls, 1, 'Completed service timing is rendered without a model rewrite')
      assert.ok(tools.some(tool => tool.name === 'service_timing'))
      return { tool_calls: [{ id: 'timing', function: { name: 'service_timing', arguments: JSON.stringify({ ...args, resultUse: 'answer' }) } }] }
    } } })
    assert.match(result.answer, expected); assert.equal(result.aiGenerated, false); assert.equal(result.warnings.length, 0)
  }
  const numeric = { type: 'object', properties: { horizonMinutes: { type: 'integer', minimum: 1, maximum: 120 }, vehicleId: { type: 'string' } }, required: ['horizonMinutes'] }
  assert.deepEqual(normalizeArguments({ horizonMinutes: '60', vehicleId: '0042' }, numeric), { horizonMinutes: 60, vehicleId: '0042' })
  for (const value of ['60 minutes', '2.5', '121', 'Infinity', '1e999', '']) assert.throws(() => validateArguments(normalizeArguments({ horizonMinutes: value }, numeric), numeric))
  assert.throws(() => validateArguments(normalizeArguments({ horizonMinutes: '60', unexpected: true }, numeric), numeric), /Unknown/)
  for (const content of ['private draft</think>Public answer.', '<think>private draft</think>Public answer.', 'private draft</THINK >Public answer.', '<think>unfinished']) {
    assert.doesNotMatch(publicReply(content), /private|think|unfinished/)
  }
  assert.equal(publicReply('private draft</think>Public answer.'), 'Public answer.')
  let round = 0
  const normalized = await queryAgency({ question: 'Check R for an hour', context, state, callTool: async (name, args) => {
    assert.equal(name, 'inspect_service'); assert.equal(args.horizonMinutes, 60)
    return { ok: true, data: { aspect: 'outlook' }, generatedAt: state.generatedAt, warnings: [], provenance: [] }
  }, history: [{ question: 'Earlier', answer: 'private draft</think>Prior public answer.' }], provider: { available: true, complete: async messages => {
    assert.doesNotMatch(JSON.stringify(messages), /private draft/)
    return ++round === 1 ? { tool_calls: [{ id: 'scope', function: { name: 'inspect_service', arguments: JSON.stringify({ scope: 'routes', routeNames: ['R'], horizonMinutes: '60' }) } }] } : { content: 'private draft</think>Public answer.' }
  } } })
  assert.equal(normalized.answer, 'Public answer.'); assert.equal(normalized.warnings.length, 0)
} finally { context?.close(); await fs.rm(directory, { recursive: true, force: true }) }
console.log('Service timing: distinct fresh vehicles, past terminal evidence, out-and-back running time vs headway, direct rendering, numeric argument repair and reasoning boundaries passed.')
