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
import { apiJson, apiProgressJson, type ApiProgress } from './app/api'
import { statusFromJobStatus, statusFromStoreStatus, type WorkspaceStatus } from './app/status'
import {
  requestNativeGtfsFile,
  requestNativeHomeFolder,
  requestNativeOsmFile,
  subscribeNativeCommands,
  syncNativeChromeState,
} from './app/nativeBridge'
import { readNavigationMemory, rememberProject, rememberRoute, rememberSearchResult } from './app/navigationMemory'
import { useProjectDetailHydration } from './app/projectHydration'
import { useNationalRouting } from './app/useNationalRouting'
import { mergeGtfsRouteAnalysis, routeHasCompleteGtfsAnalysis, type GtfsRouteAnalysis } from './app/gtfsAnalysis'
import { routeListLabels } from './app/routePresentation'
import { buildWorkspacePreviewLod } from './app/workspacePreview'
import { formatBytes } from './app/presentation'
import {
  buildRoutingActivity,
  localCalendarDate,
  serviceDayForCalendarDate,
  type RoutingActivity,
  type RoutingServiceCoverage,
} from './app/routingContracts'
import {
  emptyWorkspaceProject,
  hasOperationsData,
  mergeProjectLists,
  mergeProjectState,
  hasReadyWorkspaceSources,
  needsProjectDetail,
  orderedProjects,
  preferredProjectId,
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
  serviceDayOptions,
  type RoutingDepartureWindowMinutes,
} from './app/uiOptions'
import { LazyVigoMap } from './components/LazyVigoMap'
import {
  RoutingDetailPanel,
  SidebarPathfinderBox,
  type RoutingLocationCandidate,
  type RoutingLocationChoice,
  type RoutingScopeStatus,
  type SidebarPathfinderBoxProps,
} from './components/PathfinderPanel'
import {
  AccessibilityWorkspacePanel,
  type AccessibilityFeedOption,
  type AccessibilityMode,
} from './components/AccessibilityWorkspacePanel'
import { FirstRunSetupDialog, ProjectEditorDialog } from './components/ProjectDialogs'
import { DataWorkspace, type DataSection } from './components/DataWorkspace'
import { ExploreObjectPanel } from './components/ExploreObjectPanel'
import { ServiceStateControl } from './components/ServiceStateControl'
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
  type ServiceDay,
  type TableProfile,
  type TidesSummary,
  type VigoProject,
  classNames,
  basemapLabels,
  basemapShortLabels,
  formatNumber,
  initialLayers,
  networkLensLabels,
} from './domain'
import { entityFeedScope, scopePreviewToFeed } from './networkTruth'
import { buildNetworkPerformanceProfile } from './networkPerformance'
import { scopedRouteServiceKey, type RouteRenderMode } from './routeServices'
import { coordinateDistanceKm, polylineDistanceKm } from './app/geometry'
import { formatScheduleClock, scheduledVehicleDiagnostics, scheduledVehiclesAtTime } from './scheduledVehicles'
import { buildServiceVehicleFrame, serviceVehicleCount, type ServiceVehicleMode } from './serviceVehicles'
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
  normalizeOrderedRoutingPoints,
} from './routingPointSequence'
import {
  type AccessibilityCaseDraft,
  type AccessibilityInterventionDraft,
  type AccessibilityInterventionKind,
  type ScenarioAnalysisResult,
  type ScenarioComparisonResult,
  type ScenarioGeometryMode,
  type ScenarioRouteScope,
  type ScenarioRenderMode,
  type ScenarioServiceDraft,
  type ScenarioStopDraft,
  type ScenarioStopPlacement,
  type ScenarioTimeModel,
  type ScenarioView,
  type ServiceEdgeDecomposition,
} from './scenarioAnalysis'

type RouteStatusFilter = GtfsRouteStatusFilter
type RouteToolKey = 'explore' | 'data' | 'pathfinder' | 'accessibility'
type MapScope = 'network' | 'route'
const desktopAccessibilityRasterSize = 128

const readinessStateClasses: Record<WorkspaceStatus, string> = {
  idle: 'state-idle',
  preparing: 'state-preparing',
  ready: 'state-ready',
  stale: 'state-stale',
  blocked: 'state-blocked',
  error: 'state-error',
  cancelled: 'state-cancelled',
}

type PendingRoutingLocationResolution = {
  queries: string[]
  candidates: RoutingLocationCandidate[][]
  selections: Array<RoutingLocationCandidate | null>
  departMinutes: number
  timePreference: RoutingTimePreference
  mode: RoutingTravelMode
  maxWalkKm?: number
}

type RealtimeInspectRequest =
  | { url: string }
  | {
      urls: {
        vehicles: string
        tripUpdates?: string
        alerts?: string
      }
    }

const realtimeRefreshMs = 10_000
let accessibilityDraftSequence = 0

function realtimeInspectRequest(sourceText: string): RealtimeInspectRequest {
  const urls = (sourceText.match(/https?:\/\/[^\s<>"']+/gi) ?? [])
    .map((value) => value.replace(/[),;\]]+$/, ''))
  if (!urls.length) throw new Error('Enter a valid GTFS-RT URL.')

  const parsed = urls.map((value) => {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('GTFS-RT URLs must use HTTP or HTTPS.')
    return { value, pathname: url.pathname.toLowerCase() }
  })
  if (parsed.length === 1) return { url: parsed[0].value }

  const feedSet: { vehicles?: string; tripUpdates?: string; alerts?: string } = {}
  for (const source of parsed) {
    const kind = source.pathname.endsWith('/vehiclepositions.pb')
      ? 'vehicles'
      : source.pathname.endsWith('/tripupdates.pb')
        ? 'tripUpdates'
        : source.pathname.endsWith('/alerts.pb')
          ? 'alerts'
          : undefined
    if (!kind) throw new Error('For multiple feeds, use VehiclePositions.pb, TripUpdates.pb, and Alerts.pb URLs.')
    if (feedSet[kind]) throw new Error(`Duplicate ${kind} GTFS-RT URL.`)
    feedSet[kind] = source.value
  }
  if (!feedSet.vehicles) throw new Error('A VehiclePositions.pb URL is required for live map locations.')

  return { urls: { vehicles: feedSet.vehicles, tripUpdates: feedSet.tripUpdates, alerts: feedSet.alerts } }
}

function newAccessibilityIntervention(
  kind: AccessibilityInterventionKind,
): AccessibilityInterventionDraft {
  accessibilityDraftSequence += 1
  return {
    id: `intervention-${accessibilityDraftSequence}`,
    kind,
    name: kind.replaceAll('-', ' '),
    stops: [],
    headwayMinutes: 10,
    averageSpeedKph: 25,
    startMinutes: 5 * 60,
    endMinutes: 25 * 60,
    bidirectional: true,
    routeScope: kind === 'add-line' ? undefined : 'pattern',
    timeModel: ['add-line', 'change-line'].includes(kind) ? 'infer-road' : 'preserve-scheduled',
    geometryMode: ['add-line', 'change-line'].includes(kind) ? 'auto-road' : 'published-shape',
    geometryStatus: 'idle',
  }
}

function newAccessibilityCase(index: number): AccessibilityCaseDraft {
  accessibilityDraftSequence += 1
  return {
    id: `case-${accessibilityDraftSequence}`,
    name: `Case ${String.fromCharCode(65 + index)}`,
    interventions: [],
  }
}

const bundleFeedId = '__bundle__'
const requiredTableNames = ['agency.txt', 'stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt']
const optionalTableNames = ['shapes.txt', 'calendar.txt', 'calendar_dates.txt', 'frequencies.txt', 'transfers.txt', 'pathways.txt', 'feed_info.txt']

function latestCoverageDateMatchingWeekday(completeEndDate: string, preferredDate: string) {
  const end = new Date(`${completeEndDate}T12:00:00`)
  const preferred = new Date(`${preferredDate}T12:00:00`)
  if (Number.isNaN(end.getTime()) || Number.isNaN(preferred.getTime())) return completeEndDate
  const preferredWeekday = preferred.getDay()
  for (let offset = 0; offset < 7; offset += 1) {
    const candidate = new Date(end)
    candidate.setDate(end.getDate() - offset)
    if (candidate.getDay() !== preferredWeekday) continue
    const year = candidate.getFullYear()
    const month = String(candidate.getMonth() + 1).padStart(2, '0')
    const day = String(candidate.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }
  return completeEndDate
}

function latestMidweekCoverageDate(completeEndDate: string) {
  const end = new Date(`${completeEndDate}T12:00:00`)
  if (Number.isNaN(end.getTime())) return completeEndDate
  for (let offset = 0; offset < 7; offset += 1) {
    const candidate = new Date(end)
    candidate.setDate(end.getDate() - offset)
    if (candidate.getDay() !== 3) continue
    const year = candidate.getFullYear()
    const month = String(candidate.getMonth() + 1).padStart(2, '0')
    const day = String(candidate.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }
  return completeEndDate
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
  routes.forEach((route) => {
    const key = scopedRouteServiceKey(route)
    groups.set(key, [...(groups.get(key) ?? []), route])
  })

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

function WorkspaceRailButton({
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

function WorkspaceRail({
  page,
  activeRouteTool,
  hasActiveData,
  onOpenExplore,
  onOpenRouting,
  onOpenAccessibility,
  onOpenSettings,
}: {
  page: 'projects' | 'project'
  activeRouteTool: RouteToolKey
  hasActiveData: boolean
  onOpenExplore: () => void
  onOpenRouting: () => void
  onOpenAccessibility: () => void
  onOpenSettings: () => void
}) {
  return (
    <nav className="sidebar-rail" aria-label="Workspace views">
      <div className="sidebar-rail-main">
        <WorkspaceRailButton
          title="Network"
          shortcut="1"
          icon={<Route size={19} aria-hidden="true" />}
          active={page === 'project' && activeRouteTool === 'explore'}
          disabled={page !== 'project' || !hasActiveData}
          onClick={onOpenExplore}
        />
        <WorkspaceRailButton
          title="Route"
          shortcut="2"
          icon={<Navigation2 size={19} aria-hidden="true" />}
          active={page === 'project' && activeRouteTool === 'pathfinder'}
          disabled={page !== 'project' || !hasActiveData}
          onClick={onOpenRouting}
        />
        <WorkspaceRailButton
          title="Evidence"
          shortcut="3"
          icon={<Radar size={19} aria-hidden="true" />}
          active={page === 'project' && activeRouteTool === 'accessibility'}
          disabled={page !== 'project' || !hasActiveData}
          onClick={onOpenAccessibility}
        />
      </div>
      <div className="sidebar-rail-bottom">
        <WorkspaceRailButton
          title="Manage workspace"
          label="Manage"
          shortcut="4"
          icon={<Settings size={18} aria-hidden="true" />}
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
  scheduleServiceDay,
  routingEnabled,
  routingOrigin,
  routingWaypoints,
  routingDestination,
  routingPlan,
  routingChoices,
  routingScopeStatus,
  routingStoreReady,
  routingStoreFeedCount,
  routingStoreReadyFeedCount,
  routingStoreStored,
  routingStoreStoredFeedCount,
  routingStoreTripCount,
  routingStoreConnectionCount,
  routingTimePreference,
  routingMode,
  routingDepartureWindowMinutes,
  routingMaxWalkKm,
  routingAllowLongWalk,
  routingActivity,
  routingAlternativesLoading,
  routingServiceDate,
  routingServiceCoverage,
  routingServiceDateAvailability,
  routingServiceDateOptions,
  routingResolvingLocations,
  routingLocationError,
  routingLocationChoices,
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
  onOpenAccessibility,
  onOpenSettings,
  onOpenLive,
  onMapScopeChange,
  onNetworkLensChange,
  onBasemapChange,
  onScheduleTimeChange,
  onScheduleServiceDayChange,
  onRunRoutingSearch,
  onReorderRoutingPoints,
  onRoutingTimePreferenceChange,
  onRoutingModeChange,
  onRoutingDepartureWindowChange,
  onRoutingMaxWalkKmChange,
  onRoutingAllowLongWalkChange,
  onRoutingServiceDateChange,
  onSelectRoutingPlan,
  onChooseRoutingLocation,
  onDismissRoutingLocationChoices,
  onInvalidateRoutingResults,
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
  scheduleServiceDay: ServiceDay
  routingStoreStored: boolean
  routingStoreStoredFeedCount: number
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
  onOpenAccessibility: () => void
  onOpenSettings: () => void
  onOpenLive: () => void
  onMapScopeChange: (scope: MapScope) => void
  onNetworkLensChange: (lens: NetworkLens) => void
  onBasemapChange: (basemap: Basemap) => void
  onScheduleServiceDayChange: (serviceDay: ServiceDay) => void
} & Pick<SidebarPathfinderBoxProps,
  | 'routingEnabled'
  | 'routingOrigin'
  | 'routingWaypoints'
  | 'routingDestination'
  | 'routingPlan'
  | 'routingChoices'
  | 'routingScopeStatus'
  | 'routingStoreReady'
  | 'routingStoreFeedCount'
  | 'routingStoreReadyFeedCount'
  | 'routingTimePreference'
  | 'routingMode'
  | 'routingDepartureWindowMinutes'
  | 'routingMaxWalkKm'
  | 'routingAllowLongWalk'
  | 'routingActivity'
  | 'routingAlternativesLoading'
  | 'routingServiceDate'
  | 'routingServiceCoverage'
  | 'routingServiceDateAvailability'
  | 'routingServiceDateOptions'
  | 'routingResolvingLocations'
  | 'routingLocationError'
  | 'routingLocationChoices'
  | 'storeBackedRouting'
  | 'scheduleTimeMinutes'
  | 'onRunRoutingSearch'
  | 'onReorderRoutingPoints'
  | 'onOpenFeed'
  | 'onScheduleTimeChange'
  | 'onRoutingTimePreferenceChange'
  | 'onRoutingModeChange'
  | 'onRoutingDepartureWindowChange'
  | 'onRoutingMaxWalkKmChange'
  | 'onRoutingAllowLongWalkChange'
  | 'onRoutingServiceDateChange'
  | 'onSelectRoutingPlan'
  | 'onChooseRoutingLocation'
  | 'onDismissRoutingLocationChoices'
  | 'onInvalidateRoutingResults'
  | 'onToggleRouting'
  | 'onClearRouting'
>) {
  const isDataPanel = page === 'project' && activeRouteTool === 'data'
  const isExplorePanel = page === 'project' && activeRouteTool === 'explore'
  const isPathfinderPanel = page === 'project' && activeRouteTool === 'pathfinder'
  const isAccessibilityPanel = page === 'project' && activeRouteTool === 'accessibility'
  const panelTitle = page === 'projects'
    ? 'Workspaces'
    : isDataPanel
      ? 'Manage workspace'
      : isAccessibilityPanel
        ? 'Evidence'
        : isPathfinderPanel
          ? 'Route'
          : isExplorePanel
            ? 'Visualize GTFS'
            : 'Network'
  const panelSubtitle = page === 'projects'
    ? `${projects.length} workspaces in Library`
    : isPathfinderPanel
      ? routingOrigin || routingDestination
        ? [
          routingOrigin?.label ?? 'Origin',
          ...routingWaypoints.map((point) => point.label),
          routingDestination?.label ?? 'Destination',
        ].join(' → ')
        : 'Origin to destination'
    : isAccessibilityPanel
      ? 'Access, scenario, and decision evidence'
    : isExplorePanel
      ? 'Network, service, and live operations'
    : hasActiveData
      ? activeFeedId === bundleFeedId
        ? quietMapLabel(selectedProject.name)
        : quietMapLabel(activeFeed.name)
      : `${selectedProject.name} needs an indexed GTFS feed`
  const routeFocusActive = mapScope === 'route' && Boolean(selectedRoute)
  const networkPreview = useMemo(() => buildWorkspacePreviewLod(visiblePreview), [visiblePreview])
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
      ? scheduledVehiclesAtTime(scopedMapPreview, scheduleTimeMinutes, scheduleServiceDay)
      : [],
    [scheduleProjectionEnabled, scopedMapPreview, scheduleServiceDay, scheduleTimeMinutes],
  )
  const scheduleDiagnostics = useMemo(
    () => renderingLive
      ? liveVehicleDiagnostics(liveVehicleCount, realtimeSnapshot !== null)
      : scheduleProjectionEnabled
        ? scheduledVehicleDiagnostics(scopedMapPreview, scheduledVehicles, scheduleTimeMinutes, scheduleServiceDay)
        : liveVehicleDiagnostics(0),
    [liveVehicleCount, realtimeSnapshot, renderingLive, scheduleProjectionEnabled, scopedMapPreview, scheduleServiceDay, scheduleTimeMinutes, scheduledVehicles],
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
    : isAccessibilityPanel
      ? routingStoreReady || routingStoreStored ? 'Transit + OSM analysis ready' : 'Index GTFS for access analysis'
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
    <aside className="app-sidebar" aria-label="Workspace navigation">
      <WorkspaceRail
        page={page}
        activeRouteTool={activeRouteTool}
        hasActiveData={hasActiveData}
        onOpenExplore={onOpenExplore}
        onOpenRouting={onOpenRouting}
        onOpenAccessibility={onOpenAccessibility}
        onOpenSettings={onOpenSettings}
      />
      <section className={classNames('sidebar-panel', page === 'project' && `is-${activeRouteTool}`)} aria-label="Workspace panel">
        <div className="sidebar-panel-head">
          <div className="sidebar-panel-title">
            <strong>{panelTitle}</strong>
          </div>
          <p>{panelSubtitle}</p>
          {panelContextLine ? <span className="sidebar-context-line">{panelContextLine}</span> : null}
        </div>

        {page === 'projects' ? (
          <div className="sidebar-section">
            <div className="sidebar-section-title">
              <strong>Workspace Library</strong>
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
                  <span>Load a GTFS ZIP to create patterns, stop pairs, validation evidence, and the operations map.</span>
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
                scheduleServiceDay={scheduleServiceDay}
                scheduleDiagnostics={scheduleDiagnostics}
                lensInsight={lensInsight}
                performanceProfile={scopedPerformanceProfile}
                livePositionCount={realtimePositionCount(realtimeSnapshot)}
                realtimeSnapshot={realtimeSnapshot}
                onMapScopeChange={onMapScopeChange}
                onNetworkLensChange={onNetworkLensChange}
                onBasemapChange={onBasemapChange}
                onScheduleTimeChange={onScheduleTimeChange}
                onScheduleServiceDayChange={onScheduleServiceDayChange}
                onOpenLive={onOpenLive}
              />
            ) : null}

            {hasActiveData && isExplorePanel ? (
              <div className={classNames('sidebar-section route-browser-section', selectedRoute && 'has-object-detail')}>
                {selectedRoute ? objectPanel : (
                  <>
                    <div className="sidebar-section-title route-browser-heading">
                      <div>
                        <strong>GTFS services</strong>
                        <small>Select a route to inspect its map, stops, and timetable.</small>
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
                routingStoreFeedCount={routingStoreFeedCount}
                routingStoreReadyFeedCount={routingStoreReadyFeedCount}
                routingTimePreference={routingTimePreference}
                routingMode={routingMode}
                routingDepartureWindowMinutes={routingDepartureWindowMinutes}
                routingMaxWalkKm={routingMaxWalkKm}
                routingAllowLongWalk={routingAllowLongWalk}
                routingActivity={routingActivity}
                routingAlternativesLoading={routingAlternativesLoading}
                routingServiceDate={routingServiceDate}
                routingServiceCoverage={routingServiceCoverage}
                routingServiceDateAvailability={routingServiceDateAvailability}
                routingServiceDateOptions={routingServiceDateOptions}
                routingResolvingLocations={routingResolvingLocations}
                routingLocationError={routingLocationError}
                routingLocationChoices={routingLocationChoices}
                storeBackedRouting={storeBackedRouting}
                scheduleTimeMinutes={scheduleTimeMinutes}
                onRunRoutingSearch={onRunRoutingSearch}
                onReorderRoutingPoints={onReorderRoutingPoints}
                onOpenFeed={onOpenFeed}
                onScheduleTimeChange={onScheduleTimeChange}
                onRoutingTimePreferenceChange={onRoutingTimePreferenceChange}
                onRoutingModeChange={onRoutingModeChange}
                onRoutingDepartureWindowChange={onRoutingDepartureWindowChange}
                onRoutingMaxWalkKmChange={onRoutingMaxWalkKmChange}
                onRoutingAllowLongWalkChange={onRoutingAllowLongWalkChange}
                onRoutingServiceDateChange={onRoutingServiceDateChange}
                onSelectRoutingPlan={onSelectRoutingPlan}
                onChooseRoutingLocation={onChooseRoutingLocation}
                onDismissRoutingLocationChoices={onDismissRoutingLocationChoices}
                onInvalidateRoutingResults={onInvalidateRoutingResults}
                onToggleRouting={onToggleRouting}
                onClearRouting={onClearRouting}
              />
            ) : null}

            {hasActiveData && isAccessibilityPanel ? analysisPanel : null}
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
  scheduleServiceDay,
  scheduleDiagnostics,
  lensInsight,
  performanceProfile,
  livePositionCount,
  realtimeSnapshot,
  onMapScopeChange,
  onNetworkLensChange,
  onBasemapChange,
  onScheduleTimeChange,
  onScheduleServiceDayChange,
  onOpenLive,
}: {
  mapScope: MapScope
  networkLens: NetworkLens
  basemap: Basemap
  scheduleTimeMinutes: number
  scheduleServiceDay: ServiceDay
  scheduleDiagnostics: ReturnType<typeof scheduledVehicleDiagnostics>
  lensInsight: ReturnType<typeof buildNetworkLensInsight>
  performanceProfile: ReturnType<typeof buildNetworkPerformanceProfile>
  livePositionCount: number
  realtimeSnapshot: RealtimeSnapshot | null
  onMapScopeChange: (scope: MapScope) => void
  onNetworkLensChange: (lens: NetworkLens) => void
  onBasemapChange: (basemap: Basemap) => void
  onScheduleTimeChange: (minutes: number) => void
  onScheduleServiceDayChange: (serviceDay: ServiceDay) => void
  onOpenLive: () => void
}) {
  const clock = formatScheduleClock(scheduleTimeMinutes)

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
          max={1439}
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

      <div className="sidebox-row sidebox-days" role="group" aria-label="Service day">
        {serviceDayOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            className={classNames(scheduleServiceDay === option.value && 'is-active')}
            onClick={() => onScheduleServiceDayChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

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

function mergeTidesSummaries(feeds: FeedSummary[]): TidesSummary | undefined {
  const summaries = feeds
    .map((feed) => feed.tides)
    .filter((summary): summary is TidesSummary => Boolean(summary?.detected))

  if (!summaries.length) return undefined

  const tableNames = Array.from(new Set(summaries.flatMap((summary) => summary.tables.map((table) => table.name))))
  const tables = tableNames.map((name) => {
    const matching = summaries.flatMap((summary) => summary.tables.filter((table) => table.name === name))
    const first = matching[0]
    const fields = Array.from(new Set(matching.flatMap((table) => table.fields))).slice(0, 8)
    return {
      ...first,
      present: matching.some((table) => table.present),
      rowCount: matching.reduce((sum, table) => sum + table.rowCount, 0),
      fieldCount: Math.max(0, ...matching.map((table) => table.fieldCount)),
      fields,
      path: undefined,
    }
  })
  const presentTables = tables.filter((table) => table.present)
  const scheduledTripRefs = summaries.reduce((sum, summary) => sum + summary.scheduledTripRefs, 0)
  const scheduledTripMatches = summaries.reduce((sum, summary) => sum + summary.scheduledTripMatches, 0)
  const stopRefs = summaries.reduce((sum, summary) => sum + summary.stopRefs, 0)
  const stopMatches = summaries.reduce((sum, summary) => sum + summary.stopMatches, 0)
  const linkRefs = scheduledTripRefs + stopRefs
  const linkMatches = scheduledTripMatches + stopMatches

  return {
    schemaVersion: 'tides.v1',
    detected: true,
    datapackage: summaries.some((summary) => summary.datapackage),
    packageName: `${summaries.length} observed-operations package${summaries.length === 1 ? '' : 's'}`,
    packageProfile: summaries.find((summary) => summary.packageProfile)?.packageProfile,
    tableCount: presentTables.length,
    eventTableCount: presentTables.filter((table) => table.role === 'event').length,
    summaryTableCount: presentTables.filter((table) => table.role === 'summary').length,
    supportingTableCount: presentTables.filter((table) => table.role === 'supporting').length,
    rowCount: summaries.reduce((sum, summary) => sum + summary.rowCount, 0),
    observedServiceDates: summaries.reduce((sum, summary) => sum + summary.observedServiceDates, 0),
    performedTripCount: summaries.reduce((sum, summary) => sum + summary.performedTripCount, 0),
    stopVisitCount: summaries.reduce((sum, summary) => sum + summary.stopVisitCount, 0),
    passengerEventCount: summaries.reduce((sum, summary) => sum + summary.passengerEventCount, 0),
    vehicleLocationCount: summaries.reduce((sum, summary) => sum + summary.vehicleLocationCount, 0),
    fareTransactionCount: summaries.reduce((sum, summary) => sum + summary.fareTransactionCount, 0),
    stationActivityCount: summaries.reduce((sum, summary) => sum + summary.stationActivityCount, 0),
    vehicleCount: summaries.reduce((sum, summary) => sum + summary.vehicleCount, 0),
    deviceCount: summaries.reduce((sum, summary) => sum + summary.deviceCount, 0),
    totalBoardings: summaries.reduce((sum, summary) => sum + summary.totalBoardings, 0),
    totalAlightings: summaries.reduce((sum, summary) => sum + summary.totalAlightings, 0),
    totalEntries: summaries.reduce((sum, summary) => sum + summary.totalEntries, 0),
    totalExits: summaries.reduce((sum, summary) => sum + summary.totalExits, 0),
    totalFareTransactions: summaries.reduce((sum, summary) => sum + summary.totalFareTransactions, 0),
    totalFareRevenue: summaries.reduce((sum, summary) => sum + summary.totalFareRevenue, 0),
    maxDepartureLoad: Math.max(0, ...summaries.map((summary) => summary.maxDepartureLoad)),
    averageDwellSeconds: undefined,
    averageScheduleDeviationSeconds: undefined,
    scheduledTripRefs,
    scheduledTripMatches,
    scheduledTripUnmatched: summaries.reduce((sum, summary) => sum + summary.scheduledTripUnmatched, 0),
    stopRefs,
    stopMatches,
    stopUnmatched: summaries.reduce((sum, summary) => sum + summary.stopUnmatched, 0),
    linkScore: linkRefs ? Math.round((linkMatches / linkRefs) * 100) : 0,
    tables,
    signals: Array.from(new Set(summaries.flatMap((summary) => summary.signals))).slice(0, 7),
  }
}

function emptyProjectFeed(project: VigoProject): FeedSummary {
  return {
    id: bundleFeedId,
    name: `${project.name} Bundle`,
    provider: project.region,
    versionLabel: 'No feeds',
    importedAt: project.updatedAt,
    source: 'bundle',
    fileName: 'No GTFS',
    fileSize: 0,
    hash: `bundle-${project.id}`,
    qualityScore: 0,
    routeCount: 0,
    stopCount: 0,
    tripCount: 0,
    transferCandidates: 0,
    requiredTables: Object.fromEntries(requiredTableNames.map((name) => [name, false])),
    optionalTables: Object.fromEntries(optionalTableNames.map((name) => [name, false])),
    tableProfiles: [],
    warnings: [],
    routeMetrics: [],
    stopMetrics: [],
    mapPreview: { routes: [], stops: [], stopPairs: [] },
  }
}

function feedPreview(feed: FeedSummary): MapPreview {
  return feed.mapPreview ?? { routes: [], stops: [], stopPairs: [] }
}

function prefixedPreview(feed: FeedSummary): MapPreview {
  return scopePreviewToFeed(feed, feedPreview(feed))
}

function mergeTableState(feeds: FeedSummary[], tableNames: string[], required: boolean) {
  return Object.fromEntries(
    tableNames.map((name) => [
      name,
      feeds.length ? feeds.every((feed) => Boolean(feed[required ? 'requiredTables' : 'optionalTables']?.[name])) : false,
    ]),
  )
}

function bundleFeed(project: VigoProject): FeedSummary {
  const feeds = project.feeds
  if (!feeds.length) return emptyProjectFeed(project)
  const qualityScore = Math.round(feeds.reduce((sum, feed) => sum + feed.qualityScore, 0) / feeds.length)
  const preview = bundlePreviewFromFeeds(feeds)
  const tides = mergeTidesSummaries(feeds)

  return {
    id: bundleFeedId,
    name: `${project.name} Bundle`,
    provider: project.region,
    versionLabel: `${feeds.length} GTFS`,
    importedAt: project.updatedAt,
    source: 'bundle',
    fileName: `${feeds.length} feeds`,
    fileSize: feeds.reduce((sum, feed) => sum + feed.fileSize, 0),
    hash: `bundle-${project.id}-${feeds.length}`,
    qualityScore,
    routeCount: feeds.reduce((sum, feed) => sum + feed.routeCount, 0),
    stopCount: feeds.reduce((sum, feed) => sum + feed.stopCount, 0),
    tripCount: feeds.reduce((sum, feed) => sum + feed.tripCount, 0),
    transferCandidates: feeds.reduce((sum, feed) => sum + feed.transferCandidates, 0),
    requiredTables: mergeTableState(feeds, requiredTableNames, true),
    optionalTables: mergeTableState(feeds, optionalTableNames, false),
    tableProfiles: feeds.flatMap((feed) => getTableProfiles(feed).map((profile) => ({ ...profile, name: `${feed.name} / ${profile.name}` }))),
    warnings: feeds.flatMap((feed) => feed.warnings.map((warning) => ({ ...warning, id: `${feed.id}-${warning.id}`, table: `${feed.name} / ${warning.table}` }))),
    routeMetrics: preview.routes,
    stopMetrics: preview.stops,
    tides,
    mapPreview: preview,
  }
}

function appendItems<T>(target: T[], items: readonly T[] | undefined) {
  if (!items?.length) return
  for (const item of items) target.push(item)
}

function bundlePreviewFromFeeds(feeds: FeedSummary[]): MapPreview {
  if (!feeds.length) return { routes: [], stops: [], stopPairs: [] }
  return feeds.reduce<MapPreview>((bundle, feed) => {
    const preview = prefixedPreview(feed)
    appendItems(bundle.routes, preview.routes)
    appendItems(bundle.stops, preview.stops)
    appendItems(bundle.stopPairs ?? [], preview.stopPairs)
    if (preview.coverage) {
      bundle.coverage = {
        rawRouteRows: (bundle.coverage?.rawRouteRows ?? 0) + preview.coverage.rawRouteRows,
        publicRouteIdentities: (bundle.coverage?.publicRouteIdentities ?? 0) + preview.coverage.publicRouteIdentities,
        tripsIndexed: (bundle.coverage?.tripsIndexed ?? 0) + preview.coverage.tripsIndexed,
        stopTimesScanned: (bundle.coverage?.stopTimesScanned ?? 0) + preview.coverage.stopTimesScanned,
        stopsIndexed: (bundle.coverage?.stopsIndexed ?? 0) + preview.coverage.stopsIndexed,
        stopPairsIndexed: (bundle.coverage?.stopPairsIndexed ?? 0) + preview.coverage.stopPairsIndexed,
        capped: Boolean(bundle.coverage?.capped || preview.coverage.capped),
        timetableDeferred: Boolean(bundle.coverage?.timetableDeferred || preview.coverage.timetableDeferred),
      }
    }
    return bundle
  }, { routes: [], stops: [], stopPairs: [] })
}

function scopedFeedAndPreview(project: VigoProject, feedId: string): { feed: FeedSummary; preview: MapPreview } {
  if (feedId === bundleFeedId) {
    const feed = bundleFeed(project)
    return { feed, preview: feedPreview(feed) }
  }

  const feed = project.feeds.find((item) => item.id === feedId)
  if (feed) {
    return { feed, preview: feedPreview(feed) }
  }

  const bundle = bundleFeed(project)
  return { feed: bundle, preview: feedPreview(bundle) }
}

function getTableProfiles(feed: FeedSummary): TableProfile[] {
  if (feed.tableProfiles?.length) return feed.tableProfiles

  return [
    ...Object.entries(feed.requiredTables ?? {}).map(([name, present]) => ({ name, role: 'required' as const, present, rowCount: present ? 1 : 0, fieldCount: 0, fields: [], issueCount: feed.warnings.filter((warning) => warning.table === name).length })),
    ...Object.entries(feed.optionalTables ?? {}).map(([name, present]) => ({ name, role: 'optional' as const, present, rowCount: present ? 1 : 0, fieldCount: 0, fields: [], issueCount: feed.warnings.filter((warning) => warning.table === name).length })),
  ]
}

function filterPreviewByStatus(preview: MapPreview, statusFilter: RouteStatusFilter): MapPreview {
  if (statusFilter === 'all') return preview
  const routes = preview.routes.filter((route) => {
    return route.status === statusFilter
  })

  const visibleRouteRefs = new Set(routes.flatMap((route) => [route.id, route.routeId ?? route.id, route.patternId ?? route.id, route.shortName]))
  const visibleStopIds = new Set(routes.flatMap((route) => route.stopIds))
  const stops = preview.stops.filter((stop) => {
    return stop.routes.some((routeId) => visibleRouteRefs.has(routeId)) || visibleStopIds.has(stop.id)
  })

  const visiblePatternIds = new Set(routes.map((route) => route.id))
  const stopPairs = (preview.stopPairs ?? []).filter((pair) => visiblePatternIds.has(pair.patternId))

  return { routes, stops, stopPairs, coverage: preview.coverage }
}

function previewForSelectedRoute(
  preview: MapPreview,
  selectedRoute?: RouteMetric,
  renderMode: RouteRenderMode = 'service',
): MapPreview {
  if (!selectedRoute) return preview

  const selectedPattern = preview.routes.find((route) => route.id === selectedRoute.id || route.patternId === selectedRoute.patternId) ?? selectedRoute
  const routes = renderMode === 'pattern'
    ? [selectedPattern]
    : preview.routes.filter((route) => scopedRouteServiceKey(route) === scopedRouteServiceKey(selectedPattern))
  const routeIds = new Set(routes.flatMap((route) => [route.id, route.patternId ?? route.id]))
  const stopIds = new Set(routes.flatMap((route) => route.stopIds))

  return {
    routes,
    stops: preview.stops.filter((stop) => stopIds.has(stop.id)),
    stopPairs: (preview.stopPairs ?? []).filter((pair) => routeIds.has(pair.patternId)),
    coverage: preview.coverage,
  }
}

function scenarioStopsForRoute(route: RouteMetric | undefined, preview: MapPreview) {
  if (!route) return []
  const stopById = new Map(preview.stops.map((stop) => [stop.id, stop]))
  const exactStops = route.stopIds.flatMap<ScenarioStopDraft>((stopId, index) => {
    const stop = stopById.get(stopId)
    if (!stop || !Number.isFinite(stop.lon) || !Number.isFinite(stop.lat)) return []
    return [{
      id: `${route.id}:stop:${index + 1}`,
      label: stop.name || `Stop ${index + 1}`,
      coordinate: [Number(stop.lon), Number(stop.lat)],
      source: 'route',
      stopId: stop.id,
      baselineStopId: stop.id,
      editStatus: 'baseline',
    }]
  })
  return exactStops.length >= 2 ? exactStops : []
}

function scenarioSourceRouteId(route: RouteMetric) {
  const localRouteId = route.routeId ?? route.id
  const feedScope = entityFeedScope(route.id)
  return feedScope && !String(localRouteId).includes('::')
    ? `${feedScope}::${localRouteId}`
    : localRouteId
}

function scenarioStopFromRoutingPoint(
  interventionId: string,
  point: RoutingPoint,
  editStatus: NonNullable<ScenarioStopDraft['editStatus']>,
): ScenarioStopDraft {
  return {
    id: `${interventionId}:${editStatus}:${crypto.randomUUID()}`,
    label: point.label,
    coordinate: point.coordinate,
    source: point.stopId ? 'route' : 'map',
    ...(point.stopId ? { stopId: point.stopId } : {}),
    editStatus,
  }
}

function scenarioStopBoundaryId(stop: ScenarioStopDraft | undefined, side: 'before' | 'after') {
  if (!stop) return undefined
  return side === 'before'
    ? stop.baselineStopId ?? stop.stopId ?? stop.anchorBeforeStopId ?? stop.anchorAfterStopId
    : stop.baselineStopId ?? stop.stopId ?? stop.anchorAfterStopId ?? stop.anchorBeforeStopId
}

function scenarioInsertionAnchors(before: ScenarioStopDraft, after: ScenarioStopDraft) {
  return {
    beforeStopId: scenarioStopBoundaryId(before, 'before'),
    afterStopId: scenarioStopBoundaryId(after, 'after'),
  }
}

function scenarioInsertedStopsForEdge(stops: ScenarioStopDraft[]) {
  const grouped = new Map<string, ScenarioStopDraft[]>()
  for (const stop of stops) {
    if (stop.editStatus !== 'inserted' || !stop.anchorBeforeStopId || !stop.anchorAfterStopId) continue
    const key = `${stop.anchorBeforeStopId}\u0000${stop.anchorAfterStopId}`
    grouped.set(key, [...(grouped.get(key) ?? []), stop])
  }
  return [...grouped.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([key, entries]) => {
      const [beforeStopId, afterStopId] = key.split('\u0000')
      return { beforeStopId, afterStopId, stops: entries }
    })
    .at(0)
}

function routeHasPublishedShape(
  route: RouteMetric | undefined,
): route is RouteMetric & { coordinates: [number, number][] } {
  return Boolean(
    route?.coordinates
    && route.coordinates.length >= 2
    && (route.geometrySource === 'shape' || route.geometrySource === undefined),
  )
}

function scenarioPublishedShapeSegmentIndexes(
  route: RouteMetric | undefined,
  stops: ScenarioStopDraft[],
) {
  if (!routeHasPublishedShape(route) || stops.length < 2) return []
  const baselineIndexes = new Map(route.stopIds.map((stopId, index) => [stopId, index]))
  const baselineId = (stop: ScenarioStopDraft) => stop.baselineStopId ?? stop.stopId
  return stops.slice(0, -1).flatMap((left, index) => {
    const right = stops[index + 1]
    // Preserve only an untouched published edge. A replacement keeps the
    // baseline ID for scope matching, but its coordinate is intentionally
    // edited and must be traced by OSM instead.
    if (left.editStatus !== 'baseline' || right.editStatus !== 'baseline') return []
    const leftIndex = baselineIndexes.get(String(baselineId(left) ?? ''))
    const rightIndex = baselineIndexes.get(String(baselineId(right) ?? ''))
    return leftIndex !== undefined && rightIndex === leftIndex + 1 ? [index] : []
  })
}

type ScenarioSegmentRuntimeOptions = {
  segmentDistancesKm?: number[]
  addedStopDwellMinutes?: number
}

function scenarioSegmentRuntimeMinutes(
  route: RouteMetric,
  stops: ScenarioStopDraft[],
  preview: MapPreview,
  options: ScenarioSegmentRuntimeOptions = {},
) {
  const routePatternIds = new Set([route.id, route.patternId ?? route.id])
  const pairRuntimes = new Map<string, number>()
  for (const pair of (preview.stopPairs ?? [])
    .filter((candidate) => routePatternIds.has(candidate.patternId))
    .sort((left, right) => left.sequence - right.sequence)) {
    if (!Number.isFinite(pair.medianRuntimeMinutes) || pair.medianRuntimeMinutes <= 0) continue
    const key = `${pair.fromStopId}\u0000${pair.toStopId}`
    if (!pairRuntimes.has(key)) pairRuntimes.set(key, pair.medianRuntimeMinutes)
  }

  const baselineIndexes = new Map(route.stopIds.map((stopId, index) => [stopId, index]))
  const spanRuntime = (leftIndex: number, rightIndex: number) => {
    const direction = Math.sign(rightIndex - leftIndex)
    if (!direction) return 0
    const start = Math.min(leftIndex, rightIndex)
    const end = Math.max(leftIndex, rightIndex)
    let total = 0
    for (let index = start; index < end; index += 1) {
      const fromStopId = route.stopIds[index]
      const toStopId = route.stopIds[index + 1]
      const runtime = pairRuntimes.get(
        direction > 0
          ? `${fromStopId}\u0000${toStopId}`
          : `${toStopId}\u0000${fromStopId}`,
      )
      if (runtime === undefined || !Number.isFinite(runtime)) return null
      total += runtime
    }
    return total
  }
  const baselineCoordinates = new Map(preview.stops.map((stop) => [stop.id, [Number(stop.lon), Number(stop.lat)] as [number, number]]))
  const publishedCoordinate = (stop: ScenarioStopDraft) => {
    const id = stop.baselineStopId ?? stop.stopId
    const coordinate = id ? baselineCoordinates.get(id) : undefined
    return coordinate ?? stop.coordinate
  }
  const routeDistance = (left: ScenarioStopDraft, right: ScenarioStopDraft) => (
    routeHasPublishedShape(route)
      && Array.isArray(route.coordinates)
      && route.coordinates.length >= 2
      ? polylineDistanceKm(route.coordinates, publishedCoordinate(left), publishedCoordinate(right))
      : coordinateDistanceKm(publishedCoordinate(left), publishedCoordinate(right))
  )
  const fallbackRuntime = (left: ScenarioStopDraft, right: ScenarioStopDraft) => {
    const speedKph = Number(route.scheduledSpeedKph)
    const distanceKm = routeDistance(left, right)
    return speedKph > 0
      ? Math.max(0.05, distanceKm / speedKph * 60)
      : Math.max(0.05, coordinateDistanceKm(left.coordinate, right.coordinate) / 25 * 60)
  }
  const stopBaselineIndex = (stop: ScenarioStopDraft) => {
    const id = stop.baselineStopId ?? stop.stopId
    return id ? baselineIndexes.get(id) : undefined
  }

  const runtimes: number[] = []
  let index = 0
  while (index < stops.length - 1) {
    const left = stops[index]
    const leftIndex = stopBaselineIndex(left)
    if (leftIndex !== undefined) {
      let rightPosition = index + 1
      while (rightPosition < stops.length && stopBaselineIndex(stops[rightPosition]) === undefined) {
        rightPosition += 1
      }
      const rightIndex = rightPosition < stops.length ? stopBaselineIndex(stops[rightPosition]) : undefined
      const preservedRuntime = rightIndex === undefined ? null : spanRuntime(leftIndex, rightIndex)
      if (rightIndex !== undefined) {
        const block = stops.slice(index, rightPosition + 1)
        const originalRuntime = preservedRuntime ?? fallbackRuntime(left, block.at(-1)!)
        const originalDistance = routeDistance(left, block.at(-1)!)
        const requestedDistances = options.segmentDistancesKm?.slice(index, rightPosition)
        const shapeDistances = block.slice(1).map((stop, blockIndex) => (
          routeDistance(block[blockIndex], stop)
        ))
        const distances = requestedDistances?.length === block.length - 1
          && requestedDistances.every((distance) => Number.isFinite(distance) && distance >= 0)
          ? requestedDistances
          : shapeDistances
        const totalDistance = distances.reduce((sum, distance) => sum + distance, 0)
        const referenceSpeedKph = originalDistance > 0 && originalRuntime > 0
          ? originalDistance / originalRuntime * 60
          : Number(route.scheduledSpeedKph) > 0
            ? Number(route.scheduledSpeedKph)
            : 25
        const adjustedTravelRuntime = Math.max(
          0.05,
          originalRuntime + (totalDistance - originalDistance) / referenceSpeedKph * 60,
        )
        const addedStopDwellMinutes = Math.max(0, Number(options.addedStopDwellMinutes ?? 0))
        runtimes.push(...distances.map((distance, segmentIndex) => {
          const distributedTravel = totalDistance > 0
            ? adjustedTravelRuntime * distance / totalDistance
            : adjustedTravelRuntime / Math.max(1, distances.length)
          // Associate dwell with the station reached by this segment. The
          // server reverses the segment array for the opposite direction, so
          // this keeps the dwell at the same physical stop both ways.
          const destinationStop = block[segmentIndex + 1]
          const addedDwell = addedStopDwellMinutes > 0
            && (destinationStop.editStatus === 'inserted' || destinationStop.editStatus === 'added')
            ? addedStopDwellMinutes
            : 0
          return Math.max(0.05, distributedTravel + addedDwell)
        }))
        index = rightPosition
        continue
      }
    }
    runtimes.push(fallbackRuntime(left, stops[index + 1]))
    index += 1
  }
  return runtimes
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
          detail: 'Amber lines need GTFS shapes before map-based evidence is publication-ready.',
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
          detail: 'No route in this scope violates the basic headway/span gate.',
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
    <section className="project-page project-switcher" aria-labelledby="workspace-switcher-title">
      <header className="workspace-switcher-head">
        <div>
          <span className="eyebrow">Workspaces</span>
          <h1 id="workspace-switcher-title">Choose a workspace</h1>
          <p>Open a project, or manage its local workspace.</p>
        </div>
        <div className="workspace-switcher-actions">
          <IconButton label="Refresh workspaces" onClick={onRefresh}>
            <RefreshCw size={15} />
          </IconButton>
          <IconButton label="Open settings" onClick={onOpenSettings}>
            <Settings size={15} />
          </IconButton>
          <button type="button" className="button button-primary" onClick={onCreateProject}>
            <FolderPlus size={15} />
            <span>New workspace</span>
          </button>
        </div>
      </header>

      {visibleProjects.length ? (
        <div className="workspace-switcher-list">
          {visibleProjects.map((project) => {
            const hasData = hasOperationsData(project)
            const isSelected = project.id === selectedProject.id
            const readiness = project.routingStore?.status === 'ready'
              ? 'Indexed locally'
              : hasData
                ? 'GTFS available'
                : 'No GTFS data'
            const readinessStatus: WorkspaceStatus = project.routingStore
              ? statusFromStoreStatus(project.routingStore.status)
              : hasData
                ? 'stale'
                : 'idle'
            return (
              <article key={project.id} className={classNames('workspace-switcher-row', isSelected && 'is-current')}>
                <button
                  type="button"
                  className="workspace-switcher-open"
                  onClick={() => onOpenProject(project.id)}
                  aria-label={`Open ${project.name} Routes`}
                  aria-current={isSelected ? 'page' : undefined}
                >
                  <span className={classNames('workspace-readiness-dot', hasData && 'is-ready')} aria-hidden="true" />
                  <span className="workspace-switcher-copy">
                    <strong title={project.name}>{quietMapLabel(project.name)}</strong>
                    <small title={project.region}>{project.region}</small>
                  </span>
                  <span className="workspace-switcher-status">
                    <StatusBadge status={readinessStatus} label={readiness} />
                    <small>{formatNumber(project.summary.feeds)} feed{project.summary.feeds === 1 ? '' : 's'} · {formatNumber(project.summary.routes)} route records</small>
                  </span>
                </button>
                <div className="workspace-switcher-row-actions" aria-label={`Manage ${project.name}`}>
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
            <div className="workspace-switcher-loading" role="status" aria-live="polite">
              <span />
              Opening workspace…
            </div>
          ) : null}
        </div>
      ) : (
        <div className="project-empty-state">
          <Database size={24} />
          <strong>{normalizedQuery ? 'No matching workspace' : 'No workspaces yet'}</strong>
          <span>{normalizedQuery ? 'Try a different name.' : 'Create a workspace, then add a GTFS feed.'}</span>
          <button type="button" className="button button-primary" onClick={onCreateProject}>
            <FolderPlus size={15} />
            New workspace
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
        <span className="eyebrow">Workspace recovery</span>
        <h1 id="storage-recovery-title">VIGO cannot write to its project folder</h1>
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
  isRealtimeLoading,
  onFiles,
  onNationalGtfsPath,
  onNationalOsmPath,
  onOsmFiles,
  onRunRealtimeUrl,
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
  isRealtimeLoading: boolean
  onFiles: (files: FileList | File[]) => void
  onNationalGtfsPath: (path: string) => void
  onNationalOsmPath: (path: string) => void
  onOsmFiles: (files: FileList | File[]) => void
  onRunRealtimeUrl: (sourceText: string) => void
  onExportReproducibility: () => void
  onCancelGtfs: () => void
  onRetryGtfs: () => void
  onCancelOsm: () => void
  onRetryOsm: () => void
}) {
  const fileRef = useRef<HTMLInputElement | null>(null)
  const osmFileRef = useRef<HTMLInputElement | null>(null)
  const [realtimeUrl, setRealtimeUrl] = useState('')
  const [realtimeDetailsOpen, setRealtimeDetailsOpen] = useState(!realtimeSnapshot)
  useEffect(() => {
    if (!realtimeSnapshot) setRealtimeDetailsOpen(true)
  }, [realtimeSnapshot])
  const chooseGtfs = () => {
    if (!requestNativeGtfsFile(onNationalGtfsPath)) fileRef.current?.click()
  }
  const chooseOsm = () => {
    if (!requestNativeOsmFile(onNationalOsmPath)) osmFileRef.current?.click()
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    if (event.dataTransfer.files.length) onFiles(event.dataTransfer.files)
  }

  return (
    <section className="workspace-panel import-panel" aria-label="Feed import">
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

      <details
        className="advanced-import"
        open={realtimeDetailsOpen}
        onToggle={(event) => setRealtimeDetailsOpen(event.currentTarget.open)}
      >
        <summary>Live data · GTFS-RT feeds</summary>
        <form
          className="url-import realtime-import"
          onSubmit={(event) => {
            event.preventDefault()
            if (!realtimeUrl.trim()) return
            onRunRealtimeUrl(realtimeUrl.trim())
          }}
        >
          <textarea
            aria-label="GTFS realtime feed URLs or viewer link"
            value={realtimeUrl}
            onChange={(event) => setRealtimeUrl(event.target.value)}
            placeholder={'Vehicle Positions URL\nTrip Updates URL (optional)\nService Alerts URL (optional)'}
            rows={3}
          />
          <button type="submit" disabled={isRealtimeLoading}>
            <Radio size={14} />
            Connect live
          </button>
        </form>
      </details>
      <div className={classNames('realtime-strip', realtimeSnapshot && 'has-live')}>
        <Radio size={14} />
        <span>{realtimeMessage || (realtimeSnapshot ? `${formatNumber(realtimeSnapshot.counts.vehicles)} veh / ${formatNumber(realtimeSnapshot.counts.tripUpdates)} updates / ${formatNumber(realtimeSnapshot.counts.alerts)} alerts` : 'RT off')}</span>
      </div>
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
  const timetableStatus: WorkspaceStatus = timetableReady
    ? 'ready'
    : timetableBuilding
      ? 'preparing'
      : 'blocked'
  const steps: Array<{
    label: string
    value: string
    detail: string
    state: WorkspaceStatus
    icon: LucideIcon
  }> = [
    {
      label: 'Source',
      value: `${project.feeds.length} feed${project.feeds.length === 1 ? '' : 's'}`,
      detail: activeFeed.source === 'bundle' ? 'Project bundle' : activeFeed.name,
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
    <section className="workspace-panel bundle-panel" aria-label="Project GTFS bundle">
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
            <small>{project.routingStore?.status === 'ready' ? 'Project SQLite index ready' : 'All GTFS in project'}</small>
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

function WorkspaceSourceStatus({
  icon,
  title,
  detail,
  ready,
  working,
  status: sourceStatus,
}: {
  icon: ReactNode
  title: string
  detail: string
  ready: boolean
  working: boolean
  status?: WorkspaceStatus
}) {
  const status: WorkspaceStatus = sourceStatus ?? (ready ? 'ready' : working ? 'preparing' : 'blocked')
  return (
    <div className={classNames('workspace-source-status', ready && 'is-ready', working && 'is-working')}>
      <span className="workspace-source-status-icon">{icon}</span>
      <span className="workspace-source-status-copy">
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      <StatusBadge status={status} label={ready ? 'Ready' : working ? 'Preparing' : 'Required'} />
    </div>
  )
}

function EmptyOperationsStart({
  project,
  gtfsReady,
  osmStreetReady,
  isImporting,
  isOsmImporting,
  gtfsJob,
  osmJob,
  importMessage,
  osmStreetMessage,
  realtimeSnapshot,
  realtimeMessage,
  isRealtimeLoading,
  onFiles,
  onNationalGtfsPath,
  onNationalOsmPath,
  onOsmFiles,
  onRunRealtimeUrl,
  onExportReproducibility,
  onCancelGtfs,
  onRetryGtfs,
  onCancelOsm,
  onRetryOsm,
}: {
  project: VigoProject
  gtfsReady: boolean
  osmStreetReady: boolean
  isImporting: boolean
  isOsmImporting: boolean
  gtfsJob?: JobRecord
  osmJob?: JobRecord
  importMessage: string
  osmStreetMessage: string
  realtimeSnapshot: RealtimeSnapshot | null
  realtimeMessage: string
  isRealtimeLoading: boolean
  onFiles: (files: FileList | File[]) => void
  onNationalGtfsPath: (path: string) => void
  onNationalOsmPath: (path: string) => void
  onOsmFiles: (files: FileList | File[]) => void
  onRunRealtimeUrl: (url: string) => void
  onExportReproducibility: () => void
  onCancelGtfs: () => void
  onRetryGtfs: () => void
  onCancelOsm: () => void
  onRetryOsm: () => void
}) {
  const gtfsDetail = gtfsReady
    ? `${formatNumber(project.summary.routes)} routes indexed in SQLite`
    : isImporting
      ? importMessage || 'Building the local timetable index…'
      : 'Add a GTFS ZIP to load routes and schedules'
  const osmDetail = osmStreetReady
    ? `${formatNumber(project.osmStreetIndex?.edgeCount ?? 0)} walk edges indexed locally`
    : isOsmImporting
      ? osmStreetMessage || 'Building the local street network…'
      : 'Add an OSM PBF to enable street access'

  return (
    <div className="workbench empty-workbench empty-intake">
      <section className="workspace-source-intake" aria-labelledby="workspace-source-intake-title">
        <div className="workspace-source-intake-copy">
          <span className="eyebrow">Workspace setup</span>
          <h1 id="workspace-source-intake-title">Prepare {quietMapLabel(project.name)}</h1>
          <p>Load the timetable and the local street network before opening Network, Route, or Evidence.</p>
        </div>

        <div className="workspace-source-statuses" aria-label="Required workspace sources">
          <WorkspaceSourceStatus
            icon={<FileArchive size={18} />}
            title="GTFS timetable"
            detail={gtfsDetail}
            ready={gtfsReady}
            working={isImporting}
            status={statusFromJobStatus(gtfsJob?.status ?? (gtfsReady ? 'complete' : isImporting ? 'running' : 'missing'))}
          />
          <WorkspaceSourceStatus
            icon={<Navigation2 size={18} />}
            title="OSM street network"
            detail={osmDetail}
            ready={osmStreetReady}
            working={isOsmImporting}
            status={statusFromJobStatus(osmJob?.status ?? (osmStreetReady ? 'complete' : isOsmImporting ? 'running' : 'missing'))}
          />
        </div>

        <p className="workspace-source-hint">
          {gtfsReady && osmStreetReady
            ? 'Both sources are ready. Opening the network workspace…'
            : 'You can load both files at the same time; each source is indexed independently.'}
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
          isRealtimeLoading={isRealtimeLoading}
          onFiles={onFiles}
          onNationalGtfsPath={onNationalGtfsPath}
          onNationalOsmPath={onNationalOsmPath}
          onOsmFiles={onOsmFiles}
          onRunRealtimeUrl={onRunRealtimeUrl}
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

function RouteWorkspace({
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
  scheduleServiceDay,
  routingEnabled,
  routingOrigin,
  routingWaypoints,
  routingDestination,
  routingPlan,
  routingFocus,
  analysisFocus,
  scenarioAnalysis,
  scenarioComparison,
  serviceDecomposition,
  scenarioView,
  scenarioRenderMode,
  scenarioCutoffMinutes,
  scenarioSketchStops,
  scenarioSketchGeometry,
  scenarioPointPicking,
  onMoveScenarioStop,
  routingActivity,
  workspacePreviewLoading,
  onMapScopeChange,
  onVehicleModeChange,
  onScheduleTimeChange,
  onScheduleServiceDayChange,
  onRoutingPoint,
  onSelectRoute,
  onSelectStop,
}: {
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
  scheduleServiceDay: ServiceDay
  routingEnabled: boolean
  routingOrigin: RoutingPoint | null
  routingWaypoints: RoutingPoint[]
  routingDestination: RoutingPoint | null
  routingPlan: RoutingPlan | null
  routingFocus: boolean
  analysisFocus: boolean
  scenarioAnalysis: ScenarioAnalysisResult | null
  scenarioComparison: ScenarioComparisonResult[] | null
  serviceDecomposition: ServiceEdgeDecomposition | null
  scenarioView: ScenarioView
  scenarioRenderMode: ScenarioRenderMode
  scenarioCutoffMinutes: number
  scenarioSketchStops: ScenarioStopDraft[]
  scenarioSketchGeometry: [number, number][]
  scenarioPointPicking: boolean
  onMoveScenarioStop?: (index: number, coordinate: [number, number]) => void
  routingActivity: RoutingActivity
  workspacePreviewLoading: boolean
  onMapScopeChange: (scope: MapScope) => void
  onVehicleModeChange: (mode: ServiceVehicleMode) => void
  onScheduleTimeChange: (minutes: number) => void
  onScheduleServiceDayChange: (serviceDay: ServiceDay) => void
  onRoutingPoint?: (point: RoutingPoint) => void
  onSelectRoute: (id: string) => void
  onSelectStop: (id: string) => void
}) {
  const isNetworkMap = mapScope === 'network' || !selectedRoute
  const routingCanvasPreview = useMemo<MapPreview>(() => ({ routes: [], stops: visiblePreview.stops, stopPairs: [] }), [visiblePreview.stops])
  const workspaceMapPreview = useMemo(
    () => buildWorkspacePreviewLod(visiblePreview, selectedRouteId),
    [selectedRouteId, visiblePreview],
  )
  const mapPreview = routingFocus || analysisFocus ? routingCanvasPreview : isNetworkMap ? workspaceMapPreview : focusedPreview
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
      : scheduledVehiclesAtTime(mapPreview, scheduleTimeMinutes, scheduleServiceDay),
    [analysisFocus, mapPreview, routingFocus, scheduleServiceDay, scheduleTimeMinutes, vehicleMode],
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
  const visibleVehicleCount = serviceVehicleCount(vehicleFrame, isNetworkMap ? undefined : selectedRoute)
  const serviceDiagnostics = useMemo(
    () => vehicleMode === 'live'
      ? liveVehicleDiagnostics(visibleVehicleCount, realtimeSnapshot !== null)
      : scheduledVehicleDiagnostics(mapPreview, scheduledVehicles, scheduleTimeMinutes, scheduleServiceDay),
    [mapPreview, realtimeSnapshot, scheduleServiceDay, scheduleTimeMinutes, scheduledVehicles, vehicleMode, visibleVehicleCount],
  )
  const routeStyle = {
    '--route-color': selectedRoute?.color ?? '#6da8ff',
  } as CSSProperties
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
      const nextTime = (playbackTimeRef.current + servicePlaybackStep + 1440) % 1440
      playbackTimeRef.current = nextTime
      onScheduleTimeChange(nextTime)
    }, 650)
    return () => window.clearInterval(timer)
  }, [analysisFocus, onScheduleTimeChange, routingFocus, servicePlaybackRunning, servicePlaybackStep, vehicleMode])

  return (
    <section className="route-workspace" aria-label="GTFS map and service state" style={routeStyle}>
      <div className="workspace-panel route-map-shell">
        <LazyVigoMap
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
          scenarioAnalysis={scenarioAnalysis}
          scenarioComparison={scenarioComparison}
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
        {!routingFocus && !analysisFocus ? (
          <MapScopeControl
            mapScope={isNetworkMap ? 'network' : 'route'}
            routeFocusAvailable={Boolean(selectedRoute)}
            onMapScopeChange={onMapScopeChange}
          />
        ) : null}
        {workspacePreviewLoading ? (
          <div className="workspace-loading-overlay" role="status" aria-live="polite">
            <span className="workspace-preview-loading" />
            <strong>Loading workspace…</strong>
          </div>
        ) : null}
        {!routingFocus && !analysisFocus ? (
          <ServiceStateControl
            mode={vehicleMode}
            frame={vehicleFrame}
            vehicleCount={visibleVehicleCount}
            diagnostics={serviceDiagnostics}
            scheduleTimeMinutes={scheduleTimeMinutes}
            scheduleServiceDay={scheduleServiceDay}
            playbackRunning={servicePlaybackRunning}
            playbackStep={servicePlaybackStep}
            onModeChange={onVehicleModeChange}
            onTogglePlayback={() => setServicePlaybackRunning((current) => !current)}
            onPlaybackStepChange={setServicePlaybackStep}
            onScheduleTimeChange={onScheduleTimeChange}
            onScheduleServiceDayChange={onScheduleServiceDayChange}
          />
        ) : null}
        {!routingFocus && !analysisFocus && !mapPreview.routes.length ? (
          <div className="route-geometry-empty">
            <strong>No spatial alignment in this scope</strong>
            <span>The service remains indexed. Inspect stop coordinates, stop sequences, and shapes.txt to establish defensible map geometry.</span>
          </div>
        ) : null}
      </div>
    </section>
  )
}

function FeedTableContract({
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
    <section className="workspace-panel feed-table-contract" aria-label="Source tables">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Source tables</span>
          <h2>{requiredPresent === requiredTables.length && requiredTables.length ? 'Core tables ready' : `${requiredTables.length - requiredPresent} core missing`}</h2>
          <p>{requiredPresent}/{requiredTables.length} required · {optionalPresent}/{optionalTables.length} optional</p>
        </div>
        <TableProperties size={16} />
      </div>

      <div className="table-contract-list" role="list">
        {tableProfiles.map((profile) => (
          <div
            key={profile.name}
            className={classNames('table-contract-row', !profile.present && 'is-missing', profile.name.startsWith('TIDES') && 'is-tides')}
            role="listitem"
          >
            <span>
              <strong>{profile.name}</strong>
              <small>{profile.fields.length ? profile.fields.slice(0, 4).join(', ') : profile.present ? 'profiled' : 'not present'}</small>
            </span>
            <span className="table-contract-status">
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
  const [scheduleServiceDay, setScheduleServiceDay] = useState<ServiceDay>('weekday')
  const [routingServiceDate, setRoutingServiceDate] = useState(() => localCalendarDate())
  const [routingResidencyCoverage, setRoutingResidencyCoverage] = useState<RoutingServiceCoverage | null>(null)
  const [routingTimePreference, setRoutingTimePreference] = useState<RoutingTimePreference>('depart')
  const [routingMode, setRoutingMode] = useState<RoutingTravelMode>('transit')
  const [routingDepartureWindowMinutes, setRoutingDepartureWindowMinutes] = useState<RoutingDepartureWindowMinutes>(20)
  const [routingMaxWalkKm, setRoutingMaxWalkKm] = useState(1.2)
  const [routingAllowLongWalk, setRoutingAllowLongWalk] = useState(true)
  const [selectedRoutingPlanId, setSelectedRoutingPlanId] = useState('')
  const [routingEnabled, setRoutingEnabled] = useState(false)
  const [routingOrigin, setRoutingOrigin] = useState<RoutingPoint | null>(null)
  const [routingWaypoints, setRoutingWaypoints] = useState<RoutingPoint[]>([])
  const [routingDestination, setRoutingDestination] = useState<RoutingPoint | null>(null)
  const [analysisOrigin, setAnalysisOrigin] = useState<RoutingPoint | null>(null)
  const [accessibilityMode, setAccessibilityMode] = useState<AccessibilityMode>('single')
  const [scenarioAnalysis, setScenarioAnalysis] = useState<ScenarioAnalysisResult | null>(null)
  const [scenarioComparison, setScenarioComparison] = useState<ScenarioComparisonResult[] | null>(null)
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
  const [accessibilityCases, setAccessibilityCases] = useState<AccessibilityCaseDraft[]>([{
    id: 'case-a',
    name: 'Case A',
    interventions: [],
  }])
  const [comparisonFeedIds, setComparisonFeedIds] = useState<string[]>([])
  const comparisonFeedInitializationRef = useRef(false)
  const [activeAccessibilityCaseId, setActiveAccessibilityCaseId] = useState('case-a')
  const [activeAccessibilityInterventionId, setActiveAccessibilityInterventionId] = useState('')
  const [scenarioStopPlacement, setScenarioStopPlacement] = useState<ScenarioStopPlacement | null>(null)
  const analysisAbortRef = useRef<AbortController | null>(null)
  const scenarioRoadGeometryAbortRef = useRef<AbortController | null>(null)
  const scenarioRoadGeometryRequestIdRef = useRef(0)
  const serviceDecompositionAbortRef = useRef<AbortController | null>(null)
  const invalidateAccessibilityAnalysis = useCallback(() => {
    analysisAbortRef.current?.abort()
    analysisAbortRef.current = null
    scenarioRoadGeometryAbortRef.current?.abort()
    scenarioRoadGeometryAbortRef.current = null
    scenarioRoadGeometryRequestIdRef.current += 1
    serviceDecompositionAbortRef.current?.abort()
    serviceDecompositionAbortRef.current = null
    setScenarioAnalysis(null)
    setScenarioComparison(null)
    setServiceDecomposition(null)
    setServiceDecompositionLoading(false)
    setServiceDecompositionError('')
    setScenarioError('')
    setScenarioLoading(false)
    setScenarioProgress(null)
  }, [])
  const [routingLocationResolving, setRoutingLocationResolving] = useState(false)
  const [routingLocationError, setRoutingLocationError] = useState('')
  const [pendingRoutingLocationResolution, setPendingRoutingLocationResolution] = useState<PendingRoutingLocationResolution | null>(null)
  const routingLocationAbortRef = useRef<AbortController | null>(null)
  const routingLocationRequestIdRef = useRef(0)
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
  const [realtimeUrl, setRealtimeUrl] = useState('')
  const realtimeInFlightRef = useRef(false)
  const realtimeRequestIdRef = useRef(0)
  const [query, setQuery] = useState('')
  const navigationMemoryRef = useRef(readNavigationMemory())
  const [recentSearchIds, setRecentSearchIds] = useState(navigationMemoryRef.current.recentSearchIds)
  const deferredQuery = useDeferredValue(query)
  const [statusFilter, setStatusFilter] = useState<RouteStatusFilter>('all')
  const [page, setPage] = useState<'projects' | 'project'>('projects')
  const [activeFeedId, setActiveFeedId] = useState(bundleFeedId)
  const [activeRouteTool, setActiveRouteTool] = useState<RouteToolKey>('explore')
  const [dataSection, setDataSection] = useState<DataSection>('feeds')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [projectDialog, setProjectDialog] = useState<ProjectDialogState | null>(null)
  const [projectDialogBusy, setProjectDialogBusy] = useState(false)
  const [projectDialogError, setProjectDialogError] = useState('')
  const changeRoutingServiceDate = useCallback((serviceDate: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) return
    setRoutingServiceDate(serviceDate)
    setSelectedRoutingPlanId('')
  }, [])
  const {
    beginWorkspaceSelection,
    cancelProjectDetail,
    workspacePreviewLoadingProjectId,
  } = useProjectDetailHydration({
    projects,
    selectedProjectId,
    setProjects,
    onSelectProject: applyWorkspaceSelection,
    onError: setApiError,
  })

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? projects[0] ?? emptyWorkspaceProject(health?.storageRoot),
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
  const workspacePreviewLoading = Boolean(workspacePreviewLoadingProjectId)
  const activeScope = useMemo(() => scopedFeedAndPreview(selectedProject, activeFeedId), [selectedProject, activeFeedId])
  const activeFeed = activeScope.feed
  const preview = activeScope.preview
  const comparisonFeedOptions = useMemo<AccessibilityFeedOption[]>(
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
  const accessibilityInputIdentity = [
    nationalRoutingStoreKey,
    comparisonStoreIdentity,
    selectedProject.osmStreetIndex?.builtAt ?? '',
    routingServiceDate,
    scheduleTimeMinutes,
    routingMaxWalkKm,
  ].join(':')
  const routingWorkspaceActive = page === 'project' && Boolean(nationalRoutingFeed)
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
    origin: activeRouteTool === 'pathfinder' && !pendingRoutingLocationResolution ? routingOrigin : null,
    waypoints: routingWaypoints,
    destination: activeRouteTool === 'pathfinder' && !pendingRoutingLocationResolution ? routingDestination : null,
    mode: routingMode,
    departMinutes: scheduleTimeMinutes,
    timePreference: routingTimePreference,
    serviceDay: routingServiceDay,
    serviceDate: routingServiceDate,
    maxWalkKm: routingMaxWalkKm,
    allowLongWalk: routingAllowLongWalk,
    departureWindowMinutes: routingDepartureWindowMinutes,
    realtimeSnapshot,
    routeAllowed: routingStreetState === 'ready',
    onError: setApiError,
  })
  const routingMergeSourceIdentity = selectedProject.feeds
    .filter((feed) => feed.routingStore?.status === 'ready')
    .map((feed) => `${feed.id}:${feed.routingStore?.sourceFingerprint ?? feed.routingStore?.builtAt ?? ''}`)
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
    invalidateAccessibilityAnalysis()
  }, [accessibilityInputIdentity, invalidateAccessibilityAnalysis])
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
    if (!routingWorkspaceActive || !nationalRoutingFeed) {
      setRoutingResidencyCoverage(null)
      return
    }
    let active = true
    const leaseId = `desktop-workspace-${crypto.randomUUID()}`
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
    routingWorkspaceActive,
    nationalRoutingFeed?.id,
    selectedProject.id,
    routingServiceDate,
    routingServiceDay,
  ])
  useEffect(() => {
    if (activeRouteTool !== 'accessibility') return
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
  const routingStoreReadyFeedCount = nationalRoutingFeed
    ? nationalRouting.ready ? routingStoreStoredFeedCount : 0
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
  const gtfsSourceReady = hasActiveOperationsData
    && selectedProject.feeds.length > 0
    && selectedProject.feeds.every((feed) => feed.routingStore?.status === 'ready')
  const workspaceSourcesReady = hasReadyWorkspaceSources(selectedProject)
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
  const activeAccessibilityCase = accessibilityCases.find(
    (entry) => entry.id === activeAccessibilityCaseId,
  ) ?? accessibilityCases[0]
  const activeAccessibilityIntervention = activeAccessibilityCase?.interventions.find(
    (entry) => entry.id === activeAccessibilityInterventionId,
  ) ?? activeAccessibilityCase?.interventions[0]
  const activeAccessibilityRoute = activeAccessibilityIntervention?.routeId
    ? preview.routes.find((route) => (
      route.id === activeAccessibilityIntervention.routeId
      || route.patternId === activeAccessibilityIntervention.routeId
    ))
    : undefined
  const scenarioSketchStops = ['add-line', 'change-line'].includes(activeAccessibilityIntervention?.kind ?? '')
    ? activeAccessibilityIntervention.stops
    : []
  const scenarioSketchGeometry = useMemo<[number, number][]>(() => {
    if (!activeAccessibilityIntervention || scenarioSketchStops.length < 2) return []
    const geometryMode = activeAccessibilityIntervention.geometryMode
      ?? (activeAccessibilityIntervention.timeModel === 'infer-road'
        ? 'auto-road'
        : activeAccessibilityIntervention.timeModel === 'estimate-distance'
          ? 'straight-line'
          : 'published-shape')
    if (geometryMode === 'auto-road' && activeAccessibilityIntervention.geometryStatus === 'ready') {
      return activeAccessibilityIntervention.inferredGeometry ?? scenarioSketchStops.map((stop) => stop.coordinate)
    }
    const publishedGeometry = routeHasPublishedShape(activeAccessibilityRoute)
      ? activeAccessibilityRoute.coordinates
      : undefined
    if (geometryMode === 'published-shape' && publishedGeometry && publishedGeometry.length >= 2) {
      return publishedGeometry
    }
    // Do not draw an invented chord while the hybrid OSM/shape path is still
    // being prepared. Existing route shape remains useful context; a new
    // line stays point-only until its road geometry is certified.
    if (geometryMode === 'auto-road') return publishedGeometry ?? []
    return scenarioSketchStops.map((stop) => stop.coordinate)
  }, [activeAccessibilityIntervention, activeAccessibilityRoute, scenarioSketchStops])
  const activeScenarioStopPlacement = scenarioStopPlacement?.interventionId === activeAccessibilityIntervention?.id
    ? scenarioStopPlacement
    : null
  const scenarioPointPicking = activeRouteTool === 'accessibility' && Boolean(
    !analysisOrigin
    || accessibilityMode === 'single' && activeScenarioStopPlacement,
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
  const routingLocationChoices = useMemo<RoutingLocationChoice[]>(() => {
    if (!pendingRoutingLocationResolution) return []
    return pendingRoutingLocationResolution.queries.flatMap((query, index, queries) => (
      pendingRoutingLocationResolution.selections[index]
        ? []
        : [{
            queryIndex: index,
            query,
            role: index === 0 ? 'Origin' : index === queries.length - 1 ? 'Destination' : `Stop ${index}`,
            routeQueries: pendingRoutingLocationResolution.queries,
            options: pendingRoutingLocationResolution.candidates[index] ?? [],
          }]
    ))
  }, [pendingRoutingLocationResolution])
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
    && !workspaceSourcesReady

  function clearAnalysisState() {
    invalidateAccessibilityAnalysis()
    comparisonFeedInitializationRef.current = false
    setComparisonFeedIds([])
    setAnalysisOrigin(null)
    setAccessibilityCases([{ id: 'case-a', name: 'Case A', interventions: [] }])
    setActiveAccessibilityCaseId('case-a')
    setActiveAccessibilityInterventionId('')
    setScenarioStopPlacement(null)
  }

  function cancelRouteAnalysis() {
    routeAnalysisAbortRef.current?.abort()
    routeAnalysisAbortRef.current = null
    routeAnalysisRequestIdRef.current += 1
    setRouteAnalysisRouteId('')
    setRouteAnalysisError('')
  }

  function applyWorkspaceSelection(projectId: string) {
    cancelRouteAnalysis()
    if (selectedProjectId !== projectId) {
      clearRouting()
      clearAnalysisState()
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
      setActiveRouteTool('explore')
      applyNetworkMapDefaults()
      setApiError('')
      if (nextSelectedId) {
        setSelectedProjectId(nextSelectedId)
        setPage('project')
        beginWorkspaceSelection(nextSelectedId, nextProjects)
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
    syncNativeChromeState({
      appearance,
      title: page === 'projects' ? 'Workspaces' : quietMapLabel(selectedProject.name),
      sidebarAvailable: page === 'project' && !isProjectEmpty,
      sidebarCollapsed,
      canGoBack: page === 'project',
      canGoForward: page === 'projects' && selectedProjectExists,
    })
  }, [appearance, isProjectEmpty, page, projects, selectedProject.id, selectedProject.name, sidebarCollapsed])

  useEffect(() => subscribeNativeCommands((command) => {
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
      setOsmStreetMessage(street.schemaVersion === 'vigo.street.store.v3'
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
    if (page !== 'project' || activeRouteTool !== 'explore' || !selectedRoute) return
    if (routeHasCompleteGtfsAnalysis(selectedRoute, preview)) return
    void loadGtfsRouteAnalysis(selectedRoute, selectedRoute.id)
  }, [activeFeedId, activeRouteTool, page, preview, selectedProject.id, selectedRoute])

  useEffect(() => {
    if (page !== 'project' || activeRouteTool !== 'accessibility') return
    const routeId = activeAccessibilityIntervention?.routeId
    if (!routeId) return
    const route = preview.routes.find((candidate) => (
      candidate.id === routeId || candidate.patternId === routeId
    ))
    if (!route || routeHasCompleteGtfsAnalysis(route, preview)) return
    void loadGtfsRouteAnalysis(route, route.id)
  }, [
    activeAccessibilityIntervention?.routeId,
    activeFeedId,
    activeRouteTool,
    page,
    preview,
    selectedProject.id,
  ])

  useEffect(() => {
    if (page !== 'project' || activeRouteTool !== 'accessibility') return
    const intervention = activeAccessibilityIntervention
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
    setAccessibilityCases((current) => current.map((entry) => ({
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
    activeAccessibilityIntervention,
    activeRouteTool,
    page,
    preview,
  ])

  useEffect(() => {
    if (page !== 'project' || !selectedProject.id || !needsProjectDetail(selectedProject)) return
    if (workspacePreviewLoadingProjectId === selectedProject.id) return
    beginWorkspaceSelection(selectedProject.id)
  }, [page, selectedProject.id, workspacePreviewLoadingProjectId])

  useEffect(() => {
    if (page === 'project') scrollWorkbenchToTop()
  }, [page])

  useEffect(() => {
    if (workspacePreviewLoading || selectedProject.id === '__empty_workspace__') return
    if (selectedRouteId && !preview.routes.some((route) => route.id === selectedRouteId || route.patternId === selectedRouteId)) {
      setSelectedRouteId('')
      navigationMemoryRef.current = rememberRoute(selectedProject.id, '')
    }
    if (selectedStopId && !preview.stops.some((stop) => stop.id === selectedStopId)) setSelectedStopId('')
  }, [preview, selectedProject.id, selectedRouteId, selectedStopId, workspacePreviewLoading])

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

  function applyWorkspaceCleanup(cleanedProject: VigoProject) {
    cancelProjectDetail(cleanedProject.id)
    setProjects((current) => current.map((project) => (
      project.id === cleanedProject.id ? cleanedProject : project
    )))
    if (selectedProjectId !== cleanedProject.id) return

    cancelRouteAnalysis()
    invalidateAccessibilityAnalysis()
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
    setRealtimeUrl('')
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

  function closeWorkspace() {
    cancelProjectDetail(selectedProjectId)
    cancelRouteAnalysis()
    clearAnalysisState()
    clearRouting()
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
    beginWorkspaceSelection(projectId)
    setPage('project')
    setActiveRouteTool('explore')
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
    if (routeHasCompleteGtfsAnalysis(route, preview)) return

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
          body: JSON.stringify({ feedId, routeId }),
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

    if (result.kind === 'workspace') {
      openProject(result.id.slice('workspace:'.length))
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

    if (result.id === 'command:workspaces') {
      showProjects()
    } else if (result.id === 'command:pathfinder') {
      setPage('project')
      openPathfinderView()
    } else if (result.id === 'command:accessibility') {
      setPage('project')
      openAccessibilityView()
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
    routingLocationAbortRef.current?.abort()
    routingLocationRequestIdRef.current += 1
    setRoutingLocationResolving(false)
    setRoutingLocationError('')
    setPendingRoutingLocationResolution(null)
    setRoutingOrigin(null)
    setRoutingWaypoints([])
    setRoutingDestination(null)
    setSelectedRoutingPlanId('')
    nationalRouting.reset()
    setRoutingEnabled(false)
  }

  function toggleRouting() {
    setActiveRouteTool('pathfinder')
    setMapScope('route')
    setRoutingEnabled((current) => !current)
  }

  function dismissRoutingLocationChoices() {
    setPendingRoutingLocationResolution(null)
  }

  function invalidateRoutingResults() {
    setSelectedRoutingPlanId('')
    setRoutingLocationError('')
    nationalRouting.reset()
    setRoutingEnabled(false)
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

  function routingPointFromMap(point: RoutingPoint) {
    setActiveRouteTool('pathfinder')
    setMapScope('route')
    const currentPoints = [
      ...(routingOrigin ? [routingOrigin] : []),
      ...routingWaypoints,
      ...(routingDestination ? [routingDestination] : []),
    ]
    if (currentPoints.length >= maxRoutingPointCount) {
      setRoutingEnabled(false)
      return
    }

    const nextPoints = currentPoints.length >= 2
      ? insertRoutingPointBeforeDestination(currentPoints, point)
      : appendRoutingPointSequence(currentPoints, point)
    if (nextPoints.length === 1) {
      nationalRouting.reset()
      setRoutingLocationError('')
      setRoutingOrigin(nextPoints[0])
      setRoutingWaypoints([])
      setRoutingDestination(null)
      setSelectedRoutingPlanId('')
      setRoutingEnabled(true)
      return
    }

    if (!reorderRoutingPoints(nextPoints)) return
    setRoutingEnabled(false)
  }

  function reorderRoutingPoints(points: RoutingPoint[]) {
    if (points.length < 2 || points.length > maxRoutingPointCount) return false
    const orderedPoints = normalizeOrderedRoutingPoints(points)
    const duplicateIndex = orderedPoints.findIndex((point, index) => (
      index > 0
      && point.coordinate[0] === orderedPoints[index - 1].coordinate[0]
      && point.coordinate[1] === orderedPoints[index - 1].coordinate[1]
    ))
    if (duplicateIndex >= 0) {
      setRoutingLocationError(`Stops ${duplicateIndex} and ${duplicateIndex + 1} are the same place. Remove the duplicate before routing.`)
      return false
    }
    routingLocationAbortRef.current?.abort()
    routingLocationAbortRef.current = null
    routingLocationRequestIdRef.current += 1
    setRoutingLocationResolving(false)
    setRoutingLocationError('')
    setPendingRoutingLocationResolution(null)
    setRoutingOrigin(orderedPoints[0])
    setRoutingWaypoints(orderedPoints.slice(1, -1))
    setRoutingDestination(orderedPoints.at(-1) ?? null)
    setSelectedRoutingPlanId('')
    nationalRouting.reset()
    setRoutingEnabled(false)
    setActiveRouteTool('pathfinder')
    setMapScope('route')
    return true
  }

  function analysisPointFromMap(point: RoutingPoint) {
    const mapPoint = point.source === 'map'
      ? buildRoutingPointFromMap(
        point.coordinate,
        `${point.coordinate[1].toFixed(4)}, ${point.coordinate[0].toFixed(4)}`,
      )
      : point
    if (activeRouteTool !== 'accessibility') return
    if (!analysisOrigin) {
      invalidateAccessibilityAnalysis()
      setAnalysisOrigin(mapPoint)
      return
    }
    if (!activeAccessibilityIntervention) return
    const placement = scenarioStopPlacement?.interventionId === activeAccessibilityIntervention.id
      ? scenarioStopPlacement
      : null
    if (!placement) return
    if (
      activeAccessibilityIntervention.stops.length >= 256
      && placement?.mode !== 'replace'
    ) return

    const nextStops = [...activeAccessibilityIntervention.stops]
    if (placement?.mode === 'replace') {
      if (!nextStops[placement.index]) return
      const replacement = scenarioStopFromRoutingPoint(
        activeAccessibilityIntervention.id,
        mapPoint,
        'replaced',
      )
      nextStops[placement.index] = {
        ...replacement,
        id: nextStops[placement.index].id,
        baselineStopId: nextStops[placement.index].baselineStopId
          ?? nextStops[placement.index].stopId,
      }
    } else if (placement?.mode === 'insert') {
      if (placement.index < 1 || placement.index >= nextStops.length) return
      const before = nextStops[placement.index - 1]
      const after = nextStops[placement.index]
      const { beforeStopId, afterStopId } = scenarioInsertionAnchors(before, after)
      nextStops.splice(
        placement.index,
        0,
        {
          ...scenarioStopFromRoutingPoint(activeAccessibilityIntervention.id, mapPoint, 'inserted'),
          anchorBeforeStopId: beforeStopId,
          anchorAfterStopId: afterStopId,
        },
      )
    } else {
      nextStops.push(
        scenarioStopFromRoutingPoint(activeAccessibilityIntervention.id, mapPoint, 'added'),
      )
    }
    updateAccessibilityIntervention(activeAccessibilityIntervention.id, {
      stops: nextStops,
    })
    if (placement) setScenarioStopPlacement(null)
  }

  function moveScenarioStopFromMap(index: number, coordinate: [number, number]) {
    const intervention = activeAccessibilityIntervention
    const stop = intervention?.stops[index]
    if (!intervention || !stop) return
    invalidateAccessibilityAnalysis()
    setAccessibilityCases((current) => current.map((entry) => ({
      ...entry,
      interventions: entry.interventions.map((candidate) => {
        if (candidate.id !== intervention.id) return candidate
        return {
          ...candidate,
          stops: candidate.stops.map((candidateStop, candidateIndex) => {
            if (candidateIndex !== index) return candidateStop
            return {
              ...candidateStop,
              stopId: undefined,
              baselineStopId: candidateStop.baselineStopId ?? candidateStop.stopId,
              coordinate,
              source: 'map',
              editStatus: 'replaced',
            }
          }),
        }
      }),
    })))
  }

  function selectAccessibilityCase(caseId: string) {
    invalidateAccessibilityAnalysis()
    setScenarioStopPlacement(null)
    setActiveAccessibilityCaseId(caseId)
    const selected = accessibilityCases.find((entry) => entry.id === caseId)
    setActiveAccessibilityInterventionId(selected?.interventions[0]?.id ?? '')
  }

  function addAccessibilityCase() {
    if (accessibilityCases.length >= 6) return
    invalidateAccessibilityAnalysis()
    const next = newAccessibilityCase(accessibilityCases.length)
    setScenarioStopPlacement(null)
    setAccessibilityCases((current) => [...current, next])
    setActiveAccessibilityCaseId(next.id)
    setActiveAccessibilityInterventionId('')
  }

  function removeAccessibilityCase(caseId: string) {
    if (accessibilityCases.length <= 1) return
    invalidateAccessibilityAnalysis()
    const next = accessibilityCases.filter((entry) => entry.id !== caseId)
    setScenarioStopPlacement(null)
    setAccessibilityCases(next)
    setActiveAccessibilityCaseId(next[0].id)
    setActiveAccessibilityInterventionId(next[0].interventions[0]?.id ?? '')
  }

  function addAccessibilityIntervention(kind: AccessibilityInterventionKind) {
    if (!activeAccessibilityCase || activeAccessibilityCase.interventions.length >= 8) return
    invalidateAccessibilityAnalysis()
    const intervention = newAccessibilityIntervention(kind)
    setScenarioStopPlacement(null)
    setAccessibilityCases((current) => current.map((entry) => (
      entry.id === activeAccessibilityCase.id
        ? { ...entry, interventions: [...entry.interventions, intervention] }
        : entry
    )))
    setActiveAccessibilityInterventionId(intervention.id)
  }

  function updateAccessibilityIntervention(
    interventionId: string,
    patch: Partial<AccessibilityInterventionDraft>,
  ) {
    invalidateAccessibilityAnalysis()
    setAccessibilityCases((current) => current.map((entry) => ({
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

  function updateAccessibilityInterventionRoute(interventionId: string, routeId: string) {
    const route = preview.routes.find((candidate) => (
      candidate.id === routeId || candidate.patternId === routeId
    ))
    setScenarioStopPlacement(null)
    updateAccessibilityIntervention(interventionId, {
      routeId,
      stops: scenarioStopsForRoute(route, preview),
    })
  }

  async function inferScenarioRoadGeometry(interventionId: string) {
    const intervention = activeAccessibilityCase?.interventions.find((entry) => entry.id === interventionId)
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
      updateAccessibilityIntervention(interventionId, {
        geometryStatus: 'error',
        geometryError: 'Place at least two ordered stops before tracing a road-following path.',
      })
      return
    }
    if (selectedProject.osmStreetIndex?.status !== 'ready') {
      updateAccessibilityIntervention(interventionId, {
        geometryStatus: 'error',
        geometryError: 'Build the local OSM street index before tracing a road-following path.',
      })
      return
    }
    const feedId = activeFeedId === bundleFeedId
      ? route ? entityFeedScope(route.id) || nationalRoutingFeed?.id : nationalRoutingFeed?.id
      : activeFeedId
    if (!feedId) {
      updateAccessibilityIntervention(interventionId, {
        geometryStatus: 'error',
        geometryError: 'Choose a ready GTFS feed before tracing a route.',
      })
      return
    }
    invalidateAccessibilityAnalysis()
    const previous = scenarioRoadGeometryAbortRef.current
    previous?.abort()
    const controller = new AbortController()
    scenarioRoadGeometryAbortRef.current = controller
    const requestId = scenarioRoadGeometryRequestIdRef.current + 1
    scenarioRoadGeometryRequestIdRef.current = requestId
    const fallbackGeometry = routeHasPublishedShape(route) ? route.coordinates : undefined
    const fallbackSegmentRuntimeMinutes = route
      ? scenarioSegmentRuntimeMinutes(route, stops, preview, {
          addedStopDwellMinutes: 0.35,
        })
      : undefined
    const publishedShapeSegmentIndexes = scenarioPublishedShapeSegmentIndexes(route, stops)
    setAccessibilityCases((current) => current.map((entry) => ({
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
      const inferredGeometry = segments.flatMap((segment, index) => {
        const coordinates = Array.isArray(segment.coordinates) ? segment.coordinates : []
        return index === 0 ? coordinates : coordinates.slice(1)
      })
      const hasOsmSegments = segments.some((segment) => segment.source === 'osm_drive')
      const hasShapeSegments = segments.some((segment) => (
        segment.source === 'published_shape' || segment.source === 'published_shape_fallback'
      ))
      const snappedCoordinates = Array.isArray(geometry.snappedCoordinates)
        ? geometry.snappedCoordinates
        : []
      setAccessibilityCases((current) => current.map((entry) => ({
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
      setAccessibilityCases((current) => current.map((entry) => ({
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
    const intervention = activeAccessibilityCase?.interventions.find((entry) => entry.id === interventionId)
    if (!intervention || intervention.stops.length <= 2 || !intervention.stops[index]) return
    setScenarioStopPlacement(null)
    updateAccessibilityIntervention(interventionId, {
      stops: intervention.stops.filter((_, stopIndex) => stopIndex !== index),
    })
  }

  function resetScenarioRouteStops(interventionId: string) {
    const intervention = activeAccessibilityCase?.interventions.find((entry) => entry.id === interventionId)
    if (!intervention?.routeId) return
    const route = preview.routes.find((candidate) => (
      candidate.id === intervention.routeId || candidate.patternId === intervention.routeId
    ))
    setScenarioStopPlacement(null)
    updateAccessibilityIntervention(interventionId, {
      stops: scenarioStopsForRoute(route, preview),
    })
  }

  function removeAccessibilityIntervention(interventionId: string) {
    invalidateAccessibilityAnalysis()
    setScenarioStopPlacement(null)
    const remaining = activeAccessibilityCase?.interventions.filter(
      (entry) => entry.id !== interventionId,
    ) ?? []
    setAccessibilityCases((current) => current.map((entry) => (
      entry.id === activeAccessibilityCase?.id
        ? { ...entry, interventions: remaining }
        : entry
    )))
    setActiveAccessibilityInterventionId(remaining[0]?.id ?? '')
  }

  function accessibilityScenarioDraft() {
    const services: ScenarioServiceDraft[] = []
    const excludedRouteIds: string[] = []
    const excludedPatternIds: Array<{ routeId: string; patternId: string }> = []
    let policy = {
      maxWalkKm: routingMaxWalkKm,
      walkSpeedKph: scenarioWalkSpeedKph,
    }
    const serviceFor = (
      intervention: AccessibilityInterventionDraft,
      route: RouteMetric | undefined,
      stops: ScenarioStopDraft[],
      serviceId: string,
      serviceName: string,
      useInferredGeometry: boolean,
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
      const inferredReady = useInferredGeometry
        && intervention.geometryStatus === 'ready'
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
        bidirectional: intervention.bidirectional,
        headwayMinutes: intervention.headwayMinutes,
        startMinutes: intervention.startMinutes,
        endMinutes: intervention.endMinutes,
        averageSpeedKph: intervention.averageSpeedKph,
        dwellMinutes: 0.35,
        ...(route && (timeModel === 'preserve-scheduled' || timeModel === 'infer-road')
          ? {
              segmentRuntimeMinutes: scenarioSegmentRuntimeMinutes(route, stops, preview, {
                segmentDistancesKm,
                addedStopDwellMinutes: timeModel === 'infer-road' ? 0.35 : 0,
              }),
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
    for (const intervention of activeAccessibilityCase?.interventions ?? []) {
      if (intervention.kind === 'policy') {
        policy = {
          maxWalkKm: intervention.maxWalkKm ?? policy.maxWalkKm,
          walkSpeedKph: intervention.walkSpeedKph ?? policy.walkSpeedKph,
        }
        continue
      }
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
      const stops = ['add-line', 'change-line'].includes(intervention.kind)
        ? intervention.stops
        : scenarioStopsForRoute(route, preview)
      if (['add-line', 'change-line'].includes(intervention.kind) && stops.length < 2) {
        return { error: `${intervention.name} needs at least two ordered GTFS or placed stops.` }
      }
      if (routeScope === 'edge' && intervention.kind === 'change-line') {
        if (!route) return { error: `${intervention.name} needs a selected GTFS branch before applying an exact edge edit.` }
        const edgeRoute = route
        const edgeEdit = scenarioInsertedStopsForEdge(stops)
        if (!edgeEdit) {
          return { error: `${intervention.name} needs one or more inserted stops anchored between an exact ordered A → B GTFS edge.` }
        }
        const matchingBranches = preview.routes
          .filter((candidate) => scopedRouteServiceKey(candidate) === scopedRouteServiceKey(edgeRoute))
          .filter((candidate) => candidate.stopIds.some((stopId, index) => (
            stopId === edgeEdit.beforeStopId && candidate.stopIds[index + 1] === edgeEdit.afterStopId
          )))
        if (!matchingBranches.length) {
          return { error: `No GTFS branch in ${edgeRoute.shortName} serves the exact ordered ${edgeEdit.beforeStopId} → ${edgeEdit.afterStopId} edge.` }
        }
        for (const branch of matchingBranches) {
          let branchStops = branch.id === edgeRoute.id ? stops : scenarioStopsForRoute(branch, preview)
          const branchIndex = branch.stopIds.findIndex((stopId, index) => (
            stopId === edgeEdit.beforeStopId && branch.stopIds[index + 1] === edgeEdit.afterStopId
          ))
          if (branchIndex < 0 || branchStops.length < 2) continue
          if (branch.id !== edgeRoute.id) {
            const clonedStops = edgeEdit.stops.map((stop, index) => ({
              ...stop,
              id: `${intervention.id}:${branch.id}:inserted:${index + 1}`,
              stopId: undefined,
              baselineStopId: undefined,
              anchorBeforeStopId: edgeEdit.beforeStopId,
              anchorAfterStopId: edgeEdit.afterStopId,
              editStatus: 'inserted' as const,
            }))
            branchStops = [
              ...branchStops.slice(0, branchIndex + 1),
              ...clonedStops,
              ...branchStops.slice(branchIndex + 1),
            ]
          }
          services.push(serviceFor(
            intervention,
            branch,
            branchStops,
            `${intervention.id}:${branch.id}`,
            `${intervention.name} · ${branch.directionId || 'branch'} · ${branch.patternRank ?? branch.id}`,
            branch.id === edgeRoute.id,
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
        true,
      ))
    }
    return {
      scenario: {
        id: activeAccessibilityCase?.id ?? 'baseline-only',
        name: activeAccessibilityCase?.name ?? 'Baseline',
        services,
        excludedRouteIds: [...new Set(excludedRouteIds)],
        excludedPatternIds,
        policy,
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
    setScenarioAnalysis(null)
    try {
      const results = await Promise.all(selectedFeeds.map(async (feed, index) => {
        const feedName = quietMapLabel(feed!.name || feed!.fileName || `GTFS ${index + 1}`)
        const result = await apiProgressJson<{ analysis: ScenarioAnalysisResult }>(
          `/api/projects/${encodeURIComponent(selectedProject.id)}/scenario-analysis`,
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
              rasterSize: desktopAccessibilityRasterSize,
              cutoffsMinutes: [...new Set([15, 30, 45, 60, 75, 90, scenarioCutoffMinutes])].sort((left, right) => left - right),
              includePreliminary: false,
              includeStreetEdges,
              scenario: {
                id: `gtfs-comparison-${index + 1}`,
                name: `${feedName} comparison baseline`,
                services: [],
                excludedRouteIds: [],
                policy: {
                  maxWalkKm: routingMaxWalkKm,
                  walkSpeedKph: scenarioWalkSpeedKph,
                },
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
          analysis: result.analysis,
        } satisfies ScenarioComparisonResult
      }))
      setScenarioComparison(results)
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
    const draft = accessibilityScenarioDraft()
    if ('error' in draft) {
      setScenarioError(draft.error ?? 'Configure the active case before running it.')
      return
    }
    analysisAbortRef.current?.abort()
    const controller = new AbortController()
    analysisAbortRef.current = controller
    setScenarioLoading(true)
    setScenarioProgress({ phase: 'preparation', progress: 0, detail: 'Starting network accessibility analysis' })
    setScenarioError('')
    setScenarioComparison(null)
    try {
      const result = await apiProgressJson<{ analysis: ScenarioAnalysisResult }>(
        `/api/projects/${encodeURIComponent(selectedProject.id)}/scenario-analysis`,
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
            rasterSize: desktopAccessibilityRasterSize,
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
        (preliminary) => setScenarioAnalysis(preliminary.analysis),
      )
      setScenarioAnalysis(result.analysis)
      setScenarioView((activeAccessibilityCase?.interventions.length ?? 0) ? 'comparison' : 'baseline')
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

  function commitRoutingLocationResolution(resolution: PendingRoutingLocationResolution) {
    if (resolution.selections.some((candidate) => !candidate)) return false
    const resolvedPoints = resolution.selections.map((candidate) => ({
      coordinate: candidate!.coordinate,
      label: candidate!.name,
      stopId: candidate!.id,
      source: 'search' as const,
    }))
    setScheduleTimeMinutes(resolution.departMinutes)
    setRoutingTimePreference(resolution.mode === 'transit' ? resolution.timePreference : 'depart')
    setRoutingMode(resolution.mode)
    if (resolution.maxWalkKm) setRoutingMaxWalkKm(resolution.maxWalkKm)
    setPendingRoutingLocationResolution(null)
    if (!reorderRoutingPoints(resolvedPoints)) return false
    setQuery('')
    return true
  }

  function chooseRoutingLocation(queryIndex: number, candidate: RoutingLocationCandidate) {
    if (!pendingRoutingLocationResolution) return
    const selections = [...pendingRoutingLocationResolution.selections]
    selections[queryIndex] = candidate
    const nextResolution = { ...pendingRoutingLocationResolution, selections }
    if (selections.every(Boolean)) {
      commitRoutingLocationResolution(nextResolution)
      return
    }
    setPendingRoutingLocationResolution(nextResolution)
  }

  async function runRoutingSearch(commandText: string) {
    const normalizedCommand = commandText.trim()
    if (!normalizedCommand) return false

    const routingCommand = parseRoutingCommand(normalizedCommand)
    if (!routingCommand) {
      setQuery(normalizedCommand)
      return false
    }

    const nextDepartMinutes = routingCommand.departMinutes ?? scheduleTimeMinutes
    const nextTimePreference = routingCommand.timePreference ?? routingTimePreference
    const nextMode = routingCommand.mode ?? routingMode
    setPendingRoutingLocationResolution(null)
    setSelectedRoutingPlanId('')
    nationalRouting.reset()
    setRoutingEnabled(false)
    setRoutingLocationError('')
    if (routingScopeStatus !== 'ready' || !nationalRoutingFeed) {
      setActiveRouteTool('pathfinder')
      return true
    }
    if (nationalRoutingFeed) {
      routingLocationAbortRef.current?.abort()
      const controller = new AbortController()
      routingLocationAbortRef.current = controller
      const requestId = routingLocationRequestIdRef.current + 1
      routingLocationRequestIdRef.current = requestId
      setRoutingLocationResolving(true)
      setRoutingLocationError('')
      try {
        const locationSearch = await apiJson<{ results: RoutingLocationCandidate[][] }>(
          `/api/projects/${encodeURIComponent(selectedProject.id)}/national-search`,
          {
            method: 'POST',
            signal: controller.signal,
            body: JSON.stringify({
              feedId: nationalRoutingFeed.id,
              queries: routingCommand.locationTexts,
              limit: 5,
            }),
          },
        )
        if (requestId !== routingLocationRequestIdRef.current) return true
        const candidates = routingCommand.locationTexts.map((_, index) => locationSearch.results?.[index] ?? [])
        const missingIndex = candidates.findIndex((options) => !options.length)
        if (missingIndex >= 0) {
          setActiveRouteTool('pathfinder')
          setRoutingEnabled(false)
          const role = missingIndex === 0
            ? 'starting point'
            : missingIndex === routingCommand.locationTexts.length - 1
              ? 'destination'
              : `stop ${missingIndex}`
          setRoutingLocationError(`The ${role} “${routingCommand.locationTexts[missingIndex]}” did not match a stop in this workspace.`)
          return true
        }
        const selections = candidates.map((options, index) => {
          const normalizedQuery = routingCommand.locationTexts[index].trim().toLocaleLowerCase()
          const exactMatches = options.filter((candidate) => (
            candidate.name.trim().toLocaleLowerCase() === normalizedQuery
            || candidate.id.trim().toLocaleLowerCase() === normalizedQuery
          ))
          if (exactMatches.length === 1) return exactMatches[0]
          return options.length === 1 ? options[0] : null
        })
        const resolution: PendingRoutingLocationResolution = {
          queries: routingCommand.locationTexts,
          candidates,
          selections,
          departMinutes: nextDepartMinutes,
          timePreference: nextTimePreference,
          mode: nextMode,
          maxWalkKm: routingCommand.maxWalkKm,
        }
        if (selections.some((candidate) => !candidate)) {
          setActiveRouteTool('pathfinder')
          setPendingRoutingLocationResolution(resolution)
          return true
        }
        commitRoutingLocationResolution(resolution)
        return true
      } catch (error) {
        if (controller.signal.aborted || requestId !== routingLocationRequestIdRef.current) return true
        const message = error instanceof Error ? error.message : 'National station search failed'
        setRoutingLocationError(`Stops could not be searched. ${message}`)
        return false
      } finally {
        if (requestId === routingLocationRequestIdRef.current) {
          routingLocationAbortRef.current = null
          setRoutingLocationResolving(false)
        }
      }
    }
    setActiveRouteTool('pathfinder')
    setRoutingEnabled(false)
    setRoutingLocationError('')
    return true
  }

  async function runCommandCenter() {
    const commandText = query.trim()
    if (!commandText) return

    await runRoutingSearch(commandText)
  }

  async function persistRuntimePreferences(next: Partial<Pick<VigoRuntimeConfig, 'appearance' | 'basemap' | 'accent' | 'automaticCacheCleanup'>>) {
    if (!runtimeConfig) return

    try {
      const result = await apiJson<{ config: VigoRuntimeConfig }>('/api/config', {
        method: 'PATCH',
        body: JSON.stringify({
          storageRoot: runtimeConfig.storageRoot,
          appearance: next.appearance ?? appearance,
          accent: next.accent ?? accent,
          basemap: next.basemap ?? basemap,
          automaticCacheCleanup: next.automaticCacheCleanup ?? runtimeConfig.automaticCacheCleanup,
        }),
      })
      setRuntimeConfig(result.config)
      setHealth((current) => current ? { ...current, storageRoot: result.config.storageRoot, config: result.config, offline: result.config.offline } : current)
    } catch (error) {
      setApiError(error instanceof Error ? `Could not save workspace preference: ${error.message}` : 'Could not save workspace preference.')
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

  function changeAutomaticCacheCleanup(enabled: boolean) {
    void persistRuntimePreferences({ automaticCacheCleanup: enabled })
  }

  function showProjects() {
    closeWorkspace()
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
      setProjectDialogError('Workspace name is required.')
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
      setProjectDialogError(`Workspace was not saved: ${message}`)
      setApiError(`Workspace was not saved: ${message}`)
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
      setProjectDialogError(`Workspace rename was not saved: ${message}`)
      setApiError(`Workspace rename was not saved: ${message}`)
    } finally {
      setProjectDialogBusy(false)
    }
  }

  async function deleteProject(projectId: string, options: { confirm?: boolean } = {}): Promise<boolean> {
    const project = projects.find((item) => item.id === projectId)
    if (!project) return false

    if (options.confirm !== false) {
      const confirmation = globalThis.prompt?.(
        `Delete "${project.name}"?\n\nThis removes its isolated workspace folder from Library.\nType the workspace name to confirm.`,
      )?.trim()
      if (confirmation !== project.name) return false
    }

    const applyDeletion = (nextProjects: VigoProject[]) => {
      setProjects(nextProjects)
      const nextSelectedId = preferredProjectId(nextProjects, selectedProjectId === projectId ? '' : selectedProjectId)
      cancelProjectDetail(projectId)
      if (nextSelectedId) beginWorkspaceSelection(nextSelectedId, nextProjects)
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
      setApiError(`Workspace was not deleted: ${message}`)
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
      setImportMessage('Create a project before loading GTFS.')
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

  const refreshRealtimeUrl = useCallback(async (
    url: string,
    options: { background?: boolean; openPanel?: boolean } = {},
  ) => {
    if (realtimeInFlightRef.current) {
      if (!options.background) setRealtimeMessage('Live refresh already running.')
      return
    }

    const requestId = realtimeRequestIdRef.current + 1
    realtimeRequestIdRef.current = requestId
    realtimeInFlightRef.current = true
    if (!options.background) {
      setIsRealtimeLoading(true)
      setRealtimeMessage('Connecting live...')
    }

    try {
      const result = await apiJson<{ snapshot: RealtimeSnapshot }>('/api/realtime/inspect', {
        method: 'POST',
        body: JSON.stringify(realtimeInspectRequest(url)),
      })
      if (requestId !== realtimeRequestIdRef.current) return
      const positions = realtimePositionCount(result.snapshot)
      const refreshTime = new Date(result.snapshot.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      setRealtimeSnapshot(result.snapshot)
      setRealtimeUrl(url)
      const freshness = result.snapshot.freshness
      const freshnessLabel = freshness?.status === 'stale'
        ? ` · stale feed (${Math.round(freshness.ageSeconds ?? 0)}s)`
        : ''
      setRealtimeMessage(`${formatNumber(positions)} live positions / ${formatNumber(result.snapshot.counts.tripUpdates)} trip updates / ${formatNumber(result.snapshot.counts.alerts)} alerts · ${refreshTime}${freshnessLabel}`)
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
      setRealtimeMessage(options.background ? `Live refresh missed; the last live frame remains visible. ${message}` : message)
    } finally {
      if (requestId === realtimeRequestIdRef.current) {
        realtimeInFlightRef.current = false
        if (!options.background) setIsRealtimeLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    if (!realtimeUrl) return
    const interval = window.setInterval(() => {
      void refreshRealtimeUrl(realtimeUrl, { background: true })
    }, realtimeRefreshMs)

    return () => window.clearInterval(interval)
  }, [realtimeUrl, refreshRealtimeUrl])

  function runRealtimeUrl(url: string) {
    try {
      realtimeInspectRequest(url)
    } catch (error) {
      setRealtimeMessage(error instanceof Error ? error.message : 'Enter a valid GTFS-RT URL.')
      return
    }

    void refreshRealtimeUrl(url, { openPanel: true })
  }

  function changeVehicleMode(mode: ServiceVehicleMode) {
    if (mode === 'live' && !realtimeSnapshot) {
      setRealtimeMessage('Connect Vehicle Positions, Trip Updates, and Service Alerts to open the live service frame.')
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
      setSetupError(error instanceof Error ? error.message : 'The project folder is still unavailable.')
    } finally {
      setSetupBusy(false)
    }
  }

  function chooseRecoveryFolder() {
    const openedNative = requestNativeHomeFolder((path) => {
      void recoverStorageRoot(path)
    })
    if (!openedNative) setSetupOpen(true)
  }

  function chooseDataFolder() {
    setSetupError('')
    const openedNative = requestNativeHomeFolder((path) => {
      void recoverStorageRoot(path)
    })
    if (!openedNative) setSetupError('Folder selection is available in the VIGO desktop app.')
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

  function openAccessibilityView() {
    setActiveRouteTool('accessibility')
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
      applyWorkspaceSelection(nextProjectId)
    }
    setPage('project')
    setDataSection('preferences')
    setActiveRouteTool('data')
  }

  useEffect(() => {
    function handleWorkspaceShortcut(event: KeyboardEvent) {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (page !== 'project' && event.code !== 'Digit4') return
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
          action = hasActiveOperationsData ? openAccessibilityView : null
          break
        case 'Digit4':
          action = openSettingsView
          break
        default:
          return
      }
      if (!action) return
      event.preventDefault()
      action()
    }

    window.addEventListener('keydown', handleWorkspaceShortcut)
    return () => window.removeEventListener('keydown', handleWorkspaceShortcut)
  }, [hasActiveOperationsData, page, projects, selectedProjectId])

  const storageRecoveryRequired = Boolean(runtimeConfig && !runtimeConfig.setupRequired && !runtimeConfig.offline.storageWritable)
  const routingDetailOpen = page === 'project'
    && activeRouteTool === 'pathfinder'
    && Boolean(selectedRoutingPlanId)
    && routingPlan?.status === 'ready'

  return (
    <main className={classNames('app-shell', `appearance-${appearance}`, `accent-${accent}`, `page-${page}`, isProjectEmpty && 'project-empty', page === 'project' && activeRouteTool === 'data' && 'view-data', routingDetailOpen && 'routing-detail-open', sidebarCollapsed && 'native-sidebar-collapsed')}>
      <header className="topbar">
        <div className="topbar-brand" aria-label="Workspace header">
          <button type="button" className="topbar-mark-button" onClick={showProjects} title="Open networks" aria-label="Open networks">
            <VigoBrandMark />
          </button>
          <div className="topbar-brand-copy">
            <b>{page === 'projects' ? 'Workspaces' : quietMapLabel(selectedProject.name)}</b>
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
              className="topbar-project-action workspace-exit-action"
              onClick={showProjects}
              title="Back to all networks"
              aria-label="Switch network"
            >
              <ArrowLeft size={14} />
              <span>Networks</span>
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
      {page === 'projects' ? null : activeRouteTool === 'data' ? (
        <aside className="app-sidebar" aria-label="Workspace navigation">
          <WorkspaceRail
            page={page}
            activeRouteTool={activeRouteTool}
            hasActiveData={hasActiveOperationsData}
            onOpenExplore={openRoutesView}
            onOpenRouting={openPathfinderView}
            onOpenAccessibility={openAccessibilityView}
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
        analysisPanel={activeRouteTool === 'accessibility' ? (
          <AccessibilityWorkspacePanel
            mode={accessibilityMode}
            origin={analysisOrigin}
            serviceDate={routingServiceDate}
            departMinutes={scheduleTimeMinutes}
            maxWalkKm={routingMaxWalkKm}
            walkSpeedKph={scenarioWalkSpeedKph}
            cutoffMinutes={scenarioCutoffMinutes}
            renderMode={scenarioRenderMode}
            cases={accessibilityCases}
            feeds={comparisonFeedOptions}
            comparisonFeedIds={comparisonFeedIds}
            activeCaseId={activeAccessibilityCaseId}
            activeInterventionId={activeAccessibilityIntervention?.id ?? ''}
            stopPlacement={activeScenarioStopPlacement}
            routes={preview.routes}
            routeAnalysisLoading={Boolean(routeAnalysisRouteId)}
            routeAnalysisError={routeAnalysisError}
            view={scenarioView}
            loading={scenarioLoading}
            progress={scenarioProgress}
            error={scenarioError}
            analysis={scenarioAnalysis}
            comparison={scenarioComparison}
            serviceDecomposition={serviceDecomposition}
            serviceDecompositionLoading={serviceDecompositionLoading}
            serviceDecompositionError={serviceDecompositionError}
            routingStoreAvailable={storeBackedRouting}
            streetGraphAvailable={selectedProject.osmStreetIndex?.status === 'ready'}
            onServiceDateChange={(value) => {
              changeRoutingServiceDate(value)
              invalidateAccessibilityAnalysis()
            }}
            onDepartMinutesChange={(value) => {
              setScheduleTimeMinutes(value)
              invalidateAccessibilityAnalysis()
            }}
            onMaxWalkKmChange={(value) => {
              changeRoutingMaxWalkKm(value)
              invalidateAccessibilityAnalysis()
            }}
            onWalkSpeedChange={(value) => {
              setScenarioWalkSpeedKph(value)
              invalidateAccessibilityAnalysis()
            }}
            onCutoffChange={(value) => {
              setScenarioCutoffMinutes(value)
              if (value > (scenarioAnalysis?.request.cutoffsMinutes.at(-1) ?? 0)) {
                invalidateAccessibilityAnalysis()
              }
            }}
            onRenderModeChange={(mode) => {
              if (mode === scenarioRenderMode) return
              setScenarioRenderMode(mode)
              if (mode !== 'streets') return
              if (accessibilityMode !== 'single') {
                if (scenarioLoading || scenarioComparison?.some((entry) => !entry.analysis.surface.edges)) {
                  void runFeedComparison(true)
                }
              } else if (scenarioLoading || (scenarioAnalysis && !scenarioAnalysis.surface.edges)) {
                void runSurfaceAnalysis(true)
              }
            }}
            onModeChange={(mode) => {
              invalidateAccessibilityAnalysis()
              setAccessibilityMode(mode)
            }}
            onComparisonFeedChange={(feedId, selected) => {
              invalidateAccessibilityAnalysis()
              setComparisonFeedIds((current) => selected
                ? current.includes(feedId) ? current : [...current, feedId]
                : current.filter((candidate) => candidate !== feedId))
            }}
            onSelectCase={selectAccessibilityCase}
            onAddCase={addAccessibilityCase}
            onRemoveCase={removeAccessibilityCase}
            onAddIntervention={addAccessibilityIntervention}
            onSelectIntervention={(interventionId) => {
              setScenarioStopPlacement(null)
              setActiveAccessibilityInterventionId(interventionId)
            }}
            onUpdateIntervention={updateAccessibilityIntervention}
            onInferInterventionGeometry={(interventionId) => void inferScenarioRoadGeometry(interventionId)}
            onUpdateInterventionRoute={updateAccessibilityInterventionRoute}
            onBeginStopPlacement={beginScenarioStopPlacement}
            onCancelStopPlacement={() => setScenarioStopPlacement(null)}
            onRemoveInterventionStop={removeScenarioStop}
            onResetInterventionStops={resetScenarioRouteStops}
            onRemoveIntervention={removeAccessibilityIntervention}
            onClearInterventionSketch={(interventionId) => {
              setScenarioStopPlacement(null)
              updateAccessibilityIntervention(interventionId, { stops: [] })
            }}
            onViewChange={setScenarioView}
            onClearOrigin={() => {
              invalidateAccessibilityAnalysis()
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
        scheduleServiceDay={scheduleServiceDay}
        routingEnabled={routingEnabled}
        routingOrigin={routingOrigin}
        routingWaypoints={routingWaypoints}
        routingDestination={routingDestination}
        routingPlan={routingPlan}
        routingChoices={routingChoices}
        routingScopeStatus={routingScopeStatus}
        routingStoreReady={routingStoreReady}
        routingStoreFeedCount={routingStoreFeedCount}
        routingStoreReadyFeedCount={routingStoreReadyFeedCount}
        routingStoreStored={routingStoreStored}
        routingStoreStoredFeedCount={routingStoreStoredFeedCount}
        routingStoreTripCount={routingStoreTripCount}
        routingStoreConnectionCount={routingStoreConnectionCount}
        routingTimePreference={routingTimePreference}
        routingMode={routingMode}
        routingDepartureWindowMinutes={routingDepartureWindowMinutes}
        routingMaxWalkKm={routingMaxWalkKm}
        routingAllowLongWalk={routingAllowLongWalk}
        routingActivity={routingActivity}
        routingAlternativesLoading={nationalRouting.alternativesLoading}
        routingServiceDate={routingServiceDate}
        routingServiceCoverage={nationalRouting.serviceCoverage}
        routingServiceDateAvailability={nationalRouting.serviceDateAvailability}
        routingServiceDateOptions={nationalRouting.serviceDateOptions}
        routingResolvingLocations={routingLocationResolving}
        routingLocationError={routingLocationError}
        routingLocationChoices={routingLocationChoices}
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
        onOpenAccessibility={openAccessibilityView}
        onOpenSettings={openSettingsView}
        onOpenLive={() => {
          if (!realtimeSnapshot) {
            setRealtimeMessage('Paste Vehicle Positions, Trip Updates, and Alerts URLs — one per line.')
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
        onScheduleServiceDayChange={setScheduleServiceDay}
        onRunRoutingSearch={runRoutingSearch}
        onReorderRoutingPoints={reorderRoutingPoints}
        onRoutingTimePreferenceChange={changeRoutingTimePreference}
        onRoutingModeChange={changeRoutingMode}
        onRoutingDepartureWindowChange={changeRoutingDepartureWindow}
        onRoutingMaxWalkKmChange={changeRoutingMaxWalkKm}
        onRoutingAllowLongWalkChange={setRoutingAllowLongWalk}
        onRoutingServiceDateChange={changeRoutingServiceDate}
        onSelectRoutingPlan={(id) => {
          setSelectedRoutingPlanId(id)
        }}
        onChooseRoutingLocation={chooseRoutingLocation}
        onDismissRoutingLocationChoices={dismissRoutingLocationChoices}
        onInvalidateRoutingResults={invalidateRoutingResults}
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
          previewLoading={workspacePreviewLoading}
          onOpenProject={openProject}
          onOpenSettings={openSettingsView}
          onCreateProject={openCreateProjectDialog}
          onRenameProject={openRenameProjectDialog}
          onDeleteProject={deleteProject}
          onRefresh={loadProjects}
        />
      ) : activeRouteTool === 'data' ? (
        <DataWorkspace
          section={dataSection}
          projectId={selectedProject.id}
          projectName={quietMapLabel(selectedProject.name)}
          projectRegion={selectedProject.region || 'Local workspace'}
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
          onAutomaticCacheCleanupChange={changeAutomaticCacheCleanup}
          onWorkspaceCleaned={applyWorkspaceCleanup}
          onWorkspaceRemoved={(projectId) => deleteProject(projectId, { confirm: false })}
          feeds={(
            <div className="data-feed-layout">
              <DataReadinessRail project={selectedProject} activeFeed={activeFeed} />
              <ImportPanel
                isImporting={isImporting}
                isOsmImporting={isOsmImporting}
                gtfsJob={gtfsImportJob}
                osmJob={osmImportJob}
                importMessage={importMessage}
                osmStreetReady={selectedProject.osmStreetIndex?.status === 'ready'}
                osmStreetMessage={osmStreetMessage}
                realtimeSnapshot={realtimeSnapshot}
                realtimeMessage={realtimeMessage}
                isRealtimeLoading={isRealtimeLoading}
                onFiles={handleFiles}
                onNationalGtfsPath={handleNationalGtfsPath}
                onNationalOsmPath={handleNationalOsmPath}
                onOsmFiles={handleOsmFiles}
                onRunRealtimeUrl={runRealtimeUrl}
                onExportReproducibility={() => { void exportReproducibilityManifest() }}
                onCancelGtfs={() => { void cancelImportJob('gtfs') }}
                onRetryGtfs={() => { void retryImportJob('gtfs') }}
                onCancelOsm={() => { void cancelImportJob('osm') }}
                onRetryOsm={() => { void retryImportJob('osm') }}
              />
              <BundlePanel
                project={selectedProject}
                activeFeedId={activeFeedId}
                activeFeed={activeFeed}
                onSelectFeed={selectFeed}
              />
              <FeedTableContract activeFeed={activeFeed} />
            </div>
          )}
        />
      ) : (
      !workspaceSourcesReady ? (
        <EmptyOperationsStart
          project={selectedProject}
          gtfsReady={gtfsSourceReady}
          isImporting={isImporting}
          isOsmImporting={isOsmImporting}
          gtfsJob={gtfsImportJob}
          osmJob={osmImportJob}
          importMessage={importMessage}
          osmStreetReady={selectedProject.osmStreetIndex?.status === 'ready'}
          osmStreetMessage={osmStreetMessage}
          realtimeSnapshot={realtimeSnapshot}
          realtimeMessage={realtimeMessage}
          isRealtimeLoading={isRealtimeLoading}
          onFiles={handleFiles}
          onNationalGtfsPath={handleNationalGtfsPath}
          onNationalOsmPath={handleNationalOsmPath}
          onOsmFiles={handleOsmFiles}
          onRunRealtimeUrl={runRealtimeUrl}
          onExportReproducibility={() => { void exportReproducibilityManifest() }}
          onCancelGtfs={() => { void cancelImportJob('gtfs') }}
          onRetryGtfs={() => { void retryImportJob('gtfs') }}
          onCancelOsm={() => { void cancelImportJob('osm') }}
          onRetryOsm={() => { void retryImportJob('osm') }}
        />
      ) : (
      <div className="workbench project-workbench route-investigation-shell">
        <RouteWorkspace
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
          selectedStopId={selectedStop?.id ?? ''}
          realtimeSnapshot={realtimeSnapshot}
          vehicleMode={vehicleMode}
          scheduleTimeMinutes={scheduleTimeMinutes}
          scheduleServiceDay={scheduleServiceDay}
          routingEnabled={routingEnabled}
          routingOrigin={activeRouteTool === 'accessibility' ? analysisOrigin : routingOrigin}
          routingWaypoints={activeRouteTool === 'accessibility' ? [] : routingWaypoints}
          routingDestination={activeRouteTool === 'accessibility' ? null : routingDestination}
          routingPlan={activeRouteTool === 'accessibility' ? null : routingPlan}
          routingFocus={activeRouteTool === 'pathfinder'}
          analysisFocus={activeRouteTool === 'accessibility'}
          scenarioAnalysis={activeRouteTool === 'accessibility' ? scenarioAnalysis : null}
          scenarioComparison={activeRouteTool === 'accessibility' ? scenarioComparison : null}
          serviceDecomposition={activeRouteTool === 'accessibility' ? serviceDecomposition : null}
          scenarioView={scenarioView}
          scenarioRenderMode={scenarioRenderMode}
          scenarioCutoffMinutes={scenarioCutoffMinutes}
          scenarioSketchStops={activeRouteTool === 'accessibility' ? scenarioSketchStops : []}
          scenarioSketchGeometry={activeRouteTool === 'accessibility' ? scenarioSketchGeometry : []}
          scenarioPointPicking={scenarioPointPicking}
          onMoveScenarioStop={activeRouteTool === 'accessibility' ? moveScenarioStopFromMap : undefined}
          routingActivity={routingActivity}
          workspacePreviewLoading={workspacePreviewLoading}
          onMapScopeChange={setMapScope}
          onVehicleModeChange={changeVehicleMode}
          onScheduleTimeChange={setScheduleTimeMinutes}
          onScheduleServiceDayChange={setScheduleServiceDay}
          onRoutingPoint={activeRouteTool === 'accessibility' ? analysisPointFromMap : routingPointFromMap}
          onSelectRoute={selectRoute}
          onSelectStop={selectStop}
        />
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
