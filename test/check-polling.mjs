import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { runElectronCheck } from './helpers/electron-check.mjs'
const module = ts.transpileModule(await readFile(new URL('../src/app/polling.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText.replace('export function', 'function')
await runElectronCheck(`
await app.whenReady();
const window = new BrowserWindow({ show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
await window.loadURL('data:text/html,<title>Polling lifecycle</title>');
const result = await window.webContents.executeJavaScript(${JSON.stringify(`(async () => {
${module}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let completed = 0, active = 0, peak = 0;
const poll = startPolling(async signal => { active++; peak = Math.max(peak, active); await wait(30); if (!signal.aborted) completed++; active--; }, 20);
await wait(10);
await Promise.all([poll.refresh(), poll.refresh()]);
if (completed !== 1 || peak !== 1) throw Error('Concurrent polling was not coalesced');
await wait(90);
if (completed < 2 || peak !== 1) throw Error('Real timers did not serialize polling');
poll.stop();
const stopped = completed;
await wait(100);
if (completed !== stopped) throw Error('Polling continued after cleanup');
let reads = 0;
const immediate = startPolling(async () => { reads++; }, 20);
immediate.stop();
await wait(50);
if (reads !== 0) throw Error('Stop before first read failed');
return true;
})()`)});
assert.equal(result, true);
`)
console.log('Polling with real browser document and timers: serialization, manual coalescing and cleanup passed.')
