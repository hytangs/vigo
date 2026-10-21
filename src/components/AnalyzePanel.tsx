import { type CSSProperties, type FormEvent, memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  CircleDot,
  Eraser,
  GitCompareArrows,
  Grid2x2,
  LoaderCircle,
  MapPin,
  Pencil,
  Plus,
  Radar,
  RotateCcw,
  Route,
  Trash2,
  Waypoints,
  X,
} from 'lucide-react'
import type { ApiProgress } from '../app/api'
import { countRender } from '../app/renderCounts'
import { shallowEqual, useStore } from '../app/store'
import {
  activeCaseFeeds,
  activeScenarioChange,
  activeScenarioStopPlacement,
  addScenario,
  addScenarioChange,
  analysisRoutes,
  analyze,
  beginScenarioStopPlacement,
  cancelScenarioStopPlacement,
  cancelSurfaceAnalysis,
  changeAnalysisDepartMinutes,
  changeAnalysisServiceDate,
  changeAnalyzeMode,
  changeCutoff,
  changeReachMaxTransfers,
  changeReachMaxWalkKm,
  changeRenderMode,
  changeSurfaceSampling,
  changeReachTravelMode,
  changeReachTimePreference,
  changeWalkSpeed,
  cityGrouping,
  clearScenarioSketch,
  comparisonFeedOptions,
  inferScenarioRoadGeometry,
  removeScenario,
  removeScenarioChange,
  removeScenarioStop,
  resetScenarioRouteStops,
  runComparison as runComparisonAction,
  compareReferenceOptions,
  compareScenarioIds,
  changeCompareReference,
  toggleCompareScenario,
  selectComparisonVariant,
  renameScenario,
  assignScenarioGroup,
  runServiceDecomposition,
  runSurfaceAnalysis,
  selectScenario,
  selectScenarioChange,
  setAnalysisOrigin,
  setScenarioView,
  toggleComparisonFeed,
  updateScenarioChange,
  updateScenarioChangeRoute,
} from '../state/analyze'
import { clock } from '../state/clock'
import { useStudio, useStudioRecord } from '../state/hooks'
import { openDataView } from '../state/navigation'
import { network } from '../state/network'
import { scenarioLibrary } from '../state/scenarios'
import { preview, routingScope, selectedProject, visiblePreparationTasks } from '../state/scope'
import { preparationState, type PreparationTask } from '../app/preparation'
import { classNames, formatNumber, type RouteMetric, type StopMetric } from '../domain'
import { gtfsDirectionLabel, gtfsPatternStops, gtfsPatternTimetable } from '../app/gtfsPresentation'
import { scopedRouteServiceKey } from '../routeServices'
import type { RoutingPoint, RoutingTimePreference } from '../routingModel'
import { ResultMetric } from './UiPrimitives'
import { AnalysisOriginPicker } from './AnalysisOriginPicker'
import { OperationProgress } from './OperationProgress'
import { AnalysisNumberField, ReachSettings } from './ReachSettings'
import { ResultExportActions } from './ResultExportActions'
import { exportComparison, exportReachResults, reachExportEntries, reachGeometryAvailable } from '../app/resultExports'
import { rankedCompareEntries, type CompareVariant, type ComparisonRun } from '../app/comparison'
import { reachTransitStops, reachScenarioDifference } from '../app/resultSummary'
import { maximumScenarios } from '../app/scenarioLibrary'
import type { CityDataGroup } from '../app/cityDataGroups'
import type { ScenarioSaveState } from '../app/useScenarioLibrary'
import {
  reachArrivesBy,
  reachBandColor,
  reachDifferenceCapMinutes,
  reachDisplayedBands,
  reachDifferenceGradient,
  reachTimeGradient,
  scenarioReachedAreaKm2,
  scenarioImprovedPixels,
  scenarioWorsenedPixels,
  scenarioInsertedStopsForEdge,
  scenarioEdgeEditError,
  scenarioEdgeIndexes,
  type ReachTransitStatus,
  type ScenarioDraft,
  type ScenarioChangeDraft,
  type ScenarioChangeKind,
  type ScenarioGeometryMode,
  type ReachResult,
  type ScenarioRouteScope,
  type ScenarioRenderMode,
  type ScenarioStopDraft,
  type ScenarioStopPlacement,
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
  /** The departure, or for arrive-by the arrival deadline. */
  departMinutes: number
  timePreference?: RoutingTimePreference
  onTimePreferenceChange?: (value: RoutingTimePreference) => void
  maxWalkKm: number
  maxTransfers?: number
  walkSpeedKph: number
  travelMode?: 'transit' | 'drive'
  onTravelModeChange?: (value: 'transit' | 'drive') => void
  surfaceSampling?: 'street' | 'cell-center'
  onSurfaceSamplingChange?: (value: 'street' | 'cell-center') => void
  cutoffMinutes: number
  renderMode: ScenarioRenderMode
  cases: ScenarioDraft[]
  caseGroupLabel?: string
  scenarioGroups?: CityDataGroup[]
  scenarioSaveState?: ScenarioSaveState
  onRenameCase?: (caseId: string, name: string) => void
  onAssignCaseGroup?: (caseId: string, groupId: string) => void
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
  comparisonRun?: ComparisonRun | null
  compareReferenceOptions?: CompareVariant[]
  compareReferenceId?: string
  compareScenarioIds?: string[]
  onCompareReferenceChange?: (id: string) => void
  onCompareScenarioChange?: (id: string, selected: boolean) => void
  onSelectComparisonVariant?: (id: string) => void
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
  onMaxTransfersChange?: (value: number | undefined) => void
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
const serviceStartOptions = [0, 300, 360, 420, 480, 540, 600, 720] as const
const serviceEndOptions = [1080, 1200, 1320, 1440, 1500, 1560, 1680] as const
const scenarioViewOptions = [
  ['baseline', 'Baseline'],
  ['scenario', 'Scenario'],
  ['comparison', 'Difference'],
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

function keepsScheduledTrips(intervention: ScenarioChangeDraft) {
  return intervention.kind === 'change-line' && intervention.scheduleMode !== 'frequency'
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
  analysis,
  view,
  renderMode,
  cutoffMinutes,
  terminalWalkKm,
}: {
  analysis: ReachResult
  view: ScenarioView
  renderMode: ScenarioRenderMode
  cutoffMinutes: number
  terminalWalkKm: number
}) {
  const difference = view === 'comparison'
  // Arrive-by values are the minutes before the deadline a traveler must leave.
  const arriveBy = reachArrivesBy(analysis.request)
  const timing = analysis.request.mode === 'drive'
    ? arriveBy ? 'Driving time to the destination · road-speed estimates' : 'Driving time · road-speed estimates'
    : arriveBy ? `Leave this many minutes before ${serviceTimeLabel(analysis.request.departMinutes)} · first walk ≤ ${terminalWalkKm} km` : ''
  if (!difference && renderMode === 'area') {
    const surface = view === 'scenario' ? 'scenario' : 'baseline'
    const bands = reachDisplayedBands(analysis, cutoffMinutes)
    const areas = bands.map((band) => scenarioReachedAreaKm2(analysis, surface, band))
    const largest = Math.max(...areas, Number.EPSILON)
    return (
      <div className="reach-surface-legend" role="group" aria-label={`${surface === 'baseline' ? 'Baseline' : 'Scenario'} travel time bands`}>
        <div className="reach-surface-legend-head">
          <strong>{surface === 'baseline' ? 'Baseline' : 'Scenario'}</strong>
          <small>{timing || `Area reached by elapsed time · final walk ≤ ${terminalWalkKm} km`}</small>
        </div>
        <ol className="reach-band-list">
          {bands.map((band, index) => (
            <li key={band} style={{ '--reach-band': reachBandColor(bands, index), '--reach-band-share': `${areas[index] / largest * 100}%` } as CSSProperties}>
              <span className="reach-band-label">≤ {band} min{arriveBy ? ' before' : ''}</span>
              <span className="reach-band-bar" aria-hidden="true" />
              <b>{reachDecimal(areas[index], areas[index] < 10 ? 1 : 0)} km²</b>
            </li>
          ))}
        </ol>
      </div>
    )
  }
  return (
    <div
      className={classNames('reach-surface-legend', difference && 'is-difference')}
      role="group"
      aria-label={difference ? 'Time difference legend' : `${view === 'baseline' ? 'Baseline' : 'Scenario'} travel time legend`}
    >
      <div className="reach-surface-legend-head">
        <strong>{difference ? 'Time difference' : view === 'baseline' ? 'Baseline' : 'Scenario'}</strong>
        <small>{difference ? 'Green is faster · red is slower' : timing || `Elapsed time · final walk ≤ ${terminalWalkKm} km`}</small>
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
          <><span>0 min</span><span>{Number((cutoffMinutes / 2).toFixed(2))} min</span><span>{cutoffMinutes} min</span></>
        )}
      </div>
    </div>
  )
}

const renderModeChoices = [
  ['area', 'Reachable area', Grid2x2],
  ['streets', 'Reached streets', Waypoints],
] as const

/** How Reach draws on the map: filled area or the streets themselves. */
function ReachRenderModePicker({ renderMode, onRenderModeChange }: {
  renderMode: ScenarioRenderMode
  onRenderModeChange: (mode: ScenarioRenderMode) => void
}) {
  return (
    <div className="studio-tabs reach-render-mode" role="group" aria-label="Reach map rendering">
      {renderModeChoices.map(([value, label, Icon]) => (
        <button key={value} type="button" aria-pressed={renderMode === value} aria-label={label} title={label} onClick={() => onRenderModeChange(value)}>
          <Icon size={14} aria-hidden="true" />
        </button>
      ))}
    </div>
  )
}

function transitStopsForSelectedCutoff(analysis: ReachResult, surface: 'baseline' | 'scenario', cutoffMinutes: number): number | null {
  return reachTransitStops(analysis, surface, cutoffMinutes)
}

const reachDecimal = (value: number, digits: number) => value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
const reachDelta = (value: number, digits = 0) => {
  const rounded = Number(value.toFixed(digits))
  return `${rounded > 0 ? '+' : ''}${reachDecimal(rounded, digits)}`
}

export function ReachMetricCards({
  analysis,
  surface,
  cutoffMinutes,
}: {
  analysis: ReachResult
  surface: 'baseline' | 'scenario'
  cutoffMinutes: number
}) {
  const areaKm2 = scenarioReachedAreaKm2(analysis, surface, cutoffMinutes)
  const stops = transitStopsForSelectedCutoff(analysis, surface, cutoffMinutes)
  const arriveBy = reachArrivesBy(analysis.request)
  return (
    <div className="reach-metric-grid" aria-label={`${surface === 'baseline' ? 'Baseline' : 'Scenario'} network reach metrics`}>
      <ResultMetric value={`${reachDecimal(areaKm2, 2)} km²`} label={arriveBy ? `sampled area to leave ≤ ${cutoffMinutes} min before` : `sampled area reached by ${cutoffMinutes} min`} />
      {analysis.request.mode !== 'drive' ? <ResultMetric value={stops === null ? 'Unavailable' : formatNumber(stops)} label={arriveBy ? `stops to board ≤ ${cutoffMinutes} min before` : `stops reached by ${cutoffMinutes} min`} detail={stops === null ? 'Update Reach to compute this cutoff.' : undefined} /> : null}
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
  if (!status || analysis.request.mode === 'drive') return null
  const stops = transitStopsForSelectedCutoff(analysis, surface, cutoffMinutes)
  const fullWindow = analysis.summary.maximumCutoffMinutes
  const fullStops = transitStopsForSelectedCutoff(analysis, surface, fullWindow)
  const earliest = status.earliestScheduledDepartureMinutes
  const timing = typeof earliest === 'number' && Number.isFinite(earliest)
    ? ` First scheduled service is at ${serviceTimeLabel(Number(earliest))}${typeof status.waitMinutes === 'number' && Number.isFinite(status.waitMinutes) ? ` (${Math.round(status.waitMinutes)} min after departure)` : ''}.`
    : ''
  const arriveBy = reachArrivesBy(analysis.request)
  if (status.status === 'reached') {
    const selected = stops === null
      ? `Transit-stop counts are unavailable for the selected ${cutoffMinutes}-minute cutoff. Update Reach to compute this cutoff.`
      : arriveBy
        ? `${formatNumber(stops)} transit ${stops === 1 ? 'stop reaches' : 'stops reach'} the destination within the selected ${cutoffMinutes}-minute cutoff.`
        : `${formatNumber(stops)} transit ${stops === 1 ? 'stop is' : 'stops are'} reachable within the selected ${cutoffMinutes}-minute cutoff.`
    const laterReach = stops === 0 && fullWindow > cutoffMinutes && fullStops !== null && fullStops > 0
      ? arriveBy
        ? ` ${formatNumber(fullStops)} ${fullStops === 1 ? 'stop reaches' : 'stops reach'} it within the full ${fullWindow}-minute computed window.`
        : ` Transit reaches ${formatNumber(fullStops)} ${fullStops === 1 ? 'stop' : 'stops'} within the full ${fullWindow}-minute computed window.`
      : ''
    if (stops !== null && stops > 0) return null
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

function scenarioSaveLabel(state: ScenarioSaveState) {
  return { loading: 'Loading…', saved: 'Saved in City', unsaved: 'Unsaved', saving: 'Saving…', error: 'Not saved', unavailable: 'Not saved' }[state]
}

export function AnalyzePanelView({
  mode,
  origin,
  serviceDate,
  departMinutes,
  timePreference = 'depart',
  onTimePreferenceChange,
  maxWalkKm,
  maxTransfers,
  walkSpeedKph,
  travelMode = 'transit',
  onTravelModeChange,
  surfaceSampling = 'street',
  onSurfaceSamplingChange,
  cutoffMinutes,
  renderMode,
  cases,
  caseGroupLabel,
  scenarioGroups = [],
  scenarioSaveState = 'saved',
  onRenameCase = () => {},
  onAssignCaseGroup = () => {},
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
  comparisonRun = null,
  compareReferenceOptions = [],
  compareReferenceId = '',
  compareScenarioIds = [],
  onCompareReferenceChange = () => {},
  onCompareScenarioChange = () => {},
  onSelectComparisonVariant = () => {},
  serviceDecomposition,
  serviceDecompositionLoading,
  serviceDecompositionError,
  onServiceDateChange,
  onDepartMinutesChange,
  onMaxWalkKmChange,
  onMaxTransfersChange,
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
  const hasScenarioChanges = travelMode !== 'drive' && interventions.length > 0
  // An arrive-by Reach anchors at its destination and reads the clock as a deadline.
  const arriveBy = timePreference === 'arrive'
  const place = arriveBy ? 'destination' : 'origin'
  useEffect(() => {
    if (hasScenarioChanges && surfaceSampling === 'cell-center') onSurfaceSamplingChange?.('street')
  }, [hasScenarioChanges, travelMode, onTravelModeChange, surfaceSampling, onSurfaceSamplingChange])
  useEffect(() => {
    if (hasScenarioChanges) setScenarioEditorOpen(true)
  }, [hasScenarioChanges])
  const improvedPixels = useMemo(() => scenarioImprovedPixels(analysis, cutoffMinutes), [analysis, cutoffMinutes])
  const worsenedPixels = useMemo(() => scenarioWorsenedPixels(analysis, cutoffMinutes), [analysis, cutoffMinutes])
  const scenarioDifference = useMemo(() => analysis ? reachScenarioDifference(analysis, cutoffMinutes) : null, [analysis, cutoffMinutes])
  const analysisExportEntries = useMemo(() => reachExportEntries(analysis), [analysis, cutoffMinutes])
  const roadInferencePending = mode === 'single' && interventions.some((intervention) => (
    hasLineSettings(intervention.kind)
    && intervention.geometryMode === 'auto-road'
    && intervention.geometryStatus !== 'ready'
  ))
  const compareTimetableIds = feeds.length >= 2
    ? comparisonFeedIds.filter((feedId) => feeds.some((feed) => feed.id === feedId) && `timetable:${feedId}` !== compareReferenceId)
    : []
  const comparisonReady = compareReferenceOptions.some((option) => option.id === compareReferenceId)
    && (compareScenarioIds.length > 0 || compareTimetableIds.length > 0)
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
  const transitSetup = preparationState(routingStoreAvailable,
    preparationTasks, ['national-gtfs-import', 'national-gtfs-merge'], routingStoreBuilding)
  const streetSetup = preparationState(streetGraphAvailable, preparationTasks, ['national-osm-import'], streetGraphBuilding)
  const dataPreparing = [transitSetup, streetSetup].some((state) => state.status === 'working')
  const setupHint = !streetGraphAvailable || !(mode === 'compare' ? comparisonReady : routingStoreAvailable)
    ? [transitSetup, streetSetup].some((state) => state.status === 'paused')
      ? 'Task updates are paused. Open background tasks to reconnect.'
      : dataPreparing ? `Data is being prepared. You can choose the ${place} while it runs.`
        : mode === 'compare' && routingStoreAvailable && !comparisonReady ? 'Choose a scenario or timetable to compare above.'
          : 'Finish the data setup above, then run the analysis.'
    : !origin ? onSetOrigin ? 'Search for a stop above or click the map.' : `Click the map to choose ${arriveBy ? 'a destination' : 'an origin'}.`
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
    <section className="reach-surface" aria-label="Reach analysis controls">
      <header className="inspector-head reach-analysis-switch">
        <div className="studio-tabs reach-mode-tabs" role="group" aria-label="Analyze mode">
          <button type="button" aria-pressed={mode === 'single'} onClick={() => onModeChange('single')}>
            <Radar size={13} aria-hidden="true" /><span>Reach</span>
          </button>
          <button type="button" aria-pressed={mode === 'compare'} onClick={() => onModeChange('compare')}>
            <GitCompareArrows size={13} aria-hidden="true" /><span>Compare</span>
          </button>
        </div>
        <button type="button" className="kit-icon-button reach-new" onClick={onClearOrigin} disabled={!origin} aria-label="New Reach" title={`Clear the ${place} and start a new Reach`}>
          <RotateCcw size={15} aria-hidden="true" />
        </button>
      </header>
      <form className="reach-form" onSubmit={submit}>

        {mode === 'compare' ? (
          <div className="reach-comparison-picker">
            <label className="reach-field">
              <span>Compare against</span>
              <select value={compareReferenceId} onChange={(event) => onCompareReferenceChange(event.currentTarget.value)}>
                {compareReferenceOptions.map((option) => <option key={option.id} value={option.id}>{option.label} · {option.detail}</option>)}
              </select>
            </label>
            <div className="compare-variant-group" role="group" aria-label="Saved scenarios to compare">
              <span className="reach-section-kicker">Saved scenarios</span>
              {cases.length ? cases.map((entry) => (
                <label className="reach-comparison-scenario-option" key={entry.id}>
                  <input type="checkbox" checked={compareScenarioIds.includes(entry.id)} onChange={(event) => onCompareScenarioChange(entry.id, event.currentTarget.checked)} />
                  <span>
                    <strong>{entry.name}</strong>
                    <small>{scenarioGroups.find((group) => group.id === entry.groupId)?.name ?? 'No timetable group'} · {entry.interventions.length ? `${entry.interventions.length} change${entry.interventions.length === 1 ? '' : 's'}` : 'no changes'}</small>
                  </span>
                </label>
              )) : <small className="reach-comparison-selection-note">Save a scenario in Reach to compare it here.</small>}
            </div>
            {feeds.length >= 2 ? (
              <div className="compare-variant-group reach-comparison-feed-list" role="group" aria-label="GTFS feeds to compare">
                <span className="reach-section-kicker">Timetables</span>
                {feeds.map((feed) => (
                  <label className="reach-comparison-feed-option" key={feed.id}>
                    <input
                      type="checkbox"
                      checked={comparisonFeedIds.includes(feed.id)}
                      disabled={`timetable:${feed.id}` === compareReferenceId}
                      onChange={(event) => onComparisonFeedChange(feed.id, event.currentTarget.checked)}
                    />
                    <span>
                      <strong>{feed.name}</strong>
                      <small>{formatNumber(feed.routeCount)} routes · {formatNumber(feed.stopCount)} stops · {formatNumber(feed.tripCount)} trips</small>
                    </span>
                  </label>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="reach-query-card kit-group">
          {onTimePreferenceChange ? <div className="studio-tabs reach-time-preference" role="group" aria-label="Reach time">
            {(['depart', 'arrive'] as const).map((value) => (
              <button key={value} type="button" aria-pressed={timePreference === value} onClick={() => onTimePreferenceChange(value)}>
                {value === 'arrive' ? 'Arrive by' : 'Leave at'}
              </button>
            ))}
          </div> : null}
          <div className={classNames('reach-origin-row', !origin && 'is-empty', arriveBy && 'is-destination')}>
            <span className="reach-origin-icon" aria-hidden="true" />
            <div>
              <span className="reach-section-kicker">{arriveBy ? 'Destination' : 'Origin'}{origin?.coordinate ? <span className="reach-origin-coordinate">{origin.coordinate[1].toFixed(5)}, {origin.coordinate[0].toFixed(5)}</span> : null}</span>
              <strong>{origin ? origin.label : onSetOrigin ? 'Click the map or search stops' : 'Choose a point on the map'}</strong>
            </div>
            {origin ? (
              <button type="button" className="kit-icon-button reach-origin-clear" onClick={onClearOrigin} aria-label={`Clear ${place}`} title={`Clear ${place}`}><X size={14} aria-hidden="true" /></button>
            ) : null}
          </div>
          {onSetOrigin ? <AnalysisOriginPicker origin={origin} place={place} stops={stops} onSetOrigin={onSetOrigin} disabled={loading} /> : null}

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
              <span>{arriveBy ? 'Deadline' : 'Departs'}</span>
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

        <ReachSettings travelMode={travelMode} onTravelModeChange={mode === 'single' ? onTravelModeChange : undefined} timePreference={timePreference} cutoffMinutes={cutoffMinutes} maxWalkKm={maxWalkKm} walkSpeedKph={walkSpeedKph}
          maxTransfers={maxTransfers} surfaceSampling={surfaceSampling} hasScenarioChanges={hasScenarioChanges}
          onCutoffChange={onCutoffChange} onMaxWalkKmChange={onMaxWalkKmChange} onWalkSpeedChange={onWalkSpeedChange}
          onMaxTransfersChange={onMaxTransfersChange} onSurfaceSamplingChange={onSurfaceSamplingChange} />

        {mode === 'single' && travelMode !== 'drive' ? (
          <details
            className="studio-disclosure is-compact reach-scenario-builder"
            open={scenarioEditorOpen}
            onToggle={(event) => setScenarioEditorOpen(event.currentTarget.open)}
          >
            <summary>
              <span>Scenario</span>
              <b>{activeCase ? `${activeCase.name}${hasScenarioChanges ? ` · ${interventions.length} change${interventions.length === 1 ? '' : 's'}` : ''}` : 'No changes'}</b>
            </summary>
            <div className="reach-scenario-content">
              <div className="scenario-library">
                <div className="scenario-library-head">
                  <strong>Saved scenarios</strong>
                  <span className="scenario-save-state" data-state={scenarioSaveState} role="status">{scenarioSaveLabel(scenarioSaveState)}</span>
                  <button
                    type="button"
                    className="reach-icon-action"
                    onClick={onAddCase}
                    disabled={cases.length >= maximumScenarios}
                    aria-label="New scenario"
                    title="New scenario"
                  >
                    <Plus size={14} />
                  </button>
                </div>
                <div className="scenario-library-list" role="radiogroup" aria-label="Saved scenarios">
                  {cases.map((entry) => {
                    const group = scenarioGroups.find((candidate) => candidate.id === entry.groupId)
                    return (
                      <button
                        key={entry.id}
                        type="button"
                        role="radio"
                        aria-checked={entry.id === activeCase?.id}
                        className={classNames('scenario-library-row', entry.id === activeCase?.id && 'is-active')}
                        onClick={() => onSelectCase(entry.id)}
                      >
                        <span className="scenario-library-name">{entry.name}</span>
                        <small>{group?.name ?? 'No timetable group'} · {entry.interventions.length ? `${entry.interventions.length} change${entry.interventions.length === 1 ? '' : 's'}` : 'no changes'}</small>
                      </button>
                    )
                  })}
                </div>
              </div>
              {activeCase ? (
                <div className="scenario-active">
                  <label className="reach-field">
                    <span>Name</span>
                    <input
                      type="text"
                      value={activeCase.name}
                      maxLength={80}
                      onChange={(event) => onRenameCase(activeCase.id, event.currentTarget.value)}
                      onBlur={(event) => { if (!event.currentTarget.value.trim()) onRenameCase(activeCase.id, 'Untitled scenario') }}
                    />
                  </label>
                  <label className="reach-field">
                    <span>Runs on</span>
                    <select value={activeCase.groupId ?? ''} onChange={(event) => onAssignCaseGroup(activeCase.id, event.currentTarget.value)}>
                      <option value="" disabled>Choose timetables</option>
                      {scenarioGroups.map((group) => <option key={group.id} value={group.id}>{group.name} · {group.feedIds.length} timetable{group.feedIds.length === 1 ? '' : 's'}</option>)}
                    </select>
                  </label>
                  <div className="scenario-active-actions">
                    <button type="button" className="city-case-group-link" onClick={onOpenData}>{caseGroupLabel ? 'Edit timetable groups' : 'Choose timetables'}</button>
                    {cases.length > 1 ? (
                      <button type="button" className="reach-danger-action" onClick={() => onRemoveCase(activeCase.id)}>
                        <Trash2 size={13} />
                        Remove
                      </button>
                    ) : null}
                  </div>
                </div>
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
                        {intervention.kind === 'change-line' ? (
                          <label className="reach-field">
                            <span>Departures</span>
                            <select
                              value={intervention.scheduleMode ?? 'preserve-trips'}
                              onChange={(event) => onUpdateIntervention(intervention.id, {
                                scheduleMode: event.currentTarget.value as 'preserve-trips' | 'frequency',
                                bidirectional: false,
                              })}
                            >
                              <option value="preserve-trips">Keep scheduled departures</option>
                              <option value="frequency">Set frequency and hours</option>
                            </select>
                            {keepsScheduledTrips(intervention) ? <small>Keep every trip on the selected service date. Stop edits change travel times without adding departures.</small> : null}
                          </label>
                        ) : null}
                        <div className="reach-service-settings">
                          {!keepsScheduledTrips(intervention) ? (
                            <AnalysisNumberField label="Time between services" value={intervention.headwayMinutes} min={2} max={180} unit="min"
                              onChange={value => { if (value !== undefined) onUpdateIntervention(intervention.id, { headwayMinutes: value }) }} />
                          ) : null}
                          <AnalysisNumberField label="Average speed" value={intervention.averageSpeedKph} min={4} max={160} unit="km/h"
                            onChange={value => { if (value !== undefined) onUpdateIntervention(intervention.id, { averageSpeedKph: value }) }} />
                        </div>
                        {!keepsScheduledTrips(intervention) ? (
                          <>
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
            className={classNames('kit-button is-block reach-run', !loading && 'is-primary')}
            disabled={!loading && !canRun}
            onClick={loading ? onCancel : undefined}
          >
            {loading ? <LoaderCircle className="is-spinning" size={15} /> : <Radar size={15} />}
            {loading
              ? 'Cancel analysis'
              : mode === 'compare'
                ? comparisonRun ? 'Refresh comparison' : 'Compare'
                : analysis ? 'Update Reach' : 'Run Reach'}
          </button>
          {loading || !canRun ? (
            <small className="reach-run-hint">
              {loading ? (travelMode === 'drive' ? 'Computing driving times across the map…' : 'Computing the complete reached-street surface…') : setupHint}
            </small>
          ) : null}
          {loading ? (
            <OperationProgress phase={progress?.phase || 'Starting analysis'} detail={progress?.detail} work={progress?.work} profile={`reach:${mode}`} />
          ) : null}
        </div>

        {roadInferencePending && streetGraphAvailable ? <p className="reach-inline-note">Road inference is still building. Finish the road trace before running the analysis.</p> : null}
        {error ? <p className="reach-inline-note is-error" role="alert">{error}</p> : null}
      </form>

      {mode === 'compare' && comparisonRun ? (
        <section className="reach-results compare-results" aria-label="Comparison results">
          <div className="reach-results-heading">
            <div>
              <strong>Compare · {comparisonRun.cutoffMinutes} min</strong>
              <small>Against {comparisonRun.reference.label} · {comparisonRun.serviceDate} · {comparisonRun.timePreference === 'arrive' ? 'arrive by ' : ''}{serviceTimeLabel(comparisonRun.departMinutes)}</small>
            </div>
            <div className="reach-results-tools">
              <ReachRenderModePicker renderMode={renderMode} onRenderModeChange={onRenderModeChange} />
              <ResultExportActions label="Save comparison" resultKey={comparisonRun}
                disabled={loading} formats={['csv', 'json', 'geojson']}
                onExport={(format) => exportComparison(comparisonRun, analysis, format)} />
            </div>
          </div>
          <div className="compare-reference">
            <span className="reach-reference-label">Reference</span>
            <strong>{comparisonRun.reference.label}</strong>
            <b>{comparisonRun.reference.areaKm2.toFixed(2)} km²</b>
            <small>{comparisonRun.reference.stops === null ? 'Stops unavailable' : `${formatNumber(comparisonRun.reference.stops)} stops reached`}</small>
          </div>
          <div className="compare-ranking" role="radiogroup" aria-label="Variants ranked by reach gained">
            {(() => {
              const ranked = rankedCompareEntries(comparisonRun.entries)
              const largest = Math.max(...ranked.map((entry) => Math.abs(entry.stats?.areaDeltaKm2 ?? 0)), 1e-9)
              return ranked.map((entry, index) => {
                const stats = entry.stats
                const selected = entry.variant.id === comparisonRun.selectedId
                const gain = stats?.areaDeltaKm2 ?? 0
                return (
                  <button
                    key={entry.variant.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={!stats || loading}
                    className={classNames('compare-variant', selected && 'is-selected', !stats && 'is-failed')}
                    onClick={() => onSelectComparisonVariant(entry.variant.id)}
                  >
                    <span className="compare-variant-name">
                      <strong>{entry.variant.label}</strong>
                      {index === 0 && stats && gain > 0 ? <em>Most reach</em> : null}
                      <small>{entry.variant.kind === 'scenario' ? 'Scenario' : entry.variant.kind === 'group' ? 'Timetable group' : 'Timetable'}{entry.variant.detail ? ` · ${entry.variant.detail}` : ''}</small>
                    </span>
                    {stats ? <>
                      <span className="compare-variant-area">
                        <b>{stats.areaKm2.toFixed(2)} km²</b>
                        <small data-tone={gain > 0.005 ? 'good' : gain < -0.005 ? 'alert' : 'same'}>{reachDelta(gain, 2)} km²</small>
                      </span>
                      <span className="compare-variant-bar" aria-hidden="true"><i data-tone={gain >= 0 ? 'good' : 'alert'} style={{ width: `${Math.round(Math.abs(gain) / largest * 100)}%` }} /></span>
                      <small className="compare-variant-detail">
                        {formatNumber(stats.newPixels)} cells newly reached · {formatNumber(stats.lostPixels)} lost
                        {stats.commonPixels ? ` · ${stats.meanSavedMinutes >= 0 ? 'saves' : 'adds'} ${reachDecimal(Math.abs(stats.meanSavedMinutes), 1)} min where both reach` : ''}
                        {stats.stopsDelta !== null ? ` · ${reachDelta(stats.stopsDelta)} stops` : ''}
                      </small>
                    </> : <small className="compare-variant-detail is-error">{entry.error ?? 'Not measured'}</small>}
                  </button>
                )
              })
            })()}
          </div>
          {analysis && comparisonRun.selectedId ? <p className="compare-map-note">The map shows time change from {comparisonRun.reference.label} to {comparisonRun.entries.find((entry) => entry.variant.id === comparisonRun.selectedId)?.variant.label}. Choose another variant to compare it.</p> : null}
          {feeds.length >= 2 && comparisonFeedIds.length === 2 ? (
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
        </section>
      ) : null}

      {mode === 'single' && analysis ? (
        <section className="reach-results" aria-label="Modeled network reach comparison results">
          <div className="reach-results-heading">
            <div>
              <strong>{view === 'baseline' ? 'Baseline reach' : view === 'scenario' ? 'Scenario reach' : 'Travel-time change'}</strong>
              <small>{analysis.request.serviceDate} · {reachArrivesBy(analysis.request) ? 'arrive by ' : ''}{serviceTimeLabel(analysis.request.departMinutes)}</small>
            </div>
            <div className="reach-results-tools">
              {analysis.request.mode !== 'drive' ? <ReachRenderModePicker renderMode={renderMode} onRenderModeChange={onRenderModeChange} /> : null}
              <ResultExportActions label="Save Reach results" resultKey={analysisExportEntries}
                disabled={loading || analysis.diagnostics.preliminary || cutoffMinutes > analysis.summary.maximumCutoffMinutes}
                unavailable={reachGeometryAvailable(analysisExportEntries, cutoffMinutes) ? {} : { geojson: 'Update Reach to retain geometry for this cutoff' }}
                onExport={format => exportReachResults(analysisExportEntries, format, cutoffMinutes)} />
            </div>
          </div>
          {hasScenarioChanges ? <div className="studio-tabs reach-segmented is-view" role="group" aria-label="Network comparison view">
            {scenarioViewOptions.map(([value, label]) => (
              <button key={value} type="button" onClick={() => onViewChange(value)} aria-pressed={view === value}>{label}</button>
            ))}
          </div> : null}
          <ReachSurfaceLegend
            analysis={analysis}
            view={view}
            renderMode={renderMode}
            cutoffMinutes={cutoffMinutes}
            terminalWalkKm={view === 'scenario'
              ? analysis.surface.reachability?.scenarioTerminalWalkKm ?? analysis.request.maxWalkKm
              : analysis.surface.reachability?.baselineTerminalWalkKm ?? analysis.request.maxWalkKm}
          />
          <ReachMetricCards
            analysis={analysis}
            surface={view === 'scenario' ? 'scenario' : 'baseline'}
            cutoffMinutes={cutoffMinutes}
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
            <span className="is-gain"><b>{formatNumber(improvedPixels)}</b><small>cells faster or newly reached</small></span>
            <span><b>{formatNumber(worsenedPixels)}</b><small>cells slower or lost</small></span>
          </div> : null}
          {hasScenarioChanges && scenarioDifference ? <p className="reach-scenario-difference">
            {reachDelta(scenarioDifference.areaKm2, 2)} km² · {scenarioDifference.transitStops === null
              ? 'stop difference unavailable at this cutoff' : `${reachDelta(scenarioDifference.transitStops)} reached stops`} from baseline
          </p> : null}
        </section>
      ) : null}
    </section>
  )
}

const addCase = () => addScenario()
const inferGeometry = (interventionId: string) => { void inferScenarioRoadGeometry(interventionId) }
const clearOrigin = () => setAnalysisOrigin(null)
const runAnalysis = () => { void runSurfaceAnalysis() }
const runComparison = () => { void runComparisonAction() }
const runDecomposition = () => { void runServiceDecomposition() }

/** The Analyze workspace panel, reading the Analyze store and the open City. */
export const AnalyzePanel = memo(function AnalyzePanel() {
  countRender('AnalyzePanel')
  const settings = useStore(analyze, (state) => ({
    analyzeMode: state.analyzeMode,
    analysisOrigin: state.analysisOrigin,
    reachTimePreference: state.reachTimePreference,
    reachMaxWalkKm: state.reachMaxWalkKm,
    reachMaxTransfers: state.reachMaxTransfers,
    scenarioWalkSpeedKph: state.scenarioWalkSpeedKph,
    reachSurfaceSampling: state.reachSurfaceSampling,
    reachTravelMode: state.reachTravelMode,
    scenarioCutoffMinutes: state.scenarioCutoffMinutes,
    scenarioRenderMode: state.scenarioRenderMode,
    comparisonFeedIds: state.comparisonFeedIds,
    scenarioView: state.scenarioView,
    scenarioLoading: state.scenarioLoading,
    scenarioProgress: state.scenarioProgress,
    scenarioError: state.scenarioError,
    reachResult: state.reachResult,
    comparisonRun: state.comparisonRun,
    compareReferenceId: state.compareReferenceId,
    serviceDecomposition: state.serviceDecomposition,
    serviceDecompositionLoading: state.serviceDecompositionLoading,
    serviceDecompositionError: state.serviceDecompositionError,
  }), shallowEqual)
  const { serviceDate, scheduleTimeMinutes } = useStore(clock, (state) => state, shallowEqual)
  const library = useStudio(scenarioLibrary)
  const references = useStudio(compareReferenceOptions)
  const comparedScenarios = useStudio(compareScenarioIds)
  const activeInterventionId = useStudio(() => activeScenarioChange()?.id ?? '')
  const stopPlacement = useStudio(activeScenarioStopPlacement)
  const caseFeeds = useStudio(activeCaseFeeds)
  const groupsError = useStudio(() => cityGrouping().error)
  const feeds = useStudio(comparisonFeedOptions)
  const routes = useStudio(analysisRoutes)
  const stops = useStudio(() => preview().stops)
  const routeAnalysis = useStore(network, (state) => ({
    loading: Boolean(state.routeAnalysisRouteId),
    error: state.routeAnalysisError,
  }), shallowEqual)
  const data = useStudioRecord(() => {
    const project = selectedProject()
    return {
      routingStoreAvailable: Boolean(routingScope().nationalRoutingFeed),
      streetGraphAvailable: project.osmStreetIndex?.status === 'ready',
      streetGraphBuilding: project.osmStreetIndex?.status === 'building',
      routingStoreBuilding: project.routingStore?.status === 'building',
    }
  })
  const preparationTasks = useStudio(visiblePreparationTasks)

  return (
    <AnalyzePanelView
      mode={settings.analyzeMode}
      origin={settings.analysisOrigin}
      serviceDate={serviceDate}
      departMinutes={scheduleTimeMinutes}
      timePreference={settings.reachTimePreference}
      onTimePreferenceChange={changeReachTimePreference}
      maxWalkKm={settings.reachMaxWalkKm}
      maxTransfers={settings.reachMaxTransfers}
      walkSpeedKph={settings.scenarioWalkSpeedKph}
      travelMode={settings.analyzeMode === 'single' ? settings.reachTravelMode : 'transit'}
      onTravelModeChange={changeReachTravelMode}
      surfaceSampling={settings.reachSurfaceSampling}
      onSurfaceSamplingChange={changeSurfaceSampling}
      cutoffMinutes={settings.scenarioCutoffMinutes}
      renderMode={settings.scenarioRenderMode}
      cases={library.scenarioDrafts}
      caseGroupLabel={caseFeeds.group?.name ?? ''}
      scenarioGroups={library.grouping.value.groups}
      scenarioSaveState={library.saveState}
      onRenameCase={renameScenario}
      onAssignCaseGroup={assignScenarioGroup}
      feeds={feeds}
      comparisonFeedIds={settings.comparisonFeedIds}
      activeCaseId={library.activeScenarioId}
      activeInterventionId={activeInterventionId}
      stopPlacement={stopPlacement}
      routes={routes}
      stops={stops}
      routeAnalysisLoading={routeAnalysis.loading}
      routeAnalysisError={routeAnalysis.error}
      view={settings.scenarioView}
      loading={settings.scenarioLoading}
      progress={settings.scenarioProgress}
      error={settings.scenarioError || library.draftStorageError || (settings.analyzeMode === 'single' ? groupsError || caseFeeds.error : '')}
      analysis={settings.reachResult}
      comparisonRun={settings.comparisonRun}
      compareReferenceOptions={references}
      compareReferenceId={settings.compareReferenceId}
      compareScenarioIds={comparedScenarios}
      onCompareReferenceChange={changeCompareReference}
      onCompareScenarioChange={toggleCompareScenario}
      onSelectComparisonVariant={selectComparisonVariant}
      serviceDecomposition={settings.serviceDecomposition}
      serviceDecompositionLoading={settings.serviceDecompositionLoading}
      serviceDecompositionError={settings.serviceDecompositionError}
      routingStoreAvailable={data.routingStoreAvailable}
      streetGraphAvailable={data.streetGraphAvailable}
      preparationTasks={preparationTasks}
      streetGraphBuilding={data.streetGraphBuilding}
      routingStoreBuilding={data.routingStoreBuilding}
      onServiceDateChange={changeAnalysisServiceDate}
      onDepartMinutesChange={changeAnalysisDepartMinutes}
      onMaxWalkKmChange={changeReachMaxWalkKm}
      onMaxTransfersChange={changeReachMaxTransfers}
      onWalkSpeedChange={changeWalkSpeed}
      onCutoffChange={changeCutoff}
      onRenderModeChange={changeRenderMode}
      onModeChange={changeAnalyzeMode}
      onComparisonFeedChange={toggleComparisonFeed}
      onSelectCase={selectScenario}
      onAddCase={addCase}
      onRemoveCase={removeScenario}
      onAddIntervention={addScenarioChange}
      onSelectIntervention={selectScenarioChange}
      onUpdateIntervention={updateScenarioChange}
      onInferInterventionGeometry={inferGeometry}
      onUpdateInterventionRoute={updateScenarioChangeRoute}
      onBeginStopPlacement={beginScenarioStopPlacement}
      onCancelStopPlacement={cancelScenarioStopPlacement}
      onRemoveInterventionStop={removeScenarioStop}
      onResetInterventionStops={resetScenarioRouteStops}
      onRemoveIntervention={removeScenarioChange}
      onClearInterventionSketch={clearScenarioSketch}
      onViewChange={setScenarioView}
      onSetOrigin={setAnalysisOrigin}
      onClearOrigin={clearOrigin}
      onRun={runAnalysis}
      onRunComparison={runComparison}
      onRunServiceDecomposition={runDecomposition}
      onOpenData={openDataView}
      onCancel={cancelSurfaceAnalysis}
    />
  )
})
