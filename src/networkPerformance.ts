import type { MapPreview } from './domain'

export type NetworkPerformanceMode = 'precision' | 'rapid' | 'atlas'

export type NetworkPerformanceProfile = {
  mode: NetworkPerformanceMode
  score: number
  title: string
  detail: string
  segmentPointBudget: number
  stopBudget: number
  transferStopBudget: number
  segmentBudget: number
  routeListWindowSize: number
  stats: {
    routes: number
    stops: number
    stopPairs: number
    trips: number
    routeShapePoints: number
  }
}

function routeShapePointCount(preview: MapPreview) {
  return preview.routes.reduce((sum, route) => sum + (route.coordinates?.length ?? route.stopIds.length ?? route.points.length), 0)
}

function routeTripCount(preview: MapPreview) {
  return preview.routes.reduce((sum, route) => sum + route.tripCount, 0)
}

function performanceScore(preview: MapPreview) {
  const routes = preview.routes.length
  const stops = preview.stops.length
  const stopPairs = preview.stopPairs?.length ?? 0
  const trips = routeTripCount(preview)
  const shapePoints = routeShapePointCount(preview)

  return Math.round(
    routes * 2.4 +
      stops * 0.12 +
      stopPairs * 0.34 +
      Math.min(900, shapePoints / 90) +
      Math.min(900, trips / 260),
  )
}

export function buildNetworkPerformanceProfile(preview: MapPreview, options: { precise?: boolean } = {}): NetworkPerformanceProfile {
  const stats = {
    routes: preview.routes.length,
    stops: preview.stops.length,
    stopPairs: preview.stopPairs?.length ?? 0,
    trips: routeTripCount(preview),
    routeShapePoints: routeShapePointCount(preview),
  }
  const score = performanceScore(preview)

  if (options.precise || stats.routes <= 4) {
    return {
      mode: 'precision',
      score,
      title: 'Precision',
      detail: 'Selected route renders at full inspection fidelity.',
      segmentPointBudget: 90,
      stopBudget: Number.POSITIVE_INFINITY,
      transferStopBudget: Number.POSITIVE_INFINITY,
      segmentBudget: Number.POSITIVE_INFINITY,
      routeListWindowSize: 80,
      stats,
    }
  }

  if (stats.routes > 1_200 || stats.stops > 12_000 || stats.stopPairs > 36_000 || score > 4_800) {
    return {
      mode: 'atlas',
      score,
      title: 'Atlas',
      detail: 'Complete network mode: every public service remains visible with SQLite-prepared linework.',
      segmentPointBudget: 28,
      stopBudget: Number.POSITIVE_INFINITY,
      transferStopBudget: Number.POSITIVE_INFINITY,
      segmentBudget: 560,
      routeListWindowSize: 44,
      stats,
    }
  }

  if (stats.routes > 280 || stats.stops > 3_200 || stats.stopPairs > 9_000 || score > 1_300) {
    return {
      mode: 'rapid',
      score,
      title: 'Rapid',
      detail: 'Dense feed mode: all services render with bounded points per line.',
      segmentPointBudget: 54,
      stopBudget: Number.POSITIVE_INFINITY,
      transferStopBudget: Number.POSITIVE_INFINITY,
      segmentBudget: 1_100,
      routeListWindowSize: 60,
      stats,
    }
  }

  return {
    mode: 'precision',
    score,
    title: 'Precision',
    detail: 'Network is small enough for full-detail drawing.',
    segmentPointBudget: 90,
    stopBudget: Number.POSITIVE_INFINITY,
    transferStopBudget: Number.POSITIVE_INFINITY,
    segmentBudget: Number.POSITIVE_INFINITY,
    routeListWindowSize: 80,
    stats,
  }
}
