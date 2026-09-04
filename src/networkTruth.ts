import type { FeedSummary, MapPreview, RouteMetric, ScheduledTrip, StopMetric } from './domain'

type ScopedEntity = {
  feedId: string
  localId: string
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
