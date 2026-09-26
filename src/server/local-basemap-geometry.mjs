// Cartographic geometry only. These approximations never enter the routing graph.
export const coastGeometryLimits = Object.freeze({ pieces: 4_096, vertices: 80_000, containmentChecks: 1_000_000 })
const pointKey = (point) => `${point[0].toFixed(8)},${point[1].toFixed(8)}`
const samePoint = (left, right) => pointKey(left) === pointKey(right)

export function signedArea(ring) {
  let area = 0
  for (let i = 1; i < ring.length; i += 1) area += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1]
  return area / 2
}

export function containsPoint(ring, point) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j]
    if ((a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside
  }
  return inside
}

function segmentDistance(point, start, end) {
  const dx = end[0] - start[0], dy = end[1] - start[1]
  const t = dx || dy ? Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy))) : 0
  return (point[0] - start[0] - t * dx) ** 2 + (point[1] - start[1] - t * dy) ** 2
}

export function simplifyLine(points, tolerance) {
  if (points.length <= 2) return points
  const keep = new Uint8Array(points.length)
  keep[0] = keep[points.length - 1] = 1
  const stack = [0, points.length - 1]
  while (stack.length) {
    const end = stack.pop(), start = stack.pop()
    let maximum = tolerance * tolerance, selected = -1
    for (let i = start + 1; i < end; i += 1) {
      const distance = segmentDistance(points[i], points[start], points[end])
      if (distance > maximum) { maximum = distance; selected = i }
    }
    if (selected !== -1) { keep[selected] = 1; stack.push(start, selected, selected, end) }
  }
  const result = points.filter((_, i) => keep[i])
  return samePoint(points[0], points.at(-1)) && result.length < 4 ? points : result
}

// OSM multipolygon members can arrive unordered and reversed. Coastlines must
// retain their direction: land on the left, sea on the right.
export function joinLines(lines, directed = false) {
  const endpoints = new Map()
  for (let i = 0; i < lines.length; i += 1) {
    for (const point of [lines[i][0], lines[i].at(-1)]) {
      const key = pointKey(point)
      if (!endpoints.has(key)) endpoints.set(key, [])
      endpoints.get(key).push(i)
    }
  }
  const used = new Set(), result = []
  for (let i = 0; i < lines.length; i += 1) {
    if (used.has(i)) continue
    used.add(i)
    const prefix = [], suffix = []
    let first = lines[i][0], last = lines[i].at(-1)
    for (const prepend of [false, true]) {
      while (!samePoint(first, last)) {
        const point = prepend ? first : last
        const match = (endpoints.get(pointKey(point)) ?? []).find((index) => !used.has(index)
          && (!directed || samePoint(prepend ? lines[index].at(-1) : lines[index][0], point)))
        if (match === undefined) break
        used.add(match)
        let part = lines[match]
        if (!samePoint(prepend ? part.at(-1) : part[0], point)) part = [...part].reverse()
        if (prepend) { prefix.push(part); first = part[0] }
        else { suffix.push(part); last = part.at(-1) }
      }
    }
    const line = []
    for (const part of [...prefix.reverse(), lines[i], ...suffix]) {
      for (let j = line.length ? 1 : 0; j < part.length; j += 1) line.push(part[j])
    }
    result.push(line)
  }
  return result
}

export function polygonWithHoles(outers, inners, maximumWork = Infinity) {
  const polygons = outers.map((ring) => [signedArea(ring) < 0 ? [...ring].reverse() : ring])
  const candidates = polygons.map((polygon) => ({ polygon, area: Math.abs(signedArea(polygon[0])) }))
  let work = 0
  for (const inner of inners) {
    let owner = null, smallest = Infinity
    for (const { polygon, area } of candidates) {
      if (++work > maximumWork) return null
      if (area >= smallest) continue
      work += polygon[0].length
      if (work > maximumWork) return null
      if (containsPoint(polygon[0], inner[0])) { owner = polygon; smallest = area }
    }
    if (owner) owner.push(signedArea(inner) > 0 ? [...inner].reverse() : inner)
  }
  return polygons
}

function clipSegment(a, b, bounds) {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  let enter = 0, leave = 1
  for (const [p, q] of [[-dx, a[0] - bounds.west], [dx, bounds.east - a[0]], [-dy, a[1] - bounds.south], [dy, bounds.north - a[1]]]) {
    if (!p) { if (q < 0) return null; continue }
    const t = q / p
    if (p < 0) enter = Math.max(enter, t)
    else leave = Math.min(leave, t)
    if (enter >= leave) return null
  }
  return [[a[0] + enter * dx, a[1] + enter * dy], [a[0] + leave * dx, a[1] + leave * dy]]
}

export function clipLines(lines, bounds) {
  const result = []
  let vertices = 0
  for (const line of lines) {
    let current = null
    for (let i = 1; i < line.length; i += 1) {
      const segment = clipSegment(line[i - 1], line[i], bounds)
      if (!segment) { current = null; continue }
      const connected = current && samePoint(current.at(-1), segment[0])
      const addedVertices = connected ? 1 : 2
      // Clipping can split one zigzagging shore into thousands of pieces.
      // Bound the intermediate geometry as well as the original SQL input.
      if ((!connected && result.length >= coastGeometryLimits.pieces)
        || vertices + addedVertices > coastGeometryLimits.vertices) return { lines: result, complete: false }
      if (connected) current.push(segment[1])
      else { current = segment; result.push(current) }
      vertices += addedVertices
    }
  }
  return { lines: result, complete: true }
}

export function nearestCoastSide(lines, point) {
  let nearest = Infinity, side = null
  for (const line of lines) {
    for (let i = 1; i < line.length; i += 1) {
      const a = line[i - 1], b = line[i]
      const length = Math.hypot(b[0] - a[0], b[1] - a[1])
      if (!length) continue
      const distance = segmentDistance(point, a, b)
      const direction = ((b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0])) / length
      if (Math.abs(distance - nearest) < 1e-18) {
        // At a vertex use both adjacent shore normals, independent of their
        // segment lengths and of the SQLite result order.
        side += direction
      } else if (distance < nearest) {
        nearest = distance
        side = direction
      }
    }
  }
  return side
}

// Polygonize only complete coastlines inside the viewport. Never close a broken
// interior shoreline with an invented diagonal across land. Exterior closures
// follow the viewport boundary clockwise, preserving the OSM sea-side rule.
export function oceanPolygons(lines, bounds, cornerSide = null, sourceComplete = true) {
  const clipped = clipLines(lines, bounds)
  const incomplete = (limited = false) => ({ polygons: [], outlines: clipped.lines, complete: false, limited })
  if (!clipped.complete || !sourceComplete) return incomplete(!clipped.complete)
  const { west: w, south: s, east: e, north: n } = bounds
  const width = e - w, height = n - s, perimeter = 2 * (width + height)
  const corners = [[w, s], [w, n], [e, n], [e, s]]
  const positions = [0, height, height + width, 2 * height + width]
  const boundaryPosition = (p) => {
    const epsilon = 1e-7
    if (Math.abs(p[0] - w) < epsilon) return p[1] - s
    if (Math.abs(p[1] - n) < epsilon) return height + p[0] - w
    if (Math.abs(p[0] - e) < epsilon) return height + width + n - p[1]
    if (Math.abs(p[1] - s) < epsilon) return 2 * height + width + e - p[0]
    return null
  }
  const open = [], outers = [], holes = []
  for (const line of joinLines(clipped.lines, true)) {
    if (samePoint(line[0], line.at(-1))) {
      if (line.length >= 4) (signedArea(line) < 0 ? outers : holes).push(line)
    } else {
      const start = boundaryPosition(line[0]), end = boundaryPosition(line.at(-1))
      if (start === null || end === null) return incomplete()
      open.push({ line, start, end })
    }
  }
  // Find the next clockwise boundary crossing in logarithmic time. A linear
  // scan for every crossing becomes quadratic on intricate coastal extracts.
  const starts = open.map(({ start }, index) => ({ start, index })).sort((a, b) => a.start - b.start || a.index - b.index)
  const visited = new Set()
  for (let i = 0; i < open.length; i += 1) {
    if (visited.has(i)) continue
    const ring = []
    let cursor = i
    do {
      if (visited.has(cursor)) return incomplete()
      visited.add(cursor)
      const part = open[cursor]
      for (const point of part.line) ring.push(point)
      let low = 0, high = starts.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (starts[middle].start < part.end) low = middle + 1
        else high = middle
      }
      const next = starts[low] ?? starts[0]
      const distance = (next.start - part.end + perimeter) % perimeter
      const boundaryCorners = positions.map((position, index) => ({
        point: corners[index], distance: (position - part.end + perimeter) % perimeter,
      })).filter((corner) => corner.distance > 1e-10 && corner.distance < distance)
        .sort((a, b) => a.distance - b.distance)
      ring.push(...boundaryCorners.map((corner) => corner.point))
      cursor = next.index
    } while (cursor !== i)
    ring.push(ring[0])
    outers.push(ring)
  }
  if (!open.length && cornerSide !== null && cornerSide < 0) outers.unshift([...corners, corners[0]])
  const polygons = polygonWithHoles(outers, holes, coastGeometryLimits.containmentChecks)
  if (!polygons) return incomplete(true)
  return { polygons, outlines: clipped.lines, complete: true, limited: false }
}
