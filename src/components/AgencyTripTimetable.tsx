import { useEffect, useState } from 'react'
import { apiJson } from '../app/api'
import type { VehicleTiming } from '../agency/routeOperationsTypes'
import { vehicleDelayLabel } from './AgencyVehicleDetails'

type Trip = { id: string; directionId: string | null; destination: string; departure: number; arrival: number }
type Timetable = { timezone: string; trips: Trip[]; trip: (Trip & { serviceDate: string; status: string; predictionAt: number | null; calls: Array<{ stop: { id: string; name: string }; index: number; status: string; arrival: VehicleTiming['arrival']; departure: VehicleTiming['departure'] }> }) | null }

export function AgencyTripTimetable({ projectId, routeId }: { projectId: string; routeId: string }) {
  const [selection, setSelection] = useState('')
  const [date, setDate] = useState('')
  const [data, setData] = useState<Timetable | null>(null)
  const [error, setError] = useState('')
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
  return <section className="agency-trip-timetable" aria-label="Trip timetable">
    <div className="agency-trip-controls"><label>Service date<input type="date" value={date || data?.trip?.serviceDate || ''} onChange={event => { setDate(event.target.value); setSelection('') }} /></label>
      <label>Trip<select value={selection || data?.trip?.id || ''} onChange={event => setSelection(event.target.value)} disabled={!data?.trips.length}>
        {!data?.trips.length ? <option value="">No trips</option> : data.trips.map(trip => <option key={trip.id} value={trip.id}>{clock(trip.departure)} → {trip.destination} · {trip.id.split('\u001f').at(-1)}</option>)}
      </select></label>
      <label>Times<select value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="departure">Departures</option><option value="arrival">Arrivals</option></select></label></div>
    {error ? <p role="alert">{error}</p> : !data ? <p role="status">Loading timetable…</p> : !data.trip ? <p>No indexed fixed-schedule trips for this service date.</p> : <>
      <h2>To {data.trip.destination}</h2><p>{data.trip.status} · {data.trip.serviceDate} · {data.timezone}</p>
      <p>Predictions only · actual times unavailable.</p>
      <div className="agency-trip-table-scroll"><table aria-label={`Scheduled and predicted ${kind} times`}><thead><tr><th scope="col">Stop</th><th scope="col">Scheduled</th><th scope="col">Predicted</th></tr></thead><tbody>{data.trip.calls.map(call => {
        const event = call[kind]
        return <tr key={call.index}><th scope="row"><span className="agency-trip-stop">{call.stop.name}</span>{call.status ? <small>{call.status}</small> : null}</th><td>{clock(event.scheduled)}</td><td>{clock(event.current)}{event.current !== null && event.scheduled !== null ? <small>{vehicleDelayLabel(event.current - event.scheduled)}</small> : null}</td></tr>
      })}</tbody></table></div>
      <details className="agency-trip-source"><summary>Timing &amp; source</summary><p className="agency-caption">{data.trip.predictionAt ? `Trip update ${clock(data.trip.predictionAt)}. ` : ''}— means unavailable. Predictions do not confirm arrival or departure. Frequency-based trips require a trip-instance timetable.</p></details>
    </>}
  </section>
}
