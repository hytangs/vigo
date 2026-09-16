import type { AgencyState } from '../agency/types'
import { routeBrowserFreshness, routeDelayLabel } from '../agency/routeBrowser'

export function AgencyRouteCoverage({ state, route, refreshFailed }: { state: AgencyState; route: AgencyState['routes'][number]; refreshFailed: boolean }) {
  const freshness = routeBrowserFreshness(state, Date.now(), refreshFailed)
  const reporting = freshness.predictions && route.reportingTrips > 0
  const delay = routeDelayLabel(route, freshness)
  return <details className="agency-route-coverage"><summary>Route coverage</summary>
    <p>{reporting ? `${route.reportingTrips} current trip reports` : 'No current trip reports'}{freshness.alerts && route.alerts ? ` · ${route.alerts} alerts` : ''}{delay ? ` · ${delay} predicted` : ''}</p>
    {reporting && route.widestInterval ? <p>Worst predicted gap: {Math.round(route.widestInterval.predictedSeconds / 60)} min / {Math.round(route.widestInterval.scheduledSeconds / 60)} min scheduled · {route.widestInterval.stopName} · direction {route.widestInterval.directionId ?? 'unknown'} · {route.comparedPairs ?? 0} stop-pair comparisons</p> : <p>Headway coverage unknown.</p>}
    <p>{freshness.detail} Predicted gaps do not confirm vehicle passage.</p>
  </details>
}
