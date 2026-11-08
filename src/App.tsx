import { lazy, Suspense } from 'react'
import { RouteSurface } from './components/studio/RouteSurface'
import { ProjectDialog, RoutingDetail, RuntimeAlert, SetupDialog, StudioTopbar } from './components/studio/StudioShell'
import { VigoSidebar } from './components/studio/StudioSidebar'

import './App.css'
import { publicRouting } from './app/publicRouting'
import { hasOperationsData } from './app/projectState'
import { countRender } from './app/renderCounts'
import { classNames } from './domain'
import { city } from './state/city'
import { useStudioRecord } from './state/hooks'
import { network } from './state/network'
import { routingDetailOpen } from './state/route'
import { StudioRuntime } from './state/runtime'
import { isProjectEmpty, selectedProject, storageRecoveryRequired } from './state/scope'
import { shell } from './state/shell'

// Library, data and network views load on first use; the public planner needs none of them.
const cityWorkspace = () => import('./components/studio/CityWorkspace')
const CityLibraryPage = lazy(() => cityWorkspace().then(module => ({ default: module.CityLibraryPage })))
const CityStart = lazy(() => cityWorkspace().then(module => ({ default: module.CityStart })))
const CityWorkspace = lazy(() => cityWorkspace().then(module => ({ default: module.CityWorkspace })))
const LibraryRecovery = lazy(() => cityWorkspace().then(module => ({ default: module.LibraryRecovery })))
const NetworkWorkspace = lazy(() => import('./components/studio/NetworkWorkspace').then(module => ({ default: module.NetworkWorkspace })))

/**
 * Studio's frame. Each workspace owns its state in a store and its panels
 * read their own slices, so this shell re-renders only when the layout
 * changes: the page, the workspace, or a panel opening over the map.
 */
export default function App() {
  countRender('App')
  const layout = useStudioRecord(() => {
    const { appearance, accent, page, activeRouteTool, dataSection, publicPanelExpanded } = shell.get()
    const project = selectedProject()
    return {
      appearance,
      publicPanelExpanded,
      accent,
      page,
      activeRouteTool,
      dataSection,
      agencyMapOpen: network.get().agencyMapOpen,
      projectEmpty: isProjectEmpty(),
      routingDetailOpen: routingDetailOpen(),
      storageRecovery: storageRecoveryRequired() && Boolean(shell.get().runtimeConfig),
      cityData: hasOperationsData(project),
      networkOpened: city.get().openedNetworkProjectId === project.id,
    }
  })
  const { page, activeRouteTool: tool } = layout
  const hasStage = page === 'project' && tool !== 'data' && !layout.projectEmpty && !layout.storageRecovery
  const settingsOpen = page === 'project' && tool === 'data' && layout.dataSection === 'preferences'

  return (
    <main className={classNames('app-shell', publicRouting && 'public-app', layout.publicPanelExpanded && 'public-panel-expanded', `appearance-${layout.appearance}`, `accent-${layout.accent}`, `page-${page}`, layout.projectEmpty && 'project-empty', hasStage && 'has-stage', page === 'project' && tool === 'data' && 'view-data', tool === 'agency' && 'view-agency', layout.agencyMapOpen && 'agency-map-open', layout.routingDetailOpen && 'routing-detail-open')}>
      <StudioTopbar />
      <RuntimeAlert />

      <div className="shell-body">
        {page === 'projects' ? null : <VigoSidebar hasCityData={layout.cityData} />}

        <div className="app-frame">
          <Suspense fallback={null}>
          {layout.storageRecovery && !settingsOpen ? <LibraryRecovery />
            : page === 'projects' ? publicRouting ? <p role="status">Opening routing…</p> : <CityLibraryPage />
              : tool === 'data' ? <CityWorkspace />
                : !layout.cityData || !layout.networkOpened ? <CityStart /> : (
                  <div className="workbench project-workbench route-investigation-shell">
                    <RouteSurface />
                    {tool === 'agency' ? <Suspense fallback={null}><NetworkWorkspace /></Suspense> : null}
                  </div>
                )}
          </Suspense>
        </div>
        <RoutingDetail />
      </div>

      {publicRouting ? null : <><ProjectDialog /><SetupDialog /></>}
      {/* Background work runs after the panels' effects, as App's own effects did. */}
      <StudioRuntime />
    </main>
  )
}
