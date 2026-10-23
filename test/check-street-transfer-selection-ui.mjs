import fs from 'node:fs/promises'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { createViteTestServer } from './helpers/vite-test-server.mjs'
import { runElectronCheck } from './helpers/electron-check.mjs'

import { checkDirectory } from './helpers/check-directory.mjs'

const root = path.resolve(import.meta.dirname, '..')
const directory = await checkDirectory(root, 'transfer-selection-ui-')
const screenshotPath = path.join(directory, 'transfer-options.png')
const fixture = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SidebarPathfinderBox} from '/src/components/PathfinderPanel.tsx';
import {useNationalRouting} from '/src/app/useNationalRouting.ts';
import {route} from '/src/state/route.ts';
import '/src/App.css'; import '/src/index.css';
document.documentElement.dataset.appearance='light';
const origin={coordinate:[0,0],label:'Origin',source:'map'};
const destination={coordinate:[.05,0],label:'Destination',source:'map'};
const waypoints=[]; const noOp=()=>{}; const alternative={key:'alternative',feedIds:['alternative'],scenario:null};
window.selectionRequests=[]; window.readinessRequests=[];
window.fetch=async (url,options)=>{
  if(url.endsWith('/national-ready')) { window.readinessRequests.push(JSON.parse(options.body)); return Response.json({routing:{ready:true}}); }
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
 const [wheelchair,setWheelchair]=useState(false);
 const [allowStreetTransfers,setAllowStreetTransfers]=useState(true);
 const [minimumTransferBufferMinutes,setMinimumTransferBufferMinutes]=useState(route.get().routingMinimumTransferBufferMinutes);
 const [allowLongWalk,setAllowLongWalk]=useState(true);
 const [routingDataMode,setRoutingDataMode]=useState('scheduled');
 const [network,setNetwork]=useState('scenario');
 const [time,setTime]=useState(769);
 const [date,setDate]=useState('2026-10-19');
 const routing=useNationalRouting({active:true,projectId:'fixture',feedId:'fixture',storeKey:'fixture',
   origin,waypoints,destination,wheelchair,mode:'transit',routingDataMode,departMinutes:480,timePreference:'depart',
   serviceDay:'weekday',serviceDate:'2026-07-15',maxWalkKm:1.2,allowLongWalk,allowStreetTransfers,minimumTransferBufferMinutes,
   departureWindowMinutes:0,realtimeSnapshot:null,routeAllowed:true,scenario:network==='feed:alternative'?alternative:null});
 return React.createElement('main',{className:'app-shell appearance-light accent-teal page-project view-pathfinder',style:{display:'block',overflowY:'auto',width:'100%',maxWidth:380,margin:'0 auto',padding:12}},
  React.createElement('output',{id:'selection-result',style:{display:'none'}},routing.choices[0]?.id||'pending'),
  React.createElement(SidebarPathfinderBox,{
   routingWheelchair:wheelchair,routingWheelchairAvailable:true,onRoutingWheelchairChange:setWheelchair,
   routingEnabled:false,routingOrigin:origin,routingWaypoints:waypoints,routingDestination:destination,
   routingPlan:null,routingChoices:[],routingScopeStatus:'ready',routingStoreReady:true,
   routingTimePreference:'depart',routingMode:'transit',routingDataMode,routingDepartureWindowMinutes:0,
   routingNetwork:{scenarios:[{id:'scenario',name:'Scenario A',detail:'Weekday timetable · 3 service changes'},{id:'feed:alternative',name:'Alternative network',detail:'Independent timetable'}],selectedId:network,error:'',onChange:setNetwork},
   routingMaxWalkKm:1.2,routingAllowLongWalk:allowLongWalk,routingAllowStreetTransfers:allowStreetTransfers,routingMinimumTransferBufferMinutes:minimumTransferBufferMinutes,
   routingActivity:{kind:'idle',title:'',detail:''},routingAlternativesLoading:false,
   routingServiceDate:date,routingServiceCoverage:null,routingServiceDateAvailability:'covered',
   routingServiceDateOptions:[],storeBackedRouting:true,scheduleTimeMinutes:time,routingPickIndex:null,
   onRunRouting:routing.reset,onRoutingAllowStreetTransfersChange:setAllowStreetTransfers,onRoutingMinimumTransferBufferChange:setMinimumTransferBufferMinutes,
   onPickRoutingPoint:noOp,onReorderRoutingPoints:noOp,onOpenFeed:noOp,onScheduleTimeChange:setTime,
   onRoutingTimePreferenceChange:noOp,onRoutingModeChange:noOp,onRoutingDataModeChange:setRoutingDataMode,
   onRoutingDepartureWindowChange:noOp,onRoutingMaxWalkKmChange:noOp,onRoutingMaxTransfersChange:noOp,
   onRoutingAllowLongWalkChange:setAllowLongWalk,onRoutingServiceDateChange:setDate,onSelectRoutingPlan:noOp,
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
    const {layoutFrame,resizeLayout}=await import(${JSON.stringify(new URL('./helpers/layout-frame.cjs', import.meta.url).href)});
    app.disableHardwareAcceleration();
    await app.whenReady();
    const window=new BrowserWindow({show:false,frame:false,useContentSize:true,width:390,height:1000,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}});
    await window.loadURL(${JSON.stringify(url)});
    const read=code=>window.webContents.executeJavaScript(code);
    await until(()=>read('document.getElementById("selection-result")?.textContent==="allowed:1"'));
    assert.equal(await read('window.selectionRequests.at(-1).requireTransitRide'),false,'Point-to-point transit must admit direct walking');
    await read('[...document.querySelectorAll("[role=tab]")].find(button=>button.textContent==="Preferences").click()');
    await until(()=>read('document.querySelector("[aria-labelledby$=preferences-tab]").hidden===false'));
    await read('document.getElementById("pathfinder-long-walk").click()');
    await until(()=>read('window.selectionRequests.at(-1).allowLongWalk===false'));
    assert.equal(await read('window.selectionRequests.at(-1).requireTransitRide'),false,'Disabling longer walks must still admit short direct walks');
    await read('document.getElementById("pathfinder-street-transfers").click()');
    await until(()=>read('document.getElementById("selection-result").textContent==="station:1"'));
    assert.equal(await read('window.selectionRequests.at(-1).allowStreetTransfers'),false);
    assert.equal(await read('document.getElementById("pathfinder-street-transfers").checked'),false);
    assert.equal(await read('window.selectionRequests.at(-1).minimumTransferBufferMinutes'),1);
    await read('{const select=document.getElementById("pathfinder-transfer-buffer");select.value="2";select.dispatchEvent(new Event("change",{bubbles:true}))}');
    await until(()=>read('document.getElementById("selection-result").textContent==="station:2"'));
    assert.equal(await read('window.selectionRequests.at(-1).minimumTransferBufferMinutes'),2);
    assert.equal(await read('document.getElementById("pathfinder-transfer-buffer").value'),'2');
    assert.equal(await read('window.selectionRequests.at(-1).wheelchair'),false);
    await read('document.querySelector(".routing-wheelchair").click()');
    await until(()=>read('window.selectionRequests.at(-1).wheelchair===true'));
    assert.equal(await read('document.querySelector(".routing-wheelchair").getAttribute("aria-pressed")'),'true');
    await read('document.querySelector(".routing-wheelchair").click()');
    await until(()=>read('window.selectionRequests.at(-1).wheelchair===false'));
    for(const width of [320,390]){
      await resizeLayout(window,width,1000);
      assert(await read('document.documentElement.scrollWidth<=innerWidth+1'),'Route options must fit a narrow window');
    }
    await resizeLayout(window,390,1000);
    await read('document.querySelector(".routing-setup").scrollIntoView()');
    await (await import('node:fs/promises')).writeFile(${JSON.stringify(screenshotPath)},(await layoutFrame(window)).toPNG());
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
    // Settings persist through tab switches; arrow keys move both selection and focus.
    await read('document.querySelector("[id$=preferences-tab]").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}))');
    assert.equal(await read('document.activeElement.id.endsWith("when-tab")'),true);
    assert.equal(await read('document.querySelector("[type=time]").value'),'12:49');
    assert.equal(await read('document.querySelector("[type=date]").value'),'2026-10-19');
    assert.equal(await read('[...document.querySelectorAll("button")].find(button=>button.textContent==="Now").disabled'),true,'Scenario timetable cannot be queried as realtime');
    await read('{const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;for(const [type,value] of [["time","14:25"],["date","2026-10-20"]]){const input=document.querySelector("[type="+type+"]");set.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}))}}');
    await until(()=>read('document.querySelector("[type=time]").value==="14:25"&&document.querySelector("[type=date]").value==="2026-10-20"'));

    await read('{const select=document.querySelector("select[aria-label^=Route]");select.value="";select.dispatchEvent(new Event("change",{bubbles:true}))}');
    await until(()=>read('[...document.querySelectorAll("button")].find(button=>button.textContent==="Now").disabled===false'));
    await read('{const select=document.querySelector("select[aria-label^=Route]");select.value="feed:alternative";select.dispatchEvent(new Event("change",{bubbles:true}))}');
    await until(()=>read('window.selectionRequests.at(-1).feedIds?.[0]==="alternative"'));
    assert.equal(await read('window.selectionRequests.at(-1).feedId'),undefined);
    assert.equal(await read('window.readinessRequests.at(-1).feedIds[0]'),'alternative','Readiness and routing must use the same network');
    await read('{const select=document.querySelector("select[aria-label^=Route]");select.value="";select.dispatchEvent(new Event("change",{bubbles:true}))}');
    await until(()=>read('window.selectionRequests.at(-1).feedId==="fixture"'));
    for(const appearance of ['dark','light']) {
      await read('document.querySelector("main").className="app-shell appearance-'+appearance+' accent-graphite page-project view-pathfinder"; document.documentElement.dataset.appearance="'+appearance+'"');
      for(const tab of ['when','preferences']) {
        await read('document.querySelector("[id$='+tab+'-tab]").click()');
        await until(()=>read('document.querySelector("[aria-labelledby$='+tab+'-tab]").hidden===false'));
        await read('document.querySelector(".routing-setup").scrollIntoView()');
        await wait(150);
        await layoutFrame(window);
        assert(await read('document.querySelector(".routing-setup").scrollWidth<=document.querySelector(".routing-setup").clientWidth+1'),'Settings must not overflow horizontally');
        await (await import('node:fs/promises')).writeFile(${JSON.stringify(directory)}+'/'+appearance+'-'+tab+'.png',(await layoutFrame(window)).toPNG());
      }
    }
    assert.equal(await read('document.getElementById("pathfinder-street-transfers").checked'),true,'Tab changes preserve transfer choices');
    assert.equal(await read('document.querySelector("[type=time]").value'),'14:25','Time edits survive tab changes');
    assert.equal(await read('document.querySelector("[type=date]").value'),'2026-10-20','Date edits survive tab changes');
    const expandedHeight=await read('document.querySelector(".routing-setup").getBoundingClientRect().height');
    await read('document.querySelector(".routing-setup-fold").click()');
    await until(()=>read('document.querySelector(".routing-setup-fold").getAttribute("aria-expanded")==="false"'));
    assert(await read('document.querySelector(".routing-setup").getBoundingClientRect().height')<expandedHeight/2,'Folding must reclaim meaningful space');
    assert.equal(await read('document.querySelector("[role=tablist]").getBoundingClientRect().height'),0);
    assert.match(await read('document.querySelector(".routing-setup-summary").textContent'),/Depart at 14:25.*2026-10-20/);
    await wait(150); await layoutFrame(window);
    await (await import('node:fs/promises')).writeFile(${JSON.stringify(directory)}+'/folded.png',(await layoutFrame(window)).toPNG());
    await read('document.querySelector(".routing-setup-fold").click()');
    await until(()=>read('document.querySelector("[aria-labelledby$=preferences-tab]").getBoundingClientRect().height>0'));
    assert.equal(await read('document.querySelector("[id$=preferences-tab]").getAttribute("aria-selected")'),'true','Expanding restores the selected tab');
    assert.equal(await read('document.getElementById("pathfinder-street-transfers").checked'),true,'Folding preserves settings');
    await read('document.querySelector(".routing-setup-fold").click()');
    await read('document.querySelector("[type=date]").max="2026-10-19";document.querySelector("form").requestSubmit()');
    await until(()=>read('document.querySelector("[aria-labelledby$=when-tab]").hidden===false'));
    // Focusing follows the tab update on requestAnimationFrame.
    await until(()=>read('document.activeElement.type==="date"'));
    assert.equal(await read('document.activeElement.type'),'date','Invalid dates reveal and focus the When tab');
    await read('document.querySelector("[type=date]").removeAttribute("max")');
    await read('document.querySelector("[id$=when-tab]").click()');
    await read('[...document.querySelectorAll("button")].find(button=>button.textContent==="Now").click()');
    await until(()=>read('window.selectionRequests.at(-1).routingDataMode==="realtime"'));
    assert.equal(await read('window.selectionRequests.at(-1).departNow'),true);
    assert.equal(await read('window.selectionRequests.at(-1).requireTransitRide'),false,'Depart now must compare direct walking too');
    window.destroy();
  `)
  console.log(`Route controls passed: walking comparison, realtime mode, transfer settings, obsolete responses and 320/390 px layout. Screenshot: ${screenshotPath}`)
} finally {
  await server.close()
  await fs.rm(path.join(directory, 'vite-cache'), { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
