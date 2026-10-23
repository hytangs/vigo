import fs from 'node:fs/promises'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { createViteTestServer } from './helpers/vite-test-server.mjs'
import { runElectronCheck } from './helpers/electron-check.mjs'
import { checkDirectory } from './helpers/check-directory.mjs'
const root = path.resolve(import.meta.dirname, '..')
const directory = await checkDirectory(root, 'journey-groups-ui-')
const fixture = `
import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
import {PathfinderRouteList} from '/src/components/PathfinderPanel.tsx';
import '/src/App.css'; import '/src/index.css';
const plan=(id,offset,other=false)=>({id,status:'ready',travelMode:'transit',timePreference:'depart',maxWalkKm:1.2,
 departMinutes:484+offset,arriveMinutes:504+offset,durationMinutes:20,walkMinutes:0,rideMinutes:20,waitMinutes:0,transfers:0,title:id,detail:'',origin:{label:'A'},destination:{label:'B'},diagnostics:{departureWindow:{centerMinutes:480}},
 legs:[{type:'ride',routeId:id,routeShortName:id,tripId:id,fromStopId:'A',toStopId:'B',fromName:'A',toName:'B',stopIds:['A','B'],stopCount:2,geometrySource:'gtfs_shape',coordinates:other?[[0,0],[1,-1],[2,0]]:[[0,0],[1,1],[2,0]],startMinutes:484+offset,endMinutes:504+offset,durationMinutes:20,distanceKm:4}]});
const plans=[plan('M',0),plan('E',2),plan('Rail',4,true)];
function Fixture(){const [selected,setSelected]=useState('M');return <main className="app-shell page-project" style={{display:'block',width:'100%',maxWidth:390,padding:12}}><output id="selected">{selected}</output><PathfinderRouteList plans={plans} selectedPlanId={selected} alternativesLoading={false} onSelect={setSelected}/></main>}
createRoot(document.getElementById('root')).render(<Fixture/>);`
const server = await createViteTestServer({root,configFile:false,cacheDir:path.join(directory,'cache'),plugins:[react(),{
 name:'journey-groups-fixture',resolveId:id=>id==='/groups.tsx'?id:null,load:id=>id==='/groups.tsx'?fixture:null,
 configureServer(vite){vite.middlewares.use(async(req,res,next)=>{if(req.url!=='/groups.html')return next();res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml(req.url,'<div id="root"></div><script type="module" src="/groups.tsx"></script>'))})},
}],server:{host:'127.0.0.1',port:0},optimizeDeps:{include:['react','react-dom/client']}})
try{
 await server.listen();const url=`http://127.0.0.1:${server.httpServer.address().port}/groups.html`
 await runElectronCheck(`
 app.disableHardwareAcceleration();await app.whenReady();
 const window=new BrowserWindow({show:false,width:390,height:1000,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true}});
 await window.loadURL(${JSON.stringify(url)}); const read=code=>window.webContents.executeJavaScript(code);
 await until(()=>read('document.querySelectorAll("[role=radio]").length===2'));
 assert.match(await read('document.querySelector(".pathfinder-results-head").textContent'),/2 journeys/);
 assert.match(await read('document.querySelector(".pathfinder-group-services").textContent'),/M or E/);
 await read('[...document.querySelectorAll(".pathfinder-group-departures button")].find(b=>b.textContent.startsWith("E")).click()');
 await until(()=>read('document.querySelector("#selected").textContent==="E"'));
 assert.match(await read('document.querySelector(".pathfinder-route-time").textContent'),/08:06.*08:26/);
 assert.equal(await read('document.querySelector("[role=radio]").getAttribute("aria-checked")'),'true');
 await read('document.querySelector("[role=radio]").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}))');
 await until(()=>read('document.querySelector("#selected").textContent==="Rail"'));
 for(const width of [320,390]){window.setSize(width,1000);await wait(100);assert(await read('document.documentElement.scrollWidth<=window.innerWidth'),'No horizontal overflow');}
 await (await import('node:fs/promises')).writeFile(${JSON.stringify(directory)}+'/groups.png',(await window.capturePage()).toPNG());
 window.destroy();`)
 console.log('Grouped journey cards: merged services, separate corridor, exact selected times, keyboard selection and narrow layouts passed. '+directory)
}finally{await server.close();await fs.rm(path.join(directory,'cache'),{ recursive: true, force: true, maxRetries: 20, retryDelay: 50 })}
