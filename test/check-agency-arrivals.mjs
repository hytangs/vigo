import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgencyContext } from '../src/agency/agencyContext.mjs'
import { deriveOperationalState } from '../src/agency/realtimeIntelligence.mjs'
import { createToolRegistry } from '../src/agency/toolRegistry.mjs'
import { queryAgency, compactResult } from '../src/agency/queryAgent.mjs'
import { stopBoard } from '../src/agency/stopBoard.mjs'
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

  let modelCalls = 0
  const answer = await queryAgency({ question: 'Next departure from Library for each route', context, state, callTool,
    selection: { route: { id: 'R', name: 'R' } }, provider: { available: true, model: 'fixture', complete: async (_messages, tools) => {
      assert.equal(++modelCalls, 1, 'A completed board is displayed without another model rewrite')
      assert.ok(tools.some(tool => tool.name === 'stop_arrivals'), 'The board is available without discovery overhead')
      return { tool_calls: [{ id: 'arrivals', function: { name: 'stop_arrivals', arguments: JSON.stringify({ stopId: 'B', resultUse: 'answer' }) } }] }
    } },
  })
  assert.equal(answer.aiGenerated, false)
  assert.match(answer.answer, /each route and direction at Library/)
  assert.deepEqual(answer.citations, [1])
  assert.deepEqual(new Set(answer.trace[0].result.data.board.rows.map(row => row.routeId)), new Set(['R', 'Q']), 'Explicit all-route station queries remain independent of the route selected on the map')
  let round = 0
  const rewritten = await queryAgency({ question: 'Next departures at Library', context, state, callTool,
    provider: { available: true, complete: async () => ++round === 1
      ? { tool_calls: [{ id: 'board', function: { name: 'stop_arrivals', arguments: JSON.stringify({ stopId: 'Library', resultUse: 'continue' }) } }] }
      : { content: 'Only R is running; the next bus is in one minute.' } },
  })
  assert.equal(rewritten.aiGenerated, false)
  assert.match(rewritten.answer, /each route and direction at Library/)
  assert.doesNotMatch(rewritten.answer, /one minute|Only R/, 'A model rewrite cannot replace a complete station board with an incomplete or invented time list')
} finally { context?.close(); await fs.rm(directory, { recursive: true, force: true }) }
console.log('Agency arrivals: shared station board, exact route scope, cancellations, departure semantics, overnight next service and one-call display passed.')
