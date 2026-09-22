// Frozen JavaScript alignment oracle from before the Rust migration. Test-only.
import { haversineKm } from '../../src/server/geometry-utils.mjs'

export function shapeDistancePrefix(shapeCoordinates) {
  const prefix = new Array(shapeCoordinates.length).fill(0)
  for (let index = 1; index < shapeCoordinates.length; index += 1) {
    prefix[index] = prefix[index - 1] + haversineKm(shapeCoordinates[index - 1], shapeCoordinates[index])
  }
  return prefix
}

function nearestShapeCandidates(shapeCoordinates, stopCoordinate, limit = 16) {
  const nearest = []
  // Great-circle distance is at least the latitude separation. Reject points
  // outside the existing 1 km acceptance radius before trigonometry; this is
  // a conservative bound, including near the poles and across the dateline.
  const maximumLatitudeDelta = 180 / (Math.PI * 6371.0088) + 1e-12
  for (let index = 0; index < shapeCoordinates.length; index += 1) {
    if (Math.abs(shapeCoordinates[index][1] - stopCoordinate[1]) > maximumLatitudeDelta) continue
    const distanceKm = haversineKm(shapeCoordinates[index], stopCoordinate)
    if (distanceKm > 1) continue
    // Indices increase monotonically, so an equal-distance later point cannot
    // displace the last retained candidate. Avoid allocation and insertion work.
    if (nearest.length === limit && distanceKm >= nearest.at(-1).distanceKm) continue
    const candidate = { index, distanceKm }
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
  return nearest
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

export function alignPreparedShapeStopIndices(preparedShape, stopCoordinates, stopKeys) {
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
        if (!best || cost < best.cost || (cost === best.cost && previous.firstIndex > best.firstIndex)) {
          best = { index: candidate.index, firstIndex: previous.firstIndex, cost, previous: previousIndex }
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
