import crypto from 'node:crypto'
import { nativeOffStreetEstimates, nativeRasterAreas } from './native-routing-kernel.mjs'
export { nativeRasterAreas as rasterBoundaryAreas } from './native-routing-kernel.mjs'
import { reachChangeCounts, reachChangeStats } from './reach-comparison.mjs'
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
  const scheduleMode = value.scheduleMode ?? (operation === 'replace' ? 'preserve-trips' : 'frequency')
  if (!['preserve-trips', 'frequency'].includes(scheduleMode)) {
    throw badRequest(`scenario.services[${index}].scheduleMode must be preserve-trips or frequency.`)
  }
  const preserveTrips = scheduleMode === 'preserve-trips'
  if (preserveTrips && (operation !== 'replace' || !value.sourceRouteId || !value.sourcePatternId)) {
    throw badRequest('Keeping scheduled departures requires a replacement with sourceRouteId and sourcePatternId.')
  }
  const routeScope = ['pattern', 'edge', 'route'].includes(String(value.routeScope ?? ''))
    ? String(value.routeScope)
    : undefined
  const timeModel = ['preserve-scheduled', 'infer-road', 'estimate-distance'].includes(String(value.timeModel ?? ''))
    ? String(value.timeModel)
    : preserveTrips ? 'preserve-scheduled' : 'estimate-distance'
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
  let scheduledTrips
  if (preserveTrips) {
    if (!Array.isArray(value.scheduledTrips)) {
      throw badRequest('Scheduled replacements must be hydrated from the City timetable for the requested service date.')
    }
    if (value.scheduledTrips.length > 50_000 || value.scheduledTrips.length * stops.length > 1_000_000) {
      throw badRequest('The scheduled replacement exceeds the trip or stop-event limit.')
    }
    scheduledTrips = value.scheduledTrips.map((trip, tripIndex) => {
      const label = `scenario.services[${index}].scheduledTrips[${tripIndex}]`
      const times = (field) => {
        if (!Array.isArray(trip?.[field]) || trip[field].length !== stops.length) {
          throw badRequest(`${label}.${field} must contain one value per stop.`)
        }
        return trip[field].map((time) => boundedNumber(time, `${label}.${field}`, 0, 0xffff_ffff))
      }
      const departureOffsetsSeconds = times('departureOffsetsSeconds')
      const arrivalOffsetsSeconds = times('arrivalOffsetsSeconds')
      if (departureOffsetsSeconds[0] !== 0 || arrivalOffsetsSeconds.some((arrival, position) => (
        arrival > departureOffsetsSeconds[position] || (position > 0 && arrival < departureOffsetsSeconds[position - 1])
      ))) throw badRequest(`${label} has inconsistent arrival and departure times.`)
      const flags = (field) => {
        if (!Array.isArray(trip[field]) || trip[field].length !== stops.length || trip[field].some((flag) => flag !== 0 && flag !== 1)) {
          throw badRequest(`${label}.${field} must contain one boarding permission per stop.`)
        }
        return [...trip[field]]
      }
      return {
        tripId: compactText(trip.tripId, '', 240),
        departureSeconds: boundedNumber(trip.departureSeconds, `${label}.departureSeconds`, 0, 0xffff_ffff),
        departureOffsetsSeconds, arrivalOffsetsSeconds,
        canBoard: flags('canBoard'), canAlight: flags('canAlight'),
      }
    })
  }
  return {
    id: compactText(value.id, `service-${index + 1}`, 80),
    name: compactText(value.name, `Service ${index + 1}`),
    operation,
    scheduleMode,
    ...(preserveTrips ? { scheduledTrips } : {}),
    sourceRouteId: value.sourceRouteId ? compactText(value.sourceRouteId, '', 160) : undefined,
    sourcePatternId: value.sourcePatternId ? compactText(value.sourcePatternId, '', 240) : undefined,
    ...(routeScope ? { routeScope } : {}),
    timeModel,
    bidirectional: preserveTrips || (value.bidirectional === undefined && operation !== 'add' && value.sourcePatternId)
      ? false
      : value.bidirectional !== false,
    ...(preserveTrips ? {} : {
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
    }),
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
      value.addedStopDwellMinutes ?? (preserveTrips ? 0.35 : 0),
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
  const arrivalOffsets = []
  const canBoard = [], canAlight = []
  const runs = directions.flatMap((direction) => direction.service.scheduleMode === 'preserve-trips'
    ? direction.service.scheduledTrips.map((trip) => ({
        ...direction, trip, start: trip.departureSeconds, end: trip.departureSeconds, headway: 1,
      }))
    : [{ ...direction, start: direction.service.startMinutes * 60,
        end: direction.service.endMinutes * 60, headway: direction.service.headwayMinutes * 60 }])
  for (const direction of runs) {
    directionStops.push(...direction.indexes)
    const offsets = direction.trip?.departureOffsetsSeconds ?? direction.offsets.map((minutes) => minutes * 60)
    stopOffsets.push(...offsets)
    arrivalOffsets.push(...(direction.trip?.arrivalOffsetsSeconds ?? offsets))
    canBoard.push(...(direction.trip?.canBoard ?? direction.indexes.map(() => 1)))
    canAlight.push(...(direction.trip?.canAlight ?? direction.indexes.map(() => 1)))
    directionStarts.push(directionStops.length)
  }
  return {
    directions,
    // The planned direction each run (frequency window or kept trip) belongs to.
    runDirections: runs.map((run) => directions.findIndex((direction) => direction.id === run.id)),
    overlay: scenarioStops.length && runs.length ? {
      stops: scenarioStops,
      directionOffsets: directionStarts,
      directionStops,
      directionStopOffsetsSeconds: stopOffsets,
      directionArrivalOffsetsSeconds: arrivalOffsets,
      directionCanBoard: canBoard,
      directionCanAlight: canAlight,
      serviceStartSeconds: runs.map((direction) => direction.start),
      serviceEndSeconds: runs.map((direction) => direction.end),
      serviceHeadwaySeconds: runs.map((direction) => direction.headway),
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
      scheduleMode: direction.service.scheduleMode,
      scheduledTripCount: direction.service.scheduledTrips?.length,
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
    byCutoff: cutoffsMinutes.map((cutoffMinutes) => {
      const reachablePixels = countReachableRasterCells(values, cutoffMinutes)
      return { cutoffMinutes, reachablePixels, areaKm2: reachablePixels * pixelAreaKm2 }
    }),
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

// Fill and outline share one topology. Only GeoJSON presentation stays in JS.
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

export function rasterContours(values, width, height, bounds, cutoffsMinutes, surface) {
  return boundaryContoursFromAreas(nativeRasterAreas(values, width, height, bounds, cutoffsMinutes, surface))
}

export function rasterAreas(values, width, height, bounds, cutoffsMinutes, surface) {
  return nativeRasterAreas(values, width, height, bounds, cutoffsMinutes, surface, true)
}

// Baseline outlines repeat with the cached baseline range they come from.
const baselineBoundaryMemo = new WeakMap()

function displayBoundarySurfaces(baseline, scenario, request, readWater, baselineSource) {
  const blockEstimates = {}
  const memoKey = JSON.stringify([request.cutoffsMinutes, request.walkSpeedKph, request.surfaceSampling, request.rasterSize])
  const memo = baselineSource && typeof baselineSource === 'object' ? baselineBoundaryMemo.get(baselineSource) : null
  const build = (raster, surface) => {
    const size = request.rasterSize
    // Street sampling leaves the land between reached streets empty; shade it
    // from the fastest nearby street. Payloads keep the `blockEstimates` name.
    const estimates = request.surfaceSampling === 'street' && readWater
      ? nativeOffStreetEstimates(raster.areaValues, size, size, raster.areaBounds, readWater(raster.areaBounds), request.walkSpeedKph)
      : new Float64Array(raster.areaValues.length).fill(Infinity)
    blockEstimates[surface] = { width: size, height: size, bounds: raster.areaBounds,
      values: encodeRaster(estimates), scale: rasterScale, nodata: rasterNoData }
    const displayValues = new Float64Array(raster.areaValues.length)
    for (let index = 0; index < displayValues.length; index++) displayValues[index] = Math.min(raster.areaValues[index], estimates[index])
    return nativeRasterAreas(displayValues, size, size, raster.areaBounds, request.cutoffsMinutes, surface)
  }
  const retained = memo?.get(memoKey)
  let baselineAreas
  if (retained) {
    baselineAreas = retained.areas
    blockEstimates.baseline = retained.blocks
  } else {
    baselineAreas = build(baseline, 'baseline')
    if (baselineSource && typeof baselineSource === 'object') {
      const entries = memo ?? new Map()
      entries.set(memoKey, { areas: baselineAreas, blocks: blockEstimates.baseline })
      if (entries.size > 4) entries.delete(entries.keys().next().value)
      baselineBoundaryMemo.set(baselineSource, entries)
    }
  }
  const scenarioAreas = scenario.areaValues === baseline.areaValues
    ? featureCollection(baselineAreas.features.map(feature => ({
        ...feature,
        id: `scenario-area-${feature.properties.cutoffMinutes}`,
        properties: { ...feature.properties, surface: 'scenario', id: `scenario-area-${feature.properties.cutoffMinutes}` },
      })))
    : build(scenario, 'scenario')
  blockEstimates.scenario ??= blockEstimates.baseline
  return {
    blockEstimates,
    areas: { baseline: baselineAreas, scenario: scenarioAreas },
    contours: {
      baseline: boundaryContoursFromAreas(baselineAreas),
      scenario: boundaryContoursFromAreas(scenarioAreas),
    },
  }
}

function scenarioRequestRecord(request) {
  return {
    baselineIdentity: request.baselineIdentity,
    ...(request.feedIds ? { feedIds: request.feedIds } : {}),
    mode: request.mode,
    surfaceSampling: request.surfaceSampling,
    origin: request.origin,
    departMinutes: request.departMinutes,
    serviceDate: request.serviceDate,
    serviceDay: request.serviceDay,
    maxWalkKm: request.maxWalkKm,
    maxTransfers: request.maxTransfers,
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
    mode: request.mode === 'drive' ? 'total-elapsed-drive' : 'total-elapsed-walk-transit-walk',
    cutoffMinutes,
    baselineTerminalWalkKm: request.mode === 'drive' ? 0 : request.maxWalkKm,
    scenarioTerminalWalkKm: request.mode === 'drive' ? 0 : request.maxWalkKm,
    baselineTerminalWalkMinutes: request.mode === 'drive' ? 0 : Number(baselineMinutes.toFixed(3)),
    scenarioTerminalWalkMinutes: request.mode === 'drive' ? 0 : Number(scenarioMinutes.toFixed(3)),
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
      ...displayBoundarySurfaces(
        { areaValues: raster.values, areaBounds: raster.bounds },
        { areaValues: raster.values, areaBounds: raster.bounds },
        request,
      ),
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
      code: 'interpolated_display_boundary',
      detail: 'Map boundaries interpolate street times. Small enclosed blocks may include conservative walking estimates (at most 120 m from bordering samples, 350 m across, 0.04 km²), excluding known water. Missing or truncated water coverage disables block estimates. These are not verified interior paths or parcel boundaries. Area totals still count street-sampled cells; destination clicks run a separate journey query.',
    },
    {
      code: request.surfaceSampling === 'cell-center' ? 'coordinate_cell_centers' : 'street_network_cell_sampling',
      detail: request.surfaceSampling === 'cell-center' ? 'Each raster value routes to the coordinate at that cell center on the requested fixed grid.' : 'Surface cells use arrival times interpolated along reachable directed OSM edges; cells outside those edges remain no-data, so no straight-line travel is invented across network gaps.',
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
      detail: 'Edited branches keep their active GTFS departures unless a frequency change is explicitly selected. Stop edits model travel and dwell times. New or frequency-based services use the specified headway and operating span; none represent observed operations.',
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
    !['vigo.street.edge-bundle.v1', 'vigo.street.edge-bundle.v2'].includes(edges?.schemaVersion)
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
      .map((cutoff, index) => boundedNumber(cutoff, `cutoffsMinutes[${index}]`, 1, 240)),
  )].sort((left, right) => left - right)
  if (!cutoffsMinutes.length || cutoffsMinutes.length > 8) {
    throw badRequest('cutoffsMinutes must contain between one and eight values.')
  }
  const { scenario } = compileReachScenario(value.scenario)
  const mode = value.mode ?? 'transit'
  const surfaceSampling = mode === 'drive' ? 'cell-center' : value.surfaceSampling ?? 'street'
  if (!['street', 'cell-center'].includes(value.surfaceSampling ?? 'street')) throw badRequest('surfaceSampling must be street or cell-center.')
  if (!['transit', 'walk', 'drive'].includes(mode)) throw badRequest('Reach supports transit, walk, or drive.')
  if ((mode === 'walk' || surfaceSampling === 'cell-center') && (scenario.services.length
    || scenario.excludedRouteIds.length || scenario.excludedTripIds.length || scenario.excludedPatternIds.length)) {
    throw badRequest('Planned transit changes require transit Reach with street sampling.')
  }
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
    ...(Array.isArray(value.feedIds) ? { feedIds: [...new Set(value.feedIds.map(id => compactText(id, '', 160)))].sort() } : {}),
    origin,
    mode,
    surfaceSampling,
    departMinutes: boundedIntegralNumber(value.departMinutes, 'departMinutes', 0, 2_880, 8 * 60),
    serviceDate,
    serviceDay,
    maxWalkKm: baselineMaxWalkKm,
    maxTransfers: value.maxTransfers === undefined ? undefined
      : boundedIntegralNumber(value.maxTransfers, 'maxTransfers', 0, 31),
    walkSpeedKph: baselineWalkSpeedKph,
    includePreliminary: value.includePreliminary !== false,
    includeStreetEdges: mode !== 'drive' && value.includeStreetEdges !== false,
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
    if (service.scheduleMode === 'frequency' && service.endMinutes <= service.startMinutes) {
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
  const compiled = compileScenarioOverlay({
    services,
    scenarioStops,
    serviceStopIndexes,
  })
  return {
    scenario,
    overlay: compiled.overlay,
    directions: compiled.directions,
    runDirections: compiled.runDirections,
  }
}

/**
 * The plan point-to-point routing applies to the timetable: the same compiled
 * runs as Reach, the trips and routes they remove, and per-direction labels
 * and geometry so journeys can describe planned service.
 */
export function compileRouteScenario(value) {
  const { scenario, overlay, directions, runDirections } = compileReachScenario(value)
  const changed = Boolean(overlay || scenario.excludedRouteIds.length || scenario.excludedTripIds.length)
  if (!changed) return null
  const plan = {
    id: scenario.id,
    name: scenario.name,
    overlay,
    runDirections,
    directions: directions.map((direction) => ({
      id: direction.id,
      serviceId: direction.service.id,
      name: direction.service.name,
      operation: direction.service.operation,
      sourceRouteId: direction.service.sourceRouteId,
      inbound: direction.id.endsWith(':inbound'),
      geometry: direction.geometry?.length >= 2 ? direction.geometry : direction.stops.map((stop) => stop.coordinate),
    })),
    excludedRouteIds: scenario.excludedRouteIds,
    excludedTripIds: scenario.excludedTripIds,
  }
  plan.identity = crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 24)
  return plan
}

function roundedCoordinates(value) {
  return typeof value[0] === 'number'
    ? value.map((number) => Math.round(number * 1e6) / 1e6)
    : value.map(roundedCoordinates)
}

/**
 * Studio's map payload for a Reach result. Outlines are the area boundaries,
 * so they are drawn from the fills instead of sent twice; coordinates keep six
 * decimals (about 0.1 m); and an unchanged scenario surface is not repeated.
 * `inflateReachResult` in the client restores the full shape.
 */
export function compactReachResult(result) {
  const surface = result?.surface
  if (!surface?.raster) return result
  const shared = surface.raster.scenario === surface.raster.baseline
  const areas = Object.fromEntries(Object.entries(surface.areas ?? {})
    .filter(([key]) => !shared || key !== 'scenario')
    .map(([key, collection]) => [key, {
      ...collection,
      features: collection.features.map((feature) => ({
        ...feature,
        geometry: { ...feature.geometry, coordinates: roundedCoordinates(feature.geometry.coordinates) },
      })),
    }]))
  const blockEstimates = surface.blockEstimates
    && surface.blockEstimates.scenario === surface.blockEstimates.baseline
    ? { baseline: surface.blockEstimates.baseline }
    : surface.blockEstimates
  const { contours: _contours, ...rest } = surface
  return {
    ...result,
    surface: {
      ...rest,
      raster: shared ? { ...surface.raster, scenario: undefined } : surface.raster,
      ...(surface.areas ? { areas } : {}),
      ...(blockEstimates ? { blockEstimates } : {}),
      compact: { contours: 'from-areas', scenario: shared ? 'baseline' : 'own' },
    },
  }
}

export async function computeReachResult(
  value,
  {
    runReach,
    buildPreliminaryStreetRaster,
    readDisplayWater,
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
    && request.surfaceSampling === 'street'
    && typeof buildPreliminaryStreetRaster !== 'function'
  ) {
    throw new TypeError('A preliminary scenario preview requires an OSM street-raster function.')
  }
  if (onPreliminary && request.includePreliminary && request.surfaceSampling === 'street') {
    onPreliminary(await preliminaryWalkSurface(
      request,
      startedAt,
      buildPreliminaryStreetRaster,
    ))
  }
  let stopSelection
  let transitStops
  let baselineTransitDurations
  const phaseTimes = {}
  let phaseStarted = performance.now()
  const phase = (name) => {
    const now = performance.now()
    phaseTimes[name] = round(now - phaseStarted)
    phaseStarted = now
  }
  const reachResult = await runReach({
    mode: request.mode,
    surfaceSampling: request.surfaceSampling,
    stage: 'baseline-range',
    feedId: request.feedId,
    origin: request.origin,
    departMinutes: request.departMinutes,
    serviceDate: request.serviceDate,
    serviceDay: request.serviceDay,
    maxWalkKm: request.maxWalkKm,
    maxTransfers: request.maxTransfers,
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
  phase('baselineRangeMs')
  let scenarioReachRange = null
  // A remix runs the scenario on a different set of the City's timetables.
  const remixed = value?.remixed === true
  const scenarioTransitQueryChanged = (
    remixed
    || request.scenario.services.length > 0
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
      maxTransfers: request.maxTransfers,
      walkSpeedKph: request.walkSpeedKph,
      cutoffMinutes: request.cutoffsMinutes.at(-1),
      excludedRouteIds: request.scenario.excludedRouteIds,
      excludedTripIds: request.scenario.excludedTripIds,
      scenarioServices: request.scenario.services,
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
  phase('scenarioRangeMs')
  const baselineRaster = rasterFromReach(reachResult, 'baseline')
  const hasScenarioChanges = Boolean(
    remixed
    || request.scenario.services.length
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
  const changeCountsByCutoff = reachChangeCounts(baselineRaster.values, scenarioRaster.values, request.cutoffsMinutes)
  const improvedPixels = changeCountsByCutoff.at(-1).improvedPixels
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

  phase('metricsMs')
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
  phase('encodeMs')
  const timedBoundaries = displayBoundarySurfaces(baselineRaster, scenarioRaster, request, readDisplayWater, reachResult)
  phase('boundariesMs')
  const result = {
    schemaVersion: 'vigo.result.reach.v1',
    request: scenarioRequestRecord(request),
    summary: {
      pixels: request.rasterSize ** 2,
      baselineReachablePixels,
      scenarioReachablePixels,
      improvedPixels,
      changeCountsByCutoff,
      // Same requested grid as changeCountsByCutoff.
      changeStatsByCutoff: hasScenarioChanges
        ? reachChangeStats(baselineRaster.values, scenarioRaster.values, request.cutoffsMinutes)
        : null,
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
      ...timedBoundaries,
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
      phases: phaseTimes,
      totalMs: round(performance.now() - startedAt),
    },
  }
  onProgress?.({ phase: 'complete', progress: 1, detail: `${baselineTransitSeeds.length.toLocaleString()} reached transit stops` })
  return result
}
