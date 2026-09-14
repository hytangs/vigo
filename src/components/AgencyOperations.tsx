import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, Download, RefreshCw } from 'lucide-react'
import { apiJson } from '../app/api'
import { AgencyReplay } from './AgencyReplay'
import type { AgencyState, OperationalEvent } from '../agency/types'
import type { OperationsRecord, OperationsOverview, HistoricalComparison } from '../agency/operationsTypes'

type Command = (body: Record<string, unknown>) => Promise<void>
const transitions: Record<string, string[]> = { new: ['acknowledged'], acknowledged: ['investigating'], investigating: ['acting', 'resolved'], acting: ['monitoring'], monitoring: ['investigating', 'resolved'], resolved: ['investigating'] }
const words = (value: string) => value.replaceAll('-', ' ')
const minute = (value: number | null) => value === null ? 'Unknown' : `${Number((value / 60).toFixed(1))} min`

function download(record: OperationsRecord) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = `agency-${record.kind}-${record.id}.json`; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function RecordEditor({ record, overview, command, busy, onEvidence }: { record: OperationsRecord; overview: OperationsOverview; command: Command; busy: boolean; onEvidence: (event: OperationalEvent) => void }) {
  const [note, setNote] = useState(''), [text, setText] = useState(record.body || ''), [receipt, setReceipt] = useState('')
  const [outcome, setOutcome] = useState('unable-to-confirm'), [channel, setChannel] = useState('app'), [audience, setAudience] = useState('all-riders')
  const [links, setLinks] = useState((record.knowledge || []).map(link => link.id))
  const can = (capability: string) => overview.principal.capabilities.includes(capability)
  const act = (action: string, fields: Record<string, unknown> = {}) => void command({ action, id: record.id, version: record.version, ...fields })
  return <article className="agency-ops-detail">
    <header><div><span className="agency-caption">{words(record.kind)} · version {record.version}</span><h3>{record.title}</h3></div><span className="agency-filter-chip">{words(record.status)}</span></header>
    <p className="agency-caption">Updated {new Date(record.updatedAt).toLocaleString()}{record.owner ? ` · ${record.owner}` : ''}</p>
    {record.event ? <button className="agency-text-button" onClick={() => onEvidence(record.event!)}>Open source evidence <ArrowRight size={13} /></button> : null}
    {record.kind === 'finding' ? <>
      <p className="agency-ops-availability">{record.availability?.status === 'current' ? record.availability.changed ? 'Evidence has changed. Refresh before reviewing rider guidance.' : 'Supported by the current observation.' : record.availability?.reason || 'Current availability has not been checked.'}</p>
      {record.note ? <p className="agency-ops-prose">{record.note}</p> : null}
      {record.outcome ? <p>Resolution: {words(record.outcome.label)} · {record.outcome.source}</p> : null}
      {can('finding') ? <>
        <label>Investigation / action note<textarea value={note} onChange={event => setNote(event.target.value)} maxLength={2000} rows={3} /></label>
        <details><summary>Link approved operational context</summary>{overview.knowledge.filter(item => item.status === 'approved' && Date.parse(item.validUntil!) > Date.now()).map(item => <label className="agency-ops-check" key={item.id}><input type="checkbox" checked={links.includes(item.id)} onChange={event => setLinks(event.target.checked ? [...links, item.id] : links.filter(id => id !== item.id))} />{item.title}</label>)}</details>
        {transitions[record.status]?.includes('resolved') ? <div className="agency-ops-fields"><label>Resolution outcome<select value={outcome} onChange={event => setOutcome(event.target.value)}><option value="unable-to-confirm">Unable to confirm</option><option value="confirmed-recovery">Recovery confirmed by staff</option><option value="false-positive">False positive</option></select></label><label>Resolution evidence<input value={receipt} onChange={event => setReceipt(event.target.value)} maxLength={2000} placeholder="Reference, observation or verification record" /></label></div> : null}
        <div className="agency-ops-actions">{(transitions[record.status] || []).map(status => <button className="agency-button" disabled={busy || !note.trim() || status === 'resolved' && !receipt.trim()} key={status} onClick={() => act('operations-transition', { status, note, knowledge: links, outcome, resolutionSource: receipt })}>{status === 'acknowledged' ? 'Acknowledge' : status === 'investigating' ? 'Investigate' : status === 'acting' ? 'Record action' : status === 'monitoring' ? 'Monitor' : 'Resolve'}</button>)}<button className="agency-text-button" disabled={busy || record.availability?.status !== 'current'} onClick={() => act('operations-refresh')}><RefreshCw size={13} />Refresh evidence</button></div>
      </> : null}
      {can('draft') && record.status !== 'resolved' ? <div className="agency-ops-compose"><h4>Prepare rider guidance</h4><div className="agency-ops-fields"><label>Channel<select value={channel} onChange={event => setChannel(event.target.value)}>{['app', 'service-alert', 'social', 'signage'].map(value => <option key={value} value={value}>{words(value)}</option>)}</select></label><label>Audience<select value={audience} onChange={event => setAudience(event.target.value)}>{['all-riders', 'at-stop', 'accessible-travel'].map(value => <option key={value} value={value}>{words(value)}</option>)}</select></label></div><button className="agency-button" disabled={busy || record.availability?.status !== 'current' || record.availability.changed} onClick={() => act('message-draft', { findingId: record.id, channel, audience })}>Create draft</button></div> : null}
    </> : record.kind === 'message' ? <>
      <p className="agency-caption">{words(record.channel!)} · {words(record.audience!)} · English · expires {new Date(record.expiresAt!).toLocaleString()}</p>
      {['draft', 'approved'].includes(record.status) && can('draft') ? <><label>Rider message<textarea rows={5} value={text} onChange={event => setText(event.target.value)} /></label><p className="agency-caption">{[...text].length} / {record.limit} characters. Saving changes requires another approval.</p><button className="agency-button" disabled={busy || !text.trim() || [...text].length > record.limit! || text === record.body} onClick={() => act('message-edit', { text })}>Save revision</button></> : <p className="agency-ops-prose">{record.body}</p>}
      {record.approvedBy ? <p className="agency-caption">Reviewed by {record.approvedBy}</p> : null}
      <div className="agency-ops-actions">
        {record.status === 'draft' && can('approve') ? <button className="agency-button is-primary" disabled={busy || text !== record.body || [...text].length > record.limit!} onClick={() => act('message-approve')}><Check size={14} />Approve saved copy</button> : null}
        {record.status === 'approved' && can('publish') ? <button className="agency-button is-primary" disabled={busy || text !== record.body} onClick={() => act('message-release')}>Release to local outbox</button> : null}
        {['released', 'delivered'].includes(record.status) ? <button className="agency-button" onClick={() => download(record)}><Download size={14} />Export approved handoff</button> : null}
      </div>
      {record.status === 'released' && can('publish') ? <><p className="agency-caption">{overview.delivery.note}</p><label>Delivery receipt<input value={receipt} onChange={event => setReceipt(event.target.value)} maxLength={2000} placeholder="Channel confirmation or published URL" /></label><button className="agency-button" disabled={busy || !receipt.trim()} onClick={() => act('message-delivery', { receipt })}>Record confirmed delivery</button></> : null}
      {record.delivery ? <p>Staff-recorded delivery: {record.delivery.receipt}</p> : null}
      {['released', 'delivered'].includes(record.status) && can('publish') ? <><label>Withdrawal reason<input value={note} onChange={event => setNote(event.target.value)} maxLength={2000} /></label><button className="agency-text-button" disabled={busy || !note.trim()} onClick={() => act('message-withdraw', { note })}>Withdraw local handoff</button><p className="agency-caption">Remove any published copy in its agency channel too.</p></> : null}
      <details><summary>Sources and reviewed context</summary>{record.evidenceRefs?.map(source => <p className="agency-caption" key={source}>{source}</p>)}{record.knowledge?.map(link => <p key={link.id}>{link.title} · version {link.version}</p>)}</details>
    </> : <>
      <p className="agency-ops-prose">{record.body}</p><p className="agency-caption">Source: {record.source}<br />Review by {new Date(record.validUntil!).toLocaleString()}</p>
      <p className="agency-caption">{record.visibility === 'public' ? 'Public context · model use allowed after approval' : 'Internal context · excluded from model and web tools'}</p>
      {record.procedure ? <p className="agency-caption">{record.procedure.documentId} · revision {record.procedure.revision} · {record.procedure.section} · authority: {record.procedure.authority}</p> : null}
      <p className="agency-caption">Scope: {record.routeIds?.join(', ') || 'City'}{record.stopIds?.length ? ` · stops ${record.stopIds.join(', ')}` : ''}</p>
      {record.status === 'draft' && can('approve') ? <button className="agency-button" disabled={busy} onClick={() => act('knowledge-approve')}>Approve context</button> : null}
      {can('knowledge') ? <details><summary>Revise context</summary><KnowledgeForm record={record} state={null} command={command} busy={busy} /></details> : null}
    </>}
  </article>
}

function KnowledgeForm({ record, state, command, busy }: { record?: OperationsRecord; state: AgencyState | null; command: Command; busy: boolean }) {
  const [title, setTitle] = useState(record?.title || ''), [text, setText] = useState(record?.body || ''), [source, setSource] = useState(record?.source || '')
  const [visibility, setVisibility] = useState(record?.visibility || 'internal')
  const [kind, setKind] = useState(record?.type || 'sop'), [routeId, setRouteId] = useState(record?.routeIds?.[0] || '')
  const [validUntil, setValidUntil] = useState((record?.validUntil || new Date(Date.now() + 30 * 86_400_000).toISOString()).slice(0, 10))
  return <form className="agency-ops-form" onSubmit={event => { event.preventDefault(); void command({ action: 'knowledge-save', id: record?.id, version: record?.version, title, text, source, kind, validUntil, visibility, procedure: record?.procedure, routeIds: record?.routeIds || (routeId ? [routeId] : []), stopIds: record?.stopIds || [] }) }}>
    <label>Title<input required value={title} onChange={event => setTitle(event.target.value)} maxLength={160} /></label>
    <div className="agency-ops-fields"><label>Type<select value={kind} onChange={event => setKind(event.target.value)}>{['sop', 'maintenance', 'document', 'operating-note'].map(value => <option key={value} value={value}>{words(value)}</option>)}</select></label>{state ? <label>Route scope<select value={routeId} onChange={event => setRouteId(event.target.value)}><option value="">City-wide</option>{state.routes.map(route => <option key={route.id} value={route.id}>{route.name}</option>)}</select></label> : null}</div>
    <label>Operational context<textarea required value={text} onChange={event => setText(event.target.value)} maxLength={20000} rows={4} /></label>
    <label>Source reference<input required value={source} onChange={event => setSource(event.target.value)} maxLength={2000} placeholder="Document title, revision, page or internal reference" /></label>
    <label className="agency-ops-check"><input type="checkbox" checked={visibility === 'public'} onChange={event => setVisibility(event.target.checked ? 'public' : 'internal')} />Public material — allow approved excerpts to reach the configured AI endpoint</label>
    <p className="agency-caption">Internal by default. Staff notes and internal procedures stay in Operations; they are excluded from Ask and its web tools.</p>
    <label>Review date<input required type="date" value={validUntil} onChange={event => setValidUntil(event.target.value)} /></label>
    <button className="agency-button" disabled={busy} type="submit">Save for review</button>
  </form>
}

export function AgencyOperations({ endpoint, state, onEvidence }: { endpoint: string; state: AgencyState; onEvidence: (event: OperationalEvent) => void }) {
  const [overview, setOverview] = useState<OperationsOverview | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [view, setView] = useState<'finding' | 'message' | 'knowledge' | 'history' | 'replay'>('finding'), [selected, setSelected] = useState<string | null>(null)
  const [records, setRecords] = useState<OperationsRecord[] | null>(null), [search, setSearch] = useState(''), [baseline, setBaseline] = useState<HistoricalComparison | null>(null), [route, setRoute] = useState('')
  const [audit, setAudit] = useState<Array<{ sequence: number; version: number; at: string; actor: string; action: string; data: unknown }> | null>(null)
  const generation = useRef(0), readGeneration = useRef(0), mutation = useRef(false), mounted = useRef(true)
  const call = <T,>(body: Record<string, unknown>, signal?: AbortSignal) => apiJson<T>(endpoint, { method: 'POST', body: JSON.stringify(body), signal })
  useEffect(() => { mounted.current = true; const controller = new AbortController(); const current = ++generation.current
    void call<OperationsOverview>({ action: 'operations-overview' }, controller.signal).then(value => { if (!controller.signal.aborted && generation.current === current) setOverview(value) }).catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
    return () => { mounted.current = false; controller.abort() }
  }, [endpoint, state.generatedAt])
  const command: Command = async body => {
    if (mutation.current) return
    mutation.current = true
    setBusy(true); setError(''); ++generation.current; ++readGeneration.current
    try { const result = await call<OperationsRecord>(body); const next = await call<OperationsOverview>({ action: 'operations-overview' }); if (!mounted.current) return
      setOverview(next); setRecords(null); setSearch(''); setAudit(null)
      if (result?.id) { setSelected(result.id); setView(result.kind) }
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : 'Could not save this operation.') }
    finally { mutation.current = false; if (mounted.current) setBusy(false) }
  }
  const fetchRecords = async (more = false) => {
    const current = ++readGeneration.current
    setError('')
    try { const result = await call<{ records: OperationsRecord[] }>({ action: 'operations-list', kind: view, query: { search, before: more ? (records || list).at(-1)?.id || '' : '' } }); if (mounted.current && current === readGeneration.current) setRecords(more ? [...(records || list), ...result.records] : result.records) }
    catch (reason) { if (mounted.current && current === readGeneration.current) setError((reason as Error).message) }
  }
  const readAudit = async () => { const current = ++readGeneration.current; try { const result = await call<{ revisions: NonNullable<typeof audit> }>({ action: 'operations-audit', id: selected }); if (mounted.current && current === readGeneration.current) setAudit(result.revisions) } catch (reason) { setError((reason as Error).message) } }
  const compare = async () => { const current = ++readGeneration.current; setError(''); try { const result = await call<HistoricalComparison>({ action: 'operations-baseline', routeId: route }); if (mounted.current && current === readGeneration.current) setBaseline(result) } catch (reason) { setError((reason as Error).message) } }
  const list = records || (view === 'finding' ? overview?.findings : view === 'knowledge' ? overview?.knowledge : overview?.messages) || []
  const listed = list.find(record => record.id === selected)
  const record = listed?.kind === 'finding' ? overview?.findings.find(record => record.id === selected) || listed : listed
  return <section className="agency-operations" aria-label="Operations workflow">
    {view !== 'replay' ? <p className="agency-intro">Keep an operational finding, its evidence, staff decisions and rider guidance together.</p> : null}
    {error ? <p className="agency-error" role="alert">{error}</p> : null}
    {overview ? <>
      {view !== 'replay' ? <div className="agency-ops-health"><strong>{overview.quality.alignmentRatio === null ? 'Reporting unknown' : `${overview.quality.alignedReports} / ${overview.quality.totalReports} reports aligned`}</strong><span>{overview.quality.comparedRoutes} routes with paired departures</span><details><summary>{overview.quality.flags.length ? `${overview.quality.flags.length} quality flags` : 'Quality and coverage'}</summary><p>{overview.quality.note}</p>{overview.quality.flags.map(flag => <p key={flag}>{words(flag)}</p>)}<p>{overview.monitoring.note}</p><p>Last retained: {overview.monitoring.lastStoredAt ? new Date(overview.monitoring.lastStoredAt).toLocaleString() : 'No observation yet'}</p><p>Access: {overview.principal.id} · {overview.principal.role}</p></details></div> : null}
      <nav className="agency-ops-nav" aria-label="Operations records">{(['finding', 'message', 'knowledge', 'history', 'replay'] as const).map(value => <button className="agency-button" aria-pressed={view === value} key={value} disabled={busy} onClick={() => { ++readGeneration.current; setView(value); setSelected(null); setRecords(null); setSearch(''); setAudit(null) }}>{value === 'finding' ? 'Findings' : value === 'message' ? 'Rider guidance' : value === 'knowledge' ? 'Knowledge' : value === 'history' ? 'History' : 'Replay'}</button>)}</nav>
      {view === 'replay' ? <AgencyReplay endpoint={endpoint} capabilities={overview.principal.capabilities} /> : view === 'history' ? <>
        <div className="agency-ops-fields"><label>Route<select value={route} onChange={event => { ++readGeneration.current; setRoute(event.target.value); setBaseline(null) }}><option value="">Choose a route</option>{state.routes.map(route => <option key={route.id} value={route.id}>{route.name}</option>)}</select></label><button className="agency-button" disabled={!route} onClick={() => void compare()}>Compare earlier service days</button></div>
        {baseline ? <><h3>{baseline.serviceDays < baseline.minimumDays ? `Building history · ${baseline.serviceDays} / ${baseline.minimumDays} comparable days` : `${baseline.weekday} · ${baseline.hour}:00 comparison`}</h3><div className="agency-ops-health"><strong>Historical median: {minute(baseline.baselineSeconds)}</strong><span>Current: {minute(baseline.currentSeconds)} · difference: {minute(baseline.differenceSeconds)}</span></div><p className="agency-caption">{baseline.method}</p><p>Chronological evaluation: {baseline.evaluation.cases} held-out days · mean absolute error {minute(baseline.evaluation.meanAbsoluteErrorSeconds)}</p><table className="agency-ops-history"><thead><tr><th>Service date</th><th>Daily median</th><th>Samples</th></tr></thead><tbody>{baseline.days.map(day => <tr key={day.date}><td>{day.date}</td><td>{minute(day.value)}</td><td>{day.samples}</td></tr>)}</tbody></table></> : <p className="agency-caption">One observation per five-minute interval, retained for up to 90 days. No observations are invented while the application is closed.</p>}
      </> : <>
        {view === 'finding' && overview.principal.capabilities.includes('finding') ? <details className="agency-ops-new"><summary>Track a current finding</summary>{state.events.slice(0, 40).map(event => <button className="agency-event" key={event.id} disabled={busy} onClick={() => void command({ action: 'operations-track', eventId: event.id })}><span><strong>{event.routeName ? `${event.routeName} · ` : ''}{event.title}</strong><small>{event.stopName || event.observedAt}</small></span><ArrowRight size={14} /></button>)}{!state.events.length ? <p>No findings established by this observation.</p> : null}<p className="agency-caption">Up to 40 current findings shown; use Live route filters to narrow the scope.</p></details> : null}
        {view === 'knowledge' && overview.principal.capabilities.includes('knowledge') ? <details className="agency-ops-new"><summary>Add operational context</summary><KnowledgeForm state={state} command={command} busy={busy} /></details> : null}
        <form className="agency-ops-search" onSubmit={event => { event.preventDefault(); void fetchRecords() }}><input aria-label="Search operations records" placeholder="Search saved records" value={search} onChange={event => setSearch(event.target.value)} maxLength={200} /><button className="agency-button" type="submit">Search</button></form>
        <div className="agency-ops-records">{list.map(item => <button className="agency-event" aria-pressed={selected === item.id} key={item.id} onClick={() => { ++readGeneration.current; setSelected(item.id); setAudit(null) }}><span><strong>{item.title}</strong><small>{words(item.status)} · v{item.version}{item.expiresAt && Date.parse(item.expiresAt) <= Date.now() || item.validUntil && Date.parse(item.validUntil) <= Date.now() ? ' · expired' : ''}</small></span><ArrowRight size={14} /></button>)}</div>
        {!list.length ? <p className="agency-quiet">{view === 'finding' ? 'Track a finding to start an investigation.' : view === 'knowledge' ? 'Add a sourced SOP, maintenance note or document excerpt for review.' : 'Prepare rider guidance from an investigated finding.'}</p> : null}
        {list.length >= 50 ? <button className="agency-text-button" onClick={() => void fetchRecords(true)}>Load more records</button> : null}
        {record ? <><RecordEditor key={`${record.id}:${record.version}`} record={record} overview={overview} command={command} busy={busy} onEvidence={onEvidence} /><button className="agency-text-button" onClick={() => void readAudit()}>View revision history</button>{audit ? <div className="agency-ops-audit">{audit.map(entry => <details key={entry.sequence}><summary>v{entry.version} · {words(entry.action)} · {entry.actor} · {new Date(entry.at).toLocaleString()}</summary><pre>{JSON.stringify(entry.data, null, 2)}</pre></details>)}</div> : null}</> : null}
      </>}
    </> : <p role="status">Reading the City operations record…</p>}
  </section>
}
