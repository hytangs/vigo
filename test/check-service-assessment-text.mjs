import assert from 'node:assert/strict'
import { compactNoticeScope, noticeSummary, networkPriorityText, retainedNetworkAssessmentText } from '../src/agency/serviceAssessmentText.mjs'

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

const sections = [{ target: 'Network', check: 'conditions', text: 'Legacy conditions.' }, { target: 'Network', check: 'spacing', text: 'Legacy spacing.' }, { target: 'Network', check: 'causes', text: 'Legacy causes.' }]
const answer = { aiGenerated: false, responseBasis: 'computed', answer: sections.map(row => row.text).join('\n\n') + ' [1]', generatedAt: '2026-09-15T12:00:00Z', trace: [{ result: { data: {
  kind: 'service_assessment', sections, inspections: [{ data: { scope: { allNetwork: true }, coverage, predictionWindowMinutes: 30, totalNotices: 92, notices,
    routes: [{ id: 'late', route: 'Late', reportingTrips: 4, laterTrips: 4, cancelledTrips: 0, maxDelayMinutes: 60 }],
    intervals: [{ route: 'Wide', stop: 'Main', predictedMinutes: 21, scheduledMinutes: 10 }] } }],
} } }] }
const before = JSON.stringify(answer)
const legacy = retainedNetworkAssessmentText(answer)
assert.match(legacy, /Based on the saved route and spacing examples/)
assert.match(legacy, /\*\*Wide\*\*.*21 min.*10 min/)
assert.match(legacy, /3 remain unknown/)
assert.equal(JSON.stringify(answer), before, 'Condensing a saved answer must not change its timestamp, source facts or original text')
assert.equal(retainedNetworkAssessmentText({ ...answer, aiGenerated: true }), null, 'Do not rewrite a model-authored historical answer')
assert.equal(retainedNetworkAssessmentText({ ...answer, answer: 'Only one chosen section.' }), null, 'Do not add omitted checks back to a selected answer')
console.log('Service answer text: bounded priorities, exact predictions, unknown coverage, scoped notices and immutable saved-answer display passed.')
