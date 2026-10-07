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
  startDurations: Float64Array
  startFractions: Float64Array
  endFractions: Float64Array
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
    startDurations: new Float64Array(decodeBase64Bytes(bundle.fromDurationMinutes ?? bundle.durationMinutes)),
    startFractions: bundle.startFractions ? new Float64Array(decodeBase64Bytes(bundle.startFractions)) : new Float64Array(bundle.count),
    endFractions: bundle.endFractions ? new Float64Array(decodeBase64Bytes(bundle.endFractions)) : new Float64Array(bundle.count).fill(1),
    points: new Array<LngLat>(bundle.nodeCount),
    segments: new Array<[LngLat, LngLat]>(bundle.count),
  }
  if (
    decoded.nodes.length !== bundle.nodeCount * 2
    || decoded.endpoints.length !== bundle.count * 2
    || decoded.edgeIds.length !== bundle.count
    || decoded.durations.length !== bundle.count
    || decoded.startDurations.length !== bundle.count
    || decoded.startFractions.length !== bundle.count
    || decoded.endFractions.length !== bundle.count
    || (bundle.schemaVersion === 'vigo.street.edge-bundle.v2'
      && (!bundle.fromDurationMinutes || !bundle.startFractions || !bundle.endFractions))
  ) throw new Error('Reach street-edge bundle has inconsistent packed lengths.')
  for (let i = 0; i < bundle.count; i += 1) {
    if (![decoded.startDurations[i], decoded.durations[i], decoded.startFractions[i], decoded.endFractions[i]].every(Number.isFinite)
      || decoded.startDurations[i] < 0 || decoded.durations[i] < decoded.startDurations[i]
      || decoded.startFractions[i] < 0 || decoded.endFractions[i] > 1
      || decoded.startFractions[i] >= decoded.endFractions[i]) throw new Error('Reach has an invalid street interval.')
  }
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
  if (!['vigo.street.edge-bundle.v1', 'vigo.street.edge-bundle.v2'].includes(resolved.schemaVersion)) {
    throw new Error('Reach street-edge bundle schema is unsupported.')
  }
  const decoded = decodeStreetEdgeBundle(resolved)
  for (let index = 0; index < resolved.count; index += 1) {
    const end = cutoffFraction(decoded, index, cutoffMinutes)
    if (end <= decoded.startFractions[index]) continue
    callback(indexedEdgeCoordinates(decoded, index, decoded.startFractions[index], end),
      indexedEdgeArrival(decoded, index, end))
  }
}

function indexedStreetEdges(source: ScenarioStreetEdgeSource, sources?: ScenarioEdgeSources) {
  const resolved = resolveStreetEdgeSource(source, sources)
  if (!['vigo.street.edge-bundle.v1', 'vigo.street.edge-bundle.v2'].includes(resolved.schemaVersion)) {
    throw new Error('Reach street-edge bundle schema is unsupported.')
  }
  const decoded = decodeStreetEdgeBundle(resolved)
  for (let index = 1; index < decoded.edgeIds.length; index += 1) {
    if (decoded.edgeIds[index] < decoded.edgeIds[index - 1]
      || (decoded.edgeIds[index] === decoded.edgeIds[index - 1]
        && decoded.startFractions[index] < decoded.endFractions[index - 1])) {
      throw new Error('Reach street intervals must be ordered and non-overlapping within each edge.')
    }
  }
  return { decoded }
}

function indexedEdgeArrival(decoded: DecodedStreetEdgeBundle, index: number, fraction = decoded.endFractions[index]) {
  return decoded.startDurations[index] + (decoded.durations[index] - decoded.startDurations[index])
    * (fraction - decoded.startFractions[index]) / (decoded.endFractions[index] - decoded.startFractions[index])
}

function cutoffFraction(decoded: DecodedStreetEdgeBundle, index: number, cutoff: number) {
  if (decoded.startDurations[index] > cutoff) return decoded.startFractions[index]
  if (decoded.durations[index] <= cutoff) return decoded.endFractions[index]
  return decoded.startFractions[index] + (decoded.endFractions[index] - decoded.startFractions[index])
    * (cutoff - decoded.startDurations[index]) / (decoded.durations[index] - decoded.startDurations[index])
}

function indexedEdgeCoordinates(decoded: DecodedStreetEdgeBundle, index: number,
  start = decoded.startFractions[index], end = decoded.endFractions[index]): [LngLat, LngLat] {
  const cached = decoded.segments[index]
  const complete = start === decoded.startFractions[index] && end === decoded.endFractions[index]
  if (cached && complete) return cached
  const fromNode = decoded.endpoints[index * 2] * 2
  const toNode = decoded.endpoints[index * 2 + 1] * 2
  if (fromNode + 1 >= decoded.nodes.length || toNode + 1 >= decoded.nodes.length) {
    throw new Error('Reach street-edge bundle references an invalid node.')
  }
  const point = (fraction: number): LngLat => fraction === 0
    ? decoded.points[fromNode / 2] ??= [decoded.nodes[fromNode], decoded.nodes[fromNode + 1]]
    : fraction === 1 ? decoded.points[toNode / 2] ??= [decoded.nodes[toNode], decoded.nodes[toNode + 1]]
      : [decoded.nodes[fromNode] + fraction * (decoded.nodes[toNode] - decoded.nodes[fromNode]),
          decoded.nodes[fromNode + 1] + fraction * (decoded.nodes[toNode + 1] - decoded.nodes[fromNode + 1])]
  const segment: [LngLat, LngLat] = [point(start), point(end)]
  if (complete) decoded.segments[index] = segment
  return segment
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
  let before = 0, after = 0
  while (before < baseline.decoded.edgeIds.length || after < scenario.decoded.edgeIds.length) {
    const id = Math.min(baseline.decoded.edgeIds[before] ?? Infinity, scenario.decoded.edgeIds[after] ?? Infinity)
    const beforeStart = before, afterStart = after
    while (baseline.decoded.edgeIds[before] === id) before += 1
    while (scenario.decoded.edgeIds[after] === id) after += 1
    const intervals = (decoded: DecodedStreetEdgeBundle, from: number, to: number) => {
      const result: {index: number; start: number; end: number}[] = []
      for (let i = from; i < to; i += 1) {
        const start = decoded.startFractions[i], end = cutoffFraction(decoded, i, cutoffMinutes)
        if (end > start) result.push({index: i, start, end})
      }
      return result
    }
    const a = intervals(baseline.decoded, beforeStart, before)
    const b = intervals(scenario.decoded, afterStart, after)
    const cuts = [...new Set([...a, ...b].flatMap(i => [i.start, i.end]))].sort((x,y) => x-y)
    let ai = 0, bi = 0
    for (let k = 1; k < cuts.length; k += 1) {
      const start = cuts[k-1], end = cuts[k], middle = (start+end)/2
      while (ai < a.length && a[ai].end < middle) ai += 1
      while (bi < b.length && b[bi].end < middle) bi += 1
      const left = a[ai]?.start <= middle && a[ai]?.end >= middle ? a[ai] : undefined
      const right = b[bi]?.start <= middle && b[bi]?.end >= middle ? b[bi] : undefined
      if (!left && !right) continue
      const delta = left && right
        ? indexedEdgeArrival(baseline.decoded,left.index,middle) - indexedEdgeArrival(scenario.decoded,right.index,middle)
        : right ? cutoffMinutes : -cutoffMinutes
      const [red,green,blue] = reachDifferenceColor(delta)
      const color = `rgb(${red}, ${green}, ${blue})`
      const group = groups.get(color) ?? {color,coordinates:[],count:0}
      group.coordinates.push(indexedEdgeCoordinates(right ? scenario.decoded : baseline.decoded,
        (right ?? left)!.index,start,end))
      group.count += 1
      groups.set(color,group)
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
