import { createServer } from 'vite'
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
  const original = Storage.prototype.setItem;
  try {
    Storage.prototype.setItem = () => { throw Error('quota'); };
    flushSync(() => state.setScenarioDrafts([{id:'case-a',name:'Unsaved A',interventions:[]}]))
    check(state.draftStorageError.includes('could not be saved'), 'Missing save failure');
    check(JSON.parse(localStorage.getItem(A)).cases[0].name === 'Saved A', 'Failed save erased copy');
  } finally { Storage.prototype.setItem = original; }
  flushSync(() => state.setScenarioDrafts([{id:'case-a',name:'Recovered A',interventions:[]}]))
  check(!state.draftStorageError, 'Save did not recover');
  localStorage.setItem('damaged', '{'); mount('damaged');
  check(state.draftStorageError.includes('stored copy has been kept'), 'Malformed storage failure');
  check(localStorage.getItem('damaged') === '{', 'Malformed copy erased');
  mount(A);
  return { switch: true, staleCallback: true, remount: true, quotaRecovery: true, damagedCopyRetained: true };
};
window.checkReload = () => { check(state.scenarioDrafts[0].name === 'Recovered A', 'Reload lost draft'); return true; };
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
    const window = new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
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
  const child = spawn(electronPath, [...ciFlags, path.join(temporary,'main.cjs')], {stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:''}})
  const timeout = setTimeout(() => child.kill(), 60_000)
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', (code) => resolve(code ?? 1))
    })
  } finally { clearTimeout(timeout) }
} finally { await server.close(); await rm(temporary,{recursive:true,force:true}); }
