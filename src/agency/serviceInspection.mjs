import { alertInScope, alertStopIds } from './alertApplicability.mjs'
import { diagnoseNetwork } from './networkDiagnosis.mjs'
import { serviceContextNarrative } from './networkNarrative.mjs'
import { serviceEpoch } from './agencyContext.mjs'
import { inspectService } from './serviceInvestigationEvidence.mjs'
import { scheduledServiceWindow, tripInstance } from './serviceWindow.mjs'
import { agencyClock } from './agencyClock.mjs'
import { feedStates } from './realtimeIntelligence.mjs'

const minutes = seconds => Number.isFinite(seconds) ? Math.round(seconds / 60 * 10) / 10 : null

// The same bounded evidence packet serves diagnosis, rider impact and action
// questions. It does not choose an incident cause or simulate a dispatch action.
export function inspectionScope(context, snapshot, args) {
  const resolve = (kind, values) => values.map(value => {
    const index = kind === 'route' ? context.routeIndex : context.stopIndex
    if (index.has(value)) return value
    const result = context.resolve({ kind, query: value })
    if (result.method !== 'exact' || result.matches.length !== 1) {
      const vehicle = kind === 'route' && (snapshot?.vehicles ?? []).find(vehicle => vehicle.id === value || vehicle.label === value)
      throw Object.assign(new Error(vehicle ? `“${value}” matches a vehicle report, not an indexed route. Use vehicleId: ${vehicle.id}.` : `Choose an exact ${kind} for “${value}”.`),
        { details: { matches: result.matches.slice(0, 8), ...(vehicle ? { nextStep: `Call inspect_service with scope=vehicle and vehicleId=${vehicle.id}. Do not put the vehicle number in routeNames or routeIds.` } : {}) } })
    }
    return result.matches[0].id
  })
  const routeIds = [...new Set(resolve('route', [...(args.routeIds ?? []), ...(args.routeNames ?? [])]))]
  const roots = resolve('stop', args.stopIds ?? [])
  const stopIds = [...new Set(roots.flatMap(id => [id, ...context.stops.filter(stop => stop.parent_station === id).map(stop => stop.stop_id)]))]
  let vehicleIds = []
  if (args.vehicleId) {
    const vehicles = (snapshot?.vehicles ?? []).filter(vehicle => vehicle.id === args.vehicleId || vehicle.label === args.vehicleId)
    vehicleIds = [...new Set(vehicles.map(vehicle => vehicle.id))]
    if (!vehicleIds.length) vehicleIds = [args.vehicleId] // TripUpdates may identify a vehicle without a position.
    if (new Set(vehicles.map(vehicle => JSON.stringify([vehicle.sourceUrl, vehicle.id]))).size > 1) throw new Error('That vehicle label identifies more than one vehicle or source; choose an unambiguous vehicle.')
  }
  if (args.tripId && !context.tripById.has(args.tripId)) throw new Error('Choose an exact trip from this City.')
  return { routeIds, stopIds, vehicleIds, tripId: args.tripId }
}

export async function inspectOperationalService({ context, state, snapshot, directory, diagnosis: preparedDiagnosis }, args) {
  const scope = inspectionScope(context, snapshot, args)
  const allNetwork = !scope.routeIds.length && !scope.stopIds.length && !scope.tripId && !scope.vehicleIds.length
  const routeSet = new Set(scope.routeIds), stopSet = new Set(scope.stopIds)
  const tripSelected = row => (!routeSet.size || routeSet.has(row.routeId)) && (!scope.tripId || row.tripId === scope.tripId) && (!scope.vehicleIds.length || scope.vehicleIds.includes(row.vehicleId))
  // Departure measurements belong to their origin stop. The connection's
  // destination is not a departure prediction for that downstream station.
  const atStop = row => !stopSet.size || stopSet.has(row.stopId)
  const selected = (state.measurements?.departures ?? []).filter(row => tripSelected(row) && atStop(row))
  const reports = state.trips.filter(tripSelected)
  const selectedRoutes = scope.routeIds.length ? scope.routeIds : [...new Set([...selected, ...reports.filter(row => !stopSet.size)].map(row => row.routeId).filter(Boolean))]
  const aspect = args.aspect || 'diagnosis'
  if (!['diagnosis', 'outlook'].includes(aspect)) return inspectService({ context, state, snapshot, directory }, {
    ...scope, routeIds: allNetwork ? [...context.routeIndex.keys()] : selectedRoutes, aspect,
  })
  const now = Date.parse(state.generatedAt) / 1000
  const clock = seconds => {
    const value = Number.isFinite(seconds) ? agencyClock(new Date(seconds * 1000).toISOString(), context.timezone) : null
    return value ? `${value.date} ${value.time} ${value.zoneLabel}` : null
  }
  const diagnosis = preparedDiagnosis || diagnoseNetwork(context, state)
  const names = ids => ids.map(id => ({ id, name: context.routeIndex.get(id)?.short_name || context.routeIndex.get(id)?.long_name || id }))
  const areaRoutes = new Set(selectedRoutes)
  const relevant = diagnosis.routes.filter(route => (!routeSet.size || routeSet.has(route.id)) && (!stopSet.size && !scope.tripId && !scope.vehicleIds.length || areaRoutes.has(route.id)))
  const ordered = relevant.sort((a, b) => b.cancelledTrips - a.cancelledTrips || b.delaySeconds - a.delaySeconds)
  const nextByTrip = new Map()
  for (const row of selected) {
    const key = tripInstance(row)
    if (!nextByTrip.has(key) || row.predictedTime < nextByTrip.get(key).predictedTime) nextByTrip.set(key, row)
  }
  const uniqueTrips = [...nextByTrip.values()].sort((a, b) => b.delaySeconds - a.delaySeconds)
  const intervals = (state.measurements?.intervals ?? []).filter(row => (!routeSet.size || routeSet.has(row.routeId)) && (!stopSet.size || stopSet.has(row.stopId))
    && (!scope.tripId || row.tripIds.includes(scope.tripId)) && (!scope.vehicleIds.length || row.tripIds.some(id => reports.some(report => report.tripId === id))))
    .sort((a, b) => (b.predictedSeconds - b.scheduledSeconds) - (a.predictedSeconds - a.scheduledSeconds))
  const counts = new Map()
  const pairs = intervals.filter(row => {
    const key = JSON.stringify([row.routeId, row.directionId, row.serviceDate, row.tripIds])
    if (counts.has(key)) { counts.get(key).add(row.stopId); return false }
    counts.set(key, new Set([row.stopId])); return true
  })
  // Retain both spacing extremes: a list of only the widest gaps hides the
  // following close pairs that a bunching investigation needs to compare.
  const intervalExamples = [...new Set([...pairs.slice(0, 3), ...pairs.slice(-3).reverse()])]
  const feeds = feedStates(snapshot, now, state.policy)
  const freshVehicles = (snapshot?.vehicles ?? []).filter(vehicle => feeds.some(feed => feed.sourceUrl === vehicle.sourceUrl && feed.kind === 'vehicles' && feed.status === 'fresh')
    && Number.isFinite(vehicle.timestamp) && Math.abs(now - vehicle.timestamp) <= state.policy.freshnessSeconds)
  const vehicleRows = freshVehicles.flatMap(vehicle => {
    const match = context.matchTripIdentity(vehicle, state.coverage.serviceDate)
    if (!match.trip || !tripSelected({ routeId: match.trip.route_id, tripId: match.trip.trip_id, vehicleId: vehicle.id }) || stopSet.size && !stopSet.has(vehicle.stopId)) return []
    return [{ vehicle: vehicle.label || vehicle.id, vehicleId: vehicle.id, route: names([match.trip.route_id])[0].name, tripId: match.trip.trip_id, at: clock(vehicle.timestamp), stop: context.stopIndex.get(vehicle.stopId)?.name,
      occupancy: vehicle.occupancyStatus ?? null }]
  })
  const selectedStopIds = scope.stopIds.length ? scope.stopIds : [...new Set(uniqueTrips.slice(0, 6).map(row => row.stopId))]
  const noticeStops = alertStopIds(context, stopSet)
  const alerts = state.events.filter(event => event.type === 'service-alert' && (allNetwork
    || (areaRoutes.size || stopSet.size || scope.tripId) && [...(areaRoutes.size ? areaRoutes : [undefined])].some(routeId => alertInScope(event, { routeId, stopIds: noticeStops, tripId: scope.tripId }))))
  const reportByKey = new Map(reports.map(row => [tripInstance(row), row]))
  const epochs = new Map()
  const epochFor = date => { if (!epochs.has(date)) epochs.set(date, serviceEpoch(date, context.timezone)); return epochs.get(date) }
  const horizons = (args.horizonMinutes ? [args.horizonMinutes] : [30, 60, 90]).map(horizon => {
    const scheduled = scheduledServiceWindow(context, now, now + horizon * 60).trips.filter(row => reportByKey.get(row.key)?.status !== 'deleted').filter(row => tripSelected({ ...row, vehicleId: reportByKey.get(row.key)?.vehicleId }))
      .filter(row => !stopSet.size || context.tripDepartures(row.tripId).some(call => stopSet.has(call.from_stop_id) && epochFor(row.serviceDate) + call.departure >= now && epochFor(row.serviceDate) + call.departure < now + horizon * 60
        || stopSet.has(call.to_stop_id) && epochFor(row.serviceDate) + call.arrival >= now && epochFor(row.serviceDate) + call.arrival < now + horizon * 60))
    return { minutes: horizon, through: clock(now + horizon * 60), scheduledTrips: scheduled.length,
      reportedCancelled: scheduled.filter(row => reportByKey.get(row.key)?.status === 'cancelled').length,
      withoutMatchedReport: scheduled.filter(row => !reportByKey.has(row.key) || reportByKey.get(row.key).status === 'unresolved').length }
  })
  return {
    aspect,
    scope: { routes: names(selectedRoutes), stops: scope.stopIds.map(id => ({ id, name: context.stopIndex.get(id)?.name })), tripId: scope.tripId, vehicleId: args.vehicleId, allNetwork },
    asOf: clock(now), predictionWindowMinutes: state.policy.windowMinutes, requestedHorizonMinutes: args.horizonMinutes,
    serviceContext: diagnosis.serviceContext, scheduledServiceSummary: serviceContextNarrative(diagnosis),
    coverage: { ...diagnosis.coverage, feeds: feeds.map(({ kind, status, ageSeconds }) => ({ kind, status, ageSeconds })) },
    network: { ...diagnosis.network, measuredRoutes: diagnosis.coverage.measuredRoutes, routesWithLatePredictions: diagnosis.routes.filter(route => route.laterTrips).length },
    routes: ordered.slice(0, 8).map(route => ({ route: route.name, id: route.id, scope: 'whole route within the prediction window', scheduledTrips: route.scheduledTrips,
      reportingTrips: route.measuredTrips, laterTrips: route.laterTrips, matchingTrips: route.matchingTrips, cancelledTrips: route.cancelledTrips,
      patterns: route.patterns, maxDelayMinutes: minutes(route.maxDelaySeconds), widerPairs: route.widerPairs, closerPairs: route.closerPairs })), totalRoutes: relevant.length,
    concentrations: diagnosis.concentrations.filter(area => allNetwork || area.routeIds.some(id => areaRoutes.has(id))).filter(area => !stopSet.size || area.stopIds.some(id => stopSet.has(id))).slice(0, 3)
      .map(area => ({ place: area.name, routes: names(area.routeIds), tripCount: area.tripCount, maxDelayMinutes: minutes(area.maxDelaySeconds), stopIds: area.stopIds })),
    trips: uniqueTrips.slice(0, 6).map(row => ({ route: names([row.routeId])[0].name, tripId: row.tripId, vehicleId: row.vehicleId,
      stop: context.stopIndex.get(row.stopId)?.name, scheduled: clock(row.scheduledTime), predicted: clock(row.predictedTime), delayMinutes: minutes(row.delaySeconds),
      retainedReports: (state.tripHistory?.[`${row.tripId}/${row.serviceDate}`] ?? []).filter(point => Date.parse(point.at) <= now * 1000 && Date.parse(point.at) >= (now - state.policy.historyMinutes * 60) * 1000).slice(-6)
        .map(point => ({ at: clock(Date.parse(point.at) / 1000), stop: context.stopIndex.get(point.stopId)?.name, delayMinutes: minutes(point.delaySeconds) })) })), totalReportingTrips: uniqueTrips.length,
    intervals: intervalExamples.map(row => ({ route: names([row.routeId])[0].name, direction: row.directionId, stop: context.stopIndex.get(row.stopId)?.name,
      scheduledMinutes: minutes(row.scheduledSeconds), predictedMinutes: minutes(row.predictedSeconds), tripIds: row.tripIds,
      comparedStops: counts.get(JSON.stringify([row.routeId, row.directionId, row.serviceDate, row.tripIds])).size })), totalIntervalPairs: pairs.length,
    notices: alerts.slice(0, 6).map(event => ({ title: event.title, description: event.evidence.alertDescription, routes: names(event.routeIds || []), stops: event.stopIds?.map(id => context.stopIndex.get(id)?.name),
      scopeDescription: event.scopeDescription, selectors: event.selectors, effect: event.evidence.alertEffect, cause: event.evidence.alertCause, noticeDisplayPeriod: event.evidence.activePeriods?.map(period => ({ from: clock(period.start), to: clock(period.end) })), periodMeaning: 'Notice validity only; not incident onset or a recovery promise.' })), totalNotices: alerts.length,
    vehicles: vehicleRows.filter(row => row.occupancy || scope.vehicleIds.length || scope.tripId).slice(0, 6), freshVehicleReports: vehicleRows.length,
    progression: selectedRoutes.length && selectedStopIds.length ? await inspectService({ context, state, snapshot, directory }, { routeIds: selectedRoutes, stopIds: selectedStopIds, tripId: scope.tripId, vehicleIds: scope.vehicleIds, aspect: 'prediction_progression' }) : null,
    outlook: horizons,
    limits: ['Route and network totals retain their explicit scope; selected-stop evidence does not describe every stop.',
      'Spacing is between two predicted departures, not a measured wait for every rider. A wider gap increases possible waiting and accumulation; passenger counts and loads are not inferred.',
      'Outlook counts scheduled work, not forecasts. Trips without a report, especially future trips, are not missing vehicles or failed pull-outs.',
      'Retained reports track predictions, not actual passages or incident onset. No dispatch, crew, vehicle fitness, passenger counts, calibrated recovery forecast or live intervention simulation is connected.',
      'Notices establish only their stated cause, scope and period. Access notices do not explain vehicle running delays.'],
  }
}

// Model-facing facts attach the measurement, scope and interpretation limit to
// each value. Full structured data remain in the saved technical record.
export function inspectionFacts(data) {
  if (!data.routes) return data.notices ? { ...data, notices: data.notices.map(notice => ({ ...notice,
    activePeriods: notice.activePeriods?.map(period => Object.fromEntries(['start', 'end'].map(key => [key,
      Number.isFinite(period[key]) ? agencyClock(new Date(period[key] * 1000).toISOString(), data.timezone) : null]))),
    periodMeaning: 'Notice display periods in the agency timezone, not incident onset or recovery time.',
  })) } : data
  const n = data.network, c = data.coverage
  const facts = [
    ...(data.scope.allNetwork ? [
      ...(data.scheduledServiceSummary ? [data.scheduledServiceSummary] : []),
      `Whole-network context: ${n.measuredTrips} trips on ${n.measuredRoutes} routes have comparable next-departure predictions; ${n.laterTrips} trips on ${n.routesWithLatePredictions} routes are later than scheduled, ${n.matchingTrips} match schedule. These comparisons do not establish actual passages or unreported service.`,
      `In the next ${data.predictionWindowMinutes} minutes, ${c.reportingScheduledTrips} of ${c.scheduledTrips} scheduled trip instances have matching reports; ${c.unknownTrips} are unreported. This is reporting coverage, not service health.`,
      'Only trips with scheduled work in the assessment window belong in missing-service comparisons. The local hour alone does not establish whether service is scheduled.',
    ] : []),
    ...data.routes.map(route => `Route ${route.route}, whole-route comparison: ${route.reportingTrips} reporting trips; ${route.laterTrips} later, ${route.matchingTrips} matching timetable; ${route.cancelledTrips} cancellations in the assessment window. Maximum predicted departure delay ${route.maxDelayMinutes ?? 'unknown'} minutes. ${route.widerPairs} distinct departure pairs are farther apart than scheduled; ${route.closerPairs} closer together. This covers reporting trips only.`),
    ...data.concentrations.map(area => `${area.place}: overlapping late predictions on shared directed stop connections involve routes ${area.routes.map(route => route.name).join(', ')}, ${area.tripCount} trips; maximum predicted delay ${area.maxDelayMinutes} minutes. Geographic overlap does not establish a shared cause.`),
    ...data.intervals.map(pair => `Route ${pair.route}, direction ${pair.direction}, ${pair.stop}: two departures are predicted ${pair.predictedMinutes} minutes apart, scheduled ${pair.scheduledMinutes} minutes apart (${pair.predictedMinutes > pair.scheduledMinutes ? 'wider' : pair.predictedMinutes < pair.scheduledMinutes ? 'closer' : 'same'} spacing). The same pair is compared at ${pair.comparedStops} stops; those are not independent vehicle pairs.`),
    ...data.notices.map(notice => `Agency notice for ${notice.scopeDescription || notice.routes.map(route => route.name).join(', ') || 'the stated stops'}: ${notice.title}. ${(notice.description || '').slice(0, 1200)} Effect: ${notice.effect}; reported cause: ${notice.cause || 'unspecified'}. Validity dates are not onset or recovery evidence. This does not establish the cause of every trip delay or a shared cause on other routes.`),
    ...(!data.scope.allNetwork ? data.trips : []).map(trip => `Vehicle ${trip.vehicleId || 'not identified'}, route ${trip.route}: next compared DEPARTURE at ${trip.stop}, scheduled ${trip.scheduled}, predicted ${trip.predicted} (${trip.delayMinutes} minutes deviation). ${trip.retainedReports.length ? `Retained prediction reports: ${trip.retainedReports.map(row => `${row.at}, ${row.stop}, ${row.delayMinutes} minutes delay`).join('; ')}. These are changes in forecasts, not observed progression or incident onset.` : 'No retained prediction history is supplied for this trip.'}`),
    ...data.vehicles.filter(vehicle => vehicle.occupancy).map(vehicle => `Vehicle ${vehicle.vehicle}, route ${vehicle.route}, reports occupancy ${vehicle.occupancy} at ${vehicle.at}. This is a vehicle occupancy category, not APC passenger counts or a demand diagnosis.`),
    ...(data.aspect === 'outlook' || data.requestedHorizonMinutes !== undefined ? data.outlook : []).map(row => `Schedule exposure through ${row.through} (${row.minutes} minutes): ${row.scheduledTrips} scheduled trips, ${row.reportedCancelled} reported cancelled, ${row.withoutMatchedReport} without a matching report. A future trip need not report yet; this is NOT a forecast of missing pull-outs or service recovery.`),
  ]
  return { scope: data.scope, asOf: data.asOf,
    servicePattern: { routesWithLatePredictions: data.routes.filter(route => route.laterTrips).map(route => route.route),
      routesWhoseReportingTripsMatchSchedule: data.routes.filter(route => route.reportingTrips > 0 && route.matchingTrips === route.reportingTrips).map(route => route.route),
      reportedCancellations: data.routes.filter(route => route.cancelledTrips).map(route => ({ route: route.route, trips: route.cancelledTrips })),
      agencyCauseScope: data.notices.map(notice => ({ routes: notice.routes.map(route => route.name), effect: notice.effect, cause: notice.cause })),
      meaning: 'These are the returned routes, not unreported or omitted routes. A cause reported for one route cannot be extended to the other late routes.' }, facts,
    feeds: c.feeds, freshVehicleReportsInScope: data.freshVehicleReports,
    moreDetail: { routesOmitted: data.totalRoutes - data.routes.length, tripsOmitted: data.scope.allNetwork ? data.totalReportingTrips : data.totalReportingTrips - data.trips.length, noticesOmitted: data.totalNotices - data.notices.length,
      intervalPairsOmitted: data.totalIntervalPairs - data.intervals.length, noticesShortened: data.notices.filter(notice => notice.description?.length > 1200).length },
    progression: !data.scope.allNetwork ? data.progression : undefined, limits: data.limits }
}
