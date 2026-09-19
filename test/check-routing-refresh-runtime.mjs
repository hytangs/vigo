import { createViteTestServer as createServer } from './helpers/vite-test-server.mjs'
import react from '@vitejs/plugin-react'
import electronPath from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const directory = await fs.mkdtemp(path.join(root, 'temp', 'routing-refresh-runtime-'))
const server = await createServer({ root, configFile: false, cacheDir: path.join(directory, 'vite-cache'), plugins: [react(), {
  name: 'routing-refresh-fixture',
  configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
    if (req.url !== '/routing-refresh.html') return next()
    res.setHeader('Content-Type', 'text/html')
    res.end(await vite.transformIndexHtml(req.url, '<div id="root"></div><script type="module" src="/test/fixtures/routing-refresh.jsx"></script>'))
  }) },
}], server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { include: ['react', 'react-dom/client'] } })
await server.listen()
const main = path.join(directory, 'main.cjs')
await fs.writeFile(main, `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(directory, 'profile'))});
app.whenReady().then(async()=>{try{
 const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 await window.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/routing-refresh.html`)});
 await window.webContents.executeJavaScript('new Promise((resolve,reject)=>{const timer=setInterval(()=>{if(window.runTests){clearInterval(timer);resolve()}},20);setTimeout(()=>{clearInterval(timer);reject(Error("Fixture timed out"))},15000)})');
 console.log(JSON.stringify({passed:true,...await window.webContents.executeJavaScript('window.runTests()')}));app.exit(0);
}catch(error){console.error(error);app.exit(1)}});`)
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronPath, [...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []), main], { env, stdio: 'inherit' })
  const timeout = setTimeout(() => child.kill(), 45_000)
  try { const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }); if (code !== 0) throw new Error(`Routing refresh fixture exited ${code}`) }
  finally { clearTimeout(timeout) }
} finally { await server.close() }
