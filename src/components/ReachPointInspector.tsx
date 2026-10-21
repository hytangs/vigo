import { ChevronRight, X } from 'lucide-react'
import { reachHasServiceChanges, reachPointSample } from '../app/reachInspection'
import type { useReachInspection } from '../app/useReachInspection'
import { formatScheduleClock } from '../scheduledVehicles'
import { RoutingItinerary } from './JourneyItinerary'

function minutes(value: number) {
  return `${Number(value.toFixed(1))} min`
}

const coordinateLabel = /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/u

export function ReachPointInspector({ inspection }: { inspection: ReturnType<typeof useReachInspection> }) {
  const { point, source, plan, loading, error } = inspection
  if (!point || !source) return null
  const result = source.result, request = result.request
  const baseline = reachPointSample(result, point.coordinate, 'baseline')
  const scenario = reachHasServiceChanges(result) ? reachPointSample(result, point.coordinate, 'scenario') : null
  const cutoff = Math.max(...request.cutoffsMinutes)
  // Arrive-by explains a point by the journey from it, timed to the deadline.
  const arriveBy = request.timePreference === 'arrive'
  const arrival = plan?.status === 'ready' ? plan.arriveMinutes ?? plan.departMinutes + plan.durationMinutes : null
  const elapsed = plan?.status === 'ready' ? arriveBy ? request.departMinutes - plan.departMinutes : arrival! - request.departMinutes : null
  const sampleLabel = (sample: typeof baseline) => sample.status === 'sampled' ? `≈ ${minutes(sample.minutes)}${sample.estimatedBlock ? ' · block estimate' : ''}`
    : sample.status === 'outside' ? 'Outside map extent' : 'No sampled street here'
  const unnamed = coordinateLabel.test(point.label.trim())
  const budget = Number(cutoff.toFixed(2))
  return <aside className="reach-point-inspector" aria-label={arriveBy ? 'Travel time from selected point' : 'Travel time to selected point'}>
    <header>
      <div>
        <span>{arriveBy ? 'Start' : 'Destination'}</span>
        <h2>{unnamed ? 'Dropped pin' : point.label}</h2>
        {unnamed || point.named ? <small>{point.coordinate[1].toFixed(5)}, {point.coordinate[0].toFixed(5)}</small> : null}
      </div>
      <button type="button" className="icon-button" aria-label={arriveBy ? 'Close start point' : 'Close destination'} onClick={inspection.close}><X size={16} /></button>
    </header>
    <div className="reach-point-scroll">
      <div className="reach-point-time" role="status" aria-live="polite">
        {scenario ? <span>Scheduled journey</span> : null}
        {loading ? <><strong>Checking journey…</strong><span>{arriveBy ? `To ${request.destination?.label}` : `From ${request.origin?.label}`}</span></>
          : elapsed !== null ? <>
            <strong>{minutes(elapsed)}</strong>
            <span>{arriveBy ? `Leave ${formatScheduleClock(plan!.departMinutes)} · arrive by ${formatScheduleClock(request.departMinutes)}`
              : `Arrive ${formatScheduleClock(arrival!)} · depart ${formatScheduleClock(request.departMinutes)}`} · {request.serviceDate}</span>
            <em className="reach-point-budget" data-tone={elapsed > cutoff ? 'watch' : 'good'}>
              {elapsed > cutoff ? `${minutes(elapsed - cutoff)} beyond the ${budget} min budget` : `Within the ${budget} min budget`}
            </em>
          </>
            : <><strong>{error ? 'Could not check journey' : 'No journey found'}</strong><span>{error || plan?.detail}</span></>}
      </div>
      <dl className="reach-point-estimates"><div><dt>{scenario ? 'Baseline map estimate' : 'Map estimate'}</dt><dd>{sampleLabel(baseline)}</dd></div>
        {scenario ? <div><dt>{request.scenario.name}</dt><dd>{sampleLabel(scenario)}</dd></div> : null}
      </dl>
      {elapsed === null ? <p className="reach-point-context">{request.serviceDate} · {arriveBy ? 'arrive by' : 'depart'} {formatScheduleClock(request.departMinutes)}</p> : null}
      {baseline.status === 'sampled' && baseline.estimatedBlock || scenario?.status === 'sampled' && scenario.estimatedBlock
        ? <p className="reach-point-note">Block shading estimates access from surrounding streets. The journey checks your selected point separately.</p> : null}
      {scenario ? <p className="reach-point-note">The journey below uses scheduled service. Planned changes are included in the scenario map estimate.</p> : null}
      {request.mode !== 'drive' && plan && typeof plan.diagnostics.walkingSpeedKph === 'number' && Math.abs(plan.diagnostics.walkingSpeedKph - (request.walkSpeedKph ?? 4.8)) > 0.001
        ? <p className="reach-point-note">Journey walking: {plan.diagnostics.walkingSpeedKph} km/h. Map walking: {request.walkSpeedKph} km/h.</p> : null}
      {error ? <button type="button" className="button button-secondary" onClick={inspection.retry}>Try again</button> : null}
      {plan?.status === 'ready' ? <details className="reach-point-journey" key={`${source.id}:${point.coordinate.join(',')}`} open>
        <summary><span>Journey</span><ChevronRight size={15} aria-hidden="true" /></summary>
        <RoutingItinerary plan={plan} destinationLabel={point.named && !arriveBy ? point.label : undefined} />
      </details> : null}
    </div>
  </aside>
}
