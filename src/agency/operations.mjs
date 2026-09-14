import { createHash } from 'node:crypto'
import { eventSentences } from './communications.mjs'

export const operationsPolicy = Object.freeze({ sampleMinutes: 5, retentionDays: 90, maxSamples: 25_920, minBaselineDays: 3, maxRecords: 10_000 })
export const channelLimits = Object.freeze({ app: 2000, 'service-alert': 2000, social: 280, signage: 160 })
export const workflow = Object.freeze({ new: ['acknowledged'], acknowledged: ['investigating'], investigating: ['acting', 'resolved'], acting: ['monitoring'], monitoring: ['investigating', 'resolved'], resolved: ['investigating'] })
export const permissions = Object.freeze({ viewer: ['read'], operator: ['read', 'finding', 'knowledge', 'draft'], reviewer: ['read', 'finding', 'knowledge', 'draft', 'approve', 'publish'], admin: ['read', 'finding', 'knowledge', 'draft', 'approve', 'publish', 'configure'] })
export const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }) }
export function authorize(principal, capability) {
  if (!principal || typeof principal.id !== 'string' || !principal.id.trim() || principal.id.length > 120 || !Object.hasOwn(permissions, principal.role) || !permissions[principal.role].includes(capability)) fail('This account cannot perform this action.', 403)
}
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const eventFingerprint = event => digest({ ...event, observedAt: undefined })
export function textField(value, name, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || [...value].length > max) fail(`${name} must contain 1–${max} characters.`)
  return value.trim()
}
export function isoDate(value, name) {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) fail(`${name} must be a valid date.`)
  return new Date(value).toISOString()
}
export function qualitySummary(state) {
  const flags = []
  if (!state.connected) flags.push('disconnected')
  if (!state.coverage.valid) flags.push('schedule-out-of-coverage')
  if (!state.feeds.length) flags.push('no-feed-clocks')
  for (const feed of state.feeds) if (feed.status !== 'fresh') flags.push(`${feed.kind}:${feed.status}`)
  if (state.counts.unresolvedTrips) flags.push('unresolved-trip-reports')
  if (!state.routes.some(route => route.widestInterval)) flags.push('no-departure-pairs')
  return { flags: [...new Set(flags)], alignedReports: state.counts.matchedTrips, totalReports: state.counts.trips,
    alignmentRatio: state.counts.trips ? state.counts.matchedTrips / state.counts.trips : null,
    comparedRoutes: state.routes.filter(route => route.widestInterval).length,
    note: 'Alignment measures received trip reports, not the share of scheduled service observed. No reports means unknown.' }
}
export function eventAvailability(finding, state, scheduleIdentity) {
  if (finding.scheduleIdentity !== scheduleIdentity) return { status: 'unknown', reason: 'The timetable changed. Investigate against the current import.' }
  const event = state.events.find(event => event.id === finding.event.id)
  if (!event) return { status: 'unknown', reason: 'This finding is no longer established by current reports. Absence does not establish recovery.' }
  if (event.type === 'stale-data') return { status: 'unknown', reason: 'This finding concerns missing or stale data.' }
  const age = (Date.parse(state.generatedAt) - Date.parse(event.observedAt)) / 1000
  if (!state.connected || !state.coverage.valid || !Number.isFinite(age) || Math.abs(age) > state.policy.freshnessSeconds) return { status: 'unknown', reason: 'Current, aligned evidence is required.' }
  return { status: 'current', event, changed: finding.fingerprint !== eventFingerprint(event) }
}
export function composeMessage(event, context, { channel, audience }) {
  if (!Object.hasOwn(channelLimits, channel)) fail('Choose app, service-alert, social or signage.')
  if (!['all-riders', 'at-stop', 'accessible-travel'].includes(audience)) fail('Choose a supported rider audience.')
  const fact = eventSentences(event, context).find(sentence => sentence.id === 'fact').text
  const guidance = audience === 'at-stop' ? 'Check the departure display before boarding.' : audience === 'accessible-travel'
    ? 'Check with agency staff about accessible travel options.' : 'Check current departures before travelling.'
  const body = `${fact} ${guidance}`
  return { channel, audience, language: 'en', body, limit: channelLimits[channel], needsShortening: [...body].length > channelLimits[channel] }
}

const median = values => { const ordered = [...values].sort((a, b) => a - b); return ordered.length % 2 ? ordered[(ordered.length - 1) / 2] : (ordered[ordered.length / 2 - 1] + ordered[ordered.length / 2]) / 2 }
// One value per service day prevents frequent polling from dominating the comparison.
export function historicalComparison(samples, state, routeId, scheduleIdentity) {
  if (!state.routes.some(route => route.id === routeId)) fail('Choose a current indexed route.')
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: state.coverage.timezone || 'UTC', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(state.generatedAt))
  const weekday = parts.find(part => part.type === 'weekday').value, hour = parts.find(part => part.type === 'hour').value
  const byDate = new Map()
  const validScope = state.coverage.valid && state.coverage.timezone && /^\d{4}-\d{2}-\d{2}$/.test(state.coverage.serviceDate || '')
  for (const sample of samples) {
    if (!validScope) continue
    if (sample.scheduleIdentity !== scheduleIdentity || sample.weekday !== weekday || sample.hour !== hour || sample.serviceDate >= state.coverage.serviceDate || !sample.coverageValid) continue
    const route = sample.routes.find(route => route.id === routeId)
    if (!route || !Number.isFinite(route.maxDelaySeconds) || !route.reportingTrips) continue
    const values = byDate.get(sample.serviceDate) || []
    values.push(route.maxDelaySeconds); byDate.set(sample.serviceDate, values)
  }
  const days = [...byDate].sort(([a], [b]) => a.localeCompare(b)).map(([date, values]) => ({ date, value: median(values), samples: values.length }))
  const evaluation = days.slice(operationsPolicy.minBaselineDays).map((day, index) => ({ date: day.date, targetSeconds: day.value, predictedSeconds: median(days.slice(0, index + operationsPolicy.minBaselineDays).map(row => row.value)) }))
  const baselineSeconds = days.length >= operationsPolicy.minBaselineDays ? median(days.map(day => day.value)) : null
  const currentSeconds = state.routes.find(route => route.id === routeId).maxDelaySeconds
  return { routeId, weekday, hour, serviceDays: days.length, minimumDays: operationsPolicy.minBaselineDays, baselineSeconds, currentSeconds,
    differenceSeconds: baselineSeconds !== null && Number.isFinite(currentSeconds) ? currentSeconds - baselineSeconds : null,
    evaluation: { cases: evaluation.length, meanAbsoluteErrorSeconds: evaluation.length ? evaluation.reduce((sum, row) => sum + Math.abs(row.targetSeconds - row.predictedSeconds), 0) / evaluation.length : null, rows: evaluation }, days,
    method: 'Median of daily medians of reported route maximum predicted departure delay; same timetable, local weekday and hour; earlier service dates only. Historical prediction summaries, not actual vehicle passages or passenger delay. Expanding-window evaluation never trains on the evaluated day.' }
}
