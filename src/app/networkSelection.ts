type RouteIdentity = { id: string; routeId?: string; patternId?: string }

/** Public service identity, independent of the currently drawn trip pattern. */
export function networkRouteId(route: RouteIdentity): string {
  const split = route.id.indexOf('::')
  const id = route.routeId || route.id
  return split > 0 && !id.includes('\u001f') ? `${route.id.slice(0, split)}::${id}` : id
}

function studioId(id: string): string { return id.replace('\u001f', '::') }

export function findNetworkRoute<T extends RouteIdentity>(routes: T[], id: string): T | undefined {
  const direct = routes.find(route => route.id === id || route.patternId === id)
  if (direct) return direct
  const scoped = routes.find(route => networkRouteId(route) === studioId(id))
  if (scoped) return scoped
  const matches = routes.filter(route => route.routeId === id)
  return new Set(matches.map(networkRouteId)).size === 1 ? matches[0] : undefined
}

export function findNetworkStop<T extends { id: string }>(stops: T[], id: string): T | undefined {
  const direct = stops.find(stop => stop.id === studioId(id))
  if (direct) return direct
  const matches = stops.filter(stop => stop.id.includes('::') && stop.id.slice(stop.id.indexOf('::') + 2) === id)
  return matches.length === 1 ? matches[0] : undefined
}
