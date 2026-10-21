import { createViteTestServer } from './helpers/vite-test-server.mjs'
import { checkDirectory } from './helpers/check-directory.mjs'
import react from '@vitejs/plugin-react'
import electronPath from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
const root=path.resolve(import.meta.dirname,'..')
const directory=await checkDirectory(root,'service-inspector-')
const server=await createViteTestServer({root,configFile:false,cacheDir:path.join(directory,'vite-cache'),plugins:[react(),{
 name:'service-inspector-fixture',configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
  if(req.url!=='/inspector.html')return next();res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml(req.url,'<div id="root"></div><script type="module" src="/test/fixtures/service-inspector.tsx"></script>'))
 })}
}],server:{host:'127.0.0.1',port:0},optimizeDeps:{include:['react','react-dom/client','react-dom']}})
await server.listen()
const main=path.join(directory,'main.cjs')
await fs.writeFile(main,`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(directory,'profile'))});
app.whenReady().then(async()=>{try{const w=new BrowserWindow({width:1440,height:900,show:false,webPreferences:{backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}});
await w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/inspector.html`)});
await w.webContents.executeJavaScript('window.prepareInspector()');
for(const [width,height,appearance,expanded] of [[1440,900,'dark',false],[1440,900,'light',true],[1100,650,'dark',false],[980,540,'dark',true],[760,700,'light',false]]){
 w.setContentSize(width,height); await new Promise(r=>setTimeout(r,200));
 console.log(await w.webContents.executeJavaScript('window.checkInspectorLayout('+JSON.stringify(appearance)+','+expanded+')'));
 require('node:fs').writeFileSync(${JSON.stringify(directory)}+'/'+width+'-'+appearance+'.png',(await w.webContents.capturePage()).toPNG());
}
console.log(await w.webContents.executeJavaScript('window.finishInspector()'));app.exit(0)}catch(e){console.error(e);app.exit(1)}});`)
try {
 const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE
 const child=spawn(electronPath,[...(process.platform==='darwin'?[]:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']),...(process.platform==='linux'&&process.env.CI?['--no-sandbox']:[]),main],{env,stdio:'inherit'})
 const timeout=setTimeout(()=>child.kill(),45000)
 try{const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});if(code!==0)throw Error(`Service inspector fixture exited ${code}`)}finally{clearTimeout(timeout)}
}finally{await server.close();await Promise.all(['vite-cache','profile'].map(n=>fs.rm(path.join(directory,n),{recursive:true,force:true})))}
console.log('Service inspector screenshots: '+directory)
