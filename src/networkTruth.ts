import type { FeedSummary, MapPreview, RouteMetric, ScheduledTrip, StopMetric } from './domain'

type ScopedEntity = {
  feedId: string
  localId: string
}

export type NetworkTruthReport = {
  tone: 'good' | 'watch' | 'risk'
  score: number
  title: string
  detail: string
  identityIssues: string[]
  feedScopes: string[]
  shapeBackedRoutes: number
  inferredRoutes: number
}

const scopeDelimiter = '::'

function parseScopedEntityId(value = ''): ScopedEntity {
  const splitIndex = value.indexOf(scopeDelimiter)
  if (splitIndex <= 0) return { feedId: '', localId: value }
  return {
    feedId: value.slice(0, splitIndex),
    localId: value.slice(splitIndex + scopeDelimiter.length),
  }
}

function scopedEntityId(feedId: string, localId = '') {
  const parsed = parseScopedEntityId(localId)
  if (parsed.feedId === feedId) return localId
  return `${feedId}${scopeDelimiter}${parsed.localId || 'unknown'}`
}

export function entityFeedScope(value = '') {
  return parseScopedEntityId(value).feedId
}

function entityLocalId(value = '') {
  return parseScopedEntityId(value).localId
}

export function scopedRouteGroupKey(route: RouteMetric) {
  const feedScope = entityFeedScope(route.id)
  return `${feedScope}:${route.routeId || route.shortName || entityLocalId(route.id)}`
}

function scopedStopRoutes(feedId: string, stop: StopMetric) {
  return stop.routes.map((routeId) => scopedEntityId(feedId, routeId))
}

function scopedScheduledTrips(feedId: string, route: RouteMetric, scopedRouteId: string): ScheduledTrip[] | undefined {
  return route.scheduledTrips?.map((trip) => ({
    ...trip,
    patternId: trip.patternId ? scopedEntityId(feedId, trip.patternId) : scopedRouteId,
    stopTimes: trip.stopTimes.map((stopTime) => ({
      ...stopTime,
      stopId: scopedEntityId(feedId, stopTime.stopId),
    })),
  }))
}

export function scopePreviewToFeed(feed: FeedSummary, preview: MapPreview): MapPreview {
  return {
    coverage: preview.coverage,
    routes: preview.routes.map((route) => {
      const scopedRouteId = scopedEntityId(feed.id, route.id)
      return {
        ...route,
        id: scopedRouteId,
        patternId: scopedEntityId(feed.id, route.patternId ?? route.id),
        shapeId: route.shapeId ? scopedEntityId(feed.id, route.shapeId) : undefined,
        stopIds: route.stopIds.map((stopId) => scopedEntityId(feed.id, stopId)),
        longName: `${feed.name} / ${route.longName}`,
        scheduledTrips: scopedScheduledTrips(feed.id, route, scopedRouteId),
      }
    }),
    stops: preview.stops.map((stop) => ({
      ...stop,
      id: scopedEntityId(feed.id, stop.id),
      routes: scopedStopRoutes(feed.id, stop),
      parentStationId: stop.parentStationId ? scopedEntityId(feed.id, stop.parentStationId) : undefined,
    })),
    stopPairs: (preview.stopPairs ?? []).map((pair) => ({
      ...pair,
      id: scopedEntityId(feed.id, pair.id),
      patternId: scopedEntityId(feed.id, pair.patternId),
      fromStopId: scopedEntityId(feed.id, pair.fromStopId),
      toStopId: scopedEntityId(feed.id, pair.toStopId),
    })),
    transferRules: preview.transferRules?.map((rule) => ({
      ...rule,
      fromStopId: scopedEntityId(feed.id, rule.fromStopId),
      toStopId: scopedEntityId(feed.id, rule.toStopId),
      fromRouteId: rule.fromRouteId ? scopedEntityId(feed.id, rule.fromRouteId) : undefined,
      toRouteId: rule.toRouteId ? scopedEntityId(feed.id, rule.toRouteId) : undefined,
      fromTripId: rule.fromTripId ? scopedEntityId(feed.id, rule.fromTripId) : undefined,
      toTripId: rule.toTripId ? scopedEntityId(feed.id, rule.toTripId) : undefined,
    })),
    pathways: preview.pathways?.map((pathway) => ({
      ...pathway,
      id: scopedEntityId(feed.id, pathway.id),
      fromStopId: scopedEntityId(feed.id, pathway.fromStopId),
      toStopId: scopedEntityId(feed.id, pathway.toStopId),
    })),
  }
}

function previewFeedScopes(preview: MapPreview) {
  return Array.from(new Set([
    ...preview.routes.map((route) => entityFeedScope(route.id)),
    ...preview.stops.map((stop) => entityFeedScope(stop.id)),
  ].filter(Boolean))).sort()
}

export function assertPreviewScopeIntegrity(preview: MapPreview) {
  const issues: string[] = []
  const routeIds = new Set(preview.routes.map((route) => route.id))
  const stopIds = new Set(preview.stops.map((stop) => stop.id))

  for (const route of preview.routes) {
    const routeScope = entityFeedScope(route.id)
    if (!routeScope) issues.push(`route ${route.id} is not feed-scoped`)
    if (route.patternId && entityFeedScope(route.patternId) !== routeScope) issues.push(`route ${route.id} has mismatched pattern scope`)

    for (const stopId of route.stopIds) {
      if (entityFeedScope(stopId) !== routeScope) issues.push(`route ${route.id} references out-of-scope stop ${stopId}`)
      if (!stopIds.has(stopId)) issues.push(`route ${route.id} references missing stop ${stopId}`)
    }
  }

  for (const stop of preview.stops) {
    const stopScope = entityFeedScope(stop.id)
    if (!stopScope) issues.push(`stop ${stop.id} is not feed-scoped`)
    for (const routeRef of stop.routes) {
      if (entityFeedScope(routeRef) !== stopScope) issues.push(`stop ${stop.id} references out-of-scope route ${routeRef}`)
    }
  }

  for (const pair of preview.stopPairs ?? []) {
    const pairScope = entityFeedScope(pair.id)
    if (!pairScope) issues.push(`stop pair ${pair.id} is not feed-scoped`)
    if (entityFeedScope(pair.patternId) !== pairScope) issues.push(`stop pair ${pair.id} has mismatched pattern scope`)
    if (entityFeedScope(pair.fromStopId) !== pairScope || entityFeedScope(pair.toStopId) !== pairScope) issues.push(`stop pair ${pair.id} crosses feed scope`)
    if (!routeIds.has(pair.patternId)) issues.push(`stop pair ${pair.id} references missing pattern ${pair.patternId}`)
    if (!stopIds.has(pair.fromStopId) || !stopIds.has(pair.toStopId)) issues.push(`stop pair ${pair.id} references missing stops`)
  }

  return issues
}

export function buildNetworkTruthReport(feed: FeedSummary, preview: MapPreview): NetworkTruthReport {
  const identityIssues = feed.source === 'bundle' ? assertPreviewScopeIntegrity(preview) : []
  const feedScopes = previewFeedScopes(preview)
  const inferredRoutes = preview.routes.filter((route) => route.geometrySource !== 'shape').length
  const shapeBackedRoutes = preview.routes.length - inferredRoutes
  const blockingWarnings = feed.warnings.filter((warning) => warning.severity === 'error').length
  const score = Math.max(0, Math.min(100, 100 - identityIssues.length * 24 - blockingWarnings * 12 - inferredRoutes * 2))
  const tone: NetworkTruthReport['tone'] = identityIssues.length || blockingWarnings ? 'risk' : inferredRoutes ? 'watch' : 'good'
  const title = identityIssues.length
    ? `${identityIssues.length} identity leak${identityIssues.length === 1 ? '' : 's'}`
    : feed.source === 'bundle'
      ? `${feedScopes.length} feed${feedScopes.length === 1 ? '' : 's'} isolated`
      : 'Feed isolated'
  const detail = identityIssues[0] ?? (
    inferredRoutes
      ? `${shapeBackedRoutes}/${preview.routes.length} patterns are shape-backed; inferred paths are capped.`
      : `${preview.routes.length} patterns pass feed scope and geometry gates.`
  )

  return {
    tone,
    score,
    title,
    detail,
    identityIssues,
    feedScopes,
    shapeBackedRoutes,
    inferredRoutes,
  }
}
