import { Car, Clock3, Footprints, X } from 'lucide-react'
import { useEffect, useRef, type CSSProperties } from 'react'
import {
  formatRoutingLegDuration,
  formatRoutingMinutes,
  isSameStationTransfer,
  routingDataModeLabel,
  routingLegColor,
  routingLegPrimaryLabel,
  routingLegTextColor,
} from '../app/presentation'
import { routingPlanStartWaitMinutes, routingPlanTotalElapsedMinutes } from '../app/routingPlan'
import { classNames } from '../domain'
import type { RoutingPlan } from '../routingModel'
import { formatScheduleClock } from '../scheduledVehicles'
import { JourneyLegStrip, RouteTypeIcon } from './JourneyLegStrip'
import { RoutingFare } from './RoutingFare'
import { ResultExportActions } from './ResultExportActions'
import { exportJourney, journeyGeometryAvailable } from '../app/resultExports'
import { selectRoutingPlan } from '../state/route'

/** The leg that starts each via segment, keyed by leg index: the segment begins at the via point. */
function viaSegmentStarts(plan: RoutingPlan) {
  const starts = new Map<number, number>()
  let from = 1
  for (const [order, point] of (plan.waypoints ?? []).entries()) {
    const index = plan.legs.findIndex((leg, legIndex) => legIndex >= from && (leg.fromName === point.label || (leg.coordinates.length > 0
      && Math.hypot(leg.coordinates[0][0] - point.coordinate[0], leg.coordinates[0][1] - point.coordinate[1]) < 1e-5)))
    if (index < 0) break
    starts.set(index, order)
    from = index + 1
  }
  return starts
}

const coordinateLabel = /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/u

/** A stop keeps its name; a bare coordinate reads as the start or the destination. */
function journeyPlace(name: string, fallback: string) {
  const label = name.trim()
  return !label || coordinateLabel.test(label) ? fallback : label
}

function formatDistance(distanceKm: number) {
  return distanceKm < 1 ? `${Math.round(distanceKm * 1000)} m` : `${distanceKm.toFixed(1)} km`
}

/** Minutes as riders read them: 41 min, or 1 h 5 min. */
export function JourneyDuration({ minutes, suffix = '' }: { minutes: number; suffix?: string }) {
  const rounded = Math.max(0, Math.round(minutes))
  const hours = Math.floor(rounded / 60)
  const rest = rounded % 60
  return <>{hours ? <>{hours}<small>h</small>{rest ? ' ' : ''}</> : null}{rest || !hours ? <>{rest}<small>min{suffix}</small></> : null}</>
}

export function RoutingItinerary({ plan, destinationLabel }: { plan: RoutingPlan; destinationLabel?: string }) {
  const initialWait = routingPlanStartWaitMinutes(plan)
  const arrival = plan.arriveMinutes ?? plan.departMinutes + plan.durationMinutes
  let previousEnd = plan.departMinutes
  const viaStarts = viaSegmentStarts(plan)
  return <section className="journey-itinerary" aria-label="Detailed itinerary">
    {initialWait > 0 ? <p className="journey-start-wait"><Clock3 size={12} aria-hidden="true" />Leave {formatRoutingMinutes(initialWait)} after your requested time.</p> : null}
    {plan.diagnostics.expandedWalkingLimitKm ? <p className="journey-start-wait">More walking allowed · up to {plan.diagnostics.expandedWalkingLimitKm} km at each end</p> : null}
    <ol className="journey-timeline">
      {plan.legs.map((leg, index) => {
        const wait = leg.inSeatSeconds != null ? 0 : Math.max(0, leg.startMinutes - previousEnd)
        previousEnd = leg.endMinutes
        const ride = leg.type === 'ride'
        const frequency = plan.sharedLegAlternatives?.frequencies?.find(f => f.legIndex === index)
        const sharedOptions = plan.sharedLegAlternatives?.options.filter(option => option.legIndex === index) ?? []
        const previousLeg = plan.legs[index - 1]
        const immediateVehicleChange = ride && previousLeg?.type === 'ride'
          && previousLeg.tripId !== leg.tripId && wait === 0 && leg.inSeatSeconds == null
        const transfer = isSameStationTransfer(leg)
        const kind = ride ? 'ride' : leg.type === 'drive' ? 'drive' : transfer ? 'transfer' : 'walk'
        const color = routingLegColor(leg)
        // A stop where a ride ends takes that ride's colour, as on a line diagram.
        const nodeColor = color ?? (previousLeg ? routingLegColor(previousLeg) : undefined)
        const style = {
          ...color ? { '--journey-line': color, '--journey-ink': routingLegTextColor(color) } : {},
          ...nodeColor ? { '--journey-node': nodeColor } : {},
        } as CSSProperties
        const MoveIcon = leg.type === 'drive' ? Car : Footprints
        const via = viaStarts.get(index)
        const viaLabel = via === undefined ? '' : journeyPlace(plan.waypoints![via].label, `Via stop ${via + 1}`)
        return <li key={index} className={classNames('journey-leg', `is-${kind}`, nodeColor && 'has-station', via !== undefined && 'is-via')} style={style}>
          <time className="journey-clock">{formatScheduleClock(leg.startMinutes)}</time>
          <span className="journey-node-mark" aria-hidden="true" />
          <strong className="journey-place">{index === 0 ? journeyPlace(leg.fromName, plan.origin.label && !coordinateLabel.test(plan.origin.label) ? plan.origin.label : 'Start')
            : via !== undefined ? <>{viaLabel}{/^Via stop \d+$/.test(viaLabel) ? null : <span className="journey-via-tag">Via {via + 1}</span>}</> : leg.fromName}</strong>
          <div className="journey-leg-body">
            {leg.headwayEstimate ? <p className="journey-caution">Estimated timing · every {formatRoutingMinutes(leg.headwayEstimate.headwaySeconds / 60)} · assumes {formatRoutingMinutes(leg.headwayEstimate.expectedWaitSeconds / 60)} waiting</p> : null}
            {leg.inSeatSeconds != null ? <p className="journey-wait">Stay aboard{leg.inSeatSeconds > 0 ? ` · ${formatRoutingMinutes(leg.inSeatSeconds / 60)} onboard layover` : ''}</p> : null}
            {wait > 0 ? <p className="journey-wait"><Clock3 size={12} aria-hidden="true" />{formatRoutingMinutes(wait)} wait at {leg.fromName}</p> : null}
            {immediateVehicleChange ? <p className="journey-caution">No time between vehicles</p> : null}
            {ride ? <div className="journey-ride">
              <span className="journey-route"><RouteTypeIcon routeType={leg.routeType} size={13} />{routingLegPrimaryLabel(leg)}</span>
              <span className="journey-leg-meta">{leg.scenarioService ? <span className="journey-planned">Planned · {leg.scenarioService.scenarioName} · </span> : null}{leg.stopCount > 0 ? `${leg.stopCount} ${leg.headwayEstimate ? 'service' : leg.scenarioService ? 'planned' : 'scheduled'} stop${leg.stopCount === 1 ? '' : 's'}` : 'Transit ride'} · {formatRoutingLegDuration(leg)}</span>
            </div> : <p className="journey-move">
              <MoveIcon size={13} aria-hidden="true" />
              <span>{transfer ? 'Change' : leg.type === 'drive' ? 'Drive' : 'Walk'}</span>
              <span className="journey-leg-meta">{formatRoutingLegDuration(leg)}{leg.distanceKm > 0 ? ` · ${formatDistance(leg.distanceKm)}` : ''}</span>
            </p>}
            {transfer && (leg.geometrySource === 'stop_coordinate_fallback' || leg.stationAccessStatus === 'unverified') ? <p className="journey-leg-meta journey-transfer-note">Map line approximate</p> : null}
            {ride && Boolean(leg.intermediateStops?.length) ? <details className="kit-inline-details journey-leg-evidence journey-stops">
              <summary>Stops along the way · {leg.intermediateStops!.length}</summary>
              <ol>{leg.intermediateStops!.map((stop, stopIndex) => <li key={`${stop.stopId}:${stopIndex}`}>{stop.name || stop.stopId}</li>)}</ol>
            </details> : null}
            {leg.stationAccessStatus !== 'unverified' && leg.transferSource === 'parent_station_fallback' ? <p className="journey-caution">Assumed station connection time</p> : null}
            {ride && plan.sharedLegAlternatives && (frequency || sharedOptions.length > 0) ?
              <div className="journey-leg-evidence journey-shared-services">
                <p className="journey-departure-times" aria-label="Departure times">{(frequency?.departureSeconds ?? [leg.startMinutes * 60, ...sharedOptions.map(option => option.plan.legs[index].startMinutes * 60)])
                  .filter((time, i, times) => times.indexOf(time) === i).sort((a, b) => a - b)
                  .map(time => <time key={time}>{formatScheduleClock(time / 60)}</time>)}</p>
                  {frequency && frequency.departureCount > frequency.uniqueDepartureCount ? <p className="journey-leg-meta">Some services depart at the same time.</p> : null}
                  {frequency?.status === 'incomplete' ? <p className="journey-leg-meta">More departures may be available in this window.</p> : null}
                  {sharedOptions.map(option => {
                    const alternate = option.plan.legs[index]
                    return <button type="button" key={option.plan.id} onClick={() => selectRoutingPlan(option.plan.id)}>
                      <strong>{alternate.routeShortName || alternate.routeId}</strong>
                      <span>{formatScheduleClock(alternate.startMinutes)} → {formatScheduleClock(alternate.endMinutes)}</span>
                      <small>{alternate.routeId} · Arrive {formatScheduleClock(option.plan.arriveMinutes ?? option.plan.departMinutes + option.plan.durationMinutes)}</small>
                    </button>
                  })}
              </div> : null}
          </div>
        </li>
      })}
      <li className="journey-finish">
        <time className="journey-clock">{formatScheduleClock(arrival)}</time>
        <span className="journey-node-mark" aria-hidden="true" />
        <strong className="journey-place">Arrive at {journeyPlace(destinationLabel || plan.legs.at(-1)?.toName || plan.destination.label, 'Destination')}</strong>
      </li>
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


  return (
    <aside className="routing-detail-panel" aria-label="Routing details" data-map-occluder="">
      <header className="routing-detail-head">
        <div className="routing-detail-title">
          <p className="journey-eyebrow">{plan.travelMode === 'transit' ? routingDataModeLabel(plan) || 'Transit' : plan.travelMode === 'drive' ? 'Drive' : 'Walk'} journey</p>
          <div className="routing-detail-time">
            <h2><JourneyDuration minutes={routingPlanTotalElapsedMinutes(plan)} suffix=" total" /></h2>
            <p className="journey-time-range">{formatScheduleClock(plan.departMinutes)} <span aria-hidden="true">→</span> {formatScheduleClock(plan.arriveMinutes ?? plan.departMinutes + plan.durationMinutes)}</p>
          </div>
        </div>
        <div className="routing-detail-actions">
          <ResultExportActions label="Save journey" formats={['json', 'md', 'geojson', 'csv']} resultKey={plan}
            unavailable={journeyGeometryAvailable(plan) ? {} : { geojson: 'Complete path geometry is unavailable' }}
            onExport={format => exportJourney(plan, format)} />
          <button ref={closeButtonRef} type="button" className="kit-icon-button routing-detail-close" onClick={onClose} aria-label="Close routing details" title="Close details"><X size={16} aria-hidden="true" /></button>
        </div>
        {plan.legs.length ? <JourneyLegStrip plan={plan} /> : null}
        <p className="journey-overview">{plan.travelMode === 'transit' ? `${plan.transfers} transfer${plan.transfers === 1 ? '' : 's'} · ` : ''}{plan.travelMode === 'drive' ? `${formatRoutingMinutes(plan.rideMinutes)} driving` : `${formatRoutingMinutes(plan.walkMinutes)} walking`}{plan.waitMinutes > 0 ? ` · ${formatRoutingMinutes(plan.waitMinutes)} waiting en route` : ''}</p>
      </header>
      <div className="routing-detail-scroll">
        <RoutingItinerary plan={plan} />
      </div>
    </aside>
  )
}
