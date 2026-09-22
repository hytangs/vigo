import { emptyCollection, type FeatureCollection } from './featureGeometry'

import type { LngLat } from '../domain'
import {
  reachDifferenceColor,
  reachTimeColor,
  type ReachResult,
  type ScenarioStopDraft,
  type ScenarioStreetEdgeBundle,
  type ScenarioStreetEdgeSource,
  type ScenarioView,
} from '../reach'

export function scenarioSketchFeatures(stops: ScenarioStopDraft[], geometry: LngLat[] = []): FeatureCollection {
  const features: FeatureCollection['features'] = stops.map((stop, index) => ({
    type: 'Feature',
    id: stop.id,
    properties: {
      id: stop.id,
      label: stop.label,
      sequenceLabel: String(index + 1),
      stopNumber: index + 1,
      index,
      kind: 'stop',
      source: stop.source,
      editStatus: stop.editStatus ?? 'baseline',
    },
    geometry: { type: 'Point', coordinates: stop.coordinate },
  }))
  if (stops.length >= 2) {
    features.unshift({
      type: 'Feature',
      id: 'scenario-sketch-line',
      properties: { id: 'scenario-sketch-line', kind: 'line' },
      geometry: { type: 'LineString', coordinates: geometry.length >= 2 ? geometry : stops.map((stop) => stop.coordinate) },
    })
  }
  return { type: 'FeatureCollection', features }
}

export function scenarioContourFeatures(
  analysis: ReachResult | null | undefined,
  view: ScenarioView,
  cutoffMinutes: number,
): FeatureCollection {
  if (!analysis) return emptyCollection
  const surfaces = view === 'comparison'
    ? ['baseline', 'scenario'] as const
    : [view] as const
  return {
    type: 'FeatureCollection',
    features: surfaces.flatMap((surface) => (
      analysis.surface.contours[surface].features.filter((feature) => (
        Number(feature.properties?.cutoffMinutes) === cutoffMinutes
      ))
    )),
  }
}

export function scenarioAreaFeatures(
  analysis: ReachResult | null | undefined,
  view: ScenarioView,
  cutoffMinutes: number,
): FeatureCollection {
  if (!analysis?.surface.areas) return emptyCollection
  const surfaces = view === 'comparison'
    ? ['baseline', 'scenario'] as const
    : [view] as const
  return {
    type: 'FeatureCollection',
    features: surfaces.flatMap((surface) => (
      analysis.surface.areas?.[surface].features
        .filter((feature) => Number(feature.properties?.cutoffMinutes) === cutoffMinutes)
        .map((feature) => ({
          ...feature,
          properties: {
            ...feature.properties,
            color: surface === 'scenario' ? '#35d0a1' : '#6da8ff',
          },
        })) ?? []
    )),
  }
}

type DecodedStreetEdgeBundle = {
  nodes: Float64Array
  endpoints: Uint32Array
  edgeIds: Uint32Array
  durations: Float64Array
  points: LngLat[]
  segments: Array<[LngLat, LngLat]>
}

type StreetEdgeCallback = (
  coordinates: [LngLat, LngLat],
  durationMinutes: number,
) => void

type ScenarioEdgeSources = {
  baseline: ScenarioStreetEdgeSource
  scenario: ScenarioStreetEdgeSource
}

const decodedStreetEdgeBundles = new WeakMap<object, DecodedStreetEdgeBundle>()

function decodeBase64Bytes(value: string) {
  const binary = window.atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}

function decodeStreetEdgeBundle(bundle: ScenarioStreetEdgeBundle): DecodedStreetEdgeBundle {
  const cached = decodedStreetEdgeBundles.get(bundle)
  if (cached) return cached
  const decoded = {
    nodes: new Float64Array(decodeBase64Bytes(bundle.nodes)),
    endpoints: new Uint32Array(decodeBase64Bytes(bundle.endpoints)),
    edgeIds: new Uint32Array(decodeBase64Bytes(bundle.edgeIds)),
    durations: new Float64Array(decodeBase64Bytes(bundle.durationMinutes)),
    points: new Array<LngLat>(bundle.nodeCount),
    segments: new Array<[LngLat, LngLat]>(bundle.count),
  }
  if (
    decoded.nodes.length !== bundle.nodeCount * 2
    || decoded.endpoints.length !== bundle.count * 2
    || decoded.edgeIds.length !== bundle.count
    || decoded.durations.length !== bundle.count
  ) throw new Error('Reach street-edge bundle has inconsistent packed lengths.')
  decodedStreetEdgeBundles.set(bundle, decoded)
  return decoded
}

function resolveStreetEdgeSource(source: ScenarioStreetEdgeSource, sources?: ScenarioEdgeSources) {
  let resolved = source
  const seen = new Set<string>()
  while (resolved.schemaVersion === 'vigo.street.edge-ref.v1') {
    if (seen.has(resolved.source)) throw new Error('Reach street-edge reference cycle.')
    seen.add(resolved.source)
    const next = sources?.[resolved.source]
    if (!next) throw new Error(`Reach street-edge reference is missing: ${resolved.source}.`)
    resolved = next
  }
  return resolved
}

function forEachStreetEdge(
  source: ScenarioStreetEdgeSource,
  cutoffMinutes: number,
  callback: StreetEdgeCallback,
  sources?: ScenarioEdgeSources,
) {
  const resolved = resolveStreetEdgeSource(source, sources)
  if (resolved.schemaVersion !== 'vigo.street.edge-bundle.v1') {
    throw new Error('Reach street-edge bundle schema is unsupported.')
  }
  const decoded = decodeStreetEdgeBundle(resolved)
  for (let index = 0; index < resolved.count; index += 1) {
    if (decoded.durations[index] > cutoffMinutes) continue
    callback(indexedEdgeCoordinates(decoded, index), decoded.durations[index])
  }
}

function indexedStreetEdges(source: ScenarioStreetEdgeSource, sources?: ScenarioEdgeSources) {
  const resolved = resolveStreetEdgeSource(source, sources)
  if (resolved.schemaVersion !== 'vigo.street.edge-bundle.v1') {
    throw new Error('Reach street-edge bundle schema is unsupported.')
  }
  const decoded = decodeStreetEdgeBundle(resolved)
  for (let index = 1; index < decoded.edgeIds.length; index += 1) {
    if (decoded.edgeIds[index] <= decoded.edgeIds[index - 1]) {
      throw new Error('Reach street-edge IDs must be strictly increasing.')
    }
  }
  return { decoded }
}

function indexedEdgeArrival(decoded: DecodedStreetEdgeBundle, index: number) {
  return decoded.durations[index]
}

function indexedEdgeCoordinates(decoded: DecodedStreetEdgeBundle, index: number): [LngLat, LngLat] {
  const cached = decoded.segments[index]
  if (cached) return cached
  const fromNode = decoded.endpoints[index * 2] * 2
  const toNode = decoded.endpoints[index * 2 + 1] * 2
  if (fromNode + 1 >= decoded.nodes.length || toNode + 1 >= decoded.nodes.length) {
    throw new Error('Reach street-edge bundle references an invalid node.')
  }
  // Cutoffs change inclusion and color, not geometry. Share immutable points
  // and segments across views instead of reallocating millions on every edit.
  return decoded.segments[index] = [
    decoded.points[fromNode / 2] ??= [decoded.nodes[fromNode], decoded.nodes[fromNode + 1]],
    decoded.points[toNode / 2] ??= [decoded.nodes[toNode], decoded.nodes[toNode + 1]],
  ]
}

function groupedStreetFeatures(
  groups: Map<string, { color: string; coordinates: Array<[LngLat, LngLat]>; count: number }>,
  surface: string,
): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [...groups.values()].map((group) => ({
      type: 'Feature' as const,
      geometry: { type: 'MultiLineString' as const, coordinates: group.coordinates },
      properties: {
        color: group.color,
        surface,
        edgeCount: group.count,
      },
    })),
  }
}

function indexedScenarioEdgeFeatures(
  edges: ScenarioEdgeSources,
  cutoffMinutes: number,
): FeatureCollection {
  const baseline = indexedStreetEdges(edges.baseline, edges)
  const scenario = indexedStreetEdges(edges.scenario, edges)
  const groups = new Map<string, { color: string; coordinates: Array<[LngLat, LngLat]>; count: number }>()
  const add = (beforeIndex: number | undefined, afterIndex: number | undefined) => {
    const beforeMinutes = beforeIndex === undefined
      ? Number.POSITIVE_INFINITY
      : indexedEdgeArrival(baseline.decoded, beforeIndex)
    const afterMinutes = afterIndex === undefined
      ? Number.POSITIVE_INFINITY
      : indexedEdgeArrival(scenario.decoded, afterIndex)
    if (beforeMinutes > cutoffMinutes && afterMinutes > cutoffMinutes) return
    const edgeMinutes = Number.isFinite(afterMinutes) ? afterMinutes : beforeMinutes
    const deltaMinutes = Number.isFinite(beforeMinutes) && Number.isFinite(afterMinutes)
      ? beforeMinutes - afterMinutes
      : Number.isFinite(afterMinutes) ? cutoffMinutes : -cutoffMinutes
    const [red, green, blue] = reachDifferenceColor(deltaMinutes)
    const color = `rgb(${red}, ${green}, ${blue})`
    const group = groups.get(color) ?? { color, coordinates: [], count: 0 }
    const coordinates = indexedEdgeCoordinates(
      afterIndex === undefined ? baseline.decoded : scenario.decoded,
      afterIndex === undefined ? beforeIndex as number : afterIndex,
    )
    if (!Number.isFinite(edgeMinutes)) return
    group.coordinates.push(coordinates)
    group.count += 1
    groups.set(color, group)
  }
  let baselineIndex = 0
  let scenarioIndex = 0
  while (
    baselineIndex < baseline.decoded.edgeIds.length
    || scenarioIndex < scenario.decoded.edgeIds.length
  ) {
    const baselineId = baseline.decoded.edgeIds[baselineIndex]
    const scenarioId = scenario.decoded.edgeIds[scenarioIndex]
    if (scenarioIndex >= scenario.decoded.edgeIds.length || baselineId < scenarioId) {
      add(baselineIndex, undefined)
      baselineIndex += 1
    } else if (baselineIndex >= baseline.decoded.edgeIds.length || scenarioId < baselineId) {
      add(undefined, scenarioIndex)
      scenarioIndex += 1
    } else {
      add(baselineIndex, scenarioIndex)
      baselineIndex += 1
      scenarioIndex += 1
    }
  }
  return groupedStreetFeatures(groups, 'comparison')
}

export function scenarioEdgeFeatures(
  analysis: ReachResult | null | undefined,
  view: ScenarioView,
  cutoffMinutes: number,
): FeatureCollection {
  const edges = analysis?.surface.edges
  if (!edges) return emptyCollection
  const colorForDuration = (durationMinutes: number) => {
    const [red, green, blue] = reachTimeColor(cutoffMinutes > 0 ? durationMinutes / cutoffMinutes : 1)
    return `rgb(${red}, ${green}, ${blue})`
  }
  if (view !== 'comparison') {
    const groups = new Map<string, { color: string; coordinates: Array<[LngLat, LngLat]>; count: number }>()
    forEachStreetEdge(edges[view], cutoffMinutes, (coordinates, durationMinutes) => {
      const arrival = durationMinutes
      if (arrival > cutoffMinutes) return
      const color = colorForDuration(arrival)
      const group = groups.get(color) ?? { color, coordinates: [], count: 0 }
      group.coordinates.push(coordinates)
      group.count += 1
      groups.set(color, group)
    }, edges)
    return groupedStreetFeatures(groups, view)
  }
  return indexedScenarioEdgeFeatures(edges, cutoffMinutes)
}

export function reachComparisonContourFeatures(
  analysis: ReachResult | null | undefined,
  cutoffMinutes: number,
): FeatureCollection {
  if (!analysis) return emptyCollection
  return {
    type: 'FeatureCollection',
    features: analysis.surface.contours.baseline.features.filter((feature) => (
      Number(feature.properties?.cutoffMinutes) === cutoffMinutes
    )),
  }
}

export function reachComparisonAreaFeatures(
  analysis: ReachResult | null | undefined,
  cutoffMinutes: number,
  color: string,
): FeatureCollection {
  const areas = analysis?.surface.areas?.baseline
  if (!areas) return emptyCollection
  return {
    type: 'FeatureCollection',
    features: areas.features
      .filter((feature) => Number(feature.properties?.cutoffMinutes) === cutoffMinutes)
      .map((feature) => ({
        ...feature,
        properties: { ...feature.properties, color },
      })),
  }
}

export function reachComparisonEdgeFeatures(
  analysis: ReachResult,
  cutoffMinutes: number,
  color: string,
): FeatureCollection {
  const source = analysis.surface.edges?.baseline
  if (!source) return emptyCollection
  const coordinates: Array<[LngLat, LngLat]> = []
  forEachStreetEdge(source, cutoffMinutes, (edgeCoordinates, durationMinutes) => {
    if (durationMinutes <= cutoffMinutes) coordinates.push(edgeCoordinates)
  }, analysis.surface.edges)
  return coordinates.length
    ? {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature' as const,
          geometry: { type: 'MultiLineString' as const, coordinates },
          properties: { color, surface: 'feed-comparison', edgeCount: coordinates.length },
        }],
      }
    : emptyCollection
}
