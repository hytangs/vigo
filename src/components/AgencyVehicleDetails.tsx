import { occupancyIndicator } from '../agency/vehicleIndicators'
import { useEffect, useState } from 'react'
import { apiJson } from '../app/api'
import type { VehicleTiming } from '../agency/routeOperationsTypes'

export function vehicleDelayLabel(seconds: number | null) {
  if (seconds === null) return 'Timing unavailable'
  if (seconds === 0) return 'Matches schedule'
  const minutes = Math.abs(seconds) / 60
  return `${minutes < 0.1 ? '<0.1' : Number(minutes.toFixed(1))} min ${seconds > 0 ? 'later' : 'earlier'}`
}

export function vehicleStopLabel(vehicle: VehicleTiming) {
  const prefix = vehicle.status === 'STOPPED_AT' ? 'At' : vehicle.status === 'INCOMING_AT' ? 'Approaching' : vehicle.status === 'IN_TRANSIT_TO' ? 'To' : 'Reported stop ·'
  return vehicle.stop ? `${prefix} ${vehicle.stop.name}` : 'Stop position unavailable'
}

function clock(timestamp: number | null, vehicle: VehicleTiming, seconds = false) {
  if (timestamp === null || !vehicle.timezone) return '—'
  const date = new Date(timestamp * 1000)
  const time = date.toLocaleTimeString([], { timeZone: vehicle.timezone, hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) })
  const calendarDate = new Intl.DateTimeFormat('en-CA', { timeZone: vehicle.timezone }).format(date)
  return vehicle.serviceDate && calendarDate !== vehicle.serviceDate ? `${date.toLocaleDateString([], { timeZone: vehicle.timezone, month: 'short', day: 'numeric' })} · ${time}` : time
}

export function VehicleDetailsView({ vehicle }: { vehicle: VehicleTiming }) {
  const next = vehicle.arrival.current === null && vehicle.departure.current === null ? vehicle.nextPrediction : undefined
  const timing = next ?? vehicle
  return <section className="agency-vehicle-detail" aria-label={`Vehicle ${vehicle.label} schedule and current timing`}>
    <header><span>Live vehicle</span><h3>{vehicle.label} <small>Route {vehicle.routeName}</small></h3><p>{vehicle.destination ? `To ${vehicle.destination}` : 'Destination unavailable'}</p></header>
    <p className="agency-vehicle-position">{vehicleStopLabel(vehicle)}</p>
    {vehicle.warnings.map(warning => <p className="agency-vehicle-warning" key={warning}>{warning}</p>)}
    {next ? <p className="agency-vehicle-next"><span>Next prediction</span><strong>{next.stop.name}</strong></p> : null}
    <table aria-label={`Scheduled and predicted times at ${timing.stop?.name ?? 'the reported stop'}`}><thead><tr><th scope="col">{next ? 'Event' : 'At this stop'}</th><th scope="col">Scheduled</th><th scope="col">Predicted</th></tr></thead><tbody>{(['arrival', 'departure'] as const).map(kind => <tr key={kind}><th scope="row">{kind === 'arrival' ? 'Arrival' : 'Departure'}</th><td>{clock(timing[kind].scheduled, vehicle)}</td><td>{clock(timing[kind].current, vehicle)}</td></tr>)}</tbody></table>
    {timing.delayKind ? <p className="agency-vehicle-deviation">{timing.delayKind === 'arrival' ? 'Arrival' : 'Departure'} · <strong>{vehicleDelayLabel(timing.delaySeconds)}</strong></p> : null}
    <p className={occupancyIndicator(vehicle.occupancy || undefined).crowded && vehicle.fresh ? 'agency-vehicle-warning' : 'agency-caption'}><strong>Reported occupancy · {occupancyIndicator(vehicle.occupancy || undefined).label}</strong>{!vehicle.fresh ? ' · Not current' : ''}</p>
    <footer><span>Vehicle seen {clock(vehicle.observedAt, vehicle, true)}{!vehicle.fresh ? ' · Not current' : ''}</span>{vehicle.predictionAt ? <span>Trip update {clock(vehicle.predictionAt, vehicle, true)}</span> : null}<span>— means timing unavailable.</span></footer>
    <details className="agency-vehicle-source"><summary>Trip & service day</summary><p>Trip {vehicle.tripId?.split('\u001f').at(-1) || 'unassigned'} · {vehicle.serviceDate || 'unknown date'} · {vehicle.timezone || 'unknown timezone'}</p></details>
  </section>
}

export function AgencyVehicleDetails({ projectId, vehicleId, sourceUrl }: { projectId: string; vehicleId: string; sourceUrl?: string }) {
  const [vehicle, setVehicle] = useState<VehicleTiming | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let pending = false
    setVehicle(null); setError('')
    async function refresh() {
      if (pending) return
      pending = true
      try {
        const result = await apiJson<VehicleTiming>(`/api/projects/${encodeURIComponent(projectId)}/agency`, { method: 'POST', body: JSON.stringify({ action: 'vehicle', vehicleId, sourceUrl }), signal: controller.signal })
        if (!controller.signal.aborted) { setVehicle(result); setError('') }
      } catch (error) { if (!controller.signal.aborted) { setVehicle(null); setError(error instanceof Error ? error.message : 'Vehicle timing is unavailable.') } }
      finally { pending = false }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 10_000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [projectId, vehicleId, sourceUrl])
  return vehicle ? <VehicleDetailsView vehicle={vehicle} /> : <p className="agency-caption" role="status">{error || 'Reading the vehicle’s timetable and current predictions…'}</p>
}
