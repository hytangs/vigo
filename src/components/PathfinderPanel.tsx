import { type CSSProperties, type KeyboardEvent, useEffect, useRef } from 'react'
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
  Navigation2,
  Plus,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react'
import { classNames } from '../domain'
import { RoutingFare } from './RoutingFare'
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
import { maxRoutingPointCount, routingPointRoleLabel } from '../routingPointSequence'
import { ResultMetric, StatusBadge } from './UiPrimitives'

export type RoutingScopeStatus = 'ready' | 'building' | 'failed' | 'missing'

const travelModeChoices = [
  ['transit', 'Transit'],
  ['walk', 'Walk'],
  ['drive', 'Drive'],
] as const satisfies ReadonlyArray<readonly [RoutingTravelMode, string]>

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
      <RoutingFare plan={plan} />

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
          {earliestTransit ? <small>{earliestTransit}</small> : null}
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
  routingPointError?: string
  storeBackedRouting: boolean
  scheduleTimeMinutes: number
  onRunRouting: () => void
  onPickRoutingPoint: (index: number | null) => void
  routingPickIndex: number | null
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
  routingPointError = '',
  storeBackedRouting,
  scheduleTimeMinutes,
  onRunRouting,
  onPickRoutingPoint,
  routingPickIndex,
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
  onToggleRouting,
  onClearRouting,
}: SidebarPathfinderBoxProps) {
  const points = [...(routingOrigin ? [routingOrigin] : []), ...routingWaypoints, ...(routingDestination ? [routingDestination] : [])]
  const pointRows = points.length < 2 ? [routingOrigin, null] : points
  const mapPointLimitReached = points.length >= maxRoutingPointCount
  const busy = routingActivity.kind === 'loading' || routingActivity.kind === 'preparing'
  const canRun = Boolean(routingOrigin && routingDestination) && !busy
  const pickLabel = routingPickIndex === null || routingPickIndex >= points.length
    ? points.length === 0 ? 'Pick origin' : points.length === 1 ? 'Pick destination' : 'Pick via point'
    : `Repick ${routingPointRoleLabel(routingPickIndex, pointRows.length).toLowerCase()}`

  function movePoint(index: number, offset: number) {
    const next = [...points]
    const target = index + offset
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    onReorderRoutingPoints(next)
  }

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
  const showRoutingActivity = !routingPointError
    && !buildingCombinedSchedule
    && !failedCombinedSchedule
    && !missingExactSchedule
    && !showServiceDateCorrection
    && Boolean(routingOrigin && routingDestination)
    && (routingActivity.kind === 'loading' || routingActivity.kind === 'preparing')
  const showRoutingBlock = !routingPointError
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
      <form className="pathfinder-composer" onSubmit={(event) => { event.preventDefault(); if (canRun) onRunRouting() }}>
        <div className="pathfinder-composer-heading">
          <span><strong>Route points</strong><small>{points.length}/{maxRoutingPointCount}</small></span>
          <button type="button" className="pathfinder-new-route" onClick={onClearRouting} disabled={!points.length}>
            <Plus size={14} aria-hidden="true" /><span>New route</span>
          </button>
        </div>
        <div className="pathfinder-stage pathfinder-stage-mode">
          <div className="pathfinder-mode-selector" role="group" aria-label="Travel mode">
            {travelModeChoices.map(([mode, label]) => (
              <button key={mode} type="button" className={classNames(routingMode === mode && 'is-active')} onClick={() => onRoutingModeChange(mode)} aria-pressed={routingMode === mode}>{label}</button>
            ))}
          </div>
        </div>
        <div className="pathfinder-stage pathfinder-stage-points">
          <div className="pathfinder-stage-actions">
            <button type="button" className="pathfinder-swap" onClick={() => onReorderRoutingPoints([...points].reverse())} disabled={points.length < 2} aria-label="Reverse route sequence">
              <ArrowUpDown size={14} aria-hidden="true" /><span>Reverse</span>
            </button>
          </div>
          <div className="pathfinder-location-stack">
            {pointRows.map((point, index) => {
              const role = index === 0 ? 'From' : index === pointRows.length - 1 ? 'To' : `Via ${index}`
              const selected = routingEnabled && (routingPickIndex === index || routingPickIndex === null && index === points.length && points.length < 2)
              return (
                <div className={classNames('pathfinder-location-field', selected && 'is-picking')} key={index}>
                  <span className={classNames('pathfinder-location-mark', index === 0 ? 'is-origin' : index === pointRows.length - 1 ? 'is-destination' : 'is-waypoint')} aria-hidden="true" />
                  <button type="button" className="pathfinder-coordinate-point" aria-label={`${point ? 'Repick' : 'Pick'} ${role.toLowerCase()} on map`} aria-pressed={selected} onClick={() => onPickRoutingPoint(index)} disabled={index > points.length}>
                    <small>{role}</small>
                    <strong>{point ? `${point.coordinate[1].toFixed(5)}, ${point.coordinate[0].toFixed(5)}` : 'Pick on map'}</strong>
                  </button>
                  {point ? <span className="pathfinder-location-actions">
                    <button type="button" onClick={() => movePoint(index, -1)} disabled={index === 0} aria-label={`Move ${role.toLowerCase()} earlier`}><ArrowUp size={13} /></button>
                    <button type="button" onClick={() => movePoint(index, 1)} disabled={index === points.length - 1} aria-label={`Move ${role.toLowerCase()} later`}><ArrowDown size={13} /></button>
                    <button type="button" onClick={() => onReorderRoutingPoints(points.filter((_, current) => current !== index))} aria-label={`Remove ${role.toLowerCase()}`}><Trash2 size={13} /></button>
                  </span> : <MapPin size={14} aria-hidden="true" />}
                </div>
              )
            })}
          </div>
          <div className="pathfinder-stop-controls" role="group" aria-label="Add route points">
            <button type="button" className="pathfinder-add-stop" onClick={() => onPickRoutingPoint(null)} disabled={mapPointLimitReached || routingEnabled}>
              <Plus size={15} aria-hidden="true" /><span>Add point</span>
            </button>
            {routingEnabled ? <button type="button" className="pathfinder-map-pick is-active" onClick={onToggleRouting}><CheckCircle2 size={15} aria-hidden="true" /><span>Done picking</span></button> : null}
          </div>
          {routingEnabled ? <p className="pathfinder-points-hint" role="status">{pickLabel}</p> : null}
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
          <button type="submit" className="pathfinder-directions-button" disabled={!canRun}>
            {busy ? <LoaderCircle className="is-spinning" size={16} aria-hidden="true" /> : <Navigation2 size={16} aria-hidden="true" />}
            <span>{busy ? 'Routing…' : routingPlan ? 'Rerun route' : 'Run route'}</span>
          </button>
        </div>
      </form>
      {routingPointError ? (
        <div className="pathfinder-notice is-error" role="alert">
          <AlertTriangle size={16} />
          <span><strong>Check route points</strong><small>{routingPointError}</small></span>
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

      <PathfinderRouteList
          plans={resultPlans}
          selectedPlanId={routingPlan?.id}
          alternativesLoading={routingAlternativesLoading}
          onSelect={onSelectRoutingPlan}
      />

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
      </details> : null}
    </section>
  )
}
