import { runElectronCheck } from './helpers/electron-check.mjs'

// Exercise production assets through Studio's actual offline protocol.
const main = new URL('../public/main.mjs', import.meta.url).href
await runElectronCheck(`
await import(${JSON.stringify(main)});
await app.whenReady();
const window = await until(() => BrowserWindow.getAllWindows()[0]);
const evaluate = source => window.webContents.executeJavaScript(source);
await until(() => !window.webContents.isLoading());
const { Menu } = await import('electron');
const menu = Menu.getApplicationMenu();
const settings = menu.getMenuItemById('settings');
const chooseCity = menu.getMenuItemById('choose-city');
assert(settings && chooseCity, 'Useful desktop commands must exist');
await until(() => evaluate('Boolean(document.querySelector(".city-library"))'));
await until(() => settings.enabled && !chooseCity.enabled);
settings.click();
await until(() => evaluate('Boolean(document.querySelector(".settings-themes"))'));
await until(() => chooseCity.enabled && !settings.enabled);
chooseCity.click();
await until(() => evaluate('Boolean(document.querySelector(".city-library"))'));
assert.equal(await evaluate('Boolean(document.querySelector(".desktop-sidebar-collapsed"))'), false);

await until(() => evaluate('Boolean(Array.from(document.querySelectorAll("button")).find(button => button.textContent.trim() === "Settings"))'));
await evaluate('Array.from(document.querySelectorAll("button")).find(button => button.textContent.trim() === "Settings").click()');
await until(() => evaluate('Boolean(document.querySelector("#settings-tab-documentation"))')).catch(async error => { throw Error(error.message + await evaluate('document.body.innerText')) });
await evaluate('document.querySelector("#settings-tab-documentation").click()');
await until(() => evaluate('Boolean(document.querySelector("iframe")?.contentDocument?.querySelector("#chapters"))')).catch(async error => { throw Error(error.message + await evaluate('document.body.innerText + document.querySelector("iframe")?.src')) });
const guide = await evaluate('document.querySelector("iframe").src');
assert.match(guide, /^vigo:\\/\\/studio\\/assets\\/guide\\.html/);
assert.equal(new URL(guide).searchParams.get('embedded'), '1');
// One bundled guide covers Studio, the engine reference, and the HTTP API.
await evaluate('document.querySelector("iframe").contentDocument.querySelector("[data-nav=http-api]").click()');
await until(() => evaluate('Boolean(document.querySelector("iframe").contentDocument.querySelector("#page-http-api:not([hidden])"))'));
assert.equal(await evaluate('Boolean(document.querySelector("[role=alert]"))'), false);
const schemaUrl = await evaluate('Array.from(document.querySelector("iframe").contentDocument.querySelectorAll("a[download]")).find(link => link.download === "standalone-openapi.json").href');
const schema = await (await net.fetch(schemaUrl)).json();
assert.equal(schema.openapi, '3.1.0');
const response = await net.fetch(guide);
assert.equal(response.status, 200);
assert((await response.text()).includes('data-source-root='));
// A locked/unavailable library must still expose local Settings and docs.
const health = await (await net.fetch('vigo://studio/api/health')).json();
if (!health.config.offline.storageWritable) {
  await evaluate('document.querySelector(".topbar-mark-button").click()');
  await until(() => evaluate('Boolean(document.querySelector(".storage-recovery"))'));
  await evaluate('Array.from(document.querySelectorAll(".storage-recovery button")).find(button => button.textContent === "Settings").click()');
  await until(() => evaluate('Boolean(document.querySelector("#settings-tab-documentation"))'));
}
`)
console.log('Studio documentation opens the bundled guide, navigates to the HTTP API reference offline, and reads the local API schema.')
