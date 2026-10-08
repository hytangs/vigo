import fs from 'node:fs/promises'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { createViteTestServer } from './helpers/vite-test-server.mjs'
import { runElectronCheck } from './helpers/electron-check.mjs'

const root = path.resolve(import.meta.dirname, '..')
await fs.mkdir(path.join(root, 'temp'), { recursive: true })
const directory = await fs.mkdtemp(path.join(root, 'temp', 'transfer-selection-ui-'))
const screenshotPath = path.join(directory, 'transfer-options.png')
const fixture = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SidebarPathfinderBox} from '/src/components/PathfinderPanel.tsx';
import {useNationalRouting} from '/src/app/useNationalRouting.ts';
import '/src/App.css'; import '/src/index.css';
document.documentElement.dataset.appearance='light';
const origin={coordinate:[0,0],label:'Origin',source:'map'};
const destination={coordinate:[.05,0],label:'Destination',source:'map'};
const waypoints=[]; const noOp=()=>{};
window.selectionRequests=[];
window.fetch=async (url,options)=>{
  if(url.endsWith('/national-ready')) return Response.json({routing:{ready:true}});
  const request=JSON.parse(options.body); window.selectionRequests.push(request);
  const allowed=request.allowStreetTransfers;
  // Deliberately ignore abort: obsolete responses must still be rejected by the hook.
  await new Promise(resolve=>setTimeout(resolve,allowed?10:100));
  const plan={id:(allowed?'allowed':'station')+':'+request.minimumTransferBufferMinutes,status:'blocked',travelMode:'transit',timePreference:'depart',
    maxWalkKm:1.2,departMinutes:480,durationMinutes:0,walkMinutes:0,rideMinutes:0,waitMinutes:0,transfers:0,
    title:'Fixture result',detail:'Fixture result',origin,destination,legs:[],diagnostics:{serviceDay:'weekday'}};
  return Response.json({choices:[plan],selectedPlanId:plan.id});
};
function Fixture(){
 const [allowStreetTransfers,setAllowStreetTransfers]=useState(true);
 const [minimumTransferBufferMinutes,setMinimumTransferBufferMinutes]=useState(0);
 const [allowLongWalk,setAllowLongWalk]=useState(true);
 const [routingDataMode,setRoutingDataMode]=useState('scheduled');
 const routing=useNationalRouting({active:true,projectId:'fixture',feedId:'fixture',storeKey:'fixture',
   origin,waypoints,destination,mode:'transit',routingDataMode,departMinutes:480,timePreference:'depart',
   serviceDay:'weekday',serviceDate:'2026-07-15',maxWalkKm:1.2,allowLongWalk,allowStreetTransfers,minimumTransferBufferMinutes,
   departureWindowMinutes:0,realtimeSnapshot:null,routeAllowed:true});
 return React.createElement('main',{className:'app-shell appearance-light accent-teal page-project view-pathfinder',style:{display:'block',overflowY:'auto',width:'100%',maxWidth:380,margin:'0 auto',padding:12}},
  React.createElement('output',{id:'selection-result',style:{display:'none'}},routing.choices[0]?.id||'pending'),
  React.createElement(SidebarPathfinderBox,{
   routingEnabled:false,routingOrigin:origin,routingWaypoints:waypoints,routingDestination:destination,
   routingPlan:null,routingChoices:[],routingScopeStatus:'ready',routingStoreReady:true,
   routingTimePreference:'depart',routingMode:'transit',routingDataMode,routingDepartureWindowMinutes:0,
   routingMaxWalkKm:1.2,routingAllowLongWalk:allowLongWalk,routingAllowStreetTransfers:allowStreetTransfers,routingMinimumTransferBufferMinutes:minimumTransferBufferMinutes,
   routingActivity:{kind:'idle',title:'',detail:''},routingAlternativesLoading:false,
   routingServiceDate:'2026-07-15',routingServiceCoverage:null,routingServiceDateAvailability:'covered',
   routingServiceDateOptions:[],storeBackedRouting:true,scheduleTimeMinutes:480,routingPickIndex:null,
   onRunRouting:routing.reset,onRoutingAllowStreetTransfersChange:setAllowStreetTransfers,onRoutingMinimumTransferBufferChange:setMinimumTransferBufferMinutes,
   onPickRoutingPoint:noOp,onReorderRoutingPoints:noOp,onOpenFeed:noOp,onScheduleTimeChange:noOp,
   onRoutingTimePreferenceChange:noOp,onRoutingModeChange:noOp,onRoutingDataModeChange:setRoutingDataMode,
   onRoutingDepartureWindowChange:noOp,onRoutingMaxWalkKmChange:noOp,onRoutingMaxTransfersChange:noOp,
   onRoutingAllowLongWalkChange:setAllowLongWalk,onRoutingServiceDateChange:noOp,onSelectRoutingPlan:noOp,
   onToggleRouting:noOp,onClearRouting:noOp}));
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));`
const server = await createViteTestServer({ root, configFile: false, cacheDir: path.join(directory, 'vite-cache'),
  plugins: [react(), {
    name: 'transfer-selection-fixture',
    resolveId(id) { if (id === '/selection-fixture.js') return id },
    load(id) { if (id === '/selection-fixture.js') return fixture },
    configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
      if (req.url !== '/selection-fixture.html') return next()
      res.setHeader('Content-Type', 'text/html')
      res.end(await vite.transformIndexHtml(req.url, '<div id="root"></div><script type="module" src="/selection-fixture.js"></script>'))
    }) },
  }], server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { include: ['react', 'react-dom/client'] } })
try {
  await server.listen()
  const url = `http://127.0.0.1:${server.httpServer.address().port}/selection-fixture.html`
  await runElectronCheck(`
    await app.whenReady();
    const window=new BrowserWindow({show:false,width:390,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    await window.loadURL(${JSON.stringify(url)});
    const read=code=>window.webContents.executeJavaScript(code);
    await until(()=>read('document.getElementById("selection-result")?.textContent==="allowed:0"'));
    assert.equal(await read('window.selectionRequests.at(-1).requireTransitRide'),false,'Point-to-point transit must admit direct walking');
    await read('document.querySelector(".pathfinder-options").open=true;document.getElementById("pathfinder-long-walk").click()');
    await until(()=>read('window.selectionRequests.at(-1).allowLongWalk===false'));
    assert.equal(await read('window.selectionRequests.at(-1).requireTransitRide'),false,'Disabling longer walks must still admit short direct walks');
    await read('document.getElementById("pathfinder-street-transfers").click()');
    await until(()=>read('document.getElementById("selection-result").textContent==="station:0"'));
    assert.equal(await read('window.selectionRequests.at(-1).allowStreetTransfers'),false);
    assert.equal(await read('document.getElementById("pathfinder-street-transfers").checked'),false);
    assert.equal(await read('window.selectionRequests.at(-1).minimumTransferBufferMinutes'),0);
    await read('{const select=document.getElementById("pathfinder-transfer-buffer");select.value="2";select.dispatchEvent(new Event("change",{bubbles:true}))}');
    await until(()=>read('document.getElementById("selection-result").textContent==="station:2"'));
    assert.equal(await read('window.selectionRequests.at(-1).minimumTransferBufferMinutes'),2);
    assert.equal(await read('document.getElementById("pathfinder-transfer-buffer").value'),'2');
    for(const width of [320,390]){
      window.setContentSize(width,1000); await wait(50);
      assert(await read('document.documentElement.scrollWidth<=innerWidth+1'),'Route options must fit a narrow window');
    }
    window.setContentSize(390,1000); await wait(50);
    await read('document.querySelector(".pathfinder-options").scrollIntoView()');
    await (await import('node:fs/promises')).writeFile(${JSON.stringify(screenshotPath)},(await window.webContents.capturePage()).toPNG());
    await read('{const select=document.getElementById("pathfinder-transfer-buffer");select.value="0";select.dispatchEvent(new Event("change",{bubbles:true}))}');
    await until(()=>read('document.getElementById("selection-result").textContent==="station:0"'));
    await read('document.getElementById("pathfinder-street-transfers").click()');
    await until(()=>read('document.getElementById("selection-result").textContent==="allowed:0"'));
    assert.equal(await read('window.selectionRequests.at(-1).allowStreetTransfers'),true);
    const count=await read('window.selectionRequests.length');
    await read('document.getElementById("pathfinder-street-transfers").click()');
    await until(()=>read('window.selectionRequests.length>'+count));
    await read('document.getElementById("pathfinder-street-transfers").click()');
    await until(()=>read('document.getElementById("selection-result").textContent==="allowed:0"'));
    await wait(150);
    assert.equal(await read('document.getElementById("selection-result").textContent'),'allowed:0','A superseded restricted response cannot overwrite the new choice');
    await read('[...document.querySelectorAll("button")].find(button=>button.textContent==="Realtime").click()');
    await until(()=>read('window.selectionRequests.at(-1).routingDataMode==="realtime"'));
    assert.equal(await read('window.selectionRequests.at(-1).departNow'),true);
    assert.equal(await read('window.selectionRequests.at(-1).requireTransitRide'),false,'Depart now must compare direct walking too');
    window.destroy();
  `)
  console.log(`Route controls passed: walking comparison, realtime mode, transfer settings, obsolete responses and 320/390 px layout. Screenshot: ${screenshotPath}`)
} finally {
  await server.close()
  await fs.rm(path.join(directory, 'vite-cache'), { recursive: true, force: true })
}
