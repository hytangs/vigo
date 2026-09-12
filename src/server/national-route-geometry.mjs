import {
  appendDistinctCoordinates,
  haversineKm,
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

function cachedNationalShapeCoordinatesById(store, shapeId) {
  if (!store.shapePointsLookup || !shapeId) return null
  if (store.shapeGeometryCache.has(shapeId)) {
    const preparedShape = store.shapeGeometryCache.get(shapeId)
    store.shapeGeometryCache.delete(shapeId)
    store.shapeGeometryCache.set(shapeId, preparedShape)
    return { shapeId, ...preparedShape }
  }
  const coordinates = store.shapePointsLookup.all(shapeId)
    .map((point) => [numeric(point.lon, NaN), numeric(point.lat, NaN)])
    .filter((coordinate) => coordinate.every(Number.isFinite))
  if (coordinates.length < 2) return null
  const preparedShape = {
    coordinates,
    prefixKm: shapeDistancePrefix(coordinates),
    candidatesByStop: new Map(),
    estimatedBytes: coordinates.length * 24 + 256,
  }
  const maximumEntries = Math.max(1, Number(store.shapeGeometryCacheMaxEntries ?? 4096))
  const maximumBytes = Math.max(1, Number(store.shapeGeometryCacheMaxBytes ?? 256 * 1024 * 1024))
  let retainedBytes = Number(store.shapeGeometryCacheBytes ?? 0)
  while (
    store.shapeGeometryCache.size >= maximumEntries
    || retainedBytes + preparedShape.estimatedBytes > maximumBytes
  ) {
    const oldestShapeId = store.shapeGeometryCache.keys().next().value
    if (oldestShapeId === undefined) break
    const removed = store.shapeGeometryCache.get(oldestShapeId)
    store.shapeGeometryCache.delete(oldestShapeId)
    retainedBytes = Math.max(0, retainedBytes - numeric(removed?.estimatedBytes, 0))
  }
  if (preparedShape.estimatedBytes <= maximumBytes) {
    store.shapeGeometryCache.set(shapeId, preparedShape)
    retainedBytes += preparedShape.estimatedBytes
  }
  store.shapeGeometryCacheBytes = retainedBytes
  return { shapeId, ...preparedShape }
}

function cachedNationalShapeCoordinates(store, tripId) {
  if (!store.tripShapeLookup || !store.shapePointsLookup) return null
  const shapeId = shapeIdForTrip(store, tripId)
  if (!shapeId) return null
  return cachedNationalShapeCoordinatesById(store, shapeId)
}

function shapeDistancePrefix(shapeCoordinates) {
  const prefix = new Array(shapeCoordinates.length).fill(0)
  for (let index = 1; index < shapeCoordinates.length; index += 1) {
    prefix[index] = prefix[index - 1] + haversineKm(shapeCoordinates[index - 1], shapeCoordinates[index])
  }
  return prefix
}

function nearestShapeCandidates(shapeCoordinates, stopCoordinate, limit = 16) {
  const nearest = []
  for (let index = 0; index < shapeCoordinates.length; index += 1) {
    const candidate = { index, distanceKm: haversineKm(shapeCoordinates[index], stopCoordinate) }
    let insertionIndex = nearest.length
    while (insertionIndex > 0) {
      const previous = nearest[insertionIndex - 1]
      if (previous.distanceKm < candidate.distanceKm) break
      if (previous.distanceKm === candidate.distanceKm && previous.index < candidate.index) break
      insertionIndex -= 1
    }
    if (insertionIndex >= limit) continue
    nearest.splice(insertionIndex, 0, candidate)
    if (nearest.length > limit) nearest.pop()
  }
  return nearest.filter((candidate) => candidate.distanceKm <= 1)
}

function cachedShapeCandidates(preparedShape, stopCoordinate, stopKey) {
  if (!stopKey) return nearestShapeCandidates(preparedShape.coordinates, stopCoordinate)
  const cache = preparedShape.candidatesByStop
  if (cache.has(stopKey)) return cache.get(stopKey)
  const candidates = nearestShapeCandidates(preparedShape.coordinates, stopCoordinate)
  // Normal GTFS shapes reference only tens of stops. This bound prevents a
  // malformed feed that reuses one shape globally from growing memory forever.
  if (cache.size >= 2048) cache.delete(cache.keys().next().value)
  cache.set(stopKey, candidates)
  return candidates
}

function alignPreparedShapeStopIndices(preparedShape, stopCoordinates, stopKeys) {
  if (!preparedShape?.coordinates?.length || stopCoordinates.length < 2) return null
  const candidateLayers = stopCoordinates.map((coordinate, index) => (
    cachedShapeCandidates(preparedShape, coordinate, stopKeys[index])
  ))
  if (candidateLayers.some((candidates) => !candidates.length)) return null
  let states = candidateLayers[0].map((candidate) => ({
    index: candidate.index,
    firstIndex: candidate.index,
    cost: candidate.distanceKm,
    previous: -1,
  }))
  const layers = [states]
  for (let stopIndex = 1; stopIndex < candidateLayers.length; stopIndex += 1) {
    const directStopKm = haversineKm(stopCoordinates[stopIndex - 1], stopCoordinates[stopIndex])
    const nextStates = []
    for (const candidate of candidateLayers[stopIndex]) {
      let best = null
      for (let previousIndex = 0; previousIndex < states.length; previousIndex += 1) {
        const previous = states[previousIndex]
        if (candidate.index < previous.index) continue
        const shapeSectionKm = preparedShape.prefixKm[candidate.index]
          - preparedShape.prefixKm[previous.index]
        const excessiveDetourKm = Math.max(0, shapeSectionKm - Math.max(0.2, directStopKm * 3))
        const collapsedProgressPenalty = candidate.index === previous.index && directStopKm > 0.05 ? 2 : 0
        const cost = previous.cost + candidate.distanceKm + excessiveDetourKm * 0.05 + collapsedProgressPenalty
        const state = {
          index: candidate.index,
          firstIndex: previous.firstIndex,
          cost,
          previous: previousIndex,
        }
        if (!best || cost < best.cost || (cost === best.cost && state.firstIndex > best.firstIndex)) {
          best = state
        }
      }
      if (best) nextStates.push(best)
    }
    if (!nextStates.length) return null
    states = nextStates
    layers.push(states)
  }
  let selected = -1
  for (let index = 0; index < states.length; index += 1) {
    const candidate = states[index]
    if (candidate.index <= candidate.firstIndex) continue
    if (
      selected < 0
      || candidate.cost < states[selected].cost
      || (candidate.cost === states[selected].cost
        && candidate.index - candidate.firstIndex
          < states[selected].index - states[selected].firstIndex)
    ) selected = index
  }
  if (selected < 0) return null
  const indices = new Array(layers.length)
  for (let layer = layers.length - 1; layer >= 0; layer -= 1) {
    const state = layers[layer][selected]
    indices[layer] = state.index
    selected = state.previous
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
      ? alignPreparedShapeStopIndices(shape, coordinates, stopIds)
      : null
    if (shapeIndices) alignment = { shapeId, shapeIndices, startSegment: start, endSegment: end }
  }
  const limit = Math.max(1, Number(store.shapeGeometryCacheMaxEntries ?? 4096))
  while (alignments.size >= limit) alignments.delete(alignments.keys().next().value)
  // Retain indices only: shape coordinates remain subject to the store byte budget.
  alignments.set(trip, alignment)
  return alignment ? { ...alignment, shape } : null
}

function clipPreparedShapeCoordinatesThroughStops(preparedShape, stopCoordinates, stopKeys = []) {
  const shapeCoordinates = preparedShape?.coordinates
  if (!shapeCoordinates?.length || !stopCoordinates?.length || stopCoordinates.length < 2) return null
  const candidatesByStop = stopCoordinates.map((coordinate, index) => (
    cachedShapeCandidates(preparedShape, coordinate, stopKeys[index])
  ))
  if (candidatesByStop.some((candidates) => !candidates.length)) return null
  const shapePrefixKm = preparedShape.prefixKm
  let states = candidatesByStop[0].map((candidate) => ({
    index: candidate.index,
    firstIndex: candidate.index,
    cost: candidate.distanceKm,
  }))

  for (let stopIndex = 1; stopIndex < candidatesByStop.length; stopIndex += 1) {
    const directStopKm = haversineKm(stopCoordinates[stopIndex - 1], stopCoordinates[stopIndex])
    const nextStates = []
    for (const candidate of candidatesByStop[stopIndex]) {
      let best = null
      for (const previous of states) {
        if (candidate.index < previous.index) continue
        const shapeSectionKm = shapePrefixKm[candidate.index] - shapePrefixKm[previous.index]
        const excessiveDetourKm = Math.max(0, shapeSectionKm - Math.max(0.2, directStopKm * 3))
        const collapsedProgressPenalty = candidate.index === previous.index && directStopKm > 0.05 ? 2 : 0
        const cost = previous.cost + candidate.distanceKm + excessiveDetourKm * 0.05 + collapsedProgressPenalty
        const state = { index: candidate.index, firstIndex: previous.firstIndex, cost }
        if (!best || cost < best.cost || (cost === best.cost && state.firstIndex > best.firstIndex)) best = state
      }
      if (best) nextStates.push(best)
    }
    if (!nextStates.length) return null
    states = nextStates
  }

  const best = states
    .filter((state) => state.index > state.firstIndex)
    .sort((left, right) => left.cost - right.cost || (left.index - left.firstIndex) - (right.index - right.firstIndex))[0]
  if (!best) return null
  return boundedLineCoordinates(appendDistinctCoordinates(
    [stopCoordinates[0]],
    [...shapeCoordinates.slice(best.firstIndex, best.index + 1), stopCoordinates.at(-1)],
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
    prefixKm: shapeDistancePrefix(shapeCoordinates ?? []),
    candidatesByStop: new Map(),
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
  const stopKeys = []
  if (from) {
    stopCoordinates.push([from.lon, from.lat])
    stopKeys.push(String(first.from_stop_id))
  }
  for (const connection of connections) {
    const stop = stopLookup.get(connection.to_stop_id)
    if (stop) {
      stopCoordinates.push([stop.lon, stop.lat])
      stopKeys.push(String(connection.to_stop_id))
    }
  }
  const shape = cachedNationalShapeCoordinates(store, first.trip_id)
  const shapeCoordinates = shape && stopCoordinates.length >= 2
    ? clipPreparedShapeCoordinatesThroughStops(shape, stopCoordinates, stopKeys)
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
