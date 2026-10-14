import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ProjectsPage, StorageRecovery } from '../../src/components/studio/CityLibrary'
import { CityPanel } from '../../src/components/CityPanel'
import { ImportPanel } from '../../src/components/studio/CitySources'
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
let requests = [], resets = [], opened = '', managed = '', failScan = false, slowScan = false, libraryOpened = false
const streetAccessRequests = []
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
  const [accessCity, setAccessCity] = useState('boston'), [accessReady, setAccessReady] = useState(true)
  window.fixture = { setView, setEmpty, setAppearance, setQuery, setSection, setAccessCity, setAccessReady }
  return <main className={`app-shell appearance-${appearance} accent-graphite ${view === 'cities' ? 'page-projects' : 'page-project view-data'}`}>
    <header className="topbar" style={{ margin: 0, display: 'flex', justifyContent: 'space-between', padding: '12px 24px' }}><b>VIGO <span style={{ fontWeight: 400 }}>· Interface fixture</span></b><button type="button" className="button button-secondary" onClick={() => setView(view === 'cities' ? 'settings' : 'cities')}>{view === 'cities' ? 'Settings' : 'Cities'}</button></header>
    <div className="app-frame" style={{ display: 'block', overflow: 'auto' }}>
      {view === 'imports' ? <div style={{ maxWidth: 520, margin: '20px auto', padding: 16 }}><ImportPanel cityId={accessCity} canPrepareAuthorizedAccess={accessReady}
        staticFeeds={[]} isImporting={false} isOsmImporting={false} importMessage="" osmStreetReady osmStreetMessage=""
        realtimeSnapshot={null} realtimeMessage="" realtimeRequest={null} isRealtimeLoading={false}
        onFiles={noop} onNationalGtfsPath={noop} onNationalOsmPath={noop} onOsmFiles={(_files, policy) => streetAccessRequests.push(policy)}
        onConnectRealtime={noop} onDisconnectRealtime={noop} onCancelGtfs={noop} onRetryGtfs={noop} onCancelOsm={noop} onRetryOsm={noop} /></div>
        : view === 'library-access' ? <StorageRecovery config={{ ...config, storageAccessRequired: true, offline: { ...config.offline, storageWritable: false, storageError: 'Open your saved library folder. Existing Cities remain there.' } }} busy={false} error="" onChooseFolder={() => { libraryOpened = true }} onUseDefault={noop} /> : view === 'cities' ? <ProjectsPage projects={empty ? [] : projects} selectedProject={projects[0]} query={query} onQueryChange={setQuery} previewLoading={false} onOpenProject={id => { opened = id }} onOpenProjectData={id => { managed = id }} onOpenSettings={() => setView('settings')} onCreateProject={noop} onRenameProject={noop} onDeleteProject={noop} onRefresh={noop} />
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
  flushSync(() => window.fixture.setView('library-access'))
  assert(document.getElementById('storage-recovery-title')?.textContent === 'Open your City library', 'Permission gate must not claim the saved library is broken')
  assert(!libraryOpened, 'Opening a saved library must require an action')
  assert(document.querySelector('.storage-recovery-location p')?.textContent === config.storageRoot, 'Keep the saved library location visible')
  click('.storage-recovery .button-primary')
  assert(libraryOpened, 'Open library button must request folder selection')

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
window.checkStreetAccess = async () => {
  flushSync(() => window.fixture.setView('imports')); await settle()
  const control = () => document.querySelector('select[aria-label="Pedestrian access"]')
  assert(control().value === 'public', 'Public permission must be the default')
  flushSync(() => { control().value = 'endpoints'; control().dispatchEvent(new Event('change', { bubbles: true })) })
  const upload = document.querySelector('input[accept=".osm.pbf,.pbf,application/octet-stream"]')
  const files = new DataTransfer(); files.items.add(new File(['fixture'], 'fixture.pbf'))
  upload.files = files.files; upload.dispatchEvent(new Event('change', { bubbles: true }))
  assert(streetAccessRequests.at(-1) === 'endpoints', 'The selected policy must reach file import')
  flushSync(() => window.fixture.setAccessCity('washington')); await settle()
  assert(control().value === 'public', 'An uncommitted permission choice cannot leak into another City')
  flushSync(() => window.fixture.setAccessReady(false)); await settle()
  assert(control().querySelector('[value="endpoints"]').disabled, 'Authorization requires a prepared timetable')
  flushSync(() => window.fixture.setAccessReady(true)); await settle()
  return { publicDefault: true, selectedPolicyImported: true, cityIsolation: true, timetableGuard: true }
}
window.checkDocumentation = async (dark = false) => {
  requests = []
  flushSync(() => { window.fixture.setView('settings'); window.fixture.setAppearance(dark ? 'dark' : 'light') })
  click('#settings-tab-documentation'); await settle()
  const ready = async () => {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      const frame = document.querySelector('.settings-docs-frame')
      const doc = frame?.contentDocument
      if (frame?.getAttribute('aria-busy') === 'false' && doc?.readyState === 'complete' && doc.querySelector('#search') && doc?.documentElement.dataset.theme === (dark ? 'dark' : 'light')) return doc
      await settle()
    }
    throw Error('Bundled documentation did not load')
  }
  let doc = await ready()
  assert(doc.documentElement.dataset.embedded === 'true', 'Reader is not embedded')
  const compact = doc.defaultView.innerWidth <= 960
  const header = doc.querySelector('.site-header')
  assert((getComputedStyle(header).display !== 'none') === compact, 'Embedded navigation does not match the reader width')
  if (compact) {
    const menu = doc.querySelector('.menu-button')
    menu.click(); await settle()
    assert(doc.querySelector('#sidebar').classList.contains('open'), 'Compact reader navigation cannot open')
    menu.click(); await settle()
    assert(!doc.querySelector('#sidebar').classList.contains('open'), 'Compact reader navigation cannot close')
    doc.defaultView.scrollTo(0, 200); await settle()
    assert(Math.abs(header.getBoundingClientRect().top) < 1, 'Compact reader navigation scrolls away')
  }
  doc.querySelector('[data-search-open]').click()
  const search = doc.querySelector('#search')
  search.value = 'routing'; search.dispatchEvent(new Event('input', { bubbles: true }))
  const result = doc.querySelector('#search-links a')
  assert(result, 'Offline documentation search has no results')
  result.click(); await settle()
  assert(doc.querySelectorAll('.doc-page:not([hidden])').length === 1, 'Search did not select one page')
  const source = doc.querySelector('.page-meta a')
  assert(source.href.startsWith('https://github.com/hytangs/vigo/blob/main/') && source.target === '_blank', 'Source link replaces Studio')
  assert(doc.documentElement.scrollWidth <= doc.documentElement.clientWidth + 1, 'Embedded reader overflows')
  const frame = document.querySelector('.settings-docs-frame')
  doc.querySelector('#chapters [data-nav=http-api]').click(); await settle()
  assert(document.querySelector('.settings-docs-frame') === frame && frame.getAttribute('aria-busy') === 'false', 'Guide navigation reloads the embedded reader')
  assert(!doc.querySelector('#page-http-api').hidden, 'Integrated HTTP reference did not open')
  const schema = await originalFetch(document.querySelector('.settings-docs-toolbar a').href).then(response => response.json())
  assert(schema.openapi === '3.1.0' && schema.info.version === '0.5.2', 'API schema is missing or stale')
  const codePage = [...doc.querySelectorAll('.doc-page')].find(page => page.querySelector('.copy'))
  doc.defaultView.location.hash = codePage.dataset.page; await settle()
  codePage.querySelector('.copy').click(); await settle()
  assert(/copied|manually/i.test(doc.querySelector('#copy-status').textContent), 'Copy control gives no outcome')
  assert(!requests.length, 'Reading documentation loaded City or routing state')
  assert(!document.querySelector('.settings-documentation [role=alert]'), 'Reader reported a load error')
  return { width: innerWidth, dark, offlineSearch: true, referenceAndSchema: true, sourceLinksExternal: true, noRoutingLoad: true }
}
window.checkLayout = async (view, dark = false) => {
  flushSync(() => { window.fixture.setView(view); window.fixture.setAppearance(dark ? 'dark' : 'light') })
  const root = document.querySelector('.app-frame'); root.scrollTop = 0
  assert(root.scrollWidth <= root.clientWidth + 1, 'Horizontal overflow: ' + view + ' at ' + innerWidth)
  for (const element of document.querySelectorAll(view === 'cities' ? '.city-card-actions button, .city-library-actions button' : view === 'imports' ? '.city-walking-access select, .osm-import-strip button' : '.settings-navigation button, .settings-theme')) {
    element.scrollIntoView({ block: 'center' })
    const box = element.getBoundingClientRect()
    assert(box.width > 0 && box.height >= 32 && box.right <= innerWidth + 1, 'Control clipped')
    assert(element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)), 'Control obscured')
  }
  root.scrollTop = 0
  return { width: innerWidth, view, dark, controlsReachable: true }
}
