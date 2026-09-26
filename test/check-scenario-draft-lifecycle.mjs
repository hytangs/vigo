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
import { useScenarioDrafts } from '/src/app/useScenarioDrafts.ts';
import { createScenarioRoadGeometryRequest } from '/src/app/scenarioRoadGeometryRequest.ts';
let state, root = createRoot(document.getElementById('root'));
const A = 'draft-lifecycle-A', B = 'draft-lifecycle-B';
function Component({city}) { state = useScenarioDrafts(city); return React.createElement('div', null, state.scenarioDrafts[0].name); }
function mount(city) { flushSync(() => root.render(React.createElement(React.StrictMode, null, React.createElement(Component, {city})))); }
function check(condition, text) { if (!condition) throw Error(text); }
mount(A);
window.runTests = () => {
  flushSync(() => state.setScenarioDrafts([{id:'case-a', name:'Saved A', interventions:[]}]));
  check(JSON.parse(localStorage.getItem(A)).cases[0].name === 'Saved A', 'Edit not saved');
  const stale = state.setScenarioDrafts;
  mount(B);
  check(state.scenarioDrafts[0].name === 'Case A', 'City isolation');
  flushSync(() => stale([{id:'case-a',name:'Late old callback',interventions:[]}]))
  check(state.scenarioDrafts[0].name === 'Case A', 'Stale callback changed new City');
  flushSync(() => state.setScenarioDrafts([{id:'case-a',name:'Saved B',interventions:[]}]))
  mount(A);
  check(state.scenarioDrafts[0].name === 'Saved A', 'Switch lost draft');
  flushSync(() => root.unmount());
  root = createRoot(document.getElementById('root')); mount(A);
  check(state.scenarioDrafts[0].name === 'Saved A', 'Remount lost draft');
  localStorage.setItem('damaged', '{'); mount('damaged');
  check(state.draftStorageError.includes('stored copy has been kept'), 'Malformed storage failure');
  check(localStorage.getItem('damaged') === '{', 'Malformed copy erased');
  const change = (id, geometryStatus) => ({
    id, name:id, kind:'add-line', stops:[], headwayMinutes:10, averageSpeedKph:25,
    startMinutes:300, endMinutes:1500, bidirectional:true, geometryMode:'auto-road',
    geometryStatus, geometryError:geometryStatus === 'error' ? 'Existing error' : '',
  });
  const changes = () => state.scenarioDrafts[0].interventions;
  mount('road-lifecycle-A');
  flushSync(() => state.setScenarioDrafts([{id:'case-road',name:'Road A',interventions:[
    change('pending', 'loading'), change('ready', 'ready'), change('error', 'error'),
  ]}]));
  const cancelled = createScenarioRoadGeometryRequest('pending', state.setScenarioDrafts);
  flushSync(() => cancelled.abort());
  check(changes()[0].geometryStatus === 'idle', 'Cancellation left road geometry loading');
  check(changes()[1].geometryStatus === 'ready', 'Cancellation cleared finished road geometry');
  check(changes()[2].geometryError === 'Existing error', 'Cancellation cleared another road error');
  check(JSON.parse(localStorage.getItem('road-lifecycle-A')).cases[0].interventions[0].geometryStatus === 'idle', 'Cancelled loading state remained saved');
  flushSync(() => state.setScenarioDrafts(current => current.map(entry => ({...entry,
    interventions:entry.interventions.map(item => item.id === 'pending' ? {...item, geometryStatus:'loading'} : item),
  }))));
  const oldCityRequest = createScenarioRoadGeometryRequest('pending', state.setScenarioDrafts);
  flushSync(() => cancelled.abort());
  check(changes()[0].geometryStatus === 'loading', 'An old cancellation cleared a retry');
  mount('road-lifecycle-B');
  flushSync(() => state.setScenarioDrafts([{id:'case-road',name:'Road B',interventions:[change('pending', 'loading')]}]));
  const newCityRequest = createScenarioRoadGeometryRequest('pending', state.setScenarioDrafts);
  flushSync(() => oldCityRequest.abort());
  check(changes()[0].geometryStatus === 'loading', 'Old City cancellation changed the new City');
  flushSync(() => newCityRequest.abort());
  check(changes()[0].geometryStatus === 'idle', 'New City cancellation failed after switching Cities');
  mount('road-lifecycle-A');
  check(changes()[0].geometryStatus === 'idle', 'Returning to a City restored an abandoned loading state');
  mount(A);
  return { switch: true, staleCallback: true, remount: true, damagedCopyRetained: true, roadCancellation:true, roadRetry:true, roadCityIsolation:true };
};
window.checkReload = () => { check(state.scenarioDrafts[0].name === 'Saved A', 'Reload lost draft'); return true; };
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
    const result = await window.webContents.executeJavaScript('(() => { try { return window.runTests() } catch(e) { return {failed:e.stack}; } })()');
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
