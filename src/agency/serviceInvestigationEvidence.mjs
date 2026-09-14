import { tripInstance } from './serviceWindow.mjs'
import { feedStates } from './realtimeIntelligence.mjs'
import { readLampStudy } from './lampStudy.mjs'

const countTiming = rows => ({ trips: rows.length, late: rows.filter(row => row.delaySeconds > 0).length,
  maxDelayMinutes: rows.length ? Math.round(Math.max(...rows.map(row => row.delaySeconds)) / 60) : null })

export async function inspectService({ context, state, snapshot, directory }, { routeIds, stopIds = [], tripId, vehicleIds = [], aspect }) {
  if (!routeIds.every(id => context.routeIndex.has(id)) || !stopIds.every(id => context.stopIndex.has(id))) throw new Error('Choose routes and stops from this City.')
  const scope = new Set(routeIds), stops = new Set(stopIds)
  const measurements = state.measurements?.departures ?? []
  const selected = measurements.filter(row => scope.has(row.routeId) && (!tripId || row.tripId === tripId) && (!vehicleIds.length || vehicleIds.includes(row.vehicleId)))
  if (aspect === 'historical_runtime') return readLampStudy(directory, { routeIds, limit: 6 })
  if (aspect === 'alerts') {
    const feeds = state.feeds.filter(feed => feed.kind === 'alerts')
    const matches = state.events.filter(event => event.type === 'service-alert' && (event.routeIds?.some(id => scope.has(id)) || event.stopIds?.some(id => stops.has(id))))
    // These GTFS effects concern access or information, not vehicle operation.
    // Keep their count, but do not invite a model to use an elevator outage as
    // evidence explaining a running-time or departure-delay pattern.
    const operational = matches.filter(event => !['ACCESSIBILITY_ISSUE', 'NO_EFFECT'].includes(event.evidence.alertEffect))
    return { scope: { routeIds, stopIds, meaning: 'Notices matching the selected routes or stops. A notice elsewhere on the same route does not establish a problem at the selected station.' },
      sourceAvailable: Boolean(feeds.length && feeds.every(feed => feed.status === 'fresh')), matchingNotices: operational.length, otherNotices: matches.length - operational.length,
      notices: operational.slice(0, 8).map(event => ({ title: event.title, effect: event.evidence.alertEffect, cause: event.evidence.alertCause, routeIds: event.routeIds,
        stops: (event.stopIds ?? []).map(id => ({ id, name: context.stopIndex.get(id)?.name })), sourceRefs: event.sourceRefs, activePeriods: event.evidence.activePeriods })),
      limit: 'Notices describe only their stated location and period. They do not automatically explain every delay on an affected route.' }
  }
  if (aspect === 'surrounding_service') {
    const inside = new Map(), outside = new Map()
    for (const row of measurements) {
      const target = stops.has(row.stopId) || stops.has(row.toStopId) ? inside : outside
      const key = tripInstance(row)
      if (!target.has(key) || row.predictedTime < target.get(key).predictedTime) target.set(key, row)
    }
    return { areaDefined: Boolean(stops.size), inside: countTiming([...inside.values()]), outside: countTiming([...outside.values()].filter(row => !inside.has(tripInstance(row)))),
      routesAtSharedStops: [...new Set([...inside.values()].map(row => row.routeId))],
      limit: 'Inside means the selected exact GTFS stop connections, not an inferred neighborhood. These are future departure predictions, not measured vehicle speeds. A trip is counted once and is not in both groups.' }
  }
  if (aspect === 'prediction_progression') {
    const trips = new Map()
    for (const row of selected) { const key = tripInstance(row); if (!trips.has(key)) trips.set(key, []); trips.get(key).push(row) }
    const rows = [...trips.values()].flatMap(values => {
      values.sort((a, b) => a.sequence - b.sequence)
      const inside = stops.size ? values.filter(row => stops.has(row.stopId)) : values
      if (!inside.length) return []
      const first = inside[0], before = values.filter(row => row.sequence < first.sequence).at(-1), last = inside.at(-1)
      const now = Date.parse(state.generatedAt)
      const history = (state.tripHistory?.[`${first.tripId}/${first.serviceDate}`] ?? [])
        .filter(point => point.stopId === first.stopId && Date.parse(point.at) <= now && Date.parse(point.at) >= now - state.policy.historyMinutes * 60_000)
        .sort((a, b) => a.at.localeCompare(b.at))
      return [{ routeId: first.routeId, tripId: first.tripId, directionId: first.directionId,
        entryDelayMinutes: Math.round(first.delaySeconds / 60), upstreamDelayMinutes: before ? Math.round(before.delaySeconds / 60) : null,
        predictedChangeWithinAreaMinutes: inside.length > 1 ? Math.round((last.delaySeconds - first.delaySeconds) / 60) : null,
        distinctObservationTimes: new Set(history.map(point => point.at)).size,
        firstRetainedReport: history[0]?.at ?? null }]
    })
    return { trips: rows.slice(0, 12), totalTrips: rows.length,
      limit: 'A gradient between future stop predictions is not an observed increase after entering a corridor. First retained report is not incident onset. Missing upstream evidence is unknown. Recovery and actual dwell/speed are not established.' }
  }
  if (aspect === 'vehicle_reports') {
    const now = Date.parse(state.generatedAt) / 1000, feeds = feedStates(snapshot, now, state.policy)
    const freshSources = new Set(feeds.filter(feed => feed.kind === 'vehicles' && feed.status === 'fresh').map(feed => feed.sourceUrl))
    const positions = new Set()
    for (const vehicle of snapshot?.vehicles ?? []) {
      if (!freshSources.has(vehicle.sourceUrl) || !Number.isFinite(vehicle.timestamp) || Math.abs(now - vehicle.timestamp) > state.policy.freshnessSeconds) continue
      const match = context.matchTripIdentity(vehicle, state.coverage.serviceDate)
      if (match.trip) positions.add(JSON.stringify([match.trip.trip_id, match.serviceDate]))
    }
    const keys = new Set(selected.map(tripInstance))
    return { freshPositionSource: freshSources.size > 0, timedTripReports: keys.size, reportsWithFreshPosition: [...keys].filter(key => positions.has(key)).length,
      sourceStates: feeds.map(({ kind, status }) => ({ kind, status })),
      limit: 'Matching identity and fresh timestamps corroborate a reported trip, not the accuracy of its predictions. An absent position does not prove a data artifact or a cancelled trip.' }
  }
  throw new Error('Choose an installed service-evidence check.')
}
