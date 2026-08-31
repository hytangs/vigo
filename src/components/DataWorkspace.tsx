import { type KeyboardEvent, type ReactNode, useEffect, useRef } from 'react'
import { CheckCircle2, Database, SunMoon } from 'lucide-react'
import type { HealthResponse, VigoRuntimeConfig } from '../app/runtimeConfig'
import { basemapDescriptions, basemapLabels, type Appearance, type Basemap, type VigoProject } from '../domain'
import { basemapOptions } from '../app/uiOptions'
import { CacheMaintenanceControl } from './CacheMaintenanceControl'
import { WorkspaceCleanupControl } from './WorkspaceCleanupControl'

export type DataSection = 'feeds' | 'preferences'

function readinessLabel(ready: boolean | undefined, readyLabel = 'Ready') {
  if (ready === undefined) return 'Checking'
  return ready ? readyLabel : 'Not ready'
}

export function DataWorkspace({
  section,
  projectId,
  projectName,
  projectRegion,
  feedCount,
  routeCount,
  stopCount,
  appearance,
  basemap,
  localStreetGraphAvailable,
  runtimeConfig,
  health,
  busy,
  error,
  projects,
  feeds,
  onSectionChange,
  onChooseFolder,
  onAppearanceChange,
  onBasemapChange,
  onAutomaticCacheCleanupChange,
  onWorkspaceCleaned,
  onWorkspaceRemoved,
}: {
  section: DataSection
  projectId: string
  projectName: string
  projectRegion: string
  feedCount: number
  routeCount: number
  stopCount: number
  appearance: Appearance
  basemap: Basemap
  localStreetGraphAvailable: boolean
  runtimeConfig: VigoRuntimeConfig | null
  health: HealthResponse | null
  busy: boolean
  error: string
  projects: VigoProject[]
  feeds: ReactNode
  onSectionChange: (section: DataSection) => void
  onChooseFolder: () => void
  onAppearanceChange: (appearance: Appearance) => void
  onBasemapChange: (basemap: Basemap) => void
  onAutomaticCacheCleanupChange: (enabled: boolean) => void
  onWorkspaceCleaned: (project: VigoProject) => void
  onWorkspaceRemoved: (projectId: string) => Promise<boolean>
}) {
  const offline = runtimeConfig?.offline
  const rootRef = useRef<HTMLElement>(null)

  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()

    const nextSection: DataSection = event.key === 'ArrowLeft' || event.key === 'Home'
      ? 'feeds'
      : 'preferences'

    onSectionChange(nextSection)
    globalThis.requestAnimationFrame(() => {
      document.getElementById(`data-tab-${nextSection}`)?.focus()
    })
  }

  useEffect(() => {
    rootRef.current?.closest('.app-frame')?.scrollTo({ top: 0, left: 0 })
  }, [section])

  return (
    <section ref={rootRef} className="data-workspace" aria-labelledby="data-workspace-title">
      <header className="data-workspace-head">
        <div className="data-workspace-title">
          <span className="eyebrow">{section === 'feeds' ? 'Workspace data' : 'Manage workspace'}</span>
          <h1 id="data-workspace-title">{section === 'feeds' ? projectName : 'Manage workspace'}</h1>
          <p>
            {section === 'feeds'
              ? `${projectRegion} · GTFS and OSM sources.`
              : 'Appearance, local runtime, and workspace data.'}
          </p>
        </div>
        {section === 'feeds' ? (
          <dl className="data-workspace-summary" aria-label="Project data summary">
            <div><dt>Feeds</dt><dd>{feedCount.toLocaleString()}</dd></div>
            <div><dt>Route rows</dt><dd>{routeCount.toLocaleString()}</dd></div>
            <div><dt>Stops</dt><dd>{stopCount.toLocaleString()}</dd></div>
          </dl>
        ) : null}
      </header>

      <div className="data-workspace-tabs" role="tablist" aria-label="Workspace management sections">
        <button
          type="button"
          role="tab"
          id="data-tab-feeds"
          aria-controls="data-panel-feeds"
          aria-selected={section === 'feeds'}
          tabIndex={section === 'feeds' ? 0 : -1}
          className={section === 'feeds' ? 'is-active' : undefined}
          onClick={() => onSectionChange('feeds')}
          onKeyDown={handleTabKey}
        >
          <Database size={16} />
          Data sources
        </button>
        <button
          type="button"
          role="tab"
          id="data-tab-preferences"
          aria-controls="data-panel-preferences"
          aria-selected={section === 'preferences'}
          tabIndex={section === 'preferences' ? 0 : -1}
          className={section === 'preferences' ? 'is-active' : undefined}
          onClick={() => onSectionChange('preferences')}
          onKeyDown={handleTabKey}
        >
          <SunMoon size={16} />
          Preferences
        </button>
      </div>

      {section === 'feeds' ? (
        <div
          id="data-panel-feeds"
          className="data-workspace-panel"
          role="tabpanel"
          aria-labelledby="data-tab-feeds"
        >
          {feeds}
        </div>
      ) : (
        <div
          id="data-panel-preferences"
          className="data-workspace-panel data-preferences"
          role="tabpanel"
          aria-labelledby="data-tab-preferences"
        >
          <section className="data-setting-section" aria-labelledby="data-general-heading">
            <div className="data-setting-heading">
              <div>
                <h2 id="data-general-heading">General</h2>
                <p>Keep the interface and local library predictable.</p>
              </div>
            </div>
            <div className="data-setting-stack">
              <div className="data-setting-row">
                <span>
                  <strong>Appearance</strong>
                  <small>Applied throughout VIGO.</small>
                </span>
                <div className="data-segmented-control" role="group" aria-label="Appearance">
                  <button type="button" className={appearance === 'dark' ? 'is-active' : undefined} aria-pressed={appearance === 'dark'} onClick={() => onAppearanceChange('dark')}>Dark</button>
                  <button type="button" className={appearance === 'light' ? 'is-active' : undefined} aria-pressed={appearance === 'light'} onClick={() => onAppearanceChange('light')}>Light</button>
                </div>
              </div>
              <div className="data-setting-row">
                <span>
                  <strong>Map base</strong>
                  <small>{basemapDescriptions[basemap]}</small>
                </span>
                <select
                  className="data-basemap-select"
                  aria-label="Map base"
                  value={basemap}
                  onChange={(event) => onBasemapChange(event.target.value as Basemap)}
                >
                  {basemapOptions.map((option) => (
                    <option key={option} value={option}>
                      {basemapLabels[option]}{option === 'offline' && !localStreetGraphAvailable ? ' · not indexed' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="data-setting-row data-folder-setting">
                <span>
                  <strong>Local library</strong>
                  <small>Projects and local SQLite indexes.</small>
                </span>
                <div className="data-folder-row">
                  <code title={runtimeConfig?.storageRoot}>{runtimeConfig?.storageRoot ?? 'Checking local configuration…'}</code>
                  <button type="button" className="button button-secondary" onClick={onChooseFolder} disabled={busy || !runtimeConfig}>
                    Choose
                  </button>
                </div>
              </div>
            </div>
            {error ? <p className="form-error" role="alert">{error}</p> : null}
          </section>

          <section className="data-setting-section" aria-labelledby="data-system-heading">
            <div className="data-setting-heading">
              <div>
                <h2 id="data-system-heading">Local runtime</h2>
                <p>Capabilities available to this desktop app.</p>
              </div>
            </div>
            <dl className="data-system-list">
              <div><dt><CheckCircle2 size={15} />Local runtime</dt><dd>{health?.version ?? 'Checking'}</dd></div>
              <div><dt><CheckCircle2 size={15} />Project folder</dt><dd>{readinessLabel(offline?.storageWritable, 'Writable')}</dd></div>
              <div><dt><CheckCircle2 size={15} />GTFS import</dt><dd>{readinessLabel(offline?.gtfsImport)}</dd></div>
              <div><dt><CheckCircle2 size={15} />Offline map</dt><dd>{readinessLabel(offline?.offlineBasemap)}</dd></div>
            </dl>
            <p className="data-system-note">Static GTFS/OSM work stays local. Live GTFS-RT vehicles and remote map tiles require a network connection.</p>
          </section>

          <section className="data-setting-section" aria-labelledby="data-cache-heading">
            <div className="data-setting-heading">
              <div>
                <h2 id="data-cache-heading">Cache maintenance</h2>
                <p>Keep the local desktop runtime lean without touching durable workspace data.</p>
              </div>
            </div>
            <CacheMaintenanceControl
              automatic={runtimeConfig?.automaticCacheCleanup ?? true}
              disabled={busy || !runtimeConfig}
              onAutomaticChange={onAutomaticCacheCleanupChange}
            />
          </section>

          <section className="data-setting-section data-cleanup-section" aria-labelledby="data-cleanup-heading">
            <div className="data-setting-heading">
              <div>
                <h2 id="data-cleanup-heading">Workspace data</h2>
                <p>Inspect, reset, or remove one workspace.</p>
              </div>
            </div>
            <WorkspaceCleanupControl
              projects={projects}
              defaultProjectId={projectId}
              onWorkspaceCleaned={onWorkspaceCleaned}
              onWorkspaceRemoved={onWorkspaceRemoved}
            />
          </section>
        </div>
      )}
    </section>
  )
}
