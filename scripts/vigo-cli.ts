import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import Papa from 'papaparse'
import packageJson from '../package.json'
import {
  buildNationalGtfsStore,
  compactNationalGtfsRuntimeStore,
  disposeNationalGtfsStore,
  ensureNationalGtfsOsmStopTransfers,
  mergeNationalGtfsStores,
  prepareNationalGtfsRoutingContext,
  prepareNationalGtfsNativeCoordinateAccess,
  prepareNationalGtfsStore,
  readNationalGtfsStoreMetadata,
  resolveNationalInteractiveRoutingPreference,
  routeNationalGtfsAccessibilityRange,
  routeNationalGtfsDepartureWindow,
  routeNationalGtfsMatrix,
  routeNationalGtfsStore,
} from '../server/national-gtfs-store.mjs'
import {
  buildNationalOsmDriveStore,
  buildNationalOsmStore,
  compactNationalOsmRuntimeStore,
  disposeNationalOsmStore,
  prepareNationalOsmNativeStore,
} from '../server/national-osm-store.mjs'
import { buildNativeStreetCchIndex } from '../server/native-routing-kernel.mjs'
import { rasterBounds, rasterContours } from '../server/scenario-analysis.mjs'
import type { ServiceDay } from '../src/domain'
import type { RoutingPlan, RoutingPoint, RoutingResultStatus, RoutingTimePreference } from '../src/routingModel'

type CliArguments = Map<string, string[]>
type RouteResult = { plan: RoutingPlan | undefined; profileSampleCount: number; elapsedMs: number }

const cliStartedAt = performance.now()
const rawOsmWorkingSetMultiplier = 80
const rawGtfsWorkingSetMultiplier = 20
const rawCompilerFixedWorkingSetBytes = 256 * 1024 * 1024

function usage() {
  return [
    `VIGO ${packageJson.version}`,
    '',
    'Usage:',
    '  vigo build-network --osm-pbf=/path/to/region.osm.pbf --gtfs=/path/to/feed.zip --output-dir=/path/to/network',
    '  vigo route --store=/path/to/feed.sqlite --od=/path/to/od.csv --out=/path/to/routes.csv [options]',
    '  vigo route-ndjson --store=/path/to/feed.sqlite [options] < requests.ndjson',
    '  vigo one-to-many --store=/path/to/feed.sqlite --request=/path/to/request.json [options]',
    '  vigo isochrone --store=/path/to/feed.sqlite --street-store=/path/to/street-index.sqlite --request=/path/to/request.json [options]',
    '  vigo prepare --store=/path/to/feed.sqlite --street-store=/path/to/street-index.sqlite [options]',
    '',
    'OD columns:',
    '  id, origin_lon, origin_lat, destination_lon, destination_lat',
    '  Optional: origin_stop_id, destination_stop_id, origin_name, destination_name',
    '',
    'Options:',
    '  --gtfs PATH                 GTFS ZIP for build-network; repeat for multiple feeds',
    '  --gtfs-scope VALUE          Optional unique scope for each repeated --gtfs',
    '  --osm-pbf PATH              OSM .pbf input for build-network',
    '  --output-dir PATH           Compiled network directory for build-network',
    '  --force                     Replace an existing compiled network',
    '  --sequential-raw-build      Disable memory-gated parallel GTFS/OSM compilation',
    '  --store PATH                VIGO GTFS SQLite routing store',
    '  --street-store PATH         Required when either endpoint is a coordinate',
    '  --od PATH                   Input OD CSV',
    '  --out PATH                  Output route CSV',
    '  --json-out PATH             Optional full-fidelity JSON results for language bindings',
    '  --request PATH              JSON request for one-to-many or isochrone',
    '  --time HH:MM                Selected time (default: 08:00)',
    '  --time-preference VALUE     depart or arrive (default: depart)',
    '  --routing-preference VALUE  balanced or fastest (default: balanced)',
    '  --departure-window MIN      Centered departure profile, +/- minutes (depart only)',
    '  --service-day VALUE         weekday, saturday, or sunday',
    '  --service-date YYYY-MM-DD   Required exact service date',
    '  --max-walk KM               Physical walking budget (default: 1.2)',
    '  --horizon MIN               One-to-many scan horizon (default: 480)',
    '  --matrix-strategy VALUE     shared, pairwise, or auto (default: shared)',
    '  --cutoffs MINUTES           Isochrone thresholds, comma-separated (default: 15,30,45,60)',
    '  --radius KM                 Isochrone display radius (default: 8)',
    '  --raster-size N             Isochrone grid: 48, 64, 96, 128, 192, 256, 384, 512, or 1024 (default: 96)',
    '  --walk-speed KPH            Isochrone walking speed (default: 4.8)',
    '  --help                      Show this help',
    '  --version                   Print the VIGO version',
    '',
    'route-ndjson input:',
    '  One JSON object per line with id, origin, and destination.',
    '  A point is a stop ID string or {"stopId":"..."} or {"coordinate":[lon,lat]}.',
    '  Per-request overrides: time, timeMinutes, timePreference, routingPreference, maxWalkKm, departureWindowMinutes, disableCache.',
    '',
    'one-to-many request JSON:',
    '  {"origin":"A","destinations":[{"id":"b","point":"B"},{"id":"map","point":{"coordinate":[lon,lat]}}]}',
    '',
    'isochrone request JSON:',
    '  {"origin":{"coordinate":[lon,lat]},"cutoffsMinutes":[15,30,45,60],"radiusKm":8,"rasterSize":96}',
    '',
  ].join('\n')
}

function parseArguments(argv: string[]) {
  const args: CliArguments = new Map()
  const positionals: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const equals = token.indexOf('=')
    const name = token.slice(2, equals >= 0 ? equals : undefined)
    let optionValue = equals >= 0 ? token.slice(equals + 1) : 'true'
    if (equals < 0 && argv[index + 1] && !argv[index + 1].startsWith('-')) {
      optionValue = argv[index + 1]
      index += 1
    }
    args.set(name, [...(args.get(name) ?? []), optionValue])
  }
  return { command: positionals[0] ?? 'route', args }
}

function value(args: CliArguments, name: string, fallback = '') {
  return args.get(name)?.at(-1) ?? fallback
}

function values(args: CliArguments, name: string) {
  return args.get(name) ?? []
}

function enabled(args: CliArguments, name: string) {
  return ['1', 'true', 'yes'].includes(value(args, name).trim().toLowerCase())
}

function parseClock(input: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(input.trim())
  if (!match) throw new Error(`Invalid --time value: ${input}`)
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (minutes > 59 || hours > 29) throw new Error(`Invalid --time value: ${input}`)
  return hours * 60 + minutes
}

function parseNumber(input: string, label: string, minimum = 0) {
  const parsed = Number(input)
  if (!Number.isFinite(parsed) || parsed < minimum) throw new Error(`Invalid --${label} value: ${input}`)
  return parsed
}

function normalizeServiceDate(input: string) {
  const text = input.trim()
  if (!text) return undefined
  const dashed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text)
  if (dashed) return text
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`
  throw new Error(`Invalid --service-date value: ${input}`)
}

function numberField(row: Record<string, string>, names: string[]) {
  for (const name of names) {
    const raw = row[name]
    if (raw === undefined || raw === null || String(raw).trim() === '') continue
    const parsed = Number(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function openStopLookup(storePath: string) {
  const database = new DatabaseSync(storePath, { readOnly: true })
  const lookup = database.prepare('SELECT stop_id, name, lon, lat FROM stops WHERE stop_id=?')
  return {
    close: () => database.close(),
    point(stopId: string, label?: string): RoutingPoint | null {
      const row = lookup.get(stopId) as { stop_id: string; name: string; lon: number; lat: number } | undefined
      if (!row || !Number.isFinite(row.lon) || !Number.isFinite(row.lat)) return null
      return { stopId: row.stop_id, coordinate: [row.lon, row.lat], label: label || row.name || row.stop_id, source: 'stop' }
    },
  }
}

function buildPoint(
  row: Record<string, string>,
  prefix: 'origin' | 'destination',
  stopLookup: ReturnType<typeof openStopLookup>,
): RoutingPoint | null {
  const stopId = String(row[`${prefix}_stop_id`] || row[`${prefix}StopId`] || '').trim()
  const label = row[`${prefix}_name`] || row[`${prefix}Name`] || (prefix === 'origin' ? 'Starting point' : 'Destination')
  if (stopId) return stopLookup.point(stopId, label)
  const lon = numberField(row, [`${prefix}_lon`, `${prefix}_lng`, `${prefix}Lon`, `${prefix}Lng`, prefix === 'origin' ? 'from_lon' : 'to_lon'])
  const lat = numberField(row, [`${prefix}_lat`, `${prefix}Lat`, prefix === 'origin' ? 'from_lat' : 'to_lat'])
  if (lon === undefined || lat === undefined) return null
  return { coordinate: [lon, lat], label, source: 'map' }
}

function pointKey(point: RoutingPoint) {
  return JSON.stringify({
    stopId: point.stopId ?? null,
    coordinate: point.coordinate.map((coordinate) => Object.is(coordinate, -0) ? 0 : coordinate),
    label: point.label,
    source: point.source,
  })
}

function requireStreetStoreForCoordinateEndpoints(
  streetStorePath: string | undefined,
  origin: RoutingPoint,
  destination: RoutingPoint,
  requestLabel: string,
) {
  if (streetStorePath || (origin.stopId && destination.stopId)) return
  throw new Error(
    `${requestLabel}: coordinate endpoints require --street-store; only exact-stop routing may omit the OSM street index`,
  )
}

function routeSequence(plan: RoutingPlan | undefined) {
  if (!plan) return ''
  return plan.legs
    .filter((leg) => leg.type === 'ride')
    .map((leg) => leg.routeShortName || leg.routeId || leg.routeFeatureId || '')
    .filter((route, index, routes) => route && routes.indexOf(route) === index)
    .join(' > ')
}

function decorateCliRoutingPlan(plan: RoutingPlan | undefined) {
  if (!plan) return plan
  const code = String(plan.diagnostics.failure?.code ?? plan.diagnostics.failureCode ?? '')
  const category = String(plan.diagnostics.failure?.category ?? plan.diagnostics.failureCategory ?? '')
  const routingStatus: RoutingResultStatus = plan.diagnostics.routingStatus ?? (
    plan.status === 'ready'
      ? 'ready'
      : code.includes('stale') || code.includes('artifact')
        ? 'stale'
        : code.includes('cancel')
          ? 'cancelled'
          : category === 'unsupported_feature' || code.includes('unsupported')
            ? 'unsupported'
            : 'blocked'
  )
  return {
    ...plan,
    diagnostics: {
      ...plan.diagnostics,
      routingStatus,
      routingStatusSchemaVersion: 'vigo.routing.status.v1' as const,
    },
  }
}

function routeOne(storePath: string, request: Record<string, unknown>, departureWindowMinutes: number): RouteResult {
  const startedAt = performance.now()
  if (request.timePreference === 'depart' && departureWindowMinutes > 0) {
    const profile = routeNationalGtfsDepartureWindow(storePath, {
      ...request,
      departureWindowMinutes,
      stepMinutes: 1,
    })
    return {
      plan: decorateCliRoutingPlan(profile.plan),
      profileSampleCount: profile.profile.sampleCount,
      elapsedMs: performance.now() - startedAt,
    }
  }
  return {
    plan: decorateCliRoutingPlan(routeNationalGtfsStore(storePath, request)),
    profileSampleCount: 0,
    elapsedMs: performance.now() - startedAt,
  }
}

function engineDescriptor(results: Iterable<RouteResult>) {
  const algorithms = new Set<string>()
  const methods = new Set<string>()
  for (const result of results) {
    const algorithm = result.plan?.diagnostics.algorithm
    if (algorithm) algorithms.add(algorithm)
    const methodUsed = result.plan?.diagnostics.methodUsed
    for (const method of Array.isArray(methodUsed) ? methodUsed : methodUsed ? [methodUsed] : []) {
      if (method) methods.add(String(method))
    }
  }
  const algorithmList = [...algorithms].sort()
  return {
    name: 'VIGO',
    algorithm: algorithmList.length === 1
      ? algorithmList[0]
      : algorithmList.length
        ? 'mixed_exact_routing'
        : 'no_route_executed',
    algorithms: algorithmList,
    methods: [...methods].sort(),
    storage: 'sqlite-persisted-resident-compiled',
    persistentStore: 'sqlite',
    queryExecutor: 'resident-active-service-kernel',
    sqlRouteExecutor: false,
  }
}

function resolveRuntimePaths(args: CliArguments) {
  const storeValue = value(args, 'store')
  const streetStoreValue = value(args, 'street-store')
  if (!storeValue) throw new Error('a routing command requires --store')
  const storePath = path.resolve(storeValue)
  const streetStorePath = streetStoreValue ? path.resolve(streetStoreValue) : undefined
  for (const filePath of [storePath, ...(streetStorePath ? [streetStorePath] : [])]) {
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`)
  }
  if (!/\.sqlite$/i.test(storePath)) throw new Error('--store must be a VIGO SQLite routing store')
  if (streetStorePath && !/\.sqlite$/i.test(streetStorePath)) throw new Error('--street-store must be a VIGO SQLite street index')
  return { storePath, streetStorePath }
}

function runtimeOptions(args: CliArguments) {
  const serviceDay = value(args, 'service-day', 'weekday') as ServiceDay
  if (!['weekday', 'saturday', 'sunday'].includes(serviceDay)) throw new Error(`Invalid --service-day value: ${serviceDay}`)
  const timePreference = value(args, 'time-preference', 'depart') as RoutingTimePreference
  if (!['depart', 'arrive'].includes(timePreference)) throw new Error(`Invalid --time-preference value: ${timePreference}`)
  const routingPreferenceValue = value(args, 'routing-preference', 'balanced')
  if (!['balanced', 'fastest'].includes(routingPreferenceValue)) {
    throw new Error(`Invalid --routing-preference value: ${routingPreferenceValue}`)
  }
  const routingPreference = resolveNationalInteractiveRoutingPreference(routingPreferenceValue)
  const timeMinutes = parseClock(value(args, 'time', '08:00'))
  const serviceDate = normalizeServiceDate(value(args, 'service-date'))
  if (!serviceDate) throw new Error('--service-date is required for exact timetable routing')
  const maxWalkKm = parseNumber(value(args, 'max-walk', '1.2'), 'max-walk', 0.01)
  const departureWindowMinutes = parseNumber(value(args, 'departure-window', '0'), 'departure-window')
  if (timePreference === 'arrive' && departureWindowMinutes > 0) {
    throw new Error('--departure-window is a centered departure profile; omit it for arrive-by search')
  }
  return {
    serviceDay,
    timePreference,
    routingPreference,
    timeMinutes,
    serviceDate,
    maxWalkKm,
    departureWindowMinutes,
  }
}

async function prepareRuntime(
  storePath: string,
  streetStorePath: string | undefined,
  serviceDate: string | undefined,
  serviceDay: ServiceDay,
) {
  const preparationStarted = performance.now()
  const street = streetStorePath
    ? prepareNationalOsmNativeStore(streetStorePath, { requireCurrentSchema: true })
    : null
  const transfers = streetStorePath
    ? await ensureNationalGtfsOsmStopTransfers(storePath, streetStorePath)
    : null
  const routing = serviceDate
    ? prepareNationalGtfsRoutingContext(storePath, {
        serviceDate,
        serviceDay,
        streetStorePath,
        allowServiceDateFallback: false,
      })
    : prepareNationalGtfsStore(storePath)
  return {
    elapsedMs: Number((performance.now() - preparationStarted).toFixed(3)),
    routing,
    street,
    transfers,
  }
}

async function runRoute(args: CliArguments) {
  const { storePath, streetStorePath } = resolveRuntimePaths(args)
  const odPath = path.resolve(value(args, 'od'))
  const outPath = path.resolve(value(args, 'out'))
  const jsonOutValue = value(args, 'json-out')
  const jsonOutPath = jsonOutValue ? path.resolve(jsonOutValue) : undefined
  if (!value(args, 'store') || !value(args, 'od') || !value(args, 'out')) {
    throw new Error('route requires --store, --od, and --out')
  }
  for (const filePath of [odPath]) {
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`)
  }
  const {
    serviceDay,
    timePreference,
    routingPreference,
    timeMinutes,
    serviceDate,
    maxWalkKm,
    departureWindowMinutes,
  } = runtimeOptions(args)

  const metadata = readNationalGtfsStoreMetadata(storePath)
  const preparation = await prepareRuntime(storePath, streetStorePath, serviceDate, serviceDay)
  const parsed = Papa.parse<Record<string, string>>(fs.readFileSync(odPath, 'utf8'), { header: true, skipEmptyLines: true })
  if (parsed.errors.length) throw new Error(`OD CSV parse failed: ${parsed.errors[0].message}`)
  const stopLookup = openStopLookup(storePath)
  const querySemantics = departureWindowMinutes > 0 ? 'centered_departure_profile' : timePreference === 'arrive' ? 'fixed_arrival' : 'fixed_departure'
  const results = new Map<string, RouteResult>()
  const rows: Array<Record<string, string | number>> = []
  const fullResults: Array<{ id: string; plan: RoutingPlan | null; blockedReason?: string }> = []
  const routingStarted = performance.now()
  try {
    for (let index = 0; index < parsed.data.length; index += 1) {
      const input = parsed.data[index]
      const id = input.id || input.student_id || input.od_id || `row_${index + 1}`
      const origin = buildPoint(input, 'origin', stopLookup)
      const destination = buildPoint(input, 'destination', stopLookup)
      if (!origin || !destination) {
        const blockedReason = 'missing or unknown origin/destination'
        rows.push({ id, status: 'blocked', blocked_reason: blockedReason, walking_network: streetStorePath ? 'sqlite-osm' : 'direct', query_semantics: querySemantics })
        fullResults.push({ id, plan: null, blockedReason })
        continue
      }
      requireStreetStoreForCoordinateEndpoints(streetStorePath, origin, destination, `OD ${id}`)
      const cacheKey = [
        pointKey(origin), pointKey(destination), timeMinutes, timePreference, routingPreference,
        serviceDay, serviceDate ?? '',
        maxWalkKm.toFixed(3), departureWindowMinutes, streetStorePath ?? 'direct',
      ].join('|')
      let result = results.get(cacheKey)
      if (!result) {
        const request = {
          origin,
          destination,
          departMinutes: timeMinutes,
          arriveMinutes: timeMinutes,
          timePreference,
          routingPreference,
          serviceDay,
          serviceDate,
          allowServiceDateFallback: false,
          maxWalkKm,
          streetStorePath,
        }
        result = routeOne(storePath, request, departureWindowMinutes)
        results.set(cacheKey, result)
      }
      const plan = result.plan
      fullResults.push({
        id,
        plan: plan ?? null,
        ...(plan?.status === 'blocked' ? { blockedReason: `${plan.title}: ${plan.detail}` } : {}),
      })
      rows.push({
        id,
        status: plan?.status ?? 'blocked',
        routing_status: plan?.diagnostics?.routingStatus ?? (plan?.status === 'ready' ? 'ready' : 'blocked'),
        duration_min: plan?.durationMinutes ?? '',
        depart_min: plan?.departMinutes ?? '',
        arrive_min: plan?.arriveMinutes ?? '',
        walk_min: plan?.walkMinutes ?? '',
        wait_min: plan?.waitMinutes ?? '',
        ride_min: plan?.rideMinutes ?? '',
        transfers: plan?.transfers ?? '',
        route_sequence: routeSequence(plan),
        schedule_mode: plan?.diagnostics.scheduleMode ?? 'none',
        scanned_departures: plan?.diagnostics.scannedDepartures ?? 0,
        relaxed_stops: plan?.diagnostics.relaxedStops ?? 0,
        walking_network: plan?.diagnostics.walkingNetwork ?? (streetStorePath ? 'sqlite-osm' : 'direct'),
        query_semantics: querySemantics,
        profile_sample_count: result.profileSampleCount,
        query_wall_ms: Number(result.elapsedMs.toFixed(3)),
        engine_query_ms: plan?.diagnostics.searchStats?.engineQueryMs ?? '',
        cache_hit: plan?.diagnostics.searchStats?.cacheHit === true,
        algorithm: plan?.diagnostics.algorithm ?? '',
        method_used: Array.isArray(plan?.diagnostics.methodUsed)
          ? plan.diagnostics.methodUsed.join(' > ')
          : plan?.diagnostics.methodUsed ?? '',
        optimality: plan?.diagnostics.optimality ?? '',
        method_state: plan?.diagnostics.methodState ?? (plan?.status === 'ready' ? 'complete' : 'failed'),
        failure_code: plan?.diagnostics.failureCode ?? '',
        failure_category: plan?.diagnostics.failureCategory ?? '',
        fallback_reason: plan?.diagnostics.fallbackReason ?? '',
        blocked_reason: plan?.status === 'blocked' ? `${plan.title}: ${plan.detail}` : '',
        cache_key: cacheKey,
      })
    }
  } finally {
    stopLookup.close()
  }

  const routingElapsedMs = performance.now() - routingStarted
  const outputStarted = performance.now()
  const engine = engineDescriptor(results.values())
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, `${Papa.unparse(rows, { newline: '\n' })}\n`)
  if (jsonOutPath) {
    fs.mkdirSync(path.dirname(jsonOutPath), { recursive: true })
    fs.writeFileSync(jsonOutPath, `${JSON.stringify({
      schemaVersion: 'vigo.cli.route-results.v1',
      version: packageJson.version,
      engine,
      query: {
        semantics: querySemantics,
        timeMinutes,
        timePreference,
        routingPreference,
        departureWindowMinutes,
        serviceDay,
        serviceDate: serviceDate ?? null,
        maxWalkKm,
      },
      routingStore: {
        path: storePath,
        storeId: metadata.storeId,
        routeCount: metadata.routeCount,
        stopCount: metadata.stopCount,
        tripCount: metadata.tripCount,
        connectionCount: metadata.connectionCount,
      },
      streetStore: streetStorePath ?? null,
      results: fullResults,
    }, null, 2)}\n`)
  }
  const outputElapsedMs = performance.now() - outputStarted
  const ready = rows.filter((row) => row.status === 'ready').length
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 'vigo.cli.route.v2',
    version: packageJson.version,
    engine,
    query: {
      semantics: querySemantics,
      timeMinutes,
      timePreference,
      routingPreference,
      departureWindowMinutes,
      serviceDay,
      serviceDate: serviceDate ?? null,
      maxWalkKm,
    },
    routingStore: {
      path: storePath,
      storeId: metadata.storeId,
      routeCount: metadata.routeCount,
      stopCount: metadata.stopCount,
      tripCount: metadata.tripCount,
      connectionCount: metadata.connectionCount,
    },
    streetStore: streetStorePath ?? null,
    preparation,
    rows: { total: rows.length, ready, blocked: rows.length - ready },
    uniqueRoutingKeys: results.size,
    elapsedMs: Number(routingElapsedMs.toFixed(3)),
    meanMsPerUniqueRoute: results.size ? Number((routingElapsedMs / results.size).toFixed(4)) : 0,
    timing: {
      processToSummaryMs: Number((performance.now() - cliStartedAt).toFixed(3)),
      preparationMs: preparation.elapsedMs,
      routingMs: Number(routingElapsedMs.toFixed(3)),
      outputMs: Number(outputElapsedMs.toFixed(3)),
    },
    output: outPath,
    jsonOutput: jsonOutPath ?? null,
  }, null, 2)}\n`)
}

function ndjsonPoint(
  input: unknown,
  fallbackLabel: string,
  stopLookup: ReturnType<typeof openStopLookup>,
): RoutingPoint {
  if (typeof input === 'string') {
    const point = stopLookup.point(input, fallbackLabel)
    if (!point) throw new Error(`Unknown stop ID: ${input}`)
    return point
  }
  if (!input || typeof input !== 'object') throw new Error(`${fallbackLabel} must be a stop ID or point object`)
  const candidate = input as Record<string, unknown>
  const stopId = typeof candidate.stopId === 'string' ? candidate.stopId.trim() : ''
  const label = typeof candidate.label === 'string' && candidate.label.trim() ? candidate.label.trim() : fallbackLabel
  if (stopId) {
    const point = stopLookup.point(stopId, label)
    if (!point) throw new Error(`Unknown stop ID: ${stopId}`)
    return point
  }
  const coordinate = candidate.coordinate
  if (
    !Array.isArray(coordinate)
    || coordinate.length < 2
    || !Number.isFinite(Number(coordinate[0]))
    || !Number.isFinite(Number(coordinate[1]))
  ) throw new Error(`${fallbackLabel} requires a finite [longitude, latitude] coordinate`)
  return {
    coordinate: [Number(coordinate[0]), Number(coordinate[1])],
    label,
    source: typeof candidate.source === 'string' ? candidate.source : 'map',
  }
}

const ndjsonSerializationMarker = '__VIGO_NDJSON_SERIALIZATION_MS__'

function serializeNdjson(value: unknown) {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
  const timing = record?.timing && typeof record.timing === 'object' && !Array.isArray(record.timing)
    ? record.timing as Record<string, unknown>
    : null
  if (!timing) {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new Error('NDJSON response is not serializable')
    return serialized
  }

  timing.serializationMs = ndjsonSerializationMarker
  const started = performance.now()
  const serialized = JSON.stringify(value)
  const serializationMs = Number((performance.now() - started).toFixed(3))
  timing.serializationMs = serializationMs
  if (serialized === undefined) throw new Error('NDJSON response is not serializable')
  const marker = `\"serializationMs\":${JSON.stringify(ndjsonSerializationMarker)}`
  const markerIndex = serialized.indexOf(marker)
  if (markerIndex < 0) throw new Error('NDJSON serialization timing marker is missing')
  const replacement = `\"serializationMs\":${serializationMs}`
  return `${serialized.slice(0, markerIndex)}${replacement}${serialized.slice(markerIndex + marker.length)}`
}

async function writeNdjson(value: unknown) {
  if (process.stdout.write(`${serializeNdjson(value)}\n`)) return
  await once(process.stdout, 'drain')
}

async function runRouteNdjson(args: CliArguments) {
  const { storePath, streetStorePath } = resolveRuntimePaths(args)
  const defaults = runtimeOptions(args)
  const metadata = readNationalGtfsStoreMetadata(storePath)
  const preparation = await prepareRuntime(storePath, streetStorePath, defaults.serviceDate, defaults.serviceDay)
  const stopLookup = openStopLookup(storePath)
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })
  let sequence = 0
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      sequence += 1
      const requestStarted = performance.now()
      let id = `request_${sequence}`
      try {
        const input = JSON.parse(line) as Record<string, unknown>
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Each line must be a JSON object')
        if (typeof input.id === 'string' && input.id.trim()) id = input.id.trim()
        const origin = ndjsonPoint(input.origin, 'Origin', stopLookup)
        const destination = ndjsonPoint(input.destination, 'Destination', stopLookup)
        requireStreetStoreForCoordinateEndpoints(streetStorePath, origin, destination, `Request ${id}`)
        const timePreference = (input.timePreference ?? defaults.timePreference) as RoutingTimePreference
        if (!['depart', 'arrive'].includes(timePreference)) throw new Error('timePreference must be depart or arrive')
        const routingPreferenceValue = String(
          input.routingPreference ?? defaults.routingPreference,
        )
        if (!['balanced', 'fastest'].includes(routingPreferenceValue)) {
          throw new Error('routingPreference must be balanced or fastest')
        }
        const routingPreference = resolveNationalInteractiveRoutingPreference(
          routingPreferenceValue,
        )
        const timeMinutes = typeof input.time === 'string'
          ? parseClock(input.time)
          : input.timeMinutes === undefined
            ? defaults.timeMinutes
            : parseNumber(String(input.timeMinutes), 'timeMinutes')
        const maxWalkKm = input.maxWalkKm === undefined
          ? defaults.maxWalkKm
          : parseNumber(String(input.maxWalkKm), 'maxWalkKm', 0.01)
        const departureWindowMinutes = input.departureWindowMinutes === undefined
          ? defaults.departureWindowMinutes
          : parseNumber(String(input.departureWindowMinutes), 'departureWindowMinutes')
        if (input.disableCache !== undefined && typeof input.disableCache !== 'boolean') {
          throw new Error('disableCache must be true or false')
        }
        const disableCache = input.disableCache === true
        if (timePreference === 'arrive' && departureWindowMinutes > 0) {
          throw new Error('departureWindowMinutes is only valid for depart searches')
        }
        const routed = routeOne(storePath, {
          origin,
          destination,
          departMinutes: timeMinutes,
          arriveMinutes: timeMinutes,
          timePreference,
          routingPreference,
          serviceDay: defaults.serviceDay,
          serviceDate: defaults.serviceDate,
          allowServiceDateFallback: false,
          maxWalkKm,
          streetStorePath,
          __disableResultCache: disableCache,
        }, departureWindowMinutes)
        const engine = engineDescriptor([routed])
        await writeNdjson({
          schemaVersion: 'vigo.cli.route-result.v1',
          version: packageJson.version,
          sequence,
          id,
          status: 'ok',
          routingStatus: routed.plan?.diagnostics?.routingStatus ?? (routed.plan?.status === 'ready' ? 'ready' : 'blocked'),
          engine,
          timing: {
            requestMs: Number((performance.now() - requestStarted).toFixed(3)),
            routeMs: Number(routed.elapsedMs.toFixed(3)),
            engineQueryMs: routed.plan?.diagnostics.searchStats?.engineQueryMs ?? null,
            preparationMs: sequence === 1 ? preparation.elapsedMs : 0,
          },
          routingStore: {
            storeId: metadata.storeId,
            connectionCount: metadata.connectionCount,
          },
          plan: routed.plan ?? null,
          profileSampleCount: routed.profileSampleCount,
        })
      } catch (error) {
        await writeNdjson({
          schemaVersion: 'vigo.cli.route-result.v1',
          version: packageJson.version,
          sequence,
          id,
          status: 'error',
          routingStatus: 'error',
          timing: { requestMs: Number((performance.now() - requestStarted).toFixed(3)) },
          error: { message: error instanceof Error ? error.message : String(error) },
        })
      }
    }
  } finally {
    stopLookup.close()
  }
}

function readStructuredRequest(args: CliArguments, command: string) {
  const requestValue = value(args, 'request')
  if (!requestValue.trim()) throw new Error(`${command} requires --request`)
  const requestPath = path.resolve(requestValue)
  if (!fs.existsSync(requestPath) || !fs.statSync(requestPath).isFile()) {
    throw new Error(`Request file not found: ${requestPath}`)
  }
  if (fs.statSync(requestPath).size > 16 * 1024 * 1024) {
    throw new Error(`${command} request exceeds the 16 MiB input limit`)
  }
  let request: unknown
  try {
    request = JSON.parse(fs.readFileSync(requestPath, 'utf8'))
  } catch (error) {
    throw new Error(
      `${command} request is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error(`${command} request must be one JSON object`)
  }
  return request as Record<string, unknown>
}

function analyticalPoint(
  value: unknown,
  label: string,
  stopLookup: ReturnType<typeof openStopLookup>,
) {
  return ndjsonPoint(value, label, stopLookup)
}

function oneToManyDestinations(
  input: unknown,
  stopLookup: ReturnType<typeof openStopLookup>,
) {
  if (!Array.isArray(input) || !input.length) {
    throw new Error('one-to-many requires a non-empty destinations array')
  }
  if (input.length > 256) {
    throw new Error('one-to-many is limited to 256 destinations per request')
  }
  const destinations = input.map((candidate, index) => {
    const descriptor = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      ? candidate as Record<string, unknown>
      : null
    const pointInput = descriptor && Object.hasOwn(descriptor, 'point')
      ? descriptor.point
      : candidate
    const id = String(
      descriptor?.id
      ?? (typeof pointInput === 'string' ? pointInput : `destination_${index + 1}`),
    ).trim()
    if (!id) throw new Error(`Destination ${index + 1} has an empty id`)
    return {
      id,
      point: analyticalPoint(pointInput, `Destination ${id}`, stopLookup),
    }
  })
  if (new Set(destinations.map((destination) => destination.id)).size !== destinations.length) {
    throw new Error('one-to-many destination ids must be unique')
  }
  return destinations
}

function boundedAnalyticalNumber(
  args: CliArguments,
  request: Record<string, unknown>,
  option: string,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const candidate = args.has(option) ? value(args, option) : request[field] ?? fallback
  const parsed = Number(candidate)
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Invalid --${option} value: ${String(candidate)}`)
  }
  return parsed
}

function analyticalRuntimeOptions(args: CliArguments, command: string) {
  const options = runtimeOptions(args)
  if (options.timePreference !== 'depart') {
    throw new Error(`${command} supports fixed-departure routing only`)
  }
  if (options.departureWindowMinutes !== 0) {
    throw new Error(`${command} does not support --departure-window`)
  }
  return options
}

async function runOneToMany(args: CliArguments) {
  const { storePath, streetStorePath } = resolveRuntimePaths(args)
  const request = readStructuredRequest(args, 'one-to-many')
  const options = analyticalRuntimeOptions(args, 'one-to-many')
  const matrixStrategy = String(
    args.has('matrix-strategy')
      ? value(args, 'matrix-strategy')
      : request.matrixStrategy ?? 'shared',
  )
  if (!['shared', 'pairwise', 'auto'].includes(matrixStrategy)) {
    throw new Error('--matrix-strategy must be shared, pairwise, or auto')
  }
  const horizonMinutes = boundedAnalyticalNumber(
    args,
    request,
    'horizon',
    'horizonMinutes',
    480,
    1,
    2_880,
  )
  const stopLookup = openStopLookup(storePath)
  let origin: RoutingPoint
  let destinations: ReturnType<typeof oneToManyDestinations>
  try {
    origin = analyticalPoint(request.origin, 'Origin', stopLookup)
    destinations = oneToManyDestinations(request.destinations, stopLookup)
  } finally {
    stopLookup.close()
  }
  if (
    !streetStorePath
    && (!origin.stopId || destinations.some((destination) => !destination.point.stopId))
  ) {
    throw new Error(
      'one-to-many coordinate endpoints require --street-store; only all-exact-stop requests may omit it',
    )
  }

  const preparation = await prepareRuntime(
    storePath,
    streetStorePath,
    options.serviceDate,
    options.serviceDay,
  )
  const queryStarted = performance.now()
  const matrix = routeNationalGtfsMatrix(storePath, {
    origins: [origin],
    destinations: destinations.map((destination) => destination.point),
    departMinutes: options.timeMinutes,
    timePreference: 'depart',
    routingPreference: options.routingPreference,
    serviceDay: options.serviceDay,
    serviceDate: options.serviceDate,
    allowServiceDateFallback: false,
    maxWalkKm: options.maxWalkKm,
    horizonMinutes,
    matrixStrategy,
    streetStorePath,
  })
  const queryWallMs = performance.now() - queryStarted
  const rows = matrix.rows.map((row: Record<string, unknown>) => ({
    ...row,
    destinationId: destinations[Number(row.destinationIndex)]?.id ?? null,
  }))
  const payload = {
    schemaVersion: 'vigo.cli.one-to-many.v1',
    version: packageJson.version,
    engine: {
      name: 'VIGO',
      operator: 'one-to-many',
      owner: 'rust-resident-timetable-kernel',
      algorithm: matrix.diagnostics?.matrixEngine
        ?? (matrix.diagnostics?.matrixStrategy === 'not_run'
          ? 'no_route_executed'
          : 'rust_exact_connection_scan_one_to_many'),
      storage: 'sqlite-persisted-resident-compiled',
      persistentStore: 'sqlite',
      queryExecutor: 'resident-active-service-kernel',
      sqlRouteExecutor: false,
    },
    query: {
      origin,
      destinations,
      timeMinutes: options.timeMinutes,
      serviceDate: options.serviceDate,
      serviceDay: options.serviceDay,
      maxWalkKm: options.maxWalkKm,
      horizonMinutes,
      matrixStrategy,
    },
    rows,
    diagnostics: matrix.diagnostics,
    preparation,
    timing: {
      preparationMs: preparation.elapsedMs,
      queryMs: Number(queryWallMs.toFixed(3)),
      engineQueryMs: matrix.diagnostics?.engineQueryMs ?? null,
      processToResultMs: Number((performance.now() - cliStartedAt).toFixed(3)),
    },
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
}

function isochroneCutoffs(args: CliArguments, request: Record<string, unknown>) {
  const source: unknown[] = args.has('cutoffs')
    ? value(args, 'cutoffs').split(',')
    : Array.isArray(request.cutoffsMinutes)
      ? request.cutoffsMinutes
      : [15, 30, 45, 60]
  const cutoffs = [...new Set(source.map(Number))].sort((left, right) => left - right)
  if (
    !cutoffs.length
    || cutoffs.some((cutoff) => !Number.isFinite(cutoff) || cutoff < 5 || cutoff > 240)
  ) {
    throw new Error('Isochrone cutoffs must be finite minutes between 5 and 240')
  }
  return cutoffs
}

async function runIsochrone(args: CliArguments) {
  const { storePath, streetStorePath } = resolveRuntimePaths(args)
  if (!streetStorePath) throw new Error('isochrone requires --street-store')
  const request = readStructuredRequest(args, 'isochrone')
  const options = analyticalRuntimeOptions(args, 'isochrone')
  const cutoffsMinutes = isochroneCutoffs(args, request)
  const radiusKm = boundedAnalyticalNumber(args, request, 'radius', 'radiusKm', 8, 1, 40)
  const rasterSize = boundedAnalyticalNumber(
    args,
    request,
    'raster-size',
    'rasterSize',
    96,
    48,
    1024,
  )
  if (![48, 64, 96, 128, 192, 256, 384, 512, 1024].includes(rasterSize)) {
    throw new Error('--raster-size must be 48, 64, 96, 128, 192, 256, 384, 512, or 1024')
  }
  const walkSpeedKph = boundedAnalyticalNumber(
    args,
    request,
    'walk-speed',
    'walkSpeedKph',
    4.8,
    1,
    8,
  )
  const excludedRouteIds = Array.isArray(request.excludedRouteIds)
    ? [...new Set(request.excludedRouteIds.map((routeId) => String(routeId).trim()).filter(Boolean))]
    : []
  if (excludedRouteIds.length > 512) {
    throw new Error('isochrone is limited to 512 excluded route ids')
  }
  const stopLookup = openStopLookup(storePath)
  let origin: RoutingPoint
  try {
    origin = analyticalPoint(request.origin, 'Origin', stopLookup)
  } finally {
    stopLookup.close()
  }
  const bounds = rasterBounds(origin, radiusKm)
  const preparation = await prepareRuntime(
    storePath,
    streetStorePath,
    options.serviceDate,
    options.serviceDay,
  )
  const queryStarted = performance.now()
  const range = routeNationalGtfsAccessibilityRange(storePath, {
    origin,
    departMinutes: options.timeMinutes,
    serviceDate: options.serviceDate,
    serviceDay: options.serviceDay,
    maxWalkKm: options.maxWalkKm,
    walkSpeedKph,
    radiusKm,
    cutoffMinutes: cutoffsMinutes.at(-1),
    excludedRouteIds,
    ...(request.scenarioOverlay ? { scenarioOverlay: request.scenarioOverlay } : {}),
    surface: {
      bounds,
      width: rasterSize,
      height: rasterSize,
    },
  }, { streetStorePath })
  const queryWallMs = performance.now() - queryStarted
  if (
    !range.surface
    || range.surface.schemaVersion !== 'vigo.street.network-raster.v1'
    || !range.surface.values
    || range.surface.values.length !== rasterSize ** 2
  ) {
    throw new Error('Rust Accessibility returned an invalid isochrone surface')
  }
  const contourStarted = performance.now()
  const isochrones = rasterContours(
    range.surface.values,
    rasterSize,
    rasterSize,
    bounds,
    cutoffsMinutes,
    'isochrone',
  )
  const contourMs = performance.now() - contourStarted
  const payload = {
    schemaVersion: 'vigo.cli.isochrone.v1',
    version: packageJson.version,
    engine: {
      name: 'VIGO',
      operator: 'isochrone',
      owner: 'rust-resident-accessibility-pipeline',
      algorithm: range.diagnostics?.algorithm
        ?? 'rust_resident_generation_tagged_connection_scan_one_to_many',
      surfaceKernel: range.diagnostics?.surface?.kernel ?? 'rust_mmap_street_surface_v1',
      storage: 'sqlite-persisted-resident-compiled',
      persistentStore: 'sqlite',
      queryExecutor: 'resident-active-service-kernel',
      sqlRouteExecutor: false,
    },
    query: {
      origin,
      timeMinutes: options.timeMinutes,
      serviceDate: options.serviceDate,
      serviceDay: options.serviceDay,
      maxWalkKm: options.maxWalkKm,
      walkSpeedKph,
      radiusKm,
      rasterSize,
      cutoffsMinutes,
      excludedRouteIds,
    },
    stops: range.stops,
    scenarioStops: range.scenarioStops,
    surface: {
      ...range.surface,
      values: Array.from(range.surface.values),
    },
    isochrones,
    diagnostics: range.diagnostics,
    preparation,
    timing: {
      preparationMs: preparation.elapsedMs,
      queryMs: Number(queryWallMs.toFixed(3)),
      timetableQueryMs: range.diagnostics?.search?.nativeQueryMs ?? null,
      surfaceQueryMs: range.diagnostics?.surface?.nativeQueryMs ?? null,
      contourMs: Number(contourMs.toFixed(3)),
      processToResultMs: Number((performance.now() - cliStartedAt).toFixed(3)),
    },
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

function requiredRawInput(input: string, label: string, pattern: RegExp) {
  if (!input.trim()) throw new Error(`build-network requires ${label}`)
  const filePath = path.resolve(input)
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label} file not found: ${filePath}`)
  }
  if (!pattern.test(filePath)) throw new Error(`${label} has an unsupported file name: ${filePath}`)
  return filePath
}

function defaultGtfsScope(filePath: string, index: number) {
  const base = path.basename(filePath).replace(/(?:\.gtfs)?\.zip$/iu, '')
  return base.replace(/[^a-z0-9._-]+/giu, '-').replace(/^-+|-+$/gu, '') || `feed-${index + 1}`
}

function buildProgress(scope: string) {
  let previousPhase = ''
  return (event: Record<string, unknown>) => {
    const phase = String(event.phase ?? 'Building')
    if (phase === previousPhase && Number(event.progress ?? 0) < 1) return
    previousPhase = phase
    const detail = String(event.detail ?? '').trim()
    process.stderr.write(`[${scope}] ${phase}${detail ? `: ${detail}` : ''}\n`)
  }
}

function rawCompilerConcurrency(gtfsBytes: number, osmBytes: number) {
  const estimatedPeakWorkingBytes = rawCompilerFixedWorkingSetBytes
    + osmBytes * rawOsmWorkingSetMultiplier
    + gtfsBytes * rawGtfsWorkingSetMultiplier
  const hostMemoryGuardBytes = os.totalmem() * 0.55
  const freeMemoryGuardBytes = Math.min(
    estimatedPeakWorkingBytes * 0.75,
    os.totalmem() * 0.02,
  )
  const freeMemoryAtBuildStartBytes = os.freemem()
  const loadAverageAtBuildStart = os.loadavg()
  const loadAverageGuard = Math.max(1, os.cpus().length * 2)
  const loadAverageGuardPassed = loadAverageAtBuildStart[1] <= loadAverageGuard
  return {
    enabled: os.cpus().length >= 4
      && os.totalmem() >= 8 * 1024 * 1024 * 1024
      && estimatedPeakWorkingBytes <= hostMemoryGuardBytes
      && freeMemoryAtBuildStartBytes >= freeMemoryGuardBytes
      && loadAverageGuardPassed,
    estimatedPeakWorkingBytes,
    hostMemoryGuardBytes,
    freeMemoryAtBuildStartBytes,
    freeMemoryGuardBytes,
    loadAverageAtBuildStart,
    loadAverageGuard,
    loadAverageGuardPassed,
  }
}

function startJsonCompiler(command: string, compilerArguments: string[], label: string) {
  const startedAt = performance.now()
  const cliPath = path.resolve(process.argv[1])
  const child = spawn(process.execPath, [
    cliPath,
    command,
    ...compilerArguments,
  ], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let stdout = ''
  let settled = false
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
    if (stdout.length > 16 * 1024 * 1024) child.kill()
  })
  const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
    child.once('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      if (code !== 0) {
        reject(new Error(`${label} exited with ${signal ?? code}.`))
        return
      }
      try {
        resolve(JSON.parse(stdout) as Record<string, unknown>)
      } catch (error) {
        reject(new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
  })
  return {
    child,
    startedAt,
    outcome: promise.then((result) => ({ result }), (error) => ({ error })),
  }
}

function startOsmCompiler(osmPbf: string, outputPath: string) {
  return startJsonCompiler(
    '_build-osm-store',
    [`--osm-pbf=${osmPbf}`, `--output-store=${outputPath}`],
    'OSM compiler',
  )
}

function startOsmDriveCompiler(storePath: string) {
  return startJsonCompiler(
    '_prepare-osm-drive',
    [`--street-store=${storePath}`],
    'OSM drive compiler',
  )
}

async function runOsmCompiler(args: CliArguments) {
  const osmPbf = requiredRawInput(value(args, 'osm-pbf'), 'OSM PBF', /(?:\.osm)?\.pbf$/iu)
  const outputPath = path.resolve(value(args, 'output-store'))
  if (!value(args, 'output-store')) throw new Error('_build-osm-store requires --output-store')
  const result = await buildNationalOsmStore({
    pbfPath: osmPbf,
    outputPath,
    onProgress: buildProgress('osm'),
  })
  process.stdout.write(JSON.stringify(result))
}

async function runOsmDriveCompiler(args: CliArguments) {
  const storePath = path.resolve(value(args, 'street-store'))
  if (!value(args, 'street-store')) throw new Error('_prepare-osm-drive requires --street-store')
  const result = buildNationalOsmDriveStore(storePath, {
    persist: true,
    prepareNative: false,
    ensureIndexes: false,
  })
  process.stdout.write(JSON.stringify(result))
}

async function runBuildNetwork(args: CliArguments) {
  const gtfsValues = values(args, 'gtfs')
  const scopeValues = values(args, 'gtfs-scope')
  if (!gtfsValues.length) throw new Error('build-network requires at least one --gtfs GTFS ZIP')
  if (scopeValues.length && scopeValues.length !== gtfsValues.length) {
    throw new Error('repeat --gtfs-scope once for every --gtfs input, or omit it')
  }
  const gtfs = gtfsValues.map((input, index) => ({
    path: requiredRawInput(input, `GTFS ZIP ${index + 1}`, /\.zip$/iu),
    scope: String(scopeValues[index] ?? defaultGtfsScope(input, index)).trim(),
  }))
  if (gtfs.some((feed) => !feed.scope)) throw new Error('GTFS scopes must be non-empty')
  if (new Set(gtfs.map((feed) => feed.scope)).size !== gtfs.length) {
    throw new Error('GTFS scopes must be unique; pass one --gtfs-scope for each feed')
  }
  const osmPbf = requiredRawInput(value(args, 'osm-pbf'), 'OSM PBF', /(?:\.osm)?\.pbf$/iu)
  const outputValue = value(args, 'output-dir')
  if (!outputValue.trim()) throw new Error('build-network requires --output-dir')
  const outputDirectory = path.resolve(outputValue)
  if (outputDirectory === path.parse(outputDirectory).root) {
    throw new Error('build-network output directory cannot be a filesystem root')
  }
  const gtfsInputBytes = gtfs.reduce((sum, feed) => sum + fs.statSync(feed.path).size, 0)
  const osmInputBytes = fs.statSync(osmPbf).size
  const rawConcurrency = rawCompilerConcurrency(gtfsInputBytes, osmInputBytes)
  const parallelRawBuild = rawConcurrency.enabled && !enabled(args, 'sequential-raw-build')

  const routingDirectory = path.join(outputDirectory, 'routing')
  const osmDirectory = path.join(outputDirectory, 'osm')
  const manifestPath = path.join(outputDirectory, 'network.json')
  const existing = [routingDirectory, osmDirectory, manifestPath].filter((target) => fs.existsSync(target))
  if (existing.length && !enabled(args, 'force')) {
    throw new Error(`compiled network already exists; pass --force to replace it: ${outputDirectory}`)
  }

  // Windows cannot rename a directory containing live mmap handles. Build
  // directly into the final component directories there and publish the
  // network manifest last; other platforms retain directory-rename publish.
  const directWindowsPublication = process.platform === 'win32'
  fs.mkdirSync(outputDirectory, { recursive: true })
  const stagingDirectory = path.join(outputDirectory, `.vigo-router-building-${process.pid}-${Date.now()}`)
  const stagingRouting = directWindowsPublication ? routingDirectory : path.join(stagingDirectory, 'routing')
  const stagingOsm = directWindowsPublication ? osmDirectory : path.join(stagingDirectory, 'osm')
  const componentDirectory = path.join(stagingDirectory, 'components')
  if (directWindowsPublication && existing.length) {
    fs.rmSync(routingDirectory, { recursive: true, force: true })
    fs.rmSync(osmDirectory, { recursive: true, force: true })
    fs.rmSync(manifestPath, { force: true })
  }
  fs.mkdirSync(stagingRouting, { recursive: true })
  fs.mkdirSync(stagingOsm, { recursive: true })

  const started = performance.now()
  let gtfsBuildMs = 0
  let gtfsMergeMs = 0
  let osmBuildMs = 0
  let streetCchBuildMs = 0
  let stopTransferBuildMs = 0
  let coordinateAccessBuildMs = 0
  let osmRuntimeCompactionMs = 0
  let gtfsRuntimeCompactionMs = 0
  let osmCompiler: ReturnType<typeof startOsmCompiler> | null = null
  let osmDriveCompiler: ReturnType<typeof startOsmDriveCompiler> | null = null
  let osmDrivePreparation: Record<string, unknown> | null = null
  const componentResults: Array<{ scope: string; path: string; result: Record<string, unknown> }> = []
  try {
    const stagedStreetStore = path.join(stagingOsm, 'street-index.sqlite')
    if (parallelRawBuild) osmCompiler = startOsmCompiler(osmPbf, stagedStreetStore)
    for (let index = 0; index < gtfs.length; index += 1) {
      const feed = gtfs[index]
      const storePath = gtfs.length === 1
        ? path.join(stagingRouting, 'project.sqlite')
        : path.join(componentDirectory, `${String(index + 1).padStart(2, '0')}-${feed.scope}.sqlite`)
      const phaseStarted = performance.now()
      const result = await buildNationalGtfsStore({
        zipPath: feed.path,
        outputPath: storePath,
        onProgress: buildProgress(`gtfs:${feed.scope}`),
      }) as Record<string, unknown>
      gtfsBuildMs += performance.now() - phaseStarted
      componentResults.push({ scope: feed.scope, path: storePath, result })
    }

    const stagedRoutingStore = path.join(stagingRouting, 'project.sqlite')
    if (componentResults.length > 1) {
      const mergeStarted = performance.now()
      await mergeNationalGtfsStores({
        stores: componentResults.map((component) => ({
          scope: component.scope,
          storePath: component.path,
        })),
        outputPath: stagedRoutingStore,
        onProgress: buildProgress('gtfs:merge'),
        removeSourcesAfterMerge: true,
      })
      gtfsMergeMs = performance.now() - mergeStarted
    }

    let streetResult: Record<string, unknown>
    if (osmCompiler) {
      const outcome = await osmCompiler.outcome
      if (outcome.error) throw outcome.error
      streetResult = outcome.result
      osmBuildMs = performance.now() - osmCompiler.startedAt
    } else {
      const osmStarted = performance.now()
      streetResult = await buildNationalOsmStore({
        pbfPath: osmPbf,
        outputPath: stagedStreetStore,
        onProgress: buildProgress('osm'),
      }) as Record<string, unknown>
      osmBuildMs = performance.now() - osmStarted
    }

    if (Number(streetResult.driveEdgeCount ?? 0) > 0) {
      // Build the driving snapshot in a separate resident process while the
      // GTFS compilation is still in progress. The source graph is sealed only
      // after this compiler finishes so no builder can race the compactor.
      osmDriveCompiler = startOsmDriveCompiler(stagedStreetStore)
    }

    if (osmDriveCompiler) {
      const outcome = await osmDriveCompiler.outcome
      if (outcome.error) throw outcome.error
      osmDrivePreparation = outcome.result
    }

    // Publish one runtime representation for every network size before any
    // native routing preparation. The raw SQLite graph is compiler-only.
    const osmRuntimeCompactionStarted = performance.now()
    const osmRuntimeCompaction = compactNationalOsmRuntimeStore(stagedStreetStore, { requireDrive: true })
    osmRuntimeCompactionMs = performance.now() - osmRuntimeCompactionStarted

    const nativeStreet = prepareNationalOsmNativeStore(stagedStreetStore, { requireCurrentSchema: true })
    if (!nativeStreet.ready) {
      throw new Error(`Native street snapshot preparation failed: ${nativeStreet.error ?? nativeStreet.reason}`)
    }
    const streetCchStarted = performance.now()
    const streetCch = buildNativeStreetCchIndex(stagedStreetStore)
    streetCchBuildMs = performance.now() - streetCchStarted
    const stopTransferStarted = performance.now()
    const stopTransfers = await ensureNationalGtfsOsmStopTransfers(
      stagedRoutingStore,
      stagedStreetStore,
      { onProgress: buildProgress('transfers') },
    )
    stopTransferBuildMs = performance.now() - stopTransferStarted
    const coordinateAccessStarted = performance.now()
    const coordinateAccess = prepareNationalGtfsNativeCoordinateAccess(
      stagedRoutingStore,
      stagedStreetStore,
    )
    coordinateAccessBuildMs = performance.now() - coordinateAccessStarted
    if (!coordinateAccess.ready) throw new Error('Native coordinate access preparation failed.')

    const gtfsRuntimeCompactionStarted = performance.now()
    const gtfsRuntimeCompaction = compactNationalGtfsRuntimeStore(stagedRoutingStore)
    gtfsRuntimeCompactionMs = performance.now() - gtfsRuntimeCompactionStarted

    // Windows will not rename a directory while SQLite handles or mmap-backed
    // native kernels still reference files inside it. The build has completed,
    // so release those cached readers before publishing the staged directories.
    disposeNationalGtfsStore(stagedRoutingStore)
    disposeNationalOsmStore(stagedStreetStore)

    if (!directWindowsPublication) {
      if (existing.length) {
        fs.rmSync(routingDirectory, { recursive: true, force: true })
        fs.rmSync(osmDirectory, { recursive: true, force: true })
        fs.rmSync(manifestPath, { force: true })
      }
      fs.renameSync(stagingRouting, routingDirectory)
      fs.renameSync(stagingOsm, osmDirectory)
    }

    const routingStorePath = path.join(routingDirectory, 'project.sqlite')
    const streetStorePath = path.join(osmDirectory, 'street-index.sqlite')
    const routingMetadata = readNationalGtfsStoreMetadata(routingStorePath)
    const summary = {
      schemaVersion: 'vigo.cli.build-network.v1',
      version: packageJson.version,
      reused: false,
      inputs: {
        gtfs: gtfs.map((feed, index) => ({
          path: feed.path,
          scope: feed.scope,
          sourceFingerprint: componentResults[index].result.sourceFingerprint ?? null,
        })),
        osmPbf: {
          path: osmPbf,
          sourceFingerprint: streetResult.sourceFingerprint ?? null,
        },
      },
      outputDirectory,
      routingStore: {
        path: routingStorePath,
        storeId: routingMetadata.storeId,
        sourceFingerprint: routingMetadata.sourceFingerprint,
        routeCount: routingMetadata.routeCount,
        stopCount: routingMetadata.stopCount,
        tripCount: routingMetadata.tripCount,
        connectionCount: routingMetadata.connectionCount,
        departureIndexState: routingMetadata.departureIndexState ?? gtfsRuntimeCompaction.state,
        runtimeCompaction: {
          state: gtfsRuntimeCompaction.state,
          bytesSaved: gtfsRuntimeCompaction.bytesSaved,
        },
        stopTransfers: {
          edgeCount: stopTransfers.edgeCount,
          candidateEdgeCount: stopTransfers.candidateEdgeCount,
          fingerprint: stopTransfers.fingerprint,
        },
        nativeCoordinateAccess: {
          profileKey: coordinateAccess.profileKey,
          mode: 'exact-local-graph-frontier',
          persistenceState: coordinateAccess.persistenceState,
          snapshotBytes: coordinateAccess.snapshotBytes,
          prepareMs: coordinateAccess.prepareMs,
        },
      },
      streetStore: {
        path: streetStorePath,
        sourceFingerprint: streetResult.sourceFingerprint ?? null,
        nodeCount: streetResult.nodeCount ?? null,
        walkNodeCount: streetResult.walkNodeCount ?? null,
        edgeCount: streetResult.edgeCount ?? null,
        driveNodeCount: streetResult.driveNodeCount ?? null,
        driveEdgeCount: streetResult.driveEdgeCount ?? null,
        bytes: osmRuntimeCompaction.afterBytes,
        storageLayout: osmRuntimeCompaction.storageLayout,
        runtimeCompaction: {
          storageLayout: osmRuntimeCompaction.storageLayout,
          bytesSaved: osmRuntimeCompaction.bytesSaved,
          driveSnapshot: osmRuntimeCompaction.drive?.snapshotPath
            ? path.basename(osmRuntimeCompaction.drive.snapshotPath)
            : null,
        },
        walkAccelerator: streetResult.walkAccelerator ?? null,
        driveAccelerator: osmDrivePreparation
          ? {
              ready: osmDrivePreparation.ready,
              source: osmDrivePreparation.source ?? null,
              buildMs: osmDrivePreparation.buildMs ?? 0,
              snapshotWriteMs: osmDrivePreparation.snapshotWriteMs ?? 0,
              snapshotStatus: osmDrivePreparation.snapshotStatus ?? null,
              reason: osmDrivePreparation.reason ?? null,
              error: osmDrivePreparation.error ?? null,
            }
          : streetResult.driveAccelerator ?? null,
        streetCch: {
          ready: Number(streetCch.loaded?.cchArcCount ?? streetCch.cchArcCount ?? 0) > 0,
          format: streetCch.format,
          orderStrategy: streetCch.orderStrategy ?? 'inertial',
          nodeCount: streetCch.nodeCount,
          edgeCount: streetCch.edgeCount,
          cchArcCount: streetCch.cchArcCount,
          structureFile: path.basename(streetCch.structurePath),
          metricFile: path.basename(streetCch.metricPath),
        },
      },
      timing: {
        totalMs: Number((performance.now() - started).toFixed(3)),
        gtfsBuildMs: Number(gtfsBuildMs.toFixed(3)),
        gtfsMergeMs: Number(gtfsMergeMs.toFixed(3)),
        osmBuildMs: Number(osmBuildMs.toFixed(3)),
        streetCchBuildMs: Number(streetCchBuildMs.toFixed(3)),
        stopTransferBuildMs: Number(stopTransferBuildMs.toFixed(3)),
        coordinateAccessBuildMs: Number(coordinateAccessBuildMs.toFixed(3)),
        osmRuntimeCompactionMs: Number(osmRuntimeCompactionMs.toFixed(3)),
        gtfsRuntimeCompactionMs: Number(gtfsRuntimeCompactionMs.toFixed(3)),
        osmDrivePreparationMs: Number(osmDrivePreparation?.prepareMs ?? 0),
        rawCompilerConcurrency: {
          gtfsAndOsmParallel: parallelRawBuild,
          estimatedPeakWorkingBytes: rawConcurrency.estimatedPeakWorkingBytes,
          hostMemoryGuardBytes: rawConcurrency.hostMemoryGuardBytes,
          freeMemoryAtBuildStartBytes: rawConcurrency.freeMemoryAtBuildStartBytes,
          freeMemoryGuardBytes: rawConcurrency.freeMemoryGuardBytes,
          loadAverageAtBuildStart: rawConcurrency.loadAverageAtBuildStart,
          loadAverageGuard: rawConcurrency.loadAverageGuard,
          loadAverageGuardPassed: rawConcurrency.loadAverageGuardPassed,
        },
      },
    }
    fs.writeFileSync(manifestPath, `${JSON.stringify(summary, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  } finally {
    if (osmCompiler?.child.exitCode === null) {
      osmCompiler.child.kill()
      await osmCompiler.outcome
    }
    if (osmDriveCompiler?.child.exitCode === null) {
      osmDriveCompiler.child.kill()
      await osmDriveCompiler.outcome
    }
    fs.rmSync(stagingDirectory, { recursive: true, force: true })
  }
}

async function runPrepare(args: CliArguments) {
  const { storePath, streetStorePath } = resolveRuntimePaths(args)
  if (!streetStorePath) throw new Error('prepare requires --street-store')
  const { serviceDate, serviceDay } = runtimeOptions(args)
  const preparation = await prepareRuntime(storePath, streetStorePath, serviceDate, serviceDay)
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 'vigo.cli.prepare.v1',
    version: packageJson.version,
    routingStore: storePath,
    streetStore: streetStorePath,
    serviceDate,
    serviceDay,
    preparation,
    processElapsedMs: Number((performance.now() - cliStartedAt).toFixed(3)),
  }, null, 2)}\n`)
}

const { command, args } = parseArguments(process.argv.slice(2))
if (args.has('version')) {
  process.stdout.write(`${packageJson.version}\n`)
} else if (args.has('help')) {
  process.stdout.write(usage())
} else if (![
  '_build-osm-store',
  '_prepare-osm-drive',
  'build-network',
  'isochrone',
  'one-to-many',
  'prepare',
  'route',
  'route-ndjson',
].includes(command)) {
  process.stderr.write(`Unknown command: ${command}\n\n${usage()}`)
  process.exitCode = 2
} else {
  try {
    if (command === '_build-osm-store') await runOsmCompiler(args)
    else if (command === '_prepare-osm-drive') await runOsmDriveCompiler(args)
    else if (command === 'build-network') await runBuildNetwork(args)
    else if (command === 'isochrone') await runIsochrone(args)
    else if (command === 'one-to-many') await runOneToMany(args)
    else if (command === 'prepare') await runPrepare(args)
    else if (command === 'route-ndjson') await runRouteNdjson(args)
    else await runRoute(args)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`VIGO ${command} failed: ${message}\n\n${usage()}`)
    process.exitCode = 2
  }
}
