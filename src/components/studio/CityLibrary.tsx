import { quietMapLabel } from './presentation'

import { AlertTriangle, ArrowUpRight, Check, Database, FolderOpen, FolderPlus, Map, Pencil, Plus, RefreshCw, Search, Settings, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { orderedProjects } from '../../app/projectState'
import { cityReadiness } from '../../app/cityReadiness'
import type { VigoRuntimeConfig } from '../../app/runtimeConfig'
import { classNames, formatNumber, type VigoProject } from '../../domain'
import { IconButton, VigoBrandMark } from '../UiPrimitives'

/** A small system map drawn on first run: three lines meeting at a transfer. */
function FirstRunNetwork() {
  return (
    <svg className="city-first-run-art" viewBox="0 0 240 120" aria-hidden="true">
      <path className="is-a" d="M14 92 C 60 92, 74 60, 120 60 S 190 26, 226 26" />
      <path className="is-b" d="M28 18 C 70 18, 96 40, 120 60 S 160 104, 214 104" />
      <path className="is-c" d="M120 8 L 120 112" />
      {[[14, 92], [226, 26], [28, 18], [214, 104], [120, 8], [120, 112], [67, 76], [176.75, 43], [80.75, 31.5], [155.75, 89.5]].map(([x, y]) => <circle key={`${x}-${y}`} cx={x} cy={y} r="3.2" />)}
      <circle className="is-transfer" cx="120" cy="60" r="7" />
    </svg>
  )
}

/** "Updated today", "Updated yesterday" or "Updated 3 Oct" in the reader's locale. */
function updatedLabel(updatedAt: string, now = new Date()) {
  const time = new Date(updatedAt)
  if (!Number.isFinite(time.getTime())) return ''
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(time.getFullYear(), time.getMonth(), time.getDate()).getTime()) / 86_400_000)
  if (days === 0) return 'Updated today'
  if (days === 1) return 'Updated yesterday'
  return `Updated ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', ...(time.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) }).format(time)}`
}

/** The City's own network, drawn by the local server from its map preview. */
export function NetworkSignature({ projectId, revision, empty = false }: { projectId: string; revision: string; empty?: boolean }) {
  const [failed, setFailed] = useState(false)
  if (empty) return <span className="city-signature-fallback is-empty"><Map size={24} strokeWidth={1.3} aria-hidden="true" /><small>No timetable yet</small></span>
  if (failed) return <span className="city-signature-fallback" aria-hidden="true"><Map size={26} strokeWidth={1.3} /></span>
  return (
    <img
      className="city-signature"
      src={`/api/projects/${encodeURIComponent(projectId)}/signature?v=2:${encodeURIComponent(revision)}`}
      alt=""
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
    />
  )
}

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
  const filteredProjects = orderedProjects(projects).filter((project) => {
    const ready = cityReadiness(project).state === 'ready'
    if (filter === 'ready' && !ready || filter === 'setup' && ready) return false
    if (!normalizedQuery) return true
    return [project.id, project.name, project.storagePath].some((value) => value.toLowerCase().includes(normalizedQuery))
  })
  // Unfiltered, the City you last worked in leads the page as a wide card.
  const featuredId = filter === 'all' && !normalizedQuery
    ? (filteredProjects.find((project) => project.id === selectedProject.id) ?? filteredProjects[0])?.id
    : undefined
  const visibleProjects = featuredId
    ? [...filteredProjects.filter((project) => project.id === featuredId), ...filteredProjects.filter((project) => project.id !== featuredId)]
    : filteredProjects

  return (
    <section className="city-library" aria-labelledby="city-library-title">
      <header className="city-library-head">
        <div>
          <span className="eyebrow">Your workspace</span>
          <h1 id="city-library-title">Cities</h1>
          <p>Select a City to explore, or create one with your own data.</p>
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
      {loading && !projects.length ? (
        <div className="city-library-loading" role="status">
          <span className="city-library-loading-label"><span className="signal-loader" aria-hidden="true" />Loading Cities</span>
          <div className="city-library-skeleton" aria-hidden="true">
            <div className="is-featured"><span className="skeleton" /><span><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /></span></div>
            <div><span className="skeleton" /><span><span className="skeleton" /><span className="skeleton" /></span></div>
            <div><span className="skeleton" /><span><span className="skeleton" /><span className="skeleton" /></span></div>
          </div>
        </div>
      ) : loadFailed ? (
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
              <article key={project.id} className={classNames('city-library-card', isSelected && 'is-current', project.id === featuredId && 'is-featured')} aria-label={project.name} aria-busy={isSelected && previewLoading ? true : undefined}>
                <div className="city-card-signature">
                  <NetworkSignature projectId={project.id} revision={`${project.updatedAt}:${project.summary.routes}`} empty={!project.summary.routes} />
                  {isSelected && previewLoading ? <span className="city-card-loading" role="status" aria-live="polite"><span className="signal-loader" aria-hidden="true" />Opening City…</span> : null}
                  <span className="city-state" data-state={readiness.state}>{readiness.state === 'ready' ? <Check size={13} /> : null}{readiness.label}</span>
                </div>
                <button
                  type="button"
                  className="city-card-open"
                  onClick={() => readiness.state === 'ready' ? onOpenProject(project.id) : onOpenProjectData(project.id)}
                  aria-label={`${readiness.state === 'ready' ? 'Open' : 'Set up'} ${project.name}`}
                >
                  {project.id === featuredId ? <span className="city-card-kicker">Continue where you left off</span> : null}
                  <strong>{quietMapLabel(project.name)}</strong>
                  {project.id === featuredId && project.summary.routes ? <span className="city-card-facts">{formatNumber(project.summary.routes)} routes · {formatNumber(project.summary.stops)} stops</span> : null}
                  <span className="city-card-enter">{readiness.detail}<ArrowUpRight size={17} /></span>
                </button>
                <div className="city-card-sources" aria-label="Prepared sources">
                  <span data-ready={readiness.transitReady}><span aria-hidden="true" />Timetables {readiness.transitReady ? 'ready' : project.routingStore?.status === 'building' ? 'preparing' : project.routingStore?.status === 'failed' ? 'failed' : 'needed'}</span>
                  <span data-ready={readiness.streetsReady}><span aria-hidden="true" />Streets {readiness.streetsReady ? 'ready' : project.osmStreetIndex?.status === 'building' ? 'preparing' : project.osmStreetIndex?.status === 'failed' ? 'failed' : 'needed'}</span>
                </div>
                <footer className="city-card-footer">
                  <small>{[`${formatNumber(project.summary.feeds)} feed${project.summary.feeds === 1 ? '' : 's'}`, updatedLabel(project.updatedAt)].filter(Boolean).join(' · ')}</small>
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
          {filter === 'all' && !normalizedQuery ? (
            <button type="button" className="city-library-new" onClick={onCreateProject}>
              <span className="city-library-new-icon" aria-hidden="true"><Plus size={18} /></span>
              <strong>New City</strong>
              <span>Start from a GTFS timetable and an OpenStreetMap extract.</span>
            </button>
          ) : null}
        </div>
      ) : !loading && !loadFailed ? (
        <div className={classNames('city-library-empty', !projects.length && 'is-first-run')}>
          {projects.length ? <Map size={36} strokeWidth={1.2} /> : <>
            <div className="city-first-run-brand"><VigoBrandMark /><span>VIGO</span></div>
            <FirstRunNetwork />
          </>}
          <h2>{projects.length ? 'No matching Cities' : 'Transit routing. In milliseconds.'}</h2>
          <p>{projects.length ? 'Try another name or show all Cities.' : 'From a single journey to a city’s worth of possibilities.'}</p>
          {projects.length ? null : (
            <ol className="city-first-run-steps">
              <li><b>1</b><span><strong>Choose your city</strong><small>Create a City, name it, and choose its folder.</small></span></li>
              <li><b>2</b><span><strong>Add GTFS data</strong><small>A timetable ZIP from the local transit agency.</small></span></li>
              <li><b>3</b><span><strong>Add OSM PBF data</strong><small>An OpenStreetMap .osm.pbf file covering the same area.</small></span></li>
            </ol>
          )}
          {projects.length ? <button type="button" className="button button-secondary" onClick={() => { setFilter('all'); onQueryChange('') }}>Clear filters</button> : <button type="button" className="button button-primary" onClick={onCreateProject}><FolderPlus size={16} />Create your first City</button>}
        </div>
      ) : null}
      <footer className="city-library-note"><FolderOpen size={14} />Stored on this computer<span>{!projects.length && (loading || loadFailed) ? loading ? 'Loading…' : 'Not loaded' : loading ? 'Refreshing…' : `${projects.length} ${projects.length === 1 ? 'City' : 'Cities'}`}</span></footer>
    </section>
  )
}

export function StorageRecovery({
  config,
  busy,
  error,
  onChooseFolder,
  onUseDefault,
  onOpenSettings,
}: {
  config: VigoRuntimeConfig
  busy: boolean
  error: string
  onChooseFolder: () => void
  onUseDefault: () => void
  onOpenSettings: () => void
}) {
  return (
    <section className="storage-recovery" aria-labelledby="storage-recovery-title" aria-busy={busy}>
      <div className="storage-recovery-panel">
        <div className="storage-recovery-icon" aria-hidden="true">
          {config.storageAccessRequired ? <FolderOpen size={26} strokeWidth={1.5} /> : <AlertTriangle size={26} strokeWidth={1.5} />}
        </div>
        <span className="eyebrow">City library</span>
        <h1 id="storage-recovery-title">{config.storageAccessRequired ? 'Open your City library' : 'Your library needs attention'}</h1>
        <p className="storage-recovery-description">{config.storageAccessRequired
          ? 'Choose your saved library folder to access your Cities.'
          : config.offline.storageError || 'The configured folder is unavailable or read-only.'}</p>
        <div className="storage-recovery-location">
          <FolderOpen size={17} aria-hidden="true" />
          <div><span>Library folder</span><p title={config.storageRoot}>{config.storageRoot}</p></div>
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="storage-recovery-actions">
          <button type="button" className="button button-primary" onClick={onChooseFolder} disabled={busy}>
            <FolderOpen size={15} />
            {config.storageAccessRequired ? 'Open library folder' : 'Locate folder'}
          </button>
          <button type="button" className="button button-secondary" onClick={onUseDefault} disabled={busy}>
            Use default folder
          </button>
          <button type="button" className="button button-secondary" onClick={onOpenSettings}>Settings</button>
        </div>
        <p className="storage-recovery-note">Your existing Cities stay in their saved folder.</p>
      </div>
    </section>
  )
}
