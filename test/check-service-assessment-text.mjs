import assert from 'node:assert/strict'
import { compactNoticeScope, noticeSummary, networkPriorityText } from '../src/agency/serviceAssessmentText.mjs'

const coverage = { reportingScheduledTrips: 7, scheduledTrips: 10, unknownTrips: 3, feeds: [{ kind: 'tripUpdates', status: 'stale' }], excludedFrequencyTemplates: 0 }
const base = { measuredTrips: 4, laterTrips: 0, earlierTrips: 0, cancelledTrips: 0, maxDelaySeconds: null, widest: null }
const diagnosis = { status: 'measured', window: { minutes: 30 }, coverage, routes: [
  { ...base, id: 'late', name: 'Late', laterTrips: 4, maxDelaySeconds: 3600 },
  { ...base, id: 'wide', name: 'Wide', widest: { maxIncreaseSeconds: 660, predictedSeconds: 1260, scheduledSeconds: 600, stopName: 'Main' } },
  { ...base, id: 'cancel', name: 'Cancelled', cancelledTrips: 1 },
  { ...base, id: 'early', name: 'Early', earlierTrips: 1 },
] }
const text = networkPriorityText(diagnosis, 'Fallback')
assert.ok(text.indexOf('**Cancelled**') < text.indexOf('**Wide**'))
assert.ok(text.indexOf('**Wide**') < text.indexOf('**Late**'), 'Maximum lateness alone must not override a checked wider departure interval')
assert.match(text, /21 min between predicted departures at Main, versus 10 min scheduled/)
assert.match(text, /7 of 10 scheduled trips.*3 remain unknown/)
assert.match(text, /Trip updates: stale/)
assert.doesNotMatch(text, /\*\*Early\*\*|actual waiting|most disrupted/)
assert.doesNotMatch(networkPriorityText({ ...diagnosis, status: 'timetable_unavailable' }, 'Timetable unavailable.'), /\*\*Wide\*\*/)

const unknown = { title: 'Route 429 detoured for construction.', effect: 'DETOUR', cause: 'CONSTRUCTION', scopeDescription: 'Part of this notice has an unresolved scope.; Part of this notice has an unresolved scope.', selectors: [{ unresolved: ['agency ownership unavailable'] }] }
const known = { title: 'Route 10 is detoured.', effect: 'DETOUR', scopeDescription: 'Route 10 · at Main; Route 10 · at Main', selectors: [{ unresolved: [] }] }
const notices = [unknown, unknown, known, { title: 'Garage renovation', effect: 'OTHER_EFFECT' }]
assert.equal(compactNoticeScope(known), 'Route 10 · at Main')
const noticeText = noticeSummary({ totalNotices: 92, notices })
assert.equal((noticeText.match(/Route 429 detoured/g) || []).length, 1)
assert.equal((noticeText.match(/Route 10 · at Main/g) || []).length, 1)
assert.match(noticeText, /92 active agency notices; 4 retained examples/)
assert.match(noticeText, /unresolved scope/)
assert.doesNotMatch(noticeText, /Garage renovation/)
const unrelated = noticeSummary({ totalNotices: 92, notices }, { priorityRouteIds: ['unrelated-route'] })
assert.doesNotMatch(unrelated, /Route 429|Route 10|Garage/)
assert.match(unrelated, /retained notices do not establish a cause/)

console.log('Service answer text: bounded priorities, exact predictions, unknown coverage and scoped notices passed.')
