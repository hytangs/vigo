import { scheduledServiceWindow, scheduledServiceContext, tripInstance } from './serviceWindow.mjs'
import { serviceConcentrations } from './serviceConcentrations.mjs'

const sum = (rows, field) => rows.reduce((value, row) => value + row[field], 0)
const quantile = (values, p) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]
}
const groupBy = (rows, field) => {
  const groups = new Map()
  for (const row of rows) { const key = row[field]; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row) }
  return groups
}

export function diagnoseNetwork(context, state) {
  const from = Date.parse(state.generatedAt) / 1000, to = from + state.policy.windowMinutes * 60
  const scheduled = state.coverage.valid ? scheduledServiceWindow(context, from, to) : { trips: [], excludedFrequencyTemplates: 0 }
  const expected = new Map(scheduled.trips.map(row => [row.key, row]))
  const departures = state.measurements?.departures ?? [], intervals = state.measurements?.intervals ?? []
  const next = new Map()
  for (const departure of departures) {
    if (departure.predictedTime < from) continue
    const key = tripInstance(departure)
    if (!next.has(key) || departure.predictedTime < next.get(key).predictedTime) next.set(key, departure)
  }
  const cancellations = state.trips.filter(row => row.status === 'cancelled' && expected.has(tripInstance(row)))
  const cancelledKeys = new Set(cancellations.map(tripInstance))
  const reports = [...next.values()]
  const scheduledByRoute = groupBy(scheduled.trips, 'routeId'), reportsByRoute = groupBy(reports, 'routeId')
  const intervalsByRoute = groupBy(intervals, 'routeId'), cancellationsByRoute = groupBy(cancellations, 'routeId')
  const routes = state.routes.map(route => {
    const scheduledTrips = scheduledByRoute.get(route.id) ?? [], measured = reportsByRoute.get(route.id) ?? []
    const comparisons = intervalsByRoute.get(route.id) ?? [], cancelled = cancellationsByRoute.get(route.id) ?? []
    const late = measured.filter(row => row.delaySeconds > 0), early = measured.filter(row => row.delaySeconds < 0)
    const matching = measured.length - late.length - early.length
    const pairs = new Map()
    for (const interval of comparisons) {
      const id = JSON.stringify([interval.directionId, interval.serviceDate, interval.tripIds])
      if (!pairs.has(id)) pairs.set(id, { ...interval, stopIds: [], maxIncreaseSeconds: -Infinity, minIncreaseSeconds: Infinity })
      const pair = pairs.get(id), difference = interval.predictedSeconds - interval.scheduledSeconds
      pair.stopIds.push(interval.stopId)
      if (difference > pair.maxIncreaseSeconds) Object.assign(pair, interval, { maxIncreaseSeconds: difference })
      pair.minIncreaseSeconds = Math.min(pair.minIncreaseSeconds, difference)
    }
    const wider = [...pairs.values()].filter(row => row.maxIncreaseSeconds > 0)
    const closer = [...pairs.values()].filter(row => row.minIncreaseSeconds < 0)
    const widest = wider.sort((a, b) => b.maxIncreaseSeconds - a.maxIncreaseSeconds)[0] ?? null
    const continued = late.flatMap(row => {
      const points = (state.tripHistory?.[`${row.tripId}/${row.serviceDate}`] ?? [])
        .filter(point => point.stopId === row.stopId && point.at <= row.observedAt && point.at >= new Date((from - state.policy.historyMinutes * 60) * 1000).toISOString())
      const distinct = [...new Map(points.map(point => [point.at, point])).values()].sort((a, b) => a.at.localeCompare(b.at))
      // Consecutive positive reports at the same stop; no claim about onset or
      // recovery after a vehicle count, and no trend from a refreshed header.
      const lastNonLate = distinct.findLastIndex(point => point.delaySeconds <= 0)
      const positive = distinct.slice(lastNonLate + 1)
      if (positive.length < 2 || positive.at(-1).at !== row.observedAt) return []
      return [{ tripId: row.tripId, stopId: row.stopId, since: positive[0].at, seconds: (Date.parse(row.observedAt) - Date.parse(positive[0].at)) / 1000,
        changeSeconds: row.delaySeconds - positive[0].delaySeconds }]
    })
    const coverageSeconds = scheduledTrips.filter(row => next.has(row.key) || cancelledKeys.has(row.key)).reduce((total, row) => total + row.seconds, 0)
    const patterns = [
      ...(cancelled.length ? ['reported_cancellation'] : []),
      ...(late.length === 1 ? ['one_late_prediction'] : late.length > 1 ? ['several_late_predictions'] : []),
      ...(wider.length && closer.length ? ['uneven_spacing'] : wider.length ? ['wider_spacing'] : closer.length ? ['closer_spacing'] : []),
      ...(continued.length ? ['repeated_late_prediction'] : []), ...(early.length ? ['early_predictions'] : []),
    ]
    if (!patterns.length) patterns.push(measured.length ? 'matches_schedule' : scheduledTrips.length ? 'unreported' : 'no_scheduled_service')
    return { id: route.id, name: route.name, mode: route.mode, scheduledTrips: scheduledTrips.length, scheduledSeconds: sum(scheduledTrips, 'seconds'), coverageSeconds,
      reportingScheduledTrips: scheduledTrips.filter(row => next.has(row.key) || cancelledKeys.has(row.key)).length,
      measuredTrips: measured.length, laterTrips: late.length, earlierTrips: early.length, matchingTrips: matching, cancelledTrips: cancelled.length,
      delaySeconds: sum(late, 'delaySeconds'), maxDelaySeconds: measured.length ? Math.max(...measured.map(row => row.delaySeconds)) : null,
      medianDeviationSeconds: quantile(measured.map(row => Math.abs(row.delaySeconds)), 0.5),
      measuredPairs: pairs.size, widerPairs: wider.length, closerPairs: closer.length,
      widest: widest ? { ...widest, stopName: context.stopIndex.get(widest.stopId)?.name || widest.stopId, stopIds: [...new Set(widest.stopIds)] } : null,
      patterns, continued, alerts: route.alerts,
      trips: measured.map(row => ({ ...row, stopName: context.stopIndex.get(row.stopId)?.name || row.stopId })),
    }
  })
  const measuredRoutes = routes.filter(row => row.measuredTrips)
  const scheduledSeconds = sum(scheduled.trips, 'seconds'), coverageSeconds = sum(routes, 'coverageSeconds')
  const coveredTrips = sum(routes, 'reportingScheduledTrips')
  const totalDelaySeconds = sum(routes, 'delaySeconds')
  const byDelay = routes.filter(row => row.delaySeconds > 0).sort((a, b) => b.delaySeconds - a.delaySeconds || a.id.localeCompare(b.id))
  const intervalPairs = sum(routes, 'measuredPairs')
  return {
    version: 2, generatedAt: state.generatedAt, timezone: context.timezone, window: { from, to, minutes: state.policy.windowMinutes },
    serviceContext: state.coverage.valid ? scheduledServiceContext(context, from, scheduled) : null,
    status: !state.coverage.valid ? 'timetable_unavailable' : !reports.length
      ? !scheduled.trips.length && !context.frequencyTrips.size ? 'no_scheduled_service' : 'prediction_coverage_unavailable' : 'measured',
    coverage: { scheduledTrips: scheduled.trips.length, reportingScheduledTrips: coveredTrips, unknownTrips: scheduled.trips.length - coveredTrips,
      scheduledRoutes: routes.filter(row => row.scheduledTrips).length, measuredRoutes: measuredRoutes.length, indexedRoutes: routes.length,
      scheduledVehicleMinutes: scheduledSeconds / 60, reportingVehicleMinutes: coverageSeconds / 60,
      reportingShare: scheduledSeconds ? coverageSeconds / scheduledSeconds : null,
      excludedFrequencyTemplates: scheduled.excludedFrequencyTemplates,
      additionalReportingTrips: reports.filter(row => !expected.has(tripInstance(row))).length,
      feeds: state.feeds.map(({ kind, sourceUrl, status, feedTimestamp }) => ({ kind, sourceUrl, status, feedTimestamp })),
    },
    network: { measuredTrips: reports.length, laterTrips: sum(routes, 'laterTrips'), earlierTrips: sum(routes, 'earlierTrips'), matchingTrips: sum(routes, 'matchingTrips'), cancelledTrips: cancellations.length,
      medianDeviationSeconds: quantile(reports.map(row => Math.abs(row.delaySeconds)), 0.5), p90DeviationSeconds: quantile(reports.map(row => Math.abs(row.delaySeconds)), 0.9),
      totalDelaySeconds, measuredPairs: intervalPairs, widerPairs: sum(routes, 'widerPairs'), closerPairs: sum(routes, 'closerPairs'), alerts: state.counts.alerts,
      // This is a delay distribution across measured trips, not a health or
      // passenger exposure score. Never weight a route as one equal vote.
      leadingDelayRoute: byDelay[0] ? { id: byDelay[0].id, name: byDelay[0].name, share: byDelay[0].delaySeconds / totalDelaySeconds } : null },
    concentrations: serviceConcentrations(context, departures), routes,
    limits: [
      'One next departure per reporting trip measures timetable deviation; future stop predictions are not independent vehicles.',
      'Coverage is weighted by scheduled vehicle-minutes within this window. It is not passenger coverage or a health score.',
      'Shared-location findings use overlapping late predictions on the same directed GTFS stop connection. Nearby roads and neighborhood boundaries are not inferred.',
      'No passenger counts, normal-variability baseline, incident causes, or recovery forecast are established by these predictions.',
      ...(scheduled.excludedFrequencyTemplates ? ['Frequency trip instances are excluded because their start times are not retained.'] : []),
    ],
  }
}

// Ask gets the same calculated assessment, without thousands of stop rows or
// full trip histories in the small local model's context.
export function compactDiagnosis(diagnosis) {
  return { ...diagnosis, concentrations: diagnosis.concentrations.slice(0, 3),
    routes: diagnosis.routes.filter(row => row.measuredTrips || row.cancelledTrips)
      .sort((a, b) => b.cancelledTrips - a.cancelledTrips || b.delaySeconds - a.delaySeconds).slice(0, 8)
      .map(({ trips, continued, ...route }) => ({ ...route, repeatedLateTrips: continued.length })),
    routeDetailLimit: 8, concentrationDetailLimit: 3 }
}
