type Metrics = { cases: number; maeSeconds: number; p90AbsoluteErrorSeconds: number; biasSeconds: number }
export type LampStudyData = {
  status: string; dataset?: string; range?: { start: string; trainEnd: string; end: string }
  comparison?: { scheduled: Metrics; historical: Metrics; coverage: number; scoredTestSegments: number; eligibleTestSegments: number }
  routes?: Array<{ routeId: string; scheduled: Metrics; historical: Metrics }>
  days?: Array<{ serviceDate: string; scheduled: Metrics; historical: Metrics }>
  filters?: { inputRows: number; eligibleSegments: number }
  limits?: string[]; message?: string
}
const seconds = (value: number) => `${Math.round(value)} s`
export function LampStudyResult({ study }: { study: LampStudyData }) {
  if (!study.comparison || !study.range) return <p className="agency-caption">{study.message || 'No running-time study is available for this selection.'}</p>
  const { comparison, range } = study
  const change = comparison.scheduled.maeSeconds - comparison.historical.maeSeconds
  const days = study.days ?? [], maximum = Math.max(1, ...days.flatMap(day => [day.scheduled.maeSeconds, day.historical.maeSeconds]))
  const chartWidth = 480, column = chartWidth / Math.max(1, days.length)
  return <section className="lamp-study" aria-label="Historical running-time study">
    <h3>Running-time prediction</h3>
    <p>{change >= 0 ? 'Historical segment times produced lower average error than the timetable' : 'The timetable produced lower average error than the historical predictor'} on the held-out dates, by {seconds(Math.abs(change))} per segment on average.</p>
    <div className="lamp-study-metrics"><div><strong>{seconds(comparison.historical.maeSeconds)}</strong><span>Historical model · average error</span></div><div><strong>{seconds(comparison.scheduled.maeSeconds)}</strong><span>Timetable · average error</span></div><div><strong>{seconds(comparison.historical.p90AbsoluteErrorSeconds)}</strong><span>Model · 90th-percentile error</span></div></div>
    <p className="agency-caption">Trained {range.start}–{range.trainEnd} · evaluated through {range.end}. {comparison.scoredTestSegments.toLocaleString()} matched test segments · {comparison.eligibleTestSegments.toLocaleString()} eligible test segments; {comparison.eligibleTestSegments - comparison.scoredTestSegments} without enough training history. Study-wide comparison; segment observations within a trip are dependent.</p>
    {days.length ? <figure className="lamp-study-chart"><figcaption>Average absolute error on later service dates · seconds</figcaption><svg viewBox="0 0 540 150" role="img" aria-label="Historical predictor and timetable errors by held-out service date">
      <line x1="40" x2="530" y1="120" y2="120" /><text x="5" y="22">{Math.ceil(maximum)}</text><text x="20" y="120">0</text>
      {days.map((day, i) => <g key={day.serviceDate}><rect className="lamp-timetable-bar" x={44 + i * column} y={120 - day.scheduled.maeSeconds / maximum * 100} width={column * .35} height={day.scheduled.maeSeconds / maximum * 100}><title>{day.serviceDate}: timetable {seconds(day.scheduled.maeSeconds)}</title></rect><rect className="lamp-model-bar" x={44 + i * column + column * .4} y={120 - day.historical.maeSeconds / maximum * 100} width={column * .35} height={day.historical.maeSeconds / maximum * 100}><title>{day.serviceDate}: historical model {seconds(day.historical.maeSeconds)}</title></rect><text x={44 + i * column + column * .38} y="140" textAnchor="middle">{day.serviceDate.slice(4, 6)}/{day.serviceDate.slice(6)}</text></g>)}
    </svg><p><span className="lamp-timetable-key" /> Timetable <span className="lamp-model-key" /> Historical model</p></figure> : null}
    <div className="agency-table-wrap"><table className="agency-table"><caption>Average absolute error · selected routes</caption><thead><tr><th>Route</th><th>Historical model</th><th>Timetable</th><th>Test segments</th></tr></thead><tbody>{study.routes?.map(route => <tr key={route.routeId}><td>{route.routeId}</td><td>{seconds(route.historical.maeSeconds)}</td><td>{seconds(route.scheduled.maeSeconds)}</td><td>{route.historical.cases.toLocaleString()}</td></tr>)}</tbody></table></div>
    {study.status === 'route_not_covered' ? <p>The selected route has no results in this study. The comparison above describes the complete study.</p> : null}
    <p className="agency-caption">LAMP reconstructed stop events may include arrival predictions. This is a retrospective running-time study, not a live delay forecast or independent sensor validation.</p>
    <details className="agency-source-details"><summary>Study coverage &amp; limits</summary>{study.filters ? <p>{study.filters.eligibleSegments.toLocaleString()} eligible adjacent segments from {study.filters.inputRows.toLocaleString()} source stop rows across training and test dates. Unmatched and ambiguous records are excluded; prediction coverage is conditional on these matches.</p> : null}{study.limits?.map(limit => <p key={limit}>{limit}</p>)}</details>
  </section>
}
