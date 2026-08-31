import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  CheckCircle2,
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
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react'
import type { ApiProgress } from '../app/api'
import { classNames, formatNumber, type RouteMetric } from '../domain'
import { scopedRouteServiceKey } from '../routeServices'
import type { RoutingPoint } from '../routingModel'
import { ResultMetric } from './UiPrimitives'
import {
  accessibilityDifferenceCapMinutes,
  accessibilityDifferenceGradient,
  accessibilityTimeGradient,
  scenarioAccessibleAreaKm2,
  scenarioComparisonColor,
  scenarioImprovedPixels,
  scenarioReachablePixels,
  scenarioTransitStopsAtCutoff,
  type AccessibilityTransitStatus,
  type AccessibilityCaseDraft,
  type AccessibilityInterventionDraft,
  type AccessibilityInterventionKind,
  type ScenarioGeometryMode,
  type ScenarioAnalysisResult,
  type ScenarioComparisonResult,
  type ScenarioRouteScope,
  type ScenarioRenderMode,
  type ScenarioStopDraft,
  type ScenarioStopPlacement,
  type ScenarioTimeModel,
  type ScenarioView,
  type ServiceEdgeDecomposition,
} from '../scenarioAnalysis'

export type AccessibilityMode = 'single' | 'compare'

export type AccessibilityFeedOption = {
  id: string
  name: string
  routeCount: number
  stopCount: number
  tripCount: number
}

type AccessibilityWorkspacePanelProps = {
  mode: AccessibilityMode
  origin: RoutingPoint | null
  serviceDate: string
  departMinutes: number
  maxWalkKm: number
  walkSpeedKph: number
  cutoffMinutes: number
  renderMode: ScenarioRenderMode
  cases: AccessibilityCaseDraft[]
  feeds: AccessibilityFeedOption[]
  comparisonFeedIds: string[]
  activeCaseId: string
  activeInterventionId: string
  stopPlacement: ScenarioStopPlacement | null
  routes: RouteMetric[]
  routeAnalysisLoading: boolean
  routeAnalysisError: string
  view: ScenarioView
  loading: boolean
  progress: ApiProgress | null
  error: string
  analysis: ScenarioAnalysisResult | null
  comparison: ScenarioComparisonResult[] | null
  serviceDecomposition: ServiceEdgeDecomposition | null
  serviceDecompositionLoading: boolean
  serviceDecompositionError: string
  routingStoreAvailable: boolean
  streetGraphAvailable: boolean
  onServiceDateChange: (value: string) => void
  onDepartMinutesChange: (value: number) => void
  onMaxWalkKmChange: (value: number) => void
  onWalkSpeedChange: (value: number) => void
  onCutoffChange: (value: number) => void
  onRenderModeChange: (mode: ScenarioRenderMode) => void
  onModeChange: (mode: AccessibilityMode) => void
  onComparisonFeedChange: (feedId: string, selected: boolean) => void
  onSelectCase: (caseId: string) => void
  onAddCase: () => void
  onRemoveCase: (caseId: string) => void
  onAddIntervention: (kind: AccessibilityInterventionKind) => void
  onSelectIntervention: (interventionId: string) => void
  onUpdateIntervention: (
    interventionId: string,
    patch: Partial<AccessibilityInterventionDraft>,
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
  ['policy', 'Policy'],
] as const satisfies ReadonlyArray<readonly [AccessibilityInterventionKind, string]>
const interventionLabels = Object.fromEntries(interventionOptions)
const walkBudgetOptions = [0.4, 0.6, 0.8, 1.2, 1.6, 2, 3, 4, 5] as const
const walkSpeedOptions = [3, 3.6, 4.2, 4.8, 5.4, 6] as const
const cutoffOptions = [10, 15, 20, 30, 45, 60, 75, 90, 120] as const
const lineHeadwayOptions = [4, 5, 8, 10, 12, 15, 20, 30, 60] as const
const lineSpeedOptions = [12, 15, 20, 25, 30, 40, 60, 80] as const
const serviceStartOptions = [0, 300, 360, 420, 480, 540, 600, 720] as const
const serviceEndOptions = [1080, 1200, 1320, 1440, 1500, 1560, 1680] as const
const scenarioViewOptions = [
  ['baseline', 'Current network'],
  ['scenario', 'Scenario'],
  ['comparison', 'Time difference'],
] as const satisfies ReadonlyArray<readonly [ScenarioView, string]>

function routeOptionLabel(route: RouteMetric) {
  return `${route.shortName} · ${route.longName || `${route.stopCount} stops`}`
}

function branchOptionLabel(route: RouteMetric) {
  const direction = route.directionId === undefined || route.directionId === ''
    ? 'Primary'
    : `Direction ${route.directionId}`
  const pattern = route.serviceVariantCount && route.serviceVariantCount > 1
    ? `Pattern ${route.patternRank ?? '?'}`
    : 'Published pattern'
  return `${pattern} · ${direction} · ${route.stopCount} stops · ${formatNumber(route.tripCount)} trips`
}

function routePatternRank(route: RouteMetric) {
  return route.patternRank ?? Number.MAX_SAFE_INTEGER
}

function hasLineSettings(kind: AccessibilityInterventionKind) {
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

function geometryModeLabel(mode: ScenarioGeometryMode | undefined) {
  if (mode === 'auto-road') return 'GTFS shape + OSM road path'
  if (mode === 'straight-line') return 'Straight-line path + speed'
  return 'Published shape + timetable'
}

function serviceTimeLabel(minutes: number) {
  const day = Math.floor(minutes / (24 * 60))
  const normalized = minutes % (24 * 60)
  const hours = Math.floor(normalized / 60)
  const minute = normalized % 60
  return `${String(hours).padStart(2, '0')}:${String(minute).padStart(2, '0')}${day ? ` +${day}d` : ''}`
}

function AccessibilitySurfaceLegend({
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
      className={classNames('accessibility-surface-legend', difference && 'is-difference')}
      role="group"
      aria-label={difference ? 'Time difference legend' : `${view === 'baseline' ? 'Current network' : 'Scenario'} travel time legend`}
    >
      <div className="accessibility-surface-legend-head">
        <strong>{difference ? 'Time difference' : view === 'baseline' ? 'Current network' : 'Scenario'}</strong>
        <small>{difference ? 'Green is faster · red is slower' : `Total elapsed time · final walk uses remaining time, up to ${terminalWalkKm} km`}</small>
      </div>
      <div
        className="accessibility-surface-legend-bar"
        style={{ background: difference ? accessibilityDifferenceGradient : accessibilityTimeGradient }}
        aria-hidden="true"
      />
      <div className="accessibility-surface-legend-scale">
        {difference ? (
          <><span>{accessibilityDifferenceCapMinutes}+ min slower</span><span>same</span><span>{accessibilityDifferenceCapMinutes}+ min faster</span></>
        ) : (
          <><span>0 min</span><span>{Math.round(cutoffMinutes / 2)} min</span><span>{cutoffMinutes} min</span></>
        )}
      </div>
    </div>
  )
}

function AccessibilityRenderModePicker({
  renderMode,
  onRenderModeChange,
  terminalWalkKm,
}: {
  renderMode: ScenarioRenderMode
  onRenderModeChange: (mode: ScenarioRenderMode) => void
  terminalWalkKm: number
}) {
  return (
    <div className="accessibility-render-mode">
      <div className="accessibility-render-mode-head">
        <div>
          <span className="accessibility-section-kicker">Map layer</span>
          <strong>{renderMode === 'area' ? 'Accessible area' : 'Street paths'}</strong>
        </div>
        <small>Show area or OSM streets reached within the total time cutoff. Final walking consumes remaining time and is capped at {terminalWalkKm} km.</small>
      </div>
      <div className="accessibility-segmented is-render-mode" role="group" aria-label="Accessibility map rendering">
        <button
          type="button"
          className={classNames(renderMode === 'area' && 'is-active')}
          aria-pressed={renderMode === 'area'}
          onClick={() => onRenderModeChange('area')}
        >
          Accessible area
        </button>
        <button
          type="button"
          className={classNames(renderMode === 'streets' && 'is-active')}
          aria-pressed={renderMode === 'streets'}
          onClick={() => onRenderModeChange('streets')}
        >
          Street paths
        </button>
      </div>
    </div>
  )
}

function AccessibilityMetricCards({
  analysis,
  surface,
  cutoffMinutes,
  walkBudgetKm,
}: {
  analysis: ScenarioAnalysisResult
  surface: 'baseline' | 'scenario'
  cutoffMinutes: number
  walkBudgetKm: number
}) {
  const areaKm2 = scenarioAccessibleAreaKm2(analysis, surface, cutoffMinutes)
  const stops = scenarioTransitStopsAtCutoff(analysis, surface, cutoffMinutes)
  const network = surface === 'scenario'
    ? analysis.diagnostics.raster.scenarioNetwork
    : analysis.diagnostics.raster.baselineNetwork
  return (
    <div className="accessibility-metric-grid" aria-label={`${surface === 'baseline' ? 'Current network' : 'Scenario'} real-world accessibility metrics`}>
      <ResultMetric value={`${areaKm2.toFixed(2)} km²`} label="reachable area" />
      <ResultMetric value={`${(network?.reachedEdgeLengthKm ?? 0).toFixed(1)} km`} label="OSM street network reached" />
      <ResultMetric value={formatNumber(stops)} label={`stops reached by ${cutoffMinutes} min`} />
      <ResultMetric value={`${walkBudgetKm.toFixed(1)} km`} label="final-walk budget" />
    </div>
  )
}

function AccessibilityTransitStatusNotice({
  analysis,
  surface,
}: {
  analysis: ScenarioAnalysisResult
  surface: 'baseline' | 'scenario'
}) {
  const status: AccessibilityTransitStatus | null | undefined = surface === 'scenario'
    ? analysis.summary.scenarioTransitStatus ?? analysis.summary.transitStatus
    : analysis.summary.transitStatus
  if (!status) return null
  const earliest = status.earliestScheduledDepartureMinutes
  const timing = typeof earliest === 'number' && Number.isFinite(earliest)
    ? ` First scheduled service is at ${serviceTimeLabel(Number(earliest))}${typeof status.waitMinutes === 'number' && Number.isFinite(status.waitMinutes) ? ` (${Math.round(status.waitMinutes)} min after departure)` : ''}.`
    : ''
  if (status.status === 'reached') {
    return (
      <p className="accessibility-inline-note" role="status" aria-live="polite">
        {status.detail}{timing}
      </p>
    )
  }
  if (status.status === 'preliminary') {
    return <p className="accessibility-inline-note" role="status" aria-live="polite">{status.detail}</p>
  }
  const window = status.windowEndMinutes !== undefined && status.requestedDepartureMinutes !== undefined
    ? `${Math.round(status.windowEndMinutes - status.requestedDepartureMinutes)}-minute`
    : 'selected'
  return (
    <p className="accessibility-inline-note is-error" role="status" aria-live="polite">
      {status.detail}{timing} No transit stop is counted for this exact date, departure, and {window} window; the map retains only the origin walking context.
    </p>
  )
}

function interventionSummary(
  intervention: AccessibilityInterventionDraft,
  routes: RouteMetric[],
) {
  if (intervention.kind === 'add-line') return `${intervention.stops.length} stops`
  if (intervention.kind === 'policy') {
    return `${intervention.maxWalkKm ?? 'base'} km · ${intervention.walkSpeedKph ?? 'base'} km/h`
  }
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
  intervention: AccessibilityInterventionDraft
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
    <div className="accessibility-stop-editor">
      <div className="accessibility-sketch-state">
        <span>
          <CircleDot size={14} aria-hidden="true" />
          <strong>{stops.length} ordered stops</strong>
          <small>{stops.length < 2 ? emptyDetail : 'Sequence used by the scenario service.'}</small>
        </span>
        {stops.length ? (
          intervention.kind === 'change-line' ? (
            <button
              type="button"
              className="accessibility-mini-action"
              onClick={onReset}
            >
              <RotateCcw size={13} aria-hidden="true" /> Reset to GTFS
            </button>
          ) : (
            <button
              type="button"
              className="accessibility-mini-action"
              onClick={onClear}
            >
              <Eraser size={13} aria-hidden="true" /> Clear
            </button>
          )
        ) : null}
      </div>

      {placement ? (
        <div className="accessibility-placement-status" role="status" aria-live="polite" aria-atomic="true">
          <MapPin size={14} aria-hidden="true" />
          <span><strong>Map placement active</strong><small>{placementDescription}</small></span>
          <button type="button" onClick={onCancelPlacement} aria-label="Cancel map stop placement" title="Cancel placement">
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <div className="accessibility-insert-stop">
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
          <label className="accessibility-field">
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
        <ol className="accessibility-stop-sequence" aria-label={`${intervention.name} ordered stop sequence`}>
          {stops.map((stop, index) => (
            <li key={stop.id} className={placement?.mode === 'replace' && placement.index === index ? 'is-placing' : undefined}>
              <span className="accessibility-stop-index">{index + 1}</span>
              <span className="accessibility-stop-name">
                <strong>{stop.label}</strong>
                <small>{stopProvenanceLabel(stop)}</small>
              </span>
              <button
                type="button"
                className="accessibility-stop-change"
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
                className="accessibility-stop-remove"
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
        <p className="accessibility-stop-method-note">
          Stop order follows GTFS stop_times. Choose an explicit A → B gap before placing an intermediate stop; after insertion the same gap advances so adding several stops stays predictable.
        </p>
      ) : null}
    </div>
  )
}

function interventionEvidenceDetail(
  intervention: AccessibilityInterventionDraft,
  routes: RouteMetric[],
) {
  if (intervention.kind === 'policy') {
    return `${intervention.maxWalkKm ?? 'baseline'} km walk budget · ${intervention.walkSpeedKph ?? 'baseline'} km/h walk speed`
  }
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
    intervention.bidirectional ? 'both directions' : 'one direction',
  ].join(' · ')
}

export function AccessibilityWorkspacePanel({
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
  routeAnalysisLoading,
  routeAnalysisError,
  view,
  loading,
  progress,
  error,
  analysis,
  routingStoreAvailable,
  streetGraphAvailable,
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
  onRun,
  onRunComparison,
  onRunServiceDecomposition,
  onOpenData,
  onCancel,
}: AccessibilityWorkspacePanelProps) {
  const [newInterventionKind, setNewInterventionKind] = useState<AccessibilityInterventionKind>('add-line')
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

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canRun) return
    if (mode === 'compare') onRunComparison()
    else onRun()
  }

  function changeGeometryMode(intervention: AccessibilityInterventionDraft, mode: ScenarioGeometryMode) {
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
    <section className="sidebar-section accessibility-workspace" aria-label="Accessibility analysis controls">
      <form onSubmit={submit}>
        <div className="accessibility-analysis-switch">
          <div>
            <span className="accessibility-section-kicker">Analysis source</span>
            <strong>What should the map compare?</strong>
          </div>
          <div className="accessibility-mode-tabs" role="group" aria-label="Accessibility analysis mode">
            <button
              type="button"
              className={classNames(mode === 'single' && 'is-active')}
              aria-pressed={mode === 'single'}
              onClick={() => onModeChange('single')}
            >
              <span>Single feed</span>
              <small>Current + scenario</small>
            </button>
            <button
              type="button"
              className={classNames(mode === 'compare' && 'is-active')}
              aria-pressed={mode === 'compare'}
              onClick={() => onModeChange('compare')}
            >
              <span>Compare feeds</span>
              <small>Same snapshot</small>
            </button>
          </div>
        </div>

        {mode === 'compare' ? (
          <div className="accessibility-comparison-picker">
            <div className="accessibility-panel-heading">
              <span>
                <strong>Choose feeds</strong>
                <small>Every selected timetable uses the same origin, departure, and walking rules.</small>
              </span>
              <span className="accessibility-selection-count"><Database size={13} aria-hidden="true" /> {comparisonFeedIds.length} selected</span>
            </div>
            {feeds.length >= 2 ? (
              <div className="accessibility-comparison-feed-list" role="group" aria-label="GTFS feeds to compare">
                {feeds.map((feed, index) => (
                  <label className="accessibility-comparison-feed-option" key={feed.id}>
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
                <small className="accessibility-comparison-selection-note">
                  {comparisonFeedIds.length} selected · choose at least two; exactly two enables street-service comparison
                </small>
              </div>
            ) : (
              <div className="accessibility-empty-case">
                <strong>Load at least two indexed GTFS feeds first.</strong>
                <span>Open Manage workspace, add the GTFS ZIPs you want to compare, then return here.</span>
                <button type="button" onClick={onOpenData}>Open Manage workspace</button>
              </div>
            )}
          </div>
        ) : null}

        <div className="accessibility-query-card">
          <div className="accessibility-origin-row">
            <span className="accessibility-origin-icon"><MapPin size={16} aria-hidden="true" /></span>
            <div>
              <span className="accessibility-section-kicker">Origin</span>
              <strong>{origin ? origin.label : 'Choose a point on the map'}</strong>
              <small>{origin ? 'Free coordinate · ready to measure' : 'Click the map to place the origin'}</small>
            </div>
            {origin ? (
              <button type="button" className="accessibility-mini-action" onClick={onClearOrigin}>Clear</button>
            ) : null}
          </div>

          <div className="accessibility-query-fields">
            <label className="accessibility-field">
              <span>Service date</span>
              <input
                type="date"
                value={serviceDate}
                onChange={(event) => onServiceDateChange(event.currentTarget.value)}
              />
            </label>
            <label className="accessibility-field">
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
            <label className="accessibility-field">
              <span>Maximum final walk</span>
              <select value={maxWalkKm} onChange={(event) => onMaxWalkKmChange(Number(event.currentTarget.value))}>
                {walkBudgetOptions.map((value) => <option key={value} value={value}>{value} km</option>)}
              </select>
            </label>
          </div>
        </div>

        <details className="accessibility-advanced">
          <summary>
            <span><SlidersHorizontal size={14} aria-hidden="true" /> Analysis settings</span>
            <b>All streets reached within {cutoffMinutes} min · OSM walking</b>
          </summary>
          <div className="accessibility-field-grid">
            <label className="accessibility-field">
              <span>Walk speed</span>
              <select value={walkSpeedKph} onChange={(event) => onWalkSpeedChange(Number(event.currentTarget.value))}>
                {walkSpeedOptions.map((value) => <option key={value} value={value}>{value} km/h</option>)}
              </select>
            </label>
            <label className="accessibility-field">
              <span>Time cutoff</span>
              <select value={cutoffMinutes} onChange={(event) => onCutoffChange(Number(event.currentTarget.value))}>
                {cutoffOptions.map((value) => <option key={value} value={value}>{value} min</option>)}
              </select>
            </label>
          </div>
        </details>

        {mode === 'single' ? (
          <details
            className="accessibility-scenario-builder"
            open={scenarioEditorOpen}
            onToggle={(event) => setScenarioEditorOpen(event.currentTarget.open)}
          >
            <summary>
              <span><SlidersHorizontal size={14} aria-hidden="true" /> Scenario</span>
              <b>{hasScenarioChanges ? `${interventions.length} change${interventions.length === 1 ? '' : 's'} · ${activeCase?.name ?? 'Case'}` : 'Optional'}</b>
            </summary>
            <div className="accessibility-scenario-content">
              <div className="accessibility-scenario-heading">
                <span>
                  <strong>Model service changes</strong>
                  <small>Keep the current network as the baseline, then add a precise service or policy change.</small>
                </span>
                <button
                  type="button"
                  className="accessibility-icon-action"
                  onClick={onAddCase}
                  disabled={cases.length >= 6}
                  aria-label="Add comparison case"
                  title="Add case"
                >
                  <Plus size={14} />
                </button>
              </div>

        {mode === 'single' ? <div className="accessibility-case-tabs" role="group" aria-label="Comparison cases">
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
            className="accessibility-danger-action"
            onClick={() => onRemoveCase(activeCase.id)}
          >
            <Trash2 size={13} />
            Remove {activeCase.name}
          </button>
        ) : null}

        {mode === 'single' ? <div className="accessibility-intervention-add">
          <label className="accessibility-field">
            <span>Add a change</span>
            <select
              value={newInterventionKind}
              onChange={(event) => setNewInterventionKind(event.currentTarget.value as AccessibilityInterventionKind)}
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
          <div className="accessibility-intervention-list" role="list" aria-label={`${activeCase?.name} interventions`}>
            {interventions.map((intervention, index) => (
              <article
                key={intervention.id}
                role="listitem"
                className={classNames(
                  'accessibility-intervention',
                  intervention.id === activeIntervention?.id && 'is-active',
                )}
              >
                <div className="accessibility-intervention-row">
                  <button
                    type="button"
                    className="accessibility-intervention-head"
                    onClick={() => onSelectIntervention(intervention.id)}
                    aria-expanded={intervention.id === activeIntervention?.id}
                  >
                    <span>{index + 1}</span>
                    <strong>{interventionLabels[intervention.kind]}</strong>
                    <small>{interventionSummary(intervention, routes)}</small>
                  </button>
                  <button
                    type="button"
                    className="accessibility-intervention-remove"
                    onClick={() => onRemoveIntervention(intervention.id)}
                    aria-label={`Remove ${intervention.name || interventionLabels[intervention.kind]}`}
                    title="Remove intervention"
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
                {intervention.id === activeIntervention?.id ? (
                  <div className="accessibility-intervention-body">
                    <label className="accessibility-field">
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
                    <label className="accessibility-field">
                      <span>Change type</span>
                      <select
                        value={intervention.kind}
                        onChange={(event) => onUpdateIntervention(intervention.id, {
                          kind: event.currentTarget.value as AccessibilityInterventionKind,
                        })}
                      >
                        {interventionOptions.map(([value, label]) => (
                          <option key={value} value={value}>{label}</option>
                        ))}
                      </select>
                    </label>

                    {intervention.kind !== 'add-line' && intervention.kind !== 'policy' ? (
                      <div className="accessibility-route-picker">
                        <label className="accessibility-field">
                          <span>Find route</span>
                          <input
                            type="search"
                            value={routeQuery}
                            placeholder="Name, number, or route ID"
                            onChange={(event) => setRouteQuery(event.currentTarget.value)}
                          />
                        </label>
                        <label className="accessibility-field">
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
                          <label className="accessibility-field">
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
                                <option key={route.id} value={route.id}>{branchOptionLabel(route)}</option>
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
                        <div className="accessibility-field-grid">
                          {['change-line', 'remove-line'].includes(intervention.kind) ? (
                            <label className="accessibility-field">
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
                            <label className="accessibility-field">
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
                                <option value="published-shape">Published shape + timetable</option>
                                <option value="auto-road">Hybrid: GTFS shape + OSM roads</option>
                                <option value="straight-line">Straight-line estimate</option>
                              </select>
                            </label>
                          ) : null}
                        </div>
                        <small className="accessibility-scope-note">
                          {intervention.kind === 'change-line'
                            ? intervention.routeScope === 'edge'
                              ? 'Inserted stops apply only to branches sharing this ordered A → B GTFS edge. Other branch segments stay unchanged.'
                              : 'This edit applies to the selected GTFS branch only. Other branches keep their published timetable.'
                            : intervention.kind === 'remove-line' && intervention.routeScope === 'route'
                              ? 'Removes every branch of this public route.'
                              : intervention.kind === 'remove-line'
                                ? 'Removes only the selected GTFS branch.'
                                : geometryModeLabel(intervention.geometryMode)}
                        </small>
                      </>
                    ) : null}

                    {hasLineSettings(intervention.kind) ? (
                      <div className="accessibility-road-inference">
                        {intervention.kind === 'add-line' ? (
                          <label className="accessibility-field">
                            <span>Path + timing</span>
                            <select
                              value={intervention.geometryMode ?? 'auto-road'}
                              onChange={(event) => changeGeometryMode(
                                intervention,
                                event.currentTarget.value as ScenarioGeometryMode,
                              )}
                            >
                              <option value="auto-road">Hybrid: GTFS shape + OSM roads</option>
                              <option value="straight-line">Straight-line estimate</option>
                            </select>
                          </label>
                        ) : null}
                        <div>
                          <strong>{geometryModeLabel(intervention.geometryMode)}</strong>
                          <small>
                            {intervention.geometryMode === 'auto-road'
                              ? 'Keep untouched GTFS shapes. Trace only edited gaps on the local OSM road graph, keep the original A → B runtime, and add dwell at inserted stops. If OSM cannot connect a gap, use its published shape segment.'
                              : intervention.geometryMode === 'straight-line'
                                ? 'Use direct stop-to-stop geometry and the configured average speed.'
                                : 'Keep the published GTFS shape and published segment timing unless you choose another path mode.'}
                          </small>
                        </div>
                        {intervention.geometryMode === 'auto-road' ? (
                          <>
                            <button
                              type="button"
                              className="accessibility-mini-action"
                              onClick={() => onInferInterventionGeometry(intervention.id)}
                              disabled={intervention.geometryStatus === 'loading' || intervention.stops.length < 2}
                            >
                              {intervention.geometryStatus === 'loading' ? <LoaderCircle size={13} /> : <Route size={13} />}
                              {intervention.geometryStatus === 'loading' ? 'Tracing roads…' : 'Build road-following path'}
                            </button>
                            {intervention.geometryStatus === 'ready' ? (
                              <small className="accessibility-road-status is-ready">
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
                            {intervention.geometryError ? <small className="accessibility-road-status is-error">{intervention.geometryError}</small> : null}
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
                        <div className="accessibility-field-grid">
                          <label className="accessibility-field">
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
                          <label className="accessibility-field">
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
                        <div className="accessibility-field-grid">
                          <label className="accessibility-field">
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
                          <label className="accessibility-field">
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
                        <label className="accessibility-check">
                          <input
                            type="checkbox"
                            checked={intervention.bidirectional}
                            onChange={(event) => onUpdateIntervention(intervention.id, {
                              bidirectional: event.currentTarget.checked,
                            })}
                          />
                          <span><strong>Bidirectional</strong><small>Operate the intervention in both directions.</small></span>
                        </label>
                      </>
                    ) : null}

                    {intervention.kind === 'policy' ? (
                      <div className="accessibility-field-grid">
                        <label className="accessibility-field">
                          <span>Case walk budget</span>
                          <select
                            value={intervention.maxWalkKm ?? maxWalkKm}
                            onChange={(event) => onUpdateIntervention(intervention.id, {
                              maxWalkKm: Number(event.currentTarget.value),
                            })}
                          >
                            {walkBudgetOptions.map((value) => <option key={value} value={value}>{value} km</option>)}
                          </select>
                        </label>
                        <label className="accessibility-field">
                          <span>Case walk speed</span>
                          <select
                            value={intervention.walkSpeedKph ?? walkSpeedKph}
                            onChange={(event) => onUpdateIntervention(intervention.id, {
                              walkSpeedKph: Number(event.currentTarget.value),
                            })}
                          >
                            {walkSpeedOptions.map((value) => <option key={value} value={value}>{value} km/h</option>)}
                          </select>
                        </label>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        ) : mode === 'single' ? (
          <p className="accessibility-empty-case">
            No changes yet. Run this case to map current-network travel time.
          </p>
        ) : null}

            </div>
          </details>
        ) : null}

        <div className="accessibility-run-block">
          <button
            type={loading ? 'button' : 'submit'}
            className="accessibility-run"
            disabled={!loading && !canRun}
            onClick={loading ? onCancel : undefined}
          >
            {loading ? <LoaderCircle size={15} /> : <Radar size={15} />}
            {loading
              ? 'Cancel analysis'
              : mode === 'compare'
                ? comparison ? 'Refresh GTFS group comparison' : 'Compare GTFS group'
                : analysis ? 'Refresh active case' : 'Run accessibility analysis'}
          </button>
          <small className="accessibility-run-hint">
            {loading ? 'Building the complete reached-street evidence surface…' : canRun ? 'Ready to run · no geographic pruning' : 'Choose an origin and finish the required data setup'}
          </small>
          {loading && progress ? (
            <div className="accessibility-analysis-progress" aria-live="polite">
              <span>
                <strong>{progress.phase}</strong>
                <b>{Math.round(progress.progress * 100)}%</b>
              </span>
              <progress max={1} value={progress.progress} aria-label={`${progress.phase} progress`} />
              {progress.detail ? <small>{progress.detail}</small> : null}
            </div>
          ) : null}
        </div>

        {mode === 'single' && !routingStoreAvailable ? <p className="accessibility-inline-note is-error">A persisted transit routing store is required.</p> : null}
        {mode === 'compare' && feeds.length < 2 ? <p className="accessibility-inline-note is-error">At least two independently indexed GTFS feeds are required for comparison.</p> : null}
        {mode === 'compare' && feeds.length >= 2 && comparisonFeedIds.length < 2 ? <p className="accessibility-inline-note is-error">Select at least two GTFS feeds to compare.</p> : null}
        {!streetGraphAvailable ? <p className="accessibility-inline-note is-error">Import OSM and build the pedestrian street index to compute a network isochrone.</p> : null}
        {roadInferencePending && streetGraphAvailable ? <p className="accessibility-inline-note">Road inference is still building. Finish the road trace before running the analysis.</p> : null}
        {error ? <p className="accessibility-inline-note is-error" role="alert">{error}</p> : null}
      </form>

      {mode === 'compare' && comparison && comparison.length >= 2 ? (
        <section className="accessibility-results" aria-label="GTFS comparison results">
          <div className="accessibility-results-heading">
            <div>
              <span className="accessibility-kicker">Evidence result</span>
              <strong>Feed comparison at one snapshot</strong>
              <small>Same origin, departure, cutoff, and final-walk budget across every selected timetable.</small>
            </div>
            <span className="accessibility-result-badge"><CheckCircle2 size={12} aria-hidden="true" /> Ready</span>
          </div>
          <AccessibilityRenderModePicker renderMode={renderMode} onRenderModeChange={onRenderModeChange} terminalWalkKm={maxWalkKm} />
          <div className="accessibility-comparison-result-head">
            <div>
              <strong>Selected feeds</strong>
              <small>Colors on the map match the rows below.</small>
            </div>
            <span>OSM walking</span>
          </div>
          <div className="accessibility-comparison-result-list">
            {comparison.map((entry, index) => {
              const pixels = scenarioReachablePixels(entry.analysis, 'baseline', cutoffMinutes)
              const areaKm2 = scenarioAccessibleAreaKm2(entry.analysis, 'baseline', cutoffMinutes)
              const stops = scenarioTransitStopsAtCutoff(entry.analysis, 'baseline', cutoffMinutes)
              const networkKm = entry.analysis.diagnostics.raster.baselineNetwork?.reachedEdgeLengthKm ?? 0
              const color = scenarioComparisonColor(index)
              const feed = feeds.find((candidate) => candidate.id === entry.feedId)
              return (
                <article key={entry.feedId} className="accessibility-comparison-result">
                  <span className="accessibility-comparison-swatch" style={{ background: color }} aria-hidden="true" />
                  <div>
                    <strong>GTFS {index + 1} · {entry.feedName}</strong>
                    <small>{formatNumber(feed?.routeCount ?? 0)} routes · {formatNumber(feed?.stopCount ?? 0)} stops · {formatNumber(feed?.tripCount ?? 0)} trips · {formatNumber(stops)} reached by cutoff</small>
                  </div>
                  <b>{areaKm2.toFixed(2)} km²</b>
                  <small>{networkKm.toFixed(1)} km OSM network · {formatNumber(pixels)} cells</small>
                </article>
              )
            })}
          </div>
          <p><CheckCircle2 size={13} /> All selected isochrones are overlaid on the map; colors match the feeds above.</p>
          {comparisonFeedIds.length === 2 ? (
            <div className="accessibility-service-edges">
              <div>
                <strong>Street service change</strong>
                <small>Compare GTFS shapes on the local OSM driving graph; route IDs are not used for alignment.</small>
              </div>
              <div className="accessibility-service-edge-legend" aria-label="Street service edge legend">
                <span><i style={{ background: '#35d0a1' }} />Added</span>
                <span><i style={{ background: '#6da8ff' }} />Maintained</span>
                <span><i style={{ background: '#ff6757' }} />Removed</span>
              </div>
              <button
                type="button"
                className="accessibility-run"
                disabled={serviceDecompositionLoading || !streetGraphAvailable}
                onClick={onRunServiceDecomposition}
              >
                {serviceDecompositionLoading ? <LoaderCircle size={14} /> : <Route size={14} />}
                {serviceDecompositionLoading ? 'Mapping service edges…' : serviceDecomposition ? 'Refresh street service map' : 'Map street service change'}
              </button>
              {serviceDecomposition ? (
                <small className="accessibility-service-edge-summary">
                  {formatNumber(serviceEdgeSummary.added)} added · {formatNumber(serviceEdgeSummary.maintained)} maintained · {formatNumber(serviceEdgeSummary.removed)} removed · unmatched/partial patterns excluded
                </small>
              ) : null}
              {serviceDecompositionError ? <p className="accessibility-inline-note is-error" role="alert">{serviceDecompositionError}</p> : null}
            </div>
          ) : null}
          <details className="accessibility-evidence-record">
            <summary>Comparison evidence record and limits</summary>
            <dl>
              <div><dt>Snapshot</dt><dd>{comparison[0].analysis.request.serviceDate} · {serviceTimeLabel(comparison[0].analysis.request.departMinutes)} · one origin</dd></div>
              <div><dt>Measure</dt><dd>Reachable raster cells within {cutoffMinutes} total elapsed minutes; final walking consumes remaining time and is capped at {comparison[0].analysis.surface.reachability?.baselineTerminalWalkKm ?? comparison[0].analysis.request.maxWalkKm} km; not people or opportunities</dd></div>
              <div><dt>Access</dt><dd>{comparison[0].analysis.request.maxWalkKm} km at {comparison[0].analysis.request.walkSpeedKph ?? walkSpeedKph} km/h · OSM pedestrian network</dd></div>
              <div><dt>Surface</dt><dd>Complete reached-street vector extent · no rectangular map crop</dd></div>
            </dl>
            <ul>
              {Array.from(new Map(comparison.flatMap((entry) => entry.analysis.limitations.map((limitation) => [limitation.code, limitation]))).values()).map((limitation) => <li key={limitation.code}>{limitation.detail}</li>)}
            </ul>
          </details>
        </section>
      ) : null}

      {mode === 'single' && analysis ? (
        <section className="accessibility-results" aria-label="Evidence comparison results">
          <div className="accessibility-results-heading">
            <div>
              <span className="accessibility-kicker">Evidence result</span>
              <strong>{view === 'baseline' ? 'Current network' : view === 'scenario' ? 'Scenario' : 'Time difference'}</strong>
              <small>{analysis.request.serviceDate} · {serviceTimeLabel(analysis.request.departMinutes)} · complete reached-street extent</small>
            </div>
            <span className="accessibility-result-badge"><CheckCircle2 size={12} aria-hidden="true" /> Ready</span>
          </div>
          <div className="accessibility-result-toolbar">
            <AccessibilityRenderModePicker renderMode={renderMode} onRenderModeChange={onRenderModeChange} terminalWalkKm={analysis.surface.reachability?.baselineTerminalWalkKm ?? analysis.request.maxWalkKm} />
            <div className="accessibility-result-view">
              <div className="accessibility-render-mode-head">
                <div>
                  <span className="accessibility-section-kicker">Compare</span>
                  <strong>Network view</strong>
                </div>
                <small>Switch the map and metrics together.</small>
              </div>
              <div className="accessibility-segmented is-view" role="group" aria-label="Network comparison view">
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
            </div>
          </div>
          <AccessibilitySurfaceLegend
            view={view}
            cutoffMinutes={cutoffMinutes}
            terminalWalkKm={view === 'scenario'
              ? analysis.surface.reachability?.scenarioTerminalWalkKm ?? analysis.request.scenario.policy?.maxWalkKm ?? analysis.request.maxWalkKm
              : analysis.surface.reachability?.baselineTerminalWalkKm ?? analysis.request.maxWalkKm}
          />
          <AccessibilityMetricCards
            analysis={analysis}
            surface={view === 'scenario' ? 'scenario' : 'baseline'}
            cutoffMinutes={cutoffMinutes}
            walkBudgetKm={view === 'scenario'
              ? analysis.surface.reachability?.scenarioTerminalWalkKm ?? analysis.request.scenario.policy?.maxWalkKm ?? analysis.request.maxWalkKm
              : analysis.surface.reachability?.baselineTerminalWalkKm ?? analysis.request.maxWalkKm}
          />
          <AccessibilityTransitStatusNotice
            analysis={analysis}
            surface={view === 'scenario' ? 'scenario' : 'baseline'}
          />
          <div className={classNames('accessibility-result-flow', !hasScenarioChanges && 'is-current-network')}>
            {hasScenarioChanges ? (
              <>
                <span><b>{scenarioAccessibleAreaKm2(analysis, 'baseline', cutoffMinutes).toFixed(2)} km²</b><small>current-network area</small></span>
                <ArrowRight size={16} aria-hidden="true" />
                <span><b>{scenarioAccessibleAreaKm2(analysis, 'scenario', cutoffMinutes).toFixed(2)} km²</b><small>scenario area</small></span>
                <span className="is-gain"><b>+{formatNumber(improvedPixels)}</b><small>faster or newly reached</small></span>
              </>
            ) : (
              <span><b>{scenarioAccessibleAreaKm2(analysis, 'baseline', cutoffMinutes).toFixed(2)} km²</b><small>mapped area · {cutoffMinutes} min total elapsed · walk cap {analysis.surface.reachability?.baselineTerminalWalkKm ?? analysis.request.maxWalkKm} km</small></span>
            )}
          </div>
          {(() => {
            const cacheNote = analysis.diagnostics.cache.baselineSurface === 'hit'
              ? ' · baseline surface reused'
              : analysis.diagnostics.preliminary === false
                ? ' · single-pass surface'
                : ''
            return (
          <p>
            <CheckCircle2 size={13} />
            <span>Transit + walking · mapped area, reachable street km, and reached stops. No population or jobs layer is loaded · {analysis.diagnostics.totalMs.toFixed(1)} ms{cacheNote}</span>
          </p>
            )
          })()}
          <details className="accessibility-evidence-record">
            <summary>Evidence record and limits</summary>
            <dl>
              <div><dt>Snapshot</dt><dd>{analysis.request.serviceDate} · {serviceTimeLabel(analysis.request.departMinutes)} · one origin</dd></div>
              <div><dt>Measure</dt><dd>Reachable raster cells within {cutoffMinutes} total elapsed minutes; final walking consumes remaining time and is capped at {analysis.surface.reachability?.baselineTerminalWalkKm ?? analysis.request.maxWalkKm} km; not people or opportunities</dd></div>
              <div><dt>Method</dt><dd>Total elapsed OSM access walk + transit + terminal walk; directed OSM network evidence with area and street-path renderings</dd></div>
              <div><dt>Access</dt><dd>{analysis.request.maxWalkKm} km at {analysis.request.walkSpeedKph ?? walkSpeedKph} km/h · OSM pedestrian network</dd></div>
              <div><dt>Surface</dt><dd>Complete reached-street vector extent · no rectangular map crop</dd></div>
              <div><dt>Run identity</dt><dd><code>{analysis.diagnostics.cache.key?.slice(0, 16) ?? analysis.request.baselineIdentity.slice(0, 16)}</code></dd></div>
            </dl>
            {activeCase?.interventions.length ? (
              <ol className="accessibility-evidence-interventions" aria-label="Modeled scenario assumptions">
                {activeCase.interventions.map((intervention) => (
                  <li key={intervention.id}>
                    <strong>{intervention.name || interventionLabels[intervention.kind]}</strong>
                    <small>{interventionEvidenceDetail(intervention, routes)}</small>
                  </li>
                ))}
              </ol>
            ) : null}
            {activeCase?.interventions.some((intervention) => hasLineSettings(intervention.kind)) ? (
              <p className="accessibility-evidence-caveat">
                Scenario travel times use the selected average speed plus a fixed 0.35-minute dwell at each stop. They are modeled service, not a published timetable or observed operations.
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
