import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AgencyContext } from '../src/agency/agencyContext.mjs'
import { deriveOperationalState } from '../src/agency/realtimeIntelligence.mjs'
import { observationReportMarkdown } from '../src/agency/observationExport.ts'
import { createAgencyFixture, observationTime, realtimeFixture, tripUpdate, sourceUrl } from './fixtures/agency.mjs'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-observation-export-'))
const file = path.join(directory, 'schedule.sqlite')
createAgencyFixture(file)
const context = new AgencyContext(file, 'City X')
const exportedAt = new Date((observationTime + 600) * 1000).toISOString()
const derive = snapshot => {
  const state = deriveOperationalState(context, snapshot, observationTime)
  return { ...state, scheduleIdentity: 'timetable-fixture-v1', eventCount: state.events.length, filteredEventCount: state.events.length,
    filters: { eventType: 'all' }, history: [], tripHistory: {}, provider: { available: false, model: null, hasKey: false } }
}

try {
  const state = derive(realtimeFixture([tripUpdate('T1'), tripUpdate('T2', 600)]))
  state.selection = { route: { id: 'R', name: 'River service' }, stop: { id: 'A', name: 'River', coordinate: [-71.06, 42.36] } }
  const before = JSON.stringify(state)
  const report = observationReportMarkdown(state, { exportedAt })
  assert.equal(JSON.stringify(state), before, 'Export must not mutate the retained observation')
  assert.match(report, /GTFS service date: 2026-09-13/)
  assert.match(report, /Agency timezone: Etc\/UTC/)
  assert.match(report, /Response computed at: 2026-09-13T12:00:00.000Z/)
  assert.match(report, /Realtime snapshot fetched at: 2026-09-13T12:00:00.000Z/)
  assert.match(report, /Exported at: 2026-09-13T12:10:00.000Z/)
  assert.match(report, /Schedule identity: timetable-fixture-v1/)
  assert.match(report, /Route selection: River service \(R\)/)
  assert.match(report, /Stop selection: River \(A\)/)
  assert.match(report, /City-wide counts below do not narrow/)
  assert.match(report, /\| Resolved trip-update records \| 2 \|/)
  assert.match(report, /Predicted 1200 s \/ scheduled 600 s/)
  assert.match(report, /2\/2 expected departures report/)
  assert.match(report, /\| Trip updates \| fresh \|/)
  assert.match(report, /600 s; outside freshness policy by timestamp/, 'A fresh captured status must not be advertised as current after time passes')
  assert.match(report, /Unreported scheduled trips are not quantified/)
  assert.match(report, /does not provide|do not provide a scheduled-trip reporting percentage/)
  assert.ok(report.includes(`](<${sourceUrl}>)`), 'Feed references remain directly usable links')
  assert.match(report, /no AI-generated explanation/)

  const failed = observationReportMarkdown(state, { exportedAt: state.generatedAt, refreshFailed: true, eventFilter: 'service-gap' })
  assert.match(failed, /Observation refresh failed. The last successful response is retained/)
  assert.match(failed, /0 s; observation refresh failed/)
  assert.doesNotMatch(failed, /within freshness policy by timestamp/, 'A failed refresh is never summarized as a current feed check')
  assert.match(failed, /Event filter: service-gap/)

  const missing = derive(realtimeFixture([tripUpdate('T1'), tripUpdate('T3', 600)]))
  const missingReport = observationReportMarkdown(missing, { exportedAt: missing.generatedAt })
  assert.doesNotMatch(missingReport, /Long predicted interval/, 'Missing intermediate reports must not become a measured gap in the export')
  assert.match(missingReport, /Missing or unusable reports leave service conditions unknown/)

  const disconnected = observationReportMarkdown(derive(null), { exportedAt })
  assert.match(disconnected, /Realtime snapshot: Not connected/)
  assert.match(disconnected, /Live freshness is unknown/)
  assert.match(disconnected, /No events were returned.*does not establish normal service/)
  assert.match(disconnected, /No source references were supplied/)

  const event = state.events[0]
  const capped = observationReportMarkdown({ ...state, events: Array.from({ length: 501 }, (_, index) => ({ ...event, id: String(index), title: `Event ${index}` })), filteredEventCount: 620, eventCount: 900 }, { exportedAt })
  assert.match(capped, /500 of 620 matching events included; 501 records were returned/)
  assert.match(capped, /partial event listing/)
  assert.match(capped, /City-wide event total before selection: 900/)
  assert.match(capped, /Event 499/)
  assert.doesNotMatch(capped, /Event 500/)
  const unknownTotal = observationReportMarkdown({ ...state, filteredEventCount: undefined }, { exportedAt })
  assert.match(unknownTotal, /matching total was not supplied; completeness is unknown/)

  const hostile = observationReportMarkdown({ ...state, cityName: '<img src=x> | City\n# injected',
    selection: undefined, filters: { routeId: 'not-found', stopId: 'missing', eventType: 'delay' },
    events: [{ ...event, title: '[open](javascript:alert(1))\n| fake row', sourceRefs: ['javascript:alert(1)', 'https://example.org/a(b)?q=<unsafe>'] }],
  }, { exportedAt })
  assert.doesNotMatch(hostile, /<img|\n# injected|\n\| fake row|(?<!\\)\]\(javascript:/)
  assert.match(hostile, /Requested route not-found; identity unresolved/)
  assert.match(hostile, /Requested stop missing; identity unresolved/)
  assert.ok(hostile.includes('](<https://example.org/a(b)?q=%3Cunsafe%3E>)'))

  const noTimestamp = observationReportMarkdown({ ...state, feeds: [{ ...state.feeds[0], feedTimestamp: undefined, ageSeconds: null, status: 'unknown' }] }, { exportedAt })
  assert.match(noTimestamp, /Unknown; freshness unknown/)
  const future = observationReportMarkdown({ ...state, feeds: [{ ...state.feeds[0], feedTimestamp: observationTime + 300 }] }, { exportedAt: state.generatedAt })
  assert.match(future, /Clock ahead 300 s; freshness unknown/)
} finally {
  context.close()
  await fs.rm(directory, { recursive: true, force: true })
}
console.log('Agency observation export: computed-fixture provenance, scope, stale/failed/unknown feeds, missing reporting, capped events and safe Markdown passed.')
