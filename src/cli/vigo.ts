import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import Papa from 'papaparse'
import packageJson from '../../package.json'
import { CliUsageError, parseArguments, validateInvocation, value, values, enabled } from './arguments.mjs'
import { commands, usage } from './commands.mjs'
import { handleOutputErrors, readJsonObject, writeJsonResult, writeOutputFile } from './io.mjs'
import { assertMatrixSize } from '../server/matrix-size.mjs'
import { normalizeRoutingDataRequest, normalizeScheduledAnalysisRequest } from '../server/routing-data-mode.mjs'
import {
  apiVersion,
  cityFormatVersion,
  resultSchemaVersion,
  vigoCapabilities,
} from '../capabilities.mjs'
import {
  createCityStagingDirectory,
  publishCity,
  validateCityDirectory,
} from '../city.mjs'
import {
  buildNationalGtfsCityStore,
  compactNationalGtfsRuntimeStore,
  disposeNationalGtfsStore,
  ensureNationalGtfsOsmStopTransfers,
  inspectNationalStaticTopologySidecar,
  nationalGtfsRuntimeView,
  prepareNationalGtfsRoutingContext,
  prepareNationalGtfsNativeCoordinateAccess,
  prepareNationalGtfsStore,
  readNationalGtfsStoreMetadata,
  routeNationalGtfsReach,
  routeNationalGtfsDepartureWindow,
  addNationalGtfsFares,
  routeNationalGtfsMatrix,
  routeNationalGtfsStore,
} from '../server/national-gtfs-store.mjs'
import {
  buildNationalOsmDriveStore,
  buildNationalOsmStore,
  compactNationalOsmRuntimeStore,
  disposeNationalOsmStore,
  prepareNationalOsmNativeStore,
  routeNationalStreetMatrix,
  routeNationalStreetStore,
} from '../server/national-osm-store.mjs'
import { buildNativeStreetCchIndex } from '../server/native-routing-kernel.mjs'
import { buildTerminalAccessStore } from '../server/terminal-access-store.mjs'
import { timingMilliseconds } from '../server/number-utils.mjs'
import {
  composeOrderedRoutingPlans,
  routeOrderedRoutingSegments,
  validateOrderedRoutingPoints,
} from '../server/ordered-route-composition.mjs'
import { compileReachScenario, rasterBounds, rasterContours } from '../server/reach.mjs'
import { hydrateScenarioRouteServices } from '../server/scenario-services.mjs'
import { resolveServiceDay } from '../server/service-day.mjs'
import type { ServiceDay } from '../domain'
import type { RoutingExecutionStatus, RoutingPlan, RoutingPoint, RoutingTimePreference } from '../routingModel'

type CliArguments = Map<string, string[]>
type RouteResult = { plan: RoutingPlan | undefined; choices?: RoutingPlan[]; profileSampleCount: number; elapsedMs: number }

const cliStartedAt = performance.now()
const rawOsmWorkingSetMultiplier = 80
const rawGtfsWorkingSetMultiplier = 20
const rawCompilerFixedWorkingSetBytes = 256 * 1024 * 1024
const publicResultMetadata = Object.freeze({
  productVersion: packageJson.version,
  apiVersion,
  resultSchemaVersion,
})

function cityRevisionId(builtAt: string) {
  return builtAt.replace(/[-:]/gu, '').replace(/\.(\d{3})Z$/u, '-$1Z')
}
function parseClock(input: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(input.trim())
  if (!match) throw new Error(`Invalid --time value: ${input}`)
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (minutes > 59 || hours > 29) throw new Error(`Invalid --time value: ${input}`)
  return hours * 60 + minutes
}

function parseNumber(input: string, label: string, minimum = 0, maximum = Number.POSITIVE_INFINITY) {
  const parsed = Number(input)
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) throw new Error(`Invalid --${label} value: ${input}`)
  return parsed
}

function parseIntegerNumber(input: string, label: string, minimum = 0, maximum = Number.POSITIVE_INFINITY) {
  const parsed = Number(input)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    const range = Number.isFinite(maximum) ? ` in [${minimum}, ${maximum}]` : ` >= ${minimum}`
    throw new Error(`Invalid --${label} value: ${input}; expected an integral number${range}`)
  }
  return parsed
}

function parseTimeMinutes(input: string, label = 'timeMinutes') {
  const parsed = Number(input)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0 || parsed >= 30 * 60) {
    throw new Error(`Invalid --${label} value: ${input}; expected an integral minute in [0, 1800)`)
  }
  return parsed
}

function parseNdjsonTime(input: unknown, label: string) {
  if (typeof input === 'string') return parseClock(input)
  if (typeof input === 'number') return parseTimeMinutes(String(input), label)
  throw new Error(`Invalid ${label} value: ${String(input)}; expected HH:MM or an integral minute`)
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
  const view = nationalGtfsRuntimeView(storePath)
  const routingStore = {
    storeId: view.metadata.storeId,
    connectionCount: view.metadata.connectionCount,
  }
  type StopRow = { stop_id: string; name: string; lon: number; lat: number }
  return {
    metadata: view.metadata,
    routingStore,
    point(stopId: string, label?: string): RoutingPoint | null {
      const row = view.stop(stopId) as StopRow | null
      if (!row || !Number.isFinite(row.lon) || !Number.isFinite(row.lat)) return null
      return { stopId: row.stop_id, coordinate: [row.lon, row.lat], label: label || row.name || row.stop_id, source: 'stop' }
    },
  }
}

function coordinatePoint(longitude: unknown, latitude: unknown, label: string): RoutingPoint | null {
  const coordinateNumber = (value: unknown) => {
    if (
      value === null
      || value === undefined
      || typeof value === 'boolean'
      || (typeof value === 'string' && value.trim() === '')
    ) return null
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }
  const lon = coordinateNumber(longitude)
  const lat = coordinateNumber(latitude)
  if (
    lon === null
    || lat === null
    || lon < -180
    || lon > 180
    || lat < -90
    || lat > 90
  ) return null
  return { coordinate: [lon, lat], label, source: 'map' }
}

function buildPoint(
  row: Record<string, string>,
  prefix: 'origin' | 'destination',
  stopLookup: ReturnType<typeof openStopLookup>,
): RoutingPoint | null {
  const stopId = String(row[`${prefix}_stop_id`] || row[`${prefix}StopId`] || '').trim()
  const explicitLabel = row[`${prefix}_name`] || row[`${prefix}Name`] || ''
  if (stopId) return stopLookup.point(stopId, explicitLabel)
  const label = explicitLabel || (prefix === 'origin' ? 'Starting point' : 'Destination')
  const lon = numberField(row, [`${prefix}_lon`, `${prefix}_lng`, `${prefix}Lon`, `${prefix}Lng`, prefix === 'origin' ? 'from_lon' : 'to_lon'])
  const lat = numberField(row, [`${prefix}_lat`, `${prefix}Lat`, prefix === 'origin' ? 'from_lat' : 'to_lat'])
  if (lon === undefined || lat === undefined) return null
  const point = coordinatePoint(lon, lat, label)
  if (!point) throw new Error(`Invalid ${prefix} coordinate; longitude must be in [-180, 180] and latitude in [-90, 90]`)
  return point
}

function requireStreetStoreForCoordinateEndpoints(
  streetStorePath: string | undefined,
  origin: RoutingPoint,
  destination: RoutingPoint,
  requestLabel: string,
) {
  if (streetStorePath || (origin.stopId && destination.stopId)) return
  throw new Error(
    `${requestLabel}: coordinate endpoints require a City built with OSM streets`,
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
  const routingStatus: RoutingExecutionStatus = plan.diagnostics.routingStatus ?? (
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
      plan: decorateCliRoutingPlan(addNationalGtfsFares(storePath, profile.plan)),
      choices: profile.choices.map(plan => decorateCliRoutingPlan(addNationalGtfsFares(storePath, plan))),
      profileSampleCount: profile.profile.sampleCount,
      elapsedMs: performance.now() - startedAt,
    }
  }
  return {
    plan: decorateCliRoutingPlan(addNationalGtfsFares(storePath, routeNationalGtfsStore(storePath, request))),
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
  const cityValue = value(args, 'city')
  if (!cityValue) throw new Error('a query requires --city')
  const cityPath = path.resolve(cityValue)
  const storePath = path.join(cityPath, 'routing', 'project.sqlite')
  const streetCandidate = path.join(cityPath, 'osm', 'street-index.sqlite')
  const manifest = validateCityDirectory(cityPath) as Record<string, unknown>
  if (!fs.existsSync(storePath)) throw new Error(`City timetable is missing: ${storePath}`)
  return {
    storePath,
    streetStorePath: fs.existsSync(streetCandidate) ? streetCandidate : undefined,
    cityPath,
    city: {
      name: manifest.name ?? path.basename(cityPath),
      revisionId: manifest.revisionId ?? null,
    },
  }
}

function runtimeOptions(args: CliArguments, request: Record<string, unknown> = {}) {
  if (args.has('routing-preference') || Object.hasOwn(request, 'routingPreference')) {
    throw new Error('Unknown routing option; use --objective=earliest_arrival')
  }
  const timePreference = value(args, 'time-preference', String(request.timePreference ?? 'depart')) as RoutingTimePreference
  if (!['depart', 'arrive'].includes(timePreference)) throw new Error(`Invalid --time-preference value: ${timePreference}`)
  const objective = String(args.has('objective') ? value(args, 'objective') : request.objective ?? 'earliest_arrival')
  if (objective !== 'earliest_arrival') {
    throw new Error(`Invalid --objective value: ${objective}`)
  }
  const routingPreference = 'fastest'
  const timeMinutes = parseClock(value(args, 'time', '08:00'))
  const serviceDate = normalizeServiceDate(value(args, 'service-date'))
  if (!serviceDate) throw new Error('--service-date is required for exact timetable routing')
  const serviceDay = resolveServiceDay(serviceDate, value(args, 'service-day')) as ServiceDay
  const maxWalkKm = parseNumber(value(args, 'max-walk', '1.2'), 'max-walk', 0.01)
  const horizonMinutes = boundedAnalyticalNumber(args, request, 'horizon', 'horizonMinutes', 480, 1, 2_880)
  const maxTransfers = args.has('max-transfers') || request.maxTransfers !== undefined
    ? parseIntegerNumber(value(args, 'max-transfers', String(request.maxTransfers)), 'max-transfers', 0, 31)
    : undefined
  const departureWindowMinutes = parseIntegerNumber(value(args, 'departure-window', '0'), 'departure-window', 0, 30)
  if (timePreference === 'arrive' && departureWindowMinutes > 0) {
    throw new Error('--departure-window is a centered departure profile; omit it for arrive-by search')
  }
  const { routingDataMode } = normalizeRoutingDataRequest({
    routingDataMode: args.has('data-mode') ? value(args, 'data-mode')
      : request.routingDataMode === undefined ? 'scheduled' : request.routingDataMode,
    serviceDate, timePreference, departMinutes: timeMinutes, arriveMinutes: timeMinutes,
  })
  return {
    routingDataMode,
    serviceDay,
    timePreference,
    objective,
    routingPreference,
    timeMinutes,
    serviceDate,
    maxWalkKm,
    maxTransfers,
    horizonMinutes,
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
    ? prepareNationalOsmNativeStore(streetStorePath)
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

async function runRouteRequest(args: CliArguments) {
  const request = await readStructuredRequest(args, 'route')
  const { storePath, streetStorePath, city } = resolveRuntimePaths(args)
  if (request.scenario) throw new Error('Planned transit Scenarios are supported by Reach, not Route.')
  const options = runtimeOptions(args, request)
  const mode = String(value(args, 'mode', String(request.mode ?? 'transit')))
  if (!['transit', 'walk', 'drive'].includes(mode)) {
    throw new Error('route mode must be transit, walk, or drive')
  }
  if (options.routingDataMode === 'realtime' && request.traffic && mode !== 'drive') throw new Error('Supplied traffic requires Drive Route.')
  const stopLookup = openStopLookup(storePath)
  const origin = analyticalPoint(request.origin, 'Origin', stopLookup)
  const destination = analyticalPoint(request.destination, 'Destination', stopLookup)
  const waypointInputs = Array.isArray(request.waypoints) ? request.waypoints : []
  const waypoints = waypointInputs.map((waypoint, index) => (
    analyticalPoint(waypoint, `Waypoint ${index + 1}`, stopLookup)
  ))
  requireStreetStoreForCoordinateEndpoints(streetStorePath, origin, destination, 'Route')
  if (mode !== 'transit' && [origin, ...waypoints, destination].some((point) => !point.coordinate)) {
    throw new Error(`${mode} routes require coordinate points`)
  }
  const preparation = await prepareRuntime(
    storePath,
    streetStorePath,
    options.serviceDate,
    options.serviceDay,
  )
  const queryStarted = performance.now()
  try {
    const baseRequest = normalizeRoutingDataRequest({
      routingDataMode: options.routingDataMode,
      mode,
      origin,
      destination,
      departMinutes: options.timeMinutes,
      arriveMinutes: options.timeMinutes,
      timePreference: options.timePreference,
      routingPreference: options.routingPreference,
      serviceDay: options.serviceDay,
      serviceDate: options.serviceDate,
      allowServiceDateFallback: false,
      maxWalkKm: options.maxWalkKm,
      maxTransfers: options.maxTransfers,
      streetStorePath,
      requireTransitRide: request.requireTransitRide,
      __disableNativeStreetPathCache: request.disableCache === true,
      horizonMinutes: options.horizonMinutes,
      allowLongWalk: request.allowLongWalk !== false,
      departureWindowMinutes: options.departureWindowMinutes,
      walkingSpeedKph: request.walkSpeedKph,
      ...(options.routingDataMode === 'realtime' && mode === 'transit' && request.realtimeSnapshot
        ? { realtimeSnapshot: request.realtimeSnapshot } : {}),
      ...(options.routingDataMode === 'realtime' && mode === 'drive' && request.traffic
        ? { trafficSnapshot: request.traffic } : {}),
    })
    const routeSegment = async (segmentRequest: Record<string, any>) => (
      mode === 'transit'
        ? routeOne(
            storePath,
            segmentRequest,
            Number(segmentRequest.departureWindowMinutes ?? 0),
          ).plan
        : routeNationalStreetStore(streetStorePath!, segmentRequest) as RoutingPlan
    )
    let routed: RouteResult
    if (waypoints.length) {
      const points = validateOrderedRoutingPoints(origin, waypoints, destination)
      const components = await routeOrderedRoutingSegments(points, baseRequest, routeSegment)
      routed = {
        plan: composeOrderedRoutingPlans(components.componentPlans, points, baseRequest),
        profileSampleCount: components.componentPlans.length,
        elapsedMs: performance.now() - queryStarted,
      }
    } else {
      routed = mode === 'transit'
        ? routeOne(storePath, baseRequest, options.departureWindowMinutes)
        : {
            plan: routeNationalStreetStore(streetStorePath!, baseRequest) as RoutingPlan,
            profileSampleCount: 1,
            elapsedMs: 0,
          }
    }
    const queryMs = performance.now() - queryStarted
    writeJsonResult({
      schemaVersion: 'vigo.result.route.v1',
      ...publicResultMetadata,
      kind: 'route',
      status: routed.plan?.status ?? 'blocked',
      city,
      query: {
        origin,
        waypoints,
        destination,
        mode,
        routingDataMode: options.routingDataMode,
        timeMinutes: options.timeMinutes,
        timePreference: options.timePreference,
        objective: options.objective,
        serviceDate: options.serviceDate,
        maxWalkKm: options.maxWalkKm,
        maxTransfers: options.maxTransfers,
        departureWindowMinutes: options.departureWindowMinutes,
      },
      result: routed.plan ?? null,
      ...(routed.choices ? { choices: routed.choices } : {}),
      warnings: [],
      timing: {
        buildMs: null,
        openMs: preparation.elapsedMs,
        computeMs: Number(queryMs.toFixed(3)),
        endToEndMs: Number((performance.now() - cliStartedAt).toFixed(3)),
      },
    }, value(args, 'output'))
  } finally {
    disposeNationalGtfsStore(storePath)
  }
}

async function runRoute(args: CliArguments) {
  if (args.has('request')) return runRouteRequest(args)
  const { storePath, streetStorePath, city } = resolveRuntimePaths(args)
  const inputValue = value(args, 'input')
  const outputValue = value(args, 'output')
  const odPath = path.resolve(inputValue)
  const outPath = path.resolve(outputValue)
  if (!value(args, 'city') || !inputValue || !outputValue) {
    throw new Error('route requires --city, --input, and --output')
  }
  for (const filePath of [odPath]) {
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`)
  }
  const {
    routingDataMode,
    serviceDay,
    timePreference,
    objective,
    routingPreference,
    timeMinutes,
    serviceDate,
    maxWalkKm,
    maxTransfers,
    departureWindowMinutes,
    horizonMinutes,
  } = runtimeOptions(args)

  const preparation = await prepareRuntime(storePath, streetStorePath, serviceDate, serviceDay)
  const parsed = Papa.parse<Record<string, string>>(fs.readFileSync(odPath, 'utf8'), { header: true, skipEmptyLines: true })
  if (parsed.errors.length) throw new Error(`OD CSV parse failed: ${parsed.errors[0].message}`)
  const stopLookup = openStopLookup(storePath)
  const querySemantics = departureWindowMinutes > 0 ? 'centered_departure_profile' : timePreference === 'arrive' ? 'fixed_arrival' : 'fixed_departure'
  const results: RouteResult[] = []
  const rows: Array<Record<string, string | number>> = []
  const fullResults: Array<{ id: string; plan: RoutingPlan | null; blockedReason?: string }> = []
  const routingStarted = performance.now()
  try {
    for (let index = 0; index < parsed.data.length; index += 1) {
      const input = parsed.data[index]
      const id = input.id || input.od_id || `row_${index + 1}`
      const origin = buildPoint(input, 'origin', stopLookup)
      const destination = buildPoint(input, 'destination', stopLookup)
      if (!origin || !destination) {
        const blockedReason = 'missing or unknown origin/destination'
        rows.push({ id, status: 'blocked', blocked_reason: blockedReason, walking_network: streetStorePath ? 'sqlite-osm' : 'direct', query_semantics: querySemantics })
        fullResults.push({ id, plan: null, blockedReason })
        continue
      }
      requireStreetStoreForCoordinateEndpoints(streetStorePath, origin, destination, `OD ${id}`)
      const request = {
        routingDataMode,
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
        maxTransfers,
        horizonMinutes,
        streetStorePath,
      }
      const result = routeOne(storePath, request, departureWindowMinutes)
      results.push(result)
      const plan = result.plan
      fullResults.push({
        id,
        plan: plan ?? null,
        ...(result.choices ? { choices: result.choices } : {}),
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
        query_semantics: querySemantics,
        profile_sample_count: result.profileSampleCount,
        query_wall_ms: Number(result.elapsedMs.toFixed(3)),
        blocked_reason: plan?.status === 'blocked' ? `${plan.title}: ${plan.detail}` : '',
      })
    }
  } finally {
    disposeNationalGtfsStore(storePath)
  }

  const routingElapsedMs = performance.now() - routingStarted
  const outputStarted = performance.now()
  const queryMetadata = {
    routingDataMode,
    semantics: querySemantics,
    timeMinutes,
    timePreference,
    objective,
    departureWindowMinutes,
    serviceDay,
    serviceDate: serviceDate ?? null,
    maxWalkKm,
    maxTransfers,
  }
  writeOutputFile(outPath, `${Papa.unparse(rows, { newline: '\n' })}\n`)
  const outputElapsedMs = performance.now() - outputStarted
  const ready = rows.filter((row) => row.status === 'ready').length
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 'vigo.result.route.v1',
    ...publicResultMetadata,
    kind: 'route',
    status: ready ? 'ready' : 'blocked',
    city,
    query: queryMetadata,
    rows: { total: rows.length, ready, blocked: rows.length - ready },
    timing: {
      openMs: preparation.elapsedMs,
      computeMs: Number(routingElapsedMs.toFixed(3)),
      outputMs: Number(outputElapsedMs.toFixed(3)),
      endToEndMs: Number((performance.now() - cliStartedAt).toFixed(3)),
    },
    output: outPath,
    results: fullResults,
  }, null, 2)}\n`)
}

function ndjsonPoint(
  input: unknown,
  fallbackLabel: string,
  stopLookup: ReturnType<typeof openStopLookup>,
): RoutingPoint {
  if (typeof input === 'string') {
    const point = stopLookup.point(input)
    if (!point) throw new Error(`Unknown stop ID: ${input}`)
    return point
  }
  if (!input || typeof input !== 'object') throw new Error(`${fallbackLabel} must be a stop ID or point object`)
  const candidate = input as Record<string, unknown>
  const stopId = typeof candidate.stopId === 'string' ? candidate.stopId.trim() : ''
  const explicitLabel = typeof candidate.label === 'string' ? candidate.label.trim() : ''
  if (stopId) {
    const point = stopLookup.point(stopId, explicitLabel)
    if (!point) throw new Error(`Unknown stop ID: ${stopId}`)
    return point
  }
  const coordinate = candidate.coordinate
  const point = Array.isArray(coordinate) && coordinate.length >= 2
    ? coordinatePoint(coordinate[0], coordinate[1], explicitLabel || fallbackLabel)
    : null
  if (!point) throw new Error(`${fallbackLabel} requires a valid [longitude, latitude] coordinate`)
  return { ...point, source: typeof candidate.source === 'string' ? candidate.source : 'map' }
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

async function runRouteStream(args: CliArguments) {
  const paths = resolveRuntimePaths(args)
  const { storePath, streetStorePath } = paths
  const defaults = runtimeOptions(args)
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
        const timePreference = (input.timePreference ?? defaults.timePreference) as RoutingTimePreference
        if (!['depart', 'arrive'].includes(timePreference)) throw new Error('timePreference must be depart or arrive')
        const objective = String(input.objective ?? defaults.objective)
        if (objective !== 'earliest_arrival') {
          throw new Error('objective must be earliest_arrival')
        }
        const routingPreference = 'fastest'
        const { routingDataMode } = normalizeRoutingDataRequest({
          routingDataMode: input.routingDataMode === undefined ? defaults.routingDataMode : input.routingDataMode,
          serviceDate: defaults.serviceDate, timePreference,
          departMinutes: defaults.timeMinutes, arriveMinutes: defaults.timeMinutes,
        })
        const timeMinutes = input.time !== undefined
          ? parseNdjsonTime(input.time, 'time')
          : input.timeMinutes === undefined
            ? defaults.timeMinutes
            : parseNdjsonTime(input.timeMinutes, 'timeMinutes')
        const maxWalkKm = input.maxWalkKm === undefined
          ? defaults.maxWalkKm
          : parseNumber(String(input.maxWalkKm), 'maxWalkKm', 0.01)
        const maxTransfers = input.maxTransfers === undefined
          ? defaults.maxTransfers
          : parseIntegerNumber(String(input.maxTransfers), 'maxTransfers', 0, 31)
        const horizonMinutes = input.horizonMinutes === undefined
          ? defaults.horizonMinutes
          : parseNumber(String(input.horizonMinutes), 'horizonMinutes', 1, 2_880)
        const departureWindowMinutes = input.departureWindowMinutes === undefined
          ? defaults.departureWindowMinutes
          : parseIntegerNumber(String(input.departureWindowMinutes), 'departureWindowMinutes', 0, 30)
        if (timePreference === 'arrive' && departureWindowMinutes > 0) {
          throw new Error('departureWindowMinutes is only valid for depart searches')
        }
        if (input.kind === 'matrix') {
          if (departureWindowMinutes !== 0) throw new Error('Matrix does not support departure windows')
          const matrix = computePreparedMatrix(new Map(), input, paths, {
            ...defaults, routingDataMode, timePreference, objective, routingPreference, timeMinutes, maxWalkKm, maxTransfers,
          }, stopLookup)
          await writeNdjson({ ...matrix, sequence, id, timing: {
            ...matrix.timing,
            openMs: sequence === 1 ? preparation.elapsedMs : 0,
            endToEndMs: Number((performance.now() - (sequence === 1 ? cliStartedAt : requestStarted)).toFixed(3)),
          } })
          continue
        }
        const origin = ndjsonPoint(input.origin, 'Origin', stopLookup)
        const destination = ndjsonPoint(input.destination, 'Destination', stopLookup)
        requireStreetStoreForCoordinateEndpoints(streetStorePath, origin, destination, `Request ${id}`)
        const routed = routeOne(storePath, {
          routingDataMode,
          ...(routingDataMode === 'realtime' && input.realtimeSnapshot ? { realtimeSnapshot: input.realtimeSnapshot } : {}),
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
          maxTransfers,
          requireTransitRide: input.requireTransitRide,
          __disableNativeStreetPathCache: input.disableCache === true,
          horizonMinutes,
          streetStorePath,
        }, departureWindowMinutes)
        const engine = engineDescriptor([routed])
        await writeNdjson({
          // Keep the complete plan first so streaming clients can retain its
          // JSON while decoding the small response envelope separately.
          plan: routed.plan ?? null,
          schemaVersion: 'vigo.result.route.v1',
          ...publicResultMetadata,
          sequence,
          id,
          status: 'ok',
          routingStatus: routed.plan?.diagnostics?.routingStatus ?? (routed.plan?.status === 'ready' ? 'ready' : 'blocked'),
          query: {
            routingDataMode, serviceDate: defaults.serviceDate, timeMinutes, timePreference,
            objective, maxWalkKm, maxTransfers, departureWindowMinutes,
          },
          engine,
          timing: {
            openMs: sequence === 1 ? preparation.elapsedMs : 0,
            computeMs: Number(routed.elapsedMs.toFixed(3)),
            endToEndMs: Number((performance.now() - (sequence === 1 ? cliStartedAt : requestStarted)).toFixed(3)),
            requestMs: Number((performance.now() - requestStarted).toFixed(3)),
            routeMs: Number(routed.elapsedMs.toFixed(3)),
            engineQueryMs: timingMilliseconds(
              routed.plan?.diagnostics.searchStats?.engineQueryMs,
              null,
            ),
            preparationMs: sequence === 1 ? preparation.elapsedMs : 0,
          },
          routingStore: {
            storeId: stopLookup.routingStore.storeId,
            connectionCount: stopLookup.routingStore.connectionCount,
          },
          ...(routed.choices ? { choices: routed.choices } : {}),
          profileSampleCount: routed.profileSampleCount,
        })
      } catch (error) {
        await writeNdjson({
          schemaVersion: 'vigo.result.route.v1',
          ...publicResultMetadata,
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
    disposeNationalGtfsStore(storePath)
  }
}

async function readStructuredRequest(args: CliArguments, command: string) {
  return await readJsonObject(value(args, 'request'), `${command} request`, { stdin: true, maxBytes: 16 * 1024 * 1024 }) as Record<string, unknown>
}

function analyticalPoint(
  value: unknown,
  label: string,
  stopLookup: ReturnType<typeof openStopLookup>,
) {
  return ndjsonPoint(value, label, stopLookup)
}

function matrixDestinations(
  input: unknown,
  stopLookup: ReturnType<typeof openStopLookup>,
) {
  if (!Array.isArray(input) || !input.length) {
    throw new Error('matrix requires a non-empty destinations array')
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
    throw new Error('matrix destination ids must be unique')
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

function analyticalRuntimeOptions(args: CliArguments, command: string, request: Record<string, unknown>) {
  const options = runtimeOptions(args, request)
  normalizeScheduledAnalysisRequest({ ...options, departMinutes: options.timeMinutes }, command)
  if (options.timePreference !== 'depart' && command !== 'matrix') {
    throw new Error(`${command} supports fixed-departure routing only`)
  }
  if (options.departureWindowMinutes !== 0) {
    throw new Error(`${command} does not support --departure-window`)
  }
  return options
}

function matrixOrigins(
  request: Record<string, unknown>,
  stopLookup: ReturnType<typeof openStopLookup>,
) {
  const source = request.origins
  if (!Array.isArray(source) || !source.length) {
    throw new Error('matrix requires a non-empty origins array')
  }
  return source.map((candidate, index) => {
    const descriptor = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      ? candidate as Record<string, unknown>
      : null
    const pointInput = descriptor && Object.hasOwn(descriptor, 'point')
      ? descriptor.point
      : candidate
    const id = String(
      descriptor?.id
      ?? (typeof pointInput === 'string' ? pointInput : `origin_${index + 1}`),
    ).trim()
    if (!id) throw new Error(`Origin ${index + 1} has an empty id`)
    return { id, point: analyticalPoint(pointInput, `Origin ${id}`, stopLookup) }
  })
}

function computePreparedMatrix(
  args: CliArguments,
  request: Record<string, unknown>,
  paths: ReturnType<typeof resolveRuntimePaths>,
  options: ReturnType<typeof runtimeOptions>,
  stopLookup: ReturnType<typeof openStopLookup>,
) {
  normalizeScheduledAnalysisRequest({ ...options, departMinutes: options.timeMinutes }, 'Matrix')
  const { storePath, streetStorePath, city } = paths
  assertMatrixSize(Array.isArray(request.origins) ? request.origins.length : 0,
    Array.isArray(request.destinations) ? request.destinations.length : 0)
  if (request.scenario) throw new Error('Planned transit Scenarios are supported by Reach, not Matrix.')
  const mode = String(value(args, 'mode', String(request.mode ?? 'transit')))
  if (!['transit', 'walk', 'drive'].includes(mode)) {
    throw new Error('matrix mode must be transit, walk, or drive')
  }
  for (const option of ['includeJourneys', 'includeGeometry']) {
    if (request[option] != null && typeof request[option] !== 'boolean') throw new Error(`Matrix ${option} must be a boolean.`)
  }
  if (request.includeGeometry && !request.includeJourneys) throw new Error('Matrix includeGeometry requires includeJourneys: true.')
  if (request.includeJourneys && mode !== 'transit') throw new Error('Matrix journeys require transit mode.')
  const horizonMinutes = boundedAnalyticalNumber(
    args,
    request,
    'horizon',
    'horizonMinutes',
    480,
    1,
    2_880,
  )
  const origins = matrixOrigins(request, stopLookup)
  const destinations = matrixDestinations(request.destinations, stopLookup)
  if (
    !streetStorePath
    && (
      origins.some((origin) => !origin.point.stopId)
      || destinations.some((destination) => !destination.point.stopId)
    )
  ) {
    throw new Error(
      'matrix coordinate endpoints require a City with streets; only exact-stop requests may omit them',
    )
  }

  const queryStarted = performance.now()
  if (mode !== 'transit' && (
    origins.some((origin) => !origin.point.coordinate)
    || destinations.some((destination) => !destination.point.coordinate)
  )) {
    throw new Error(`${mode} matrices require coordinate points`)
  }
  const matrix = mode === 'transit'
    ? routeNationalGtfsMatrix(storePath, {
        routingDataMode: options.routingDataMode,
        origins: origins.map((origin) => origin.point),
        destinations: destinations.map((destination) => destination.point),
        departMinutes: options.timeMinutes,
        arriveMinutes: options.timeMinutes,
        timePreference: options.timePreference,
        routingPreference: options.routingPreference,
        serviceDay: options.serviceDay,
        serviceDate: options.serviceDate,
        allowServiceDateFallback: false,
        maxWalkKm: options.maxWalkKm,
        maxTransfers: options.maxTransfers,
        horizonMinutes,
        requireTransitRide: request.requireTransitRide,
        __disableNativeStreetPathCache: request.disableCache === true,
        includeJourneys: request.includeJourneys,
        includeGeometry: request.includeGeometry,
        streetStorePath,
      })
    : routeNationalStreetMatrix(streetStorePath!, {
        mode,
        origins: origins.map((origin) => origin.point),
        destinations: destinations.map((destination) => destination.point),
        walkingSpeedKph: request.walkSpeedKph,
        maxDistanceKm: request.maxDistanceKm,
      })
  const queryWallMs = performance.now() - queryStarted
  const rows = matrix.rows.map((row: Record<string, unknown>) => ({
    ...row,
    originId: origins[Number(row.originIndex)]?.id ?? null,
    destinationId: destinations[Number(row.destinationIndex)]?.id ?? null,
  }))
  const payload = {
    schemaVersion: 'vigo.result.matrix.v1',
    ...publicResultMetadata,
    kind: 'matrix',
    status: 'ready',
    city,
    warnings: [],
    query: {
      origins,
      destinations,
      mode,
      routingDataMode: options.routingDataMode,
      timePreference: options.timePreference,
      objective: options.objective,
      timeMinutes: options.timeMinutes,
      serviceDate: options.serviceDate,
      serviceDay: options.serviceDay,
      maxWalkKm: options.maxWalkKm,
      maxTransfers: options.maxTransfers,
      horizonMinutes,
      includeJourneys: request.includeJourneys === true,
      includeGeometry: request.includeGeometry === true,
    },
    rows,
    diagnostics: matrix.diagnostics,
    timing: {
      computeMs: Number(queryWallMs.toFixed(3)),
    },
  }
  return payload
}


async function runMatrix(args: CliArguments) {
  const request = await readStructuredRequest(args, 'matrix')
  const paths = resolveRuntimePaths(args)
  assertMatrixSize((request.origins as unknown[])?.length, (request.destinations as unknown[])?.length)
  const options = analyticalRuntimeOptions(args, 'matrix', request)
  const preparation = await prepareRuntime(paths.storePath, paths.streetStorePath, options.serviceDate, options.serviceDay)
  const payload = computePreparedMatrix(args, request, paths, options, openStopLookup(paths.storePath))
  writeJsonResult({ ...payload, timing: { ...payload.timing,
    openMs: preparation.elapsedMs,
    endToEndMs: Number((performance.now() - cliStartedAt).toFixed(3)),
  } }, value(args, 'output'))
}

function reachCutoffs(args: CliArguments, request: Record<string, unknown>) {
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
    throw new Error('Reach cutoffs must be finite minutes between 5 and 240')
  }
  return cutoffs
}

async function runReach(args: CliArguments) {
  const request = await readStructuredRequest(args, 'reach')
  const { storePath, streetStorePath, city } = resolveRuntimePaths(args)
  if (!streetStorePath) throw new Error('reach requires a City with streets')
  const scenarioState = request.scenario as Record<string, unknown> | undefined
  if (request.traffic || request.live || scenarioState?.traffic || scenarioState?.live) {
    throw new Error('Reach does not support supplied traffic or live transit state.')
  }
  const mode = value(args, 'mode', String(request.mode ?? 'transit'))
  if (mode !== 'transit') throw new Error('Reach supports transit with walking access and egress; walk-only and drive Reach are unavailable.')
  if (args.has('radius') || Object.hasOwn(request, 'radiusKm')) {
    throw new Error('Unknown Reach extent; use --extent-radius or extentRadiusKm')
  }
  const options = analyticalRuntimeOptions(args, 'reach', request)
  const cutoffsMinutes = reachCutoffs(args, request)
  const radiusKm = boundedAnalyticalNumber(args, request, 'extent-radius', 'extentRadiusKm', 8, 1, 40)
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
  const hydrated = hydrateScenarioRouteServices(storePath, { storageGeneration: city.revisionId }, request)
  const { scenario, overlay } = compileReachScenario(hydrated.scenario)
  const preparation = await prepareRuntime(
    storePath,
    streetStorePath,
    options.serviceDate,
    options.serviceDay,
  )
  const stopLookup = openStopLookup(storePath)
  const origin = analyticalPoint(request.origin, 'Origin', stopLookup)
  const bounds = rasterBounds(origin, radiusKm)
  const queryStarted = performance.now()
  const range = routeNationalGtfsReach(storePath, {
    routingDataMode: options.routingDataMode,
    origin,
    departMinutes: options.timeMinutes,
    serviceDate: options.serviceDate,
    serviceDay: options.serviceDay,
    maxWalkKm: options.maxWalkKm,
    maxTransfers: options.maxTransfers,
    walkSpeedKph,
    radiusKm,
    cutoffMinutes: cutoffsMinutes.at(-1),
    excludedRouteIds: scenario.excludedRouteIds,
    excludedTripIds: scenario.excludedTripIds,
    ...(overlay ? { scenarioOverlay: overlay } : {}),
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
    throw new Error('VIGO returned an invalid Reach surface')
  }
  const contourStarted = performance.now()
  const contours = rasterContours(
    range.surface.values,
    rasterSize,
    rasterSize,
    bounds,
    cutoffsMinutes,
    'reach',
  )
  const contourMs = performance.now() - contourStarted
  const payload = {
    schemaVersion: 'vigo.result.reach.v1',
    ...publicResultMetadata,
    kind: 'reach',
    status: 'ready',
    city,
    warnings: [],
    query: {
      routingDataMode: options.routingDataMode,
      origin,
      timeMinutes: options.timeMinutes,
      serviceDate: options.serviceDate,
      serviceDay: options.serviceDay,
      maxWalkKm: options.maxWalkKm,
      maxTransfers: options.maxTransfers,
      walkSpeedKph,
      extentRadiusKm: radiusKm,
      rasterSize,
      cutoffsMinutes,
      scenario,
    },
    stops: range.stops,
    scenarioStops: range.scenarioStops,
    surface: {
      ...range.surface,
      values: Array.from(range.surface.values),
    },
    contours,
    timing: {
      openMs: preparation.elapsedMs,
      computeMs: Number(queryWallMs.toFixed(3)),
      contourMs: Number(contourMs.toFixed(3)),
      endToEndMs: Number((performance.now() - cliStartedAt).toFixed(3)),
    },
  }
  writeJsonResult(payload, value(args, 'output'))
}

function requiredRawInput(input: string, label: string, pattern: RegExp) {
  if (!input.trim()) throw new Error(`build requires ${label}`)
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

async function runBuildCity(args: CliArguments) {
  const outputValue = value(args, 'output')
  if (!outputValue.trim()) throw new Error('build requires --output')
  const outputDirectory = path.resolve(outputValue)
  if (outputDirectory === path.parse(outputDirectory).root) {
    throw new Error('City output cannot be a filesystem root')
  }
  const replaceExisting = enabled(args, 'replace')
  if (fs.existsSync(outputDirectory) && !replaceExisting) {
    throw new Error(`City already exists; pass --replace to replace it: ${outputDirectory}`)
  }
  const stagingDirectory = createCityStagingDirectory(outputDirectory)
  try {
    // Native memory mappings outlive JavaScript cache eviction. Compile in a
    // child and wait for its close event before renaming the directory so all
    // mapped files and SQLite handles are released, including on Windows.
    const compiler = startJsonCompiler('_build-city', [
      ...values(args, 'gtfs').map((input) => `--gtfs=${input}`),
      ...values(args, 'gtfs-scope').map((scope) => `--gtfs-scope=${scope}`),
      `--osm=${value(args, 'osm')}`,
      `--private-access=${value(args, 'private-access', 'public')}`,
      `--output=${stagingDirectory}`,
      `--city-name=${path.basename(outputDirectory)}`,
    ], 'City compiler')
    const outcome = await compiler.outcome
    if (outcome.error) throw outcome.error
    buildProgress('city')({ phase: 'Saving City' })
    publishCity(stagingDirectory, outputDirectory, { replace: replaceExisting })
    process.stdout.write(`${JSON.stringify(outcome.result, null, 2)}\n`)
  } finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true })
  }
}

async function runCityCompiler(args: CliArguments) {
  const privateAccess = value(args, 'private-access', 'public')
  if (!['public', 'endpoints'].includes(privateAccess)) throw new Error('private-access must be public or endpoints')
  const gtfsValues = values(args, 'gtfs')
  const scopeValues = values(args, 'gtfs-scope')
  if (!gtfsValues.length) throw new Error('build requires at least one --gtfs GTFS ZIP')
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
  const osmPbf = requiredRawInput(value(args, 'osm'), 'OSM PBF', /(?:\.osm)?\.pbf$/iu)
  const outputValue = value(args, 'output')
  if (!outputValue.trim()) throw new Error('build requires --output')
  const outputDirectory = path.resolve(outputValue)
  if (outputDirectory === path.parse(outputDirectory).root) {
    throw new Error('City output cannot be a filesystem root')
  }
  const gtfsInputBytes = gtfs.reduce((sum, feed) => sum + fs.statSync(feed.path).size, 0)
  const osmInputBytes = fs.statSync(osmPbf).size
  const rawConcurrency = rawCompilerConcurrency(gtfsInputBytes, osmInputBytes)
  const parallelRawBuild = rawConcurrency.enabled

  const stagingDirectory = outputDirectory
  if (fs.readdirSync(stagingDirectory).length) {
    throw new Error('City compilation requires an empty staging directory')
  }
  const stagingRouting = path.join(stagingDirectory, 'routing')
  const stagingOsm = path.join(stagingDirectory, 'osm')
  fs.mkdirSync(stagingRouting, { recursive: true })
  fs.mkdirSync(stagingOsm, { recursive: true })

  const started = performance.now()
  let gtfsBuildMs = 0
  let osmBuildMs = 0
  let streetCchBuildMs = 0
  let stopTransferBuildMs = 0
  let coordinateAccessBuildMs = 0
  let osmRuntimeCompactionMs = 0
  let gtfsRuntimeCompactionMs = 0
  let osmCompiler: ReturnType<typeof startOsmCompiler> | null = null
  let osmDriveCompiler: ReturnType<typeof startOsmDriveCompiler> | null = null
  let osmDrivePreparation: Record<string, unknown> | null = null
  const cityProgress = buildProgress('city')
  try {
    const stagedStreetStore = path.join(stagingOsm, 'street-index.sqlite')
    if (parallelRawBuild) osmCompiler = startOsmCompiler(osmPbf, stagedStreetStore)
    const stagedRoutingStore = path.join(stagingRouting, 'project.sqlite')
    const gtfsStarted = performance.now()
    await buildNationalGtfsCityStore({
      feeds: gtfs,
      outputPath: stagedRoutingStore,
      onProgress: buildProgress('gtfs'),
    })
    gtfsBuildMs = performance.now() - gtfsStarted

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
      cityProgress({ phase: 'Preparing driving routes' })
      // Seal the source graph only after the driving snapshot is complete.
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
    cityProgress({ phase: 'Saving street data' })
    const osmRuntimeCompaction = compactNationalOsmRuntimeStore(stagedStreetStore, { requireDrive: true })
    osmRuntimeCompactionMs = performance.now() - osmRuntimeCompactionStarted

    const nativeStreet = prepareNationalOsmNativeStore(stagedStreetStore)
    if (!nativeStreet.ready) {
      throw new Error(`Native street snapshot preparation failed: ${nativeStreet.error ?? nativeStreet.reason}`)
    }
    const streetCchStarted = performance.now()
    cityProgress({ phase: 'Preparing street routing' })
    const streetCch = buildNativeStreetCchIndex(stagedStreetStore)
    streetCchBuildMs = performance.now() - streetCchStarted
    // Finalize SQLite before binding transfer topology and access snapshots
    // to its generation. No compaction may follow derived-index preparation.
    const gtfsRuntimeCompactionStarted = performance.now()
    cityProgress({ phase: 'Preparing transit topology' })
    const gtfsRuntimeCompaction = compactNationalGtfsRuntimeStore(stagedRoutingStore)
    gtfsRuntimeCompactionMs = performance.now() - gtfsRuntimeCompactionStarted
    const stopTransferStarted = performance.now()
    const stopTransfers = await ensureNationalGtfsOsmStopTransfers(
      stagedRoutingStore,
      stagedStreetStore,
      { onProgress: buildProgress('transfers') },
    )
    stopTransferBuildMs = performance.now() - stopTransferStarted
    const coordinateAccessStarted = performance.now()
    cityProgress({ phase: 'Preparing station access' })
    const coordinateAccess = prepareNationalGtfsNativeCoordinateAccess(
      stagedRoutingStore,
      stagedStreetStore,
    )
    coordinateAccessBuildMs = performance.now() - coordinateAccessStarted
    if (!coordinateAccess.ready) throw new Error('Native coordinate access preparation failed.')
    const terminalAccess = privateAccess === 'endpoints'
      ? await buildTerminalAccessStore({ pbfPath: osmPbf, streetStorePath: stagedStreetStore, routingStorePath: stagedRoutingStore })
      : { model: 'public' }

    const topology = inspectNationalStaticTopologySidecar(stagedRoutingStore)
    if (!topology.ready) throw new Error(`City topology is not current: ${topology.reason}.`)

    // Release cached readers now; native mappings are released on process exit
    // before the parent publishes the complete City.
    disposeNationalGtfsStore(stagedRoutingStore)
    disposeNationalOsmStore(stagedStreetStore)

    const routingMetadata = readNationalGtfsStoreMetadata(stagedRoutingStore)
    const builtAt = new Date().toISOString()
    const sources = {
      gtfs: gtfs.map((feed) => ({
        name: path.basename(feed.path),
        scope: feed.scope,
      })),
      osm: {
        name: path.basename(osmPbf),
      },
    }
    const summary = {
      schemaVersion: 'vigo.city.v1',
      productVersion: packageJson.version,
      apiVersion,
      cityFormatVersion,
      kind: 'city',
      name: value(args, 'city-name', path.basename(outputDirectory)),
      revisionId: cityRevisionId(builtAt),
      builtAt,
      sources,
      inputs: {
        gtfs: sources.gtfs,
        osmPbf: {
          name: sources.osm.name,
        },
      },
      routingStore: {
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
        terminalAccess,
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
        gtfsMergeMs: 0,
        osmBuildMs: Number(osmBuildMs.toFixed(3)),
        streetCchBuildMs: Number(streetCchBuildMs.toFixed(3)),
        stopTransferBuildMs: Number(stopTransferBuildMs.toFixed(3)),
        coordinateAccessBuildMs: Number(coordinateAccessBuildMs.toFixed(3)),
        osmRuntimeCompactionMs: Number(osmRuntimeCompactionMs.toFixed(3)),
        gtfsRuntimeCompactionMs: Number(gtfsRuntimeCompactionMs.toFixed(3)),
        osmDrivePreparationMs: Number(osmDrivePreparation?.prepareMs ?? 0),
        rawCompilerConcurrency: {
          gtfsAndOsmParallel: parallelRawBuild,
          parallelFallback: parallelRawBuild ? null : 'memory_or_load_guard',
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
    fs.writeFileSync(path.join(stagingDirectory, 'network.json'), `${JSON.stringify(summary, null, 2)}\n`)
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
  }
}

function writeProductInfo() {
  process.stdout.write(`${JSON.stringify(vigoCapabilities(packageJson.version), null, 2)}\n`)
}

function runInspect(args: CliArguments) {
  const cityValue = value(args, 'city')
  if (!cityValue) throw new Error('inspect requires --city; use vigo capabilities for runtime support')
  const cityPath = path.resolve(cityValue)
  const city = validateCityDirectory(cityPath) as Record<string, any>
  writeJsonResult({
    schemaVersion: 'vigo.city.inspect.v1',
    productVersion: packageJson.version,
    apiVersion,
    cityFormatVersion,
    kind: 'city',
    name: city.name ?? path.basename(cityPath),
    path: cityPath,
    revisionId: city.revisionId ?? null,
    builtAt: city.builtAt ?? null,
    sources: {
      gtfs: Array.isArray(city.sources?.gtfs)
        ? city.sources.gtfs.map((source: Record<string, unknown>) => ({
            name: String(source.name ?? 'GTFS'),
            scope: source.scope ?? null,
          }))
        : [],
      osm: city.sources?.osm?.name
        ? { name: String(city.sources.osm.name) }
        : null,
    },
    counts: {
      routes: city.routingStore?.routeCount ?? null,
      stops: city.routingStore?.stopCount ?? null,
      trips: city.routingStore?.tripCount ?? null,
      connections: city.routingStore?.connectionCount ?? null,
      streetNodes: city.streetStore?.nodeCount ?? null,
      streetEdges: city.streetStore?.edgeCount ?? null,
    },
    builtInMs: city.timing?.totalMs ?? null,
  }, value(args, 'output'))
}

async function readResultFile(input: string, label: string) {
  return await readJsonObject(input, `${label} result`) as Record<string, any>
}

function resultKind(result: Record<string, any>) {
  if (['route', 'matrix', 'reach'].includes(result.kind)) return result.kind
  const schema = String(result.schemaVersion ?? '')
  if (schema.includes('route')) return 'route'
  if (schema.includes('matrix')) return 'matrix'
  if (schema.includes('reach')) return 'reach'
  throw new Error(`compare does not recognize ${schema || 'this result'}`)
}

function routeComparison(before: Record<string, any>, after: Record<string, any>) {
  const left = before.result ?? before.plan ?? before.results?.[0]?.plan ?? null
  const right = after.result ?? after.plan ?? after.results?.[0]?.plan ?? null
  const leftDuration = left?.status === 'blocked' ? null : left?.durationMinutes
  const rightDuration = right?.status === 'blocked' ? null : right?.durationMinutes
  return {
    beforeStatus: left?.status ?? before.status ?? 'unknown',
    afterStatus: right?.status ?? after.status ?? 'unknown',
    durationChangeMinutes: Number.isFinite(leftDuration) && Number.isFinite(rightDuration)
      ? Number((rightDuration - leftDuration).toFixed(3))
      : null,
    transferChange: left?.status !== 'blocked' && right?.status !== 'blocked'
      && Number.isFinite(left?.transfers) && Number.isFinite(right?.transfers)
      ? Number(right.transfers) - Number(left.transfers)
      : null,
  }
}

function comparisonCounts(pairs: Iterable<[any, any]>, unit: 'Pairs' | 'Cells') {
  let faster = 0
  let slower = 0
  let unchanged = 0
  let comparable = 0
  let totalChange = 0
  let newlyReachable = 0
  let noLongerReachable = 0
  for (const [beforeMinutes, afterMinutes] of pairs) {
    if (!Number.isFinite(beforeMinutes) && Number.isFinite(afterMinutes)) newlyReachable += 1
    if (Number.isFinite(beforeMinutes) && !Number.isFinite(afterMinutes)) noLongerReachable += 1
    if (!Number.isFinite(beforeMinutes) || !Number.isFinite(afterMinutes)) continue
    const change = afterMinutes - beforeMinutes
    comparable += 1
    totalChange += change
    if (change < -1e-9) faster += 1
    else if (change > 1e-9) slower += 1
    else unchanged += 1
  }
  return {
    [`comparable${unit}`]: comparable,
    [`faster${unit}`]: faster,
    [`slower${unit}`]: slower,
    [`unchanged${unit}`]: unchanged,
    [`newlyReachable${unit}`]: newlyReachable,
    [`noLongerReachable${unit}`]: noLongerReachable,
    meanChangeMinutes: comparable ? Number((totalChange / comparable).toFixed(3)) : null,
  }
}

function matrixComparison(before: Record<string, any>, after: Record<string, any>) {
  const key = (row: Record<string, any>) => JSON.stringify([row.originId ?? row.originIndex, row.destinationId ?? row.destinationIndex])
  const left = new Map((before.rows ?? []).map((row: Record<string, any>) => [key(row), row]))
  const pairs: Array<[any, any]> = []
  for (const row of after.rows ?? []) {
    const previous = left.get(key(row)) as Record<string, any> | undefined
    if (!previous) continue
    const beforeMinutes = previous.status === 'blocked' ? null : previous.durationMinutes
    const afterMinutes = row.status === 'blocked' ? null : row.durationMinutes
    pairs.push([beforeMinutes, afterMinutes])
  }
  return comparisonCounts(pairs, 'Pairs')
}

function reachComparison(before: Record<string, any>, after: Record<string, any>) {
  const left = before.surface?.values
  const right = after.surface?.values
  const grid = before.surface
  const otherGrid = after.surface
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length
    || !Number.isInteger(grid?.width) || grid.width <= 0
    || !Number.isInteger(grid?.height) || grid.height <= 0
    || left.length !== grid.width * grid.height
    || grid.width !== otherGrid?.width || grid.height !== otherGrid?.height
    || !Array.isArray(grid.bounds) || grid.bounds.length !== 4
    || !grid.bounds.every(Number.isFinite)
    || JSON.stringify(grid.bounds) !== JSON.stringify(otherGrid?.bounds)) {
    throw new Error('Reach results must use the same grid before they can be compared')
  }
  return comparisonCounts(
    left.map((value, index) => [value, right[index]]),
    'Cells',
  )
}

async function runCompare(args: CliArguments) {
  const before = await readResultFile(value(args, 'before'), 'before')
  const after = await readResultFile(value(args, 'after'), 'after')
  const beforeKind = resultKind(before)
  const afterKind = resultKind(after)
  if (beforeKind !== afterKind) throw new Error('compare requires two Results from the same Query family')
  const change = beforeKind === 'route'
    ? routeComparison(before, after)
    : beforeKind === 'matrix'
      ? matrixComparison(before, after)
      : reachComparison(before, after)
  writeJsonResult({
    schemaVersion: 'vigo.result.comparison.v1',
    ...publicResultMetadata,
    kind: 'comparison',
    queryKind: beforeKind,
    status: 'ready',
    cities: {
      before: before.city ?? null,
      after: after.city ?? null,
    },
    change,
  }, value(args, 'output'))
}

handleOutputErrors()
let activeCommand = ''
try {
  const { command, args } = parseArguments(process.argv.slice(2))
  activeCommand = command
  if (args.has('version')) {
    process.stdout.write(`${packageJson.version}\n`)
  } else if (!command || args.has('help')) {
    process.stdout.write(usage(packageJson.version, command))
  } else {
    validateInvocation(command, args)
    if (command === '_build-city') await runCityCompiler(args)
    else if (command === '_build-osm-store') await runOsmCompiler(args)
    else if (command === '_prepare-osm-drive') await runOsmDriveCompiler(args)
    else if (command === 'build') await runBuildCity(args)
    else if (command === 'capabilities') writeProductInfo()
    else if (command === 'inspect') runInspect(args)
    else if (command === 'reach') await runReach(args)
    else if (command === 'matrix') await runMatrix(args)
    else if (command === 'compare') await runCompare(args)
    else if (command === '_route-stream') await runRouteStream(args)
    else await runRoute(args)
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  const command = error instanceof CliUsageError ? error.command : activeCommand
  const publicCommand = Object.hasOwn(commands, command) && commands[command].usage ? command : ''
  process.stderr.write(`VIGO${command ? ` ${command}` : ''}: ${message}\n`)
  process.stderr.write(`Run "vigo${publicCommand ? ` ${publicCommand}` : ''} --help" for usage.\n`)
  process.exitCode = 2
}
