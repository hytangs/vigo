import { quietMapLabel } from './presentation'

import { AlertTriangle, ArrowUpRight, Check, Database, FolderOpen, FolderPlus, Map, Pencil, RefreshCw, Search, Settings, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { orderedProjects } from '../../app/projectState'
import { cityReadiness } from '../../app/cityReadiness'
import type { VigoRuntimeConfig } from '../../app/runtimeConfig'
import { classNames, formatNumber, type VigoProject } from '../../domain'
import { IconButton } from '../UiPrimitives'
import { OperationProgress } from '../OperationProgress'

export function ProjectsPage({
  projects,
  loading = false,
  loadFailed = false,
  selectedProject,
  query,
  onQueryChange,
  previewLoading,
  onOpenProject,
  onOpenProjectData,
  onOpenSettings,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onRefresh,
}: {
  projects: VigoProject[]
  loading?: boolean
  loadFailed?: boolean
  selectedProject: VigoProject
  query: string
  onQueryChange: (query: string) => void
  previewLoading: boolean
  onOpenProject: (id: string) => void
  onOpenProjectData: (id: string) => void
  onOpenSettings: () => void
  onCreateProject: () => void
  onRenameProject: (id: string) => void
  onDeleteProject: (id: string) => void
  onRefresh: () => void
}) {
  const [filter, setFilter] = useState<'all' | 'ready' | 'setup'>('all')
  const normalizedQuery = query.trim().toLowerCase()
  const visibleProjects = orderedProjects(projects).filter((project) => {
    const ready = cityReadiness(project).state === 'ready'
    if (filter === 'ready' && !ready || filter === 'setup' && ready) return false
    if (!normalizedQuery) return true
    return [project.id, project.name, project.storagePath].some((value) => value.toLowerCase().includes(normalizedQuery))
  })

  return (
    <section className="city-library" aria-labelledby="city-library-title">
      <header className="city-library-head">
        <div>
          <span className="eyebrow">Your workspace</span>
          <h1 id="city-library-title">Cities</h1>
          <p>A place for every network you explore.</p>
        </div>
        <div className="city-library-actions">
          <button type="button" className="button button-secondary" onClick={onOpenSettings}><Settings size={16} />Settings</button>
          <button type="button" className="button button-primary" onClick={onCreateProject} disabled={!projects.length && (loading || loadFailed)}>
            <FolderPlus size={15} />
            <span>New City</span>
          </button>
        </div>
      </header>
      {projects.length > 0 ? <div className="city-library-toolbar">
        <label className="city-library-search"><Search size={17} aria-hidden="true" /><input type="search" aria-label="Search Cities" placeholder="Find a City" value={query} onChange={event => onQueryChange(event.target.value)} /></label>
        <div className="city-library-filters" role="group" aria-label="Filter Cities">
          {([['all', 'All'], ['ready', 'Prepared'], ['setup', 'In progress']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
        </div>
        <IconButton label="Refresh Cities" onClick={onRefresh} disabled={loading}><RefreshCw size={16} /></IconButton>
      </div> : null}
      {loading ? <div className="city-library-loading" role="status"><OperationProgress phase="Loading Cities" /></div> : loadFailed ? (
        <div className="city-library-loading" role="alert">
          <p>Couldn’t load your Cities. Retry to read the saved library.</p>
          <button type="button" className="button button-secondary" onClick={onRefresh}>Retry loading Cities</button>
        </div>
      ) : null}
      {visibleProjects.length ? (
        <div className="city-library-list" aria-label="City library">
          {visibleProjects.map((project) => {
            const isSelected = project.id === selectedProject.id
            const readiness = cityReadiness(project)
            return (
              <article key={project.id} className={classNames('city-library-card', isSelected && 'is-current')} aria-label={project.name}>
                <div className="city-card-top"><Map size={23} strokeWidth={1.5} aria-hidden="true" /><span className="city-state" data-state={readiness.state}>{readiness.state === 'ready' ? <Check size={13} /> : null}{readiness.label}</span></div>
                <button
                  type="button"
                  className="city-card-open"
                  onClick={() => readiness.state === 'ready' ? onOpenProject(project.id) : onOpenProjectData(project.id)}
                  aria-label={`${readiness.state === 'ready' ? 'Open' : 'Set up'} ${project.name}`}
                >
                  <strong>{quietMapLabel(project.name)}</strong>
                  <span className="city-card-enter">{readiness.detail}<ArrowUpRight size={17} /></span>
                </button>
                <div className="city-card-sources" aria-label="Prepared sources">
                  <span data-ready={readiness.transitReady}><span aria-hidden="true" />Timetables {readiness.transitReady ? 'ready' : project.routingStore?.status === 'building' ? 'preparing' : project.routingStore?.status === 'failed' ? 'failed' : 'needed'}</span>
                  <span data-ready={readiness.streetsReady}><span aria-hidden="true" />Streets {readiness.streetsReady ? 'ready' : project.osmStreetIndex?.status === 'building' ? 'preparing' : project.osmStreetIndex?.status === 'failed' ? 'failed' : 'needed'}</span>
                </div>
                <footer className="city-card-footer">
                  <small>{formatNumber(project.summary.feeds)} feed{project.summary.feeds === 1 ? '' : 's'} · {formatNumber(project.summary.stops)} stops</small>
                <div className="city-card-actions" aria-label={`Manage ${project.name}`}>
                  <IconButton label={`Data for ${project.name}`} onClick={() => onOpenProjectData(project.id)}><Database size={15} /></IconButton>
                  <IconButton label={`Rename ${project.name}`} onClick={() => onRenameProject(project.id)}>
                    <Pencil size={14} />
                  </IconButton>
                  <IconButton label={`Delete ${project.name}`} onClick={() => onDeleteProject(project.id)}>
                    <Trash2 size={14} />
                  </IconButton>
                </div>
                </footer>
              </article>
            )
          })}
          {previewLoading ? (
            <div className="city-library-loading" role="status" aria-live="polite">
              Opening City…
            </div>
          ) : null}
        </div>
      ) : !loading && !loadFailed ? (
        <div className="city-library-empty">
          <Map size={36} strokeWidth={1.2} />
          <h2>{projects.length ? 'No matching Cities' : 'Your next journey starts here'}</h2>
          <p>{projects.length ? 'Try another name or show all Cities.' : 'Create a City and add its transit timetable and street network.'}</p>
          {projects.length ? <button type="button" className="button button-secondary" onClick={() => { setFilter('all'); onQueryChange('') }}>Clear filters</button> : <button type="button" className="button button-primary" onClick={onCreateProject}><FolderPlus size={16} />Create your first City</button>}
        </div>
      ) : null}
      <footer className="city-library-note"><FolderOpen size={14} />Stored on this computer<span>{!projects.length && (loading || loadFailed) ? loading ? 'Loading…' : 'Not loaded' : `${projects.length} ${projects.length === 1 ? 'City' : 'Cities'}`}</span></footer>
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
