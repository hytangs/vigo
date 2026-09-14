import { useEffect, useRef, useState } from 'react'
import { Download, RefreshCw } from 'lucide-react'
import { apiJson } from '../app/api'
import type { OperationsRecord } from '../agency/operationsTypes'

type Candidate = { id: string; label: string; holdSeconds: number; modeledPassengerMinutes: number; changePassengerMinutes: number; onboardExtraPassengerMinutes: number; downstream: Array<{ stopName: string; frontSeconds: number; backSeconds: number; delaySeconds: number }> }
type Replay = {
  package: { title: string; agency: string; timetableVersion: string; knownUnknowns: string[]; cases: Array<{ id: string; label: string }> }
  run: null | {
    id: string; version: number; caseId: string; clock: string; frame: string
    input: { stopName: string; destination: string; sourceAt: string | null; expiresAt: string; frontSeconds: number; backSeconds: number; scheduledHeadwaySeconds: number; problems: string[]; spacingEstablished: boolean }
    procedure: { status: string; note: string; rejected: Array<{ id: string; reason: string }>; records: Array<{ id: string; title: string; body: string; appliesBecause: string; procedure: { revision: string; section: string; authority: string } }> }
    comparison: { status: string; reason?: string; selectedId: string | null; candidates: Candidate[]; assumptions?: string[]; limits?: string[] }
    decision: null | { status: string; current: boolean; candidate: Candidate; expiresAt: string; approvedBy: string | null }
    message: OperationsRecord | null
    attempts: Array<{ attempt: number; status: string; detail?: string; receipt?: string }>
    ai: null | { status: string; candidateId?: string; reason?: string; latencyMs: number; model: string; privacy: string }
  }
}
const minutes = (seconds: number) => `${Number((seconds / 60).toFixed(1))} min`
const time = (at: string | null) => at ? new Date(at).toLocaleTimeString([], { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : 'Unknown'

export function AgencyReplay({ endpoint, capabilities }: { endpoint: string; capabilities: string[] }) {
  const [data, setData] = useState<Replay | null>(null), [caseId, setCaseId] = useState('disruption'), [candidateId, setCandidateId] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController(); request.current = controller
    void apiJson<Replay>(endpoint, { method: 'POST', body: JSON.stringify({ action: 'replay-state' }), signal: controller.signal }).then(value => { setData(value); setCandidateId(value.run?.comparison.selectedId || ''); if (value.run) setCaseId(value.run.caseId) }).catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
    return () => { request.current?.abort() }
  }, [endpoint])
  const run = data?.run
  async function command(action: string, fields: Record<string, unknown> = {}) {
    if (busy) return
    const controller = new AbortController(); request.current?.abort(); request.current = controller
    setBusy(true); setError('')
    try {
      const value = await apiJson<Replay>(endpoint, { method: 'POST', body: JSON.stringify({ action, runId: run?.id, version: run?.version, ...fields }), signal: controller.signal })
      if (!controller.signal.aborted) { setData(value); if (action === 'replay-start') setCandidateId(value.run?.comparison.selectedId || '') }
    } catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  async function download() {
    try {
      const record = await apiJson<unknown>(endpoint, { method: 'POST', body: JSON.stringify({ action: 'replay-export' }) })
      const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }))
      const link = document.createElement('a'); link.href = url; link.download = `vigo-replay-${run?.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (reason) { setError((reason as Error).message) }
  }
  const canPrepare = capabilities.includes('draft'), canApprove = capabilities.includes('approve'), canDeliver = capabilities.includes('publish')
  const total = run ? run.input.frontSeconds + run.input.backSeconds : 0
  const middle = total > 0 && run ? 30 + 360 * run.input.frontSeconds / total : 210
  return <section className="agency-replay" aria-label="Operational replay">
    <header><span className="agency-caption">SYNTHETIC REPLAY · {data?.package.agency || 'City X'}</span><h3>One bus, one decision</h3><p>Compare a hold, review the procedure, then test the rider message in a sandbox.</p></header>
    <div className="agency-ops-fields"><label>Scenario<select value={caseId} disabled={busy} onChange={event => setCaseId(event.target.value)}>{data?.package.cases.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label><button className="agency-button" disabled={busy || !canPrepare || !data} onClick={() => void command('replay-start', { caseId })}>{run ? 'Open new run' : 'Open scenario'}</button></div>
    {error ? <p role="alert" className="agency-error">{error}</p> : null}
    {busy ? <p role="status" className="agency-caption">Working on this replay…</p> : null}
    {run ? <>
      <div className="agency-replay-clock"><strong>{run.clock.slice(0, 10)} · {time(run.clock)} UTC · replay clock</strong><span>Source {time(run.input.sourceAt)} · timetable {data?.package.timetableVersion}</span></div>
      <div className="agency-replay-observation"><strong>{run.input.stopName} → {run.input.destination}</strong>
        <p>{!run.input.spacingEstablished ? 'Current spacing cannot be established. The diagram shows the retained prediction.' : run.input.frontSeconds === run.input.backSeconds ? 'Predicted departures are evenly spaced.' : run.input.frontSeconds < run.input.backSeconds ? 'The selected bus has a shorter gap ahead and a longer gap behind it.' : 'The selected bus has a longer gap ahead and a shorter gap behind it.'}</p>
        <svg viewBox="0 0 420 80" role="img" aria-label={`Predicted gap ahead ${minutes(run.input.frontSeconds)}, gap behind ${minutes(run.input.backSeconds)}. Scheduled ${minutes(run.input.scheduledHeadwaySeconds)}.`}>
          <line x1="30" y1="30" x2="390" y2="30" stroke="currentColor" opacity=".35" strokeWidth="3" />
          {[30, middle, 390].map((x, i) => <circle key={i} cx={x} cy="30" r={i === 1 ? 7 : 4} fill={i === 1 ? 'var(--accent)' : 'currentColor'} />)}
          <text x={(30 + middle) / 2} y="15" textAnchor="middle">{minutes(run.input.frontSeconds)}</text><text x={(middle + 390) / 2} y="15" textAnchor="middle">{minutes(run.input.backSeconds)}</text>
          <text x="30" y="62" textAnchor="start">Ahead</text><text x={middle} y="48" textAnchor="middle">This bus</text><text x="390" y="62" textAnchor="end">Following</text>
        </svg><p className="agency-caption">Scheduled interval: {minutes(run.input.scheduledHeadwaySeconds)}. Positions above represent departure spacing, not vehicle locations.</p>
      </div>
      <details className="agency-ops-new"><summary>{run.procedure.status === 'applicable' ? 'Applicable procedure' : run.procedure.status === 'conflict' ? 'Conflicting procedures — escalate' : 'No applicable procedure'}</summary>{run.procedure.records.map(record => <article key={record.id}><strong>{record.title}</strong><p className="agency-caption">Revision {record.procedure.revision} · {record.procedure.section} · {record.procedure.authority}</p><p className="agency-ops-prose">{record.body}</p><p>{record.appliesBecause}</p></article>)}<p>{run.procedure.note}</p>{run.procedure.rejected.length ? <p>{run.procedure.rejected.length} other sections excluded by scope, validity or prerequisites.</p> : null}</details>
      {run.comparison.status === 'ready' ? <>
        <div className="agency-replay-options" role="radiogroup" aria-label="Holding alternatives">{run.comparison.candidates.map(candidate => <label key={candidate.id} className="agency-replay-option"><input type="radio" name="holding-candidate" value={candidate.id} checked={candidateId === candidate.id} disabled={busy} onChange={() => setCandidateId(candidate.id)} /><span><strong>{candidate.label} · {candidate.holdSeconds ? `${candidate.holdSeconds} seconds` : 'depart without an extra hold'}</strong><small>{candidate.changePassengerMinutes === 0 ? 'Reference outcome' : `${Math.abs(Math.round(candidate.changePassengerMinutes))} passenger-minutes ${candidate.changePassengerMinutes < 0 ? 'saved' : 'added'} in the simulation`} · {Math.round(candidate.onboardExtraPassengerMinutes)} added on board</small></span></label>)}</div>
        <details><summary>Model assumptions and downstream effects</summary>{run.comparison.assumptions?.map(line => <p key={line}>{line}</p>)}{run.comparison.candidates.find(c => c.id === candidateId)?.downstream.map(s => <p key={s.stopName}>{s.stopName}: {minutes(s.frontSeconds)} ahead · {minutes(s.backSeconds)} behind · {minutes(s.delaySeconds)} from schedule</p>)}{run.comparison.limits?.map(line => <p key={line}>{line}</p>)}</details>
        <button className="agency-button" disabled={busy || !candidateId || !canPrepare} onClick={() => void command('replay-prepare', { candidateId })}>Prepare selected option</button>
      </> : <p className="agency-ops-availability">{run.comparison.reason}</p>}
      {run.decision && run.message ? <article className="agency-ops-detail"><h3>{run.decision.current ? 'Review the decision and rider message' : 'Reconsider this decision'}</h3><p className="agency-ops-prose">{run.message.body}</p><p className="agency-caption">{run.message.status} · valid until {time(run.decision.expiresAt)} UTC{run.decision.approvedBy ? ` · reviewed by ${run.decision.approvedBy}` : ''}</p>
        {!run.decision.current ? <p className="agency-ops-availability">The evidence has changed or expired. This copy cannot be sent. A delivered sandbox copy is withdrawn.</p> : null}
        <div className="agency-ops-actions">{run.decision.current && run.decision.status === 'draft' && canApprove ? <button className="agency-button is-primary" disabled={busy} onClick={() => void command('replay-approve')}>Approve option & message</button> : null}{run.decision.current && run.decision.status === 'approved' && ['approved', 'released'].includes(run.message.status) && canDeliver ? <button className="agency-button is-primary" disabled={busy} onClick={() => void command('replay-deliver')}>{run.attempts.length ? 'Retry sandbox delivery' : 'Send to sandbox'}</button> : null}{['released', 'delivered'].includes(run.message.status) && canDeliver ? <button className="agency-text-button" disabled={busy} onClick={() => void command('replay-withdraw')}>Withdraw sandbox copy</button> : null}</div>
        {run.attempts.map(attempt => <p className="agency-caption" key={attempt.attempt}>Attempt {attempt.attempt}: {attempt.detail || `Sandbox receipt recorded (${attempt.status}).`}</p>)}
      </article> : null}
      <details><summary>Optional AI review</summary><p className="agency-caption">The model inspects the procedure and alternatives and selects from those options. It cannot approve or send anything.</p><button className="agency-button" disabled={busy || !canPrepare} onClick={() => void command('replay-ai')}>Review with AI</button>{run.ai ? <><p>{run.ai.status === 'complete' ? `Suggested: ${run.comparison.candidates.find(c => c.id === run.ai?.candidateId)?.label || 'Escalate for review'}.` : run.ai.reason}</p><p className="agency-caption">{run.ai.model} · {(run.ai.latencyMs / 1000).toFixed(1)} s · {run.ai.privacy}</p></> : null}</details>
      <div className="agency-ops-actions"><button className="agency-button" disabled={busy || run.frame === 'changed' || !canPrepare} onClick={() => void command('replay-advance', { to: 'changed' })}><RefreshCw size={13} />Next observation</button><button className="agency-button" disabled={busy || !canPrepare || Boolean(run.input.problems.length)} onClick={() => void command('replay-advance', { to: 'expired' })}>Expire evidence</button><button className="agency-text-button" disabled={busy} onClick={() => void download()}><Download size={13} />Export replay & audit</button></div>
    </> : null}
    <p className="agency-caption">Synthetic procedures and passenger inputs. No agency reviewer or real-world impact has been established. The sandbox never publishes to riders.</p>
  </section>
}
