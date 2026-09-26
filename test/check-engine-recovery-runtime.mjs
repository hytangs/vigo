import { runElectronCheck } from './helpers/electron-check.mjs'
const main = new URL('../public/main.mjs', import.meta.url).href
await runElectronCheck(`
await import(${JSON.stringify(main)});
await app.whenReady();
const window = await until(() => BrowserWindow.getAllWindows()[0]);
await until(() => !window.webContents.isLoading());
const engine = () => app.getAppMetrics().find(metric => metric.name === 'VIGO Engine' || metric.serviceName === 'VIGO Engine');
const preferences = window.webContents.getLastWebPreferences();
assert.equal(preferences.contextIsolation, true);
assert.equal(preferences.nodeIntegration, false);
assert.equal(preferences.sandbox, true);
assert.equal(preferences.webSecurity, true);
const initial = await until(engine);
const health = async () => { try { return (await net.fetch('vigo://studio/api/health')).status === 200; } catch { return false; } };
assert(await until(health));
process.kill(initial.pid, 'SIGKILL');
const second = await until(() => { const current = engine(); return current && current.pid !== initial.pid ? current : null; });
assert(await until(health));
assert.equal(BrowserWindow.getAllWindows()[0], window);
process.kill(second.pid, 'SIGKILL');
const third = await until(() => { const current = engine(); return current && current.pid !== second.pid ? current : null; });
assert(await until(health));
process.kill(third.pid, 'SIGKILL');
await wait(4500);
assert.equal(engine(), undefined, 'Repeated crashes must stop at the restart budget');
assert.equal(BrowserWindow.getAllWindows()[0], window, 'The UI survives exhausted recovery');
assert.equal(await health(), false);
`)
console.log('Real Studio Engine process death: two automatic restarts, working health checks, retained window and bounded crash loop passed.')
