function selectionError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode })
}

// A group selects service sources within the existing City, never another copy
// of its GTFS files or street network. Missing input must not broaden a query.
export function cityCaseFeedIds(project, body) {
  if (body?.feedIds === undefined) return undefined
  if (body.feedId) throw selectionError('Use feedIds or feedId, not both.')
  if (!Array.isArray(body.feedIds) || !body.feedIds.length || body.feedIds.length > 256
    || body.feedIds.some(id => typeof id !== 'string' || !id.trim())) {
    throw selectionError('A case needs a nonempty feedIds array.')
  }
  const ids = [...new Set(body.feedIds)].sort()
  for (const id of ids) {
    const feed = project.feeds.find(candidate => candidate.id === id)
    if (!feed) throw selectionError('Every case timetable must belong to this City.')
    if (feed.routingStore?.status !== 'ready') throw selectionError(`Timetable ${feed.name} is not ready.`, 409)
  }
  return ids
}

export function assertCaseRouteSources(scenario, feedIds, merged = false) {
  if (!feedIds || !scenario) return
  for (const field of ['services', 'excludedRouteIds', 'excludedPatternIds']) {
    if (scenario[field] !== undefined && !Array.isArray(scenario[field])) throw selectionError(`scenario.${field} must be an array.`)
  }
  const routes = [
    ...(scenario.services ?? []).map(service => service?.sourceRouteId),
    ...(scenario.excludedRouteIds ?? []),
    ...(scenario.excludedPatternIds ?? []).map(pattern => pattern?.routeId),
  ].filter(Boolean)
  for (const route of routes) {
    const [scope, local] = String(route).split(/::|\u001f/, 2)
    if ((local !== undefined && !feedIds.includes(scope)) || (merged && local === undefined)) {
      throw selectionError('A service change refers to a timetable outside this case’s feed group. Choose a route from the group.')
    }
  }
}

export function selectedSourceScopes(store, request) {
  if (request?.sourceScopes === undefined) return null
  const values = request.sourceScopes
  if (!Array.isArray(values) || !values.length || values.some(scope => typeof scope !== 'string'
    || !store.sourceScopes.includes(scope))) throw selectionError('Unknown or empty timetable source selection.')
  const scopes = new Set(values)
  return scopes.size === store.sourceScopes.length ? null : scopes
}

export function serviceInSources(id, scopes) {
  return !scopes || scopes.has(String(id).split('\u001f', 1)[0])
}

export function scopedServiceResolution(store, resolution, request) {
  const scopes = selectedSourceScopes(store, request)
  if (!scopes) return resolution
  const services = new Set([...resolution.services].filter(id => serviceInSources(id, scopes)))
  const count = new Set([...services].map(id => id.split('\u001f', 1)[0])).size
  return { ...resolution, services, requestedServiceScopeCount: count,
    resolvedServiceScopeCount: count, availableServiceScopeCount: scopes.size }
}
