import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgencyContext } from '../src/agency/agencyContext.mjs'
import { intelligenceScenario } from './fixtures/intelligence/scenario.mjs'
import { createToolRegistry } from '../src/agency/toolRegistry.mjs'
import { compactResult, queryAgency } from '../src/agency/queryAgent.mjs'
import { operationalDataContext } from '../src/agency/queryPrompt.mjs'
import { inspectionFacts } from '../src/agency/serviceInspection.mjs'
import { deriveOperationalState } from '../src/agency/realtimeIntelligence.mjs'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agency-intelligence-'))
const f = intelligenceScenario(directory)
try {
  const call = createToolRegistry({ ...f, adapters: {} })
  const whole = (await call('inspect_service', {})).data
  assert.equal(whole.scope.allNetwork, true)
  assert.equal(whole.totalRoutes, 7)
  assert.ok(whole.routes.some(row => row.route === '66' && row.cancelledTrips === 1))
  assert.ok(whole.routes.some(row => row.route === 'Red Line' && row.laterTrips === 0))
  assert.ok(whole.concentrations.some(row => row.routes.length > 1))
  assert.ok(whole.vehicles.some(row => row.occupancy === 'FULL' && row.route === '66'))
  assert.ok(whole.intervals.some(row => row.predictedMinutes > row.scheduledMinutes), 'Gap evidence remains visible')
  assert.ok(whole.intervals.some(row => row.predictedMinutes < row.scheduledMinutes), 'Close spacing is not crowded out by the gap examples')
  assert.ok(whole.totalIntervalPairs >= whole.intervals.length)
  assert.deepEqual(inspectionFacts(whole).servicePattern.routesWhoseReportingTripsMatchSchedule.sort(), ['1', '9', 'Red Line'])
  assert.deepEqual(inspectionFacts(whole).servicePattern.routesWithLatePredictions.sort(), ['39', '55', '57', '66'])
  assert.ok(whole.outlook[2].withoutMatchedReport > whole.outlook[0].withoutMatchedReport)
  assert.match(whole.limits.join(' '), /not missing vehicles/)
  const route = (await call('inspect_service', { routeNames: ['66'] })).data
  assert.deepEqual(route.routes.map(row => row.id), ['66'])
  assert.equal(route.notices.length, 0, 'Construction on another route cannot be assigned to this one')
  assert.deepEqual((await call('inspect_service', { routeIds: ['66'] })).data, route)
  assert.deepEqual((await call('inspect_service', { routeNames: ['Route 66'] })).data, route, 'An exact typed route label does not need another model lookup')
  assert.equal(f.context.resolve({ kind: 'route', query: 'Synthetic service 66' }).method, 'exact', 'Full indexed route names are exact aliases too')
  const collisionFile = path.join(directory, 'duplicate-route-label.sqlite')
  await fs.copyFile(f.context.storePath, collisionFile)
  const collisionDb = new DatabaseSync(collisionFile)
  collisionDb.prepare('INSERT INTO routes VALUES(?,?,?,?,?)').run('other-66', '66', 'Another agency route', 3, '557755')
  collisionDb.close()
  const collisionContext = new AgencyContext(collisionFile, 'Label collision')
  try {
    assert.equal(collisionContext.resolve({ kind: 'route', query: 'Route 66' }).ambiguous, true)
    await assert.rejects(createToolRegistry({ ...f, context: collisionContext, adapters: {} })('inspect_service', { routeNames: ['Route 66'] }), /exact route/, 'Shared route labels require an exact identity rather than first-match selection')
  } finally { collisionContext.close() }
  const vehicle = (await call('inspect_service', { vehicleId: '1827' })).data
  assert.equal(vehicle.totalReportingTrips, 1)
  assert.equal(vehicle.trips[0].vehicleId, '1827')
  assert.equal(vehicle.trips[0].delayMinutes, 20)
  assert.equal(vehicle.progression.totalTrips, 1, 'A vehicle investigation does not substitute every trip on its route')
  assert.deepEqual(vehicle.trips[0].retainedReports.map(row => row.delayMinutes), [10, 15, 20])
  assert.ok(vehicle.trips[0].retainedReports.every(row => row.stop === 'Harvard Square'))
  assert.match(vehicle.notices[0].periodMeaning, /not incident onset or a recovery promise/)
  const unknownVehicle = (await call('inspect_service', { vehicleId: 'unknown' })).data
  assert.equal(unknownVehicle.totalReportingTrips, 0)
  assert.equal(unknownVehicle.concentrations.length, 0, 'An unidentified vehicle does not acquire unrelated network clusters')
  assert.equal(inspectionFacts(unknownVehicle).facts.length, 0, 'An unidentified vehicle does not inherit the network totals as its own evidence')
  const noRedReports = { ...f.snapshot, tripUpdates: f.snapshot.tripUpdates.filter(row => row.routeId !== 'Red'), vehicles: f.snapshot.vehicles.filter(row => row.routeId !== 'Red') }
  const noRedState = deriveOperationalState(f.context, noRedReports, Date.parse(f.state.generatedAt) / 1000)
  const allNotices = (await createToolRegistry({ ...f, state: noRedState, snapshot: noRedReports, adapters: {} })('inspect_service', {})).data
  assert.ok(allNotices.notices.some(row => row.title.includes('elevator')), 'All-network investigation retains alerts on routes without trip reports')
  const noticeCheck = (await createToolRegistry({ ...f, state: noRedState, snapshot: noRedReports, adapters: {} })('inspect_service', { aspect: 'alerts' })).data
  assert.equal(noticeCheck.otherNotices, 1, 'An explicit network alert check also includes routes without reporting trips')
  const relatedNotices = (await call('inspect_service', { routeIds: ['39'], stopIds: ['C'], aspect: 'alerts' })).data
  assert.deepEqual(relatedNotices.notices[0].stops, [{ id: 'B', name: 'Huntington Avenue' }], 'A broader route notice retains its actual station rather than acquiring the selected one')
  assert.deepEqual(relatedNotices.scope.stopIds, ['C'])
  const duplicateIntervals = { ...f.state, measurements: { ...f.state.measurements, intervals: [...f.state.measurements.intervals, ...f.state.measurements.intervals] } }
  const samePairs = (await createToolRegistry({ ...f, state: duplicateIntervals, adapters: {} })('inspect_service', {})).data
  assert.deepEqual(samePairs.intervals, whole.intervals, 'Repeated records at the same stop cannot inflate the spatial extent of a pair')
  await assert.rejects(call('inspect_service', { routeIds: ['another-city::66'] }), /exact route/)
  await assert.rejects(call('inspect_service', { routeIds: ['1827'] }), error => error.details.nextStep.includes('scope=vehicle'), 'A wrong entity type receives an evidence-based correction, not a guessed identity')
  await assert.rejects(call('inspect_service', { stopIds: ['Harvard'] }), /exact stop/)
  await assert.rejects(call('inspect_service', { horizonMinutes: 121 }), /Out-of-range/)
  const local = (await call('inspect_service', { stopIds: ['Harvard Square'] })).data
  assert.ok(local.trips.every(row => row.stop === 'Harvard Square' || row.stop === 'Huntington Avenue'))
  assert.ok(local.notices.some(row => row.effect === 'SIGNIFICANT_DELAYS'))
  const progression = (await call('inspect_service', { routeIds: ['39'], aspect: 'prediction_progression' })).data
  assert.ok(progression.totalTrips > 0, 'Route-wide progression does not require a separately selected stop')
  assert.match(progression.limit, /not an observed/)
  const currentTime = Date.parse(f.state.generatedAt)
  const historyKey = '39-0/2026-09-14'
  const changedHistory = { ...f.state, tripHistory: { ...f.state.tripHistory, [historyKey]: [
    { ...f.state.tripHistory[historyKey][0], at: new Date(currentTime - (f.state.policy.historyMinutes + 1) * 60_000).toISOString() },
    { ...f.state.tripHistory[historyKey][0], at: new Date(currentTime + 60_000).toISOString() },
    ...f.state.tripHistory[historyKey],
  ] } }
  const boundedHistory = (await createToolRegistry({ ...f, state: changedHistory, adapters: {} })('inspect_service', { vehicleId: '1827', stopIds: ['C'], aspect: 'prediction_progression' })).data
  assert.equal(boundedHistory.trips[0].distinctObservationTimes, 3, 'A history check excludes future and expired observations')
  assert.equal(boundedHistory.trips[0].firstRetainedReport, f.state.tripHistory[historyKey][0].at)
  const compact = compactResult(await call('inspect_service', { vehicleId: '1827' }), 'inspect_service')
  assert.doesNotMatch(compact, /https:\/\/example.org/)
  assert.ok(compact.includes('20') && compact.includes('Harvard Square'))
  const raw = await call('realtime_status', { vehicleId: '1827' })
  assert.equal(JSON.parse(compactResult(raw, 'realtime_status')).data.trips[0].vehicleId, '1827', 'Vehicle-level reports survive model compaction')
  const stale = { ...f.snapshot, feeds: f.snapshot.feeds.map(feed => ({ ...feed, feedTimestamp: feed.feedTimestamp - 600 })) }
  const state = deriveOperationalState(f.context, stale, Date.parse(f.state.generatedAt) / 1000)
  const unavailable = (await createToolRegistry({ ...f, state, snapshot: stale, adapters: {} })('inspect_service', {})).data
  assert.equal(unavailable.totalReportingTrips, 0)
  assert.equal(unavailable.vehicles.length, 0)
  assert.ok(unavailable.coverage.feeds.every(feed => feed.status === 'stale'))
  assert.ok(operationalDataContext(state).notConnectedToAsk.some(item => item.includes('Crew')))
  const duplicate = { ...f.snapshot, vehicles: [...f.snapshot.vehicles, { ...f.snapshot.vehicles.find(row => row.id === '1827'), sourceUrl: 'https://example.org/other-operator' }] }
  await assert.rejects(createToolRegistry({ ...f, snapshot: duplicate, adapters: {} })('inspect_service', { vehicleId: '1827' }), /more than one/)
  let modelCalls = 0
  const response = await queryAgency({ ...f, question: 'Explain the condition of the whole network.', callTool: call, placesAvailable: false,
    provider: { available: true, complete: async (_messages, tools) => ++modelCalls === 1
      ? (assert.ok(tools.some(tool => tool.name === 'inspect_service')), { tool_calls: [{ id: 'diagnosis', function: { name: 'inspect_service', arguments: '{}' } }] })
      : { content: 'The selected route is not the full network; Route 66 has a reported cancellation. [1]' } } })
  assert.equal(response.trace[0].result.data.scope.allNetwork, true)
  assert.deepEqual(response.citations, [1])
  let selectionReads = 0
  const selectedBoard = await queryAgency({ ...f, question: 'Next departure here for every route.', callTool: call, placesAvailable: false,
    provider: { available: true, complete: async messages => {
      if (++selectionReads === 1) return { tool_calls: [{ id: 'where', function: { name: 'workspace_selection', arguments: '{}' } }] }
      const result = messages.findLast(message => message.role === 'tool').content
      const selected = JSON.parse(result.slice(result.indexOf('\n') + 1)).data.selection
      assert.equal(selected.stop.id, 'C')
      assert.deepEqual(selected.stop.coordinate, f.selection.stop.coordinate)
      return { tool_calls: [{ id: 'here-board', function: { name: 'stop_arrivals', arguments: JSON.stringify({ stopId: selected.stop.id, resultUse: 'answer' }) } }] }
    } } })
  assert.equal(selectedBoard.trace[1].arguments.routeId, undefined, 'A station reference does not inherit a route filter')
  assert.equal(new Set(selectedBoard.trace[1].result.data.board.rows.map(row => row.routeId)).size, 7)
  let framedCalls = 0
  const framed = await queryAgency({ ...f, question: 'What needs attention across the network?', callTool: call, placesAvailable: false,
    provider: { available: true, complete: async (_messages, tools) => ++framedCalls === 1
      ? (assert.ok(tools.find(tool => tool.name === 'inspect_service').parameters.anyOf.some(branch => branch.properties.scope.enum[0] === 'vehicle' && !branch.properties.routeNames)),
        { tool_calls: [{ id: 'scope', function: { name: 'inspect_service', arguments: '{"scope":"network"}' } }] })
      : (assert.deepEqual(tools.map(tool => tool.name), ['prepare_tools']), { content: 'Four routes have late predictions; Route 66 also has a reported cancellation. [1]' }) } })
  assert.equal(framed.trace[0].result.data.scope.allNetwork, true, 'A network choice does not inherit the selected route')
  let followup = 0
  const continued = await queryAgency({ ...f, question: 'Inspect this route and compare its history.', callTool: call, placesAvailable: false,
    provider: { available: true, complete: async () => [
      { tool_calls: [{ id: 'current', function: { name: 'inspect_service', arguments: '{"scope":"selected_route"}' } }] },
      { tool_calls: [{ id: 'prepare', function: { name: 'prepare_tools', arguments: '{"names":["historical_baseline"]}' } }] },
      { tool_calls: [{ id: 'history', function: { name: 'historical_baseline', arguments: '{"routeId":"39"}' } }] },
      { content: 'Current predictions show delay. No comparable historical service days are retained. [1] [2]' },
    ][followup++] } })
  assert.deepEqual(continued.trace.map(call => call.tool), ['inspect_service', 'historical_baseline'])
  assert.equal(continued.trace[1].result.data.serviceDays, 0)
  let followupReads = 0
  const priorFinding = { tool: 'inspect_service', arguments: { routeNames: ['66'] }, result: await call('inspect_service', { routeNames: ['66'] }) }
  await queryAgency({ ...f, question: 'Compare that earlier Route 66 finding with now.', callTool: call, placesAvailable: false,
    history: [{ question: 'Inspect Route 66.', answer: 'Earlier assessment.', observedAt: f.state.generatedAt, findings: [priorFinding], requests: [{ tool: priorFinding.tool, arguments: priorFinding.arguments }] }],
    provider: { available: true, complete: async messages => {
      if (++followupReads === 1) return { tool_calls: [{ id: 'current-66', function: { name: 'inspect_service', arguments: '{"scope":"routes","routeNames":["66"]}' } }] }
      const previous = JSON.parse(messages[1].content).history[0]
      assert.equal(previous.savedAt, f.state.generatedAt)
      assert.deepEqual(previous.priorFindings[0].arguments, { routeNames: ['66'] })
      assert.deepEqual(previous.priorFindings[0].result.data.servicePattern.reportedCancellations, [{ route: '66', trips: 1 }], 'Composition retains dated checked facts, not just previous model prose')
      return { content: 'Both records describe the same observation; this is not evidence of persistence. [1]' }
    } } })
  let repeatedCalls = 0, executed = 0
  const repeated = await queryAgency({ ...f, question: 'Assess the network and give the supported next step.', placesAvailable: false,
    callTool: async (...args) => { executed++; return call(...args) },
    provider: { available: true, complete: async (_messages, tools) => ++repeatedCalls < 3
      ? { tool_calls: [{ id: `same-${repeatedCalls}`, function: { name: 'inspect_service', arguments: '{"scope":"network"}' } }] }
      : (assert.equal(tools.length, 0, 'An identical observation read ends the loop with evidence-based composition'), { content: 'Route 66 has a cancellation and wider spacing. Verify replacement coverage. [1]' }) } })
  assert.equal(executed, 1)
  assert.equal(repeated.trace.length, 1, 'Reusing a source does not invent a second check or citation')
  assert.deepEqual(repeated.citations, [1])
  let filteredCalls = 0
  await queryAgency({ ...f, question: 'Inspect service and look for a crash notice.', callTool: call, placesAvailable: false,
    provider: { available: true, complete: async messages => {
      filteredCalls++
      if (filteredCalls === 1) return { tool_calls: [{ id: 'current-scope', function: { name: 'inspect_service', arguments: '{"scope":"network"}' } }] }
      if (filteredCalls === 2) return { tool_calls: [{ id: 'load-notices', function: { name: 'prepare_tools', arguments: '{"names":["service_alerts"]}' } }] }
      if (filteredCalls === 3) return { tool_calls: [{ id: 'find-notice', function: { name: 'service_alerts', arguments: '{"search":"crash","routeNames":["39"]}' } }] }
      const evidence = JSON.parse(messages[1].content).evidence
      assert.equal(evidence[1].arguments.search, 'crash', 'The composition stage must retain filters so an empty search is not all alerts')
      assert.deepEqual(evidence[1].arguments.routeNames, ['39'])
      return { content: 'No notice matched the crash search on Route 39. That does not exclude an incident. [2]' }
    } } })
  const questions = JSON.parse(await fs.readFile(new URL('./fixtures/intelligence/questions.json', import.meta.url), 'utf8'))
  assert.equal(questions.length, 32)
  assert.equal(new Set(questions.map(row => row.id)).size, 32)
  const criteria = JSON.parse(await fs.readFile(new URL('./fixtures/intelligence/review-criteria.json', import.meta.url), 'utf8'))
  assert.deepEqual(criteria.cases.map(row => row.id), questions.map(row => row.id))
} finally { f.close(); await fs.rm(directory, { recursive: true, force: true }) }
console.log('Agency intelligence: shared multi-route diagnosis, vehicle history, scope, cancellation, occupancy, bounded outlook, freshness, privacy and 32-question corpus integrity passed (model answer quality is evaluated separately).')
