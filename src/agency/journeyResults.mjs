export const journeyModeNames = { transit: 'Transit', drive: 'Drive' }

export function isJourneyReady(plan, mode) {
  return Boolean(plan?.legs?.length && plan.status !== 'blocked' && (!plan.travelMode || plan.travelMode === mode)
    && Number.isFinite(plan.durationMinutes) && plan.durationMinutes >= 0)
}

export function journeyDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return 'Unavailable'
  if (minutes > 0 && minutes < 1) return '<1 min'
  const rounded = Math.round(minutes)
  return rounded < 60 ? `${rounded} min` : `${Math.floor(rounded / 60)} hr${rounded % 60 ? ` ${rounded % 60} min` : ''}`
}

// Read the itinerary timeline, including a wait before the first leg. Do not
// infer that a later departure would improve it without another route query.
export function journeyBreakdown(plan) {
  let cursor = plan.departMinutes, longestWait = null
  const totals = { walk: 0, ride: 0, drive: 0, wait: 0 }
  for (const leg of plan.legs ?? []) {
    const wait = Number.isFinite(cursor) && Number.isFinite(leg.startMinutes) ? Math.max(0, leg.startMinutes - cursor) : 0
    totals.wait += wait
    if (wait > (longestWait?.minutes ?? 0)) longestWait = { minutes: wait, stop: leg.fromName, route: leg.routeShortName || leg.routeId }
    const duration = Number.isFinite(leg.durationMinutes) ? leg.durationMinutes : leg.endMinutes - leg.startMinutes
    if (Object.hasOwn(totals, leg.type) && Number.isFinite(duration) && duration >= 0) totals[leg.type] += duration
    if (Number.isFinite(leg.endMinutes)) cursor = Math.max(cursor ?? leg.endMinutes, leg.endMinutes)
  }
  return { ...totals, longestWait }
}

// The requested mode set is retained through place selection. A successful
// transit path cannot fulfill a driving output, and an omitted result cannot
// masquerade as an unavailable capability.
export function verifyJourneyModes(modes = ['transit'], data = {}) {
  const results = data.journeys ?? (data.plan ? [{ mode: data.plan.travelMode || 'transit', status: data.plan.legs?.length ? 'ready' : 'unavailable', plan: data.plan, reason: data.plan.detail }] : [])
  const missing = modes.filter(mode => {
    const matches = results.filter(result => result.mode === mode)
    if (matches.length !== 1) return true
    const result = matches[0]
    return result.status === 'ready' ? !isJourneyReady(result.plan, mode)
      : result.status !== 'unavailable' || !result.reason
  })
  return { complete: !missing.length, missing }
}

export function describeJourneys(data) {
  const journeys = data.journeys ?? [{ mode: data.plan?.travelMode || 'transit', status: data.plan?.legs?.length ? 'ready' : 'unavailable', plan: data.plan, reason: data.plan?.detail }]
  const ready = item => item.status === 'ready' && isJourneyReady(item.plan, item.mode)
  const lines = [journeys.map(item => `**${journeyModeNames[item.mode] || item.mode}: ${ready(item) ? journeyDuration(item.plan.durationMinutes) : 'unavailable'}**`).join(' · ')]
  const transit = journeys.find(item => item.mode === 'transit' && ready(item))
  if (transit) {
    const { longestWait } = journeyBreakdown(transit.plan)
    lines.push(`Transit time includes walking, waiting, and riding.${longestWait ? ` The longest wait is about ${journeyDuration(longestWait.minutes)}${longestWait.route ? ` before ${longestWait.route}` : ''}${longestWait.stop ? ` at ${longestWait.stop}` : ''}.` : ''}`)
  }
  for (const item of journeys.filter(item => !ready(item))) lines.push(`${journeyModeNames[item.mode] || item.mode}: ${item.reason || 'No journey was established.'}`)
  return lines.join('\n\n')
}
