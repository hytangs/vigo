import { type CSSProperties, type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CalendarDays,
  ChevronRight,
  CheckCircle2,
  Clock3,
  LoaderCircle,
  MapPin,
  MapPinned,
  Navigation2,
  Plus,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react'
import { classNames } from '../domain'
import { formatScheduleClock } from '../scheduledVehicles'
import type {
  RoutingPlan,
  RoutingAccessAvailabilityHint,
  RoutingPoint,
  RoutingTimePreference,
  RoutingTravelMode,
} from '../routingModel'
import {
  formatRoutingLegDuration,
  formatRoutingMinutes,
  isSameStationTransfer,
  routingLegDetail,
  routingLegPrimaryLabel,
  routingPlanRouteSequence,
} from '../app/presentation'
import {
  routingPlanStartWaitMinutes,
  routingPlanJourneyMinutes,
  routingPlanTotalWaitMinutes,
  routingPlanTotalElapsedMinutes,
  routingPlanRuntime,
  type RoutingActivity,
  type RoutingServiceCoverage,
  type RoutingServiceDateAvailability,
  type RoutingServiceDateOption,
} from '../app/routingPlan'
import {
  routingMaxWalkOptions,
  routingTimeOptions,
  type RoutingDepartureWindowMinutes,
} from '../app/uiOptions'
import { maxRoutingPointCount, routingPinLabel, routingPointRoleLabel } from '../routingPointSequence'
import { ResultMetric, StatusBadge } from './UiPrimitives'

export type RoutingLocationCandidate = {
  id: string
  name: string
  coordinate: [number, number]
  platformCount?: number
}

export type RoutingLocationChoice = {
  queryIndex: number
  query: string
  role: string
  routeQueries?: string[]
  options: RoutingLocationCandidate[]
}

export type RoutingScopeStatus = 'ready' | 'building' | 'failed' | 'missing'

const travelModeChoices = [
  ['transit', 'Transit'],
  ['walk', 'Walk'],
  ['drive', 'Drive'],
] as const satisfies ReadonlyArray<readonly [RoutingTravelMode, string]>
const routingModeLabels = Object.fromEntries(travelModeChoices)

function routingChoiceExplanation(plan: RoutingPlan) {
  if (plan.choiceLabel === 'Fastest') {
    return 'Earliest arrival among the displayed journeys, including any wait after the requested time.'
  }
  if (plan.choiceLabel === 'Fewest transfers') {
    return 'Uses the fewest transfers among the displayed journeys.'
  }
  if (plan.choiceLabel === 'Least walking') {
    return 'Requires the least walking among the displayed journeys.'
  }
  if (plan.choiceLabel === 'Shortest journey') {
    return 'Has the shortest leave-to-arrival journey time among the displayed options; waiting after the requested time is shown separately.'
  }
  if (plan.choiceLabel === 'Best balance') return 'Selected from the exact journeys retained for this departure window.'
  if (plan.travelMode === 'walk') return 'A walk-only path on the local directed pedestrian graph.'
  if (plan.travelMode === 'drive') {
    return plan.diagnostics.roadMetricMode === 'traffic-adjusted'
      ? 'The fastest path on the local directed road graph under the supplied traffic snapshot.'
      : 'The fastest free-flow path on the local directed road graph.'
  }
  return 'A distinct journey retained by the displayed-choice filter.'
}

function routingProfileLabel(plan: RoutingPlan) {
  if (plan.travelMode !== 'transit') return plan.travelMode === 'drive' ? 'OSM drive' : 'OSM walk'
  if (plan.diagnostics.searchProfile === 'balanced') return 'Transit'
  if (plan.diagnostics.searchProfile === 'fastest') return 'Earliest arrival'
  if (plan.diagnostics.searchProfile === 'pareto') return 'Pareto transit'
  return 'Transit'
}

function routingCertificationLabel(plan: RoutingPlan) {
  const certification = plan.diagnostics.paretoCertification as { status?: string } | undefined
  if (certification?.status === 'passed') return 'Bounded Pareto certification passed'
  if (plan.travelMode !== 'transit') return 'Directed street path'
  if (plan.diagnostics.searchProfile === 'balanced') return 'Timetable result'
  return 'Scalar timetable result'
}

function RoutingPointSequence({ plan }: { plan: RoutingPlan }) {
  const points = [plan.origin, ...(plan.waypoints ?? []), plan.destination]
  if (points.length <= 2) return null
  return (
    <div className="pathfinder-point-sequence" aria-label="Ordered route points">
      {points.map((point, index) => (
        <span key={`${point.label}-${index}`}>
          <b>{routingPointRoleLabel(index, points.length)}</b>
          <small>{point.label}</small>
        </span>
      ))}
    </div>
  )
}

function routingAccessHints(plan: RoutingPlan | null) {
  const availability = plan?.diagnostics.accessAvailability
  if (!availability) return []
  return [availability.origin, availability.destination]
    .filter((hint): hint is RoutingAccessAvailabilityHint => Boolean(hint))
}

function earliestTransitSummary(plans: RoutingPlan[]) {
  const check = plans
    .map((plan) => plan.diagnostics.earliestTransit)
    .find((candidate) => candidate && typeof candidate === 'object') as {
      status?: string
      firstBoardingMinutes?: number
      arriveMinutes?: number
      routeShortName?: string
      detail?: string
    } | undefined
  if (check?.status === 'ready' && Number.isFinite(check.firstBoardingMinutes)) {
    const boarding = formatScheduleClock(Number(check.firstBoardingMinutes))
    const arrival = Number.isFinite(check.arriveMinutes)
      ? ` · arrives ${formatScheduleClock(Number(check.arriveMinutes))}`
      : ''
    const route = check.routeShortName ? ` · ${check.routeShortName}` : ''
    return `Earliest transit: boards ${boarding}${arrival}${route}`
  }
  if (check?.status === 'none') return check.detail || 'No transit option in this search window.'
  if (check?.status === 'unavailable') return 'Earliest transit check unavailable.'
  return ''
}

function routingAccessHintText(hint: RoutingAccessAvailabilityHint) {
  const role = hint.role === 'origin' ? 'Starting point' : 'Destination'
  if (hint.status === 'outside_selected_budget' && hint.nearestStop) {
    return `${role} is outside the ${hint.selectedWalkKm.toFixed(1)} km access limit. ${hint.nearestStop.name} is the nearest indexed station at ${hint.nearestStop.distanceKm.toFixed(1)} km (${hint.nearestStop.walkMinutes.toFixed(1)} min walk).`
  }
  if (hint.status === 'street_access_unverified' && hint.nearestStop) {
    return `${role} is near ${hint.nearestStop.name} (${hint.nearestStop.distanceKm.toFixed(1)} km), but the OSM pedestrian graph could not certify a walk path within the ${hint.probeWalkKm.toFixed(1)} km diagnostic search.`
  }
  if (hint.status === 'none_within_probe') {
    return `${role}: no indexed station was found within the ${hint.probeWalkKm.toFixed(1)} km diagnostic search.`
  }
  return `${role}: the station-access diagnostic could not complete${hint.detail ? ` (${hint.detail})` : '.'}`
}

function RoutingItinerary({
  plan,
  showSummary = true,
}: {
  plan: RoutingPlan
  showSummary?: boolean
}) {
  if (plan.status !== 'ready') return null

  let previousEnd = plan.departMinutes
  const journeyMinutes = routingPlanJourneyMinutes(plan)
  return (
    <div className="sidebox-itinerary" aria-label="Detailed itinerary">
      {showSummary ? (
        <div className="sidebox-itinerary-summary">
          <span>
            <b>{formatScheduleClock(plan.departMinutes)}</b>
            <small>Leave</small>
          </span>
          <span>
            <b>{formatScheduleClock(plan.arriveMinutes ?? plan.departMinutes + plan.durationMinutes)}</b>
            <small>Arrive</small>
          </span>
          <span>
            <b>{formatRoutingMinutes(journeyMinutes)}</b>
            <small>Journey</small>
          </span>
        </div>
      ) : null}

      <RoutingPointSequence plan={plan} />

      <ol>
        {plan.legs.map((leg, index) => {
          const waitMinutes = Math.max(0, Math.round(leg.startMinutes - previousEnd))
          previousEnd = leg.endMinutes
          return (
            <li key={`${leg.type}-${leg.fromName}-${leg.toName}-${index}`} className={classNames(`is-${leg.type}`, leg.travelMode && `is-${leg.travelMode}`, isSameStationTransfer(leg) && 'is-platform-change')}>
              {waitMinutes > 0 ? (
                <div className="itinerary-wait">
                  <Clock3 size={12} />
                  <span>Wait {formatRoutingMinutes(waitMinutes)}</span>
                </div>
              ) : null}
              <div className="itinerary-step-main">
                <span
                  className="itinerary-step-mark"
                  style={leg.type === 'ride' && leg.routeColor ? { '--route-color': `#${leg.routeColor.replace(/^#/, '')}` } as CSSProperties : undefined}
                >
                  {leg.type === 'ride'
                    ? routingLegPrimaryLabel(leg).slice(0, 3)
                    : leg.type === 'drive'
                      ? 'D'
                    : isSameStationTransfer(leg)
                      ? <ArrowUpDown size={11} />
                      : index + 1}
                </span>
                <span>
                  <strong>{routingLegPrimaryLabel(leg)}</strong>
                  <small>{formatScheduleClock(leg.startMinutes)}-{formatScheduleClock(leg.endMinutes)} · {formatRoutingLegDuration(leg)}</small>
                </span>
              </div>
              <div className="itinerary-step-path">
                <MapPin size={12} />
                <span>{leg.fromName}</span>
                <b>to</b>
                <span>{leg.toName}</span>
              </div>
              <p>{routingLegDetail(leg)}</p>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

export function RoutingDetailPanel({
  plan,
  onClose,
}: {
  plan: RoutingPlan
  onClose: () => void
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current()
    }
    document.addEventListener('keydown', closeOnEscape)
    closeButtonRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', closeOnEscape)
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])

  if (plan.status !== 'ready') return null

  const routeSequence = routingPlanRouteSequence(plan) || plan.title
  const runtime = routingPlanRuntime(plan)
  const limitations = plan.diagnostics.dataSemantics?.limitations ?? []
  const serviceDate = plan.diagnostics.serviceDate
  const realtimeRouting = plan.diagnostics.realtimeRouting
  const realtimeApplied = plan.diagnostics.scheduleMode === 'realtime-adjusted'
    || (typeof realtimeRouting === 'object'
      && realtimeRouting !== null
      && 'status' in realtimeRouting
      && realtimeRouting.status === 'applied')
  const trafficRouting = plan.diagnostics.traffic
  const trafficApplied = plan.diagnostics.roadMetricMode === 'traffic-adjusted'
    && trafficRouting?.status === 'applied'
  const timingDetail = plan.travelMode === 'drive'
    ? trafficApplied
      ? `Traffic snapshot applied · ${trafficRouting.matchedEdges ?? 0} directed edges`
      : trafficRouting?.status === 'stale_fallback'
        ? 'OSM free-flow · traffic snapshot stale'
        : 'OSM free-flow · live traffic not supplied'
    : realtimeApplied
      ? 'GTFS-RT trip updates applied'
      : 'Scheduled times; realtime delay not modeled'

  return (
    <aside className="routing-detail-panel" aria-label="Routing details" aria-describedby="routing-choice-explanation">
      <header className="routing-detail-head">
        <span>
          <small>Selected journey</small>
          <strong>{routeSequence}</strong>
          <b>{formatScheduleClock(plan.departMinutes)} – {formatScheduleClock(plan.arriveMinutes ?? plan.departMinutes + plan.durationMinutes)}</b>
        </span>
        <StatusBadge status="ready" label="Ready" />
        <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="Close routing details" title="Close details">
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className="routing-detail-scroll">
        <div className="routing-detail-context result-metric-grid">
          {plan.travelMode === 'transit' ? <ResultMetric value={plan.transfers} label={`transfer${plan.transfers === 1 ? '' : 's'}`} /> : null}
          <ResultMetric value={plan.travelMode === 'drive' ? 'OSM' : formatRoutingMinutes(plan.walkMinutes)} label={plan.travelMode === 'drive' ? 'drive' : 'walk'} />
          <ResultMetric value={formatRoutingMinutes(plan.rideMinutes)} label={plan.travelMode === 'drive' ? 'drive time' : 'ride'} />
          <ResultMetric value={formatRoutingMinutes(routingPlanTotalWaitMinutes(plan))} label="wait" detail="after requested departure or between legs" />
        </div>
        <section className="routing-choice-explanation" id="routing-choice-explanation">
          <span>
            <small>Why this journey is shown</small>
            <strong>{plan.choiceLabel || 'Distinct journey'}</strong>
          </span>
          <p>{routingChoiceExplanation(plan)}</p>
        </section>
        <RoutingItinerary plan={plan} />
        <details className="routing-details">
          <summary>
            <span>Route details</span>
            <b>{routingProfileLabel(plan)}</b>
          </summary>
          <dl>
            <div><dt>Search profile</dt><dd>{routingProfileLabel(plan)}</dd></div>
            <div><dt>Certification</dt><dd>{routingCertificationLabel(plan)}</dd></div>
            {serviceDate ? <div><dt>Service date</dt><dd>{serviceDate}</dd></div> : null}
            <div><dt>Access limit</dt><dd>{plan.maxWalkKm.toFixed(1)} km</dd></div>
            <div><dt>{plan.travelMode === 'drive' ? 'Road metric' : 'Schedule'}</dt><dd>{timingDetail}</dd></div>
            {limitations.length ? <div><dt>Declared limits</dt><dd>{limitations.length} attached to this result</dd></div> : null}
            {runtime ? <div><dt>Query timing</dt><dd title={`${runtime.title} This describes only the current request.`}>{runtime.label}</dd></div> : null}
          </dl>
          <p>Timing and route-choice details describe only this request.</p>
        </details>
      </div>
    </aside>
  )
}

function PathfinderRouteList({
  plans,
  selectedPlanId,
  alternativesLoading,
  onSelect,
}: {
  plans: RoutingPlan[]
  selectedPlanId?: string
  alternativesLoading: boolean
  onSelect: (id: string) => void
}) {
  const readyPlans = plans
    .filter((plan) => plan.status === 'ready')
    .sort((left, right) => (
      routingPlanTotalElapsedMinutes(left) - routingPlanTotalElapsedMinutes(right)
      || left.durationMinutes - right.durationMinutes
      || left.transfers - right.transfers
      || left.walkMinutes - right.walkMinutes
      || left.id.localeCompare(right.id)
    ))
  if (!readyPlans.length && !alternativesLoading) return null
  const displayedPlans = readyPlans.slice(0, 5)
  const earliestTransit = earliestTransitSummary(plans)

  function moveSelection(event: KeyboardEvent<HTMLButtonElement>, offset: -1 | 1) {
    if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(event.key)) return
    event.preventDefault()
    const radios = Array.from(
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [],
    )
    const currentIndex = radios.indexOf(event.currentTarget)
    const next = radios[(currentIndex + offset + radios.length) % radios.length]
    next?.focus()
    next?.click()
  }

  return (
    <section className="pathfinder-results" aria-label="Route results" aria-busy={alternativesLoading}>
      <div className="pathfinder-results-head">
        <span>
          <strong>Displayed journeys</strong>
          <small>
            Select one to inspect its path and details.
            {earliestTransit ? ` ${earliestTransit}` : ''}
          </small>
        </span>
        <b>{readyPlans.length
          ? readyPlans.length > displayedPlans.length
            ? `${displayedPlans.length} of ${readyPlans.length}`
            : `${readyPlans.length} ${readyPlans.length === 1 ? 'journey' : 'journeys'}`
          : 'Finding journeys'}</b>
      </div>

      {readyPlans.length ? (
        <div className="pathfinder-route-list" role="radiogroup" aria-label="Journey alternatives">
          {displayedPlans.map((plan) => {
            const selected = selectedPlanId === plan.id
            const startWaitMinutes = routingPlanStartWaitMinutes(plan)
            const journeyMinutes = routingPlanJourneyMinutes(plan)
            const totalWaitMinutes = routingPlanTotalWaitMinutes(plan)
            const totalElapsedMinutes = routingPlanTotalElapsedMinutes(plan)
            const fastest = readyPlans[0]
            const fewerTransfers = fastest.transfers - plan.transfers
            const lessWalking = fastest.walkMinutes - plan.walkMinutes
            const laterMinutes = (plan.arriveMinutes ?? plan.departMinutes + plan.durationMinutes)
              - (fastest.arriveMinutes ?? fastest.departMinutes + fastest.durationMinutes)
            const tradeoff = plan === fastest ? '' : [
              fewerTransfers > 0 ? `${fewerTransfers} fewer transfer${fewerTransfers === 1 ? '' : 's'}` : '',
              lessWalking >= 1 ? `${formatRoutingMinutes(lessWalking)} less walking` : '',
              laterMinutes >= 0.5 ? `${formatRoutingMinutes(laterMinutes)} later` : '',
            ].filter(Boolean).join(' · ')
            const routeSequence = plan.waypoints?.length
              ? [plan.origin, ...plan.waypoints, plan.destination].map((point) => point.label).join(' → ')
              : routingPlanRouteSequence(plan) || plan.detail
            return (
              <button
                key={plan.id}
                type="button"
                className={classNames('pathfinder-route-card', selected && 'is-active', plan.recommended && 'is-recommended')}
                onClick={() => onSelect(plan.id)}
                onKeyDown={(event) => moveSelection(event, ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1)}
                role="radio"
                aria-checked={selected}
                aria-label={`${formatScheduleClock(plan.departMinutes)} to ${formatScheduleClock(plan.arriveMinutes ?? plan.departMinutes + plan.durationMinutes)}, ${formatRoutingMinutes(journeyMinutes)} journey, ${formatRoutingMinutes(totalWaitMinutes)} waiting after requested time, ${plan.choiceLabel || 'alternative journey'}, ${plan.transfers} transfers, ${formatRoutingMinutes(plan.walkMinutes)} walking. Inspect journey.`}
              >
                <span className="pathfinder-route-time">
                  <strong>{formatScheduleClock(plan.departMinutes)} – {formatScheduleClock(plan.arriveMinutes ?? plan.departMinutes + plan.durationMinutes)}</strong>
                  <b title={`Time from leaving to arriving; ${formatRoutingMinutes(totalElapsedMinutes)} elapsed from the requested departure`}>{formatRoutingMinutes(journeyMinutes)} time</b>
                </span>
                <span className="pathfinder-route-rationale">
                  <em>{plan.recommended ? 'Top result' : 'Alternative route'}</em>
                  <strong>{plan.choiceLabel || 'Distinct journey'}</strong>
                  {tradeoff ? <span>{tradeoff}</span> : null}
                  {startWaitMinutes > 0 ? (
                    <span title={`Requested ${formatScheduleClock(plan.departMinutes - startWaitMinutes)} · leaves ${formatRoutingMinutes(startWaitMinutes)} later`}>
                      Wait {formatRoutingMinutes(totalWaitMinutes)} · leave at {formatScheduleClock(plan.departMinutes)}
                    </span>
                  ) : totalWaitMinutes > 0 ? <span>Wait {formatRoutingMinutes(totalWaitMinutes)} between legs</span> : null}
                </span>
                <span className="pathfinder-route-metrics" aria-hidden="true">
                  {plan.travelMode === 'transit' ? <span><b>{plan.transfers}</b><small>transfer{plan.transfers === 1 ? '' : 's'}</small></span> : null}
                  <span><b>{formatRoutingMinutes(plan.walkMinutes)}</b><small>{plan.travelMode === 'drive' ? 'access' : 'walk'}</small></span>
                  <span><b>{formatRoutingMinutes(plan.rideMinutes)}</b><small>{plan.travelMode === 'drive' ? 'drive' : 'ride'}</small></span>
                </span>
                <span className="pathfinder-route-footer">
                  <span className="pathfinder-route-sequence">{routeSequence}</span>
                  <span className="pathfinder-route-open">Inspect <ChevronRight size={13} aria-hidden="true" /></span>
                </span>
              </button>
            )
          })}
        </div>
      ) : null}

      {alternativesLoading ? (
        <div className="pathfinder-alternatives" role="status" aria-live="polite">
          <LoaderCircle size={14} aria-hidden="true" />
          <span>Finding journey alternatives…</span>
        </div>
      ) : null}
    </section>
  )
}

export type SidebarPathfinderBoxProps = {
  routingEnabled: boolean
  routingOrigin: RoutingPoint | null
  routingWaypoints: RoutingPoint[]
  routingDestination: RoutingPoint | null
  routingPlan: RoutingPlan | null
  routingChoices: RoutingPlan[]
  routingScopeStatus: RoutingScopeStatus
  routingStoreReady: boolean
  routingStoreFeedCount: number
  routingStoreReadyFeedCount: number
  routingTimePreference: RoutingTimePreference
  routingMode: RoutingTravelMode
  routingDepartureWindowMinutes: RoutingDepartureWindowMinutes
  routingMaxWalkKm: number
  routingMaxTransfers?: number
  routingAllowLongWalk: boolean
  routingActivity: RoutingActivity
  routingAlternativesLoading: boolean
  routingServiceDate: string
  routingServiceCoverage: RoutingServiceCoverage | null
  routingServiceDateAvailability: RoutingServiceDateAvailability
  routingServiceDateOptions: RoutingServiceDateOption[]
  routingResolvingLocations?: boolean
  routingLocationError?: string
  routingLocationChoices?: RoutingLocationChoice[]
  storeBackedRouting: boolean
  scheduleTimeMinutes: number
  onRunRoutingSearch: (query: string) => void
  onReorderRoutingPoints: (points: RoutingPoint[]) => void
  onOpenFeed: () => void
  onScheduleTimeChange: (minutes: number) => void
  onRoutingTimePreferenceChange: (preference: RoutingTimePreference) => void
  onRoutingModeChange: (mode: RoutingTravelMode) => void
  onRoutingDepartureWindowChange: (minutes: RoutingDepartureWindowMinutes) => void
  onRoutingMaxWalkKmChange: (km: number) => void
  onRoutingMaxTransfersChange: (count: number | undefined) => void
  onRoutingAllowLongWalkChange: (allow: boolean) => void
  onRoutingServiceDateChange: (serviceDate: string) => void
  onSelectRoutingPlan: (id: string) => void
  onChooseRoutingLocation: (queryIndex: number, candidate: RoutingLocationCandidate) => void
  onDismissRoutingLocationChoices: () => void
  onInvalidateRoutingResults: () => void
  onToggleRouting: () => void
  onClearRouting: () => void
}

export function SidebarPathfinderBox({
  routingEnabled,
  routingOrigin,
  routingWaypoints,
  routingDestination,
  routingPlan,
  routingChoices,
  routingScopeStatus,
  routingStoreReady,
  routingStoreFeedCount,
  routingStoreReadyFeedCount,
  routingTimePreference,
  routingMode,
  routingDepartureWindowMinutes,
  routingMaxWalkKm,
  routingMaxTransfers,
  routingAllowLongWalk,
  routingActivity,
  routingAlternativesLoading,
  routingServiceDate,
  routingServiceCoverage,
  routingServiceDateAvailability,
  routingServiceDateOptions,
  routingResolvingLocations = false,
  routingLocationError = '',
  routingLocationChoices = [],
  storeBackedRouting,
  scheduleTimeMinutes,
  onRunRoutingSearch,
  onReorderRoutingPoints,
  onOpenFeed,
  onScheduleTimeChange,
  onRoutingTimePreferenceChange,
  onRoutingModeChange,
  onRoutingDepartureWindowChange,
  onRoutingMaxWalkKmChange,
  onRoutingMaxTransfersChange,
  onRoutingAllowLongWalkChange,
  onRoutingServiceDateChange,
  onSelectRoutingPlan,
  onChooseRoutingLocation,
  onDismissRoutingLocationChoices,
  onInvalidateRoutingResults,
  onToggleRouting,
  onClearRouting,
}: SidebarPathfinderBoxProps) {
  const [originDraft, setOriginDraft] = useState('')
  const [waypointDrafts, setWaypointDrafts] = useState<string[]>([])
  const [destinationDraft, setDestinationDraft] = useState('')
  const [queryExpanded, setQueryExpanded] = useState(true)

  useEffect(() => {
    setOriginDraft(routingOrigin?.label ?? '')
  }, [routingOrigin?.label])
  useEffect(() => {
    setWaypointDrafts(routingWaypoints.map((point) => point.label))
  }, [routingWaypoints])
  useEffect(() => {
    setDestinationDraft(routingDestination?.label ?? '')
  }, [routingDestination?.label])

  const clockValue = formatScheduleClock(scheduleTimeMinutes)
  const noServiceDatePlan = routingPlan?.status === 'blocked'
    && /service|timetable/i.test(`${routingPlan.title} ${routingPlan.detail}`)
  const outsideServiceCoverage = routingServiceDateAvailability === 'outside'
  const showServiceDateCorrection = routingMode === 'transit' && storeBackedRouting
    && (outsideServiceCoverage || noServiceDatePlan)
  const buildingCombinedSchedule = routingScopeStatus === 'building'
  const failedCombinedSchedule = routingScopeStatus === 'failed'
  const missingExactSchedule = routingScopeStatus === 'missing'
  const preparingExactSchedule = routingScopeStatus === 'ready'
    && routingActivity.kind === 'preparing'
    && routingActivity.title === 'Opening SQLite timetable'
  const canResolveServiceDate = routingMode === 'transit' && routingStoreReady && routingServiceDateOptions.length > 0
  const serviceCoverageLabel = routingServiceCoverage?.completeStartDate && routingServiceCoverage.completeEndDate
    ? `${routingServiceCoverage.completeStartDate} – ${routingServiceCoverage.completeEndDate}`
    : 'No complete local dates are indexed.'
  const showRoutingActivity = !routingResolvingLocations
    && !routingLocationError
    && !routingLocationChoices.length
    && !buildingCombinedSchedule
    && !failedCombinedSchedule
    && !missingExactSchedule
    && !showServiceDateCorrection
    && Boolean(routingOrigin && routingDestination)
    && (routingActivity.kind === 'loading' || routingActivity.kind === 'preparing')
  const showRoutingBlock = !routingResolvingLocations
    && !routingLocationError
    && !routingLocationChoices.length
    && !buildingCombinedSchedule
    && !failedCombinedSchedule
    && !missingExactSchedule
    && !showServiceDateCorrection
    && routingPlan?.status === 'blocked'
  const resultPlans = routingChoices.length
    ? routingChoices
    : routingPlan?.status === 'ready'
      ? [routingPlan]
      : []
  const hasReadyResults = resultPlans.some((plan) => plan.status === 'ready')
  const showCompactQuery = !queryExpanded && Boolean(
    routingLocationChoices.length || (routingOrigin && routingDestination),
  )
  const timetableLabel = routingMode !== 'transit'
    ? 'OSM streets ready'
    : !storeBackedRouting && routingStoreFeedCount > 1
      ? `${routingStoreReadyFeedCount}/${routingStoreFeedCount} feeds ready`
      : 'Timetable ready'
  const routingPointCount = (routingOrigin ? 1 : 0) + routingWaypoints.length + (routingDestination ? 1 : 0)
  const draftPointCount = [originDraft, ...waypointDrafts, destinationDraft]
    .filter((draft) => draft.trim())
    .length
  const hasRouteSession = Boolean(
    routingLocationChoices.length
      || routingOrigin
      || routingWaypoints.length
      || routingDestination
      || routingPlan,
  )
  const mapPointLimitReached = routingPointCount >= maxRoutingPointCount
  const nextMapPointLabel = routingPinLabel(routingPointCount, Math.max(2, routingPointCount + 1))
  const nextMapPointAction = routingPointCount === 0
    ? 'Pick origin'
    : routingPointCount === 1
      ? 'Add destination'
      : 'Add via stop'

  useEffect(() => {
    if (hasReadyResults && !routingResolvingLocations && !routingLocationChoices.length) {
      setQueryExpanded(false)
    }
  }, [hasReadyResults, routingLocationChoices.length, routingResolvingLocations])

  useEffect(() => {
    if (routingLocationChoices.length) setQueryExpanded(false)
  }, [routingLocationChoices.length])

  function beginDraftEdit() {
    setQueryExpanded(true)
    onDismissRoutingLocationChoices()
    onInvalidateRoutingResults()
  }

  function startNewRoute() {
    setOriginDraft('')
    setWaypointDrafts([])
    setDestinationDraft('')
    setQueryExpanded(true)
    onDismissRoutingLocationChoices()
    onClearRouting()
  }

  function submitPathfinder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onDismissRoutingLocationChoices()
    onInvalidateRoutingResults()
    const drafts = [originDraft, ...waypointDrafts, destinationDraft]
    const resolved = routingOrigin && routingDestination
      ? [routingOrigin, ...routingWaypoints, routingDestination]
      : []
    if (
      resolved.length === drafts.length
      && resolved.every((point, index) => point.label === drafts[index].trim())
    ) {
      onReorderRoutingPoints(resolved)
      return
    }
    runDraftSequence(drafts)
  }

  function swapEndpoints() {
    beginDraftEdit()
    const drafts = [originDraft, ...waypointDrafts, destinationDraft]
    const nextDrafts = [...drafts].reverse()
    const resolved = routingOrigin && routingDestination
      ? [routingOrigin, ...routingWaypoints, routingDestination]
      : []
    setDraftSequence(nextDrafts)
    if (
      resolved.length === drafts.length
      && resolved.every((point, index) => point.label === drafts[index].trim())
    ) {
      onReorderRoutingPoints([...resolved].reverse())
      return
    }
    runDraftSequence(nextDrafts)
  }

  function runDraftSequence(drafts: string[]) {
    const labels = drafts.map((draft) => draft.trim())
    if (labels.length < 2 || labels.some((label) => !label)) return
    onRunRoutingSearch(`${routingMode} from ${labels.join(' -> ')}`)
  }

  function setDraftSequence(drafts: string[]) {
    setOriginDraft(drafts[0] ?? '')
    setWaypointDrafts(drafts.slice(1, -1))
    setDestinationDraft(drafts.at(-1) ?? '')
  }

  function moveDestination(index: number, offset: -1 | 1) {
    const drafts = [originDraft, ...waypointDrafts, destinationDraft]
    const resolved = routingOrigin && routingDestination
      ? [routingOrigin, ...routingWaypoints, routingDestination]
      : []
    const nextIndex = index + offset
    const destinations = drafts.slice(1)
    if (nextIndex < 0 || nextIndex >= destinations.length) return
    beginDraftEdit()
    ;[destinations[index], destinations[nextIndex]] = [destinations[nextIndex], destinations[index]]
    const nextDrafts = [drafts[0], ...destinations]
    setDraftSequence(nextDrafts)
    if (
      resolved.length === drafts.length
      && resolved.every((point, pointIndex) => point.label === drafts[pointIndex].trim())
    ) {
      const nextPoints = [resolved[0], ...resolved.slice(1)]
      ;[nextPoints[index + 1], nextPoints[nextIndex + 1]] = [nextPoints[nextIndex + 1], nextPoints[index + 1]]
      onReorderRoutingPoints(nextPoints)
      return
    }
    runDraftSequence(nextDrafts)
  }

  function removeDestination(index: number) {
    const drafts = [originDraft, ...waypointDrafts, destinationDraft]
    const destinations = drafts.slice(1)
    if (destinations.length <= 1) return
    beginDraftEdit()
    const resolved = routingOrigin && routingDestination
      ? [routingOrigin, ...routingWaypoints, routingDestination]
      : []
    destinations.splice(index, 1)
    const nextDrafts = [drafts[0], ...destinations]
    setDraftSequence(nextDrafts)
    if (
      resolved.length === drafts.length
      && resolved.every((point, pointIndex) => point.label === drafts[pointIndex].trim())
    ) {
      onReorderRoutingPoints(resolved.filter((_, pointIndex) => pointIndex !== index + 1))
      return
    }
    runDraftSequence(nextDrafts)
  }

  function addWaypoint() {
    if (waypointDrafts.length >= 6) return
    beginDraftEdit()
    setWaypointDrafts((current) => [...current, ''])
  }

  function changeTime(value: string) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value)
    if (!match) return
    const hours = Number(match[1])
    const minutes = Number(match[2])
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return
    onScheduleTimeChange(Math.max(0, Math.min(1435, hours * 60 + minutes)))
  }

  return (
    <section className="sidebar-section sidebox sidebox-pathfinder pathfinder-query" aria-label="Routing controls">
      {showCompactQuery ? (
        <section className="pathfinder-current-query" aria-label="Current route query">
          <span>
            <small>{routingLocationChoices.length ? 'Route query' : 'Current route'}</small>
            <strong>{routingLocationChoices.length ? routingLocationChoices[0]?.routeQueries?.[0] ?? originDraft : routingOrigin?.label ?? originDraft} <b aria-hidden="true">→</b> {routingLocationChoices.length ? routingLocationChoices[0]?.routeQueries?.at(-1) ?? destinationDraft : routingDestination?.label ?? destinationDraft}</strong>
            <em>{formatScheduleClock(scheduleTimeMinutes)} · {routingModeLabels[routingMode]} · {routingMaxWalkKm.toFixed(1)} km access</em>
          </span>
          <span className="pathfinder-current-query-actions">
            <button type="button" className="pathfinder-edit-route" onClick={() => {
              if (routingLocationChoices.length) onDismissRoutingLocationChoices()
              setQueryExpanded(true)
            }}>Edit route</button>
            <button type="button" className="pathfinder-new-route" onClick={startNewRoute}>
              <Plus size={14} aria-hidden="true" />
              <span>New route</span>
            </button>
          </span>
        </section>
      ) : (
      <form className="pathfinder-composer" onSubmit={submitPathfinder} aria-busy={routingResolvingLocations}>
        <div className="pathfinder-composer-heading">
          <span>
            <strong>{draftPointCount ? 'Route points' : 'Start a new route'}</strong>
            <small>{draftPointCount ? 'Add a stop before the destination when needed.' : 'Choose a starting point and destination.'}</small>
          </span>
          {hasRouteSession ? (
            <button type="button" className="pathfinder-new-route" onClick={startNewRoute}>
              <Plus size={14} aria-hidden="true" />
              <span>New route</span>
            </button>
          ) : null}
        </div>

        <div className="pathfinder-stage pathfinder-stage-mode">
          <div className="pathfinder-mode-selector" role="group" aria-label="Travel mode">
            {travelModeChoices.map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                className={classNames(routingMode === mode && 'is-active')}
                onClick={() => onRoutingModeChange(mode)}
                aria-pressed={routingMode === mode}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="pathfinder-stage pathfinder-stage-points">
          {originDraft.trim() || destinationDraft.trim() ? <div className="pathfinder-stage-actions">
            <button
              type="button"
              className="pathfinder-swap"
              onClick={swapEndpoints}
              aria-label="Reverse route sequence"
            >
              <ArrowUpDown size={14} aria-hidden="true" />
              <span>Reverse route</span>
            </button>
          </div> : null}

          <div className="pathfinder-location-stack">
            <label className="pathfinder-location-field">
              <span className="pathfinder-location-mark is-origin" aria-hidden="true" />
              <span className="pathfinder-location-copy">
                <small>From</small>
                <input
                  value={originDraft}
                  onChange={(event) => {
                    beginDraftEdit()
                    setOriginDraft(event.currentTarget.value)
                  }}
                  placeholder="Starting point"
                  aria-label="Route origin"
                  autoComplete="off"
                />
              </span>
            </label>
            {[...waypointDrafts, destinationDraft].map((draft, index, destinations) => {
              const finalDestination = index === destinations.length - 1
              return (
                <div className="pathfinder-location-field" key={`destination-${index}`}>
                  <span className={classNames('pathfinder-location-mark', finalDestination ? 'is-destination' : 'is-waypoint')} aria-hidden="true" />
                  <span className="pathfinder-location-copy">
                    <small>{finalDestination ? 'To' : `Stop ${index + 1}`}</small>
                    <input
                      value={draft}
                      onChange={(event) => {
                        beginDraftEdit()
                        const nextValue = event.currentTarget.value
                        if (finalDestination) {
                          setDestinationDraft(nextValue)
                        } else {
                          setWaypointDrafts((current) => current.map((value, draftIndex) => (
                            draftIndex === index ? nextValue : value
                          )))
                        }
                      }}
                      placeholder={finalDestination ? 'Destination' : 'Intermediate stop'}
                      aria-label={finalDestination ? 'Route destination' : `Route stop ${index + 1}`}
                      autoComplete="off"
                    />
                  </span>
                  <span className="pathfinder-location-actions">
                    <button
                      type="button"
                      onClick={() => moveDestination(index, -1)}
                      disabled={index === 0}
                      aria-label={`Move ${finalDestination ? 'destination' : `stop ${index + 1}`} earlier`}
                    >
                      <ArrowUp size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveDestination(index, 1)}
                      disabled={index === destinations.length - 1}
                      aria-label={`Move ${finalDestination ? 'destination' : `stop ${index + 1}`} later`}
                    >
                      <ArrowDown size={12} />
                    </button>
                    {destinations.length > 1 ? (
                      <button
                        type="button"
                        onClick={() => removeDestination(index)}
                        aria-label={`Remove ${finalDestination ? 'destination' : `stop ${index + 1}`}`}
                      >
                        <Trash2 size={12} />
                      </button>
                    ) : null}
                  </span>
                </div>
              )
            })}
          </div>

          <div className="pathfinder-location-footer">
            <div className="pathfinder-stop-controls" role="group" aria-label="Add route points">
              <button type="button" className="pathfinder-add-stop" onClick={addWaypoint} disabled={waypointDrafts.length >= 6}>
                <Plus size={15} aria-hidden="true" />
                <span>Add stop</span>
              </button>

              <button
                type="button"
                className={classNames('pathfinder-map-pick', routingEnabled && 'is-active')}
                onClick={onToggleRouting}
                aria-pressed={routingEnabled}
                aria-label={routingEnabled ? 'Finish picking route points on map' : 'Pick route points on map'}
                title={mapPointLimitReached
                  ? `Routes support up to ${maxRoutingPointCount} ordered points.`
                  : routingEnabled
                    ? `Click the map to ${nextMapPointAction.toLowerCase()} (${nextMapPointLabel}). Select Done picking when finished.`
                    : 'Select ordered route points directly on the map.'}
                disabled={mapPointLimitReached && !routingEnabled}
              >
                <MapPinned size={15} aria-hidden="true" />
                <span>{routingEnabled ? 'Done picking' : 'Pick on map'}</span>
              </button>
            </div>
            <div className="pathfinder-composer-tools" aria-label="Route readiness">
              {routingStoreReady ? (
                <span className="pathfinder-ready-chip" title={routingMode === 'transit' ? 'This route uses the stored timetable for the selected date.' : 'This route uses the sealed directed OSM street snapshot.'}>
                  <CheckCircle2 size={13} aria-hidden="true" />
                  {timetableLabel}
                </span>
              ) : null}
            </div>
          </div>
          <p className="pathfinder-points-hint" role={routingEnabled ? 'status' : undefined} aria-live={routingEnabled ? 'polite' : undefined}>
            {routingEnabled
              ? mapPointLimitReached
                ? `You have selected the maximum of ${maxRoutingPointCount} route points.`
                : <>Next map point: <strong>{nextMapPointAction.toLowerCase()}</strong> <span aria-hidden="true">({nextMapPointLabel})</span>.</>
              : <>Add a stop between the start and destination, or pick the ordered points directly on the map.</>}
          </p>
        </div>

        <div className="pathfinder-stage pathfinder-stage-time">
          <div className="pathfinder-when" aria-label="Journey time and date">
            <div className="pathfinder-when-row">
              {routingMode === 'transit' ? <div className="pathfinder-time-preference" role="group" aria-label="Time preference">
                {routingTimeOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={classNames(routingTimePreference === option.value && 'is-active')}
                    onClick={() => onRoutingTimePreferenceChange(option.value)}
                    aria-pressed={routingTimePreference === option.value}
                  >
                    {option.label}
                  </button>
                ))}
              </div> : <strong className="pathfinder-street-depart-label">Depart at</strong>}
              <label className="pathfinder-time-field">
                <Clock3 size={14} aria-hidden="true" />
                <input type="time" value={clockValue} onChange={(event) => changeTime(event.currentTarget.value)} aria-label="Routing time" />
              </label>
            </div>
            {routingMode === 'transit' ? <label className={classNames('pathfinder-date-field', routingServiceDateAvailability === 'outside' && 'is-outside')}>
              <CalendarDays size={15} aria-hidden="true" />
              <span>
                <small>Service date</small>
                <input
                  type="date"
                  value={routingServiceDate}
                  min={routingServiceCoverage?.completeStartDate}
                  max={routingServiceCoverage?.completeEndDate}
                  onChange={(event) => onRoutingServiceDateChange(event.currentTarget.value)}
                  aria-label="Routing service date"
                />
              </span>
            </label> : null}
          </div>
        </div>

        <div className="pathfinder-stage pathfinder-stage-route">
          <button
            type="submit"
            className="pathfinder-directions-button"
            disabled={[originDraft, ...waypointDrafts, destinationDraft].some((draft) => !draft.trim()) || routingResolvingLocations}
          >
            {routingResolvingLocations ? <LoaderCircle className="is-spinning" size={16} aria-hidden="true" /> : <Navigation2 size={16} aria-hidden="true" />}
            <span>{routingResolvingLocations ? 'Finding places…' : 'Directions'}</span>
          </button>
        </div>
      </form>
      )}

      {routingLocationChoices.length ? (
        <section className="pathfinder-location-resolution" aria-label="Confirm route places">
          <header>
            <span>
              <strong>Confirm places</strong>
              <small>Choose the intended stop before VIGO computes the route.</small>
            </span>
            <button type="button" onClick={() => {
              onDismissRoutingLocationChoices()
              setQueryExpanded(true)
            }} aria-label="Cancel place confirmation">
              <X size={14} aria-hidden="true" />
            </button>
          </header>
          {routingLocationChoices.map((choice) => (
            <fieldset key={`${choice.queryIndex}-${choice.query}`}>
              <legend><b>{choice.role}</b><span>“{choice.query}”</span></legend>
              <div className="pathfinder-choice-group" role="radiogroup" aria-label={`Matches for ${choice.role} ${choice.query}`}>
                {choice.options.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    role="radio"
                    aria-checked="false"
                    onClick={() => onChooseRoutingLocation(choice.queryIndex, candidate)}
                  >
                    <MapPin size={14} aria-hidden="true" />
                    <span><strong>{candidate.name}</strong><small>{candidate.platformCount ? `${candidate.platformCount} platforms` : candidate.id}</small></span>
                    <ChevronRight size={14} aria-hidden="true" />
                  </button>
                ))}
              </div>
            </fieldset>
          ))}
        </section>
      ) : null}

      {routingResolvingLocations ? (
        <div className="pathfinder-notice is-loading" role="status" aria-live="polite">
          <LoaderCircle className="is-spinning" size={16} />
          <span><strong>Finding route points</strong><small>Matching the ordered sequence against this City.</small></span>
        </div>
      ) : routingLocationError ? (
        <div className="pathfinder-notice is-error" role="alert">
          <AlertTriangle size={16} />
          <span><strong>Place not found</strong><small>{routingLocationError}</small></span>
        </div>
      ) : failedCombinedSchedule ? (
        <div className="pathfinder-notice is-error" role="alert">
          <AlertTriangle size={16} />
          <span>
            <strong>Combined routing index failed</strong>
            <small>VIGO could not build the combined timetable. Open City and retry.</small>
          </span>
          <button type="button" onClick={onOpenFeed}>Open City</button>
        </div>
      ) : buildingCombinedSchedule ? (
        <div className="pathfinder-notice is-warning" role="status" aria-live="polite">
          <LoaderCircle className="is-spinning" size={16} />
          <span>
            <strong>Combining timetable feeds</strong>
            <small>VIGO is building one timetable from the ready GTFS feeds. Route will be available when it finishes.</small>
          </span>
          <button type="button" onClick={onOpenFeed}>Open City</button>
        </div>
      ) : preparingExactSchedule ? (
        <div className="pathfinder-notice is-loading" role="status" aria-live="polite">
          <LoaderCircle className="is-spinning" size={16} />
          <span><strong>Opening timetable</strong><small>{routingActivity.detail}</small></span>
        </div>
      ) : missingExactSchedule ? (
        <div className="pathfinder-notice is-warning">
          <AlertTriangle size={16} />
          <span>
            <strong>No routing timetable ready</strong>
            <small>Import or finish indexing a GTFS feed in City.</small>
          </span>
          <button type="button" onClick={onOpenFeed}>Open City</button>
        </div>
      ) : routingActivity.kind === 'error' ? (
        <div className="pathfinder-notice is-error" role="alert">
          <AlertTriangle size={16} />
          <span><strong>{routingActivity.title}</strong><small>{routingActivity.detail}</small></span>
        </div>
      ) : showServiceDateCorrection ? (
        <div className="pathfinder-notice is-warning" role="status" aria-live="polite">
          <AlertTriangle size={16} />
          <span>
            <strong>{outsideServiceCoverage ? 'Date outside timetable' : 'Timetable incomplete for this date'}</strong>
            <small>{outsideServiceCoverage ? `Complete local coverage: ${serviceCoverageLabel}` : routingPlan?.detail}</small>
          </span>
          {canResolveServiceDate ? (
            <div className="pathfinder-date-options" aria-label="Covered timetable date options">
              {routingServiceDateOptions.map((option) => (
                <button
                  key={option.date}
                  type="button"
                  onClick={() => onRoutingServiceDateChange(option.date)}
                  title={`Use ${option.date} timetable`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : showRoutingActivity ? (
        <div className="pathfinder-notice is-loading" role="status" aria-live="polite">
          <LoaderCircle className="is-spinning" size={16} />
          <span><strong>{routingActivity.title}</strong><small>{routingActivity.detail}</small></span>
        </div>
      ) : showRoutingBlock ? (
        <div className="pathfinder-notice is-error" role="alert">
          <AlertTriangle size={16} />
          <span><strong>{routingPlan.title}</strong><small>{routingPlan.detail}</small></span>
          {routingAccessHints(routingPlan).map((hint) => (
            <span className="pathfinder-access-reason" key={hint.role}>
              <small>{routingAccessHintText(hint)}</small>
            </span>
          ))}
          {(() => {
            const suggestedMaxWalkKm = Math.max(
              ...routingAccessHints(routingPlan)
                .map((hint) => Number(hint.suggestedMaxWalkKm))
                .filter(Number.isFinite),
              0,
            )
            return suggestedMaxWalkKm > routingMaxWalkKm + 0.05 ? (
              <button type="button" onClick={() => onRoutingMaxWalkKmChange(Math.min(5, suggestedMaxWalkKm))}>
                Try {suggestedMaxWalkKm.toFixed(1)} km access
              </button>
            ) : null
          })()}
        </div>
      ) : null}

      {!routingResolvingLocations ? (
        <PathfinderRouteList
          plans={resultPlans}
          selectedPlanId={routingPlan?.id}
          alternativesLoading={routingAlternativesLoading}
          onSelect={onSelectRoutingPlan}
        />
      ) : null}

      {routingMode === 'transit' ? <details className="pathfinder-options">
        <summary>
          <span><SlidersHorizontal size={15} /> Route options</span>
          <b>{routingMaxTransfers === undefined ? '' : `≤${routingMaxTransfers} transfers · `}{routingDepartureWindowMinutes ? 'Later departures' : 'Exact time'} · {routingMaxWalkKm.toFixed(1)} km access</b>
        </summary>
        <div className="pathfinder-options-body">
          {routingTimePreference === 'depart' ? (
            <div className="pathfinder-option-group">
              <label>Departure search</label>
              <div className="pathfinder-segmented" role="group" aria-label="Departure search window">
                <button type="button" className={classNames(routingDepartureWindowMinutes === 0 && 'is-active')} onClick={() => onRoutingDepartureWindowChange(0)} aria-pressed={routingDepartureWindowMinutes === 0}>Exact time</button>
                <button type="button" className={classNames(routingDepartureWindowMinutes === 20 && 'is-active')} onClick={() => onRoutingDepartureWindowChange(20)} aria-pressed={routingDepartureWindowMinutes === 20}>Later departures</button>
              </div>
            </div>
          ) : null}

          <div className="pathfinder-option-group">
            <label htmlFor="pathfinder-max-transfers">Maximum transfers</label>
            <select
              id="pathfinder-max-transfers"
              value={routingMaxTransfers ?? ''}
              onChange={(event) => onRoutingMaxTransfersChange(event.currentTarget.value === '' ? undefined : Number(event.currentTarget.value))}
            >
              <option value="">Unlimited</option>
              {Array.from({ length: 32 }, (_, count) => (
                <option key={count} value={count}>{count === 0 ? '0 — Direct services only' : count}</option>
              ))}
            </select>
          </div>

          <div className="pathfinder-option-group pathfinder-walk-limit">
            <label htmlFor="pathfinder-walk-range">Access/egress limit <strong>{routingMaxWalkKm.toFixed(1)} km</strong></label>
            <input
              id="pathfinder-walk-range"
              type="range"
              min={0.2}
              max={5}
              step={0.1}
              value={routingMaxWalkKm}
              onChange={(event) => onRoutingMaxWalkKmChange(Number(event.currentTarget.value))}
              aria-valuetext={`${routingMaxWalkKm.toFixed(1)} kilometers`}
            />
            <div className="pathfinder-walk-presets" role="group" aria-label="Access and egress walk limit presets">
              {routingMaxWalkOptions.map((km) => {
                const selected = Math.abs(routingMaxWalkKm - km) < 0.05
                return (
                  <button key={km} type="button" className={classNames(selected && 'is-active')} onClick={() => onRoutingMaxWalkKmChange(km)} aria-pressed={selected}>
                    {km.toFixed(1)}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="pathfinder-option-group">
            <label htmlFor="pathfinder-long-walk">Walk-only fallback</label>
            <label className="pathfinder-option-check" htmlFor="pathfinder-long-walk">
              <input
                id="pathfinder-long-walk"
                type="checkbox"
                checked={routingAllowLongWalk}
                onChange={(event) => onRoutingAllowLongWalkChange(event.currentTarget.checked)}
              />
              <span>Allow longer end-to-end walks</span>
            </label>
            <small>
              {routingAllowLongWalk
                ? 'Transit may be compared with a graph-verified walk beyond the endpoint access limit.'
                : 'Walk-only results stay within the endpoint access limit; transit is not replaced by a long walk.'}
            </small>
          </div>
        </div>
      </details> : (
        <p className="pathfinder-street-note">
          {routingMode === 'drive'
            ? 'Fastest path on directed OSM roads. One-way and access rules apply; the route uses free flow unless a fresh traffic snapshot is supplied through the routing API.'
            : 'Shortest exact path on the OSM pedestrian graph.'}
        </p>
      )}
    </section>
  )
}
