import type { LngLat } from '../domain'
import type { ReachComparisonResult, ReachResult, ScenarioSurface } from '../reach'
import type { RoutingPoint } from '../routingModel'

export type ReachPointSample = { status: 'sampled'; minutes: number; estimatedBlock?: boolean } | { status: 'outside' | 'unsampled' }

export function reachPointSample(result: ReachResult, coordinate: LngLat, surface: ScenarioSurface): ReachPointSample {
  const raster = result.surface.raster
  const sample = sampleRaster(raster, raster[surface], coordinate)
  if (sample.status === 'sampled') return sample
  const blocks = result.surface.blockEstimates?.[surface]
  if (blocks) {
    const estimate = sampleRaster(blocks, blocks.values, coordinate)
    if (estimate.status === 'sampled') return { ...estimate, estimatedBlock: true }
  }
  return sample
}

function sampleRaster(raster: Pick<ReachResult['surface']['raster'], 'bounds' | 'width' | 'height' | 'scale' | 'nodata'>, encoded: string, coordinate: LngLat): ReachPointSample {
  const [west, south, east, north] = raster.bounds
  const [lon, lat] = coordinate
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return { status: 'unsampled' }
  if (lon < west || lon > east || lat < south || lat > north) return { status: 'outside' }
  if (!(east > west && north > south && raster.width > 0 && raster.height > 0 && raster.scale > 0)) return { status: 'unsampled' }
  const x = Math.min(raster.width - 1, Math.floor((lon - west) / (east - west) * raster.width))
  const y = Math.min(raster.height - 1, Math.floor((north - lat) / (north - south) * raster.height))
  // Decode only the two bytes for this cell, never another full raster copy.
  const byte = 2 * (y * raster.width + x), block = Math.floor(byte / 3), offset = byte % 3
  const bytes = atob(encoded.slice(block * 4, (block + 2) * 4))
  if (bytes.length < offset + 2) return { status: 'unsampled' }
  const value = bytes.charCodeAt(offset) | (bytes.charCodeAt(offset + 1) << 8)
  return value === raster.nodata ? { status: 'unsampled' } : { status: 'sampled', minutes: value / raster.scale }
}

export type ReachInspectionSource = { id: string; label: string; result: ReachResult; feedId?: string }

export function reachInspectionSources(result: ReachResult | null, comparison: ReachComparisonResult[] | null): ReachInspectionSource[] {
  return comparison?.length
    ? comparison.map(entry => ({ id: entry.feedId, label: entry.feedName, result: entry.result, feedId: entry.feedId }))
    : result ? [{ id: result.request.baselineIdentity, label: 'Scheduled service', result }] : []
}

export function reachHasServiceChanges(result: ReachResult) {
  const scenario = result.request.scenario
  return Boolean(scenario.serviceCount || scenario.excludedRouteCount || scenario.excludedTripCount || scenario.excludedPatternCount)
}

export function reachPointRouteRequest(source: ReachInspectionSource, destination: RoutingPoint, fallbackFeedId: string) {
  const request = source.result.request
  return {
    ...(request.feedIds?.length ? { feedIds: request.feedIds } : { feedId: source.feedId ?? fallbackFeedId }),
    origin: request.origin, destination,
    mode: request.mode ?? 'transit', routingDataMode: 'scheduled', timePreference: 'depart',
    departMinutes: request.departMinutes, serviceDate: request.serviceDate, serviceDay: request.serviceDay,
    maxWalkKm: request.maxWalkKm, maxTransfers: request.maxTransfers,
    allowServiceDateFallback: false, objective: 'earliest_arrival', departureWindowMinutes: 0,
    // The final-walk cap controls transit access, not an entire walking journey.
    // Let graph-verified direct walking compete with a slower transit detour.
    allowLongWalk: true, requireTransitRide: false,
    // Point routing's transfer graph uses the City's prepared walking speed.
    // Do not submit an unsupported speed or silently ignore a scenario overlay.
  }
}
