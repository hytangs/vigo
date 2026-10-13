import { scenarioReachedAreaKm2, scenarioReachablePixels, type ReachResult, type ScenarioSurface } from '../reach'

/** A missing exact cutoff is unknown, even if a longer window reached stops. */
export function reachTransitStops(result: ReachResult, surface: ScenarioSurface, cutoffMinutes: number): number | null {
  if (result.diagnostics.preliminary) return null
  const entries = surface === 'baseline' ? result.summary.transitStopsByCutoff
    : result.summary.scenarioTransitStopsByCutoff ?? result.summary.transitStopsByCutoff
  const count = entries?.find(entry => entry.cutoffMinutes === cutoffMinutes)?.stops
  return typeof count === 'number' && Number.isFinite(count) ? count : null
}

export function reachResultMetrics(result: ReachResult, surface: ScenarioSurface, cutoffMinutes: number) {
  return {
    reachableCells: scenarioReachablePixels(result, surface, cutoffMinutes),
    areaKm2: scenarioReachedAreaKm2(result, surface, cutoffMinutes),
    transitStops: reachTransitStops(result, surface, cutoffMinutes),
    areaSource: result.surface.areaMetrics?.[surface].byCutoff.some(entry => entry.cutoffMinutes === cutoffMinutes)
      ? 'cutoff-area-metric' : 'display-raster',
    totalProcessingMs: typeof result.diagnostics.totalMs === 'number' && Number.isFinite(result.diagnostics.totalMs)
      ? result.diagnostics.totalMs : null,
  }
}

export function reachResultsComparable(reference: ReachResult, result: ReachResult, cutoffMinutes: number) {
  const settings = ({ request }: ReachResult) => [request.origin.coordinate, request.serviceDate, request.departMinutes,
    request.mode ?? 'transit', request.surfaceSampling ?? 'street', request.maxWalkKm,
    request.walkSpeedKph ?? 4.8, request.maxTransfers ?? null]
  return !reference.diagnostics.preliminary && !result.diagnostics.preliminary
    && cutoffMinutes <= reference.summary.maximumCutoffMinutes && cutoffMinutes <= result.summary.maximumCutoffMinutes
    && JSON.stringify(settings(reference)) === JSON.stringify(settings(result))
}

function metricDifference(baseline: ReturnType<typeof reachResultMetrics>, comparison: ReturnType<typeof reachResultMetrics>) {
  return {
    areaKm2: comparison.areaKm2 - baseline.areaKm2,
    transitStops: baseline.transitStops === null || comparison.transitStops === null ? null
      : comparison.transitStops - baseline.transitStops,
  }
}

export function reachScenarioDifference(result: ReachResult, cutoffMinutes: number) {
  if (result.diagnostics.preliminary || cutoffMinutes > result.summary.maximumCutoffMinutes) return null
  return metricDifference(reachResultMetrics(result, 'baseline', cutoffMinutes), reachResultMetrics(result, 'scenario', cutoffMinutes))
}

/** Compare sampled area and stops. Cell counts can use different grids. */
export function reachResultDifference(reference: ReachResult, result: ReachResult, cutoffMinutes: number) {
  if (!reachResultsComparable(reference, result, cutoffMinutes)) return null
  const baseline = reachResultMetrics(reference, 'baseline', cutoffMinutes)
  const comparison = reachResultMetrics(result, 'baseline', cutoffMinutes)
  return metricDifference(baseline, comparison)
}
