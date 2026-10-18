import type { LngLat, MapPreview } from '../domain'

export type MapViewportBounds = [LngLat, LngLat]
export type MapFitPadding = { top: number; right: number; bottom: number; left: number }

/** Camera context is independent of whether transit stops are drawn. */
export function previewStopBounds(preview: Pick<MapPreview, 'stops'>): MapViewportBounds | null {
  const longitude: number[] = []
  const latitude: number[] = []
  for (const stop of preview.stops) {
    if (typeof stop.lon !== 'number' || typeof stop.lat !== 'number'
      || !Number.isFinite(stop.lon) || !Number.isFinite(stop.lat)
      || stop.lon < -180 || stop.lon > 180 || stop.lat < -90 || stop.lat > 90) continue
    longitude.push(stop.lon)
    latitude.push(stop.lat)
  }
  if (!longitude.length) return null

  // Match the map's network fit: isolated distant stops should not pull a
  // large city's initial camera away from its service area.
  longitude.sort((left, right) => left - right)
  latitude.sort((left, right) => left - right)
  const trim = longitude.length >= 500 ? Math.floor(longitude.length * 0.02) : 0
  return [
    [longitude[trim], latitude[trim]],
    [longitude[longitude.length - trim - 1], latitude[latitude.length - trim - 1]],
  ]
}

/** Preserve room for map controls while leaving at least 60% of either axis. */
export function mapFitPadding(width: number, height: number): MapFitPadding {
  const availableWidth = Number.isFinite(width) ? Math.max(0, width) : 0
  const availableHeight = Number.isFinite(height) ? Math.max(0, height) : 0
  const preferred = availableWidth >= 900 && availableHeight >= 640
    ? { top: 56, right: 58, bottom: 118, left: 58 }
    : availableWidth >= 640
      ? { top: 72, right: 72, bottom: 138, left: 72 }
      : { top: 86, right: 54, bottom: 142, left: 54 }
  const horizontalScale = Math.min(1, availableWidth * 0.4 / (preferred.left + preferred.right))
  const verticalScale = Math.min(1, availableHeight * 0.4 / (preferred.top + preferred.bottom))
  return {
    top: preferred.top * verticalScale,
    right: preferred.right * horizontalScale,
    bottom: preferred.bottom * verticalScale,
    left: preferred.left * horizontalScale,
  }
}

/**
 * Floating panels cover part of a full-bleed map. Measure elements marked
 * `data-map-occluder` against the map container so the camera frames content
 * in the visible remainder. Overlays that would leave less than 40% of the
 * width (narrow windows) are ignored: there the panel stacks above the map.
 */
export function mapOcclusion(container: Element): MapFitPadding {
  const area = container.getBoundingClientRect()
  const occlusion = { top: 0, right: 0, bottom: 0, left: 0 }
  if (!area.width || !area.height) return occlusion
  for (const element of container.ownerDocument.querySelectorAll('[data-map-occluder]')) {
    const box = element.getBoundingClientRect()
    if (!box.width || !box.height || box.right <= area.left || box.left >= area.right
      || box.bottom <= area.top || box.top >= area.bottom) continue
    if (box.left - area.left <= area.right - box.right) occlusion.left = Math.max(occlusion.left, box.right - area.left)
    else occlusion.right = Math.max(occlusion.right, area.right - box.left)
  }
  return occlusion.left + occlusion.right > area.width * 0.6 ? { top: 0, right: 0, bottom: 0, left: 0 } : occlusion
}

export function occludedMapFitPadding(width: number, height: number, occlusion: MapFitPadding): MapFitPadding {
  const base = mapFitPadding(Math.max(0, width - occlusion.left - occlusion.right), Math.max(0, height - occlusion.top - occlusion.bottom))
  return {
    top: base.top + occlusion.top,
    right: base.right + occlusion.right,
    bottom: base.bottom + occlusion.bottom,
    left: base.left + occlusion.left,
  }
}

/** Shift a camera target so it lands in the middle of the visible map area. */
export function occlusionCenterOffset(occlusion: MapFitPadding): [number, number] {
  return [(occlusion.left - occlusion.right) / 2, (occlusion.top - occlusion.bottom) / 2]
}
