import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { CityDataSources } from '../../src/components/studio/CityDataSources'
import { CityPanel } from '../../src/components/CityPanel'
import { caseFeedSelection } from '../../src/app/cityDataGroups'
import { useScenarioLibrary } from '../../src/app/useScenarioLibrary'
import { emptyCityProject } from '../../src/app/projectState'
import '../../src/App.css'
import '../../src/index.css'
const noop = () => {}
const makeFeed = (id, name) => ({ id, name, importedAt: '2026-10-08', fileName: `${id}.zip`, source: 'local', provider: name,
  routeCount: 171, stopCount: 6830, tripCount: 41726, requiredTables: [], optionalTables: [], tableProfiles: [], warnings: [],
  routingStore: { status: 'ready', routingEligibility: 'exact' } })
const boston = { ...emptyCityProject(), id: 'boston', name: 'Boston', storagePath: '/fixture/boston',
  feeds: [makeFeed('mbta', 'MBTA · Fall 2026'), makeFeed('massport', 'Massport shuttles'), makeFeed('future', 'North–South Rail Link')],
  routingStore: { status: 'ready', routingEligibility: 'exact' }, osmStreetIndex: { status: 'ready' } }
const dc = { ...boston, id: 'dc', name: 'Washington', storagePath: '/fixture/dc', feeds: [makeFeed('wmata', 'WMATA')] }
// The City folder's saved scenarios, served as Studio's API serves them.
const savedLibraries = {
  boston: { revision: 1, library: { schemaVersion: 'vigo.studio.scenarios.v1', revision: 1,
    groups: [{ id: 'baseline', name: 'Baseline', feedIds: ['mbta', 'massport', 'future'] }],
    scenarios: [{ id: 'case-a', name: 'Morning commute', groupId: 'baseline', changes: [] }, { id: 'case-b', name: 'Rail extension', groupId: 'baseline', changes: [] }] } },
}
window.savedLibraries = savedLibraries
window.fetch = async (input, options = {}) => {
  const match = String(input).match(/\/api\/projects\/([^/]+)\/scenarios$/)
  if (!match) return Response.json({ error: 'Unused fixture endpoint' }, { status: 404 })
  const id = decodeURIComponent(match[1]), entry = savedLibraries[id] ?? { library: null, revision: 0 }
  if (!options.method || options.method === 'GET') return Response.json(entry)
  const body = JSON.parse(options.body)
  if (body.baseRevision !== entry.revision) return Response.json({ error: 'changed', ...entry }, { status: 409 })
  savedLibraries[id] = { revision: entry.revision + 1, library: { ...body.library, revision: entry.revision + 1 } }
  return Response.json(savedLibraries[id])
}
let root = createRoot(document.getElementById('root')), opened = '', sourcePicks = 0
function Fixture() {
  const [project, setProject] = useState(boston), [appearance, setAppearance] = useState('light')
  const library = useScenarioLibrary(project)
  const grouping = library.grouping, cases = library.scenarioDrafts, setCases = library.setScenarioDrafts
  window.fixture = { grouping, library, project, setProject, setAppearance, cases }
  const props = { isImporting: false, isOsmImporting: false, osmStreetReady: true, importMessage: '', osmStreetMessage: '', realtimeSnapshot: null, realtimeMessage: '', realtimeRequest: null,
    isRealtimeLoading: false, onFiles: noop, onOsmFiles: noop, onNationalGtfsPath: noop, onNationalOsmPath: noop, onConnectRealtime: noop, onDisconnectRealtime: noop, onCancelGtfs: noop, onRetryGtfs: noop, onCancelOsm: noop, onRetryOsm: noop }
  return <main className={`app-shell appearance-${appearance} accent-graphite page-project view-data`}>
    <header className="topbar" style={{ padding: '12px 24px', margin: 0, display: 'flex', alignItems: 'center' }}><b>VIGO Studio</b><span style={{ marginLeft: 12, color: 'var(--text-muted)' }}>City data</span></header>
    <div className="app-frame" style={{ overflow: 'auto', display: 'block' }}><CityPanel
      section="feeds" projectId={project.id} projectName={project.name} projectRegion="" feedCount={3} routeCount={0} stopCount={0} appearance={appearance}
      basemap="minimal" localBasemapAvailable runtimeConfig={null} health={null} busy={false} error="" projects={[project]}
      onSectionChange={noop} onChooseFolder={noop} onAppearanceChange={setAppearance} onBasemapChange={noop} onCityReset={noop} onCityRemoved={async () => true}
      feeds={<CityDataSources key={project.id} project={project} grouping={grouping} cases={cases} {...props}
        deletingDisabled={false} onSourceDeleted={noop} onAddCase={groupId => {
          const id = `case-${cases.length}`; setCases(current => [...current, { id, name: 'New case', groupId, interventions: [] }])
        }} onRenameCase={(id,name) => setCases(current => current.map(entry => entry.id === id ? { ...entry,name } : entry))}
        onOpenCase={id => { opened = id }} />}
    /></div>
  </main>
}
flushSync(() => root.render(<Fixture />))
const assert = (condition, message) => { if (!condition) throw Error(message) }
const click = selector => { const element = document.querySelector(selector); assert(element, 'Missing ' + selector); flushSync(() => element.click()); return element }
const type = (selector, value) => flushSync(() => { const element = document.querySelector(selector); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
const select = (selector, value) => flushSync(() => { const element = document.querySelector(selector); element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })) })
const until = async (read, label) => { for (let i = 0; i < 200; i++) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 25)) } throw Error('Fixture timed out: ' + label) }
const loaded = () => until(() => window.fixture.library.saveState === 'saved', 'saved scenarios did not load')
window.checkData = async () => {
  await loaded()
  assert(document.querySelectorAll('.city-feed-entry').length === 3, 'Timetables not listed')
  assert(!document.querySelector('.data-readiness-rail') && !document.querySelector('.bundle-summary'), 'Duplicate dashboard remains')
  assert(!document.querySelector('.city-live-disclosure').open, 'Live setup exposed by default')
  assert(!document.querySelector('.network-import-example'), 'Example tutorial present in prepared City')
  click('.city-data-groups > button')
  assert(document.querySelector('.city-group-dialog').open, 'Group editor missing')
  type('.city-group-name input', 'Future network')
  click('.city-group-feed:nth-of-type(1) input'); click('.city-group-feed:nth-of-type(3) input')
  click('.city-group-dialog button[type=submit]')
  const group = window.fixture.grouping.value.groups.find(entry => entry.name === 'Future network')
  assert(group && group.feedIds.join() === 'mbta,future', 'Group lost selected timetables')
  assert(window.fixture.grouping.value.groups[0].feedIds.includes('mbta'), 'Adding a group removed shared feed from baseline')
  await until(() => savedLibraries.boston.library.groups.length === 2, 'Groups not saved to the City')
  click('.city-data-switch button:last-child')
  select('[aria-label="Feed group for Rail extension"]', group.id)
  assert(caseFeedSelection(window.fixture.grouping.value, 'case-b', boston).feedIds.join() === 'mbta,future', 'Case did not inherit its group feeds')
  click('[aria-label="Open Rail extension"]'); assert(opened === 'case-b', 'Case action opened the wrong case')
  // City selection must isolate group membership even when case IDs repeat.
  const staleAssign = window.fixture.grouping.assignCase
  flushSync(() => window.fixture.setProject(dc))
  flushSync(() => staleAssign('case-a', group.id))
  assert(window.fixture.grouping.value.groups.length === 1, 'Groups leaked between Cities')
  assert(caseFeedSelection(window.fixture.grouping.value, 'case-a', dc).feedIds.join() === 'wmata', 'Old callback wrote to new City')
  flushSync(() => window.fixture.setProject(boston))
  await loaded()
  assert(caseFeedSelection(window.fixture.grouping.value, 'case-b', boston).feedIds.join() === 'mbta,future', 'Returning to City lost case membership')
  flushSync(() => window.fixture.grouping.saveGroup('empty', 'Empty', []))
  flushSync(() => window.fixture.grouping.assignCase('case-a','empty'))
  assert(caseFeedSelection(window.fixture.grouping.value,'case-a',boston).error, 'Empty group silently used the whole City')
  flushSync(() => window.fixture.grouping.assignCase('case-a','baseline'))
  flushSync(() => window.fixture.grouping.removeGroup('empty'))
  const removed = { ...boston, feeds: boston.feeds.filter(feed=>feed.id!=='future') }
  assert(caseFeedSelection(window.fixture.grouping.value,'case-b',removed).error, 'Removed source silently changed a case')
  // Reload the hook rather than trusting only the last in-memory update.
  await until(() => savedLibraries.boston.library.groups.every(group => group.id !== 'empty'), 'Removed group not saved')
  flushSync(() => { root.unmount(); root = createRoot(document.getElementById('root')); root.render(<Fixture />) })
  await loaded()
  assert(caseFeedSelection(window.fixture.grouping.value,'case-b',boston).feedIds.join() === 'mbta,future', 'Reload lost case membership')
  const fileInput = document.querySelector('input[type=file]'); fileInput.addEventListener('click',event => { event.preventDefault(); sourcePicks++ })
  click('.city-data-actions .button'); assert(sourcePicks === 1, 'GTFS import no longer opens picker')
  click('.city-feed-entry summary'); click('.city-feed-detail .city-source-delete')
  assert(document.querySelector('.city-source-dialog').open, 'Source deletion lost confirmation')
  document.querySelector('.city-source-dialog').close(); document.querySelector('.city-feed-entry').open = false
  return { sharedFeedGroups:true, exactCaseMembership:true, persistence:true, cityIsolation:true, staleCallbackGuard:true, emptyAndMissingInputs:true, importPicker:true, deleteConfirmation:true }
}
window.checkDataLayout = async (view = 'feeds', dark = false) => {
  flushSync(() => window.fixture.setAppearance(dark ? 'dark' : 'light'))
  if(view === 'group') { click('.city-data-groups > button'); type('.city-group-name input', 'Future network') }
  else click('.city-data-switch button:' + (view === 'cases' ? 'last-child' : 'first-child'))
  const scroller = document.querySelector('.app-frame'); scroller.scrollTop = 0
  assert(scroller.scrollWidth <= scroller.clientWidth + 1, 'Horizontal overflow at ' + innerWidth + ' ' + view)
  const selector = view==='group' ? '.city-group-dialog input, .city-group-dialog button' : '.city-data-switch button, .city-data-groups > button, .city-data-actions button, .city-case-entry select, .city-case-entry > button'
  for(const element of document.querySelectorAll(selector)) {
    element.scrollIntoView({block:'center'}); const r=element.getBoundingClientRect()
    assert(r.width>0 && r.height>0 && r.left>=-1 && r.right<=innerWidth+1, 'Control clipped: '+view)
    assert(element.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)), 'Control obscured: '+element.outerHTML)
  }
  if(view==='group') click('[aria-label="Close group editor"]')
  scroller.scrollTop=0
  for(const animation of document.getAnimations())if(animation.effect?.getTiming().iterations !== Infinity)animation.finish()
  return { width:innerWidth,view,dark,controlsReachable:true }
}
