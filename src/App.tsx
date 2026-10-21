import { CityLibraryPage, CityStart, CityWorkspace, LibraryRecovery } from './components/studio/CityWorkspace'
import { NetworkWorkspace } from './components/studio/NetworkWorkspace'
import { RouteSurface } from './components/studio/RouteSurface'
import { ProjectDialog, RoutingDetail, RuntimeAlert, SetupDialog, StudioTopbar } from './components/studio/StudioShell'
import { VigoSidebar } from './components/studio/StudioSidebar'

import './App.css'
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

/**
 * Studio's frame. Each workspace owns its state in a store and its panels
 * read their own slices, so this shell re-renders only when the layout
 * changes: the page, the workspace, or a panel opening over the map.
 */
export default function App() {
  countRender('App')
  const layout = useStudioRecord(() => {
    const { appearance, accent, page, activeRouteTool, dataSection, sidebarCollapsed } = shell.get()
    const project = selectedProject()
    return {
      appearance,
      accent,
      page,
      activeRouteTool,
      dataSection,
      sidebarCollapsed,
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
    <main className={classNames('app-shell', `appearance-${layout.appearance}`, `accent-${layout.accent}`, `page-${page}`, layout.projectEmpty && 'project-empty', hasStage && 'has-stage', page === 'project' && tool === 'data' && 'view-data', tool === 'agency' && 'view-agency', layout.agencyMapOpen && 'agency-map-open', layout.routingDetailOpen && 'routing-detail-open', layout.sidebarCollapsed && 'desktop-sidebar-collapsed')}>
      <StudioTopbar />
      <RuntimeAlert />

      <div className="shell-body">
        {page === 'projects' ? null : <VigoSidebar />}

        <div className="app-frame">
          {layout.storageRecovery && !settingsOpen ? <LibraryRecovery />
            : page === 'projects' ? <CityLibraryPage />
              : tool === 'data' ? <CityWorkspace />
                : !layout.cityData || !layout.networkOpened ? <CityStart /> : (
                  <div className="workbench project-workbench route-investigation-shell">
                    <RouteSurface />
                    {tool === 'agency' ? <NetworkWorkspace /> : null}
                  </div>
                )}
        </div>
        <RoutingDetail />
      </div>

      <ProjectDialog />
      <SetupDialog />
      {/* Background work runs after the panels' effects, as App's own effects did. */}
      <StudioRuntime />
    </main>
  )
}
