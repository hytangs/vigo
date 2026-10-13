// Studio display boundaries interpolate sampled times. Raw rasters and the
// public CLI cell polygons retain their existing sampling and representation.
const round = (value, digits) => Number(value.toFixed(digits))
const featureCollection = features => ({ type: 'FeatureCollection', features })

function contourCoordinate(bounds, width, height, x, y) {
  const [west, south, east, north] = bounds
  return [
    round(west + Math.max(0, Math.min(width, x + 0.5)) / width * (east - west), 12),
    round(north - Math.max(0, Math.min(height, y + 0.5)) / height * (north - south), 12),
  ]
}

function interpolateEdge(left, right, threshold) {
  // No-data is a mask boundary, not a travel time to interpolate through.
  if (!Number.isFinite(left) || !Number.isFinite(right)) return 0.5
  if (Math.abs(right - left) < 1e-9) return 0.5
  // Keep threshold-equal samples just inside, avoiding collapsed edges and
  // four-way vertices when a contour passes exactly through a sampled point.
  return Math.max(1e-6, Math.min(1 - 1e-6, (threshold - left) / (right - left)))
}

function contourSegments(values, width, height, bounds, threshold) {
  const segments = []
  const cases = {
    1: [['left', 'top']],
    2: [['top', 'right']],
    3: [['left', 'right']],
    4: [['right', 'bottom']],
    5: [['left', 'top'], ['right', 'bottom']],
    6: [['top', 'bottom']],
    7: [['left', 'bottom']],
    8: [['bottom', 'left']],
    9: [['top', 'bottom']],
    10: [['top', 'right'], ['bottom', 'left']],
    11: [['right', 'bottom']],
    12: [['left', 'right']],
    13: [['top', 'right']],
    14: [['left', 'top']],
  }
  const valueAt = (x, y) => x >= 0 && x < width && y >= 0 && y < height
    && Number.isFinite(values[y * width + x]) ? values[y * width + x] : Infinity
  // A no-data collar closes rings at the extent. Diagonal-only samples stay
  // separate (cases 5/10); a missing strip must never become a connection.
  for (let y = -1; y < height; y += 1) {
    for (let x = -1; x < width; x += 1) {
      const topLeft = valueAt(x, y)
      const topRight = valueAt(x + 1, y)
      const bottomRight = valueAt(x + 1, y + 1)
      const bottomLeft = valueAt(x, y + 1)
      const state = (topLeft <= threshold ? 1 : 0)
        | (topRight <= threshold ? 2 : 0)
        | (bottomRight <= threshold ? 4 : 0)
        | (bottomLeft <= threshold ? 8 : 0)
      if (state === 0 || state === 15) continue
      const edgePoints = {
        top: [x + interpolateEdge(topLeft, topRight, threshold), y],
        right: [x + 1, y + interpolateEdge(topRight, bottomRight, threshold)],
        bottom: [x + interpolateEdge(bottomLeft, bottomRight, threshold), y + 1],
        left: [x, y + interpolateEdge(topLeft, bottomLeft, threshold)],
      }
      for (const [startEdge, endEdge] of cases[state] ?? []) {
        segments.push([
          contourCoordinate(bounds, width, height, ...edgePoints[startEdge]),
          contourCoordinate(bounds, width, height, ...edgePoints[endEdge]),
        ])
      }
    }
  }
  return segments
}

function contourPointKey(point) {
  return `${point[0].toFixed(12)},${point[1].toFixed(12)}`
}

function stitchContourSegments(segments) {
  const nodes = new Map()
  const edges = segments.map(([start, end], index) => {
    const startKey = contourPointKey(start)
    const endKey = contourPointKey(end)
    for (const [key, coordinate] of [[startKey, start], [endKey, end]]) {
      const node = nodes.get(key) ?? { coordinate, edges: [] }
      node.edges.push(index)
      nodes.set(key, node)
    }
    return { startKey, endKey }
  })
  const visited = new Uint8Array(edges.length)
  const lines = []

  const walk = (startKey, firstEdge) => {
    const coordinates = [nodes.get(startKey).coordinate]
    let key = startKey
    let edgeIndex = firstEdge
    while (edgeIndex !== undefined && !visited[edgeIndex]) {
      visited[edgeIndex] = 1
      const edge = edges[edgeIndex]
      key = edge.startKey === key ? edge.endKey : edge.startKey
      coordinates.push(nodes.get(key).coordinate)
      edgeIndex = nodes.get(key).edges.find((candidate) => !visited[candidate])
    }
    if (coordinates.length >= 2) lines.push(coordinates)
  }

  for (const [key, node] of nodes) {
    if (node.edges.length === 2) continue
    for (const edgeIndex of node.edges) {
      if (!visited[edgeIndex]) walk(key, edgeIndex)
    }
  }
  for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex += 1) {
    if (!visited[edgeIndex]) walk(edges[edgeIndex].startKey, edgeIndex)
  }
  return lines
}

// Raster cell edges are directed with reachable space on their right. At a
// corner contact, keep that orientation instead of reversing an arbitrary edge.
export function stitchAreaSegments(segments) {
  const outgoing = new Map()
  segments.forEach(([start], index) => {
    const key = contourPointKey(start)
    const edges = outgoing.get(key) ?? []
    edges.push(index)
    outgoing.set(key, edges)
  })
  const visited = new Uint8Array(segments.length)
  const rings = []
  for (let first = 0; first < segments.length; first++) {
    if (visited[first]) continue
    const ring = [segments[first][0]]
    const startKey = contourPointKey(ring[0])
    let index = first
    while (index !== undefined) {
      const [start, end] = segments[index]
      visited[index] = 1
      ring.push(end)
      const key = contourPointKey(end)
      if (key === startKey) break
      const dx = end[0] - start[0], dy = end[1] - start[1]
      const candidates = (outgoing.get(key) ?? []).filter(i => !visited[i])
      const turn = i => {
        const next = segments[i][1]
        const nx = next[0] - end[0], ny = next[1] - end[1]
        return Math.atan2(dx * ny - dy * nx, dx * nx + dy * ny)
      }
      index = candidates.length > 1 ? candidates.sort((a, b) => turn(a) - turn(b))[0] : candidates[0]
    }
    rings.push(ring)
  }
  return rings
}

export function boundaryContoursFromAreas(areas) {
  return featureCollection(areas.features.map(feature => ({
    ...feature,
    id: `${feature.properties.surface}-${feature.properties.cutoffMinutes}`,
    properties: { ...feature.properties, id: `${feature.properties.surface}-${feature.properties.cutoffMinutes}` },
    geometry: {
      type: 'MultiLineString',
      coordinates: feature.geometry.type === 'Polygon' ? feature.geometry.coordinates : feature.geometry.coordinates.flat(),
    },
  })))
}

function signedRingArea(ring) {
  let area = 0
  const [originX, originY] = ring[0]
  for (let index = 0; index < ring.length - 1; index += 1) {
    const [x1, y1] = ring[index]
    const [x2, y2] = ring[index + 1]
    area += (x1 - originX) * (y2 - originY) - (x2 - originX) * (y1 - originY)
  }
  return area / 2
}

function pointInRing(point, ring) {
  const [x, y] = point
  let inside = false
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [xi, yi] = ring[index]
    const [xj, yj] = ring[previous]
    const intersects = (yi > y) !== (yj > y)
      && x < (xj - xi) * (y - yi) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

function simplifyAreaRing(ring) {
  if (ring.length < 4) return ring
  const points = ring.slice(0, -1)
  const simplified = []
  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index + points.length - 1) % points.length]
    const current = points[index]
    const next = points[(index + 1) % points.length]
    const ax = current[0] - previous[0], ay = current[1] - previous[1]
    const bx = next[0] - current[0], by = next[1] - current[1]
    const left = ax * by, right = ay * bx
    // An absolute area tolerance can erase real bends in degree coordinates,
    // including the small collars that keep exact-cutoff samples inside.
    // Remove only forward collinearity within multiplication roundoff.
    const roundoff = 8 * Number.EPSILON * (Math.abs(left) + Math.abs(right))
    if (Math.abs(left - right) > roundoff || ax * bx + ay * by < 0) simplified.push(current)
  }
  if (simplified.length < 3) return ring
  return [...simplified, simplified[0]]
}

function orientAreaRing(ring, counterClockwise) {
  const counterClockwiseRing = signedRingArea(ring) >= 0
  return counterClockwiseRing === counterClockwise ? ring : [...ring].reverse()
}

// Cell boundaries can meet at a corner. Split a closed walk at repeated
// vertices before computing area, so touching rings cannot cancel each other.
function splitTouchingRings(ring) {
  const positions = new Map()
  const path = []
  const rings = []
  for (const point of ring) {
    const key = contourPointKey(point)
    const start = positions.get(key)
    if (start !== undefined) {
      rings.push([...path.slice(start), point])
      for (let i = start + 1; i < path.length; i++) positions.delete(contourPointKey(path[i]))
      path.length = start + 1
    } else {
      positions.set(key, path.length)
      path.push(point)
    }
  }
  return rings
}

export function areaPolygons(rings) {
  const records = rings
    .filter((ring) => ring.length >= 4 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1])
    .flatMap(splitTouchingRings)
    .map((ring) => {
      const simplified = simplifyAreaRing(ring)
      const bounds = [Infinity, Infinity, -Infinity, -Infinity]
      for (const [x, y] of simplified) {
        bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y)
        bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y)
      }
      return { ring: simplified, bounds, absoluteArea: Math.abs(signedRingArea(simplified)), parent: null, depth: 0 }
    })
    .filter((record) => record.absoluteArea > 0)
    .sort((left, right) => right.absoluteArea - left.absoluteArea)
  for (const record of records) {
    const probe = [(record.ring[0][0] + record.ring[1][0]) / 2,
      (record.ring[0][1] + record.ring[1][1]) / 2]
    record.parent = records.findLast((candidate) => (
      candidate !== record
      && candidate.absoluteArea > record.absoluteArea
      && candidate.bounds[0] <= record.bounds[0] && candidate.bounds[1] <= record.bounds[1]
      && candidate.bounds[2] >= record.bounds[2] && candidate.bounds[3] >= record.bounds[3]
      && pointInRing(probe, candidate.ring)
    )) ?? null
    record.depth = record.parent ? record.parent.depth + 1 : 0
  }
  const outerRecords = records.filter((record) => record.depth % 2 === 0)
  return outerRecords.map((outer) => {
    const holes = records
      .filter((record) => record.depth % 2 === 1)
      .filter((record) => record.parent === outer)
      .map((record) => orientAreaRing(record.ring, false))
    return [orientAreaRing(outer.ring, true), ...holes]
  })
}

function interpolatedAreaPolygons(values, width, height, bounds, cutoffMinutes) {
  return areaPolygons(stitchContourSegments(
    contourSegments(values, width, height, bounds, cutoffMinutes),
  ))
}

export function rasterBoundaryAreas(values, width, height, bounds, cutoffsMinutes, surface) {
  return featureCollection(cutoffsMinutes.flatMap((cutoffMinutes) => {
    const polygons = interpolatedAreaPolygons(values, width, height, bounds, cutoffMinutes)
    if (!polygons.length) return []
    return [{
      type: 'Feature',
      id: `${surface}-area-${cutoffMinutes}`,
      properties: {
        id: `${surface}-area-${cutoffMinutes}`,
        surface,
        cutoffMinutes,
      },
      geometry: polygons.length === 1
        ? { type: 'Polygon', coordinates: polygons[0] }
        : { type: 'MultiPolygon', coordinates: polygons },
    }]
  }))
}
