import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDown, MapPin, Search } from 'lucide-react'
import type { StopMetric } from '../domain'
import type { RoutingPoint } from '../routingModel'
import '../styles/analysis-origin.css'

const pageSize = 20

export function analysisStopDisplayId(id: string): string {
  // City feed IDs are feed_ plus ten lowercase hexadecimal characters. Strip
  // only that known namespace, leaving separators inside original GTFS IDs.
  return id.replace(/^feed_[0-9a-f]{10}(?:::|\u001f)(.+)$/, '$1')
}

export function analysisStopOrigin(stop: StopMetric): RoutingPoint | null {
  if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon) || Math.abs(stop.lat!) > 90 || Math.abs(stop.lon!) > 180) return null
  return { coordinate: [stop.lon!, stop.lat!], label: stop.name, stopId: stop.id, source: 'stop' }
}

export function searchAnalysisStops(stops: StopMetric[], search: string): StopMetric[] {
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return stops.filter(stop => analysisStopOrigin(stop) && terms.every(term => `${stop.name} ${stop.id}`.toLocaleLowerCase().includes(term)))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.id.localeCompare(b.id))
}

type CoordinateResult = { point: RoutingPoint; error?: never; field?: never } | { point?: never; error: string; field: 'latitude' | 'longitude' }

export function analysisCoordinateOrigin(latitude: string, longitude: string): CoordinateResult {
  if (!latitude.trim()) return { error: 'Enter a latitude between −90 and 90.', field: 'latitude' }
  const lat = Number(latitude)
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) return { error: 'Latitude must be between −90 and 90.', field: 'latitude' }
  if (!longitude.trim()) return { error: 'Enter a longitude between −180 and 180.', field: 'longitude' }
  const lon = Number(longitude)
  if (!Number.isFinite(lon) || Math.abs(lon) > 180) return { error: 'Longitude must be between −180 and 180.', field: 'longitude' }
  return { point: { coordinate: [lon, lat], label: `Coordinates · ${lat.toFixed(5)}, ${lon.toFixed(5)}`, source: 'map' } }
}

export function AnalysisOriginPicker({ origin, stops, onSetOrigin, disabled = false }: {
  origin: RoutingPoint | null
  stops: StopMetric[]
  onSetOrigin: (point: RoutingPoint) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(pageSize)
  const [latitude, setLatitude] = useState('')
  const [longitude, setLongitude] = useState('')
  const [error, setError] = useState<{ message: string; field: 'latitude' | 'longitude' } | null>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const latitudeRef = useRef<HTMLInputElement>(null)
  const longitudeRef = useRef<HTMLInputElement>(null)
  const id = useId()
  const results = useMemo(() => open ? searchAnalysisStops(stops, search) : [], [stops, search, open])
  useEffect(() => { if (open) searchRef.current?.focus() }, [open])

  function close() { setOpen(false); toggleRef.current?.focus() }
  function select(point: RoutingPoint) { if (disabled) return; onSetOrigin(point); close() }
  function setCoordinates() {
    if (disabled) return
    const result = analysisCoordinateOrigin(latitude, longitude)
    if (result.error) {
      setError({ message: result.error, field: result.field })
      if (result.field === 'latitude') latitudeRef.current?.focus()
      else longitudeRef.current?.focus()
      return
    }
    select(result.point!)
  }
  function coordinateKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); setCoordinates() }
  }

  return <div className="analysis-origin-picker" onKeyDown={event => {
    if (event.key === 'Escape' && open && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); close() }
  }}>
    <button ref={toggleRef} type="button" className="reach-mini-action analysis-origin-toggle" aria-expanded={open} aria-controls={`${id}-panel`} disabled={disabled} onClick={() => {
      if (open) close()
      else {
        setLatitude(origin ? String(origin.coordinate[1]) : '')
        setLongitude(origin ? String(origin.coordinate[0]) : '')
        setError(null)
        setOpen(true)
      }
    }}><MapPin size={14} aria-hidden="true" />{origin ? 'Change origin' : 'Choose origin'}<ChevronDown size={14} aria-hidden="true" /></button>
    {open ? <div id={`${id}-panel`} className="analysis-origin-panel">
      <label htmlFor={`${id}-search`}>Search imported stops</label>
      <div className="analysis-origin-search"><Search size={18} aria-hidden="true" /><input id={`${id}-search`} ref={searchRef} type="search" placeholder="Stop name or ID" value={search} disabled={disabled} aria-describedby={`${id}-count`} onChange={event => { setSearch(event.target.value); setLimit(pageSize) }} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.preventDefault() }} /></div>
      <p id={`${id}-count`} className="analysis-origin-count" role="status">{results.length ? `${Math.min(limit, results.length)} of ${results.length.toLocaleString()} ${results.length === 1 ? 'stop' : 'stops'}${search.trim() ? ' match' : ''}` : search.trim() ? 'No imported stops match this search.' : 'No imported stops have usable coordinates.'}</p>
      {results.length ? <ul className="analysis-origin-results" aria-label="Origin stop choices">{results.slice(0, limit).map(stop => <li key={stop.id}><button type="button" disabled={disabled} title={`${stop.lat!.toFixed(5)}, ${stop.lon!.toFixed(5)}`} onClick={() => { const point = analysisStopOrigin(stop); if (point) select(point) }}><strong>{stop.name}</strong><span title={stop.id}>Stop {analysisStopDisplayId(stop.id)}</span></button></li>)}</ul> : null}
      {results.length > limit ? <button type="button" className="reach-mini-action" disabled={disabled} onClick={() => setLimit(value => value + pageSize)}>Show more stops ({results.length - limit} remaining)</button> : null}
      <details className="analysis-origin-coordinate-disclosure"><summary>Enter coordinates</summary><fieldset className="analysis-origin-coordinates" aria-label="Origin coordinates" disabled={disabled}>
        <div className="analysis-origin-coordinate-fields">
          <label htmlFor={`${id}-latitude`}>Latitude<input id={`${id}-latitude`} ref={latitudeRef} type="number" inputMode="decimal" min={-90} max={90} step="any" placeholder="42.3601" value={latitude} onKeyDown={coordinateKeyDown} aria-invalid={error?.field === 'latitude' || undefined} aria-describedby={error?.field === 'latitude' ? `${id}-error` : `${id}-coordinate-hint`} onChange={event => { setLatitude(event.target.value); setError(null) }} /></label>
          <label htmlFor={`${id}-longitude`}>Longitude<input id={`${id}-longitude`} ref={longitudeRef} type="number" inputMode="decimal" min={-180} max={180} step="any" placeholder="−71.0589" value={longitude} onKeyDown={coordinateKeyDown} aria-invalid={error?.field === 'longitude' || undefined} aria-describedby={error?.field === 'longitude' ? `${id}-error` : `${id}-coordinate-hint`} onChange={event => { setLongitude(event.target.value); setError(null) }} /></label>
        </div>
        <p id={`${id}-coordinate-hint`}>Latitude −90 to 90 · longitude −180 to 180</p>
        {error ? <p id={`${id}-error`} className="analysis-origin-error" role="alert">{error.message}</p> : null}
        <button type="button" className="analysis-origin-confirm" onClick={setCoordinates}>Use coordinates</button>
      </fieldset></details>
    </div> : null}
  </div>
}
