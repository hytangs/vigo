import type { RoutingBikeOptions } from '../routingModel'

/** The largest half-width, in kilometres, of a square the server evaluates. */
export const maximumReachRadiusKm = 150

// The fastest a Reach can move in a straight line: driving at the 140 km/h cap
// on OSM road speeds; cycling at the profile speed with the steepest downhill
// gain (×1.24) and the 45 km/h cap. Endpoint walks are slower than either.
function topSpeedKph(mode: 'drive' | 'bike', bike: RoutingBikeOptions) {
  return mode === 'drive' ? 140 : Math.min(45, bike.speedKph * 1.24)
}

// Cells keep this size until the grid reaches its side limit, then grow.
// Cost follows the cell count. On Boston, 48 bicycle cells keep a 79-minute
// Reach within 1.7× the work of the earlier fixed 8 km grid, and 128 drive
// cells answer in under a second.
const grid = { drive: { cellMeters: 600, maximumSize: 128 }, bike: { cellMeters: 330, maximumSize: 48 } }

// The raster sizes Reach accepts, up to the largest grid above
// (capabilities.mjs `supportedReachRasterSizes`).
const rasterSizes = [48, 64, 96, 128]

/**
 * The square a drive or bicycle Reach evaluates around its place. It holds
 * every point the largest time band can reach, so the surface ends where
 * travel does rather than at the square's edge.
 */
export function reachExtent(mode: 'drive' | 'bike', cutoffMinutes: number, bike: RoutingBikeOptions) {
  // 50 m outward, so rounding to 0.1 km never cuts a reachable point.
  const reachKm = cutoffMinutes / 60 * topSpeedKph(mode, bike) + 0.05
  const radiusKm = Math.min(maximumReachRadiusKm, Math.max(1, Math.ceil(reachKm * 10) / 10))
  const { cellMeters, maximumSize } = grid[mode]
  // The smallest accepted grid that keeps cells at their size, up to the limit.
  const cells = Math.min(maximumSize, Math.ceil(radiusKm * 2000 / cellMeters))
  const rasterSize = rasterSizes.find(size => size >= cells) ?? maximumSize
  return { radiusKm, rasterSize, cellMeters: Math.round(radiusKm * 2000 / rasterSize) }
}
