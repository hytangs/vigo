// A City's network as a small SVG mark for the City library. It is derived
// from the published map preview already stored with each feed: no routing
// store is opened and nothing is written. Buses sit underneath fixed-guideway
// lines so rapid transit reads first, the way a rider reads a system map.

const width = 320
const height = 200
const padding = 10
const maximumPoints = 14_000
/** Bump when the drawing changes so cached signatures refresh. */
export const networkSignatureVersion = 2

function finiteCoordinate(value) {
  return Array.isArray(value) && Number.isFinite(value[0]) && Number.isFinite(value[1])
    && value[0] >= -180 && value[0] <= 180 && value[1] >= -90 && value[1] <= 90
}

function routeLines(preview) {
  const stops = new Map((preview?.stops ?? []).map((stop) => [stop.id, stop]))
  return (preview?.routes ?? []).flatMap((route) => {
    const coordinates = Array.isArray(route.coordinates) && route.coordinates.length > 1
      ? route.coordinates.filter(finiteCoordinate)
      : (route.stopIds ?? []).map((id) => stops.get(id)).filter(Boolean).map((stop) => [stop.lon, stop.lat]).filter(finiteCoordinate)
    if (coordinates.length < 2) return []
    const color = /^#[0-9a-f]{6}$/iu.test(String(route.color ?? '')) ? route.color : '#8b95a4'
    return [{ coordinates, color, rapid: Number.isInteger(route.routeType) && route.routeType !== 3, trips: Number(route.tripCount) || 0 }]
  })
}

function quantile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * fraction)))]
}

function simplify(points, tolerance) {
  if (points.length <= 2) return points
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack = [[0, points.length - 1]]
  const squared = tolerance * tolerance
  while (stack.length) {
    const [first, last] = stack.pop()
    const [ax, ay] = points[first]
    const [bx, by] = points[last]
    const dx = bx - ax
    const dy = by - ay
    const length = dx * dx + dy * dy
    let farthest = -1
    let distance = squared
    for (let index = first + 1; index < last; index += 1) {
      const [px, py] = points[index]
      const t = length ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0
      const ex = ax + t * dx - px
      const ey = ay + t * dy - py
      const candidate = ex * ex + ey * ey
      if (candidate > distance) {
        distance = candidate
        farthest = index
      }
    }
    if (farthest >= 0) {
      keep[farthest] = 1
      stack.push([first, farthest], [farthest, last])
    }
  }
  return points.filter((_, index) => keep[index])
}

/** Render a City's map previews as an SVG string, or null when no geometry exists. */
export function networkSignatureSvg(previews) {
  const lines = previews.flatMap(routeLines)
  if (!lines.length) return null
  const longitudes = lines.flatMap((line) => line.coordinates.map((coordinate) => coordinate[0])).sort((a, b) => a - b)
  const latitudes = lines.flatMap((line) => line.coordinates.map((coordinate) => coordinate[1])).sort((a, b) => a - b)
  // Frame the dense core; regional lines bleed off the edge like a cropped system map.
  const west = quantile(longitudes, 0.04)
  const east = quantile(longitudes, 0.96)
  const south = quantile(latitudes, 0.04)
  const north = quantile(latitudes, 0.96)
  const aspect = Math.cos(((south + north) / 2) * Math.PI / 180)
  const spanX = Math.max(1e-6, (east - west) * aspect)
  const spanY = Math.max(1e-6, north - south)
  const scale = Math.min((width - 2 * padding) / spanX, (height - 2 * padding) / spanY)
  const offsetX = (width - spanX * scale) / 2
  const offsetY = (height - spanY * scale) / 2
  const project = ([lon, lat]) => [offsetX + (lon - west) * aspect * scale, offsetY + (north - lat) * scale]

  const ordered = [...lines].sort((left, right) => Number(left.rapid) - Number(right.rapid) || left.trips - right.trips)
  let budget = maximumPoints
  const paths = []
  for (const line of ordered) {
    if (budget <= 0) break
    const points = simplify(line.coordinates.map(project), 0.55)
    if (points.length < 2) continue
    budget -= points.length
    const d = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('')
    paths.push(line.rapid
      ? `<path d="${d}" stroke="${line.color}" stroke-width="2.2" stroke-opacity="0.95" vector-effect="non-scaling-stroke"/>`
      : `<path d="${d}" stroke="${line.color}" stroke-width="0.8" stroke-opacity="0.5" vector-effect="non-scaling-stroke"/>`)
  }
  // Strokes keep their pixel width whether the mark is a card thumbnail or a hero.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" fill="none" stroke-linecap="round" stroke-linejoin="round">${paths.join('')}</svg>`
}
