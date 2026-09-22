import { quietMapLabel } from './presentation'

import { AlertTriangle, Database, FolderOpen, FolderPlus, Pencil, RefreshCw, Settings, Trash2 } from 'lucide-react'
import { hasOperationsData, orderedProjects } from '../../app/projectState'
import type { VigoRuntimeConfig } from '../../app/runtimeConfig'
import { statusFromStoreStatus, type ActivityStatus } from '../../app/status'
import { classNames, formatNumber, type VigoProject } from '../../domain'
import { IconButton, StatusBadge } from '../UiPrimitives'

export function ProjectsPage({
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
                  aria-label={hasData ? `Open ${project.name} network` : `Set up ${project.name}`}
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

export function StorageRecovery({
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
