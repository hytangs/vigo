import { rawId, scopeOf } from './agencyContext.mjs'

const indexes = new WeakMap()
function entityIndex(context) {
  const cached = indexes.get(context)
  if (cached && cached.sizes.every((size, i) => size === [context.routes, context.stops, context.trips][i].length)) return cached
  const index = { sizes: [context.routes.length, context.stops.length, context.trips.length] }
  for (const [kind, rows, field] of [['route', context.routes, 'route_id'], ['stop', context.stops, 'stop_id'], ['trip', context.trips, 'trip_id']]) {
    if (kind === 'trip' && context.tripIndex) { index.trip = context.tripIndex; continue }
    index[kind] = new Map()
    for (const row of rows) {
      const id = rawId(row[field])
      if (!index[kind].has(id)) index[kind].set(id, [])
      index[kind].get(id).push(row)
    }
  }
  indexes.set(context, index)
  return index
}

// Keep each GTFS EntitySelector intact: AND within a selector, OR between
// selectors. Flattened IDs are useful for display, never for applicability.
export function alertSelectors(context, alert) {
  const index = entityIndex(context)
  const resolve = (kind, id) => {
    const field = `${kind}_id`
    const candidates = (index[kind].get(rawId(id)) ?? []).filter(row =>
      (!String(id).includes('\u001f') || row[field] === id) && (alert.sourceScope == null || scopeOf(row[field]) === alert.sourceScope))
    return candidates.length === 1 ? candidates[0] : null
  }
  let selectors = alert.informedEntities
  // Old retained snapshots may predate selector preservation. A single pair
  // is recoverable; multiple route/stop lists cannot reconstruct conjunctions.
  if (!selectors?.length) {
    const routes = alert.routeIds ?? [], stops = alert.stopIds ?? []
    selectors = routes.length <= 1 && stops.length <= 1 && routes.length + stops.length
      ? [{ routeId: routes[0], stopId: stops[0] }]
      : routes.length && !stops.length ? routes.map(routeId => ({ routeId }))
        : stops.length && !routes.length ? stops.map(stopId => ({ stopId })) : []
  }
  return selectors.map(selector => {
    const unresolved = []
    const route = selector.routeId ? resolve('route', selector.routeId) : null
    const stop = selector.stopId ? resolve('stop', selector.stopId) : null
    const trip = selector.trip?.tripId ? resolve('trip', selector.trip.tripId) : null
    if (Object.keys(selector).some(key => selector[key] != null && !['routeId', 'routeType', 'agencyId', 'directionId', 'trip', 'stopId'].includes(key))) unresolved.push('unsupported selector field')
    const scopes = new Set([route?.route_id, stop?.stop_id, trip?.trip_id].filter(Boolean).map(scopeOf))
    if (scopes.size > 1) unresolved.push('conflicting source scopes')
    if (selector.routeId && !route) unresolved.push('route')
    if (selector.stopId && !stop) unresolved.push('stop')
    if (selector.trip && (!trip || context.frequencyTrips?.has(trip.trip_id) || selector.trip.startTime)) unresolved.push('trip instance')
    if (selector.directionId != null && !selector.routeId) unresolved.push('direction without route')
    let routes = route ? [route] : trip ? [context.routeIndex.get(trip.route_id)] : selector.routeType != null || selector.agencyId ? context.routes : []
    if (!route && !trip && context.scopes.length > 1 && alert.sourceScope == null) unresolved.push('source feed')
    routes = routes.filter(Boolean).filter(row => alert.sourceScope == null || scopeOf(row.route_id) === alert.sourceScope)
    if (selector.agencyId && routes.some(row => row.agency_id == null)) unresolved.push('agency ownership unavailable')
    routes = routes.filter(row => (selector.routeType == null || row.route_type === selector.routeType)
      && (!selector.agencyId || rawId(row.agency_id) === selector.agencyId))
    if (trip && ((route && trip.route_id !== route.route_id) || (selector.directionId != null && selector.directionId !== trip.direction_id)
      || (selector.trip.routeId && rawId(trip.route_id) !== rawId(selector.trip.routeId))
      || (selector.trip.directionId != null && selector.trip.directionId !== trip.direction_id))) unresolved.push('conflicting trip constraints')
    if ((route || trip || selector.routeType != null || selector.agencyId) && !routes.length) unresolved.push('route constraints')
    if (!route && !stop && !trip && selector.routeType == null && !selector.agencyId) unresolved.push('empty selector')
    return { routeIds: routes.map(row => row.route_id), stopId: stop?.stop_id,
      directionId: selector.directionId ?? trip?.direction_id, tripId: trip?.trip_id,
      serviceDate: selector.trip?.startDate?.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
      sourceScope: alert.sourceScope, unresolved, selector }
  })
}

export function alertInScope(event, { routeId, stopIds, tripId, directionId, serviceDate } = {}) {
  const legacy = !event.selectors && !(event.routeIds?.length > 1 && event.stopIds?.length) && !(event.stopIds?.length > 1 && event.routeIds?.length)
    ? [{ routeIds: event.routeIds ?? (event.routeId ? [event.routeId] : []), stopId: event.stopId ?? event.stopIds?.[0], tripId: event.tripId, directionId: event.directionId, unresolved: [] }] : []
  return (event.selectors ?? legacy).some(selector => {
    if (selector.unresolved.length) return false
    if (routeId && !selector.routeIds.includes(routeId)) {
      // A stop-only notice can apply at that stop without being route-wide.
      if (selector.routeIds.length || !stopIds?.has(selector.stopId)) return false
      if (selector.sourceScope != null && scopeOf(routeId) !== selector.sourceScope) return false
    }
    if (stopIds && selector.stopId && !stopIds.has(selector.stopId)) return false
    if (stopIds && !selector.stopId && !routeId && !tripId) return false
    if (tripId && (selector.tripId ? selector.tripId !== tripId : !routeId)) return false
    if (directionId != null && selector.directionId != null && selector.directionId !== directionId) return false
    if (serviceDate && selector.serviceDate && selector.serviceDate !== serviceDate) return false
    return true
  })
}

// Human-readable scope follows the same selectors used by the matcher.
export function describeAlertScope(selectors, context) {
  return selectors.map(selector => {
    if (selector.unresolved.length) return 'Part of this notice has an unresolved scope.'
    const routes = selector.routeIds.map(id => context.routeIndex.get(id)?.short_name || context.routeIndex.get(id)?.long_name || rawId(id))
    return [routes.length ? `Route ${routes.join(', ')}` : '', selector.stopId ? `at ${context.stopIndex.get(selector.stopId)?.name || rawId(selector.stopId)}` : '',
      selector.directionId != null ? `direction ${selector.directionId}` : '', selector.tripId ? `trip ${rawId(selector.tripId)}` : '', selector.serviceDate || ''].filter(Boolean).join(' · ')
  }).filter(Boolean).join('; ')
}

export function alertStopIds(context, ids) {
  if (!ids?.size) return undefined
  return new Set([...ids].flatMap(id => {
    const parent = context.stopIndex.get(id)?.parent_station
    return parent ? [id, parent] : [id, ...(context.stops ?? []).filter(stop => stop.parent_station === id).map(stop => stop.stop_id)]
  }))
}
