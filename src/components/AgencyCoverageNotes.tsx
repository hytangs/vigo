const reasonLabels: Record<string, string> = {
  route: 'Route could not be matched uniquely',
  stop: 'Stop could not be matched uniquely',
  'trip instance': 'Trip instance could not be resolved',
  'source feed': 'Source feed is ambiguous',
  'agency ownership unavailable': 'Agency ownership is missing',
  'empty selector': 'Affected service is not specified',
}

export function AgencyCoverageNotes({ warnings }: { warnings: string[] }) {
  const groups = new Map<string, Set<string>>()
  const notes: string[] = []
  const alertIds = new Set<string>()
  for (const warning of new Set(warnings)) {
    const alert = warning.match(/^Alert (.+?): (?:unresolved scope \((.+)\)\.|some selector constraints could not be resolved and are not assigned\.)$/)
    if (!alert) { notes.push(warning); continue }
    alertIds.add(alert[1])
    for (const reason of alert[2]?.split('; ') ?? ['Matching reason unavailable in this saved snapshot']) {
      const label = reasonLabels[reason] ?? reason
      const ids = groups.get(label) ?? new Set<string>()
      ids.add(alert[1]); groups.set(label, ids)
    }
  }
  return <>
    {notes.map(note => <p className="agency-caption" key={note}>{note.includes('intervals cannot be compared')
      ? note.replace('intervals cannot be compared', 'stop-level headway comparisons were skipped') : note}</p>)}
    {notes.some(note => /headway comparisons|intervals cannot be compared/.test(note)) ? <p className="agency-caption">These are comparison limits, not confirmed disruptions. The same trips can be counted at multiple stops.</p> : null}
    {alertIds.size ? <details className="agency-source-details">
      <summary>{alertIds.size} alerts with unresolved scope</summary>
      <p className="agency-caption">Alerts are retained. Only affected-service selectors that can be matched are assigned; unresolved selectors are excluded. An alert may have more than one matching issue.</p>
      {[...groups].map(([reason, ids]) => <details key={reason}><summary>{reason} · {ids.size}</summary><p className="agency-caption">Alert IDs: {[...ids].join(', ')}</p></details>)}
    </details> : null}
  </>
}
