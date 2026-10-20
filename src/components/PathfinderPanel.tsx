export { RoutingDetailPanel } from './JourneyItinerary'
import { RoutingSetup } from './RoutingSetup'
import { OperationProgress } from './OperationProgress'
import { ResultExportActions } from './ResultExportActions'
import { exportJourneys } from '../app/resultExports'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bus,
  Car,
  CheckCircle2,
  ChevronRight,
  Footprints,
  LoaderCircle,
  MapPin,
  Navigation2,
  Plus,
  RotateCcw,
  Ship,
  TrainFront,
  TramFront,
  Trash2,
} from 'lucide-react'
import { useState, type CSSProperties, type KeyboardEvent } from 'react'
import {
  formatRoutingMinutes,
  isSameStationTransfer,
  routingLegColor,
  routingLegTextColor,
  routingPlanRouteSequence,
} from '../app/presentation'
import {
  routingPlanJourneyMinutes,
  routingPlanStartWaitMinutes,
  routingPlanTotalElapsedMinutes,
  routingPlanTotalWaitMinutes,
  type RoutingActivity,
  type RoutingServiceCoverage,
  type RoutingServiceDateAvailability,
  type RoutingServiceDateOption,
} from '../app/routingPlan'
import { type RoutingDepartureWindowMinutes } from '../app/uiOptions'
import { classNames } from '../domain'
import type  {
  RoutingAccessAvailabilityHint,
  RoutingDataMode,
  RoutingPlan,
  RoutingPoint,
  RoutingTimePreference,
  RoutingTravelMode,
} from '../routingModel'
import { maxRoutingPointCount, routingPointRoleLabel } from '../routingPointSequence'
import { formatScheduleClock } from '../scheduledVehicles'

/** Stops keep their names; a point dropped on the map has no name of its own. */
function routingPointName(point: RoutingPoint) {
  const label = point.label.trim()
  return (point.source === 'map' && !point.named) || !label || /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/u.test(label) ? 'Dropped pin' : label
}

export type RoutingScopeStatus = 'ready' | 'building' | 'failed' | 'missing'

const travelModeIcons = { transit: TrainFront, walk: Footprints, drive: Car } satisfies Record<RoutingTravelMode, unknown>

const travelModeChoices = [
  ['transit', 'Transit'],
  ['walk', 'Walk'],
  ['drive', 'Drive'],
] as const satisfies ReadonlyArray<readonly [RoutingTravelMode, string]>

function boardings(plan: RoutingPlan) {
  // Rank by the same vehicle changes shown on the card. Presentation legs
  // can be split or summarized without changing the journey's transfer count.
  return plan.legs.some(leg => leg.type === 'ride') ? plan.transfers + 1 : 0
}

function timeDifference(minutes: number) {
  return minutes < 1 ? `${Math.max(1, Math.round(minutes * 60))}s` : formatRoutingMinutes(minutes)
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
    return `First boarding option: ${boarding}${arrival}${route}`
  }
  if (check?.status === 'none') return check.detail || 'No transit option in this search window.'
  if (check?.status === 'unavailable') return 'Earliest transit check unavailable.'
  return ''
}

function routingAccessHintText(hint: RoutingAccessAvailabilityHint) {
  const role = hint.role === 'origin' ? 'Starting point' : 'Destination'
  if (hint.status === 'outside_selected_budget' && hint.nearestStop) {
    const duration = hint.nearestStop.walkMinutes === undefined ? '' : ` (${hint.nearestStop.walkMinutes.toFixed(1)} min)`
    const verification = hint.streetPathVerified === false ? ' Street or station access remains unverified.' : ''
    return `${role}: access to ${hint.nearestStop.name} requires ${hint.nearestStop.distanceKm.toFixed(1)} km${duration}, beyond the ${hint.selectedWalkKm.toFixed(1)} km limit.${verification}`
  }
  if (hint.status === 'street_access_unverified' && hint.nearestStop) {
    return `${role} is near ${hint.nearestStop.name} (${hint.nearestStop.distanceKm.toFixed(1)} km in a straight line), but no walk path was verified within ${hint.probeWalkKm.toFixed(1)} km.`
  }
  if (hint.status === 'none_within_probe') {
    return `${role}: no station access candidate was found within the ${hint.probeWalkKm.toFixed(1)} km diagnostic search. A longer path may exist.`
  }
  return `${role}: the station-access diagnostic could not complete${hint.detail ? ` (${hint.detail})` : '.'}`
}

function RouteTypeIcon({ routeType }: { routeType?: number }) {
  if (routeType === 3 || routeType === 11) return <Bus size={12} aria-hidden="true" />
  if (routeType === 0 || routeType === 5) return <TramFront size={12} aria-hidden="true" />
  if (routeType === 4) return <Ship size={12} aria-hidden="true" />
  return <TrainFront size={12} aria-hidden="true" />
}

/** Proportional walk / wait / ride bar with the boarded services as route-coloured badges. */
function JourneyLegStrip({ plan }: { plan: RoutingPlan }) {
  let previousEnd = plan.legs[0]?.startMinutes ?? plan.departMinutes
  const segments = plan.legs.flatMap((leg, index) => {
    const wait = Math.max(0, leg.startMinutes - previousEnd)
    previousEnd = Math.max(previousEnd, leg.endMinutes)
    const color = routingLegColor(leg)
    return [
      ...wait > 0 ? [<span key={`wait-${index}`} className="pathfinder-leg-segment is-wait" style={{ flexGrow: wait }} />] : [],
      <span
        key={index}
        className={classNames('pathfinder-leg-segment', `is-${leg.type}`)}
        style={{ flexGrow: Math.max(leg.durationMinutes, 0.5), ...color ? { '--leg-color': color } : {} } as CSSProperties}
      />,
    ]
  })
  const steps = plan.legs.filter((leg) => leg.type === 'ride'
    || (leg.durationMinutes >= 1 && !isSameStationTransfer(leg)))
  return (
    <span className="pathfinder-leg-strip" aria-hidden="true">
      <span className="pathfinder-leg-bar">{segments}</span>
      <span className="pathfinder-leg-steps">
        {steps.map((leg, index) => {
          const color = routingLegColor(leg)
          return (
            <span key={index} className="pathfinder-leg-step">
              {index ? <ChevronRight size={11} className="pathfinder-leg-sep" /> : null}
              {leg.type === 'ride' ? (
                <span
                  className="pathfinder-leg-badge"
                  style={color ? { '--leg-color': color, '--leg-text': routingLegTextColor(color) } as CSSProperties : undefined}
                >
                  <RouteTypeIcon routeType={leg.routeType} />
                  {leg.routeShortName || leg.routeId || 'Ride'}
                </span>
              ) : (
                <span className="pathfinder-leg-walk">
                  {leg.type === 'drive' ? <Car size={12} /> : <Footprints size={12} />}
                  {formatRoutingMinutes(leg.durationMinutes)}
                </span>
              )}
            </span>
          )
        })}
      </span>
    </span>
  )
}

export function PathfinderRouteList({
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
  const [sort, setSort] = useState<'arrival' | 'transfers' | 'walking'>('arrival')
  const readyPlans = plans
    .filter((plan) => plan.status === 'ready')
    .sort((left, right) => (
      (left.timePreference === 'arrive'
        ? right.departMinutes - left.departMinutes
        : (left.arriveMinutes ?? left.departMinutes + left.durationMinutes)
          - (right.arriveMinutes ?? right.departMinutes + right.durationMinutes))
      || boardings(left) - boardings(right)
      || left.walkMinutes - right.walkMinutes
      || left.durationMinutes - right.durationMinutes
      || left.id.localeCompare(right.id)
    ))
  if (!readyPlans.length && !alternativesLoading) return null
  const displayedPlans = [...readyPlans].sort((left, right) => {
    const difference = sort === 'transfers' ? boardings(left) - boardings(right)
      : sort === 'walking' ? left.walkMinutes - right.walkMinutes : 0
    return difference || readyPlans.indexOf(left) - readyPlans.indexOf(right)
  }).slice(0, 5)
  const earliestTransit = earliestTransitSummary(plans)

  function moveSelection(event: KeyboardEvent<HTMLButtonElement>, offset: -1 | 1) {
    if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const radios = Array.from(
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [],
    )
    const currentIndex = radios.indexOf(event.currentTarget)
    const next = event.key === 'Home' ? radios[0] : event.key === 'End' ? radios.at(-1)
      : radios[(currentIndex + offset + radios.length) % radios.length]
    next?.focus()
    next?.click()
  }

  return (
    <section className="pathfinder-results" aria-label="Route results" aria-busy={alternativesLoading}>
      <div className="pathfinder-results-head">
        <span>
          <strong>Choose a journey</strong>
        </span>
        <b>{readyPlans.length
          ? readyPlans.length > displayedPlans.length
            ? `${displayedPlans.length} of ${readyPlans.length}`
            : `${readyPlans.length} ${readyPlans.length === 1 ? 'journey' : 'journeys'}`
          : 'Finding journeys'}</b>
      </div>

      {readyPlans.length > 1 ? (
        <div className="pathfinder-choice-sort" role="group" aria-label="Sort journeys">
          {([['arrival', readyPlans[0].timePreference === 'arrive' ? 'Leave later' : 'Earliest'], ['transfers', 'Fewer transfers'], ['walking', 'Less walking']] as const).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={sort === value} onClick={() => setSort(value)}>{label}</button>
          ))}
        </div>
      ) : null}
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
            const earlierMinutes = fastest.departMinutes - plan.departMinutes
            const timeTradeoff = plan.timePreference === 'arrive'
              ? earlierMinutes > 0.01 ? `Leave ${timeDifference(earlierMinutes)} earlier` : 'Same departure'
              : laterMinutes > 0.01 ? `${timeDifference(laterMinutes)} later` : 'Same arrival'
            const tradeoff = plan === fastest ? '' : [
              plan.travelMode === 'walk' ? 'Walk only' : '',
              fewerTransfers > 0 ? `${fewerTransfers} fewer transfer${fewerTransfers === 1 ? '' : 's'}` : '',
              lessWalking >= 1 ? `${formatRoutingMinutes(lessWalking)} less walking` : '',
              timeTradeoff,
            ].filter(Boolean).join(' · ')
            const routeSequence = plan.legs.length ? ''
              : plan.travelMode === 'walk' ? 'Walk only' : routingPlanRouteSequence(plan) || plan.detail
            const waypointNote = plan.waypoints?.length ? `via ${plan.waypoints.length} stop${plan.waypoints.length === 1 ? '' : 's'}` : ''
            return (
              <button
                key={plan.id}
                type="button"
                className={classNames('pathfinder-route-card', selected && 'is-active', plan.recommended && 'is-recommended')}
                onClick={() => onSelect(plan.id)}
                onKeyDown={(event) => moveSelection(event, ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1)}
                role="radio"
                aria-checked={selected}
                tabIndex={selected || (!displayedPlans.some(candidate => candidate.id === selectedPlanId) && plan === displayedPlans[0]) ? 0 : -1}
                aria-label={`${formatScheduleClock(plan.departMinutes)} to ${formatScheduleClock(plan.arriveMinutes ?? plan.departMinutes + plan.durationMinutes)}, ${formatRoutingMinutes(totalElapsedMinutes)} total${plan.timePreference === 'depart' ? ' from requested departure' : ''}, ${plan.transfers} transfer${plan.transfers === 1 ? '' : 's'}, ${formatRoutingMinutes(plan.walkMinutes)} walking${plan.travelMode === 'transit' && plan.legs.some((leg) => leg.type === 'ride') ? `, via ${routingPlanRouteSequence(plan).replaceAll(' -> ', ' then ')}` : ''}. ${tradeoff || (plan.timePreference === 'arrive' ? 'Latest departure' : 'Earliest arrival')}. Open journey.`}
              >
                <span className="pathfinder-route-time">
                  <strong>{formatScheduleClock(plan.departMinutes)} → {formatScheduleClock(plan.arriveMinutes ?? plan.departMinutes + plan.durationMinutes)}</strong>
                  <b title={plan.timePreference === 'depart'
                    ? `${formatRoutingMinutes(totalElapsedMinutes)} from the requested departure, including ${formatRoutingMinutes(startWaitMinutes)} before leaving; ${formatRoutingMinutes(journeyMinutes)} travelling`
                    : 'Time from leaving to arriving'}>{formatRoutingMinutes(totalElapsedMinutes)} total</b>
                </span>
                <span className="pathfinder-route-rationale">
                  <strong>{plan === fastest ? `${plan.travelMode === 'walk' ? 'Walk only · ' : ''}${plan.timePreference === 'arrive' ? 'Latest departure' : 'Earliest arrival'}` : tradeoff || plan.choiceLabel || 'Another route'}</strong>
                  {startWaitMinutes > 0 ? (
                    <span title={`Requested ${formatScheduleClock(plan.departMinutes - startWaitMinutes)} · leaves ${formatRoutingMinutes(startWaitMinutes)} later`}>
                      Leave {formatRoutingMinutes(startWaitMinutes)} after your requested time
                    </span>
                  ) : totalWaitMinutes > 0 ? <span>Wait {formatRoutingMinutes(totalWaitMinutes)} between legs</span> : null}
                </span>
                <span className="pathfinder-route-metrics" aria-hidden="true">
                  {plan.travelMode === 'transit' ? <span><b>{plan.transfers}</b><small>transfer{plan.transfers === 1 ? '' : 's'}</small></span> : null}
                  <span><b>{formatRoutingMinutes(plan.walkMinutes)}</b><small>{plan.travelMode === 'drive' ? 'access' : 'walk'}</small></span>
                  {plan.travelMode !== 'walk' ? <span><b>{formatRoutingMinutes(plan.rideMinutes)}</b><small>{plan.travelMode === 'drive' ? 'drive' : 'ride'}</small></span> : <span><b>0</b><small>vehicles</small></span>}
                </span>
                {plan.legs.length ? <JourneyLegStrip plan={plan} /> : null}
                <span className="pathfinder-route-footer">
                  <span className="pathfinder-route-sequence">{[routeSequence, waypointNote].filter(Boolean).join(' · ')}</span>
                  <span className="pathfinder-route-open">Details <ChevronRight size={13} aria-hidden="true" /></span>
                </span>
              </button>
            )
          })}
        </div>
      ) : null}

      {readyPlans.length > 1 ? <ResultExportActions key={selectedPlanId} label={`Save all ${readyPlans.length} journeys`} buttonLabel="Save all" formats={['json', 'csv']}
        disabled={alternativesLoading} resultKey={plans}
        onExport={format => exportJourneys(readyPlans, format, selectedPlanId)} /> : null}
      {earliestTransit ? <details className="pathfinder-result-context"><summary>Search details</summary><p>{earliestTransit}</p></details> : null}
      {alternativesLoading ? (
        <div className="pathfinder-alternatives" role="status" aria-live="polite">
          <LoaderCircle size={14} aria-hidden="true" />
          <span>Finding journey alternatives…</span>
        </div>
      ) : null}
    </section>
  )
}

/** The timetable a route runs on: the City's own, or a saved scenario. */
export type RoutingNetworkChoice = {
  scenarios: Array<{ id: string; name: string; detail: string }>
  selectedId: string
  error: string
  onChange: (id: string) => void
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
  routingDataMode: RoutingDataMode
  routingNetwork?: RoutingNetworkChoice
  routingDepartureWindowMinutes: RoutingDepartureWindowMinutes
  routingMaxWalkKm: number
  routingMaxTransfers?: number
  routingAllowLongWalk: boolean
  routingAllowStreetTransfers: boolean
  routingMinimumTransferBufferMinutes: number
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
  onRoutingDataModeChange: (mode: RoutingDataMode) => void
  onRoutingDepartureWindowChange: (minutes: RoutingDepartureWindowMinutes) => void
  onRoutingMaxWalkKmChange: (km: number) => void
  onRoutingMaxTransfersChange: (count: number | undefined) => void
  onRoutingAllowLongWalkChange: (allow: boolean) => void
  onRoutingAllowStreetTransfersChange: (allow: boolean) => void
  onRoutingMinimumTransferBufferChange: (minutes: number) => void
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
  routingDataMode,
  routingNetwork,
  routingDepartureWindowMinutes,
  routingMaxWalkKm,
  routingMaxTransfers,
  routingAllowLongWalk,
  routingAllowStreetTransfers,
  routingMinimumTransferBufferMinutes,
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
  onRoutingDataModeChange,
  onRoutingDepartureWindowChange,
  onRoutingMaxWalkKmChange,
  onRoutingMaxTransfersChange,
  onRoutingAllowLongWalkChange,
  onRoutingAllowStreetTransfersChange,
  onRoutingMinimumTransferBufferChange,
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

  const departNow = routingMode === 'transit' && routingDataMode === 'realtime'
  const noServiceDatePlan = routingPlan?.status === 'blocked'
    && /service|timetable/i.test(`${routingPlan.title} ${routingPlan.detail}`)
  const outsideServiceCoverage = !departNow && routingServiceDateAvailability === 'outside'
  const showServiceDateCorrection = routingMode === 'transit' && storeBackedRouting
    && (outsideServiceCoverage || noServiceDatePlan)
  const buildingCombinedSchedule = routingScopeStatus === 'building'
  const failedCombinedSchedule = routingScopeStatus === 'failed'
  const missingExactSchedule = routingScopeStatus === 'missing'
  const preparingExactSchedule = routingScopeStatus === 'ready'
    && routingActivity.kind === 'preparing'
    && routingActivity.title === 'Opening SQLite timetable'
  const canResolveServiceDate = routingMode === 'transit' && !departNow && routingStoreReady && routingServiceDateOptions.length > 0
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

  return (
    <section className="sidebar-section sidebox sidebox-pathfinder pathfinder-query" aria-label="Routing controls">
      <form className="pathfinder-composer" onSubmit={(event) => { event.preventDefault(); if (canRun) onRunRouting() }}>
        <div className="pathfinder-setup-head">
          <div className="pathfinder-mode-switch" role="group" aria-label="Travel mode">
            {travelModeChoices.map(([mode, label]) => {
              const Icon = travelModeIcons[mode]
              return (
                <button key={mode} type="button" className={classNames(routingMode === mode && 'is-active')} onClick={() => onRoutingModeChange(mode)} aria-pressed={routingMode === mode}>
                  <Icon size={14} aria-hidden="true" /><span>{label}</span>
                </button>
              )
            })}
          </div>
          <button type="button" className="pathfinder-new-route" onClick={onClearRouting} disabled={!points.length} aria-label="New route" title="Clear points and start a new route">
            <RotateCcw size={14} aria-hidden="true" />
          </button>
        </div>

        <div className="pathfinder-stage pathfinder-stage-points">
          <div className="pathfinder-location-stack">
            {pointRows.map((point, index) => {
              const role = index === 0 ? 'From' : index === pointRows.length - 1 ? 'To' : `Via ${index}`
              const selected = routingEnabled && (routingPickIndex === index || routingPickIndex === null && index === points.length && points.length < 2)
              return (
                <div className={classNames('pathfinder-location-field', selected && 'is-picking')} key={index}>
                  <span className={classNames('pathfinder-location-mark', index === 0 ? 'is-origin' : index === pointRows.length - 1 ? 'is-destination' : 'is-waypoint')} aria-hidden="true" />
                  <button type="button" className="pathfinder-coordinate-point" aria-label={`${point ? 'Repick' : 'Pick'} ${role.toLowerCase()} on map`} aria-pressed={selected} onClick={() => onPickRoutingPoint(index)} disabled={index > points.length}>
                    <small>{role}</small>
                    <strong className={classNames(!point && 'is-empty')}>{point ? routingPointName(point) : selected ? 'Click the map…' : 'Pick on map'}</strong>
                    {point ? <span className="pathfinder-coordinate-value">{point.coordinate[1].toFixed(5)}, {point.coordinate[0].toFixed(5)}</span> : null}
                  </button>
                  {point ? <span className="pathfinder-location-actions">
                    <button type="button" onClick={() => movePoint(index, -1)} disabled={index === 0} aria-label={`Move ${role.toLowerCase()} earlier`}><ArrowUp size={13} /></button>
                    <button type="button" onClick={() => movePoint(index, 1)} disabled={index === points.length - 1} aria-label={`Move ${role.toLowerCase()} later`}><ArrowDown size={13} /></button>
                    <button type="button" onClick={() => onReorderRoutingPoints(points.filter((_, current) => current !== index))} aria-label={`Remove ${role.toLowerCase()}`}><Trash2 size={13} /></button>
                  </span> : <MapPin size={14} aria-hidden="true" />}
                </div>
              )
            })}
            <div className="pathfinder-stop-controls" role="group" aria-label="Add route points">
              <button type="button" className="pathfinder-add-stop" onClick={() => onPickRoutingPoint(null)} disabled={mapPointLimitReached || routingEnabled} title={`${points.length} of ${maxRoutingPointCount} route points`}>
                <Plus size={14} aria-hidden="true" /><span>Add stop</span>
              </button>
              {routingEnabled ? <button type="button" className="pathfinder-map-pick is-active" onClick={onToggleRouting}><CheckCircle2 size={14} aria-hidden="true" /><span>Done</span></button> : null}
              <button type="button" className="pathfinder-swap" onClick={() => onReorderRoutingPoints([...points].reverse())} disabled={points.length < 2} aria-label="Reverse route sequence" title="Reverse route">
                <ArrowUpDown size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
          {routingEnabled ? <p className="pathfinder-points-hint" role="status">{pickLabel} on the map</p> : null}
        </div>

        <RoutingSetup {...{
          routingMode, routingNetwork, routingDataMode, routingTimePreference, routingServiceDate,
          routingServiceCoverage, routingServiceDateAvailability, scheduleTimeMinutes, routingWaypoints,
          routingDepartureWindowMinutes, routingMaxTransfers, routingMinimumTransferBufferMinutes,
          routingMaxWalkKm, routingAllowStreetTransfers, routingAllowLongWalk,
          onRoutingDataModeChange, onRoutingTimePreferenceChange, onRoutingServiceDateChange,
          onScheduleTimeChange, onRoutingDepartureWindowChange, onRoutingMaxTransfersChange,
          onRoutingMinimumTransferBufferChange, onRoutingMaxWalkKmChange,
          onRoutingAllowStreetTransfersChange, onRoutingAllowLongWalkChange,
        }} />

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
          <span><strong>Opening timetable</strong><small>{routingActivity.detail}</small><OperationProgress phase="Opening timetable" compact /></span>
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
            <strong>{departNow ? 'Timetable unavailable for now' : outsideServiceCoverage ? 'Date outside timetable' : 'Timetable incomplete for this date'}</strong>
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
          ) : departNow ? <button type="button" onClick={() => onRoutingDataModeChange('scheduled')}>Use Scheduled</button> : null}
        </div>
      ) : showRoutingActivity ? (
        <div className="pathfinder-notice is-loading" role="status" aria-live="polite">
          <LoaderCircle className="is-spinning" size={16} />
          <span><strong>{routingActivity.title}</strong><small>{routingActivity.detail}</small><OperationProgress phase={routingActivity.title} compact /></span>
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


    </section>
  )
}
