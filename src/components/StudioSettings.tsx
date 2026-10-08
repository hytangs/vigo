import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, Circle, FolderOpen, HardDrive, Info, Moon, Palette, RefreshCw, Sun } from 'lucide-react'
import { apiJson } from '../app/api'
import { formatBytes } from '../app/presentation'
import type { HealthResponse, VigoRuntimeConfig } from '../app/runtimeConfig'
import { basemapOptions } from '../app/uiOptions'
import { basemapDescriptions, basemapLabels, type Appearance, type Basemap, type VigoProject } from '../domain'
import { CityDataControl } from './CityDataControl'

const settingPages = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'storage', label: 'Storage', icon: HardDrive },
  { id: 'about', label: 'About VIGO', icon: Info },
] as const

type SettingsPage = typeof settingPages[number]['id']
type StorageStatus = { capacityBytes: number; availableBytes: number }

function LibraryStorage({ config, busy, onChooseFolder }: { config: VigoRuntimeConfig | null; busy: boolean; onChooseFolder: () => void }) {
  const [storage, setStorage] = useState<StorageStatus | null>(null)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setStorage(null)
    setError('')
    apiJson<StorageStatus>('/api/storage', { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setStorage(result)
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Unable to measure free space.')
    })
    return () => controller.abort()
  }, [config?.storageRoot, refresh])
  const low = storage && storage.availableBytes < 5 * 1024 ** 3
  return <section className="settings-section" aria-labelledby="library-folder-heading">
    <div className="settings-section-heading"><div><h2 id="library-folder-heading">City library</h2><p>Where your Cities live on this computer.</p></div><button type="button" className="settings-icon-button" aria-label="Refresh disk space" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={16} /></button></div>
    <div className="settings-folder"><FolderOpen size={20} aria-hidden="true" /><span title={config?.storageRoot}>{config?.storageRoot ?? 'Loading folder…'}</span><button type="button" className="button button-secondary" onClick={onChooseFolder} disabled={busy || !config?.canChangeStorageRoot}>{busy ? 'Changing…' : 'Change folder'}</button></div>
    <p className="settings-note">Changing folders opens a different library. Your existing Cities stay where they are.</p>
    {config && !config.canChangeStorageRoot ? <p className="settings-note">The library folder is fixed by this installation.</p> : null}
    {storage ? <div className="settings-disk" data-low={Boolean(low)} role="status">
      <div><strong>{formatBytes(storage.availableBytes)} available</strong><span>on a {formatBytes(storage.capacityBytes)} volume</span></div>
      <meter min={0} max={storage.capacityBytes} value={storage.availableBytes} aria-label="Available disk space" />
      {low ? <p>Space is running low. Free space on this volume before preparing another City.</p> : null}
    </div> : <p className="settings-note" role={error ? 'alert' : 'status'}>{error || 'Checking free space…'}</p>}
  </section>
}

export function StudioSettings({ appearance, basemap, localBasemapAvailable, runtimeConfig, health, busy, error, projects, projectId, onChooseFolder, onAppearanceChange, onBasemapChange, onCityReset, onCityRemoved }: {
  appearance: Appearance; basemap: Basemap; localBasemapAvailable: boolean
  runtimeConfig: VigoRuntimeConfig | null; health: HealthResponse | null; busy: boolean; error: string
  projects: VigoProject[]; projectId: string
  onChooseFolder: () => void; onAppearanceChange: (appearance: Appearance) => void; onBasemapChange: (basemap: Basemap) => void
  onCityReset: (project: VigoProject) => void; onCityRemoved: (id: string) => Promise<boolean>
}) {
  const [page, setPage] = useState<SettingsPage>('appearance')
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const offline = runtimeConfig?.offline
  function handleKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : ['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 0
    if (!step && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? settingPages.length - 1 : (index + step + settingPages.length) % settingPages.length
    setPage(settingPages[next].id)
    tabRefs.current[next]?.focus()
  }
  return <div className="studio-settings">
    <div className="settings-navigation" role="tablist" aria-label="Settings categories">
      {settingPages.map(({ id, label, icon: Icon }, index) => <button key={id} ref={node => { tabRefs.current[index] = node }} type="button" role="tab" id={`settings-tab-${id}`} aria-selected={page === id} aria-controls={`settings-panel-${id}`} tabIndex={page === id ? 0 : -1} onClick={() => setPage(id)} onKeyDown={event => handleKey(event, index)}><Icon size={17} />{label}</button>)}
      <p>Applies throughout Studio.</p>
    </div>
    <div className="settings-content" role="tabpanel" id={`settings-panel-${page}`} aria-labelledby={`settings-tab-${page}`} tabIndex={0}>
      {page === 'appearance' ? <>
        <section className="settings-section" aria-labelledby="settings-appearance-title">
          <div className="settings-section-heading"><div><h2 id="settings-appearance-title">Color theme</h2><p>Choose a comfortable view of your workspace.</p></div></div>
          <div className="settings-themes" role="group" aria-label="Appearance">
            {(['light', 'dark'] as const).map(value => <button key={value} type="button" className="settings-theme" aria-pressed={appearance === value} onClick={() => onAppearanceChange(value)}>
              <span className="settings-theme-preview" data-theme={value} aria-hidden="true"><i /><span><b /><b /><b /></span></span>
              <span className="settings-theme-label">{value === 'light' ? <Sun size={16} /> : <Moon size={16} />}{value === 'light' ? 'Light' : 'Dark'}{appearance === value ? <Check size={16} /> : null}</span>
            </button>)}
          </div>
        </section>
        <section className="settings-section" aria-labelledby="settings-map-title">
          <div className="settings-section-heading"><div><h2 id="settings-map-title">Map background</h2><p>Set the context around your routes.</p></div></div>
          <div className="settings-maps" role="group" aria-label="Map background">
            {basemapOptions.map(option => <button key={option} type="button" aria-pressed={basemap === option} onClick={() => onBasemapChange(option)}>
              <span className="settings-map-label">{basemapLabels[option]}{basemap === option ? <Check size={16} /> : null}</span>
              <small>{option === 'offline' && !localBasemapAvailable ? 'Add street data to use this in the current City.' : basemapDescriptions[option]}</small>
            </button>)}
          </div>
        </section>
      </> : page === 'storage' ? <>
        <LibraryStorage config={runtimeConfig} busy={busy} onChooseFolder={onChooseFolder} />
        <section className="settings-section" aria-labelledby="settings-city-storage-title">
          <div className="settings-section-heading"><div><h2 id="settings-city-storage-title">City storage</h2><p>Inspect one City at a time.</p></div></div>
          {projects.length ? <CityDataControl projects={projects} defaultProjectId={projectId} onCityReset={onCityReset} onCityRemoved={onCityRemoved} /> : <p className="settings-note">No Cities in this library yet.</p>}
        </section>
      </> : <>
        <section className="settings-section settings-about" aria-labelledby="settings-about-title">
          <span className="eyebrow">Local by design</span><h2 id="settings-about-title">VIGO Studio <span>{health?.version || '—'}</span></h2>
          <p>Explore a network. Find a journey. Understand what is within reach.</p>
          <p className="settings-note">Timetables, streets, and routing stay on this computer. Live feeds and online maps use the internet.</p>
        </section>
        <section className="settings-section" aria-labelledby="settings-health-title">
          <div className="settings-section-heading"><div><h2 id="settings-health-title">Availability</h2></div></div>
          <dl className="settings-health">{[
            ['Routing service', health?.ok], ['Library access', offline?.storageWritable], ['Timetable import', offline?.gtfsImport], ['Offline map support', offline?.offlineBasemap],
          ].map(([label, ready]) => <div key={String(label)} data-ready={ready === true}><dt>{ready === true ? <Check size={16} /> : <Circle size={14} />}{label}</dt><dd>{ready === undefined ? 'Checking' : ready ? 'Available' : 'Unavailable'}</dd></div>)}</dl>
          {offline?.storageError ? <p className="form-error" role="alert">{offline.storageError}</p> : null}
        </section>
      </>}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </div>
  </div>
}
