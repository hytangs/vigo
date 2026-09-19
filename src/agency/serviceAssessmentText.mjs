const number = value => Number(value.toFixed(1))
const minutes = seconds => number(seconds / 60)
const plural = (count, one, many = `${one}s`) => count === 1 ? one : many

// A bounded investigation order, not a severity score or passenger-impact rank.
// Full measurements and notice selectors remain in the tool's evidence record.
export function networkPriorityRoutes(diagnosis) {
  return diagnosis.routes.filter(route => diagnosis.status !== 'timetable_unavailable' && (route.cancelledTrips || route.widest || route.laterTrips || route.earlierTrips))
    .sort((a, b) => b.cancelledTrips - a.cancelledTrips
      || (b.widest?.maxIncreaseSeconds || 0) - (a.widest?.maxIncreaseSeconds || 0)
      || b.laterTrips - a.laterTrips || b.earlierTrips - a.earlierTrips || a.name.localeCompare(b.name))
    .slice(0, 3)
}

export function networkPriorityText(diagnosis, overview) {
  const { coverage, window } = diagnosis
  const selected = networkPriorityRoutes(diagnosis)
  const rows = selected.map(route => {
    const facts = []
    if (route.cancelledTrips) facts.push(`${route.cancelledTrips} scheduled ${plural(route.cancelledTrips, 'trip')} reported cancelled`)
    if (route.widest) facts.push(`${minutes(route.widest.predictedSeconds)} min between predicted departures at ${route.widest.stopName}, versus ${minutes(route.widest.scheduledSeconds)} min scheduled`)
    if (!route.widest && route.laterTrips) facts.push(`${route.laterTrips} of ${route.measuredTrips} reporting trips have a late next departure${Number.isFinite(route.maxDelaySeconds) ? `, up to ${minutes(route.maxDelaySeconds)} min` : ''}`)
    if (!route.widest && !route.laterTrips && route.earlierTrips) facts.push(`${route.earlierTrips} of ${route.measuredTrips} reporting trips have an early next departure`)
    return `- **${route.name}** — ${facts.join('; ')}.`
  })
  const reasons = [selected.some(route => route.cancelledTrips) ? 'reported cancellations' : '', selected.some(route => route.widest) ? 'larger predicted spacing increases' : '', selected.some(route => !route.cancelledTrips && !route.widest) ? 'more late or early reporting trips' : ''].filter(Boolean)
  const order = rows.length ? `Start with ${selected.map(route => route.name).join(', ')}. Review order: ${reasons.join(', then ')}.` : overview
  const next = rows.length ? 'Check following departures and direction before choosing a dispatch action. Passenger impact has not been ranked; predicted spacing is not measured waiting.' : ''
  const coverageText = `**Coverage:** ${coverage.reportingScheduledTrips} of ${coverage.scheduledTrips} scheduled trips have a usable prediction or cancellation report in the next ${window.minutes} min; ${coverage.unknownTrips} ${coverage.unknownTrips === 1 ? 'remains' : 'remain'} unknown.`
  const unavailable = coverage.feeds.filter(feed => feed.status !== 'fresh').map(feed => `${feed.kind === 'tripUpdates' ? 'Trip updates' : feed.kind === 'vehicles' ? 'Vehicle positions' : 'Alerts'}: ${feed.status}`)
  return [order, rows.join('\n'), next, `${coverageText}${unavailable.length ? ` ${[...new Set(unavailable)].join('; ')}.` : ''}${coverage.excludedFrequencyTemplates ? ` Frequency-based service is outside this assessment (${coverage.excludedFrequencyTemplates} excluded templates).` : ''}`].filter(Boolean).join('\n\n')
}

export function compactNoticeScope(notice) {
  const parts = [...new Set((notice.scopeDescription || '').split(';').map(part => part.trim().replace(/\.$/, '')).filter(Boolean))]
  return parts.join('; ') || [...new Set((notice.routes || []).map(route => route.name))].join(', ') || 'Scope unresolved'
}

export function noticeSummary(data, { priorityRouteIds } = {}) {
  if (!data.totalNotices && !data.notices?.length) return ''
  const notices = data.notices || []
  const operational = notices.filter(notice => !['ACCESSIBILITY_ISSUE', 'NO_EFFECT', 'OTHER_EFFECT', 'UNKNOWN_EFFECT'].includes(notice.effect)
    && (!priorityRouteIds || notice.selectors?.some(selector => !selector.unresolved?.length && selector.routeIds?.some(id => priorityRouteIds.includes(id)))))
  const distinct = [...new Map(operational.map(notice => [JSON.stringify([notice.title?.trim(), compactNoticeScope(notice), notice.effect, notice.cause]), notice])).values()]
  const selected = distinct.slice(0, 2)
  const unresolved = notices.filter(notice => notice.selectors?.some(selector => selector.unresolved?.length) || /unresolved/i.test(notice.scopeDescription || '')).length
  const line = notice => {
    const title = notice.title.trim().replace(/\s+/g, ' ')
    const prefix = title.slice(0, 187)
    const sentence = Math.max(prefix.lastIndexOf('. '), prefix.lastIndexOf('! '), prefix.lastIndexOf('? '))
    const short = title.length > 190 ? sentence > 70 ? prefix.slice(0, sentence + 1) : `${prefix.slice(0, prefix.lastIndexOf(' ')).trimEnd()}…` : title
    const scope = compactNoticeScope(notice)
    const uncertain = notice.selectors?.some(selector => selector.unresolved?.length) || /unresolved/i.test(scope)
    return `- ${short}${uncertain ? ' **Scope unresolved.**' : ` (${scope})`}`
  }
  const count = `${data.totalNotices ?? notices.length} active agency ${plural(data.totalNotices ?? notices.length, 'notice')}${data.totalNotices > notices.length ? `; ${notices.length} retained examples` : ''}.`
  const scopeLimit = unresolved ? ` ${unresolved} retained ${plural(unresolved, 'notice has', 'notices have')} unresolved scope.` : ''
  if (priorityRouteIds && !selected.length) return `${count} The retained notices do not establish a cause for these route changes.${scopeLimit}`
  return [`${count}${scopeLimit}${selected.length ? ' Selected operational notices:' : ' No operational cause is established by the retained examples.'}`,
    selected.map(line).join('\n'), selected.length ? 'Notice causes apply only to their stated scope. Full text and selectors remain in the evidence.' : 'Full notice text and selectors remain in the evidence.'].filter(Boolean).join('\n\n')
}

// Old notes retain their exact answers, sources and timestamps. The UI may
// condense this specific legacy network summary from its recorded evidence;
// never reinterpret a model-authored answer or claim a new observation.
export function retainedNetworkAssessmentText(answer) {
  if (answer.aiGenerated || answer.responseBasis !== 'computed' || answer.trace?.length !== 1) return null
  const data = answer.trace[0].result?.data
  if (data?.kind !== 'service_assessment' || data.presentationVersion || !data.sections?.some(section => section.check === 'conditions')
    || !data.sections.every(section => section.target === 'Network' && ['conditions', 'spacing', 'causes'].includes(section.check))
    || !data.sections.every(section => answer.answer.includes(section.text))) return null
  const d = data.inspections?.find(item => item.data?.scope?.allNetwork)?.data
  if (!d?.coverage || !d.routes || !d.intervals) return null
  const routes = new Map(d.routes.map(route => [route.route, { id: route.id, name: route.route,
    measuredTrips: route.reportingTrips, laterTrips: route.laterTrips || 0, earlierTrips: 0,
    cancelledTrips: route.cancelledTrips || 0, maxDelaySeconds: Number.isFinite(route.maxDelayMinutes) ? route.maxDelayMinutes * 60 : null, widest: null }]))
  for (const pair of d.intervals) {
    if (!(pair.predictedMinutes > pair.scheduledMinutes)) continue
    if (!routes.has(pair.route)) routes.set(pair.route, { id: pair.route, name: pair.route, measuredTrips: 0, laterTrips: 0, earlierTrips: 0, cancelledTrips: 0, widest: null })
    const route = routes.get(pair.route), increase = (pair.predictedMinutes - pair.scheduledMinutes) * 60
    if (!route.widest || route.widest.maxIncreaseSeconds < increase) route.widest = { predictedSeconds: pair.predictedMinutes * 60,
      scheduledSeconds: pair.scheduledMinutes * 60, maxIncreaseSeconds: increase, stopName: pair.stop }
  }
  const diagnosis = { routes: [...routes.values()], coverage: d.coverage, window: { minutes: d.predictionWindowMinutes } }
  const summary = networkPriorityText(diagnosis, 'No priority is established by the retained route and spacing examples.')
  return [data.preface, `Based on the saved route and spacing examples.\n\n${summary}`, noticeSummary(d, { priorityRouteIds: networkPriorityRoutes(diagnosis).map(route => route.id) })].filter(Boolean).join('\n\n') + ' [1]'
}
