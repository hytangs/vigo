// Studio Reach asks the native runtime for each surface it composes: the
// reference and scenario ranges, and the preliminary walking preview. This
// module translates those requests to the public Reach request (planned
// services are compiled and run natively) and returns the native surfaces in
// the packed form Studio's Reach composition reads.

const rasterSchema = 'vigo.street.network-raster.v1'

function routePoint(point) {
  return Object.fromEntries(['stopId', 'coordinate', 'id', 'name', 'label', 'source']
    .filter(key => point?.[key] !== undefined).map(key => [key, point[key]]))
}

const plannedServiceFields = ['id', 'name', 'stops', 'scheduleMode', 'scheduledTrips', 'bidirectional',
  'averageSpeedKph', 'dwellMinutes', 'timeModel', 'addedStopDwellMinutes', 'startMinutes', 'endMinutes',
  'headwayMinutes', 'segmentDistancesKm', 'segmentRuntimeMinutes']

/**
 * A Studio service as a public planned service. Studio has already resolved
 * which original trips a replacement removes (its branch, or the whole route)
 * into the scenario's excluded trips and routes, so every service is added.
 */
export function plannedService(service) {
  return {
    ...Object.fromEntries(plannedServiceFields.filter(key => service[key] !== undefined).map(key => [key, service[key]])),
    operation: 'add',
    stops: service.stops.map(stop => Object.fromEntries(['id', 'stopId', 'coordinate', 'label', 'source', 'editStatus']
      .filter(key => stop[key] !== undefined).map(key => [key, stop[key]]))),
  }
}

/** The public Reach request for one Studio range (`baseline-range`, `scenario-range`). */
export function nativeReachRangeRequest(range, { sourceScopes } = {}) {
  const surface = range.surface ?? {}
  const width = Number(surface.width)
  if (!Number.isInteger(width) || width !== Number(surface.height)) {
    throw Object.assign(new Error('Reach surfaces use a square raster.'), { statusCode: 400 })
  }
  const services = range.scenarioServices ?? []
  const changed = services.length || range.excludedRouteIds?.length || range.excludedTripIds?.length
  return {
    kind: 'reach',
    // Studio draws its own areas from the surface and reads typed arrays.
    reachFormat: 'surface',
    arrayEncoding: 'base64',
    mode: range.mode ?? 'transit',
    surfaceSampling: range.surfaceSampling ?? 'street',
    origin: routePoint(range.origin),
    serviceDate: range.serviceDate,
    timeMinutes: Number(range.departMinutes),
    maxWalkKm: range.maxWalkKm,
    ...(range.maxTransfers !== undefined ? { maxTransfers: range.maxTransfers } : {}),
    walkSpeedKph: range.walkSpeedKph,
    cutoffsMinutes: [Number(range.cutoffMinutes)],
    rasterSize: width,
    bounds: surface.bounds,
    includeStreetEdges: surface.includeEdges === true,
    includeNodes: false,
    // The scenario surface grows from the reference surface just computed.
    ...(range.stage === 'baseline-range' ? { surfaceReuse: 'baseline' }
      : range.stage === 'scenario-range' ? { surfaceReuse: 'scenario' } : {}),
    ...((range.mode ?? 'transit') === 'transit' ? {
      routingDataMode: 'scheduled',
      requireCompleteServiceCoverage: true,
      ...(sourceScopes ? { sourceScopes } : {}),
    } : {}),
    ...(changed ? { scenario: {
      excludedRouteIds: range.excludedRouteIds ?? [],
      excludedTripIds: range.excludedTripIds ?? [],
      ...(services.length ? { services: services.map(plannedService) } : {}),
    } } : {}),
  }
}

/** The preliminary walking preview: the origin's own street surface. */
export function nativePreliminaryRequest(surface, origin, serviceDate, departMinutes) {
  return {
    kind: 'reach',
    reachFormat: 'surface',
    arrayEncoding: 'base64',
    mode: 'walk',
    surfaceSampling: 'street',
    origin: { coordinate: surface.seeds?.[0]?.coordinate ?? origin.coordinate },
    serviceDate,
    timeMinutes: Number(departMinutes),
    maxWalkKm: surface.maxWalkKm,
    walkSpeedKph: surface.walkSpeedKph,
    cutoffsMinutes: [Number(surface.maximumDurationMinutes)],
    rasterSize: Number(surface.width),
    bounds: surface.bounds,
    includeStreetEdges: surface.includeEdges === true,
    includeNodes: false,
  }
}

// JSON cannot carry Infinity: an unreached cell arrives as null.
function typedArray(values = [], Type = Float64Array) {
  const typed = new Type(values.length)
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    typed[index] = value === null ? Infinity : value
  }
  return typed
}

// A base64 array is little-endian f64 already; copy it into aligned memory.
function minutesArray(values) {
  if (typeof values !== 'string') return typedArray(values ?? [])
  const bytes = Buffer.from(values, 'base64')
  return new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

function packed(values, Type) {
  if (typeof values === 'string') return values
  const typed = typedArray(values ?? [], Type)
  return Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString('base64')
}

/** Native street edges in Studio's packed edge bundle. */
function edgeBundle(edges) {
  if (!edges || edges.schemaVersion !== 'vigo.standalone.street-edges.v2') return null
  return {
    schemaVersion: 'vigo.street.edge-bundle.v2',
    encoding: 'indexed-f64-le',
    count: Number(edges.count ?? edges.edgeIds?.length ?? 0),
    nodeCount: Number(edges.nodeCount ?? (edges.nodes?.length ?? 0) / 2),
    nodes: packed(edges.nodes, Float64Array),
    endpoints: packed(edges.endpoints, Uint32Array),
    edgeIds: packed(edges.edgeIds, Uint32Array),
    durationMinutes: packed(edges.durationMinutes, Float64Array),
    fromDurationMinutes: packed(edges.fromDurationMinutes, Float64Array),
    startFractions: packed(edges.startFractions, Float64Array),
    endFractions: packed(edges.endFractions, Float64Array),
    walkDistanceM: packed(edges.walkDistanceM, Float64Array),
    transitArrivalMinutes: packed(edges.transitArrivalMinutes, Float64Array),
  }
}

export function nativeSurface(result) {
  const surface = result.surface ?? {}
  return {
    schemaVersion: rasterSchema,
    sampling: surface.sampling,
    width: surface.width,
    height: surface.height,
    bounds: surface.bounds,
    values: minutesArray(surface.values),
    fullValues: minutesArray(surface.fullValues ?? surface.values),
    fullBounds: surface.fullBounds ?? surface.bounds,
    nodes: [],
    edges: edgeBundle(surface.edges),
    diagnostics: result.diagnostics?.surface ?? {},
  }
}

function transitStatus(result, range) {
  const stops = Array.isArray(result.stops) ? result.stops.length : 0
  const departure = Number(range.departMinutes)
  const base = {
    requestedDepartureMinutes: departure,
    windowEndMinutes: departure + Number(range.cutoffMinutes),
    reachedStops: stops,
  }
  if ((range.mode ?? 'transit') !== 'transit') {
    return range.mode === 'drive'
      ? { ...base, status: 'drive_only', detail: 'Driving only; road-speed estimates.', reachedStops: 0 }
      : { ...base, status: 'walk_only', detail: 'Walking only.', reachedStops: 0 }
  }
  if (stops > 0) return { ...base, status: 'reached', detail: `${stops} transit stops are reachable within the selected window.` }
  return {
    ...base,
    status: 'no_reachable_stops',
    detail: 'Scheduled transit is present, but no transit stop is reachable within the selected window and access budget.',
  }
}

/** A native Reach Result as the range Studio's Reach composition expects. */
export function studioReachRange(result, range) {
  const overlayIds = new Set((range.scenarioOverlay?.stops ?? []).map((stop, index) => String(stop?.id ?? `scenario:${index}`)))
  const allStops = (result.stops ?? []).map(stop => ({
    stopId: stop.stopId,
    name: stop.name,
    coordinate: stop.coordinate,
    durationMinutes: Number(stop.durationMinutes),
  }))
  const transit = result.diagnostics?.transit
  return {
    schemaVersion: 'vigo.result.reach.v1',
    stops: allStops.filter(stop => !overlayIds.has(String(stop.stopId))),
    scenarioStops: allStops.filter(stop => overlayIds.has(String(stop.stopId))),
    surface: nativeSurface(result),
    diagnostics: {
      owner: 'rust_standalone_runtime',
      algorithm: range.scenarioOverlay
        ? 'rust_resident_query_overlay_connection_scan_one_to_many'
        : 'rust_resident_connection_scan_one_to_many',
      transit: transitStatus(result, range),
      timetable: {
        ...(Number.isInteger(transit?.residentTrips) ? { residentTrips: transit.residentTrips } : {}),
        ...(transit && range.scenarioOverlay ? { scenarioOverlay: {
          overlayConnections: transit.overlayConnections ?? null,
          supplementalTransferEdges: transit.supplementalTransferEdges ?? null,
        } } : {}),
      },
      search: {
        engine: 'rust_standalone_runtime',
        reachedStops: allStops.length,
        excludedTrips: transit?.excludedTrips ?? 0,
        relaxedStops: transit?.relaxedStops ?? transit?.timetable?.relaxedStops ?? 0,
        nativeQueryMs: Number(((transit?.queryNs ?? transit?.timetable?.queryNs ?? 0) / 1e6).toFixed(3)),
      },
      stopSelection: {
        candidates: allStops.length,
        selected: allStops.length,
        sampled: false,
        strategy: 'all-active-timetable-stops',
      },
      surface: result.diagnostics?.surface ?? {},
      totalMs: Number(Number(result.timing?.totalMs ?? 0).toFixed(3)),
    },
  }
}
