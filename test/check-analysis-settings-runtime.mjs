import { createViteTestServer as createServer } from './helpers/vite-test-server.mjs'
import react from '@vitejs/plugin-react'
import electron from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
await fs.mkdir(path.join(root, 'temp'), { recursive: true })
const directory = await fs.mkdtemp(path.join(root, 'temp', 'analysis-settings-'))
const fixture = `import '/test/fixtures/analysis-settings.tsx';`
const server = await createServer({ root, cacheDir: path.join(directory, 'cache'), configFile: false, plugins: [react(), {
  name: 'analysis-settings', resolveId(id) { if (['/settings-fixture.tsx', '/request-fixture.tsx'].includes(id)) return id }, load(id) { if (id === '/settings-fixture.tsx') return fixture; if (id === '/request-fixture.tsx') return `import '/test/fixtures/analysis-request.tsx';` },
  configureServer(server) { server.middlewares.use(async (request, response, next) => { if (!['/settings.html', '/request.html'].includes(request.url)) return next(); response.setHeader('Content-Type', 'text/html'); response.end(await server.transformIndexHtml(request.url, '<meta name="viewport" content="width=device-width,initial-scale=1"><style>*,*::before,*::after{transition:none!important;animation:none!important}</style><div id="root"></div><script type="module" src="'+(request.url === '/request.html' ? '/request-fixture.tsx' : '/settings-fixture.tsx')+'"></script>')) }) },
}], server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const main = path.join(directory, 'main.cjs')
await fs.writeFile(main, `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const {layoutFrame,resizeLayout}=require(${JSON.stringify(path.join(root, 'test/helpers/layout-frame.cjs'))});app.disableHardwareAcceleration();app.setPath('userData',${JSON.stringify(path.join(directory, 'profile'))});app.whenReady().then(async()=>{try{const w=new BrowserWindow({show:false,width:400,height:920,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}});await w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/settings.html`)});await w.webContents.executeJavaScript('new Promise((resolve,reject)=>{const timer=setInterval(()=>{if(window.checkSettings){clearInterval(timer);resolve()}},20);setTimeout(()=>reject(Error("Fixture timeout")),15000)})');await w.webContents.executeJavaScript('window.checkSettings()');const results=[];for(const width of [320,390,760,1280]){await resizeLayout(w,width,920);for(const dark of [false,true]){results.push(await w.webContents.executeJavaScript('window.checkLayout('+dark+')'));fs.writeFileSync(${JSON.stringify(directory)}+'/'+width+'-'+(dark?'dark':'light')+'.png',(await layoutFrame(w)).toPNG());}}await w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/request.html`)});await w.webContents.executeJavaScript('new Promise((resolve,reject)=>{const timer=setInterval(()=>{if(window.checkAnalysisRequest){clearInterval(timer);resolve()}},20);setTimeout(()=>reject(Error("Request fixture timeout")),15000)})');const requestWiring=await w.webContents.executeJavaScript('window.checkAnalysisRequest()');console.log(JSON.stringify({passed:true,results,requestWiring,directory:${JSON.stringify(directory)}}));app.exit(0)}catch(e){console.error(e);app.exit(1)}});`)
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []), main], { env, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill(), 60_000)
  try { const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }); if (code !== 0) throw Error(`Settings runtime check failed (${code})`) }
  finally { clearTimeout(timer) }
} finally { await server.close(); await Promise.all(['cache', 'profile'].map(name => fs.rm(path.join(directory, name), { recursive: true, force: true }))) }
