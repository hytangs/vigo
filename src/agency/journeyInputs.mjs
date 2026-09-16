import { agencyClock } from './agencyClock.mjs'

export function journeyTime(args, generatedAt, timezone) {
  if (args.departTime && args.arriveBy) throw new Error('Use either a departure time or an arrival deadline, not both.')
  if (args.serviceDate && !args.departTime && !args.arriveBy) throw new Error('Supply a departure time or an arrival deadline for the selected date.')
  if (args.serviceDate) return args
  const clock = agencyClock(generatedAt, timezone)
  if (!clock) throw new Error('A current date and agency timezone are required to default the journey time.')
  return { ...args, serviceDate: clock.date, ...(!args.departTime && !args.arriveBy ? { departTime: clock.time } : {}) }
}

async function candidateIdentities(matches, places, signal) {
  return Promise.all(matches.map(async item => {
    if (item.category?.key !== 'aeroway' || item.category.value !== 'aerodrome' || !places.details) return item
    try {
      const details = await places.details(item.id, signal)
      const identifiers = Object.fromEntries(['iata', 'icao'].filter(key => details?.tags[key]).map(key => [key, details.tags[key]]))
      return { ...item, identifiers }
    } catch { signal?.throwIfAborted(); return item }
  }))
}

// Resolve user-supplied names once, inside the routing tool. The model does not
// need separate turns to copy coordinates between lookup and routing calls.
export async function resolveJourneyPoints(context, places, args, signal) {
  const sources = new Set(), resolved = []
  const inputs = [args.origin, ...(args.waypoints ?? []), args.destination].filter(Boolean)
  const results = await Promise.allSettled(inputs.map(async (value, index) => {
    if (typeof value === 'string') {
      if (!value.trim()) throw new Error('Supply a nonempty place name or address.')
      const match = context.resolve({ query: value, kind: 'stop' })
      const known = places?.named?.(value) ?? []
      value = context.stopIndex.has(value) ? { stopId: value } : value.startsWith('osm:') ? { placeId: value }
        : match.method === 'exact' && match.matches.length ? { stopName: value }
          : known.length === 1 ? { placeId: known[0].id } : { placeQuery: value }
    }
    const selectors = ['stopId', 'placeId', 'stopName', 'placeQuery'].filter((key) => value[key])
    if (selectors.length > 1) throw new Error('Choose one stop ID, place ID, stop name, or place search for each endpoint.')
    let stop = value.stopId ? context.stopIndex.get(value.stopId) : null
    if (value.stopId && !stop) throw new Error('Unknown stop ID. Resolve the indexed stop first.')
    if (value.stopName) {
      const result = context.resolve({ query: value.stopName, kind: 'stop' })
      if (result.matches.length !== 1) throw Object.assign(new Error(result.matches.length
        ? `Which stop do you mean by “${value.stopName}”?`
        : `No stop matches “${value.stopName}”. Retry the proper name alone, without generic words such as “station” or “stop”.`), { details: { endpoint: index, matches: result.matches.slice(0, 8) } })
      stop = context.stopIndex.get(result.matches[0].id)
    }
    let place = value.placeId ? places?.resolve(value.placeId) : null
    if (value.placeQuery) {
      if (!places) throw new Error('Place search is not available on this server.')
      const known = places.named?.(value.placeQuery) ?? []
      const result = known.length === 1 ? { matches: known } : await places.search({ query: value.placeQuery }, signal)
      if (result.matches.length !== 1) throw Object.assign(new Error(result.matches.length
        ? `Which address do you mean by “${value.placeQuery}”?`
        : `OpenStreetMap could not resolve “${value.placeQuery}”. This does not mean the place does not exist. Verify its street address from an available public source, then route to that address.`), { details: { endpoint: index, query: value.placeQuery, matches: await candidateIdentities(result.matches, places, signal),
          nextStep: 'Choose the mapped feature matching the requested place, then call the journey tool with its placeId. A similarly named parking lot, hotel or bus stop is a different feature. For a large site use a public entrance or passenger terminal, not the area centre. Ask only if the intended location remains ambiguous.' } })
      place = result.matches[0]
    }
    if (value.placeId && !place) throw new Error('Search for the place before routing.')
    if (place?.category?.key === 'aeroway' && place.category.value === 'aerodrome') {
      const candidates = await places.search({ query: place.name, osmTag: 'aeroway:terminal' }, signal)
      const passengerPoints = candidates.matches.filter(item => item.category?.key === 'aeroway' && item.category.value === 'terminal'
        || item.category?.key === 'highway' && item.category.value === 'bus_stop'
        || item.category?.key === 'public_transport' && ['platform', 'station'].includes(item.category.value)
        || item.category?.key === 'railway' && ['station', 'halt', 'tram_stop'].includes(item.category.value))
      throw Object.assign(new Error(`${place.name} identifies the airport area, not a passenger arrival point. Choose a terminal or public transit stop.`), { details: { endpoint: index, query: place.name,
        matches: passengerPoints,
        nextStep: 'Select the passenger terminal or transit stop from the returned coordinates. Ask which terminal if multiple passenger destinations remain plausible.' } })
    }
    const location = stop || place || value
    if (!Number.isFinite(location.lat) || !Number.isFinite(location.lon)) throw new Error('Supply a stop name, place search, resolved ID, or both latitude and longitude.')
    if (stop) sources.add('GTFS Static · indexed stop locations')
    if (place) { sources.add('Photon · © OpenStreetMap contributors'); sources.add(place.sourceUrl) }
    const label = stop?.name || place?.label || value.label?.trim() || 'Map point'
    resolved[index] = { label, lat: location.lat, lon: location.lon, ...(stop ? { stopId: stop.stop_id } : place ? { placeId: place.id, address: place.address } : {}) }
    return { coordinate: [location.lon, location.lat], label, source: stop ? 'stop' : place ? 'search' : 'map', ...(stop ? { stopId: stop.stop_id } : {}) }
  }))
  signal?.throwIfAborted()
  const failures = results.flatMap((result, endpoint) => result.status === 'rejected' ? [{ endpoint, error: result.reason.message, ...result.reason.details }] : [])
  if (failures.length) {
    const first = results.find(result => result.status === 'rejected').reason
    throw Object.assign(new Error(failures.map(failure => failure.error).join('\n')), { details: { ...first.details,
      ...(failures.every(failure => failure.matches?.some(item => Number.isFinite(item.lat) && Number.isFinite(item.lon))) ? { status: 'needs_location_choice' } : {}),
      endpoints: failures, resolved: resolved.flatMap((point, endpoint) => point ? [{ ...point, endpoint }] : []),
      nextStep: 'No journey has been calculated. Keep resolved endpoints and use the returned placeId or stopId candidates to calculate the requested journey now. Repeat only unresolved lookups; do not search again for information already returned. Ask a focused question only when candidate identity or the public entrance cannot be established.' } })
  }
  const points = results.map(result => result.value)
  return { origin: points[0], ...(args.destination ? { destination: points.at(-1), waypoints: points.slice(1, -1) } : {}), resolved, sources: [...sources] }
}
