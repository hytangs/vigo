import { ProjectsPage, StorageRecovery } from './components/studio/CityLibrary'
import { BundlePanel, DataReadinessRail, EmptyOperationsStart, FeedTables, ImportPanel } from './components/studio/CitySources'
import { RouteSurface } from './components/studio/RouteSurface'
import { VigoSidebar } from './components/studio/StudioSidebar'
import { quietMapLabel, type MapScope } from './components/studio/presentation'

import { ArrowLeft, XCircle } from 'lucide-react'
import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import type { OperationalEvent, ToolResult } from './agency/types'
import { apiJson, apiProgressJson, type ApiProgress } from './app/api'
import { requestDesktopHomeFolder, subscribeDesktopCommands, syncDesktopChromeState } from './app/desktopBridge'
import { mergeGtfsRouteAnalysis, routeHasCompleteGtfsAnalysis, type GtfsRouteAnalysis } from './app/gtfsAnalysis'
import { filterPreviewByStatus, previewForSelectedRoute } from './app/mapPresentation'
import { readNavigationMemory, rememberProject, rememberRoute, rememberSearchResult } from './app/navigationMemory'
import type { NetworkScheduleResult } from './app/networkScheduleCollection'
import { findNetworkRoute, findNetworkStop, networkRouteId } from './app/networkSelection'
import { startPolling } from './app/polling'
import { isActiveTask, isPreparationJob, preparationTasks, updateProjectJob, type PreparationTask } from './app/preparation'
import { useProjectDetailHydration } from './app/projectHydration'
import {
  bundleFeedId,
  emptyCityProject,
  hasOperationsData,
  mergeProjectLists,
  mergeProjectState,
  needsProjectDetail,
  preferredProjectId,
  scopedFeedAndPreview,
} from './app/projectState'
import { realtimeRefreshMs, type RealtimeInspectRequest } from './app/realtime'
import { readRoutingDataModePreference, saveRoutingDataModePreference } from './app/routingDataMode'
import { buildRoutingActivity, localCalendarDate, serviceDayForCalendarDate, type RoutingServiceCoverage } from './app/routingPlan'
import type { AppAccent, HealthResponse, ProjectDialogState, ProjectDraft, SetupDraft, VigoRuntimeConfig } from './app/runtimeConfig'
import { scenarioStorageKey } from './app/scenarioDraftStorage'
import { createScenarioRoadGeometryRequest } from './app/scenarioRoadGeometryRequest'
import { type RoutingDepartureWindowMinutes } from './app/uiOptions'
import { useNationalRouting } from './app/useNationalRouting'
import { useScenarioDrafts } from './app/useScenarioDrafts'
import { useStreetPreparation } from './app/useStreetPreparation'
import { AgencyPanel } from './components/AgencyPanel'
import { AnalyzePanel, type AnalyzeMode, type ComparisonFeedOption } from './components/AnalyzePanel'
import { BackgroundTasks } from './components/BackgroundTasks'
import { CityPanel, type DataSection } from './components/CityPanel'
import { CitySourceDelete } from './components/CitySourceDelete'
import { NetworkTimetable } from './components/NetworkTimetable'
import { RoutingDetailPanel, type RoutingScopeStatus } from './components/PathfinderPanel'
import { PrimaryNav, type RouteToolKey } from './components/PrimaryNav'
import { FirstRunSetupDialog, ProjectEditorDialog } from './components/ProjectDialogs'
import type { TripTarget } from './components/StopArrivalBoard'
import { IconButton, VigoBrandMark } from './components/UiPrimitives'
import type { JobRecord } from './domain'
import {
  classNames,
  formatNumber,
  initialLayers,
  type Appearance,
  type Basemap,
  type GtfsRouteStatusFilter,
  type LayerState,
  type NetworkLens,
  type RealtimeSnapshot,
  type RouteMetric,
  type VigoProject,
} from './domain'
import { SearchPalette } from './features/search/SearchPalette'
import { buildSearchResults, type SearchResult } from './features/search/searchModel'
import { journeyContinuityIssue } from './journeyIntegrity.mjs'
import { entityFeedScope } from './networkTruth'
import {
  joinScenarioSegmentGeometry,
  routeHasPublishedShape,
  scenarioEdgeEditError,
  scenarioEdgeGeometryForBranch,
  scenarioEdgeIndexes,
  scenarioInsertedStopsForEdge,
  scenarioInsertionAnchors,
  scenarioPublishedShapeSegmentIndexes,
  scenarioSegmentRuntimeMinutes,
  scenarioSourceRouteId,
  scenarioStopFromRoutingPoint,
  scenarioStopsForEdgeBranch,
  scenarioStopsForRoute,
  type ReachComparisonResult,
  type ReachResult,
  type ScenarioChangeDraft,
  type ScenarioChangeKind,
  type ScenarioDraft,
  type ScenarioGeometryMode,
  type ScenarioRenderMode,
  type ScenarioRouteScope,
  type ScenarioServiceDraft,
  type ScenarioStopDraft,
  type ScenarioStopPlacement,
  type ScenarioTimeModel,
  type ScenarioView,
  type ServiceEdgeDecomposition,
} from './reach'
import { scopedRouteServiceKey, type RouteRenderMode } from './routeServices'
import {
  type RoutingDataMode,
  type RoutingPlan,
  type RoutingPoint,
  type RoutingTimePreference,
  type RoutingTravelMode,
} from './routingModel'
import {
  appendRoutingPointSequence,
  insertRoutingPointBeforeDestination,
  maxRoutingPointCount,
  normalizeOrderedRoutingPoints,
  parseRoutingCoordinate,
} from './routingPointSequence'
import { buildNetworkSearchIndex, buildRoutingPointFromMap, parseRoutingCommand } from './routingUi'
import { type ServiceVehicleMode } from './serviceVehicles'
const desktopReachRasterSize = 128

function newScenarioChange(
  kind: ScenarioChangeKind,
): ScenarioChangeDraft {
  const changesGeometry = kind === 'add-line' || kind === 'change-line'
  return {
    id: `intervention-${crypto.randomUUID()}`,
    kind,
    name: kind.replaceAll('-', ' '),
    stops: [],
    headwayMinutes: 10,
    averageSpeedKph: 25,
    startMinutes: 5 * 60,
    endMinutes: 25 * 60,
    bidirectional: kind === 'add-line',
    routeScope: kind === 'add-line' ? undefined : 'pattern',
    timeModel: changesGeometry ? 'infer-road' : 'preserve-scheduled',
    geometryMode: changesGeometry ? 'auto-road' : 'published-shape',
    geometryStatus: 'idle',
  }
}

function newScenarioDraft(index: number): ScenarioDraft {
  return {
    id: `case-${crypto.randomUUID()}`,
    name: `Case ${String.fromCharCode(65 + index)}`,
    interventions: [],
  }
}

function latestCoverageDateForWeekday(completeEndDate: string, weekday: number) {
  const end = new Date(`${completeEndDate}T12:00:00`)
  if (Number.isNaN(end.getTime())) return completeEndDate
  for (let offset = 0; offset < 7; offset += 1) {
    const candidate = new Date(end)
    candidate.setDate(end.getDate() - offset)
    if (candidate.getDay() !== weekday) continue
    const year = candidate.getFullYear()
    const month = String(candidate.getMonth() + 1).padStart(2, '0')
    const day = String(candidate.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }
  return completeEndDate
}

function latestCoverageDateMatchingWeekday(completeEndDate: string, preferredDate: string) {
  const preferred = new Date(`${preferredDate}T12:00:00`)
  return Number.isNaN(preferred.getTime())
    ? completeEndDate
    : latestCoverageDateForWeekday(completeEndDate, preferred.getDay())
}

function latestMidweekCoverageDate(completeEndDate: string) {
  return latestCoverageDateForWeekday(completeEndDate, 3)
}

function scrollWorkbenchToTop() {
  requestAnimationFrame(() => {
    document.querySelector('.workbench')?.scrollTo({ top: 0, left: 0, behavior: 'smooth' })
  })
}

const emptyRoutingPoints: RoutingPoint[] = []
const emptyScenarioStops: ScenarioStopDraft[] = []
const emptyCoordinates: [number, number][] = []

export default function App() {
  const [appearance, setAppearance] = useState<Appearance>('dark')
  const [accent, setAccent] = useState<AppAccent>('blue')
  const [basemap, setBasemap] = useState<Basemap>('offline')
  const [projects, setProjects] = useState<VigoProject[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [openedNetworkProjectId, setOpenedNetworkProjectId] = useState('')
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [runtimeConfig, setRuntimeConfig] = useState<VigoRuntimeConfig | null>(null)
  const [setupOpen, setSetupOpen] = useState(false)
  const [setupBusy, setSetupBusy] = useState(false)
  const [setupError, setSetupError] = useState('')
  const [apiError, setApiError] = useState('')
  const [layers, setLayers] = useState<LayerState>(initialLayers)
  const [operationalEvents, setOperationalEvents] = useState<OperationalEvent[]>([])
  const [vehicleMode, setVehicleMode] = useState<ServiceVehicleMode>('schedule')
  const [selectedRouteId, setSelectedRouteId] = useState('')
  const [selectedStopId, setSelectedStopId] = useState('')
  const routeAnalysisAbortRef = useRef<AbortController | null>(null)
  const routeAnalysisKeyRef = useRef('')
  const routeAnalysisRequestIdRef = useRef(0)
  const [routeAnalysisRouteId, setRouteAnalysisRouteId] = useState('')
  const [routeAnalysisError, setRouteAnalysisError] = useState('')
  const [mapScope, setMapScope] = useState<MapScope>('network')
  const [routeRenderMode, setRouteRenderMode] = useState<RouteRenderMode>('service')
  const [networkLens, setNetworkLens] = useState<NetworkLens>('network')
  const [scheduleTimeMinutes, setScheduleTimeMinutes] = useState(8 * 60)
  const [routingServiceDate, setRoutingServiceDate] = useState(() => localCalendarDate())
  const [routingResidencyCoverage, setRoutingResidencyCoverage] = useState<RoutingServiceCoverage | null>(null)
  const [routingTimePreference, setRoutingTimePreference] = useState<RoutingTimePreference>('depart')
  const [routingMode, setRoutingMode] = useState<RoutingTravelMode>('transit')
  const [routingDataMode, setRoutingDataMode] = useState<RoutingDataMode>(readRoutingDataModePreference)
  useEffect(() => { saveRoutingDataModePreference(routingDataMode) }, [routingDataMode])
  const [routingDepartureWindowMinutes, setRoutingDepartureWindowMinutes] = useState<RoutingDepartureWindowMinutes>(20)
  const [routingMaxWalkKm, setRoutingMaxWalkKm] = useState(1.2)
  const [routingMaxTransfers, setRoutingMaxTransfers] = useState<number | undefined>()
  const [routingAllowLongWalk, setRoutingAllowLongWalk] = useState(true)
  const [selectedRoutingPlanId, setSelectedRoutingPlanId] = useState('')
  const [routingEnabled, setRoutingEnabled] = useState(false)
  const [routingPickIndex, setRoutingPickIndex] = useState<number | null>(null)
  const [routingOrigin, setRoutingOrigin] = useState<RoutingPoint | null>(null)
  const [routingWaypoints, setRoutingWaypoints] = useState<RoutingPoint[]>([])
  const [routingDestination, setRoutingDestination] = useState<RoutingPoint | null>(null)
  const [analysisOrigin, setAnalysisOrigin] = useState<RoutingPoint | null>(null)
  const [analyzeMode, setAnalyzeMode] = useState<AnalyzeMode>('single')
  const [agencyPlan, setAgencyPlan] = useState<RoutingPlan | null>(null)
  const [agencyLocation, setAgencyLocation] = useState<{ id: string; label: string; coordinate: [number, number]; stopId?: string } | undefined>()
  const [agencyReach, setAgencyReach] = useState<ReachResult | null>(null)
  const [reachResult, setReachResult] = useState<ReachResult | null>(null)
  const [reachComparison, setReachComparison] = useState<ReachComparisonResult[] | null>(null)
  const [serviceDecomposition, setServiceDecomposition] = useState<ServiceEdgeDecomposition | null>(null)
  const [serviceDecompositionLoading, setServiceDecompositionLoading] = useState(false)
  const [serviceDecompositionError, setServiceDecompositionError] = useState('')
  const [scenarioLoading, setScenarioLoading] = useState(false)
  const [scenarioProgress, setScenarioProgress] = useState<ApiProgress | null>(null)
  const [scenarioError, setScenarioError] = useState('')
  const [scenarioCutoffMinutes, setScenarioCutoffMinutes] = useState(45)
  const [scenarioWalkSpeedKph, setScenarioWalkSpeedKph] = useState(4.8)
  const [scenarioView, setScenarioView] = useState<ScenarioView>('comparison')
  const [scenarioRenderMode, setScenarioRenderMode] = useState<ScenarioRenderMode>('area')
  const { scenarioDrafts, setScenarioDrafts, activeScenarioId, setActiveScenarioId,
    activeScenarioChangeId, setActiveScenarioChangeId, draftStorageError } = useScenarioDrafts(
    scenarioStorageKey(projects.find((project) => project.id === selectedProjectId)),
  )
  const [comparisonFeedIds, setComparisonFeedIds] = useState<string[]>([])
  const comparisonFeedInitializationRef = useRef(false)
  const [scenarioStopPlacement, setScenarioStopPlacement] = useState<ScenarioStopPlacement | null>(null)
  const analysisAbortRef = useRef<AbortController | null>(null)
  const scenarioRoadGeometryAbortRef = useRef<AbortController | null>(null)
  const scenarioRoadGeometryRequestIdRef = useRef(0)
  const serviceDecompositionAbortRef = useRef<AbortController | null>(null)
  const invalidateAnalyzeResult = useCallback(() => {
    analysisAbortRef.current?.abort()
    analysisAbortRef.current = null
    scenarioRoadGeometryAbortRef.current?.abort()
    scenarioRoadGeometryAbortRef.current = null
    scenarioRoadGeometryRequestIdRef.current += 1
    serviceDecompositionAbortRef.current?.abort()
    serviceDecompositionAbortRef.current = null
    setReachResult(null)
    setReachComparison(null)
    setServiceDecomposition(null)
    setServiceDecompositionLoading(false)
    setServiceDecompositionError('')
    setScenarioError('')
    setScenarioLoading(false)
    setScenarioProgress(null)
  }, [])
  const [routingPointError, setRoutingPointError] = useState('')
  const routingDateAutoAlignedStoreRef = useRef('')
  const [osmStreetMessage, setOsmStreetMessage] = useState('')
  const [isImporting, setIsImporting] = useState(false)
  const [isOsmImporting, setIsOsmImporting] = useState(false)
  const [gtfsImportJobId, setGtfsImportJobId] = useState('')
  const [osmImportJobId, setOsmImportJobId] = useState('')
  const [importMessage, setImportMessage] = useState('')
  const importPollingPromisesRef = useRef(new Map<string, Promise<JobRecord>>())
  const [pendingPreparations, setPendingPreparations] = useState<Record<string, PreparationTask>>({})
  const [preparationErrors, setPreparationErrors] = useState<Record<string, string>>({})
  const [preparationJobUpdates, setPreparationJobUpdates] = useState<Record<string, JobRecord>>({})
  const [backgroundTasksOpen, setBackgroundTasksOpen] = useState(false)
  const routingMergeRequestRef = useRef('')
  const [routingMergeRetryNonce, setRoutingMergeRetryNonce] = useState(0)
  const [realtimeSnapshot, setRealtimeSnapshot] = useState<RealtimeSnapshot | null>(null)
  const [realtimeMessage, setRealtimeMessage] = useState('')
  const [isRealtimeLoading, setIsRealtimeLoading] = useState(false)
  const [realtimeRequest, setRealtimeRequest] = useState<RealtimeInspectRequest | null>(null)
  const realtimeInFlightRef = useRef(false)
  const realtimeAbortRef = useRef<AbortController | null>(null)
  const realtimeRequestIdRef = useRef(0)
  const [query, setQuery] = useState('')
  const navigationMemoryRef = useRef(readNavigationMemory())
  const [recentSearchIds, setRecentSearchIds] = useState(navigationMemoryRef.current.recentSearchIds)
  const deferredQuery = useDeferredValue(query)
  const [statusFilter, setStatusFilter] = useState<GtfsRouteStatusFilter>('all')
  const [page, setPage] = useState<'projects' | 'project'>('projects')
  const [activeFeedId, setActiveFeedId] = useState(bundleFeedId)
  const [activeRouteTool, setActiveRouteTool] = useState<RouteToolKey>(() => { const saved = sessionStorage.getItem('vigo-agency-view'); return ['data', 'pathfinder', 'analyze', 'agency'].includes(saved || '') ? saved as RouteToolKey : 'agency' })
  useEffect(() => { sessionStorage.setItem('vigo-agency-view', activeRouteTool) }, [activeRouteTool])
  const [dataSection, setDataSection] = useState<DataSection>('feeds')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [agencyMapOpen, setAgencyMapOpen] = useState(false)
  const [agencyTripTarget, setAgencyTripTarget] = useState<{ routeId: string; tripId: string; serviceDate: string } | undefined>()
  const [agencyBrowseRequest, setAgencyBrowseRequest] = useState(0)
  const [projectDialog, setProjectDialog] = useState<ProjectDialogState | null>(null)
  const [projectDialogBusy, setProjectDialogBusy] = useState(false)
  const [projectDialogError, setProjectDialogError] = useState('')
  const changeRoutingServiceDate = useCallback((serviceDate: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) return
    try {
      serviceDayForCalendarDate(serviceDate)
    } catch {
      return
    }
    setRoutingServiceDate(serviceDate)
    setSelectedRoutingPlanId('')
  }, [])
  const {
    beginCitySelection,
    cancelProjectDetail,
    cityPreviewLoadingProjectId,
  } = useProjectDetailHydration({
    projects,
    selectedProjectId,
    setProjects,
    onSelectProject: applyCitySelection,
    onError: setApiError,
  })

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? projects[0] ?? emptyCityProject(health?.storageRoot),
    [projects, selectedProjectId, health?.storageRoot],
  )
  const preparationJobs = selectedProject.jobs.map((job) => preparationJobUpdates[job.id] ?? job)
  const streetPreparation = useStreetPreparation({
    active: page === 'project' && selectedProject.osmStreetIndex?.status === 'ready' && !isOsmImporting,
    projectId: selectedProject.id,
    identity: `${selectedProject.osmStreetIndex?.builtAt ?? ''}:${selectedProject.osmStreetIndex?.bytes ?? ''}`,
    refreshKey: activeRouteTool === 'pathfinder' ? routingMode : '',
  })
  const latestGtfsJob = [...preparationJobs]
    .filter((job) => job.kind === 'national-gtfs-import')
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
  const visiblePreparationTasks = preparationTasks(preparationJobs,
    [
      ...Object.entries(pendingPreparations).filter(([key]) => key.startsWith(`${selectedProject.id}:`)).map(([, task]) => task),
      ...(cityPreviewLoadingProjectId === selectedProject.id ? [{ id: `${selectedProject.id}:loading`, kind: 'city-data-load', label: selectedProject.name, status: 'running' as const, phase: 'Loading transit feeds and map data', createdAt: selectedProject.updatedAt }] : []),
      ...(streetPreparation.task ? [streetPreparation.task] : []),
    ],
    preparationErrors)
  const selectedPreparationProjectRef = useRef(selectedProject.id)
  selectedPreparationProjectRef.current = selectedProject.id
  const latestOsmJob = [...preparationJobs]
    .filter((job) => job.kind === 'national-osm-import')
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
  const gtfsImportJob = preparationJobs.find((job) => job.id === gtfsImportJobId) ?? latestGtfsJob
  const osmImportJob = preparationJobs.find((job) => job.id === osmImportJobId) ?? latestOsmJob
  const latestActiveGtfsJob = preparationJobs.find((job) => (
    job.kind === 'national-gtfs-import' && ['queued', 'running'].includes(job.status)
  ))
  const latestActiveOsmJob = preparationJobs.find((job) => (
    job.kind === 'national-osm-import' && ['queued', 'running'].includes(job.status)
  ))
  useEffect(() => {
    if (latestActiveGtfsJob) {
      setGtfsImportJobId(latestActiveGtfsJob.id)
      setIsImporting(true)
    } else if (gtfsImportJobId && gtfsImportJob?.status && gtfsImportJob.status !== 'running' && gtfsImportJob.status !== 'queued') {
      setIsImporting(false)
    }
    if (latestActiveOsmJob) {
      setOsmImportJobId(latestActiveOsmJob.id)
      setIsOsmImporting(true)
    } else if (osmImportJobId && osmImportJob?.status && osmImportJob.status !== 'running' && osmImportJob.status !== 'queued') {
      setIsOsmImporting(false)
    }
  }, [gtfsImportJob, gtfsImportJobId, latestActiveGtfsJob, latestActiveOsmJob, osmImportJob, osmImportJobId])
  const cityPreviewLoading = Boolean(cityPreviewLoadingProjectId)
  const activeScope = useMemo(() => scopedFeedAndPreview(selectedProject, activeFeedId), [selectedProject, activeFeedId])
  const activeFeed = activeScope.feed
  const preview = activeScope.preview
  const comparisonFeedOptions = useMemo<ComparisonFeedOption[]>(
    () => selectedProject.feeds
      .filter((feed) => feed.routingStore?.status === 'ready')
      .map((feed) => ({
        id: feed.id,
        name: quietMapLabel(feed.name || feed.fileName || feed.id),
        routeCount: Number(feed.routeCount ?? 0),
        stopCount: Number(feed.stopCount ?? 0),
        tripCount: Number(feed.tripCount ?? 0),
      })),
    [selectedProject.feeds],
  )
  const comparisonStoreIdentity = comparisonFeedIds.map((feedId) => {
    const feed = selectedProject.feeds.find((candidate) => candidate.id === feedId)
    return `${feedId}:${feed?.routingStore?.builtAt ?? ''}`
  }).join('|')
  const scopedRoutingFeeds = activeFeedId === bundleFeedId
    ? selectedProject.feeds
    : activeFeed.id === bundleFeedId
      ? []
      : [activeFeed]
  const projectRoutingFeed = activeFeedId === bundleFeedId && selectedProject.routingStore?.status === 'ready'
    ? { ...activeFeed, id: '__project__', routingStore: selectedProject.routingStore }
    : null
  const nationalRoutingFeed = projectRoutingFeed ?? (scopedRoutingFeeds.length === 1 && scopedRoutingFeeds[0]?.routingStore?.status === 'ready'
    ? scopedRoutingFeeds[0]
    : null)
  const readyBundleFeedCount = selectedProject.feeds.filter((feed) => feed.routingStore?.status === 'ready').length
  const routingScopeStatus: RoutingScopeStatus = nationalRoutingFeed
    ? 'ready'
    : activeFeedId === bundleFeedId && selectedProject.routingStore?.status === 'failed'
      ? 'failed'
      : activeFeedId === bundleFeedId && (
          selectedProject.routingStore?.status === 'building'
          || readyBundleFeedCount > 1
        )
        ? 'building'
      : 'missing'
  const nationalRoutingStoreKey = nationalRoutingFeed
    ? `${selectedProject.id}:${nationalRoutingFeed.id}:${nationalRoutingFeed.routingStore?.builtAt ?? ''}`
    : ''
  const reachInputIdentity = [
    nationalRoutingStoreKey,
    comparisonStoreIdentity,
    selectedProject.osmStreetIndex?.builtAt ?? '',
    routingServiceDate,
    scheduleTimeMinutes,
    routingMaxWalkKm,
  ].join(':')
  const cityRoutingActive = page === 'project' && Boolean(nationalRoutingFeed)
  const storeBackedRouting = Boolean(nationalRoutingFeed)
  const routingServiceDay = serviceDayForCalendarDate(routingServiceDate)
  const mapPointRoutingNeedsStreetGraph = routingMode !== 'transit' || Boolean(
    routingOrigin && routingDestination &&
    [routingOrigin, ...routingWaypoints, routingDestination].some((point) => point.source === 'map'),
  )
  const routingStreetState: 'ready' | 'loading' | 'missing' = routingMode !== 'transit'
    ? selectedProject.osmStreetIndex?.status === 'ready'
      ? streetPreparation.ready ? 'ready' : 'loading'
      : selectedProject.osmStreetIndex?.status === 'building' || isOsmImporting ? 'loading' : 'missing'
    : !mapPointRoutingNeedsStreetGraph ||
    Boolean(nationalRoutingFeed && selectedProject.osmStreetIndex?.status === 'ready')
    ? 'ready'
    : selectedProject.osmStreetIndex?.status === 'building'
      ? 'loading'
      : 'missing'
  const nationalRouting = useNationalRouting({
    active: Boolean(
      page === 'project' && nationalRoutingFeed
      && activeRouteTool === 'pathfinder',
    ),
    projectId: selectedProject.id,
    feedId: nationalRoutingFeed?.id ?? '',
    storeKey: nationalRoutingStoreKey,
    streetKey: `${selectedProject.osmStreetIndex?.builtAt ?? ''}:${selectedProject.osmStreetIndex?.bytes ?? ''}`,
    origin: routingOrigin,
    waypoints: routingWaypoints,
    destination: routingDestination,
    mode: routingMode,
    routingDataMode,
    departMinutes: scheduleTimeMinutes,
    timePreference: routingTimePreference,
    serviceDay: routingServiceDay,
    serviceDate: routingServiceDate,
    maxWalkKm: routingMaxWalkKm,
    maxTransfers: routingMaxTransfers,
    allowLongWalk: routingAllowLongWalk,
    departureWindowMinutes: routingDepartureWindowMinutes,
    realtimeSnapshot,
    routeAllowed: routingStreetState === 'ready',
  })
  const routingMergeSourceIdentity = selectedProject.feeds
    .filter((feed) => feed.routingStore?.status === 'ready')
    .map((feed) => `${feed.id}:${feed.routingStore?.builtAt ?? ''}`)
    .sort()
    .join('|')
  useEffect(() => {
    if (
      page !== 'project'
      || activeFeedId !== bundleFeedId
      || readyBundleFeedCount < 2
      || selectedProject.routingStore?.status === 'ready'
      || !routingMergeSourceIdentity
    ) return
    const requestKey = `${selectedProject.id}:${routingMergeSourceIdentity}`
    if (routingMergeRequestRef.current === requestKey) return
    routingMergeRequestRef.current = requestKey
    let cancelled = false
    void apiJson<{ job: { id: string; status?: string } }>(
      `/api/projects/${encodeURIComponent(selectedProject.id)}/national-routing-merge`,
      {
        method: 'POST',
        body: JSON.stringify({
          preloadServiceDate: routingServiceDate,
          preloadServiceDay: routingServiceDay,
        }),
      },
    ).then(async ({ job }) => {
      if (cancelled) return
      await refreshImportedProject(selectedProject.id, false)
      if (job.status !== 'complete') {
        await waitForImportJob(selectedProject.id, job.id, () => {}, 'Combined GTFS routing build failed')
      }
      if (!cancelled) await refreshImportedProject(selectedProject.id, true)
    }).catch((error) => {
      if (cancelled) return
      const message = error instanceof Error ? error.message : 'Combined GTFS routing build failed'
      if (/already has a GTFS import in progress|At least two ready GTFS feeds/i.test(message)) return
      setApiError(message)
    })
    return () => {
      cancelled = true
    }
  }, [
    activeFeedId,
    page,
    readyBundleFeedCount,
    routingMergeSourceIdentity,
    routingServiceDate,
    routingServiceDay,
    selectedProject.id,
    selectedProject.routingStore?.status,
    routingMergeRetryNonce,
  ])
  useEffect(() => {
    invalidateAnalyzeResult()
  }, [reachInputIdentity, invalidateAnalyzeResult])
  useEffect(() => {
    const validIds = comparisonFeedOptions.map((feed) => feed.id)
    setComparisonFeedIds((current) => {
      if (!comparisonFeedInitializationRef.current && validIds.length > 0) {
        comparisonFeedInitializationRef.current = true
        return validIds
      }
      const retained = current.filter((feedId) => validIds.includes(feedId))
      if (retained.length === current.length && retained.every((feedId, index) => feedId === current[index])) return current
      return retained
    })
  }, [comparisonFeedOptions])
  useEffect(() => {
    if (!cityRoutingActive || !nationalRoutingFeed) {
      setRoutingResidencyCoverage(null)
      return
    }
    let active = true
    const leaseId = `desktop-surface-${crypto.randomUUID()}`
    const endpoint = `/api/projects/${encodeURIComponent(selectedProject.id)}/routing-residency`
    const request = (resident: boolean, keepalive = false) => fetch(endpoint, {
      method: 'POST',
      keepalive,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feedId: nationalRoutingFeed.id,
        resident,
        leaseId,
        serviceDate: routingServiceDate,
        serviceDay: routingServiceDay,
      }),
    }).then((response) => response.ok ? response.json() : null).catch(() => null)
    void request(true).then((result: {
      residency?: { serviceCoverage?: RoutingServiceCoverage }
    } | null) => {
      if (active) setRoutingResidencyCoverage(result?.residency?.serviceCoverage ?? null)
    })
    return () => {
      active = false
      void request(false, true)
    }
  }, [
    cityRoutingActive,
    nationalRoutingFeed?.id,
    selectedProject.id,
    routingServiceDate,
    routingServiceDay,
  ])
  useEffect(() => {
    if (activeRouteTool !== 'analyze') return
    const latest = routingResidencyCoverage?.completeEndDate
    if (
      latest
      && (
        routingServiceDate < String(routingResidencyCoverage.completeStartDate ?? latest)
        || routingServiceDate > latest
      )
    ) changeRoutingServiceDate(latestMidweekCoverageDate(latest))
  }, [
    activeRouteTool,
    changeRoutingServiceDate,
    routingResidencyCoverage,
    routingServiceDate,
  ])
  useEffect(() => {
    if (
      !nationalRoutingStoreKey
      || (activeRouteTool === 'pathfinder' && (routingOrigin || routingDestination))
    ) return
    const latestCompleteDate = nationalRouting.serviceCoverage?.completeEndDate
    if (!latestCompleteDate || nationalRouting.serviceDateAvailability !== 'outside') return
    if (routingDateAutoAlignedStoreRef.current === nationalRoutingStoreKey) return
    routingDateAutoAlignedStoreRef.current = nationalRoutingStoreKey
    changeRoutingServiceDate(
      activeRouteTool === 'pathfinder'
        ? latestCoverageDateMatchingWeekday(latestCompleteDate, routingServiceDate)
        : latestMidweekCoverageDate(latestCompleteDate),
    )
  }, [
    changeRoutingServiceDate,
    activeRouteTool,
    nationalRouting.serviceCoverage?.completeEndDate,
    nationalRouting.serviceDateAvailability,
    nationalRoutingStoreKey,
    routingDestination,
    routingOrigin,
    routingServiceDate,
  ])
  const routingStoreFeedCount = scopedRoutingFeeds.length
  const metadataReadyFeedCount = scopedRoutingFeeds.filter((feed) => feed.routingStore?.status === 'ready').length
  const routingStoreStoredFeedCount = nationalRoutingFeed
    ? Math.max(1, routingStoreFeedCount)
    : metadataReadyFeedCount
  const routingStoreStored = routingStoreFeedCount > 0 && routingStoreStoredFeedCount === routingStoreFeedCount
  const routingStoreReady = nationalRouting.ready
  const routingInputReady = routingStoreReady && Boolean(nationalRoutingFeed && selectedProject.osmStreetIndex?.status === 'ready')
  const routingStoreTripCount = scopedRoutingFeeds.reduce((sum, feed) => sum + Number(feed.tripCount ?? 0), 0)
  const routingStoreConnectionCount = Number(
    projectRoutingFeed?.routingStore?.connectionCount
      ?? scopedRoutingFeeds.reduce((sum, feed) => sum + Number(feed.routingStore?.connectionCount ?? 0), 0),
  )
  const hasActiveOperationsData = openedNetworkProjectId === selectedProject.id && hasOperationsData(selectedProject) && (activeFeed.routeCount > 0 || preview.routes.length > 0)
  const networkSearchIndex = useMemo(() => buildNetworkSearchIndex(preview), [preview])
  const visiblePreview = useMemo(() => filterPreviewByStatus(preview, statusFilter), [preview, statusFilter])
  const workbenchMapPreview = activeRouteTool === 'agency' && vehicleMode === 'schedule' ? preview : visiblePreview
  const [scheduleLoadStatus, setScheduleLoadStatus] = useState('')
  const scheduleRequestsKey = JSON.stringify([...new Map(preview.routes.map(route => {
    const feedId = activeFeedId === bundleFeedId ? entityFeedScope(route.id) : activeFeedId
    const routeId = route.routeId || route.id
    return [`${feedId}/${routeId}`, { feedId, routeId }] as const
  })).values()].sort((a, b) => `${a.feedId}/${a.routeId}`.localeCompare(`${b.feedId}/${b.routeId}`)))
  const [scheduleLoadRequest, setScheduleLoadRequest] = useState<{ key: string; projectId: string; label: string; serviceDate: string; requests: Array<{ feedId: string; routeId: string }> } | null>(null)
  const scheduleLoadRequestsRef = useRef(new Map<string, NonNullable<typeof scheduleLoadRequest>>())
  const [scheduleLoadRetry, setScheduleLoadRetry] = useState(0)
  useEffect(() => {
    if (page !== 'project' || activeRouteTool !== 'agency' || vehicleMode !== 'schedule') return
    const requests = (JSON.parse(scheduleRequestsKey) as Array<{ feedId: string; routeId: string }>).filter(request => request.feedId)
    if (!requests.length) return
    const key = JSON.stringify([selectedProject.id, routingServiceDate, scheduleRequestsKey])
    setScheduleLoadRequest(current => current?.key === key ? current : { key, projectId: selectedProject.id, label: selectedProject.name, serviceDate: routingServiceDate, requests })
  }, [page, activeRouteTool, vehicleMode, selectedProject.id, selectedProject.name, routingServiceDate, scheduleRequestsKey])
  useEffect(() => {
    if (!scheduleLoadRequest || scheduleLoadRequest.projectId !== selectedProject.id) return
    const { projectId, label, serviceDate, requests } = scheduleLoadRequest
    const controller = new AbortController()
    const taskKey = `${projectId}:vehicle-schedules`
    scheduleLoadRequestsRef.current.set(taskKey, scheduleLoadRequest)
    const task: PreparationTask = { id: taskKey, kind: 'vehicle-schedules', label: `${label} · ${serviceDate}`, status: 'running', progress: 0, phase: `Loading full-day schedules · 0/${requests.length} routes`, createdAt: new Date().toISOString() }
    setPendingPreparations(current => ({ ...current, [taskKey]: task }))
    setScheduleLoadStatus(task.phase || '')
    const worker = new Worker(new URL('./app/networkSchedules.worker.ts', import.meta.url), { type: 'module' })
    const fail = (error: string) => {
      if (controller.signal.aborted) return
      worker.terminate()
      setScheduleLoadStatus('Schedule loading failed')
      setPendingPreparations(current => ({ ...current, [taskKey]: { ...task, status: 'failed', error } }))
    }
    worker.onerror = () => fail('The background schedule worker could not finish. Retry loading.')
    worker.onmessage = (event: MessageEvent<{ type: string; completed: number; failures: number; results?: NetworkScheduleResult[]; error?: string }>) => {
      if (controller.signal.aborted) return
      const { type, completed, failures, results } = event.data
      if (type === 'error') { fail(event.data.error || 'Could not load vehicle schedules.'); return }
      const done = type === 'complete'
      const phase = !done ? `Loading full-day schedules · ${completed}/${requests.length} routes`
        : failures ? `${failures} route schedules unavailable; ${completed - failures} loaded` : `Full-day schedule ready · ${completed} routes`
      // No partial timetable enters project/map state. Publish the entire day once.
      if (done && results) {
        startTransition(() => setProjects(current => controller.signal.aborted ? current : current.map(project => project.id === projectId
          ? results.reduce((next, result) => mergeGtfsRouteAnalysis(next, result.feedId, result.analysis), project) : project)))
        worker.terminate()
      }
      setScheduleLoadStatus(phase)
      setPendingPreparations(current => ({ ...current, [taskKey]: { ...task, phase, progress: completed / requests.length,
        status: !done ? 'running' : failures ? 'failed' : 'complete' } }))
    }
    worker.postMessage({ endpoint: new URL(`/api/projects/${encodeURIComponent(projectId)}/gtfs-route-analysis`, window.location.href).href, requests, serviceDate })
    return () => {
      controller.abort()
      worker.terminate()
      setPendingPreparations(current => current[taskKey]?.createdAt === task.createdAt && current[taskKey]?.status === 'running'
        ? { ...current, [taskKey]: { ...current[taskKey], status: 'cancelled', phase: 'Schedule loading cancelled' } } : current)
    }
  }, [scheduleLoadRequest, selectedProject.id, scheduleLoadRetry])
  const searchResults = useMemo(() => {
    return buildSearchResults({
      query: deferredQuery,
      preview,
      networkSearchIndex,
      projects,
      recentIds: recentSearchIds,
    })
  }, [deferredQuery, networkSearchIndex, preview, projects, recentSearchIds])
  const selectedRoute = selectedRouteId
    ? findNetworkRoute(preview.routes, selectedRouteId)
    : undefined
  const activeScenario = scenarioDrafts.find(
    (entry) => entry.id === activeScenarioId,
  ) ?? scenarioDrafts[0]
  const activeScenarioChange = activeScenario?.interventions.find(
    (entry) => entry.id === activeScenarioChangeId,
  ) ?? activeScenario?.interventions[0]
  const activeScenarioRoute = activeScenarioChange?.routeId
    ? preview.routes.find((route) => (
      route.id === activeScenarioChange.routeId
      || route.patternId === activeScenarioChange.routeId
    ))
    : undefined
  const scenarioSketchStops = ['add-line', 'change-line'].includes(activeScenarioChange?.kind ?? '')
    ? activeScenarioChange.stops
    : emptyScenarioStops
  const scenarioSketchGeometry = useMemo<[number, number][]>(() => {
    if (!activeScenarioChange || scenarioSketchStops.length < 2) return emptyCoordinates
    const geometryMode = activeScenarioChange.geometryMode
      ?? (activeScenarioChange.timeModel === 'infer-road'
        ? 'auto-road'
        : activeScenarioChange.timeModel === 'estimate-distance'
          ? 'straight-line'
          : 'published-shape')
    if (geometryMode === 'auto-road' && activeScenarioChange.geometryStatus === 'ready') {
      return activeScenarioChange.inferredGeometry ?? scenarioSketchStops.map((stop) => stop.coordinate)
    }
    const publishedGeometry = routeHasPublishedShape(activeScenarioRoute)
      ? activeScenarioRoute.coordinates
      : undefined
    if (geometryMode === 'published-shape' && publishedGeometry && publishedGeometry.length >= 2) {
      return publishedGeometry
    }
    // Do not draw an invented chord while the hybrid OSM/shape path is still
    // being prepared. Existing route shape remains useful context; a new
    // line stays point-only until its road geometry is certified.
    if (geometryMode === 'auto-road') return publishedGeometry ?? emptyCoordinates
    return scenarioSketchStops.map((stop) => stop.coordinate)
  }, [activeScenarioChange, activeScenarioRoute, scenarioSketchStops])
  const activeScenarioStopPlacement = scenarioStopPlacement?.interventionId === activeScenarioChange?.id
    ? scenarioStopPlacement
    : null
  const scenarioPointPicking = activeRouteTool === 'analyze' && Boolean(
    !analysisOrigin
    || analyzeMode === 'single' && activeScenarioStopPlacement,
  )
  const selectedStop = selectedStopId
    ? findNetworkStop(preview.stops, selectedStopId)
    : undefined
  const focusedMapPreview = useMemo(
    () => previewForSelectedRoute(preview, selectedRoute, routeRenderMode),
    [routeRenderMode, selectedRoute, preview],
  )
  const routingChoices = nationalRouting.choices
  const routingPlan = routingChoices.find((plan) => plan.id === selectedRoutingPlanId)
    ?? routingChoices.find((plan) => plan.recommended)
    ?? routingChoices[0]
    ?? null
  const routingActivity = buildRoutingActivity({
    routingError: nationalRouting.error || (routingMode !== 'transit' ? streetPreparation.error : ''),
    routingErrorStatus: nationalRouting.errorStatus,
    routingPlan,
    storeBackedRouting,
    routingStoreReady,
    hasOrigin: Boolean(routingOrigin),
    hasDestination: Boolean(routingDestination),
    routingStreetState,
    routingLoading: nationalRouting.loading,
    routingInputReady,
    routingServiceDate,
    routingMode,
    routingServiceDateAvailability: nationalRouting.serviceDateAvailability,
    routingServiceCoverage: nationalRouting.serviceCoverage,
  })
  useEffect(() => {
    if (selectedRoutingPlanId && !routingChoices.some((plan) => plan.id === selectedRoutingPlanId)) {
      setSelectedRoutingPlanId('')
    }
  }, [routingChoices, selectedRoutingPlanId])
  const isProjectEmpty = page === 'project'
    && activeRouteTool !== 'data'
    && (!hasOperationsData(selectedProject) || openedNetworkProjectId !== selectedProject.id)

  function clearAnalysisState() {
    invalidateAnalyzeResult()
    comparisonFeedInitializationRef.current = false
    setComparisonFeedIds([])
    setAnalysisOrigin(null)
    setScenarioStopPlacement(null)
  }

  function cancelRouteAnalysis() {
    routeAnalysisAbortRef.current?.abort()
    routeAnalysisAbortRef.current = null
    routeAnalysisRequestIdRef.current += 1
    setRouteAnalysisRouteId('')
    setRouteAnalysisError('')
  }

  function applyCitySelection(projectId: string) {
    cancelRouteAnalysis()
    if (selectedProjectId !== projectId) {
      clearRouting()
      clearAnalysisState()
      clearAgencyMap()
    }
    setSelectedProjectId(projectId)
    setSelectedRouteId(navigationMemoryRef.current.lastRouteByProject[projectId] ?? '')
    setRouteRenderMode('service')
    setSelectedStopId('')
    setActiveFeedId(bundleFeedId)
    setQuery('')
    setStatusFilter('all')
    setApiError('')
    navigationMemoryRef.current = rememberProject(projectId)
  }

  async function loadProjects() {
    try {
      const [healthResult, projectsResult] = await Promise.all([
        apiJson<HealthResponse>('/api/health'),
        apiJson<{ projects: VigoProject[] }>('/api/projects'),
      ])
      const config = healthResult.config ?? null
      setHealth(healthResult)
      setRuntimeConfig(config)

      if (config) {
        setAppearance(config.appearance)
        setAccent(config.accent)
        setBasemap(config.basemap)
      }

      if (config?.setupRequired) {
        setProjects([])
        setSelectedProjectId('')
        setPage('projects')
        setSetupOpen(true)
        setApiError('')
        return
      }

      const nextProjects = mergeProjectLists(projects, projectsResult.projects)
      const rememberedProjectId = navigationMemoryRef.current.lastProjectId
      const currentSelectedId = nextProjects.some((project) => project.id === selectedProjectId)
        ? selectedProjectId
        : nextProjects.some((project) => project.id === rememberedProjectId)
          ? rememberedProjectId
          : ''
      const nextSelectedId = preferredProjectId(nextProjects, currentSelectedId)
      setProjects(nextProjects)
      applyNetworkMapDefaults()
      setApiError('')
      if (nextSelectedId) {
        setSelectedProjectId(nextSelectedId)
        setPage('projects')
      } else {
        setPage('projects')
      }
    } catch (error) {
      setApiError(error instanceof Error ? error.message : 'Local API unavailable')
      try {
        const configResult = await apiJson<{ config: VigoRuntimeConfig }>('/api/config')
        setRuntimeConfig(configResult.config)
      } catch {
        // If the local runtime never started there is no frontend surface to recover from.
      }
    }
  }

  useEffect(() => {
    document.documentElement.dataset.appearance = appearance
    document.documentElement.style.colorScheme = appearance
  }, [appearance])

  useEffect(() => {
    const selectedProjectExists = projects.some((project) => project.id === selectedProject.id)
    syncDesktopChromeState({
      appearance,
      title: page === 'projects' ? 'Cities' : quietMapLabel(selectedProject.name),
      sidebarAvailable: page === 'project' && !isProjectEmpty,
      sidebarCollapsed,
      canGoBack: page === 'project',
      canGoForward: page === 'projects' && selectedProjectExists,
    })
  }, [appearance, isProjectEmpty, page, projects, selectedProject.id, selectedProject.name, sidebarCollapsed])

  useEffect(() => subscribeDesktopCommands((command) => {
    if (command === 'toggleSidebar' && page === 'project' && !isProjectEmpty) {
      setSidebarCollapsed((current) => !current)
      return
    }
    if (command === 'navigateBack' && page === 'project') {
      showProjects()
      return
    }
    if (command === 'navigateForward' && page === 'projects' && projects.some((project) => project.id === selectedProject.id)) {
      openProject(selectedProject.id)
    }
  }), [isProjectEmpty, page, projects, selectedProject.id])

  useEffect(() => {
    if (page !== 'project' || isProjectEmpty) setSidebarCollapsed(false)
  }, [isProjectEmpty, page])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
    return () => window.cancelAnimationFrame(frame)
  }, [sidebarCollapsed])

  useEffect(() => {
    document.documentElement.dataset.accent = accent
  }, [accent])

  useEffect(() => {
    const street = selectedProject.osmStreetIndex
    if (street?.status === 'ready') {
      setOsmStreetMessage(street.schemaVersion === 'vigo.street.store.v4'
        ? `${street.fileName} indexed / ${formatNumber(street.edgeCount)} walk + ${formatNumber(street.driveEdgeCount ?? 0)} drive edges`
        : `${street.fileName} indexed / ${formatNumber(street.edgeCount)} walk edges / rebuild for Drive`)
    } else if (street?.status === 'building') {
      setOsmStreetMessage(`${street.fileName} / building SQLite street index`)
    } else {
      setOsmStreetMessage('')
    }
  }, [selectedProject.osmStreetIndex])

  useEffect(() => {
    loadProjects()
  }, [])

  useEffect(() => () => {
    routeAnalysisAbortRef.current?.abort()
    scenarioRoadGeometryAbortRef.current?.abort()
  }, [])

  useEffect(() => {
    const needsRouteDetail = activeRouteTool === 'agency' && mapScope === 'route'
    if (page !== 'project' || !needsRouteDetail || !selectedRoute) return
    if (routeHasCompleteGtfsAnalysis(selectedRoute, preview, routingServiceDate)) return
    void loadGtfsRouteAnalysis(selectedRoute, selectedRoute.id)
  }, [activeFeedId, activeRouteTool, mapScope, page, preview, routingServiceDate, selectedProject.id, selectedRoute])

  useEffect(() => {
    if (page !== 'project' || activeRouteTool !== 'analyze') return
    const routeId = activeScenarioChange?.routeId
    if (!routeId) return
    const route = preview.routes.find((candidate) => (
      candidate.id === routeId || candidate.patternId === routeId
    ))
    if (!route || routeHasCompleteGtfsAnalysis(route, preview, routingServiceDate)) return
    void loadGtfsRouteAnalysis(route, route.id)
  }, [
    activeScenarioChange?.routeId,
    activeFeedId,
    activeRouteTool,
    page,
    preview,
    routingServiceDate,
    selectedProject.id,
  ])

  useEffect(() => {
    if (page !== 'project' || activeRouteTool !== 'analyze') return
    const intervention = activeScenarioChange
    if (!intervention?.routeId) return
    if (intervention.stops.some((stop) => stop.editStatus && stop.editStatus !== 'baseline')) return
    const route = preview.routes.find((candidate) => (
      candidate.id === intervention.routeId || candidate.patternId === intervention.routeId
    ))
    if (!route?.analysisSource || route.analysisSource !== 'focused') return
    const currentBaselineIds = intervention.stops.map((stop) => stop.baselineStopId ?? stop.stopId)
    if (
      currentBaselineIds.length === route.stopIds.length
      && currentBaselineIds.every((stopId, index) => stopId === route.stopIds[index])
    ) return
    const nextStops = scenarioStopsForRoute(route, preview)
    if (nextStops.length < 2) return
    setScenarioDrafts((current) => current.map((entry) => ({
      ...entry,
      interventions: entry.interventions.map((candidate) => (
        candidate.id === intervention.id
          && candidate.routeId === intervention.routeId
          && candidate.stops.every((stop) => !stop.editStatus || stop.editStatus === 'baseline')
          ? { ...candidate, stops: nextStops }
          : candidate
      )),
    })))
  }, [
    activeScenarioChange,
    activeRouteTool,
    page,
    preview,
  ])

  useEffect(() => {
    if (page !== 'project' || !selectedProject.id || !needsProjectDetail(selectedProject)) return
    if (cityPreviewLoadingProjectId === selectedProject.id) return
    beginCitySelection(selectedProject.id)
  }, [page, selectedProject.id, cityPreviewLoadingProjectId])

  useEffect(() => {
    if (page === 'project') scrollWorkbenchToTop()
  }, [page])

  useEffect(() => {
    if (cityPreviewLoading || selectedProject.id === '__empty_city__') return
    if (selectedRouteId && !findNetworkRoute(preview.routes, selectedRouteId)) {
      setSelectedRouteId('')
      navigationMemoryRef.current = rememberRoute(selectedProject.id, '')
    }
    if (activeRouteTool !== 'agency' && selectedStopId && !findNetworkStop(preview.stops, selectedStopId)) setSelectedStopId('')
  }, [preview, selectedProject.id, selectedRouteId, selectedStopId, cityPreviewLoading, activeRouteTool])

  useEffect(() => {
    if (activeFeedId !== bundleFeedId && !selectedProject.feeds.some((feed) => feed.id === activeFeedId)) {
      setActiveFeedId(bundleFeedId)
    }
  }, [activeFeedId, selectedProject])

  function replaceProject(nextProject: VigoProject) {
    cancelProjectDetail(nextProject.id)
    setProjects((current) => {
      const existingProject = current.find((project) => project.id === nextProject.id)
      const mergedProject = mergeProjectState(existingProject, nextProject)
      return [mergedProject, ...current.filter((project) => project.id !== nextProject.id)]
    })
    setSelectedProjectId(nextProject.id)
  }

  function applyCityReset(cleanedProject: VigoProject) {
    cancelProjectDetail(cleanedProject.id)
    setProjects((current) => current.map((project) => (
      project.id === cleanedProject.id ? cleanedProject : project
    )))
    if (selectedProjectId !== cleanedProject.id) return
    setOpenedNetworkProjectId('')
    setAgencyPlan(null)
    setAgencyReach(null)

    cancelRouteAnalysis()
    invalidateAnalyzeResult()
    clearRouting()
    setSelectedRouteId('')
    setSelectedStopId('')
    setActiveFeedId(bundleFeedId)
    setQuery('')
    setStatusFilter('all')
    clearRealtimeConnection()
    setOsmStreetMessage('')
    setImportMessage('')
  }

  function clearRealtimeConnection() {
    realtimeAbortRef.current?.abort()
    realtimeAbortRef.current = null
    realtimeRequestIdRef.current += 1
    realtimeInFlightRef.current = false
    setRealtimeRequest(null)
    setRealtimeSnapshot(null)
    setRealtimeMessage('')
    setIsRealtimeLoading(false)
    setVehicleMode('schedule')
  }

  function applyRouteMapDefaults() {
    setMapScope('route')
    setRoutingEnabled(false)
    setLayers((current) => ({
      ...current,
      routes: true,
      segments: false,
      stops: true,
      transfers: false,
      coverage: false,
      scenario: false,
      access: false,
    }))
  }

  function applyNetworkMapDefaults() {
    setMapScope('network')
    setRoutingEnabled(false)
    setLayers((current) => ({
      ...current,
      routes: true,
      segments: false,
      stops: true,
      transfers: false,
      coverage: false,
      scenario: false,
      access: false,
    }))
  }

  function returnToNetworkOverview() {
    cancelRouteAnalysis()
    setSelectedRouteId('')
    setRouteRenderMode('service')
    setSelectedStopId('')
    setQuery('')
    setStatusFilter('all')
    navigationMemoryRef.current = rememberRoute(selectedProject.id, '')
    applyNetworkMapDefaults()
  }

  function closeCity() {
    cancelProjectDetail(selectedProjectId)
    cancelRouteAnalysis()
    clearAnalysisState()
    clearRouting()
    clearAgencyMap()
    routingDateAutoAlignedStoreRef.current = ''
    routingMergeRequestRef.current = ''
    setSelectedRouteId('')
    setRouteRenderMode('service')
    setSelectedStopId('')
    setActiveFeedId(bundleFeedId)
    clearRealtimeConnection()
    setRoutingResidencyCoverage(null)
    setOsmStreetMessage('')
    setQuery('')
    setStatusFilter('all')
    setActiveRouteTool('agency')
    setSidebarCollapsed(false)
    applyNetworkMapDefaults()
  }

  function openProject(projectId: string) {
    const project = projects.find(item => item.id === projectId)
    setOpenedNetworkProjectId(project && hasOperationsData(project) ? projectId : '')
    if (selectedProjectId && selectedProjectId !== projectId) clearRealtimeConnection()
    beginCitySelection(projectId)
    setPage('project')
    setActiveRouteTool('agency')
    applyNetworkMapDefaults()
  }

  function selectNetworkLens(nextLens: NetworkLens) {
    setNetworkLens(nextLens)
    setMapScope('network')
    setLayers((current) => ({
      ...current,
      routes: true,
      segments: nextLens === 'service' || nextLens === 'risk',
      stops: nextLens === 'network' || nextLens === 'shape' || nextLens === 'transfer' || nextLens === 'risk',
      transfers: nextLens === 'network' || nextLens === 'transfer',
      coverage: false,
      scenario: nextLens === 'risk',
      access: false,
    }))
  }

  function selectFeed(feedId: string) {
    cancelRouteAnalysis()
    if (feedId !== activeFeedId) clearRealtimeConnection()
    setActiveFeedId(feedId)
    setQuery('')
    setStatusFilter('all')
    setDataSection('feeds')
    setActiveRouteTool('data')
  }

  async function loadGtfsRouteAnalysis(route: RouteMetric, selectedId: string) {
    if (routeHasCompleteGtfsAnalysis(route, preview, routingServiceDate)) return

    const feedId = activeFeedId === bundleFeedId ? entityFeedScope(route.id) : activeFeedId
    const routeId = route.routeId || route.id
    if (!feedId || !routeId) return

    const requestKey = JSON.stringify([selectedProject.id, feedId, routeId, routingServiceDate])
    if (routeAnalysisAbortRef.current && routeAnalysisKeyRef.current === requestKey) return
    routeAnalysisAbortRef.current?.abort()
    const controller = new AbortController()
    routeAnalysisAbortRef.current = controller
    routeAnalysisKeyRef.current = requestKey
    const requestId = routeAnalysisRequestIdRef.current + 1
    routeAnalysisRequestIdRef.current = requestId
    setRouteAnalysisRouteId(selectedId)
    setRouteAnalysisError('')
    try {
      const result = await apiJson<{ feedId: string; analysis: GtfsRouteAnalysis }>(
        `/api/projects/${encodeURIComponent(selectedProject.id)}/gtfs-route-analysis`,
        {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify({ feedId, routeId, serviceDate: routingServiceDate }),
        },
      )
      if (controller.signal.aborted || routeAnalysisRequestIdRef.current !== requestId) return
      setProjects((current) => current.map((project) => (
        project.id === selectedProject.id
          ? mergeGtfsRouteAnalysis(project, result.feedId, result.analysis)
          : project
      )))
      setRouteAnalysisRouteId('')
      setRouteAnalysisError('')
    } catch (error) {
      if (controller.signal.aborted || routeAnalysisRequestIdRef.current !== requestId) return
      setRouteAnalysisRouteId('')
      setRouteAnalysisError(error instanceof Error ? error.message : 'SQLite route analysis could not be loaded.')
    } finally {
      if (routeAnalysisAbortRef.current === controller) routeAnalysisAbortRef.current = null
    }
  }

  function selectRoute(routeId: string, renderMode: RouteRenderMode = 'service') {
    const route = preview.routes.find((item) => item.id === routeId || item.patternId === routeId) ?? visiblePreview.routes.find((item) => item.id === routeId || item.patternId === routeId)
    const nextRouteId = route?.id ?? routeId
    setSelectedRouteId(nextRouteId)
    setRouteRenderMode(renderMode)
    navigationMemoryRef.current = rememberRoute(selectedProject.id, nextRouteId)
    setSelectedStopId('')
    clearAgencyMap()
    setActiveRouteTool('agency')
    applyRouteMapDefaults()
    if (route) void loadGtfsRouteAnalysis(route, nextRouteId)
  }

  function selectStop(stopId: string) {
    setSelectedStopId(stopId)
    setActiveRouteTool('agency')
  }

  function activateSearchResult(result: SearchResult) {
    const nextMemory = rememberSearchResult(result.id)
    navigationMemoryRef.current = nextMemory
    setRecentSearchIds(nextMemory.recentSearchIds)
    setQuery('')

    if (result.kind === 'city') {
      openProject(result.id.slice('city:'.length))
      return
    }
    if (result.kind === 'route') {
      setPage('project')
      selectRoute(result.id.slice('route:'.length))
      return
    }
    if (result.kind === 'stop') {
      setPage('project')
      const stopId = result.id.slice('stop:'.length)
      const stop = preview.stops.find(item => item.id === stopId)
      if (activeRouteTool === 'agency') browseAgencyEntities([], [stopId], stop && typeof stop.lon === 'number' && typeof stop.lat === 'number' ? { id: stopId, label: stop.name, coordinate: [stop.lon, stop.lat] } : undefined)
      else selectStop(stopId)
      setMapScope('network')
      setLayers((current) => ({ ...current, routes: true, stops: true, transfers: true }))
      return
    }

    if (result.id === 'command:cities') {
      showProjects()
    } else if (result.id === 'command:pathfinder') {
      setPage('project')
      openPathfinderView()
    } else if (result.id === 'command:analyze') {
      setPage('project')
      openAnalyzeView()
    } else if (result.id === 'command:data') {
      setPage('project')
      openDataView()
    } else if (result.id === 'command:preferences') {
      setPage('project')
      openSettingsView()
    } else {
      setPage('project')
      openNetworkView()
    }
  }

  function clearRouting() {
    setRoutingPickIndex(null)
    setRoutingPointError('')
    setRoutingOrigin(null)
    setRoutingWaypoints([])
    setRoutingDestination(null)
    setSelectedRoutingPlanId('')
    nationalRouting.reset()
    setRoutingEnabled(false)
  }

  function toggleRouting() {
    setRoutingPickIndex(null)
    setActiveRouteTool('pathfinder')
    setMapScope('route')
    setRoutingEnabled((current) => !current)
  }

  function changeRoutingTimePreference(preference: RoutingTimePreference) {
    setRoutingTimePreference(preference)
    setSelectedRoutingPlanId('')
  }

  function changeRoutingMode(mode: RoutingTravelMode) {
    setRoutingMode(mode)
    if (mode !== 'transit') setRoutingTimePreference('depart')
    setSelectedRoutingPlanId('')
    nationalRouting.reset()
  }

  function changeRoutingDataMode(mode: RoutingDataMode) {
    if (mode === routingDataMode) return
    setRoutingDataMode(mode)
    setSelectedRoutingPlanId('')
    nationalRouting.reset()
  }

  function changeRoutingDepartureWindow(minutes: RoutingDepartureWindowMinutes) {
    setRoutingDepartureWindowMinutes(minutes)
    setSelectedRoutingPlanId('')
  }

  function changeRoutingMaxWalkKm(km: number) {
    setRoutingMaxWalkKm(Math.max(0.2, Math.min(5, km)))
    setSelectedRoutingPlanId('')
  }

  function routingPoints() {
    return [...(routingOrigin ? [routingOrigin] : []), ...routingWaypoints, ...(routingDestination ? [routingDestination] : [])]
  }

  function pickRoutingPoint(index: number | null) {
    if (index === null && routingPoints().length >= maxRoutingPointCount) return
    setRoutingPickIndex(index)
    setRoutingPointError('')
    setActiveRouteTool('pathfinder')
    setMapScope('route')
    setRoutingEnabled(true)
  }

  function routingPointFromMap(point: RoutingPoint) {
    const current = routingPoints()
    const replacing = routingPickIndex !== null && routingPickIndex < current.length
    if (!replacing && current.length >= maxRoutingPointCount) {
      setRoutingEnabled(false)
      return
    }
    const next = replacing
      ? current.map((entry, index) => index === routingPickIndex ? point : entry)
      : current.length >= 2 ? insertRoutingPointBeforeDestination(current, point) : appendRoutingPointSequence(current, point)
    if (!reorderRoutingPoints(next)) return
    if (next.length === 1) setRoutingEnabled(true)
  }

  function reorderRoutingPoints(points: RoutingPoint[]) {
    if (points.length > maxRoutingPointCount) return false
    const ordered = normalizeOrderedRoutingPoints(points)
    const duplicateIndex = ordered.findIndex((point, index) => index > 0
      && point.coordinate[0] === ordered[index - 1].coordinate[0]
      && point.coordinate[1] === ordered[index - 1].coordinate[1])
    if (duplicateIndex >= 0) {
      setRoutingPointError(`Points ${duplicateIndex} and ${duplicateIndex + 1} have the same coordinates.`)
      return false
    }
    setRoutingPointError('')
    setRoutingOrigin(ordered[0] ?? null)
    setRoutingWaypoints(ordered.slice(1, -1))
    setRoutingDestination(ordered.length >= 2 ? ordered.at(-1)! : null)
    setSelectedRoutingPlanId('')
    nationalRouting.reset()
    setRoutingPickIndex(null)
    setRoutingEnabled(false)
    setActiveRouteTool('pathfinder')
    setMapScope('route')
    return true
  }

  function rerunRouting() {
    const points = routingPoints()
    if (points.length < 2) return
    reorderRoutingPoints(points.map((point) => ({ ...point, coordinate: [...point.coordinate] })))
  }

  function analysisPointFromMap(point: RoutingPoint) {
    const mapPoint = point.source === 'map'
      ? buildRoutingPointFromMap(
        point.coordinate,
        `${point.coordinate[1].toFixed(4)}, ${point.coordinate[0].toFixed(4)}`,
      )
      : point
    if (activeRouteTool !== 'analyze') return
    if (!analysisOrigin) {
      invalidateAnalyzeResult()
      setAnalysisOrigin(mapPoint)
      return
    }
    if (!activeScenarioChange) return
    const placement = scenarioStopPlacement?.interventionId === activeScenarioChange.id
      ? scenarioStopPlacement
      : null
    if (!placement) return
    if (
      activeScenarioChange.stops.length >= 256
      && placement?.mode !== 'replace'
    ) return

    const nextStops = [...activeScenarioChange.stops]
    if (placement?.mode === 'replace') {
      if (!nextStops[placement.index]) return
      const replacement = scenarioStopFromRoutingPoint(
        activeScenarioChange.id,
        mapPoint,
        'replaced',
      )
      nextStops[placement.index] = {
        ...replacement,
        id: nextStops[placement.index].id,
        baselineStopId: ['inserted', 'added'].includes(nextStops[placement.index].editStatus ?? '')
          ? undefined
          : nextStops[placement.index].baselineStopId ?? nextStops[placement.index].stopId,
        baselineStopIndex: nextStops[placement.index].baselineStopIndex,
        anchorBeforeStopId: nextStops[placement.index].anchorBeforeStopId,
        anchorAfterStopId: nextStops[placement.index].anchorAfterStopId,
        anchorBeforeStopIndex: nextStops[placement.index].anchorBeforeStopIndex,
        anchorAfterStopIndex: nextStops[placement.index].anchorAfterStopIndex,
        editStatus: ['inserted', 'added'].includes(nextStops[placement.index].editStatus ?? '')
          ? nextStops[placement.index].editStatus : 'replaced',
      }
    } else if (placement?.mode === 'insert') {
      if (placement.index < 1 || placement.index >= nextStops.length) return
      const before = nextStops[placement.index - 1]
      const after = nextStops[placement.index]
      const { beforeStopId, afterStopId, beforeStopIndex, afterStopIndex } = scenarioInsertionAnchors(before, after)
      nextStops.splice(
        placement.index,
        0,
        {
          ...scenarioStopFromRoutingPoint(activeScenarioChange.id, mapPoint, 'inserted'),
          anchorBeforeStopId: beforeStopId,
          anchorAfterStopId: afterStopId,
          anchorBeforeStopIndex: beforeStopIndex,
          anchorAfterStopIndex: afterStopIndex,
        },
      )
    } else {
      nextStops.push(
        scenarioStopFromRoutingPoint(activeScenarioChange.id, mapPoint, 'added'),
      )
    }
    updateScenarioChange(activeScenarioChange.id, {
      stops: nextStops,
    })
    if (placement) setScenarioStopPlacement(null)
  }

  function moveScenarioStopFromMap(index: number, coordinate: [number, number]) {
    const intervention = activeScenarioChange
    const stop = intervention?.stops[index]
    if (!intervention || !stop) return
    updateScenarioChange(intervention.id, {
      stops: intervention.stops.map((candidateStop, candidateIndex) => {
        if (candidateIndex !== index) return candidateStop
        return {
          ...candidateStop,
          stopId: undefined,
          baselineStopId: candidateStop.editStatus === 'inserted' || candidateStop.editStatus === 'added'
            ? undefined
            : candidateStop.baselineStopId ?? candidateStop.stopId,
          coordinate,
          source: 'map',
          editStatus: candidateStop.editStatus === 'inserted' || candidateStop.editStatus === 'added'
            ? candidateStop.editStatus : 'replaced',
        }
      }),
    })
  }

  function selectScenario(caseId: string) {
    invalidateAnalyzeResult()
    setScenarioStopPlacement(null)
    setActiveScenarioId(caseId)
    const selected = scenarioDrafts.find((entry) => entry.id === caseId)
    setActiveScenarioChangeId(selected?.interventions[0]?.id ?? '')
  }

  function addScenario() {
    if (scenarioDrafts.length >= 6) return
    invalidateAnalyzeResult()
    const next = newScenarioDraft(scenarioDrafts.length)
    setScenarioStopPlacement(null)
    setScenarioDrafts((current) => [...current, next])
    setActiveScenarioId(next.id)
    setActiveScenarioChangeId('')
  }

  function removeScenario(caseId: string) {
    if (scenarioDrafts.length <= 1) return
    invalidateAnalyzeResult()
    const next = scenarioDrafts.filter((entry) => entry.id !== caseId)
    setScenarioStopPlacement(null)
    setScenarioDrafts((current) => current.filter((entry) => entry.id !== caseId))
    setActiveScenarioId(next[0].id)
    setActiveScenarioChangeId(next[0].interventions[0]?.id ?? '')
  }

  function addScenarioChange(kind: ScenarioChangeKind) {
    if (!activeScenario || activeScenario.interventions.length >= 8) return
    invalidateAnalyzeResult()
    const intervention = newScenarioChange(kind)
    setScenarioStopPlacement(null)
    setScenarioDrafts((current) => current.map((entry) => (
      entry.id === activeScenario.id
        ? { ...entry, interventions: [...entry.interventions, intervention] }
        : entry
    )))
    setActiveScenarioChangeId(intervention.id)
  }

  function updateScenarioChange(
    interventionId: string,
    patch: Partial<ScenarioChangeDraft>,
  ) {
    invalidateAnalyzeResult()
    setScenarioDrafts((current) => current.map((entry) => ({
      ...entry,
      interventions: entry.interventions.map((intervention) => {
        if (intervention.id !== interventionId) return intervention
        const geometryInvalidated = (
          patch.stops !== undefined
          || patch.routeId !== undefined
          || patch.geometryMode !== undefined
          || patch.kind !== undefined
        ) && patch.inferredGeometry === undefined
        const nextIntervention = {
          ...intervention,
          ...patch,
          ...(geometryInvalidated
            ? {
                inferredGeometry: undefined,
                inferredGeometrySource: undefined,
                inferredFallbackSegmentCount: undefined,
                inferredPublishedShapeSegmentCount: undefined,
                inferredOsmSegmentCount: undefined,
                inferredSegmentGeometry: undefined,
                inferredSegmentDistanceKm: undefined,
                inferredSegmentRuntimeMinutes: undefined,
                geometryStatus: 'idle' as const,
                geometryError: undefined,
              }
            : {}),
        }
        if (patch.kind && patch.kind !== intervention.kind) {
          const route = intervention.routeId
            ? preview.routes.find((candidate) => (
                candidate.id === intervention.routeId || candidate.patternId === intervention.routeId
              ))
            : undefined
          return {
            ...nextIntervention,
            routeScope: patch.kind === 'add-line' ? undefined : 'pattern' as const,
            bidirectional: patch.kind === 'add-line',
            ...(['add-line', 'change-line'].includes(patch.kind)
              ? { geometryMode: 'auto-road' as const, timeModel: 'infer-road' as const }
              : {}),
            stops: ['change-line', 'enhance-line', 'remove-line'].includes(patch.kind)
              ? scenarioStopsForRoute(route, preview)
              : [],
          }
        }
        return nextIntervention
      }),
    })))
  }

  function updateScenarioChangeRoute(interventionId: string, routeId: string) {
    const route = preview.routes.find((candidate) => (
      candidate.id === routeId || candidate.patternId === routeId
    ))
    setScenarioStopPlacement(null)
    updateScenarioChange(interventionId, {
      routeId,
      stops: scenarioStopsForRoute(route, preview),
    })
  }

  async function inferScenarioRoadGeometry(interventionId: string) {
    const intervention = activeScenario?.interventions.find((entry) => entry.id === interventionId)
    if (!intervention || !['add-line', 'change-line', 'enhance-line'].includes(intervention.kind)) return
    const route = intervention.routeId
      ? preview.routes.find((candidate) => (
        candidate.id === intervention.routeId || candidate.patternId === intervention.routeId
      ))
      : undefined
    const stops = intervention.stops.length >= 2
      ? intervention.stops
      : route
        ? scenarioStopsForRoute(route, preview)
        : []
    if (stops.length < 2) {
      updateScenarioChange(interventionId, {
        geometryStatus: 'error',
        geometryError: 'Place at least two ordered stops before tracing a road-following path.',
      })
      return
    }
    if (selectedProject.osmStreetIndex?.status !== 'ready') {
      updateScenarioChange(interventionId, {
        geometryStatus: 'error',
        geometryError: 'Build the local OSM street index before tracing a road-following path.',
      })
      return
    }
    const feedId = activeFeedId === bundleFeedId
      ? route ? entityFeedScope(route.id) || nationalRoutingFeed?.id : nationalRoutingFeed?.id
      : activeFeedId
    if (!feedId) {
      updateScenarioChange(interventionId, {
        geometryStatus: 'error',
        geometryError: 'Choose a ready GTFS feed before tracing a route.',
      })
      return
    }
    invalidateAnalyzeResult()
    const controller = createScenarioRoadGeometryRequest(interventionId, setScenarioDrafts)
    scenarioRoadGeometryAbortRef.current = controller
    const requestId = scenarioRoadGeometryRequestIdRef.current + 1
    scenarioRoadGeometryRequestIdRef.current = requestId
    const fallbackGeometry = routeHasPublishedShape(route) ? route.coordinates : undefined
    const fallbackSegmentRuntimeMinutes = route
      ? scenarioSegmentRuntimeMinutes(route, stops, preview)
      : undefined
    const publishedShapeSegmentIndexes = scenarioPublishedShapeSegmentIndexes(route, stops)
    setScenarioDrafts((current) => current.map((entry) => ({
      ...entry,
      interventions: entry.interventions.map((candidate) => candidate.id === interventionId
        ? { ...candidate, geometryStatus: 'loading', geometryError: '' }
        : candidate),
    })))
    try {
      const result = await apiJson<{
        geometry: {
          status: 'ready' | 'blocked'
          segments?: Array<{
            coordinates?: [number, number][]
            distanceKm?: number
            durationMinutes?: number
            source?: 'osm_drive' | 'published_shape' | 'published_shape_fallback'
          }>
          snappedCoordinates?: [number, number][]
          detail?: string
          fallbackUsed?: boolean
          fallbackSegmentCount?: number
          publishedShapeSegmentCount?: number
          osmSegmentCount?: number
        }
      }>(
        `/api/projects/${encodeURIComponent(selectedProject.id)}/scenario-road-geometry`,
        {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify({
            feedId,
            maxStreetKm: 100,
            points: stops.map((stop) => ({ coordinate: stop.coordinate, label: stop.label })),
            ...(fallbackGeometry ? { fallbackGeometry } : {}),
            ...(fallbackSegmentRuntimeMinutes ? { fallbackSegmentRuntimeMinutes } : {}),
            ...(publishedShapeSegmentIndexes.length ? { publishedShapeSegmentIndexes } : {}),
          }),
        },
      )
      if (controller.signal.aborted || scenarioRoadGeometryRequestIdRef.current !== requestId) return
      const geometry = result.geometry
      const segments = Array.isArray(geometry?.segments) ? geometry.segments : []
      if (geometry?.status !== 'ready' || segments.length !== stops.length - 1) {
        throw new Error(geometry?.detail ?? 'The OSM street network could not connect every ordered stop.')
      }
      const inferredGeometry = joinScenarioSegmentGeometry(segments.map((segment) => segment.coordinates ?? []))
      const hasOsmSegments = segments.some((segment) => segment.source === 'osm_drive')
      const hasShapeSegments = segments.some((segment) => (
        segment.source === 'published_shape' || segment.source === 'published_shape_fallback'
      ))
      const snappedCoordinates = Array.isArray(geometry.snappedCoordinates)
        ? geometry.snappedCoordinates
        : []
      setScenarioDrafts((current) => current.map((entry) => ({
        ...entry,
        interventions: entry.interventions.map((candidate) => candidate.id === interventionId
          ? {
              ...candidate,
              stops: candidate.stops.length >= 2
                ? candidate.stops.map((stop, index) => snappedCoordinates[index]?.length === 2
                  ? { ...stop, coordinate: snappedCoordinates[index] }
                  : stop)
                : candidate.stops,
              inferredGeometry,
              inferredSegmentGeometry: segments.map((segment) => segment.coordinates ?? []),
              inferredGeometrySource: hasOsmSegments && hasShapeSegments
                ? 'hybrid'
                : hasShapeSegments
                  ? 'published_shape_fallback'
                  : 'osm_drive',
              inferredFallbackSegmentCount: Number(
                geometry.fallbackSegmentCount
                  ?? segments.filter((segment) => segment.source === 'published_shape_fallback').length,
              ),
              inferredPublishedShapeSegmentCount: Number(
                geometry.publishedShapeSegmentCount
                  ?? segments.filter((segment) => segment.source === 'published_shape').length,
              ),
              inferredOsmSegmentCount: Number(
                geometry.osmSegmentCount
                  ?? segments.filter((segment) => segment.source === 'osm_drive').length,
              ),
              inferredSegmentDistanceKm: segments.map((segment) => Number(segment.distanceKm ?? 0)),
              inferredSegmentRuntimeMinutes: segments.map((segment) => Number(segment.durationMinutes ?? 0)),
              geometryStatus: 'ready',
              geometryError: '',
            }
          : candidate),
      })))
    } catch (error) {
      if (controller.signal.aborted || scenarioRoadGeometryRequestIdRef.current !== requestId) return
      const message = error instanceof Error ? error.message : 'OSM road inference failed.'
      setScenarioDrafts((current) => current.map((entry) => ({
        ...entry,
        interventions: entry.interventions.map((candidate) => candidate.id === interventionId
          ? { ...candidate, geometryStatus: 'error', geometryError: message }
          : candidate),
      })))
    } finally {
      if (scenarioRoadGeometryAbortRef.current === controller) scenarioRoadGeometryAbortRef.current = null
    }
  }

  function beginScenarioStopPlacement(
    interventionId: string,
    mode: ScenarioStopPlacement['mode'],
    index: number,
  ) {
    if (!analysisOrigin) return
    setScenarioStopPlacement({ interventionId, mode, index })
  }

  function removeScenarioStop(interventionId: string, index: number) {
    const intervention = activeScenario?.interventions.find((entry) => entry.id === interventionId)
    if (!intervention || intervention.stops.length <= 2 || !intervention.stops[index]) return
    setScenarioStopPlacement(null)
    updateScenarioChange(interventionId, {
      stops: intervention.stops.filter((_, stopIndex) => stopIndex !== index),
    })
  }

  function resetScenarioRouteStops(interventionId: string) {
    const intervention = activeScenario?.interventions.find((entry) => entry.id === interventionId)
    if (!intervention?.routeId) return
    const route = preview.routes.find((candidate) => (
      candidate.id === intervention.routeId || candidate.patternId === intervention.routeId
    ))
    setScenarioStopPlacement(null)
    updateScenarioChange(interventionId, {
      stops: scenarioStopsForRoute(route, preview),
    })
  }

  function removeScenarioChange(interventionId: string) {
    invalidateAnalyzeResult()
    setScenarioStopPlacement(null)
    const remaining = activeScenario?.interventions.filter(
      (entry) => entry.id !== interventionId,
    ) ?? []
    setScenarioDrafts((current) => current.map((entry) => (
      entry.id === activeScenario?.id
        ? { ...entry, interventions: entry.interventions.filter((change) => change.id !== interventionId) }
        : entry
    )))
    setActiveScenarioChangeId(remaining[0]?.id ?? '')
  }

  function activeScenarioDraft() {
    const services: ScenarioServiceDraft[] = []
    const excludedRouteIds: string[] = []
    const excludedPatternIds: Array<{ routeId: string; patternId: string }> = []
    const serviceFor = (
      intervention: ScenarioChangeDraft,
      route: RouteMetric | undefined,
      stops: ScenarioStopDraft[],
      serviceId: string,
      serviceName: string,
    ): ScenarioServiceDraft => {
      const geometryMode: ScenarioGeometryMode = intervention.geometryMode
        ?? (intervention.timeModel === 'infer-road'
          ? 'auto-road'
          : intervention.timeModel === 'estimate-distance'
            ? 'straight-line'
            : route ? 'published-shape' : 'straight-line')
      const timeModel: ScenarioTimeModel = geometryMode === 'auto-road'
        ? 'infer-road'
        : geometryMode === 'straight-line'
          ? 'estimate-distance'
          : 'preserve-scheduled'
      const inferredReady = intervention.geometryStatus === 'ready'
        && Array.isArray(intervention.inferredGeometry)
        && intervention.inferredGeometry.length >= 2
      const geometry = geometryMode === 'auto-road'
        ? inferredReady
          ? intervention.inferredGeometry
          : undefined
        : geometryMode === 'straight-line'
          ? stops.map((stop) => stop.coordinate)
          : routeHasPublishedShape(route)
            ? route.coordinates
            : undefined
      const segmentDistancesKm = inferredReady
        ? intervention.inferredSegmentDistanceKm
        : undefined
      return {
        id: serviceId,
        name: serviceName,
        operation: intervention.kind === 'add-line'
          ? 'add'
          : intervention.kind === 'change-line'
            ? 'replace'
            : 'augment',
        sourceRouteId: route ? scenarioSourceRouteId(route) : undefined,
        sourcePatternId: route?.patternId ?? route?.id,
        // Each exact-edge branch replacement is hydrated and excluded by its
        // own GTFS pattern. The UI-level edge scope is expanded below.
        routeScope: intervention.routeScope === 'edge' ? 'pattern' : intervention.routeScope,
        timeModel,
        bidirectional: intervention.routeScope === 'edge' ? false : intervention.bidirectional,
        headwayMinutes: intervention.headwayMinutes,
        startMinutes: intervention.startMinutes,
        endMinutes: intervention.endMinutes,
        averageSpeedKph: intervention.averageSpeedKph,
        dwellMinutes: 0.35,
        ...(segmentDistancesKm ? { segmentDistancesKm } : {}),
        ...(route && (timeModel === 'preserve-scheduled' || timeModel === 'infer-road')
          ? {
              segmentRuntimeMinutes: scenarioSegmentRuntimeMinutes(route, stops, preview, {
                segmentDistancesKm,
              }),
              addedStopDwellMinutes: timeModel === 'infer-road' ? 0.35 : 0,
            }
          : {}),
        ...(geometry && geometry.length >= 2
          ? {
              geometry,
              geometrySource: geometryMode === 'auto-road'
                ? intervention.inferredGeometrySource === 'published_shape_fallback'
                  ? 'shape' as const
                  : 'osm_drive' as const
                : geometryMode === 'straight-line'
                  ? 'stop_sequence' as const
                  : route?.geometrySource ?? 'shape' as const,
            }
          : {}),
        stops,
      }
    }
    for (const intervention of activeScenario?.interventions ?? []) {
      const route = intervention.routeId
        ? preview.routes.find((entry) => (
          entry.id === intervention.routeId || entry.patternId === intervention.routeId
        ))
        : undefined
      if (intervention.kind !== 'add-line' && !route) {
        return { error: `Choose a route for ${intervention.name}.` }
      }
      const sourceRouteId = route ? scenarioSourceRouteId(route) : undefined
      const routeScope: ScenarioRouteScope = intervention.routeScope ?? 'pattern'
      if (['remove-line', 'change-line'].includes(intervention.kind) && sourceRouteId) {
        if (routeScope === 'route') {
          excludedRouteIds.push(sourceRouteId)
        } else if (route?.patternId ?? route?.id) {
          if (intervention.kind === 'remove-line') {
            excludedPatternIds.push({
              routeId: sourceRouteId,
              patternId: route.patternId ?? route.id,
            })
          }
        }
      }
      if (intervention.kind === 'remove-line') continue
      if (intervention.geometryMode === 'auto-road' && intervention.geometryStatus !== 'ready') {
        return { error: `Build the road-following path for ${intervention.name} before running Reach, or choose Straight-line estimate.` }
      }
      const stops = ['add-line', 'change-line'].includes(intervention.kind)
        ? intervention.stops
        : scenarioStopsForRoute(route, preview)
      if (stops.length < 2) {
        return { error: `${intervention.name} needs at least two ordered GTFS or placed stops.` }
      }
      if (routeScope === 'edge' && intervention.kind === 'change-line') {
        if (!route) return { error: `${intervention.name} needs a selected GTFS branch before applying an exact edge edit.` }
        const edgeRoute = route
        const edgeError = scenarioEdgeEditError(edgeRoute, stops)
        if (edgeError) return { error: `${intervention.name}: ${edgeError}` }
        const edgeEdit = scenarioInsertedStopsForEdge(stops)
        if (!edgeEdit) {
          return { error: `${intervention.name} needs one or more inserted stops anchored between an exact ordered A → B GTFS edge.` }
        }
        const serviceBranches = preview.routes
          .filter((candidate) => scopedRouteServiceKey(candidate) === scopedRouteServiceKey(edgeRoute))
        if (serviceBranches.length !== edgeRoute.serviceVariantCount
          || serviceBranches.some((candidate) => candidate.analysisSource !== 'focused'
            || candidate.analysisServiceDate !== routingServiceDate)) {
          return { error: `Load every GTFS branch of ${edgeRoute.shortName} for ${routingServiceDate} before applying an exact-edge edit.` }
        }
        const matchingBranches = serviceBranches.filter((candidate) => (
          scenarioEdgeIndexes(candidate, edgeEdit.beforeStopId, edgeEdit.afterStopId).length > 0
        ))
        if (!matchingBranches.length) {
          return { error: `No GTFS branch in ${edgeRoute.shortName} serves the exact ordered ${edgeEdit.beforeStopId} → ${edgeEdit.afterStopId} edge.` }
        }
        for (const branch of matchingBranches) {
          const branchStops = scenarioStopsForEdgeBranch(intervention, branch, preview)
          if (branchStops.length < 2) {
            return { error: `Load the complete ordered stops for ${branch.shortName} · Pattern ${branch.patternRank ?? branch.id} before applying this edge edit.` }
          }
          const branchGeometry = intervention.geometryMode === 'auto-road'
            ? scenarioEdgeGeometryForBranch(intervention, branch, preview)
            : undefined
          if (intervention.geometryMode === 'auto-road' && !branchGeometry) {
            return { error: `The edited road gap cannot be applied to ${branch.shortName} · ${branch.patternRank ?? branch.id}. Load its complete published shape and rebuild the road path.` }
          }
          services.push(serviceFor(
            branchGeometry ? { ...intervention, inferredGeometry: branchGeometry.geometry,
              inferredSegmentDistanceKm: branchGeometry.segmentDistancesKm, inferredGeometrySource: 'hybrid' } : intervention,
            branch,
            branchStops,
            `${intervention.id}:${branch.id}`,
            `${intervention.name} · ${branch.directionId || 'branch'} · ${branch.patternRank ?? branch.id}`,
          ))
        }
        continue
      }
      services.push(serviceFor(
        intervention,
        route,
        stops,
        intervention.id,
        intervention.name,
      ))
    }
    return {
      scenario: {
        id: activeScenario?.id ?? 'baseline-only',
        name: activeScenario?.name ?? 'Baseline',
        services,
        excludedRouteIds: [...new Set(excludedRouteIds)],
        excludedPatternIds,
      },
    }
  }

  async function runFeedComparison(includeStreetEdges = scenarioRenderMode === 'streets') {
    if (!analysisOrigin || comparisonFeedIds.length < 2) return
    if (new Set(comparisonFeedIds).size !== comparisonFeedIds.length) {
      setScenarioError('Choose each GTFS feed only once.')
      return
    }
    const selectedFeeds = comparisonFeedIds.map((feedId) => selectedProject.feeds.find((feed) => feed.id === feedId))
    if (selectedFeeds.some((feed) => !feed || feed.routingStore?.status !== 'ready')) {
      setScenarioError('Every selected GTFS feed needs a ready SQLite routing store.')
      return
    }

    analysisAbortRef.current?.abort()
    const controller = new AbortController()
    analysisAbortRef.current = controller
    const feedProgress = selectedFeeds.map(() => 0)
    setScenarioLoading(true)
    setScenarioProgress({ phase: 'comparison', progress: 0, detail: 'Starting selected GTFS analyses' })
    setScenarioError('')
    setReachResult(null)
    try {
      const results = await Promise.all(selectedFeeds.map(async (feed, index) => {
        const feedName = quietMapLabel(feed!.name || feed!.fileName || `GTFS ${index + 1}`)
        const response = await apiProgressJson<{ result: ReachResult }>(
          `/api/projects/${encodeURIComponent(selectedProject.id)}/reach`,
          {
            method: 'POST',
            signal: controller.signal,
            body: JSON.stringify({
              feedId: feed!.id,
              origin: analysisOrigin,
              departMinutes: scheduleTimeMinutes,
              serviceDate: routingServiceDate,
              serviceDay: routingServiceDay,
              maxWalkKm: routingMaxWalkKm,
              walkSpeedKph: scenarioWalkSpeedKph,
              rasterSize: desktopReachRasterSize,
              cutoffsMinutes: [...new Set([15, 30, 45, 60, 75, 90, scenarioCutoffMinutes])].sort((left, right) => left - right),
              includePreliminary: false,
              includeStreetEdges,
              scenario: {
                id: `gtfs-comparison-${index + 1}`,
                name: `${feedName} comparison baseline`,
                services: [],
                excludedRouteIds: [],
              },
            }),
          },
          (progress) => {
            feedProgress[index] = Math.max(feedProgress[index], Math.min(1, Number(progress.progress ?? feedProgress[index])))
            setScenarioProgress({
              phase: `GTFS ${index + 1} · ${progress.phase}`,
              progress: feedProgress.reduce((total, value) => total + value, 0) / feedProgress.length,
              detail: `${feedName}${progress.detail ? ` · ${progress.detail}` : ''}`,
            })
          },
        )
        return {
          feedId: feed!.id,
          feedName,
          result: response.result,
        } satisfies ReachComparisonResult
      }))
      setReachComparison(results)
      setScenarioView('baseline')
    } catch (error) {
      const cancelled = controller.signal.aborted
      controller.abort()
      if (cancelled) return
      setScenarioError(error instanceof Error ? error.message : 'GTFS comparison failed.')
    } finally {
      if (analysisAbortRef.current === controller) {
        analysisAbortRef.current = null
        setScenarioLoading(false)
        setScenarioProgress(null)
      }
    }
  }

  async function runServiceDecomposition() {
    if (comparisonFeedIds.length !== 2) {
      setServiceDecompositionError('Select exactly two GTFS feeds for street-service comparison.')
      return
    }
    const [baselineFeedId, comparisonFeedId] = comparisonFeedIds
    const selectedFeeds = comparisonFeedIds.map((feedId) => selectedProject.feeds.find((feed) => feed.id === feedId))
    if (selectedFeeds.some((feed) => !feed || feed.routingStore?.status !== 'ready')) {
      setServiceDecompositionError('Both selected GTFS feeds need ready SQLite routing stores.')
      return
    }
    if (selectedProject.osmStreetIndex?.status !== 'ready') {
      setServiceDecompositionError('Build the local OSM street index before comparing service edges.')
      return
    }

    serviceDecompositionAbortRef.current?.abort()
    const controller = new AbortController()
    serviceDecompositionAbortRef.current = controller
    setServiceDecompositionLoading(true)
    setServiceDecompositionError('')
    try {
      const result = await apiJson<{ decomposition: ServiceEdgeDecomposition }>(
        `/api/projects/${encodeURIComponent(selectedProject.id)}/service-edge-decomposition`,
        {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify({ baselineFeedId, comparisonFeedId }),
        },
      )
      if (controller.signal.aborted) return
      setServiceDecomposition(result.decomposition)
    } catch (error) {
      if (controller.signal.aborted) return
      setServiceDecomposition(null)
      setServiceDecompositionError(error instanceof Error ? error.message : 'Street-service comparison failed.')
    } finally {
      if (serviceDecompositionAbortRef.current === controller) {
        serviceDecompositionAbortRef.current = null
        setServiceDecompositionLoading(false)
      }
    }
  }

  async function runSurfaceAnalysis(includeStreetEdges = scenarioRenderMode === 'streets') {
    if (!analysisOrigin || !nationalRoutingFeed) return
    const draft = activeScenarioDraft()
    if ('error' in draft) {
      setScenarioError(draft.error ?? 'Configure the active case before running it.')
      return
    }
    analysisAbortRef.current?.abort()
    const controller = new AbortController()
    analysisAbortRef.current = controller
    setScenarioLoading(true)
    setScenarioProgress({ phase: 'preparation', progress: 0, detail: 'Starting network Reach' })
    setScenarioError('')
    setReachComparison(null)
    try {
      const response = await apiProgressJson<{ result: ReachResult }>(
        `/api/projects/${encodeURIComponent(selectedProject.id)}/reach`,
        {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify({
            feedId: nationalRoutingFeed.id,
            origin: analysisOrigin,
            departMinutes: scheduleTimeMinutes,
            serviceDate: routingServiceDate,
            serviceDay: routingServiceDay,
            maxWalkKm: routingMaxWalkKm,
            walkSpeedKph: scenarioWalkSpeedKph,
            rasterSize: desktopReachRasterSize,
            cutoffsMinutes: [...new Set([15, 30, 45, 60, 75, 90, scenarioCutoffMinutes])].sort((left, right) => left - right),
            // The final baseline surface is rendered after transit/routing
            // seeds are known. Avoid spending a second full OSM traversal on
            // a provisional walk-only surface for every scenario run.
            includePreliminary: false,
            includeStreetEdges,
            scenario: draft.scenario,
          }),
        },
        setScenarioProgress,
        (preliminary) => setReachResult(preliminary.result),
      )
      setReachResult(response.result)
      setScenarioView((activeScenario?.interventions.length ?? 0) ? 'comparison' : 'baseline')
    } catch (error) {
      if (controller.signal.aborted) return
      setScenarioError(error instanceof Error ? error.message : 'Analysis failed.')
    } finally {
      if (analysisAbortRef.current === controller) {
        analysisAbortRef.current = null
        setScenarioLoading(false)
        setScenarioProgress(null)
      }
    }
  }

  function cancelSurfaceAnalysis() {
    analysisAbortRef.current?.abort()
    analysisAbortRef.current = null
    setScenarioLoading(false)
    setScenarioProgress(null)
  }

  function runRoutingSearch(commandText: string) {
    const command = parseRoutingCommand(commandText.trim())
    if (!command) return false
    setActiveRouteTool('pathfinder')
    const points = command.locationTexts.map(parseRoutingCoordinate)
    if (points.some((point) => !point)) {
      setRoutingPointError('Use latitude, longitude coordinates or pick points on the map.')
      return false
    }
    if (command.departMinutes !== undefined) setScheduleTimeMinutes(command.departMinutes)
    const mode = command.mode ?? routingMode
    setRoutingMode(mode)
    setRoutingTimePreference(mode === 'transit' ? command.timePreference ?? routingTimePreference : 'depart')
    const applied = reorderRoutingPoints(points as RoutingPoint[])
    if (applied) setQuery('')
    return applied
  }

  async function runCommandCenter() {
    const commandText = query.trim()
    if (!commandText) return

    await runRoutingSearch(commandText)
  }

  async function persistRuntimePreferences(next: Partial<Pick<VigoRuntimeConfig, 'appearance' | 'basemap' | 'accent'>>) {
    if (!runtimeConfig) return

    try {
      const result = await apiJson<{ config: VigoRuntimeConfig }>('/api/config', {
        method: 'PATCH',
        body: JSON.stringify({
          storageRoot: runtimeConfig.storageRoot,
          appearance: next.appearance ?? appearance,
          accent: next.accent ?? accent,
          basemap: next.basemap ?? basemap,
        }),
      })
      setRuntimeConfig(result.config)
      setHealth((current) => current ? { ...current, storageRoot: result.config.storageRoot, config: result.config, offline: result.config.offline } : current)
    } catch (error) {
      setApiError(error instanceof Error ? `Could not save the City setting: ${error.message}` : 'Could not save the City setting.')
    }
  }

  function changeAppearance(nextAppearance: Appearance) {
    setAppearance(nextAppearance)
    void persistRuntimePreferences({ appearance: nextAppearance })
  }

  function changeBasemap(nextBasemap: Basemap) {
    setBasemap(nextBasemap)
    void persistRuntimePreferences({ basemap: nextBasemap })
  }

  function showProjects() {
    closeCity()
    setPage('projects')
  }

  function openCreateProjectDialog() {
    setProjectDialogError('')
    setProjectDialog({ mode: 'create', name: '', region: 'Regional bundle' })
  }

  function openRenameProjectDialog(projectId: string) {
    const project = projects.find((item) => item.id === projectId)
    if (!project) return
    setProjectDialogError('')
    setProjectDialog({ mode: 'rename', projectId, name: project.name, region: project.region })
  }

  function closeProjectDialog() {
    if (projectDialogBusy) return
    setProjectDialog(null)
    setProjectDialogError('')
  }

  async function submitProjectDialog(draft: ProjectDraft) {
    if (!projectDialog || projectDialogBusy) return

    const name = draft.name.trim()
    const region = draft.region.trim() || 'Unassigned region'

    if (!name) {
      setProjectDialogError('City name is required.')
      return
    }

    setProjectDialogBusy(true)
    setProjectDialogError('')

    if (projectDialog.mode === 'create') {
      await createProject({ name, region })
    } else {
      await renameProject(projectDialog.projectId, { name, region })
    }
  }

  async function createProject({ name, region }: ProjectDraft) {
    try {
      const result = await apiJson<{ project: VigoProject }>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name, region }),
      })
      replaceProject(result.project)
      openProject(result.project.id)
      setProjectDialog(null)
      setProjectDialogError('')
      setApiError('')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Local API unavailable'
      setProjectDialogError(`City was not saved: ${message}`)
      setApiError(`City was not saved: ${message}`)
    } finally {
      setProjectDialogBusy(false)
    }
  }

  async function renameProject(projectId: string, { name, region }: ProjectDraft) {
    const project = projects.find((item) => item.id === projectId)
    if (!project) {
      setProjectDialogBusy(false)
      return
    }

    try {
      const result = await apiJson<{ project: VigoProject }>(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name, region }),
      })
      replaceProject(result.project)
      setProjectDialog(null)
      setProjectDialogError('')
      setApiError('')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Local API unavailable'
      setProjectDialogError(`City rename was not saved: ${message}`)
      setApiError(`City rename was not saved: ${message}`)
    } finally {
      setProjectDialogBusy(false)
    }
  }

  async function deleteProject(projectId: string, options: { confirm?: boolean } = {}): Promise<boolean> {
    const project = projects.find((item) => item.id === projectId)
    if (!project) return false

    if (options.confirm !== false) {
      const confirmation = globalThis.prompt?.(
        `Delete "${project.name}"?\n\nThis removes the complete City folder from the local library.\nType the City name to confirm.`,
      )?.trim()
      if (confirmation !== project.name) return false
    }

    const applyDeletion = (nextProjects: VigoProject[]) => {
      setProjects(nextProjects)
      const nextSelectedId = preferredProjectId(nextProjects, selectedProjectId === projectId ? '' : selectedProjectId)
      cancelProjectDetail(projectId)
      if (nextSelectedId) beginCitySelection(nextSelectedId, nextProjects)
      else {
        clearRouting()
        setSelectedProjectId('')
        setActiveFeedId(bundleFeedId)
        setQuery('')
        setStatusFilter('all')
      }
      if (!nextProjects.length || selectedProjectId === projectId) setPage('projects')
    }

    try {
      const result = await apiJson<{ ok: boolean; projects: VigoProject[] }>(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: 'DELETE',
      })
      applyDeletion(result.projects)
      setApiError('')
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Local API unavailable'
      setApiError(`City was not deleted: ${message}`)
      return false
    }
  }

  async function waitForImportJob(
    projectId: string,
    jobId: string,
    onProgress: (message: string) => void,
    failureLabel: string,
  ) {
    const existing = importPollingPromisesRef.current.get(jobId)
    if (existing) return existing
    const polling = (async () => {
      let firstPoll = true
      while (true) {
        if (!firstPoll) await new Promise((resolve) => window.setTimeout(resolve, 250))
        firstPoll = false
        const result = await apiJson<{ job: JobRecord }>(
          `/api/projects/${encodeURIComponent(projectId)}/national-gtfs-job?jobId=${encodeURIComponent(jobId)}`,
        ).catch((error) => {
          setPreparationErrors((current) => ({ ...current, [jobId]: error instanceof Error ? error.message : 'Task status is unavailable.' }))
          throw error
        })
        // Keep frequent job ticks separate from the feeds used to build the map.
        setPreparationJobUpdates((current) => ({ ...current, [jobId]: result.job }))
        setProjects((current) => current.find((project) => project.id === projectId)?.jobs.some((job) => job.id === jobId)
          ? current : updateProjectJob(current, projectId, result.job))
        setPreparationErrors((current) => {
          if (!current[jobId]) return current
          const next = { ...current }; delete next[jobId]; return next
        })
        const progress = Math.round(Number(result.job.progress ?? 0) * 100)
        if (selectedPreparationProjectRef.current === projectId) onProgress([result.job.phase, progress ? `${progress}%` : '', result.job.detail].filter(Boolean).join(' / '))
        if (result.job.status === 'failed' || result.job.status === 'cancelled') {
          await refreshImportedProject(projectId, false).catch(() => {})
          throw new Error(result.job.error || (result.job.status === 'cancelled' ? 'Preparation cancelled.' : failureLabel))
        }
        if (result.job.status === 'complete') return result.job
      }
    })()
    importPollingPromisesRef.current.set(jobId, polling)
    try {
      return await polling
    } finally {
      if (importPollingPromisesRef.current.get(jobId) === polling) {
        importPollingPromisesRef.current.delete(jobId)
      }
    }
  }

  async function startPreparation(kind: string, label: string, submit: () => Promise<{ id: string }>) {
    const projectId = selectedProject.id
    const key = `${projectId}:${kind}`
    const task: PreparationTask = { id: key, kind, label, status: 'running', phase: 'Loading source data', createdAt: new Date().toISOString() }
    setPendingPreparations((current) => ({ ...current, [key]: task }))
    setBackgroundTasksOpen(true)
    try {
      const result = await submit()
      setProjects((current) => updateProjectJob(current, projectId, {
        ...task, status: 'queued', progress: 0, phase: 'Waiting for processing status', ...result,
      }))
      setPendingPreparations((current) => { const next = { ...current }; delete next[key]; return next })
      return result
    } catch (error) {
      setPendingPreparations((current) => ({ ...current, [key]: { ...task, status: 'failed', error: error instanceof Error ? error.message : 'Could not load source data.' } }))
      throw error
    }
  }

  async function reconnectPreparation(task: PreparationTask) {
    if (task.kind === 'vehicle-schedules') {
      const request = scheduleLoadRequestsRef.current.get(task.id)
      if (request) { setScheduleLoadRequest(request); setScheduleLoadRetry(value => value + 1) }
      return
    }
    if (task.kind === 'street-runtime-prepare') { streetPreparation.retry(); return }
    const projectId = selectedProject.id
    try {
      await waitForImportJob(projectId, task.id, () => {}, 'Data preparation failed')
      await refreshImportedProject(projectId, true)
    } catch { /* The task panel retains the last status and connection error. */ }
  }

  async function refreshImportedProject(projectId: string, hydrate = true) {
    const detail = hydrate ? '' : '?detail=metadata'
    const projectResult = await apiJson<{ project: VigoProject }>(`/api/projects/${encodeURIComponent(projectId)}${detail}`)
    replaceProject(projectResult.project)
    return projectResult.project
  }

  async function cancelImportJob(kind: 'gtfs' | 'osm') {
    const job = kind === 'gtfs' ? gtfsImportJob : osmImportJob
    if (!job?.id) return
    try {
      await apiJson<{ job: JobRecord }>(`/api/projects/${encodeURIComponent(selectedProject.id)}/national-job-cancel`, {
        method: 'POST',
        body: JSON.stringify({ jobId: job.id }),
      })
      await refreshImportedProject(selectedProject.id, false)
      if (kind === 'gtfs') setImportMessage('GTFS preparation cancelled; the source is available to retry.')
      else setOsmStreetMessage('OSM preparation cancelled; the source is available to retry.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Preparation could not be cancelled.'
      if (kind === 'gtfs') setImportMessage(message)
      else setOsmStreetMessage(message)
    }
  }

  async function retryImportJob(kind: 'gtfs' | 'osm') {
    const job = kind === 'gtfs' ? gtfsImportJob : osmImportJob
    if (!job?.id) return
    if (kind === 'gtfs') {
      setIsImporting(true)
      setImportMessage('Retrying GTFS preparation…')
    } else {
      setIsOsmImporting(true)
      setOsmStreetMessage('Retrying OSM preparation…')
    }
    try {
      const nextJob = await startPreparation(job.kind, job.label, async () => (await apiJson<{ job: JobRecord }>(`/api/projects/${encodeURIComponent(selectedProject.id)}/national-job-retry`, {
        method: 'POST',
        body: JSON.stringify({ jobId: job.id }),
      })).job)
      if (kind === 'gtfs') setGtfsImportJobId(nextJob.id)
      else setOsmImportJobId(nextJob.id)
      const completed = await waitForImportJob(
        selectedProject.id,
        nextJob.id,
        kind === 'gtfs' ? setImportMessage : setOsmStreetMessage,
        kind === 'gtfs' ? 'GTFS indexing failed' : 'Street indexing failed',
      )
      await refreshImportedProject(selectedProject.id, true)
      if (kind === 'gtfs') {
        if (completed.result?.feedId) setActiveFeedId(completed.result.feedId)
        setImportMessage('GTFS SQLite routing store ready')
      } else {
        setOsmStreetMessage('Pedestrian SQLite street index ready')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Preparation retry failed.'
      if (kind === 'gtfs') setImportMessage(message)
      else setOsmStreetMessage(message)
    } finally {
      if (kind === 'gtfs') setIsImporting(false)
      else setIsOsmImporting(false)
    }
  }

  useEffect(() => {
    const projectId = selectedProject.id
    for (const job of preparationJobs.filter((entry) => isPreparationJob(entry) && isActiveTask(entry))) {
      if (importPollingPromisesRef.current.has(job.id)) continue
      const kind = job.kind === 'national-osm-import' ? 'osm' : 'gtfs'
      void waitForImportJob(
        projectId,
        job.id,
        kind === 'gtfs' ? setImportMessage : setOsmStreetMessage,
        kind === 'gtfs' ? 'GTFS indexing failed' : 'Street indexing failed',
      ).then(async (completed) => {
        await refreshImportedProject(projectId, true)
        if (selectedPreparationProjectRef.current === projectId && kind === 'gtfs' && completed.result?.feedId) setActiveFeedId(completed.result.feedId)
      }).catch((error) => {
        if (selectedPreparationProjectRef.current !== projectId) return
        const message = error instanceof Error ? error.message : 'Preparation failed.'
        if (kind === 'gtfs') setImportMessage(message)
        else setOsmStreetMessage(message)
      }).finally(() => {
        if (selectedPreparationProjectRef.current !== projectId) return
        if (kind === 'gtfs') setIsImporting(false)
        else setIsOsmImporting(false)
      })
    }
  }, [preparationJobs.filter((job) => isPreparationJob(job) && isActiveTask(job)).map((job) => job.id).sort().join('|'), selectedProject.id])

  function replaceExistingSchedule(fileName: string) {
    if (!selectedProject.feeds.length) return false
    return window.confirm(
      `Replace every timetable in ${selectedProject.name} with ${fileName}?\n\n`
      + 'Choose Cancel to keep the current feeds and add this as another scope.',
    )
  }

  async function uploadProjectSourceFile(
    file: File,
    action: 'national-gtfs-upload' | 'national-osm-upload',
    replaceProjectSchedule = false,
  ) {
    const parameters = new URLSearchParams({ fileName: file.name })
    if (action === 'national-gtfs-upload' && replaceProjectSchedule) {
      parameters.set('replaceProjectSchedule', 'true')
    }
    if (action === 'national-gtfs-upload') {
      parameters.set('preloadServiceDate', routingServiceDate)
      parameters.set('preloadServiceDay', routingServiceDay)
    }
    const response = await fetch(
      `/api/projects/${encodeURIComponent(selectedProject.id)}/${action}?${parameters}`,
      {
        method: 'POST',
        headers: { 'Content-Type': action === 'national-gtfs-upload' ? 'application/zip' : 'application/octet-stream' },
        body: file,
      },
    )
    const body = await response.json().catch(() => ({})) as { job?: { id: string }; error?: string }
    if (!response.ok || !body.job?.id) throw new Error(body.error || `Source upload failed with ${response.status}`)
    return body.job
  }

  async function handleFiles(filesLike: FileList | File[]) {
    const file = Array.from(filesLike).find((candidate) => candidate.name.toLowerCase().endsWith('.zip'))
    if (!file || isImporting) return
    if (!projects.some((project) => project.id === selectedProject.id)) {
      setImportMessage('Create a City before loading GTFS.')
      setPage('projects')
      return
    }

    setIsImporting(true)
    try {
      setImportMessage(`Staging ${file.name} for SQLite indexing...`)
      const job = await startPreparation('national-gtfs-import', file.name, () => uploadProjectSourceFile(
        file,
        'national-gtfs-upload',
        replaceExistingSchedule(file.name),
      ))
      setGtfsImportJobId(job.id)
      const completed = await waitForImportJob(selectedProject.id, job.id, setImportMessage, 'GTFS indexing failed')
      await refreshImportedProject(selectedProject.id, true)
      if (completed.result?.feedId) setActiveFeedId(completed.result.feedId)
      setImportMessage(`${file.name} / SQLite routing store ready`)
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : 'GTFS indexing failed')
    } finally {
      setIsImporting(false)
    }
  }

  async function handleNationalGtfsPath(sourcePath: string) {
    if (!sourcePath || isImporting) return
    const replaceProjectSchedule = replaceExistingSchedule(
      sourcePath.split(/[\\/]/).pop() || 'this GTFS feed',
    )
    setIsImporting(true)
    setImportMessage('Starting local GTFS index')
    try {
      const job = await startPreparation('national-gtfs-import', sourcePath.split(/[\\/]/).pop() || 'GTFS feed', async () => (await apiJson<{ job: JobRecord }>(`/api/projects/${encodeURIComponent(selectedProject.id)}/national-gtfs-import`, {
        method: 'POST',
        body: JSON.stringify({
          sourcePath,
          replaceProjectSchedule,
          preloadServiceDate: routingServiceDate,
          preloadServiceDay: routingServiceDay,
        }),
      })).job)
      setGtfsImportJobId(job.id)
      const completed = await waitForImportJob(selectedProject.id, job.id, setImportMessage, 'GTFS indexing failed')
      await refreshImportedProject(selectedProject.id, true)
      if (completed.result?.feedId) setActiveFeedId(completed.result.feedId)
      setImportMessage('GTFS SQLite routing store ready')
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : 'GTFS indexing failed')
    } finally {
      setIsImporting(false)
    }
  }

  async function handleNationalOsmPath(sourcePath: string) {
    if (!sourcePath || isOsmImporting) return
    setIsOsmImporting(true)
    setOsmStreetMessage('Starting local street index')
    try {
      const job = await startPreparation('national-osm-import', sourcePath.split(/[\\/]/).pop() || 'OSM streets', async () => (await apiJson<{ job: JobRecord }>(`/api/projects/${encodeURIComponent(selectedProject.id)}/national-osm-import`, {
        method: 'POST',
        body: JSON.stringify({ sourcePath }),
      })).job)
      setOsmImportJobId(job.id)
      await waitForImportJob(selectedProject.id, job.id, setOsmStreetMessage, 'Street indexing failed')
      await refreshImportedProject(selectedProject.id, true)
      setOsmStreetMessage('Pedestrian SQLite street index ready')
    } catch (error) {
      setOsmStreetMessage(error instanceof Error ? error.message : 'Street indexing failed')
    } finally {
      setIsOsmImporting(false)
    }
  }

  async function handleOsmFiles(filesLike: FileList | File[]) {
    const file = Array.from(filesLike).find((candidate) => /\.pbf$/i.test(candidate.name))
    if (!file || isOsmImporting) return
    setIsOsmImporting(true)
    try {
      setOsmStreetMessage(`Staging ${file.name} for SQLite street indexing...`)
      const job = await startPreparation('national-osm-import', file.name, () => uploadProjectSourceFile(file, 'national-osm-upload'))
      setOsmImportJobId(job.id)
      await waitForImportJob(selectedProject.id, job.id, setOsmStreetMessage, 'Street indexing failed')
      await refreshImportedProject(selectedProject.id, true)
      setOsmStreetMessage(`${file.name} / SQLite street index ready`)
    } catch (error) {
      setOsmStreetMessage(error instanceof Error ? error.message : 'Street indexing failed')
    } finally {
      setIsOsmImporting(false)
    }
  }

  const refreshRealtimeRequest = useCallback(async (
    request: RealtimeInspectRequest,
    options: { background?: boolean; openPanel?: boolean; signal?: AbortSignal } = {},
  ) => {
    if (realtimeInFlightRef.current && options.background) return
    realtimeAbortRef.current?.abort()
    const controller = new AbortController()
    realtimeAbortRef.current = controller
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal

    const requestId = realtimeRequestIdRef.current + 1
    realtimeRequestIdRef.current = requestId
    realtimeInFlightRef.current = true
    if (!options.background) {
      setIsRealtimeLoading(true)
      setRealtimeMessage('')
    }

    try {
      const result = await apiJson<{ snapshot: RealtimeSnapshot }>('/api/realtime/inspect', {
        method: 'POST',
        signal,
        body: JSON.stringify({ ...request, projectId: selectedProjectId }),
      })
      if (requestId !== realtimeRequestIdRef.current || signal.aborted) return
      setRealtimeSnapshot(result.snapshot)
      setRealtimeRequest(request)
      setRealtimeMessage('')
      if (!options.background) setVehicleMode('live')
      if (options.openPanel) {
        setSelectedRouteId('')
        setSelectedStopId('')
        setMapScope('network')
        setActiveRouteTool('agency')
      }
    } catch (error) {
      if (requestId !== realtimeRequestIdRef.current || signal.aborted) return
      const message = error instanceof Error ? error.message : 'GTFS-RT decode failed.'
      setRealtimeMessage(message)
    } finally {
      if (requestId === realtimeRequestIdRef.current) {
        realtimeInFlightRef.current = false
        realtimeAbortRef.current = null
        if (!options.background) setIsRealtimeLoading(false)
      }
    }
  }, [selectedProjectId])

  useEffect(() => {
    if (!realtimeRequest || page !== 'project') return
    const polling = startPolling(
      signal => refreshRealtimeRequest(realtimeRequest, { background: true, signal }),
      realtimeRefreshMs,
      { immediate: false },
    )
    return polling.stop
  }, [page, realtimeRequest, refreshRealtimeRequest])
  useEffect(() => () => realtimeAbortRef.current?.abort(), [])

  function connectRealtime(request: RealtimeInspectRequest) {
    void refreshRealtimeRequest(request, { openPanel: true })
  }

  function disconnectRealtime() {
    void apiJson(`/api/projects/${encodeURIComponent(selectedProjectId)}/agency`, { method: 'POST', body: JSON.stringify({ action: 'disconnect' }) }).catch(() => {})
    clearRealtimeConnection()
    setVehicleMode('schedule')
  }

  function changeVehicleMode(mode: ServiceVehicleMode) {
    if (mode === 'live' && !realtimeSnapshot) {
      openDataView()
      return
    }
    setVehicleMode(mode)
  }

  async function submitSetup(draft: SetupDraft) {
    const storageRoot = draft.storageRoot.trim()
    if (!storageRoot) {
      setSetupError('Choose a VIGO home folder.')
      return
    }

    setSetupBusy(true)
    setSetupError('')

    try {
      const result = await apiJson<{ config: VigoRuntimeConfig }>('/api/config', {
        method: 'PATCH',
        body: JSON.stringify(draft),
      })
      setRuntimeConfig(result.config)
      setHealth((current) => current ? { ...current, storageRoot: result.config.storageRoot, config: result.config, offline: result.config.offline } : current)
      setAppearance(result.config.appearance)
      setAccent(result.config.accent)
      setBasemap(result.config.basemap)
      setSetupOpen(false)
      setApiError('')
      await loadProjects()
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : 'Setup failed.')
    } finally {
      setSetupBusy(false)
    }
  }

  async function recoverStorageRoot(storageRoot: string) {
    if (!runtimeConfig) return
    setSetupBusy(true)
    setSetupError('')
    try {
      const result = await apiJson<{ config: VigoRuntimeConfig }>('/api/config', {
        method: 'PATCH',
        body: JSON.stringify({
          storageRoot,
          appearance,
          accent,
          basemap,
        }),
      })
      setRuntimeConfig(result.config)
      setHealth((current) => current ? { ...current, storageRoot: result.config.storageRoot, config: result.config, offline: result.config.offline } : current)
      setApiError('')
      await loadProjects()
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : 'The City library is still unavailable.')
    } finally {
      setSetupBusy(false)
    }
  }

  function chooseRecoveryFolder() {
    const openedDesktop = requestDesktopHomeFolder((path) => {
      void recoverStorageRoot(path)
    })
    if (!openedDesktop) setSetupOpen(true)
  }

  function chooseDataFolder() {
    setSetupError('')
    const openedDesktop = requestDesktopHomeFolder((path) => {
      void recoverStorageRoot(path)
    })
    if (!openedDesktop) setSetupError('Folder selection is available in VIGO Studio.')
  }

  function openNetworkView() {
    if (!hasOperationsData(selectedProject)) return
    setOpenedNetworkProjectId(selectedProject.id)
    setActiveRouteTool('agency')
    setRoutingEnabled(false)
    setSidebarCollapsed(false)
  }

  function openPathfinderView() {
    setActiveRouteTool('pathfinder')
    setMapScope('route')
    setRoutingEnabled(false)
  }

  function clearAgencyMap() {
    setAgencyPlan(null)
    setAgencyReach(null)
    setAgencyLocation(undefined)
  }

  function locateAgencyEntities(routeIds: string[], stopIds: string[], location?: { id: string; label: string; coordinate: [number, number] }, revealMap = true) {
    if (!location && stopIds.length === 1) {
      const stop = findNetworkStop(preview.stops, stopIds[0])
      if (stop && typeof stop.lon === 'number' && typeof stop.lat === 'number' && Number.isFinite(stop.lon) && Number.isFinite(stop.lat)) location = { id: stop.id, label: stop.name, coordinate: [stop.lon, stop.lat] }
    }
    setAgencyPlan(null); setAgencyReach(null); setAgencyLocation(location ? { ...location, stopId: stopIds.length === 1 ? stopIds[0] : undefined } : undefined)
    if (!routeIds.length && !stopIds.length) { setSelectedRouteId(''); setMapScope('network') }
    const route = routeIds.length === 1 ? findNetworkRoute(preview.routes, routeIds[0]) : undefined
    if (route || routeIds[0]) { setSelectedRouteId(route?.id ?? routeIds[0]); setMapScope('route'); setRouteRenderMode('service') }
    setSelectedStopId(stopIds[0] || '')
    if (revealMap && window.innerWidth <= 760) setAgencyMapOpen(true)
  }

  function openAgencyTrip(trip: TripTarget) {
    if (!trip.routeId || !trip.tripId || !trip.serviceDate) return
    browseAgencyEntities([trip.routeId], [])
    const route = findNetworkRoute(preview.routes, trip.routeId)
    setAgencyTripTarget({ routeId: route ? networkRouteId(route) : trip.routeId, tripId: trip.tripId, serviceDate: trip.serviceDate })
  }

  function browseAgencyEntities(routeIds: string[], stopIds: string[], location?: { id: string; label: string; coordinate: [number, number] }) {
    setAgencyTripTarget(undefined)
    locateAgencyEntities(routeIds, stopIds, location, false)
    if (!routeIds.some(Boolean) && !stopIds.some(Boolean)) return
    setAgencyBrowseRequest(request => request + 1)
    setAgencyMapOpen(false)
  }

  function presentAgencyResult(result: ToolResult) {
    const data = result.data as { plan?: RoutingPlan; surface?: unknown }
    if (data?.plan && journeyContinuityIssue(data.plan)) { setAgencyPlan(null); return }
    if (data?.plan) { setAgencyLocation(undefined); setAgencyPlan(data.plan); setAgencyReach(null); setMapScope('route') }
    else if (data?.surface) { setAgencyLocation(undefined); setAgencyReach(result.data as ReachResult); setAgencyPlan(null); setMapScope('network') }
    else if (result.presentation?.location) locateAgencyEntities([], [], result.presentation.location)
    else if (result.presentation?.routeIds?.length === 1 || result.presentation?.stopIds?.length === 1) locateAgencyEntities(result.presentation.routeIds ?? [], result.presentation.stopIds ?? [])
    if (window.innerWidth <= 760 && (data?.plan || data?.surface)) setAgencyMapOpen(true)
  }

  function openAnalyzeView() {
    setActiveRouteTool('analyze')
    setMapScope('network')
    setRoutingEnabled(false)
  }

  function openDataView() {
    routingMergeRequestRef.current = ''
    setRoutingMergeRetryNonce((current) => current + 1)
    setDataSection('feeds')
    setActiveRouteTool('data')
  }

  function openSettingsView() {
    const nextProjectId = selectedProjectId
      || preferredProjectId(projects, navigationMemoryRef.current.lastProjectId)
    if (!nextProjectId) {
      setSetupOpen(true)
      return
    }
    if (page !== 'project' || selectedProjectId !== nextProjectId) {
      applyCitySelection(nextProjectId)
    }
    setPage('project')
    setDataSection('preferences')
    setActiveRouteTool('data')
  }

  useEffect(() => {
    function handleCityShortcut(event: KeyboardEvent) {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (page !== 'project' && event.code !== 'Digit5') return
      const target = event.target
      if (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && target.isContentEditable)
      ) return

      let action: (() => void) | null = null
      switch (event.code) {
        case 'Digit1':
          action = hasActiveOperationsData ? openNetworkView : null
          break
        case 'Digit2':
          action = hasActiveOperationsData ? openPathfinderView : null
          break
        case 'Digit3':
          action = hasActiveOperationsData ? openAnalyzeView : null
          break
        case 'Digit4':
          action = hasActiveOperationsData ? openNetworkView : null
          break
        case 'Digit5':
          action = openSettingsView
          break
        default:
          return
      }
      if (!action) return
      event.preventDefault()
      action()
    }

    window.addEventListener('keydown', handleCityShortcut)
    return () => window.removeEventListener('keydown', handleCityShortcut)
  }, [hasActiveOperationsData, page, projects, selectedProjectId])

  const storageRecoveryRequired = Boolean(runtimeConfig && !runtimeConfig.setupRequired && !runtimeConfig.offline.storageWritable)
  const routingDetailOpen = page === 'project'
    && activeRouteTool === 'pathfinder'
    && Boolean(selectedRoutingPlanId)
    && routingPlan?.status === 'ready'
  const sourceDeletionDisabled = isImporting || isOsmImporting || preparationJobs.some((job) => isPreparationJob(job) && isActiveTask(job))
  const importPanelProps = {
    osmDelete: selectedProject.osmStreetIndex ? <CitySourceDelete key={`${selectedProject.id}:${selectedProject.osmStreetIndex.fileName}`} projectId={selectedProject.id} kind="osm" name={selectedProject.osmStreetIndex.fileName} disabled={sourceDeletionDisabled} onDeleted={applyCityReset} /> : undefined,
    isImporting,
    isOsmImporting,
    gtfsJob: gtfsImportJob,
    osmJob: osmImportJob,
    importMessage,
    osmStreetReady: selectedProject.osmStreetIndex?.status === 'ready',
    osmStreetMessage,
    realtimeSnapshot,
    realtimeMessage,
    realtimeRequest,
    isRealtimeLoading,
    onFiles: handleFiles,
    onNationalGtfsPath: handleNationalGtfsPath,
    onNationalOsmPath: handleNationalOsmPath,
    onOsmFiles: handleOsmFiles,
    onConnectRealtime: connectRealtime,
    onDisconnectRealtime: disconnectRealtime,
    onCancelGtfs: () => { void cancelImportJob('gtfs') },
    onRetryGtfs: () => { void retryImportJob('gtfs') },
    onCancelOsm: () => { void cancelImportJob('osm') },
    onRetryOsm: () => { void retryImportJob('osm') },
  }

  return (
    <main className={classNames('app-shell', `appearance-${appearance}`, `accent-${accent}`, `page-${page}`, isProjectEmpty && 'project-empty', page === 'project' && activeRouteTool === 'data' && 'view-data', activeRouteTool === 'agency' && 'view-agency', agencyMapOpen && 'agency-map-open', routingDetailOpen && 'routing-detail-open', sidebarCollapsed && 'desktop-sidebar-collapsed')}>
      <header className="topbar">
        <div className="topbar-brand" aria-label="City header">
          <button type="button" className="topbar-mark-button" onClick={showProjects} title="Open Cities" aria-label="Open Cities">
            <VigoBrandMark />
          </button>
          <div className="topbar-brand-copy">
            <b>{page === 'projects' ? 'Cities' : quietMapLabel(selectedProject.name)}</b>
          </div>
        </div>

        <SearchPalette
          value={query}
          results={searchResults}
          onChange={setQuery}
          onActivate={activateSearchResult}
          onSubmit={runCommandCenter}
        />

        <div className="topbar-actions">
          {page === 'project' ? <BackgroundTasks key={selectedProject.id}
            tasks={visiblePreparationTasks} open={backgroundTasksOpen} onOpenChange={setBackgroundTasksOpen}
            onOpenData={openDataView} onReconnect={(task) => { void reconnectPreparation(task) }}
          /> : null}
          {page === 'project' ? (
            <button
              type="button"
              className="topbar-project-action surface-exit-action"
              onClick={showProjects}
              title="Back to all Cities"
              aria-label="Switch City"
            >
              <ArrowLeft size={14} />
              <span>Cities</span>
            </button>
          ) : null}
        </div>
      </header>

      {apiError && !storageRecoveryRequired ? (
        <div className="runtime-alert" role="alert">
          <span>{apiError}</span>
          <IconButton label="Dismiss runtime error" onClick={() => setApiError('')}>
            <XCircle size={15} />
          </IconButton>
        </div>
      ) : null}

      <div className="shell-body">
      {page === 'projects' ? null : activeRouteTool === 'data' || activeRouteTool === 'agency' ? (
        <aside className="app-sidebar" aria-label="City navigation">
          <PrimaryNav
            page={page}
            activeRouteTool={activeRouteTool}
            hasActiveData={hasActiveOperationsData}
            onOpenNetwork={openNetworkView}
            onOpenRouting={openPathfinderView}
            onOpenAnalyze={openAnalyzeView}
            onOpenSettings={openSettingsView}
          />
        </aside>
      ) : (
      <VigoSidebar
        page={page}
        projects={projects}
        selectedProject={selectedProject}
        activeFeed={activeFeed}
        activeFeedId={activeFeedId}
        activeRouteTool={activeRouteTool}
        analysisPanel={activeRouteTool === 'analyze' ? (
          <AnalyzePanel
            mode={analyzeMode}
            origin={analysisOrigin}
            serviceDate={routingServiceDate}
            departMinutes={scheduleTimeMinutes}
            maxWalkKm={routingMaxWalkKm}
            walkSpeedKph={scenarioWalkSpeedKph}
            cutoffMinutes={scenarioCutoffMinutes}
            renderMode={scenarioRenderMode}
            cases={scenarioDrafts}
            feeds={comparisonFeedOptions}
            comparisonFeedIds={comparisonFeedIds}
            activeCaseId={activeScenarioId}
            activeInterventionId={activeScenarioChange?.id ?? ''}
            stopPlacement={activeScenarioStopPlacement}
            routes={preview.routes}
            stops={preview.stops}
            routeAnalysisLoading={Boolean(routeAnalysisRouteId)}
            routeAnalysisError={routeAnalysisError}
            view={scenarioView}
            loading={scenarioLoading}
            progress={scenarioProgress}
            error={scenarioError || draftStorageError}
            analysis={reachResult}
            comparison={reachComparison}
            serviceDecomposition={serviceDecomposition}
            serviceDecompositionLoading={serviceDecompositionLoading}
            serviceDecompositionError={serviceDecompositionError}
            routingStoreAvailable={storeBackedRouting}
            streetGraphAvailable={selectedProject.osmStreetIndex?.status === 'ready'}
            preparationTasks={visiblePreparationTasks}
            streetGraphBuilding={selectedProject.osmStreetIndex?.status === 'building'}
            routingStoreBuilding={selectedProject.routingStore?.status === 'building'}
            onServiceDateChange={(value) => {
              changeRoutingServiceDate(value)
              invalidateAnalyzeResult()
            }}
            onDepartMinutesChange={(value) => {
              setScheduleTimeMinutes(value)
              invalidateAnalyzeResult()
            }}
            onMaxWalkKmChange={(value) => {
              changeRoutingMaxWalkKm(value)
              invalidateAnalyzeResult()
            }}
            onWalkSpeedChange={(value) => {
              setScenarioWalkSpeedKph(value)
              invalidateAnalyzeResult()
            }}
            onCutoffChange={(value) => {
              setScenarioCutoffMinutes(value)
              const results = reachComparison?.map(entry => entry.result) ?? (reachResult ? [reachResult] : [])
              if (!results.length || results.some(result => !result.request.cutoffsMinutes.includes(value))) {
                invalidateAnalyzeResult()
              }
            }}
            onRenderModeChange={(mode) => {
              if (mode === scenarioRenderMode) return
              setScenarioRenderMode(mode)
              if (mode !== 'streets') return
              if (analyzeMode !== 'single') {
                if (scenarioLoading || reachComparison?.some((entry) => !entry.result.surface.edges)) {
                  void runFeedComparison(true)
                }
              } else if (scenarioLoading || (reachResult && !reachResult.surface.edges)) {
                void runSurfaceAnalysis(true)
              }
            }}
            onModeChange={(mode) => {
              invalidateAnalyzeResult()
              setAnalyzeMode(mode)
            }}
            onComparisonFeedChange={(feedId, selected) => {
              invalidateAnalyzeResult()
              setComparisonFeedIds((current) => selected
                ? current.includes(feedId) ? current : [...current, feedId]
                : current.filter((candidate) => candidate !== feedId))
            }}
            onSelectCase={selectScenario}
            onAddCase={addScenario}
            onRemoveCase={removeScenario}
            onAddIntervention={addScenarioChange}
            onSelectIntervention={(interventionId) => {
              setScenarioStopPlacement(null)
              setActiveScenarioChangeId(interventionId)
            }}
            onUpdateIntervention={updateScenarioChange}
            onInferInterventionGeometry={(interventionId) => void inferScenarioRoadGeometry(interventionId)}
            onUpdateInterventionRoute={updateScenarioChangeRoute}
            onBeginStopPlacement={beginScenarioStopPlacement}
            onCancelStopPlacement={() => setScenarioStopPlacement(null)}
            onRemoveInterventionStop={removeScenarioStop}
            onResetInterventionStops={resetScenarioRouteStops}
            onRemoveIntervention={removeScenarioChange}
            onClearInterventionSketch={(interventionId) => {
              setScenarioStopPlacement(null)
              updateScenarioChange(interventionId, { stops: [] })
            }}
            onViewChange={setScenarioView}
            onSetOrigin={(point) => {
              invalidateAnalyzeResult()
              setScenarioStopPlacement(null)
              setAnalysisOrigin(point)
            }}
            onClearOrigin={() => {
              invalidateAnalyzeResult()
              setScenarioStopPlacement(null)
              setAnalysisOrigin(null)
            }}
            onRun={() => void runSurfaceAnalysis()}
            onRunComparison={() => void runFeedComparison()}
            onRunServiceDecomposition={() => void runServiceDecomposition()}
            onOpenData={openDataView}
            onCancel={cancelSurfaceAnalysis}
          />
        ) : undefined}
        visiblePreview={visiblePreview}
        selectedRoute={selectedRoute}
        mapScope={mapScope}
        networkLens={networkLens}
        basemap={basemap}
        scheduleTimeMinutes={scheduleTimeMinutes}
        scheduleServiceDate={routingServiceDate}
        routingEnabled={routingEnabled}
        routingOrigin={routingOrigin}
        routingWaypoints={routingWaypoints}
        routingDestination={routingDestination}
        routingPlan={routingPlan}
        routingChoices={routingChoices}
        routingScopeStatus={routingScopeStatus}
        routingStoreReady={routingStoreReady}
        routingStoreFeedCount={routingStoreFeedCount}
        routingStoreStored={routingStoreStored}
        routingStoreStoredFeedCount={routingStoreStoredFeedCount}
        routingStoreTripCount={routingStoreTripCount}
        routingStoreConnectionCount={routingStoreConnectionCount}
        routingTimePreference={routingTimePreference}
        routingMode={routingMode}
        routingDataMode={routingDataMode}
        routingDepartureWindowMinutes={routingDepartureWindowMinutes}
        routingMaxWalkKm={routingMaxWalkKm}
        routingMaxTransfers={routingMaxTransfers}
        routingAllowLongWalk={routingAllowLongWalk}
        routingActivity={routingActivity}
        routingAlternativesLoading={nationalRouting.alternativesLoading}
        routingServiceDate={routingServiceDate}
        routingServiceCoverage={nationalRouting.serviceCoverage}
        routingServiceDateAvailability={nationalRouting.serviceDateAvailability}
        routingServiceDateOptions={nationalRouting.serviceDateOptions}
        routingPointError={routingPointError}
        storeBackedRouting={storeBackedRouting}
        osmStreetMessage={osmStreetMessage}
        realtimeSnapshot={realtimeSnapshot}
        vehicleMode={vehicleMode}
        hasActiveData={hasActiveOperationsData}
        onOpenProject={openProject}
        onSelectFeed={selectFeed}
        onOpenFeed={openDataView}
        onOpenNetwork={openNetworkView}
        onOpenRouting={openPathfinderView}
        onOpenAnalyze={openAnalyzeView}
        onOpenSettings={openSettingsView}
        onOpenLive={() => {
          if (!realtimeSnapshot) {
            openDataView()
            return
          }
          setMapScope('network')
          setActiveRouteTool('agency')
          setVehicleMode('live')
        }}
        onMapScopeChange={setMapScope}
        onNetworkLensChange={selectNetworkLens}
        onBasemapChange={changeBasemap}
        onScheduleTimeChange={setScheduleTimeMinutes}
        onScheduleServiceDateChange={changeRoutingServiceDate}
        onRunRouting={rerunRouting}
        onPickRoutingPoint={pickRoutingPoint}
        routingPickIndex={routingPickIndex}
        onReorderRoutingPoints={reorderRoutingPoints}
        onRoutingTimePreferenceChange={changeRoutingTimePreference}
        onRoutingModeChange={changeRoutingMode}
        onRoutingDataModeChange={changeRoutingDataMode}
        onRoutingDepartureWindowChange={changeRoutingDepartureWindow}
        onRoutingMaxWalkKmChange={changeRoutingMaxWalkKm}
        onRoutingMaxTransfersChange={setRoutingMaxTransfers}
        onRoutingAllowLongWalkChange={setRoutingAllowLongWalk}
        onRoutingServiceDateChange={changeRoutingServiceDate}
        onSelectRoutingPlan={(id) => {
          setSelectedRoutingPlanId(id)
        }}
        onToggleRouting={toggleRouting}
        onClearRouting={clearRouting}
      />
      )}

      <div className="app-frame">
      {storageRecoveryRequired && runtimeConfig ? (
        <StorageRecovery
          config={runtimeConfig}
          busy={setupBusy}
          error={setupError}
          onChooseFolder={chooseRecoveryFolder}
          onUseDefault={() => void recoverStorageRoot(runtimeConfig.defaultStorageRoot)}
        />
      ) : page === 'projects' ? (
        <ProjectsPage
          projects={projects}
          selectedProject={selectedProject}
          query={query}
          previewLoading={cityPreviewLoading}
          onOpenProject={openProject}
          onOpenSettings={openSettingsView}
          onCreateProject={openCreateProjectDialog}
          onRenameProject={openRenameProjectDialog}
          onDeleteProject={deleteProject}
          onRefresh={loadProjects}
        />
      ) : activeRouteTool === 'data' ? (
        <CityPanel
          section={dataSection}
          projectId={selectedProject.id}
          projectName={quietMapLabel(selectedProject.name)}
          projectRegion={selectedProject.region || 'Local City'}
          feedCount={selectedProject.summary.feeds}
          routeCount={selectedProject.summary.routes}
          stopCount={selectedProject.summary.stops}
          appearance={appearance}
          basemap={basemap}
          localBasemapAvailable={selectedProject.osmStreetIndex?.status === 'ready'}
          runtimeConfig={runtimeConfig}
          health={health}
          busy={setupBusy}
          error={setupError}
          projects={projects}
          onSectionChange={setDataSection}
          onChooseFolder={chooseDataFolder}
          onAppearanceChange={changeAppearance}
          onBasemapChange={changeBasemap}
          onCityReset={applyCityReset}
          onCityRemoved={(projectId) => deleteProject(projectId, { confirm: false })}
          feeds={(
            <div className="data-feed-layout">
              <DataReadinessRail project={selectedProject} activeFeed={activeFeed} />
              <ImportPanel staticFeeds={selectedProject.feeds} {...importPanelProps} />
              <BundlePanel
                deletingDisabled={sourceDeletionDisabled}
                onSourceDeleted={applyCityReset}
                project={selectedProject}
                activeFeedId={activeFeedId}
                activeFeed={activeFeed}
                onSelectFeed={selectFeed}
              />
              <FeedTables activeFeed={activeFeed} />
            </div>
          )}
        />
      ) : (
      !hasOperationsData(selectedProject) || openedNetworkProjectId !== selectedProject.id ? (
        <EmptyOperationsStart
          onOpenNetwork={openNetworkView}
          project={selectedProject}
          {...importPanelProps}
        />
      ) : (
      <div className="workbench project-workbench route-investigation-shell">
        <RouteSurface
          onOpenTrip={openAgencyTrip}
          operationalEvents={activeRouteTool === 'agency' ? operationalEvents : undefined}
          agencyFocus={activeRouteTool === 'agency'}
          scheduleLoadStatus={scheduleLoadStatus}
          agencyLocation={agencyLocation}
          routeDetailStatus={selectedRoute && routeHasCompleteGtfsAnalysis(selectedRoute, preview, routingServiceDate)
            ? 'All route patterns'
            : routeAnalysisError ? 'Route detail unavailable · overview only' : 'Loading full route…'}
          key={activeRouteTool === 'agency' ? 'network-map' : 'studio-map'}
          projectId={selectedProject.id}
          feed={activeFeed}
          focusedPreview={focusedMapPreview}
          visiblePreview={workbenchMapPreview}
          selectedRoute={selectedRoute}
          mapScope={mapScope}
          networkLens={networkLens}
          layers={layers}
          appearance={appearance}
          basemap={basemap}
          localBasemapAvailable={selectedProject.osmStreetIndex?.status === 'ready'}
          localBasemapRevision={selectedProject.osmStreetIndex?.builtAt}
          selectedRouteId={selectedRoute?.id ?? ''}
          selectedStopId={activeRouteTool === 'agency' ? selectedStopId : selectedStop?.id ?? ''}
          realtimeSnapshot={realtimeSnapshot}
          vehicleMode={vehicleMode}
          scheduleTimeMinutes={scheduleTimeMinutes}
          scheduleServiceDate={routingServiceDate}
          routingEnabled={activeRouteTool === 'agency' ? false : routingEnabled}
          routingOrigin={activeRouteTool === 'agency' ? agencyPlan?.origin ?? null : activeRouteTool === 'analyze' ? analysisOrigin : routingOrigin}
          routingWaypoints={activeRouteTool === 'agency' ? agencyPlan?.waypoints ?? emptyRoutingPoints : activeRouteTool === 'analyze' ? emptyRoutingPoints : routingWaypoints}
          routingDestination={activeRouteTool === 'agency' ? agencyPlan?.destination ?? null : activeRouteTool === 'analyze' ? null : routingDestination}
          routingPlan={activeRouteTool === 'agency' ? agencyPlan : activeRouteTool === 'analyze' ? null : routingPlan}
          routingFocus={activeRouteTool === 'pathfinder' || activeRouteTool === 'agency' && Boolean(agencyPlan)}
          analysisFocus={activeRouteTool === 'analyze' || activeRouteTool === 'agency' && Boolean(agencyReach)}
          reachResult={activeRouteTool === 'agency' ? agencyReach : activeRouteTool === 'analyze' ? reachResult : null}
          reachComparison={activeRouteTool === 'analyze' ? reachComparison : null}
          serviceDecomposition={activeRouteTool === 'analyze' ? serviceDecomposition : null}
          scenarioView={scenarioView}
          scenarioRenderMode={scenarioRenderMode}
          scenarioCutoffMinutes={scenarioCutoffMinutes}
          scenarioSketchStops={activeRouteTool === 'analyze' ? scenarioSketchStops : emptyScenarioStops}
          scenarioSketchGeometry={activeRouteTool === 'analyze' ? scenarioSketchGeometry : emptyCoordinates}
          scenarioPointPicking={scenarioPointPicking}
          onMoveScenarioStop={activeRouteTool === 'analyze' ? moveScenarioStopFromMap : undefined}
          routingActivity={routingActivity}
          cityPreviewLoading={cityPreviewLoading}
          onMapScopeChange={(scope) => { if (activeRouteTool === 'agency' && scope === 'network') { clearAgencyMap(); returnToNetworkOverview() } setMapScope(scope) }}
          onVehicleModeChange={changeVehicleMode}
          onScheduleTimeChange={setScheduleTimeMinutes}
          onScheduleServiceDateChange={changeRoutingServiceDate}
          onRoutingPoint={activeRouteTool === 'agency' ? undefined : activeRouteTool === 'analyze' ? analysisPointFromMap : routingPointFromMap}
          onSelectRoute={activeRouteTool === 'agency' ? (id, options) => options?.inspect === false ? locateAgencyEntities([id], []) : browseAgencyEntities([id], []) : id => selectRoute(id)}
          onSelectStop={activeRouteTool === 'agency' ? (id, options) => options?.inspect === false ? locateAgencyEntities([], [id]) : browseAgencyEntities([], [id]) : selectStop}
        />
        {activeRouteTool === 'agency' ? <AgencyPanel
          staticFeeds={selectedProject.feeds}
          onOperationalEvents={setOperationalEvents}
          key={selectedProjectId}
          projectId={selectedProjectId}
          selection={{ routeId: mapScope === 'route' && selectedRoute ? networkRouteId(selectedRoute) : undefined, stopId: selectedStopId || undefined }}
          onClearSelection={() => { returnToNetworkOverview(); clearAgencyMap() }}
          onBrowseRoute={id => selectRoute(findNetworkRoute(preview.routes, id)?.id ?? id)}
          timetable={<NetworkTimetable
            feed={activeFeed}
            preview={visiblePreview}
            selectedRoute={mapScope === 'route' ? selectedRoute : undefined}
            selectedStop={selectedStop}
            analysisLoading={Boolean(selectedRoute && routeAnalysisRouteId === selectedRoute.id)}
            analysisError={routeAnalysisError}
            serviceDate={routingServiceDate}
            onServiceDateChange={changeRoutingServiceDate}
            routeRenderMode={routeRenderMode}
            onRouteRenderModeChange={setRouteRenderMode}
            onSelectPattern={(routeId) => selectRoute(routeId, 'pattern')}
            onSelectStop={id => browseAgencyEntities([], [id])}
            onOpenSources={openDataView}
            onClearSelection={returnToNetworkOverview}
          />}
          snapshot={realtimeSnapshot}
          realtimeRequest={realtimeRequest}
          realtimeMessage={realtimeMessage}
          realtimeLoading={isRealtimeLoading}
          onConnect={(request) => void refreshRealtimeRequest(request)}
          onDisconnect={disconnectRealtime}
          onLocate={locateAgencyEntities}
          onResult={presentAgencyResult}
          onOpenData={openDataView}
          mapOpen={agencyMapOpen}
          tripTarget={agencyTripTarget}
          onOpenTrip={openAgencyTrip}
          browseRequest={agencyBrowseRequest}
          onToggleMap={() => setAgencyMapOpen(open => !open)}
        /> : null}
      </div>
      )
      )}

      </div>
      {routingDetailOpen && routingPlan ? (
        <RoutingDetailPanel
          plan={routingPlan}
          onClose={() => setSelectedRoutingPlanId('')}
        />
      ) : null}
      </div>

      <ProjectEditorDialog
        state={projectDialog}
        busy={projectDialogBusy}
        error={projectDialogError}
        onClose={closeProjectDialog}
        onSubmit={submitProjectDialog}
      />

      <FirstRunSetupDialog
        open={setupOpen}
        config={runtimeConfig}
        busy={setupBusy}
        error={setupError}
        onClose={() => {
          if (!runtimeConfig?.setupRequired) setSetupOpen(false)
        }}
        onSubmit={submitSetup}
      />

    </main>
  )
}
