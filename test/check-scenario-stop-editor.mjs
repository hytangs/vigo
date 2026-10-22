import { createViteTestServer as createServer } from './helpers/vite-test-server.mjs'
import electronPath from 'electron'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
const root = path.resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(path.join(tmpdir(), 'vigo-scenario-stop-editor-'))
const harness = await readFile(path.join(root, 'test/fixtures/scenario-stop-editor.js'), 'utf8')

const server = await createServer({ root, configFile: false, optimizeDeps: {include:['react','react-dom','react-dom/client']}, server: { host:'127.0.0.1', port:0 }, plugins:[{
  name:'scenario-stop-editor', configureServer(server) { server.middlewares.use((req,res,next) => {
    if (req.url?.split('?')[0] === '/scenario-stop-editor.html') { res.setHeader('Content-Type','text/html'); res.end('<div id="root"></div><script type="module" src="/scenario-stop-editor.js"></script>'); }
    else if (req.url === '/scenario-stop-editor.js') { res.setHeader('Content-Type','text/javascript'); server.transformRequest('virtual:scenario-stop-editor').then(result=>res.end(result.code)).catch(next); }
    else next();
  }); }, resolveId(id) { if (id === 'virtual:scenario-stop-editor') return id; }, load(id) { if (id === 'virtual:scenario-stop-editor') return harness; }
}] })
await server.listen()
if (process.env.VIGO_PREVIEW_ONLY) { console.log('PREVIEW http://127.0.0.1:' + server.httpServer.address().port + '/scenario-stop-editor.html'); await new Promise(() => {}); }
await writeFile(path.join(temporary,'main.cjs'), `const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(path.join(temporary,'profile'))});
app.whenReady().then(async () => {
  try {
    const window = new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false,nodeIntegration:false,contextIsolation:true,sandbox:true}});
    await window.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/scenario-stop-editor.html`)});
    const result = await window.webContents.executeJavaScript('window.runTests()');
    if (result.failed) throw Error(result.failed);
    const assembly = await window.webContents.executeJavaScript('window.runAssemblyTests()');
    if (assembly.failed) throw Error(assembly.failed);
    console.log(JSON.stringify({passed:true,...result,...assembly})); app.exit(0);
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
