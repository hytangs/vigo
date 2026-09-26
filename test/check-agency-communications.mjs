import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { draftRouteMessage, draftRiderMessage } from '../src/agency/communications.mjs'
import { AgencyContext } from '../src/agency/agencyContext.mjs'
import { deriveOperationalState } from '../src/agency/realtimeIntelligence.mjs'
import { createToolRegistry } from '../src/agency/toolRegistry.mjs'
import { compactResult } from '../src/agency/queryAgent.mjs'

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

  const noDisruption = draftRouteMessage({ context, state: { ...state, routes: state.routes.map(route => ({ ...route, maxDelaySeconds: null })) }, routeIds: ['R'], events: [] })
  assert.doesNotMatch(noDisruption.body, /sorry|disruption/)
  assert.match(noDisruption.body, /As of Sep 13.*Review before publishing/)
  const eventDraft = await draftRiderMessage({ context, event: state.events.find(event => event.type === 'delay'), channel: 'signage' })
  assert.match(eventDraft.body, /Direction 0.*trip T/)
  assert.match(eventDraft.body, /As of Sep 13.*Review before publishing/)
  const staleDraft = await draftRiderMessage({ context, event: { type: 'stale-data', title: 'Feed is stale', evidence: {}, observedAt: state.observedAt, sourceRefs: [] }, channel: 'app' })
  assert.doesNotMatch(staleDraft.body, /sorry|disruption/)

  console.log('Computed rider drafts preserve alert scope, uncertainty and cancellation evidence.')
} finally { service?.close(); context?.close(); await fs.rm(directory, { recursive: true, force: true }) }
