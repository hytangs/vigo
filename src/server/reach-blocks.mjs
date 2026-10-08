// Bounded display estimates for enclosed block interiors. The routed street
// raster is never changed, and these values are not pedestrian connections.
export function blockInteriorEstimates(values, width, height, bounds, water, walkSpeedKph = 4.8) {
  const estimates = new Float64Array(values.length).fill(Infinity)
  // Missing/truncated water coverage is not evidence that a block is dry.
  if (water?.metadata?.status !== 'ready' || water.metadata.sampled
    || water.metadata.coastlineComplete === false) return estimates
  const [west, south, east, north] = bounds
  const dx = (east - west) * 111320 * Math.cos((south + north) / 2 * Math.PI / 180) / width
  const dy = (north - south) * 111320 / height
  if (!(dx > 0 && dy > 0 && walkSpeedKph > 0) || Math.max(dx, dy) > 120) return estimates
  const wet = waterCells(water.features, width, height, bounds)
  const visited = new Uint8Array(values.length)
  const offsets = [-1, 0, 1].flatMap(y => [-1, 0, 1].map(x => [x, y])).filter(([x, y]) => x || y)
  for (let seed = 0; seed < values.length; seed++) {
    if (visited[seed] || Number.isFinite(values[seed])) continue
    const component = [seed], border = new Set()
    let enclosed = true, protectedWater = false
    let minX = width, maxX = 0, minY = height, maxY = 0
    visited[seed] = 1
    for (let head = 0; head < component.length; head++) {
      const cell = component[head], x = cell % width, y = Math.floor(cell / width)
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
      protectedWater ||= Boolean(wet[cell])
      for (const [ox, oy] of offsets) {
        const xx = x + ox, yy = y + oy
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) { enclosed = false; continue }
        const next = yy * width + xx
        if (Number.isFinite(values[next])) border.add(next)
        else if (!visited[next]) { visited[next] = 1; component.push(next) }
      }
    }
    if (!enclosed || protectedWater || !border.size || component.length * dx * dy > 40000
      || (maxX - minX + 1) * dx > 350 || (maxY - minY + 1) * dy > 350) continue
    const boundary = [...border]
    const latestBoundary = boundary.reduce((latest, cell) => Math.max(latest, values[cell]), 0)
    for (const cell of component) {
      const x = cell % width, y = Math.floor(cell / width)
      const distance = Math.min(...boundary.map(other => Math.hypot(
        (x - other % width) * dx, (y - Math.floor(other / width)) * dy,
      ))) + Math.hypot(dx, dy) / 2
      if (distance <= 120) estimates[cell] = latestBoundary + distance / (walkSpeedKph * 1000 / 60)
    }
  }
  return estimates
}

function waterCells(features, width, height, bounds) {
  const [west, south, east, north] = bounds
  const mask = new Uint8Array(width * height)
  const project = ([lon, lat]) => [(lon - west) / (east - west) * width, (north - lat) / (north - south) * height]
  const mark = (x, y) => { if (x >= 0 && y >= 0 && x < width && y < height) mask[Math.floor(y) * width + Math.floor(x)] = 1 }
  const edge = (a, b) => {
    const ts = [0, 1]
    for (const axis of [0, 1]) {
      const d = b[axis] - a[axis]
      if (!d) continue
      const size = axis === 0 ? width : height
      for (let k = Math.max(0, Math.ceil(Math.min(a[axis], b[axis]))); k <= Math.min(size, Math.floor(Math.max(a[axis], b[axis]))); k++) {
        const t = (k - a[axis]) / d
        if (t > 0 && t < 1) ts.push(t)
      }
    }
    ts.sort((a, b) => a - b)
    for (let i = 0; i < ts.length; i++) {
      const t = i ? (ts[i - 1] + ts[i]) / 2 : ts[i]
      mark(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
    }
    mark(...b)
  }
  const line = coordinates => {
    const points = coordinates.map(project)
    for (let i = 1; i < points.length; i++) edge(points[i - 1], points[i])
    return points
  }
  const polygon = coordinates => {
    const rings = coordinates.map(line)
    // Even/odd scanlines preserve islands inside water polygons.
    for (let y = 0; y < height; y++) {
      const intersections = []
      for (const ring of rings) for (let i = 1; i < ring.length; i++) {
        const [a, b] = [ring[i - 1], ring[i]]
        if ((a[1] > y + .5) !== (b[1] > y + .5)) intersections.push(a[0] + (y + .5 - a[1]) / (b[1] - a[1]) * (b[0] - a[0]))
      }
      intersections.sort((a, b) => a - b)
      for (let i = 1; i < intersections.length; i += 2) for (let x = Math.max(0, Math.ceil(intersections[i - 1] - .5)); x + .5 < Math.min(width, intersections[i]); x++) mark(x, y)
    }
  }
  for (const feature of features) {
    if (!['water', 'river', 'ocean', 'coastline'].includes(feature.properties?.kind)) continue
    const { type, coordinates } = feature.geometry
    if (type === 'Polygon') polygon(coordinates)
    else if (type === 'MultiPolygon') coordinates.forEach(polygon)
    else if (type === 'LineString') line(coordinates)
    else if (type === 'MultiLineString') coordinates.forEach(line)
  }
  return mask
}
