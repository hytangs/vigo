// The model extracts what its prose asserts; these checks verify the selected
// predicates against the actual diagnosis. They do not classify question text
// or choose a narrative, cause, priority or intervention.
export const networkClaimConditions = ['late_departures', 'all_reporting_late', 'all_reporting_match_schedule', 'reported_cancellation', 'wider_departure_gap', 'closer_departure_pairs', 'possible_longer_waits', 'observed_longer_waits', 'normal_service']

export function checkNetworkClaims(diagnosis, paragraphs, claims) {
  return claims.map(claim => {
    const route = diagnosis.routes.find(route => route.id === claim.routeId)
    if (!route || !claim.quote.trim() || !paragraphs[claim.paragraph - 1]?.includes(claim.quote)) throw new Error('A network claim must identify its route and exact public wording.')
    const supported = {
      late_departures: route.laterTrips > 0,
      all_reporting_late: route.measuredTrips > 0 && route.laterTrips === route.measuredTrips,
      all_reporting_match_schedule: route.measuredTrips > 0 && route.matchingTrips === route.measuredTrips,
      reported_cancellation: route.cancelledTrips > 0,
      wider_departure_gap: route.measuredPairs > 0 && route.widerPairs > 0,
      closer_departure_pairs: route.measuredPairs > 0 && route.closerPairs > 0,
      possible_longer_waits: route.measuredPairs > 0 && route.widerPairs > 0,
      observed_longer_waits: false, // Forecast spacing does not measure riders' actual waits.
      normal_service: false, // Predictions alone cannot establish actual service reliability.
    }[claim.condition]
    if (supported === undefined) throw new Error('Choose a known service-condition claim.')
    return { ...claim, supported, evidence: { route: route.name, reportingTrips: route.measuredTrips, later: route.laterTrips, matching: route.matchingTrips,
      cancelledTrips: route.cancelledTrips, comparedPairs: route.measuredPairs, widerPairs: route.widerPairs, closerPairs: route.closerPairs },
      ...(supported ? {} : { reason: `${route.name}: the checked ${claim.condition.replaceAll('_', ' ')} assertion is not established by its reporting-trip and departure-pair comparisons.` }) }
  })
}
