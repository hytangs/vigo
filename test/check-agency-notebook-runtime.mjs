import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import electronPath from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agency-notebook-runtime-'))
const server = await createServer({ root, configFile: false, plugins: [react(), {
  name: 'agency-notebook-fixture',
  configureServer(vite) { vite.middlewares.use(async (request, response, next) => {
    if (request.url !== '/agency-notebook.html') return next()
    response.setHeader('Content-Type', 'text/html')
    response.end(await vite.transformIndexHtml(request.url, '<div id="root"></div><script type="module" src="/test/fixtures/agency-notebook.jsx"></script>'))
  }) },
}], server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { include: ['react', 'react-dom/client'] } })
try {
  await server.listen()
  const main = path.join(directory, 'main.cjs')
  await fs.writeFile(main, `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(directory, 'profile'))});
app.whenReady().then(async()=>{try{
 const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 await window.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/agency-notebook.html`)});
 await window.webContents.executeJavaScript('new Promise((resolve,reject)=>{const timer=setInterval(()=>{if(window.runTests){clearInterval(timer);resolve()}},20);setTimeout(()=>{clearInterval(timer);reject(Error("Fixture timed out"))},15000)})');
 console.log(JSON.stringify({passed:true,...await window.webContents.executeJavaScript('window.runTests()')}));app.exit(0);
}catch(error){console.error(error);app.exit(1)}});`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronPath, [...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []), main], { env, stdio: 'inherit' })
  const timeout = setTimeout(() => child.kill(), 45_000)
  try { const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }); if (code !== 0) throw new Error(`Agency notebook fixture exited ${code}`) }
  finally { clearTimeout(timeout) }
} finally { await server.close(); await fs.rm(directory, { recursive: true, force: true }) }
