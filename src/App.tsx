import { type CSSProperties, type DragEvent, type ReactNode, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  type LucideIcon,
  Activity,
  AlertTriangle,
  ArrowLeft,
  Clock3,
  Database,
  Download,
  FileArchive,
  FolderOpen,
  FolderPlus,
  MapPin,
  Navigation2,
  Pencil,
  Radio,
  Radar,
  RefreshCw,
  Route,
  Server,
  Settings,
  TableProperties,
  Trash2,
  XCircle,
} from 'lucide-react'
import './App.css'
import type { ToolResult } from './agency/types'
import { AgencyPanel } from './components/AgencyPanel'
import { apiJson, apiProgressJson, type ApiProgress } from './app/api'
import { statusFromJobStatus, statusFromStoreStatus, type ActivityStatus } from './app/status'
import {
  requestDesktopGtfsFile,
  requestDesktopHomeFolder,
  requestDesktopOsmFile,
  subscribeDesktopCommands,
  syncDesktopChromeState,
} from './app/desktopBridge'
import { readNavigationMemory, rememberProject, rememberRoute, rememberSearchResult } from './app/navigationMemory'
import { useProjectDetailHydration } from './app/projectHydration'
import { scenarioStorageKey } from './app/scenarioDraftStorage'
import { createScenarioRoadGeometryRequest } from './app/scenarioRoadGeometryRequest'
import { useScenarioDrafts } from './app/useScenarioDrafts'
import { useNationalRouting } from './app/useNationalRouting'
import { mergeGtfsRouteAnalysis, routeHasCompleteGtfsAnalysis, type GtfsRouteAnalysis } from './app/gtfsAnalysis'
import { routeListLabels } from './app/routePresentation'
import { buildCityPreviewLod } from './app/cityPreview'
import { filterPreviewByStatus, previewForSelectedRoute } from './app/mapPresentation'
import { formatBytes } from './app/presentation'
import {
  buildRoutingActivity,
  localCalendarDate,
  serviceDayForCalendarDate,
  type RoutingActivity,
  type RoutingServiceCoverage,
} from './app/routingPlan'
import {
  bundleFeed,
  bundleFeedId,
  emptyCityProject,
  getTableProfiles,
  hasOperationsData,
  mergeProjectLists,
  mergeProjectState,
  needsProjectDetail,
  orderedProjects,
  preferredProjectId,
  requiredTableNames,
  scopedFeedAndPreview,
} from './app/projectState'
import type {
  AppAccent,
  HealthResponse,
  ProjectDialogState,
  ProjectDraft,
  SetupDraft,
  VigoRuntimeConfig,
} from './app/runtimeConfig'
import type { JobRecord } from './domain'
import {
  basemapOptions,
  networkLensOptions,
  schedulePresets,
  type RoutingDepartureWindowMinutes,
} from './app/uiOptions'
import { LazyVigoMap } from './components/LazyVigoMap'
import {
  RoutingDetailPanel,
  SidebarPathfinderBox,
  type RoutingScopeStatus,
  type SidebarPathfinderBoxProps,
} from './components/PathfinderPanel'
import {
  AnalyzePanel,
  type ComparisonFeedOption,
  type AnalyzeMode,
} from './components/AnalyzePanel'
import { FirstRunSetupDialog, ProjectEditorDialog } from './components/ProjectDialogs'
import { CityPanel, type DataSection } from './components/CityPanel'
import { ExploreObjectPanel } from './components/ExploreObjectPanel'
import { ServiceStateControl } from './components/ServiceStateControl'
import { RealtimePanel } from './components/RealtimePanel'
import { realtimeRefreshMs, type RealtimeInspectRequest } from './app/realtime'
import { SearchPalette } from './features/search/SearchPalette'
import { buildSearchResults, type SearchResult } from './features/search/searchModel'
import { IconButton, StatusBadge, VigoBrandMark } from './components/UiPrimitives'
import {
  type Appearance,
  type Basemap,
  type FeedSummary,
  type GtfsRouteStatusFilter,
  type LayerState,
  type MapPreview,
  type NetworkLens,
  type RealtimeSnapshot,
  type RouteMetric,
  type VigoProject,
  classNames,
  basemapLabels,
  basemapShortLabels,
  formatNumber,
  initialLayers,
  networkLensLabels,
} from './domain'
import { entityFeedScope } from './networkTruth'
import { buildNetworkPerformanceProfile } from './networkPerformance'
import { scopedRouteServiceKey, type RouteRenderMode } from './routeServices'
import { formatServiceTime, scheduledServiceEndMinutes, scheduledVehicleDiagnostics, scheduledVehiclesAtTime } from './scheduledVehicles'
import { buildServiceVehicleFrame, serviceKeyForRoute, serviceVehicleCount, type ServiceVehicleMode } from './serviceVehicles'
import {
  type RoutingPlan,
  type RoutingPoint,
  type RoutingTimePreference,
  type RoutingTravelMode,
} from './routingModel'
import {
  buildNetworkSearchIndex,
  buildRoutingPointFromMap,
  parseRoutingCommand,
} from './routingUi'
import {
  appendRoutingPointSequence,
  insertRoutingPointBeforeDestination,
  maxRoutingPointCount,
  parseRoutingCoordinate,
  normalizeOrderedRoutingPoints,
} from './routingPointSequence'
import {
  routeHasPublishedShape,
  scenarioInsertedStopsForEdge,
  scenarioEdgeEditError,
  scenarioEdgeIndexes,
  scenarioStopsForEdgeBranch,
  scenarioEdgeGeometryForBranch,
  scenarioInsertionAnchors,
  scenarioPublishedShapeSegmentIndexes,
  scenarioSegmentRuntimeMinutes,
  joinScenarioSegmentGeometry,
  scenarioSourceRouteId,
  scenarioStopFromRoutingPoint,
  scenarioStopsForRoute,
  type ScenarioDraft,
  type ScenarioChangeDraft,
  type ScenarioChangeKind,
  type ReachResult,
  type ReachComparisonResult,
  type ScenarioGeometryMode,
  type ScenarioRouteScope,
  type ScenarioRenderMode,
  type ScenarioServiceDraft,
  type ScenarioStopDraft,
  type ScenarioStopPlacement,
  type ScenarioTimeModel,
  type ScenarioView,
  type ServiceEdgeDecomposition,
} from './reach'

type RouteToolKey = 'explore' | 'data' | 'pathfinder' | 'analyze' | 'agency'
type MapScope = 'network' | 'route'
const desktopReachRasterSize = 128

const readinessStateClasses: Record<ActivityStatus, string> = {
  idle: 'state-idle',
  preparing: 'state-preparing',
  ready: 'state-ready',
  stale: 'state-stale',
  blocked: 'state-blocked',
  error: 'state-error',
  cancelled: 'state-cancelled',
}

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

type PublicRouteEntry = {
  key: string
  representative: RouteMetric
  variants: RouteMetric[]
  tripCount: number
  detailLabel: string
}

function publicRouteEntries(routes: RouteMetric[]): PublicRouteEntry[] {
  const groups = new Map<string, RouteMetric[]>()
  for (const route of routes) {
    const key = scopedRouteServiceKey(route)
    const group = groups.get(key)
    if (group) group.push(route)
    else groups.set(key, [route])
  }

  const entries = Array.from(groups.entries())
    .map(([key, group]) => {
      const variants = [...group].sort((left, right) => {
      const rankDelta = (left.patternRank ?? Number.MAX_SAFE_INTEGER) - (right.patternRank ?? Number.MAX_SAFE_INTEGER)
      if (rankDelta) return rankDelta
      return right.tripCount - left.tripCount
    })
      return {
        key,
        representative: variants[0],
        variants,
        tripCount: variants.reduce((sum, route) => sum + route.tripCount, 0),
        detailLabel: '',
      }
    })
    .filter((entry) => Boolean(entry.representative))
    .sort((left, right) => right.tripCount - left.tripCount)
  const labels = routeListLabels(entries.map((entry) => entry.representative))
  return entries.map((entry) => ({
    ...entry,
    detailLabel: labels.get(entry.representative.id) ?? entry.representative.longName,
  }))
}

function quietMapLabel(value: string) {
  return value
    .replace(/\bGTFS[-\s]*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim() || value
}

type FeedIdentity = {
  title: string
  detail: string
  chip: string
  shortLabel: string
}

function compactFeedFileName(fileName = '') {
  const clean = fileName.split(/[\\/]/).pop()?.trim() || ''
  return clean || fileName.trim()
}

function compactFeedVersion(versionLabel = '') {
  const clean = versionLabel.split(',')[0]?.trim() || versionLabel.trim()
  if (!clean || /^local import$/i.test(clean)) return ''
  return clean.length > 18 ? `${clean.slice(0, 17)}...` : clean
}

function feedIdentity(feeds: FeedSummary[], feed: FeedSummary): FeedIdentity {
  const feedIndex = Math.max(0, feeds.findIndex((item) => item.id === feed.id))
  const duplicateName = feeds.filter((item) => item.name === feed.name).length > 1
  const fileName = compactFeedFileName(feed.fileName)
  const fileStem = fileName.replace(/\.(gtfs\.)?zip$/i, '')
  const version = compactFeedVersion(feed.versionLabel)
  const ordinal = `Feed ${feedIndex + 1}`
  const chip = (duplicateName ? fileStem : feed.provider || fileStem || ordinal).slice(0, 10) || ordinal
  const detailParts = duplicateName
    ? [fileName || ordinal, version]
    : [feed.provider !== feed.name ? feed.provider : fileName, version]
  const detail = detailParts.filter(Boolean).join(' · ') || ordinal

  return {
    title: feed.name,
    detail,
    chip,
    shortLabel: duplicateName ? (fileStem || ordinal) : feed.name,
  }
}

function scrollWorkbenchToTop() {
  requestAnimationFrame(() => {
    document.querySelector('.workbench')?.scrollTo({ top: 0, left: 0, behavior: 'smooth' })
  })
}

function PrimaryNavButton({
  title,
  label = title,
  shortcut,
  icon,
  active,
  disabled,
  onClick,
}: {
  title: string
  label?: string
  shortcut?: string
  icon: ReactNode
  active: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={classNames('sidebar-rail-button', active && 'is-active')}
      onClick={onClick}
      disabled={disabled}
      title={shortcut ? `${title} (${shortcut})` : title}
      aria-label={title}
      aria-keyshortcuts={shortcut}
      aria-current={active ? 'page' : undefined}
    >
      {icon}
      <span className="sidebar-rail-label">{label}</span>
    </button>
  )
}

function PrimaryNav({
  page,
  activeRouteTool,
  hasActiveData,
  onOpenExplore,
  onOpenRouting,
  onOpenAnalyze,
  onOpenAgency,
  onOpenSettings,
}: {
  page: 'projects' | 'project'
  activeRouteTool: RouteToolKey
  hasActiveData: boolean
  onOpenExplore: () => void
  onOpenRouting: () => void
  onOpenAnalyze: () => void
  onOpenAgency: () => void
  onOpenSettings: () => void
}) {
  return (
    <nav className="sidebar-rail" aria-label="VIGO Studio">
      <div className="sidebar-rail-main">
        <PrimaryNavButton
          title="Explore"
          label="Explore"
          shortcut="1"
          icon={<Route size={19} aria-hidden="true" />}
          active={page === 'project' && activeRouteTool === 'explore'}
          disabled={page !== 'project' || !hasActiveData}
          onClick={onOpenExplore}
        />
        <PrimaryNavButton
          title="Route"
          label="Route"
          shortcut="2"
          icon={<Navigation2 size={19} aria-hidden="true" />}
          active={page === 'project' && activeRouteTool === 'pathfinder'}
          disabled={page !== 'project' || !hasActiveData}
          onClick={onOpenRouting}
        />
        <PrimaryNavButton
          title="Analyze"
          label="Analyze"
          shortcut="3"
          icon={<Radar size={19} aria-hidden="true" />}
          active={page === 'project' && activeRouteTool === 'analyze'}
          disabled={page !== 'project' || !hasActiveData}
          onClick={onOpenAnalyze}
        />
        <PrimaryNavButton title="Agency" label="Agency" shortcut="4" icon={<Activity size={19} aria-hidden="true" />} active={page === 'project' && activeRouteTool === 'agency'} disabled={page !== 'project' || !hasActiveData} onClick={onOpenAgency} />
      </div>
      <div className="sidebar-rail-bottom">
        <PrimaryNavButton
          title="City"
          label="City"
          shortcut="5"
          icon={<Settings size={19} aria-hidden="true" />}
          active={page === 'project' && activeRouteTool === 'data'}
          disabled={false}
          onClick={onOpenSettings}
        />
      </div>
    </nav>
  )
}

function VigoSidebar({
  page,
  projects,
  selectedProject,
  activeFeed,
  activeFeedId,
  activeRouteTool,
  analysisPanel,
  objectPanel,
  preview,
  visiblePreview,
  selectedRoute,
  mapScope,
  networkLens,
  basemap,
  scheduleTimeMinutes,
  scheduleServiceDate,
  routingEnabled,
  routingOrigin,
  routingWaypoints,
  routingDestination,
  routingPlan,
  routingChoices,
  routingScopeStatus,
  routingStoreReady,
  routingStoreFeedCount,
  routingStoreStored,
  routingStoreStoredFeedCount,
  routingStoreTripCount,
  routingStoreConnectionCount,
  routingTimePreference,
  routingMode,
  routingDepartureWindowMinutes,
  routingMaxWalkKm,
  routingMaxTransfers,
  routingAllowLongWalk,
  routingActivity,
  routingAlternativesLoading,
  routingServiceDate,
  routingServiceCoverage,
  routingServiceDateAvailability,
  routingServiceDateOptions,
  routingPointError,
  storeBackedRouting,
  osmStreetMessage,
  realtimeSnapshot,
  vehicleMode,
  hasActiveData,
  onOpenProject,
  onSelectFeed,
  onSelectRoute,
  onOpenFeed,
  onOpenExplore,
  onOpenRouting,
  onOpenAnalyze,
  onOpenAgency,
  onOpenSettings,
  onOpenLive,
  onMapScopeChange,
  onNetworkLensChange,
  onBasemapChange,
  onScheduleTimeChange,
  onScheduleServiceDateChange,
  onRunRouting,
  onPickRoutingPoint,
  routingPickIndex,
  onReorderRoutingPoints,
  onRoutingTimePreferenceChange,
  onRoutingModeChange,
  onRoutingDepartureWindowChange,
  onRoutingMaxWalkKmChange,
  onRoutingMaxTransfersChange,
  onRoutingAllowLongWalkChange,
  onRoutingServiceDateChange,
  onSelectRoutingPlan,
  onToggleRouting,
  onClearRouting,
}: {
  page: 'projects' | 'project'
  projects: VigoProject[]
  selectedProject: VigoProject
  activeFeed: FeedSummary
  activeFeedId: string
  activeRouteTool: RouteToolKey
  analysisPanel?: ReactNode
  objectPanel?: ReactNode
  preview: MapPreview
  visiblePreview: MapPreview
  selectedRoute?: RouteMetric
  mapScope: MapScope
  networkLens: NetworkLens
  basemap: Basemap
  scheduleServiceDate: string
  routingStoreStored: boolean
  routingStoreStoredFeedCount: number
  routingStoreFeedCount: number
  routingStoreTripCount: number
  routingStoreConnectionCount: number
  osmStreetMessage: string
  realtimeSnapshot: RealtimeSnapshot | null
  vehicleMode: ServiceVehicleMode
  hasActiveData: boolean
  onOpenProject: (id: string) => void
  onSelectFeed: (id: string) => void
  onSelectRoute: (id: string) => void
  onOpenFeed: () => void
  onOpenExplore: () => void
  onOpenRouting: () => void
  onOpenAnalyze: () => void
  onOpenAgency: () => void
  onOpenSettings: () => void
  onOpenLive: () => void
  onMapScopeChange: (scope: MapScope) => void
  onNetworkLensChange: (lens: NetworkLens) => void
  onBasemapChange: (basemap: Basemap) => void
  onScheduleServiceDateChange: (serviceDate: string) => void
} & Pick<SidebarPathfinderBoxProps,
  | 'routingEnabled'
  | 'routingOrigin'
  | 'routingWaypoints'
  | 'routingDestination'
  | 'routingPlan'
  | 'routingChoices'
  | 'routingScopeStatus'
  | 'routingStoreReady'
  | 'routingTimePreference'
  | 'routingMode'
  | 'routingDepartureWindowMinutes'
  | 'routingMaxWalkKm'
  | 'routingMaxTransfers'
  | 'routingAllowLongWalk'
  | 'routingActivity'
  | 'routingAlternativesLoading'
  | 'routingServiceDate'
  | 'routingServiceCoverage'
  | 'routingServiceDateAvailability'
  | 'routingServiceDateOptions'
  | 'routingPointError'
  | 'storeBackedRouting'
  | 'scheduleTimeMinutes'
  | 'onRunRouting'
  | 'onPickRoutingPoint'
  | 'routingPickIndex'
  | 'onReorderRoutingPoints'
  | 'onOpenFeed'
  | 'onScheduleTimeChange'
  | 'onRoutingTimePreferenceChange'
  | 'onRoutingModeChange'
  | 'onRoutingDepartureWindowChange'
  | 'onRoutingMaxWalkKmChange'
  | 'onRoutingMaxTransfersChange'
  | 'onRoutingAllowLongWalkChange'
  | 'onRoutingServiceDateChange'
  | 'onSelectRoutingPlan'
  | 'onToggleRouting'
  | 'onClearRouting'
>) {
  const isDataPanel = page === 'project' && activeRouteTool === 'data'
  const isExplorePanel = page === 'project' && activeRouteTool === 'explore'
  const isPathfinderPanel = page === 'project' && activeRouteTool === 'pathfinder'
  const isAnalyzePanel = page === 'project' && activeRouteTool === 'analyze'
  const panelTitle = page === 'projects'
    ? 'Cities'
    : isDataPanel
      ? 'City'
      : isAnalyzePanel
        ? 'Analyze'
        : isPathfinderPanel
          ? 'Route'
          : 'Explore'
  const panelSubtitle = page === 'projects'
    ? `${projects.length} Cities`
    : isPathfinderPanel
      ? ''
    : isAnalyzePanel
      ? 'Reach and compare'
    : isExplorePanel
      ? ''
    : hasActiveData
      ? activeFeedId === bundleFeedId
        ? quietMapLabel(selectedProject.name)
        : quietMapLabel(activeFeed.name)
      : `${selectedProject.name} needs an indexed GTFS feed`
  const routeFocusActive = mapScope === 'route' && Boolean(selectedRoute)
  const networkPreview = useMemo(() => buildCityPreviewLod(visiblePreview), [visiblePreview])
  const scopedMapPreview = routeFocusActive ? previewForSelectedRoute(visiblePreview, selectedRoute) : networkPreview
  const performanceProfile = useMemo(() => buildNetworkPerformanceProfile(preview), [preview])
  const scopedPerformanceProfile = useMemo(
    () => buildNetworkPerformanceProfile(scopedMapPreview, { precise: routeFocusActive }),
    [routeFocusActive, scopedMapPreview],
  )
  const liveVehicleCount = realtimePositionCount(realtimeSnapshot)
  const renderingLive = vehicleMode === 'live'
  const scheduleProjectionEnabled = hasActiveData && isDataPanel && vehicleMode === 'schedule'
  const scheduledVehicles = useMemo(
    () => scheduleProjectionEnabled
      ? scheduledVehiclesAtTime(scopedMapPreview, scheduleTimeMinutes, scheduleServiceDate)
      : [],
    [scheduleProjectionEnabled, scopedMapPreview, scheduleServiceDate, scheduleTimeMinutes],
  )
  const scheduleDiagnostics = useMemo(
    () => renderingLive
      ? liveVehicleDiagnostics(liveVehicleCount, realtimeSnapshot !== null)
      : scheduleProjectionEnabled
        ? scheduledVehicleDiagnostics(scopedMapPreview, scheduledVehicles, scheduleTimeMinutes, scheduleServiceDate)
        : liveVehicleDiagnostics(0),
    [liveVehicleCount, realtimeSnapshot, renderingLive, scheduleProjectionEnabled, scopedMapPreview, scheduleServiceDate, scheduleTimeMinutes, scheduledVehicles],
  )
  const lensInsight = buildNetworkLensInsight(activeFeed, visiblePreview, networkLens)
  const [routeScrollTop, setRouteScrollTop] = useState(0)
  const [routeViewportHeight, setRouteViewportHeight] = useState(560)
  const routeListRef = useRef<HTMLDivElement>(null)
  const publicRoutes = useMemo(() => publicRouteEntries(visiblePreview.routes), [visiblePreview.routes])
  const sortedRouteList = useMemo(
    () => [...publicRoutes].sort((left, right) => left.representative.shortName.localeCompare(right.representative.shortName, undefined, { numeric: true })),
    [publicRoutes],
  )
  const publicRouteCount = publicRoutes.length
  const routeRowHeight = 50
  const routeOverscan = 8
  const routeWindowSize = Math.max(
    performanceProfile.routeListWindowSize,
    Math.ceil(routeViewportHeight / routeRowHeight) + routeOverscan * 2,
  )
  const routeWindowStart = Math.max(0, Math.floor(routeScrollTop / routeRowHeight) - routeOverscan)
  const routeWindowEnd = Math.min(publicRouteCount, routeWindowStart + routeWindowSize)
  const routeList = sortedRouteList.slice(routeWindowStart, routeWindowEnd)
  const routeTopSpacer = routeWindowStart * routeRowHeight
  const routeBottomSpacer = Math.max(0, (publicRouteCount - routeWindowEnd) * routeRowHeight)
  const networkIndexState = routingStoreReady
    ? 'SQLite service model open'
    : routingStoreStored
      ? `${routingStoreStoredFeedCount}/${Math.max(1, routingStoreFeedCount)} local service stores ready`
      : `${routingStoreStoredFeedCount}/${Math.max(1, routingStoreFeedCount)} local service stores indexed`
  const panelContextLine = isPathfinderPanel
    ? ''
    : isAnalyzePanel
      ? ''
      : isDataPanel
        ? networkIndexState
        : ''

  useEffect(() => {
    setRouteScrollTop(0)
  }, [activeFeedId, preview])

  useEffect(() => {
    const viewport = routeListRef.current
    if (!isExplorePanel || !viewport) return undefined

    const syncViewport = () => {
      const nextHeight = viewport.clientHeight
      setRouteViewportHeight(nextHeight)
      const maxScrollTop = Math.max(0, sortedRouteList.length * routeRowHeight - nextHeight)
      if (viewport.scrollTop > maxScrollTop) viewport.scrollTop = maxScrollTop
      setRouteScrollTop(viewport.scrollTop)
    }

    syncViewport()
    const observer = new ResizeObserver(syncViewport)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [isExplorePanel, routeRowHeight, sortedRouteList.length])

  useEffect(() => {
    if (!isExplorePanel || !selectedRoute || !routeListRef.current) return
    const selectedIndex = sortedRouteList.findIndex((entry) => entry.key === scopedRouteServiceKey(selectedRoute))
    if (selectedIndex < 0) return
    const rowTop = selectedIndex * routeRowHeight
    const rowBottom = rowTop + routeRowHeight
    const viewport = routeListRef.current
    if (rowTop < viewport.scrollTop || rowBottom > viewport.scrollTop + viewport.clientHeight) {
      const nextScrollTop = Math.max(0, rowTop - Math.max(0, viewport.clientHeight - routeRowHeight) / 2)
      viewport.scrollTop = nextScrollTop
      setRouteScrollTop(viewport.scrollTop)
    }
  }, [isExplorePanel, selectedRoute, sortedRouteList])

  return (
    <aside className="app-sidebar" aria-label="City navigation">
      <PrimaryNav
        page={page}
        activeRouteTool={activeRouteTool}
        hasActiveData={hasActiveData}
        onOpenExplore={onOpenExplore}
        onOpenRouting={onOpenRouting}
        onOpenAnalyze={onOpenAnalyze}
        onOpenAgency={onOpenAgency}
        onOpenSettings={onOpenSettings}
      />
      <section className={classNames('sidebar-panel', page === 'project' && `is-${activeRouteTool}`)} aria-label="City panel">
        <div className="sidebar-panel-head">
          <div className="sidebar-panel-title">
            <strong>{panelTitle}</strong>
          </div>
          {panelSubtitle ? <p>{panelSubtitle}</p> : null}
          {panelContextLine ? <span className="sidebar-context-line">{panelContextLine}</span> : null}
        </div>

        {page === 'projects' ? (
          <div className="sidebar-section">
            <div className="sidebar-section-title">
              <strong>Cities</strong>
              <span>{projects.length}</span>
            </div>
            <div className="sidebar-list">
              {orderedProjects(projects).slice(0, 8).map((project) => (
                <button
                  key={project.id}
                  type="button"
                  className={classNames('sidebar-list-row', project.id === selectedProject.id && 'is-selected', !hasOperationsData(project) && 'is-empty')}
                  onClick={() => onOpenProject(project.id)}
                >
                  <strong>{project.name}</strong>
                  <span>{formatNumber(project.summary.feeds)} feeds / {formatNumber(project.summary.routes)} routes</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {!hasActiveData ? (
              <div className="sidebar-section">
                <div className="sidebar-empty-note">
                  <strong>No routes indexed</strong>
                  <span>Load a GTFS ZIP to create route patterns, stops, schedules, and the network map.</span>
                </div>
              </div>
            ) : null}

            {hasActiveData && isDataPanel ? (
              <div className="sidebar-section">
                <div className="sidebar-section-title">
                  <strong>Feeds</strong>
                  <span>{activeFeed.source === 'bundle' ? `${selectedProject.feeds.length} feeds` : 'Scoped'}</span>
                </div>
                <div className="sidebar-list">
                  <button
                    type="button"
                    className={classNames('sidebar-list-row', activeFeedId === bundleFeedId && 'is-selected')}
                    onClick={() => onSelectFeed(bundleFeedId)}
                  >
                    <strong>All feeds</strong>
                    <span>{selectedProject.feeds.length} feed{selectedProject.feeds.length === 1 ? '' : 's'} in {quietMapLabel(selectedProject.name)}</span>
                  </button>
                  {selectedProject.feeds.slice(0, 7).map((feed) => {
                    const identity = feedIdentity(selectedProject.feeds, feed)
                    return (
                      <button
                        key={feed.id}
                        type="button"
                        className={classNames('sidebar-list-row feed-scope-row', activeFeedId === feed.id && 'is-selected')}
                        onClick={() => onSelectFeed(feed.id)}
                      >
                        <strong>{feed.name}</strong>
                        <span>{identity.detail}</span>
                        <small>{identity.chip}</small>
                      </button>
                    )
                  })}
                </div>
              </div>
            ) : null}

            {hasActiveData && isDataPanel ? (
              <SidebarNetworkStatusBox
                project={selectedProject}
                feed={activeFeed}
                preview={visiblePreview}
                routingStoreReady={routingStoreReady}
                routingStoreFeedCount={routingStoreFeedCount}
                routingStoreStored={routingStoreStored}
                routingStoreStoredFeedCount={routingStoreStoredFeedCount}
                routingStoreTripCount={routingStoreTripCount}
                routingStoreConnectionCount={routingStoreConnectionCount}
                osmStreetMessage={osmStreetMessage}
              />
            ) : null}

            {hasActiveData && isDataPanel ? (
              <SidebarNetworkBox
                mapScope={mapScope}
                networkLens={networkLens}
                basemap={basemap}
                scheduleTimeMinutes={scheduleTimeMinutes}
                scheduleServiceDate={scheduleServiceDate}
                scheduleDiagnostics={scheduleDiagnostics}
                scheduleEndMinutes={scheduledServiceEndMinutes(scopedMapPreview, scheduleServiceDate)}
                lensInsight={lensInsight}
                performanceProfile={scopedPerformanceProfile}
                livePositionCount={realtimePositionCount(realtimeSnapshot)}
                realtimeSnapshot={realtimeSnapshot}
                onMapScopeChange={onMapScopeChange}
                onNetworkLensChange={onNetworkLensChange}
                onBasemapChange={onBasemapChange}
                onScheduleTimeChange={onScheduleTimeChange}
                onScheduleServiceDateChange={onScheduleServiceDateChange}
                onOpenLive={onOpenLive}
              />
            ) : null}

            {hasActiveData && isExplorePanel ? (
              <div className={classNames('sidebar-section route-browser-section', selectedRoute && 'has-object-detail')}>
                {selectedRoute ? objectPanel : (
                  <>
                    <div className="sidebar-section-title route-browser-heading">
                      <div>
                        <strong>Routes</strong>
                      </div>
                      <span>{formatNumber(publicRouteCount)} service{publicRouteCount === 1 ? '' : 's'}</span>
                    </div>
                    <div
                      ref={routeListRef}
                      className="sidebar-list compact route-browser-list is-virtual"
                      onScroll={(event) => {
                        setRouteScrollTop(event.currentTarget.scrollTop)
                        setRouteViewportHeight(event.currentTarget.clientHeight)
                      }}
                    >
                      {routeTopSpacer > 0 ? <div className="route-list-spacer" style={{ height: routeTopSpacer }} /> : null}
                      {routeList.map((entry) => {
                        const route = entry.representative

                        return (
                          <div
                            key={entry.key}
                            className="route-tree-item"
                            style={{ '--route-color': route.color } as CSSProperties}
                          >
                            <button
                              type="button"
                              className="sidebar-list-row route-row"
                              onClick={() => onSelectRoute(route.id)}
                              title={entry.detailLabel}
                              aria-label={`${route.shortName}, ${entry.detailLabel}`}
                            >
                              <b style={{ background: route.color }} />
                              <strong>{route.shortName}</strong>
                              <span>{entry.detailLabel}</span>
                            </button>
                          </div>
                        )
                      })}
                      {routeBottomSpacer > 0 ? <div className="route-list-spacer" style={{ height: routeBottomSpacer }} /> : null}
                    </div>
                  </>
                )}
              </div>
            ) : null}

            {hasActiveData && isPathfinderPanel ? (
              <SidebarPathfinderBox
                routingEnabled={routingEnabled}
                routingOrigin={routingOrigin}
                routingWaypoints={routingWaypoints}
                routingDestination={routingDestination}
                routingPlan={routingPlan}
                routingChoices={routingChoices}
                routingScopeStatus={routingScopeStatus}
                routingStoreReady={routingStoreReady}
                routingTimePreference={routingTimePreference}
                routingMode={routingMode}
                routingDepartureWindowMinutes={routingDepartureWindowMinutes}
                routingMaxWalkKm={routingMaxWalkKm}
                routingMaxTransfers={routingMaxTransfers}
                routingAllowLongWalk={routingAllowLongWalk}
                routingActivity={routingActivity}
                routingAlternativesLoading={routingAlternativesLoading}
                routingServiceDate={routingServiceDate}
                routingServiceCoverage={routingServiceCoverage}
                routingServiceDateAvailability={routingServiceDateAvailability}
                routingServiceDateOptions={routingServiceDateOptions}
                routingPointError={routingPointError}
                storeBackedRouting={storeBackedRouting}
                scheduleTimeMinutes={scheduleTimeMinutes}
                onRunRouting={onRunRouting}
                onPickRoutingPoint={onPickRoutingPoint}
                routingPickIndex={routingPickIndex}
                onReorderRoutingPoints={onReorderRoutingPoints}
                onOpenFeed={onOpenFeed}
                onScheduleTimeChange={onScheduleTimeChange}
                onRoutingTimePreferenceChange={onRoutingTimePreferenceChange}
                onRoutingModeChange={onRoutingModeChange}
                onRoutingDepartureWindowChange={onRoutingDepartureWindowChange}
                onRoutingMaxWalkKmChange={onRoutingMaxWalkKmChange}
                onRoutingMaxTransfersChange={onRoutingMaxTransfersChange}
                onRoutingAllowLongWalkChange={onRoutingAllowLongWalkChange}
                onRoutingServiceDateChange={onRoutingServiceDateChange}
                onSelectRoutingPlan={onSelectRoutingPlan}
                onToggleRouting={onToggleRouting}
                onClearRouting={onClearRouting}
              />
            ) : null}

            {hasActiveData && isAnalyzePanel ? analysisPanel : null}
          </>
        )}
      </section>
    </aside>
  )
}

function SidebarNetworkStatusBox({
  project,
  feed,
  preview,
  routingStoreReady,
  routingStoreFeedCount,
  routingStoreStored,
  routingStoreStoredFeedCount,
  routingStoreTripCount,
  routingStoreConnectionCount,
  osmStreetMessage,
}: {
  project: VigoProject
  feed: FeedSummary
  preview: MapPreview
  routingStoreReady: boolean
  routingStoreFeedCount: number
  routingStoreStored: boolean
  routingStoreStoredFeedCount: number
  routingStoreTripCount: number
  routingStoreConnectionCount: number
  osmStreetMessage: string
}) {
  const missingRequiredTables = Object.entries(feed.requiredTables)
    .filter(([, present]) => !present)
    .map(([table]) => table)
  const severeWarnings = feed.warnings
    .filter((warning) => warning.severity === 'error' || warning.severity === 'warning')
    .slice(0, 3)
  const statusTone = missingRequiredTables.length || severeWarnings.some((warning) => warning.severity === 'error')
    ? 'risk'
    : routingStoreReady || routingStoreStored
      ? 'good'
      : 'watch'
  const scheduleText = routingStoreReady
    ? `${formatNumber(routingStoreTripCount)} trips / ${formatNumber(routingStoreConnectionCount)} connections`
    : routingStoreStored
      ? `${formatNumber(routingStoreTripCount)} trips / ${formatNumber(routingStoreConnectionCount)} connections in SQLite`
      : `${routingStoreStoredFeedCount}/${Math.max(1, routingStoreFeedCount)} SQLite stores ready`
  const osmStreetIndex = project.osmStreetIndex?.status === 'ready' ? project.osmStreetIndex : null
  const osmText = osmStreetIndex
    ? `${formatNumber(osmStreetIndex.nodeCount)} nodes / ${formatNumber(osmStreetIndex.edgeCount)} directed edges`
    : 'No local street index'

  return (
    <section className="sidebar-section sidebox sidebox-input" aria-label="Network status">
      <div className="sidebar-section-title">
        <strong>Input status</strong>
        <span>{project.feeds.length} feed{project.feeds.length === 1 ? '' : 's'}</span>
      </div>

      <div className={classNames('sidebox-input-hero', `tone-${statusTone}`)}>
        <span />
        <div>
          <strong>{routingStoreReady ? 'Local service model ready' : routingStoreStored ? 'GTFS indexed in SQLite' : 'GTFS index needed'}</strong>
          <small>{scheduleText}</small>
        </div>
      </div>

      <div className="sidebox-health-grid">
        <div>
          <Database size={13} />
          <span>{formatNumber(preview.routes.length)}</span>
          <small>routes</small>
        </div>
        <div>
          <MapPin size={13} />
          <span>{formatNumber(preview.stops.length)}</span>
          <small>stops</small>
        </div>
        <div>
          <TableProperties size={13} />
          <span>{formatNumber(feed.tripCount)}</span>
          <small>trips</small>
        </div>
        <div>
          <Server size={13} />
          <span>{formatBytes(feed.fileSize)}</span>
          <small>{feed.fileName || 'GTFS ZIP'}</small>
        </div>
      </div>

      <div className="sidebox-finding-list">
        <div className={classNames('sidebox-finding', osmStreetIndex ? 'tone-good' : 'tone-watch')}>
          <strong>{osmStreetIndex ? 'OSM indexed locally' : 'OSM optional'}</strong>
          <span>{osmStreetMessage || osmText}</span>
        </div>
        {missingRequiredTables.length ? (
          <div className="sidebox-finding tone-risk">
            <strong>Missing required tables</strong>
            <span>{missingRequiredTables.join(', ')}</span>
          </div>
        ) : null}
        {severeWarnings.map((warning) => (
          <div key={warning.id} className={classNames('sidebox-finding', warning.severity === 'error' ? 'tone-risk' : 'tone-watch')}>
            <strong>{warning.table || 'GTFS warning'}</strong>
            <span>{warning.message}</span>
          </div>
        ))}
        {!missingRequiredTables.length && !severeWarnings.length ? (
          <div className="sidebox-finding tone-good">
            <strong>Validation clear</strong>
            <span>Required GTFS tables and indexed map artifacts are present.</span>
          </div>
        ) : null}
      </div>
    </section>
  )
}

function SidebarNetworkBox({
  mapScope,
  networkLens,
  basemap,
  scheduleTimeMinutes,
  scheduleServiceDate,
  scheduleDiagnostics,
  scheduleEndMinutes,
  lensInsight,
  performanceProfile,
  livePositionCount,
  realtimeSnapshot,
  onMapScopeChange,
  onNetworkLensChange,
  onBasemapChange,
  onScheduleTimeChange,
  onScheduleServiceDateChange,
  onOpenLive,
}: {
  mapScope: MapScope
  networkLens: NetworkLens
  basemap: Basemap
  scheduleTimeMinutes: number
  scheduleServiceDate: string
  scheduleDiagnostics: ReturnType<typeof scheduledVehicleDiagnostics>
  scheduleEndMinutes: number
  lensInsight: ReturnType<typeof buildNetworkLensInsight>
  performanceProfile: ReturnType<typeof buildNetworkPerformanceProfile>
  livePositionCount: number
  realtimeSnapshot: RealtimeSnapshot | null
  onMapScopeChange: (scope: MapScope) => void
  onNetworkLensChange: (lens: NetworkLens) => void
  onBasemapChange: (basemap: Basemap) => void
  onScheduleTimeChange: (minutes: number) => void
  onScheduleServiceDateChange: (serviceDate: string) => void
  onOpenLive: () => void
}) {
  const clock = formatServiceTime(scheduleTimeMinutes)

  return (
    <section className="sidebar-section sidebox sidebox-network" aria-label="Network controls">
      <div className="sidebar-section-title">
        <strong>Network</strong>
        <span>{performanceProfile.title}</span>
      </div>

      <div className="sidebox-row sidebox-scope" role="group" aria-label="Map scope">
        <button type="button" className={classNames(mapScope === 'network' && 'is-active')} onClick={() => onMapScopeChange('network')}>
          Network
        </button>
        <button type="button" className={classNames(mapScope === 'route' && 'is-active')} onClick={() => onMapScopeChange('route')}>
          Route
        </button>
      </div>

      <div className="sidebox-lens-grid" role="group" aria-label="Network lens">
        {networkLensOptions.map((lens) => (
          <button
            key={lens}
            type="button"
            className={classNames(networkLens === lens && 'is-active')}
            onClick={() => onNetworkLensChange(lens)}
          >
            {networkLensLabels[lens]}
          </button>
        ))}
      </div>

      <div className={classNames('sidebox-insight', `tone-${lensInsight.tone}`)} title={lensInsight.detail}>
        <span />
        <strong>{lensInsight.title}</strong>
        <small>{lensInsight.detail}</small>
      </div>

      <div className="sidebox-time">
        <div className={classNames('sidebox-time-readout', `tone-${scheduleDiagnostics.tone}`)} title={scheduleDiagnostics.detail}>
          <Clock3 size={14} />
          <span>
            <strong>{clock}</strong>
            <small>{scheduleDiagnostics.title}</small>
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={scheduleEndMinutes}
          step={1}
          value={scheduleTimeMinutes}
          onChange={(event) => onScheduleTimeChange(Number(event.currentTarget.value))}
          aria-label="Scrub scheduled vehicle positions"
        />
      </div>

      <div className="sidebox-row sidebox-presets" role="group" aria-label="Time presets">
        {schedulePresets.map((preset) => (
          <button
            key={preset.label}
            type="button"
            className={classNames(Math.abs(scheduleTimeMinutes - preset.minutes) <= 2 && 'is-active')}
            onClick={() => onScheduleTimeChange(preset.minutes)}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <label className="sidebox-row sidebox-days">
        Service date
        <input
          type="date"
          value={scheduleServiceDate}
          onChange={(event) => onScheduleServiceDateChange(event.currentTarget.value)}
          aria-label="Network service date"
        />
      </label>

      <div className="sidebox-row sidebox-basemap" role="group" aria-label="Basemap">
        {basemapOptions.map((option) => (
          <button
            key={option}
            type="button"
            className={classNames(basemap === option && 'is-active')}
            onClick={() => onBasemapChange(option)}
            title={basemapLabels[option]}
          >
            {basemapShortLabels[option]}
          </button>
        ))}
      </div>

      <button type="button" className={classNames('sidebox-live', livePositionCount > 0 && 'has-live')} onClick={onOpenLive}>
        <Radio size={14} />
        <span>{livePositionCount > 0 ? `${formatNumber(livePositionCount)} live vehicles` : realtimeSnapshot ? 'Live · 0 positions' : 'Connect live'}</span>
      </button>
    </section>
  )
}

function realtimePositionCount(snapshot: RealtimeSnapshot | null, route?: RouteMetric) {
  const routeId = route?.routeId || route?.shortName
  return snapshot?.vehicles.filter((vehicle) => (
    typeof vehicle.lon === 'number'
    && Number.isFinite(vehicle.lon)
    && Math.abs(vehicle.lon) <= 180
    && typeof vehicle.lat === 'number'
    && Number.isFinite(vehicle.lat)
    && Math.abs(vehicle.lat) <= 90
    && (!routeId || vehicle.routeId === routeId)
  )).length ?? 0
}

function liveVehicleDiagnostics(vehicleCount: number, connected = false): ReturnType<typeof scheduledVehicleDiagnostics> {
  return {
    tone: vehicleCount > 0 ? 'good' : connected ? 'watch' : 'empty',
    title: vehicleCount > 0 ? `${formatNumber(vehicleCount)} live vehicles` : connected ? 'Live · 0 positions' : 'Live layer idle',
    detail: vehicleCount > 0
      ? `Rendering all ${formatNumber(vehicleCount)} positioned GTFS-RT vehicles in the live service frame.`
      : connected
        ? 'The Vehicle Positions feed returned no valid coordinates. The live frame stays empty and explicit.'
        : 'No live vehicle positions are being rendered.',
  }
}

type NetworkLensInsight = {
  tone: 'good' | 'watch' | 'risk'
  title: string
  detail: string
}

function buildNetworkLensInsight(feed: FeedSummary, preview: MapPreview, networkLens: NetworkLens): NetworkLensInsight {
  const routeCount = preview.routes.length
  const stopCount = preview.stops.length
  const tripCount = preview.routes.reduce((sum, route) => sum + route.tripCount, 0)
  const inferredRoutes = preview.routes.filter((route) => route.geometrySource !== 'shape')
  const shapeBackedRoutes = routeCount - inferredRoutes.length
  const serviceWeakRoutes = preview.routes.filter((route) => route.headwayMinutes > 30 || route.spanHours < 14)
  const transferStops = preview.stops.filter((stop) => stop.routes.length >= 2)
  const blockingWarnings = feed.warnings.filter((warning) => warning.severity === 'error')
  const scenarioRoutes = preview.routes.filter((route) => route.status === 'added' || route.status === 'changed' || route.status === 'removed')
  const totalRiskItems = blockingWarnings.length + inferredRoutes.length + serviceWeakRoutes.length + scenarioRoutes.length

  if (networkLens === 'shape') {
    return inferredRoutes.length
      ? {
          tone: 'watch',
          title: `${formatNumber(inferredRoutes.length)} inferred pattern${inferredRoutes.length === 1 ? '' : 's'}`,
          detail: 'Amber lines use inferred geometry because their GTFS data has no shapes.',
        }
      : {
          tone: 'good',
          title: 'Shape coverage looks strong',
          detail: `${formatNumber(routeCount)} patterns are using GTFS shape geometry.`,
        }
  }

  if (networkLens === 'service') {
    return serviceWeakRoutes.length
      ? {
          tone: 'risk',
          title: `${formatNumber(serviceWeakRoutes.length)} weak service pattern${serviceWeakRoutes.length === 1 ? '' : 's'}`,
          detail: 'Red/amber marks headway above 30m or span below 14h.',
        }
      : {
          tone: 'good',
          title: 'Service lens is clean',
          detail: 'Every route in this scope stays within the basic headway and span limits.',
        }
  }

  if (networkLens === 'transfer') {
    return transferStops.length
      ? {
          tone: 'good',
          title: `${formatNumber(transferStops.length)} transfer stop${transferStops.length === 1 ? '' : 's'}`,
          detail: 'Large halos show the most connected places in the bundle.',
        }
      : {
          tone: 'watch',
          title: 'No transfer pressure detected',
          detail: 'This scope has no stops shared by multiple route patterns.',
        }
  }

  if (networkLens === 'risk') {
    return totalRiskItems
      ? {
          tone: blockingWarnings.length ? 'risk' : 'watch',
          title: `${formatNumber(totalRiskItems)} deterministic risk signal${totalRiskItems === 1 ? '' : 's'}`,
          detail: 'Risk combines blocking rows, inferred shapes, weak service, and scenario deltas.',
        }
      : {
          tone: 'good',
          title: 'No major risk signal',
          detail: 'Validation, shape, service, and scenario checks are quiet in this scope.',
        }
  }

  return {
    tone: inferredRoutes.length ? 'watch' : 'good',
    title: inferredRoutes.length
      ? `${formatNumber(shapeBackedRoutes)}/${formatNumber(routeCount)} shape-backed`
      : `${formatNumber(routeCount)} patterns / ${formatNumber(stopCount)} stops`,
    detail: inferredRoutes.length
      ? `${formatNumber(inferredRoutes.length)} inferred pattern${inferredRoutes.length === 1 ? '' : 's'} are capped to avoid fake route chords.`
      : `${formatNumber(tripCount)} scheduled trips are indexed for network review.`,
  }
}

function ProjectsPage({
  projects,
  selectedProject,
  query,
  previewLoading,
  onOpenProject,
  onOpenSettings,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onRefresh,
}: {
  projects: VigoProject[]
  selectedProject: VigoProject
  query: string
  previewLoading: boolean
  onOpenProject: (id: string) => void
  onOpenSettings: () => void
  onCreateProject: () => void
  onRenameProject: (id: string) => void
  onDeleteProject: (id: string) => void
  onRefresh: () => void
}) {
  const normalizedQuery = query.trim().toLowerCase()
  const visibleProjects = orderedProjects(projects).filter((project) => {
    if (!normalizedQuery) return true
    return [project.id, project.name, project.region, project.storagePath].some((value) => value.toLowerCase().includes(normalizedQuery))
  })

  return (
    <section className="project-page project-switcher" aria-labelledby="surface-switcher-title">
      <header className="surface-switcher-head">
        <div>
          <span className="eyebrow">Cities</span>
          <h1 id="surface-switcher-title">Choose a City</h1>
          <p>Open a City or create one from GTFS and OSM.</p>
        </div>
        <div className="surface-switcher-actions">
          <IconButton label="Refresh Cities" onClick={onRefresh}>
            <RefreshCw size={15} />
          </IconButton>
          <IconButton label="Open settings" onClick={onOpenSettings}>
            <Settings size={15} />
          </IconButton>
          <button type="button" className="button button-primary" onClick={onCreateProject}>
            <FolderPlus size={15} />
            <span>New City</span>
          </button>
        </div>
      </header>

      {visibleProjects.length ? (
        <div className="surface-switcher-list">
          {visibleProjects.map((project) => {
            const hasData = hasOperationsData(project)
            const isSelected = project.id === selectedProject.id
            const readiness = project.routingStore?.status === 'ready'
              ? 'Indexed locally'
              : hasData
                ? 'GTFS available'
                : 'No GTFS data'
            const readinessStatus: ActivityStatus = project.routingStore
              ? statusFromStoreStatus(project.routingStore.status)
              : hasData
                ? 'stale'
                : 'idle'
            return (
              <article key={project.id} className={classNames('surface-switcher-row', isSelected && 'is-current')}>
                <button
                  type="button"
                  className="surface-switcher-open"
                  onClick={() => onOpenProject(project.id)}
                  aria-label={`Open ${project.name} Routes`}
                  aria-current={isSelected ? 'page' : undefined}
                >
                  <span className={classNames('surface-readiness-dot', hasData && 'is-ready')} aria-hidden="true" />
                  <span className="surface-switcher-copy">
                    <strong title={project.name}>{quietMapLabel(project.name)}</strong>
                    <small title={project.region}>{project.region}</small>
                  </span>
                  <span className="surface-switcher-status">
                    <StatusBadge status={readinessStatus} label={readiness} />
                    <small>{formatNumber(project.summary.feeds)} feed{project.summary.feeds === 1 ? '' : 's'} · {formatNumber(project.summary.routes)} route records</small>
                  </span>
                </button>
                <div className="surface-switcher-row-actions" aria-label={`Manage ${project.name}`}>
                  <IconButton label={`Rename ${project.name}`} onClick={() => onRenameProject(project.id)}>
                    <Pencil size={14} />
                  </IconButton>
                  <IconButton label={`Delete ${project.name}`} onClick={() => onDeleteProject(project.id)}>
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              </article>
            )
          })}
          {previewLoading ? (
            <div className="surface-switcher-loading" role="status" aria-live="polite">
              <span />
              Opening City…
            </div>
          ) : null}
        </div>
      ) : (
        <div className="project-empty-state">
          <Database size={24} />
          <strong>{normalizedQuery ? 'No matching City' : 'No Cities yet'}</strong>
          <span>{normalizedQuery ? 'Try a different name.' : 'Create a City, then add GTFS and OSM.'}</span>
          <button type="button" className="button button-primary" onClick={onCreateProject}>
            <FolderPlus size={15} />
            New City
          </button>
        </div>
      )}
    </section>
  )
}

function StorageRecovery({
  config,
  busy,
  error,
  onChooseFolder,
  onUseDefault,
}: {
  config: VigoRuntimeConfig
  busy: boolean
  error: string
  onChooseFolder: () => void
  onUseDefault: () => void
}) {
  return (
    <section className="storage-recovery" role="alert" aria-labelledby="storage-recovery-title">
      <AlertTriangle size={22} />
      <div>
        <span className="eyebrow">City library</span>
        <h1 id="storage-recovery-title">VIGO cannot write to its City library</h1>
        <p>{config.offline.storageError || 'The configured folder is unavailable or read-only.'}</p>
        <small title={config.storageRoot}>{config.storageRoot}</small>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="storage-recovery-actions">
          <button type="button" className="button button-primary" onClick={onChooseFolder} disabled={busy}>
            <FolderOpen size={15} />
            Locate folder
          </button>
          <button type="button" className="button button-secondary" onClick={onUseDefault} disabled={busy}>
            Use default folder
          </button>
        </div>
      </div>
    </section>
  )
}

function ImportPanel({
  isImporting,
  isOsmImporting,
  gtfsJob,
  osmJob,
  importMessage,
  osmStreetReady,
  osmStreetMessage,
  realtimeSnapshot,
  realtimeMessage,
  realtimeRequest,
  isRealtimeLoading,
  onFiles,
  onNationalGtfsPath,
  onNationalOsmPath,
  onOsmFiles,
  onConnectRealtime,
  onDisconnectRealtime,
  onExportReproducibility,
  onCancelGtfs,
  onRetryGtfs,
  onCancelOsm,
  onRetryOsm,
}: {
  isImporting: boolean
  isOsmImporting: boolean
  gtfsJob?: JobRecord
  osmJob?: JobRecord
  importMessage: string
  osmStreetReady: boolean
  osmStreetMessage: string
  realtimeSnapshot: RealtimeSnapshot | null
  realtimeMessage: string
  realtimeRequest: RealtimeInspectRequest | null
  isRealtimeLoading: boolean
  onFiles: (files: FileList | File[]) => void
  onNationalGtfsPath: (path: string) => void
  onNationalOsmPath: (path: string) => void
  onOsmFiles: (files: FileList | File[]) => void
  onConnectRealtime: (request: RealtimeInspectRequest) => void
  onDisconnectRealtime: () => void
  onExportReproducibility: () => void
  onCancelGtfs: () => void
  onRetryGtfs: () => void
  onCancelOsm: () => void
  onRetryOsm: () => void
}) {
  const fileRef = useRef<HTMLInputElement | null>(null)
  const osmFileRef = useRef<HTMLInputElement | null>(null)
  const chooseGtfs = () => {
    if (!requestDesktopGtfsFile(onNationalGtfsPath)) fileRef.current?.click()
  }
  const chooseOsm = () => {
    if (!requestDesktopOsmFile(onNationalOsmPath)) osmFileRef.current?.click()
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    if (event.dataTransfer.files.length) onFiles(event.dataTransfer.files)
  }

  return (
    <section className="surface-panel import-panel" aria-label="Feed import">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Import</span>
          <h2>Add data</h2>
        </div>
        <button type="button" className="panel-heading-action" onClick={onExportReproducibility} title="Download reproducibility manifest">
          <Download size={14} />
          <span>Manifest</span>
        </button>
      </div>

      <div
        className={classNames('drop-zone', isImporting && 'is-working')}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
        onClick={() => {
          if (!isImporting) chooseGtfs()
        }}
        onKeyDown={(event) => {
          if (isImporting || (event.key !== 'Enter' && event.key !== ' ')) return
          event.preventDefault()
          chooseGtfs()
        }}
        role="button"
        tabIndex={0}
        aria-disabled={isImporting}
      >
        <input
          ref={fileRef}
          hidden
          type="file"
          accept=".zip,application/zip"
          onChange={(event) => {
            if (event.currentTarget.files) onFiles(event.currentTarget.files)
            event.currentTarget.value = ''
          }}
        />
        <FileArchive size={22} />
        <div>
          <strong>{isImporting ? 'Importing GTFS…' : 'Add GTFS'}</strong>
          <span>{importMessage || 'Choose or drop a GTFS ZIP'}</span>
        </div>
        {isImporting ? (
          <button type="button" className="import-job-action" onClick={(event) => { event.stopPropagation(); onCancelGtfs() }}>
            <XCircle size={14} />
            Cancel
          </button>
        ) : gtfsJob?.status === 'failed' || gtfsJob?.status === 'cancelled' ? (
          <button type="button" className="import-job-action" onClick={(event) => { event.stopPropagation(); onRetryGtfs() }}>
            <RefreshCw size={14} />
            Retry
          </button>
        ) : null}
      </div>

      <div className={classNames('osm-import-strip', osmStreetReady && 'has-osm')}>
        <button type="button" onClick={chooseOsm} disabled={isOsmImporting}>
          <Navigation2 size={15} />
          <span>
            <strong>{isOsmImporting ? 'Indexing OSM…' : osmStreetReady ? 'OSM indexed' : 'OSM streets'}</strong>
            <small>{osmStreetMessage || (osmStreetReady ? 'SQLite street index ready' : 'OSM PBF')}</small>
          </span>
        </button>
        {isOsmImporting ? (
          <button type="button" className="import-job-action" onClick={onCancelOsm}>
            <XCircle size={14} />
            Cancel
          </button>
        ) : osmJob?.status === 'failed' || osmJob?.status === 'cancelled' ? (
          <button type="button" className="import-job-action" onClick={onRetryOsm}>
            <RefreshCw size={14} />
            Retry
          </button>
        ) : null}
        <input
          ref={osmFileRef}
          hidden
          type="file"
          accept=".osm.pbf,.pbf,application/octet-stream"
          onChange={(event) => {
            if (event.currentTarget.files) onOsmFiles(event.currentTarget.files)
            event.currentTarget.value = ''
          }}
        />
      </div>

      <RealtimePanel
        snapshot={realtimeSnapshot}
        request={realtimeRequest}
        message={realtimeMessage}
        loading={isRealtimeLoading}
        onConnect={onConnectRealtime}
        onDisconnect={onDisconnectRealtime}
      />
    </section>
  )
}

function DataReadinessRail({
  project,
  activeFeed,
}: {
  project: VigoProject
  activeFeed: FeedSummary
}) {
  const tableProfiles = getTableProfiles(activeFeed)
  const requiredProfiles = tableProfiles.filter((profile) => profile.role === 'required')
  const requiredPresent = requiredProfiles.filter((profile) => profile.present).length
  const readyFeedStores = project.feeds.filter((feed) => feed.routingStore?.status === 'ready')
  const routingStore = activeFeed.source === 'bundle' ? project.routingStore : activeFeed.routingStore
  const bundleStoresReady = activeFeed.source === 'bundle' && project.feeds.length > 0 && readyFeedStores.length === project.feeds.length
  const timetableReady = routingStore?.status === 'ready' || bundleStoresReady
  const timetableBuilding = routingStore?.status === 'building' || project.feeds.some((feed) => feed.routingStore?.status === 'building')
  const indexedConnections = routingStore?.status === 'ready'
    ? routingStore.connectionCount
    : readyFeedStores.reduce((sum, feed) => sum + (feed.routingStore?.connectionCount ?? 0), 0)
  const streetStore = project.osmStreetIndex
  const timetableStatus: ActivityStatus = timetableReady
    ? 'ready'
    : timetableBuilding
      ? 'preparing'
      : 'blocked'
  const steps: Array<{
    label: string
    value: string
    detail: string
    state: ActivityStatus
    icon: LucideIcon
  }> = [
    {
      label: 'Source',
      value: `${project.feeds.length} feed${project.feeds.length === 1 ? '' : 's'}`,
      detail: activeFeed.source === 'bundle' ? 'City sources' : activeFeed.name,
      state: project.feeds.length ? 'ready' : 'blocked',
      icon: FileArchive,
    },
    {
      label: 'Tables',
      value: `${requiredPresent}/${requiredProfiles.length || requiredTableNames.length} core`,
      detail: requiredPresent === requiredProfiles.length && requiredProfiles.length ? 'Required GTFS ready' : 'Required files need review',
      state: requiredPresent === requiredProfiles.length && requiredProfiles.length ? 'ready' : 'blocked',
      icon: TableProperties,
    },
    {
      label: 'Timetable',
      value: timetableReady ? 'SQLite ready' : timetableBuilding ? 'Indexing' : 'Needs index',
      detail: timetableReady
        ? `${formatNumber(indexedConnections)} connections`
        : timetableBuilding
          ? 'Building local routing store'
          : 'No ready routing store',
      state: timetableStatus,
      icon: Database,
    },
    {
      label: 'Streets',
      value: streetStore?.status === 'ready' ? 'OSM ready' : streetStore?.status === 'building' ? 'Indexing' : 'Optional',
      detail: streetStore?.status === 'ready'
        ? `${formatNumber(streetStore.edgeCount)} directed edges`
        : streetStore?.status === 'building'
          ? 'Building local street network'
          : 'Add OSM for street access',
      state: statusFromStoreStatus(streetStore?.status),
      icon: Navigation2,
    },
  ]

  return (
    <section className="data-readiness-rail" aria-label="Data readiness pipeline">
      {steps.map((step, index) => {
        const Icon = step.icon
        return (
          <div key={step.label} className={classNames('data-readiness-step', readinessStateClasses[step.state])}>
            <span className="data-readiness-index" aria-hidden="true">{index + 1}</span>
            <Icon size={15} aria-hidden="true" />
            <span>
              <small>{step.label}</small>
              <strong>{step.value}</strong>
              <em>{step.detail}</em>
            </span>
          </div>
        )
      })}
    </section>
  )
}

function BundlePanel({
  project,
  activeFeedId,
  activeFeed,
  onSelectFeed,
}: {
  project: VigoProject
  activeFeedId: string
  activeFeed: FeedSummary
  onSelectFeed: (id: string) => void
}) {
  const bundle = bundleFeed(project)

  return (
    <section className="surface-panel bundle-panel" aria-label="City GTFS sources">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Bundle</span>
          <h2>{project.feeds.length} feed{project.feeds.length === 1 ? '' : 's'}</h2>
        </div>
        <Database size={16} />
      </div>

      <div className="bundle-summary">
        <div><span>{formatNumber(bundle.routeCount)}</span><small>routes</small></div>
        <div><span>{formatNumber(bundle.stopCount)}</span><small>stops</small></div>
        <div><span>{formatNumber(bundle.tripCount)}</span><small>trips</small></div>
      </div>

      <div className="bundle-feed-list">
        <button
          type="button"
          className={classNames('bundle-feed-row', activeFeedId === bundleFeedId && 'is-selected')}
          onClick={() => onSelectFeed(bundleFeedId)}
        >
          <span>
            <strong>Bundle</strong>
            <small>{project.routingStore?.status === 'ready' ? 'City timetable ready' : 'All GTFS in this City'}</small>
          </span>
          <b title={`${bundle.warnings.length} recorded findings`}>{formatNumber(bundle.warnings.length)}</b>
        </button>
        {project.feeds.map((feed) => {
          return (
            <button
              key={feed.id}
              type="button"
              className={classNames('bundle-feed-row', activeFeedId === feed.id && 'is-selected')}
              onClick={() => onSelectFeed(feed.id)}
            >
              <span>
                <strong>{feed.name}</strong>
                <small>{feed.routingStore?.status === 'ready' ? 'SQLite ready' : feedIdentity(project.feeds, feed).detail}</small>
              </span>
              <b title={`${feed.warnings.length} recorded findings`}>{formatNumber(feed.warnings.length)}</b>
            </button>
          )
        })}
      </div>

      <div className="bundle-active">
        <span>{activeFeed.source === 'bundle' ? 'Scope' : 'Feed'}</span>
        <strong>{activeFeed.name}</strong>
      </div>
    </section>
  )
}

function CitySourceStatus({
  icon,
  title,
  detail,
  ready,
  working,
  missingLabel,
  status,
}: {
  icon: ReactNode
  title: string
  detail: string
  ready: boolean
  working: boolean
  missingLabel: string
  status: ActivityStatus
}) {
  return (
    <div className={classNames('surface-source-status', ready && 'is-ready', working && 'is-working')}>
      <span className="surface-source-status-icon">{icon}</span>
      <span className="surface-source-status-copy">
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      <StatusBadge status={status} label={ready ? 'Ready' : working ? 'Preparing' : missingLabel} />
    </div>
  )
}

function EmptyOperationsStart({
  project,
  osmStreetReady,
  isImporting,
  isOsmImporting,
  gtfsJob,
  osmJob,
  importMessage,
  osmStreetMessage,
  realtimeSnapshot,
  realtimeMessage,
  realtimeRequest,
  isRealtimeLoading,
  onFiles,
  onNationalGtfsPath,
  onNationalOsmPath,
  onOsmFiles,
  onConnectRealtime,
  onDisconnectRealtime,
  onExportReproducibility,
  onCancelGtfs,
  onRetryGtfs,
  onCancelOsm,
  onRetryOsm,
}: {
  project: VigoProject
  osmStreetReady: boolean
  isImporting: boolean
  isOsmImporting: boolean
  gtfsJob?: JobRecord
  osmJob?: JobRecord
  importMessage: string
  osmStreetMessage: string
  realtimeSnapshot: RealtimeSnapshot | null
  realtimeMessage: string
  realtimeRequest: RealtimeInspectRequest | null
  isRealtimeLoading: boolean
  onFiles: (files: FileList | File[]) => void
  onNationalGtfsPath: (path: string) => void
  onNationalOsmPath: (path: string) => void
  onOsmFiles: (files: FileList | File[]) => void
  onConnectRealtime: (request: RealtimeInspectRequest) => void
  onDisconnectRealtime: () => void
  onExportReproducibility: () => void
  onCancelGtfs: () => void
  onRetryGtfs: () => void
  onCancelOsm: () => void
  onRetryOsm: () => void
}) {
  const gtfsDetail = isImporting
    ? importMessage || 'Building the local timetable index…'
    : 'Add a GTFS ZIP to load routes and schedules'
  const osmDetail = osmStreetReady
    ? `${formatNumber(project.osmStreetIndex?.edgeCount ?? 0)} walk edges indexed locally`
    : isOsmImporting
      ? osmStreetMessage || 'Building the local street network…'
      : 'Add an OSM PBF to enable street access'

  return (
    <div className="workbench empty-workbench empty-intake">
      <section className="surface-source-intake" aria-labelledby="surface-source-intake-title">
        <div className="surface-source-intake-copy">
          <span className="eyebrow">City data</span>
          <h1 id="surface-source-intake-title">Build {quietMapLabel(project.name)}</h1>
          <p>Add GTFS and OSM to open Explore, Route, and Analyze.</p>
        </div>

        <div className="surface-source-statuses" aria-label="City sources">
          <CitySourceStatus
            icon={<FileArchive size={18} />}
            title="GTFS timetable"
            detail={gtfsDetail}
            ready={false}
            working={isImporting}
            missingLabel="Required"
            status={statusFromJobStatus(gtfsJob?.status ?? (isImporting ? 'running' : 'missing'))}
          />
          <CitySourceStatus
            icon={<Navigation2 size={18} />}
            title="OSM street network"
            detail={osmDetail}
            ready={osmStreetReady}
            working={isOsmImporting}
            missingLabel="Optional"
            status={statusFromJobStatus(osmJob?.status ?? (osmStreetReady ? 'complete' : isOsmImporting ? 'running' : 'idle'))}
          />
        </div>

        <p className="surface-source-hint">
          GTFS supplies scheduled transit. OSM supplies walking and driving streets.
        </p>

        <ImportPanel
          isImporting={isImporting}
          isOsmImporting={isOsmImporting}
          gtfsJob={gtfsJob}
          osmJob={osmJob}
          importMessage={importMessage}
          osmStreetReady={osmStreetReady}
          osmStreetMessage={osmStreetMessage}
          realtimeSnapshot={realtimeSnapshot}
          realtimeMessage={realtimeMessage}
          realtimeRequest={realtimeRequest}
          isRealtimeLoading={isRealtimeLoading}
          onFiles={onFiles}
          onNationalGtfsPath={onNationalGtfsPath}
          onNationalOsmPath={onNationalOsmPath}
          onOsmFiles={onOsmFiles}
          onConnectRealtime={onConnectRealtime}
          onDisconnectRealtime={onDisconnectRealtime}
          onExportReproducibility={onExportReproducibility}
          onCancelGtfs={onCancelGtfs}
          onRetryGtfs={onRetryGtfs}
          onCancelOsm={onCancelOsm}
          onRetryOsm={onRetryOsm}
        />
      </section>
    </div>
  )
}

function MapScopeControl({
  mapScope,
  routeFocusAvailable,
  onMapScopeChange,
}: {
  mapScope: MapScope
  routeFocusAvailable: boolean
  onMapScopeChange: (scope: MapScope) => void
}) {
  return (
    <div className="map-scope-control">
      <span className="map-scope-actions" role="group" aria-label="Map view">
        <button
          type="button"
          className={classNames(mapScope === 'network' && 'is-active')}
          aria-pressed={mapScope === 'network'}
          onClick={() => onMapScopeChange('network')}
        >
          Network
        </button>
        <button
          type="button"
          className={classNames(mapScope === 'route' && routeFocusAvailable && 'is-active')}
          aria-pressed={mapScope === 'route' && routeFocusAvailable}
          disabled={!routeFocusAvailable}
          onClick={() => onMapScopeChange('route')}
        >
          Route
        </button>
      </span>
    </div>
  )
}

function RouteSurface({
  agencyFocus,
  agencyLocation,
  routeDetailStatus,
  projectId,
  feed,
  focusedPreview,
  visiblePreview,
  selectedRoute,
  mapScope,
  networkLens,
  layers,
  appearance,
  basemap,
  localStreetGraphAvailable,
  selectedRouteId,
  selectedStopId,
  realtimeSnapshot,
  vehicleMode,
  scheduleTimeMinutes,
  scheduleServiceDate,
  routingEnabled,
  routingOrigin,
  routingWaypoints,
  routingDestination,
  routingPlan,
  routingFocus,
  analysisFocus,
  reachResult,
  reachComparison,
  serviceDecomposition,
  scenarioView,
  scenarioRenderMode,
  scenarioCutoffMinutes,
  scenarioSketchStops,
  scenarioSketchGeometry,
  scenarioPointPicking,
  onMoveScenarioStop,
  routingActivity,
  cityPreviewLoading,
  onMapScopeChange,
  onVehicleModeChange,
  onScheduleTimeChange,
  onScheduleServiceDateChange,
  onRoutingPoint,
  onSelectRoute,
  onSelectStop,
}: {
  agencyLocation?: { id: string; label: string; coordinate: [number, number] }
  agencyFocus: boolean
  routeDetailStatus?: string
  projectId: string
  feed: FeedSummary
  focusedPreview: MapPreview
  visiblePreview: MapPreview
  selectedRoute?: RouteMetric
  networkLens: NetworkLens
  layers: LayerState
  appearance: Appearance
  basemap: Basemap
  localStreetGraphAvailable: boolean
  selectedRouteId: string
  selectedStopId: string
  realtimeSnapshot: RealtimeSnapshot | null
  vehicleMode: ServiceVehicleMode
  mapScope: MapScope
  scheduleTimeMinutes: number
  scheduleServiceDate: string
  routingEnabled: boolean
  routingOrigin: RoutingPoint | null
  routingWaypoints: RoutingPoint[]
  routingDestination: RoutingPoint | null
  routingPlan: RoutingPlan | null
  routingFocus: boolean
  analysisFocus: boolean
  reachResult: ReachResult | null
  reachComparison: ReachComparisonResult[] | null
  serviceDecomposition: ServiceEdgeDecomposition | null
  scenarioView: ScenarioView
  scenarioRenderMode: ScenarioRenderMode
  scenarioCutoffMinutes: number
  scenarioSketchStops: ScenarioStopDraft[]
  scenarioSketchGeometry: [number, number][]
  scenarioPointPicking: boolean
  onMoveScenarioStop?: (index: number, coordinate: [number, number]) => void
  routingActivity: RoutingActivity
  cityPreviewLoading: boolean
  onMapScopeChange: (scope: MapScope) => void
  onVehicleModeChange: (mode: ServiceVehicleMode) => void
  onScheduleTimeChange: (minutes: number) => void
  onScheduleServiceDateChange: (serviceDate: string) => void
  onRoutingPoint?: (point: RoutingPoint) => void
  onSelectRoute: (id: string) => void
  onSelectStop: (id: string) => void
}) {
  const isNetworkMap = mapScope === 'network' || !selectedRoute
  const routingCanvasPreview = useMemo<MapPreview>(() => ({ routes: [], stops: visiblePreview.stops, stopPairs: [] }), [visiblePreview.stops])
  const cityMapPreview = useMemo(
    () => buildCityPreviewLod(visiblePreview, selectedRouteId),
    [selectedRouteId, visiblePreview],
  )
  const mapPreview = routingFocus || analysisFocus ? routingCanvasPreview : isNetworkMap ? cityMapPreview : focusedPreview
  const mapLayers = useMemo<LayerState>(() => (
    routingFocus || analysisFocus
      ? {
        ...layers,
        routes: false,
        segments: false,
        stops: true,
        transfers: false,
        coverage: false,
        scenario: false,
        access: false,
      }
      : layers
  ), [analysisFocus, layers, routingFocus])
  const selectedMapRouteId = routingFocus || analysisFocus || isNetworkMap ? '' : selectedRouteId
  const performanceProfile = useMemo(
    () => buildNetworkPerformanceProfile(routingFocus || analysisFocus ? visiblePreview : mapPreview, { precise: !isNetworkMap && !routingFocus && !analysisFocus }),
    [analysisFocus, isNetworkMap, mapPreview, routingFocus, visiblePreview],
  )
  const scheduledVehicles = useMemo(
    () => vehicleMode === 'live' || routingFocus || analysisFocus
      ? []
      : scheduledVehiclesAtTime(mapPreview, scheduleTimeMinutes, scheduleServiceDate),
    [analysisFocus, mapPreview, routingFocus, scheduleServiceDate, scheduleTimeMinutes, vehicleMode],
  )
  const vehicleFrame = useMemo(
    () => buildServiceVehicleFrame({
      mode: vehicleMode,
      preview: vehicleMode === 'live' ? visiblePreview : mapPreview,
      realtimeSnapshot,
      scheduledVehicles,
    }),
    [mapPreview, realtimeSnapshot, scheduledVehicles, vehicleMode, visiblePreview],
  )
  const visibleVehicleCount = serviceVehicleCount(vehicleFrame, isNetworkMap ? undefined : selectedRoute, mapPreview)
  const selectedPatternOnly = !isNetworkMap && mapPreview.routes.length === 1 && (selectedRoute?.serviceVariantCount ?? 1) > 1
  const unknownBranchVehicles = vehicleMode === 'live' && selectedPatternOnly && selectedRoute
    ? vehicleFrame.vehicles.filter((vehicle) => vehicle.serviceKey === serviceKeyForRoute(selectedRoute) && !vehicle.routeFeatureId).length
    : 0
  const serviceDiagnostics = useMemo(
    () => vehicleMode === 'live'
      ? selectedPatternOnly
        ? {
            tone: unknownBranchVehicles || !visibleVehicleCount ? 'watch' as const : 'good' as const,
            title: visibleVehicleCount ? `${formatNumber(visibleVehicleCount)} matched live vehicles` : 'No vehicles matched to this pattern',
            detail: `${formatNumber(visibleVehicleCount)} live vehicles matched to this GTFS pattern.${unknownBranchVehicles ? ` ${formatNumber(unknownBranchVehicles)} vehicles have an unknown branch; view Full service to see them.` : ''}`,
          }
        : liveVehicleDiagnostics(visibleVehicleCount, realtimeSnapshot !== null)
      : scheduledVehicleDiagnostics(mapPreview, scheduledVehicles, scheduleTimeMinutes, scheduleServiceDate),
    [mapPreview, realtimeSnapshot, scheduleServiceDate, scheduleTimeMinutes, scheduledVehicles, selectedPatternOnly, unknownBranchVehicles, vehicleMode, visibleVehicleCount],
  )
  const routeStyle = {
    '--route-color': selectedRoute?.color ?? '#6da8ff',
  } as CSSProperties
  const scheduleEndMinutes = useMemo(
    () => scheduledServiceEndMinutes(mapPreview, scheduleServiceDate),
    [mapPreview, scheduleServiceDate],
  )
  const [servicePlaybackRunning, setServicePlaybackRunning] = useState(false)
  const [servicePlaybackStep, setServicePlaybackStep] = useState(1)
  const playbackTimeRef = useRef(scheduleTimeMinutes)

  useEffect(() => {
    playbackTimeRef.current = scheduleTimeMinutes
  }, [scheduleTimeMinutes])

  useEffect(() => {
    if ((routingFocus || analysisFocus || vehicleMode === 'live') && servicePlaybackRunning) setServicePlaybackRunning(false)
  }, [analysisFocus, routingFocus, servicePlaybackRunning, vehicleMode])

  useEffect(() => {
    if (!servicePlaybackRunning || routingFocus || analysisFocus || vehicleMode === 'live') return undefined
    const timer = window.setInterval(() => {
      const nextTime = (playbackTimeRef.current + servicePlaybackStep) % (scheduleEndMinutes + 1)
      playbackTimeRef.current = nextTime
      onScheduleTimeChange(nextTime)
    }, 650)
    return () => window.clearInterval(timer)
  }, [analysisFocus, onScheduleTimeChange, routingFocus, scheduleEndMinutes, servicePlaybackRunning, servicePlaybackStep, vehicleMode])

  return (
    <section className="route-surface" aria-label="GTFS map and service state" style={routeStyle}>
      <div className="surface-panel route-map-shell">
        <LazyVigoMap
          focusLocation={agencyFocus ? agencyLocation : undefined}
          projectId={projectId}
          localStreetGraphAvailable={localStreetGraphAvailable}
          preview={mapPreview}
          feedName={feed.name}
          layers={mapLayers}
          networkLens={networkLens}
          basemap={basemap}
          appearance={appearance}
          performanceProfile={performanceProfile}
          focusMode={analysisFocus ? 'scenario' : routingFocus ? 'routing' : isNetworkMap ? 'network' : 'route'}
          selectedRouteId={selectedMapRouteId}
          selectedStopId={selectedStopId}
          vehicleFrame={vehicleFrame}
          routingEnabled={routingEnabled}
          routingOrigin={routingOrigin}
          routingWaypoints={routingWaypoints}
          routingDestination={routingDestination}
          routingPlan={routingPlan}
          reachResult={reachResult}
          reachComparison={reachComparison}
          serviceDecomposition={serviceDecomposition}
          scenarioView={scenarioView}
          scenarioRenderMode={scenarioRenderMode}
          scenarioCutoffMinutes={scenarioCutoffMinutes}
          scenarioSketchStops={scenarioSketchStops}
          scenarioSketchGeometry={scenarioSketchGeometry}
          scenarioPointPicking={scenarioPointPicking}
          onMoveScenarioStop={onMoveScenarioStop}
          routingStatusTitle={!routingOrigin && !routingDestination ? 'Choose origin and destination' : routingActivity.title}
          routingStatusDetail={!routingOrigin && !routingDestination ? 'Search for two places or pick them on the map.' : routingActivity.detail}
          onSelectRoute={(id) => {
            onSelectRoute(id)
          }}
          onSelectStop={(id) => {
            onSelectStop(id)
          }}
          onRoutingPoint={onRoutingPoint}
        />
        {!agencyFocus && !routingFocus && !analysisFocus ? (
          <MapScopeControl
            mapScope={isNetworkMap ? 'network' : 'route'}
            routeFocusAvailable={Boolean(selectedRoute)}
            onMapScopeChange={onMapScopeChange}
          />
        ) : null}
        {agencyFocus ? (
          <div className="agency-map-context">
            <div>
              <span>{routingFocus ? 'Journey' : analysisFocus ? 'Reachable area' : isNetworkMap ? 'Live network' : `Route ${selectedRoute?.shortName || selectedRoute?.longName || ''}`}</span>
              <small aria-live="polite">
                {routingFocus || analysisFocus ? 'From your investigation' : (
                  <>
                    {realtimeSnapshot ? `${visibleVehicleCount} reported vehicle ${visibleVehicleCount === 1 ? 'location' : 'locations'}` : 'Connect feeds to see vehicle reports'}
                    {!isNetworkMap && routeDetailStatus ? ` · ${routeDetailStatus}` : ''}
                  </>
                )}
              </small>
            </div>
            {!isNetworkMap || routingFocus || analysisFocus ? <button className="agency-button" onClick={() => onMapScopeChange('network')}>All routes</button> : null}
          </div>
        ) : null}
        {cityPreviewLoading ? (
          <div className="surface-loading-overlay" role="status" aria-live="polite">
            <span className="surface-preview-loading" />
            <strong>Loading City…</strong>
          </div>
        ) : null}
        {!agencyFocus && !routingFocus && !analysisFocus ? (
          <ServiceStateControl
            mode={vehicleMode}
            frame={vehicleFrame}
            vehicleCount={visibleVehicleCount}
            diagnostics={serviceDiagnostics}
            scheduleTimeMinutes={scheduleTimeMinutes}
            scheduleServiceDate={scheduleServiceDate}
            scheduleEndMinutes={scheduleEndMinutes}
            playbackRunning={servicePlaybackRunning}
            playbackStep={servicePlaybackStep}
            onModeChange={onVehicleModeChange}
            onTogglePlayback={() => setServicePlaybackRunning((current) => !current)}
            onPlaybackStepChange={setServicePlaybackStep}
            onScheduleTimeChange={onScheduleTimeChange}
            onScheduleServiceDateChange={onScheduleServiceDateChange}
          />
        ) : null}
        {!routingFocus && !analysisFocus && !cityPreviewLoading && !mapPreview.routes.length ? (
          <div className="route-geometry-empty">
            <strong>No spatial alignment in this scope</strong>
            <span>The service remains indexed. Inspect stop coordinates, stop sequences, and shapes.txt to establish defensible map geometry.</span>
          </div>
        ) : null}
      </div>
    </section>
  )
}

function FeedTables({
  activeFeed,
}: {
  activeFeed: FeedSummary
}) {
  const tableProfiles = getTableProfiles(activeFeed)
  const requiredTables = tableProfiles.filter((profile) => profile.role === 'required')
  const optionalTables = tableProfiles.filter((profile) => profile.role === 'optional')
  const requiredPresent = requiredTables.filter((profile) => profile.present).length
  const optionalPresent = optionalTables.filter((profile) => profile.present).length
  const tidesSignals = activeFeed.tides?.signals ?? []

  return (
    <section className="surface-panel feed-table-panel" aria-label="Source table inventory">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Source table inventory</span>
          <h2>{requiredPresent === requiredTables.length && requiredTables.length ? 'Core tables ready' : `${requiredTables.length - requiredPresent} core missing`}</h2>
          <p>{requiredPresent}/{requiredTables.length} required · {optionalPresent}/{optionalTables.length} optional · schema and row counts, not raw records</p>
        </div>
        <TableProperties size={16} />
      </div>

      <div className="feed-table-list" role="list">
        {tableProfiles.map((profile) => (
          <div
            key={profile.name}
            className={classNames('feed-table-row', !profile.present && 'is-missing', profile.name.startsWith('TIDES') && 'is-tides')}
            role="listitem"
          >
            <span>
              <strong>{profile.name}</strong>
              <small>{profile.fields.length ? profile.fields.slice(0, 4).join(', ') : profile.present ? 'profiled' : 'not present'}</small>
            </span>
            <span className="feed-table-status">
              <em>{profile.role}</em>
              <b>{profile.present ? formatNumber(profile.rowCount) : 'Not in feed'}</b>
            </span>
          </div>
        ))}
      </div>

      {tidesSignals.length ? (
        <div className="tides-signal-strip">
          <Activity size={14} />
          <span>{tidesSignals.slice(0, 3).join(' / ')}</span>
        </div>
      ) : null}
    </section>
  )
}

export default function App() {
  const [appearance, setAppearance] = useState<Appearance>('dark')
  const [accent, setAccent] = useState<AppAccent>('blue')
  const [basemap, setBasemap] = useState<Basemap>('streets')
  const [projects, setProjects] = useState<VigoProject[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [runtimeConfig, setRuntimeConfig] = useState<VigoRuntimeConfig | null>(null)
  const [setupOpen, setSetupOpen] = useState(false)
  const [setupBusy, setSetupBusy] = useState(false)
  const [setupError, setSetupError] = useState('')
  const [apiError, setApiError] = useState('')
  const [layers, setLayers] = useState<LayerState>(initialLayers)
  const [vehicleMode, setVehicleMode] = useState<ServiceVehicleMode>('schedule')
  const [selectedRouteId, setSelectedRouteId] = useState('')
  const [selectedStopId, setSelectedStopId] = useState('')
  const routeAnalysisAbortRef = useRef<AbortController | null>(null)
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
  const [agencyLocation, setAgencyLocation] = useState<{ id: string; label: string; coordinate: [number, number] } | undefined>()
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
  const routingMergeRequestRef = useRef('')
  const [routingMergeRetryNonce, setRoutingMergeRetryNonce] = useState(0)
  const [realtimeSnapshot, setRealtimeSnapshot] = useState<RealtimeSnapshot | null>(null)
  const [realtimeMessage, setRealtimeMessage] = useState('')
  const [isRealtimeLoading, setIsRealtimeLoading] = useState(false)
  const [realtimeRequest, setRealtimeRequest] = useState<RealtimeInspectRequest | null>(null)
  const realtimeInFlightRef = useRef(false)
  const realtimeRequestIdRef = useRef(0)
  const [query, setQuery] = useState('')
  const navigationMemoryRef = useRef(readNavigationMemory())
  const [recentSearchIds, setRecentSearchIds] = useState(navigationMemoryRef.current.recentSearchIds)
  const deferredQuery = useDeferredValue(query)
  const [statusFilter, setStatusFilter] = useState<GtfsRouteStatusFilter>('all')
  const [page, setPage] = useState<'projects' | 'project'>('projects')
  const [activeFeedId, setActiveFeedId] = useState(bundleFeedId)
  const [activeRouteTool, setActiveRouteTool] = useState<RouteToolKey>(() => { const saved = sessionStorage.getItem('vigo-agency-view'); return ['explore', 'data', 'pathfinder', 'analyze', 'agency'].includes(saved || '') ? saved as RouteToolKey : 'agency' })
  useEffect(() => { sessionStorage.setItem('vigo-agency-view', activeRouteTool) }, [activeRouteTool])
  const [dataSection, setDataSection] = useState<DataSection>('feeds')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [agencyMapOpen, setAgencyMapOpen] = useState(false)
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
  const latestGtfsJob = [...selectedProject.jobs]
    .filter((job) => job.kind === 'national-gtfs-import')
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
  const latestOsmJob = [...selectedProject.jobs]
    .filter((job) => job.kind === 'national-osm-import')
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
  const gtfsImportJob = selectedProject.jobs.find((job) => job.id === gtfsImportJobId) ?? latestGtfsJob
  const osmImportJob = selectedProject.jobs.find((job) => job.id === osmImportJobId) ?? latestOsmJob
  const latestActiveGtfsJob = selectedProject.jobs.find((job) => (
    job.kind === 'national-gtfs-import' && ['queued', 'running'].includes(job.status)
  ))
  const latestActiveOsmJob = selectedProject.jobs.find((job) => (
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
  const routingStreetState: 'ready' | 'loading' | 'missing' = !mapPointRoutingNeedsStreetGraph ||
    Boolean(nationalRoutingFeed && selectedProject.osmStreetIndex?.status === 'ready')
    ? 'ready'
    : selectedProject.osmStreetIndex?.status === 'building'
      ? 'loading'
      : 'missing'
  const nationalRouting = useNationalRouting({
    active: Boolean(
      nationalRoutingFeed
      && activeRouteTool === 'pathfinder',
    ),
    projectId: selectedProject.id,
    feedId: nationalRoutingFeed?.id ?? '',
    storeKey: nationalRoutingStoreKey,
    origin: activeRouteTool === 'pathfinder' ? routingOrigin : null,
    waypoints: routingWaypoints,
    destination: activeRouteTool === 'pathfinder' ? routingDestination : null,
    mode: routingMode,
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
    onError: setApiError,
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
  const hasActiveOperationsData = hasOperationsData(selectedProject) && (activeFeed.routeCount > 0 || preview.routes.length > 0)
  const networkSearchIndex = useMemo(() => buildNetworkSearchIndex(preview), [preview])
  const visiblePreview = useMemo(() => filterPreviewByStatus(preview, statusFilter), [preview, statusFilter])
  const workbenchMapPreview = visiblePreview
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
    ? preview.routes.find((route) => route.id === selectedRouteId || route.patternId === selectedRouteId)
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
    : []
  const scenarioSketchGeometry = useMemo<[number, number][]>(() => {
    if (!activeScenarioChange || scenarioSketchStops.length < 2) return []
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
    if (geometryMode === 'auto-road') return publishedGeometry ?? []
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
    ? preview.stops.find((stop) => stop.id === selectedStopId)
    : undefined
  const focusedMapPreview = useMemo(
    () => previewForSelectedRoute(workbenchMapPreview, selectedRoute, routeRenderMode),
    [routeRenderMode, selectedRoute, workbenchMapPreview],
  )
  const routingChoices = nationalRouting.choices
  const routingPlan = routingChoices.find((plan) => plan.id === selectedRoutingPlanId)
    ?? routingChoices.find((plan) => plan.recommended)
    ?? routingChoices[0]
    ?? null
  const routingActivity = buildRoutingActivity({
    routingError: nationalRouting.error,
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
    && !hasOperationsData(selectedProject)

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
        setPage('project')
        beginCitySelection(nextSelectedId, nextProjects)
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
    const needsRouteDetail = activeRouteTool === 'explore'
      || activeRouteTool === 'agency' && mapScope === 'route'
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
    if (selectedRouteId && !preview.routes.some((route) => route.id === selectedRouteId || route.patternId === selectedRouteId)) {
      setSelectedRouteId('')
      navigationMemoryRef.current = rememberRoute(selectedProject.id, '')
    }
    if (selectedStopId && !preview.stops.some((stop) => stop.id === selectedStopId)) setSelectedStopId('')
  }, [preview, selectedProject.id, selectedRouteId, selectedStopId, cityPreviewLoading])

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
    setActiveRouteTool('explore')
    setSidebarCollapsed(false)
    applyNetworkMapDefaults()
  }

  function openProject(projectId: string) {
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

    routeAnalysisAbortRef.current?.abort()
    const controller = new AbortController()
    routeAnalysisAbortRef.current = controller
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
    if (route?.stopIds.length) {
      setSelectedStopId((current) => route.stopIds.includes(current) ? current : route.stopIds[0])
    }
    setActiveRouteTool('explore')
    applyRouteMapDefaults()
  }

  function selectStop(stopId: string) {
    setSelectedStopId(stopId)
    setActiveRouteTool('explore')
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
      selectStop(result.id.slice('stop:'.length))
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
      openRoutesView()
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
        )
        const progress = Math.round(Number(result.job.progress ?? 0) * 100)
        onProgress([result.job.phase, progress ? `${progress}%` : '', result.job.detail].filter(Boolean).join(' / '))
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

  async function refreshImportedProject(projectId: string, hydrate = true) {
    const detail = hydrate ? '' : '?detail=metadata'
    const projectResult = await apiJson<{ project: VigoProject }>(`/api/projects/${encodeURIComponent(projectId)}${detail}`)
    replaceProject(projectResult.project)
    return projectResult.project
  }

  async function exportReproducibilityManifest() {
    try {
      const result = await apiJson<{ manifest: Record<string, unknown> }>(`/api/projects/${encodeURIComponent(selectedProject.id)}/reproducibility`)
      const blob = new Blob([`${JSON.stringify(result.manifest, null, 2)}\n`], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${selectedProject.id}-reproducibility.json`
      anchor.click()
      URL.revokeObjectURL(url)
      setImportMessage('Reproducibility manifest downloaded')
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : 'Reproducibility manifest could not be downloaded.')
    }
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
      const result = await apiJson<{ job: JobRecord }>(`/api/projects/${encodeURIComponent(selectedProject.id)}/national-job-retry`, {
        method: 'POST',
        body: JSON.stringify({ jobId: job.id }),
      })
      if (kind === 'gtfs') setGtfsImportJobId(result.job.id)
      else setOsmImportJobId(result.job.id)
      const completed = await waitForImportJob(
        selectedProject.id,
        result.job.id,
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
    const activeJobs: Array<{ job: JobRecord; kind: 'gtfs' | 'osm' }> = [
      ...(latestActiveGtfsJob ? [{ job: latestActiveGtfsJob, kind: 'gtfs' as const }] : []),
      ...(latestActiveOsmJob ? [{ job: latestActiveOsmJob, kind: 'osm' as const }] : []),
    ]
    for (const { job, kind } of activeJobs) {
      void waitForImportJob(
        selectedProject.id,
        job.id,
        kind === 'gtfs' ? setImportMessage : setOsmStreetMessage,
        kind === 'gtfs' ? 'GTFS indexing failed' : 'Street indexing failed',
      ).then(async (completed) => {
        await refreshImportedProject(selectedProject.id, true)
        if (kind === 'gtfs' && completed.result?.feedId) setActiveFeedId(completed.result.feedId)
      }).catch((error) => {
        const message = error instanceof Error ? error.message : 'Preparation failed.'
        if (kind === 'gtfs') setImportMessage(message)
        else setOsmStreetMessage(message)
      }).finally(() => {
        if (kind === 'gtfs') setIsImporting(false)
        else setIsOsmImporting(false)
      })
    }
  }, [latestActiveGtfsJob?.id, latestActiveOsmJob?.id, selectedProject.id])

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
      const job = await uploadProjectSourceFile(
        file,
        'national-gtfs-upload',
        replaceExistingSchedule(file.name),
      )
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
      const { job } = await apiJson<{ job: { id: string } }>(`/api/projects/${encodeURIComponent(selectedProject.id)}/national-gtfs-import`, {
        method: 'POST',
        body: JSON.stringify({
          sourcePath,
          replaceProjectSchedule,
          preloadServiceDate: routingServiceDate,
          preloadServiceDay: routingServiceDay,
        }),
      })
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
      const { job } = await apiJson<{ job: { id: string } }>(`/api/projects/${encodeURIComponent(selectedProject.id)}/national-osm-import`, {
        method: 'POST',
        body: JSON.stringify({ sourcePath }),
      })
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
      const job = await uploadProjectSourceFile(file, 'national-osm-upload')
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
    options: { background?: boolean; openPanel?: boolean } = {},
  ) => {
    if (realtimeInFlightRef.current) {
      return
    }

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
        body: JSON.stringify({ ...request, projectId: selectedProjectId }),
      })
      if (requestId !== realtimeRequestIdRef.current) return
      setRealtimeSnapshot(result.snapshot)
      setRealtimeRequest(request)
      setRealtimeMessage('')
      if (!options.background) setVehicleMode('live')
      if (options.openPanel) {
        setSelectedRouteId('')
        setSelectedStopId('')
        setMapScope('network')
        setActiveRouteTool('explore')
      }
    } catch (error) {
      if (requestId !== realtimeRequestIdRef.current) return
      const message = error instanceof Error ? error.message : 'GTFS-RT decode failed.'
      setRealtimeMessage(message)
    } finally {
      if (requestId === realtimeRequestIdRef.current) {
        realtimeInFlightRef.current = false
        if (!options.background) setIsRealtimeLoading(false)
      }
    }
  }, [selectedProjectId])

  useEffect(() => {
    if (!realtimeRequest) return
    const interval = window.setInterval(() => {
      void refreshRealtimeRequest(realtimeRequest, { background: true })
    }, realtimeRefreshMs)

    return () => window.clearInterval(interval)
  }, [realtimeRequest, refreshRealtimeRequest])

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

  function openRoutesView() {
    setActiveRouteTool('explore')
    returnToNetworkOverview()
  }

  function openPathfinderView() {
    setActiveRouteTool('pathfinder')
    setMapScope('route')
    setRoutingEnabled(false)
  }

  function openAgencyView() {
    setActiveRouteTool('agency')
    setMapScope('network')
    setRoutingEnabled(false)
    setSidebarCollapsed(false)
  }

  function clearAgencyMap() {
    setAgencyPlan(null)
    setAgencyReach(null)
    setAgencyLocation(undefined)
  }

  function locateAgencyEntities(routeIds: string[], stopIds: string[], location?: { id: string; label: string; coordinate: [number, number] }) {
    setAgencyPlan(null); setAgencyReach(null); setAgencyLocation(location)
    if (!routeIds.length && !stopIds.length) { setSelectedRouteId(''); setMapScope('network') }
    const route = preview.routes.find((item) => routeIds.includes(item.id) || Boolean(item.routeId && routeIds.includes(item.routeId)))
    if (route || routeIds[0]) { setSelectedRouteId(route?.id ?? routeIds[0]); setMapScope('route'); setRouteRenderMode('service') }
    setSelectedStopId(stopIds[0] || '')
    if (window.innerWidth <= 760) setAgencyMapOpen(true)
  }

  function presentAgencyResult(result: ToolResult) {
    const data = result.data as { plan?: RoutingPlan; surface?: unknown }
    if (data?.plan) { setAgencyLocation(undefined); setAgencyPlan(data.plan); setAgencyReach(null); setMapScope('route') }
    else if (data?.surface) { setAgencyLocation(undefined); setAgencyReach(result.data as ReachResult); setAgencyPlan(null); setMapScope('network') }
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
          action = hasActiveOperationsData ? openRoutesView : null
          break
        case 'Digit2':
          action = hasActiveOperationsData ? openPathfinderView : null
          break
        case 'Digit3':
          action = hasActiveOperationsData ? openAnalyzeView : null
          break
        case 'Digit4':
          action = hasActiveOperationsData ? openAgencyView : null
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
  const importPanelProps = {
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
    onExportReproducibility: () => { void exportReproducibilityManifest() },
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
            onOpenExplore={openRoutesView}
            onOpenRouting={openPathfinderView}
            onOpenAnalyze={openAnalyzeView}
        onOpenAgency={openAgencyView}
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
              if (value > (reachResult?.request.cutoffsMinutes.at(-1) ?? 0)) {
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
        objectPanel={(
          <ExploreObjectPanel
            feed={activeFeed}
            preview={visiblePreview}
            selectedRoute={selectedRoute}
            selectedStop={selectedStop}
            analysisLoading={Boolean(selectedRoute && routeAnalysisRouteId === selectedRoute.id)}
            analysisError={routeAnalysisError}
            routeRenderMode={routeRenderMode}
            onRouteRenderModeChange={setRouteRenderMode}
            onSelectPattern={(routeId) => selectRoute(routeId, 'pattern')}
            onOpenSources={openDataView}
            onClearSelection={returnToNetworkOverview}
          />
        )}
        preview={preview}
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
        onSelectRoute={selectRoute}
        onOpenFeed={openDataView}
        onOpenExplore={openRoutesView}
        onOpenRouting={openPathfinderView}
        onOpenAnalyze={openAnalyzeView}
        onOpenAgency={openAgencyView}
        onOpenSettings={openSettingsView}
        onOpenLive={() => {
          if (!realtimeSnapshot) {
            openDataView()
            return
          }
          setMapScope('network')
          setActiveRouteTool('explore')
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
          localStreetGraphAvailable={selectedProject.osmStreetIndex?.status === 'ready'}
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
              <ImportPanel {...importPanelProps} />
              <BundlePanel
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
      !hasOperationsData(selectedProject) ? (
        <EmptyOperationsStart
          project={selectedProject}
          {...importPanelProps}
        />
      ) : (
      <div className="workbench project-workbench route-investigation-shell">
        <RouteSurface
          agencyFocus={activeRouteTool === 'agency'}
          agencyLocation={agencyLocation}
          routeDetailStatus={selectedRoute && routeHasCompleteGtfsAnalysis(selectedRoute, preview, routingServiceDate)
            ? 'All route patterns'
            : routeAnalysisError ? 'Route detail unavailable · overview only' : 'Loading full route…'}
          key={activeRouteTool === 'agency' ? `agency-map-${agencyMapOpen}` : 'studio-map'}
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
          localStreetGraphAvailable={selectedProject.osmStreetIndex?.status === 'ready'}
          selectedRouteId={selectedRoute?.id ?? ''}
          selectedStopId={activeRouteTool === 'agency' ? selectedStopId : selectedStop?.id ?? ''}
          realtimeSnapshot={realtimeSnapshot}
          vehicleMode={vehicleMode}
          scheduleTimeMinutes={scheduleTimeMinutes}
          scheduleServiceDate={routingServiceDate}
          routingEnabled={activeRouteTool === 'agency' ? false : routingEnabled}
          routingOrigin={activeRouteTool === 'agency' ? agencyPlan?.origin ?? null : activeRouteTool === 'analyze' ? analysisOrigin : routingOrigin}
          routingWaypoints={activeRouteTool === 'agency' ? agencyPlan?.waypoints ?? [] : activeRouteTool === 'analyze' ? [] : routingWaypoints}
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
          scenarioSketchStops={activeRouteTool === 'analyze' ? scenarioSketchStops : []}
          scenarioSketchGeometry={activeRouteTool === 'analyze' ? scenarioSketchGeometry : []}
          scenarioPointPicking={scenarioPointPicking}
          onMoveScenarioStop={activeRouteTool === 'analyze' ? moveScenarioStopFromMap : undefined}
          routingActivity={routingActivity}
          cityPreviewLoading={cityPreviewLoading}
          onMapScopeChange={(scope) => { if (activeRouteTool === 'agency' && scope === 'network') { clearAgencyMap(); setSelectedStopId('') } setMapScope(scope) }}
          onVehicleModeChange={changeVehicleMode}
          onScheduleTimeChange={setScheduleTimeMinutes}
          onScheduleServiceDateChange={changeRoutingServiceDate}
          onRoutingPoint={activeRouteTool === 'agency' ? undefined : activeRouteTool === 'analyze' ? analysisPointFromMap : routingPointFromMap}
          onSelectRoute={activeRouteTool === 'agency' ? (id) => locateAgencyEntities([id], []) : selectRoute}
          onSelectStop={activeRouteTool === 'agency' ? (id) => locateAgencyEntities([], [id]) : selectStop}
        />
        {activeRouteTool === 'agency' ? <AgencyPanel key={selectedProjectId} projectId={selectedProjectId} snapshot={realtimeSnapshot} realtimeRequest={realtimeRequest} realtimeMessage={realtimeMessage} realtimeLoading={isRealtimeLoading} onConnect={(request) => void refreshRealtimeRequest(request)} onDisconnect={disconnectRealtime} onLocate={locateAgencyEntities} onResult={presentAgencyResult} onOpenData={openDataView} mapOpen={agencyMapOpen} onToggleMap={() => setAgencyMapOpen((open) => !open)} /> : null}
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
