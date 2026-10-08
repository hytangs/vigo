import { createViteTestServer as createServer } from './helpers/vite-test-server.mjs'
import react from '@vitejs/plugin-react'
import electronPath from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const directory = await fs.mkdtemp(path.join(root, 'temp', 'city-data-runtime-'))
const fixture = `import '/test/fixtures/city-data.tsx';`
const server = await createServer({ root, cacheDir: path.join(directory, 'vite-cache'), configFile: false, plugins: [react(), {
  name: 'navigation-fixture',
  resolveId(id) { if (id === '/navigation-fixture.js' || id === '/app-settings-fixture.js') return id },
  load(id) { if (id === '/navigation-fixture.js') return fixture; if (id === '/app-settings-fixture.js') return `import '/test/fixtures/app-settings.tsx';` },
  configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
    if (!['/navigation-fixture.html', '/app-settings-fixture.html'].includes(req.url)) return next()
    res.setHeader('Content-Type', 'text/html')
    res.end(await vite.transformIndexHtml(req.url, '<div id="root"></div><script type="module" src="'+(req.url === '/app-settings-fixture.html' ? '/app-settings-fixture.js' : '/navigation-fixture.js')+'"></script>'))
  }) },
}], server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { include: ['react', 'react-dom/client'] } })
await server.listen()
if (process.env.VIGO_UI_PREVIEW === '1') {
 console.log('City data fixture: http://127.0.0.1:' + server.httpServer.address().port + '/navigation-fixture.html')
 await new Promise(() => {})
}
const main = path.join(directory, 'main.cjs')
await fs.writeFile(main, `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');
const {layoutFrame,resizeLayout}=require(${JSON.stringify(path.join(root, 'test/helpers/layout-frame.cjs'))});
app.disableHardwareAcceleration();
app.setPath('userData',${JSON.stringify(path.join(directory, 'profile'))});
app.whenReady().then(async()=>{try{
 const window=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}});
 await window.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/navigation-fixture.html`)});
 await window.webContents.executeJavaScript('new Promise((resolve,reject)=>{const timer=setInterval(()=>{if(window.checkData){clearInterval(timer);resolve()}},20);setTimeout(()=>{clearInterval(timer);reject(Error("Fixture timed out"))},15000)})');
 const behavior=await window.webContents.executeJavaScript('window.checkData()');
 const results=[];
 for(const [width,height] of [[320,640],[390,844],[760,708],[1280,900]]){
  await resizeLayout(window,width,height);
  for(const view of ['feeds','cases','group'])results.push(await window.webContents.executeJavaScript('window.checkDataLayout('+JSON.stringify(view)+')'));
 }
 await window.webContents.executeJavaScript('window.checkDataLayout("feeds")');
 fs.writeFileSync(${JSON.stringify(path.join(directory, 'city-data.png'))},(await layoutFrame(window)).toPNG());
 await window.webContents.executeJavaScript('window.checkDataLayout("cases")');
 fs.writeFileSync(${JSON.stringify(path.join(directory, 'city-cases.png'))},(await layoutFrame(window)).toPNG());
 await window.webContents.executeJavaScript('window.checkDataLayout("feeds",true)');
 fs.writeFileSync(${JSON.stringify(path.join(directory, 'city-data-dark.png'))},(await layoutFrame(window)).toPNG());
 console.log(JSON.stringify({passed:true,behavior,results}));app.exit(0);
}catch(error){console.error(error);app.exit(1)}});`)
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronPath, [...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []), main], { env, stdio: 'inherit' })
  const timeout = setTimeout(() => child.kill(), 60_000)
  try { const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }); if (code !== 0) throw new Error(`Navigation fixture exited ${code}`) }
  finally { clearTimeout(timeout) }
} finally {
  await server.close()
  await Promise.all(['vite-cache', 'profile'].map(name => fs.rm(path.join(directory, name), { recursive: true, force: true })))
}
