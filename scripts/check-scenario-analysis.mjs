import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  analyzeScenarioSurface,
  clearScenarioAnalysisCache,
  rasterContours,
  scenarioAnalysisCacheSnapshot,
  validateScenarioAnalysisRequest,
} from '../server/scenario-analysis.mjs'
import {
  scenarioEntityCandidates,
  scenarioEntityMatches,
} from '../server/scenario-entity-ids.mjs'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const modulePath = path.join(repositoryRoot, 'server', 'scenario-analysis.mjs')
const apiPath = path.join(repositoryRoot, 'server', 'vigo-api.mjs')
const routingStorePath = path.join(repositoryRoot, 'server', 'national-gtfs-store.mjs')

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function packedEdgeFixture(edgeId = 7) {
  const float64 = (values) => {
    const buffer = Buffer.alloc(values.length * 8)
    values.forEach((value, index) => buffer.writeDoubleLE(value, index * 8))
    return buffer.toString('base64')
  }
  const uint32 = (values) => {
    const buffer = Buffer.alloc(values.length * 4)
    values.forEach((value, index) => buffer.writeUInt32LE(value, index * 4))
    return buffer.toString('base64')
  }
  return {
    schemaVersion: 'vigo.street.edge-bundle.v1',
    encoding: 'indexed-f64-le',
    count: 1,
    nodeCount: 2,
    nodes: float64([0, 0, 0.01, 0]),
    endpoints: uint32([0, 1]),
    edgeIds: uint32([edgeId]),
    durationMinutes: float64([2]),
    walkDistanceM: float64([160]),
    transitArrivalMinutes: float64([-1]),
  }
}

function fixtureRequest() {
  return {
    baselineIdentity: 'fixture-store-v1',
    feedId: '__project__',
    origin: { coordinate: [0, 0], label: 'Origin', source: 'map' },
    departMinutes: 480,
    serviceDate: '2026-07-20',
    serviceDay: 'weekday',
    maxWalkKm: 1.2,
    radiusKm: 7,
    rasterSize: 48,
    cutoffsMinutes: [15, 30, 45],
    scenario: {
      id: 'fixture-scenario',
      name: 'Fast east line',
      services: [{
        id: 'east-line',
        name: 'East line',
        operation: 'add',
        bidirectional: true,
        headwayMinutes: 5,
        startMinutes: 360,
        endMinutes: 1_320,
        averageSpeedKph: 60,
        dwellMinutes: 0,
        stops: [
          { id: 'origin', label: 'Origin', coordinate: [0, 0] },
          { id: 'east', label: 'East', coordinate: [0.063, 0] },
        ],
        geometry: [
          [0, 0],
          [0.02, 0.012],
          [0.063, 0],
        ],
        geometrySource: 'shape',
      }],
    },
  }
}

function fakeAccessibilityRange(counter, stops = null) {
  return async (rangeRequest) => {
    counter.calls += 1
    counter.rangeRequests ??= []
    counter.rangeRequests.push(clone(rangeRequest))
    assert.deepEqual(rangeRequest.origin.coordinate, fixtureRequest().origin.coordinate)
    assert.equal(rangeRequest.origin.source, 'map')
    assert.equal(rangeRequest.departMinutes, fixtureRequest().departMinutes)
    const reachedStops = stops ?? [
      { id: 'west', label: 'West', coordinate: [-0.04, 0], source: 'stop', stopId: 'WEST', durationMinutes: 18 },
      { id: 'origin-stop', label: 'Origin stop', coordinate: [0, 0], source: 'stop', stopId: 'ORIGIN', durationMinutes: 8 },
    ]
    const overlayStops = rangeRequest.scenarioOverlay?.stops?.map((stop, index) => ({
      ...stop,
      source: 'scenario-stop',
      durationMinutes: index === 0 ? 8 : 14,
    })) ?? []
    const surface = await fakeAccessibilitySurface(rangeRequest, reachedStops, overlayStops)
    return {
      schemaVersion: 'vigo.analysis.accessibility-range.v1',
      stops: reachedStops,
      scenarioStops: overlayStops,
      surface,
      diagnostics: {
        owner: 'rust_resident_timetable_kernel',
        algorithm: overlayStops.length
          ? 'rust_resident_query_overlay_connection_scan_one_to_many'
          : 'rust_resident_generation_tagged_connection_scan_one_to_many',
        search: {
          relaxedStops: overlayStops.length,
          nativeQueryMs: 0.1,
        },
        timetable: overlayStops.length ? {
          scenarioOverlay: {
            overlayConnections: rangeRequest.scenarioOverlay.directionStops.length - 1,
            supplementalTransferEdges: 4,
            mixedBaselineScenarioTransfers: true,
          },
        } : {},
        stopSelection: {
          candidates: reachedStops.length,
          selected: reachedStops.length,
          sampled: false,
          strategy: 'all_active_timetable_stops',
        },
      },
    }
  }
}

async function fakeAccessibilitySurface(rangeRequest, stops, scenarioStops = []) {
  assert(rangeRequest.surface, 'Accessibility range fixtures must request the unified surface.')
  assert.equal(rangeRequest.surface.includeNodes, false)
  assert.equal(typeof rangeRequest.surface.includeEdges, 'boolean')
  assert.equal(
    rangeRequest.surface.expandBoundsToReachedEdges,
    true,
    'Area surfaces must expand to every reached street without requiring edge serialization.',
  )
  assert.equal(
    rangeRequest.surface.terminalWalkMode,
    'elapsed-total',
    'Accessibility range requests must charge terminal walking against the total elapsed-time cutoff.',
  )
  assert.deepEqual(
    rangeRequest.surface.seeds,
    undefined,
    'The HTTP surface request must not smuggle precomputed seeds past Accessibility ownership.',
  )
  const seeds = [
    { coordinate: rangeRequest.origin.coordinate, durationMinutes: 0 },
    ...stops.map((stop) => ({
      coordinate: stop.coordinate,
      durationMinutes: stop.durationMinutes,
    })),
    ...scenarioStops.map((stop) => ({
      coordinate: stop.coordinate,
      durationMinutes: stop.durationMinutes,
    })),
  ]
  assert.deepEqual(
    seeds.slice(1, stops.length + 1).map((seed) => seed.durationMinutes),
    stops.map((stop) => stop.durationMinutes),
    'Every cutoff-safe transit stop must seed the final street surface with its elapsed arrival time.',
  )
  return fakeStreetRaster({})({
    analysisStage: rangeRequest.analysisStage,
    seeds,
    ...rangeRequest.surface,
    maxWalkKm: rangeRequest.maxWalkKm,
    walkSpeedKph: rangeRequest.walkSpeedKph,
    maximumDurationMinutes: rangeRequest.cutoffMinutes,
    independentTerminalWalk: false,
  })
}

function fakeStreetRaster(counter) {
  return async (surfaceRequest) => {
    counter.streetRasters = Number(counter.streetRasters ?? 0) + 1
    counter.streetStages ??= []
    counter.streetStages.push(surfaceRequest.analysisStage)
    counter.streetRequests ??= []
    counter.streetRequests.push(surfaceRequest)
    const values = new Float64Array(surfaceRequest.width * surfaceRequest.height)
    values.fill(Number.POSITIVE_INFINITY)
    const [west, south, east, north] = surfaceRequest.bounds
    for (const seed of surfaceRequest.seeds) {
      const centerX = Math.max(0, Math.min(
        surfaceRequest.width - 1,
        Math.floor((seed.coordinate[0] - west) / (east - west) * surfaceRequest.width),
      ))
      const centerY = Math.max(0, Math.min(
        surfaceRequest.height - 1,
        Math.floor((north - seed.coordinate[1]) / (north - south) * surfaceRequest.height),
      ))
      const radius = Math.max(1, Math.round(surfaceRequest.maxWalkKm / 0.25))
      for (let offset = -radius; offset <= radius; offset += 1) {
        const x = centerX + offset
        if (x < 0 || x >= surfaceRequest.width) continue
        const duration = surfaceRequest.independentTerminalWalk
          ? seed.durationMinutes
          : seed.durationMinutes + Math.abs(offset) * 0.25 / surfaceRequest.walkSpeedKph * 60
        if (duration > surfaceRequest.maximumDurationMinutes) continue
        const index = centerY * surfaceRequest.width + x
        values[index] = Math.min(values[index], duration)
      }
    }
    return {
      schemaVersion: 'vigo.street.network-raster.v1',
      values,
      fullValues: values,
      fullBounds: [-0.01, -0.01, 0.02, 0.01],
      width: surfaceRequest.width,
      height: surfaceRequest.height,
      bounds: surfaceRequest.bounds,
      ...(surfaceRequest.includeEdges ? {
        edges: packedEdgeFixture(7),
      } : {}),
      diagnostics: {
        seeds: surfaceRequest.seeds.length,
        settledLabels: values.filter(Number.isFinite).length,
        reachedPixels: values.filter(Number.isFinite).length,
        queryMs: 0.1,
      },
    }
  }
}

clearScenarioAnalysisCache()
const request = fixtureRequest()
const original = clone(request)
const counter = { calls: 0 }
const first = await analyzeScenarioSurface(request, {
  runAccessibilityRange: fakeAccessibilityRange(counter),
})

assert.deepEqual(request, original, 'Scenario analysis must not mutate the request.')
assert.equal(first.schemaVersion, 'vigo.scenario-analysis.v1')
assert.equal(first.surface.raster.width, 48)
assert.equal(first.surface.raster.height, 48)
assert.equal(first.surface.raster.encoding, 'uint16-tenths-minutes-le-base64')
assert.equal(first.surface.reachability?.mode, 'total-elapsed-walk-transit-walk')
assert.equal(first.surface.reachability?.cutoffMinutes, 45)
assert.equal(first.surface.reachability?.baselineTerminalWalkKm, request.maxWalkKm)
assert(first.limitations.some((entry) => entry.code === 'total_elapsed_time_cutoff'))
assert(first.limitations.some((entry) => entry.detail.includes('Terminal walking uses only the remaining time')))
assert.equal(Buffer.from(first.surface.raster.baseline, 'base64').byteLength, 48 * 48 * 2)
assert.equal(Buffer.from(first.surface.raster.scenario, 'base64').byteLength, 48 * 48 * 2)
assert.equal(first.surface.contours.baseline.type, 'FeatureCollection')
assert.equal(first.surface.contours.scenario.type, 'FeatureCollection')
assert.deepEqual(first.surface.displayBounds, [-0.01, -0.01, 0.02, 0.01])
assert.equal(first.surface.areaMetrics.baseline.bounds[0], -0.01)
assert.equal(first.surface.nodes, undefined, 'Desktop scenario results must not carry settled OSM point evidence.')
assert.equal(first.surface.edges?.baseline.schemaVersion, 'vigo.street.edge-bundle.v1')
assert.equal(first.surface.edges?.baseline.count, 1, 'Scenario results must retain every reached directed OSM street path.')
assert.equal(first.surface.edges?.baseline.nodeCount, 2)
const packedNodes = Buffer.from(first.surface.edges?.baseline.nodes ?? '', 'base64')
assert.equal(packedNodes.byteLength, 2 * 2 * 8)
assert.deepEqual(
  [packedNodes.readDoubleLE(0), packedNodes.readDoubleLE(8), packedNodes.readDoubleLE(16), packedNodes.readDoubleLE(24)],
  [0, 0, 0.01, 0],
)
const packedEndpoints = Buffer.from(first.surface.edges?.baseline.endpoints ?? '', 'base64')
assert.equal(packedEndpoints.byteLength, 2 * 4)
assert.deepEqual([packedEndpoints.readUInt32LE(0), packedEndpoints.readUInt32LE(4)], [0, 1])
assert.equal(Buffer.from(first.surface.edges?.baseline.edgeIds ?? '', 'base64').readUInt32LE(0), 7)
assert.equal(Buffer.from(first.surface.edges?.baseline.durationMinutes ?? '', 'base64').byteLength, 8)
assert.equal(counter.rangeRequests[0].surface.includeEdges, true)
const finiteContours = rasterContours(
  Float64Array.from([
    0, 0, 10,
    0, 0, 10,
    10, 10, 10,
  ]),
  3,
  3,
  [-1, -1, 1, 1],
  [5],
  'baseline',
)
assert.equal(finiteContours.features.length, 1, 'Finite raster values must still produce a real contour.')
assert.equal(
  rasterContours(
    Float64Array.from([
      0, Number.POSITIVE_INFINITY, 10,
      0, Number.POSITIVE_INFINITY, 10,
      10, 10, 10,
    ]),
    3,
    3,
    [-1, -1, 1, 1],
    [5],
    'baseline',
  ).features.length,
  0,
  'No-data boundaries must not be rendered as isochrone contours.',
)
assert.equal(first.scenario.routes.features.length, 2, 'A bidirectional service should expose two route features.')
assert.deepEqual(
  first.scenario.routes.features[0].geometry.coordinates,
  request.scenario.services[0].geometry,
  'Scenario route overlays must retain supplied GTFS shape geometry.',
)
assert.deepEqual(
  first.scenario.routes.features[1].geometry.coordinates,
  [...request.scenario.services[0].geometry].reverse(),
  'Inbound scenario route overlays must reverse the supplied GTFS shape geometry.',
)
assert.equal(first.scenario.routes.features[0].properties.geometrySource, 'shape')
assert.equal(first.diagnostics.accessibilityDispatches, 2)
assert.equal(first.diagnostics.analysisEngine, 'unified_native_one_to_many')
assert.equal(first.diagnostics.accessibility.owner, 'rust_resident_timetable_kernel')
assert.equal(counter.calls, 2, 'An additive analysis must dispatch baseline and overlay Accessibility ranges.')
assert.equal(counter.rangeRequests[0].scenarioOverlay, undefined)
assert.equal(counter.rangeRequests[1].scenarioOverlay.stops.length, 2)
assert.deepEqual(counter.rangeRequests[1].scenarioOverlay.directionOffsets, [0, 2, 4])
assert(first.summary.scenarioReachablePixels > first.summary.baselineReachablePixels)
assert(first.summary.improvedPixels > 0)
assert(first.limitations.some((entry) => entry.code === 'street_network_cell_sampling'))
assert(first.limitations.some((entry) => entry.detail.includes('directed OSM edges')))
assert(first.limitations.some((entry) => entry.code === 'single_origin_departure_snapshot'))
assert(first.limitations.some((entry) => entry.code === 'raster_cells_not_opportunities'))
assert(first.limitations.some((entry) => entry.code === 'modeled_scenario_service'))
assert(first.limitations.some((entry) => entry.code === 'descriptive_scenario_contrast'))
assert(!first.limitations.some((entry) => entry.code === 'scenario_connector_local_distance'))
assert.equal(first.diagnostics.raster.method, 'osm-pedestrian-network')
assert.equal(
  first.diagnostics.scenarioPropagation.connectorStrategy,
  'accessibility_owned_directed_osm_overlay_transfers',
)
assert.equal(
  first.diagnostics.scenarioPropagation.algorithm,
  'rust_resident_query_overlay_connection_scan_one_to_many',
)
assert(first.diagnostics.scenarioPropagation.settledStops > 0)
assert.equal(first.diagnostics.streetConnectorDispatches, 0)
assert.equal(counter.streetRasters ?? 0, 0, 'Final surfaces must arrive inside Accessibility responses.')
assert.deepEqual(counter.streetStages ?? [], [])

function decodeRaster(base64) {
  const bytes = Buffer.from(base64, 'base64')
  return Array.from({ length: bytes.length / 2 }, (_, index) => bytes.readUInt16LE(index * 2))
}

const baselineRaster = decodeRaster(first.surface.raster.baseline)
const scenarioRaster = decodeRaster(first.surface.raster.scenario)
const [west, south, east, north] = first.surface.raster.bounds
const originX = Math.max(0, Math.min(
  first.surface.raster.width - 1,
  Math.floor((request.origin.coordinate[0] - west) / (east - west) * first.surface.raster.width),
))
const originY = Math.max(0, Math.min(
  first.surface.raster.height - 1,
  Math.floor((north - request.origin.coordinate[1]) / (north - south) * first.surface.raster.height),
))
const originPixel = originY * first.surface.raster.width + originX
assert(
  baselineRaster[originPixel] <= 4 * first.surface.raster.scale,
  'The baseline must retain a near-zero direct-walk seed at the selected origin.',
)
assert.equal(first.diagnostics.raster.directWalkSeed, true)
for (const cutoff of request.cutoffsMinutes) {
  const threshold = cutoff * first.surface.raster.scale
  const baselineCount = baselineRaster.filter((value) => value <= threshold).length
  const scenarioCount = scenarioRaster.filter((value) => value <= threshold).length
  assert(scenarioCount >= baselineCount, 'An additive scenario may not shrink a cutoff raster.')
}
for (let index = 0; index < baselineRaster.length; index += 1) {
  if (baselineRaster[index] !== first.surface.raster.nodata) {
    assert(scenarioRaster[index] <= baselineRaster[index], 'An additive scenario may not make a baseline raster pixel slower.')
  }
}

const second = await analyzeScenarioSurface(clone(request), {
  runAccessibilityRange: fakeAccessibilityRange(counter),
})
assert.deepEqual(second.surface, first.surface, 'A cache hit must preserve deterministic surface ordering and values.')
assert.equal(second.diagnostics.cache.status, 'hit')
assert.equal(counter.calls, 2, 'A cache hit must not dispatch the Accessibility worker.')
assert.equal(second.diagnostics.streetConnectorDispatches, 0)
assert.equal(scenarioAnalysisCacheSnapshot().entries, 1)

clearScenarioAnalysisCache()
const compactCounter = { calls: 0 }
const compact = await analyzeScenarioSurface({
  ...fixtureRequest(),
  includeStreetEdges: false,
}, {
  runAccessibilityRange: fakeAccessibilityRange(compactCounter),
})
assert.equal(compact.surface.edges, undefined, 'Area-only analysis must omit full street-edge evidence.')
assert.equal(compactCounter.rangeRequests[0].surface.includeEdges, false)
assert.equal(compact.diagnostics.cache.stored, true, 'Compact area-only analysis should remain cacheable.')

clearScenarioAnalysisCache()
const preservedRequest = fixtureRequest()
preservedRequest.scenario.services = [{
  ...preservedRequest.scenario.services[0],
  id: 'changed-line',
  operation: 'replace',
  sourceRouteId: 'route-1',
  sourcePatternId: 'pattern-1',
  routeScope: 'pattern',
  timeModel: 'preserve-scheduled',
  segmentRuntimeMinutes: [7, 11],
  stops: [
    { id: 'origin', label: 'Origin', coordinate: [0, 0] },
    { id: 'middle', label: 'Middle', coordinate: [0.031, 0] },
    { id: 'east', label: 'East', coordinate: [0.063, 0] },
  ],
}]
const preservedCounter = { calls: 0 }
const preserved = await analyzeScenarioSurface(preservedRequest, {
  runAccessibilityRange: fakeAccessibilityRange(preservedCounter),
})
assert.equal(preserved.schemaVersion, 'vigo.scenario-analysis.v1')
assert.deepEqual(
  preservedCounter.rangeRequests[1].scenarioOverlay.directionStopOffsetsSeconds,
  [0, 7 * 60, 18 * 60, 0, 11 * 60, 18 * 60],
  'Published segment runtimes must be preserved in both directions when a branch is edited.',
)

clearScenarioAnalysisCache()
const baselineOnlyRequest = fixtureRequest()
baselineOnlyRequest.scenario.services = []
const baselineOnlyCounter = { calls: 0 }
const baselineOnly = await analyzeScenarioSurface(baselineOnlyRequest, {
  runAccessibilityRange: fakeAccessibilityRange(baselineOnlyCounter),
})
assert.equal(baselineOnly.summary.improvedPixels, 0)
assert.equal(baselineOnly.surface.raster.scenario, baselineOnly.surface.raster.baseline)
assert.equal(baselineOnly.surface.edges?.scenario.schemaVersion, 'vigo.street.edge-ref.v1')
assert.equal(baselineOnly.surface.edges?.scenario.source, 'baseline')

clearScenarioAnalysisCache()
const packedSurfaceCounter = { calls: 0 }
const packedRange = fakeAccessibilityRange(packedSurfaceCounter, [])
const packedAnalysis = await analyzeScenarioSurface({
  ...baselineOnlyRequest,
  baselineIdentity: 'packed-surface-preservation',
}, {
  runAccessibilityRange: async (rangeRequest) => {
    const result = await packedRange(rangeRequest)
    return { ...result, surface: { ...result.surface, edges: packedEdgeFixture(11) } }
  },
})
assert.equal(packedAnalysis.surface.edges?.baseline.count, 1)
assert.equal(
  Buffer.from(packedAnalysis.surface.edges?.baseline.edgeIds ?? '', 'base64').readUInt32LE(0),
  11,
  'Scenario analysis must preserve a packed Accessibility edge bundle.',
)

clearScenarioAnalysisCache()
const walkOnlyRequest = fixtureRequest()
walkOnlyRequest.scenario.services = []
const walkOnlyCounter = { calls: 0 }
const walkOnly = await analyzeScenarioSurface(walkOnlyRequest, {
  runAccessibilityRange: async (rangeRequest) => {
    walkOnlyCounter.calls += 1
    assert.deepEqual(rangeRequest.origin.coordinate, walkOnlyRequest.origin.coordinate)
    assert.equal(rangeRequest.origin.stopId, undefined)
    return {
      schemaVersion: 'vigo.analysis.accessibility-range.v1',
      stops: [],
      surface: await fakeAccessibilitySurface(rangeRequest, []),
      diagnostics: {
        owner: 'rust_resident_timetable_kernel',
        stopSelection: {
          candidates: 0,
          selected: 0,
          sampled: false,
          strategy: 'all_active_timetable_stops',
        },
      },
    }
  },
})
assert(walkOnly.summary.baselineReachablePixels > 0, 'Walking must remain reachable when transit is not.')
assert.equal(walkOnly.summary.transitStopSeeds, 0)
assert.equal(walkOnly.diagnostics.raster.directWalkSeed, true)

clearScenarioAnalysisCache()
const unifiedCounter = { calls: 0, preliminary: 0 }
const unified = await analyzeScenarioSurface(fixtureRequest(), {
  runAccessibilityRange: async (rangeRequest) => {
    unifiedCounter.calls += 1
    assert.equal(rangeRequest.cutoffMinutes, 45)
    assert.equal('radiusKm' in rangeRequest, false)
    const stops = [
      { id: 'origin-stop', label: 'Origin stop', coordinate: [0, 0], source: 'stop', stopId: 'ORIGIN', durationMinutes: 0 },
      { id: 'west', label: 'West', coordinate: [-0.04, 0], source: 'stop', stopId: 'WEST', durationMinutes: 18 },
    ]
    const scenarioStops = rangeRequest.scenarioOverlay?.stops?.map((stop, index) => ({
      ...stop,
      source: 'scenario-stop',
      durationMinutes: index === 0 ? 0 : 12,
    })) ?? []
    return {
      schemaVersion: 'vigo.analysis.accessibility-range.v1',
      stops,
      scenarioStops,
      surface: await fakeAccessibilitySurface(rangeRequest, stops, scenarioStops),
      diagnostics: {
        stopSelection: {
          candidates: 2,
          selected: 2,
          sampled: false,
          limit: null,
          strategy: 'cutoff-safe-complete',
        },
        owner: 'rust_resident_timetable_kernel',
        algorithm: rangeRequest.scenarioOverlay
          ? 'rust_resident_query_overlay_connection_scan_one_to_many'
          : 'rust_resident_generation_tagged_connection_scan_one_to_many',
        timetable: {
          residentConnections: 1,
          nationalConnectionScan: true,
          ...(rangeRequest.scenarioOverlay ? {
            scenarioOverlay: {
              overlayConnections: 2,
              supplementalTransferEdges: 4,
              mixedBaselineScenarioTransfers: true,
            },
          } : {}),
        },
      },
    }
  },
  buildPreliminaryStreetRaster: fakeStreetRaster(unifiedCounter),
  onPreliminary: (preliminary) => {
    unifiedCounter.preliminary += 1
    assert.equal(preliminary.diagnostics.analysisEngine, 'walk_preliminary')
    assert(preliminary.summary.baselineReachablePixels > 0)
  },
})
assert.equal(unifiedCounter.calls, 2)
assert.equal(unifiedCounter.preliminary, 1)
assert.deepEqual(unifiedCounter.streetStages, ['preliminary-surface'])
assert.equal(unifiedCounter.streetRequests[0].compactEdges, true)
assert.equal(unified.diagnostics.analysisEngine, 'unified_native_one_to_many')
assert.equal(unified.diagnostics.accessibilityDispatches, 2)
assert.equal(unified.diagnostics.stopSelection.sampled, false)
assert.equal(unified.diagnostics.accessibility.owner, 'rust_resident_timetable_kernel')
assert.equal(unified.diagnostics.scenarioConnectors.mixedBaselineScenarioTransfers, true)

clearScenarioAnalysisCache()
const destructiveRequest = fixtureRequest()
destructiveRequest.scenario.services = []
destructiveRequest.scenario.excludedRouteIds = ['ROUTE_TO_REMOVE']
destructiveRequest.scenario.excludedTripIds = ['TRIP_TO_REMOVE']
destructiveRequest.scenario.policy = { maxWalkKm: 1.6, walkSpeedKph: 4.2 }
const destructiveCalls = []
const destructive = await analyzeScenarioSurface(destructiveRequest, {
  runAccessibilityRange: async (rangeRequest) => {
    destructiveCalls.push(clone(rangeRequest))
    const removed = rangeRequest.excludedRouteIds?.includes('ROUTE_TO_REMOVE')
    const stops = removed
      ? [{ id: 'origin-stop', label: 'Origin', coordinate: [0, 0], source: 'stop', stopId: 'ORIGIN', durationMinutes: 0 }]
      : [
        { id: 'origin-stop', label: 'Origin', coordinate: [0, 0], source: 'stop', stopId: 'ORIGIN', durationMinutes: 0 },
        { id: 'east', label: 'East', coordinate: [0.04, 0], source: 'stop', stopId: 'EAST', durationMinutes: 12 },
      ]
    return {
      schemaVersion: 'vigo.analysis.accessibility-range.v1',
      stops,
      surface: await fakeAccessibilitySurface(rangeRequest, stops),
      diagnostics: {
        owner: 'rust_resident_timetable_kernel',
        stopSelection: {
          candidates: removed ? 1 : 2,
          selected: removed ? 1 : 2,
          sampled: false,
          strategy: 'fixture-route-exclusion',
        },
      },
    }
  },
})
assert.equal(destructiveCalls.length, 2, 'A destructive or access-policy case must run a separate modified range.')
assert.equal(destructiveCalls[0].analysisStage, 'baseline-range')
assert.equal(destructiveCalls[1].analysisStage, 'scenario-range')
assert.deepEqual(destructiveCalls[0].excludedRouteIds, undefined)
assert.deepEqual(destructiveCalls[1].excludedRouteIds, ['ROUTE_TO_REMOVE'])
assert.deepEqual(destructiveCalls[1].excludedTripIds, ['TRIP_TO_REMOVE'])
assert.equal(destructiveCalls[1].maxWalkKm, 1.6)
assert.equal(destructiveCalls[1].walkSpeedKph, 4.2)
assert.equal(destructive.diagnostics.accessibilityDispatches, 2)
assert(destructive.summary.scenarioReachablePixels < destructive.summary.baselineReachablePixels)

const normalizedScopeRequest = validateScenarioAnalysisRequest({
  ...fixtureRequest(),
  scenario: {
    ...fixtureRequest().scenario,
    excludedTripIds: ['TRIP_A', 'TRIP_A'],
    excludedPatternIds: [{ routeId: 'ROUTE_1', patternId: 'PATTERN_1' }],
    services: [{
      ...fixtureRequest().scenario.services[0],
      operation: 'replace',
      routeScope: 'pattern',
      timeModel: 'preserve-scheduled',
      segmentRuntimeMinutes: [9],
    }],
  },
})
assert.deepEqual(normalizedScopeRequest.scenario.excludedTripIds, ['TRIP_A'])
assert.deepEqual(normalizedScopeRequest.scenario.excludedPatternIds, [{ routeId: 'ROUTE_1', patternId: 'PATTERN_1' }])
assert.equal(normalizedScopeRequest.scenario.services[0].timeModel, 'preserve-scheduled')
assert.deepEqual(normalizedScopeRequest.scenario.services[0].segmentRuntimeMinutes, [9])

assert.deepEqual(
  scenarioEntityCandidates('feed_e0d954794a::41'),
  ['feed_e0d954794a\u001f41', '41'],
  'Bundle route IDs must expose both merged-store and feed-store candidates.',
)
assert(scenarioEntityMatches('feed_e0d954794a\u001f41', 'feed_e0d954794a::41'))
assert(scenarioEntityMatches('feed_e0d954794a\u001f41--pattern-2', 'feed_e0d954794a::41--pattern-2'))
assert(!scenarioEntityMatches('other-feed\u001f41', 'feed_e0d954794a::41'))

assert.doesNotThrow(
  () => validateScenarioAnalysisRequest({ ...fixtureRequest(), rasterSize: 1024 }),
)
assert.throws(
  () => validateScenarioAnalysisRequest({ ...fixtureRequest(), rasterSize: 50 }),
  /rasterSize/i,
)
assert.doesNotThrow(
  () => validateScenarioAnalysisRequest({
    ...fixtureRequest(),
    scenario: {
      ...fixtureRequest().scenario,
      services: [{
        ...fixtureRequest().scenario.services[0],
        stops: Array.from({ length: 25 }, (_, index) => ({
          id: `stop-${index}`,
          label: `Stop ${index}`,
          coordinate: [index / 100, 0],
        })),
      }],
    },
  }),
)
assert.throws(
  () => validateScenarioAnalysisRequest({
    ...fixtureRequest(),
    scenario: {
      ...fixtureRequest().scenario,
      services: [{
        ...fixtureRequest().scenario.services[0],
        stops: Array.from({ length: 257 }, (_, index) => ({
          id: `stop-${index}`,
          label: `Stop ${index}`,
          coordinate: [index / 1000, 0],
        })),
      }],
    },
  }),
  /256 unique scenario stops/i,
)

const moduleSource = fs.readFileSync(modulePath, 'utf8')
const apiSource = fs.readFileSync(apiPath, 'utf8')
const routingStoreSource = fs.readFileSync(routingStorePath, 'utf8')
assert(!moduleSource.includes("from './national-gtfs-store.mjs'"), 'Scenario analysis must depend on the isolated Accessibility dispatch contract, not import the core router.')
assert(apiSource.includes("action === 'scenario-analysis'"), 'The loopback API must expose the scenario-analysis action.')
assert(apiSource.includes('runScenarioAnalysis'), 'The API must route scenario analysis through its isolated owner.')
assert(apiSource.includes("'accessibility-range'"), 'Production scenario analysis must dispatch the unified resident one-to-many operation.')
assert(apiSource.includes('buildPreliminaryStreetRaster:'), 'Only the optional walk preview may dispatch a standalone pedestrian surface.')
assert(!apiSource.includes('buildStreetConnectors:'), 'Scenario connectors must be owned by the Accessibility operation.')
assert(
  apiSource.includes('streetStorePath: streetPath,'),
  'OSM pedestrian dispatches must receive the resolved project street store.',
)
assert(apiSource.includes('Accessibility analysis requires a ready OSM pedestrian street index.'))
assert(apiSource.includes("case 'preliminary-surface': return [0, 0.08]"))
assert(!apiSource.includes("case 'scenario-connectors': return [0.68, 0.76]"))
assert(!apiSource.includes("case 'scenario-surface':"))
assert(!apiSource.includes("case 'baseline-surface':"))
assert(
  apiSource.includes('hydrateScenarioRouteServices(storePath, storeIdentity, body)'),
  'Existing-line interventions must hydrate ordered stops from the persisted route catalog.',
)
assert(
  apiSource.includes('const stops = ordered.length >= 2 ? ordered : []'),
  'Existing-line interventions must preserve their complete ordered GTFS stop sequence.',
)
assert(
  !apiSource.includes('coordinateFallback') &&
    !apiSource.includes('evenlySampledIndexes') &&
    !apiSource.includes('label: `Alignment ${index + 1}`'),
  'Existing-line interventions must fail closed instead of treating route-shape vertices as stops.',
)
assert(
  apiSource.includes('expandedScenarioRouteIds(storePath, scenario.excludedRouteIds)'),
  'Line removals must preserve the public route IDs consumed by resident trip exclusions.',
)
assert(apiSource.includes('scenarioEntityCandidates'), 'Scenario route hydration must normalize feed-scoped UI IDs.')
assert(apiSource.includes('scenarioEntityMatches'), 'Scenario branch hydration must match scoped and local pattern IDs.')
assert(moduleSource.includes("analysisStage: 'baseline-range'"))
assert(moduleSource.includes("analysisStage: 'scenario-range'"))
assert(moduleSource.includes('scenarioOverlay: compiledScenario.overlay'))
assert(moduleSource.includes("'accessibility_owned_directed_osm_overlay_transfers'"))
assert(!moduleSource.includes('routeNativeScenarioExact'))
assert(!moduleSource.includes('while (changed'))
assert(!moduleSource.includes('maximumRounds'))
assert(!moduleSource.includes('nextTripStart'))
assert(!moduleSource.includes("code: 'scenario_connector_local_distance'"))
assert(!moduleSource.includes('loadScenarioTransitStops'), 'The retired in-module SQLite stop sampler must stay removed.')
assert(!apiSource.includes('analyzeScenarioSurface, loadScenarioTransitStops'), 'Production analysis must not route through sampled matrix destinations.')
assert(!routingStoreSource.includes('vigo.scenario-analysis.v1'), 'The canonical routing store must not own the scenario-analysis response contract.')

console.log(JSON.stringify({
  ok: true,
  schemaVersion: first.schemaVersion,
  raster: `${first.surface.raster.width}x${first.surface.raster.height}`,
  improvedPixels: first.summary.improvedPixels,
  accessibilityDispatches: counter.calls,
  cache: scenarioAnalysisCacheSnapshot(),
}, null, 2))
