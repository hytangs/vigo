import { type KeyboardEvent, type ReactNode, useEffect, useRef } from 'react'
import { CheckCircle2, Database, SunMoon } from 'lucide-react'
import type { HealthResponse, VigoRuntimeConfig } from '../app/runtimeConfig'
import { basemapDescriptions, basemapLabels, type Appearance, type Basemap, type VigoProject } from '../domain'
import { basemapOptions } from '../app/uiOptions'
import { CityDataControl } from './CityDataControl'

export type DataSection = 'feeds' | 'preferences'

function readinessLabel(ready: boolean | undefined, readyLabel = 'Ready') {
  if (ready === undefined) return 'Checking'
  return ready ? readyLabel : 'Not ready'
}

export function CityPanel({
  section,
  projectId,
  projectName,
  projectRegion,
  feedCount,
  routeCount,
  stopCount,
  appearance,
  basemap,
  localBasemapAvailable,
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
  onCityReset,
  onCityRemoved,
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
  localBasemapAvailable: boolean
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
  onCityReset: (project: VigoProject) => void
  onCityRemoved: (projectId: string) => Promise<boolean>
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
    <section ref={rootRef} className="city-surface" aria-labelledby="city-surface-title">
      <header className="city-surface-head">
        <div className="city-surface-title">
          <span className="eyebrow">{section === 'feeds' ? 'City data' : 'City settings'}</span>
          <h1 id="city-surface-title">{section === 'feeds' ? projectName : 'City settings'}</h1>
          <p>
            {section === 'feeds'
              ? `${projectRegion} · GTFS and OSM sources.`
              : 'Appearance, local runtime, and City data.'}
          </p>
        </div>
        {section === 'feeds' ? (
          <dl className="city-surface-summary" aria-label="City data summary">
            <div><dt>Feeds</dt><dd>{feedCount.toLocaleString()}</dd></div>
            <div><dt>Route rows</dt><dd>{routeCount.toLocaleString()}</dd></div>
            <div><dt>Stops</dt><dd>{stopCount.toLocaleString()}</dd></div>
          </dl>
        ) : null}
      </header>

      <div className="city-surface-tabs" role="tablist" aria-label="City sections">
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
          className="city-surface-panel"
          role="tabpanel"
          aria-labelledby="data-tab-feeds"
        >
          {feeds}
        </div>
      ) : (
        <div
          id="data-panel-preferences"
          className="city-surface-panel data-preferences"
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
                      {basemapLabels[option]}{option === 'offline' && !localBasemapAvailable ? ' · not indexed' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="data-setting-row data-folder-setting">
                <span>
                  <strong>Local library</strong>
                  <small>Cities and their local indexes.</small>
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
              <div><dt><CheckCircle2 size={15} />City folder</dt><dd>{readinessLabel(offline?.storageWritable, 'Writable')}</dd></div>
              <div><dt><CheckCircle2 size={15} />GTFS import</dt><dd>{readinessLabel(offline?.gtfsImport)}</dd></div>
              <div><dt><CheckCircle2 size={15} />Offline map</dt><dd>{readinessLabel(offline?.offlineBasemap)}</dd></div>
            </dl>
            <p className="data-system-note">Static GTFS/OSM work stays local. Live GTFS-RT vehicles and remote map tiles require a network connection.</p>
          </section>

          <section className="data-setting-section data-cleanup-section" aria-labelledby="data-cleanup-heading">
            <div className="data-setting-heading">
              <div>
                <h2 id="data-cleanup-heading">City data</h2>
                <p>Inspect, reset, or remove one City.</p>
              </div>
            </div>
            <CityDataControl
              projects={projects}
              defaultProjectId={projectId}
              onCityReset={onCityReset}
              onCityRemoved={onCityRemoved}
            />
          </section>
        </div>
      )}
    </section>
  )
}
