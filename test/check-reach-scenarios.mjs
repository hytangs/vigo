import assert from 'node:assert/strict'
import {
  computeReachResult,
  rasterContours,
  validateReachRequest,
} from '../src/server/reach.mjs'
import {
  scenarioEntityCandidates,
  scenarioEntityMatches,
} from '../src/server/scenario-entity-ids.mjs'

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
    feedId: '__city__',
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

function fakeReachRange(counter, stops = null) {
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
    const surface = await fakeReachSurface(rangeRequest, reachedStops, overlayStops)
    return {
      schemaVersion: 'vigo.result.reach.v1',
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

async function fakeReachSurface(rangeRequest, stops, scenarioStops = []) {
  assert(rangeRequest.surface, 'Reach range fixtures must request the unified surface.')
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
    'Reach range requests must charge terminal walking against the total elapsed-time cutoff.',
  )
  assert.deepEqual(
    rangeRequest.surface.seeds,
    undefined,
    'The HTTP surface request must not smuggle precomputed seeds past Reach ownership.',
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
    stage: rangeRequest.stage,
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
    counter.streetStages.push(surfaceRequest.stage)
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

const request = fixtureRequest()
const original = clone(request)
const counter = { calls: 0 }
const first = await computeReachResult(request, {
  runReach: fakeReachRange(counter),
})

assert.deepEqual(request, original, 'Reach must not mutate the request.')
assert.equal(first.schemaVersion, 'vigo.result.reach.v1')
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
assert.equal(first.surface.nodes, undefined, 'Studio Scenario results must not carry settled OSM points.')
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
  'No-data boundaries must not be rendered as Reach contours.',
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
assert.equal(first.diagnostics.reachDispatches, 2)
assert.equal(first.diagnostics.engine, 'unified_native_one_to_many')
assert.equal(first.diagnostics.reach.owner, 'rust_resident_timetable_kernel')
assert.equal(counter.calls, 2, 'An additive analysis must dispatch baseline and overlay Reach ranges.')
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
  'reach_owned_directed_osm_overlay_transfers',
)
assert.equal(
  first.diagnostics.scenarioPropagation.algorithm,
  'rust_resident_query_overlay_connection_scan_one_to_many',
)
assert(first.diagnostics.scenarioPropagation.settledStops > 0)
assert.equal(first.diagnostics.streetConnectorDispatches, 0)
assert.equal(counter.streetRasters ?? 0, 0, 'Final surfaces must arrive inside Reach responses.')
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

const second = await computeReachResult(clone(request), {
  runReach: fakeReachRange(counter),
})
assert.deepEqual(second.surface, first.surface, 'Repeated computation must preserve deterministic surface ordering and values.')
assert.equal(second.diagnostics.cache, undefined)
assert.equal(counter.calls, 4, 'Repeated Reach requests must compute fresh results.')
assert.equal(second.diagnostics.streetConnectorDispatches, 0)

const compactCounter = { calls: 0 }
const compact = await computeReachResult({
  ...fixtureRequest(),
  includeStreetEdges: false,
}, {
  runReach: fakeReachRange(compactCounter),
})
assert.equal(compact.surface.edges, undefined, 'Area-only Reach must omit full street-edge bundles.')
assert.equal(compactCounter.rangeRequests[0].surface.includeEdges, false)
assert.equal(compact.diagnostics.cache, undefined)

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
const preserved = await computeReachResult(preservedRequest, {
  runReach: fakeReachRange(preservedCounter),
})
assert.equal(preserved.schemaVersion, 'vigo.result.reach.v1')
assert.deepEqual(
  preservedCounter.rangeRequests[1].scenarioOverlay.directionStopOffsetsSeconds,
  [0, 7 * 60, 18 * 60, 0, 11 * 60, 18 * 60],
  'Published segment runtimes must be preserved in both directions when a branch is edited.',
)

const baselineOnlyRequest = fixtureRequest()
baselineOnlyRequest.scenario.services = []
const baselineOnlyCounter = { calls: 0 }
const baselineOnly = await computeReachResult(baselineOnlyRequest, {
  runReach: fakeReachRange(baselineOnlyCounter),
})
assert.equal(baselineOnly.summary.improvedPixels, 0)
assert.equal(baselineOnly.surface.raster.scenario, baselineOnly.surface.raster.baseline)
assert.equal(baselineOnly.surface.edges?.scenario.schemaVersion, 'vigo.street.edge-ref.v1')
assert.equal(baselineOnly.surface.edges?.scenario.source, 'baseline')

const packedSurfaceCounter = { calls: 0 }
const packedRange = fakeReachRange(packedSurfaceCounter, [])
const packedAnalysis = await computeReachResult({
  ...baselineOnlyRequest,
  baselineIdentity: 'packed-surface-preservation',
}, {
  runReach: async (rangeRequest) => {
    const result = await packedRange(rangeRequest)
    return { ...result, surface: { ...result.surface, edges: packedEdgeFixture(11) } }
  },
})
assert.equal(packedAnalysis.surface.edges?.baseline.count, 1)
assert.equal(
  Buffer.from(packedAnalysis.surface.edges?.baseline.edgeIds ?? '', 'base64').readUInt32LE(0),
  11,
  'Reach must preserve a packed street-edge bundle.',
)

const walkOnlyRequest = fixtureRequest()
walkOnlyRequest.scenario.services = []
const walkOnlyCounter = { calls: 0 }
const walkOnly = await computeReachResult(walkOnlyRequest, {
  runReach: async (rangeRequest) => {
    walkOnlyCounter.calls += 1
    assert.deepEqual(rangeRequest.origin.coordinate, walkOnlyRequest.origin.coordinate)
    assert.equal(rangeRequest.origin.stopId, undefined)
    return {
      schemaVersion: 'vigo.result.reach.v1',
      stops: [],
      surface: await fakeReachSurface(rangeRequest, []),
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

const unifiedCounter = { calls: 0, preliminary: 0 }
const unified = await computeReachResult(fixtureRequest(), {
  runReach: async (rangeRequest) => {
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
      schemaVersion: 'vigo.result.reach.v1',
      stops,
      scenarioStops,
      surface: await fakeReachSurface(rangeRequest, stops, scenarioStops),
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
    assert.equal(preliminary.diagnostics.engine, 'walk_preliminary')
    assert(preliminary.summary.baselineReachablePixels > 0)
  },
})
assert.equal(unifiedCounter.calls, 2)
assert.equal(unifiedCounter.preliminary, 1)
assert.deepEqual(unifiedCounter.streetStages, ['preliminary-surface'])
assert.equal(unifiedCounter.streetRequests[0].compactEdges, true)
assert.equal(unified.diagnostics.engine, 'unified_native_one_to_many')
assert.equal(unified.diagnostics.reachDispatches, 2)
assert.equal(unified.diagnostics.stopSelection.sampled, false)
assert.equal(unified.diagnostics.reach.owner, 'rust_resident_timetable_kernel')
assert.equal(unified.diagnostics.scenarioConnectors.mixedBaselineScenarioTransfers, true)

const destructiveRequest = fixtureRequest()
destructiveRequest.scenario.services = []
destructiveRequest.scenario.excludedRouteIds = ['ROUTE_TO_REMOVE']
destructiveRequest.scenario.excludedTripIds = ['TRIP_TO_REMOVE']
const destructiveCalls = []
const destructive = await computeReachResult(destructiveRequest, {
  runReach: async (rangeRequest) => {
    destructiveCalls.push(clone(rangeRequest))
    const removed = rangeRequest.excludedRouteIds?.includes('ROUTE_TO_REMOVE')
    const stops = removed
      ? [{ id: 'origin-stop', label: 'Origin', coordinate: [0, 0], source: 'stop', stopId: 'ORIGIN', durationMinutes: 0 }]
      : [
        { id: 'origin-stop', label: 'Origin', coordinate: [0, 0], source: 'stop', stopId: 'ORIGIN', durationMinutes: 0 },
        { id: 'east', label: 'East', coordinate: [0.04, 0], source: 'stop', stopId: 'EAST', durationMinutes: 12 },
      ]
    return {
      schemaVersion: 'vigo.result.reach.v1',
      stops,
      surface: await fakeReachSurface(rangeRequest, stops),
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
assert.equal(destructiveCalls.length, 2, 'A destructive scenario must run a separate modified range.')
assert.equal(destructiveCalls[0].stage, 'baseline-range')
assert.equal(destructiveCalls[1].stage, 'scenario-range')
assert.deepEqual(destructiveCalls[0].excludedRouteIds, undefined)
assert.deepEqual(destructiveCalls[1].excludedRouteIds, ['ROUTE_TO_REMOVE'])
assert.deepEqual(destructiveCalls[1].excludedTripIds, ['TRIP_TO_REMOVE'])
assert.equal(destructiveCalls[1].maxWalkKm, destructiveCalls[0].maxWalkKm)
assert.equal(destructiveCalls[1].walkSpeedKph, destructiveCalls[0].walkSpeedKph)
assert.equal(destructive.diagnostics.reachDispatches, 2)
assert(destructive.summary.scenarioReachablePixels < destructive.summary.baselineReachablePixels)

const normalizedScopeRequest = validateReachRequest({
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

const derivedSaturdayRequest = validateReachRequest({
  ...fixtureRequest(),
  serviceDate: '2026-07-18',
  serviceDay: undefined,
})
assert.equal(derivedSaturdayRequest.serviceDay, 'saturday')
assert.throws(
  () => validateReachRequest({
    ...fixtureRequest(),
    departMinutes: 480.5,
  }),
  /integral number/,
  'Reach must reject fractional departure minutes instead of truncating them.',
)
assert.throws(
  () => validateReachRequest({ ...fixtureRequest(), serviceDate: undefined }),
  /serviceDate is required/,
)

assert.deepEqual(
  scenarioEntityCandidates('feed_e0d954794a::41'),
  ['feed_e0d954794a\u001f41', '41'],
  'Bundle route IDs must expose both merged-store and feed-store candidates.',
)
assert(scenarioEntityMatches('feed_e0d954794a\u001f41', 'feed_e0d954794a::41'))
assert(scenarioEntityMatches('feed_e0d954794a\u001f41--pattern-2', 'feed_e0d954794a::41--pattern-2'))
assert(!scenarioEntityMatches('other-feed\u001f41', 'feed_e0d954794a::41'))

assert.doesNotThrow(
  () => validateReachRequest({ ...fixtureRequest(), rasterSize: 1024 }),
)
assert.throws(
  () => validateReachRequest({ ...fixtureRequest(), rasterSize: 50 }),
  /rasterSize/i,
)
assert.doesNotThrow(
  () => validateReachRequest({
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
  () => validateReachRequest({
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

console.log(JSON.stringify({
  ok: true,
  schemaVersion: first.schemaVersion,
  raster: `${first.surface.raster.width}x${first.surface.raster.height}`,
  improvedPixels: first.summary.improvedPixels,
  reachDispatches: counter.calls,
}, null, 2))
