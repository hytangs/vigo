import { resolveServiceDay } from './service-day.mjs'
import { integralNumber, timingMilliseconds } from './number-utils.mjs'

import { supportedReachRasterSizes } from '../capabilities.mjs'

const supportedRasterSizes = new Set(supportedReachRasterSizes)
const maximumScenarioStops = 256
const maximumScenarioServices = 32
const maximumScenarioGeometryPoints = 16_384
const rasterScale = 10
const rasterNoData = 65_535

function badRequest(message, code = 'invalid_reach_request') {
  const error = new Error(message)
  error.statusCode = 400
  error.code = code
  return error
}

function finiteNumber(value, label) {
  if (value == null || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) {
    throw badRequest(`${label} must be a finite number.`)
  }
  let number
  try {
    number = Number(value)
  } catch {
    throw badRequest(`${label} must be a finite number.`)
  }
  if (!Number.isFinite(number)) throw badRequest(`${label} must be a finite number.`)
  return number
}

function boundedNumber(value, label, minimum, maximum) {
  const number = finiteNumber(value, label)
  if (number < minimum || number > maximum) {
    throw badRequest(`${label} must be between ${minimum} and ${maximum}.`)
  }
  return number
}

function boundedIntegralNumber(value, label, minimum, maximum, fallback) {
  const candidate = value === undefined ? fallback : value
  const number = integralNumber(candidate)
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw badRequest(`${label} must be an integral number between ${minimum} and ${maximum}.`)
  }
  return number
}

function coordinate(value, label) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw badRequest(`${label} must be a [longitude, latitude] coordinate.`)
  }
  return [
    boundedNumber(value[0], `${label} longitude`, -180, 180),
    boundedNumber(value[1], `${label} latitude`, -85, 85),
  ]
}

function normalizedGeometry(value, label) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length < 2) {
    throw badRequest(`${label} must contain at least two [longitude, latitude] coordinates.`)
  }
  if (value.length > maximumScenarioGeometryPoints) {
    throw badRequest(`${label} is limited to ${maximumScenarioGeometryPoints} coordinates.`)
  }
  return value.map((point, index) => coordinate(point, `${label}[${index}]`))
}

function compactText(value, fallback, maximumLength = 120) {
  const text = String(value ?? '').trim()
  return (text || fallback).slice(0, maximumLength)
}

function normalizedPoint(value, label, fallbackId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest(`${label} must be an object.`)
  }
  const editStatus = ['baseline', 'added', 'inserted', 'replaced'].includes(value.editStatus)
    ? value.editStatus
    : undefined
  return {
    id: compactText(value.id, fallbackId, 80),
    label: compactText(value.label, fallbackId),
    coordinate: coordinate(value.coordinate, `${label}.coordinate`),
    source: compactText(value.source, 'map', 24),
    ...(value.stopId ? { stopId: compactText(value.stopId, '', 160) } : {}),
    ...(editStatus ? { editStatus } : {}),
  }
}

function normalizedService(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest(`scenario.services[${index}] must be an object.`)
  }
  const operation = String(value.operation ?? 'add')
  if (!['add', 'augment', 'replace'].includes(operation)) {
    throw badRequest(`scenario.services[${index}].operation must be add, augment, or replace.`)
  }
  const routeScope = ['pattern', 'edge', 'route'].includes(String(value.routeScope ?? ''))
    ? String(value.routeScope)
    : undefined
  const timeModel = ['preserve-scheduled', 'infer-road', 'estimate-distance'].includes(String(value.timeModel ?? ''))
    ? String(value.timeModel)
    : 'estimate-distance'
  const geometry = normalizedGeometry(value.geometry, `scenario.services[${index}].geometry`)
  const geometrySource = ['shape', 'stop_sequence', 'osm_drive'].includes(String(value.geometrySource ?? ''))
    ? String(value.geometrySource)
    : geometry ? 'shape' : undefined
  const stops = Array.isArray(value.stops)
    ? value.stops.map((stop, stopIndex) => normalizedPoint(
      stop,
      `scenario.services[${index}].stops[${stopIndex}]`,
      `stop-${stopIndex + 1}`,
    ))
    : []
  if (stops.length < 2) throw badRequest(`scenario.services[${index}] requires at least two stops.`)
  for (const field of ['segmentRuntimeMinutes', 'segmentDistancesKm']) {
    if (value[field] !== undefined && (!Array.isArray(value[field]) || value[field].length !== stops.length - 1)) {
      throw badRequest(`scenario.services[${index}].${field} must contain one value per stop pair.`)
    }
  }
  if (timeModel === 'infer-road' && !value.segmentRuntimeMinutes && !value.segmentDistancesKm) {
    throw badRequest(`scenario.services[${index}] requires road distances or segment runtimes for infer-road timing.`)
  }
  return {
    id: compactText(value.id, `service-${index + 1}`, 80),
    name: compactText(value.name, `Service ${index + 1}`),
    operation,
    sourceRouteId: value.sourceRouteId ? compactText(value.sourceRouteId, '', 160) : undefined,
    sourcePatternId: value.sourcePatternId ? compactText(value.sourcePatternId, '', 240) : undefined,
    ...(routeScope ? { routeScope } : {}),
    timeModel,
    bidirectional: value.bidirectional !== false,
    headwayMinutes: boundedNumber(
      value.headwayMinutes ?? 12,
      `scenario.services[${index}].headwayMinutes`,
      2,
      180,
    ),
    startMinutes: boundedNumber(
      value.startMinutes ?? 5 * 60,
      `scenario.services[${index}].startMinutes`,
      0,
      2_880,
    ),
    endMinutes: boundedNumber(
      value.endMinutes ?? 25 * 60,
      `scenario.services[${index}].endMinutes`,
      0,
      2_880,
    ),
    averageSpeedKph: boundedNumber(
      value.averageSpeedKph ?? 22,
      `scenario.services[${index}].averageSpeedKph`,
      4,
      160,
    ),
    dwellMinutes: boundedNumber(
      value.dwellMinutes ?? 0.35,
      `scenario.services[${index}].dwellMinutes`,
      0,
      10,
    ),
    addedStopDwellMinutes: boundedNumber(
      value.addedStopDwellMinutes ?? 0,
      `scenario.services[${index}].addedStopDwellMinutes`,
      0,
      10,
    ),
    ...(Array.isArray(value.segmentDistancesKm)
      ? { segmentDistancesKm: value.segmentDistancesKm.map((distance, distanceIndex) => boundedNumber(
          distance, `scenario.services[${index}].segmentDistancesKm[${distanceIndex}]`, 0, 1_500,
        )) }
      : {}),
    ...(Array.isArray(value.segmentRuntimeMinutes)
      ? {
          segmentRuntimeMinutes: value.segmentRuntimeMinutes.map((runtime, runtimeIndex) => boundedNumber(
            runtime,
            `scenario.services[${index}].segmentRuntimeMinutes[${runtimeIndex}]`,
            0,
            1_440,
          )),
        }
      : {}),
    ...(geometry ? { geometry } : {}),
    ...(geometrySource ? { geometrySource } : {}),
    stops,
  }
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function localProjection(latitude) {
  return {
    kmPerLatitudeDegree: 111.32,
    kmPerLongitudeDegree: Math.max(12, 111.32 * Math.cos(latitude * Math.PI / 180)),
  }
}

function projectedDistanceKm(left, right, projection = localProjection((left[1] + right[1]) / 2)) {
  const x = (right[0] - left[0]) * projection.kmPerLongitudeDegree
  const y = (right[1] - left[1]) * projection.kmPerLatitudeDegree
  return Math.hypot(x, y)
}

function pointKey(point) {
  if (point.stopId) return `stop:${point.stopId}`
  return `coordinate:${point.coordinate.map((value) => Number(value).toFixed(7)).join(',')}`
}

function uniqueScenarioStops(services) {
  const stops = []
  const indexByKey = new Map()
  const serviceStopIndexes = services.map((service) => service.stops.map((stop) => {
    const key = pointKey(stop)
    if (!indexByKey.has(key)) {
      indexByKey.set(key, stops.length)
      stops.push(stop)
    }
    return indexByKey.get(key)
  }))
  return { stops, serviceStopIndexes }
}

function serviceDirections(service, indexes) {
  const directions = [{
    id: `${service.id}:outbound`,
    stops: service.stops,
    indexes,
    geometry: service.geometry,
  }]
  if (service.bidirectional) {
    directions.push({
      id: `${service.id}:inbound`,
      stops: [...service.stops].reverse(),
      indexes: [...indexes].reverse(),
      geometry: service.geometry ? [...service.geometry].reverse() : undefined,
      segmentRuntimeMinutes: service.segmentRuntimeMinutes
        ? [...service.segmentRuntimeMinutes].reverse()
        : undefined,
      segmentDistancesKm: service.segmentDistancesKm
        ? [...service.segmentDistancesKm].reverse()
        : undefined,
    })
  }
  return directions
}

function directionOffsets(direction, service) {
  const projection = localProjection(
    direction.stops.reduce((sum, stop) => sum + stop.coordinate[1], 0) / direction.stops.length,
  )
  const offsets = [0]
  for (let index = 1; index < direction.stops.length; index += 1) {
    const inferredDistance = direction.segmentDistancesKm?.[index - 1]
      ?? service.segmentDistancesKm?.[index - 1]
    const distanceKm = service.timeModel === 'infer-road' && Number.isFinite(inferredDistance)
      ? inferredDistance
      : projectedDistanceKm(
      direction.stops[index - 1].coordinate,
      direction.stops[index].coordinate,
      projection,
    )
    const scheduledRuntime = direction.segmentRuntimeMinutes?.[index - 1]
      ?? service.segmentRuntimeMinutes?.[index - 1]
    const addedDwell = ['inserted', 'added'].includes(direction.stops[index].editStatus)
      ? service.addedStopDwellMinutes
      : 0
    const segmentMinutes = ['preserve-scheduled', 'infer-road'].includes(service.timeModel)
      && Number.isFinite(scheduledRuntime)
      ? scheduledRuntime + addedDwell
      : service.dwellMinutes + distanceKm / service.averageSpeedKph * 60
    offsets.push(
      offsets[index - 1]
      + segmentMinutes,
    )
  }
  return offsets
}

function compileScenarioOverlay({
  services,
  scenarioStops,
  serviceStopIndexes,
}) {
  const directions = services.flatMap((service, serviceIndex) => (
    serviceDirections(service, serviceStopIndexes[serviceIndex]).map((direction) => ({
      ...direction,
      service,
      offsets: directionOffsets(direction, service),
    }))
  ))
  const directionStarts = [0]
  const directionStops = []
  const stopOffsets = []
  for (const direction of directions) {
    directionStops.push(...direction.indexes)
    stopOffsets.push(...direction.offsets.map((minutes) => minutes * 60))
    directionStarts.push(directionStops.length)
  }
  return {
    directions,
    overlay: scenarioStops.length ? {
      stops: scenarioStops,
      directionOffsets: directionStarts,
      directionStops,
      directionStopOffsetsSeconds: stopOffsets,
      serviceStartSeconds: directions.map((direction) => direction.service.startMinutes * 60),
      serviceEndSeconds: directions.map((direction) => direction.service.endMinutes * 60),
      serviceHeadwaySeconds: directions.map((direction) => direction.service.headwayMinutes * 60),
    } : null,
  }
}

function featureCollection(features) {
  return { type: 'FeatureCollection', features }
}

function routeFeatures(directions) {
  return featureCollection(directions.map((direction, index) => ({
    type: 'Feature',
    id: direction.id,
    properties: {
      id: direction.id,
      serviceId: direction.service.id,
      name: direction.service.name,
      operation: direction.service.operation,
      direction: direction.id.endsWith(':inbound') ? 'inbound' : 'outbound',
      headwayMinutes: direction.service.headwayMinutes,
      averageSpeedKph: direction.service.averageSpeedKph,
      geometrySource: direction.service.geometrySource
        ?? (direction.geometry?.length >= 2 ? 'shape' : 'stop_sequence'),
      geometryPointCount: direction.geometry?.length ?? direction.stops.length,
      order: index,
    },
    geometry: {
      type: 'LineString',
      coordinates: direction.geometry?.length >= 2
        ? direction.geometry
        : direction.stops.map((stop) => stop.coordinate),
    },
  })))
}

export function rasterBounds(origin, radiusKm) {
  const projection = localProjection(origin.coordinate[1])
  const latitudeRadius = radiusKm / projection.kmPerLatitudeDegree
  const longitudeRadius = radiusKm / projection.kmPerLongitudeDegree
  return [
    origin.coordinate[0] - longitudeRadius,
    origin.coordinate[1] - latitudeRadius,
    origin.coordinate[0] + longitudeRadius,
    origin.coordinate[1] + latitudeRadius,
  ]
}

function validBounds(value) {
  return Array.isArray(value)
    && value.length === 4
    && value.every(Number.isFinite)
    && value[0] < value[2]
    && value[1] < value[3]
    ? value.map(Number)
    : null
}

function unionBounds(...values) {
  const bounds = values.map(validBounds).filter(Boolean)
  if (!bounds.length) return null
  return [
    Math.min(...bounds.map((entry) => entry[0])),
    Math.min(...bounds.map((entry) => entry[1])),
    Math.max(...bounds.map((entry) => entry[2])),
    Math.max(...bounds.map((entry) => entry[3])),
  ]
}

function countReachableRasterCells(values, cutoffMinutes) {
  let count = 0
  for (const value of values) {
    if (Number.isFinite(value) && value <= cutoffMinutes) count += 1
  }
  return count
}

function areaMetrics(values, width, height, bounds, cutoffsMinutes) {
  const [west, south, east, north] = bounds
  const latitudeKm = 111.32
  const longitudeKm = Math.max(12, 111.32 * Math.cos(((south + north) / 2) * Math.PI / 180))
  const pixelAreaKm2 = Math.max(0, (east - west) * longitudeKm * (north - south) * latitudeKm)
    / (width * height)
  return {
    bounds,
    width,
    height,
    pixelAreaKm2,
    byCutoff: cutoffsMinutes.map((cutoffMinutes) => ({
      cutoffMinutes,
      reachablePixels: countReachableRasterCells(values, cutoffMinutes),
      areaKm2: countReachableRasterCells(values, cutoffMinutes) * pixelAreaKm2,
    })),
  }
}

function encodeRaster(values) {
  const buffer = Buffer.allocUnsafe(values.length * 2)
  for (let index = 0; index < values.length; index += 1) {
    const encoded = Number.isFinite(values[index])
      ? Math.min(rasterNoData - 1, Math.max(0, Math.round(values[index] * rasterScale)))
      : rasterNoData
    buffer.writeUInt16LE(encoded, index * 2)
  }
  return buffer.toString('base64')
}

function contourCoordinate(bounds, width, height, x, y) {
  const [west, south, east, north] = bounds
  return [
    round(west + (x + 0.5) / width * (east - west), 6),
    round(north - (y + 0.5) / height * (north - south), 6),
  ]
}

function gridCoordinate(bounds, width, height, x, y) {
  const [west, south, east, north] = bounds
  return [
    round(west + x / width * (east - west), 6),
    round(north - y / height * (north - south), 6),
  ]
}

function interpolateEdge(left, right, threshold) {
  if (!Number.isFinite(left) && !Number.isFinite(right)) return 0.5
  if (!Number.isFinite(left)) return 1
  if (!Number.isFinite(right)) return 0
  if (Math.abs(right - left) < 1e-9) return 0.5
  return Math.max(0, Math.min(1, (threshold - left) / (right - left)))
}

function contourSegments(values, width, height, bounds, threshold) {
  const segments = []
  const cases = {
    1: [['left', 'top']],
    2: [['top', 'right']],
    3: [['left', 'right']],
    4: [['right', 'bottom']],
    5: [['left', 'bottom'], ['top', 'right']],
    6: [['top', 'bottom']],
    7: [['left', 'bottom']],
    8: [['bottom', 'left']],
    9: [['top', 'bottom']],
    10: [['top', 'left'], ['right', 'bottom']],
    11: [['right', 'bottom']],
    12: [['left', 'right']],
    13: [['top', 'right']],
    14: [['left', 'top']],
  }
  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const topLeft = values[y * width + x]
      const topRight = values[y * width + x + 1]
      const bottomRight = values[(y + 1) * width + x + 1]
      const bottomLeft = values[(y + 1) * width + x]
      if (![topLeft, topRight, bottomRight, bottomLeft].every(Number.isFinite)) continue
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
  return `${point[0].toFixed(6)},${point[1].toFixed(6)}`
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

export function rasterContours(values, width, height, bounds, cutoffsMinutes, surface) {
  return featureCollection(cutoffsMinutes.flatMap((cutoffMinutes) => {
    const coordinates = stitchContourSegments(
      contourSegments(values, width, height, bounds, cutoffMinutes),
    )
    if (!coordinates.length) return []
    return [{
      type: 'Feature',
      id: `${surface}-${cutoffMinutes}`,
      properties: {
        id: `${surface}-${cutoffMinutes}`,
        surface,
        cutoffMinutes,
      },
      geometry: {
        type: 'MultiLineString',
        coordinates,
      },
    }]
  }))
}

function areaBoundarySegments(values, width, height, bounds, threshold) {
  const reachable = (x, y) => (
    x >= 0
    && x < width
    && y >= 0
    && y < height
    && Number.isFinite(values[y * width + x])
    && values[y * width + x] <= threshold
  )
  const segments = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!reachable(x, y)) continue
      if (!reachable(x, y - 1)) segments.push([gridCoordinate(bounds, width, height, x, y), gridCoordinate(bounds, width, height, x + 1, y)])
      if (!reachable(x + 1, y)) segments.push([gridCoordinate(bounds, width, height, x + 1, y), gridCoordinate(bounds, width, height, x + 1, y + 1)])
      if (!reachable(x, y + 1)) segments.push([gridCoordinate(bounds, width, height, x + 1, y + 1), gridCoordinate(bounds, width, height, x, y + 1)])
      if (!reachable(x - 1, y)) segments.push([gridCoordinate(bounds, width, height, x, y + 1), gridCoordinate(bounds, width, height, x, y)])
    }
  }
  return segments
}

function signedRingArea(ring) {
  let area = 0
  for (let index = 0; index < ring.length - 1; index += 1) {
    const [x1, y1] = ring[index]
    const [x2, y2] = ring[index + 1]
    area += x1 * y2 - x2 * y1
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
    const cross = (current[0] - previous[0]) * (next[1] - current[1])
      - (current[1] - previous[1]) * (next[0] - current[0])
    if (Math.abs(cross) > 1e-12) simplified.push(current)
  }
  if (simplified.length < 3) return ring
  return [...simplified, simplified[0]]
}

function orientAreaRing(ring, counterClockwise) {
  const counterClockwiseRing = signedRingArea(ring) >= 0
  return counterClockwiseRing === counterClockwise ? ring : [...ring].reverse()
}

function areaPolygons(rings) {
  const records = rings
    .filter((ring) => ring.length >= 4 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1])
    .map((ring) => {
      const simplified = simplifyAreaRing(ring)
      return { ring: simplified, absoluteArea: Math.abs(signedRingArea(simplified)), parent: null, depth: 0 }
    })
    .filter((record) => record.absoluteArea > 0)
    .sort((left, right) => right.absoluteArea - left.absoluteArea)
  for (const record of records) {
    record.parent = records.find((candidate) => (
      candidate !== record
      && candidate.absoluteArea > record.absoluteArea
      && pointInRing(record.ring[0], candidate.ring)
    )) ?? null
    record.depth = record.parent ? record.parent.depth + 1 : 0
  }
  const outerRecords = records.filter((record) => record.depth % 2 === 0)
  return outerRecords.map((outer) => {
    const holes = records
      .filter((record) => record.depth % 2 === 1)
      .filter((record) => {
        let ancestor = record.parent
        while (ancestor?.parent) ancestor = ancestor.parent
        return ancestor === outer
      })
      .map((record) => orientAreaRing(record.ring, false))
    return [orientAreaRing(outer.ring, true), ...holes]
  })
}

function rasterAreas(values, width, height, bounds, cutoffsMinutes, surface) {
  return featureCollection(cutoffsMinutes.flatMap((cutoffMinutes) => {
    const rings = stitchContourSegments(
      areaBoundarySegments(values, width, height, bounds, cutoffMinutes),
    )
    const polygons = areaPolygons(rings)
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

function scenarioRequestRecord(request) {
  return {
    baselineIdentity: request.baselineIdentity,
    origin: request.origin,
    departMinutes: request.departMinutes,
    serviceDate: request.serviceDate,
    serviceDay: request.serviceDay,
    maxWalkKm: request.maxWalkKm,
    walkSpeedKph: request.walkSpeedKph,
    radiusKm: request.radiusKm,
    rasterSize: request.rasterSize,
    cutoffsMinutes: request.cutoffsMinutes,
    scenario: {
      id: request.scenario.id,
      name: request.scenario.name,
      serviceCount: request.scenario.services.length,
      excludedRouteCount: request.scenario.excludedRouteIds.length,
      excludedTripCount: request.scenario.excludedTripIds.length,
      excludedPatternCount: request.scenario.excludedPatternIds.length,
    },
  }
}

function scenarioReachRecord(request, cutoffMinutes, baselineMinutes, scenarioMinutes) {
  return {
    mode: 'total-elapsed-walk-transit-walk',
    cutoffMinutes,
    baselineTerminalWalkKm: request.maxWalkKm,
    scenarioTerminalWalkKm: request.maxWalkKm,
    baselineTerminalWalkMinutes: Number(baselineMinutes.toFixed(3)),
    scenarioTerminalWalkMinutes: Number(scenarioMinutes.toFixed(3)),
  }
}

async function preliminaryWalkSurface(
  request,
  startedAt,
  buildStreetRaster,
) {
  const bounds = rasterBounds(request.origin, request.radiusKm)
  const terminalWalkMinutes = request.maxWalkKm / request.walkSpeedKph * 60
  const maximumCutoff = request.cutoffsMinutes.at(-1)
  const networkRaster = await buildStreetRaster({
    stage: 'preliminary-surface',
    seeds: [{ coordinate: request.origin.coordinate, durationMinutes: 0 }],
    bounds,
    width: request.rasterSize,
    height: request.rasterSize,
    maxWalkKm: request.maxWalkKm,
    walkSpeedKph: request.walkSpeedKph,
    maximumDurationMinutes: maximumCutoff,
    independentTerminalWalk: false,
    includeNodes: false,
    includeEdges: request.includeStreetEdges,
    compactEdges: true,
    edgeDetailLimit: 0,
    expandBoundsToReachedEdges: true,
  })
  if (
    networkRaster
    && (
      networkRaster.schemaVersion !== 'vigo.street.network-raster.v1'
      || !networkRaster.values
      || networkRaster.values.length !== request.rasterSize ** 2
    )
  ) throw new Error('Reach received an invalid preliminary OSM street response.')
  const raster = {
    values: Float64Array.from(
      networkRaster.fullValues?.length === request.rasterSize ** 2
        ? networkRaster.fullValues
        : networkRaster.values,
    ),
    bounds: validBounds(networkRaster.fullBounds) ?? bounds,
    pixelWidthKm: 0,
    pixelHeightKm: 0,
    network: networkRaster.diagnostics,
  }
  const encoded = encodeRaster(raster.values)
  const reachablePixels = [...raster.values].filter((value) => value <= maximumCutoff).length
  const { serviceStopIndexes } = uniqueScenarioStops(request.scenario.services)
  const directions = request.scenario.services.flatMap((service, serviceIndex) => (
    serviceDirections(service, serviceStopIndexes[serviceIndex]).map((direction) => ({
      ...direction,
      service,
    }))
  ))
  const packedEdges = request.includeStreetEdges
    ? requireStreetEdgeBundle(networkRaster.edges, 'preliminary')
    : null
  return {
    schemaVersion: 'vigo.result.reach.v1',
    request: scenarioRequestRecord(request),
    summary: {
      pixels: request.rasterSize ** 2,
      baselineReachablePixels: reachablePixels,
      scenarioReachablePixels: reachablePixels,
      improvedPixels: 0,
      maximumCutoffMinutes: maximumCutoff,
      transitStopSeeds: 0,
      transitStopsByCutoff: request.cutoffsMinutes.map((cutoffMinutes) => ({ cutoffMinutes, stops: 0 })),
      scenarioTransitStopsByCutoff: request.cutoffsMinutes.map((cutoffMinutes) => ({ cutoffMinutes, stops: 0 })),
      transitStatus: {
        status: 'preliminary',
        detail: 'The preliminary walk surface is ready; run the full timetable analysis to certify transit stops.',
      },
    },
    surface: {
      reachability: scenarioReachRecord(
        request,
        maximumCutoff,
        terminalWalkMinutes,
        terminalWalkMinutes,
      ),
      raster: {
        width: request.rasterSize,
        height: request.rasterSize,
        bounds: raster.bounds,
        encoding: 'uint16-tenths-minutes-le-base64',
        scale: rasterScale,
        nodata: rasterNoData,
        baseline: encoded,
        scenario: encoded,
      },
      displayBounds: raster.bounds,
      contours: {
        baseline: rasterContours(
          raster.values,
          request.rasterSize,
          request.rasterSize,
          raster.bounds,
          request.cutoffsMinutes,
          'baseline',
        ),
        scenario: rasterContours(
          raster.values,
          request.rasterSize,
          request.rasterSize,
          raster.bounds,
          request.cutoffsMinutes,
          'scenario',
        ),
      },
      areas: {
        baseline: rasterAreas(
          raster.values,
          request.rasterSize,
          request.rasterSize,
          raster.bounds,
          [maximumCutoff],
          'baseline',
        ),
        scenario: rasterAreas(
          raster.values,
          request.rasterSize,
          request.rasterSize,
          raster.bounds,
          [maximumCutoff],
          'scenario',
        ),
      },
      ...(packedEdges ? {
        edges: {
          baseline: packedEdges,
          scenario: { schemaVersion: 'vigo.street.edge-ref.v1', source: 'baseline' },
        },
      } : {}),
    },
    scenario: {
      id: request.scenario.id,
      name: request.scenario.name,
      routes: routeFeatures(directions),
    },
    limitations: [{
      code: 'preliminary_walk_surface',
      detail: 'Preliminary surface follows the persisted OSM pedestrian graph while the transit range is refined.',
    }],
    diagnostics: {
      preliminary: true,
      reachDispatches: 0,
      engine: 'walk_preliminary',
      reach: null,
      scenarioReach: null,
      originAccess: {
        strategy: 'osm-network-walk-preliminary',
        stopIds: [],
        candidates: null,
        maximumDistanceKm: request.maxWalkKm,
        durationMinutes: 0,
      },
      stopSelection: {
        candidates: 0,
        selected: 0,
        sampled: false,
        strategy: 'pending-surface-stop-envelope',
      },
      raster: {
        size: request.rasterSize,
        pixels: request.rasterSize ** 2,
        directWalkSeed: true,
        transitSeeds: 0,
        scenarioSeeds: 0,
        reachTargets: 0,
        pixelWidthKm: round(raster.pixelWidthKm, 5),
        pixelHeightKm: round(raster.pixelHeightKm, 5),
        network: raster.network ?? null,
      },
      scenarioPropagation: {
        services: request.scenario.services.length,
        directions: directions.length,
        settledStops: 0,
        relaxations: 0,
        queryMs: 0,
        algorithm: 'pending_rust_resident_query_overlay_connection_scan',
      },
      totalMs: round(performance.now() - startedAt),
    },
  }
}

function scenarioLimitations(request, hasScenarioChanges) {
  const limitations = [
    {
      code: 'street_network_cell_sampling',
      detail: 'Surface cells use arrival times interpolated along reachable directed OSM edges; cells outside those edges remain no-data, so no straight-line travel is invented across network gaps.',
    },
    {
      code: 'total_elapsed_time_cutoff',
      detail: `Access walking, waiting, transit, transfers, and terminal walking share one elapsed-time cutoff. Terminal walking uses only the remaining time and is capped at ${request.maxWalkKm} km on the directed OSM network; no geographic envelope is applied.`,
    },
    {
      code: 'single_origin_departure_snapshot',
      detail: 'This run represents one origin and one scheduled departure. Test nearby departure times, service dates, and additional origins before treating the contrast as temporally or spatially robust.',
    },
    {
      code: 'raster_cells_not_opportunities',
      detail: 'Reachable and improved cells measure spatial coverage, not population, jobs, riders, equity, welfare, or observed travel.',
    },
  ]
  if (request.scenario.services.length) {
    limitations.push({
      code: 'modeled_scenario_service',
      detail: 'Scenario services use the specified headway, operating span, average speed, fixed dwell, and ordered stops. They are synthetic schedules rather than published timetables or observed operations.',
    })
  }
  if (hasScenarioChanges) {
    limitations.push({
      code: 'descriptive_scenario_contrast',
      detail: 'Before/after differences are modeled descriptive contrasts, not causal effects, demand forecasts, or benefit-cost estimates.',
    })
  }
  return limitations
}

function requireStreetEdgeBundle(edges, label) {
  if (
    edges?.schemaVersion !== 'vigo.street.edge-bundle.v1'
    || edges.encoding !== 'indexed-f64-le'
    || typeof edges.edgeIds !== 'string'
  ) {
    throw new Error(`Reach received an invalid ${label} street-edge bundle.`)
  }
  return edges
}

function transitStopCountsByCutoff(stops, cutoffsMinutes) {
  return cutoffsMinutes.map((cutoffMinutes) => ({
    cutoffMinutes,
    stops: stops.filter((stop) => Number.isFinite(Number(stop?.durationMinutes))
      && Number(stop.durationMinutes) <= cutoffMinutes).length,
  }))
}

export function validateReachRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('Reach requires a JSON object.')
  }
  const origin = normalizedPoint(value.origin, 'origin', 'origin')
  const rasterSize = Math.round(finiteNumber(value.rasterSize ?? 96, 'rasterSize'))
  if (!supportedRasterSizes.has(rasterSize)) {
    throw badRequest(`rasterSize must be one of ${supportedReachRasterSizes.join(', ')}.`)
  }
  const cutoffsMinutes = [...new Set(
    (Array.isArray(value.cutoffsMinutes) ? value.cutoffsMinutes : [30, 45, 60])
      .map((cutoff, index) => boundedNumber(cutoff, `cutoffsMinutes[${index}]`, 5, 240)),
  )].sort((left, right) => left - right)
  if (!cutoffsMinutes.length || cutoffsMinutes.length > 8) {
    throw badRequest('cutoffsMinutes must contain between one and eight values.')
  }
  const { scenario } = compileReachScenario(value.scenario)
  const baselineMaxWalkKm = boundedNumber(value.maxWalkKm ?? 1.2, 'maxWalkKm', 0.2, 5)
  const baselineWalkSpeedKph = boundedNumber(value.walkSpeedKph ?? 4.8, 'walkSpeedKph', 1, 8)
  const serviceDate = compactText(value.serviceDate, '', 16)
  if (!serviceDate) throw badRequest('serviceDate is required for Reach.')
  let serviceDay
  try {
    serviceDay = resolveServiceDay(serviceDate, value.serviceDay)
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : String(error))
  }
  return {
    baselineIdentity: compactText(value.baselineIdentity, 'unversioned-baseline', 240),
    feedId: compactText(value.feedId, '__city__', 160),
    origin,
    departMinutes: boundedIntegralNumber(value.departMinutes, 'departMinutes', 0, 2_880, 8 * 60),
    serviceDate,
    serviceDay,
    maxWalkKm: baselineMaxWalkKm,
    walkSpeedKph: baselineWalkSpeedKph,
    includePreliminary: value.includePreliminary !== false,
    includeStreetEdges: value.includeStreetEdges !== false,
    radiusKm: boundedNumber(value.radiusKm ?? 8, 'radiusKm', 1, 40),
    rasterSize,
    cutoffsMinutes,
    scenario,
  }
}

export function compileReachScenario(value) {
  if (value != null && (typeof value !== 'object' || Array.isArray(value))) {
    throw badRequest('scenario must be an object.')
  }
  const scenarioValue = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {}
  for (const field of ['services', 'excludedRouteIds', 'excludedTripIds', 'excludedPatternIds']) {
    if (scenarioValue[field] !== undefined && !Array.isArray(scenarioValue[field])) {
      throw badRequest(`scenario.${field} must be an array.`)
    }
  }
  const services = Array.isArray(scenarioValue.services)
    ? scenarioValue.services.map(normalizedService)
    : []
  if (services.length > maximumScenarioServices) {
    throw badRequest(`scenario.services is limited to ${maximumScenarioServices} services.`)
  }
  for (const [index, service] of services.entries()) {
    if (service.endMinutes <= service.startMinutes) {
      throw badRequest(`scenario.services[${index}].endMinutes must be after startMinutes.`)
    }
  }
  const { stops: scenarioStops, serviceStopIndexes } = uniqueScenarioStops(services)
  if (scenarioStops.length > maximumScenarioStops) {
    throw badRequest(`Reach is limited to ${maximumScenarioStops} unique scenario stops.`)
  }
  const excludedRouteIds = [...new Set(
    (Array.isArray(scenarioValue.excludedRouteIds) ? scenarioValue.excludedRouteIds : [])
      .map((routeId) => compactText(routeId, '', 160))
      .filter(Boolean),
  )]
  if (excludedRouteIds.length > 512) {
    throw badRequest('scenario.excludedRouteIds is limited to 512 route variants.')
  }
  const excludedTripIds = [...new Set(
    (Array.isArray(scenarioValue.excludedTripIds) ? scenarioValue.excludedTripIds : [])
      .map((tripId) => compactText(tripId, '', 240))
      .filter(Boolean),
  )]
  if (excludedTripIds.length > 50_000) {
    throw badRequest('scenario.excludedTripIds is limited to 50000 trips.')
  }
  const excludedPatternIds = (Array.isArray(scenarioValue.excludedPatternIds)
    ? scenarioValue.excludedPatternIds
    : []).flatMap((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw badRequest(`scenario.excludedPatternIds[${index}] must be an object.`)
      }
      const routeId = compactText(entry.routeId, '', 240)
      const patternId = compactText(entry.patternId, '', 320)
      return routeId && patternId ? [{ routeId, patternId }] : []
    })
  if (excludedPatternIds.length > 512) {
    throw badRequest('scenario.excludedPatternIds is limited to 512 patterns.')
  }
  const scenario = {
    id: compactText(scenarioValue.id, 'scenario', 80),
    name: compactText(scenarioValue.name, 'Scenario'),
    services,
    excludedRouteIds,
    excludedTripIds,
    excludedPatternIds,
  }
  return {
    scenario,
    overlay: compileScenarioOverlay({
      services,
      scenarioStops,
      serviceStopIndexes,
    }).overlay,
  }
}

export async function computeReachResult(
  value,
  {
    runReach,
    buildPreliminaryStreetRaster,
    onProgress,
    onPreliminary,
  } = {},
) {
  if (typeof runReach !== 'function') {
    throw new TypeError('computeReachResult requires the unified Reach range function.')
  }
  const startedAt = performance.now()
  const request = validateReachRequest(value)
  const { stops: scenarioStops, serviceStopIndexes } = uniqueScenarioStops(request.scenario.services)
  const compiledScenario = compileScenarioOverlay({
    services: request.scenario.services,
    scenarioStops,
    serviceStopIndexes,
  })
  const bounds = rasterBounds(request.origin, request.radiusKm)
  const reachSurface = {
    bounds,
    width: request.rasterSize,
    height: request.rasterSize,
    includeNodes: false,
    includeEdges: request.includeStreetEdges,
    expandBoundsToReachedEdges: true,
    terminalWalkMode: 'elapsed-total',
  }
  if (
    onPreliminary
    && request.includePreliminary
    && typeof buildPreliminaryStreetRaster !== 'function'
  ) {
    throw new TypeError('A preliminary scenario preview requires an OSM street-raster function.')
  }
  if (onPreliminary && request.includePreliminary) {
    onPreliminary(await preliminaryWalkSurface(
      request,
      startedAt,
      buildPreliminaryStreetRaster,
    ))
  }
  let stopSelection
  let transitStops
  let baselineTransitDurations
  const reachResult = await runReach({
    stage: 'baseline-range',
    feedId: request.feedId,
    origin: request.origin,
    departMinutes: request.departMinutes,
    serviceDate: request.serviceDate,
    serviceDay: request.serviceDay,
    maxWalkKm: request.maxWalkKm,
    walkSpeedKph: request.walkSpeedKph,
    cutoffMinutes: request.cutoffsMinutes.at(-1),
    surface: reachSurface,
  })
  if (
    !reachResult
    || reachResult.schemaVersion !== 'vigo.result.reach.v1'
    || !Array.isArray(reachResult.stops)
  ) throw new Error('Reach received an invalid range response.')
  transitStops = reachResult.stops
  baselineTransitDurations = Float64Array.from(
    transitStops,
    (stop) => Number.isFinite(Number(stop.durationMinutes))
      ? Number(stop.durationMinutes)
      : Number.POSITIVE_INFINITY,
  )
  stopSelection = { diagnostics: reachResult.diagnostics?.stopSelection }
  let scenarioReachRange = null
  const scenarioTransitQueryChanged = (
    request.scenario.services.length > 0
    || request.scenario.excludedRouteIds.length > 0
    || request.scenario.excludedTripIds.length > 0
  )
  if (scenarioTransitQueryChanged) {
    scenarioReachRange = await runReach({
      stage: 'scenario-range',
      feedId: request.feedId,
      origin: request.origin,
      departMinutes: request.departMinutes,
      serviceDate: request.serviceDate,
      serviceDay: request.serviceDay,
      maxWalkKm: request.maxWalkKm,
      walkSpeedKph: request.walkSpeedKph,
      cutoffMinutes: request.cutoffsMinutes.at(-1),
      excludedRouteIds: request.scenario.excludedRouteIds,
      excludedTripIds: request.scenario.excludedTripIds,
      scenarioOverlay: compiledScenario.overlay,
      surface: reachSurface,
    })
    if (
      !scenarioReachRange
      || scenarioReachRange.schemaVersion !== 'vigo.result.reach.v1'
      || !Array.isArray(scenarioReachRange.stops)
    ) throw new Error('Reach received an invalid Scenario range response.')
  }
  const scenarioServiceStops = Array.isArray(scenarioReachRange?.scenarioStops)
    ? scenarioReachRange.scenarioStops
    : []
  const scenarioTransitStops = Array.isArray(scenarioReachRange?.stops)
    ? scenarioReachRange.stops
    : transitStops
  const overlayDiagnostics = scenarioReachRange
    ?.diagnostics
    ?.timetable
    ?.scenarioOverlay ?? null
  const propagation = {
    directions: compiledScenario.directions,
    settledStops: scenarioServiceStops.length,
    relaxations: scenarioReachRange?.diagnostics?.search?.relaxedStops ?? 0,
    serviceRelaxations: overlayDiagnostics?.overlayConnections ?? 0,
    walkTransferRelaxations: overlayDiagnostics?.supplementalTransferEdges ?? 0,
    queryMs: timingMilliseconds(
      scenarioReachRange?.diagnostics?.search?.nativeQueryMs,
    ),
    algorithm: scenarioReachRange?.diagnostics?.algorithm
      ?? 'rust_resident_query_overlay_connection_scan_one_to_many',
  }

  const baselineTransitSeeds = transitStops.flatMap((stop, index) => (
    Number.isFinite(baselineTransitDurations[index])
      ? [{ coordinate: stop.coordinate, durationMinutes: baselineTransitDurations[index] }]
      : []
  ))
  const scenarioServiceSeeds = scenarioServiceStops.flatMap((stop) => (
    Number.isFinite(Number(stop.durationMinutes))
      ? [{ coordinate: stop.coordinate, durationMinutes: Number(stop.durationMinutes) }]
      : []
  ))
  const rasterFromReach = (range, label) => {
    const surface = range?.surface
    if (
      !surface
      || surface.schemaVersion !== 'vigo.street.network-raster.v1'
      || surface.width !== request.rasterSize
      || surface.height !== request.rasterSize
      || !surface.values
      || surface.values.length !== request.rasterSize ** 2
    ) {
      const received = surface && typeof surface === 'object'
        ? {
            schemaVersion: surface.schemaVersion ?? null,
            width: surface.width ?? null,
            height: surface.height ?? null,
            valuesLength: surface.values?.length ?? null,
          }
        : null
      throw new Error(
        `Reach received an invalid ${label} surface: ${JSON.stringify(received)}.`,
      )
    }
    return {
      values: Float64Array.from(surface.values),
      areaValues: surface.fullValues
        && surface.fullValues.length === request.rasterSize ** 2
        ? Float64Array.from(surface.fullValues)
        : Float64Array.from(surface.values),
      areaBounds: validBounds(surface.fullBounds)
        ?? validBounds(surface.bounds)
        ?? bounds,
      pixelWidthKm: 0,
      pixelHeightKm: 0,
      edges: request.includeStreetEdges
        ? requireStreetEdgeBundle(surface.edges, label)
        : null,
      network: surface.diagnostics ?? {},
      terminalWalkMode: 'elapsed-total',
    }
  }
  const baselineRaster = rasterFromReach(reachResult, 'baseline')
  const hasScenarioChanges = Boolean(
    request.scenario.services.length
    || request.scenario.excludedRouteIds.length
    || request.scenario.excludedTripIds.length
  )
  const scenarioRaster = hasScenarioChanges
    ? rasterFromReach(scenarioReachRange, 'scenario')
    : { ...baselineRaster, values: new Float64Array(baselineRaster.values) }
  const maximumCutoff = request.cutoffsMinutes.at(-1)
  const baselineTerminalWalkMinutes = request.maxWalkKm / request.walkSpeedKph * 60
  const scenarioTerminalWalkMinutes = baselineTerminalWalkMinutes
  let baselineReachablePixels = 0
  let scenarioReachablePixels = 0
  let improvedPixels = 0
  const baselineAreaMetrics = areaMetrics(
    baselineRaster.areaValues,
    request.rasterSize,
    request.rasterSize,
    baselineRaster.areaBounds,
    request.cutoffsMinutes,
  )
  const scenarioAreaMetrics = areaMetrics(
    scenarioRaster.areaValues,
    request.rasterSize,
    request.rasterSize,
    scenarioRaster.areaBounds,
    request.cutoffsMinutes,
  )
  baselineReachablePixels = baselineAreaMetrics.byCutoff.find((entry) => entry.cutoffMinutes === maximumCutoff)?.reachablePixels ?? 0
  scenarioReachablePixels = scenarioAreaMetrics.byCutoff.find((entry) => entry.cutoffMinutes === maximumCutoff)?.reachablePixels ?? 0
  for (let index = 0; index < baselineRaster.values.length; index += 1) {
    const baseline = baselineRaster.values[index]
    const scenario = scenarioRaster.values[index]
    if (scenario <= maximumCutoff && (!Number.isFinite(baseline) || scenario < baseline - 0.05)) {
      improvedPixels += 1
    }
  }

  const encodedBaseline = encodeRaster(baselineRaster.values)
  const encodedScenario = hasScenarioChanges
    ? encodeRaster(scenarioRaster.values)
    : encodedBaseline
  const packedEdges = request.includeStreetEdges
    ? {
        baseline: baselineRaster.edges,
        scenario: hasScenarioChanges
          ? scenarioRaster.edges
          : { schemaVersion: 'vigo.street.edge-ref.v1', source: 'baseline' },
      }
    : null
  const result = {
    schemaVersion: 'vigo.result.reach.v1',
    request: scenarioRequestRecord(request),
    summary: {
      pixels: request.rasterSize ** 2,
      baselineReachablePixels,
      scenarioReachablePixels,
      improvedPixels,
      maximumCutoffMinutes: maximumCutoff,
      transitStopSeeds: baselineTransitSeeds.length,
      transitStopsByCutoff: transitStopCountsByCutoff(transitStops, request.cutoffsMinutes),
      scenarioTransitStopsByCutoff: transitStopCountsByCutoff(scenarioTransitStops, request.cutoffsMinutes),
      transitStatus: reachResult.diagnostics?.transit ?? null,
      scenarioTransitStatus: scenarioReachRange?.diagnostics?.transit
        ?? reachResult.diagnostics?.transit
        ?? null,
    },
    surface: {
      reachability: scenarioReachRecord(
        request,
        maximumCutoff,
        baselineTerminalWalkMinutes,
        scenarioTerminalWalkMinutes,
      ),
      raster: {
        width: request.rasterSize,
        height: request.rasterSize,
        bounds,
        encoding: 'uint16-tenths-minutes-le-base64',
        scale: rasterScale,
        nodata: rasterNoData,
        baseline: encodedBaseline,
        scenario: encodedScenario,
      },
      displayBounds: unionBounds(baselineRaster.areaBounds, scenarioRaster.areaBounds) ?? bounds,
      areaMetrics: {
        baseline: baselineAreaMetrics,
        scenario: scenarioAreaMetrics,
      },
      ...(packedEdges ? { edges: packedEdges } : {}),
      contours: {
        baseline: rasterContours(
          baselineRaster.areaValues,
          request.rasterSize,
          request.rasterSize,
          baselineRaster.areaBounds,
          request.cutoffsMinutes,
          'baseline',
        ),
        scenario: rasterContours(
          scenarioRaster.areaValues,
          request.rasterSize,
          request.rasterSize,
          scenarioRaster.areaBounds,
          request.cutoffsMinutes,
          'scenario',
        ),
      },
      areas: {
        baseline: rasterAreas(
          baselineRaster.areaValues,
          request.rasterSize,
          request.rasterSize,
          baselineRaster.areaBounds,
          request.cutoffsMinutes,
          'baseline',
        ),
        scenario: rasterAreas(
          scenarioRaster.areaValues,
          request.rasterSize,
          request.rasterSize,
          scenarioRaster.areaBounds,
          request.cutoffsMinutes,
          'scenario',
        ),
      },
    },
    scenario: {
      id: request.scenario.id,
      name: request.scenario.name,
      routes: routeFeatures(propagation.directions),
    },
    limitations: scenarioLimitations(request, hasScenarioChanges),
    diagnostics: {
      reachDispatches: scenarioReachRange ? 2 : 1,
      streetConnectorDispatches: 0,
      engine: 'unified_native_one_to_many',
      reach: reachResult.diagnostics ?? null,
      scenarioReach: scenarioReachRange?.diagnostics ?? null,
      scenarioConnectors: overlayDiagnostics,
      preliminary: request.includePreliminary,
      originAccess: {
        strategy: request.origin.stopId
          ? 'exact-transit-stop'
          : 'rust-cch-coordinate-one-to-many-access',
        stopIds: request.origin.stopId ? [request.origin.stopId] : [],
        candidates: request.origin.stopId ? 1 : null,
        maximumDistanceKm: request.origin.stopId ? 0 : request.maxWalkKm,
        durationMinutes: request.origin.stopId ? 0 : null,
      },
      stopSelection: stopSelection?.diagnostics ?? {
        candidates: transitStops.length,
        selected: transitStops.length,
        sampled: false,
        strategy: 'callback',
      },
      raster: {
        size: request.rasterSize,
        pixels: request.rasterSize ** 2,
        directWalkSeed: true,
        transitSeeds: baselineTransitSeeds.length,
        scenarioSeeds: scenarioServiceSeeds.length,
        reachTargets: transitStops.length,
        pixelWidthKm: round(baselineRaster.pixelWidthKm, 5),
        pixelHeightKm: round(baselineRaster.pixelHeightKm, 5),
        method: 'osm-pedestrian-network',
        surfaceModel: 'directed_osm_edge_independent_terminal_walk',
        baselineNetwork: baselineRaster.network ?? null,
        scenarioNetwork: scenarioRaster.network ?? null,
      },
      scenarioPropagation: {
        services: request.scenario.services.length,
        excludedRouteIds: request.scenario.excludedRouteIds,
        excludedTripIds: request.scenario.excludedTripIds,
        directions: propagation.directions.length,
        settledStops: propagation.settledStops,
        relaxations: propagation.relaxations,
        serviceRelaxations: propagation.serviceRelaxations,
        walkTransferRelaxations: propagation.walkTransferRelaxations,
        connectorStrategy: 'reach_owned_directed_osm_overlay_transfers',
        connectedStops: scenarioServiceStops.length,
        directedTransferPairs: overlayDiagnostics?.supplementalTransferEdges ?? 0,
        blockedTransferPairs: null,
        transferPairsEvaluated: scenarioStops.length > 1,
        queryMs: propagation.queryMs,
        algorithm: propagation.algorithm,
      },
      totalMs: round(performance.now() - startedAt),
    },
  }
  onProgress?.({ phase: 'complete', progress: 1, detail: `${baselineTransitSeeds.length.toLocaleString()} reached transit stops` })
  return result
}
