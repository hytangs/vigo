import { Check, ChevronRight, CircleAlert, Download, LoaderCircle } from 'lucide-react'
import type { ApiProgress } from '../app/api'
import type { QueryAnswer } from '../agency/types'
import { downloadText } from '../agency/exports'
import { humanField, toolNames } from '../agency/presentation'

export function AgencyActivity({ activities, busy, trace }: {
  activities: ApiProgress[]; busy: boolean; trace: QueryAnswer['trace']
}) {
  const stopped = activities.some((item) => item.phase === 'stopped')
  const interrupted = activities.some((item) => item.phase === 'provider-error' || item.phase === 'response-error')
  if (!busy && !trace.length && !stopped && !interrupted) return null
  const current = busy ? activities.filter((item) => item.progress < 1).at(-1) : undefined
  const progress = activities.filter((item) => item.phase !== 'planning' || !trace.length && activities.length === 1)
  const visible = (progress.length ? progress : trace.map((call, index) => ({
    phase: `tool-${index}`, progress: call.result.ok ? 1 : 0,
    detail: `${toolNames[call.tool] || humanField(call.tool)}: ${call.result.ok ? 'Complete' : call.result.warnings[0] || 'Could not complete'}`,
  }))).filter((item) => item !== current)
  const completed = trace.filter((call) => call.result.ok).length
  const count = completed === trace.length ? `${completed} ${completed === 1 ? 'check' : 'checks'} completed` : `${completed} of ${trace.length} checks completed`

  return <details className="agency-activity" open={busy}>
    <summary>
      {busy ? <LoaderCircle size={14} className="agency-spinner" /> : interrupted ? <CircleAlert size={14} /> : <Check size={14} />}
      <span aria-live="polite">{busy ? current?.detail || 'Checking your request…' : stopped ? 'Stopped · saved for later' : interrupted ? 'Response interrupted' : count}</span>
      {visible.length || trace.length ? <ChevronRight size={14} /> : null}
    </summary>
    {visible.length ? <ol aria-live="polite">{visible.map((item) => <li key={item.phase}>
      <span className={`agency-activity-mark ${item.progress === 1 ? 'is-done' : ''}`} />{item.detail}
    </li>)}</ol> : null}
    {trace.length ? <button className="agency-text-button agency-record-download" onClick={() => downloadText('agency-investigation.json', JSON.stringify(trace, null, 2), 'application/json')}>
      <Download size={13} /> Download technical record
    </button> : null}
  </details>
}
