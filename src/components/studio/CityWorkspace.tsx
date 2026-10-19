import { memo } from 'react'
import { shallowEqual, useStore } from '../../app/store'
import { addScenario, openScenarioCase, renameScenario } from '../../state/analyze'
import { city } from '../../state/city'
import { useStudio } from '../../state/hooks'
import {
  applyCityReset,
  chooseDataFolder,
  chooseRecoveryFolder,
  confirmDeleteProject,
  loadProjects,
  openCreateProjectDialog,
  openNetworkView,
  openProject,
  openProjectData,
  openRenameProjectDialog,
  openSettingsView,
  recoverDefaultStorageRoot,
  removeProject,
} from '../../state/navigation'
import { connectRealtime, disconnectRealtime, network } from '../../state/network'
import {
  cancelGtfsImport,
  cancelOsmImport,
  handleFiles,
  handleNationalGtfsPath,
  handleNationalOsmPath,
  handleOsmFiles,
  retryGtfsImport,
  retryOsmImport,
} from '../../state/preparation'
import { scenarioLibrary } from '../../state/scenarios'
import { importJobs, selectedProject, sourceDeletionDisabled } from '../../state/scope'
import { changeAppearance, changeBasemap, setDataSection, setQuery, shell } from '../../state/shell'
import { CityPanel } from '../CityPanel'
import { CitySourceDelete } from '../CitySourceDelete'
import { ProjectsPage, StorageRecovery } from './CityLibrary'
import { CityDataSources } from './CityDataSources'
import { EmptyOperationsStart, type CityImportProps } from './CitySources'
import { quietMapLabel } from './presentation'

/** The City library: every City on this machine. */
export const CityLibraryPage = memo(function CityLibraryPage() {
  const projects = useStore(city, (state) => state.projects)
  const loadState = useStore(city, (state) => state.projectsLoadState)
  const previewLoading = useStore(city, (state) => Boolean(state.cityPreviewLoadingProjectId))
  const project = useStudio(selectedProject)
  const query = useStore(shell, (state) => state.query)
  return (
    <ProjectsPage
      projects={projects}
      loading={loadState === 'loading'}
      loadFailed={loadState === 'failed'}
      selectedProject={project}
      query={query}
      onQueryChange={setQuery}
      previewLoading={previewLoading}
      onOpenProject={openProject}
      onOpenProjectData={openProjectData}
      onOpenSettings={openSettingsView}
      onCreateProject={openCreateProjectDialog}
      onRenameProject={openRenameProjectDialog}
      onDeleteProject={confirmDeleteProject}
      onRefresh={loadProjects}
    />
  )
})

/** Shown when the configured City library folder cannot be written. */
export const LibraryRecovery = memo(function LibraryRecovery() {
  const { runtimeConfig, setupBusy, setupError } = useStore(shell, (state) => ({
    runtimeConfig: state.runtimeConfig,
    setupBusy: state.setupBusy,
    setupError: state.setupError,
  }), shallowEqual)
  if (!runtimeConfig) return null
  return (
    <StorageRecovery
      config={runtimeConfig}
      busy={setupBusy}
      error={setupError}
      onChooseFolder={chooseRecoveryFolder}
      onUseDefault={recoverDefaultStorageRoot}
      onOpenSettings={openSettingsView}
    />
  )
})

/** Source imports, live feeds and preparation status for the selected City. */
function useCityImportProps(): Omit<CityImportProps, 'staticFeeds'> {
  const project = useStudio(selectedProject)
  const deletionDisabled = useStudio(sourceDeletionDisabled)
  const { gtfsImportJob, osmImportJob } = useStudio(importJobs)
  const imports = useStore(city, (state) => ({
    isImporting: state.isImporting,
    isOsmImporting: state.isOsmImporting,
    importMessage: state.importMessage,
    osmStreetMessage: state.osmStreetMessage,
    pendingPreparations: state.pendingPreparations,
  }), shallowEqual)
  const realtime = useStore(network, (state) => ({
    realtimeSnapshot: state.realtimeSnapshot,
    realtimeMessage: state.realtimeMessage,
    realtimeRequest: state.realtimeRequest,
    isRealtimeLoading: state.isRealtimeLoading,
  }), shallowEqual)
  return {
    cityId: project.id,
    osmDelete: project.osmStreetIndex ? <CitySourceDelete key={`${project.id}:${project.osmStreetIndex.fileName}`} projectId={project.id} kind="osm" name={project.osmStreetIndex.fileName} disabled={deletionDisabled} onDeleted={applyCityReset} /> : undefined,
    isImporting: imports.isImporting,
    isOsmImporting: imports.isOsmImporting,
    gtfsJob: gtfsImportJob,
    osmJob: osmImportJob,
    importMessage: imports.importMessage,
    gtfsError: imports.pendingPreparations[`${project.id}:national-gtfs-import`]?.error,
    osmError: imports.pendingPreparations[`${project.id}:national-osm-import`]?.error,
    osmStreetReady: project.osmStreetIndex?.status === 'ready',
    osmAccessModel: project.osmStreetIndex?.terminalAccess?.model ?? 'public',
    canPrepareAuthorizedAccess: project.routingStore?.status === 'ready',
    osmStreetMessage: imports.osmStreetMessage,
    ...realtime,
    onFiles: handleFiles,
    onNationalGtfsPath: handleNationalGtfsPath,
    onNationalOsmPath: handleNationalOsmPath,
    onOsmFiles: handleOsmFiles,
    onConnectRealtime: connectRealtime,
    onDisconnectRealtime: disconnectRealtime,
    onCancelGtfs: cancelGtfsImport,
    onRetryGtfs: retryGtfsImport,
    onCancelOsm: cancelOsmImport,
    onRetryOsm: retryOsmImport,
  }
}

function CitySourcesPanel() {
  const project = useStudio(selectedProject)
  const library = useStudio(scenarioLibrary)
  const cases = library.scenarioDrafts
  const grouping = library.grouping
  const deletionDisabled = useStudio(sourceDeletionDisabled)
  const importProps = useCityImportProps()
  return (
    <CityDataSources
      project={project}
      grouping={grouping}
      cases={cases}
      deletingDisabled={deletionDisabled}
      onSourceDeleted={applyCityReset}
      onAddCase={addScenario}
      onRenameCase={renameScenario}
      onOpenCase={openScenarioCase}
      {...importProps}
    />
  )
}

/** City data and Studio settings for the selected City. */
export const CityWorkspace = memo(function CityWorkspace() {
  const project = useStudio(selectedProject)
  const { dataSection, appearance, basemap, runtimeConfig, health, setupBusy, setupError } = useStore(shell, (state) => ({
    dataSection: state.dataSection,
    appearance: state.appearance,
    basemap: state.basemap,
    runtimeConfig: state.runtimeConfig,
    health: state.health,
    setupBusy: state.setupBusy,
    setupError: state.setupError,
  }), shallowEqual)
  const projects = useStore(city, (state) => state.projects)
  return (
    <CityPanel
      section={dataSection}
      projectId={project.id}
      projectName={quietMapLabel(project.name)}
      projectRegion={project.region || 'Local City'}
      feedCount={project.summary.feeds}
      routeCount={project.summary.routes}
      stopCount={project.summary.stops}
      projectRevision={project.updatedAt}
      appearance={appearance}
      basemap={basemap}
      localBasemapAvailable={project.osmStreetIndex?.status === 'ready'}
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
      onCityRemoved={removeProject}
      feeds={<CitySourcesPanel key={project.id} />}
    />
  )
})

/** The start page for a City without indexed transit data. */
export const CityStart = memo(function CityStart() {
  const project = useStudio(selectedProject)
  const importProps = useCityImportProps()
  return <EmptyOperationsStart onOpenNetwork={openNetworkView} project={project} {...importProps} />
})
