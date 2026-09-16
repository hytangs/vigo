import type { AgencyRoute, AgencyState, FeedState } from './types'

export type RouteBrowserFilter = 'all' | 'attention' | 'reporting'
export type RouteBrowserSort = 'name' | 'attention' | 'delay'
export type RouteBrowserFreshness = {
  predictions: boolean
  alerts: boolean
  label: string
  detail: string
  attentionRouteIds: ReadonlySet<string>
}

// Route counts are built from matched, fresh TripUpdates, while active alerts
// have their own source clock. A vehicle-position feed establishes neither.
export function routeBrowserFreshness(state: AgencyState, now = Date.now(), refreshFailed = false): RouteBrowserFreshness {
  const age = (now - Date.parse(state.generatedAt)) / 1000
  const window = state.policy.freshnessSeconds
  const currentSnapshot = !refreshFailed && state.connected && Number.isFinite(age) && Math.abs(age) <= window
  const isCurrent = (feed: FeedState) => {
    const feedAge = Number.isFinite(feed.feedTimestamp) ? now / 1000 - feed.feedTimestamp! : feed.ageSeconds === null ? NaN : feed.ageSeconds + age
    return feed.status === 'fresh' && Number.isFinite(feedAge) && Math.abs(feedAge) <= window
  }
  const sourceCurrent = (kind: string) => {
    const included = state.feeds.filter(feed => feed.kind === kind && feed.status === 'fresh')
    // Aggregate routes do not retain per-source counts. If a source used to
    // produce this snapshot expires, wait for a reassessment before ranking it.
    return currentSnapshot && included.length > 0 && included.every(isCurrent)
  }
  const predictions = state.coverage.valid && sourceCurrent('tripUpdates')
  const alerts = sourceCurrent('alerts')
  const attentionRouteIds = new Set<string>()
  if (predictions) {
    const legacyRoutes = new Set(state.routes.filter(route => route.serviceChanges === undefined).map(route => route.id))
    for (const route of state.routes) if ((route.serviceChanges ?? 0) > 0) attentionRouteIds.add(route.id)
    // Older saved snapshots lack route aggregates; use only their delivered
    // events as a fallback. New API rows stay independent of event selection.
    for (const event of state.events) {
      if (!['cancellation', 'skipped-stop', 'headway-review'].includes(event.type)) continue
      for (const id of event.routeIds ?? (event.routeId ? [event.routeId] : [])) if (legacyRoutes.has(id)) attentionRouteIds.add(id)
    }
  }
  const status = refreshFailed
    ? ['Refresh failed', 'Current route conditions are unavailable until the next successful refresh.']
    : !state.connected
      ? ['Timetable only', 'Connect live feeds to see trip reports and service alerts.']
      : predictions
        ? ['Live trip reports', 'Predicted departures cover reporting trips only. Missing reports do not establish on-time service.']
        : alerts
          ? ['Service alerts available', 'Current agency alerts are available; departure predictions are not.']
          : !state.coverage.valid
            ? ['Timetable needs attention', 'Current trip reports cannot be matched to this timetable.']
            : ['Live predictions unavailable', 'Live sources are missing, out of date or unverified. Route conditions are unknown.']
  return { predictions, alerts, label: status[0], detail: status[1], attentionRouteIds }
}

export function routeHasAttention(route: AgencyRoute, freshness: RouteBrowserFreshness): boolean {
  return (freshness.alerts && route.alerts > 0)
    || (freshness.predictions && ((route.reportingTrips > 0 && (route.headway === 'changed' || (route.maxDelaySeconds !== null && route.maxDelaySeconds > 0)))
      || freshness.attentionRouteIds.has(route.id)))
}

const nameOrder = (a: AgencyRoute, b: AgencyRoute) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.id.localeCompare(b.id)
const knownDelay = (route: AgencyRoute, freshness: RouteBrowserFreshness) => freshness.predictions && route.reportingTrips > 0 && Number.isFinite(route.maxDelaySeconds) ? route.maxDelaySeconds! : -Infinity

export function browseRoutes(routes: AgencyRoute[], { search = '', filter = 'all', sort = 'name', freshness }: {
  search?: string
  filter?: RouteBrowserFilter
  sort?: RouteBrowserSort
  freshness: RouteBrowserFreshness
}): AgencyRoute[] {
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return routes.filter(route => {
    const text = `${route.name} ${route.longName}`.toLocaleLowerCase()
    return terms.every(term => text.includes(term))
      && (filter !== 'attention' || routeHasAttention(route, freshness))
      && (filter !== 'reporting' || (freshness.predictions && route.reportingTrips > 0))
  }).sort((a, b) => {
    if (sort === 'attention') {
      const attention = Number(routeHasAttention(b, freshness)) - Number(routeHasAttention(a, freshness))
      if (attention) return attention
      const alerts = freshness.alerts ? b.alerts - a.alerts : 0
      if (alerts) return alerts
      const explicit = Number(freshness.attentionRouteIds.has(b.id)) - Number(freshness.attentionRouteIds.has(a.id))
      if (explicit) return explicit
    }
    if (sort === 'delay' || sort === 'attention') {
      const first = knownDelay(a, freshness)
      const second = knownDelay(b, freshness)
      if (first !== second) return second > first ? 1 : -1
      const spacing = freshness.predictions ? Number(b.headway === 'changed') - Number(a.headway === 'changed') : 0
      if (sort === 'attention' && spacing) return spacing
    }
    return nameOrder(a, b)
  })
}

export function routeDelayLabel(route: AgencyRoute, freshness: RouteBrowserFreshness): string | null {
  const seconds = knownDelay(route, freshness)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  const amount = seconds < 60 ? `${Math.ceil(seconds)} sec` : `${(seconds / 60).toFixed(1).replace(/\.0$/, '')} min`
  return `Up to ${amount} late`
}
