import {
  directWalkEndToEndLimitKm,
  nationalRoutingAccessPolicy,
  routingHorizonMinutes,
  transitRideRequired,
} from './routing-policy.mjs'
import { currentStreetStoreStorageIdentity } from './store-metadata.mjs'

import crypto from 'node:crypto'
import { createNativeRealtimeSchedule } from '../native-routing-kernel.mjs'
import { numeric } from '../number-utils.mjs'
import { routingDataModeForRequest } from '../routing-data-mode.mjs'
import { stableJson } from '../routing-plan-identity.mjs'
import { runtimeCapacityError, timetableBudgetBytes } from '../runtime/resource-limits.mjs'

const realtimeQueryContext = Symbol('vigo.internal.realtime-query-context')

// Each resident timetable keeps one native schedule and its recent views.
const realtimeSchedules = new WeakMap()
const retainedViews = 4

function normalizeRealtimeSnapshotForRouting(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.incrementality != null && !['FULL_DATASET', 0].includes(value.incrementality)) {
    throw Object.assign(new Error('Realtime routing requires a FULL_DATASET snapshot.'), { statusCode: 400 })
  }
  const tripUpdates = Array.isArray(value.tripUpdates) ? value.tripUpdates : []
  const alerts = Array.isArray(value.alerts) ? value.alerts : undefined
  if (tripUpdates.length > 100_000 || tripUpdates.reduce((total, update) => total + (Array.isArray(update?.stopTimeUpdates) ? update.stopTimeUpdates.length : 0), 0) > 500_000) {
    throw Object.assign(new Error('Realtime snapshot exceeds 100,000 trip updates or 500,000 stop predictions.'), { statusCode: 413 })
  }
  if (!tripUpdates.length && !alerts?.length && !value.inputCoverage?.received) return null
  const feedTimestamp = numeric(value.feedTimestamp, undefined)
  return {
    sourceUrl: String(value.sourceUrl ?? '').trim() || undefined,
    sourceUrls: Array.isArray(value.sourceUrls)
      ? value.sourceUrls.map((sourceUrl) => String(sourceUrl ?? '').trim()).filter(Boolean)
      : [],
    fetchedAt: String(value.fetchedAt ?? '').trim() || undefined,
    feedTimestamp,
    tripUpdates,
    failedFeeds: Array.isArray(value.feeds) ? value.feeds.filter(feed => feed.error).length : 0,
    inputCoverage: value.inputCoverage,
    counts: value.counts && typeof value.counts === 'object' ? value.counts : undefined,
    // Only what the native overlay reads crosses to it; vehicle positions and
    // feed reports stay here.
    overlay: { feedTimestamp, timezone: value.timezone, tripUpdates, alerts },
  }
}

// The schedule retains the timetable's arrays without copying them. Alerts
// resolve stations through parent stops and route selectors through types.
function realtimeSchedule(store, kernel) {
  const retained = realtimeSchedules.get(kernel)
  if (retained) return retained
  const stopIndex = kernel.stopIndex ?? new Map(kernel.stopIds.map((id, index) => [id, index]))
  const stopParents = new Uint32Array(kernel.stopIds.length).fill(0xffff_ffff)
  kernel.stopIds.forEach((id, index) => {
    const parent = stopIndex.get(store.stopRecords?.get(id)?.parent_station)
    if (parent !== undefined) stopParents[index] = parent
  })
  const routeTypes = {}
  for (const routeId of new Set(kernel.routeIds)) {
    const type = Number(store.routeLookup?.get(routeId)?.route_type)
    if (Number.isInteger(type)) routeTypes[routeId] = type
  }
  const text = values => Array.from(values, value => String(value ?? ''))
  const schedule = {
    native: createNativeRealtimeSchedule({
      stopIds: text(kernel.stopIds), tripIds: text(kernel.tripIds), routeIds: text(kernel.routeIds),
      directionIds: text(kernel.directionIds),
      ...(kernel.tripServiceDates ? { tripServiceDates: text(kernel.tripServiceDates) } : {}),
      departureSeconds: kernel.departureSeconds, arrivalSeconds: kernel.arrivalSeconds,
      fromStop: kernel.fromStop, toStop: kernel.toStop, sequence: kernel.sequence,
      segmentRun: kernel.segmentRun, continuityBreak: kernel.continuityBreak,
      canBoard: kernel.canBoard, canAlight: kernel.canAlight, tripStart: kernel.tripStart,
      stopParents, routeTypes,
    }),
    views: new Map(),
  }
  realtimeSchedules.set(kernel, schedule)
  return schedule
}

export function withRealtimeQueryContext(request, observationSeconds = Date.now() / 1000) {
  const mode = routingDataModeForRequest(request)
  if (request[realtimeQueryContext]?.mode === mode) return request
  // Preserve the non-enumerable prepared access controls on local requests.
  const descriptors = Object.getOwnPropertyDescriptors(request)
  delete descriptors[realtimeQueryContext]
  descriptors[realtimeQueryContext] = { enumerable: true, value: {
    mode,
    snapshot: mode === 'realtime' ? normalizeRealtimeSnapshotForRouting(request.realtimeSnapshot) : null,
    nowSeconds: mode === 'realtime' ? observationSeconds : null,
    resolutions: new WeakMap(),
  } }
  return Object.create(Object.getPrototypeOf(request), descriptors)
}

export function attachRoutingDataProvenance(plan, store, request) {
  if (!plan) return plan
  const mode = request[realtimeQueryContext]?.mode ?? routingDataModeForRequest(request)
  const diagnostics = plan.diagnostics ??= {}
  if (mode === 'scheduled') {
    delete diagnostics.realtimeRouting
    if (diagnostics.searchStats) delete diagnostics.searchStats.realtimeRouting
  } else if (!diagnostics.realtimeRouting && plan.travelMode === 'transit') {
    diagnostics.realtimeRouting = {
      mode: 'full-snapshot', status: 'scheduled_fallback',
      fallbackReason: request[realtimeQueryContext]?.snapshot ? 'realtime_search_not_run' : 'realtime_snapshot_unavailable',
      appliedTrips: 0, canceledTrips: 0,
      coverage: { inputUpdates: 0, appliedUpdates: 0, rejectedUpdates: 0, prunedUpdates: 0, complete: false },
    }
  }
  const realtime = diagnostics.realtimeRouting
  const provenance = {
    schemaVersion: 'vigo.routing.data-provenance.v1', mode,
    engineVersion: 'vigo.routing.timetable.v1',
    staticTimetableIdentity: String(store.sourceFingerprint || store.sourceArtifactIdentity),
    streetIdentity: currentStreetStoreStorageIdentity(request.streetStorePath) ?? null,
    serviceDate: diagnostics.resolvedServiceDate ?? diagnostics.serviceDate ?? request.serviceDate ?? null,
    timeZone: store.agencyTimezones[0] || 'UTC',
    serviceDay: request.serviceDay,
    timePreference: request.timePreference === 'arrive' ? 'arrive' : 'depart',
    requestedTimeMinutes: request.timePreference === 'arrive'
      ? request.arriveMinutes ?? request.timeMinutes ?? request.departMinutes
      : request.departMinutes,
    walkingPolicy: { ...nationalRoutingAccessPolicy },
    searchParameters: {
      travelMode: request.mode ?? 'transit',
      objective: request.routingPreference === 'balanced' ? 'balanced' : 'earliest_arrival',
      maxWalkKm: plan.maxWalkKm,
      directWalkLimitKm: directWalkEndToEndLimitKm(request),
      requireTransitRide: transitRideRequired(request),
      maxTransfers: request.maxTransfers ?? null,
      allowStreetTransfers: request.allowStreetTransfers !== false,
      minimumTransferBufferMinutes: request.minimumTransferBufferMinutes ?? 0,
      horizonMinutes: routingHorizonMinutes(request),
      serviceDateFallbackAllowed: request.allowServiceDateFallback === true,
      requireCompleteServiceCoverage: request.requireCompleteServiceCoverage === true,
      transferSemanticsVersion: store.transferSemanticsVersion ?? null,
    },
    realtimeApplied: mode === 'realtime' && ((realtime?.appliedTrips ?? 0) + (realtime?.canceledTrips ?? 0) > 0),
    ...(mode === 'realtime' ? { snapshotId: realtime?.snapshotId ?? null, feedTimestamp: realtime?.feedTimestamp ?? null } : {}),
  }
  provenance.reproducibilityKey = crypto.createHash('sha256').update(stableJson({
    provenance, origin: request.origin, destination: request.destination,
  })).digest('hex')
  diagnostics.routingDataMode = mode
  diagnostics.routingDataProvenance = provenance
  return plan
}

// Freeze one observation time across reverse search, forward materialization,
// and preference verification. A new snapshot compiles a new view in the
// native engine; it never edits the resident scheduled timetable or a search
// already in flight. Views are retained by the snapshot's content and the
// validity of its records at the observation time.
export function realtimeTimetableForRequest(store, kernel, request, serviceDateResolution) {
  const context = request[realtimeQueryContext]
  const snapshot = context?.snapshot
  if (!snapshot) return null
  const serviceDate = serviceDateResolution.resolvedServiceDate
  const previous = context.resolutions.get(kernel)
  if (previous?.serviceDate === serviceDate) return previous.result
  const schedule = realtimeSchedule(store, kernel)
  context.json ??= JSON.stringify(snapshot.overlay)
  context.digest ??= crypto.createHash('sha256').update(context.json).digest('hex')
  const options = { serviceDate, timezone: store.agencyTimezones?.[0] || 'UTC', nowSeconds: context.nowSeconds }
  const key = schedule.native.viewKey(context.digest, options)
  let result = key && schedule.views.get(key)
  if (result) schedule.views.delete(key)
  else result = compileRealtimeTimetable(kernel, schedule.native, context, options, snapshot)
  schedule.views.set(result.diagnostics.snapshotId, result)
  if (schedule.views.size > retainedViews) schedule.views.delete(schedule.views.keys().next().value)
  context.resolutions.set(kernel, { serviceDate, result })
  return result
}

function compileRealtimeTimetable(base, schedule, { json, digest }, options, snapshot) {
  const started = performance.now()
  // A view replaces calls of scheduled trips, so it never exceeds the schedule
  // by more than one call per update. Bound admission before compiling it.
  const calls = base.activeSegmentCount + snapshot.tripUpdates.length
  const estimatedBytes = (base.estimatedBytes ?? base.activeSegmentCount * 96 + base.stopIds.length * 256)
    + Math.max(base.activeSegmentCount, calls) * 96 + calls * 256
  if (estimatedBytes > timetableBudgetBytes) {
    throw runtimeCapacityError(`Realtime reconstruction needs an estimated ${Math.ceil(estimatedBytes / 1024 / 1024)} MiB; the timetable budget is ${Math.floor(timetableBudgetBytes / 1024 / 1024)} MiB.`, 'VIGO_REALTIME_MEMORY_LIMIT')
  }
  const overlay = schedule.apply(json, digest, options)
  const counts = overlay.counts
  const trips = []
  const pairs = overlay.applied
  for (let index = 0; index < pairs.length; index += 2) {
    const update = snapshot.tripUpdates[pairs[index]]
    trips.push({ tripId: base.tripIds[pairs[index + 1]], feedTripId: String(update.tripId ?? update.trip?.tripId) })
  }
  const applied = counts.applied + counts.canceled
  const upstreamRejected = Math.max(0, numeric(snapshot.inputCoverage?.rejected, 0))
  const rejected = counts.feedUpdates - applied + upstreamRejected
  const alerts = overlay.alertDiagnostics
  const diagnostics = {
    mode: 'full-snapshot', snapshotId: overlay.key,
    feedTimestamp: snapshot.feedTimestamp, fetchedAt: snapshot.fetchedAt,
    feedTripUpdates: counts.feedUpdates,
    failedFeeds: snapshot.failedFeeds,
    inputCoverage: snapshot.inputCoverage,
    matchedTripUpdates: applied + counts.duplicate + counts.invalid + counts.unsupported,
    appliedTrips: counts.applied, replacedTrips: counts.applied, canceledTrips: counts.canceled,
    unsupportedTrips: counts.unsupported, dateMismatches: counts.dateMismatches, unmatchedTrips: counts.unmatched,
    invalidTrips: counts.invalid, staleTrips: counts.stale, duplicateTrips: counts.duplicate, prunedTrips: 0,
    pastPrefixTrips: counts.pastPrefixTrips, omittedPastPrefixStops: counts.omittedPastPrefixStops,
    stale: !freshTimestamp(snapshot.feedTimestamp, options.nowSeconds),
    coverage: {
      inputUpdates: counts.feedUpdates + upstreamRejected,
      appliedUpdates: applied, rejectedUpdates: rejected, prunedUpdates: 0,
      failedFeeds: snapshot.failedFeeds,
      complete: rejected === 0 && snapshot.failedFeeds === 0 && (counts.feedUpdates > 0 || snapshot.inputCoverage?.complete === true),
    },
    ...(alerts ? { alerts: JSON.parse(alerts) } : {}),
  }
  const status = applied ? rejected || snapshot.failedFeeds ? 'partial' : counts.applied ? 'applied' : 'cancellations_only'
    : diagnostics.staleTrips > 0 || diagnostics.stale ? 'stale_fallback' : 'no_matches'
  diagnostics.status = status
  if (status === 'stale_fallback') diagnostics.fallbackReason = 'feed_or_record_timestamp_missing_invalid_or_stale'
  const view = overlay.takeView()
  const kernel = view ? realtimeKernel(base, view, diagnostics, started) : base
  diagnostics.activeSegments = kernel.activeSegmentCount
  diagnostics.activeRuns = kernel.runCount
  return { ready: Boolean(view), status, diagnostics, trips, kernel, alerts: overlay.hasAlerts ? overlay : null }
}

// The view shares the schedule's names, stops and transfers; only its segment
// arrays and departure index are new. Native indexes are rebuilt for it.
function realtimeKernel(base, view, diagnostics, started) {
  const kernel = { ...base, ...view, realtimeTripIndices: new Set(view.realtimeTripIndices), realtimeDiagnostics: diagnostics,
    compileMs: Number((performance.now() - started).toFixed(3)), buildMs: 0, memoryDelta: null }
  for (const field of ['nativeTimetableKernel', 'sourceTypedArrayBytes', 'nativeIndexBytes', 'nativeWorkspaceBytes', 'typedArrayBytes', 'estimatedBytes']) delete kernel[field]
  return kernel
}

function freshTimestamp(timestamp, nowSeconds) {
  return Number.isInteger(timestamp) && timestamp > 0 && nowSeconds - timestamp <= 180 && timestamp - nowSeconds <= 60
}

// The Service Alerts that describe one ride: its trip, its route or a stop it
// calls at, during the ride.
export function realtimeRideAlerts(realtimeTimetable, kernel, trip, connections) {
  const alerts = realtimeTimetable?.alerts
  if (!alerts || !connections.length) return undefined
  const stopIndex = kernel.stopIndex ?? new Map(kernel.stopIds.map((id, index) => [id, index]))
  const stops = [connections[0].from_stop_id, ...connections.map(connection => connection.to_stop_id)]
    .map(id => stopIndex.get(id)).filter(stop => stop !== undefined)
  const ride = alerts.alertsForRide(trip, stops, connections[0].departure, connections.at(-1).arrival)
  return ride ? JSON.parse(ride) : undefined
}
