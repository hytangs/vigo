import { createNativeShapeGeometry, alignNativeShapeStops } from './native-routing-kernel.mjs'
import {
  appendDistinctCoordinates,
  lineDistanceKm,
} from './geometry-utils.mjs'
import { numeric } from './number-utils.mjs'

export function deduplicateNationalRouteCoordinates(coordinates) {
  const source = Array.isArray(coordinates) ? coordinates : []
  const distinct = appendDistinctCoordinates([], source)
  // A degenerate source edge still needs two GeoJSON positions. Preserve
  // that explicit zero-length line while removing redundant interior points
  // from every drawable route geometry.
  return distinct.length === 1 && source.length >= 2
    ? [distinct[0], distinct[0]]
    : distinct
}

function boundedLineCoordinates(coordinates, limit = 512) {
  if (coordinates.length <= limit) return coordinates
  const stride = Math.ceil((coordinates.length - 1) / (limit - 1))
  const sampled = coordinates.filter((_coordinate, index) => index === 0 || index === coordinates.length - 1 || index % stride === 0)
  if (sampled.at(-1) !== coordinates.at(-1)) sampled.push(coordinates.at(-1))
  return sampled
}

function shapeIdForTrip(store, tripId) {
  const normalizedTripId = String(tripId ?? '').trim()
  if (!normalizedTripId || !store.tripShapeLookup) return ''
  const retained = store.tripShapeIdCache?.get(normalizedTripId)
  if (retained !== undefined) return retained
  const shapeId = String(store.tripShapeLookup.get(normalizedTripId)?.shape_id ?? '').trim()
  if (store.tripShapeIdCache) {
    const maximumEntries = Math.max(1, Number(store.tripShapeIdCacheMaxEntries ?? 500_000))
    while (store.tripShapeIdCache.size >= maximumEntries) {
      const oldestTripId = store.tripShapeIdCache.keys().next().value
      if (oldestTripId === undefined) break
      store.tripShapeIdCache.delete(oldestTripId)
    }
    store.tripShapeIdCache.set(normalizedTripId, shapeId)
  }
  return shapeId
}

function trimShapeCache(store) {
  const maximumEntries = Math.max(1, Number(store.shapeGeometryCacheMaxEntries ?? 4096))
  const maximumBytes = Math.max(1, Number(store.shapeGeometryCacheMaxBytes ?? 256 * 1024 * 1024))
  while (store.shapeGeometryCache.size > maximumEntries || store.shapeGeometryCacheBytes > maximumBytes) {
    const oldestShapeId = store.shapeGeometryCache.keys().next().value
    if (oldestShapeId === undefined) break
    const removed = store.shapeGeometryCache.get(oldestShapeId)
    store.shapeGeometryCache.delete(oldestShapeId)
    store.shapeGeometryCacheBytes = Math.max(0, store.shapeGeometryCacheBytes - removed.estimatedBytes)
  }
}

function shapeEstimatedBytes(shape) {
  return shape.coordinates.length * 24 + shape.native.estimatedBytes + 256
}

function cachedNationalShapeCoordinatesById(store, shapeId) {
  if (!store.shapePointsLookup || !shapeId) return null
  if (store.shapeGeometryCache.has(shapeId)) {
    const preparedShape = store.shapeGeometryCache.get(shapeId)
    store.shapeGeometryCache.delete(shapeId)
    store.shapeGeometryCache.set(shapeId, preparedShape)
    return preparedShape
  }
  const coordinates = store.shapePointsLookup.all(shapeId)
    .map((point) => [numeric(point.lon, NaN), numeric(point.lat, NaN)])
    .filter((coordinate) => coordinate.every(Number.isFinite))
  if (coordinates.length < 2) return null
  const preparedShape = { shapeId, coordinates, native: createNativeShapeGeometry(coordinates) }
  preparedShape.estimatedBytes = shapeEstimatedBytes(preparedShape)
  store.shapeGeometryCache.set(shapeId, preparedShape)
  store.shapeGeometryCacheBytes = Number(store.shapeGeometryCacheBytes ?? 0) + preparedShape.estimatedBytes
  trimShapeCache(store)
  return preparedShape
}

function cachedNationalShapeCoordinates(store, tripId) {
  if (!store.tripShapeLookup || !store.shapePointsLookup) return null
  const shapeId = shapeIdForTrip(store, tripId)
  if (!shapeId) return null
  return cachedNationalShapeCoordinatesById(store, shapeId)
}

function alignPreparedShapeStopIndices(preparedShape, stopCoordinates, store) {
  if (!preparedShape?.coordinates?.length || stopCoordinates.length < 2) return null
  const indices = alignNativeShapeStops(preparedShape.native, stopCoordinates)
  if (store?.shapeGeometryCache.get(preparedShape.shapeId) === preparedShape) {
    const bytes = shapeEstimatedBytes(preparedShape)
    store.shapeGeometryCacheBytes += bytes - preparedShape.estimatedBytes
    preparedShape.estimatedBytes = bytes
    trimShapeCache(store)
  }
  return indices
}

// A kernel owns the segment indices. Keeping this cache with that kernel also
// prevents an alignment from a different service date being reused accidentally.
const tripAlignmentsByKernel = new WeakMap()

function selectedTripShapeAlignment(store, connection) {
  const kernel = store.activeServiceKernel
  const segment = Number(connection.kernel_segment_index)
  if (!kernel || !Number.isInteger(segment) || segment < 0) return null
  const trip = kernel.segmentTrip[segment]
  if (trip === undefined || kernel.tripIds[trip] !== connection.trip_id) return null
  let alignments = tripAlignmentsByKernel.get(kernel)
  if (!alignments) {
    alignments = new Map()
    tripAlignmentsByKernel.set(kernel, alignments)
  }
  if (alignments.has(trip)) {
    const alignment = alignments.get(trip)
    alignments.delete(trip)
    alignments.set(trip, alignment)
    return alignment
  }
  const shapeId = shapeIdForTrip(store, connection.trip_id)
  const shape = cachedNationalShapeCoordinatesById(store, shapeId)
  const start = kernel.tripStart[trip]
  const end = kernel.tripStart[trip + 1]
  let alignment = null
  if (shape && start < end) {
    const stopIds = [kernel.stopIds[kernel.fromStop[start]]]
    for (let index = start; index < end; index += 1) {
      stopIds.push(kernel.stopIds[kernel.toStop[index]])
    }
    const coordinates = stopIds.map((stopId) => {
      const stop = store.stopLookup.get(stopId)
      return [numeric(stop?.lon, NaN), numeric(stop?.lat, NaN)]
    })
    const shapeIndices = coordinates.every((coordinate) => coordinate.every(Number.isFinite))
      ? alignPreparedShapeStopIndices(shape, coordinates, store)
      : null
    if (shapeIndices) alignment = { shapeId, shapeIndices, startSegment: start, endSegment: end }
  }
  const limit = Math.max(1, Number(store.shapeGeometryCacheMaxEntries ?? 4096))
  while (alignments.size >= limit) alignments.delete(alignments.keys().next().value)
  // Retain indices only: shape coordinates remain subject to the store byte budget.
  alignments.set(trip, alignment)
  return alignment ? { ...alignment, shape } : null
}

function clipPreparedShapeCoordinatesThroughStops(preparedShape, stopCoordinates, store) {
  const shapeCoordinates = preparedShape?.coordinates
  if (!shapeCoordinates?.length || !stopCoordinates?.length || stopCoordinates.length < 2) return null
  const indices = alignPreparedShapeStopIndices(preparedShape, stopCoordinates, store)
  if (!indices) return null
  return boundedLineCoordinates(appendDistinctCoordinates(
    [stopCoordinates[0]],
    [...shapeCoordinates.slice(indices[0], indices.at(-1) + 1), stopCoordinates.at(-1)],
  ))
}

/**
 * Match every scheduled stop to a monotone point on its trip shape. Intermediate
 * stops disambiguate repeated coordinates and looped shapes that cannot be
 * clipped safely from endpoints alone.
 */
export function clipNationalShapeCoordinatesThroughStops(shapeCoordinates, stopCoordinates) {
  return clipPreparedShapeCoordinatesThroughStops({
    coordinates: shapeCoordinates,
    native: createNativeShapeGeometry(shapeCoordinates ?? []),
  }, stopCoordinates)
}

export function clipNationalShapeCoordinates(shapeCoordinates, fromCoordinate, toCoordinate) {
  return clipNationalShapeCoordinatesThroughStops(shapeCoordinates, [fromCoordinate, toCoordinate])
}

export function nationalRideGeometry(store, connections, stopLookup) {
  const first = connections[0]
  const last = connections.at(-1)
  if (!first || !last) return { coordinates: [], distanceKm: 0, geometrySource: 'stop_sequence' }
  const from = stopLookup.get(first.from_stop_id)
  const to = stopLookup.get(last.to_stop_id)
  const alignment = selectedTripShapeAlignment(store, first)
  const alignedShape = alignment?.shape
    ?? (alignment ? cachedNationalShapeCoordinatesById(store, alignment.shapeId) : null)
  const firstSegment = Number(first.kernel_segment_index)
  const lastSegment = Number(last.kernel_segment_index)
  if (
    alignment
    && alignedShape
    && Number.isInteger(firstSegment)
    && Number.isInteger(lastSegment)
    && firstSegment >= alignment.startSegment
    && lastSegment < alignment.endSegment
  ) {
    const firstShapeIndex = alignment.shapeIndices[firstSegment - alignment.startSegment]
    const lastShapeIndex = alignment.shapeIndices[lastSegment - alignment.startSegment + 1]
    if (Number.isInteger(firstShapeIndex) && Number.isInteger(lastShapeIndex) && lastShapeIndex > firstShapeIndex) {
      const coordinates = deduplicateNationalRouteCoordinates(boundedLineCoordinates(
        appendDistinctCoordinates(
          from ? [[from.lon, from.lat]] : [],
          [
            ...alignedShape.coordinates.slice(firstShapeIndex, lastShapeIndex + 1),
            ...(to ? [[to.lon, to.lat]] : []),
          ],
        ),
      ))
      return {
        coordinates,
        distanceKm: lineDistanceKm(coordinates),
        geometrySource: 'shape',
        shapeId: alignment.shapeId,
      }
    }
  }
  const stopCoordinates = []
  if (from) {
    stopCoordinates.push([from.lon, from.lat])
  }
  for (const connection of connections) {
    const stop = stopLookup.get(connection.to_stop_id)
    if (stop) {
      stopCoordinates.push([stop.lon, stop.lat])
    }
  }
  const shape = cachedNationalShapeCoordinates(store, first.trip_id)
  const shapeCoordinates = shape && stopCoordinates.length >= 2
    ? clipPreparedShapeCoordinatesThroughStops(shape, stopCoordinates, store)
    : null
  const coordinates = deduplicateNationalRouteCoordinates(
    shapeCoordinates ?? stopCoordinates,
  )
  return {
    coordinates,
    distanceKm: lineDistanceKm(coordinates),
    geometrySource: shapeCoordinates ? 'shape' : 'stop_sequence',
    shapeId: shapeCoordinates ? shape.shapeId : undefined,
  }
}
