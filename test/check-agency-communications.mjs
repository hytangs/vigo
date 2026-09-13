import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { draftRouteMessage } from '../src/agency/communications.mjs'
import { AgencyContext } from '../src/agency/agencyContext.mjs'
import { deriveOperationalState } from '../src/agency/realtimeIntelligence.mjs'
import { createToolRegistry } from '../src/agency/toolRegistry.mjs'
import { compactResult, queryAgency } from '../src/agency/queryAgent.mjs'
import { createWebResearch } from '../src/agency/webResearch.mjs'
import { createAgencyService } from '../src/server/agency-api.mjs'
import { createAgencyFixture, realtimeFixture, tripUpdate, observationTime } from './fixtures/agency.mjs'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agency-writing-'))
let context, service
try {
  const file = path.join(directory, 'schedule.sqlite')
  createAgencyFixture(file)
  context = new AgencyContext(file, 'City X')
  const snapshot = realtimeFixture([tripUpdate('T1', 300), tripUpdate('T2', 600), tripUpdate('T3', 900)])
  snapshot.feeds.push({ sourceUrl: 'https://example.org/alerts.pb', kind: 'alerts', feedTimestamp: observationTime })
  snapshot.alerts = [{ id: 'notice', sourceUrl: 'https://example.org/alerts.pb', routeIds: ['R'], stopIds: ['A'], header: 'R diversion', description: 'Road work at River closes the usual stop.', cause: 'CONSTRUCTION', effect: 'DETOUR', url: 'https://agency.example/notices/road-work', activePeriods: [{ start: observationTime - 60, end: observationTime + 600 }] }]
  const state = deriveOperationalState(context, snapshot, observationTime)
  const callTool = createToolRegistry({ context, state, snapshot, adapters: {} })
  const alertResult = await callTool('service_alerts', { routeNames: ['R'] })
  const projected = JSON.parse(compactResult(alertResult, 'service_alerts')).data.events[0]
  assert.equal(projected.evidence.alertDescription, snapshot.alerts[0].description)
  assert.equal(projected.evidence.alertCause, 'CONSTRUCTION')
  assert.equal(projected.evidence.alertUrl, snapshot.alerts[0].url)
  assert.deepEqual(projected.evidence.activePeriods, snapshot.alerts[0].activePeriods)
  const draft = await callTool('draft_rider_message', { routeNames: ['R'], eventId: 'expired-event' })
  assert.equal(draft.ok, true, 'An expired event does not prevent a draft from the current route scope')
  assert.match(draft.data.body, /10 min/)
  assert.match(draft.data.body, /sorry/)
  assert.doesNotMatch(draft.data.body, /due to|because/, 'A separate alert association does not prove the cause of every delay')
  assert.match(draft.warnings.join(), /earlier event expired/)
  assert.equal(draft.data.agencyExplanations[0].cause, 'CONSTRUCTION')
  await assert.rejects(callTool('draft_rider_message', { eventId: 'expired-event' }), error => error.details.requiredScope.includes('routeNames'))

  const cancellation = draftRouteMessage({ context, state: { ...state, routes: state.routes.map(route => ({ ...route, maxDelaySeconds: null })) }, routeIds: ['R'], events: [{ type: 'cancellation', sourceRefs: ['fixture:cancellation'] }] })
  assert.match(cancellation.body, /1 cancelled trip/)
  assert.doesNotMatch(cancellation.body, /do not establish a delay/)

  let modelCalls = 0
  const provider = { available: true, model: 'fixture', complete: async (messages, tools) => {
    const question = messages.filter(message => message.role === 'user').at(-1).content
    if (question === 'Check R' && !messages.some(message => message.role === 'tool')) return { tool_calls: [{ id: 'status', function: { name: 'realtime_status', arguments: '{"routeNames":["R"]}' } }] }
    if (question === 'Check R') return { content: 'Some departures on R are predicted late. [1]' }
    modelCalls++
    assert.match(messages[0].content, /previousRequests.*routeNames.*R/s)
    assert.match(messages[0].content, /priorFindings.*maxDelayMinutes.*10/s, 'The notebook preserves checked measurements, not only the old answer')
    assert.ok(tools.some(tool => tool.name === 'web_read'))
    assert.ok(!tools.some(tool => tool.name === 'web_search'), 'Unavailable search is not advertised to the model')
    return { content: 'We’re sorry: some Route R departures are delayed. Please check current departure information before travelling.' }
  } }
  service = createAgencyService({ context: async () => ({ storePath: file, cityName: 'City X', agencyDirectory: path.join(directory, 'notes') }), inspectRealtime: async () => snapshot }, { provider, web: createWebResearch({ env: { VIGO_AGENCY_WEB_SEARCH_PROVIDER: 'off' }, readPage: () => {} }), clock: () => observationTime * 1000 })
  await service.connect('x', {})
  const first = await service.handle('x', { action: 'ask', question: 'Check R' })
  const next = await service.handle('x', { action: 'ask', question: 'Draft an apologetic message', parentId: first.entryId })
  const third = await service.handle('x', { action: 'ask', question: 'Make it shorter', parentId: next.entryId })
  assert.match(next.answer, /We’re sorry/)
  assert.match(third.answer, /We’re sorry/)
  assert.equal(modelCalls, 2, 'Drafting and revision each require only one inference when context supplies the facts')
  assert.equal(third.trace.length, 0)

  let round = 0
  const researched = await queryAgency({ question: 'Find a cause and draft a rider update', context, state, webStatus: { searchAvailable: true, readAvailable: true },
    provider: { available: true, complete: async (messages, tools) => {
      assert.ok(tools.some(tool => tool.name === 'web_search'))
      if (++round === 1) return { tool_calls: [{ id: 'web', function: { name: 'web_search', arguments: '{"query":"City X R road work today"}' } }] }
      assert.match(messages.filter(message => message.role !== 'system').at(-1).content, /Search unavailable/)
      return { content: 'We’re sorry for the delays on Route R. Please check live departures. The cause has not been confirmed.' }
    } }, callTool: async () => { throw new Error('Search unavailable') } })
  assert.match(researched.answer, /We’re sorry/)
  assert.equal(researched.trace[0].result.ok, false, 'A failed search remains visible without blocking the useful draft')
  console.log('Agency communications: full alert explanations, exact scope, expired-event recovery, retained operational findings, direct revisions and failed-search recovery passed.')
} finally { service?.close(); context?.close(); await fs.rm(directory, { recursive: true, force: true }) }
