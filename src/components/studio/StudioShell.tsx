import { ArrowLeft, XCircle } from 'lucide-react'
import { memo, useDeferredValue, useMemo } from 'react'
import type { PreparationTask } from '../../app/preparation'
import { shallowEqual, useStore } from '../../app/store'
import { SearchPalette } from '../../features/search/SearchPalette'
import { buildSearchResults } from '../../features/search/searchModel'
import { buildNetworkSearchIndex } from '../../routingUi'
import { city } from '../../state/city'
import { useStudio } from '../../state/hooks'
import {
  activateSearchResult,
  closeProjectDialog,
  closeSetup,
  openDataView,
  runCommandCenter,
  showProjects,
  submitProjectDialog,
  submitSetup,
} from '../../state/navigation'
import { reconnectPreparation } from '../../state/preparation'
import { closeRoutingDetails, routingDetailOpen, routingPlan } from '../../state/route'
import { preview, selectedProject, storageRecoveryRequired, visiblePreparationTasks } from '../../state/scope'
import { setApiError, setBackgroundTasksOpen, setQuery, shell } from '../../state/shell'
import { BackgroundTasks } from '../BackgroundTasks'
import { RoutingDetailPanel } from '../PathfinderPanel'
import { FirstRunSetupDialog, ProjectEditorDialog } from '../ProjectDialogs'
import { IconButton, VigoBrandMark } from '../UiPrimitives'
import { quietMapLabel } from './presentation'

const reconnectTask = (task: PreparationTask) => { void reconnectPreparation(task) }
const dismissApiError = () => setApiError('')

/** Search for Cities, routes, stops and commands, or type a journey. */
const StudioSearch = memo(function StudioSearch() {
  const query = useStore(shell, (state) => state.query)
  const recentIds = useStore(shell, (state) => state.recentSearchIds)
  const projects = useStore(city, (state) => state.projects)
  const currentPreview = useStudio(preview)
  const deferredQuery = useDeferredValue(query)
  const networkSearchIndex = useMemo(() => buildNetworkSearchIndex(currentPreview), [currentPreview])
  const results = useMemo(() => buildSearchResults({
    query: deferredQuery,
    preview: currentPreview,
    networkSearchIndex,
    projects,
    recentIds,
  }), [deferredQuery, networkSearchIndex, currentPreview, projects, recentIds])
  return <SearchPalette value={query} results={results} onChange={setQuery} onActivate={activateSearchResult} onSubmit={runCommandCenter} />
})

const StudioBackgroundTasks = memo(function StudioBackgroundTasks() {
  const tasks = useStudio(visiblePreparationTasks)
  const open = useStore(shell, (state) => state.backgroundTasksOpen)
  return <BackgroundTasks tasks={tasks} open={open} onOpenChange={setBackgroundTasksOpen} onOpenData={openDataView} onReconnect={reconnectTask} />
})

export const StudioTopbar = memo(function StudioTopbar() {
  const page = useStore(shell, (state) => state.page)
  const projectId = useStudio(() => selectedProject().id)
  const tool = useStore(shell, state => state.activeRouteTool)
  const title = useStudio(() => {
    const { activeRouteTool, dataSection } = shell.get()
    return shell.get().page === 'projects'
      ? 'Cities'
      : activeRouteTool === 'data' && dataSection === 'preferences' ? 'Settings' : quietMapLabel(selectedProject().name)
  })
  return (
    <header className="topbar">
      <div className="topbar-brand" aria-label="City header">
        <button type="button" className="topbar-mark-button" onClick={showProjects} title="Open Cities" aria-label="Open Cities">
          <VigoBrandMark />
        </button>
        <div className="topbar-brand-copy">
          <b>{title}</b>
          {page === 'project' && tool !== 'data' ? <span className="topbar-crumb">{tool === 'pathfinder' ? 'Route' : tool === 'analyze' ? 'Analyze' : 'Network'}</span> : null}
        </div>
      </div>

      <StudioSearch />

      <div className="topbar-actions">
        {page === 'project' ? <StudioBackgroundTasks key={projectId} /> : null}
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
  )
})

export const RuntimeAlert = memo(function RuntimeAlert() {
  const apiError = useStore(shell, (state) => state.apiError)
  const recoveryRequired = useStudio(storageRecoveryRequired)
  return apiError && !recoveryRequired ? (
    <div className="runtime-alert" role="alert">
      <span>{apiError}</span>
      <IconButton label="Dismiss runtime error" onClick={dismissApiError}>
        <XCircle size={15} />
      </IconButton>
    </div>
  ) : null
})

/** The selected journey's legs, floating over the Route map. */
export const RoutingDetail = memo(function RoutingDetail() {
  const open = useStudio(routingDetailOpen)
  const plan = useStudio(routingPlan)
  return open && plan ? <RoutingDetailPanel plan={plan} onClose={closeRoutingDetails} /> : null
})

export const ProjectDialog = memo(function ProjectDialog() {
  const { projectDialog, projectDialogBusy, projectDialogError } = useStore(shell, (state) => ({
    projectDialog: state.projectDialog,
    projectDialogBusy: state.projectDialogBusy,
    projectDialogError: state.projectDialogError,
  }), shallowEqual)
  return (
    <ProjectEditorDialog
      state={projectDialog}
      busy={projectDialogBusy}
      error={projectDialogError}
      onClose={closeProjectDialog}
      onSubmit={submitProjectDialog}
    />
  )
})

export const SetupDialog = memo(function SetupDialog() {
  const { setupOpen, runtimeConfig, setupBusy, setupError } = useStore(shell, (state) => ({
    setupOpen: state.setupOpen,
    runtimeConfig: state.runtimeConfig,
    setupBusy: state.setupBusy,
    setupError: state.setupError,
  }), shallowEqual)
  return (
    <FirstRunSetupDialog
      open={setupOpen}
      config={runtimeConfig}
      busy={setupBusy}
      error={setupError}
      onClose={closeSetup}
      onSubmit={submitSetup}
    />
  )
})
