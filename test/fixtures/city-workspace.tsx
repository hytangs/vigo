import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ProjectsPage } from '../../src/components/studio/CityLibrary'
import { CityPanel } from '../../src/components/CityPanel'
import { cityReadiness } from '../../src/app/cityReadiness'
import { emptyCityProject } from '../../src/app/projectState'
import '../../src/App.css'
import '../../src/index.css'

const noop = () => {}
const projects = ['Boston', 'Washington', 'Anchorage'].map((name, index) => ({
  ...emptyCityProject(), id: name.toLowerCase(), name, region: ['Massachusetts', 'District of Columbia', 'Alaska'][index],
  updatedAt: '2026-01-01', summary: { feeds: 1, stops: 400, routes: 20, transferCandidates: 0, qualityScore: 100 },
  routingStore: { status: 'ready', routingEligibility: 'exact' },
  osmStreetIndex: index === 1 ? null : { status: index === 2 ? 'building' : 'ready' },
  jobs: index === 2 ? [{ status: 'running', kind: 'national-osm-import' }] : [],
}))
let requests = [], resets = [], opened = '', managed = '', failScan = false, slowScan = false
const originalFetch = window.fetch
window.fetch = async (input, options = {}) => {
  const url = String(input)
  if (!url.startsWith('/api/')) return originalFetch(input, options)
  requests.push(url)
  if (url === '/api/storage') return Response.json({ capacityBytes: 1024 ** 4, availableBytes: 17 * 1024 ** 3 })
  const id = url.split('/')[3]
  const project = projects.find(p => p.id === id)
  if (!project) return Response.json({ error: 'Missing City' }, { status: 404 })
  if (slowScan && id === 'boston') await new Promise(resolve => setTimeout(resolve, 120))
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  if (failScan) return Response.json({ error: 'Storage measurement failed' }, { status: 503 })
  if (options.method === 'POST') resets.push(id)
  return Response.json({ data: {
    city: { id, name: project.name }, managedBytes: 320 * 1024 ** 2, fileCount: 42, hasData: true,
    activeImport: id === 'anchorage', counts: { feeds: 1, stops: 400, routes: 20 },
    categories: { timetables: { bytes: 64 * 1024 ** 2 }, streets: { bytes: 240 * 1024 ** 2 }, activity: { bytes: 12 * 1024 ** 2 }, other: { bytes: 4 * 1024 ** 2 } },
  } })
}
const config = { storageRoot: '/Cities/Transit networks', canChangeStorageRoot: true, offline: { storageWritable: true, gtfsImport: true, offlineBasemap: true } }
function Fixture() {
  const [view, setView] = useState('cities'), [section, setSection] = useState('preferences'), [query, setQuery] = useState(''), [appearance, setAppearance] = useState('light'), [basemap, setBasemap] = useState('minimal'), [empty, setEmpty] = useState(false)
  window.fixture = { setView, setEmpty, setAppearance, setQuery, setSection }
  return <main className={`app-shell appearance-${appearance} accent-graphite ${view === 'cities' ? 'page-projects' : 'page-project view-data'}`}>
    <header className="topbar" style={{ margin: 0, display: 'flex', justifyContent: 'space-between', padding: '12px 24px' }}><b>VIGO <span style={{ fontWeight: 400 }}>· Interface fixture</span></b><button type="button" className="button button-secondary" onClick={() => setView(view === 'cities' ? 'settings' : 'cities')}>{view === 'cities' ? 'Settings' : 'Cities'}</button></header>
    <div className="app-frame" style={{ display: 'block', overflow: 'auto' }}>
      {view === 'cities' ? <ProjectsPage projects={empty ? [] : projects} selectedProject={projects[0]} query={query} onQueryChange={setQuery} previewLoading={false} onOpenProject={id => { opened = id }} onOpenProjectData={id => { managed = id }} onOpenSettings={() => setView('settings')} onCreateProject={noop} onRenameProject={noop} onDeleteProject={noop} onRefresh={noop} />
        : <CityPanel projects={empty ? [] : projects} projectId="boston" projectName="Boston" projectRegion="Massachusetts" feedCount={1} routeCount={20} stopCount={400} appearance={appearance} basemap={basemap} localBasemapAvailable runtimeConfig={config} health={{ ok: true, version: '0.5.0' }} busy={false} error="" section={section} onSectionChange={setSection} onChooseFolder={noop} onAppearanceChange={setAppearance} onBasemapChange={setBasemap} onCityReset={noop} onCityRemoved={async () => true} feeds={<p>City sources fixture</p>} />}
    </div>
  </main>
}
flushSync(() => createRoot(document.getElementById('root')).render(<Fixture />))
const assert = (condition, message) => { if (!condition) throw Error(message) }
const click = selector => { const node = document.querySelector(selector); assert(node, 'Missing ' + selector); flushSync(() => node.click()); return node }
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 30)); flushSync(() => {}) }
const select = value => flushSync(() => { const node = document.querySelector('#city-data-target'); node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })) })
window.checkCities = async () => {
  flushSync(() => { window.fixture.setView('cities'); window.fixture.setEmpty(false); window.fixture.setQuery('') })
  assert(document.querySelectorAll('.city-state[data-state=ready]').length === 1, 'Missing streets advertised as prepared')
  click('[aria-label="Set up Washington"]'); assert(managed === 'washington', 'Partial City does not lead to setup')
  click('[aria-label="Open Boston"]'); assert(opened === 'boston', 'Prepared City does not open')
  const filters = [...document.querySelectorAll('.city-library-filters button')]
  flushSync(() => filters[1].click()); assert(document.querySelectorAll('.city-library-card').length === 1, 'Ready filter failed')
  flushSync(() => filters[2].click()); assert(document.querySelectorAll('.city-library-card').length === 2, 'In progress filter failed')
  flushSync(() => { filters[0].click(); window.fixture.setQuery('no such city') })
  assert(document.querySelector('.city-library-empty'), 'Empty search missing')
  click('.city-library-empty button'); assert(document.querySelectorAll('.city-library-card').length === 3, 'Clear filters failed')
  assert(cityReadiness({ ...projects[0], routingStore: { status: 'ready', routingEligibility: 'unsupported' } }).state === 'attention', 'Unsupported timetable marked ready')
  assert(cityReadiness({ ...projects[0], routingStore: { status: 'failed' } }).state === 'attention', 'Failed preparation hidden')
  return { searchAndFilters: true, honestPreparation: true, directActions: true }
}
window.checkSettings = async () => {
  requests = []
  flushSync(() => window.fixture.setView('settings'))
  await settle()
  assert(!requests.length, 'Appearance scans storage eagerly')
  const dark = [...document.querySelectorAll('.settings-theme')][1]; flushSync(() => dark.click())
  assert(document.querySelector('.appearance-dark'), 'Theme does not apply')
  flushSync(() => [...document.querySelectorAll('.settings-theme')][0].click())
  const maps = [...document.querySelectorAll('.settings-maps button')]; flushSync(() => maps[0].click())
  assert(maps[0].getAttribute('aria-pressed') === 'true', 'Map choice not selected')
  const firstTab = document.querySelector('#settings-tab-appearance'); firstTab.focus()
  flushSync(() => firstTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  await settle()
  assert(document.activeElement.id === 'settings-tab-storage', 'Keyboard tab navigation failed')
  assert(requests.filter(url => url.endsWith('city-data')).length === 1, 'Must only measure the selected City')
  assert(!document.querySelector('.city-maintenance').open, 'Destructive controls exposed by default')
  assert(document.querySelector('.settings-disk').textContent.includes('available'), 'Disk availability missing')
  slowScan = true
  click('[aria-label="Refresh City storage"]')
  select('washington'); await settle(); await new Promise(resolve => setTimeout(resolve, 150))
  assert(document.querySelector('#city-data-target').value === 'washington', 'Target changed after stale request')
  click('.city-maintenance summary')
  click('.city-data-action button')
  assert(document.querySelector('.city-data-confirm').textContent.includes('Washington'), 'Stale storage response targets the wrong City')
  assert(document.querySelector('.city-data-confirm-actions button:last-child').disabled, 'Reset permits empty confirmation')
  select('anchorage'); await settle()
  click('.city-maintenance summary')
  assert([...document.querySelectorAll('.city-data-action button')].every(button => button.disabled), 'Active import can be reset')
  assert(!document.querySelector('.city-data-confirm'), 'Old confirmation survives changing City')
  slowScan = false; failScan = true
  select('boston'); await settle()
  assert(document.querySelector('[role=alert]')?.textContent.includes('Storage measurement failed'), 'Measurement failure hidden')
  failScan = false; click('[aria-label="Refresh City storage"]'); await settle()
  assert(document.querySelector('.city-data-overview'), 'Measurement retry failed')
  assert(!resets.length, 'Navigation unexpectedly resets data')
  flushSync(() => window.fixture.setEmpty(true))
  assert(document.querySelector('.settings-content').textContent.includes('No Cities'), 'Empty library settings unavailable')
  click('#settings-tab-about'); assert(document.querySelector('.settings-about').textContent.includes('0.5.0'), 'Version missing')
  flushSync(() => window.fixture.setEmpty(false))
  click('#settings-tab-appearance')
  return { lazyMeasurement: true, keyboardNavigation: true, themes: true, mapChoice: true, staleRequestGuard: true, activeImportGuard: true, retry: true, emptyLibrary: true }
}
window.checkLayout = async (view, dark = false) => {
  flushSync(() => { window.fixture.setView(view); window.fixture.setAppearance(dark ? 'dark' : 'light') })
  const root = document.querySelector('.app-frame'); root.scrollTop = 0
  assert(root.scrollWidth <= root.clientWidth + 1, 'Horizontal overflow: ' + view + ' at ' + innerWidth)
  for (const element of document.querySelectorAll(view === 'cities' ? '.city-card-actions button, .city-library-actions button' : '.settings-navigation button, .settings-theme')) {
    element.scrollIntoView({ block: 'center' })
    const box = element.getBoundingClientRect()
    assert(box.width > 0 && box.height >= 32 && box.right <= innerWidth + 1, 'Control clipped')
    assert(element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)), 'Control obscured')
  }
  root.scrollTop = 0
  return { width: innerWidth, view, dark, controlsReachable: true }
}
