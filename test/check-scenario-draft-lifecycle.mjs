import { createViteTestServer as createServer } from './helpers/vite-test-server.mjs'
import electronPath from 'electron'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
const root = path.resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(path.join(tmpdir(), 'vigo-draft-lifecycle-'))
const harness = `import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useScenarioLibrary } from '/src/app/useScenarioLibrary.ts';
import { updateScenarioNetwork, scenarioNetworkDiffers, recoverEmptyBaseline } from '/src/app/scenarioLibrary.ts';
import { city as cityStore } from '/src/state/city.ts';
import { openScenariosView } from '/src/state/navigation.ts';
import { bundleFeedId } from '/src/app/projectState.ts';
import { createScenarioRoadGeometryRequest } from '/src/app/scenarioRoadGeometryRequest.ts';
// A small in-page stand-in for the City folder: GET and PUT /api/projects/{id}/scenarios.
// sessionStorage keeps it across the reload check.
const serverKey = 'scenario-library-server', damaged = new Set();
const saved = () => JSON.parse(sessionStorage.getItem(serverKey) || '{}');
const realFetch = window.fetch.bind(window);
window.puts = 0;
window.fetch = async (input, options = {}) => {
  const match = String(input).match(/\\/api\\/projects\\/([^/]+)\\/scenarios$/);
  if (!match) return realFetch(input, options);
  const id = decodeURIComponent(match[1]), state = saved(), entry = state[id] || { library: null, revision: 0 };
  if (damaged.has(id)) return Response.json({ error: 'Saved scenarios could not be read. The file has been kept unchanged.' }, { status: 500 });
  if (!options.method || options.method === 'GET') return Response.json(entry);
  const body = JSON.parse(options.body);
  if (body.baseRevision !== entry.revision) return Response.json({ error: 'changed', library: entry.library, revision: entry.revision }, { status: 409 });
  window.puts += 1;
  state[id] = { library: { ...body.library, revision: entry.revision + 1 }, revision: entry.revision + 1 };
  sessionStorage.setItem(serverKey, JSON.stringify(state));
  return Response.json(state[id]);
};
const city = id => ({ id, storagePath: '/library/' + id, name: id, feeds: [{ id: 'feed', importedAt: 'first' }, { id: 'other', importedAt: 'first' }] });
let state, root = createRoot(document.getElementById('root'));
function Component({project}) { state = useScenarioLibrary(project); return React.createElement('div', null, state.scenarioDrafts[0].name); }
function mount(id, project = city(id)) { flushSync(() => root.render(React.createElement(React.StrictMode, null, React.createElement(Component, {project})))); }
function check(condition, text) { if (!condition) throw Error(text); }
async function until(read, text) { for (let i = 0; i < 200; i++) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw Error('Timed out: ' + text); }
const ready = label => until(() => state.saveState === 'saved', label + ' did not load');
const savedName = (id, index = 0) => saved()[id]?.library?.scenarios?.[index]?.name;
window.runTests = async () => { try {
  cityStore.set({ projects: [{ ...city('scope'), summary: {feeds:2,routes:2} }], selectedProjectId: 'scope', activeFeedId: 'feed' });
  openScenariosView();
  check(cityStore.get().activeFeedId === bundleFeedId, 'Scenarios inherited a single-feed filter with unscoped route IDs');
  const shared = { groups: [{id:'baseline',name:'Baseline',feedIds:['feed']}, {id:'network-a',name:'Shared',feedIds:['feed']}],
    scenarios: [{id:'a',name:'A',groupId:'network-a',interventions:[]}, {id:'b',name:'B',groupId:'network-a',interventions:[]}] };
  const changed = updateScenarioNetwork(shared, 'a', 'other', true);
  check(changed.scenarios[0].groupId !== 'network-a' && changed.scenarios[1].groupId === 'network-a', 'Shared network was edited in place');
  check(changed.groups.find(group => group.id === 'network-a').feedIds.join() === 'feed', 'Another scenario was changed');
  check(scenarioNetworkDiffers(changed.groups, changed.scenarios[0].groupId), 'Timetable-only change was missed');
  const reduced = updateScenarioNetwork(changed, 'a', 'feed', false);
  check(updateScenarioNetwork(reduced, 'a', 'other', false) === reduced, 'Last timetable was removed');
  check(!scenarioNetworkDiffers([{id:'baseline',feedIds:['b','a','a']},{id:'same',feedIds:['a','b']}], 'same'), 'Order or duplicates changed network identity');
  // Importing GTFS after opening an empty City must populate its baseline.
  mount('imported', { ...city('imported'), feeds: [] }); await ready('Empty City');
  check(state.grouping.value.groups[0].feedIds.length === 0, 'Empty City invented feeds');
  mount('imported');
  await until(() => state.grouping.value.groups[0].feedIds.length === 2, 'Imported feeds did not reach the baseline');
  await ready('Imported baseline saved');
  check(saved()['imported'].library.groups[0].feedIds.length === 2, 'Recovered baseline was not persisted');

  // Repair an already-saved empty baseline without losing authored changes.
  const broken = saved();
  broken.broken = { revision: 3, library: { groups: [{id:'baseline',name:'Baseline',feedIds:[]}, {id:'custom',name:'Custom',feedIds:[]}],
    scenarios: [{id:'plan',name:'My plan',groupId:'baseline',changes:[]}], schemaVersion:'vigo.studio.scenarios.v1' } };
  sessionStorage.setItem(serverKey, JSON.stringify(broken));
  mount('broken'); await ready('Recovered saved City');
  check(state.grouping.value.groups[0].feedIds.length === 2, 'Saved empty baseline remained unusable');
  check(state.grouping.value.groups[1].feedIds.length === 0, 'Custom empty group was overwritten');
  check(state.scenarioDrafts[0].name === 'My plan', 'Recovery replaced the authored scenario');
  check(recoverEmptyBaseline(shared, city('check')) === shared, 'Explicit baseline selection was expanded');

  mount('shared'); await ready('Shared definitions City');
  const sharedChange = {id:'clarkson',name:'Clarkson Line',kind:'add-line',stops:[],headwayMinutes:10,averageSpeedKph:25,startMinutes:300,endMinutes:1500,bidirectional:true};
  flushSync(() => state.setScenarioDrafts([
    {id:'a',name:'A',groupId:'baseline',interventions:[sharedChange]},
    {id:'b',name:'B',groupId:'baseline',interventions:[sharedChange]},
  ]));
  flushSync(() => state.setScenarioDrafts(current => current.map(entry => entry.id === 'a' ? {...entry,interventions:[{...entry.interventions[0],headwayMinutes:7}]} : entry)));
  check(state.scenarioDrafts.every(entry => entry.interventions[0].headwayMinutes === 7), 'Editing a definition did not update every composition');
  flushSync(() => state.deleteReusableChange('clarkson'));
  check(state.reusableChanges.length === 1, 'Deleted a definition still used by scenarios');
  flushSync(() => state.setScenarioDrafts(current => current.map(entry => ({...entry,interventions:[]}))));
  check(state.reusableChanges[0].headwayMinutes === 7, 'Removing the last membership lost the definition');
  flushSync(() => state.setScenarioNetworkFeed('a', 'other', false));
  check(state.reusableChanges[0]?.headwayMinutes === 7, 'Changing timetables discarded unused definitions');
  await until(() => saved()['shared']?.library?.sharedChanges?.[0]?.headwayMinutes === 7 && saved()['shared'].library.scenarios.every(entry => !entry.changes.length), 'Unused shared definition was not saved');
  mount('away'); await ready('Away'); mount('shared'); await ready('Reopened shared City');
  check(state.reusableChanges[0]?.name === 'Clarkson Line', 'Reload lost an unused definition');
  const reusable = state.reusableChanges[0];
  flushSync(() => state.setScenarioDrafts(current => current.map(entry => entry.id === 'b' ? {...entry,interventions:[reusable]} : entry)));
  check(state.scenarioDrafts[1].interventions[0].headwayMinutes === 7, 'Reassembly restored a stale definition');
  flushSync(() => state.setScenarioDrafts(current => current.filter(entry => entry.id !== 'b')));
  check(state.reusableChanges.length === 1, 'Deleting a scenario deleted its definitions');
  flushSync(() => state.deleteReusableChange('clarkson'));
  check(state.reusableChanges.length === 0, 'Unused definition could not be deleted');

  mount('compose'); await ready('Composition City');
  const composeId = state.scenarioDrafts[0].id;
  const editFeed = state.setScenarioNetworkFeed;
  flushSync(() => { editFeed(composeId, 'feed', false); editFeed(composeId, 'feed', true); editFeed(composeId, 'other', false); });
  const composedGroup = state.grouping.value.groups.find(group => group.id === state.scenarioDrafts[0].groupId);
  check(composedGroup.feedIds.join() === 'feed', 'Batched network edits lost a selection');
  check(state.grouping.value.groups.find(group => group.id === 'baseline').feedIds.join() === 'feed,other', 'Composition mutated baseline');
  await until(() => saved()['compose']?.library?.groups?.some(group => group.id === composedGroup.id && group.feedIds.join() === 'feed'), 'Composed network was not saved');
  mount('A'); await ready('City A');
  check(state.scenarioDrafts[0].name === 'Current network' && state.grouping.value.groups[0].feedIds.join() === 'feed,other', 'New City defaults');
  const putsBeforeView = window.puts;
  await new Promise(resolve => setTimeout(resolve, 500));
  check(window.puts === putsBeforeView, 'Viewing a City must not write a library');
  flushSync(() => editFeed(composeId, 'other', true));
  check(state.grouping.value.groups.length === 1, 'Old City network callback changed new City');
  flushSync(() => state.setScenarioDrafts(current => [{ ...current[0], name: 'Saved A' }]));
  await until(() => savedName('A') === 'Saved A', 'Edit not saved to the City');
  const stale = state.setScenarioDrafts;
  mount('B'); await ready('City B');
  check(state.scenarioDrafts[0].name === 'Current network', 'City isolation');
  flushSync(() => stale(current => [{ ...current[0], name: 'Late old callback' }]));
  check(state.scenarioDrafts[0].name === 'Current network', 'Stale callback changed new City');
  mount('A'); await until(() => state.scenarioDrafts[0].name === 'Saved A', 'Switch lost the saved scenario');
  flushSync(() => root.unmount()); root = createRoot(document.getElementById('root')); mount('A');
  await until(() => state.scenarioDrafts[0].name === 'Saved A', 'Remount lost the saved scenario');

  // Another window saves first: this window adopts that copy instead of overwriting it.
  const server = saved();
  server.A = { library: { ...server.A.library, scenarios: [{ ...server.A.library.scenarios[0], name: 'Other window' }], revision: server.A.revision + 1 }, revision: server.A.revision + 1 };
  sessionStorage.setItem(serverKey, JSON.stringify(server));
  flushSync(() => state.setScenarioDrafts(current => [{ ...current[0], name: 'This window' }]));
  await until(() => state.scenarioDrafts[0].name === 'Other window', 'A conflicting save overwrote another window');
  check(state.grouping.error.includes('another window'), 'Conflict was not explained');
  check(savedName('A') === 'Other window', 'The newer saved copy changed');
  flushSync(() => state.setScenarioDrafts(current => [{ ...current[0], name: 'Saved A' }]));
  await until(() => savedName('A') === 'Saved A', 'Saving after a conflict failed');

  // A copy that cannot be read is never written over; edits stay in the window.
  damaged.add('damaged'); mount('damaged');
  await until(() => state.saveState === 'unavailable', 'Unreadable library not reported');
  check(state.draftStorageError.includes('kept unchanged'), 'Unreadable library message');
  const putsBefore = window.puts;
  flushSync(() => state.setScenarioDrafts(current => [{ ...current[0], name: 'Unsaved edit' }]));
  await new Promise(resolve => setTimeout(resolve, 700));
  check(state.scenarioDrafts[0].name === 'Unsaved edit' && window.puts === putsBefore, 'An unreadable library was overwritten');

  // Drafts kept in this browser by earlier Studio versions move into the City once.
  localStorage.setItem('vigo.scenarios.v1:' + JSON.stringify(['/library/legacy', 'legacy', [['feed', 'first']], '', '']), JSON.stringify({
    cases: [{ id: 'case-a', name: 'Legacy plan', interventions: [{ id: 'line', name: 'Line', kind: 'add-line', stops: [], headwayMinutes: 10,
      averageSpeedKph: 25, startMinutes: 300, endMinutes: 1500, bidirectional: true }] }], activeCaseId: 'case-a', activeChangeId: 'line' }));
  mount('legacy');
  await until(() => savedName('legacy') === 'Legacy plan', 'Browser drafts were not moved into the City');
  check(state.scenarioDrafts[0].groupId === 'baseline', 'Migrated scenario lost its timetable group');

  const change = (id, geometryStatus) => ({
    id, name:id, kind:'add-line', stops:[], headwayMinutes:10, averageSpeedKph:25,
    startMinutes:300, endMinutes:1500, bidirectional:true, geometryMode:'auto-road',
    geometryStatus, geometryError:geometryStatus === 'error' ? 'Existing error' : '',
  });
  const changes = () => state.scenarioDrafts[0].interventions;
  mount('road-A'); await ready('Road City A');
  flushSync(() => state.setScenarioDrafts([{id:'case-road',name:'Road A',groupId:'baseline',interventions:[
    change('pending', 'loading'), change('ready', 'ready'), change('error', 'error'),
  ]}]));
  const stableScope = state.grouping.value;
  const cancelled = createScenarioRoadGeometryRequest('pending', state.setScenarioDrafts);
  flushSync(() => cancelled.abort());
  check(changes()[0].geometryStatus === 'idle', 'Cancellation left road geometry loading');
  check(changes()[1].geometryStatus === 'ready', 'Cancellation cleared finished road geometry');
  check(changes()[2].geometryError === 'Existing error', 'Cancellation cleared another road error');
  flushSync(() => state.setScenarioDrafts(current => current.map(entry => ({...entry,
    interventions:entry.interventions.map(item => item.id === 'pending' ? {...item, geometryStatus:'loading'} : item),
  }))));
  await until(() => saved()['road-A']?.library?.scenarios?.[0]?.changes?.length === 3, 'Road City not saved');
  check(saved()['road-A'].library.scenarios[0].changes[0].geometryStatus === 'idle', 'A loading road path was saved as loading');
  check(state.grouping.value === stableScope, 'Road status updates or save acknowledgements changed network scope and would abort the running trace');
  const oldCityRequest = createScenarioRoadGeometryRequest('pending', state.setScenarioDrafts);
  flushSync(() => cancelled.abort());
  check(changes()[0].geometryStatus === 'loading', 'An old cancellation cleared a retry');
  mount('road-B'); await ready('Road City B');
  flushSync(() => state.setScenarioDrafts([{id:'case-road',name:'Road B',groupId:'baseline',interventions:[change('pending', 'loading')]}]));
  const newCityRequest = createScenarioRoadGeometryRequest('pending', state.setScenarioDrafts);
  flushSync(() => oldCityRequest.abort());
  check(changes()[0].geometryStatus === 'loading', 'Old City cancellation changed the new City');
  flushSync(() => newCityRequest.abort());
  check(changes()[0].geometryStatus === 'idle', 'New City cancellation failed after switching Cities');
  mount('A'); await until(() => state.scenarioDrafts[0].name === 'Saved A', 'Returning to City A');
  return { cityFolder: true, staleCallback: true, remount: true, conflict: true, unreadableCopyKept: true, migration: true, roadCancellation: true, roadCityIsolation: true };
} catch (error) { return { failed: error.stack || String(error) }; } };
window.checkReload = async () => { mount('A'); await until(() => state.scenarioDrafts[0].name === 'Saved A', 'Reload lost the saved scenario'); return true; };
`
const server = await createServer({ root, configFile: false, optimizeDeps: {include:['react','react-dom','react-dom/client']}, server: { host:'127.0.0.1', port:0 }, plugins:[{
  name:'draft-lifecycle', configureServer(server) { server.middlewares.use((req,res,next) => {
    if (req.url === '/draft-lifecycle.html') { res.setHeader('Content-Type','text/html'); res.end('<div id="root"></div><script type="module" src="/draft-lifecycle.js"></script>'); }
    else if (req.url === '/draft-lifecycle.js') { res.setHeader('Content-Type','text/javascript'); server.transformRequest('virtual:draft-lifecycle').then(result=>res.end(result.code)).catch(next); }
    else next();
  }); }, resolveId(id) { if (id === 'virtual:draft-lifecycle') return id; }, load(id) { if (id === 'virtual:draft-lifecycle') return harness; }
}] })
await server.listen()
await writeFile(path.join(temporary,'main.cjs'), `const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(path.join(temporary,'profile'))});
app.whenReady().then(async () => {
  try {
    const window = new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false,nodeIntegration:false,contextIsolation:true,sandbox:true}});
    await window.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/draft-lifecycle.html`)});
    const result = await window.webContents.executeJavaScript('window.runTests()');
    if (result.failed) throw Error(result.failed);
    await window.loadURL(window.webContents.getURL());
    result.reload = await window.webContents.executeJavaScript('window.checkReload()');
    console.log(JSON.stringify({passed:true,...result})); app.exit(0);
  } catch(error) { console.error(error); app.exit(1); }
});`)
try {
  const ciFlags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronPath, [...ciFlags, path.join(temporary,'main.cjs')], {stdio:'inherit',env})
  const timeout = setTimeout(() => child.kill(), 60_000)
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', (code) => resolve(code ?? 1))
    })
  } finally { clearTimeout(timeout) }
} finally { await server.close(); await rm(temporary,{recursive:true,force:true}); }
