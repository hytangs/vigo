import {runElectronCheck} from './helpers/electron-check.mjs'
const main = new URL('../public/main.mjs', import.meta.url).href
await runElectronCheck(`
const fs = await import('node:fs/promises');
const path = await import('node:path');
await import(${JSON.stringify(main)});
await app.whenReady();
const window = await until(() => BrowserWindow.getAllWindows()[0]);
await until(() => !window.webContents.isLoading());
for (const endpoint of ['/api/health', '/api/projects']) {
  const response = await net.fetch('vigo://studio' + endpoint);
  assert.equal(response.status, 200);
  await response.arrayBuffer();
}
const records = await until(async () => {
  const text = await fs.readFile(path.join(app.getPath('userData'), 'startup.jsonl'), 'utf8').catch(()=>'');
  const rows = text.trim().split('\\n').filter(Boolean).map(line => JSON.parse(line));
  return ['app-ready','engine-starting','engine-ready','window-loaded','city-list','health'].every(p=>rows.some(r=>r.phase===p)) ? rows : null;
});
assert(records.every(r=>Number.isFinite(r.elapsedMs)));
assert(records.filter(r=>r.phase==='city-list').length===1);
assert(records.every(r=>!('body' in r) && !('path' in r)));
`)
console.log('Studio launch trace records readiness and first requests without request bodies or City paths.')
