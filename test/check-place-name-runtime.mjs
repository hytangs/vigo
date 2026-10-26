// Real React/Chromium acceptance: queued names must not overwrite rapid clicks.
import { createViteTestServer } from './helpers/vite-test-server.mjs'
import react from '@vitejs/plugin-react'
import electronPath from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { checkDirectory } from './helpers/check-directory.mjs'
const root=path.resolve(import.meta.dirname,'..')
const directory=await checkDirectory(root,'place-runtime-')
const fixture=`import React,{useState,useRef} from 'react';
import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {usePlaceNames} from '/src/app/usePlaceNames.ts';
const pending=[];let next=0;
window.fetch=async(url,options={})=>url.includes('?points=')?new Promise((resolve,reject)=>{
 pending.push(name=>resolve({ok:true,json:async()=>({places:[{label:name}]})}));
 options.signal?.addEventListener('abort',()=>reject(Error('aborted')));
}):({ok:true,json:async()=>({places:[]})});
function Fixture(){
 const [city,setCity]=useState('one'),[points,setPoints]=useState([]);
 const name=usePlaceNames(city,true);const handler=useRef(null);
 handler.current=p=>setPoints([...points,p]);
 const pick=()=>name({coordinate:[++next,52],label:'Dropped pin',source:'map'},p=>flushSync(()=>handler.current(p)));
 return <main><button id="pick" onClick={pick}>Pick coordinate</button><button id="city" onClick={()=>setCity('two')}>Change City</button><ol>{points.map(p=><li key={p.coordinate[0]}>{p.label}:{p.coordinate[0]}</li>)}</ol></main>;
}
flushSync(()=>createRoot(document.getElementById('root')).render(<Fixture/>));
window.checkPlaces=async()=>{
 const pause=n=>new Promise(r=>setTimeout(r,n));await pause(20);
 const click=id=>flushSync(()=>document.getElementById(id).click());
 click('pick');click('pick');pending[1]('Second St');pending[0]('First St');await pause(30);
 const labels=()=>[...document.querySelectorAll('li')].map(e=>e.textContent);
 if(JSON.stringify(labels())!==JSON.stringify(['First St:1','Second St:2']))throw Error('Rapid clicks lost or reordered: '+labels());
 click('pick');click('city');pending[2]('Wrong City');await pause(30);
 if(labels().length!==2)throw Error('Previous City accepted delayed name');
 click('pick');await pause(300);
 if(labels().at(-1)!=='Dropped pin:4')throw Error('Timeout failed to retain coordinate');
 return {passed:true,labels:labels(),cityCancellation:true};
};`
const server=await createViteTestServer({root,configFile:false,cacheDir:path.join(directory,'vite-cache'),plugins:[react(),{
 name:'place-fixture',configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
  if(req.url!=='/place-fixture.html')return next();res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml(req.url,'<div id="root"></div><script type="module" src="/place-fixture.jsx"></script>'))
 })},resolveId(id){if(id==='/place-fixture.jsx')return id},load(id){if(id==='/place-fixture.jsx')return fixture}
}],server:{host:'127.0.0.1',port:0},optimizeDeps:{include:['react','react-dom/client','react-dom']}})
await server.listen()
const main=path.join(directory,'main.cjs')
await fs.writeFile(main,`const {app,BrowserWindow}=require('electron');app.disableHardwareAcceleration();app.setPath('userData',${JSON.stringify(path.join(directory,'profile'))});
app.whenReady().then(async()=>{try{const w=new BrowserWindow({show:false,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}});
await w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/place-fixture.html`)});
await w.webContents.executeJavaScript('new Promise((resolve,reject)=>{const t=setInterval(()=>{if(window.checkPlaces){clearInterval(t);resolve()}},20);setTimeout(()=>reject(Error("Fixture timeout")),10000)})');
console.log(await w.webContents.executeJavaScript('window.checkPlaces()'));app.exit(0)}catch(e){console.error(e);app.exit(1)}});`)
try{
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
 const child=spawn(electronPath,[...(process.platform==='linux'&&process.env.CI?['--no-sandbox']:[]),main],{env,stdio:'inherit'})
 const timeout=setTimeout(()=>child.kill(),30000)
 try{const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});if(code!==0)throw Error(`Place fixture exited ${code}`)}finally{clearTimeout(timeout)}
}finally{await server.close();await Promise.all(['vite-cache','profile'].map(n=>fs.rm(path.join(directory,n),{ recursive: true, force: true, maxRetries: 20, retryDelay: 50 })))}
