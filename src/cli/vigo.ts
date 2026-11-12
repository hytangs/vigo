import { nativeRouteRequest, studioRouteResponse } from '../server/studio-route-plans.mjs'
import { routingResultStatus } from '../server/gtfs/route-results.mjs'
import { validateWheelchairRequest } from '../server/wheelchair-policy.mjs'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import Papa from 'papaparse'
import packageJson from '../../package.json'
import { CliUsageError, parseArguments, validateInvocation, value, enabled } from './arguments.mjs'
import { publicResult, publicResultJson, presentationRequest, normalizePublicPoint, publicError, streamLineArgs } from './presentation.mjs'
import { commands, usage } from './commands.mjs'
import { runStreamWorkers } from './stream-workers.mjs'
import { memoryCapacityBytes } from '../server/runtime/resource-limits.mjs'
import { handleOutputErrors, readJsonObject, writeJsonResult, writeOutputFile } from './io.mjs'
import { assertMatrixSize } from '../server/matrix-size.mjs'
import { validateArrivalBuffer } from '../server/arrival-reserve.mjs'
import { normalizeRoutingDataRequest, normalizeScheduledAnalysisRequest } from '../server/routing-data-mode.mjs'
import {
  apiVersion,
  cityFormatVersion,
  resultSchemaVersion,
  vigoCapabilities,
} from '../capabilities.mjs'
import { recoverCityPublication, validateCityDirectory } from '../city.mjs'
import { readNationalGtfsStoreMetadata } from '../server/gtfs/store-metadata.mjs'
import { formatPublicResult, routeAlternativeRequest, selectDetailedRouteChoices } from '../server/native-routing-kernel.mjs'
import { nativeExecutable } from '../server/runtime/native-runtime.mjs'
import { compileReachScenario, rasterAreas, rasterContours } from '../server/reach.mjs'
import { closeNativeCity, nativePoint, nativeReachRange, nativeScenario, queryNativeCity } from './native-reach.mjs'
import { hydrateScenarioRouteServices } from '../server/scenario-services.mjs'
import { resolveServiceDay } from '../server/service-day.mjs'
import type { ServiceDay } from '../domain'
import type { RoutingExecutionStatus, RoutingPlan, RoutingPoint, RoutingTimePreference } from '../routingModel'

// Studio preparation owns this process tree. Closing the parent must stop the
// engine's build, including during cancellation.
if (process.send) {
  process.once('disconnect', () => { void stopEngine().then(() => process.exit(1)) })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => { void stopEngine().then(() => process.kill(process.pid, signal)) })
  }
  process.channel?.unref()
}

type CliArguments = Map<string, string[]>
type RouteResult = {
  plan: RoutingPlan | undefined
  choices?: RoutingPlan[]
  alternativeSearch?: Record<string, unknown> | null
  profileSampleCount: number
  elapsedMs: number
  openMs: number
}
type RouteAlternatives = { count: number; ranking: string; arrivalSlackSeconds: number; limit?: number | null }

const cliStartedAt = performance.now()
const publicResultMetadata = Object.freeze({
  productVersion: packageJson.version,
  apiVersion,
  resultSchemaVersion,
})

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

const stopLookups = new Map<string, ReturnType<typeof createStopLookup>>()
function openStopLookup(storePath: string) {
  let lookup = stopLookups.get(storePath)
  if (!lookup) {
    lookup = createStopLookup(storePath)
    stopLookups.set(storePath, lookup)
  }
  return lookup
}

function createStopLookup(storePath: string) {
  // Endpoint labels need one indexed SQLite lookup, not a second routing store
  // with timetable activation, transfer graphs and access materialization.
  const metadata = readNationalGtfsStoreMetadata(storePath)
  let db: DatabaseSync | undefined
  let statement: ReturnType<DatabaseSync['prepare']> | undefined
  const routingStore = {
    storeId: (metadata as Record<string, unknown>).storeId,
    connectionCount: metadata.connectionCount,
  }
  type StopRow = { stop_id: string; name: string; lon: number; lat: number }
  return {
    metadata,
    close() { db?.close() },
    routingStore,
    point(stopId: string, label?: string): RoutingPoint | null {
      if (!statement) {
        db = new DatabaseSync(storePath, { readOnly: true })
        statement = db.prepare('SELECT stop_id, name, lon, lat FROM stops WHERE stop_id = ?')
      }
      const row = statement.get(String(stopId ?? '').trim()) as StopRow | undefined
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

function decorateCliRoutingPlan(plan: RoutingPlan): RoutingPlan
function decorateCliRoutingPlan(plan: RoutingPlan | undefined): RoutingPlan | undefined
function decorateCliRoutingPlan(plan: RoutingPlan | undefined): RoutingPlan | undefined {
  if (!plan) return plan
  const routingStatus: RoutingExecutionStatus = plan.diagnostics.routingStatus ?? routingResultStatus(plan)
  return {
    ...plan,
    diagnostics: {
      ...plan.diagnostics,
      routingStatus,
      routingStatusSchemaVersion: 'vigo.routing.status.v1' as const,
    },
  }
}

async function routeOne(
  storePath: string, request: Record<string, any>, departureWindowMinutes: number,
  alternatives: RouteAlternatives | null = null,
): Promise<RouteResult> {
  const startedAt = performance.now()
  const body = { ...request, departureWindowMinutes: 0 }
  const query: Record<string, any> = nativeRouteRequest(body)
  delete query.requireCompleteServiceCoverage
  for (const key of ['arrivalBufferMinutes', 'disableCache', 'walkSpeedKph', 'bike']) {
    if (request[key] !== undefined) query[key] = request[key]
  }
  if (request.__disableNativeStreetPathCache !== undefined) query.disableCache = request.__disableNativeStreetPathCache
  if (request.walkingSpeedKph !== undefined) query.walkSpeedKph = request.walkingSpeedKph
  if (request.trafficSnapshot) { query.traffic = request.trafficSnapshot; query.routingDataMode = 'realtime' }
  if (departureWindowMinutes > 0) {
    const start = Math.max(0, Number(request.departMinutes) - departureWindowMinutes)
    query.timeMinutes = start
    query.windowMinutes = Number(request.departMinutes) + departureWindowMinutes - start
    query.windowChoices = 'supported'
  }
  if (alternatives) Object.assign(query, { alternatives: alternatives.count, alternativeRanking: alternatives.ranking,
    alternativeSlackMinutes: alternatives.arrivalSlackSeconds / 60 })
  const { trace, openMs } = await queryNativeCity(path.dirname(path.dirname(storePath)), query)
  const response = studioRouteResponse(trace, request)
  const choices: RoutingPlan[] = response.choices.map((plan: RoutingPlan) => decorateCliRoutingPlan({ ...plan,
    diagnostics: { ...plan.diagnostics, ...(trace.clockDate ? { clockDate: trace.clockDate } : {}),
      ...(trace.window ? { departureWindow: { centerMinutes: request.departMinutes,
        beforeMinutes: request.departMinutes - trace.window.startMinutes,
        afterMinutes: trace.window.endMinutes - request.departMinutes,
        sampleCount: trace.window.sampleCount } } : {}),
    },
  }))
  return { plan: choices.find(plan => plan?.id === response.selectedPlanId) ?? choices[0],
    ...(trace.choices ? { choices } : {}),
    ...(trace.alternativeSearch ? { alternativeSearch: trace.alternativeSearch } : {}),
    profileSampleCount: trace.window?.sampleCount ?? 0, openMs, elapsedMs: performance.now() - startedAt }
}

// Only a City missing from its path can need repair, so ordinary queries never write.
function openCity(cityPath: string) {
  if (!fs.existsSync(cityPath)) recoverCityPublication(cityPath)
  return validateCityDirectory(cityPath)
}

function resolveRuntimePaths(args: CliArguments) {
  const cityValue = value(args, 'city')
  if (!cityValue) throw new Error('a query requires --city')
  const cityPath = path.resolve(cityValue)
  const storePath = path.join(cityPath, 'routing', 'project.sqlite')
  const streetCandidate = path.join(cityPath, 'osm', 'street-index.sqlite')
  const manifest = openCity(cityPath) as Record<string, unknown>
  if (!fs.existsSync(storePath)) throw new Error(`City timetable is missing: ${storePath}`)
  return {
    storePath,
    streetStorePath: fs.existsSync(streetCandidate) ? streetCandidate : undefined,
    cityPath,
    city: {
      name: manifest.name ?? path.basename(cityPath),
      revisionId: manifest.revisionId ?? null,
      accessibility: manifest.accessibility as { profile: string } | undefined,
    },
  }
}

function runtimeOptions(args: CliArguments, request: Record<string, unknown> = {}) {
  if (Object.hasOwn(request, 'windowMinutes') || Object.hasOwn(request, 'windowStepMinutes')) {
    throw new Error('windowMinutes and windowStepMinutes require the standalone Rust CLI or /v1/route service. The Node CLI supports departureWindowMinutes (a centered departure profile).')
  }
  if (args.has('routing-preference') || Object.hasOwn(request, 'routingPreference')) {
    throw new Error('Unknown routing option; use --objective=earliest_arrival')
  }
  const preference = value(args, 'time-preference', String(request.timePreference ?? 'depart'))
  const timePreference = (preference === 'depart_at' ? 'depart' : preference === 'arrive_by' ? 'arrive' : preference) as RoutingTimePreference
  if (!['depart', 'arrive'].includes(timePreference)) throw new Error(`Invalid --time-preference value: ${timePreference}`)
  const objective = String(args.has('objective') ? value(args, 'objective') : request.objective ?? 'earliest_arrival')
  if (objective !== 'earliest_arrival') {
    throw new Error(`Invalid --objective value: ${objective}`)
  }
  const routingPreference = 'fastest'
  const timeMinutes = args.has('time') ? parseClock(value(args, 'time')) : parseNdjsonTime(request.time ?? request.timeMinutes ?? '08:00', 'time')
  const serviceDate = normalizeServiceDate(value(args, 'service-date', String(request.serviceDate ?? '')))
  const mode = value(args, 'mode', String(request.mode ?? 'transit'))
  if (!serviceDate && mode === 'transit') throw new Error('--service-date is required for exact timetable routing')
  const serviceDay = (serviceDate ? resolveServiceDay(serviceDate, value(args, 'service-day')) : 'weekday') as ServiceDay
  const maxWalkKm = parseNumber(value(args, 'max-walk', String(request.maxWalkKm ?? 1.2)), 'max-walk', 0)
  const horizonMinutes = boundedAnalyticalNumber(args, request, 'horizon', 'horizonMinutes', 480, 1, 2_880)
  const maxTransfers = args.has('max-transfers') || request.maxTransfers !== undefined
    ? parseIntegerNumber(value(args, 'max-transfers', String(request.maxTransfers)), 'max-transfers', 0, 31)
    : undefined
  const departureWindowMinutes = parseIntegerNumber(value(args, 'departure-window', String(request.departureWindowMinutes ?? 0)), 'departure-window', 0, 30)
  if (timePreference === 'arrive' && departureWindowMinutes > 0) {
    throw new Error('--departure-window is a centered departure profile; omit it for arrive-by search')
  }
  const { routingDataMode } = normalizeRoutingDataRequest({
    routingDataMode: args.has('data-mode') ? value(args, 'data-mode')
      : request.routingDataMode === undefined ? 'scheduled' : request.routingDataMode,
    mode, serviceDate, timePreference, departMinutes: timeMinutes, arriveMinutes: timeMinutes,
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

async function computeRouteRequest(
  args: CliArguments, request: Record<string, any>,
  paths: ReturnType<typeof resolveRuntimePaths>,
) {
  if (Object.hasOwn(request, 'monteCarlo')) return computeDistribution(args, request, paths, 'route')
  const { storePath, streetStorePath, city } = paths
  validateWheelchairRequest(city.accessibility?.profile, { ...request,
    mode: value(args, 'mode', String(request.mode ?? 'transit')),
    ...(args.has('data-mode') ? { routingDataMode: value(args, 'data-mode') } : {}),
  })
  if (request.scenario) throw new Error('Planned transit Scenarios are supported by Reach, not Route.')
  const options = runtimeOptions(args, request)
  const mode = String(value(args, 'mode', String(request.mode ?? 'transit')))
  validateArrivalBuffer({ ...request, timePreference: options.timePreference, mode })
  // The shared contract also rejects alternatives with arrive-by, windows,
  // ordered stops and street modes.
  const alternatives = routeAlternativeRequest({
    ...presentationRequest(request, args),
    mode,
    timePreference: options.timePreference,
    departureWindowMinutes: options.departureWindowMinutes,
  }) as RouteAlternatives | null
  if (!['transit', 'walk', 'drive', 'bike'].includes(mode)) {
    throw new Error('route mode must be transit, walk, drive, or bike')
  }
  if (options.routingDataMode === 'realtime' && request.traffic && mode !== 'drive') throw new Error('Supplied traffic requires Drive Route.')
  const stopLookup = openStopLookup(storePath)
  const origin = analyticalPoint(request.origin, 'Origin', stopLookup)
  const destination = analyticalPoint(request.destination, 'Destination', stopLookup)
  const waypointInputs = Array.isArray(request.waypoints) ? request.waypoints : []
  if (request.sharedLegs !== undefined && typeof request.sharedLegs !== 'boolean') throw new Error('sharedLegs must be a boolean.')
  if (request.sharedLegs && (mode !== 'transit' || waypointInputs.length)) throw new Error('sharedLegs requires transit mode without via points.')
  const waypoints = waypointInputs.map((waypoint, index) => (
    analyticalPoint(waypoint, `Waypoint ${index + 1}`, stopLookup)
  ))
  requireStreetStoreForCoordinateEndpoints(streetStorePath, origin, destination, 'Route')
  if (mode !== 'transit' && [origin, ...waypoints, destination].some((point) => !point.coordinate)) {
    throw new Error(`${mode} routes require coordinate points`)
  }
  const queryStarted = performance.now()
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
    sharedLegs: request.sharedLegs,
    flex: request.flex,
    __disableNativeStreetPathCache: request.disableCache === true,
    horizonMinutes: options.horizonMinutes,
    allowLongWalk: request.allowLongWalk !== false,
    allowStreetTransfers: request.allowStreetTransfers,
    minimumTransferBufferMinutes: request.minimumTransferBufferMinutes,
    arrivalBufferMinutes: request.arrivalBufferMinutes,
    departureWindowMinutes: options.departureWindowMinutes,
    walkingSpeedKph: request.walkSpeedKph,
    bike: request.bike,
    ...(options.routingDataMode === 'realtime' && mode === 'transit' && request.realtimeSnapshot
      ? { realtimeSnapshot: request.realtimeSnapshot } : {}),
    ...(options.routingDataMode === 'realtime' && mode === 'drive' && request.traffic
      ? { trafficSnapshot: request.traffic } : {}),
  })
  const routed = await routeOne(storePath, { ...baseRequest, waypoints,
    maxStreetKm: request.maxStreetKm ?? (mode === 'drive' ? 750 : 50),
  }, options.departureWindowMinutes, alternatives)
  const queryMs = performance.now() - queryStarted
  const result = {
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
      ...(alternatives ? { alternatives: alternatives.count, alternativeRanking: alternatives.ranking,
        alternativeSlackMinutes: alternatives.arrivalSlackSeconds / 60 } : {}),
      horizonMinutes: options.horizonMinutes,
      horizonScope: 'timetable_scan',
      requireTransitRide: request.requireTransitRide === true,
      ...(request.sharedLegs !== undefined ? { sharedLegs: request.sharedLegs } : {}),
      disableCache: request.disableCache === true,
      ...(request.allowStreetTransfers !== undefined ? { allowStreetTransfers: request.allowStreetTransfers } : {}),
      ...(request.minimumTransferBufferMinutes !== undefined ? { minimumTransferBufferMinutes: request.minimumTransferBufferMinutes } : {}),
      ...(request.arrivalBufferMinutes !== undefined ? { arrivalBufferMinutes: request.arrivalBufferMinutes } : {}),
    },
    result: routed.plan ?? null,
    ...(routed.choices ? { choices: routed.choices } : {}),
    ...(routed.alternativeSearch ? { alternativeSearch: routed.alternativeSearch } : {}),
    warnings: request.includeLimitations === true ? readNationalGtfsStoreMetadata(storePath).routingLimitations ?? [] : [],
    timing: {
      buildMs: null,
      openMs: routed.openMs,
      computeMs: Number(queryMs.toFixed(3)),
      endToEndMs: Number((performance.now() - cliStartedAt).toFixed(3)),
    },
  }
  if (alternatives) Object.assign(result, selectDetailedRouteChoices(presentationRequest(request, args), result))
  return result
}

async function runRouteRequest(args: CliArguments) {
  const request = await readStructuredRequest(args, 'route')
  const paths = resolveRuntimePaths(args)
  try {
    const raw = await computeRouteRequest(args, request, paths)
    writeJsonResult(publicResult(raw, request, args), value(args, 'output'), value(args, 'format', 'auto'))
  } finally {
    closeNativeCity()
  }
}

async function runRoute(args: CliArguments) {
  if (args.has('request')) return runRouteRequest(args)
  const { storePath, streetStorePath, city } = resolveRuntimePaths(args)
  validateWheelchairRequest(city.accessibility?.profile, { ...presentationRequest({}, args),
    mode: value(args, 'mode', 'transit'), routingDataMode: value(args, 'data-mode', 'scheduled') })
  const inputValue = value(args, 'input')
  const outputValue = value(args, 'output')
  const odPath = path.resolve(inputValue)
  const outPath = path.resolve(outputValue)
  if (!value(args, 'city') || !inputValue || !outputValue) {
    throw new Error('route requires --city, --input, and --output')
  }
  if (args.has('alternatives') || args.has('alternative-ranking')) {
    throw new Error('Route alternatives return JSON journeys; omit --input for a single route')
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

  const parsed = Papa.parse<Record<string, string>>(fs.readFileSync(odPath, 'utf8'), { header: true, skipEmptyLines: true })
  if (parsed.errors.length) throw new Error(`OD CSV parse failed: ${parsed.errors[0].message}`)
  const stopLookup = openStopLookup(storePath)
  const querySemantics = departureWindowMinutes > 0 ? 'centered_departure_profile' : timePreference === 'arrive' ? 'fixed_arrival' : 'fixed_departure'
  const results: RouteResult[] = []
  const rows: Array<Record<string, string | number>> = []
  const fullResults: Array<{ id: string; plan: RoutingPlan | null; blockedReason?: string }> = []
  const routingStarted = performance.now()
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
    const result = await routeOne(storePath, request, departureWindowMinutes)
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
  const batch = {
    schemaVersion: 'vigo.result.route.v1',
    ...publicResultMetadata,
    kind: 'route',
    status: ready ? 'ready' : 'blocked',
    city,
    query: queryMetadata,
    rows: { total: rows.length, ready, blocked: rows.length - ready },
    timing: {
      openMs: results[0]?.openMs ?? 0,
      computeMs: Number(routingElapsedMs.toFixed(3)),
      outputMs: Number(outputElapsedMs.toFixed(3)),
      endToEndMs: Number((performance.now() - cliStartedAt).toFixed(3)),
    },
    output: outPath,
    results: fullResults,
  }
  const level = presentationRequest({}, args).diagnostics ?? 'none'
  const output: Record<string, unknown> = { schema: 'vigo.batch.v1', status: 'ok', counts: batch.rows,
    output: outPath, meta: { engineVersion: packageJson.version, cityRevision: city.revisionId } }
  if (level !== 'none') output.diagnostics = { queries: rows.length }
  if (['profile', 'trace'].includes(level)) output.profile = { timingsUs: Object.fromEntries(Object.entries(batch.timing).map(([key, val]) => [key.replace(/Ms$/, 'Us'), Math.round(val * 1000)])) }
  if (level === 'trace') output.trace = batch
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)

}

function ndjsonPoint(
  input: unknown,
  fallbackLabel: string,
  stopLookup: ReturnType<typeof openStopLookup>,
): RoutingPoint {
  input = normalizePublicPoint(input)
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
  return { ...point, source: candidate.source === 'stop' || candidate.source === 'search' ? candidate.source : 'map' }
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

async function writeNdjson(value: unknown, request?: Record<string, unknown>, args?: CliArguments) {
  const serialized = request ? publicResultJson(value, request, args) : serializeNdjson(value)
  if (process.stdout.write(`${serialized}\n`)) return
  await once(process.stdout, 'drain')
}

async function runRouteStream(args: CliArguments) {
  const workers = Number(value(args, 'workers', '1'))
  if (!Number.isInteger(workers) || workers < 1 || workers > 4) throw new Error('--workers must be an integer from 1 to 4')
  const capacity = Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 2), Math.floor(memoryCapacityBytes / (6 * 1024 ** 3))))
  const effectiveWorkers = Math.min(workers, capacity)
  if (effectiveWorkers !== workers) process.stderr.write(`Using ${effectiveWorkers} stream worker(s) within CPU and memory limits.\n`)
  const streamOutput = value(args, 'stream-output', 'public')
  if (!['public', 'detailed'].includes(streamOutput)) throw new Error('stream-output must be public or detailed')
  const paths = resolveRuntimePaths(args)
  if (effectiveWorkers > 1) return runStreamWorkers(args, effectiveWorkers)
  const { storePath } = paths
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
        const parsed = JSON.parse(line)
        // Stream options, including the date that prepares the first City
        // slice, are defaults: a line's own fields take precedence.
        const lineArgs = streamLineArgs(parsed, args)
        const input = presentationRequest(parsed, lineArgs) as Record<string, unknown>
        if (typeof input.id === 'string' && input.id.trim()) id = input.id.trim()
        if (!['route', 'matrix', 'reach'].includes(String(input.kind))) {
          throw new Error('stream requires kind: route, matrix, or reach on every line')
        }
        const requestArgs = new Map(lineArgs)
        if (typeof input.serviceDate === 'string') requestArgs.set('service-date', [input.serviceDate])
        if (typeof input.serviceDay === 'string') requestArgs.set('service-day', [input.serviceDay])
        for (const [field, option] of [['maxWalkKm', 'max-walk'], ['maxTransfers', 'max-transfers'], ['departureWindowMinutes', 'departure-window']]) {
          if (input[field] !== undefined) requestArgs.set(option, [String(input[field])])
        }
        const clock = input.time !== undefined ? input.time : input.timeMinutes
        if (clock !== undefined) {
          const minutes = parseNdjsonTime(clock, 'time')
          requestArgs.set('time', [`${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`])
        }
        let result
        if (Object.hasOwn(input, 'monteCarlo')) result = await computeDistribution(requestArgs, input, paths, String(input.kind))
        else if (input.kind === 'route') result = await computeRouteRequest(requestArgs, input, paths)
        else if (input.kind === 'reach') result = await computeReachRequest(requestArgs, input, paths)
        else {
          const options = analyticalRuntimeOptions(requestArgs, 'matrix', input)
          const matrix = await computePreparedMatrix(requestArgs, input, paths, options, stopLookup)
          result = matrix
        }
        const detailed = { ...result, sequence, id, timing: {
          ...result.timing,
          endToEndMs: Number((performance.now() - (sequence === 1 ? cliStartedAt : requestStarted)).toFixed(3)),
        } }
        if (streamOutput === 'detailed') {
          await writeNdjson({ schema: 'vigo.stream.detail.v1', id, sequence, status: 'ok', trace: detailed })
        } else {
          await writeNdjson(detailed, input, lineArgs)
        }
      } catch (error) {
        const { status, ...failure } = publicError(error instanceof Error ? error.message : String(error), id)
        await writeNdjson({ ...failure, sequence, status })
      }
    }
  } finally {
    closeNativeCity()
  }
}

async function readStructuredRequest(args: CliArguments, command: string) {
  const request = presentationRequest(await readJsonObject(value(args, 'request'), `${command} request`, { stdin: true, maxBytes: 16 * 1024 * 1024 }), args) as Record<string, unknown>
  if (!args.has('service-date') && typeof request.serviceDate === 'string') args.set('service-date', [request.serviceDate])
  return request
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

function validateAnalysisDataMode(options: ReturnType<typeof runtimeOptions>, command: string, mode: string, request: Record<string, unknown>) {
  validateArrivalBuffer({ ...request, mode, timePreference: options.timePreference }, command.toLowerCase() === 'matrix')
  if (command.toLowerCase() === 'matrix' && mode === 'drive' && options.routingDataMode === 'realtime' && request.traffic) {
    if (request.realtimeSnapshot || request.live) throw new Error('Drive Matrix accepts supplied traffic only.')
    return
  }
  normalizeScheduledAnalysisRequest({ ...options, mode, departMinutes: options.timeMinutes }, command)
}

function analyticalRuntimeOptions(args: CliArguments, command: string, request: Record<string, unknown>) {
  const options = runtimeOptions(args, request)
  validateAnalysisDataMode(options, command, value(args, 'mode', String(request.mode ?? 'transit')), request)
  if (options.timePreference !== 'depart' && !['matrix', 'reach'].includes(command)) {
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

function analyticalJourney(raw: Record<string, any>) {
  const rounded = (value: number) => Number(value.toFixed(3))
  const { departureMinutes, arrivalMinutes, legs, ...rest } = raw
  return { ...rest, departMinutes: rounded(departureMinutes), arriveMinutes: rounded(arrivalMinutes),
    ...Object.fromEntries(['durationMinutes', 'walkMinutes', 'rideMinutes', 'waitMinutes']
      .filter(key => typeof raw[key] === 'number').map(key => [key, rounded(raw[key])])),
    legs: legs.map((leg: Record<string, any>) => {
      const { kind, departureMinutes, arrivalMinutes, ...fields } = leg
      return { ...fields, type: kind, startMinutes: rounded(departureMinutes),
        endMinutes: rounded(arrivalMinutes), durationMinutes: rounded(leg.durationMinutes) }
    }) }
}

async function computePreparedMatrix(
  args: CliArguments,
  request: Record<string, unknown>,
  paths: ReturnType<typeof resolveRuntimePaths>,
  options: ReturnType<typeof runtimeOptions>,
  stopLookup: ReturnType<typeof openStopLookup>,
) {
  const preparationStarted = performance.now()
  validateAnalysisDataMode(options, 'matrix', value(args, 'mode', String(request.mode ?? 'transit')), request)
  const { storePath, streetStorePath, city } = paths
  validateWheelchairRequest(city.accessibility?.profile, { ...request,
    mode: value(args, 'mode', String(request.mode ?? 'transit')),
    ...(args.has('data-mode') ? { routingDataMode: value(args, 'data-mode') } : {}),
  })
  assertMatrixSize(Array.isArray(request.origins) ? request.origins.length : 0,
    Array.isArray(request.destinations) ? request.destinations.length : 0)
  if (request.scenario) throw new Error('Planned transit Scenarios are supported by Reach, not Matrix.')
  const mode = String(value(args, 'mode', String(request.mode ?? 'transit')))
  if (!['transit', 'walk', 'drive', 'bike'].includes(mode)) {
    throw new Error('matrix mode must be transit, walk, drive, or bike')
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
  const nativeRequest: Record<string, any> = { kind: 'matrix', mode,
    origins: origins.map(origin => nativePoint(origin.point)), destinations: destinations.map(destination => nativePoint(destination.point)),
    timeMinutes: options.timeMinutes, timePreference: options.timePreference, serviceDate: options.serviceDate,
    maxWalkKm: options.maxWalkKm, maxTransfers: options.maxTransfers, horizonMinutes,
    maxStreetKm: request.maxStreetKm ?? request.maxDistanceKm ?? (mode === 'drive' ? 750 : 50),
    routingDataMode: options.routingDataMode,
  }
  for (const key of ['requireTransitRide', 'allowLongWalk', 'disableCache', 'allowStreetTransfers',
    'minimumTransferBufferMinutes', 'arrivalBufferMinutes', 'includeJourneys', 'includeGeometry', 'walkSpeedKph', 'flex', 'bike']) {
    if (request[key] !== undefined) nativeRequest[key] = request[key]
  }
  if (options.routingDataMode === 'realtime' && mode === 'drive') nativeRequest.traffic = request.traffic
  const detailed = value(args, 'stream-output') === 'detailed' || value(args, 'diagnostics', String(request.diagnostics ?? '')) === 'trace'
  // The legacy analytical contract contains every timed leg, without Studio
  // presentation records. Geometry or an explicit full format opts into them.
  const compactJourneys = detailed && request.includeJourneys === true
    && request.includeGeometry !== true && request.journeyFormat !== 'full'
  if (request.journeyFormat !== undefined) nativeRequest.journeyFormat = request.journeyFormat
  else if (compactJourneys) nativeRequest.journeyFormat = 'compact'
  const { trace, openMs } = await queryNativeCity(paths.cityPath, nativeRequest)
  // Public Matrix output consumes native arrays directly. Only the explicit
  // legacy detailed stream needs flat rows and Studio journey adaptation.
  const matrix = { diagnostics: trace.diagnostics, rows: detailed ? origins.flatMap((origin, i) => destinations.map((destination, j) => {
    const duration = trace.durationsMinutes[i][j]
    const ready = Number.isFinite(duration) && duration >= 0
    const rawJourney = trace.journeys?.[i]?.[j]
    const journey = rawJourney ? compactJourneys ? analyticalJourney(rawJourney) : studioRouteResponse({ ...rawJourney, serviceDate: trace.serviceDate,
      status: 'ready', mode: rawJourney.mode ?? mode },
      { ...nativeRequest, origin: origin.point, destination: destination.point,
        departMinutes: options.timeMinutes, serviceDay: options.serviceDay }).choices[0] : undefined
    return { originIndex: i, destinationIndex: j, originId: origin.id, destinationId: destination.id,
      status: ready ? 'ready' : 'blocked', durationMinutes: ready ? duration : null,
      departMinutes: ready ? (options.timePreference === 'arrive' ? options.timeMinutes - duration : options.timeMinutes) : null,
      arriveMinutes: ready ? (options.timePreference === 'arrive' ? options.timeMinutes : options.timeMinutes + duration) : null,
      ...(trace.distancesMeters ? { distanceKm: ready ? trace.distancesMeters[i][j] / 1000 : null } : {}),
      ...(journey ? { journey } : {}) }
  })) : undefined }
  const assemblyStarted = performance.now()
  const payload = {
    schemaVersion: 'vigo.result.matrix.v1',
    ...publicResultMetadata,
    kind: 'matrix',
    ...(trace.clockDate ? { clockDate: trace.clockDate } : {}),
    status: 'ready',
    city,
    warnings: request.includeLimitations === true ? readNationalGtfsStoreMetadata(storePath).routingLimitations ?? [] : [],
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
      ...(request.allowStreetTransfers !== undefined ? { allowStreetTransfers: request.allowStreetTransfers } : {}),
      ...(request.minimumTransferBufferMinutes !== undefined ? { minimumTransferBufferMinutes: request.minimumTransferBufferMinutes } : {}),
      ...(request.arrivalBufferMinutes !== undefined ? { arrivalBufferMinutes: request.arrivalBufferMinutes } : {}),
      disableCache: request.disableCache === true,
    },
    ...(detailed ? { rows: matrix.rows } : { durationsMinutes: trace.durationsMinutes,
      ...(trace.distancesMeters ? { distancesMeters: trace.distancesMeters } : {}),
      ...(trace.journeys ? { journeys: trace.journeys } : {}) }),
    diagnostics: matrix.diagnostics,
    timing: {
      computeMs: Number((assemblyStarted - queryStarted).toFixed(3)),
      openMs,
      requestPreparationMs: Number((queryStarted - preparationStarted).toFixed(3)),
      resultAssemblyMs: Number((performance.now() - assemblyStarted).toFixed(3)),
    },
  }
  return payload
}

async function runMatrix(args: CliArguments) {
  const request = await readStructuredRequest(args, 'matrix')
  const paths = resolveRuntimePaths(args)
  if (Object.hasOwn(request, 'monteCarlo')) {
    try {
      writeJsonResult(await computeDistribution(args, request, paths, 'matrix'), value(args, 'output'), value(args, 'format', 'auto'))
    } finally {
      closeNativeCity()
    }
    return
  }
  assertMatrixSize((request.origins as unknown[])?.length, (request.destinations as unknown[])?.length)
  const options = analyticalRuntimeOptions(args, 'matrix', request)
  const payload = await computePreparedMatrix(args, request, paths, options, openStopLookup(paths.storePath))
  writeJsonResult(publicResult({ ...payload, timing: { ...payload.timing,
    endToEndMs: Number((performance.now() - cliStartedAt).toFixed(3)),
  } }, request, args), value(args, 'output'), value(args, 'format', 'auto'))
}

// Simulation has its own result contract. Keep the native request intact so
// its validation, sample plan, provenance and bounded observation storage are
// identical for the CLI, Python and HTTP interfaces. Ordinary queries never
// enter this path or allocate simulation state.
async function computeDistribution(
  args: CliArguments, request: Record<string, any>,
  paths: ReturnType<typeof resolveRuntimePaths>, kind: string,
) {
  const input = { ...presentationRequest(request, args), kind } as Record<string, any>
  for (const [option, field] of [['time-preference', 'timePreference'], ['data-mode', 'routingDataMode'], ['service-day', 'serviceDay'], ['objective', 'objective']]) {
    if (args.has(option)) input[field] = value(args, option)
  }
  for (const [option, field] of [['extent-radius', 'extentRadiusKm'], ['walk-speed', 'walkSpeedKph'], ['departure-window', 'departureWindowMinutes']]) {
    if (args.has(option)) input[field] = Number(value(args, option))
  }
  if (input.departureWindowMinutes !== undefined) throw new Error('departureWindowMinutes does not apply to monteCarlo routing')
  if (input.objective !== undefined) {
    if (input.objective !== 'earliest_arrival') throw new Error('objective must be earliest_arrival')
    delete input.objective
  }
  if (kind === 'matrix') {
    // Python and the Node Matrix interface label endpoints with {id, point}.
    // Native points carry the same caller ID directly beside stopId/coordinate.
    for (const key of ['origins', 'destinations']) {
      if (Array.isArray(input[key])) input[key] = input[key].map((entry: any) => {
        if (!entry || typeof entry !== 'object' || !Object.hasOwn(entry, 'point')) return entry
        const point = normalizePublicPoint(typeof entry.point === 'string' ? { stopId: entry.point } : entry.point)
        if (!point || typeof point !== 'object' || Array.isArray(point)) throw new Error('Invalid Matrix point')
        return { ...point, ...(entry.id !== undefined ? { id: String(entry.id) } : {}) }
      })
    }
  }
  const { trace, openMs } = await queryNativeCity(paths.cityPath, input)
  return { ...trace, timing: { ...trace.timing, openMs,
    endToEndMs: Number((performance.now() - cliStartedAt).toFixed(3)) } }
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
    || cutoffs.some((cutoff) => !Number.isFinite(cutoff) || cutoff < 1 || cutoff > 240)
  ) {
    throw new Error('Reach cutoffs must be finite minutes between 1 and 240')
  }
  return cutoffs
}

async function computeReachRequest(
  args: CliArguments, request: Record<string, any>,
  paths: ReturnType<typeof resolveRuntimePaths>,
) {
  if (Object.hasOwn(request, 'monteCarlo')) return computeDistribution(args, request, paths, 'reach')
  if (Object.hasOwn(request, 'allDay')) {
    throw new Error('allDay Reach currently requires the Rust vigo executable or native HTTP endpoint.')
  }
  const { storePath, streetStorePath, city } = paths
  validateWheelchairRequest(city.accessibility?.profile, { ...request,
    mode: value(args, 'mode', String(request.mode ?? 'transit')),
    ...(args.has('data-mode') ? { routingDataMode: value(args, 'data-mode') } : {}),
  })
  if (!streetStorePath) throw new Error('reach requires a City with streets')
  const scenarioState = request.scenario as Record<string, unknown> | undefined
  if (request.traffic || request.live || scenarioState?.traffic || scenarioState?.live) {
    throw new Error('Reach does not support supplied traffic or live transit state.')
  }
  const mode = value(args, 'mode', String(request.mode ?? 'transit'))
  if (!['transit', 'walk', 'drive', 'bike'].includes(mode)) throw new Error('Reach supports transit, walk, drive, or bike.')
  if (args.has('radius') || Object.hasOwn(request, 'radiusKm')) {
    throw new Error('Unknown Reach extent; use --extent-radius or extentRadiusKm')
  }
  const options = analyticalRuntimeOptions(args, 'reach', request)
  // Depart-at Reach spreads from an origin; arrive-by Reach gathers toward a
  // destination. Both are one request form, answered by one runtime.
  const arrive = options.timePreference === 'arrive'
  if (request[arrive ? 'origin' : 'destination'] !== undefined) {
    throw new Error(arrive ? 'Arrive-by Reach takes a destination, not an origin'
      : 'Reach with a destination requires timePreference arrive_by')
  }
  if (request.includeStreetEdges !== undefined && typeof request.includeStreetEdges !== 'boolean') {
    throw new Error('Reach includeStreetEdges must be a boolean')
  }
  const includeStreetEdges = args.has('street-edges') ? enabled(args, 'street-edges') : request.includeStreetEdges === true
  if (request.includeNodes !== undefined && typeof request.includeNodes !== 'boolean') {
    throw new Error('Reach includeNodes must be a boolean')
  }
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
  const hydrated = hydrateScenarioRouteServices(storePath, { storageGeneration: city.revisionId }, {
    ...request, serviceDate: options.serviceDate, serviceDay: options.serviceDay,
  })
  const { scenario } = compileReachScenario(hydrated.scenario)
  const stopLookup = openStopLookup(storePath)
  const place = arrive
    ? analyticalPoint(request.destination, 'Destination', stopLookup)
    : analyticalPoint(request.origin, 'Origin', stopLookup)
  const surfaceSampling = mode === 'drive' || mode === 'bike' ? 'cell-center' : request.surfaceSampling ?? 'street'
  const plannedScenario = nativeScenario(scenario)
  const { trace, openMs, computeMs } = await queryNativeCity(paths.cityPath, {
    kind: 'reach',
    [arrive ? 'destination' : 'origin']: nativePoint(place),
    timePreference: arrive ? 'arrive_by' : 'depart_at',
    serviceDate: options.serviceDate,
    timeMinutes: options.timeMinutes,
    routingDataMode: options.routingDataMode,
    mode,
    surfaceSampling,
    ...(request.bike !== undefined ? { bike: request.bike } : {}),
    maxWalkKm: options.maxWalkKm,
    ...(options.maxTransfers !== undefined ? { maxTransfers: options.maxTransfers } : {}),
    walkSpeedKph,
    cutoffsMinutes,
    rasterSize,
    extentRadiusKm: radiusKm,
    includeStreetEdges,
    // Node evidence is opt-in, as in the runtime: it multiplies the response size.
    includeNodes: request.includeNodes === true,
    // The CLI draws its own contours and areas from the surface.
    reachFormat: 'surface',
    arrayEncoding: 'base64',
    ...(plannedScenario ? { scenario: plannedScenario } : {}),
  })
  const range = nativeReachRange(trace, plannedScenario)
  if (range.surface.values.length !== rasterSize ** 2) throw new Error('VIGO returned an invalid Reach surface')
  const { values, fullValues, fullBounds, bounds } = range.surface
  const contourStarted = performance.now()
  const contours = rasterContours(values, rasterSize, rasterSize, bounds, cutoffsMinutes, 'reach')
  const fullContours = rasterContours(fullValues, rasterSize, rasterSize, fullBounds, cutoffsMinutes, 'reach')
  const areas = rasterAreas(values, rasterSize, rasterSize, bounds, cutoffsMinutes, 'reach')
  const fullAreas = rasterAreas(fullValues, rasterSize, rasterSize, fullBounds, cutoffsMinutes, 'reach')
  const contourMs = performance.now() - contourStarted
  return {
    schemaVersion: 'vigo.result.reach.v1',
    ...publicResultMetadata,
    kind: 'reach',
    status: 'ready',
    city,
    warnings: request.includeLimitations === true ? readNationalGtfsStoreMetadata(storePath).routingLimitations ?? [] : [],
    query: {
      routingDataMode: options.routingDataMode,
      mode,
      surfaceSampling,
      ...(request.bike !== undefined ? { bike: request.bike } : {}),
      [arrive ? 'destination' : 'origin']: place,
      timePreference: arrive ? 'arrive_by' : 'depart_at',
      timeMinutes: options.timeMinutes,
      serviceDate: options.serviceDate,
      serviceDay: options.serviceDay,
      maxWalkKm: options.maxWalkKm,
      maxTransfers: options.maxTransfers,
      walkSpeedKph,
      extentRadiusKm: radiusKm,
      rasterSize,
      cutoffsMinutes,
      includeStreetEdges,
      scenario,
    },
    stops: range.stops,
    scenarioStops: range.scenarioStops,
    surface: { ...range.surface, values: Array.from(values), fullValues: Array.from(fullValues) },
    contours,
    areas,
    fullContours,
    fullAreas,
    diagnostics: range.diagnostics,
    timing: {
      openMs: Number(openMs.toFixed(3)),
      computeMs: Number(computeMs.toFixed(3)),
      contourMs: Number(contourMs.toFixed(3)),
      endToEndMs: Number((performance.now() - cliStartedAt).toFixed(3)),
    },
  }
}

async function runReach(args: CliArguments) {
  const request = await readStructuredRequest(args, 'reach')
  const paths = resolveRuntimePaths(args)
  try {
    writeJsonResult(publicResult(await computeReachRequest(args, request, paths), request, args), value(args, 'output'), value(args, 'format', 'auto'))
  } finally {
    closeNativeCity()
  }
}

// Cities and scenario collections are built by the `vigo` executable. This
// process starts it with the same arguments, forwards termination signals and
// ends the way it ended. The engine stops when this process's end closes its
// standard input, and the next build removes what a stopped build left.
let engineChild: ChildProcess | null = null
function delegateToEngine(argv: string[]) {
  const executable = nativeExecutable()
  if (!executable) {
    throw new Error('Cities are built by the vigo executable. Build it with npm run build:standalone, or set VIGO_STANDALONE_PATH.')
  }
  return new Promise<void>((resolve, reject) => {
    const child = engineChild = spawn(executable, [...argv, '--parent-pipe'], { stdio: ['pipe', 'inherit', 'inherit'] })
    // The engine never reads its input; an error here means it already exited.
    child.stdin?.on('error', () => {})
    const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(signal => [signal, () => { child.kill(signal) }] as const)
    for (const [signal, handler] of handlers) process.on(signal, handler)
    const finish = () => {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler)
      engineChild = null
    }
    child.once('error', (error) => {
      finish()
      reject(error)
    })
    child.once('close', (code, signal) => {
      finish()
      // Without our handler, the same signal ends this process as it ended the engine.
      if (signal) process.kill(process.pid, signal)
      else process.exitCode = code ?? 1
      resolve()
    })
  })
}

async function stopEngine() {
  const child = engineChild
  if (!child) return
  const closed = once(child, 'close').catch(() => {})
  child.kill()
  await closed
}

function writeProductInfo() {
  process.stdout.write(`${JSON.stringify(vigoCapabilities(packageJson.version), null, 2)}\n`)
}

function runInspect(args: CliArguments) {
  const cityValue = value(args, 'city')
  if (!cityValue) throw new Error('inspect requires --city; use vigo capabilities for runtime support')
  const cityPath = path.resolve(cityValue)
  const city = openCity(cityPath) as Record<string, any>
  writeJsonResult(formatPublicResult('info', {}, {
    datasetLimitations: readNationalGtfsStoreMetadata(path.join(cityPath, 'routing', 'project.sqlite')).routingLimitations ?? [],
    schemaVersion: 'vigo.city.inspect.v1',
    productVersion: packageJson.version,
    apiVersion,
    cityFormatVersion,
    kind: 'city',
    name: city.name ?? path.basename(cityPath),
    path: cityPath,
    revisionId: city.revisionId ?? null,
    builtAt: city.builtAt ?? null,
    ...(city.accessibility ? { accessibility: city.accessibility } : {}),
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
  }), value(args, 'output'))
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
  if (before.schema || after.schema) {
    const result = formatPublicResult('compare', {}, { before, after })
    if (result.status === 'error') throw new Error(result.error.message)
    writeJsonResult(result, value(args, 'output'))
    return
  }
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
    if (command === 'build' || command === 'build-scenarios') await delegateToEngine(process.argv.slice(2))
    else if (command === 'capabilities') writeProductInfo()
    else if (command === 'inspect') runInspect(args)
    else if (command === 'reach') await runReach(args)
    else if (command === 'matrix') await runMatrix(args)
    else if (command === 'compare') await runCompare(args)
    else if (command === 'stream') await runRouteStream(args)
    else await runRoute(args)
    closeNativeCity()
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  const command = error instanceof CliUsageError ? error.command : activeCommand
  const descriptor = Object.hasOwn(commands, command) ? commands[command as keyof typeof commands] : undefined
  const publicCommand = descriptor && 'usage' in descriptor ? command : ''
  process.stderr.write(`VIGO${command ? ` ${command}` : ''}: ${message}\n`)
  process.stderr.write(`Run "vigo${publicCommand ? ` ${publicCommand}` : ''} --help" for usage.\n`)
  process.exitCode = 2
} finally {
  closeNativeCity()
  for (const lookup of stopLookups.values()) lookup.close()
  stopLookups.clear()
}
