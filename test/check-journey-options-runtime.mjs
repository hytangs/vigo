import { createViteTestServer as createServer } from './helpers/vite-test-server.mjs'
import react from '@vitejs/plugin-react'
import electronPath from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
const root = path.resolve(import.meta.dirname, '..')
await fs.mkdir(path.join(root, 'temp'), { recursive: true })
const directory = await fs.mkdtemp(path.join(root, 'temp', 'journey-options-'))
const fixture = `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {buildSearchResults} from '/src/features/search/searchModel.ts';
import {PathfinderRouteList,RoutingDetailPanel} from '/src/components/PathfinderPanel.tsx';import '/src/App.css';import '/src/index.css';
const base={status:'ready',travelMode:'transit',timePreference:'depart',departMinutes:480,maxWalkKm:1.2,origin:{label:'Starting point'},destination:{label:'Destination'},waitMinutes:1,rideMinutes:24,diagnostics:{routingDataMode:'scheduled',serviceDate:'2026-10-07',departureWindow:{centerMinutes:480}}};
const plans=[{...base,id:'early',arriveMinutes:530,durationMinutes:50,transfers:1,walkMinutes:25,recommended:true,choiceLabel:'Earliest arrival'},
{...base,id:'direct',arriveMinutes:536,durationMinutes:56,transfers:0,walkMinutes:17,choiceLabel:'Fewest transfers'},
{...base,id:'walk',arriveMinutes:538,durationMinutes:58,transfers:2,walkMinutes:8,choiceLabel:'Least walking'}].map((p,i)=>({...p,legs:[{type:'ride',routeShortName:['SL4 → Red Line','1','15 → SL5 → 69'][i],fromName:'First stop',toName:'Last stop',startMinutes:490,endMinutes:520,durationMinutes:30,distanceKm:4,stopCount:5,geometrySource:'shape',routeColor:'637455'}]}));
function Fixture(){const [selected,setSelected]=useState('early');const [arriveBy,setArriveBy]=useState(false);window.setArriveBy=setArriveBy;const shown=arriveBy?plans.map((p,i)=>({...p,timePreference:'arrive',departMinutes:i===0?490:480,arriveMinutes:i===0?538:500,durationMinutes:i===0?48:20})):plans;return <main className="app-shell page-project appearance-light"><header className="topbar"><span style={{padding:16}}>VIGO · Journey choices</span></header><div className="shell-body"><aside className="sidebar-panel" style={{overflow:'auto'}}><PathfinderRouteList plans={shown} selectedPlanId={selected} alternativesLoading={false} onSelect={setSelected}/></aside><section className="app-frame" style={{position:'relative',background:'var(--panel-soft)'}}><RoutingDetailPanel plan={shown.find(p=>p.id===selected)} onClose={()=>{}}/></section></div></main>}
flushSync(()=>createRoot(document.getElementById('root')).render(<Fixture/>));
window.checkChoices=()=>{const list=()=>[...document.querySelectorAll('[role=radio]')],sort=[...document.querySelectorAll('[aria-label="Sort journeys"] button')];
const click=e=>flushSync(()=>e.click());
const query='route 38.9, -77.05 to 38.91, -77.03 arrive by 08:20';
const action=buildSearchResults({query,preview:{},networkSearchIndex:{},projects:[],recentIds:[]})[0];
if(action?.routingQuery!==query||!action.subtitle.includes('Arrive by 08:20'))throw Error('Routing search action missing');
if(!list()[0].textContent.includes('Earliest arrival'))throw Error('Wrong initial order');
click(sort[1]);if(!list()[0].textContent.includes('0transfer'))throw Error('Fewer-transfer sorting failed');
click(sort[2]);if(!list()[0].textContent.includes('8mwalk'))throw Error('Walking sorting failed');
if(list().filter(e=>e.tabIndex===0).length!==1)throw Error('Roving tabindex failed');
list()[0].focus();flushSync(()=>list()[0].dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true})));
if(list().at(-1).getAttribute('aria-checked')!=='true')throw Error('End key did not select last journey');
flushSync(()=>list().at(-1).dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true})));
if(list()[0].getAttribute('aria-checked')!=='true')throw Error('Home key did not select first journey');
if(list().filter(e=>e.getAttribute('aria-checked')==='true').length!==1)throw Error('Multiple selected journeys');
for(const card of list()){const r=card.getBoundingClientRect();if(r.width<240||card.scrollWidth>card.clientWidth+1)throw Error('Journey card overflows');}
click(sort[0]);click(list()[0]);if(!list()[0].getAttribute('aria-label').includes('50m total from requested departure, 1 transfer,'))throw Error('Accessible time basis differs from card');
flushSync(()=>window.setArriveBy(true));if(!list()[0].textContent.includes('08:10')||!list()[0].textContent.includes('Latest departure'))throw Error('Arrive-by must rank latest departure before shorter duration');if(!list()[1].textContent.includes('Leave 10m earlier'))throw Error('Arrive-by tradeoff uses wrong time objective');flushSync(()=>window.setArriveBy(false));return {sorting:true,arriveBy:true,keyboard:true,selectedJourneyStable:true};};`
const server = await createServer({ root, cacheDir: path.join(directory, 'vite-cache'), configFile: false, plugins: [react(), {
  name: 'journey-options-fixture', resolveId: id => id === '/journey-options.tsx' ? id : null,
  load: id => id === '/journey-options.tsx' ? fixture : null,
  configureServer(vite) { vite.middlewares.use(async (req,res,next)=>{
    if(req.url!=='/journey-options.html')return next()
    res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml(req.url,'<div id="root"></div><script type="module" src="/journey-options.tsx"></script>'))
  }) },
}], server: { host:'127.0.0.1',port:0 }, optimizeDeps:{include:['react','react-dom/client']} })
await server.listen()
const main=path.join(directory,'main.cjs')
await fs.writeFile(main,`const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const {layoutFrame,resizeLayout}=require(${JSON.stringify(path.join(root,'test/helpers/layout-frame.cjs'))});app.disableHardwareAcceleration();app.setPath('userData',${JSON.stringify(path.join(directory,'profile'))});
app.whenReady().then(async()=>{try{const window=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}});await window.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/journey-options.html`)});await window.webContents.executeJavaScript('new Promise((resolve,reject)=>{const t=setInterval(()=>{if(window.checkChoices){clearInterval(t);resolve()}},20);setTimeout(()=>reject(Error("Fixture timeout")),15000)})');
for(const [width,height] of [[1280,900],[390,844],[320,720]]){await resizeLayout(window,width,height);console.log(await window.webContents.executeJavaScript('window.checkChoices()'));for(const theme of ['light','dark']){await window.webContents.executeJavaScript('document.querySelector("main").className="app-shell page-project appearance-'+theme+'"');await new Promise(resolve=>setTimeout(resolve,220));await layoutFrame(window);console.log(theme,await window.webContents.executeJavaScript('getComputedStyle(document.querySelector("main")).backgroundColor'));fs.writeFileSync(${JSON.stringify(directory)}+'/'+width+'-'+theme+'.png',(await layoutFrame(window)).toPNG());}}app.exit(0);}catch(e){console.error(e);app.exit(1)}});`)
try {
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  const child=spawn(electronPath,[...(process.platform==='linux'&&process.env.CI?['--no-sandbox']:[]),main],{env,stdio:'inherit'})
  const timer=setTimeout(()=>child.kill(),60_000)
  try{const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});if(code!==0)throw Error(`Journey fixture exited ${code}`)}finally{clearTimeout(timer)}
  console.log(`Journey options verified: ${directory}`)
} finally {await server.close();await Promise.all(['vite-cache','profile'].map(name=>fs.rm(path.join(directory,name),{recursive:true,force:true})))}
