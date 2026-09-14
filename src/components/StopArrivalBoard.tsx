import { useEffect, useState, type CSSProperties } from 'react'
import { Radio } from 'lucide-react'
import { apiJson } from '../app/api'
import type { StopBoard, StopBoardRow } from '../agency/routeOperationsTypes'
import { scheduleDeviation } from '../agency/presentation'
import { AgencyFeedHealth } from './AgencyFeedHealth'

function clock(time: number | null, timezone: string | null, reference: number, precise = false) {
  if (time === null || !timezone) return '—'
  const sameDay = new Date(time * 1000).toLocaleDateString('en-CA', { timeZone: timezone }) === new Date(reference * 1000).toLocaleDateString('en-CA', { timeZone: timezone })
  return new Date(time * 1000).toLocaleString([], { timeZone: timezone, hour: 'numeric', minute: '2-digit',
    ...(!sameDay ? { month: 'short', day: 'numeric' } as const : {}), ...(precise ? { second: '2-digit', timeZoneName: 'short' } as const : {}) })
}

function arrivalLabel(row: StopBoardRow, now: number, timezone: string | null) {
  if (row.status === 'cancelled') return 'Cancelled'
  if (row.status === 'skipped') return 'Skipping stop'
  if (row.atStop) return 'At stop'
  if (row.status !== 'live') return clock(row.expected, timezone, now)
  const minutes = Math.ceil((row.expected - now) / 60)
  return minutes <= 0 ? 'Due' : `${minutes} min`
}

export function StopArrivalBoardView({ data, refreshError = '', showHeading = true, recorded = false }: { data: StopBoard; refreshError?: string; showHeading?: boolean; recorded?: boolean }) {
  const [routeId, setRouteId] = useState('')
  const [expanded, setExpanded] = useState(false)
  const routes = [...new Map(data.rows.map(row => [row.routeId, { name: row.routeName, color: row.color }])).entries()]
  const filter = routes.some(([id]) => id === routeId) ? routeId : ''
  const rows = data.rows.filter(row => !filter || row.routeId === filter)
  const now = Date.parse(data.generatedAt) / 1000
  const time = (value: number | null, precise = false) => clock(value, data.timezone, now, precise)
  const snapshot = recorded || Boolean(refreshError)
  const eventName = data.rows.length && data.rows.every(row => row.kind === 'departure') ? 'departures' : 'arrivals'
  return <section className="stop-arrival-board" aria-label={`Arrivals at ${data.stop.name}`}>
    <header><span>{recorded ? `Recorded ${eventName}` : 'Stop arrivals'}</span>{showHeading ? <h3>{data.stop.name}</h3> : null}<p>{recorded ? 'Saved with this answer · not updating' : refreshError ? 'Last successful observation' : 'Next hour'}</p>{!recorded ? <AgencyFeedHealth feeds={(data.feeds ?? []).filter(feed => feed.kind === 'tripUpdates' || feed.kind === 'vehicles')} refreshFailed={Boolean(refreshError)} /> : null}</header>
    {refreshError ? <p className="stop-board-notice" role="alert">Arrivals could not be refreshed. Times below were recorded at {time(now, true)}.</p> : null}
    {routes.length > 1 ? <div className="stop-board-routes" role="group" aria-label="Filter arrivals by route"><button aria-pressed={!filter} onClick={() => { setRouteId(''); setExpanded(false) }}>All</button>{routes.map(([id, route]) => <button key={id} aria-pressed={filter === id} style={{ '--arrival-color': route.color } as CSSProperties} onClick={() => { setRouteId(id); setExpanded(false) }}>{route.name}</button>)}</div> : null}
    {data.warnings.map(warning => <p className="stop-board-notice" key={warning}>{warning}</p>)}
    {!rows.length ? <p className="stop-board-empty">No timed service is available here in the next {(data.windowMinutes ?? 60) === 60 ? 'hour' : `${(data.windowMinutes ?? 60) / 60} hours`}.</p> : <ol className="stop-board-list">{rows.slice(0, expanded || data.nextPerRoute ? undefined : 8).map(row => {
      const timing = row[row.kind]
      const notRunning = row.status === 'cancelled' || row.status === 'skipped'
      return <li key={row.key} className={notRunning ? 'is-not-running' : ''}>
        <span className="stop-board-route" style={{ '--arrival-color': row.color } as CSSProperties}>{row.routeName}</span>
        <div className="stop-board-service"><strong>To {row.destination}</strong><small>{[row.vehicleLabel ? `Vehicle ${row.vehicleLabel}` : 'Vehicle not reported', row.platform ? `Platform ${row.platform}` : row.stopName !== data.stop.name ? row.stopName : ''].filter(Boolean).join(' · ')}</small></div>
        <div className="stop-board-time"><strong>{snapshot && !notRunning ? time(row.expected) : arrivalLabel(row, now, data.timezone)}</strong><small>{row.kind === 'departure' && !notRunning ? 'Departs · ' : ''}{row.status === 'live' ? <><Radio size={10} aria-hidden="true" /> {snapshot ? 'Recorded prediction' : `Prediction ${time(timing.current)}`}</> : row.atStop && !snapshot ? 'Reported at this stop' : notRunning ? time(timing.scheduled) : 'Schedule only'}</small></div>
        <details className="stop-board-baseline"><summary>{row.status === 'live' ? <>Scheduled {time(timing.scheduled)}{scheduleDeviation(timing.scheduled, timing.current) ? <b> · {scheduleDeviation(timing.scheduled, timing.current)}</b> : null}</> : row.status === 'stale' ? 'Prediction out of date' : row.status === 'unresolved' ? 'Conflicting reports · schedule shown' : 'Timing details'}</summary>
          {row.timingIssue ? <p>{row.timingIssue}</p> : null}
          <dl>
            <div><dt>Service date</dt><dd>{row.serviceDate}</dd></div>
            <div><dt>Trip</dt><dd>{row.tripId}</dd></div>
            <div><dt>Stop · sequence</dt><dd>{row.stopId} · {row.stopSequence ?? 'Terminal sequence not retained'}</dd></div>
            {(['arrival', 'departure'] as const).map(kind => <div key={kind}><dt>{kind === 'arrival' ? 'Arrival' : 'Departure'}</dt><dd>Scheduled {time(row[kind].scheduled, true)}<br />Prediction {time(row[kind].current, true)}</dd></div>)}
            {row.source ? <>
              <div><dt>Prediction reported</dt><dd>{time(row.predictionAt, true)}</dd></div>
              {row.timingIssue ? (['arrival', 'departure'] as const).map(kind => <div key={kind}><dt>Source {kind}</dt><dd>{row.source?.[kind]?.time != null ? time(row.source[kind]!.time!, true) : row.source?.[kind]?.delay != null ? `${row.source[kind]!.delay} sec from schedule` : 'Not reported'}</dd></div>) : null}
              <div><dt>Source</dt><dd><a href={`${row.source.url}#entity=${encodeURIComponent(row.source.entityId)}`} target="_blank" rel="noreferrer">Trip update</a> · {row.source.entityId}</dd></div>
            </> : null}
          </dl>
        </details>
      </li>
    })}</ol>}
    {rows.length > 8 && !data.nextPerRoute ? <button className="stop-board-more" onClick={() => setExpanded(value => !value)}>{expanded ? 'Show fewer' : `Show all ${rows.length}`}</button> : null}
    <footer><span>Board checked {time(now, true)}</span><span>Predictions can change.{data.total > data.rows.length ? ` Showing the first ${data.rows.length} of ${data.total}.` : ''}</span></footer>
  </section>
}

export function StopArrivalBoard({ projectId, stopId, showHeading = true }: { projectId: string; stopId: string; showHeading?: boolean }) {
  const [data, setData] = useState<StopBoard | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let pending = false
    setData(null); setError('')
    async function refresh() {
      if (pending || document.hidden) return
      pending = true
      try {
        const result = await apiJson<StopBoard>(`/api/projects/${encodeURIComponent(projectId)}/agency`, { method: 'POST', body: JSON.stringify({ action: 'stop-board', stopId }), signal: controller.signal })
        if (!controller.signal.aborted) { setData(result); setError('') }
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Stop arrivals could not be refreshed.')
      } finally { pending = false }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 10_000)
    const onVisible = () => { if (!document.hidden) void refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [projectId, stopId])
  return data ? <StopArrivalBoardView key={`${projectId}/${stopId}`} data={data} refreshError={error} showHeading={showHeading} /> : <p className="stop-board-empty" role={error ? 'alert' : 'status'}>{error || 'Loading stop arrivals…'}</p>
}
