import type { ServiceDay } from '../domain'
import type { ActivityStatus } from './status'
import type { RoutingExecutionStatus, RoutingPlan, RoutingTravelMode } from '../routingModel'

export type RoutingServiceCoverage = {
  schemaVersion: 'vigo.routing.service-coverage.v1'
  scopeCount: number
  completeStartDate?: string
  completeEndDate?: string
  scopes: Array<{ id: string; startDate: string; endDate: string }>
}

export type RoutingServiceDateAvailability = 'unknown' | 'covered' | 'outside'

export type RoutingServiceDateOption = {
  date: string
  relation: 'nearest' | 'earlier' | 'later'
  label: string
  recommended?: boolean
}

export type RoutingServiceDateSuggestion = {
  date: string
  relation: 'earlier' | 'later'
  recommended?: boolean
}

export type RoutingActivity = {
  kind: 'idle' | 'preparing' | 'loading' | 'ready' | 'blocked' | 'error' | 'unsupported'
  status: ActivityStatus
  title: string
  detail: string
}

const routingActivityStatuses: Record<RoutingActivity['kind'], ActivityStatus> = {
  idle: 'idle',
  preparing: 'preparing',
  loading: 'preparing',
  ready: 'ready',
  blocked: 'blocked',
  error: 'error',
  unsupported: 'blocked',
}

type RoutingPlanRuntime = {
  engineMs?: number
  totalMs?: number
  label: string
  title: string
}

function finiteRuntimeMs(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function formatRuntimeMs(value: number) {
  if (value < 0.1) return '<0.1 ms'
  if (value < 10) return `${value.toFixed(1)} ms`
  return `${Math.round(value)} ms`
}

export function routingPlanRuntime(plan: RoutingPlan): RoutingPlanRuntime | null {
  const searchStats = plan.diagnostics.searchStats
  const totalMs = finiteRuntimeMs(searchStats?.queryMs)
  const engineMs = finiteRuntimeMs(searchStats?.engineQueryMs)
  if (totalMs === undefined && engineMs === undefined) return null
  if (engineMs !== undefined && totalMs !== undefined) {
    return {
      engineMs,
      totalMs,
      label: `${formatRuntimeMs(engineMs)} engine · ${formatRuntimeMs(totalMs)} total`,
      title: `Exact route search: ${engineMs} ms engine; ${totalMs} ms including access and materialization.`,
    }
  }
  const runtimeMs = totalMs ?? engineMs!
  return {
    engineMs,
    totalMs,
    label: `${formatRuntimeMs(runtimeMs)} route`,
    title: `Exact route search: ${runtimeMs} ms.`,
  }
}

function padCalendarPart(value: number) {
  return String(value).padStart(2, '0')
}

function padCalendarYear(value: number) {
  return String(value).padStart(4, '0')
}

export function localCalendarDate(date = new Date()) {
  return [
    padCalendarYear(date.getFullYear()),
    padCalendarPart(date.getMonth() + 1),
    padCalendarPart(date.getDate()),
  ].join('-')
}

export function serviceDayForCalendarDate(calendarDate: string): ServiceDay {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(calendarDate)
  if (!match) throw new Error('A valid service date is required to derive service day.')
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(12, 0, 0, 0)
  if (
    year < 1
    || year > 9999
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) throw new Error(`Invalid service date: ${calendarDate}`)
  const weekday = date.getUTCDay()
  if (weekday === 0) return 'sunday'
  if (weekday === 6) return 'saturday'
  return 'weekday'
}

export function routingServiceDateAvailability(
  coverage: RoutingServiceCoverage | null,
  serviceDate: string,
): RoutingServiceDateAvailability {
  if (!coverage?.completeStartDate || !coverage.completeEndDate) return 'unknown'
  return serviceDate < coverage.completeStartDate || serviceDate > coverage.completeEndDate
    ? 'outside'
    : 'covered'
}

function routingServiceCoverageDetail(coverage: RoutingServiceCoverage | null) {
  if (!coverage?.completeStartDate || !coverage.completeEndDate) return 'The stored timetable does not publish a complete date range.'
  const scopeLabel = coverage.scopeCount > 1 ? `all ${coverage.scopeCount} feeds` : 'this feed'
  return `${scopeLabel} overlap from ${coverage.completeStartDate} through ${coverage.completeEndDate}.`
}

function offsetLocalCalendarDate(date: Date, days: number) {
  // Do not use the multi-argument Date constructor here: years 0 through 99
  // are interpreted as 1900 through 1999 by that constructor. setFullYear()
  // preserves the YYYY-MM-DD format while retaining noon as the DST-safe
  // civil-time anchor used by the date picker.
  const shifted = new Date(0)
  shifted.setFullYear(date.getFullYear(), date.getMonth(), date.getDate() + days)
  shifted.setHours(12, 0, 0, 0)
  return shifted
}

function parseLocalCalendarDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  if (year < 1 || year > 9999) return null
  const date = new Date(0)
  date.setFullYear(year, Number(match[2]) - 1, Number(match[3]))
  date.setHours(12, 0, 0, 0)
  return localCalendarDate(date) === value ? date : null
}

function dateOptionLabel(date: Date) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[date.getMonth()]} ${date.getDate()}`
}

function alignCalendarWeekday(date: Date, weekday: number, direction: -1 | 1) {
  let aligned = date
  for (let offset = 0; offset < 7 && aligned.getDay() !== weekday; offset += 1) {
    aligned = offsetLocalCalendarDate(aligned, direction)
  }
  return aligned
}

export function routingServiceDateOptions(
  coverage: RoutingServiceCoverage | null,
  requestedServiceDate: string,
  exactSuggestions?: RoutingServiceDateSuggestion[],
): RoutingServiceDateOption[] {
  const requested = parseLocalCalendarDate(requestedServiceDate)
  if (requested && exactSuggestions) {
    const seen = new Set<string>()
    return exactSuggestions.flatMap((suggestion) => {
      const date = parseLocalCalendarDate(suggestion.date)
      if (!date || suggestion.date === requestedServiceDate || seen.has(suggestion.date)) return []
      seen.add(suggestion.date)
      const relation = date < requested ? 'earlier' : 'later'
      const recommended = suggestion.recommended === true
      const prefix = recommended
        ? 'Recommended'
        : `${relation[0].toUpperCase()}${relation.slice(1)}`
      return [{
        date: suggestion.date,
        relation,
        recommended,
        label: `${prefix} · ${dateOptionLabel(date)}`,
      }]
    })
  }
  const start = coverage?.completeStartDate ? parseLocalCalendarDate(coverage.completeStartDate) : null
  const end = coverage?.completeEndDate ? parseLocalCalendarDate(coverage.completeEndDate) : null
  if (!requested || !start || !end || start > end) return []

  let nearest = requested
  let outsideDirection: -1 | 0 | 1 = 0
  if (requested < start) {
    nearest = alignCalendarWeekday(start, requested.getDay(), 1)
    outsideDirection = 1
  } else if (requested > end) {
    nearest = alignCalendarWeekday(end, requested.getDay(), -1)
    outsideDirection = -1
  }
  if (nearest < start || nearest > end) return []

  const candidates: Array<{ date: Date; relation: RoutingServiceDateOption['relation'] }> = [
    { date: nearest, relation: 'nearest' },
  ]
  if (outsideDirection <= 0) {
    const earlier = offsetLocalCalendarDate(nearest, -7)
    if (earlier >= start) candidates.push({ date: earlier, relation: 'earlier' })
  }
  if (outsideDirection >= 0) {
    const later = offsetLocalCalendarDate(nearest, 7)
    if (later <= end) candidates.push({ date: later, relation: 'later' })
  }

  return candidates.map(({ date, relation }) => ({
    date: localCalendarDate(date),
    relation,
    label: `${relation[0].toUpperCase()}${relation.slice(1)} · ${dateOptionLabel(date)}`,
  }))
}

type RoutingLeg = RoutingPlan['legs'][number]

function sameRoutingEndpoint(leg: RoutingLeg) {
  if (leg.fromStopId && leg.toStopId && leg.fromStopId === leg.toStopId) return true
  const fromName = leg.fromName.trim().toLocaleLowerCase()
  const toName = leg.toName.trim().toLocaleLowerCase()
  return Boolean(fromName && fromName === toName)
}

function isNoOpWalkLeg(leg: RoutingLeg) {
  return leg.type === 'walk'
    && leg.durationMinutes <= 0
    && leg.distanceKm <= 0
    && sameRoutingEndpoint(leg)
}

function mergedWalkCoordinates(left: RoutingLeg, right: RoutingLeg) {
  const coordinates = [...left.coordinates]
  for (const coordinate of right.coordinates) {
    const previous = coordinates.at(-1)
    if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) coordinates.push(coordinate)
  }
  return coordinates
}

function mergedWalkSource(left: RoutingLeg, right: RoutingLeg): RoutingLeg['walkSource'] {
  if (left.walkSource === 'osm' || right.walkSource === 'osm') return 'osm'
  if (left.walkSource === 'transfer' && right.walkSource === 'transfer') return 'transfer'
  return 'direct'
}

function mergeWalkLegs(left: RoutingLeg, right: RoutingLeg): RoutingLeg {
  return {
    ...left,
    travelMode: 'walk',
    walkSource: mergedWalkSource(left, right),
    transferSource: left.transferSource === right.transferSource ? left.transferSource : undefined,
    geometrySource: left.geometrySource === right.geometrySource ? left.geometrySource : undefined,
    streetPathVerified: left.streetPathVerified === true && right.streetPathVerified === true,
    stationAccessStatus: left.stationAccessStatus === 'unverified' || right.stationAccessStatus === 'unverified'
      ? 'unverified' : left.stationAccessStatus ?? right.stationAccessStatus,
    stationAccessStopIds: [...new Set([...(left.stationAccessStopIds ?? []), ...(right.stationAccessStopIds ?? [])])],
    streetSegmentVerified: (left.streetSegmentVerified ?? left.streetPathVerified) === true
      && (right.streetSegmentVerified ?? right.streetPathVerified) === true,
    toStopId: right.toStopId,
    toName: right.toName,
    endMinutes: right.endMinutes,
    durationMinutes: Math.max(
      left.durationMinutes + right.durationMinutes,
      right.endMinutes - left.startMinutes,
    ),
    distanceKm: left.distanceKm + right.distanceKm,
    stopCount: left.stopCount + right.stopCount,
    coordinates: mergedWalkCoordinates(left, right),
  }
}

function normalizeRoutingLegs(legs: RoutingPlan['legs']) {
  const normalized: RoutingPlan['legs'] = []
  let changed = false
  for (const leg of legs) {
    if (isNoOpWalkLeg(leg)) {
      changed = true
      continue
    }
    const previous = normalized.at(-1)
    if (previous?.type === 'walk' && leg.type === 'walk') {
      normalized[normalized.length - 1] = mergeWalkLegs(previous, leg)
      changed = true
      continue
    }
    normalized.push(leg)
  }
  return changed ? normalized : legs
}

function itineraryWaitMinutes(legs: RoutingPlan['legs'], departMinutes: number) {
  let waitMinutes = 0
  let previousEnd = departMinutes
  for (const leg of legs) {
    waitMinutes += Math.max(0, leg.startMinutes - previousEnd)
    previousEnd = Math.max(previousEnd, leg.endMinutes)
  }
  return waitMinutes
}

function deferInitialWalk(plan: RoutingPlan, legs: RoutingPlan['legs']): RoutingPlan | null {
  if (plan.status !== 'ready' || plan.travelMode !== 'transit' || plan.timePreference !== 'depart') return null
  const initialWalk = legs[0]
  if (initialWalk?.type !== 'walk') return null
  const firstRideIndex = legs.findIndex((leg) => leg.type === 'ride')
  if (firstRideIndex !== 1) return null

  const walkDurationMinutes = Math.max(0, initialWalk.durationMinutes)
  const displayedDepartMinutes = legs[firstRideIndex].startMinutes - walkDurationMinutes
  const deferredInitialWaitMinutes = displayedDepartMinutes - plan.departMinutes
  if (!(deferredInitialWaitMinutes > 0)) return null
  const departureWindowCenterMinutes = Number(plan.diagnostics.departureWindow?.centerMinutes)
  const requestedDepartMinutes = Number.isFinite(departureWindowCenterMinutes)
    ? departureWindowCenterMinutes
    : plan.departMinutes

  const shiftedLegs = [
    {
      ...initialWalk,
      startMinutes: displayedDepartMinutes,
      endMinutes: legs[firstRideIndex].startMinutes,
    },
    ...legs.slice(1),
  ]
  const arriveMinutes = Number.isFinite(plan.arriveMinutes)
    ? Number(plan.arriveMinutes)
    : plan.departMinutes + plan.durationMinutes
  return {
    ...plan,
    departMinutes: displayedDepartMinutes,
    durationMinutes: Math.max(0, arriveMinutes - displayedDepartMinutes),
    waitMinutes: itineraryWaitMinutes(shiftedLegs, displayedDepartMinutes),
    legs: shiftedLegs,
    diagnostics: {
      ...plan.diagnostics,
      departurePresentation: {
        requestedDepartMinutes,
        displayedDepartMinutes,
        deferredInitialWaitMinutes,
        strategy: 'just-in-time-initial-walk',
      },
    },
  }
}

export function normalizeReceivedRoutingPlan(plan: RoutingPlan): RoutingPlan {
  const legs = normalizeRoutingLegs(plan.legs)
  const legNormalizedPlan = legs === plan.legs ? plan : {
    ...plan,
    legs,
    walkMinutes: legs.reduce((sum, leg) => sum + (leg.type === 'walk' ? leg.durationMinutes : 0), 0),
  }
  const normalizedPlan = deferInitialWalk(legNormalizedPlan, legs) ?? legNormalizedPlan
  const hasScheduledRide = legs.some((leg) => leg.type === 'ride')
  if (plan.status !== 'ready' || plan.travelMode !== 'transit' || hasScheduledRide) return normalizedPlan

  return {
    ...normalizedPlan,
    id: `${plan.id}-rejected-zero-ride`,
    status: 'blocked',
    choiceLabel: 'Invalid transit result rejected',
    recommended: true,
    title: 'No scheduled ride',
    detail: 'The route engine returned only access or transfer walking. VIGO rejected it as a Transit itinerary.',
    arriveMinutes: undefined,
    durationMinutes: 0,
    waitMinutes: 0,
    walkMinutes: 0,
    rideMinutes: 0,
    transfers: 0,
    legs: [],
    diagnostics: {
      ...plan.diagnostics,
      optimality: 'rejected_zero_ride_transit_plan',
    },
  }
}

function routingChoiceArrival(plan: RoutingPlan) {
  return Number.isFinite(plan.arriveMinutes)
    ? Number(plan.arriveMinutes)
    : plan.departMinutes + plan.durationMinutes
}

/** Time spent moving through the displayed itinerary, excluding the wait
 * before the displayed leave time. */
export function routingPlanJourneyMinutes(plan: RoutingPlan) {
  return Math.max(0, routingChoiceArrival(plan) - plan.departMinutes)
}

/**
 * Pre-journey delay between the user's requested depart-at time and the
 * displayed leave time. It remains part of choice ranking even when the
 * presentation moves an initial access walk just before the first vehicle.
 */
export function routingPlanStartWaitMinutes(plan: RoutingPlan) {
  if (plan.timePreference !== 'depart') return 0
  const requestedDepartMinutes = Number(
    plan.diagnostics.departurePresentation?.requestedDepartMinutes
      ?? plan.diagnostics.departureWindow?.centerMinutes,
  )
  if (!Number.isFinite(requestedDepartMinutes)) return 0
  return Math.max(0, plan.departMinutes - requestedDepartMinutes)
}

/** All waiting attributable to this result, including the initial wait after
 * the user's requested departure and waits between itinerary legs. */
export function routingPlanTotalWaitMinutes(plan: RoutingPlan) {
  const inJourneyWaitMinutes = Number.isFinite(plan.waitMinutes)
    ? Math.max(0, plan.waitMinutes)
    : 0
  return routingPlanStartWaitMinutes(plan) + inJourneyWaitMinutes
}

/** Door-to-door elapsed time from the user's requested depart-at time. */
export function routingPlanTotalElapsedMinutes(plan: RoutingPlan) {
  return routingPlanJourneyMinutes(plan) + routingPlanStartWaitMinutes(plan)
}

type ServiceDateDiagnostics = RoutingPlan['diagnostics'] & {
  requestedServiceDate?: string
  resolvedServiceDate?: string
  serviceDateFallbackApplied?: boolean
}

function routingPlanServiceDateContext(plan: RoutingPlan, requestedServiceDate: string) {
  const diagnostics = plan.diagnostics as ServiceDateDiagnostics
  const requested = diagnostics.requestedServiceDate || diagnostics.serviceDate || requestedServiceDate
  const resolved = diagnostics.resolvedServiceDate || diagnostics.serviceDate || requestedServiceDate
  const fallbackApplied = diagnostics.serviceDateFallbackApplied === true || resolved !== requested
  return { requested, resolved, fallbackApplied }
}

function routingPlanServiceDateDetail(plan: RoutingPlan, requestedServiceDate: string) {
  const { requested, resolved, fallbackApplied } = routingPlanServiceDateContext(plan, requestedServiceDate)
  return fallbackApplied
    ? `${resolved} timetable · fallback from ${requested}`
    : `${resolved} exact service date`
}

export function buildRoutingActivity({
  routingError,
  routingErrorStatus,
  routingPlan,
  storeBackedRouting,
  routingStoreReady,
  hasOrigin,
  hasDestination,
  routingStreetState,
  routingLoading,
  routingInputReady,
  routingServiceDate,
  routingMode = 'transit',
  routingServiceDateAvailability = 'unknown',
  routingServiceCoverage = null,
}: {
  routingError: string
  routingErrorStatus?: RoutingExecutionStatus
  routingPlan: RoutingPlan | null
  storeBackedRouting: boolean
  routingStoreReady: boolean
  hasOrigin: boolean
  hasDestination: boolean
  routingStreetState: 'ready' | 'loading' | 'missing'
  routingLoading: boolean
  routingInputReady: boolean
  routingServiceDate: string
  routingMode?: RoutingTravelMode
  routingServiceDateAvailability?: RoutingServiceDateAvailability
  routingServiceCoverage?: RoutingServiceCoverage | null
}): RoutingActivity {
  const activity = (
    kind: RoutingActivity['kind'],
    title: string,
    detail: string,
  ): RoutingActivity => ({
    kind,
    status: routingActivityStatuses[kind],
    title,
    detail,
  })

  if (routingError) return activity(
    routingErrorStatus === 'unsupported' ? 'unsupported' : 'error',
    routingErrorStatus === 'stale' ? 'Rebuild required' : 'Routing request failed',
    routingError,
  )
  if (routingMode === 'transit' && routingServiceDateAvailability === 'outside') return activity(
    'blocked',
    'Date outside timetable',
    `${routingServiceDate} is outside complete local coverage; ${routingServiceCoverageDetail(routingServiceCoverage)} Choose a date in range or explicitly use the nearest available timetable.`,
  )
  if (routingPlan?.status === 'blocked') return activity(
    routingPlan.diagnostics.routingStatus === 'unsupported'
      || routingPlan.diagnostics.failureCategory === 'unsupported_feature'
      ? 'unsupported'
      : routingPlan.diagnostics.routingStatus === 'stale' ? 'error' : 'blocked',
    routingPlan.diagnostics.routingStatus === 'stale' ? 'Rebuild required' : routingPlan.title,
    routingPlan.detail,
  )
  if (routingPlan?.status === 'ready') return activity(
    'ready',
    routingPlan.title,
    routingPlan.travelMode === 'transit'
      ? routingPlanServiceDateDetail(routingPlan, routingServiceDate)
      : routingPlan.detail,
  )
  if (storeBackedRouting && !routingStoreReady) return routingMode === 'transit'
    ? activity('preparing', 'Opening SQLite timetable', `Opening the local routing database for ${routingServiceDate}. You can pick A and B now.`)
    : activity('preparing', 'Opening OSM street snapshot', `Opening the local sealed ${routingMode} street snapshot. You can pick A and B now.`)
  if (hasOrigin && hasDestination && routingStreetState === 'loading') return activity('preparing', 'Preparing street snapshot', 'Opening the sealed OSM street snapshot for A/B access. Your points are saved.')
  if (hasOrigin && hasDestination && routingStreetState === 'missing') return activity('blocked', 'Street snapshot required', 'Load or rebuild the OSM street snapshot to calculate a route between map points.')
  if (hasOrigin && hasDestination && (routingLoading || (storeBackedRouting && routingInputReady))) return routingMode === 'transit'
    ? activity('loading', 'Finding exact journey', `Searching ${routingServiceDate} timetable service and OSM access paths.`)
    : activity('loading', `Finding exact ${routingMode} route`, `Searching the directed OSM ${routingMode} network.`)
  if (hasOrigin && hasDestination) return activity('idle', 'No path yet', `A and B are saved for ${routingServiceDate}. Adjust time or walking distance and try again.`)
  if (hasOrigin) return activity('idle', 'Pick destination', 'Starting point is saved. Click once more to place the destination.')
  return activity('idle', 'Pick origin', 'Click the map to set a starting point, then add a destination.')
}
