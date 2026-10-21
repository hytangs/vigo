import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NativeRuntime, nativeLayout } from '../server/runtime/native-runtime.mjs'
import { nativeSurface, plannedService } from '../server/studio-reach-ranges.mjs'

// Reach runs in the `vigo` executable, as in Studio, the Rust CLI and the HTTP
// server: one request form for both directions and one implementation. The
// Node CLI validates the request, keeps one resident process per City and
// presents the answer in its own Result shape.
const executableName = process.platform === 'win32' ? 'vigo.exe' : 'vigo'
const plannedStop = /^scenario-[0-9a-f]+\u001f/u

/**
 * The executable beside this CLI (a staged runtime), beside Studio's bundled
 * server, or in this checkout's release build; `VIGO_STANDALONE_PATH` overrides.
 */
export function reachExecutable(environment = process.env, directory = path.dirname(fileURLToPath(import.meta.url))) {
  const configured = String(environment.VIGO_STANDALONE_PATH ?? '').trim()
  const candidates = configured ? [configured] : [
    path.join(directory, executableName),
    path.join(directory, '..', 'server', executableName),
    path.join(directory, '..', 'native', 'vigo-routing-kernel', 'target', 'release', executableName),
  ]
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {}
  }
  return null
}

let runtime = null
const openedCities = new Set()

/** Answer one Reach request; `openMs` is nonzero only when this call started the City's process. */
export async function queryNativeReach(cityPath, request) {
  runtime ??= new NativeRuntime({ executable: reachExecutable(), maxCities: 1, maxProcesses: 1 })
  if (!runtime.available) {
    throw new Error('Reach runs in the vigo executable. Build it with npm run build:standalone, or set VIGO_STANDALONE_PATH.')
  }
  const layout = nativeLayout(cityPath)
  const opening = !openedCities.has(layout.key)
  const started = performance.now()
  const trace = await runtime.query(layout, request)
  openedCities.add(layout.key)
  const wallMs = performance.now() - started
  const computeMs = Math.min(wallMs, Number(trace.timing?.totalMs ?? wallMs))
  return { trace, openMs: opening ? wallMs - computeMs : 0, computeMs }
}

export function closeNativeReach() {
  runtime?.closeAll()
  runtime = null
  openedCities.clear()
}

/** A resolved CLI point as the runtime's public point. */
export function nativePoint(point) {
  return Object.fromEntries(['stopId', 'coordinate', 'id', 'name', 'label', 'source']
    .filter(key => point?.[key] !== undefined).map(key => [key, point[key]]))
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
