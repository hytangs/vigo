const minutes = seconds => seconds < 60 ? 'less than a minute' : `about ${Math.round(seconds / 60)} minutes`
const count = (n, singular, plural = `${singular}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? singular : plural}`

// The network diagnosis determines the content and priority. These sentences
// communicate measured quantities without an extra model call or a threshold
// that silently equates "no anomaly" with "normal service".
export function networkNarrative(diagnosis) {
  const { network: n, coverage: c, routes } = diagnosis
  const sections = []
  let overview
  if (diagnosis.status === 'timetable_unavailable') overview = 'The current network cannot be assessed against this timetable. Check its service dates and timezone before using live predictions.'
  else if (!n.measuredTrips) overview = c.scheduledTrips
    ? `${count(c.scheduledTrips, 'trip')} scheduled in the next ${diagnosis.window.minutes} minutes have no usable upcoming departure predictions. Current service conditions are unknown.`
    : `No timed trips are scheduled in this ${diagnosis.window.minutes}-minute window, and no upcoming departure predictions are available.`
  else {
    const spread = routes.filter(row => row.laterTrips).length
    overview = n.laterTrips
      ? spread > c.measuredRoutes / 2
        ? 'Delays are widespread among reporting routes.'
        : spread > 1 ? 'Delays affect several reporting routes.'
          : `The reported lateness is concentrated on ${routes.find(route => route.laterTrips).name}. Other reporting routes have no late next-departure predictions.`
      : n.earlierTrips ? 'No late next departures are predicted among reporting trips, but some may leave ahead of their published times.'
        : 'Reporting trips currently match the timetable at their next departures. Unreported service remains unknown.'

  }
  if (n.cancelledTrips) overview += ` ${count(n.cancelledTrips, 'scheduled trip')} in this window ${n.cancelledTrips === 1 ? 'is' : 'are'} reported cancelled.`
  const byId = new Map(routes.map(route => [route.id, route]))
  for (const area of diagnosis.concentrations.slice(0, 2)) {
    const names = area.routeIds.map(id => byId.get(id)?.name || id)
    sections.push({ id: area.id, title: `${sections.length ? 'Also affected' : 'Main shared-area delay'} · ${area.name}`, routeIds: area.routeIds,
      text: `Routes ${names.join(' and ')} have ${count(area.tripCount, 'trip')} with departures predicted up to ${minutes(area.maxDelaySeconds)} late through the same area.` })
  }
  // A whole-minute briefing must not announce a longer wait while displaying
  // the same interval twice. Exact sub-minute comparisons remain in diagnosis.
  const widest = routes.filter(row => row.widest && Math.round(row.widest.maxIncreaseSeconds / 60) > 0
    && Math.round(row.widest.predictedSeconds / 60) > Math.round(row.widest.scheduledSeconds / 60))
    .sort((a, b) => b.widest.maxIncreaseSeconds - a.widest.maxIncreaseSeconds)[0]
  if (widest) {
    const interval = widest.widest
    sections.push({ id: 'spacing', title: `${widest.name} · Longer rider wait`, routeIds: [widest.id],
      text: `Riders at ${interval.stopName} may wait through a gap of about ${Math.round(interval.predictedSeconds / 60)} minutes between departures, compared with ${Math.round(interval.scheduledSeconds / 60)} minutes in the timetable. Following-service recovery has not been established.` })
  }
  const leading = routes.filter(row => row.laterTrips && row.id !== widest?.id && !sections.some(section => section.routeIds.includes(row.id)))
    .sort((a, b) => b.delaySeconds - a.delaySeconds)[0]
  if (leading && sections.length < 3) {
    sections.push({ id: 'delay', title: `${leading.name} · ${leading.laterTrips === 1 ? 'One late trip' : 'Delays across trips'}`, routeIds: [leading.id],
      text: `${leading.laterTrips} of ${count(leading.measuredTrips, 'reporting trip')} ${leading.laterTrips === 1 ? 'has its' : 'have their'} next departure predicted late, by up to ${minutes(leading.maxDelaySeconds)}.${leading.continued.length ? ` Repeated reports still show lateness for ${count(leading.continued.length, 'trip')} at the same stop.` : ''}${leading.laterTrips === 1 ? ' Other trips need to be checked before treating this as a route-wide problem.' : ''}` })
  }
  const coverage = `${c.reportingScheduledTrips} of ${count(c.scheduledTrips, 'scheduled trip')} have a usable prediction or cancellation report for this window.${c.reportingShare !== null ? ` They represent ${Math.round(c.reportingShare * 100)}% of scheduled vehicle-minutes, not passenger coverage.` : ''}${c.unknownTrips ? ` Conditions on ${count(c.unknownTrips, 'unreported trip')} remain unknown.` : ''}`
  return { overview, sections, elsewhere: '', coverage }
}
