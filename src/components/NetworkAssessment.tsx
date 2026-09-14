import type { NetworkDiagnosis, NetworkNarrative, BriefingInvestigation } from '../agency/networkAssessmentTypes'

export function NetworkAssessment({ narrative, diagnosis, investigation }: { narrative: NetworkNarrative; diagnosis: NetworkDiagnosis; investigation?: BriefingInvestigation }) {
  const { coverage } = diagnosis
  const assessedRoutes = diagnosis.routes.filter(route => route.scheduledTrips || route.measuredTrips)
  return <div className="network-assessment">
    <p className="network-assessment-overview">{narrative.overview}</p>
    {narrative.sections.map(section => <section key={section.id} className="network-assessment-focus"><h4>{section.title}</h4><p>{section.text}</p></section>)}
    {narrative.elsewhere ? <p>{narrative.elsewhere}</p> : null}
    {investigation?.assessment ? <section className="network-assessment-focus"><h4>Working explanation{investigation.focusTitle ? ` · ${investigation.focusTitle}` : ''}</h4><p>{investigation.assessment}</p></section> : null}
    {investigation?.watchNext ? <p><strong>Watch next · </strong>{investigation.watchNext}</p> : null}
    {investigation?.incomplete ? <p className="agency-caption">The investigation is incomplete. The computed assessment and completed evidence checks are retained.</p> : null}
    {investigation?.explanation ? <details className="network-assessment-coverage"><summary>Investigation · {investigation.checks.filter(check => check.completed).length} checks</summary><p>{investigation.explanation.text}</p><p>Assessment: {investigation.explanation.status}. {investigation.checks.map(check => `${check.aspect.replaceAll('_', ' ')}${check.completed ? '' : ' unavailable'}`).join(' · ')}</p></details> : null}
    {coverage.unknownTrips ? <p className="agency-briefing-scope">{coverage.unknownTrips} scheduled {coverage.unknownTrips === 1 ? 'trip has' : 'trips have'} no usable prediction or cancellation report. {coverage.unknownTrips === 1 ? 'Its condition remains' : 'Their conditions remain'} unknown.</p> : null}
    <details className="network-assessment-coverage">
      <summary>Coverage &amp; route conditions{coverage.scheduledTrips ? ` · ${coverage.reportingScheduledTrips}/${coverage.scheduledTrips} scheduled trips` : ' · no timed trips scheduled'}</summary>
      <p>{narrative.coverage}</p>
      {coverage.reportingShare !== null ? <div className="network-assessment-meter" role="img" aria-label={`${Math.round(coverage.reportingShare * 100)} percent of scheduled vehicle-minutes covered by reporting trips`}><span style={{ width: `${coverage.reportingShare * 100}%` }} /></div> : null}
      {coverage.additionalReportingTrips ? <p>{coverage.additionalReportingTrips} additional reporting trips fall outside this scheduled window; their predictions remain in the assessment.</p> : null}
      <div className="agency-table-wrap"><table className="agency-table"><caption>Next departure of each reporting trip · next {diagnosis.window.minutes} minutes</caption><thead><tr><th>Route</th><th>Reporting / scheduled</th><th>Later</th><th>Matches</th><th>Earlier</th><th>Cancelled</th></tr></thead><tbody>
        {assessedRoutes.map(route => <tr key={route.id}><td>{route.name}</td><td>{route.reportingScheduledTrips} / {route.scheduledTrips}</td><td>{route.measuredTrips ? route.laterTrips : '—'}</td><td>{route.measuredTrips ? route.matchingTrips : '—'}</td><td>{route.measuredTrips ? route.earlierTrips : '—'}</td><td>{route.cancelledTrips || '—'}</td></tr>)}
      </tbody></table></div>
      <p>Timing counts also include additional reporting trips. A dash means no usable timing prediction, not on-time service.</p>
      <p>{diagnosis.limits.join(' ')}</p>
    </details>
  </div>
}
