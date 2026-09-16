const minutes = seconds => seconds < 60 ? 'less than a minute' : `about ${Math.round(seconds / 60)} minutes`
const routeList = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' })
const count = (n, singular, plural = `${singular}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? singular : plural}`

export function serviceContextNarrative(diagnosis) {
  const service = diagnosis.serviceContext
  if (!service?.complete) return ''
  const next = service.nextScheduledTrip
  const nextTime = next ? `${next.date === service.clock.date ? '' : `${next.date} at `}${next.time} ${next.zoneLabel}` : ''
  if (service.phase === 'between_runs') {
    return `The timetable is between scheduled runs.${nextTime ? ` The next scheduled trip starts at ${nextTime}.` : service.referenceComplete ? ` No timed trips are scheduled in the next ${service.referenceHours} hours.` : 'The next service start is not established by the available timetable.'}`
  }
  // "Most" is an exact majority of routes with scheduled work in the reference
  // window; it is not a lateness threshold or a route-weighted health score.
  if (service.referenceComplete && service.windowRoutes < service.referenceRoutes / 2) {
    return `Most routes have no trips scheduled in this window. Service is scheduled on ${count(service.windowRoutes, 'route')} in the next ${diagnosis.window.minutes} minutes, out of ${service.referenceRoutes} with service in the next ${service.referenceHours} hours.`
  }
  return ''
}

// The network diagnosis determines the content and priority. These sentences
// communicate measured quantities without an extra model call or a threshold
// that silently equates "no anomaly" with "normal service".
export function networkNarrative(diagnosis) {
  const { network: n, coverage: c, routes } = diagnosis
  const sections = []
  let overview
  if (diagnosis.status === 'timetable_unavailable') overview = 'The current network cannot be assessed against this timetable. Check its service dates and timezone before using live predictions.'
  else if (!n.measuredTrips && !c.scheduledTrips && diagnosis.serviceContext?.complete === false) overview = 'No timed trips are scheduled in this window. Frequency-based service is outside this assessment, so current operating conditions remain unknown.'
  else if (!n.measuredTrips) overview = c.scheduledTrips
    ? `${count(c.scheduledTrips, 'trip')} scheduled in the next ${diagnosis.window.minutes} minutes have no usable upcoming departure predictions. Current service conditions are unknown.`
    : `No timed trips are scheduled in this ${diagnosis.window.minutes}-minute window, and no upcoming departure predictions are available.`
  else {
    const spread = routes.filter(row => row.laterTrips).length
    overview = n.laterTrips
      ? `Delays affect ${spread} of ${count(c.measuredRoutes, 'route')} with usable predictions.`
      : n.earlierTrips ? 'No late next departures are predicted among reporting trips, but some may leave ahead of their published times.'
        : 'Reporting trips currently match the timetable at their next departures. Unreported service remains unknown.'

  }
  const serviceContext = serviceContextNarrative(diagnosis)
  if (serviceContext) {
    overview = !n.measuredTrips && !c.scheduledTrips ? serviceContext
      : `${serviceContext} ${n.measuredTrips && !c.scheduledTrips ? 'Live predictions still show service outside its scheduled window. ' : ''}${overview}`
  }
  if (n.cancelledTrips) overview += ` ${count(n.cancelledTrips, 'scheduled trip')} ${n.cancelledTrips === 1 ? 'is' : 'are'} reported cancelled in the next ${diagnosis.window.minutes} minutes.`
  const byId = new Map(routes.map(route => [route.id, route]))
  for (const area of diagnosis.concentrations.slice(0, 2)) {
    const names = area.routeIds.map(id => byId.get(id)?.name || id)
    sections.push({ id: area.id, title: `${sections.length ? 'Other concentration' : 'Leading delay concentration'} · ${area.name}`, routeIds: area.routeIds,
      text: `${count(area.tripCount, 'delayed trip')} on routes ${routeList.format(names)} pass through this area. Predicted departure delays reach ${minutes(area.maxDelaySeconds)}.` })
  }
  // A whole-minute briefing must not announce a longer wait while displaying
  // the same interval twice. Exact sub-minute comparisons remain in diagnosis.
  const widest = routes.filter(row => row.widest && Math.round(row.widest.maxIncreaseSeconds / 60) > 0
    && Math.round(row.widest.predictedSeconds / 60) > Math.round(row.widest.scheduledSeconds / 60))
    .sort((a, b) => b.widest.maxIncreaseSeconds - a.widest.maxIncreaseSeconds)[0]
  if (widest) {
    const interval = widest.widest
    sections.push({ id: 'spacing', title: `${widest.name} · Longer rider wait`, routeIds: [widest.id],
      text: `At ${interval.stopName}, the predicted gap between departures is about ${Math.round(interval.predictedSeconds / 60)} minutes, compared with ${Math.round(interval.scheduledSeconds / 60)} minutes in the timetable. Whether following service will close this gap is unknown.` })
  }
  const leading = routes.filter(row => row.laterTrips && row.id !== widest?.id && !sections.some(section => section.routeIds.includes(row.id)))
    .sort((a, b) => b.delaySeconds - a.delaySeconds)[0]
  if (leading && sections.length < 3) {
    sections.push({ id: 'delay', title: `${leading.name} · ${leading.laterTrips === 1 ? 'One late trip' : 'Delays across trips'}`, routeIds: [leading.id],
      text: `${leading.laterTrips} of ${count(leading.measuredTrips, 'reporting trip')} ${leading.laterTrips === 1 ? 'has its' : 'have their'} next departure predicted late, by up to ${minutes(leading.maxDelaySeconds)}.${leading.continued.length ? ` Repeated reports still show lateness for ${count(leading.continued.length, 'trip')} at the same stop.` : ''}${leading.laterTrips === 1 ? ' Other trips need to be checked before treating this as a route-wide problem.' : ''}` })
  }
  const coverage = `${c.scheduledTrips ? `${c.reportingScheduledTrips} of ${count(c.scheduledTrips, 'scheduled trip')} have a usable prediction or cancellation report for this window.` : 'There are no timed trips to assess in this scheduled window.'}${c.reportingShare !== null ? ` They represent ${Math.round(c.reportingShare * 100)}% of scheduled vehicle-minutes, not passenger coverage.` : ''}${c.unknownTrips ? ` ${count(c.unknownTrips, 'scheduled trip')} ${c.unknownTrips === 1 ? 'has' : 'have'} no usable prediction or cancellation report. Their current conditions are unknown.` : ''}${diagnosis.serviceContext?.complete ? ' Routes without scheduled work in this window are not counted as missing service.' : ''}`
  return { overview, sections, elsewhere: '', coverage }
}
