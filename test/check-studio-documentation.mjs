import { runElectronCheck } from './helpers/electron-check.mjs'

// Exercise production assets through Studio's actual offline protocol.
const main = new URL('../public/main.mjs', import.meta.url).href
await runElectronCheck(`
await import(${JSON.stringify(main)});
await app.whenReady();
const window = await until(() => BrowserWindow.getAllWindows()[0]);
const evaluate = source => window.webContents.executeJavaScript(source);
await until(() => !window.webContents.isLoading());
await until(() => evaluate('Boolean(Array.from(document.querySelectorAll("button")).find(button => button.textContent.trim() === "Settings"))'));
await evaluate('Array.from(document.querySelectorAll("button")).find(button => button.textContent.trim() === "Settings").click()');
await until(() => evaluate('Boolean(document.querySelector("#settings-tab-documentation"))')).catch(async error => { throw Error(error.message + await evaluate('document.body.innerText')) });
await evaluate('document.querySelector("#settings-tab-documentation").click()');
await until(() => evaluate('Boolean(document.querySelector("iframe")?.contentDocument?.querySelector("#chapters"))')).catch(async error => { throw Error(error.message + await evaluate('document.body.innerText + document.querySelector("iframe")?.src')) });
const guide = await evaluate('document.querySelector("iframe").src');
assert.match(guide, /^vigo:\\/\\/studio\\/assets\\/guide\\.html/);
await evaluate('Array.from(document.querySelector("iframe").contentDocument.querySelectorAll("a")).find(link => new URL(link.href).pathname.endsWith("standalone.html")).click()');
await until(() => evaluate('Boolean(document.querySelector("iframe").contentWindow.location.pathname.endsWith("standalone.html") && document.querySelector("iframe").contentDocument?.querySelector("#chapters"))'));
const reference = await evaluate('document.querySelector("iframe").contentWindow.location.href');
assert.match(reference, /^vigo:\\/\\/studio\\/assets\\/standalone\\.html/);
assert.equal(new URL(reference).searchParams.get('embedded'), '1');
assert.equal(await evaluate('Boolean(document.querySelector("[role=alert]"))'), false);
const schemaUrl = new URL(reference).searchParams.get('schema');
const schema = await (await net.fetch(new URL(schemaUrl, reference).href)).json();
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
console.log('Studio documentation opens bundled production pages, follows offline reference links, and reads the local API schema.')
