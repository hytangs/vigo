import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  CircleDot,
  Database,
  Eraser,
  LoaderCircle,
  MapPin,
  Pencil,
  Plus,
  Radar,
  RotateCcw,
  Route,
  Trash2,
  X,
} from 'lucide-react'
import type { ApiProgress } from '../app/api'
import { preparationState, type PreparationTask } from '../app/preparation'
import { classNames, formatNumber, type RouteMetric, type StopMetric } from '../domain'
import { gtfsDirectionLabel, gtfsPatternStops, gtfsPatternTimetable } from '../app/gtfsPresentation'
import { scopedRouteServiceKey } from '../routeServices'
import type { RoutingPoint } from '../routingModel'
import { ResultMetric } from './UiPrimitives'
import { AnalysisOriginPicker } from './AnalysisOriginPicker'
import {
  reachDifferenceCapMinutes,
  reachDifferenceGradient,
  reachTimeGradient,
  scenarioReachedAreaKm2,
  reachComparisonColor,
  scenarioImprovedPixels,
  scenarioReachablePixels,
  scenarioTransitStopsAtCutoff,
  scenarioInsertedStopsForEdge,
  scenarioEdgeEditError,
  scenarioEdgeIndexes,
  type ReachTransitStatus,
  type ScenarioDraft,
  type ScenarioChangeDraft,
  type ScenarioChangeKind,
  type ScenarioGeometryMode,
  type ReachResult,
  type ReachComparisonResult,
  type ScenarioRouteScope,
  type ScenarioRenderMode,
  type ScenarioStopDraft,
  type ScenarioStopPlacement,
  type ScenarioTimeModel,
  type ScenarioView,
  type ServiceEdgeDecomposition,
} from '../reach'

export type AnalyzeMode = 'single' | 'compare'

export type ComparisonFeedOption = {
  id: string
  name: string
  routeCount: number
  stopCount: number
  tripCount: number
}

type AnalyzePanelProps = {
  mode: AnalyzeMode
  origin: RoutingPoint | null
  serviceDate: string
  departMinutes: number
  maxWalkKm: number
  walkSpeedKph: number
  cutoffMinutes: number
  renderMode: ScenarioRenderMode
  cases: ScenarioDraft[]
  feeds: ComparisonFeedOption[]
  comparisonFeedIds: string[]
  activeCaseId: string
  activeInterventionId: string
  stopPlacement: ScenarioStopPlacement | null
  routes: RouteMetric[]
  stops: StopMetric[]
  routeAnalysisLoading: boolean
  routeAnalysisError: string
  view: ScenarioView
  loading: boolean
  progress: ApiProgress | null
  error: string
  analysis: ReachResult | null
  comparison: ReachComparisonResult[] | null
  serviceDecomposition: ServiceEdgeDecomposition | null
  serviceDecompositionLoading: boolean
  serviceDecompositionError: string
  routingStoreAvailable: boolean
  streetGraphAvailable: boolean
  preparationTasks: PreparationTask[]
  streetGraphBuilding: boolean
  routingStoreBuilding: boolean
  onServiceDateChange: (value: string) => void
  onDepartMinutesChange: (value: number) => void
  onMaxWalkKmChange: (value: number) => void
  onWalkSpeedChange: (value: number) => void
  onCutoffChange: (value: number) => void
  onRenderModeChange: (mode: ScenarioRenderMode) => void
  onModeChange: (mode: AnalyzeMode) => void
  onComparisonFeedChange: (feedId: string, selected: boolean) => void
  onSelectCase: (caseId: string) => void
  onAddCase: () => void
  onRemoveCase: (caseId: string) => void
  onAddIntervention: (kind: ScenarioChangeKind) => void
  onSelectIntervention: (interventionId: string) => void
  onUpdateIntervention: (
    interventionId: string,
    patch: Partial<ScenarioChangeDraft>,
  ) => void
  onInferInterventionGeometry: (interventionId: string) => void
  onUpdateInterventionRoute: (interventionId: string, routeId: string) => void
  onBeginStopPlacement: (
    interventionId: string,
    mode: ScenarioStopPlacement['mode'],
    index: number,
  ) => void
  onCancelStopPlacement: () => void
  onRemoveInterventionStop: (interventionId: string, index: number) => void
  onResetInterventionStops: (interventionId: string) => void
  onRemoveIntervention: (interventionId: string) => void
  onClearInterventionSketch: (interventionId: string) => void
  onViewChange: (view: ScenarioView) => void
  onClearOrigin: () => void
  onSetOrigin?: (point: RoutingPoint) => void
  onRun: () => void
  onRunComparison: () => void
  onRunServiceDecomposition: () => void
  onOpenData: () => void
  onCancel: () => void
}

const interventionOptions = [
  ['add-line', 'Add line'],
  ['enhance-line', 'Enhance line'],
  ['change-line', 'Change line'],
  ['remove-line', 'Remove line'],
] as const satisfies ReadonlyArray<readonly [ScenarioChangeKind, string]>
const interventionLabels = Object.fromEntries(interventionOptions)
const walkBudgetOptions = [0.4, 0.6, 0.8, 1.2, 1.6, 2, 3, 4, 5] as const
const walkSpeedOptions = [3, 3.6, 4.2, 4.8, 5.4, 6] as const
const cutoffOptions = [10, 15, 20, 30, 45, 60, 75, 90, 120] as const
const lineHeadwayOptions = [4, 5, 8, 10, 12, 15, 20, 30, 60] as const
const lineSpeedOptions = [12, 15, 20, 25, 30, 40, 60, 80] as const
const serviceStartOptions = [0, 300, 360, 420, 480, 540, 600, 720] as const
const serviceEndOptions = [1080, 1200, 1320, 1440, 1500, 1560, 1680] as const
const scenarioViewOptions = [
  ['baseline', 'Baseline'],
  ['scenario', 'Scenario'],
  ['comparison', 'Time difference'],
] as const satisfies ReadonlyArray<readonly [ScenarioView, string]>

function routeOptionLabel(route: RouteMetric) {
  return `${route.shortName} · ${route.longName || `${route.stopCount} stops`}`
}

function branchOptionLabel(route: RouteMetric, stops: StopMetric[]) {
  const direction = gtfsDirectionLabel(route.directionId)
  const orderedStops = gtfsPatternStops(route, stops)
  const terminals = `${orderedStops[0]?.name ?? '?'} → ${orderedStops.at(-1)?.name ?? '?'}`
  const timetable = gtfsPatternTimetable(route)
  const pattern = route.serviceVariantCount && route.serviceVariantCount > 1
    ? `Pattern ${route.patternRank ?? '?'}`
    : 'Published pattern'
  return `${pattern} · ${terminals} · ${direction} · ${route.stopCount} stops · ${formatNumber(timetable.tripCount)} trips${timetable.dated ? ' on date' : ''}`
}

function routePatternRank(route: RouteMetric) {
  return route.patternRank ?? Number.MAX_SAFE_INTEGER
}

function hasLineSettings(kind: ScenarioChangeKind) {
  return ['add-line', 'enhance-line', 'change-line'].includes(kind)
}

function routeScopeLabel(scope: ScenarioRouteScope | undefined) {
  if (scope === 'edge') return 'same ordered A → B edge'
  if (scope === 'route') return 'all branches'
  if (scope === 'pattern') return 'selected branch'
  return 'new modeled line'
}

function timeModelLabel(model: ScenarioTimeModel | undefined) {
  if (model === 'infer-road') return 'OSM road extrapolation'
  return model === 'estimate-distance' ? 'straight-line estimate' : 'published segment times'
}

function geometryModeLabel(mode: ScenarioGeometryMode | undefined, kind: ScenarioChangeKind) {
  if (mode === 'auto-road') return kind === 'add-line' ? 'OSM road path' : 'GTFS shape + OSM road path'
  if (mode === 'straight-line') return 'Straight-line path + speed'
  return 'Published shape + segment times'
}

function serviceTimeLabel(minutes: number) {
  const day = Math.floor(minutes / (24 * 60))
  const normalized = minutes % (24 * 60)
  const hours = Math.floor(normalized / 60)
  const minute = normalized % 60
  return `${String(hours).padStart(2, '0')}:${String(minute).padStart(2, '0')}${day ? ` +${day}d` : ''}`
}

function ReachSurfaceLegend({
  view,
  cutoffMinutes,
  terminalWalkKm,
}: {
  view: ScenarioView
  cutoffMinutes: number
  terminalWalkKm: number
}) {
  const difference = view === 'comparison'
  return (
    <div
      className={classNames('reach-surface-legend', difference && 'is-difference')}
      role="group"
      aria-label={difference ? 'Time difference legend' : `${view === 'baseline' ? 'Baseline' : 'Scenario'} travel time legend`}
    >
      <div className="reach-surface-legend-head">
        <strong>{difference ? 'Time difference' : view === 'baseline' ? 'Baseline' : 'Scenario'}</strong>
        <small>{difference ? 'Green is faster · red is slower' : `Elapsed time · final walk ≤ ${terminalWalkKm} km`}</small>
      </div>
      <div
        className="reach-surface-legend-bar"
        style={{ background: difference ? reachDifferenceGradient : reachTimeGradient }}
        aria-hidden="true"
      />
      <div className="reach-surface-legend-scale">
        {difference ? (
          <><span>{reachDifferenceCapMinutes}+ min slower</span><span>same</span><span>{reachDifferenceCapMinutes}+ min faster</span></>
        ) : (
          <><span>0 min</span><span>{Math.round(cutoffMinutes / 2)} min</span><span>{cutoffMinutes} min</span></>
        )}
      </div>
    </div>
  )
}

function ReachRenderModePicker({
  renderMode,
  onRenderModeChange,
  terminalWalkKm: _terminalWalkKm,
}: {
  renderMode: ScenarioRenderMode
  onRenderModeChange: (mode: ScenarioRenderMode) => void
  terminalWalkKm: number
}) {
  return (
    <div className="reach-render-mode">
      <span className="reach-render-mode-label">Map</span>
      <div className="studio-tabs reach-segmented is-render-mode" role="group" aria-label="Reach map rendering">
        <button
          type="button"
          className={classNames(renderMode === 'area' && 'is-active')}
          aria-pressed={renderMode === 'area'}
          onClick={() => onRenderModeChange('area')}
        >
          Reachable area
        </button>
        <button
          type="button"
          className={classNames(renderMode === 'streets' && 'is-active')}
          aria-pressed={renderMode === 'streets'}
          onClick={() => onRenderModeChange('streets')}
        >
          Reached streets
        </button>
      </div>
    </div>
  )
}

function transitStopsForSelectedCutoff(analysis: ReachResult, surface: 'baseline' | 'scenario', cutoffMinutes: number): number | null {
  if (analysis.diagnostics.preliminary) return null
  const entries = surface === 'scenario'
    ? analysis.summary.scenarioTransitStopsByCutoff ?? analysis.summary.transitStopsByCutoff
    : analysis.summary.transitStopsByCutoff
  const exact = entries?.find(entry => entry.cutoffMinutes === cutoffMinutes)
  // The shared helper can fall back to an earlier cutoff or full-window seeds.
  // Those are useful elsewhere, but cannot establish this exact UI measure.
  return exact && Number.isFinite(exact.stops) ? scenarioTransitStopsAtCutoff(analysis, surface, cutoffMinutes) : null
}

const reachDecimal = (value: number, digits: number) => value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })

export function ReachMetricCards({
  analysis,
  surface,
  cutoffMinutes,
  walkBudgetKm,
}: {
  analysis: ReachResult
  surface: 'baseline' | 'scenario'
  cutoffMinutes: number
  walkBudgetKm: number
}) {
  const areaKm2 = scenarioReachedAreaKm2(analysis, surface, cutoffMinutes)
  const stops = transitStopsForSelectedCutoff(analysis, surface, cutoffMinutes)
  const network = surface === 'scenario'
    ? analysis.diagnostics.raster.scenarioNetwork
    : analysis.diagnostics.raster.baselineNetwork
  return (
    <div className="reach-metric-grid" aria-label={`${surface === 'baseline' ? 'Baseline' : 'Scenario'} network reach metrics`}>
      <ResultMetric value={`${reachDecimal(areaKm2, 2)} km²`} label={`area reached by ${cutoffMinutes} min`} />
      <ResultMetric value={stops === null ? 'Unavailable' : formatNumber(stops)} label={`stops reached by ${cutoffMinutes} min`} detail={stops === null ? 'Update Reach to compute this cutoff.' : undefined} />
      <details className="reach-supporting-metrics"><summary>Network details</summary>
        <ResultMetric value={typeof network?.reachedEdgeLengthKm === 'number' && Number.isFinite(network.reachedEdgeLengthKm) ? `${reachDecimal(network.reachedEdgeLengthKm, 1)} km` : 'Unavailable'} label={`OSM streets · full ${analysis.summary.maximumCutoffMinutes} min window`} />
        <ResultMetric value={`${walkBudgetKm.toFixed(1)} km`} label="final-walk budget" />
      </details>
    </div>
  )
}

export function ReachTransitStatusNotice({
  analysis,
  surface,
  cutoffMinutes,
}: {
  analysis: ReachResult
  surface: 'baseline' | 'scenario'
  cutoffMinutes: number
}) {
  const status: ReachTransitStatus | null | undefined = surface === 'scenario'
    ? analysis.summary.scenarioTransitStatus ?? analysis.summary.transitStatus
    : analysis.summary.transitStatus
  if (!status) return null
  const stops = transitStopsForSelectedCutoff(analysis, surface, cutoffMinutes)
  const fullWindow = analysis.summary.maximumCutoffMinutes
  const fullStops = transitStopsForSelectedCutoff(analysis, surface, fullWindow)
  const earliest = status.earliestScheduledDepartureMinutes
  const timing = typeof earliest === 'number' && Number.isFinite(earliest)
    ? ` First scheduled service is at ${serviceTimeLabel(Number(earliest))}${typeof status.waitMinutes === 'number' && Number.isFinite(status.waitMinutes) ? ` (${Math.round(status.waitMinutes)} min after departure)` : ''}.`
    : ''
  if (status.status === 'reached') {
    const selected = stops === null
      ? `Transit-stop counts are unavailable for the selected ${cutoffMinutes}-minute cutoff. Update Reach to compute this cutoff.`
      : `${formatNumber(stops)} transit ${stops === 1 ? 'stop is' : 'stops are'} reachable within the selected ${cutoffMinutes}-minute cutoff.`
    const laterReach = stops === 0 && fullWindow > cutoffMinutes && fullStops !== null && fullStops > 0
      ? ` Transit reaches ${formatNumber(fullStops)} ${fullStops === 1 ? 'stop' : 'stops'} within the full ${fullWindow}-minute computed window.`
      : ''
    if (stops !== null && stops > 0) return <details className="reach-status-details"><summary>Transit timing</summary><p>{selected}{timing}</p></details>
    return (
      <p className="reach-inline-note" role="status" aria-live="polite">
        {selected}{laterReach}{timing}
      </p>
    )
  }
  if (status.status === 'preliminary') {
    return <p className="reach-inline-note" role="status" aria-live="polite">{status.detail}</p>
  }
  const scope = stops === null
    ? ` Transit-stop counts are unavailable for the selected ${cutoffMinutes}-minute cutoff. Update Reach to compute this cutoff.`
    : ` ${formatNumber(stops)} transit ${stops === 1 ? 'stop is' : 'stops are'} counted within the selected ${cutoffMinutes}-minute cutoff.`
  return (
    <p className="reach-inline-note is-error" role="status" aria-live="polite">
      {status.detail.replace('selected window', `full ${fullWindow}-minute computed window`)}{timing}{scope}
    </p>
  )
}

function interventionSummary(
  intervention: ScenarioChangeDraft,
  routes: RouteMetric[],
) {
  if (intervention.kind === 'add-line') return `${intervention.stops.length} stops`
  const route = routes.find((entry) => (
    entry.id === intervention.routeId || entry.patternId === intervention.routeId
  ))
  return route
    ? `${routeOptionLabel(route)}${intervention.kind === 'change-line' ? ` · ${intervention.stops.length} stops` : ''}`
    : 'Configure'
}

function stopProvenanceLabel(stop: ScenarioStopDraft) {
  const source = stop.stopId ? 'GTFS stop' : 'Placed point'
  if (stop.editStatus === 'inserted') return `${source} · inserted`
  if (stop.editStatus === 'replaced') return `${source} · changed`
  if (stop.editStatus === 'added') return source
  return stop.stopId ? 'GTFS baseline' : source
}

function EditableStopSequence({
  intervention,
  originReady,
  placement,
  onBeginPlacement,
  onCancelPlacement,
  onRemoveStop,
  onClear,
  onReset,
}: {
  intervention: ScenarioChangeDraft
  originReady: boolean
  placement: ScenarioStopPlacement | null
  onBeginPlacement: (mode: ScenarioStopPlacement['mode'], index: number) => void
  onCancelPlacement: () => void
  onRemoveStop: (index: number) => void
  onClear: () => void
  onReset: () => void
}) {
  const [insertAfterIndex, setInsertAfterIndex] = useState<number | null>(null)
  const previousStopCountRef = useRef(intervention.stops.length)
  const stops = intervention.stops
  const safeInsertAfterIndex = insertAfterIndex === null
    ? null
    : Math.min(insertAfterIndex, Math.max(0, stops.length - 2))
  useEffect(() => {
    const previousCount = previousStopCountRef.current
    if (stops.length > previousCount && safeInsertAfterIndex !== null) {
      setInsertAfterIndex(Math.min(safeInsertAfterIndex + 1, Math.max(0, stops.length - 2)))
    }
    if (stops.length < 2) setInsertAfterIndex(null)
    previousStopCountRef.current = stops.length
  }, [safeInsertAfterIndex, stops.length])
  const placementDescription = placement?.mode === 'insert'
    ? `Click a GTFS stop or free map point to insert stop ${placement.index + 1}.`
    : placement?.mode === 'append'
      ? `Click a GTFS stop or free map point to add stop ${placement.index + 1}.`
    : placement?.mode === 'replace'
      ? `Click a GTFS stop or free map point to change stop ${placement.index + 1}.`
      : ''
  const configureDisabled = !originReady
  const emptyDetail = intervention.kind === 'add-line'
    ? originReady ? 'Use Add stop on map, then click the map.' : 'Choose the analysis origin first.'
    : intervention.routeId
      ? 'This route has no editable GTFS stop_times sequence.'
      : 'Choose an existing route to load its GTFS stop sequence.'

  return (
    <div className="reach-stop-editor">
      <div className="reach-sketch-state">
        <span>
          <CircleDot size={14} aria-hidden="true" />
          <strong>{stops.length} ordered stops</strong>
          <small>{stops.length < 2 ? emptyDetail : 'Sequence used by the scenario service.'}</small>
        </span>
        {stops.length ? (
          intervention.kind === 'change-line' ? (
            <button
              type="button"
              className="reach-mini-action"
              onClick={onReset}
            >
              <RotateCcw size={13} aria-hidden="true" /> Reset to GTFS
            </button>
          ) : (
            <button
              type="button"
              className="reach-mini-action"
              onClick={onClear}
            >
              <Eraser size={13} aria-hidden="true" /> Clear
            </button>
          )
        ) : null}
      </div>

      {placement ? (
        <div className="reach-placement-status" role="status" aria-live="polite" aria-atomic="true">
          <MapPin size={14} aria-hidden="true" />
          <span><strong>Map placement active</strong><small>{placementDescription}</small></span>
          <button type="button" onClick={onCancelPlacement} aria-label="Cancel map stop placement" title="Cancel placement">
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <div className="reach-insert-stop">
        <button
          type="button"
          onClick={() => onBeginPlacement('append', stops.length)}
          disabled={configureDisabled || stops.length >= 256}
          aria-pressed={placement?.mode === 'append'}
          title={!originReady ? 'Choose the analysis origin first.' : 'Place a new stop on the map'}
        >
          <MapPin size={14} aria-hidden="true" />
          Add stop on map
        </button>
        {stops.length >= 2 ? (
          <label className="reach-field">
            <span>Insert after</span>
            <select
              value={safeInsertAfterIndex ?? ''}
              onChange={(event) => setInsertAfterIndex(event.currentTarget.value === '' ? null : Number(event.currentTarget.value))}
            >
              <option value="">Choose a gap…</option>
              {stops.slice(0, -1).map((stop, index) => (
                <option key={`${stop.id}-gap`} value={index}>
                  {index + 1} · {stop.label} → {stops[index + 1]?.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {stops.length >= 2 ? (
          <button
            type="button"
            onClick={() => safeInsertAfterIndex !== null && onBeginPlacement('insert', safeInsertAfterIndex + 1)}
            disabled={configureDisabled || stops.length >= 256 || safeInsertAfterIndex === null}
            aria-pressed={safeInsertAfterIndex !== null && placement?.mode === 'insert' && placement.index === safeInsertAfterIndex + 1}
            title={!originReady ? 'Choose the analysis origin first.' : 'Place an intermediate stop on the map'}
          >
            <Plus size={14} aria-hidden="true" />
            Add intermediate stop
          </button>
        ) : null}
      </div>

      {stops.length ? (
        <ol className="reach-stop-sequence" aria-label={`${intervention.name} ordered stop sequence`}>
          {stops.map((stop, index) => (
            <li key={stop.id} className={placement?.mode === 'replace' && placement.index === index ? 'is-placing' : undefined}>
              <span className="reach-stop-index">{index + 1}</span>
              <span className="reach-stop-name">
                <strong>{stop.label}</strong>
                <small>{stopProvenanceLabel(stop)}</small>
              </span>
              <button
                type="button"
                className="reach-stop-change"
                onClick={() => onBeginPlacement('replace', index)}
                disabled={configureDisabled}
                aria-pressed={placement?.mode === 'replace' && placement.index === index}
                aria-label={`Change stop ${index + 1}, ${stop.label}`}
                title={!originReady ? 'Choose the analysis origin first.' : `Change stop ${index + 1}`}
              >
                <Pencil size={13} aria-hidden="true" /> Change
              </button>
              <button
                type="button"
                className="reach-stop-remove"
                onClick={() => onRemoveStop(index)}
                disabled={stops.length <= 2}
                aria-label={`Remove stop ${index + 1}, ${stop.label}`}
                title={stops.length <= 2 ? 'A line requires at least two stops.' : `Remove stop ${index + 1}`}
              >
                <Trash2 size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ol>
      ) : null}

      {stops.length >= 2 ? (
        <p className="reach-stop-method-note">
          Stop order follows GTFS stop_times. Choose an explicit A → B gap before placing an intermediate stop; after insertion the same gap advances so adding several stops stays predictable.
        </p>
      ) : null}
    </div>
  )
}

function interventionDetails(
  intervention: ScenarioChangeDraft,
  routes: RouteMetric[],
) {
  const route = routes.find((entry) => (
    entry.id === intervention.routeId || entry.patternId === intervention.routeId
  ))
  if (intervention.kind === 'remove-line') {
    return route ? `Removes ${routeOptionLabel(route)}` : 'Route removal not configured'
  }
  const editedStops = intervention.stops.filter((stop) => (
    stop.editStatus === 'inserted' || stop.editStatus === 'replaced'
  )).length
  const source = intervention.kind === 'add-line'
    ? 'New modeled line'
    : route
      ? routeOptionLabel(route)
      : 'Route not configured'
  return [
    source,
    `${intervention.stops.length} stops${editedStops ? ` · ${editedStops} edited` : ''}`,
    `${routeScopeLabel(intervention.routeScope)} · ${timeModelLabel(intervention.timeModel)}`,
    `${intervention.headwayMinutes} min headway`,
    `${intervention.averageSpeedKph} km/h average speed`,
    `${serviceTimeLabel(intervention.startMinutes)}–${serviceTimeLabel(intervention.endMinutes)}`,
    intervention.bidirectional && intervention.routeScope !== 'edge' ? 'both directions' : 'one direction',
  ].join(' · ')
}

export function AnalyzePanel({
  mode,
  origin,
  serviceDate,
  departMinutes,
  maxWalkKm,
  walkSpeedKph,
  cutoffMinutes,
  renderMode,
  cases,
  feeds,
  comparisonFeedIds,
  activeCaseId,
  activeInterventionId,
  stopPlacement,
  routes,
  stops,
  routeAnalysisLoading,
  routeAnalysisError,
  view,
  loading,
  progress,
  error,
  analysis,
  routingStoreAvailable,
  streetGraphAvailable,
  preparationTasks,
  streetGraphBuilding,
  routingStoreBuilding,
  comparison,
  serviceDecomposition,
  serviceDecompositionLoading,
  serviceDecompositionError,
  onServiceDateChange,
  onDepartMinutesChange,
  onMaxWalkKmChange,
  onWalkSpeedChange,
  onCutoffChange,
  onRenderModeChange,
  onModeChange,
  onComparisonFeedChange,
  onSelectCase,
  onAddCase,
  onRemoveCase,
  onAddIntervention,
  onSelectIntervention,
  onUpdateIntervention,
  onInferInterventionGeometry,
  onUpdateInterventionRoute,
  onBeginStopPlacement,
  onCancelStopPlacement,
  onRemoveInterventionStop,
  onResetInterventionStops,
  onRemoveIntervention,
  onClearInterventionSketch,
  onViewChange,
  onClearOrigin,
  onSetOrigin,
  onRun,
  onRunComparison,
  onRunServiceDecomposition,
  onOpenData,
  onCancel,
}: AnalyzePanelProps) {
  const [newInterventionKind, setNewInterventionKind] = useState<ScenarioChangeKind>('add-line')
  const [routeQuery, setRouteQuery] = useState('')
  const [scenarioEditorOpen, setScenarioEditorOpen] = useState(false)
  const activeCase = cases.find((entry) => entry.id === activeCaseId) ?? cases[0]
  const interventions = activeCase?.interventions ?? []
  const activeIntervention = interventions.find((entry) => entry.id === activeInterventionId)
    ?? interventions[0]
  const selectedRoute = useMemo(() => routes.find((route) => (
    route.id === activeIntervention?.routeId || route.patternId === activeIntervention?.routeId
  )), [activeIntervention?.routeId, routes])
  const hasScenarioChanges = interventions.length > 0
  useEffect(() => {
    if (hasScenarioChanges) setScenarioEditorOpen(true)
  }, [hasScenarioChanges])
  const improvedPixels = scenarioImprovedPixels(analysis, cutoffMinutes)
  const roadInferencePending = mode === 'single' && interventions.some((intervention) => (
    hasLineSettings(intervention.kind)
    && intervention.geometryMode === 'auto-road'
    && intervention.geometryStatus !== 'ready'
  ))
  const comparisonReady = comparisonFeedIds.length >= 2
    && comparisonFeedIds.every((feedId) => feeds.some((feed) => feed.id === feedId))
  const serviceEdgeSummary = useMemo(() => {
    const counts = { added: 0, maintained: 0, removed: 0 }
    for (const feature of serviceDecomposition?.featureCollection.features ?? []) {
      const indicator = Number(feature.properties?.serviceIndicator)
      if (indicator === 1) counts.added += 1
      else if (indicator === 2) counts.maintained += 1
      else if (indicator === 0) counts.removed += 1
    }
    return counts
  }, [serviceDecomposition])
  const canRun = Boolean(
    origin
    && streetGraphAvailable
    && !loading
    && !routeAnalysisLoading
    && !roadInferencePending
    && (mode === 'compare' ? comparisonReady : routingStoreAvailable),
  )
  const transitSetup = preparationState(mode === 'compare' ? feeds.length >= 2 : routingStoreAvailable,
    preparationTasks, mode === 'compare' ? ['national-gtfs-import'] : ['national-gtfs-import', 'national-gtfs-merge'], routingStoreBuilding)
  const streetSetup = preparationState(streetGraphAvailable, preparationTasks, ['national-osm-import'], streetGraphBuilding)
  const dataPreparing = [transitSetup, streetSetup].some((state) => state.status === 'working')
  const setupHint = !streetGraphAvailable || !(mode === 'compare' ? comparisonReady : routingStoreAvailable)
    ? [transitSetup, streetSetup].some((state) => state.status === 'paused')
      ? 'Task updates are paused. Open background tasks to reconnect.'
      : dataPreparing ? 'Data is being prepared. You can choose the origin while it runs.'
        : mode === 'compare' && feeds.length >= 2 && !comparisonReady ? 'Select at least two GTFS feeds above.'
          : 'Finish the data setup above, then run the analysis.'
    : !origin ? onSetOrigin ? 'Choose an origin below or click the map.' : 'Click the map to choose an origin.'
      : routeAnalysisLoading ? 'Loading the selected route’s timetable…'
        : roadInferencePending ? 'Finish the scenario road trace before running Reach.' : ''
  const routeOptions = useMemo(() => {
    const query = routeQuery.trim().toLocaleLowerCase()
    const matching = routes.filter((route) => (
      !query
      || `${route.id} ${route.routeId ?? ''} ${route.shortName} ${route.longName}`
        .toLocaleLowerCase()
        .includes(query)
    ))
    const groups = new Map<string, RouteMetric[]>()
    for (const route of matching) {
      const key = scopedRouteServiceKey(route)
      groups.set(key, [...(groups.get(key) ?? []), route])
    }
    const representatives = [...groups.values()]
      .map((variants) => [...variants].sort((left, right) => (
        routePatternRank(left) - routePatternRank(right)
        || right.tripCount - left.tripCount
      ))[0])
      .filter((route): route is RouteMetric => Boolean(route))
      .slice(0, 300)
    if (
      selectedRoute
      && !representatives.some((route) => scopedRouteServiceKey(route) === scopedRouteServiceKey(selectedRoute))
    ) return [selectedRoute, ...representatives]
    return representatives
  }, [routeQuery, routes, selectedRoute])
  const branchOptions = useMemo(() => {
    if (!selectedRoute) return []
    return routes
      .filter((route) => scopedRouteServiceKey(route) === scopedRouteServiceKey(selectedRoute))
      .sort((left, right) => (
        routePatternRank(left) - routePatternRank(right)
        || right.tripCount - left.tripCount
        || left.id.localeCompare(right.id)
      ))
  }, [routes, selectedRoute])
  const selectedPublicRouteKey = selectedRoute ? scopedRouteServiceKey(selectedRoute) : ''
  const edgeScopeNote = useMemo(() => {
    if (!selectedRoute || activeIntervention?.routeScope !== 'edge') return ''
    const error = scenarioEdgeEditError(selectedRoute, activeIntervention.stops)
    if (error) return error
    if (branchOptions.length !== selectedRoute.serviceVariantCount || branchOptions.some((branch) => (
      branch.analysisSource !== 'focused' || branch.analysisServiceDate !== serviceDate
    ))) return 'Load the complete GTFS branch list for the selected service date to confirm every affected branch.'
    const edit = scenarioInsertedStopsForEdge(activeIntervention.stops)!
    const occurrences = branchOptions.map((branch) => scenarioEdgeIndexes(branch, edit.beforeStopId, edit.afterStopId).length)
    const matchingCount = occurrences.filter(Boolean).length
    const edgeCount = occurrences.reduce((sum, count) => sum + count, 0)
    return `${matchingCount} of ${branchOptions.length} branches · ${edgeCount} ordered A → B occurrences. Insertions apply at every matching occurrence, following each branch’s GTFS direction.`
  }, [activeIntervention, branchOptions, selectedRoute, serviceDate])

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canRun) return
    if (mode === 'compare') onRunComparison()
    else onRun()
  }

  function changeGeometryMode(intervention: ScenarioChangeDraft, mode: ScenarioGeometryMode) {
    onUpdateIntervention(intervention.id, {
      geometryMode: mode,
      timeModel: mode === 'auto-road'
        ? 'infer-road'
        : mode === 'straight-line'
          ? 'estimate-distance'
          : 'preserve-scheduled',
    })
    // Selecting road inference is an explicit request to trace the edited
    // sequence. Keep the button below as a deliberate rebuild after a stop
    // changes, but do not let the Run action silently fall back to chords.
    if (mode === 'auto-road') onInferInterventionGeometry(intervention.id)
  }

  return (
    <section className="sidebar-section reach-surface" aria-label="Reach analysis controls">
      <form onSubmit={submit}>
        <div className="reach-analysis-switch">
          <div className="studio-tabs reach-mode-tabs" role="group" aria-label="Analyze mode">
            <button
              type="button"
              className={classNames(mode === 'single' && 'is-active')}
              aria-pressed={mode === 'single'}
              onClick={() => onModeChange('single')}
            >
              <span>Reach</span>
            </button>
            <button
              type="button"
              className={classNames(mode === 'compare' && 'is-active')}
              aria-pressed={mode === 'compare'}
              onClick={() => onModeChange('compare')}
            >
              <span>Compare</span>
            </button>
          </div>
        </div>


        {mode === 'compare' ? (
          <div className="reach-comparison-picker">
            <div className="reach-panel-heading">
              <span>
                <strong>Choose feeds</strong>
              </span>
              <span className="reach-selection-count"><Database size={13} aria-hidden="true" /> {comparisonFeedIds.length} selected</span>
            </div>
            {feeds.length >= 2 ? (
              <div className="reach-comparison-feed-list" role="group" aria-label="GTFS feeds to compare">
                {feeds.map((feed, index) => (
                  <label className="reach-comparison-feed-option" key={feed.id}>
                    <input
                      type="checkbox"
                      checked={comparisonFeedIds.includes(feed.id)}
                      onChange={(event) => onComparisonFeedChange(feed.id, event.currentTarget.checked)}
                    />
                    <span>
                      <strong>GTFS {index + 1} · {feed.name}</strong>
                      <small>{formatNumber(feed.routeCount)} routes · {formatNumber(feed.stopCount)} stops · {formatNumber(feed.tripCount)} trips</small>
                    </span>
                  </label>
                ))}
                <small className="reach-comparison-selection-note">
                  Choose at least two feeds. Two feeds also enable street-service comparison.
                </small>
              </div>
            ) : (
              <div className="reach-empty-case">
                <strong>Load at least two indexed GTFS feeds first.</strong>
                <span>Open City, add the GTFS ZIPs you want to compare, then return here.</span>
                <button type="button" onClick={onOpenData}>Open City</button>
              </div>
            )}
          </div>
        ) : null}

        <div className="reach-query-card">
          {origin || !onSetOrigin ? <div className="reach-origin-row">
            <span className="reach-origin-icon"><MapPin size={16} aria-hidden="true" /></span>
            <div>
              <span className="reach-section-kicker">Origin</span>
              <strong>{origin ? origin.label : 'Choose a point on the map'}</strong>
            </div>
            {origin ? (
              <button type="button" className="reach-mini-action" onClick={onClearOrigin}>Clear</button>
            ) : null}
          </div> : null}
          {onSetOrigin ? <AnalysisOriginPicker origin={origin} stops={stops} onSetOrigin={onSetOrigin} disabled={loading} /> : null}

          <div className="reach-query-fields">
            <label className="reach-field">
              <span>Service date</span>
              <input
                type="date"
                value={serviceDate}
                onChange={(event) => onServiceDateChange(event.currentTarget.value)}
              />
            </label>
            <label className="reach-field">
              <span>Departure</span>
              <input
                type="time"
                value={`${String(Math.floor(departMinutes / 60) % 24).padStart(2, '0')}:${String(Math.round(departMinutes) % 60).padStart(2, '0')}`}
                onChange={(event) => {
                  const [hours, minutes] = event.currentTarget.value.split(':').map(Number)
                  onDepartMinutesChange(hours * 60 + minutes)
                }}
              />
            </label>
          </div>
        </div>

        <details className="studio-disclosure reach-advanced">
          <summary>
            <span>Analysis settings</span>
            <b>{cutoffMinutes} min · {maxWalkKm} km final walk</b>
          </summary>
          <div className="reach-field-grid">
            <label className="reach-field">
              <span>Maximum final walk</span>
              <select value={maxWalkKm} onChange={(event) => onMaxWalkKmChange(Number(event.currentTarget.value))}>
                {walkBudgetOptions.map((value) => <option key={value} value={value}>{value} km</option>)}
              </select>
            </label>
            <label className="reach-field">
              <span>Walk speed</span>
              <select value={walkSpeedKph} onChange={(event) => onWalkSpeedChange(Number(event.currentTarget.value))}>
                {walkSpeedOptions.map((value) => <option key={value} value={value}>{value} km/h</option>)}
              </select>
            </label>
            <label className="reach-field">
              <span>Time cutoff</span>
              <select value={cutoffMinutes} onChange={(event) => onCutoffChange(Number(event.currentTarget.value))}>
                {cutoffOptions.map((value) => <option key={value} value={value}>{value} min</option>)}
              </select>
            </label>
          </div>
        </details>

        {mode === 'single' ? (
          <details
            className="studio-disclosure reach-scenario-builder"
            open={scenarioEditorOpen}
            onToggle={(event) => setScenarioEditorOpen(event.currentTarget.open)}
          >
            <summary>
              <span>Scenario</span>
              <b>{hasScenarioChanges ? `${interventions.length} change${interventions.length === 1 ? '' : 's'} · ${activeCase?.name ?? 'Case'}` : 'No changes'}</b>
            </summary>
            <div className="reach-scenario-content">
              <div className="reach-scenario-heading">
                <span>
                  <strong>Service changes</strong>
                </span>
                <button
                  type="button"
                  className="reach-icon-action"
                  onClick={onAddCase}
                  disabled={cases.length >= 6}
                  aria-label="Add comparison case"
                  title="Add case"
                >
                  <Plus size={14} />
                </button>
              </div>

        {mode === 'single' ? <div className="reach-case-tabs" role="group" aria-label="Comparison cases">
          {cases.map((entry, index) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={entry.id === activeCase?.id}
              className={classNames(entry.id === activeCase?.id && 'is-active')}
              onClick={() => onSelectCase(entry.id)}
            >
              Case {String.fromCharCode(65 + index)}
              <small>{entry.interventions.length}</small>
            </button>
          ))}
        </div> : null}

        {mode === 'single' && activeCase && cases.length > 1 ? (
          <button
            type="button"
            className="reach-danger-action"
            onClick={() => onRemoveCase(activeCase.id)}
          >
            <Trash2 size={13} />
            Remove {activeCase.name}
          </button>
        ) : null}

        {mode === 'single' ? <div className="reach-intervention-add">
          <label className="reach-field">
            <span>Add a change</span>
            <select
              value={newInterventionKind}
              onChange={(event) => setNewInterventionKind(event.currentTarget.value as ScenarioChangeKind)}
            >
              {interventionOptions.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => onAddIntervention(newInterventionKind)}
            disabled={interventions.length >= 8}
            title={interventions.length >= 8 ? 'A case can contain at most eight interventions.' : 'Add intervention'}
          >
            <Plus size={14} />
            Add
          </button>
        </div> : null}

        {mode === 'single' && interventions.length ? (
          <div className="reach-intervention-list" role="list" aria-label={`${activeCase?.name} interventions`}>
            {interventions.map((intervention, index) => (
              <article
                key={intervention.id}
                role="listitem"
                className={classNames(
                  'reach-intervention',
                  intervention.id === activeIntervention?.id && 'is-active',
                )}
              >
                <div className="reach-intervention-row">
                  <button
                    type="button"
                    className="reach-intervention-head"
                    onClick={() => onSelectIntervention(intervention.id)}
                    aria-expanded={intervention.id === activeIntervention?.id}
                  >
                    <span>{index + 1}</span>
                    <strong>{interventionLabels[intervention.kind]}</strong>
                    <small>{interventionSummary(intervention, routes)}</small>
                  </button>
                  <button
                    type="button"
                    className="reach-intervention-remove"
                    onClick={() => onRemoveIntervention(intervention.id)}
                    aria-label={`Remove ${intervention.name || interventionLabels[intervention.kind]}`}
                    title="Remove intervention"
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
                {intervention.id === activeIntervention?.id ? (
                  <div className="reach-intervention-body">
                    <label className="reach-field">
                      <span>Intervention name</span>
                      <input
                        type="text"
                        value={intervention.name}
                        maxLength={80}
                        onChange={(event) => onUpdateIntervention(intervention.id, {
                          name: event.currentTarget.value,
                        })}
                      />
                    </label>
                    <label className="reach-field">
                      <span>Change type</span>
                      <select
                        value={intervention.kind}
                        onChange={(event) => onUpdateIntervention(intervention.id, {
                          kind: event.currentTarget.value as ScenarioChangeKind,
                        })}
                      >
                        {interventionOptions.map(([value, label]) => (
                          <option key={value} value={value}>{label}</option>
                        ))}
                      </select>
                    </label>

                    {intervention.kind !== 'add-line' ? (
                      <div className="reach-route-picker">
                        <label className="reach-field">
                          <span>Find route</span>
                          <input
                            type="search"
                            value={routeQuery}
                            placeholder="Name, number, or route ID"
                            onChange={(event) => setRouteQuery(event.currentTarget.value)}
                          />
                        </label>
                        <label className="reach-field">
                          <span>Existing public route</span>
                          <select
                            value={selectedPublicRouteKey}
                            onChange={(event) => {
                              const route = routeOptions.find((candidate) => (
                                scopedRouteServiceKey(candidate) === event.currentTarget.value
                              ))
                              onUpdateInterventionRoute(intervention.id, route?.id ?? '')
                            }}
                          >
                            <option value="">Choose a route</option>
                            {routeOptions.map((route) => (
                              <option key={scopedRouteServiceKey(route)} value={scopedRouteServiceKey(route)}>{routeOptionLabel(route)}</option>
                            ))}
                          </select>
                        </label>
                        <small>{routeOptions.length === 300
                          ? 'Showing the first 300 matches; refine the search to narrow the catalog.'
                          : `${routeOptions.length} matching public routes`}</small>
                        {selectedRoute ? (
                          <label className="reach-field">
                            <span>GTFS branch / pattern</span>
                            <select
                              value={intervention.routeId ?? ''}
                              onChange={(event) => onUpdateInterventionRoute(
                                intervention.id,
                                event.currentTarget.value,
                              )}
                            >
                              <option value="">Choose a branch</option>
                              {branchOptions.map((route) => (
                                <option key={route.id} value={route.id}>{branchOptionLabel(route, stops)}</option>
                              ))}
                            </select>
                          </label>
                        ) : null}
                        <small>
                          {routeAnalysisLoading
                            ? 'Loading all GTFS branches for this public route…'
                            : routeAnalysisError
                              ? routeAnalysisError
                              : selectedRoute && branchOptions.length > 1
                                ? `${branchOptions.length} GTFS branches loaded. Choose the exact stop pattern before editing.`
                                : selectedRoute
                                  ? 'One GTFS branch is currently available for this public route.'
                                  : 'Choose a public route to load its GTFS branches.'}
                        </small>
                      </div>
                    ) : null}

                    {intervention.routeId ? (
                      <>
                        <div className="reach-field-grid">
                          {['change-line', 'remove-line'].includes(intervention.kind) ? (
                            <label className="reach-field">
                              <span>{intervention.kind === 'remove-line' ? 'Remove scope' : 'Apply stop edit to'}</span>
                              <select
                                value={intervention.routeScope ?? 'pattern'}
                                onChange={(event) => onUpdateIntervention(intervention.id, {
                                  routeScope: event.currentTarget.value as ScenarioRouteScope,
                                })}
                              >
                                <option value="pattern">Selected branch only</option>
                                {intervention.kind === 'change-line' ? (
                                  <option value="edge">All branches serving this exact A → B edge</option>
                                ) : null}
                                {intervention.kind === 'remove-line' ? (
                                  <option value="route">All branches of this route</option>
                                ) : null}
                              </select>
                            </label>
                          ) : null}
                          {['change-line', 'enhance-line'].includes(intervention.kind) ? (
                            <label className="reach-field">
                              <span>Path + timing</span>
                              <select
                                value={intervention.geometryMode
                                  ?? (intervention.timeModel === 'infer-road'
                                    ? 'auto-road'
                                    : intervention.timeModel === 'estimate-distance'
                                      ? 'straight-line'
                                      : 'published-shape')}
                                onChange={(event) => changeGeometryMode(
                                  intervention,
                                  event.currentTarget.value as ScenarioGeometryMode,
                                )}
                              >
                                <option value="published-shape">Published shape + segment times</option>
                                <option value="auto-road">Hybrid: GTFS shape + OSM roads</option>
                                <option value="straight-line">Straight-line estimate</option>
                              </select>
                            </label>
                          ) : null}
                        </div>
                        <small className="reach-scope-note">
                          {intervention.kind === 'change-line'
                            ? intervention.routeScope === 'edge'
                              ? edgeScopeNote
                              : 'This edit applies to the selected GTFS branch only. Other branches keep their published timetable.'
                            : intervention.kind === 'remove-line' && intervention.routeScope === 'route'
                              ? 'Removes every branch of this public route.'
                              : intervention.kind === 'remove-line'
                                ? 'Removes only the selected GTFS branch.'
                                : geometryModeLabel(intervention.geometryMode, intervention.kind)}
                        </small>
                      </>
                    ) : null}

                    {hasLineSettings(intervention.kind) ? (
                      <div className="reach-road-inference">
                        {intervention.kind === 'add-line' ? (
                          <label className="reach-field">
                            <span>Path + timing</span>
                            <select
                              value={intervention.geometryMode ?? 'auto-road'}
                              onChange={(event) => changeGeometryMode(
                                intervention,
                                event.currentTarget.value as ScenarioGeometryMode,
                              )}
                            >
                              <option value="auto-road">OSM road path</option>
                              <option value="straight-line">Straight-line estimate</option>
                            </select>
                          </label>
                        ) : null}
                        <div>
                          <strong>{geometryModeLabel(intervention.geometryMode, intervention.kind)}</strong>
                          <small>
                            {intervention.geometryMode === 'auto-road'
                              ? intervention.kind === 'add-line'
                                ? 'Trace the new line through its ordered stops on the local OSM road network. Estimate travel time using the configured average speed and stop dwell.'
                                : 'Keep untouched GTFS shapes. Trace only edited gaps on the local OSM road graph, keep the original A → B runtime, and add dwell at inserted stops. If OSM cannot connect a gap, use its published shape segment.'
                              : intervention.geometryMode === 'straight-line'
                                ? 'Use direct stop-to-stop geometry and the configured average speed.'
                                : 'Keep the published GTFS shape and published segment timing unless you choose another path mode.'}
                          </small>
                        </div>
                        {intervention.geometryMode === 'auto-road' ? (
                          <>
                            <button
                              type="button"
                              className="reach-mini-action"
                              onClick={() => onInferInterventionGeometry(intervention.id)}
                              disabled={intervention.geometryStatus === 'loading' || intervention.stops.length < 2}
                            >
                              {intervention.geometryStatus === 'loading' ? <LoaderCircle size={13} /> : <Route size={13} />}
                              {intervention.geometryStatus === 'loading' ? 'Tracing roads…' : 'Build road-following path'}
                            </button>
                            {intervention.geometryStatus === 'ready' ? (
                              <small className="reach-road-status is-ready">
                                {(intervention.inferredSegmentDistanceKm?.reduce((sum, distance) => sum + distance, 0) ?? 0).toFixed(2)} km across {intervention.inferredSegmentDistanceKm?.length ?? 0} segments
                                {(intervention.inferredFallbackSegmentCount ?? 0) > 0
                                  ? ` · ${intervention.inferredFallbackSegmentCount} shape fallback${intervention.inferredFallbackSegmentCount === 1 ? '' : 's'}`
                                  : ''}
                                {(intervention.inferredPublishedShapeSegmentCount ?? 0) > 0
                                  ? ` · ${intervention.inferredPublishedShapeSegmentCount} GTFS shape segment${intervention.inferredPublishedShapeSegmentCount === 1 ? '' : 's'}`
                                  : ''}
                                {(intervention.inferredOsmSegmentCount ?? 0) > 0
                                  ? ` · ${intervention.inferredOsmSegmentCount} OSM segment${intervention.inferredOsmSegmentCount === 1 ? '' : 's'}`
                                  : ''}
                              </small>
                            ) : null}
                            {intervention.geometryError ? <small className="reach-road-status is-error">{intervention.geometryError}</small> : null}
                          </>
                        ) : null}
                      </div>
                    ) : null}

                    {['add-line', 'change-line'].includes(intervention.kind) ? (
                      <EditableStopSequence
                        key={intervention.id}
                        intervention={intervention}
                        originReady={Boolean(origin)}
                        placement={stopPlacement?.interventionId === intervention.id ? stopPlacement : null}
                        onBeginPlacement={(mode, stopIndex) => onBeginStopPlacement(
                          intervention.id,
                          mode,
                          stopIndex,
                        )}
                        onCancelPlacement={onCancelStopPlacement}
                        onRemoveStop={(stopIndex) => onRemoveInterventionStop(intervention.id, stopIndex)}
                        onClear={() => onClearInterventionSketch(intervention.id)}
                        onReset={() => onResetInterventionStops(intervention.id)}
                      />
                    ) : null}

                    {hasLineSettings(intervention.kind) ? (
                      <>
                        <div className="reach-field-grid">
                          <label className="reach-field">
                            <span>Headway</span>
                            <select
                              value={intervention.headwayMinutes}
                              onChange={(event) => onUpdateIntervention(intervention.id, {
                                headwayMinutes: Number(event.currentTarget.value),
                              })}
                            >
                              {lineHeadwayOptions.map((value) => <option key={value} value={value}>{value} min</option>)}
                            </select>
                          </label>
                          <label className="reach-field">
                            <span>Average speed</span>
                            <select
                              value={intervention.averageSpeedKph}
                              onChange={(event) => onUpdateIntervention(intervention.id, {
                                averageSpeedKph: Number(event.currentTarget.value),
                              })}
                            >
                              {lineSpeedOptions.map((value) => <option key={value} value={value}>{value} km/h</option>)}
                            </select>
                          </label>
                        </div>
                        <div className="reach-field-grid">
                          <label className="reach-field">
                            <span>Service begins</span>
                            <select
                              value={intervention.startMinutes}
                              onChange={(event) => onUpdateIntervention(intervention.id, {
                                startMinutes: Number(event.currentTarget.value),
                              })}
                            >
                              {serviceStartOptions.map((value) => (
                                <option key={value} value={value}>{serviceTimeLabel(value)}</option>
                              ))}
                            </select>
                          </label>
                          <label className="reach-field">
                            <span>Service ends</span>
                            <select
                              value={intervention.endMinutes}
                              onChange={(event) => onUpdateIntervention(intervention.id, {
                                endMinutes: Number(event.currentTarget.value),
                              })}
                            >
                              {serviceEndOptions.map((value) => (
                                <option key={value} value={value}>{serviceTimeLabel(value)}</option>
                              ))}
                            </select>
                          </label>
                        </div>
                        <label className="reach-check">
                          <input
                            type="checkbox"
                            checked={intervention.routeScope === 'edge' ? false : intervention.bidirectional}
                            disabled={intervention.routeScope === 'edge'}
                            onChange={(event) => onUpdateIntervention(intervention.id, {
                              bidirectional: event.currentTarget.checked,
                            })}
                          />
                          <span><strong>{intervention.kind === 'add-line' ? 'Bidirectional' : 'Add reverse service'}</strong><small>{intervention.routeScope === 'edge'
                            ? 'Each matching branch follows its published stop order.'
                            : intervention.kind === 'add-line'
                              ? 'Operate the modeled line in both directions.'
                              : 'Also model a reversed copy of this branch. Its reverse is not inferred from GTFS.'}</small></span>
                        </label>
                      </>
                    ) : null}

                  </div>
                ) : null}
              </article>
            ))}
          </div>
        ) : mode === 'single' ? (
          <p className="reach-empty-case">
            This case uses the baseline network.
          </p>
        ) : null}

            </div>
          </details>
        ) : null}

        <div className="reach-run-block">
          <button
            type={loading ? 'button' : 'submit'}
            className="reach-run"
            disabled={!loading && !canRun}
            onClick={loading ? onCancel : undefined}
          >
            {loading ? <LoaderCircle size={15} /> : <Radar size={15} />}
            {loading
              ? 'Cancel analysis'
              : mode === 'compare'
                ? comparison ? 'Refresh comparison' : 'Compare City versions'
                : analysis ? 'Update Reach' : 'Run Reach'}
          </button>
          {loading || !canRun ? (
            <small className="reach-run-hint">
              {loading ? 'Computing the complete reached-street surface…' : setupHint}
            </small>
          ) : null}
          {loading && progress ? (
            <div className="reach-analysis-progress" aria-live="polite">
              <span>
                <strong>{progress.phase}</strong>
                <b>{Math.round(progress.progress * 100)}%</b>
              </span>
              <progress max={1} value={progress.progress} aria-label={`${progress.phase} progress`} />
              {progress.detail ? <small>{progress.detail}</small> : null}
            </div>
          ) : null}
        </div>

        {roadInferencePending && streetGraphAvailable ? <p className="reach-inline-note">Road inference is still building. Finish the road trace before running the analysis.</p> : null}
        {error ? <p className="reach-inline-note is-error" role="alert">{error}</p> : null}
      </form>

      {mode === 'compare' && comparison && comparison.length >= 2 ? (
        <section className="reach-results" aria-label="GTFS comparison results">
          <div className="reach-results-heading">
            <div>
              <strong>City comparison</strong>
              <small>Same origin and departure · independent timetables</small>
            </div>
          </div>
          <ReachRenderModePicker renderMode={renderMode} onRenderModeChange={onRenderModeChange} terminalWalkKm={maxWalkKm} />
          <div className="reach-comparison-result-head">
            <div>
              <strong>Selected feeds</strong>
              <small>Colors on the map match the rows below.</small>
            </div>
            <span>OSM walking</span>
          </div>
          <div className="reach-comparison-result-list">
            {comparison.map((entry, index) => {
              const pixels = scenarioReachablePixels(entry.result, 'baseline', cutoffMinutes)
              const areaKm2 = scenarioReachedAreaKm2(entry.result, 'baseline', cutoffMinutes)
              const stops = transitStopsForSelectedCutoff(entry.result, 'baseline', cutoffMinutes)
              const networkKm = entry.result.diagnostics.raster.baselineNetwork?.reachedEdgeLengthKm
              const color = reachComparisonColor(index)
              const feed = feeds.find((candidate) => candidate.id === entry.feedId)
              return (
                <article key={entry.feedId} className="reach-comparison-result">
                  <span className="reach-comparison-swatch" style={{ background: color }} aria-hidden="true" />
                  <div>
                    <strong>GTFS {index + 1} · {entry.feedName}</strong>
                    <small>{formatNumber(feed?.routeCount ?? 0)} routes · {formatNumber(feed?.stopCount ?? 0)} stops · {formatNumber(feed?.tripCount ?? 0)} trips · {stops === null ? 'Update Reach for this cutoff' : `${formatNumber(stops)} stops reached by ${cutoffMinutes} min`}</small>
                  </div>
                  <b>{areaKm2.toFixed(2)} km²</b>
                  <small>{typeof networkKm === 'number' && Number.isFinite(networkKm) ? `${reachDecimal(networkKm, 1)} km OSM streets · full ${entry.result.summary.maximumCutoffMinutes} min window` : 'Street length unavailable'} · {formatNumber(pixels)} cells</small>
                </article>
              )
            })}
          </div>
          {comparisonFeedIds.length === 2 ? (
            <div className="reach-service-edges">
              <div>
                <strong>Street service change</strong>
                <small>Compare GTFS shapes on the local OSM driving graph; route IDs are not used for alignment.</small>
              </div>
              <div className="reach-service-edge-legend" aria-label="Street service edge legend">
                <span><i style={{ background: '#35d0a1' }} />Added</span>
                <span><i style={{ background: '#6da8ff' }} />Maintained</span>
                <span><i style={{ background: '#ff6757' }} />Removed</span>
              </div>
              <button
                type="button"
                className="reach-run"
                disabled={serviceDecompositionLoading || !streetGraphAvailable}
                onClick={onRunServiceDecomposition}
              >
                {serviceDecompositionLoading ? <LoaderCircle size={14} /> : <Route size={14} />}
                {serviceDecompositionLoading ? 'Mapping service edges…' : serviceDecomposition ? 'Refresh street service map' : 'Map street service change'}
              </button>
              {serviceDecomposition ? (
                <small className="reach-service-edge-summary">
                  {formatNumber(serviceEdgeSummary.added)} added · {formatNumber(serviceEdgeSummary.maintained)} maintained · {formatNumber(serviceEdgeSummary.removed)} removed · unmatched/partial patterns excluded
                </small>
              ) : null}
              {serviceDecompositionError ? <p className="reach-inline-note is-error" role="alert">{serviceDecompositionError}</p> : null}
            </div>
          ) : null}
          <details className="reach-method-record">
            <summary>Comparison method and limits</summary>
            <dl>
              <div><dt>Snapshot</dt><dd>{comparison[0].result.request.serviceDate} · {serviceTimeLabel(comparison[0].result.request.departMinutes)} · one origin</dd></div>
              <div><dt>Measure</dt><dd>Reachable raster cells within {cutoffMinutes} total elapsed minutes; final walking consumes remaining time and is capped at {comparison[0].result.surface.reachability?.baselineTerminalWalkKm ?? comparison[0].result.request.maxWalkKm} km; not people or opportunities</dd></div>
              <div><dt>Access</dt><dd>{comparison[0].result.request.maxWalkKm} km at {comparison[0].result.request.walkSpeedKph ?? walkSpeedKph} km/h · OSM pedestrian network</dd></div>
              <div><dt>Surface</dt><dd>Complete reached-street vector extent · no rectangular map crop</dd></div>
            </dl>
            <ul>
              {Array.from(new Map(comparison.flatMap((entry) => entry.result.limitations.map((limitation) => [limitation.code, limitation]))).values()).map((limitation) => <li key={limitation.code}>{limitation.detail}</li>)}
            </ul>
          </details>
        </section>
      ) : null}

      {mode === 'single' && analysis ? (
        <section className="reach-results" aria-label="Modeled network reach comparison results">
          <div className="reach-results-heading">
            <div>
              <strong>{view === 'baseline' ? 'Baseline reach' : view === 'scenario' ? 'Scenario reach' : 'Travel-time change'}</strong>
              <small>{analysis.request.serviceDate} · {serviceTimeLabel(analysis.request.departMinutes)}</small>
            </div>
          </div>
          <div className="reach-result-toolbar">
            <ReachRenderModePicker renderMode={renderMode} onRenderModeChange={onRenderModeChange} terminalWalkKm={analysis.surface.reachability?.baselineTerminalWalkKm ?? analysis.request.maxWalkKm} />
            {hasScenarioChanges ? <div className="reach-result-view">
              <div className="reach-render-mode-head">
                <div>
                  <strong>Network view</strong>
                </div>
              </div>
              <div className="studio-tabs reach-segmented is-view" role="group" aria-label="Network comparison view">
                {scenarioViewOptions.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={classNames(view === value && 'is-active')}
                    onClick={() => onViewChange(value)}
                    aria-pressed={view === value}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div> : null}
          </div>
          <ReachSurfaceLegend
            view={view}
            cutoffMinutes={cutoffMinutes}
            terminalWalkKm={view === 'scenario'
              ? analysis.surface.reachability?.scenarioTerminalWalkKm ?? analysis.request.maxWalkKm
              : analysis.surface.reachability?.baselineTerminalWalkKm ?? analysis.request.maxWalkKm}
          />
          <ReachMetricCards
            analysis={analysis}
            surface={view === 'scenario' ? 'scenario' : 'baseline'}
            cutoffMinutes={cutoffMinutes}
            walkBudgetKm={view === 'scenario'
              ? analysis.surface.reachability?.scenarioTerminalWalkKm ?? analysis.request.maxWalkKm
              : analysis.surface.reachability?.baselineTerminalWalkKm ?? analysis.request.maxWalkKm}
          />
          <ReachTransitStatusNotice
            analysis={analysis}
            surface={view === 'scenario' ? 'scenario' : 'baseline'}
            cutoffMinutes={cutoffMinutes}
          />
          {hasScenarioChanges ? <div className="reach-result-flow">
            <span><b>{scenarioReachedAreaKm2(analysis, 'baseline', cutoffMinutes).toFixed(2)} km²</b><small>baseline area</small></span>
            <ArrowRight size={16} aria-hidden="true" />
            <span><b>{scenarioReachedAreaKm2(analysis, 'scenario', cutoffMinutes).toFixed(2)} km²</b><small>scenario area</small></span>
            <span className="is-gain"><b>+{formatNumber(improvedPixels)}</b><small>faster or newly reached</small></span>
          </div> : null}
          <details className="reach-method-record">
            <summary>Method and limits</summary>
            <dl>
              <div><dt>Snapshot</dt><dd>{analysis.request.serviceDate} · {serviceTimeLabel(analysis.request.departMinutes)} · one origin</dd></div>
              <div><dt>Measure</dt><dd>Reachable raster cells within {cutoffMinutes} total elapsed minutes; final walking consumes remaining time and is capped at {analysis.surface.reachability?.baselineTerminalWalkKm ?? analysis.request.maxWalkKm} km; not people or opportunities</dd></div>
              <div><dt>Method</dt><dd>Total elapsed OSM access walk + transit + terminal walk; directed OSM network with area and reached-street renderings</dd></div>
              <div><dt>Access</dt><dd>{analysis.request.maxWalkKm} km at {analysis.request.walkSpeedKph ?? walkSpeedKph} km/h · OSM pedestrian network</dd></div>
              <div><dt>Surface</dt><dd>Complete reached-street vector extent · no rectangular map crop</dd></div>
            </dl>
            {activeCase?.interventions.length ? (
              <ol className="reach-method-interventions" aria-label="Modeled scenario assumptions">
                {activeCase.interventions.map((intervention) => (
                  <li key={intervention.id}>
                    <strong>{intervention.name || interventionLabels[intervention.kind]}</strong>
                    <small>{interventionDetails(intervention, routes)}</small>
                  </li>
                ))}
              </ol>
            ) : null}
            {activeCase?.interventions.some((intervention) => hasLineSettings(intervention.kind)) ? (
              <p className="reach-method-caveat">
                Scenario departures use the chosen headway and service window. Published paths use median GTFS segment times; road edits distribute those times and add 0.35 minutes at inserted stops. Distance estimates use the chosen speed and stop dwell. These are modeled services, not the original trip timetable or observed operations.
              </p>
            ) : null}
            <ul>
              {analysis.limitations.map((limitation) => <li key={limitation.code}>{limitation.detail}</li>)}
            </ul>
          </details>
        </section>
      ) : null}
    </section>
  )
}
