import type { ServiceVehicleFrame } from '../serviceVehicles'
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { ArrowDown, ArrowUp, ChevronRight, Route, X } from 'lucide-react'
import type { MapPreview } from '../domain'
import { apiJson } from '../app/api'
import type { RouteOperations, RoutePattern, VehicleTiming } from '../agency/routeOperationsTypes'
import { AgencyVehicleDetails, VehicleOperationalWarnings, VehicleDetailsView, vehicleDelayLabel, vehicleStopLabel } from './AgencyVehicleDetails'
import { StopArrivalBoard, type TripNavigation } from './StopArrivalBoard'

function patternLabel(pattern: RoutePattern) {
  return `${pattern.reportedOnly ? 'Added service · reported stops: ' : ''}${pattern.stops[0]?.name} → ${pattern.stops.at(-1)?.name} · ${pattern.stops.length} stops`
}
const atReportedStop = (vehicle: VehicleTiming) => vehicle.status === 'STOPPED_AT' || vehicle.status === 'STOP_REPORTED'

export function AgencyRouteLine({ projectId, routeId, selectedStopId = '', showStopDetails = true, preview, onSelectStop, onOpenTrip, vehicleFrame }: { vehicleFrame?: ServiceVehicleFrame; projectId: string; routeId: string; preview?: MapPreview; selectedStopId?: string; showStopDetails?: boolean; onSelectStop?: (id: string) => void; onOpenTrip?: TripNavigation }) {
  const fallback = useMemo<RouteOperations | null>(() => {
    if (!routeId || !preview?.routes.length) return null
    const stops = new Map(preview.stops.map(stop => [stop.id, stop]))
    const patterns = preview.routes.map(route => ({
      id: route.patternId || route.id,
      directionId: route.directionId ?? null,
      stops: route.stopIds.map(id => ({ id, name: stops.get(id)?.name || id })),
      trips: route.tripCount,
    })).filter(pattern => pattern.stops.length > 1)
    if (!patterns.length) return null
    return { routeId, name: preview.routes[0].shortName, color: preview.routes[0].color,
      serviceDate: null, timezone: null, generatedAt: '', observedAt: null,
      patterns, vehicles: [], warnings: ['Loading live positions…'] }
  }, [preview, routeId])
  const [loadedData, setData] = useState<RouteOperations | null>(null)
  const data = loadedData ?? fallback
  const [error, setError] = useState('')
  const [choices, setChoices] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedStop, setSelectedStop] = useState<string | null>(selectedStopId || null)
  useEffect(() => { setSelectedStop(selectedStopId || null) }, [selectedStopId])
  useEffect(() => {
    const controller = new AbortController()
    let pending = false
    setData(null); setError(''); setChoices({}); setSelected(null)
    if (!routeId) return () => controller.abort()
    async function refresh() {
      if (pending) return
      pending = true
      try {
        const result = await apiJson<RouteOperations>(`/api/projects/${encodeURIComponent(projectId)}/agency`, { method: 'POST', body: JSON.stringify({ action: 'route-line', routeId }), signal: controller.signal })
        if (!controller.signal.aborted) { setData(result); setError('') }
      } catch (error) { if (!controller.signal.aborted) { setError(error instanceof Error ? error.message : 'Line view is unavailable.') } }
      finally { pending = false }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 15_000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [projectId, routeId])

  const patternVehicleCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const vehicle of data?.vehicles ?? []) {
      if (vehicle.patternId !== null && vehicle.callIndex !== null) counts.set(vehicle.patternId, (counts.get(vehicle.patternId) ?? 0) + 1)
    }
    return counts
  }, [data])
  const rankedPatterns = useMemo(() => [...(data?.patterns ?? [])].sort((a, b) =>
    (patternVehicleCounts.get(b.id) ?? 0) - (patternVehicleCounts.get(a.id) ?? 0)), [data, patternVehicleCounts])
  const directions = useMemo(() => [...new Set(data?.patterns.map(pattern => pattern.directionId ?? 'unknown') ?? [])].sort(), [data])
  const visiblePatterns = directions.map(direction => {
    const patterns = rankedPatterns.filter(pattern => (pattern.directionId ?? 'unknown') === direction)
    return patterns.find(pattern => pattern.id === choices[direction]) ?? patterns[0]
  }).filter(Boolean)
  const mapVehicles = useMemo(() => new Map((vehicleFrame?.mode === 'live' ? vehicleFrame.vehicles : []).map(vehicle => [JSON.stringify([vehicle.sourceUrl, vehicle.id]), vehicle])), [vehicleFrame])
  const selectedVehicle = data?.vehicles.find(vehicle => vehicle.key === selected)
  const selectedMapVehicle = selectedVehicle ? mapVehicles.get(selectedVehicle.key) : undefined
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
    onSelectStop?.('')
  }
  function vehicleChip(vehicle: VehicleTiming, up: boolean) {
    const indicator = mapVehicles.get(vehicle.key)?.indicatorLabel
    const Arrow = up ? ArrowUp : ArrowDown
    const estimate = vehicle.arrival.current ?? vehicle.departure.current
    const time = estimate !== null && vehicle.timezone ? new Date(estimate * 1000).toLocaleTimeString([], { timeZone: vehicle.timezone, hour: 'numeric', minute: '2-digit' }) : null
    return <button key={vehicle.key} className={`agency-line-vehicle${indicator ? ' has-alert' : ''}`} aria-pressed={selected === vehicle.key} aria-label={`Vehicle ${vehicle.label}${indicator ? ', spacing or delay alert' : ''}, ${vehicleStopLabel(vehicle)}, ${vehicleDelayLabel(vehicle.delaySeconds)}${time ? `, ${vehicle.arrival.current !== null ? 'arrival' : 'departure'} ${time}` : ''}`} title={`${vehicleStopLabel(vehicle)} · ${vehicleDelayLabel(vehicle.delaySeconds)}`} onClick={() => { setSelected(vehicle.key); setSelectedStop(null) }}><Arrow size={12} /><strong>{vehicle.label}</strong>{indicator ? <span className="agency-line-indicator" aria-hidden="true">{indicator}</span> : null}{time ? <span>{vehicle.arrival.current !== null ? '' : 'Dep. '}{time}</span> : null}</button>
  }
  function selectStop(id: string) { setSelectedStop(id); setSelected(null); onSelectStop?.(id) }
  function stopButton(stop: RoutePattern['stops'][number], marker = false) {
    return <button className="agency-line-station" aria-pressed={selectedStop === stop.id} aria-label={`Arrivals at ${stop.name}`} onClick={() => selectStop(stop.id)}>{marker ? <i aria-hidden="true" /> : null}<span>{stop.name}</span><ChevronRight size={14} aria-hidden="true" /></button>
  }

  return <><section className="agency-line-view" aria-label="Bidirectional route line view" style={{ '--line-color': data?.color || 'var(--vigo-lime-strong)' } as CSSProperties}>
    {!routeId ? <div className="agency-empty"><Route size={25} /><h2>See a route in both directions</h2><p>Choose a route in Live to see its stops and reported vehicles.</p></div> : !data && error ? <p className="agency-error" role="alert">{error}</p> : !data ? <p className="agency-caption" role="status">Reading the route’s stop patterns…</p> : <>
      <div className="agency-line-intro"><strong>Stops & vehicles</strong><p>Select a stop for arrivals or a vehicle for its reported position.</p></div>
      {error ? <p className="agency-error" role="alert">{error}</p> : null}
      {(error && !loadedData ? [] : data.warnings).map(warning => <p key={warning} className="agency-vehicle-warning">{warning}</p>)}
      {!data.patterns.length ? <p className="agency-caption">No continuous stop pattern is indexed for this service day.</p> : <div className="agency-line-directions" style={{ gridTemplateColumns: `repeat(${visiblePatterns.length}, minmax(0, 1fr))` }}>{visiblePatterns.map((pattern, directionIndex) => {
        const up = directionIndex % 2 === 1
        const Arrow = up ? ArrowUp : ArrowDown
        const patterns = rankedPatterns.filter(other => other.directionId === pattern.directionId)
        const vehicles = data.vehicles.filter(vehicle => vehicle.patternId === pattern.id && vehicle.callIndex !== null)
        const otherVehicles = data.vehicles.filter(vehicle => vehicle.patternId !== pattern.id && vehicle.callIndex !== null && patterns.some(other => other.id === vehicle.patternId))
        const stops = pattern.stops.map((stop, index) => ({ ...stop, index }))
        if (up) stops.reverse()
        return <section className={`agency-line-direction ${up ? 'is-up' : ''}`} key={pattern.directionId ?? 'unknown'} aria-label={`Toward ${pattern.stops.at(-1)?.name}`}>
          <header><Arrow size={18} /><div><strong>{pattern.reportedOnly ? 'Reported to' : 'To'} {pattern.stops.at(-1)?.name}</strong><small>{!loadedData ? 'Live positions pending' : `${vehicles.length} reported ${vehicles.length === 1 ? 'vehicle' : 'vehicles'}`}{otherVehicles.length ? ` · ${otherVehicles.length} on other stop patterns` : ''}</small></div></header>
          {patterns.length > 1 ? <select aria-label={`Stop pattern toward ${pattern.stops.at(-1)?.name}`} value={pattern.id} onChange={event => { const next = patterns.find(item => item.id === event.target.value); if (next) choosePattern(next) }}>{patterns.map(item => <option key={item.id} value={item.id}>{patternLabel(item)} · {patternVehicleCounts.get(item.id) ?? 0} vehicles</option>)}</select> : <p className="agency-line-origin">{pattern.reportedOnly ? 'Added service · reported from' : 'From'} {pattern.stops[0]?.name}</p>}
          {!paired ? <ol>{stops.map(stop => {
            const at = vehicles.filter(vehicle => vehicle.callIndex === stop.index && atReportedStop(vehicle))
            const approaching = vehicles.filter(vehicle => vehicle.callIndex === stop.index && !atReportedStop(vehicle))
            return <li key={`${stop.id}/${stop.index}`}><div className="agency-line-approaching">{!up ? approaching.map(vehicle => vehicleChip(vehicle, up)) : null}</div><div className="agency-line-stop">{stopButton(stop, true)}</div><div className="agency-line-at">{at.map(vehicle => vehicleChip(vehicle, up))}</div><div className="agency-line-approaching">{up ? approaching.map(vehicle => vehicleChip(vehicle, up)) : null}</div></li>
          })}</ol> : null}
        </section>
      })}{paired ? <ol className="agency-line-paired">{visiblePatterns[0].stops.map((stop, index) => <li key={`${stop.id}/${index}`}>
        {visiblePatterns.map((pattern, directionIndex) => {
          const up = directionIndex === 1
          const callIndex = up ? pattern.stops.length - index - 1 : index
          const vehicles = data.vehicles.filter(vehicle => vehicle.patternId === pattern.id && vehicle.callIndex === callIndex)
          const at = vehicles.filter(atReportedStop)
          const approaching = vehicles.filter(vehicle => !atReportedStop(vehicle))
          return <div className={`agency-line-traffic ${up ? 'is-up' : 'is-down'}`} key={pattern.id}><button className="agency-line-stop-marker" tabIndex={-1} aria-label={`Arrivals at ${stop.name}`} onClick={() => selectStop(stop.id)}><i /></button><div>{!up ? approaching.map(vehicle => vehicleChip(vehicle, up)) : null}</div><div>{at.map(vehicle => vehicleChip(vehicle, up))}</div><div>{up ? approaching.map(vehicle => vehicleChip(vehicle, up)) : null}</div></div>
        })}
        <span>{stopButton(stop)}</span>
      </li>)}</ol> : null}</div>}
      {unplaced.length ? <details className="agency-line-unplaced"><summary>{unplaced.length} vehicles without a current stop position</summary>{unplaced.map(vehicle => <button className="agency-text-button" key={vehicle.key} onClick={() => setSelected(vehicle.key)}>{vehicle.label} · {vehicle.warnings[0] || 'Trip pattern unavailable'}</button>)}</details> : null}
      <p className="agency-caption">Timetable dates: {data.serviceDates?.join(', ') || data.serviceDate} · Times in {data.timezone}. Arrival and departure predictions are kept separate.</p>
    </>}
  </section>{(showStopDetails && selectedStop) || selectedVehicle ? <aside className={`map-live-card is-vehicle ${selectedVehicle ? 'has-vehicle-timing' : 'has-stop-arrivals'}`}><button className="agency-icon-button" aria-label="Close details" onClick={() => { setSelected(null); setSelectedStop(null); onSelectStop?.('') }}><X size={13} strokeWidth={2.6} /></button><VehicleOperationalWarnings vehicle={selectedMapVehicle} />{showStopDetails && selectedStop ? <StopArrivalBoard onOpenTrip={onOpenTrip} key={`${projectId}/${selectedStop}`} projectId={projectId} stopId={selectedStop} /> : selectedVehicle ? selectedMapVehicle ? <AgencyVehicleDetails key={selectedVehicle.key} projectId={projectId} vehicleId={selectedMapVehicle.id} sourceUrl={selectedMapVehicle.sourceUrl} onOpenTrip={onOpenTrip} /> : <VehicleDetailsView vehicle={selectedVehicle} onOpenTrip={onOpenTrip} /> : null}</aside> : null}</>
}
