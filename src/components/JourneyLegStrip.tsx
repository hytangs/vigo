import { Bus, Car, ChevronRight, Footprints, Ship, TrainFront, TramFront } from 'lucide-react'
import type { CSSProperties } from 'react'
import { formatRoutingMinutes, isSameStationTransfer, routingLegColor, routingLegTextColor } from '../app/presentation'
import { classNames } from '../domain'
import type { RoutingPlan } from '../routingModel'

export function RouteTypeIcon({ routeType, size = 12 }: { routeType?: number; size?: number }) {
  if (routeType === 3 || routeType === 11) return <Bus size={size} aria-hidden="true" />
  if (routeType === 0 || routeType === 5) return <TramFront size={size} aria-hidden="true" />
  if (routeType === 4) return <Ship size={size} aria-hidden="true" />
  return <TrainFront size={size} aria-hidden="true" />
}

/** Proportional walk / wait / ride bar with the boarded services as route-coloured badges. */
export function JourneyLegStrip({ plan, showBar = true }: { plan: RoutingPlan; showBar?: boolean }) {
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
      {showBar ? <span className="pathfinder-leg-bar">{segments}</span> : null}
    </span>
  )
}
