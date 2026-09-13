// Resolve user-supplied names once, inside the routing tool. The model does not
// need separate turns to copy coordinates between lookup and routing calls.
export async function resolveJourneyPoints(context, places, args, signal) {
  const sources = new Set(), resolved = []
  const inputs = [args.origin, ...(args.waypoints ?? []), args.destination].filter(Boolean)
  const points = await Promise.all(inputs.map(async (value, index) => {
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
      const result = await places.search({ query: value.placeQuery }, signal)
      if (result.matches.length !== 1) throw Object.assign(new Error(result.matches.length
        ? `Which address do you mean by “${value.placeQuery}”?`
        : `OpenStreetMap could not resolve “${value.placeQuery}”. This does not mean the place does not exist. Verify its street address from an available public source, then route to that address.`), { details: { endpoint: index, matches: result.matches } })
      place = result.matches[0]
    }
    if (value.placeId && !place) throw new Error('Search for the place before routing.')
    const location = stop || place || value
    if (!Number.isFinite(location.lat) || !Number.isFinite(location.lon)) throw new Error('Supply a stop name, place search, resolved ID, or both latitude and longitude.')
    if (stop) sources.add('GTFS Static · indexed stop locations')
    if (place) { sources.add('Photon · © OpenStreetMap contributors'); sources.add(place.sourceUrl) }
    const label = stop?.name || place?.label || value.label?.trim() || 'Map point'
    resolved[index] = { label, ...(stop ? { stopId: stop.stop_id } : place ? { placeId: place.id, address: place.address } : {}) }
    return { coordinate: [location.lon, location.lat], label, source: stop ? 'stop' : place ? 'search' : 'map', ...(stop ? { stopId: stop.stop_id } : {}) }
  }))
  return { origin: points[0], ...(args.destination ? { destination: points.at(-1), waypoints: points.slice(1, -1) } : {}), resolved, sources: [...sources] }
}
