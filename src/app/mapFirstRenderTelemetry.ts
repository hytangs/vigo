import type { Basemap } from '../domain'

export type MapFirstRenderPhase =
  | 'features-prepared'
  | 'map-load'
  | 'local-source-render'
  | 'basemap-ready'
  | 'basemap-failed'

export type MapFirstRenderTracker = {
  key: string
  basemap: Basemap
  navigationStartedAt: number
  mapMountedAt: number
  featuresPreparedAt: number
  featureProcessingMs: number
  mapCreatedAt?: number
  mapLoadedAt?: number
  localSourceSubmittedAt?: number
  localSourceRenderedAt?: number
  basemapRequestedAt?: number
  basemapReadyAt?: number
  basemapFailedAt?: number
}

export type MapFirstRenderTimings = {
  navigationToMapMountMs: number
  featureProcessingMs: number
  mapLoadMs?: number
  localSourceRenderMs?: number
  localFirstPaintMs?: number
  basemapReadyMs?: number
  basemapAfterLocalMs?: number
}

function roundedDuration(start: number | undefined, end: number | undefined) {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
  return Number(Math.max(0, Number(end) - Number(start)).toFixed(3))
}

export function browserNavigationStart() {
  if (typeof performance === 'undefined') return 0
  const navigation = performance.getEntriesByType?.('navigation')?.[0]
  return Number.isFinite(navigation?.startTime) ? navigation.startTime : 0
}

export function createMapFirstRenderTracker(options: {
  key: string
  basemap: Basemap
  navigationStartedAt: number
  mapMountedAt: number
  featuresPreparedAt: number
}) {
  return {
    ...options,
    featureProcessingMs: roundedDuration(options.mapMountedAt, options.featuresPreparedAt) ?? 0,
  } satisfies MapFirstRenderTracker
}

export function markMapCreated(tracker: MapFirstRenderTracker, at: number) {
  if (tracker.mapCreatedAt !== undefined) return false
  tracker.mapCreatedAt = at
  return true
}

export function markMapLoaded(tracker: MapFirstRenderTracker, at: number) {
  if (tracker.mapLoadedAt !== undefined) return false
  tracker.mapLoadedAt = at
  return true
}

export function markLocalSourceSubmitted(tracker: MapFirstRenderTracker, at: number) {
  if (tracker.localSourceSubmittedAt !== undefined) return false
  tracker.localSourceSubmittedAt = at
  return true
}

export function markLocalSourceRendered(tracker: MapFirstRenderTracker, at: number) {
  if (tracker.localSourceRenderedAt !== undefined) return false
  tracker.localSourceRenderedAt = at
  return true
}

export function markBasemapRequested(tracker: MapFirstRenderTracker, basemap: Basemap, at: number) {
  if (tracker.basemap !== basemap) {
    tracker.basemap = basemap
    tracker.basemapRequestedAt = undefined
    tracker.basemapReadyAt = undefined
    tracker.basemapFailedAt = undefined
  }
  if (tracker.basemapRequestedAt !== undefined) return false
  tracker.basemapRequestedAt = at
  return true
}

export function markBasemapReady(tracker: MapFirstRenderTracker, at: number) {
  if (tracker.basemapReadyAt !== undefined) return false
  tracker.basemapReadyAt = at
  return true
}

export function markBasemapFailed(tracker: MapFirstRenderTracker, at: number) {
  if (tracker.basemapReadyAt !== undefined || tracker.basemapFailedAt !== undefined) return false
  tracker.basemapFailedAt = at
  return true
}

export function mapFirstRenderTimings(tracker: MapFirstRenderTracker): MapFirstRenderTimings {
  return {
    navigationToMapMountMs: roundedDuration(tracker.navigationStartedAt, tracker.mapMountedAt) ?? 0,
    featureProcessingMs: tracker.featureProcessingMs,
    mapLoadMs: roundedDuration(tracker.mapCreatedAt, tracker.mapLoadedAt),
    localSourceRenderMs: roundedDuration(tracker.localSourceSubmittedAt, tracker.localSourceRenderedAt),
    localFirstPaintMs: roundedDuration(tracker.navigationStartedAt, tracker.localSourceRenderedAt),
    basemapReadyMs: roundedDuration(tracker.basemapRequestedAt, tracker.basemapReadyAt),
    basemapAfterLocalMs: roundedDuration(tracker.localSourceRenderedAt, tracker.basemapReadyAt),
  }
}

export function basemapTelemetryStatus(tracker: MapFirstRenderTracker) {
  if (tracker.basemapFailedAt !== undefined) return 'failed' as const
  if (tracker.basemapReadyAt !== undefined) {
    return tracker.basemap === 'none' ? 'not-requested' as const : 'ready' as const
  }
  return tracker.basemapRequestedAt === undefined ? 'not-started' as const : 'pending' as const
}
