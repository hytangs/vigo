import { createViteTestServer as createServer } from './helpers/vite-test-server.mjs'
import react from '@vitejs/plugin-react'
import electronPath from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
await fs.mkdir(path.join(root, 'temp'), { recursive: true })
const directory = await fs.mkdtemp(path.join(root, 'temp', 'city-intake-runtime-'))
const fixture = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {EmptyOperationsStart} from '/src/components/studio/CitySources.tsx';
import '/src/App.css'; import '/src/index.css';
let gtfs=0,osm=0,connected=0;
HTMLInputElement.prototype.click=function(){if(this.accept.includes('zip'))gtfs++;else osm++};
const noop=()=>{};
createRoot(document.getElementById('root')).render(React.createElement('main',{className:'app-shell appearance-light project-empty page-project',style:{height:'100vh',display:'grid'}},React.createElement(EmptyOperationsStart,{
 project:{name:'Other City',summary:{feeds:0,routes:0},feeds:[],jobs:[]},onOpenNetwork:noop,osmStreetReady:false,isImporting:false,isOsmImporting:false,importMessage:'',osmStreetMessage:'',realtimeSnapshot:null,realtimeMessage:'',realtimeRequest:null,isRealtimeLoading:false,onFiles:noop,onNationalGtfsPath:noop,onNationalOsmPath:noop,onOsmFiles:noop,onConnectRealtime:()=>connected++,onDisconnectRealtime:noop,onCancelGtfs:noop,onRetryGtfs:noop,onCancelOsm:noop,onRetryOsm:noop
})));
window.checkNavigation=async()=>{
 const wait=()=>new Promise(resolve=>requestAnimationFrame(resolve));await wait();
 const cards=document.querySelectorAll('.surface-source-status');cards[0].click();cards[1].click();
 if(gtfs<1||osm<1)throw Error('Source cards did not open pickers');
 for(const selector of ['.drop-zone','.osm-import-strip button','.realtime-fields input','.realtime-actions button','.network-import-example']){
  const element=document.querySelector(selector);element.scrollIntoView({block:'center'});await wait();
  const r=element.getBoundingClientRect();
  if(r.width<=0||r.height<=0||!element.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('Control clipped: '+selector);
 }
 const outer=document.querySelector('.surface-source-intake').getBoundingClientRect();
 const panel=document.querySelector('.import-panel').getBoundingClientRect();
 const examples=document.querySelector('.network-import-example').getBoundingClientRect();
 if(panel.bottom>outer.bottom+1||examples.bottom>panel.bottom+1)throw Error('Import content escapes panel borders');
 const scroller=document.querySelector('.empty-intake');
 if(scroller.scrollWidth>scroller.clientWidth+1)throw Error('Intake overflows horizontally');
 if(document.body.textContent.includes('Manifest'))throw Error('Manifest remains');
 const preset=document.querySelector('.realtime-preset button');preset.click();await wait();
 document.querySelector('.realtime-actions button').click();await wait();
 if(!connected)throw Error('Realtime form did not connect');
 return {width:innerWidth,height:innerHeight,pickers:true,controlsReachable:true,realtimeSubmit:true};
};`
const server = await createServer({ root, cacheDir: path.join(directory, 'vite-cache'), configFile: false, plugins: [react(), {
  name: 'navigation-fixture',
  resolveId(id) { if (id === '/navigation-fixture.js') return id },
  load(id) { if (id === '/navigation-fixture.js') return fixture },
  configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
    if (req.url !== '/navigation-fixture.html') return next()
    res.setHeader('Content-Type', 'text/html')
    res.end(await vite.transformIndexHtml(req.url, '<div id="root"></div><script type="module" src="/navigation-fixture.js"></script>'))
  }) },
}], server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { include: ['react', 'react-dom/client'] } })
await server.listen()
const main = path.join(directory, 'main.cjs')
await fs.writeFile(main, `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');
app.setPath('userData',${JSON.stringify(path.join(directory, 'profile'))});
app.whenReady().then(async()=>{try{
 const window=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}});
 await window.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/navigation-fixture.html`)});
 await window.webContents.executeJavaScript('new Promise((resolve,reject)=>{const timer=setInterval(()=>{if(window.checkNavigation){clearInterval(timer);resolve()}},20);setTimeout(()=>{clearInterval(timer);reject(Error("Fixture timed out"))},15000)})');
 const results=[];
 for(const [width,height] of [[320,640],[390,844],[760,708],[760,400],[761,900],[1280,900]]){
  window.setContentSize(width,height);await new Promise(resolve=>setTimeout(resolve,100));
  results.push(await window.webContents.executeJavaScript('window.checkNavigation()'));
 }
 fs.writeFileSync(${JSON.stringify(path.join(directory, 'navigation.png'))},(await window.webContents.capturePage()).toPNG());
 console.log(JSON.stringify({passed:true,results}));app.exit(0);
}catch(error){console.error(error);app.exit(1)}});`)
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronPath, [...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []), main], { env, stdio: 'inherit' })
  const timeout = setTimeout(() => child.kill(), 60_000)
  try { const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }); if (code !== 0) throw new Error(`Navigation fixture exited ${code}`) }
  finally { clearTimeout(timeout) }
} finally { await server.close() }
