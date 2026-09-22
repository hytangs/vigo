import { Clock3, X } from 'lucide-react'
import { useEffect, useRef, type CSSProperties } from 'react'
import {
  formatRoutingLegDuration,
  formatRoutingMinutes,
  isSameStationTransfer,
  routingDataModeLabel,
  routingLegDetail,
  routingLegPrimaryLabel,
  routingRealtimeDetail,
} from '../app/presentation'
import { routingPlanJourneyMinutes, routingPlanRuntime, routingPlanStartWaitMinutes } from '../app/routingPlan'
import { classNames } from '../domain'
import type { RoutingPlan } from '../routingModel'
import { routingPointRoleLabel } from '../routingPointSequence'
import { formatScheduleClock } from '../scheduledVehicles'
import { RoutingFare } from './RoutingFare'

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

function RoutingItinerary({ plan }: { plan: RoutingPlan }) {
  const initialWait = routingPlanStartWaitMinutes(plan)
  let previousEnd = plan.departMinutes
  return <section className="journey-itinerary" aria-label="Detailed itinerary">
    {initialWait > 0 ? <p className="journey-start-wait">Leave {formatRoutingMinutes(initialWait)} after your requested time. This wait is before the journey below.</p> : null}
    <RoutingPointSequence plan={plan} />
    <ol className="journey-timeline">
      {plan.legs.map((leg, index) => {
        const wait = Math.max(0, leg.startMinutes - previousEnd)
        previousEnd = leg.endMinutes
        const ride = leg.type === 'ride'
        const transfer = isSameStationTransfer(leg)
        const color = ride && /^#?[\da-f]{6}$/i.test(leg.routeColor ?? '') ? `#${leg.routeColor!.replace('#', '')}` : undefined
        const title = ride || transfer ? routingLegPrimaryLabel(leg) : `${leg.type === 'drive' ? 'Drive' : 'Walk'} to ${leg.toName}`
        return <li key={index} className={classNames('journey-leg', ride && 'is-ride')} style={color ? { '--journey-line': color } as CSSProperties : undefined}>
          <time className="journey-clock">{formatScheduleClock(leg.startMinutes)}</time>
          <div className="journey-leg-body">
            {wait > 0 ? <p className="journey-wait"><Clock3 size={13} aria-hidden="true" />{formatRoutingMinutes(wait)} wait at {leg.fromName}</p> : null}
            <div className="journey-leg-heading"><strong>{title}</strong><span>{formatRoutingLegDuration(leg)}</span></div>
            {ride ? <><p className="journey-stop">{leg.fromName}</p><p className="journey-leg-meta">{leg.stopCount > 0 ? `${leg.stopCount} scheduled stops` : 'Transit ride'}</p><div className="journey-arrival"><span>{leg.toName}</span><time>{formatScheduleClock(leg.endMinutes)}</time></div></> : <p className="journey-leg-meta">{transfer ? 'Station connection' : `From ${leg.fromName}`}{leg.distanceKm > 0 ? ` · ${leg.distanceKm < 1 ? `${Math.round(leg.distanceKm * 1000)} m` : `${leg.distanceKm.toFixed(1)} km`}` : ''}</p>}
            {leg.stationAccessStatus === 'unverified' ? <p className="journey-caution">Station entrance / platform path unverified</p> : leg.transferSource === 'parent_station_fallback' ? <p className="journey-caution">Assumed station connection time</p> : null}
            {(ride && (leg.sourceEqualTime || leg.geometrySource !== 'shape')) || leg.type === 'drive' ? <details className="journey-leg-evidence"><summary>Path &amp; timing</summary><p>{routingLegDetail(leg)}</p></details> : null}
          </div>
        </li>
      })}
      <li className="journey-finish"><time className="journey-clock">{formatScheduleClock(plan.arriveMinutes ?? plan.departMinutes + plan.durationMinutes)}</time><strong>Arrive at {plan.legs.at(-1)?.toName || plan.destination.label}</strong></li>
    </ol>
    <RoutingFare plan={plan} />
  </section>
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

  const runtime = routingPlanRuntime(plan)
  const limitations = plan.diagnostics.dataSemantics?.limitations ?? []
  const serviceDate = plan.diagnostics.serviceDate
  const trafficRouting = plan.diagnostics.traffic
  const trafficApplied = plan.diagnostics.roadMetricMode === 'traffic-adjusted'
    && trafficRouting?.status === 'applied'
  const timingDetail = plan.travelMode === 'drive'
    ? trafficApplied
      ? `Traffic snapshot applied · ${trafficRouting.matchedEdges ?? 0} directed edges`
      : trafficRouting?.status === 'stale_fallback'
        ? 'OSM free-flow · traffic snapshot stale'
        : 'OSM free-flow · live traffic not supplied'
    : routingRealtimeDetail(plan)

  return (
    <aside className="routing-detail-panel" aria-label="Routing details">
      <header className="routing-detail-head">
        <div>
          <p className="journey-eyebrow">{plan.travelMode === 'transit' ? routingDataModeLabel(plan) || 'Transit' : plan.travelMode === 'drive' ? 'Drive' : 'Walk'} journey</p>
          <h2>{formatRoutingMinutes(routingPlanJourneyMinutes(plan))}</h2>
          <p className="journey-time-range">{formatScheduleClock(plan.departMinutes)} <span aria-hidden="true">→</span> {formatScheduleClock(plan.arriveMinutes ?? plan.departMinutes + plan.durationMinutes)}</p>
          <p className="journey-overview">{plan.travelMode === 'transit' ? `${plan.transfers} transfer${plan.transfers === 1 ? '' : 's'} · ` : ''}{plan.travelMode === 'drive' ? `${formatRoutingMinutes(plan.rideMinutes)} driving` : `${formatRoutingMinutes(plan.walkMinutes)} walking`}{plan.waitMinutes > 0 ? ` · ${formatRoutingMinutes(plan.waitMinutes)} waiting en route` : ''}</p>
        </div>
        <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="Close routing details" title="Close details"><X size={18} aria-hidden="true" /></button>
      </header>
      <div className="routing-detail-scroll">
        <RoutingItinerary plan={plan} />
        <details className="routing-details">
          <summary>
            <span>Journey information</span>
            <b>{routingProfileLabel(plan)}</b>
          </summary>
          <p>{routingChoiceExplanation(plan)}</p>
          <dl>
            <div><dt>Search profile</dt><dd>{routingProfileLabel(plan)}</dd></div>
            <div><dt>Certification</dt><dd>{routingCertificationLabel(plan)}</dd></div>
            {serviceDate ? <div><dt>Service date</dt><dd>{serviceDate}</dd></div> : null}
            {plan.diagnostics.routingDataProvenance?.timeZone ? <div><dt>Time zone</dt><dd>{plan.diagnostics.routingDataProvenance.timeZone}</dd></div> : null}
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
