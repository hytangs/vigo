const labels = {
  localized_corridor_disruption: 'A shared corridor disruption',
  independent_late_trips: 'Delay carried into the area by individual trips',
  terminal_or_dispatch_issue: 'A terminal or dispatch problem',
  realtime_data_inconsistency: 'An inconsistency in realtime reporting',
}
export const nextChecks = {
  follow_same_trips: 'Follow the same trips at their next stops to see whether delay is increasing or being carried forward.',
  compare_neighboring_service: 'Check whether other services using the same streets begin to lose time as well.',
  check_dispatch: 'Check dispatch and terminal departure records before attributing the delay to a street-level disruption.',
  verify_vehicle_progress: 'Compare the next vehicle positions with the departure predictions before acting on the reported delay.',
  check_service_notices: 'Check for a new agency notice identifying the incident and affected service.',
  watch_following_gap: 'Watch the following departures to see whether the longer gap persists or begins to close.',
}

// Facts are rendered from computed evidence. The model decides which hypothesis
// they support or weaken; it cannot replace them with invented observations.
export function investigationFacts(trace, diagnosis) {
  const names = new Map(diagnosis.routes.map(route => [route.id, route.name]))
  const facts = []
  const add = (check, statement, usableForAssessment = true) => facts.push({ id: facts.length + 1, check, statement, usableForAssessment })
  for (const [index, call] of trace.entries()) {
    if (!call.result.ok) { add(index + 1, `${call.arguments.aspect.replaceAll('_', ' ')} could not be checked.`, false); continue }
    const d = call.result.data
    switch (call.arguments.aspect) {
      case 'alerts':
        if (!d.sourceAvailable) add(index + 1, 'A current agency notice check is unavailable.', false)
        else if (!d.matchingNotices) add(index + 1, 'No matching operational notice was found. This does not rule out an incident.', false)
        else for (const notice of d.notices.slice(0, 4)) add(index + 1, `Agency notice for ${notice.routeIds?.map(id => names.get(id) || id).join(', ') || 'the selected stops'}: ${notice.title}`)
        break
      case 'prediction_progression': {
        for (const trip of d.trips.slice(0, 6)) {
          const name = names.get(trip.routeId) || trip.routeId
          if (trip.upstreamDelayMinutes !== null) add(index + 1, `One ${name} trip was already predicted ${trip.upstreamDelayMinutes} minutes late before the area and ${trip.entryDelayMinutes} minutes late at entry. This is a forecast comparison, not an observed onset.`)
          else add(index + 1, `One ${name} trip has no upstream prediction with which to locate where its delay began.`, false)
          if (trip.predictedChangeWithinAreaMinutes !== null) add(index + 1, `The ${name} trip's forecast delay ${trip.predictedChangeWithinAreaMinutes > 0 ? 'increases' : trip.predictedChangeWithinAreaMinutes < 0 ? 'decreases' : 'stays unchanged'}${trip.predictedChangeWithinAreaMinutes ? ` by ${Math.abs(trip.predictedChangeWithinAreaMinutes)} ${Math.abs(trip.predictedChangeWithinAreaMinutes) === 1 ? 'minute' : 'minutes'}` : ''} across the area. Future predictions do not establish an actual slowdown or recovery.`)
        }
        if (!d.totalTrips) add(index + 1, 'No comparable trip predictions through the selected area were available.', false)
        break
      }
      case 'surrounding_service':
        add(index + 1, `At the selected shared stops, ${d.inside.late} of ${d.inside.trips} reporting trips have late predictions; elsewhere across the reporting network, ${d.outside.late} of ${d.outside.trips} do. This comparison does not establish the condition of nearby streets.`, Boolean(d.areaDefined && d.inside.trips && d.outside.trips))
        break
      case 'vehicle_reports':
        add(index + 1, `${d.reportsWithFreshPosition} of ${d.timedTripReports} timed trip reports have a fresh vehicle position with matching trip identity. This does not verify forecast accuracy; missing positions do not prove a data error.`, false)
        break
      case 'historical_runtime':
        if (d.status !== 'available') add(index + 1, 'The historical running-time study does not cover this selection.', false)
        else add(index + 1, `A retrospective LAMP running-time evaluation is available through ${d.range.end}. Historical running-time error cannot establish the cause of current departure delay.`, false)
        break
    }
  }
  return facts
}

export function realizeInvestigation(ranked, facts, watch, narrative) {
  // Preserve the model's evidence assessment, but a weakened hypothesis must
  // never become the headline ahead of one it explicitly found plausible.
  const order = { plausible: 0, unresolved: 1, weakened: 2 }
  ranked = ranked.map(row => ({ ...row, supportingEvidenceIds: [...new Set(row.supportingEvidenceIds)], conflictingEvidenceIds: [...new Set(row.conflictingEvidenceIds)] }))
    .sort((a, b) => order[a.status] - order[b.status])
  const leading = ranked[0], selected = new Map(facts.map(fact => [fact.id, fact]))
  const support = leading.supportingEvidenceIds.map(id => selected.get(id).statement)
  const against = leading.conflictingEvidenceIds.map(id => selected.get(id).statement)
  const conclusion = leading.status === 'plausible' ? `The evidence currently favors ${labels[leading.hypothesis].toLowerCase()}.`
    : leading.status === 'weakened' ? `The checked evidence weakens ${labels[leading.hypothesis].toLowerCase()} as an explanation.`
      : 'The completed checks do not yet distinguish a shared corridor problem from delays on individual trips.'
  return { narrative: { ...narrative, elsewhere: '' }, explanation: { hypothesis: leading.hypothesis, status: leading.status,
    text: [conclusion, ...support, ...(against.length ? ['Evidence to weigh against that explanation:', ...against] : [])].join(' '), evidenceIds: [...leading.supportingEvidenceIds, ...leading.conflictingEvidenceIds] },
    assessment: conclusion, watchNext: nextChecks[watch], rankedHypotheses: ranked, facts }
}
