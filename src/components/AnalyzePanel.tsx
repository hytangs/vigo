import { type CSSProperties, type FormEvent, memo, useEffect, useMemo } from 'react'
import { ArrowRight, Grid2x2, LoaderCircle, Radar, RotateCcw, Waypoints, X } from 'lucide-react'
import type { ApiProgress } from '../app/api'
import { countRender } from '../app/renderCounts'
import { shallowEqual, useStore } from '../app/store'
import {
  analyze,
  cancelSurfaceAnalysis,
  changeAnalysisDepartMinutes,
  changeAnalysisServiceDate,
  changeCutoff,
  changeReachMaxTransfers,
  changeReachMaxWalkKm,
  changeRenderMode,
  changeSurfaceSampling,
  changeReachTravelMode,
  changeReachTimePreference,
  changeWalkSpeed,
  runSurfaceAnalysis,
  setAnalysisOrigin,
  setScenarioView,
} from '../state/analyze'
import { clock } from '../state/clock'
import { useStudio, useStudioRecord } from '../state/hooks'
import { selectScenario } from '../state/scenarioEditor'
import { activeCaseFeeds, cityGrouping, scenarioLibrary } from '../state/scenarios'
import { preview, routingScope, selectedProject, visiblePreparationTasks } from '../state/scope'
import { preparationState, type PreparationTask } from '../app/preparation'
import { classNames, formatNumber, type StopMetric } from '../domain'
import type { RoutingPoint, RoutingTimePreference } from '../routingModel'
import { ResultMetric } from './UiPrimitives'
import { AnalysisOriginPicker } from './AnalysisOriginPicker'
import { OperationProgress } from './OperationProgress'
import { ReachSettings } from './ReachSettings'
import { ResultExportActions } from './ResultExportActions'
import { ScenarioNetworkPicker } from './scenarios/ScenarioNetworkPicker'
import { exportReachResults, reachExportEntries, reachGeometryAvailable } from '../app/resultExports'
import { reachTransitStops, reachScenarioDifference } from '../app/resultSummary'
import { scenarioNetworkDiffers } from '../app/scenarioLibrary'
import type { CityDataGroup } from '../app/cityDataGroups'
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
  type ReachTransitStatus,
  type ScenarioDraft,
  type ReachResult,
  type ScenarioRenderMode,
  type ScenarioView,
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
  /** Saved scenarios; Reach compares the active one with the published baseline. */
  cases: ScenarioDraft[]
  scenarioGroups?: CityDataGroup[]
  activeCaseId: string
  stops: StopMetric[]
  view: ScenarioView
  loading: boolean
  progress: ApiProgress | null
  error: string
  analysis: ReachResult | null
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
  onSelectCase?: (caseId: string) => void
  onViewChange: (view: ScenarioView) => void
  onClearOrigin: () => void
  onSetOrigin?: (point: RoutingPoint) => void
  onRun: () => void
  onCancel: () => void
}

const scenarioViewOptions = [
  ['baseline', 'Baseline'],
  ['scenario', 'Scenario'],
  ['comparison', 'Difference'],
] as const satisfies ReadonlyArray<readonly [ScenarioView, string]>

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

export function AnalyzePanelView({
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
  scenarioGroups = [],
  activeCaseId,
  stops,
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
  onServiceDateChange,
  onDepartMinutesChange,
  onMaxWalkKmChange,
  onMaxTransfersChange,
  onWalkSpeedChange,
  onCutoffChange,
  onRenderModeChange,
  onSelectCase = () => {},
  onViewChange,
  onClearOrigin,
  onSetOrigin,
  onRun,
  onCancel,
}: AnalyzePanelProps) {
  const activeCase = cases.find((entry) => entry.id === activeCaseId) ?? cases[0]
  const interventions = activeCase?.interventions ?? []
  const hasPolicyChanges = travelMode !== 'drive' && interventions.length > 0
  const hasScenarioChanges = travelMode !== 'drive' && (hasPolicyChanges || scenarioNetworkDiffers(scenarioGroups, activeCase?.groupId))
  // An arrive-by Reach anchors at its destination and reads the clock as a deadline.
  const arriveBy = timePreference === 'arrive'
  const place = arriveBy ? 'destination' : 'origin'
  useEffect(() => {
    if (hasPolicyChanges && surfaceSampling === 'cell-center') onSurfaceSamplingChange?.('street')
  }, [hasPolicyChanges, travelMode, onTravelModeChange, surfaceSampling, onSurfaceSamplingChange])
  const improvedPixels = useMemo(() => scenarioImprovedPixels(analysis, cutoffMinutes), [analysis, cutoffMinutes])
  const worsenedPixels = useMemo(() => scenarioWorsenedPixels(analysis, cutoffMinutes), [analysis, cutoffMinutes])
  const scenarioDifference = useMemo(() => analysis ? reachScenarioDifference(analysis, cutoffMinutes) : null, [analysis, cutoffMinutes])
  const analysisExportEntries = useMemo(() => reachExportEntries(analysis), [analysis, cutoffMinutes])
  // A line set to follow roads runs once its path is traced in Scenarios.
  const untraced = travelMode === 'drive' ? undefined : interventions.find((intervention) => (
    ['add-line', 'enhance-line', 'change-line'].includes(intervention.kind)
    && intervention.geometryMode === 'auto-road'
    && intervention.geometryStatus !== 'ready'
  ))
  const canRun = Boolean(origin && streetGraphAvailable && !loading && !untraced && routingStoreAvailable)
  const transitSetup = preparationState(routingStoreAvailable,
    preparationTasks, ['national-gtfs-import', 'national-gtfs-merge'], routingStoreBuilding)
  const streetSetup = preparationState(streetGraphAvailable, preparationTasks, ['national-osm-import'], streetGraphBuilding)
  const dataPreparing = [transitSetup, streetSetup].some((state) => state.status === 'working')
  const setupHint = !streetGraphAvailable || !routingStoreAvailable
    ? [transitSetup, streetSetup].some((state) => state.status === 'paused')
      ? 'Task updates are paused. Open background tasks to reconnect.'
      : dataPreparing ? `Data is being prepared. You can choose the ${place} while it runs.`
        : 'Finish the data setup above, then run the analysis.'
    : !origin ? onSetOrigin ? 'Search for a stop above or click the map.' : `Click the map to choose ${arriveBy ? 'a destination' : 'an origin'}.`
      : untraced ? `Trace ${untraced.name} along roads in Scenarios before running Reach.` : ''

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canRun) return
    onRun()
  }

  return (
    <section className="reach-surface" aria-label="Reach analysis controls">
      <header className="inspector-head reach-analysis-switch">
        <strong>Reach</strong>
        <button type="button" className="kit-icon-button reach-new" onClick={onClearOrigin} disabled={!origin} aria-label="New Reach" title={`Clear the ${place} and start a new Reach`}>
          <RotateCcw size={15} aria-hidden="true" />
        </button>
      </header>
      <form className="reach-form" onSubmit={submit}>

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
                value={`${String(Math.floor(Math.round(departMinutes) / 60) % 24).padStart(2, '0')}:${String(Math.round(departMinutes) % 60).padStart(2, '0')}`}
                onChange={(event) => {
                  const value = event.currentTarget.value
                  if (!/^\d{2}:\d{2}$/.test(value)) return
                  const [hours, minutes] = value.split(':').map(Number)
                  if (hours < 24 && minutes < 60) onDepartMinutesChange(hours * 60 + minutes)
                }}
              />
            </label>
          </div>
        </div>

        <ReachSettings travelMode={travelMode} onTravelModeChange={onTravelModeChange} timePreference={timePreference} cutoffMinutes={cutoffMinutes} maxWalkKm={maxWalkKm} walkSpeedKph={walkSpeedKph}
          maxTransfers={maxTransfers} surfaceSampling={surfaceSampling} hasScenarioChanges={hasPolicyChanges}
          onCutoffChange={onCutoffChange} onMaxWalkKmChange={onMaxWalkKmChange} onWalkSpeedChange={onWalkSpeedChange}
          onMaxTransfersChange={onMaxTransfersChange} onSurfaceSamplingChange={onSurfaceSamplingChange} />

        {travelMode !== 'drive' && cases.length ? (
          <ScenarioNetworkPicker label="Compare with" ariaLabel="Reach network" value={activeCase?.id ?? ''}
            options={cases.map((entry) => ({ id: entry.id, name: entry.name || 'Untitled scenario' }))} onChange={onSelectCase} />
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
              : analysis ? 'Update Reach' : 'Run Reach'}
          </button>
          {loading || !canRun ? (
            <small className="reach-run-hint">
              {loading ? (travelMode === 'drive' ? 'Computing driving times across the map…' : 'Computing the complete reached-street surface…') : setupHint}
            </small>
          ) : null}
          {loading ? (
            <OperationProgress phase={progress?.phase || 'Starting analysis'} detail={progress?.detail} work={progress?.work} profile="reach:single" />
          ) : null}
        </div>

        {error ? <p className="reach-inline-note is-error" role="alert">{error}</p> : null}
      </form>

      {analysis ? (
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

const clearOrigin = () => setAnalysisOrigin(null)
const runAnalysis = () => { void runSurfaceAnalysis() }

/** The Analyze workspace panel, reading the Analyze store and the open City. */
export const AnalyzePanel = memo(function AnalyzePanel() {
  countRender('AnalyzePanel')
  const settings = useStore(analyze, (state) => ({
    analysisOrigin: state.analysisOrigin,
    reachTimePreference: state.reachTimePreference,
    reachMaxWalkKm: state.reachMaxWalkKm,
    reachMaxTransfers: state.reachMaxTransfers,
    scenarioWalkSpeedKph: state.scenarioWalkSpeedKph,
    reachSurfaceSampling: state.reachSurfaceSampling,
    reachTravelMode: state.reachTravelMode,
    scenarioCutoffMinutes: state.scenarioCutoffMinutes,
    scenarioRenderMode: state.scenarioRenderMode,
    scenarioView: state.scenarioView,
    scenarioLoading: state.scenarioLoading,
    scenarioProgress: state.scenarioProgress,
    scenarioError: state.scenarioError,
    reachResult: state.reachResult,
  }), shallowEqual)
  const { serviceDate, scheduleTimeMinutes } = useStore(clock, (state) => state, shallowEqual)
  const library = useStudio(scenarioLibrary)
  const caseFeeds = useStudio(activeCaseFeeds)
  const groupsError = useStudio(() => cityGrouping().error)
  const stops = useStudio(() => preview().stops)
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
      origin={settings.analysisOrigin}
      serviceDate={serviceDate}
      departMinutes={scheduleTimeMinutes}
      timePreference={settings.reachTimePreference}
      onTimePreferenceChange={changeReachTimePreference}
      maxWalkKm={settings.reachMaxWalkKm}
      maxTransfers={settings.reachMaxTransfers}
      walkSpeedKph={settings.scenarioWalkSpeedKph}
      travelMode={settings.reachTravelMode}
      onTravelModeChange={changeReachTravelMode}
      surfaceSampling={settings.reachSurfaceSampling}
      onSurfaceSamplingChange={changeSurfaceSampling}
      cutoffMinutes={settings.scenarioCutoffMinutes}
      renderMode={settings.scenarioRenderMode}
      cases={library.scenarioDrafts}
      scenarioGroups={library.grouping.value.groups}
      activeCaseId={library.activeScenarioId}
      stops={stops}
      view={settings.scenarioView}
      loading={settings.scenarioLoading}
      progress={settings.scenarioProgress}
      error={settings.scenarioError || library.draftStorageError || (groupsError || caseFeeds.error)}
      analysis={settings.reachResult}
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
      onSelectCase={selectScenario}
      onViewChange={setScenarioView}
      onSetOrigin={setAnalysisOrigin}
      onClearOrigin={clearOrigin}
      onRun={runAnalysis}
      onCancel={cancelSurfaceAnalysis}
    />
  )
})
