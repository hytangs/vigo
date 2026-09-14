import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { ArrowDown, ArrowUp, Route, X } from 'lucide-react'
import { apiJson } from '../app/api'
import type { RouteOperations, RoutePattern, VehicleTiming } from '../agency/routeOperationsTypes'
import { VehicleDetailsView, vehicleDelayLabel, vehicleStopLabel } from './AgencyVehicleDetails'
import { StopArrivalBoard } from './StopArrivalBoard'

function patternLabel(pattern: RoutePattern) {
  return `${pattern.stops[0]?.name} → ${pattern.stops.at(-1)?.name} · ${pattern.stops.length} stops`
}
const atReportedStop = (vehicle: VehicleTiming) => vehicle.status === 'STOPPED_AT' || vehicle.status === 'STOP_REPORTED'

export function AgencyRouteLine({ projectId, routeId }: { projectId: string; routeId: string }) {
  const [data, setData] = useState<RouteOperations | null>(null)
  const [error, setError] = useState('')
  const [choices, setChoices] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedStop, setSelectedStop] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    let pending = false
    setData(null); setError(''); setChoices({}); setSelected(null); setSelectedStop(null)
    if (!routeId) return () => controller.abort()
    async function refresh() {
      if (pending) return
      pending = true
      try {
        const result = await apiJson<RouteOperations>(`/api/projects/${encodeURIComponent(projectId)}/agency`, { method: 'POST', body: JSON.stringify({ action: 'route-line', routeId }), signal: controller.signal })
        if (!controller.signal.aborted) { setData(result); setError('') }
      } catch (error) { if (!controller.signal.aborted) { setData(null); setError(error instanceof Error ? error.message : 'Line view is unavailable.') } }
      finally { pending = false }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 10_000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [projectId, routeId])

  const directions = useMemo(() => [...new Set(data?.patterns.map(pattern => pattern.directionId ?? 'unknown') ?? [])].sort(), [data])
  const visiblePatterns = directions.map(direction => {
    const patterns = data?.patterns.filter(pattern => (pattern.directionId ?? 'unknown') === direction) ?? []
    return patterns.find(pattern => pattern.id === choices[direction]) ?? patterns[0]
  }).filter(Boolean)
  const selectedVehicle = data?.vehicles.find(vehicle => vehicle.key === selected)
  const unplaced = data?.vehicles.filter(vehicle => vehicle.callIndex === null || vehicle.patternId === null) ?? []
  const paired = visiblePatterns.length === 2 && visiblePatterns[0].stops.length === visiblePatterns[1].stops.length
    && visiblePatterns[0].stops.every((stop, index) => stop.id === visiblePatterns[1].stops.at(-index - 1)?.id)

  function choosePattern(pattern: RoutePattern) {
    const reversed = pattern.stops.map(stop => stop.id).reverse()
    // Link opposite directions only when GTFS declares the exact reverse station sequence.
    const opposite = data?.patterns.filter(other => other.directionId !== pattern.directionId && other.stops.length === reversed.length && other.stops.every((stop, index) => stop.id === reversed[index])) ?? []
    setChoices(previous => ({ ...previous, [pattern.directionId ?? 'unknown']: pattern.id, ...(opposite.length === 1 ? { [opposite[0].directionId ?? 'unknown']: opposite[0].id } : {}) }))
    setSelected(null)
    setSelectedStop(null)
  }
  function vehicleChip(vehicle: VehicleTiming, up: boolean) {
    const Arrow = up ? ArrowUp : ArrowDown
    const estimate = vehicle.arrival.current ?? vehicle.departure.current
    const time = estimate !== null && vehicle.timezone ? new Date(estimate * 1000).toLocaleTimeString([], { timeZone: vehicle.timezone, hour: 'numeric', minute: '2-digit' }) : null
    return <button key={vehicle.key} className="agency-line-vehicle" aria-pressed={selected === vehicle.key} aria-label={`Vehicle ${vehicle.label}, ${vehicleStopLabel(vehicle)}, ${vehicleDelayLabel(vehicle.delaySeconds)}${time ? `, ${vehicle.arrival.current !== null ? 'arrival' : 'departure'} ${time}` : ''}`} title={`${vehicleStopLabel(vehicle)} · ${vehicleDelayLabel(vehicle.delaySeconds)}`} onClick={() => { setSelected(vehicle.key); setSelectedStop(null) }}><Arrow size={12} /><strong>{vehicle.label}</strong>{time ? <span>{vehicle.arrival.current !== null ? '' : 'Dep. '}{time}</span> : null}</button>
  }
  function stopButton(stop: RoutePattern['stops'][number]) {
    return <button className="agency-line-station" aria-pressed={selectedStop === stop.id} aria-label={`Arrivals at ${stop.name}`} onClick={() => { setSelectedStop(stop.id); setSelected(null) }}>{stop.name}</button>
  }

  return <><section className="agency-line-view" aria-label="Bidirectional route line view" style={{ '--line-color': data?.color || 'var(--vigo-lime-strong)' } as CSSProperties}>
    {!routeId ? <div className="agency-empty"><Route size={25} /><h2>See a route in both directions</h2><p>Choose a route in Live to see its stops and reported vehicles.</p></div> : error ? <p className="agency-error" role="alert">{error}</p> : !data ? <p className="agency-caption" role="status">Reading the route’s stop patterns…</p> : <>
      <div className="agency-line-intro"><strong>Stops & arrivals</strong><p>Select a station for upcoming vehicles. Select a vehicle for its schedule.</p><span>Both directions · Reported positions on a schematic line.</span></div>
      {data.warnings.map(warning => <p key={warning} className="agency-vehicle-warning">{warning}</p>)}
      {!data.patterns.length ? <p className="agency-caption">No continuous stop pattern is indexed for this service day.</p> : <div className="agency-line-directions" style={{ gridTemplateColumns: `repeat(${visiblePatterns.length}, minmax(0, 1fr))` }}>{visiblePatterns.map((pattern, directionIndex) => {
        const up = directionIndex % 2 === 1
        const Arrow = up ? ArrowUp : ArrowDown
        const patterns = data.patterns.filter(other => other.directionId === pattern.directionId)
        const vehicles = data.vehicles.filter(vehicle => vehicle.patternId === pattern.id && vehicle.callIndex !== null)
        const otherVehicles = data.vehicles.filter(vehicle => vehicle.patternId !== pattern.id && vehicle.callIndex !== null && patterns.some(other => other.id === vehicle.patternId))
        const stops = pattern.stops.map((stop, index) => ({ ...stop, index }))
        if (up) stops.reverse()
        return <section className={`agency-line-direction ${up ? 'is-up' : ''}`} key={pattern.directionId ?? 'unknown'} aria-label={`Toward ${pattern.stops.at(-1)?.name}`}>
          <header><Arrow size={18} /><div><strong>To {pattern.stops.at(-1)?.name}</strong><small>{vehicles.length} reported {vehicles.length === 1 ? 'vehicle' : 'vehicles'}{otherVehicles.length ? ` · ${otherVehicles.length} on other stop patterns` : ''}</small></div></header>
          {patterns.length > 1 ? <select aria-label={`Stop pattern toward ${pattern.stops.at(-1)?.name}`} value={pattern.id} onChange={event => { const next = patterns.find(item => item.id === event.target.value); if (next) choosePattern(next) }}>{patterns.map(item => <option key={item.id} value={item.id}>{patternLabel(item)} · {data.vehicles.filter(vehicle => vehicle.patternId === item.id && vehicle.callIndex !== null).length} vehicles</option>)}</select> : <p className="agency-line-origin">From {pattern.stops[0]?.name}</p>}
          {!paired ? <ol>{stops.map(stop => {
            const at = vehicles.filter(vehicle => vehicle.callIndex === stop.index && atReportedStop(vehicle))
            const approaching = vehicles.filter(vehicle => vehicle.callIndex === stop.index && !atReportedStop(vehicle))
            return <li key={`${stop.id}/${stop.index}`}><div className="agency-line-approaching">{!up ? approaching.map(vehicle => vehicleChip(vehicle, up)) : null}</div><div className="agency-line-stop"><i />{stopButton(stop)}</div><div className="agency-line-at">{at.map(vehicle => vehicleChip(vehicle, up))}</div><div className="agency-line-approaching">{up ? approaching.map(vehicle => vehicleChip(vehicle, up)) : null}</div></li>
          })}</ol> : null}
        </section>
      })}{paired ? <ol className="agency-line-paired">{visiblePatterns[0].stops.map((stop, index) => <li key={`${stop.id}/${index}`}>
        {visiblePatterns.map((pattern, directionIndex) => {
          const up = directionIndex === 1
          const callIndex = up ? pattern.stops.length - index - 1 : index
          const vehicles = data.vehicles.filter(vehicle => vehicle.patternId === pattern.id && vehicle.callIndex === callIndex)
          const at = vehicles.filter(atReportedStop)
          const approaching = vehicles.filter(vehicle => !atReportedStop(vehicle))
          return <div className={`agency-line-traffic ${up ? 'is-up' : 'is-down'}`} key={pattern.id}><div>{!up ? approaching.map(vehicle => vehicleChip(vehicle, up)) : null}</div><div><i />{at.map(vehicle => vehicleChip(vehicle, up))}</div><div>{up ? approaching.map(vehicle => vehicleChip(vehicle, up)) : null}</div></div>
        })}
        <span>{stopButton(stop)}</span>
      </li>)}</ol> : null}</div>}
      {unplaced.length ? <details className="agency-line-unplaced"><summary>{unplaced.length} vehicles without a current stop position</summary>{unplaced.map(vehicle => <button className="agency-text-button" key={vehicle.key} onClick={() => setSelected(vehicle.key)}>{vehicle.label} · {vehicle.warnings[0] || 'Trip pattern unavailable'}</button>)}</details> : null}
      <p className="agency-caption">{data.serviceDate} · Times in {data.timezone}. Arrival and departure predictions are kept separate.</p>
    </>}
  </section>{selectedStop || selectedVehicle ? <aside className="agency-line-details"><button className="agency-icon-button" aria-label="Close details" onClick={() => { setSelected(null); setSelectedStop(null) }}><X size={15} /></button>{selectedStop ? <StopArrivalBoard key={`${projectId}/${selectedStop}`} projectId={projectId} stopId={selectedStop} /> : selectedVehicle ? <VehicleDetailsView vehicle={selectedVehicle} /> : null}</aside> : null}</>
}
