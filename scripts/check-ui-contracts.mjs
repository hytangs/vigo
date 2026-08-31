import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const appSource = readFileSync(resolve(root, 'src/App.tsx'), 'utf8')
const domainSource = readFileSync(resolve(root, 'src/domain.ts'), 'utf8')
const mapSource = readFileSync(resolve(root, 'src/VigoMap.tsx'), 'utf8')
const serverSource = readFileSync(resolve(root, 'server/vigo-api.mjs'), 'utf8')
const gtfsWorkerSource = readFileSync(resolve(root, 'server/national-gtfs-worker.mjs'), 'utf8')
const nationalStoreSource = readFileSync(resolve(root, 'server/national-gtfs-store.mjs'), 'utf8')
const scenarioAnalysisServerSource = readFileSync(resolve(root, 'server/scenario-analysis.mjs'), 'utf8')
const nationalRouteWorkerSource = readFileSync(resolve(root, 'server/national-route-worker.mjs'), 'utf8')
const macSource = readFileSync(resolve(root, 'scripts/macos/VigoApp.m'), 'utf8')
const packageSource = readFileSync(resolve(root, 'package.json'), 'utf8')
const macPackageSource = readFileSync(resolve(root, 'scripts/package-macos-app.mjs'), 'utf8')
const indexSource = readFileSync(resolve(root, 'index.html'), 'utf8')
const appCssEntrySource = readFileSync(resolve(root, 'src/App.css'), 'utf8')
const routeMapDefaultsSource = appSource.slice(
  appSource.indexOf('function applyRouteMapDefaults()'),
  appSource.indexOf('function applyNetworkMapDefaults()'),
)
const networkMapDefaultsSource = appSource.slice(
  appSource.indexOf('function applyNetworkMapDefaults()'),
  appSource.indexOf('function returnToNetworkOverview()'),
)
const appCssImports = [...appCssEntrySource.matchAll(/@import\s+["']([^"']+)["'];/g)].map((match) => match[1])

function readOptionalSource(path) {
  const absolutePath = resolve(root, path)
  return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : ''
}

const projectStateSource = readOptionalSource('src/app/projectState.ts')
const projectHydrationSource = readOptionalSource('src/app/projectHydration.ts')
const statusSource = readOptionalSource('src/app/status.ts')
const presentationSource = readOptionalSource('src/app/presentation.ts')
const routingContractsSource = readOptionalSource('src/app/routingContracts.ts')
const runtimeConfigSource = readOptionalSource('src/app/runtimeConfig.ts')
const nativeBridgeSource = readOptionalSource('src/app/nativeBridge.ts')
const uiPrimitivesSource = readOptionalSource('src/components/UiPrimitives.tsx')
const projectDialogsSource = readOptionalSource('src/components/ProjectDialogs.tsx')
const pathfinderSource = readOptionalSource('src/components/PathfinderPanel.tsx')
const lazyMapSource = readOptionalSource('src/components/LazyVigoMap.tsx')
const searchPaletteSource = readOptionalSource('src/features/search/SearchPalette.tsx')
const searchModelSource = readOptionalSource('src/features/search/searchModel.ts')
const dataWorkspaceSource = readOptionalSource('src/components/DataWorkspace.tsx')
const workspaceCleanupSource = readOptionalSource('src/components/WorkspaceCleanupControl.tsx')
const cacheMaintenanceSource = readOptionalSource('src/components/CacheMaintenanceControl.tsx')
const workspacePreviewSource = readOptionalSource('src/app/workspacePreview.ts')
const scheduledVehicleSource = readOptionalSource('src/scheduledVehicles.ts')
const serviceVehicleSource = readOptionalSource('src/serviceVehicles.ts')
const gtfsAnalysisSource = readOptionalSource('src/app/gtfsAnalysis.ts')
const nationalRoutingSource = readOptionalSource('src/app/useNationalRouting.ts')
const routingUiSource = readOptionalSource('src/routingUi.ts')
const routingPointSequenceSource = readOptionalSource('src/routingPointSequence.ts')
const orderedRouteSource = readOptionalSource('server/ordered-route-composition.mjs')
const accessibilityWorkspaceSource = readOptionalSource('src/components/AccessibilityWorkspacePanel.tsx')
const exploreObjectSource = readOptionalSource('src/components/ExploreObjectPanel.tsx')
const serviceStateControlSource = readOptionalSource('src/components/ServiceStateControl.tsx')
const apiClientSource = readOptionalSource('src/app/api.ts')
const macIconSource = readOptionalSource('scripts/check-macos-icons.mjs')
const uiSource = [
    appSource,
    projectStateSource,
    projectHydrationSource,
  presentationSource,
  routingContractsSource,
  runtimeConfigSource,
  nativeBridgeSource,
  uiPrimitivesSource,
  projectDialogsSource,
  pathfinderSource,
  searchPaletteSource,
  searchModelSource,
  dataWorkspaceSource,
  workspaceCleanupSource,
  cacheMaintenanceSource,
  nationalRoutingSource,
  exploreObjectSource,
  serviceStateControlSource,
].join('\n')

function readCssWithImports(entryPath, seen = new Set()) {
  const absolutePath = resolve(root, entryPath)
  if (seen.has(absolutePath)) return ''
  seen.add(absolutePath)

  const source = readFileSync(absolutePath, 'utf8')
  const baseDir = dirname(absolutePath)
  const imports = [...source.matchAll(/@import\s+["']([^"']+)["'];/g)]
  if (!imports.length) return source

  return imports.map((match) => {
    const imported = resolve(baseDir, match[1])
    return readCssWithImports(imported, seen)
  }).join('\n')
}

const appCss = readCssWithImports('src/App.css')

const contracts = [
  {
    name: 'CSS entrypoint has bounded responsibility-based ownership',
    pass: JSON.stringify(appCssImports) === JSON.stringify([
      './styles/foundation.css',
      './styles/shell.css',
      './styles/network.css',
      './styles/responsive.css',
      './styles/components.css',
      './styles/workspaces.css',
      './styles/theme.css',
      './features/search/search.css',
    ]) &&
      !appCssEntrySource.includes('-refresh.css') &&
      !appCssEntrySource.includes('product-quality.css') &&
      !appCssEntrySource.includes('vigo-future.css'),
  },
  {
    name: 'app shell contains no seeded demo network or demo-feed compatibility wrapper',
    pass: !domainSource.includes('demoFeedSummary') &&
      !domainSource.includes('legacyDemo') &&
      !domainSource.includes("geometrySource: 'demo'") &&
      !appSource.includes('resolvedFeed(') &&
      !appSource.includes('isDemoFeed('),
  },
  {
    name: 'GTFS re-import offers explicit replacement instead of silently accumulating duplicate schedules',
    pass: appSource.includes('function replaceExistingSchedule(') &&
      appSource.includes("parameters.set('replaceProjectSchedule', 'true')") &&
      appSource.includes('body: JSON.stringify({') &&
      appSource.includes('preloadServiceDate: routingServiceDate') &&
      serverSource.includes("url.searchParams.get('replaceProjectSchedule') === 'true'") &&
      serverSource.includes('replaceProjectSchedule: true'),
  },
  {
    name: 'GUI ownership is split into focused modules without duplicate declarations',
    pass: projectStateSource.includes('export function mergeProjectDetail') &&
      uiPrimitivesSource.includes('export function IconButton') &&
      projectDialogsSource.includes('export function ProjectEditorDialog') &&
      projectDialogsSource.includes('export function FirstRunSetupDialog') &&
      pathfinderSource.includes('export function SidebarPathfinderBox') &&
      appSource.includes("from './app/projectState'") &&
      appSource.includes("from './components/UiPrimitives'") &&
      appSource.includes("from './components/ProjectDialogs'") &&
      appSource.includes("from './components/PathfinderPanel'") &&
      appSource.includes("from './components/ExploreObjectPanel'") &&
      appSource.includes("from './components/ServiceStateControl'") &&
      appSource.includes("from './serviceVehicles'") &&
      serviceStateControlSource.includes('export function ServiceStateControl') &&
      serviceVehicleSource.includes('export function buildServiceVehicleFrame') &&
      !appSource.includes("from './components/TransitWorkbenchPanels'") &&
      !appSource.includes("from './app/transitWorkbench'") &&
      !appSource.includes('function mergeProjectDetail') &&
      !appSource.includes('function IconButton') &&
      !appSource.includes('function ProjectEditorDialog') &&
      !appSource.includes('function FirstRunSetupDialog') &&
      !appSource.includes('function SidebarPathfinderBox') &&
      appSource.split('\n').length < 6000,
  },
  {
    name: 'workspace state and route/accessibility results use shared presentation primitives',
    pass: statusSource.includes('export type WorkspaceStatus') &&
      statusSource.includes('normalizeWorkspaceStatus') &&
      uiPrimitivesSource.includes('export function StatusBadge') &&
      uiPrimitivesSource.includes('export function ResultMetric') &&
      appSource.includes("from './app/status'") &&
      appSource.includes('<StatusBadge') &&
      pathfinderSource.includes('<ResultMetric') &&
      pathfinderSource.includes('<StatusBadge status="ready"') &&
      accessibilityWorkspaceSource.includes('<ResultMetric') &&
      !appSource.includes('function StatusBadge') &&
      !appSource.includes('function ResultMetric'),
  },
  {
    name: 'desktop chrome uses a compact mark-only VIGO identity with a dark-mode asset',
    pass: uiPrimitivesSource.includes('export function VigoBrandMark()') &&
      uiPrimitivesSource.includes('src="/vigo-mark-transparent.png"') &&
      uiPrimitivesSource.includes('src="/vigo-mark-dark.png"') &&
      appSource.includes('<VigoBrandMark />') &&
      appSource.includes('aria-label="Open networks"') &&
      !appSource.includes('<VigoLockup />') &&
      !uiPrimitivesSource.includes('vigo-lockup') &&
      !appSource.includes('className="vigo-wordmark"') &&
      existsSync(resolve(root, 'public/vigo-mark.png')) &&
      existsSync(resolve(root, 'public/vigo-mark-transparent.png')) &&
      existsSync(resolve(root, 'public/vigo-mark-dark.png')) &&
      existsSync(resolve(root, 'public/github-social-preview.png')),
  },
  {
    name: 'desktop and browser icons derive from the supplied navy-and-lime VIGO mark',
    pass: macIconSource.includes("'public/vigo-mark-transparent.png'") &&
      macIconSource.includes("'scripts/macos/VIGO.icns'") &&
      macIconSource.includes("'public/github-social-preview.png'") &&
      indexSource.includes('href="/favicon.png"') &&
      existsSync(resolve(root, 'public/vigo-mark-transparent.png')) &&
      existsSync(resolve(root, 'public/favicon.png')) &&
      existsSync(resolve(root, 'scripts/macos/VIGO.icns')),
  },
  {
    name: 'project detail hydration preserves the complete workspace catalog',
    pass: uiSource.includes('function mergeProjectDetail') &&
      projectHydrationSource.includes('setProjects((current) => {') &&
      projectHydrationSource.includes('const next = mergeProjectDetail(current, result.project)') &&
      appSource.includes('beginWorkspaceSelection(nextSelectedId, nextProjects)'),
  },
  {
    name: 'map A and B input remains interactive while routing data prepares',
    pass: uiSource.includes('const routingInputReady =') &&
      uiSource.includes('routingEnabled={routingEnabled}') &&
      uiSource.includes('analysisPointFromMap : routingPointFromMap') &&
      !uiSource.includes('routingEnabled={routingEnabled && routingInputReady}') &&
      !uiSource.includes('onRoutingPoint={routingInputReady ? routingPointFromMap : undefined}') &&
      uiSource.includes('Opening SQLite timetable') &&
      uiSource.includes('Preparing street snapshot') &&
      uiSource.includes('/national-ready') &&
      nationalRoutingSource.includes('readyKey === readinessKey') &&
      nationalRoutingSource.includes('JSON.stringify({ feedId, serviceDate, serviceDay, allowServiceDateFallback: false })'),
  },
  {
    name: 'national route requests clear stale results and expose loading or API failure',
    pass: nationalRoutingSource.includes('setChoices([])') &&
      nationalRoutingSource.includes('setLoading(true)') &&
      nationalRoutingSource.includes('setLoading(false)') &&
      nationalRoutingSource.includes('setError(') &&
      uiSource.includes('Finding exact journey') &&
      uiSource.includes('Routing request failed'),
  },
  {
    name: 'multi-feed routing publishes one combined project store while preserving feed sources',
    pass: serverSource.includes('mergeNationalGtfsStores') &&
      serverSource.includes('startNationalGtfsMerge') &&
      serverSource.includes("action === 'national-routing-merge'") &&
      gtfsWorkerSource.includes("removeSourcesAfterMerge: false") &&
      serverSource.includes('sourceStores') &&
      appSource.includes('/national-routing-merge') &&
      appSource.includes('const readyBundleFeedCount =') &&
      appSource.includes('const routingScopeStatus: RoutingScopeStatus =') &&
      appSource.includes("if (routingScopeStatus !== 'ready' || !nationalRoutingFeed)") &&
      pathfinderSource.includes('buildingCombinedSchedule') &&
      pathfinderSource.includes('Combining timetable feeds') &&
      pathfinderSource.includes("const missingExactSchedule = routingScopeStatus === 'missing'") &&
      pathfinderSource.includes('No routing timetable ready') &&
      pathfinderSource.indexOf(") : routingActivity.kind === 'error' ?") < pathfinderSource.indexOf(') : showServiceDateCorrection ?') &&
      !pathfinderSource.includes('Routing data unavailable') &&
      !pathfinderSource.includes('pathfinder-routing-feed'),
  },
  {
    name: 'desktop routing keeps one visible exact service date and never falls back silently',
    pass: routingContractsSource.includes('export function localCalendarDate') &&
      routingContractsSource.includes('export function serviceDayForCalendarDate') &&
      appSource.includes('useState(() => localCalendarDate())') &&
      uiSource.includes('serviceDay: routingServiceDay') &&
      uiSource.includes('serviceDate: routingServiceDate') &&
      nationalRoutingSource.includes('allowServiceDateFallback: false') &&
      nationalRoutingSource.includes('routingServiceDateOptions(serviceCoverage, serviceDate, serviceDateSuggestions)') &&
      nationalRoutingSource.includes('serviceDateOptions?: RoutingServiceDateSuggestion[]') &&
      !nationalRoutingSource.includes('allowServiceDateFallback: true') &&
      pathfinderSource.includes('routingServiceDateOptions.map') &&
      pathfinderSource.includes('onRoutingServiceDateChange(option.date)') &&
      appSource.includes('routingDateAutoAlignedStoreRef') &&
      appSource.includes('latestCoverageDateMatchingWeekday(latestCompleteDate, routingServiceDate)') &&
      pathfinderSource.includes('Date outside timetable') &&
      pathfinderSource.includes('Timetable incomplete for this date') &&
      pathfinderSource.includes('aria-label="Routing service date"') &&
      serverSource.includes("schemaVersion: 'vigo.routing.service-coverage.v1'") &&
      !uiSource.includes("serviceDate: new Date().toISOString().slice(0, 10)"),
  },
  {
    name: 'received transit plans require a scheduled ride before the UI marks them ready',
    pass: routingContractsSource.includes('export function normalizeReceivedRoutingPlan') &&
      routingContractsSource.includes("leg.type === 'ride'") &&
      routingContractsSource.includes("title: 'No scheduled ride'") &&
      routingContractsSource.includes("status: 'blocked'") &&
      uiSource.includes('normalizeReceivedRoutingPlan(plan)') &&
      uiSource.includes('choices.map(normalizeReceivedRoutingPlan)'),
  },
  {
    name: 'initial walking is presented just in time without changing the selected transit legs',
    pass: routingContractsSource.includes('function deferInitialWalk') &&
      routingContractsSource.includes("strategy: 'just-in-time-initial-walk'") &&
      routingContractsSource.includes('waitMinutes: itineraryWaitMinutes') &&
      routingContractsSource.includes('export function routingPlanJourneyMinutes') &&
      routingContractsSource.includes('export function routingPlanTotalWaitMinutes') &&
      pathfinderSource.includes('leave at {formatScheduleClock(plan.departMinutes)}') &&
      pathfinderSource.includes('Time from leaving to arriving') &&
      pathfinderSource.includes('Alternative route') &&
      !pathfinderSource.includes('wait from {formatScheduleClock'),
  },
  {
    name: 'fallback service dates stay visible instead of being relabeled exact',
    pass: routingContractsSource.includes('export function routingPlanServiceDateDetail') &&
      routingContractsSource.includes('requestedServiceDate') &&
      routingContractsSource.includes('resolvedServiceDate') &&
      routingContractsSource.includes('serviceDateFallbackApplied') &&
      routingContractsSource.includes('fallback from') &&
      pathfinderSource.includes('value={routingServiceDate}') &&
      !nationalRoutingSource.includes('onServiceDateChange(resolvedServiceDate)') &&
      !uiSource.includes('`${routingServiceDate} exact timetable`'),
  },
  {
    name: 'pathfinder exposes only the three canonical local routing modes',
    pass: pathfinderSource.includes("['transit', 'Transit']") &&
      pathfinderSource.includes("['walk', 'Walk']") &&
      pathfinderSource.includes("['drive', 'Drive']") &&
      uiSource.includes('onRoutingModeChange') &&
      !uiSource.includes('Transit routing only') &&
      routingContractsSource.includes("routingPlan.travelMode === 'transit'") &&
      routingContractsSource.includes("plan.travelMode !== 'transit'"),
  },
  {
    name: 'same-station transfers distinguish interchange, vehicle change, and platform change',
    pass: presentationSource.includes('function isSameStationTransfer') &&
      presentationSource.includes('Change to another') &&
      presentationSource.includes('Change at') &&
      presentationSource.includes('Platform change at') &&
      presentationSource.includes('station connection') &&
      !presentationSource.includes("plan.travelMode === 'transit' ? 'Walk access'"),
  },
  {
    name: 'workspace atlas renders every public service with original published geometry',
    pass: projectStateSource.includes('const mostRecentOperationalProject = projects.find(hasOperationsData)') &&
      appSource.includes('buildWorkspacePreviewLod(') &&
      !workspacePreviewSource.includes('maxPublicRoutes') &&
      !workspacePreviewSource.includes('.slice(0, limits.maxPublicRoutes)') &&
      workspacePreviewSource.includes('maxStops: 16_000') &&
      workspacePreviewSource.includes('const routes = preview.routes') &&
      !workspacePreviewSource.includes('thinWorkspaceRoute') &&
      workspacePreviewSource.includes('stopPairs: []') &&
      appSource.includes('workspace-loading-overlay'),
  },
  {
    name: 'focused route inspection hydrates complete SQLite analysis without placeholder failure labels',
    pass: serverSource.includes("action === 'gtfs-route-analysis'") &&
      gtfsAnalysisSource.includes('export function mergeGtfsRouteAnalysis') &&
      appSource.includes('/gtfs-route-analysis') &&
      exploreObjectSource.includes('Reading trip patterns, stops, span, and headway from local SQLite.') &&
      exploreObjectSource.includes('Calculation lineage') &&
      !appSource.includes('Unavailable') &&
      !mapSource.includes('No GTFS geometry indexed'),
  },
  {
    name: 'startup overlaps health and project discovery while the server scans workspaces concurrently',
    pass: /await Promise\.all\(\[\s*apiJson<HealthResponse>\('\/api\/health'\),\s*apiJson<\{ projects: VigoProject\[\] \}>\('\/api\/projects'\),\s*\]\)/.test(appSource) &&
      serverSource.includes('const projectReads = entries') &&
      serverSource.includes('await Promise.all(projectReads)') &&
      serverSource.includes('.filter(Boolean)'),
  },
  {
    name: 'primary navigation avoids duplicate sidebar and validation chrome',
    pass: !appSource.includes('sidebar-panel-icon') &&
      !appSource.includes('topbar-evidence-summary') &&
      !appCss.includes('.sidebar-panel-icon') &&
      !appCss.includes('.topbar-evidence-summary'),
  },
  {
    name: 'network objects use contextual progressive disclosure in the left master-detail panel',
    pass: appSource.includes('objectPanel={(') &&
      appSource.includes('<ExploreObjectPanel') &&
      exploreObjectSource.includes('<TemporalServiceCanvas') &&
      exploreObjectSource.includes('Full service') &&
      exploreObjectSource.includes('Patterns') &&
      exploreObjectSource.includes('The map draws every pattern separately and never joins pattern endpoints.') &&
      exploreObjectSource.includes('<summary>Calculation lineage') &&
      appCss.includes('.route-browser-section.has-object-detail') &&
      !appSource.includes("inspectorOpen && 'inspector-visible'") &&
      !appSource.includes('<VigoInspectorPanel'),
  },
  {
    name: 'map playback responds to map width and Pathfinder avoids nested card chrome',
    pass: appCss.includes('container: route-map / inline-size') &&
      appCss.includes('@container route-map (max-width: 760px)') &&
      /\.pathfinder-composer,[\s\S]*?\.pathfinder-options\s*\{[\s\S]*?border-radius:\s*0;[\s\S]*?box-shadow:\s*none;/m.test(appCss) &&
      !appCss.includes('.inspector-decision') &&
      !appCss.includes('.inspector-intelligence') &&
      !appCss.includes('.inspector-signal-grid'),
  },
  {
    name: 'workspace selection clears stale map content while project detail hydrates',
    pass: uiSource.includes('workspacePreviewLoadingProjectId') &&
      appSource.includes('previewLoading={workspacePreviewLoading}') &&
      appSource.includes('previewLoading ? (') &&
      appSource.includes('Opening workspace') &&
      projectHydrationSource.includes('setWorkspacePreviewLoadingProjectId(projectId)'),
  },
  {
    name: 'workspace detail hydration deduplicates requests and rejects stale responses',
    pass: projectHydrationSource.includes('function ensureProjectDetail(') &&
      projectHydrationSource.includes('new Map<string, ProjectDetailRequest>()') &&
      projectHydrationSource.includes('new AbortController()') &&
      projectHydrationSource.includes('controller.signal.aborted') &&
      projectHydrationSource.includes('workspaceSelectionVersionRef') &&
      projectHydrationSource.includes('activeWorkspaceProjectIdRef') &&
      projectHydrationSource.includes('pending.promise'),
  },
  {
    name: 'workspace switches clear cross-project routing state before hydration',
    pass: /function applyWorkspaceSelection\([\s\S]*?clearRouting\(\)[\s\S]*?setSelectedProjectId\(projectId\)/.test(appSource) &&
      projectHydrationSource.includes('callbacksRef.current.onSelectProject(projectId)'),
  },
  {
    name: 'national route requests abort backend work when inputs or projects change',
    pass: /national-route[\s\S]*?signal:\s*controller\.signal/.test(nationalRoutingSource) &&
      nationalRoutingSource.includes('routeRequestGate.current.cancel(requestToken)') &&
      nationalRoutingSource.includes('routeRequestGate.current.cancel()'),
  },
  {
    name: 'national routing atomically commits exact and later-departure choices',
    pass: appSource.includes('useState<RoutingDepartureWindowMinutes>(20)') &&
      appSource.includes('useNationalRouting({') &&
      nationalRoutingSource.includes('const routeRequestGate = useRef(new LatestRequestGate())') &&
      nationalRoutingSource.includes('routeRequestGate.current.owns(requestToken)') &&
      nationalRoutingSource.includes('setChoices(normalizeChoices(response))') &&
      nationalRoutingSource.includes("departureWindowDirection: !streetMode && departureWindowMinutes > 0 ? 'forward' : undefined") &&
      !nationalRoutingSource.includes('alternativeMaxWalkKm') &&
      !nationalRoutingSource.includes('requestRoutes(0)') &&
      !nationalRoutingSource.includes('yieldToBrowserPaint') &&
      !nationalRoutingSource.includes('window.setTimeout') &&
      nationalStoreSource.includes('departureWindowMinutes: 0') &&
      pathfinderSource.includes('Checking later departures…') &&
      pathfinderSource.includes('Later departures') &&
      pathfinderSource.includes('Exact time'),
  },
  {
    name: 'operational sidebar and route browser stay inside their grid track and use full height',
    pass: /\.page-project \.sidebar-panel\s*{[^}]*width:\s*auto/s.test(appCss) &&
      /\.sidebar-panel\.is-explore\s*{[^}]*overflow:\s*hidden/s.test(appCss) &&
      /\.sidebar-panel\.is-explore\s*{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\)/s.test(appCss) &&
      /\.route-browser-list\.is-virtual\s*{[^}]*height:\s*100%[^}]*max-height:\s*none/s.test(appCss) &&
      appSource.includes('const observer = new ResizeObserver(syncViewport)') &&
      appSource.includes('viewport.scrollTop = nextScrollTop') &&
      !appSource.includes("viewport.scrollTo({ top: nextScrollTop, behavior: 'smooth' })"),
  },
  {
    name: 'vehicle selection explains destination, next stop, and arrival timing without overlapping map scope controls',
    pass: scheduledVehicleSource.includes('nextStopArrivalMinutes?: number') &&
      scheduledVehicleSource.includes('destinationStopId?: string') &&
      serviceVehicleSource.includes("arrivalLabel: 'Scheduled arrival'") &&
      serviceVehicleSource.includes("arrivalLabel: realtimeArrivalTimestamp || delaySeconds !== undefined ? 'Expected arrival' : 'Scheduled arrival'") &&
      mapSource.includes('className="map-vehicle-journey"') &&
      mapSource.includes("setLiveSelection({ tone: 'vehicle', ...vehicle.card })") &&
      mapSource.includes("layers: ['vigo-vehicles']") &&
      mapSource.includes('Math.hypot(point.x - event.point.x, point.y - event.point.y)') &&
      /\.route-map-shell \.map-live-card\s*{[^}]*top:\s*72px/s.test(appCss),
  },
  {
    name: 'GTFS-Realtime remains visible in focused maps and a canonical MBTA feed loads the standard set',
    pass: appSource.includes("const [vehicleMode, setVehicleMode] = useState<ServiceVehicleMode>('schedule')") &&
      appSource.includes("if (!options.background) setVehicleMode('live')") &&
      appSource.includes("mode: vehicleMode") &&
      !domainSource.includes("| 'realtime'") &&
      !mapSource.includes('layers.realtime') &&
      appSource.includes('body: JSON.stringify(realtimeInspectRequest(url))') &&
      appSource.includes('A VehiclePositions.pb URL is required for live map locations.') &&
      serverSource.includes('function mbtaStandardRealtimeUrls(sourceUrl)') &&
      serverSource.includes("new URL('/realtime/VehiclePositions.pb', parsedUrl.origin)") &&
      serverSource.includes("new URL('/realtime/TripUpdates.pb', parsedUrl.origin)") &&
      serverSource.includes("new URL('/realtime/Alerts.pb', parsedUrl.origin)") &&
      serverSource.includes('viewerRealtimeUrls(sourceUrl) ?? mbtaStandardRealtimeUrls(sourceUrl) ?? { feed: sourceUrl }'),
  },
  {
    name: 'compact live control clips its label inside the settings sidebar',
    pass: appSource.includes("className={classNames('sidebox-live'") &&
      appCss.includes('.sidebox-live {') &&
      appCss.includes('width: 100%;') &&
      appCss.includes('.sidebox-live span {') &&
      appCss.includes('text-overflow: ellipsis;') &&
      appCss.includes('white-space: nowrap;'),
  },
  {
    name: 'GTFS-RT connect action keeps its icon and label on one compact row',
    pass: /\.url-import\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;[^}]*align-items:\s*center;/s.test(appCss) &&
      /\.url-import button\s*\{[^}]*min-width:\s*max-content;[^}]*height:\s*32px;[^}]*display:\s*inline-flex;[^}]*white-space:\s*nowrap;/s.test(appCss),
  },
  {
    name: 'workspace atlas fits available stops when route geometry is deferred',
    pass: mapSource.includes('function mapContentBounds(') &&
      mapSource.includes('mapContentBounds(routesGeoJson, stopsGeoJson)') &&
      !mapSource.includes('center: [-149.89, 61.2]'),
  },
  {
    name: 'national atlas exposes a low-zoom stop overview and renderability-aware empty state',
    pass: mapSource.includes("id: 'vigo-overview-stops'") &&
      mapSource.includes("const hasDrawableNetwork = routesGeoJson.features.length > 0 || stopsGeoJson.features.length > 0") &&
      mapSource.includes("const mapVisualState = routesGeoJson.features.length > 0 ? 'network' : stopsGeoJson.features.length > 0 ? 'stops-only' : 'empty'") &&
      mapSource.includes('data-map-state={mapVisualState}') &&
      mapSource.includes('!hasDrawableNetwork ? (') &&
      uiSource.includes("setLayers((current) => ({\n      ...current,\n      routes: true,\n      segments: false,\n      stops: true,"),
  },
  {
    name: 'workspace summaries retain exact project and feed trip totals',
    pass: uiSource.includes('tripCount: feeds.reduce((sum, feed) => sum + feed.tripCount, 0)') &&
      appSource.includes('<span>{formatNumber(feed.tripCount)}</span>'),
  },
  {
    name: 'map canvas does not duplicate project summaries in a legacy HUD',
    pass: !mapSource.includes('className="map-hud"') &&
      !mapSource.includes('totalTrips?: number') &&
      !appSource.includes('totalTrips='),
  },
  {
    name: 'lazy map presents an accessible local-atlas loading state',
    pass: lazyMapSource.includes('aria-live="polite"') &&
      lazyMapSource.includes('Opening network') &&
      lazyMapSource.includes('Preparing the local atlas') &&
      appCss.includes('.map-loading-status'),
  },
  {
    name: 'database walk legs distinguish OSM paths and station transfers',
    pass: uiSource.includes("leg.walkSource === 'transfer' ? 'station transfer'") &&
      nationalStoreSource.includes("walkSource: 'transfer'") &&
      nationalStoreSource.includes('streetPathBetween'),
  },
  {
    name: 'street-walk cards use rider language instead of backend jargon',
    pass: presentationSource.includes("leg.walkSource === 'osm' ? 'Walk'") &&
      presentationSource.includes("leg.walkSource === 'transfer' ? 'station transfer' : 'OSM street route'") &&
      !presentationSource.includes('straight-line estimate') &&
      presentationSource.includes('scheduled stop') &&
      !presentationSource.includes('tripText') &&
      !presentationSource.includes('Walk via OSM'),
  },
  {
    name: 'desktop native bridge selects national GTFS and OSM files by path',
    pass: macSource.includes('chooseGtfsFile') &&
      macSource.includes('chooseOsmFile') &&
      macSource.includes("'vigo-native-file'") &&
      uiSource.includes('requestNativeGtfsFile') &&
      uiSource.includes('requestNativeOsmFile'),
  },
  {
    name: 'desktop shell keeps native traffic lights without navigation toolbar chrome',
    pass: macSource.includes('<NSApplicationDelegate, WKNavigationDelegate,') &&
      macSource.includes('self.window.titleVisibility = NSWindowTitleHidden') &&
      macSource.includes('self.window.titlebarAppearsTransparent = NO') &&
      macSource.includes('NSApp.appearance = nativeAppearance') &&
      macSource.includes('NSWindowMiniaturizeButton') &&
      macSource.includes('[action isEqualToString:@"setChromeState"]') &&
      macSource.includes("window.dispatchEvent(new CustomEvent('vigo-native-command'") &&
      !macSource.includes('NSToolbar') &&
      !macSource.includes('VigoToolbarSidebarItemIdentifier') &&
      !macSource.includes('VigoToolbarBackItemIdentifier') &&
      !macSource.includes('VigoToolbarForwardItemIdentifier') &&
      !macSource.includes('[NSApp setAppearance:[NSAppearance appearanceNamed:NSAppearanceNameDarkAqua]]') &&
      nativeBridgeSource.includes('syncNativeChromeState') &&
      nativeBridgeSource.includes('subscribeNativeCommands') &&
      appSource.includes("sidebarCollapsed && 'native-sidebar-collapsed'") &&
      appCss.includes('[data-vigo-native="macos"] .topbar-mark-button'),
  },
  {
    name: 'top bar omits redundant local runtime version chrome',
    pass: !appSource.includes('topbar-local') &&
      !appSource.includes("`local · ${health?.version ?? 'dev'}`") &&
      !appCss.includes('.topbar-local'),
  },
  {
    name: 'desktop shell confines navigation and privileged bridge messages to its runtime origin',
    pass: macSource.includes('@property(nonatomic, strong) NSURL *runtimeOriginURL;') &&
      macSource.includes('- (BOOL)isRuntimeURL:(NSURL *)url') &&
      macSource.includes('- (BOOL)isRuntimeScriptMessage:(WKScriptMessage *)message') &&
      macSource.includes('message.frameInfo.isMainFrame') &&
      macSource.includes('message.frameInfo.securityOrigin') &&
      macSource.includes('[NSWorkspace.sharedWorkspace openURL:url]') &&
      macSource.includes('decisionHandler(WKNavigationActionPolicyCancel)'),
  },
  {
    name: 'desktop native panels complete cancelled requests without retaining stale listeners',
    pass: macSource.includes('cancelled:(BOOL)cancelled') &&
      macSource.includes('cancelled:!selected') &&
      nativeBridgeSource.includes('cancelled?: boolean') &&
      nativeBridgeSource.includes('if (detail?.kind !== kind)') &&
      nativeBridgeSource.includes('if (!detail.cancelled && detail.path)'),
  },
  {
    name: 'desktop shell surfaces navigation failure and web-process recovery',
    pass: macSource.includes('didFailProvisionalNavigation') &&
      macSource.includes('didFailNavigation') &&
      macSource.includes('webViewWebContentProcessDidTerminate') &&
      macSource.includes('VIGO_NAV_READY'),
  },
  {
    name: 'desktop shell records local GTFS first paint without waiting for remote basemap idle',
    pass: nativeBridgeSource.includes('export function reportNativeMapReady') &&
      nativeBridgeSource.includes('export function reportNativeMapPhase') &&
      mapSource.includes("map.on('render', reportReadyIfRendered)") &&
      mapSource.includes("map.off('render', reportReadyIfRendered)") &&
      !mapSource.includes("map.once('idle', reportReadyIfRendered)") &&
      mapSource.includes("map.isSourceLoaded('vigo-routes')") &&
      mapSource.includes("map.isSourceLoaded('vigo-stops')") &&
      mapSource.includes('map.queryRenderedFeatures({ layers: routeLayers })') &&
      mapSource.includes('map.queryRenderedFeatures({ layers: stopLayers })') &&
      mapSource.includes("reportPhase('local-source-render')") &&
      mapSource.includes('const remoteBasemapDeferred =') &&
      mapSource.includes('syncBasemap(map, currentBasemap, appearanceRef.current)') &&
      mapSource.includes('routeFeatures: renderedRoutes') &&
      mapSource.includes('stopFeatures: renderedStops') &&
      mapSource.includes('reportNativeMapReady({') &&
      macSource.includes('VIGO_MAP_PHASE') &&
      macSource.includes('VIGO_MAP_READY') &&
      macSource.includes("[action isEqualToString:@\"mapReady\"]"),
  },
  {
    name: 'map renderer failures are visible and reach the native desktop log',
    pass: nativeBridgeSource.includes('export function reportNativeMapFailed') &&
      mapSource.includes('reportNativeMapFailed({') &&
      mapSource.includes("map.on('error', handleMapError)") &&
      mapSource.includes("stage: 'initialize'") &&
      mapSource.includes('role="alert"') &&
      mapSource.includes('Map could not render') &&
      macSource.includes('VIGO_MAP_FAILED') &&
      macSource.includes("[action isEqualToString:@\"mapFailed\"]"),
  },
  {
    name: 'low-zoom overview stops participate in pointer hit testing',
    pass: mapSource.includes("['vigo-overview-stops', 'vigo-network-stops', 'vigo-transfer-stops', 'vigo-stops']") &&
      mapSource.includes("'vigo-network-stops', 'vigo-transfer-stops', 'vigo-stops'].filter"),
  },
  {
    name: 'macOS bundle declares access to the configured Documents project store',
    pass: macPackageSource.includes('<key>NSDocumentsFolderUsageDescription</key>') &&
      macPackageSource.includes('read and update your local VIGO project store'),
  },
  {
    name: 'visible desktop timetable language avoids sidecar terminology',
    pass: !uiSource.includes('Schedule sidecar') &&
      !uiSource.includes('schedule sidecar') &&
      !uiSource.includes('Timetable sidecar') &&
      !uiSource.includes('GTFS sidecars') &&
      !uiSource.includes('metadata and sidecars.'),
  },
  {
    name: 'retired right-inspector drawer shell and styling are removed',
    pass: !uiSource.includes('function DrawerShell(') &&
      !uiSource.includes('drawer-layer-right') &&
      !appCss.includes('.vigo-inspector') &&
      !appCss.includes('.inspector-export-row'),
  },
  {
    name: 'active rail state remains visible',
    pass: /\.sidebar-rail-button\.is-active/s.test(appCss) &&
      appCss.includes('grid-template-columns: 48px minmax(0, 1fr);') &&
      appCss.includes('box-shadow: inset 2px 0 0 var(--vigo-lime-strong);'),
  },
  {
    name: 'workspace rail supports guarded keyboard switching',
    pass: uiSource.includes('aria-keyshortcuts={shortcut') &&
      appSource.includes("case 'Digit1':") &&
      appSource.includes("case 'Digit4':") &&
      appSource.includes('target instanceof HTMLInputElement') &&
      appSource.includes("window.addEventListener('keydown', handleWorkspaceShortcut)"),
  },
  {
    name: 'narrow workspace rail keeps every primary action labeled',
    pass: appSource.includes('label="Manage"') &&
      appCss.includes('.sidebar-rail-bottom .sidebar-rail-label') &&
      appCss.includes('width: min(62px, 18vw);'),
  },
  {
    name: 'virtual route rows use the rendered desktop row height',
    pass: appSource.includes('const routeRowHeight = 50') &&
      appCss.includes('.route-tree-item {\n  height: 50px;'),
  },
  {
    name: 'route selection resets route-scoped stop context',
    pass: uiSource.includes("function selectRoute(routeId: string, renderMode: RouteRenderMode = 'service')") &&
      uiSource.includes('route.stopIds.includes(current) ? current : route.stopIds[0]') &&
      uiSource.includes('setRouteRenderMode(renderMode)') &&
      !uiSource.includes('onSelectRoute={setSelectedRouteId}'),
  },
  {
    name: 'map popovers clear when route or preview context changes',
    pass: mapSource.includes('setLiveSelection(null)') && mapSource.includes('[fitSignature, selectedRouteId]'),
  },
  {
    name: 'workspace identity editor does not refocus name while typing region',
    pass: uiSource.includes("const [draft, setDraft] = useState<ProjectDraft>") &&
      uiSource.includes("const dialogKey = state?.mode === 'rename'") &&
      uiSource.includes('}, [dialogKey])') &&
      !uiSource.includes('onChange={setProjectDialog}'),
  },
  {
    name: 'project shell exposes one explicit network switcher',
    pass: !uiSource.includes('sidebar-back-button') &&
      !appCss.includes('sidebar-back-button') &&
      uiSource.includes('className="topbar-project-action workspace-exit-action"') &&
      uiSource.includes('aria-label="Switch network"') &&
      uiSource.includes('<span>Networks</span>') &&
      uiSource.includes("function showProjects()") &&
      uiSource.includes("setPage('projects')"),
  },
  {
    name: 'workspace exit remains visible at tablet and narrow breakpoints',
    pass: appCss.includes('.topbar-project-action.workspace-exit-action') &&
      appCss.includes('.topbar-project-action:not(.workspace-exit-action)') &&
      !appCss.includes('is-primary'),
  },
  {
    name: 'route workspace avoids weird route truth product language',
    pass: !uiSource.includes('Route Truth') &&
      !uiSource.includes('route truth') &&
      uiSource.includes("activeRouteTool === 'pathfinder'") &&
      pathfinderSource.includes('aria-label="Routing controls"') &&
      uiSource.includes("const isExplorePanel = page === 'project' && activeRouteTool === 'explore'"),
  },
  {
    name: 'projects and empty states keep the command shell',
    pass: appCss.includes('/* Simplified workspace switcher. */') &&
      appCss.includes('.page-projects .shell-body,\n.project-empty .shell-body') &&
      appCss.includes('grid-template-columns: minmax(0, 1fr) !important') &&
      appCss.includes('.page-projects .app-sidebar,\n.project-empty .app-sidebar') &&
      appCss.includes('.page-projects .topbar-brand') &&
      appCss.includes('.page-projects .topbar-actions'),
  },
  {
    name: 'topbar stays pure color instead of glassy gradient',
    pass: /\/\* Compact application bar\. \*\/\s*\.topbar,[\s\S]*?\[data-vigo-native="macos"\] \.project-empty \.topbar\s*{[^}]*background:\s*var\(--topbar-surface\)[^}]*box-shadow:\s*none[^}]*backdrop-filter:\s*none/s.test(appCss) &&
      /\.search-palette__field\s*{[^}]*background:\s*var\(--control-surface\)[^}]*box-shadow:\s*none/s.test(appCss),
  },
  {
    name: 'first-run setup controls local storage and identity',
    pass: uiSource.includes('function FirstRunSetupDialog(') &&
      uiSource.includes('VIGO home folder') &&
      uiSource.includes("['blue', 'VIGO blue']") &&
      uiSource.includes('/api/config') &&
      uiSource.includes('`accent-${accent}`') &&
      appCss.includes('.app-shell.accent-blue') &&
      appCss.includes('.setup-dialog') &&
      serverSource.includes("pathname === '/api/config'") &&
      macSource.includes('chooseHomeFolder') &&
      macSource.includes("window.dispatchEvent(new CustomEvent('vigo-native-folder'"),
  },
  {
    name: 'settings deep-clean flow is workspace-scoped, previewed, and exact-name guarded',
    pass: dataWorkspaceSource.includes('<WorkspaceCleanupControl') &&
      workspaceCleanupSource.includes('Workspace cleanup impact') &&
      workspaceCleanupSource.includes('confirmation === preview.project.name') &&
      workspaceCleanupSource.includes('/workspace-cleanup') &&
      workspaceCleanupSource.includes('files outside its hidden .vigo folder stay in place') &&
      workspaceCleanupSource.includes('Remove workspace') &&
      workspaceCleanupSource.includes('onWorkspaceRemoved') &&
      appSource.includes('onWorkspaceRemoved={(projectId) => deleteProject(projectId, { confirm: false })}') &&
      serverSource.includes("action === 'workspace-cleanup'") &&
      serverSource.includes("Wait for the active GTFS or OSM import to finish before removing this workspace.") &&
      serverSource.includes('body.confirmation !== project.name') &&
      serverSource.includes("markStorageInitialized('deep-clean-workspace')"),
  },
  {
    name: 'settings cache maintenance is automatic, previewed, and preserves durable workspace data',
    pass: dataWorkspaceSource.includes('<CacheMaintenanceControl') &&
      cacheMaintenanceSource.includes('Automatic cache cleanup') &&
      cacheMaintenanceSource.includes("'/api/cache-maintenance'") &&
      cacheMaintenanceSource.includes('requestNativeWebCacheCleanup') &&
      cacheMaintenanceSource.includes('GTFS timetables, OSM street indexes, jobs, evidence, and user files are always preserved') &&
      runtimeConfigSource.includes('automaticCacheCleanup: boolean') &&
      serverSource.includes("pathname === '/api/cache-maintenance'") &&
      serverSource.includes("reason: 'automatic-startup'") &&
      serverSource.includes("'gtfs-routing-stores'") &&
      serverSource.includes("'jobs-and-evidence'") &&
      nativeBridgeSource.includes("action: 'clearWebCache'") &&
      macSource.includes('WKWebsiteDataTypeDiskCache') &&
      macSource.includes('WKWebsiteDataTypeMemoryCache') &&
      macSource.includes('automaticCacheCleanupEnabled') &&
      packageSource.includes('check:cache-maintenance'),
  },
  {
    name: 'workspace state comes from Vigo Projects, not browser session storage or seeded demos',
    pass: uiSource.includes("const [projects, setProjects] = useState<VigoProject[]>([])") &&
      uiSource.includes("const [selectedProjectId, setSelectedProjectId] = useState('')") &&
      uiSource.includes("const [page, setPage] = useState<'projects' | 'project'>('projects')") &&
      !uiSource.includes('vigo.review.') &&
      !uiSource.includes('localStorage?.setItem(`vigo.projects') &&
      !uiSource.includes('sessionStorage') &&
      !uiSource.includes('fallbackProject') &&
      !uiSource.includes('createDemo') &&
      !serverSource.includes('seedSampleProject') &&
      !serverSource.includes('seedIfEmpty') &&
      !serverSource.includes('sampleProject('),
  },
  {
    name: 'offline mode avoids network tile dependency',
    pass: mapSource.includes("basemap === 'none' || basemap === 'offline'") &&
      mapSource.includes('function syncBasemap') &&
      mapSource.includes("map.removeSource('osm')") &&
      mapSource.includes("id: 'vigo-offline-bg'") &&
      mapSource.includes('localStreetRefreshTimerRef') &&
      mapSource.includes('localStreetLimitForZoom') &&
      mapSource.includes('data-local-street-status') &&
      serverSource.includes('offlineBasemap: true') &&
      uiSource.includes('remoteFeedUrlsRequireNetwork') &&
      uiSource.includes('realtimeUrlsRequireNetwork'),
  },
  {
    name: 'OSM Standard is the default and remote basemaps retain native visual detail',
    pass: appSource.includes("useState<Basemap>('streets')") &&
      projectDialogsSource.includes("basemap: 'streets'") &&
      serverSource.includes("basemap: 'streets'") &&
      serverSource.includes("? value : 'streets'") &&
      mapSource.includes("'raster-opacity': 1") &&
      mapSource.includes("'raster-fade-duration': 0") &&
      !mapSource.includes('rasterBasemapPaints') &&
      !mapSource.includes('raster-brightness-') &&
      !mapSource.includes('raster-saturation'),
  },
  {
    name: 'search palette retrieves route and stop results through a focused feature model',
    pass: searchModelSource.includes('findNetworkSearchHits(networkSearchIndex') &&
      routingUiSource.includes('export function buildNetworkSearchIndex') &&
      uiSource.includes('className="search-palette__results"') &&
      appSource.includes("from './features/search/SearchPalette'") &&
      appSource.includes("from './features/search/searchModel'") &&
      !existsSync(resolve(root, 'src/components/UniversalSearch.tsx')) &&
      appCss.includes('.search-palette__results') &&
      !appCss.includes('.command-center') &&
      !appCss.includes('.command-results'),
  },
  {
    name: 'search palette exposes every primary workspace view without map-wide query filtering',
    pass: searchModelSource.includes("id: 'command:accessibility'") &&
      appSource.includes("result.id === 'command:accessibility'") &&
      appSource.includes('filterPreviewByStatus') &&
      !appSource.includes('previewFilterQuery'),
  },
  {
    name: 'search palette supports keyboard, clear, and unobscured narrow-screen interaction',
    pass: searchPaletteSource.includes('role="combobox"') &&
      searchPaletteSource.includes('role="listbox"') &&
      searchPaletteSource.includes('role="group"') &&
      searchPaletteSource.includes("event.key === 'ArrowDown'") &&
      searchPaletteSource.includes("event.key === 'Home'") &&
      searchPaletteSource.includes('aria-label="Clear search"') &&
      searchModelSource.includes("group: hit.kind === 'route' ? 'routes' : 'stops'") &&
      routingUiSource.includes('const stopHits = normalizedQuery.length > 1') &&
      appCss.includes('.app-shell.page-project .topbar') &&
      appCss.includes('position: fixed') &&
      appCss.includes('grid-template-columns: 36px minmax(0, 1fr) 36px'),
  },
  {
    name: 'pathfinder resolves and routes an ordered point sequence through one atomic request',
    pass: appSource.includes('queries: routingCommand.locationTexts') &&
      appSource.includes('const candidates = routingCommand.locationTexts.map') &&
      appSource.includes('commitRoutingLocationResolution(resolution)') &&
      serverSource.includes("body.queries.length === 2 ? 'search-pair' : 'search-many'") &&
      serverSource.includes('return hasOrderedQueries ? { results: stops } : { stops }') &&
      nationalRouteWorkerSource.includes("operation === 'search-pair' || operation === 'search-many'") &&
      nationalRouteWorkerSource.includes('queries.map((query) => searchNationalGtfsStops') &&
      nationalRoutingSource.includes('waypoints,') &&
      nationalRoutingSource.includes('body: JSON.stringify({') &&
      orderedRouteSource.includes("algorithm: 'ordered_waypoint_composition'") &&
      orderedRouteSource.includes("optimality: 'exact_per_leg_for_fixed_user_order'") &&
      orderedRouteSource.includes("failureCode: 'ordered_transit_ride_required'") &&
      serverSource.includes("{ requireTransitRide: orderedMode === 'transit' }") &&
      serverSource.includes('{ __disableDirectWalkDominance: true }'),
  },
  {
    name: 'ambiguous typed places require an explicit candidate choice',
    pass: appSource.includes('limit: 5') &&
      appSource.includes('const exactMatches = options.filter') &&
      appSource.includes('setPendingRoutingLocationResolution(resolution)') &&
      appSource.includes('function chooseRoutingLocation(') &&
      pathfinderSource.includes('Confirm places') &&
      pathfinderSource.includes('onChooseRoutingLocation(choice.queryIndex, candidate)') &&
      pathfinderSource.includes('candidate.platformCount'),
  },
  {
    name: 'journey cards disclose selection rationale and defer diagnostics to evidence',
    pass: pathfinderSource.includes('Why this journey is shown') &&
      pathfinderSource.includes('Routing evidence') &&
      pathfinderSource.includes('not controlled performance or traveler-preference evidence') &&
      pathfinderSource.includes('Top result') &&
      !pathfinderSource.includes('Recommended ·'),
  },
  {
    name: 'reverse routing preserves resolved coordinates and destination order is editable',
    pass: pathfinderSource.includes('onReorderRoutingPoints([...resolved].reverse())') &&
      pathfinderSource.includes('function moveDestination(') &&
      pathfinderSource.includes('function addWaypoint()') &&
      pathfinderSource.includes('Reverse route') &&
      pathfinderSource.includes('function startNewRoute()') &&
      pathfinderSource.includes('New route') &&
      pathfinderSource.includes('pathfinder-stop-controls') &&
      pathfinderSource.includes('Done picking') &&
      pathfinderSource.includes('disabled={mapPointLimitReached && !routingEnabled}') &&
      appSource.includes('function reorderRoutingPoints(points: RoutingPoint[])') &&
      appSource.includes('setRoutingWaypoints(orderedPoints.slice(1, -1))') &&
      mapSource.includes('routingWaypoints?: RoutingPoint[]') &&
      mapSource.includes('routingPinLabel(index, points.length)'),
  },
  {
    name: 'map picking preserves the destination while inserting semantic via points',
    pass: routingPointSequenceSource.includes('export function appendRoutingPointSequence(') &&
      routingPointSequenceSource.includes('export function insertRoutingPointBeforeDestination(') &&
      routingPointSequenceSource.includes('normalizeOrderedRoutingPoints([...points, point])') &&
      routingPointSequenceSource.includes('normalizeOrderedRoutingPoints([...points.slice(0, -1), point, points.at(-1)!])') &&
      routingPointSequenceSource.includes('export const maxRoutingPointCount = 8') &&
      appSource.includes('const currentPoints = [') &&
      appSource.includes('insertRoutingPointBeforeDestination(currentPoints, point)') &&
      appSource.includes('if (nextPoints.length === 1)') &&
      appSource.includes('if (!reorderRoutingPoints(nextPoints)) return') &&
      !appSource.includes('setRoutingEnabled(nextPoints.length < maxRoutingPointCount)') &&
      pathfinderSource.includes('nextMapPointAction') &&
      pathfinderSource.includes('nextMapPointLabel') &&
      routingPointSequenceSource.includes('routingPointRoleLabel') &&
      mapSource.includes("map.getCanvas().style.cursor = 'crosshair'"),
  },
  {
    name: 'multi-stop transit requests chain each departure from the preceding arrival',
    pass: serverSource.includes('routeOrderedRoutingSegments(') &&
      orderedRouteSource.includes('for (let index = 0; index < points.length - 1; index += 1)') &&
      orderedRouteSource.includes('nextDepartMinutes = Number(plan.arriveMinutes') &&
      orderedRouteSource.includes('for (let index = points.length - 2; index >= 0; index -= 1)') &&
      orderedRouteSource.includes('nextArriveMinutes = Number(plan.departMinutes)'),
  },
  {
    name: 'route planner lives in the left sidebar, not the map dock',
    pass: uiSource.includes('function SidebarPathfinderBox(') &&
      uiSource.includes("activeRouteTool === 'pathfinder'") &&
      uiSource.includes("analysisFocus ? 'scenario' : routingFocus ? 'routing'") &&
      uiSource.includes('routingPointFromMap') &&
      uiSource.includes('const routingChoices = nationalRouting.choices') &&
      !uiSource.includes('<RouteMapControls') &&
      mapSource.includes("map.addSource('vigo-routing'") &&
      mapSource.includes('(routingEnabled || (scenarioFocus && scenarioPointPicking)) && onRoutingPoint') &&
      appCss.includes('.sidebox-pathfinder'),
  },
  {
    name: 'baseline isochrones and multi-case service changes share one Evidence workspace',
    pass: appSource.includes("'pathfinder' | 'accessibility'") &&
      appSource.includes('title="Evidence"') &&
      !appSource.includes('<AnalyzeModeSelector') &&
      appSource.includes('<AccessibilityWorkspacePanel') &&
      appSource.includes("activeRouteTool === 'accessibility'") &&
      !appSource.includes('<IsochronePanel') &&
      !appSource.includes('<ScenarioLabPanel') &&
      accessibilityWorkspaceSource.includes('Comparison cases') &&
      accessibilityWorkspaceSource.includes("'add-line'") &&
      accessibilityWorkspaceSource.includes("'enhance-line'") &&
      accessibilityWorkspaceSource.includes("'change-line'") &&
      accessibilityWorkspaceSource.includes("'remove-line'") &&
      accessibilityWorkspaceSource.includes("'policy'") &&
      accessibilityWorkspaceSource.includes('Name, number, or route ID') &&
      accessibilityWorkspaceSource.includes('Add intermediate stop') &&
      accessibilityWorkspaceSource.includes('Change stop ${index + 1}') &&
      appSource.includes("if (!intervention?.routeId) return") &&
      !appSource.includes("if (!intervention?.routeId || !intervention.stops.length) return") &&
      !accessibilityWorkspaceSource.includes('Surface detail') &&
      accessibilityWorkspaceSource.includes('Accessible area') &&
      accessibilityWorkspaceSource.includes('Street paths') &&
      accessibilityWorkspaceSource.includes('Stop order follows GTFS stop_times') &&
      accessibilityWorkspaceSource.includes('role="status" aria-live="polite"') &&
      appSource.includes('function beginScenarioStopPlacement(') &&
      appSource.includes('function updateAccessibilityInterventionRoute(') &&
      appSource.includes("['add-line', 'change-line'].includes") &&
      !appSource.includes('route-shape-${index + 1}') &&
      mapSource.includes('function scenarioPointForMapClick(') &&
      mapSource.includes('scenarioPointPicking') &&
      mapSource.includes('sequenceLabel: String(index + 1)') &&
      mapSource.includes("'replaced', '#ff735c'") &&
      mapSource.includes("'inserted', '#35d0a1'") &&
      mapSource.includes("scenarioStopHit?.properties") &&
      appSource.includes('sourceRouteId') &&
      !mapSource.includes("type: 'image'") &&
      mapSource.includes("source(map, 'vigo-scenario-contours')"),
  },
  {
    name: 'Accessibility expands a public route into explicit GTFS branch patterns',
    pass: accessibilityWorkspaceSource.includes('Existing public route') &&
      accessibilityWorkspaceSource.includes('GTFS branch / pattern') &&
      accessibilityWorkspaceSource.includes('scopedRouteServiceKey') &&
      accessibilityWorkspaceSource.includes('branchOptionLabel') &&
      accessibilityWorkspaceSource.includes('routeAnalysisLoading') &&
      appSource.includes('activeRouteTool !== \'accessibility\'') &&
      appSource.includes('void loadGtfsRouteAnalysis(route, route.id)') &&
      appSource.includes('function scenarioSourceRouteId('),
  },
  {
    name: 'accessibility controls expose adjustable total elapsed walk plus transit plus walk',
    pass: accessibilityWorkspaceSource.includes('maxWalkKm: number') &&
      accessibilityWorkspaceSource.includes('walkSpeedKph: number') &&
      accessibilityWorkspaceSource.includes('onMaxWalkKmChange') &&
      accessibilityWorkspaceSource.includes('onWalkSpeedChange') &&
      accessibilityWorkspaceSource.includes('Total elapsed OSM access walk + transit + terminal walk') &&
      accessibilityWorkspaceSource.includes('Final walking consumes remaining time') &&
      accessibilityWorkspaceSource.includes('Current network') &&
      accessibilityWorkspaceSource.includes('Time difference') &&
      accessibilityWorkspaceSource.includes('directed OSM network evidence') &&
      accessibilityWorkspaceSource.includes('area and street-path renderings') &&
      accessibilityWorkspaceSource.includes('accessibility-surface-legend') &&
      mapSource.includes('accessibilityTimeColor') &&
      mapSource.includes('accessibilityDifferenceColor') &&
      appSource.includes('maxWalkKm={routingMaxWalkKm}') &&
      appSource.includes('changeRoutingMaxWalkKm(value)') &&
      (
        appSource.includes('function invalidateAccessibilityAnalysis()')
        || appSource.includes('const invalidateAccessibilityAnalysis = useCallback(')
      ) &&
      appSource.includes('analysisAbortRef.current?.abort()'),
  },
  {
    name: 'accessibility renders one area or street-path surface without point evidence layers',
    pass: appSource.includes('desktopAccessibilityRasterSize = 128') &&
      appSource.includes('scenarioRenderMode') &&
      mapSource.includes('function scenarioAreaFeatures(') &&
      mapSource.includes('function scenarioEdgeFeatures(') &&
      mapSource.includes("id: 'vigo-scenario-area'") &&
      mapSource.includes("id: 'vigo-scenario-access-edges'") &&
      mapSource.includes("scenarioRenderMode === 'streets'") &&
      mapSource.includes('decodeStreetEdgeBundle') &&
      mapSource.includes('indexedScenarioEdgeFeatures') &&
      mapSource.includes("vigo.street.edge-ref.v1") &&
      mapSource.includes("type: 'MultiLineString' as const") &&
      !mapSource.includes('scenarioNodeFeatures') &&
      !mapSource.includes('scenario-nodes') &&
      nationalStoreSource.includes('includeEdges: surfaceRequest.includeEdges === true') &&
      nationalStoreSource.includes('edgeEvidenceLimit: 0') &&
      scenarioAnalysisServerSource.includes('expandBoundsToReachedEdges: true') &&
      nationalStoreSource.includes('expandBoundsToReachedEdges: surfaceRequest.expandBoundsToReachedEdges') &&
      !nationalStoreSource.includes('edgeEvidenceLimit: 12_000') &&
      nationalStoreSource.includes("'all_active_timetable_stops'") &&
      nationalStoreSource.includes("distanceSelection: 'none'") &&
      nationalStoreSource.includes("edgeEvidenceSelection: 'all-reached-directed-edges'") &&
      scenarioAnalysisServerSource.includes('includeNodes: false') &&
      scenarioAnalysisServerSource.includes('includeEdges: request.includeStreetEdges') &&
      scenarioAnalysisServerSource.includes('compactEdges: true') &&
      scenarioAnalysisServerSource.includes("terminalWalkMode: 'elapsed-total'") &&
      !scenarioAnalysisServerSource.includes("terminalWalkMode: 'independent-full-budget'") &&
      appSource.includes('includeStreetEdges,') &&
      appSource.includes("runSurfaceAnalysis(true)") &&
      scenarioAnalysisServerSource.includes('requireStreetEdgeBundle') &&
      !scenarioAnalysisServerSource.includes('packStreetEdgeEvidence') &&
      !scenarioAnalysisServerSource.includes('Array.isArray(surface.edges)') &&
      !mapSource.includes('scenarioEdgeKey') &&
      scenarioAnalysisServerSource.includes('fullValues') &&
      scenarioAnalysisServerSource.includes('displayBounds') &&
      !mapSource.includes('vigo-scenario-surface') &&
      !mapSource.includes("id: `${layerPrefix}-surface`") &&
      !mapSource.includes("source: `${layerPrefix}-surface`") &&
      !mapSource.includes("type: 'image'") &&
      accessibilityWorkspaceSource.includes('within the total time cutoff') &&
      mapSource.includes('zeroMinuteOrigin') &&
      mapSource.includes("' · 0 min'") &&
      /function indexedEdgeArrival[\s\S]*?return decoded\.durations\[index\]/.test(mapSource),
  },
  {
    name: 'remote basemap stays below accessibility evidence layers',
    pass: /function firstVigoLayerId[\s\S]*?'vigo-scenario-area'[\s\S]*?'vigo-coverage'/.test(mapSource) &&
      /map\.addLayer\(\{[\s\S]*?id: 'osm'[\s\S]*?\}, firstVigoLayerId\(map\)\)/.test(mapSource),
  },
  {
    name: 'Evidence compares a selected group of independent GTFS accessibility surfaces',
    pass: accessibilityWorkspaceSource.includes('Compare GTFS group') &&
      accessibilityWorkspaceSource.includes('GTFS feeds to compare') &&
      accessibilityWorkspaceSource.includes('comparisonFeedIds.length < 2') &&
      accessibilityWorkspaceSource.includes('All selected isochrones are overlaid on the map') &&
      appSource.includes('runFeedComparison') &&
      appSource.includes('scenarioComparison={scenarioComparison}') &&
      mapSource.includes('function scenarioComparisonLayerIds(count: number)') &&
      mapSource.includes('comparisonEntries.length') &&
      serverSource.includes('A requested feed must stay isolated'),
  },
  {
    name: 'accessibility cases use toggle-group semantics and stale results follow every routing input identity',
    pass: accessibilityWorkspaceSource.includes('role="group" aria-label="Comparison cases"') &&
      accessibilityWorkspaceSource.includes('aria-pressed={entry.id === activeCase?.id}') &&
      !accessibilityWorkspaceSource.includes('role="tab"') &&
      appSource.includes('const accessibilityInputIdentity = [') &&
      appSource.includes("selectedProject.osmStreetIndex?.builtAt ?? ''") &&
      appSource.includes('routingServiceDate,') &&
      appSource.includes('scheduleTimeMinutes,') &&
      appSource.includes('routingMaxWalkKm,') &&
      appSource.includes('invalidateAccessibilityAnalysis()') &&
      appCss.includes('.accessibility-field select') &&
      appCss.includes('color-scheme: inherit'),
  },
  {
    name: 'accessibility owns its bounded scroll and uses current workbench tokens',
    pass: appCss.includes('.sidebar-panel.is-accessibility') &&
      /\.accessibility-workspace\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s.test(appCss) &&
      appCss.includes('scrollbar-gutter: stable') &&
      !accessibilityWorkspaceSource.includes('No changes in this case') &&
      !appCss.includes('var(--line)') &&
      !appCss.includes('var(--muted)') &&
      !appCss.includes('var(--panel-raised)'),
  },
  {
    name: 'every accessibility intervention has a direct removal action',
    pass: accessibilityWorkspaceSource.includes('className="accessibility-intervention-remove"') &&
      accessibilityWorkspaceSource.includes('onRemoveIntervention(intervention.id)') &&
      accessibilityWorkspaceSource.includes('aria-label={`Remove ${intervention.name') &&
      appCss.includes('.accessibility-intervention-remove'),
  },
  {
    name: 'unified Accessibility analysis streams progress while the desktop routing workspace owns warm residency',
    pass: apiClientSource.includes("Accept: 'application/x-ndjson'") &&
      apiClientSource.includes("event.type === 'preliminary'") &&
      apiClientSource.includes("event.type === 'progress'") &&
      appSource.includes('cancelSurfaceAnalysis') &&
      appSource.includes('routing-residency') &&
      appSource.includes('desktop-workspace-${crypto.randomUUID()}') &&
      appSource.includes('serviceDate: routingServiceDate') &&
      appSource.includes('serviceDay: routingServiceDay') &&
      appSource.includes("&& activeRouteTool === 'pathfinder'") &&
      accessibilityWorkspaceSource.includes('Cancel analysis') &&
      accessibilityWorkspaceSource.includes('accessibility-analysis-progress') &&
      serverSource.includes("'accessibility-range'") &&
      serverSource.includes("'street-surface'") &&
      serverSource.includes('application/x-ndjson') &&
      serverSource.includes('setResidency') &&
      nationalRouteWorkerSource.includes("operation === 'prepare-routing-access'") &&
      serverSource.includes('readinessOnly: true') &&
      nationalRouteWorkerSource.includes("operation === 'accessibility-range'") &&
      nationalRouteWorkerSource.includes("operation === 'street-surface'") &&
      nationalRouteWorkerSource.includes('routeNationalGtfsAccessibilityRange'),
  },
  {
    name: 'routing map clicks remain free A-B coordinates so reachable stations compete',
    pass: mapSource.includes('function routingPointForMapClick(event:') &&
      mapSource.includes("return { coordinate, label: 'Map point', source: 'map' }") &&
      mapSource.includes(': routingPointForMapClick(event)') &&
      nationalStoreSource.includes("return point?.source === 'map' ? ''") &&
      nationalStoreSource.includes('nearestStops(') &&
      uiSource.includes('function routingPointFromMap(point: RoutingPoint)') &&
      uiSource.includes("point.source === 'map'"),
  },
  {
    name: 'pathfinder keeps query choices focused without reviving the retired inspector',
    pass: uiSource.includes('routingTimeOptions') &&
      uiSource.includes('routingMaxWalkOptions') &&
      !uiSource.includes('routingModeOptions') &&
      pathfinderSource.includes('pathfinder-composer') &&
      pathfinderSource.includes('pathfinder-route-card') &&
      pathfinderSource.includes('Route options') &&
      !uiSource.includes('onExportRoutingPlan') &&
      appCss.includes('.pathfinder-time-preference') &&
      appCss.includes('.pathfinder-walk-limit') &&
      !appCss.includes('.inspector-export-row'),
  },
  {
    name: 'store-backed status reports declared trips and SQLite connection totals',
    pass: uiSource.includes('const routingStoreTripCount = scopedRoutingFeeds.reduce') &&
      uiSource.includes('const routingStoreConnectionCount = Number(') &&
      uiSource.includes('feed.routingStore?.connectionCount') &&
      uiSource.includes('connections in SQLite'),
  },
  {
    name: 'map-point routing waits for the matching project street graph',
    pass: uiSource.includes('routingStreetState') &&
      uiSource.includes("selectedProject.osmStreetIndex?.status === 'ready'") &&
      uiSource.includes("routingStreetState === 'ready'") &&
      uiSource.includes("routingStreetState === 'loading'") &&
      uiSource.includes('Street snapshot required'),
  },
  {
    name: 'pathfinder labels exact and later-departure results truthfully',
    pass: pathfinderSource.includes('Timetable ready') &&
      pathfinderSource.includes('Checking later departures…') &&
      pathfinderSource.includes('Exact time') &&
      !uiSource.includes('exact baseline') &&
      !uiSource.includes('Exact baseline'),
  },
  {
    name: 'abandoned demo and map-control product paths are removed',
    pass: !existsSync(resolve(root, 'src/components/RouteMapControls.tsx')) &&
      !uiSource.includes('fallbackProject') &&
      !readFileSync(resolve(root, 'src/domain.ts'), 'utf8').includes('export function fallbackProject'),
  },
  {
    name: 'pathfinder keeps journey search explicit and leaves basemap controls in Data',
    pass: pathfinderSource.includes('pathfinder-composer') &&
      pathfinderSource.includes('onRunRoutingSearch') &&
      pathfinderSource.includes('Pick on map') &&
      !pathfinderSource.includes('basemapOptions') &&
      !pathfinderSource.includes('Load OSM') &&
      appCss.includes('.pathfinder-directions-button') &&
      uiSource.includes('function changeBasemap'),
  },
  {
    name: 'OSM PBF imports build the local SQLite street index without a browser graph',
    pass: uiSource.includes('osm-import-strip') &&
      uiSource.includes('onOsmFiles') &&
      appCss.includes('.osm-import-strip') &&
      uiSource.includes("uploadProjectSourceFile(file, 'national-osm-upload')") &&
      serverSource.includes("action === 'national-osm-upload'") &&
      serverSource.includes("extensions: ['.osm.pbf', '.pbf']") &&
      serverSource.includes("path.join(projectMetaDir(projectId), 'osm', 'street-index.sqlite')") &&
      !serverSource.includes("action === 'osm-walk'") &&
      !serverSource.includes("path.join(osmDir, 'walk-network.json')") &&
      !mapSource.includes('vigo-osm-walk'),
  },
  {
    name: 'legacy seeded-project and transport-JSON paths are removed',
    pass: !packageSource.includes('"preload:osm"') &&
      !packageSource.includes('"projects:migrate"') &&
      !existsSync(resolve(root, 'scripts/preload-project-osm.mjs')) &&
      !existsSync(resolve(root, 'scripts/migrate-project-databases.mjs')) &&
      !existsSync(resolve(root, 'scripts/refresh-feed-preview.mjs')) &&
      !serverSource.includes("path.join(projectMetaDir(projectId), 'transport'") &&
      !serverSource.includes("path.join(projectMetaDir(projectId), 'index'") &&
      !serverSource.includes('writeFeedTransport') &&
      !serverSource.includes('writeAtlasIndex') &&
      !serverSource.includes('routingSchedule') &&
      !serverSource.includes('walk-network.json'),
  },
  {
    name: 'routes map exposes all-day static GTFS service playback controls',
    pass: serviceStateControlSource.includes('service-state-panel') &&
      serviceStateControlSource.includes("mode === 'schedule'") &&
      appSource.includes('servicePlaybackRunning') &&
      appSource.includes('servicePlaybackStep') &&
      appSource.includes('scheduledVehiclesAtTime(mapPreview, scheduleTimeMinutes, scheduleServiceDay') &&
      serviceStateControlSource.includes('aria-valuetext={formatScheduleClock(scheduleTimeMinutes)}') &&
      mapSource.includes('vehicleLayerIds') &&
      appCss.includes('.service-state-panel.is-schedule') &&
      appCss.includes('.service-playback-slider'),
  },
  {
    name: 'network vehicle rendering stays complete while dynamic source work and retained frames stay bounded',
    pass: serviceVehicleSource.includes('return snapshot.vehicles.flatMap((vehicle) => {') &&
      mapSource.includes('if (selectedRouteId && !selectedRouteMatch) return []') &&
      mapSource.includes("id: uniqueVehicleFeatureId(vehicle.source, vehicle.id, occurrences)") &&
      mapSource.includes("map.addSource('vigo-service-vehicles'") &&
      !mapSource.includes("map.addSource('vigo-realtime-vehicles'") &&
      !mapSource.includes("map.addSource('vigo-scheduled-vehicles'") &&
      mapSource.includes('mapSource.updateData({') &&
      mapSource.includes("filter: ['all', ['==', ['get', 'selectedRoute'], true], ['==', ['get', 'hasBearing'], true]]") &&
      mapSource.includes("filter: ['==', ['get', 'selectedRoute'], true]") &&
      appSource.includes('const vehicleFrame = useMemo(') &&
      appSource.includes("preview: vehicleMode === 'live' ? visiblePreview : mapPreview") &&
      serviceVehicleSource.includes('Number.isFinite(vehicle.lon)') &&
      serviceVehicleSource.includes('Number.isFinite(vehicle.lat)') &&
      !scheduledVehicleSource.includes('includeHeadwayEstimates') &&
      !scheduledVehicleSource.includes('headway-estimate') &&
      !scheduledVehicleSource.includes('fallbackCount') &&
      !mapSource.includes('scheduledVehiclesAtTime') &&
      scheduledVehicleSource.includes('WeakMap<MapPreview, { key: string; vehicles: ScheduledVehicle[] }>') &&
      !scheduledVehicleSource.includes('scheduledProjectionCacheMaxEntries') &&
      !mapSource.includes('realtimeVehicleBudget') &&
      !mapSource.includes('scheduledVehicleBudget') &&
      !mapSource.includes('scheduledTripScanBudget') &&
      !mapSource.includes('routeFeatureBudget'),
  },
  {
    name: 'route focus keeps one public service coherent across static patterns and GTFS-RT details',
    pass: appSource.includes("preview: vehicleMode === 'live' ? visiblePreview : mapPreview") &&
      appSource.includes('const visibleVehicleCount = serviceVehicleCount(vehicleFrame, isNetworkMap ? undefined : selectedRoute)') &&
      serviceVehicleSource.includes('const realtimeArrivalTimestamp = nextStopUpdate?.arrival?.time ?? nextStopUpdate?.departure?.time') &&
      serviceVehicleSource.includes("?? tripUpdate?.stopTimeUpdates?.at(-1)?.stopId") &&
      serviceVehicleSource.includes('const stop = stopFor(index, nextStopId)') &&
      mapSource.includes('vehicle.serviceKey === selectedServiceKey'),
  },
  {
    name: 'map keeps network and route focus as explicit reversible views',
    pass: uiSource.includes('function MapScopeControl(') &&
      uiSource.includes('aria-label="Map view"') &&
      uiSource.includes("onMapScopeChange('network')") &&
      uiSource.includes("onMapScopeChange('route')") &&
      uiSource.includes('disabled={!routeFocusAvailable}') &&
      appCss.includes('.map-scope-control') &&
      appCss.includes('.map-scope-actions button.is-active'),
  },
  {
    name: 'GTFS data view exposes the local source-to-SQLite readiness pipeline',
    pass: uiSource.includes('function DataReadinessRail(') &&
      uiSource.includes('aria-label="Data readiness pipeline"') &&
      uiSource.includes("value: timetableReady ? 'SQLite ready'") &&
      uiSource.includes('bundleStoresReady') &&
      uiSource.includes("value: streetStore?.status === 'ready' ? 'OSM ready'") &&
      uiSource.includes('Core tables ready') &&
      uiSource.includes('role="listitem"') &&
      appCss.includes('.data-readiness-rail') &&
      appCss.includes('.table-contract-status'),
  },
  {
    name: 'route focus defaults to the complete public service and can isolate one pattern',
    pass: uiSource.includes("renderMode: RouteRenderMode = 'service'") &&
      uiSource.includes("renderMode === 'pattern'") &&
      uiSource.includes('scopedRouteServiceKey(route) === scopedRouteServiceKey(selectedPattern)') &&
      uiSource.includes('routes,') &&
      uiSource.includes('stopPairs: (preview.stopPairs ?? []).filter((pair) => routeIds.has(pair.patternId))') &&
      exploreObjectSource.includes('onRenderModeChange') &&
      exploreObjectSource.includes('onSelectPattern'),
  },
  {
    name: 'closing route detail restores the bounded network overview',
    pass: appSource.includes('function returnToNetworkOverview') &&
      appSource.includes('onClearSelection={returnToNetworkOverview}') &&
      exploreObjectSource.includes('onClearSelection') &&
      exploreObjectSource.includes('>Clear</button>') &&
      appSource.includes("const isNetworkMap = mapScope === 'network' || !selectedRoute") &&
      appSource.includes("setMapScope('network')"),
  },
  {
    name: 'map-first shell exposes three primary workspaces plus secondary management',
    pass: ['Network', 'Route', 'Evidence']
      .every((label) => appSource.includes(`title="${label}"`)) &&
      appSource.includes('title="Manage workspace"') &&
      ['Diagnose', 'Compare', 'Analyze', 'Review', 'Publish']
        .every((label) => !appSource.includes(`title="${label}"`)) &&
      appSource.includes("activeRouteTool === 'explore'") &&
      appSource.includes("activeRouteTool === 'pathfinder'") &&
      appSource.includes("activeRouteTool === 'accessibility'") &&
      appSource.includes("activeRouteTool === 'data'") &&
      appCss.includes('grid-template-columns: var(--workbench-sidebar) minmax(0, 1fr)') &&
      !appSource.includes('<VigoInspectorPanel') &&
      !appCss.includes('inspector-visible:not(.project-empty) .shell-body'),
  },
  {
    name: 'workspace settings remain reachable after a project is open',
    pass: appSource.includes('label="Open settings"') &&
      appSource.includes('onOpenSettings={openSettingsView}') &&
      appSource.includes('const nextProjectId = selectedProjectId') &&
      appSource.includes("setDataSection('preferences')") &&
      appSource.includes("setPage('project')"),
  },
  {
    name: 'leaving the map for workspace settings never calls MapLibre after removal',
    pass: mapSource.includes('const mapRemovedRef = useRef(false)') &&
      mapSource.includes('if (mapRemovedRef.current) return') &&
      mapSource.includes('mapRemovedRef.current = true') &&
      mapSource.includes("console.warn('VIGO map cleanup failed', error)"),
  },
  {
    name: 'selecting a routing choice opens a dismissible detailed itinerary panel',
    pass: pathfinderSource.includes('export function RoutingDetailPanel') &&
      pathfinderSource.includes('aria-label="Routing details"') &&
      pathfinderSource.includes('aria-label="Close routing details"') &&
      pathfinderSource.includes('className="pathfinder-route-open"') &&
      appSource.includes("routingDetailOpen = page === 'project'") &&
      appSource.includes('<RoutingDetailPanel') &&
      appSource.includes("routingDetailOpen && 'routing-detail-open'") &&
      appCss.includes('.routing-detail-panel') &&
      appCss.includes('var(--routing-detail-width)'),
  },
  {
    name: 'exiting a workspace closes route detail and cancels workspace state',
    pass: appSource.includes('function closeWorkspace()') &&
      appSource.includes('cancelProjectDetail(selectedProjectId)') &&
      appSource.includes('clearRouting()') &&
      appSource.includes("setActiveRouteTool('explore')") &&
      appSource.includes('function showProjects()') &&
      appSource.includes('closeWorkspace()'),
  },
  {
    name: 'retired expansion workspaces and their modules are removed',
    pass: !existsSync(resolve(root, 'src/app/transitWorkbench.ts')) &&
      !existsSync(resolve(root, 'src/app/evidencePackage.ts')) &&
      !existsSync(resolve(root, 'src/components/TransitWorkbenchPanels.tsx')) &&
      !appSource.includes('evidence export') &&
      !appSource.includes("'diagnose'") &&
      !appSource.includes("'compare'") &&
      !appSource.includes("'review'") &&
      !appSource.includes("'publish'") &&
      !appCss.includes('.diagnose-panel') &&
      !appCss.includes('.compare-panel') &&
      !appCss.includes('.review-panel') &&
      !appCss.includes('.publish-panel'),
  },
  {
    name: 'narrow workbench stacks the full-width panel above the horizontal rail',
    pass: appCss.includes('grid-template-rows: minmax(0, 1fr) 48px;') &&
      /\.sidebar-rail\s*{[^}]*grid-column:\s*1;[^}]*grid-row:\s*2;/s.test(appCss) &&
      /\.sidebar-panel\s*{[^}]*grid-column:\s*1;[^}]*grid-row:\s*1;/s.test(appCss),
  },
  {
    name: 'source-table absence is distinguished from a loading failure',
    pass: appSource.includes("'Not in feed'") &&
      !appSource.includes("'Not loaded'"),
  },
  {
    name: 'routes page preserves route services while exposing their pattern variants',
    pass: uiSource.includes('function publicRouteEntries') &&
      uiSource.includes('variants: RouteMetric[]') &&
      exploreObjectSource.includes('const patterns = patternGroup(preview, route)') &&
      exploreObjectSource.includes('function temporalDirectionRows') &&
      exploreObjectSource.includes("renderMode === 'service' ? directionRows : patternRows") &&
      appCss.includes('.temporal-view-switch') &&
      appCss.includes('.route-browser-list'),
  },
  {
    name: 'scheduled service playback scrubs at exact one-minute resolution',
    pass: serviceStateControlSource.includes('<option value={1}>1 min</option>') &&
      serviceStateControlSource.includes('max={1439}') &&
      serviceStateControlSource.includes('step={1}') &&
      appSource.includes('const nextTime = (playbackTimeRef.current + servicePlaybackStep + 1440) % 1440'),
  },
  {
    name: 'advanced analytics stays out of the journey query surface',
    pass: !uiSource.includes('buildAdvancedAnalyticsReport') &&
      !uiSource.includes('function SidebarEvidenceBox') &&
      exploreObjectSource.includes('function TemporalServiceCanvas') &&
      !pathfinderSource.includes('buildAdvancedAnalyticsReport') &&
      !pathfinderSource.includes('sidebox-analytics'),
  },
  {
    name: 'route patterns remain completely inspectable without legacy analysis caps',
    pass: !exploreObjectSource.includes('.slice(') &&
      exploreObjectSource.includes('className="temporal-rows"') &&
      appSource.includes('className="sidebar-list compact route-browser-list is-virtual"'),
  },
]

const failed = contracts.filter((contract) => !contract.pass)

if (failed.length) {
  console.error('UI contract check failed:')
  for (const contract of failed) {
    console.error(`- ${contract.name}`)
  }
  process.exit(1)
}

process.env.TZ = 'America/New_York'
const {
  buildRoutingActivity,
  localCalendarDate,
  normalizeReceivedRoutingPlan,
  routingPlanServiceDateDetail,
  routingServiceCoverageDetail,
  routingServiceDateAvailability,
  routingServiceDateOptions,
  serviceDayForCalendarDate,
} = await import('../src/app/routingContracts.ts')
const {
  routingLegDetail,
  routingLegPrimaryLabel,
  routingPlanRouteSequence,
} = await import('../src/app/presentation.ts')

assert.equal(localCalendarDate(new Date('2026-07-14T00:30:00.000Z')), '2026-07-13', 'Routing date must use the desktop calendar day, not UTC.')
assert.equal(serviceDayForCalendarDate('2026-07-13'), 'weekday')
assert.equal(serviceDayForCalendarDate('2026-07-18'), 'saturday')
assert.equal(serviceDayForCalendarDate('2026-07-19'), 'sunday')

const zeroRidePlan = {
  id: 'zero-ride',
  status: 'ready',
  travelMode: 'transit',
  timePreference: 'depart',
  maxWalkKm: 1.2,
  title: 'Transit',
  detail: 'transfer-only result',
  departMinutes: 480,
  arriveMinutes: 486,
  durationMinutes: 6,
  waitMinutes: 0,
  walkMinutes: 6,
  rideMinutes: 0,
  transfers: 0,
  origin: { coordinate: [8.54, 47.37], label: 'A', source: 'map' },
  destination: { coordinate: [8.541, 47.371], label: 'B', source: 'map' },
  legs: [{
    type: 'walk', travelMode: 'walk', walkSource: 'transfer', fromName: 'Zürich Oerlikon', toName: 'Zürich Oerlikon',
    startMinutes: 480, endMinutes: 486, durationMinutes: 6, distanceKm: 0, stopCount: 0, coordinates: [],
  }],
  diagnostics: {
    scannedDepartures: 2, relaxedStops: 3, serviceDay: 'weekday', serviceDate: '2026-07-13', scheduleMode: 'exact',
    walkingNetwork: 'osm', walkingSpeedKph: 3.8,
  },
}
const rejectedZeroRidePlan = normalizeReceivedRoutingPlan(zeroRidePlan)
assert.equal(rejectedZeroRidePlan.status, 'blocked')
assert.equal(rejectedZeroRidePlan.title, 'No scheduled ride')
assert.equal(rejectedZeroRidePlan.legs.length, 0, 'Rejected access-only geometry must not render as an itinerary.')

const validRidePlan = {
  ...zeroRidePlan,
  id: 'valid-ride',
  rideMinutes: 4,
  legs: [{
    type: 'ride', travelMode: 'transit', fromName: 'A', toName: 'B', routeShortName: 'S7',
    startMinutes: 481, endMinutes: 485, durationMinutes: 4, distanceKm: 2, stopCount: 1, coordinates: [],
  }],
}
assert.equal(normalizeReceivedRoutingPlan(validRidePlan), validRidePlan, 'A valid scheduled ride must remain untouched.')
const fallbackRidePlan = {
  ...validRidePlan,
  diagnostics: {
    ...validRidePlan.diagnostics,
    requestedServiceDate: '2026-07-13',
    resolvedServiceDate: '2025-12-22',
    serviceDateFallbackApplied: true,
  },
}
assert.equal(routingPlanServiceDateDetail(fallbackRidePlan, '2026-07-13'), '2025-12-22 timetable · fallback from 2026-07-13')
assert.equal(routingPlanServiceDateDetail(validRidePlan, '2026-07-13'), '2026-07-13 exact service date')

const serviceCoverage = {
  schemaVersion: 'vigo.routing.service-coverage.v1',
  scopeCount: 2,
  completeStartDate: '2025-06-29',
  completeEndDate: '2025-12-27',
  scopes: [
    { id: 'bus', startDate: '2025-06-29', endDate: '2025-12-27' },
    { id: 'rail', startDate: '2025-01-01', endDate: '2026-12-31' },
  ],
}
assert.equal(routingServiceDateAvailability(serviceCoverage, '2025-12-23'), 'covered')
assert.equal(routingServiceDateAvailability(serviceCoverage, '2026-07-14'), 'outside')
assert.equal(routingServiceDateAvailability(null, '2026-07-14'), 'unknown')
assert.equal(routingServiceCoverageDetail(serviceCoverage), 'all 2 feeds overlap from 2025-06-29 through 2025-12-27.')
assert.deepEqual(
  routingServiceDateOptions(serviceCoverage, '2025-12-14', [
    { date: '2025-12-13', relation: 'earlier', recommended: true },
    { date: '2025-12-15', relation: 'later', recommended: false },
  ]),
  [
    { date: '2025-12-13', relation: 'earlier', recommended: true, label: 'Recommended · Dec 13' },
    { date: '2025-12-15', relation: 'later', recommended: false, label: 'Later · Dec 15' },
  ],
  'The chooser must prefer exact fully-covered service dates and must not repeat an incomplete requested date.',
)
assert.deepEqual(
  routingServiceDateOptions(serviceCoverage, '2026-07-14'),
  [
    { date: '2025-12-23', relation: 'nearest', label: 'Nearest · Dec 23' },
    { date: '2025-12-16', relation: 'earlier', label: 'Earlier · Dec 16' },
  ],
  'Fallback choices should be local, deterministic, and preserve the requested weekday.',
)
assert.deepEqual(
  routingServiceDateOptions(serviceCoverage, '2025-06-24'),
  [
    { date: '2025-07-01', relation: 'nearest', label: 'Nearest · Jul 1' },
    { date: '2025-07-08', relation: 'later', label: 'Later · Jul 8' },
  ],
)

const routingActivityBase = {
  routingError: '',
  routingPlan: null,
  storeBackedRouting: true,
  routingStoreReady: false,
  hasOrigin: false,
  hasDestination: false,
  routingStreetState: 'ready',
  routingLoading: false,
  routingInputReady: false,
  routingServiceDate: '2026-07-13',
}
assert.equal(buildRoutingActivity(routingActivityBase).title, 'Opening SQLite timetable')
assert.equal(buildRoutingActivity({ ...routingActivityBase, routingStoreReady: true, hasOrigin: true, hasDestination: true, routingStreetState: 'loading' }).title, 'Preparing street snapshot')
assert.equal(buildRoutingActivity({ ...routingActivityBase, routingStoreReady: true, hasOrigin: true, hasDestination: true, routingInputReady: true }).title, 'Finding exact journey')
assert.equal(buildRoutingActivity({
  ...routingActivityBase,
  routingStoreReady: true,
  routingServiceDateAvailability: 'outside',
  routingServiceCoverage: serviceCoverage,
}).title, 'Date outside timetable')
const dominantWalkPlan = {
  ...zeroRidePlan,
  id: 'dominant-walk',
  travelMode: 'walk',
  title: 'Walk instead',
  detail: '1 min / direct OSM walk',
  durationMinutes: 1,
  walkMinutes: 1,
  arriveMinutes: 481,
  legs: [{
    type: 'walk', travelMode: 'walk', walkSource: 'osm', fromName: 'A', toName: 'B',
    startMinutes: 480, endMinutes: 481, durationMinutes: 1, distanceKm: 0.06, stopCount: 0,
    coordinates: [[8.54, 47.37], [8.541, 47.371]],
  }],
}
const dominantWalkActivity = buildRoutingActivity({ ...routingActivityBase, routingPlan: dominantWalkPlan })
assert.equal(dominantWalkActivity.title, 'Walk instead')
assert.equal(dominantWalkActivity.detail, '1 min / direct OSM walk', 'A backend-selected walk should explain the OSM route instead of pretending it uses a timetable date.')

const stationConnection = zeroRidePlan.legs[0]
assert.equal(routingLegPrimaryLabel(stationConnection), 'Change at Zürich Oerlikon')
assert.match(routingLegDetail(stationConnection), /6m station connection/)
const sameRouteVehicleChange = { ...stationConnection, transferAction: 'same-route-change', connectingRouteShortName: 'S3' }
assert.equal(routingLegPrimaryLabel(sameRouteVehicleChange), 'Change to another S3 at Zürich Oerlikon')
assert.match(routingLegDetail(sameRouteVehicleChange), /new vehicle on the same public line/)
assert.equal(routingPlanRouteSequence(zeroRidePlan), 'No scheduled ride')

await import('./check-workspace-deep-clean.mjs')

console.log(`UI contract check passed (${contracts.length} contracts).`)
