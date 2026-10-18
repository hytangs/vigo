import { type ReactNode, useEffect, useRef } from 'react'
import { Database, Settings } from 'lucide-react'
import type { HealthResponse, VigoRuntimeConfig } from '../app/runtimeConfig'
import { formatNumber, type Appearance, type Basemap, type VigoProject } from '../domain'
import { StudioSettings } from './StudioSettings'
import { NetworkSignature } from './studio/CityLibrary'

export type DataSection = 'feeds' | 'preferences'

export function CityPanel({
  section,
  projectId,
  projectName,
  feedCount,
  routeCount,
  stopCount,
  projectRevision = '',
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
  /** Changes whenever the City's data changes; versions the network signature. */
  projectRevision?: string
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
  const rootRef = useRef<HTMLElement>(null)

  useEffect(() => {
    rootRef.current?.closest('.app-frame')?.scrollTo({ top: 0, left: 0 })
  }, [section])

  return (
    <section ref={rootRef} className="city-surface" aria-labelledby="city-surface-title">
      <header className="city-surface-head">
        {section === 'feeds' && routeCount ? <div className="city-surface-signature" aria-hidden="true"><NetworkSignature projectId={projectId} revision={`${projectRevision}:${routeCount}`} /></div> : null}
        <div className="city-surface-title">
          <span className="eyebrow">{section === 'feeds' ? 'City data' : 'Studio'}</span>
          <h1 id="city-surface-title">{section === 'feeds' ? projectName : 'Settings'}</h1>
          {section === 'preferences' ? <p>Appearance, storage, documentation, and local availability.</p> : null}
          {section === 'feeds' && routeCount ? <p className="city-surface-facts">{formatNumber(routeCount)} routes · {formatNumber(stopCount)} stops · {formatNumber(feedCount)} {feedCount === 1 ? 'timetable' : 'timetables'}</p> : null}
        </div>
        {projects.length > 0 ? <button
          type="button"
          className="button button-secondary city-surface-context"
          onClick={() => onSectionChange(section === 'feeds' ? 'preferences' : 'feeds')}
        >
          {section === 'feeds' ? <Settings size={16} /> : <Database size={16} />}
          {section === 'feeds' ? 'Settings' : `${projectName} data`}
        </button> : null}
      </header>

      {section === 'feeds' ? (
        <div
          id="data-panel-feeds"
          className="city-surface-panel"
          aria-label="City data sources"
        >
          {feeds}
        </div>
      ) : (
        <div id="data-panel-preferences"><StudioSettings
          appearance={appearance}
          basemap={basemap}
          localBasemapAvailable={localBasemapAvailable}
          runtimeConfig={runtimeConfig}
          health={health}
          busy={busy}
          error={error}
          projects={projects}
          projectId={projectId}
          onChooseFolder={onChooseFolder}
          onAppearanceChange={onAppearanceChange}
          onBasemapChange={onBasemapChange}
          onCityReset={onCityReset}
          onCityRemoved={onCityRemoved}
        /></div>
      )}
    </section>
  )
}
