import { startTransition, useEffect, useLayoutEffect } from 'react'
import { apiJson } from '../app/api'
import { subscribeDesktopCommands, syncDesktopChromeState } from '../app/desktopBridge'
import { mergeGtfsRouteAnalysis, routeHasCompleteGtfsAnalysis } from '../app/gtfsAnalysis'
import { rememberRoute } from '../app/navigationMemory'
import type { NetworkScheduleResult } from '../app/networkScheduleCollection'
import { findNetworkRoute, findNetworkStop } from '../app/networkSelection'
import { startPolling } from '../app/polling'
import type { PreparationTask } from '../app/preparation'
import { bundleFeedId, needsProjectDetail } from '../app/projectState'
import { realtimeRefreshMs } from '../app/realtime'
import { saveRoutingDataModePreference } from '../app/routingDataMode'
import { scenarioStorageKey } from '../app/scenarioDraftStorage'
import { shallowEqual, useStore } from '../app/store'
import { openCityDataGroups, resetCityDataGroups } from '../app/useCityDataGroups'
import { useNationalRouting } from '../app/useNationalRouting'
import { useReachInspection } from '../app/useReachInspection'
import { useScenarioDrafts } from '../app/useScenarioDrafts'
import { useStreetPreparation } from '../app/useStreetPreparation'
import { quietMapLabel } from '../components/studio/presentation'
import { formatNumber } from '../domain'
import { scenarioStopsForRoute } from '../reach'
import {
  activeScenarioChange,
  analyze,
  cityGroupsValue,
  comparisonFeedOptions,
  invalidateAnalyzeResult,
  reachInputIdentity,
  resetAnalyze,
  retainComparisonFeeds,
} from './analyze'
import { city, refreshImportedProject, resetCity, routingMerge, setActiveFeedId, setOsmStreetMessage, updatePendingPreparations, updateProjects } from './city'
import { changeServiceDate, clock, resetClock, serviceDay } from './clock'
import { useStudio, useStudioRecord, usePublish } from './hooks'
import { beginCitySelection, handleCityShortcut, handleDesktopCommand, loadProjects } from './navigation'
import {
  loadGtfsRouteAnalysis,
  network,
  refreshRealtimeRequest,
  resetNetwork,
  scheduleLoadRequests,
  scheduleRequestsKey,
  selectedRoute,
} from './network'
import { followActivePreparationJobs, registerStreetRetry, resetPreparation, syncImportFlags, waitForImportJob } from './preparation'
import { registerRouteEngineReset, resetRoute, route, routeDateAlignment, routingStreetState } from './route'
import { resetScenarioDrafts, scenarioDrafts, scenarioDraftSetters } from './scenarios'
import { activePreparationJobIds, importJobs, isProjectEmpty, preview, routingScope, selectedProject } from './scope'
import { navigation, resetShell, routeToolStorageKey, setApiError, shell } from './shell'

/**
 * Studio's background work: requests, leases, polling and document sync. Each
 * runtime subscribes only to the inputs its effects need and renders nothing,
 * so this work never re-renders the map or the panels.
 */
export function StudioRuntime() {
  return (
    <>
      <ShellRuntime />
      <CityRuntime />
      <NetworkRuntime />
      <RouteRuntime />
      <AnalyzeRuntime />
      <StudioLifetime />
    </>
  )
}

/**
 * A remounted Studio starts from its initial state, as a remounted App did.
 * Rendered last, so the reset follows every other runtime's cleanup.
 */
function StudioLifetime() {
  useEffect(() => resetStudio, [])
  return null
}

/** Return every store to its initial state and cancel this Studio's requests. */
function resetStudio() {
  resetCity()
  resetNetwork()
  resetRoute()
  resetAnalyze()
  resetPreparation()
  resetScenarioDrafts()
  resetCityDataGroups()
  resetClock()
  resetShell()
}

function scrollWorkbenchToTop() {
  requestAnimationFrame(() => {
    document.querySelector('.workbench')?.scrollTo({ top: 0, left: 0, behavior: 'smooth' })
  })
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

function ShellRuntime() {
  const appearance = useStore(shell, (state) => state.appearance)
  const accent = useStore(shell, (state) => state.accent)
  const page = useStore(shell, (state) => state.page)
  const activeRouteTool = useStore(shell, (state) => state.activeRouteTool)
  const sidebarCollapsed = useStore(shell, (state) => state.sidebarCollapsed)
  const projectEmpty = useStudio(isProjectEmpty)
  const chrome = useStudioRecord(() => {
    const project = selectedProject()
    return {
      title: page === 'projects' ? 'Cities' : quietMapLabel(project.name),
      canGoForward: page === 'projects' && city.get().projects.some((entry) => entry.id === project.id),
    }
  })

  useEffect(() => {
    document.documentElement.dataset.appearance = appearance
    document.documentElement.style.colorScheme = appearance
  }, [appearance])

  useEffect(() => {
    syncDesktopChromeState({
      appearance,
      title: chrome.title,
      sidebarAvailable: page === 'project' && !projectEmpty,
      sidebarCollapsed,
      canGoBack: page === 'project',
      canGoForward: chrome.canGoForward,
    })
  }, [appearance, chrome, projectEmpty, page, sidebarCollapsed])

  useEffect(() => subscribeDesktopCommands(handleDesktopCommand), [])

  useEffect(() => {
    if (page !== 'project' || projectEmpty) shell.set({ sidebarCollapsed: false })
  }, [projectEmpty, page])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
    return () => window.cancelAnimationFrame(frame)
  }, [sidebarCollapsed])

  useEffect(() => {
    document.documentElement.dataset.accent = accent
  }, [accent])

  useEffect(() => {
    sessionStorage.setItem(routeToolStorageKey, activeRouteTool)
  }, [activeRouteTool])

  useEffect(() => {
    void loadProjects()
  }, [])

  useEffect(() => {
    if (page === 'project') scrollWorkbenchToTop()
  }, [page])

  useEffect(() => {
    window.addEventListener('keydown', handleCityShortcut)
    return () => window.removeEventListener('keydown', handleCityShortcut)
  }, [])

  return null
}

function CityRuntime() {
  const project = useStudio(selectedProject)
  const page = useStore(shell, (state) => state.page)
  const activeRouteTool = useStore(shell, (state) => state.activeRouteTool)
  const dataSection = useStore(shell, (state) => state.dataSection)
  const activeFeedId = useStore(city, (state) => state.activeFeedId)
  const cityPreviewLoadingProjectId = useStore(city, (state) => state.cityPreviewLoadingProjectId)
  const isOsmImporting = useStore(city, (state) => state.isOsmImporting)
  const routingMergeRetryNonce = useStore(city, (state) => state.routingMergeRetryNonce)
  const routingMode = useStore(route, (state) => state.routingMode)
  const serviceDate = useStore(clock, (state) => state.serviceDate)
  const { readyBundleFeedCount, routingMergeSourceIdentity } = useStudio(routingScope)

  const street = useStreetPreparation({
    active: page === 'project' && activeRouteTool !== 'data' && project.osmStreetIndex?.status === 'ready' && !isOsmImporting,
    projectId: project.id,
    identity: `${project.osmStreetIndex?.builtAt ?? ''}:${project.osmStreetIndex?.bytes ?? ''}`,
    refreshKey: activeRouteTool === 'pathfinder' ? routingMode : '',
    prepareDrive: activeRouteTool === 'pathfinder' && routingMode === 'drive',
  })
  usePublish(city, 'streetPreparation', { task: street.task, walkReady: street.walkReady, ready: street.ready, error: street.error })
  useEffect(() => registerStreetRetry(street.retry), [street.retry])

  // Scenario drafts follow the selected City; feed groups follow its scenario scope.
  const draftKey = useStudio(() => scenarioStorageKey(city.get().projects.find((entry) => entry.id === city.get().selectedProjectId)))
  useScenarioDrafts(draftKey)
  const cases = useStore(scenarioDrafts, (state) => state.value.cases)
  useLayoutEffect(() => { openCityDataGroups(project, scenarioStorageKey(project), cases) })

  const jobs = useStudioRecord(() => ({
    ...importJobs(),
    gtfsImportJobId: city.get().gtfsImportJobId,
    osmImportJobId: city.get().osmImportJobId,
  }))
  useEffect(syncImportFlags, [jobs])

  useEffect(() => {
    const street = project.osmStreetIndex
    if (street?.status === 'ready') {
      setOsmStreetMessage(street.schemaVersion === 'vigo.street.store.v6'
        ? `${street.fileName} indexed / ${formatNumber(street.edgeCount)} walk + ${formatNumber(street.driveEdgeCount ?? 0)} drive edges`
        : `${street.fileName} indexed / ${formatNumber(street.edgeCount)} walk edges / rebuild for Drive`)
    } else if (street?.status === 'building') {
      setOsmStreetMessage(`${street.fileName} / building SQLite street index`)
    } else {
      setOsmStreetMessage('')
    }
  }, [project.osmStreetIndex])

  // Several ready feeds route through one combined store, built on demand.
  const routingStoreStatus = project.routingStore?.status
  useEffect(() => {
    if (
      page !== 'project'
      || activeRouteTool === 'data' && dataSection === 'preferences'
      || activeFeedId !== bundleFeedId
      || readyBundleFeedCount < 2
      || routingStoreStatus === 'ready'
      || !routingMergeSourceIdentity
    ) return
    const projectId = project.id
    const requestKey = `${projectId}:${routingMergeSourceIdentity}`
    if (routingMerge.requestKey === requestKey) return
    routingMerge.requestKey = requestKey
    let cancelled = false
    void apiJson<{ job: { id: string; status?: string } }>(
      `/api/projects/${encodeURIComponent(projectId)}/national-routing-merge`,
      {
        method: 'POST',
        body: JSON.stringify({
          preloadServiceDate: serviceDate,
          preloadServiceDay: serviceDay(),
        }),
      },
    ).then(async ({ job }) => {
      if (cancelled) return
      await refreshImportedProject(projectId, false)
      if (job.status !== 'complete') {
        await waitForImportJob(projectId, job.id, () => {}, 'Combined GTFS routing build failed')
      }
      if (!cancelled) await refreshImportedProject(projectId, true)
    }).catch((error) => {
      if (cancelled) return
      const message = error instanceof Error ? error.message : 'Combined GTFS routing build failed'
      if (/already has a GTFS import in progress|At least two ready GTFS feeds/i.test(message)) return
      setApiError(message)
    })
    return () => {
      cancelled = true
    }
    // The project object changes with every job tick; its id and store status are the inputs.
  }, [activeFeedId, activeRouteTool, dataSection, page, readyBundleFeedCount, routingMergeSourceIdentity, serviceDate, project.id, routingStoreStatus, routingMergeRetryNonce])

  useEffect(() => {
    if (activeRouteTool === 'data' && dataSection === 'preferences') return
    const current = selectedProject()
    if (page !== 'project' || !current.id || !needsProjectDetail(current)) return
    if (cityPreviewLoadingProjectId === current.id) return
    beginCitySelection(current.id)
  }, [page, activeRouteTool, dataSection, project.id, cityPreviewLoadingProjectId])

  useEffect(() => {
    if (activeFeedId !== bundleFeedId && !project.feeds.some((feed) => feed.id === activeFeedId)) {
      setActiveFeedId(bundleFeedId)
    }
  }, [activeFeedId, project])

  const activeJobIds = useStudio(activePreparationJobIds)
  useEffect(followActivePreparationJobs, [activeJobIds, project.id])


  return null
}

function NetworkRuntime() {
  const projectId = useStudio(() => selectedProject().id)
  const projectName = useStudio(() => selectedProject().name)
  const currentPreview = useStudio(preview)
  const focusedRoute = useStudio(selectedRoute)
  const page = useStore(shell, (state) => state.page)
  const activeRouteTool = useStore(shell, (state) => state.activeRouteTool)
  const activeFeedId = useStore(city, (state) => state.activeFeedId)
  const cityPreviewLoading = useStore(city, (state) => Boolean(state.cityPreviewLoadingProjectId))
  const serviceDate = useStore(clock, (state) => state.serviceDate)
  const { mapScope, vehicleMode, selectedRouteId, selectedStopId, realtimeRequest, scheduleLoadRequest, scheduleLoadRetry } = useStore(network, (state) => ({
    mapScope: state.mapScope,
    vehicleMode: state.vehicleMode,
    selectedRouteId: state.selectedRouteId,
    selectedStopId: state.selectedStopId,
    realtimeRequest: state.realtimeRequest,
    scheduleLoadRequest: state.scheduleLoadRequest,
    scheduleLoadRetry: state.scheduleLoadRetry,
  }), shallowEqual)
  const requestsKey = useStudio(scheduleRequestsKey)

  // Network shows a full day of scheduled vehicles; load every route's day at once.
  useEffect(() => {
    if (page !== 'project' || activeRouteTool !== 'agency' || vehicleMode !== 'schedule') return
    const requests = (JSON.parse(requestsKey) as Array<{ feedId: string; routeId: string }>).filter((request) => request.feedId)
    if (!requests.length) return
    const key = JSON.stringify([projectId, serviceDate, requestsKey])
    network.set(({ scheduleLoadRequest: current }) => ({
      scheduleLoadRequest: current?.key === key ? current : { key, projectId, label: projectName, serviceDate, requests },
    }))
  }, [page, activeRouteTool, vehicleMode, projectId, projectName, serviceDate, requestsKey])

  useEffect(() => {
    if (!scheduleLoadRequest || scheduleLoadRequest.projectId !== projectId) return
    const { label, requests } = scheduleLoadRequest
    const requestProjectId = scheduleLoadRequest.projectId
    const requestServiceDate = scheduleLoadRequest.serviceDate
    const controller = new AbortController()
    const taskKey = `${requestProjectId}:vehicle-schedules`
    scheduleLoadRequests.set(taskKey, scheduleLoadRequest)
    const task: PreparationTask = { id: taskKey, kind: 'vehicle-schedules', label: `${label} · ${requestServiceDate}`, status: 'running', progress: 0,
      work: { completed: 0, total: requests.length, unit: 'routes' }, phase: 'Loading full-day schedules', createdAt: new Date().toISOString() }
    updatePendingPreparations((current) => ({ ...current, [taskKey]: task }))
    network.set({ scheduleLoadStatus: task.phase || '' })
    const worker = new Worker(new URL('../app/networkSchedules.worker.ts', import.meta.url), { type: 'module' })
    const fail = (error: string) => {
      if (controller.signal.aborted) return
      worker.terminate()
      network.set({ scheduleLoadStatus: 'Schedule loading failed' })
      updatePendingPreparations((current) => ({ ...current, [taskKey]: { ...task, status: 'failed', error } }))
    }
    worker.onerror = () => fail('The background schedule worker could not finish. Retry loading.')
    worker.onmessage = (event: MessageEvent<{ type: string; completed: number; failures: number; results?: NetworkScheduleResult[]; error?: string }>) => {
      if (controller.signal.aborted) return
      const { type, completed, failures, results } = event.data
      if (type === 'error') { fail(event.data.error || 'Could not load vehicle schedules.'); return }
      const done = type === 'complete'
      const phase = !done ? 'Loading full-day schedules'
        : failures ? `${failures} route schedules unavailable; ${completed - failures} loaded` : `Full-day schedule ready · ${completed} routes`
      // No partial timetable enters project/map state. Publish the entire day once.
      if (done && results) {
        startTransition(() => updateProjects((current) => controller.signal.aborted ? current : current.map((project) => project.id === requestProjectId
          ? results.reduce((next, result) => mergeGtfsRouteAnalysis(next, result.feedId, result.analysis), project) : project)))
        worker.terminate()
      }
      network.set({ scheduleLoadStatus: phase })
      updatePendingPreparations((current) => ({ ...current, [taskKey]: { ...task, phase, progress: completed / requests.length,
        work: { completed, total: requests.length, unit: 'routes' }, updatedAt: new Date().toISOString(),
        status: !done ? 'running' : failures ? 'failed' : 'complete' } }))
    }
    worker.postMessage({ endpoint: new URL(`/api/projects/${encodeURIComponent(requestProjectId)}/gtfs-route-analysis`, window.location.href).href, requests, serviceDate: requestServiceDate })
    return () => {
      controller.abort()
      worker.terminate()
      updatePendingPreparations((current) => current[taskKey]?.createdAt === task.createdAt && current[taskKey]?.status === 'running'
        ? { ...current, [taskKey]: { ...current[taskKey], status: 'cancelled', phase: 'Schedule loading cancelled' } } : current)
    }
  }, [scheduleLoadRequest, projectId, scheduleLoadRetry])

  // A focused route in Network shows every pattern; load its full analysis.
  useEffect(() => {
    const needsRouteDetail = activeRouteTool === 'agency' && mapScope === 'route'
    if (page !== 'project' || !needsRouteDetail || !focusedRoute) return
    if (routeHasCompleteGtfsAnalysis(focusedRoute, currentPreview, serviceDate)) return
    void loadGtfsRouteAnalysis(focusedRoute, focusedRoute.id)
  }, [activeFeedId, activeRouteTool, mapScope, page, currentPreview, serviceDate, projectId, focusedRoute])

  // Drop a selection the scoped preview no longer contains.
  useEffect(() => {
    if (cityPreviewLoading || projectId === '__empty_city__') return
    if (selectedRouteId && !findNetworkRoute(currentPreview.routes, selectedRouteId)) {
      network.set({ selectedRouteId: '' })
      navigation.memory = rememberRoute(projectId, '')
    }
    if (activeRouteTool !== 'agency' && selectedStopId && !findNetworkStop(currentPreview.stops, selectedStopId)) network.set({ selectedStopId: '' })
  }, [currentPreview, projectId, selectedRouteId, selectedStopId, cityPreviewLoading, activeRouteTool])

  // Live feeds refresh in the background while a City is open.
  const selectedProjectId = useStore(city, (state) => state.selectedProjectId)
  useEffect(() => {
    if (!realtimeRequest || page !== 'project') return
    const polling = startPolling(
      (signal) => refreshRealtimeRequest(realtimeRequest, { background: true, signal }),
      realtimeRefreshMs,
      { immediate: false },
    )
    return polling.stop
  }, [page, realtimeRequest, selectedProjectId])


  return null
}

function RouteRuntime() {
  const page = useStore(shell, (state) => state.page)
  const activeRouteTool = useStore(shell, (state) => state.activeRouteTool)
  const project = useStudioRecord(() => {
    const current = selectedProject()
    return { id: current.id, streetKey: `${current.osmStreetIndex?.builtAt ?? ''}:${current.osmStreetIndex?.bytes ?? ''}` }
  })
  const { nationalRoutingFeed, nationalRoutingStoreKey } = useStudio(routingScope)
  const { serviceDate, scheduleTimeMinutes } = useStore(clock, (state) => state, shallowEqual)
  const settings = useStore(route, (state) => ({
    routingOrigin: state.routingOrigin,
    routingWaypoints: state.routingWaypoints,
    routingDestination: state.routingDestination,
    routingMode: state.routingMode,
    routingDataMode: state.routingDataMode,
    routingTimePreference: state.routingTimePreference,
    routingMaxWalkKm: state.routingMaxWalkKm,
    routingMaxTransfers: state.routingMaxTransfers,
    routingAllowLongWalk: state.routingAllowLongWalk,
    routingAllowStreetTransfers: state.routingAllowStreetTransfers,
    routingMinimumTransferBufferMinutes: state.routingMinimumTransferBufferMinutes,
    routingDepartureWindowMinutes: state.routingDepartureWindowMinutes,
    routingResidencyCoverage: state.routingResidencyCoverage,
    selectedRoutingPlanId: state.selectedRoutingPlanId,
  }), shallowEqual)
  const realtimeSnapshot = useStore(network, (state) => state.realtimeSnapshot)
  const routeAllowed = useStudio(() => routingStreetState() === 'ready')
  const routingServiceDay = serviceDay()

  const engine = useNationalRouting({
    active: Boolean(page === 'project' && nationalRoutingFeed && activeRouteTool === 'pathfinder'),
    projectId: project.id,
    feedId: nationalRoutingFeed?.id ?? '',
    storeKey: nationalRoutingStoreKey,
    streetKey: project.streetKey,
    origin: settings.routingOrigin,
    waypoints: settings.routingWaypoints,
    destination: settings.routingDestination,
    mode: settings.routingMode,
    routingDataMode: settings.routingDataMode,
    departMinutes: scheduleTimeMinutes,
    timePreference: settings.routingTimePreference,
    serviceDay: routingServiceDay,
    serviceDate,
    maxWalkKm: settings.routingMaxWalkKm,
    maxTransfers: settings.routingMaxTransfers,
    allowLongWalk: settings.routingAllowLongWalk,
    allowStreetTransfers: settings.routingAllowStreetTransfers,
    minimumTransferBufferMinutes: settings.routingMinimumTransferBufferMinutes,
    departureWindowMinutes: settings.routingDepartureWindowMinutes,
    realtimeSnapshot,
    routeAllowed,
  })
  usePublish(route, 'engine', {
    choices: engine.choices,
    loading: engine.loading,
    alternativesLoading: engine.alternativesLoading,
    error: engine.error,
    errorStatus: engine.errorStatus,
    ready: engine.ready,
    serviceCoverage: engine.serviceCoverage,
    serviceDateAvailability: engine.serviceDateAvailability,
    serviceDateOptions: engine.serviceDateOptions,
  })
  useEffect(() => registerRouteEngineReset(engine.reset), [engine.reset])

  useEffect(() => { saveRoutingDataModePreference(settings.routingDataMode) }, [settings.routingDataMode])

  // Hold the routing store resident while a workspace can route against it.
  const cityRoutingActive = page === 'project' && activeRouteTool !== 'data' && Boolean(nationalRoutingFeed)
  const feedId = nationalRoutingFeed?.id
  useEffect(() => {
    if (!cityRoutingActive || !feedId) {
      route.set({ routingResidencyCoverage: null })
      return
    }
    let active = true
    const leaseId = `desktop-surface-${crypto.randomUUID()}`
    const endpoint = `/api/projects/${encodeURIComponent(project.id)}/routing-residency`
    const request = (resident: boolean, keepalive = false) => fetch(endpoint, {
      method: 'POST',
      keepalive,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feedId,
        resident,
        leaseId,
        mode: settings.routingMode,
        routingDataMode: settings.routingDataMode,
        departNow: activeRouteTool === 'pathfinder' && settings.routingMode === 'transit' && settings.routingDataMode === 'realtime' || undefined,
        serviceDate,
        serviceDay: routingServiceDay,
      }),
    }).then((response) => response.ok ? response.json() : null).catch(() => null)
    const acquisition = request(true)
    void acquisition.then((result: {
      residency?: { serviceCoverage?: typeof settings.routingResidencyCoverage }
    } | null) => {
      if (active) route.set({ routingResidencyCoverage: result?.residency?.serviceCoverage ?? null })
    })
    return () => {
      active = false
      // Registration may still be opening a store when the view changes.
      // Release after it settles so a late acquisition cannot retain a worker.
      void acquisition.then(() => request(false, true))
    }
  }, [cityRoutingActive, feedId, project.id, serviceDate, routingServiceDay, activeRouteTool, settings.routingMode, settings.routingDataMode])

  // Analyze opens on a midweek date inside the store's complete coverage.
  const coverage = settings.routingResidencyCoverage
  useEffect(() => {
    if (activeRouteTool !== 'analyze') return
    const latest = coverage?.completeEndDate
    if (
      latest
      && (
        serviceDate < String(coverage.completeStartDate ?? latest)
        || serviceDate > latest
      )
    ) changeServiceDate(latestMidweekCoverageDate(latest))
  }, [activeRouteTool, coverage, serviceDate])

  // A newly opened store moves an uncovered date into coverage once.
  const hasJourneyPoint = Boolean(settings.routingOrigin || settings.routingDestination)
  const completeEndDate = engine.serviceCoverage?.completeEndDate
  useEffect(() => {
    if (
      !nationalRoutingStoreKey
      || (activeRouteTool === 'pathfinder' && hasJourneyPoint)
    ) return
    if (!completeEndDate || engine.serviceDateAvailability !== 'outside') return
    if (routeDateAlignment.storeKey === nationalRoutingStoreKey) return
    routeDateAlignment.storeKey = nationalRoutingStoreKey
    changeServiceDate(
      activeRouteTool === 'pathfinder'
        ? latestCoverageDateMatchingWeekday(completeEndDate, serviceDate)
        : latestMidweekCoverageDate(completeEndDate),
    )
  }, [activeRouteTool, completeEndDate, engine.serviceDateAvailability, nationalRoutingStoreKey, settings.routingDestination, settings.routingOrigin, serviceDate, hasJourneyPoint])

  useEffect(() => {
    if (settings.selectedRoutingPlanId && !engine.choices.some((plan) => plan.id === settings.selectedRoutingPlanId)) {
      route.set({ selectedRoutingPlanId: '' })
    }
  }, [engine.choices, settings.selectedRoutingPlanId])

  return null
}

function AnalyzeRuntime() {
  const page = useStore(shell, (state) => state.page)
  const activeRouteTool = useStore(shell, (state) => state.activeRouteTool)
  const selectedProjectId = useStore(city, (state) => state.selectedProjectId)
  const projectId = useStudio(() => selectedProject().id)
  const activeFeedId = useStore(city, (state) => state.activeFeedId)
  const serviceDate = useStore(clock, (state) => state.serviceDate)
  const feedId = useStudio(() => routingScope().nationalRoutingFeed?.id ?? '')
  const reachResult = useStore(analyze, (state) => state.reachResult)
  const reachComparison = useStore(analyze, (state) => state.reachComparison)
  const currentPreview = useStudio(preview)
  const change = useStudio(activeScenarioChange)

  const inspection = useReachInspection({
    active: page === 'project' && activeRouteTool === 'analyze',
    projectId: selectedProjectId, feedId,
    result: reachResult, comparison: reachComparison,
  })
  useLayoutEffect(() => {
    if (analyze.get().inspection !== inspection) analyze.set({ inspection })
  })

  // A result describes one City scope, feed group and set of inputs.
  const groups = useStudio(cityGroupsValue)
  useEffect(() => { invalidateAnalyzeResult() }, [groups])
  const inputIdentity = useStudio(reachInputIdentity)
  useEffect(() => { invalidateAnalyzeResult() }, [inputIdentity])

  const feedOptions = useStudio(comparisonFeedOptions)
  useEffect(() => { retainComparisonFeeds(feedOptions) }, [feedOptions])

  // An edited route needs its full timetable before its stops can be changed.
  const changeRouteId = change?.routeId
  useEffect(() => {
    if (page !== 'project' || activeRouteTool !== 'analyze') return
    if (!changeRouteId) return
    const scenarioRoute = currentPreview.routes.find((candidate) => (
      candidate.id === changeRouteId || candidate.patternId === changeRouteId
    ))
    if (!scenarioRoute || routeHasCompleteGtfsAnalysis(scenarioRoute, currentPreview, serviceDate)) return
    void loadGtfsRouteAnalysis(scenarioRoute, scenarioRoute.id)
  }, [changeRouteId, activeFeedId, activeRouteTool, page, currentPreview, serviceDate, projectId])

  // Replace an unedited route's provisional stops once its full pattern loads.
  useEffect(() => {
    if (page !== 'project' || activeRouteTool !== 'analyze') return
    const intervention = change
    if (!intervention?.routeId) return
    if (intervention.stops.some((stop) => stop.editStatus && stop.editStatus !== 'baseline')) return
    const scenarioRoute = currentPreview.routes.find((candidate) => (
      candidate.id === intervention.routeId || candidate.patternId === intervention.routeId
    ))
    if (!scenarioRoute?.analysisSource || scenarioRoute.analysisSource !== 'focused') return
    const currentBaselineIds = intervention.stops.map((stop) => stop.baselineStopId ?? stop.stopId)
    if (
      currentBaselineIds.length === scenarioRoute.stopIds.length
      && currentBaselineIds.every((stopId, index) => stopId === scenarioRoute.stopIds[index])
    ) return
    const nextStops = scenarioStopsForRoute(scenarioRoute, currentPreview)
    if (nextStops.length < 2) return
    const key = scenarioStorageKey(city.get().projects.find((entry) => entry.id === city.get().selectedProjectId))
    scenarioDraftSetters(key).setScenarioDrafts((current) => current.map((entry) => ({
      ...entry,
      interventions: entry.interventions.map((candidate) => (
        candidate.id === intervention.id
          && candidate.routeId === intervention.routeId
          && candidate.stops.every((stop) => !stop.editStatus || stop.editStatus === 'baseline')
          ? { ...candidate, stops: nextStops }
          : candidate
      )),
    })))
  }, [change, activeRouteTool, page, currentPreview])


  return null
}
