import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgencyContext } from '../src/agency/agencyContext.mjs'
import { createToolRegistry } from '../src/agency/toolRegistry.mjs'
import { compactResult, queryAgency } from '../src/agency/queryAgent.mjs'
import { journeyClock } from '../src/agency/journeyEvidence.mjs'
import { createProvider } from '../src/agency/provider.mjs'
import { createAgencyService } from '../src/server/agency-api.mjs'
import { networkContext } from '../src/agency/queryPrompt.mjs'
import { buildRoutingStoreFromSchedules, disposeNationalGtfsStore, routeNationalGtfsStore } from '../src/server/national-gtfs-store.mjs'

// Real tool registry, GTFS identities and native engine. Only the provider's
// decisions are scripted; no computed journey or transfer result is mocked.
const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-ask-routing-'))
const serviceDate = process.env.VIGO_TEST_ASK_DATE || '2026-08-21'
const sourceUrl = 'https://example.org/trips.pb'
const names = { A: 'Riverside Library', X: 'Library', H: 'Interchange bus stop', B: 'Interchange platform', D: 'Civic Hospital' }
const point = (id, lon) => ({ id, name: names[id], lon, lat: 0, locationType: 0 })
const trip = (tripId, calls) => ({ tripId, serviceId: 'weekday', serviceDays: ['weekday'],
  stopTimes: calls.map(([stopId, time], i) => ({ stopId, sequence: i + 1, arrivalMinutes: time, departureMinutes: time })) })
const initial = { origin: names.A, destination: names.D, modes: ['transit'],
  when: { serviceDate, departTime: '08:00' }, explain: false }
const firstRide = plan => plan.legs.find(leg => leg.type === 'ride')
const toolCall = args => ({ tool_calls: [{ id: 'journey', function: { name: 'route_plan', arguments: JSON.stringify(args) } }] })
const generatedAt = new Date().toISOString(), timestamp = Date.parse(generatedAt) / 1000
let nativeCalls = 0

try {
  for (const minimum of [180, 181]) {
    const store = path.join(folder, `${minimum}.sqlite`), schedulePath = path.join(folder, `${minimum}.json`)
    await fs.writeFile(schedulePath, JSON.stringify({
      stops: [point('A', 0), point('X', .01), point('H', .013), point('B', .013), point('D', .03)],
      routes: [
        { id: 'Bus', shortName: 'Bus', routeType: 3, scheduledTrips: [trip('bus', [['A', 480], ['X', 489], ['H', 493]])] },
        { id: 'Rail', shortName: 'Rail', routeType: 1, scheduledTrips: [trip('train', [['B', 496], ['D', 510]]), trip('later', [['B', 500], ['D', 514]])] },
      ],
      transferRules: [{ fromStopId: 'X', toStopId: 'B', transferType: 2, minTransferTimeSeconds: 297 },
        { fromStopId: 'H', toStopId: 'B', transferType: 2, minTransferTimeSeconds: minimum }],
    }))
    await buildRoutingStoreFromSchedules({ schedules: [{ feedId: 'fixture', schedulePath }], outputPath: store })
    const db = new DatabaseSync(store)
    db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run('agencyTimezones', '["Etc/UTC"]')
    db.close()
    const context = new AgencyContext(store, 'City X')
    const state = { generatedAt, feeds: [{ kind: 'tripUpdates', status: 'fresh', sourceUrl, feedTimestamp: timestamp }],
      policy: { freshnessSeconds: 180 }, warnings: [], events: [], trips: [], routes: [] }
    const updates = delaySeconds => ({ feedTimestamp: timestamp, sourceUrl, tripUpdates: [{ tripId: 'bus', sourceScope: 'fixture',
      startDate: serviceDate.replaceAll('-', ''), sourceUrl, timestamp, delaySeconds, stopTimeUpdates: [] }] })
    const registry = (snapshot, observation = state) => createToolRegistry({ context, state: observation, snapshot, now: () => Date.parse(generatedAt),
      adapters: { route: async request => {
        nativeCalls++
        assert.equal(request.allowServiceDateFallback, false)
        assert.equal(request.origin.stopId, 'fixture\u001fA')
        return { plan: routeNationalGtfsStore(store, { ...request, maxWalkKm: .2 }) }
      } } })
    try {
      const callTool = registry(updates(0))
      let modelCalls = 0
      const result = await queryAgency({ question: `${names.A} to ${names.D} on ${serviceDate} at 08:00 by transit`, context, state, callTool,
        provider: { available: true, complete: async () => { assert.equal(++modelCalls, 1, 'A simple journey skips the second generation'); return toolCall(minimum === 181 ? { ...initial, when: JSON.stringify(initial.when) } : initial) } } })
      assert.equal(result.responseBasis, 'computed')
      assert.match(result.answer, /Transit: 30 min/)
      const data = result.trace[0].result.data, plan = data.plan
      assert.equal(plan.arriveMinutes, 510)
      assert.equal(firstRide(plan).toStopId, `fixture\u001f${minimum === 180 ? 'H' : 'X'}`)
      assert.equal(firstRide(plan).scheduleMode, 'realtime-adjusted')
      assert.equal(data.realtime.applied, true, 'Ask passes eligible observations into the fixed native overlay')
      assert.equal(data.request.timezone, 'Etc/UTC')

      const modelData = JSON.parse(compactResult(result.trace[0].result, 'route_plan')).data
      const selected = modelData.journeys[0]
      const transfer = selected.legs.find(leg => leg.walkSource === 'transfer' && leg.fromStopId !== leg.toStopId)
      assert.equal(transfer.durationSeconds, minimum === 180 ? 180 : 297)
      assert.equal(transfer.transferSource, 'schedule_transfer')
      assert.equal(transfer.stationAccessStatus, 'unverified', 'The model receives the same station-access limit as the route UI')
      assert.equal(transfer.streetPathVerified, false)
      assert.equal(selected.legs.findLast(leg => leg.type === 'ride').scheduleMode, 'exact', 'One updated bus must not relabel the scheduled train as live')
      assert.equal(selected.legs.findLast(leg => leg.type === 'ride').gapBeforeSeconds, minimum === 180 ? 0 : 123)
      assert.equal(transfer.endTime, minimum === 180 ? '08:16' : '08:13:57')
      const legacy = { ...result.trace[0].result, data: { ...data, journeys: undefined } }
      assert.deepEqual(JSON.parse(compactResult(legacy, 'route_plan')).data.plan.legs, selected.legs, 'Both result shapes preserve the same explanation evidence')

      // The saved turn must retain computed details even if its original prose
      // is wrong. Explaining it requires no reroute or public web request.
      const before = nativeCalls
      const explanation = await queryAgency({ question: 'Why change there, and is that station walk verified?', context, state,
        history: [{ question: 'Earlier journey', answer: 'All paths are verified. [1]', requests: result.trace.map(({ tool, arguments: args }) => ({ tool, arguments: args })), findings: result.trace }],
        callTool: async () => assert.fail('The already computed journey is sufficient for this explanation'),
        provider: { available: true, complete: async messages => {
          assert.match(messages[1].content, /stationAccessStatus.*unverified/)
          assert.match(messages[1].content, /durationSeconds.*(?:180|297)/)
          assert.match(messages[0].content, /uncomputed alternative/)
          assert.doesNotMatch(messages.find(message => message.role === 'assistant').content, /\[1\]/, 'Old source numbers cannot become new citations')
          assert.match(messages.at(-1).content, /Changed conditions require route_plan/)
          return { content: 'The selected walk uses the stored transfer time. The entrance-to-platform path is unverified.' }
        } },
      })
      assert.match(explanation.answer, /entrance-to-platform path is unverified/, 'Provider assertions must not be swallowed as a failed model response')
      assert.equal(nativeCalls, before)

      const rawArgs = result.trace[0].arguments
      const delayed = await registry(updates(120))('route_plan', rawArgs)
      assert.equal(firstRide(delayed.data.plan).toStopId, 'fixture\u001fX', 'An updated bus can still use the preceding stop to reach the train')
      assert.equal(delayed.data.plan.arriveMinutes, 510)
      const stale = await registry(updates(120), { ...state, feeds: [{ ...state.feeds[0], status: 'stale' }] })('route_plan', rawArgs)
      assert.equal(stale.data.realtime.suppliedTripUpdates, 0)
      assert.equal(firstRide(stale.data.plan).scheduleMode, 'exact')
      const noTransfers = await callTool('route_plan', { ...rawArgs, maxTransfers: 0 })
      assert.equal(noTransfers.data.journeys[0].status, 'unavailable', 'The LLM cannot silently lose the no-transfer requirement')

      const rules = await callTool('gtfs_query', { sql: "SELECT transfer_type,min_transfer_time FROM transfers WHERE from_stop_id='fixture\u001fH' AND to_stop_id='fixture\u001fB'" })
      assert.equal(rules.data.rows[0].min_transfer_time, minimum, 'The assistant can retrieve the exact directed rule behind an alternative')

      // A large feed must not displace the selected itinerary in a small
      // model's context. Retain the full overlay only in the technical record.
      const large = structuredClone(result.trace[0].result)
      large.data.journeys[0].realtime.diagnostics[0].appliedTripIds = Array.from({ length: 10_000 }, (_, i) => `unrelated-trip-${i}`)
      large.data.plan.legs[0].coordinates = Array.from({ length: 10_000 }, () => [1, 2])
      const compact = compactResult(large, 'route_plan')
      assert.equal(compact, compactResult(result.trace[0].result, 'route_plan'), 'Model payload does not scale with overlay IDs or map geometry')
      assert.ok(compact.length < 10_000)
      assert.ok(large.data.journeys[0].realtime.diagnostics[0].appliedTripIds.length === 10_000, 'Compaction never modifies the evidence record')

      // Exercise the actual service/notebook boundary too. A unit test that
      // supplies its own history would miss discarded route_plan findings.
      let apiModels = 0, apiRoutes = 0
      const service = createAgencyService({
        context: async () => ({ storePath: store, cityName: 'City X', agencyDirectory: path.join(folder, `notebook-${minimum}`) }),
        route: async (_project, request) => { apiRoutes++; nativeCalls++; return { plan: routeNationalGtfsStore(store, { ...request, maxWalkKm: .2 }) } },
      }, { clock: () => Date.parse(generatedAt), provider: { available: true, model: 'scripted-provider', complete: async messages => {
        if (++apiModels === 1) return toolCall(initial)
        assert.match(messages[1].content, /priorFindings.*route_plan.*legs.*durationSeconds/s)
        assert.match(messages[1].content, /stationAccessStatus.*unverified/)
        return { content: 'The saved journey retains its transfer evidence; station access is unverified.' }
      } } })
      try {
        const initialAnswer = await service.handle('fixture', { action: 'ask', question: 'Plan my journey' })
        const followup = await service.handle('fixture', { action: 'ask', parentId: initialAnswer.entryId, question: 'Explain that transfer' })
        const later = await service.handle('fixture', { action: 'ask', parentId: followup.entryId, question: 'And is the station walk verified?' })
        for (const answer of [followup, later]) {
          assert.match(answer.answer, /saved journey retains its transfer evidence/)
          assert.deepEqual(answer.warnings, [])
        }
        assert.equal(apiRoutes, 1, 'Retained native evidence survives an intervening explanation without rerouting')
        assert.equal(apiModels, 3)
      } finally { service.close() }

      // Opt in explicitly; ordinary regression checks never load a model or
      // use a network provider. This uses the real native fixture above.
      if (minimum === 181 && process.env.VIGO_TEST_ASK_MODEL) {
        const protocol = process.env.VIGO_TEST_ASK_PROTOCOL || 'ollama'
        const provider = createProvider({ VIGO_AGENCY_LLM_BASE_URL: process.env.VIGO_TEST_ASK_URL || 'http://127.0.0.1:11434',
          VIGO_AGENCY_LLM_PROTOCOL: protocol, VIGO_AGENCY_LLM_MODEL: process.env.VIGO_TEST_ASK_MODEL,
          VIGO_AGENCY_LLM_API_KEY: process.env.VIGO_TEST_ASK_KEY,
          VIGO_AGENCY_LLM_REASONING_EFFORT: protocol === 'ollama' ? 'none' : '' }, (url, options) => {
          const body = JSON.parse(options.body)
          console.log(JSON.stringify({ modelRequestCharacters: body.messages.reduce((n, message) => n + (message.content?.length ?? 0), 0), schemaCharacters: JSON.stringify(body.format ?? body.tools ?? {}).length }))
          return fetch(url, options)
        })
        const history = []
        for (const question of [
          `How do I go from ${names.A} to ${names.D} on ${serviceDate} at 08:00 by transit?`,
          'Explain the interchange in that journey. Does the walking path into the platform have verified station data?',
          `Same endpoints on ${serviceDate} at 08:00, but no transfers. Is there a journey?`,
        ]) {
          const live = await queryAgency({ question, context, state, callTool, provider, history, placesAvailable: false,
            signal: AbortSignal.timeout(90_000) })
          console.log(JSON.stringify({ model: provider.model, question, answer: live.answer, tools: live.trace.map(call => ({ tool: call.tool, arguments: call.arguments, ok: call.result.ok })), timing: live.timing, warnings: live.warnings }))
          if (!history.length) {
            const journey = live.trace.find(call => call.tool === 'route_plan')
            assert.equal(journey?.arguments.departTime, '08:00')
            assert.equal(journey?.arguments.serviceDate, serviceDate)
            assert.equal(journey?.result.data.plan?.arriveMinutes, 510)
          } else if (history.length === 1) assert.match(live.answer, /unverified|not verified|not.*(?:confirm|verif)/i)
          else {
            const journey = live.trace.find(call => call.tool === 'route_plan')
            assert.equal(journey?.arguments.maxTransfers, 0)
            assert.equal(journey?.result.data.journeys[0].status, 'unavailable')
          }
          history.push({ question, answer: live.answer, observedAt: live.generatedAt,
            requests: live.trace.map(({ tool, arguments: args }) => ({ tool, arguments: args })), findings: live.trace })
        }
      }
    } finally { context.close(); disposeNationalGtfsStore(store) }
  }
  assert.equal(journeyClock(496 + 1 / 60), '08:16:01', 'A one-second missed connection cannot be rounded down for the model')
  assert.equal(journeyClock(1470), '24:30', 'Keep the GTFS service-day offset past midnight')
  assert.equal(journeyClock(null), undefined)
  const calendarContext = networkContext({ counts: { routes: 2 }, coverage: { serviceDate: '2026-09-15', firstDate: '2026-01-01', lastDate: '2026-12-31', valid: true } })
  assert.match(calendarContext, /2026-01-01.*2026-12-31/)
  assert.doesNotMatch(calendarContext, /2026-09-15/, 'The snapshot date must not become the apparent timetable coverage')
  console.log(`Ask routing integration passed (${nativeCalls} real native queries; exact transfers, realtime, stale fallback, constraints and retained explanation evidence).`)
} finally { await fs.rm(folder, { recursive: true, force: true }) }
