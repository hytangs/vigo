// Real Studio: preserve navigation, map camera and panel geometry across workspaces.
import { createViteTestServer } from './helpers/vite-test-server.mjs'
import react from '@vitejs/plugin-react'
import electronPath from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { checkDirectory } from './helpers/check-directory.mjs'
const root=path.resolve(import.meta.dirname,'..')
const directory=await checkDirectory(root,'workspace-transitions-')
const fixture="import '/test/fixtures/workspace-transitions.tsx';"
const server=await createViteTestServer({root,configFile:false,cacheDir:path.join(directory,'vite-cache'),plugins:[react(),{
 name:'transitions-fixture',configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
  if(req.url!=='/transitions-fixture.html')return next();res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml(req.url,'<div id="root"></div><script type="module" src="/transitions-fixture.jsx"></script>'))
 })},resolveId(id){if(id==='/transitions-fixture.jsx')return id},load(id){if(id==='/transitions-fixture.jsx')return fixture}
}],server:{host:'127.0.0.1',port:0},optimizeDeps:{include:['react','react-dom/client','react-dom']}})
await server.listen()
const main=path.join(directory,'main.cjs')
await fs.writeFile(main,`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(directory,'profile'))});
app.whenReady().then(async()=>{try{const w=new BrowserWindow({width:1280,height:900,show:true,webPreferences:{backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}});
await w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/transitions-fixture.html`)});
await w.webContents.executeJavaScript('new Promise((resolve,reject)=>{const t=setInterval(()=>{if(window.checkTransitions){clearInterval(t);resolve()}},20);setTimeout(()=>reject(Error("Fixture timeout")),10000)})');
const result=await w.webContents.executeJavaScript('window.checkTransitions()');
require('node:fs').writeFileSync(${JSON.stringify(path.join(directory,'network.png'))},(await w.webContents.capturePage()).toPNG());
for (const name of ['Route', 'Reach']) {
 await w.webContents.executeJavaScript('window.showWorkspace('+JSON.stringify(name)+')');
 await new Promise(resolve=>setTimeout(resolve,150));
 require('node:fs').writeFileSync(${JSON.stringify(directory)}+'/'+name.toLowerCase()+'.png',(await w.webContents.capturePage()).toPNG());
}
console.log({...result,screenshot:${JSON.stringify(path.join(directory,'network.png'))}});app.exit(0)}catch(e){console.error(e);app.exit(1)}});`)
try{
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
 const child=spawn(electronPath,[...(process.platform==='darwin'?[]:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']),...(process.platform==='linux'&&process.env.CI?['--no-sandbox']:[]),main],{env,stdio:'inherit'})
 const timeout=setTimeout(()=>child.kill(),45000)
 try{const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});if(code!==0)throw Error(`Workspace transitions fixture exited ${code}`)}finally{clearTimeout(timeout)}
}finally{await server.close();await Promise.all(['vite-cache','profile'].map(n=>fs.rm(path.join(directory,n),{recursive:true,force:true})))}
