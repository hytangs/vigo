import { useEffect, useRef, useState } from 'react'
import { apiJson } from '../app/api'
import type { VehicleTiming } from '../agency/routeOperationsTypes'
import { vehicleDelayLabel } from './AgencyVehicleDetails'

type Trip = { id: string; directionId: string | null; destination: string; departure: number; arrival: number }
type Timetable = { timezone: string; trips: Trip[]; trip: (Trip & { serviceDate: string; status: string; predictionAt: number | null; sourceUrl?: string | null; calls: Array<{ stop: { id: string; name: string }; index: number; status: string; progress?: string | null; lastPrediction?: Partial<Record<'arrival' | 'departure', { time: number; observedAt: number | null }>>; arrival: VehicleTiming['arrival']; departure: VehicleTiming['departure'] }> }) | null }

export function AgencyTripTimetable({ projectId, routeId, initialTripId = '', initialServiceDate = '' }: { projectId: string; routeId: string; initialTripId?: string; initialServiceDate?: string }) {
  const retained = useRef<{ key: string; source?: string | null; calls: Map<number, NonNullable<NonNullable<Timetable['trip']>['calls'][number]['lastPrediction']>> }>({ key: '', calls: new Map() })
  const [selection, setSelection] = useState(initialTripId)
  const [date, setDate] = useState(initialServiceDate)
  const [data, setData] = useState<Timetable | null>(null)
  const [error, setError] = useState('')
  const [showPassed, setShowPassed] = useState(false)
  useEffect(() => setShowPassed(false), [projectId, routeId, selection, date])
  const [kind, setKind] = useState<'arrival' | 'departure'>('departure')
  useEffect(() => {
    const controller = new AbortController()
    let pending = false
    setData(null); setError('')
    async function refresh() {
      if (pending) return
      pending = true
      try {
        const result = await apiJson<Timetable>(`/api/projects/${encodeURIComponent(projectId)}/agency`, { method: 'POST', body: JSON.stringify({ action: 'route-line', routeId, includeTrips: true, tripId: selection || undefined, serviceDate: date || undefined }), signal: controller.signal })
        if (!result || !Array.isArray(result.trips) || !('trip' in result) || (result.trip !== null && !Array.isArray(result.trip?.calls))) {
          throw new Error('Trip timetable is unavailable from this API version. Restart the local API server to load the updated timetable. This view will retry automatically.')
        }
        if (!controller.signal.aborted && result.trip) {
          const trip = result.trip
          const key = JSON.stringify([projectId, routeId, trip.id, trip.serviceDate])
          if (retained.current.key !== key || (trip.sourceUrl && retained.current.source && trip.sourceUrl !== retained.current.source)) retained.current = { key, calls: new Map() }
          if (trip.sourceUrl) retained.current.source = trip.sourceUrl
          if (!['Predictions available', 'Scheduled only', 'Stale report'].includes(trip.status)) retained.current.calls.clear()
          for (const call of trip.calls) {
            if (call.status) { retained.current.calls.delete(call.index); continue }
            const previous = retained.current.calls.get(call.index) || {}
            for (const event of ['arrival', 'departure'] as const) {
              const time = call[event].current
              if (time !== null) previous[event] = { time, observedAt: trip.predictionAt }
            }
            retained.current.calls.set(call.index, previous)
            call.lastPrediction = { ...previous }
          }
        }
        if (!controller.signal.aborted) { setData(result); setError(''); if (!selection && result.trip) setSelection(result.trip.id) }
      } catch (reason) { if (!controller.signal.aborted) { setData(null); setError(reason instanceof Error ? reason.message : 'Trip timing unavailable.') } }
      finally { pending = false }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 15_000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [projectId, routeId, selection, date])
  function clock(value: number | null) {
    if (value === null || !data?.timezone) return '—'
    const instant = new Date(value * 1000)
    const nextDay = new Intl.DateTimeFormat('en-CA', { timeZone: data.timezone }).format(instant) !== data.trip?.serviceDate
    return instant.toLocaleString([], { timeZone: data.timezone, ...(nextDay ? { month: 'short', day: 'numeric' } as const : {}), hour: 'numeric', minute: '2-digit' })
  }
  const currentCall = data?.trip?.calls.find(call => call.progress === 'At stop' || call.progress === 'Next stop')
  const passedCount = data?.trip?.calls.filter(call => call.progress === 'Passed').length ?? 0
  const visibleCalls = data?.trip?.calls.filter(call => showPassed || call.progress !== 'Passed') ?? []
  return <section className="agency-trip-timetable" aria-label="Trip timetable">
    <div className="agency-trip-controls"><label>Service date<input type="date" value={date || data?.trip?.serviceDate || ''} onChange={event => { setDate(event.target.value); setSelection('') }} /></label>
      <label>Trip<select value={selection || data?.trip?.id || ''} onChange={event => setSelection(event.target.value)} disabled={!data?.trips.length}>
        {!data?.trips.length ? <option value="">No trips</option> : data.trips.map(trip => <option key={trip.id} value={trip.id}>{clock(trip.departure)} → {trip.destination} · {trip.id.split('\u001f').at(-1)}</option>)}
      </select></label>
      <label>Times<select value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="departure">Departures</option><option value="arrival">Arrivals</option></select></label></div>
    {error ? <p role="alert">{error}</p> : !data ? <p role="status">Loading timetable…</p> : !data.trip ? <p>No indexed fixed-schedule trips for this service date.</p> : <>
      <h2>To {data.trip.destination}</h2><p>{data.trip.status} · {data.trip.serviceDate} · {data.timezone}</p>
      <div className="agency-trip-position">{currentCall ? <><span>{currentCall.progress === 'At stop' ? 'At stop' : 'Next stop'}</span><strong>{currentCall.stop.name}</strong></> : <span>Current vehicle position unavailable</span>}</div>
      {passedCount > 0 ? <button type="button" className="agency-text-button agency-trip-passed-toggle" aria-expanded={showPassed} onClick={() => setShowPassed(value => !value)}>{showPassed ? 'Hide' : 'Show'} {passedCount} passed {passedCount === 1 ? 'stop' : 'stops'}</button> : null}
      <div className="agency-trip-table-scroll"><table aria-label={`Scheduled and predicted ${kind} times`}><thead><tr><th scope="col">Stop</th><th scope="col">Scheduled</th><th scope="col">Predicted</th></tr></thead><tbody>{visibleCalls.map(call => {
        const event = call[kind]
        const last = event.current === null ? call.lastPrediction?.[kind] : undefined
        const value = event.current ?? last?.time ?? null
        const current = call === currentCall
        return <tr key={call.index} className={current ? 'is-current-stop' : call.progress === 'Passed' ? 'is-passed-stop' : undefined} aria-current={current ? 'step' : undefined}><th scope="row"><span className="agency-trip-stop">{call.stop.name}</span>{call.status ? <small>{call.status}</small> : current ? <small>{call.progress}</small> : null}</th><td>{clock(event.scheduled)}</td><td>{clock(value)}{last ? <small>Last prediction{last.observedAt ? ` · updated ${clock(last.observedAt)}` : ''}</small> : null}{value !== null && event.scheduled !== null ? <small>{vehicleDelayLabel(value - event.scheduled)}</small> : null}</td></tr>
      })}</tbody></table></div>
      <details className="agency-trip-source"><summary>Timing &amp; source</summary><p className="agency-caption">{data.trip.predictionAt ? `Trip update ${clock(data.trip.predictionAt)}. ` : ''}Trip progress uses a fresh vehicle-position report. Passed stops are collapsed; their scheduled times are not recorded arrival or departure times. Last predictions are retained while viewing this trip; they are not actual times. — means unavailable. Predictions do not confirm arrival or departure. Frequency-based trips require a trip-instance timetable.</p></details>
    </>}
  </section>
}
