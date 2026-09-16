import { useState } from 'react'
import type { NetworkDiagnosis, NetworkNarrative, BriefingInvestigation } from '../agency/networkAssessmentTypes'

export function NetworkAssessment({ narrative, diagnosis, investigation, aiNarrative = false }: { narrative: NetworkNarrative; diagnosis: NetworkDiagnosis; investigation?: BriefingInvestigation; aiNarrative?: boolean }) {
  const [page, setPage] = useState(0)
  const { coverage } = diagnosis
  const assessedRoutes = diagnosis.routes.filter(route => route.scheduledTrips || route.measuredTrips)
  const pageCount = Math.max(1, Math.ceil(assessedRoutes.length / 10))
  const currentPage = Math.min(page, pageCount - 1)
  const visibleRoutes = assessedRoutes.slice(currentPage * 10, (currentPage + 1) * 10)
  return <div className="network-assessment">
    <p className="network-assessment-overview">{narrative.overview}</p>
    {narrative.sections.map(section => <section key={section.id} className="network-assessment-focus"><h4>{section.title}</h4><p>{section.text}</p></section>)}
    {narrative.elsewhere ? <p>{narrative.elsewhere}</p> : null}
    {!aiNarrative && investigation?.assessment ? <section className="network-assessment-focus"><h4>Working explanation{investigation.focusTitle ? ` · ${investigation.focusTitle}` : ''}</h4><p>{investigation.assessment}</p></section> : null}
    {!aiNarrative && investigation?.watchNext ? <p><strong>Watch next · </strong>{investigation.watchNext}</p> : null}
    {investigation?.incomplete ? <p className="agency-caption">The investigation is incomplete. The computed assessment and completed evidence checks are retained.</p> : null}
    {investigation?.explanation ? <details className="network-assessment-coverage"><summary>Investigation · {investigation.checks.filter(check => check.completed).length} checks</summary><p>{investigation.explanation.text}</p><p>Assessment: {investigation.explanation.status}. {investigation.checks.map(check => `${check.aspect.replaceAll('_', ' ')}${check.completed ? '' : ' unavailable'}`).join(' · ')}</p></details> : null}
    {coverage.unknownTrips ? <p className="agency-briefing-scope">{coverage.unknownTrips} scheduled {coverage.unknownTrips === 1 ? 'trip has' : 'trips have'} no usable prediction or cancellation report. {coverage.unknownTrips === 1 ? 'Its condition remains' : 'Their conditions remain'} unknown.</p> : null}
    <details className="network-assessment-coverage">
      <summary>Coverage &amp; route conditions{coverage.scheduledTrips ? ` · ${coverage.reportingScheduledTrips}/${coverage.scheduledTrips} scheduled trips` : ' · no timed trips scheduled'}</summary>
      <p>{narrative.coverage}</p>
      {coverage.reportingShare !== null ? <div className="network-assessment-meter" role="img" aria-label={`${Math.round(coverage.reportingShare * 100)} percent of scheduled vehicle-minutes covered by reporting trips`}><span style={{ width: `${coverage.reportingShare * 100}%` }} /></div> : null}
      {coverage.additionalReportingTrips ? <p>{coverage.additionalReportingTrips} additional reporting trips fall outside this scheduled window; their predictions remain in the assessment.</p> : null}
      <section className="network-route-conditions" aria-label="Route conditions">
        <div className="network-route-heading"><h4>Route conditions</h4><span>Next {diagnosis.window.minutes} minutes</span></div>
        <table className="network-route-table"><caption>Next departure of each reporting trip</caption><thead><tr><th scope="col">Route</th><th scope="col">Reported</th><th scope="col">Later</th><th scope="col">Matches</th><th scope="col">Earlier</th><th scope="col">Cancelled</th></tr></thead><tbody>
          {visibleRoutes.map(route => <tr key={route.id}>
            <th scope="row">{route.name}</th>
            <td data-label="Reported"><strong>{route.reportingScheduledTrips}</strong><span className="network-route-total"> / {route.scheduledTrips}</span><span className="network-route-basis">scheduled</span></td>
            <td data-label="Later" className={route.laterTrips ? 'has-deviation' : ''}>{route.measuredTrips ? route.laterTrips : '—'}</td>
            <td data-label="Matches">{route.measuredTrips ? route.matchingTrips : '—'}</td>
            <td data-label="Earlier" className={route.earlierTrips ? 'has-deviation' : ''}>{route.measuredTrips ? route.earlierTrips : '—'}</td>
            <td data-label="Cancelled" className={route.cancelledTrips ? 'has-deviation' : ''}>{route.cancelledTrips || '—'}</td>
          </tr>)}
        </tbody></table>
        {!assessedRoutes.length ? <p>No routes to assess in this window.</p> : null}
        {pageCount > 1 ? <nav className="network-route-pagination" aria-label="Route conditions pages"><span aria-live="polite">{currentPage * 10 + 1}–{Math.min((currentPage + 1) * 10, assessedRoutes.length)} of {assessedRoutes.length} routes</span><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><button type="button" disabled={currentPage + 1 === pageCount} onClick={() => setPage(currentPage + 1)}>Next</button></nav> : null}
        <p className="network-route-note">— means no usable report. Timing counts include trips outside the scheduled window.</p>
      </section>
      <details className="network-assessment-method"><summary>How to read these counts</summary><p>Reported compares scheduled trips with a usable prediction or cancellation report against all scheduled trips. Later, matches, and earlier compare each reporting trip’s next departure with its timetable; they also include additional reporting trips outside the scheduled window. A dash does not mean on-time service.</p><p>{diagnosis.limits.join(' ')}</p></details>
    </details>
  </div>
}
