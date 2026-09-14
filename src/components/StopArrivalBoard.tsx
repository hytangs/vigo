import { useEffect, useState, type CSSProperties } from 'react'
import { Radio } from 'lucide-react'
import { apiJson } from '../app/api'
import type { StopBoard, StopBoardRow } from '../agency/routeOperationsTypes'

function clock(time: number | null, timezone: string | null) {
  return time === null || !timezone ? '—' : new Date(time * 1000).toLocaleTimeString([], { timeZone: timezone, hour: 'numeric', minute: '2-digit' })
}

function arrivalLabel(row: StopBoardRow, now: number, timezone: string | null) {
  if (row.status === 'cancelled') return 'Cancelled'
  if (row.status === 'skipped') return 'Skipping stop'
  if (row.atStop) return 'At stop'
  if (row.status !== 'live') return clock(row.expected, timezone)
  const minutes = Math.ceil((row.expected - now) / 60)
  return minutes <= 0 ? 'Due' : `${minutes} min`
}

export function StopArrivalBoardView({ data }: { data: StopBoard }) {
  const [routeId, setRouteId] = useState('')
  const [expanded, setExpanded] = useState(false)
  const routes = [...new Map(data.rows.map(row => [row.routeId, { name: row.routeName, color: row.color }])).entries()]
  const filter = routes.some(([id]) => id === routeId) ? routeId : ''
  const rows = data.rows.filter(row => !filter || row.routeId === filter)
  const now = Date.parse(data.generatedAt) / 1000
  return <section className="stop-arrival-board" aria-label={`Arrivals at ${data.stop.name}`}>
    <header><span>Stop arrivals</span><h3>{data.stop.name}</h3><p>Next hour</p></header>
    {routes.length > 1 ? <div className="stop-board-routes" role="group" aria-label="Filter arrivals by route"><button aria-pressed={!filter} onClick={() => { setRouteId(''); setExpanded(false) }}>All</button>{routes.map(([id, route]) => <button key={id} aria-pressed={filter === id} style={{ '--arrival-color': route.color } as CSSProperties} onClick={() => { setRouteId(id); setExpanded(false) }}>{route.name}</button>)}</div> : null}
    {data.warnings.map(warning => <p className="stop-board-notice" key={warning}>{warning}</p>)}
    {!rows.length ? <p className="stop-board-empty">No timed service is available here in the next hour.</p> : <ol className="stop-board-list">{rows.slice(0, expanded ? undefined : 8).map(row => {
      const timing = row[row.kind]
      const notRunning = row.status === 'cancelled' || row.status === 'skipped'
      return <li key={row.key} className={notRunning ? 'is-not-running' : ''}>
        <span className="stop-board-route" style={{ '--arrival-color': row.color } as CSSProperties}>{row.routeName}</span>
        <div className="stop-board-service"><strong>To {row.destination}</strong><small>{[row.vehicleLabel ? `Vehicle ${row.vehicleLabel}` : 'Vehicle not reported', row.platform ? `Platform ${row.platform}` : row.stopName !== data.stop.name ? row.stopName : ''].filter(Boolean).join(' · ')}</small></div>
        <div className="stop-board-time"><strong>{arrivalLabel(row, now, data.timezone)}</strong><small>{row.kind === 'departure' && !notRunning ? 'Departs · ' : ''}{row.status === 'live' ? <><Radio size={10} aria-hidden="true" /> {clock(timing.current, data.timezone)}</> : row.atStop ? 'Reported at this stop' : notRunning ? clock(timing.scheduled, data.timezone) : 'Scheduled'}</small></div>
        {row.status === 'live' ? <p className="stop-board-baseline">Scheduled {clock(timing.scheduled, data.timezone)}</p> : row.status === 'stale' || row.status === 'unresolved' ? <p className="stop-board-baseline">{row.status === 'stale' ? 'Live estimate out of date' : 'Conflicting reports · live estimate unavailable'}</p> : null}
      </li>
    })}</ol>}
    {rows.length > 8 ? <button className="stop-board-more" onClick={() => setExpanded(value => !value)}>{expanded ? 'Show fewer' : `Show all ${rows.length}`}</button> : null}
    <footer><span>Updated {clock(now, data.timezone)}</span><span>Live times are predictions.{data.total > data.rows.length ? ` Showing the first ${data.rows.length} of ${data.total}.` : ''}</span></footer>
  </section>
}

export function StopArrivalBoard({ projectId, stopId }: { projectId: string; stopId: string }) {
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
        if (!controller.signal.aborted) { setData(null); setError(error instanceof Error ? error.message : 'Stop arrivals could not be refreshed.') }
      } finally { pending = false }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 10_000)
    const onVisible = () => { if (!document.hidden) { setData(null); void refresh() } }
    document.addEventListener('visibilitychange', onVisible)
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [projectId, stopId])
  return data ? <StopArrivalBoardView key={`${projectId}/${stopId}`} data={data} /> : <p className="stop-board-empty" role={error ? 'alert' : 'status'}>{error || 'Loading stop arrivals…'}</p>
}
