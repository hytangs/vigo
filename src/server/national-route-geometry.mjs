import { createNativeShapeGeometry, createNativeShapeGeometrySource, alignNativeShapeStops } from './native-routing-kernel.mjs'
import {
  appendDistinctCoordinates,
  haversineKm,
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
  return shape.coordinates.byteLength + (shape.distinctIndices?.byteLength ?? 0) + shape.native.estimatedBytes + 256
}

function cachedNationalShapeCoordinatesById(store, shapeId) {
  if (!store.shapePointsLookup || !shapeId) return null
  if (store.shapeGeometryCache.has(shapeId)) {
    const preparedShape = store.shapeGeometryCache.get(shapeId)
    store.shapeGeometryCache.delete(shapeId)
    store.shapeGeometryCache.set(shapeId, preparedShape)
    return preparedShape
  }
  let native
  if (store.nativeShapeSource || store.storePath) {
    store.nativeShapeSource ??= createNativeShapeGeometrySource(store.storePath)
    native = store.nativeShapeSource.readShape(shapeId)
  } else {
    // In-memory source adapters, including fixtures, share the native pipeline.
    const coordinates = store.shapePointsLookup.all(shapeId)
      .map((point) => [numeric(point.lon, NaN), numeric(point.lat, NaN)])
      .filter((coordinate) => coordinate.every(Number.isFinite))
    if (coordinates.length >= 2) native = createNativeShapeGeometry(coordinates)
  }
  if (!native) return null
  const columns = native.renderCoordinates()
  const preparedShape = { shapeId, native, coordinates: columns.coordinates, distinctIndices: columns.distinctIndices ?? null }
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
  if (!preparedShape?.coordinates?.length || !stopCoordinates?.length || stopCoordinates.length < 2) return null
  const indices = alignPreparedShapeStopIndices(preparedShape, stopCoordinates, store)
  if (!indices) return null
  return clipPackedShapeCoordinates(preparedShape.coordinates, indices[0], indices.at(-1), stopCoordinates[0], stopCoordinates.at(-1), 512, preparedShape.distinctIndices)
}

function upperBoundPointIndex(indices, value) {
  let low = 0, high = indices.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (indices[middle] <= value) low = middle + 1
    else high = middle
  }
  return low
}

function clipIndexedShapeCoordinates(packed, indices, start, end, from, to, limit) {
  const begin = indices ? upperBoundPointIndex(indices, start) : start + 1
  const finish = indices ? upperBoundPointIndex(indices, end) : end + 1
  const sourceCount = 1 + finish - begin
  const last = sourceCount === 1 ? start : indices ? indices[finish - 1] : end
  const hasFrom = Boolean(from)
  const skipFirst = hasFrom && from[0] === packed[start * 2] && from[1] === packed[start * 2 + 1]
  const hasTo = Boolean(to) && (to[0] !== packed[last * 2] || to[1] !== packed[last * 2 + 1])
  const count = sourceCount + Number(hasFrom) - Number(skipFirst) + Number(hasTo)
  const stride = Math.max(1, Math.ceil((count - 1) / (limit - 1)))
  const coordinates = []
  const append = (position) => {
    if (hasFrom && position === 0) {
      coordinates.push([from[0], from[1]])
      return
    }
    const source = position - Number(hasFrom) + Number(skipFirst)
    if (source >= sourceCount) coordinates.push([to[0], to[1]])
    else {
      // A slice beginning inside a duplicate run must keep its own first
      // position (including signed zero), not the earlier global run start.
      const index = source === 0 ? start : indices ? indices[begin + source - 1] : start + source
      coordinates.push([packed[index * 2], packed[index * 2 + 1]])
    }
  }
  for (let position = 0; position < count - 1; position += stride) append(position)
  append(count - 1)
  return coordinates
}

// Preserve distinct-then-stride sampling without expanding the full shape
// slice into point arrays. Only the output positions allocate JS objects.
export function clipPackedShapeCoordinates(packed, start, end, from, to, limit = 512, distinctIndices = undefined) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end
    || end * 2 + 1 >= packed.length || !Number.isInteger(limit) || limit < 2) {
    throw new Error('Invalid shape clipping bounds.')
  }
  const first = start - Number(Boolean(from)), last = end + Number(Boolean(to))
  // null denotes the identity projection; undefined is an unindexed caller.
  // A short slice already needs only one bounded pass. Longer slices visit
  // sampled output positions through the index instead of scanning twice.
  if (distinctIndices !== undefined && last - first + 1 > limit) {
    return clipIndexedShapeCoordinates(packed, distinctIndices, start, end, from, to, limit)
  }
  const coordinates = []
  const visit = (stride, count) => {
    let previousLon, previousLat, distinct = 0
    for (let index = first; index <= last; index += 1) {
      const lon = index < start ? from[0] : index > end ? to[0] : packed[index * 2]
      const lat = index < start ? from[1] : index > end ? to[1] : packed[index * 2 + 1]
      if (distinct && lon === previousLon && lat === previousLat) continue
      previousLon = lon
      previousLat = lat
      if (stride && (distinct % stride === 0 || distinct === count - 1)) coordinates.push([lon, lat])
      distinct += 1
    }
    return distinct
  }
  if (last - first + 1 <= limit) visit(1, 0)
  else {
    const count = visit(0, 0)
    visit(Math.max(1, Math.ceil((count - 1) / (limit - 1))), count)
  }
  return coordinates
}

/**
 * Match every scheduled stop to a monotone point on its trip shape. Intermediate
 * stops disambiguate repeated coordinates and looped shapes that cannot be
 * clipped safely from endpoints alone.
 */
export function clipNationalShapeCoordinatesThroughStops(shapeCoordinates, stopCoordinates) {
  const native = createNativeShapeGeometry(shapeCoordinates ?? [])
  const columns = native.renderCoordinates()
  return clipPreparedShapeCoordinatesThroughStops({
    native, coordinates: columns.coordinates, distinctIndices: columns.distinctIndices ?? null,
  }, stopCoordinates)
}

export function clipNationalShapeCoordinates(shapeCoordinates, fromCoordinate, toCoordinate) {
  return clipNationalShapeCoordinatesThroughStops(shapeCoordinates, [fromCoordinate, toCoordinate])
}

// The caller owns this newly materialized array. Compact sampled duplicates
// and sum the same retained edges in one pass, without two more array copies.
function finishRideGeometry(coordinates, geometrySource, shapeId) {
  const sourceLength = coordinates.length
  let length = sourceLength ? 1 : 0
  let previous = coordinates[0]
  let distanceKm = 0
  for (let index = 1; index < sourceLength; index += 1) {
    const coordinate = coordinates[index]
    if (previous[0] === coordinate[0] && previous[1] === coordinate[1]) continue
    distanceKm += haversineKm(previous, coordinate)
    coordinates[length++] = coordinate
    previous = coordinate
  }
  if (length === 1 && sourceLength >= 2) {
    coordinates[length++] = coordinates[0]
    distanceKm += haversineKm(coordinates[0], coordinates[0])
  }
  coordinates.length = length
  return { coordinates, distanceKm, geometrySource, shapeId }
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
      const coordinates = clipPackedShapeCoordinates(
        alignedShape.coordinates, firstShapeIndex, lastShapeIndex,
        from ? [from.lon, from.lat] : null, to ? [to.lon, to.lat] : null,
        512, alignedShape.distinctIndices,
      )
      return finishRideGeometry(coordinates, 'shape', alignment.shapeId)
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
  return finishRideGeometry(
    shapeCoordinates ?? stopCoordinates, shapeCoordinates ? 'shape' : 'stop_sequence',
    shapeCoordinates ? shape.shapeId : undefined,
  )
}
