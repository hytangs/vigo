import {
  directWalkEndToEndLimitKm,
  nationalRoutingAccessPolicy,
  routingHorizonMinutes,
  transitRideRequired,
} from './routing-policy.mjs'
import { currentStreetStoreStorageIdentity } from './store-metadata.mjs'

import crypto from 'node:crypto'
import { numeric } from '../number-utils.mjs'
import { compileRealtimeTimetableKernel } from '../realtime-timetable-kernel.mjs'
import { resolveRealtimeTripTimes } from '../realtime-trip-timing.mjs'
import { routingDataModeForRequest } from '../routing-data-mode.mjs'
import { stableJson } from '../routing-plan-identity.mjs'

const realtimeQueryContext = Symbol('vigo.internal.realtime-query-context')

const realtimeTimetableCache = new WeakMap()

const realtimeTripLookupCache = new WeakMap()

const realtimeTimezoneFormatterCache = new Map()

function normalizeRealtimeSnapshotForRouting(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const tripUpdates = Array.isArray(value.tripUpdates) ? value.tripUpdates : []
  if (!tripUpdates.length && !value.inputCoverage?.received) return null
  return {
    sourceUrl: String(value.sourceUrl ?? '').trim() || undefined,
    sourceUrls: Array.isArray(value.sourceUrls)
      ? value.sourceUrls.map((sourceUrl) => String(sourceUrl ?? '').trim()).filter(Boolean)
      : [],
    fetchedAt: String(value.fetchedAt ?? '').trim() || undefined,
    feedTimestamp: numeric(value.feedTimestamp, undefined),
    tripUpdates,
    inputCoverage: value.inputCoverage,
    counts: value.counts && typeof value.counts === 'object' ? value.counts : undefined,
  }
}

function realtimeTripLookup(kernel) {
  const cached = realtimeTripLookupCache.get(kernel)
  if (cached) return cached
  const exact = new Map()
  const suffix = new Map()
  for (let index = 0; index < kernel.tripIds.length; index += 1) {
    const tripId = String(kernel.tripIds[index] ?? '')
    exact.set(tripId, index)
    const baseId = tripId.includes('\u001f') ? tripId.split('\u001f').at(-1) : tripId
    const matches = suffix.get(baseId) ?? []
    matches.push(index)
    suffix.set(baseId, matches)
  }
  const lookup = { exact, suffix }
  realtimeTripLookupCache.set(kernel, lookup)
  return lookup
}

function resolveRealtimeTripIndex(kernel, tripId, sourceScope) {
  const normalizedTripId = String(tripId ?? '').trim()
  if (!normalizedTripId) return undefined
  const lookup = realtimeTripLookup(kernel)
  const matches = normalizedTripId.includes('\u001f')
    ? [lookup.exact.get(normalizedTripId)].filter(index => index !== undefined)
    : lookup.suffix.get(normalizedTripId) ?? []
  const scoped = sourceScope == null ? matches : matches.filter(index => (
    String(kernel.tripIds[index]).split('\u001f')[0] === String(sourceScope)
  ))
  return scoped.length === 1 ? scoped[0] : undefined
}

function realtimeTripRelationship(value) {
  if (value === undefined || value === null || value === '') return 'SCHEDULED'
  if (typeof value === 'number') {
    return { 0: 'SCHEDULED', 1: 'ADDED', 2: 'UNSCHEDULED', 3: 'CANCELED', 5: 'REPLACEMENT', 6: 'DUPLICATED', 7: 'DELETED' }[value] ?? 'UNKNOWN'
  }
  return String(value).trim().toUpperCase()
}

function realtimeServiceDateToken(serviceDate) {
  return String(serviceDate ?? '').replaceAll('-', '')
}

function realtimeTimezoneFormatter(timezone) {
  const key = String(timezone || 'UTC')
  const cached = realtimeTimezoneFormatterCache.get(key)
  if (cached) return cached
  let formatter
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: key,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
  } catch {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
  }
  realtimeTimezoneFormatterCache.set(key, formatter)
  return formatter
}

// One clock per snapshot build keeps reuse inside its service date/timezone.
function realtimeServiceClock(serviceDate, timezone) {
  const date = String(serviceDate ?? '').split('-').map(Number)
  if (date.length !== 3 || date.some(part => !Number.isInteger(part))) return () => undefined
  const serviceMidnight = Date.UTC(date[0], date[1] - 1, date[2])
  const formatter = realtimeTimezoneFormatter(timezone), secondsByEpoch = new Map()
  return epochSeconds => {
    const epoch = numeric(epochSeconds, Number.NaN)
    if (!Number.isFinite(epoch)) return undefined
    if (secondsByEpoch.has(epoch)) return secondsByEpoch.get(epoch)
    const parts = {}
    for (const part of formatter.formatToParts(new Date(epoch * 1000))) {
      if (part.type !== 'literal') parts[part.type] = Number(part.value)
    }
    const dayOffset = Math.round((Date.UTC(parts.year, parts.month - 1, parts.day) - serviceMidnight) / 86_400_000)
    const seconds = dayOffset * 86_400 + parts.hour * 3_600 + parts.minute * 60 + parts.second
    secondsByEpoch.set(epoch, seconds)
    return seconds
  }
}

function realtimeStaticTripStopTimes(store, tripId) {
  if (store.realtimeTripStopTimesLookup) {
    return store.realtimeTripStopTimesLookup.all(tripId)
  }
  const connections = store.realtimeTripConnectionsLookup.all(tripId)
  if (!connections.length) return []
  const stopTimes = [{
    stop_sequence: connections[0].stop_sequence,
    stop_id: connections[0].from_stop_id,
    arrival: connections[0].departure,
    departure: connections[0].departure,
    can_board: 1,
    can_alight: 1,
  }]
  for (let index = 0; index < connections.length; index += 1) {
    const connection = connections[index]
    const next = connections[index + 1]
    stopTimes.push({
      stop_sequence: next?.stop_sequence ?? Number(connection.stop_sequence) + 1,
      stop_sequence_inferred: !next,
      stop_id: connection.to_stop_id,
      arrival: connection.arrival,
      departure: next && next.from_stop_id === connection.to_stop_id
        ? next.departure
        : connection.arrival,
      can_board: 1,
      can_alight: 1,
    })
  }
  return stopTimes
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
// and preference verification. A refreshed snapshot creates a new kernel; it
// never edits the resident scheduled timetable or a search already in flight.
export function realtimeTimetableForRequest(store, kernel, request, serviceDateResolution) {
  const context = request[realtimeQueryContext]
  const snapshot = context?.snapshot
  if (!snapshot) return null
  const serviceDate = serviceDateResolution.resolvedServiceDate
  const serviceDateToken = realtimeServiceDateToken(serviceDate)
  const previous = context.resolutions.get(kernel)
  if (previous?.serviceDate === serviceDate) return previous.result
  const now = context.nowSeconds
  const fresh = timestamp => typeof timestamp === 'number' && Number.isFinite(timestamp)
    && timestamp > 0 && now - timestamp <= 180 && timestamp - now <= 60
  // Timestamp validity is part of the cache identity, so cached predictions
  // expire even when the same snapshot is repeatedly submitted.
  const validity = snapshot.tripUpdates.map(update => [
    fresh(update?.sourceFeedTimestamp ?? snapshot.feedTimestamp),
    update?.timestamp == null || fresh(update.timestamp),
    (update?.sourceFeedTimestamp ?? snapshot.feedTimestamp) <= now
      && (update?.timestamp == null || update.timestamp <= now),
  ])
  const cacheKey = crypto.createHash('sha256').update(stableJson({
    snapshot, serviceDate, timetableIdentity: kernel.sourceArtifactIdentity ?? kernel.sourceStorageIdentity,
    serviceKey: kernel.serviceKey, feedFresh: fresh(snapshot.feedTimestamp), validity,
  })).digest('hex')
  const cached = realtimeTimetableCache.get(kernel)
  if (cached?.key === cacheKey) {
    context.resolutions.set(kernel, { serviceDate, result: cached.result })
    return cached.result
  }
  const diagnostics = {
    mode: 'full-snapshot', snapshotId: cacheKey,
    feedTimestamp: snapshot.feedTimestamp, fetchedAt: snapshot.fetchedAt,
    feedTripUpdates: snapshot.tripUpdates.length,
    inputCoverage: snapshot.inputCoverage,
    matchedTripUpdates: 0, appliedTrips: 0, replacedTrips: 0, canceledTrips: 0,
    unsupportedTrips: 0, dateMismatches: 0, unmatchedTrips: 0,
    invalidTrips: 0, staleTrips: 0, duplicateTrips: 0, prunedTrips: 0,
    pastPrefixTrips: 0, omittedPastPrefixStops: 0,
    stale: !fresh(snapshot.feedTimestamp),
  }
  const replacements = new Map(), canceledTrips = new Set(), trips = []
  const resolved = snapshot.tripUpdates.map(update => resolveRealtimeTripIndex(kernel, update?.tripId, update?.sourceScope))
  const identities = new Map()
  for (let index = 0; index < resolved.length; index++) {
    const trip = resolved[index], update = snapshot.tripUpdates[index]
    if (trip !== undefined && validity[index][0] && validity[index][1]
      && (!update.startDate || realtimeServiceDateToken(update.startDate) === serviceDateToken)) {
      identities.set(trip, (identities.get(trip) ?? 0) + 1)
    }
  }
  let toServiceSeconds
  for (let index = 0; index < snapshot.tripUpdates.length; index++) {
    const update = snapshot.tripUpdates[index], tripIndex = resolved[index]
    if (!validity[index][0] || !validity[index][1]) { diagnostics.staleTrips++; continue }
    if (tripIndex === undefined) { diagnostics.unmatchedTrips++; continue }
    diagnostics.matchedTripUpdates++
    if (update.startDate && realtimeServiceDateToken(update.startDate) !== serviceDateToken) {
      diagnostics.dateMismatches++; continue
    }
    if (identities.get(tripIndex) !== 1) { diagnostics.duplicateTrips++; continue }
    const tripId = kernel.tripIds[tripIndex]
    const sameId = (left, right) => String(left).includes('\u001f')
      ? String(left) === String(right) : String(left) === String(right).split('\u001f').at(-1)
    if ((update.routeId && !sameId(update.routeId, kernel.routeIds[tripIndex]))
      || (update.directionId != null && String(update.directionId) !== String(kernel.directionIds[tripIndex]))) {
      diagnostics.invalidTrips++; continue
    }
    const relationship = realtimeTripRelationship(update.scheduleRelationship)
    if (relationship === 'CANCELED' || relationship === 'DELETED') {
      canceledTrips.add(tripIndex); diagnostics.canceledTrips++
      trips.push({ tripId, feedTripId: String(update.tripId) })
      continue
    }
    if (relationship !== 'SCHEDULED') { diagnostics.unsupportedTrips++; continue }
    const rows = realtimeStaticTripStopTimes(store, tripId)
    if (rows.length < 2) { diagnostics.invalidTrips++; continue }
    toServiceSeconds ??= realtimeServiceClock(serviceDate, store.agencyTimezones[0] || 'UTC')
    const timing = resolveRealtimeTripTimes(rows, update, toServiceSeconds,
      { nowSeconds: now, feedTimestamp: update.sourceFeedTimestamp ?? snapshot.feedTimestamp })
    if (timing.status !== 'ready') {
      diagnostics[timing.status === 'unsupported' ? 'unsupportedTrips' : 'invalidTrips']++
      continue
    }
    if (timing.omittedPastPrefixStops > 0) {
      diagnostics.pastPrefixTrips++
      diagnostics.omittedPastPrefixStops += timing.omittedPastPrefixStops
    }
    replacements.set(tripIndex, { stopTimes: timing.stopTimes })
    trips.push({ tripId, feedTripId: String(update.tripId) })
  }
  diagnostics.appliedTrips = replacements.size
  diagnostics.replacedTrips = replacements.size
  const applied = replacements.size + canceledTrips.size
  const upstreamRejected = Math.max(0, numeric(snapshot.inputCoverage?.rejected, 0))
  const rejected = snapshot.tripUpdates.length - applied + upstreamRejected
  diagnostics.coverage = {
    inputUpdates: snapshot.tripUpdates.length + upstreamRejected,
    appliedUpdates: applied, rejectedUpdates: rejected, prunedUpdates: 0,
    complete: rejected === 0 && (snapshot.tripUpdates.length > 0 || snapshot.inputCoverage?.complete === true),
  }
  const status = applied ? rejected ? 'partial' : replacements.size ? 'applied' : 'cancellations_only'
    : diagnostics.staleTrips > 0 || diagnostics.stale ? 'stale_fallback' : 'no_matches'
  diagnostics.status = status
  if (status === 'stale_fallback') diagnostics.fallbackReason = 'feed_or_record_timestamp_missing_invalid_or_stale'
  const result = { ready: applied > 0, status, diagnostics, trips,
    kernel: applied ? compileRealtimeTimetableKernel(kernel, { replacements, canceledTrips, diagnostics }) : kernel }
  diagnostics.activeSegments = result.kernel.activeSegmentCount
  diagnostics.activeRuns = result.kernel.runCount
  context.resolutions.set(kernel, { serviceDate, result })
  realtimeTimetableCache.set(kernel, { key: cacheKey, result })
  return result
}
