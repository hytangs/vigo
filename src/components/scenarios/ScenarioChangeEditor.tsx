import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ArrowLeftRight, CircleDot, Eraser, LoaderCircle, MapPin, MousePointerClick, Pencil, Plus, RotateCcw, Route, Trash2, TriangleAlert, Undo2, X } from 'lucide-react'
import { flexZoneAreaKm2, flexZoneSelfIntersects, smoothRailPath } from '../../app/scenarioGeometry'
import { useScenarioStopNames } from '../../app/useScenarioStopNames'
import { scenarioLibrary } from '../../state/scenarios'
import { shallowEqual, useStore } from '../../app/store'
import { gtfsDirectionLabel, gtfsPatternStops, gtfsPatternTimetable } from '../../app/gtfsPresentation'
import { classNames, formatNumber, type RouteMetric, type StopMetric } from '../../domain'
import {
  scenarioEdgeEditError,
  scenarioEdgeIndexes,
  scenarioInsertedStopsForEdge,
  type ScenarioChangeDraft,
  type ScenarioGeometryMode,
  type ScenarioRouteScope,
} from '../../reach'
import { scopedRouteServiceKey } from '../../routeServices'
import { clock } from '../../state/clock'
import { useStudio } from '../../state/hooks'
import { network } from '../../state/network'
import {
  activeScenarioStopPlacement,
  beginScenarioStopPlacement,
  cancelScenarioStopPlacement,
  changeGeometryMode,
  changeHasStops,
  changeRunsService,
  clearScenarioSketch,
  finishScenarioDrawing,
  inferScenarioRoadGeometry,
  removeScenarioStop,
  reorderScenarioStop,
  resetScenarioRouteStops,
  reverseScenarioLine,
  scenarioEditor,
  scenarioRoutes,
  startScenarioDrawing,
  undoScenarioStop,
  updateScenarioChange,
  updateScenarioChangeRoute,
} from '../../state/scenarioEditor'
import { preview, selectedProject } from '../../state/scope'
import { AnalysisNumberField } from '../ReachSettings'
import { serviceTimeLabel } from './presentation'

const serviceStartOptions = [0, 300, 360, 420, 480, 540, 600, 720] as const
const serviceEndOptions = [1080, 1200, 1320, 1440, 1500, 1560, 1680] as const

function routeOptionLabel(route: RouteMetric) {
  return `${route.shortName} · ${route.longName || `${route.stopCount} stops`}`
}

function branchOptionLabel(route: RouteMetric, stops: StopMetric[]) {
  const orderedStops = gtfsPatternStops(route, stops)
  const terminals = `${orderedStops[0]?.name ?? '?'} → ${orderedStops.at(-1)?.name ?? '?'}`
  const timetable = gtfsPatternTimetable(route)
  const pattern = route.serviceVariantCount && route.serviceVariantCount > 1 ? `Pattern ${route.patternRank ?? '?'}` : 'Published pattern'
  return `${pattern} · ${terminals} · ${gtfsDirectionLabel(route.directionId)} · ${route.stopCount} stops · ${formatNumber(timetable.tripCount)} trips${timetable.dated ? ' on date' : ''}`
}

const routePatternRank = (route: RouteMetric) => route.patternRank ?? Number.MAX_SAFE_INTEGER

/** The three ways a new line can run between its stops. */
const alignments = [
  ['auto-road', 'Roads', 'Snaps to the local OSM street network, like a bus'],
  ['smooth-rail', 'Rail', 'A smooth curve through the stops, like a tram or train'],
  ['straight-line', 'Direct', 'Straight between stops'],
] as const satisfies ReadonlyArray<readonly [ScenarioGeometryMode, string, string]>

function AlignmentPicker({ change }: { change: ScenarioChangeDraft }) {
  const mode = changeGeometryMode(change)
  return <div className="studio-tabs scenario-alignment" role="radiogroup" aria-label="Alignment">
    {alignments.map(([value, label, detail]) => <button key={value} type="button" role="radio" aria-checked={mode === value} aria-pressed={mode === value} title={detail}
      onClick={() => {
        if (mode === value) return
        updateScenarioChange(change.id, { geometryMode: value, timeModel: value === 'straight-line' ? 'estimate-distance' : 'infer-road' })
      }}>
      <svg viewBox="0 0 28 14" aria-hidden="true">
        {value === 'auto-road' ? <path d="M2 11h6V5h7v5h5V3h6" /> : value === 'smooth-rail' ? <path d="M2 11C8 11 9 3 14 3s7 8 12 8" /> : <path d="M2 11 14 3l12 8" />}
      </svg>
      <span>{label}</span>
    </button>)}
  </div>
}

/** Where the drawn path stands: traced, tracing, curved or failed. */
function PathStatus({ change }: { change: ScenarioChangeDraft }) {
  const mode = changeGeometryMode(change)
  const streetsReady = useStudio(() => selectedProject().osmStreetIndex?.status === 'ready')
  const drawing = useStore(scenarioEditor, (state) => state.drawing)
  const railKm = useMemo(() => mode === 'smooth-rail' && change.stops.length >= 2
    ? smoothRailPath(change.stops.map((stop) => stop.coordinate)).distancesKm.reduce((sum, km) => sum + km, 0) : 0, [change.stops, mode])
  if (change.stops.length < 2) return null
  if (mode === 'smooth-rail') return <p className="scenario-path-status is-ready">{railKm.toFixed(2)} km of track · times from its length and the average speed</p>
  if (mode === 'straight-line') return <p className="scenario-path-status">Straight between stops · times from distance and the average speed</p>
  if (mode !== 'auto-road') return null
  const total = change.inferredSegmentDistanceKm?.reduce((sum, km) => sum + km, 0) ?? 0
  return <div className="scenario-path-trace">
    {change.geometryStatus === 'loading' ? <p className="scenario-path-status"><LoaderCircle className="is-spinning" size={13} aria-hidden="true" />Snapping to roads…</p>
      : change.geometryStatus === 'ready' ? <p className="scenario-path-status is-ready">{total.toFixed(2)} km along roads
        {(change.inferredPublishedShapeSegmentCount ?? 0) > 0 ? ` · ${change.inferredPublishedShapeSegmentCount} on the GTFS shape` : ''}
        {(change.inferredFallbackSegmentCount ?? 0) > 0 ? ` · ${change.inferredFallbackSegmentCount} shape fallback${change.inferredFallbackSegmentCount === 1 ? '' : 's'}` : ''}</p>
        : change.geometryError ? <p className="scenario-path-status is-error">{change.geometryError}</p>
          : !streetsReady ? <p className="scenario-path-status is-error">Build the City’s street index to follow roads.</p>
            : drawing ? <p className="scenario-path-status">Roads are traced when you finish drawing.</p>
              : <p className="scenario-path-status">Not traced yet.</p>}
    {change.geometryStatus !== 'loading' && streetsReady && !drawing ? <button type="button" className="kit-text-button" onClick={() => void inferScenarioRoadGeometry(change.id)}>
      <Route size={13} aria-hidden="true" />{change.geometryStatus === 'ready' ? 'Trace again' : 'Trace roads'}
    </button> : null}
  </div>
}

/** The ordered stops (or zone corners) of a change, with map placement. */
function StopSequence({ change }: { change: ScenarioChangeDraft }) {
  const placement = useStudio(activeScenarioStopPlacement)
  const drawing = useStore(scenarioEditor, (state) => state.drawing)
  const zone = change.kind === 'flex-zone'
  const stops = change.stops
  const project = useStudio(selectedProject)
  const library = useStudio(scenarioLibrary)
  useScenarioStopNames(project.id, change, library.setScenarioDrafts)
  const noun = zone ? 'corner' : 'stop'
  const minimum = zone ? 3 : 2
  const drawingHere = drawing && placement?.interventionId === change.id
  const canDraw = change.kind === 'add-line' || zone

  return <div className="scenario-stops">
    <div className="scenario-stops-head">
      <span><CircleDot size={14} aria-hidden="true" /><strong>{stops.length} {stops.length === 1 ? noun : `${noun}s`}</strong></span>
      {canDraw ? <button type="button" className={classNames('kit-button scenario-draw-button', drawingHere && 'is-primary')} aria-pressed={drawingHere}
        onClick={() => drawingHere ? finishScenarioDrawing() : startScenarioDrawing(change.id)}>
        <MousePointerClick size={13} aria-hidden="true" />{drawingHere ? 'Done' : stops.length ? `Continue ${zone ? 'zone' : 'line'}` : `Draw ${zone ? 'zone' : 'line'}`}
      </button> : null}
      {drawingHere && stops.length ? <button type="button" className="kit-icon-button" onClick={undoScenarioStop} aria-label={`Undo last ${noun}`} title={`Undo last ${noun} (Backspace)`}><Undo2 size={14} aria-hidden="true" /></button> : null}
      {change.kind === 'add-line' && stops.length >= 2 && !drawingHere ? <button type="button" className="kit-icon-button" onClick={() => reverseScenarioLine(change.id)} aria-label="Reverse line direction" title="Reverse direction"><ArrowLeftRight size={14} aria-hidden="true" /></button> : null}
      {stops.length && !drawingHere ? change.kind === 'change-line'
        ? <button type="button" className="kit-icon-button" onClick={() => resetScenarioRouteStops(change.id)} aria-label="Reset to GTFS stops" title="Reset to GTFS"><RotateCcw size={14} aria-hidden="true" /></button>
        : <button type="button" className="kit-icon-button" onClick={() => clearScenarioSketch(change.id)} aria-label={`Clear ${noun}s`} title="Clear"><Eraser size={14} aria-hidden="true" /></button> : null}
    </div>

    {placement && placement.interventionId === change.id && !drawingHere ? <div className="scenario-placing" role="status" aria-live="polite">
      <MapPin size={14} aria-hidden="true" />
      <span>Click a GTFS stop or the map to {placement.mode === 'insert' ? `insert stop ${placement.index + 1}` : `change stop ${placement.index + 1}`}.</span>
      <button type="button" className="kit-icon-button" onClick={cancelScenarioStopPlacement} aria-label="Cancel placement" title="Cancel"><X size={14} aria-hidden="true" /></button>
    </div> : null}

    {stops.length < minimum && !drawingHere ? <p className="scenario-hint">
      {canDraw ? zone ? 'Draw the zone: click each corner on the map, then click the first corner to close it.' : 'Draw the line: click the map or a GTFS stop for each stop in order. Drag stops to move them.'
        : change.routeId ? 'This route has no editable GTFS stop sequence.' : 'Choose a route to load its GTFS stops.'}
    </p> : null}

    {stops.length && !zone ? <ol className="scenario-stop-list" aria-label={`${change.name} stops`}>
      {stops.map((stop, index) => <li key={stop.id} draggable={change.kind === 'add-line'}
        onDragStart={event => { event.dataTransfer.setData('application/x-vigo-stop', stop.id); event.dataTransfer.effectAllowed = 'move' }}
        onDragOver={event => { if (change.kind === 'add-line' && event.dataTransfer.types.includes('application/x-vigo-stop')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }}
        onDrop={event => { if (change.kind === 'add-line') { event.preventDefault(); reorderScenarioStop(change.id, event.dataTransfer.getData('application/x-vigo-stop'), index) } }}
        className={classNames(placement?.mode === 'replace' && placement.index === index && 'is-placing', stop.editStatus && stop.editStatus !== 'baseline' && 'is-edited')}>

        <span className="scenario-stop-name"><strong title={stop.label}>{stop.label}</strong></span>
        {change.kind === 'add-line' ? <>
          <button type="button" className="kit-icon-button scenario-stop-action" disabled={index === 0}
            aria-label={`Move ${stop.label} earlier`} title="Move earlier" onClick={() => reorderScenarioStop(change.id, stop.id, index - 1)}><ArrowUp size={13} aria-hidden="true" /></button>
          <button type="button" className="kit-icon-button scenario-stop-action" disabled={index === stops.length - 1}
            aria-label={`Move ${stop.label} later`} title="Move later" onClick={() => reorderScenarioStop(change.id, stop.id, index + 1)}><ArrowDown size={13} aria-hidden="true" /></button>
        </> : null}
        <button type="button" className="kit-icon-button scenario-stop-action" onClick={() => beginScenarioStopPlacement(change.id, 'replace', index)}
          aria-pressed={placement?.mode === 'replace' && placement.index === index} aria-label={`Change stop ${index + 1}, ${stop.label}`} title="Move to another place"><Pencil size={13} aria-hidden="true" /></button>
        <button type="button" className="kit-icon-button scenario-stop-action" onClick={() => removeScenarioStop(change.id, index)} disabled={stops.length <= minimum}
          aria-label={`Remove stop ${index + 1}, ${stop.label}`} title={stops.length <= minimum ? 'A line needs at least two stops.' : 'Remove stop'}><Trash2 size={13} aria-hidden="true" /></button>
        {index < stops.length - 1 ? <button type="button" className="scenario-stop-insert" disabled={stops.length >= 256}
          aria-label={`Insert stop between ${index + 1} and ${index + 2}`}
          aria-pressed={placement?.mode === 'insert' && placement.index === index + 1}
          onClick={() => beginScenarioStopPlacement(change.id, 'insert', index + 1)}>
          <Plus size={12} aria-hidden="true" /><span>Add stop</span>
        </button> : null}
      </li>)}
    </ol> : null}
  </div>
}

/** Departures, speed and hours of a line. */
function ServiceSettings({ change }: { change: ScenarioChangeDraft }) {
  const keepsTrips = change.kind === 'change-line' && change.scheduleMode !== 'frequency'
  return <div className="scenario-service">
    {change.kind === 'change-line' ? <label className="reach-field">
      <span>Departures</span>
      <select value={change.scheduleMode ?? 'preserve-trips'} onChange={(event) => updateScenarioChange(change.id, { scheduleMode: event.currentTarget.value as 'preserve-trips' | 'frequency', bidirectional: false })}>
        <option value="preserve-trips">Keep scheduled departures</option>
        <option value="frequency">Set frequency and hours</option>
      </select>
      {keepsTrips ? <small>Every trip on the service date keeps running; stop edits change its travel times.</small> : null}
    </label> : null}
    {!keepsTrips ? <AnalysisNumberField label="Every" value={change.headwayMinutes} min={2} max={180} unit="min"
      onChange={(value) => { if (value !== undefined) updateScenarioChange(change.id, { headwayMinutes: value }) }} /> : null}
    <AnalysisNumberField label="Average speed" value={change.averageSpeedKph} min={4} max={160} unit="km/h"
      onChange={(value) => { if (value !== undefined) updateScenarioChange(change.id, { averageSpeedKph: value }) }} />
    {!keepsTrips ? <ServiceHours change={change} /> : null}
    {!keepsTrips ? <label className="reach-check">
      <input type="checkbox" role="switch" checked={change.routeScope === 'edge' ? false : change.bidirectional} disabled={change.routeScope === 'edge'}
        onChange={(event) => updateScenarioChange(change.id, { bidirectional: event.currentTarget.checked })} />
      <span><strong>{change.kind === 'add-line' ? 'Both directions' : 'Add reverse service'}</strong>{change.kind !== 'add-line' ? <small>{change.routeScope === 'edge'
        ? 'Each matching branch follows its published stop order.'
        : 'Also run this branch reversed. The reverse is not taken from GTFS.'}</small> : null}</span>
    </label> : null}
  </div>
}

function ServiceHours({ change }: { change: ScenarioChangeDraft }) {
  return <div className="reach-field-grid">
    <label className="reach-field"><span>From</span>
      <select value={change.startMinutes} onChange={(event) => updateScenarioChange(change.id, { startMinutes: Number(event.currentTarget.value) })}>
        {[...new Set([...serviceStartOptions, change.startMinutes])].sort((a, b) => a - b).map((value) => <option key={value} value={value}>{serviceTimeLabel(value)}</option>)}
      </select>
    </label>
    <label className="reach-field"><span>Until</span>
      <select value={change.endMinutes} onChange={(event) => updateScenarioChange(change.id, { endMinutes: Number(event.currentTarget.value) })}>
        {[...new Set([...serviceEndOptions, change.endMinutes])].sort((a, b) => a - b).map((value) => <option key={value} value={value}>{serviceTimeLabel(value)}</option>)}
      </select>
    </label>
  </div>
}

/** Pick the published route (and branch) a change edits. */
function RoutePicker({ change }: { change: ScenarioChangeDraft }) {
  const routes = useStudio(scenarioRoutes)
  const stops = useStudio(() => preview().stops)
  const serviceDate = useStore(clock, (state) => state.serviceDate)
  const routeAnalysis = useStore(network, (state) => ({ loading: Boolean(state.routeAnalysisRouteId), error: state.routeAnalysisError }), shallowEqual)
  const [query, setQuery] = useState('')
  const selectedRoute = useMemo(() => routes.find((route) => route.id === change.routeId || route.patternId === change.routeId), [change.routeId, routes])
  const routeOptions = useMemo(() => {
    const text = query.trim().toLocaleLowerCase()
    const groups = new Map<string, RouteMetric[]>()
    for (const route of routes) {
      if (text && !`${route.id} ${route.routeId ?? ''} ${route.shortName} ${route.longName}`.toLocaleLowerCase().includes(text)) continue
      const key = scopedRouteServiceKey(route)
      groups.set(key, [...(groups.get(key) ?? []), route])
    }
    const representatives = [...groups.values()]
      .map((variants) => [...variants].sort((left, right) => routePatternRank(left) - routePatternRank(right) || right.tripCount - left.tripCount)[0])
      .filter((route): route is RouteMetric => Boolean(route))
      .slice(0, 300)
    return selectedRoute && !representatives.some((route) => scopedRouteServiceKey(route) === scopedRouteServiceKey(selectedRoute))
      ? [selectedRoute, ...representatives] : representatives
  }, [query, routes, selectedRoute])
  const branches = useMemo(() => selectedRoute
    ? routes.filter((route) => scopedRouteServiceKey(route) === scopedRouteServiceKey(selectedRoute))
      .sort((left, right) => routePatternRank(left) - routePatternRank(right) || right.tripCount - left.tripCount || left.id.localeCompare(right.id))
    : [], [routes, selectedRoute])
  const edgeNote = useMemo(() => {
    if (!selectedRoute || change.routeScope !== 'edge') return ''
    const error = scenarioEdgeEditError(selectedRoute, change.stops)
    if (error) return error
    if (branches.length !== selectedRoute.serviceVariantCount || branches.some((branch) => branch.analysisSource !== 'focused' || branch.analysisServiceDate !== serviceDate)) {
      return 'Load the complete GTFS branch list for the selected service date to confirm every affected branch.'
    }
    const edit = scenarioInsertedStopsForEdge(change.stops)!
    const occurrences = branches.map((branch) => scenarioEdgeIndexes(branch, edit.beforeStopId, edit.afterStopId).length)
    return `${occurrences.filter(Boolean).length} of ${branches.length} branches · ${occurrences.reduce((sum, count) => sum + count, 0)} A → B occurrences. Insertions apply at every match, in each branch’s direction.`
  }, [branches, change.routeScope, change.stops, selectedRoute, serviceDate])

  return <div className="scenario-route-picker">
    <input type="search" value={query} placeholder="Find a route by name or number" aria-label="Find route" onChange={(event) => setQuery(event.currentTarget.value)} />
    <select value={selectedRoute ? scopedRouteServiceKey(selectedRoute) : ''} aria-label="Route"
      onChange={(event) => updateScenarioChangeRoute(change.id, routeOptions.find((route) => scopedRouteServiceKey(route) === event.currentTarget.value)?.id ?? '')}>
      <option value="">{routeOptions.length ? 'Choose a route' : 'No matching routes'}</option>
      {routeOptions.map((route) => <option key={scopedRouteServiceKey(route)} value={scopedRouteServiceKey(route)}>{routeOptionLabel(route)}</option>)}
    </select>
    {selectedRoute && branches.length > 1 ? <select value={change.routeId ?? ''} aria-label="GTFS branch" onChange={(event) => updateScenarioChangeRoute(change.id, event.currentTarget.value)}>
      {branches.map((route) => <option key={route.id} value={route.id}>{branchOptionLabel(route, stops)}</option>)}
    </select> : null}
    {routeAnalysis.loading ? <small><LoaderCircle className="is-spinning" size={12} aria-hidden="true" /> Loading every GTFS branch of this route…</small>
      : routeAnalysis.error ? <small className="is-error">{routeAnalysis.error}</small> : null}
    {change.routeId && (change.kind === 'change-line' || change.kind === 'remove-line') ? <label className="reach-field">
      <span>{change.kind === 'remove-line' ? 'Remove' : 'Apply the edit to'}</span>
      <select value={change.routeScope ?? 'pattern'} onChange={(event) => updateScenarioChange(change.id, { routeScope: event.currentTarget.value as ScenarioRouteScope })}>
        <option value="pattern">This branch only</option>
        {change.kind === 'change-line' ? <option value="edge">Every branch serving this A → B edge</option> : null}
        {change.kind === 'remove-line' ? <option value="route">Every branch of the route</option> : null}
      </select>
      {change.kind === 'change-line' && change.routeScope === 'edge' ? <small>{edgeNote}</small> : null}
    </label> : null}
    {change.routeId && (change.kind === 'change-line' || change.kind === 'enhance-line') ? <label className="reach-field">
      <span>Path and timing</span>
      <select value={changeGeometryMode(change)} onChange={(event) => {
        const mode = event.currentTarget.value as ScenarioGeometryMode
        updateScenarioChange(change.id, { geometryMode: mode, timeModel: mode === 'auto-road' ? 'infer-road' : mode === 'straight-line' ? 'estimate-distance' : 'preserve-scheduled' })
        if (mode === 'auto-road') void inferScenarioRoadGeometry(change.id)
      }}>
        <option value="published-shape">Published shape and times</option>
        <option value="auto-road">GTFS shape, edits along roads</option>
        <option value="straight-line">Straight-line estimate</option>
      </select>
    </label> : null}
  </div>
}

/** An on-demand service area drawn on the map. */
function FlexZoneSettings({ change }: { change: ScenarioChangeDraft }) {
  const vertices = useMemo(() => change.stops.map((stop) => stop.coordinate), [change.stops])
  const area = flexZoneAreaKm2(vertices)
  const crossing = flexZoneSelfIntersects(vertices)
  return <>
    {vertices.length >= 3 ? <div className="kit-stats">
      <span><b>{area < 10 ? area.toFixed(2) : area.toFixed(1)} km²</b><small>service area</small></span>
      <span><b>{vertices.length}</b><small>corners</small></span>
    </div> : null}
    {crossing ? <p className="kit-notice is-warning"><TriangleAlert size={14} aria-hidden="true" /><span>The outline crosses itself. Drag a corner so the edges do not cross.</span></p> : null}
    <div className="scenario-service">
      <AnalysisNumberField label="Typical wait" value={change.flexWaitMinutes ?? 15} min={0} max={120} unit="min"
        onChange={(value) => { if (value !== undefined) updateScenarioChange(change.id, { flexWaitMinutes: value }) }} />
      <AnalysisNumberField label="Vehicle speed" value={change.averageSpeedKph} min={4} max={120} unit="km/h"
        onChange={(value) => { if (value !== undefined) updateScenarioChange(change.id, { averageSpeedKph: value }) }} />
      <ServiceHours change={change} />
    </div>
    <p className="scenario-hint">Saved with the scenario and drawn on every map. Route and Reach do not route through planned Flex zones yet; they run the scenario’s lines.</p>
  </>
}

/** Everything about one change: what it edits, its path, stops and service. */
export function ScenarioChangeEditor({ change }: { change: ScenarioChangeDraft }) {
  return <div className="scenario-change-editor">
    <input className="scenario-change-name" type="text" value={change.name} maxLength={80} aria-label="Change name"
      onChange={(event) => updateScenarioChange(change.id, { name: event.currentTarget.value })}
      onBlur={(event) => { if (!event.currentTarget.value.trim()) updateScenarioChange(change.id, { name: 'Untitled change' }) }} />
    {change.kind === 'add-line' ? <><AlignmentPicker change={change} /><PathStatus change={change} /></> : null}
    {change.kind !== 'add-line' && change.kind !== 'flex-zone' ? <RoutePicker change={change} /> : null}
    {change.kind === 'change-line' && changeGeometryMode(change) === 'auto-road' ? <PathStatus change={change} /> : null}
    {changeHasStops(change.kind) || change.kind === 'flex-zone' ? <StopSequence change={change} /> : null}
    {change.kind === 'flex-zone' ? <FlexZoneSettings change={change} /> : null}
    {changeRunsService(change.kind) && (change.kind === 'add-line' || change.routeId) ? <ServiceSettings change={change} /> : null}
    {change.kind === 'remove-line' && change.routeId ? <p className="scenario-hint">Its trips leave the timetable. Riders reroute on the rest of the network.</p> : null}
  </div>
}
