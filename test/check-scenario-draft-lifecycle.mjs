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
const city = id => ({ id, storagePath: '/library/' + id, name: id, feeds: [{ id: 'feed', importedAt: 'first' }] });
let state, root = createRoot(document.getElementById('root'));
function Component({project}) { state = useScenarioLibrary(project); return React.createElement('div', null, state.scenarioDrafts[0].name); }
function mount(id) { flushSync(() => root.render(React.createElement(React.StrictMode, null, React.createElement(Component, {project: city(id)})))); }
function check(condition, text) { if (!condition) throw Error(text); }
async function until(read, text) { for (let i = 0; i < 200; i++) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw Error('Timed out: ' + text); }
const ready = label => until(() => state.saveState === 'saved', label + ' did not load');
const savedName = (id, index = 0) => saved()[id]?.library?.scenarios?.[index]?.name;
window.runTests = async () => { try {
  mount('A'); await ready('City A');
  check(state.scenarioDrafts[0].name === 'Scenario A' && state.grouping.value.groups[0].feedIds.join() === 'feed', 'New City defaults');
  check(window.puts === 0, 'Viewing a City must not write a library');
  flushSync(() => state.setScenarioDrafts(current => [{ ...current[0], name: 'Saved A' }]));
  await until(() => savedName('A') === 'Saved A', 'Edit not saved to the City');
  const stale = state.setScenarioDrafts;
  mount('B'); await ready('City B');
  check(state.scenarioDrafts[0].name === 'Scenario A', 'City isolation');
  flushSync(() => stale(current => [{ ...current[0], name: 'Late old callback' }]));
  check(state.scenarioDrafts[0].name === 'Scenario A', 'Stale callback changed new City');
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
