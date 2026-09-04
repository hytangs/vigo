import type { FeedSummary, MapPreview, RouteMetric, StopMetric, VigoProject } from '../domain'
import type { StopPairMetric } from '../domain'
import { routeServiceId } from '../routeServices'

export type GtfsRouteAnalysis = {
  schemaVersion: 'vigo.gtfs.route-analysis.v1'
  source: 'sqlite'
  representativeRouteId: string
  memberRouteIds: string[]
  serviceKey: string
  routes: RouteMetric[]
  stops: StopMetric[]
  stopPairs: StopPairMetric[]
  coverage: NonNullable<MapPreview['coverage']>
}

function localRouteServiceKey(route: RouteMetric) {
  return routeServiceId(route)
}

function replaceAnalyzedRouteGroup(source: RouteMetric[], analysis: GtfsRouteAnalysis) {
  const analysisKeys = new Set(analysis.routes.map(localRouteServiceKey))
  const next: RouteMetric[] = []
  let inserted = false
  for (const route of source) {
    if (!analysisKeys.has(localRouteServiceKey(route))) {
      next.push(route)
      continue
    }
    if (!inserted) {
      next.push(...analysis.routes)
      inserted = true
    }
  }
  if (!inserted) next.push(...analysis.routes)
  return next
}

function mergeAnalyzedStops(source: StopMetric[], analyzed: StopMetric[]) {
  const merged = new Map(source.map((stop) => [stop.id, stop]))
  for (const stop of analyzed) {
    const existing = merged.get(stop.id)
    merged.set(stop.id, existing ? {
      ...existing,
      ...stop,
      routes: [...new Set([...existing.routes, ...stop.routes])],
      tripCount: Math.max(existing.tripCount, stop.tripCount),
      transferScore: Math.max(existing.transferScore, stop.transferScore),
    } : stop)
  }
  return [...merged.values()]
}

function mergeFeedAnalysis(feed: FeedSummary, analysis: GtfsRouteAnalysis): FeedSummary {
  const mapPreview = feed.mapPreview ?? { routes: feed.routeMetrics, stops: feed.stopMetrics, stopPairs: [] }
  const focusedAnalysis: GtfsRouteAnalysis = {
    ...analysis,
    routes: analysis.routes.map((route) => ({ ...route, analysisSource: 'focused' })),
  }
  const routes = replaceAnalyzedRouteGroup(mapPreview.routes, focusedAnalysis)
  const stops = mergeAnalyzedStops(mapPreview.stops, analysis.stops)
  const analyzedPatternIds = new Set(focusedAnalysis.routes.map((route) => route.id))
  const stopPairs = [
    ...(mapPreview.stopPairs ?? []).filter((pair) => !analyzedPatternIds.has(pair.patternId)),
    ...focusedAnalysis.stopPairs,
  ]
  return {
    ...feed,
    routeMetrics: replaceAnalyzedRouteGroup(feed.routeMetrics ?? [], focusedAnalysis),
    stopMetrics: mergeAnalyzedStops(feed.stopMetrics ?? [], analysis.stops),
    mapPreview: {
      ...mapPreview,
      routes,
      stops,
      stopPairs,
      coverage: mapPreview.coverage ? {
        ...mapPreview.coverage,
        stopsIndexed: Math.max(mapPreview.coverage.stopsIndexed, stops.length),
        stopPairsIndexed: Math.max(mapPreview.coverage.stopPairsIndexed, stopPairs.length),
      } : analysis.coverage,
    },
  }
}

export function mergeGtfsRouteAnalysis(project: VigoProject, feedId: string, analysis: GtfsRouteAnalysis): VigoProject {
  return {
    ...project,
    feeds: project.feeds.map((feed) => feed.id === feedId ? mergeFeedAnalysis(feed, analysis) : feed),
  }
}

export function routeHasCompleteGtfsAnalysis(route: RouteMetric, preview: MapPreview, serviceDate = '') {
  return route.analysisSource === 'focused'
    && (!serviceDate || route.analysisServiceDate === serviceDate)
    && Array.isArray(route.scheduledTrips)
    && route.stopIds.length >= 2
    && (route.coordinates?.length ?? 0) >= 2
    && route.spanHours > 0
    && route.serviceVariantCount === preview.routes.filter((candidate) => localRouteServiceKey(candidate) === localRouteServiceKey(route)).length
}
