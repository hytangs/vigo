// Studio previews and merged timetable stores use different feed delimiters.
// Translate only known feed scopes; never guess an agency from a bare GTFS ID.
export function indexedEntityId(context, kind, id, feedIds = []) {
  const index = kind === 'route' ? context.routeIndex : context.stopIndex
  const invalid = () => Object.assign(new Error(`Unknown ${kind}. Choose an exact ${kind} from this City’s timetable.`), { statusCode: 400 })
  if (typeof id !== 'string' || !id || id.length > 500) throw invalid()
  if (index.has(id)) return id
  const delimiter = id.indexOf('::')
  const feedId = id.slice(0, delimiter), localId = id.slice(delimiter + 2)
  if (delimiter > 0 && feedIds.includes(feedId)) {
    const scopedId = `${feedId}\u001f${localId}`
    if (index.has(scopedId)) return scopedId
    if (feedIds.length === 1 && context.scopes.length === 1 && context.scopes[0] === '' && index.has(localId)) return localId
  }
  throw invalid()
}

export function workspaceSelection(context, input = {}, feedIds = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['routeId', 'stopId'].includes(key))) {
    throw Object.assign(new Error('Select a route or station using its timetable ID.'), { statusCode: 400 })
  }
  const selection = {}
  if (input.routeId) {
    const id = indexedEntityId(context, 'route', input.routeId, feedIds)
    const route = context.routeIndex.get(id)
    selection.route = { id, name: route.short_name || route.long_name || id, description: route.long_name }
  }
  if (input.stopId) {
    const id = indexedEntityId(context, 'stop', input.stopId, feedIds)
    const stop = context.stopIndex.get(id)
    selection.stop = { id, name: stop.name, coordinate: [stop.lon, stop.lat] }
  }
  return selection
}

export function selectedStopIds(context, selection) {
  if (!selection.stop) return null
  const id = selection.stop.id
  const stop = context.stopIndex.get(id)
  return new Set([id, ...(stop.parent_station ? [stop.parent_station] : []), ...context.stops.filter(item => item.parent_station === id).map(item => item.stop_id)])
}

export function eventInSelection(event, selection, stopIds) {
  if (selection.route && event.routeId !== selection.route.id && !event.routeIds?.includes(selection.route.id)) return false
  if (!stopIds) return true
  if (stopIds.has(event.stopId) || event.stopIds?.some(id => stopIds.has(id))) return true
  // Route-wide alerts still apply when looking at a station on that route.
  return Boolean(selection.route && event.type === 'service-alert' && !event.stopId && !event.stopIds?.length)
}
