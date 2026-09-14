type WalkingEndpoint = { label?: string; stopName?: string; placeQuery?: string }
type WalkingAssessment = {
  minimumDistanceMiles?: number
  meetsMinimumDistance?: boolean | null
  minutesAfterWalking?: number | null
  fitsIncludingActivities?: boolean | null
}
type WalkingComparison = {
  from: WalkingEndpoint
  to: WalkingEndpoint
  walking: { distanceMiles: number; durationMinutes: number } | null
  assessment?: WalkingAssessment
  error?: string
}
export type WalkingOutput = { comparisons?: WalkingComparison[]; assessment?: WalkingAssessment }

export function AgencyWalkingComparisons({ rows }: { rows: WalkingComparison[] }) {
  const label = (point: WalkingEndpoint, fallback: string) => point.label || point.stopName || point.placeQuery || fallback
  return <div className="agency-query-table"><table>
    <thead><tr><th>Walk</th><th>Distance · time</th><th>Requirement</th></tr></thead>
    <tbody>{rows.map((row, index) => <tr key={index}>
      <td>{label(row.from, 'Origin')} → {label(row.to, 'Destination')}</td>
      <td>{row.walking ? `${row.walking.distanceMiles.toFixed(2)} mi · ${Math.ceil(row.walking.durationMinutes)} min` : 'Not established'}</td>
      <td>{row.assessment?.meetsMinimumDistance === false ? 'Below minimum' : row.assessment?.meetsMinimumDistance === true ? 'Meets minimum' : row.error || '—'}</td>
    </tr>)}</tbody>
  </table></div>
}

export function AgencyWalkingAssessment({ assessment }: { assessment?: WalkingAssessment }) {
  if (!assessment) return null
  const { minimumDistanceMiles, meetsMinimumDistance, minutesAfterWalking, fitsIncludingActivities } = assessment
  return <>
    {minimumDistanceMiles != null ? <p className="agency-caption">
      {meetsMinimumDistance === true ? 'Meets' : meetsMinimumDistance === false ? 'Below' : 'Could not check'} your {minimumDistanceMiles} mile minimum.
    </p> : null}
    {minutesAfterWalking != null ? <p className="agency-caption">
      {minutesAfterWalking >= 0 ? `${Math.floor(minutesAfterWalking)} min left after walking` : `${Math.ceil(-minutesAfterWalking)} min over your budget from walking alone`}
      {fitsIncludingActivities == null ? '. Ordering, eating and other activity time still need to fit.' : fitsIncludingActivities ? '. Fits with your supplied activity time.' : '. Does not fit with your supplied activity time.'}
    </p> : null}
  </>
}
