import { NativeRuntime, nativeLayout, nativeExecutable } from '../server/runtime/native-runtime.mjs'
import { nativeSurface, plannedService, nativePoint } from '../server/studio-reach-ranges.mjs'

// Routing runs in the `vigo` executable, as in Studio, the Rust CLI and the HTTP
// server: one request form for both directions and one implementation. The
// Node CLI validates the request, keeps one resident process per City and
// presents the answer in its own Result shape.
const plannedStop = /^scenario-[0-9a-f]+\u001f/u

export { nativePoint }

let runtime = null

/** Answer one routing request; `openMs` is nonzero only when this call started the City's process. */
export async function queryNativeCity(cityPath, request) {
  runtime ??= new NativeRuntime({ executable: nativeExecutable(), maxCities: 1, maxProcesses: 1 })
  if (!runtime.available) {
    throw new Error('Routing runs in the vigo executable. Build it with npm run build:standalone, or set VIGO_STANDALONE_PATH.')
  }
  const layout = nativeLayout(cityPath)
  const opening = !runtime.cities.has(layout.key)
  const started = performance.now()
  const trace = await runtime.query(layout, request)
  const wallMs = performance.now() - started
  const computeMs = Math.min(wallMs, Number(trace.timing?.totalMs ?? wallMs))
  return { trace, openMs: opening ? wallMs - computeMs : 0, computeMs }
}

export function closeNativeCity() {
  runtime?.closeAll()
  runtime = null
}

/**
 * A compiled CLI scenario as the runtime's planned services. Replacements are
 * already resolved into the excluded trips and routes, so every service is added.
 */
export function nativeScenario(scenario) {
  const changed = scenario.services.length || scenario.excludedRouteIds.length || scenario.excludedTripIds.length
  return changed ? {
    id: scenario.id,
    name: scenario.name,
    excludedRouteIds: scenario.excludedRouteIds,
    excludedTripIds: scenario.excludedTripIds,
    ...(scenario.services.length ? { services: scenario.services.map(nativeService) } : {}),
  } : undefined
}

// Normalized planned stops default to the "map" source, which the runtime
// places by coordinate. A stop that names a GTFS stop joins it, as before.
function nativeService(service) {
  const planned = plannedService(service)
  return {
    ...planned,
    stops: planned.stops.map(stop => stop.stopId && stop.source === 'map' ? { ...stop, source: 'stop' } : stop),
  }
}

/**
 * The runtime's Reach answer as the CLI's surface, stops and diagnostics.
 * Planned stops keep their service stop IDs, or arrive-by's scenario feed.
 */
export function nativeReachRange(trace, scenario) {
  const surface = nativeSurface(trace)
  // Planned stop IDs, with the GTFS stop each one joins.
  const plannedStops = new Map((scenario?.services ?? []).flatMap(service => service.stops.map(stop => [String(stop.id), stop.stopId])))
  const stops = []
  const scenarioStops = []
  for (const stop of trace.stops ?? []) {
    const stopId = String(stop.stopId)
    const durationMinutes = Number(stop.durationMinutes)
    if (plannedStops.has(stopId) || plannedStop.test(stopId)) {
      const joined = plannedStops.get(stopId)
      scenarioStops.push({ id: stopId.split('\u001f').at(-1), label: stop.name, coordinate: stop.coordinate,
        source: 'scenario-stop', ...(joined ? { stopId: joined } : {}), durationMinutes })
    } else {
      stops.push({ id: `transit-stop:${stopId}`, label: stop.name, coordinate: stop.coordinate, source: 'stop',
        stopId, durationMinutes })
    }
  }
  return {
    stops,
    scenarioStops,
    surface: {
      schemaVersion: surface.schemaVersion,
      values: surface.values,
      fullValues: surface.fullValues,
      fullBounds: surface.fullBounds,
      width: surface.width,
      height: surface.height,
      bounds: surface.bounds,
      ...(surface.sampling === 'cell-center' ? { sampling: surface.sampling } : {}),
      nodes: (trace.surface?.nodes ?? []).map(node => ({
        coordinate: [node.longitude, node.latitude],
        durationMinutes: node.durationMinutes,
        walkDistanceM: node.walkDistanceM,
      })),
      // Cell centers are not street samples and carry no edges.
      edges: surface.sampling === 'cell-center' ? null : surface.edges ?? [],
      diagnostics: surface.diagnostics,
    },
    diagnostics: { owner: 'rust_standalone_runtime', ...trace.diagnostics },
  }
}
