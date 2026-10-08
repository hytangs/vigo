import { ArrowRight, X } from 'lucide-react'
import { reachHasServiceChanges, reachPointSample } from '../app/reachInspection'
import type { useReachInspection } from '../app/useReachInspection'
import { formatScheduleClock } from '../scheduledVehicles'
import { RoutingItinerary } from './JourneyItinerary'

function minutes(value: number) {
  return `${Number(value.toFixed(1))} min`
}

export function ReachPointInspector({ inspection }: { inspection: ReturnType<typeof useReachInspection> }) {
  const { point, source, sources, plan, loading, error } = inspection
  if (!point || !source) return null
  const result = source.result, request = result.request
  const baseline = reachPointSample(result, point.coordinate, 'baseline')
  const scenario = reachHasServiceChanges(result) ? reachPointSample(result, point.coordinate, 'scenario') : null
  const cutoff = Math.max(...request.cutoffsMinutes)
  const elapsed = plan?.status === 'ready' ? (plan.arriveMinutes ?? plan.departMinutes + plan.durationMinutes) - request.departMinutes : null
  const longerDirectWalk = plan?.status === 'ready' && plan.travelMode === 'walk'
    && plan.legs.reduce((sum, leg) => sum + (leg.distanceKm ?? 0), 0) > request.maxWalkKm
  const sampleLabel = (sample: typeof baseline) => sample.status === 'sampled' ? `≈ ${minutes(sample.minutes)}${sample.estimatedBlock ? ' · block estimate' : ''}`
    : sample.status === 'outside' ? 'Outside map extent' : 'No sampled street here'
  return <aside className="reach-point-inspector" aria-label="Travel time to selected point">
    <header>
      <div><span>Selected destination</span><h2>{point.label}</h2></div>
      <button type="button" className="icon-button" aria-label="Close destination" onClick={inspection.close}><X size={18} /></button>
    </header>
    <div className="reach-point-scroll">
      {sources.length > 1 ? <label className="reach-field">Timetable<select value={source.id} onChange={event => inspection.selectSource(event.target.value)}>
        {sources.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label> : null}
      <div className="reach-point-time" role="status" aria-live="polite">
        {scenario ? <span>Scheduled journey</span> : null}
        {loading ? <><strong>Checking journey…</strong><span>From {request.origin.label}</span></>
          : elapsed !== null ? <><strong>{minutes(elapsed)}</strong><span>Arrive {formatScheduleClock(plan!.arriveMinutes ?? plan!.departMinutes + plan!.durationMinutes)}
            {elapsed > cutoff ? ` · ${minutes(elapsed - cutoff)} beyond budget` : ` · within ${cutoff} min`}</span></>
            : <><strong>{error ? 'Could not check journey' : 'No journey found'}</strong><span>{error || plan?.detail}</span></>}
      </div>
      <dl className="reach-point-estimates"><div><dt>{scenario ? 'Baseline map estimate' : 'Map estimate'}</dt><dd>{sampleLabel(baseline)}</dd></div>
        {scenario ? <div><dt>{request.scenario.name}</dt><dd>{sampleLabel(scenario)}</dd></div> : null}
      </dl>
      <p className="reach-point-context">{request.serviceDate} · depart {formatScheduleClock(request.departMinutes)}</p>
      {baseline.status === 'sampled' && baseline.estimatedBlock || scenario?.status === 'sampled' && scenario.estimatedBlock
        ? <p className="reach-point-note">Block shading estimates access from surrounding streets. The journey checks your selected point separately.</p> : null}
      {longerDirectWalk ? <p className="reach-point-note">This direct walk exceeds the map’s {request.maxWalkKm} km final-walk limit. Journey results also compare walking the whole way.</p> : null}
      {scenario ? <p className="reach-point-note">The journey below uses scheduled service. Planned changes are included in the scenario map estimate.</p> : null}
      {plan && typeof plan.diagnostics.walkingSpeedKph === 'number' && Math.abs(plan.diagnostics.walkingSpeedKph - (request.walkSpeedKph ?? 4.8)) > 0.001
        ? <p className="reach-point-note">Journey walking: {plan.diagnostics.walkingSpeedKph} km/h. Map walking: {request.walkSpeedKph} km/h.</p> : null}
      {error ? <button type="button" className="button button-secondary" onClick={inspection.retry}>Try again</button> : null}
      {plan?.status === 'ready' ? <details className="reach-point-journey" key={`${source.id}:${point.coordinate.join(',')}`}>
        <summary><span>Show journey</span><ArrowRight size={16} aria-hidden="true" /></summary>
        <RoutingItinerary plan={plan} />
      </details> : null}
    </div>
  </aside>
}
