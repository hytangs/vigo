import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import electronPath from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createAgencyService } from '../src/server/agency-api.mjs'
import { createAgencyFixture, realtimeFixture, tripUpdate, observationTime } from './fixtures/agency.mjs'

const root = path.resolve(import.meta.dirname, '..')
const directory = await fs.mkdtemp(path.join(root, 'temp', 'network-workspace-runtime-'))
const file = path.join(directory, 'schedule.sqlite')
createAgencyFixture(file)
const snapshot = realtimeFixture([tripUpdate('T1', 300), tripUpdate('T2', 800), tripUpdate('T3', 300)])
const service = createAgencyService({ context: async () => ({ storePath: file, cityName: 'Synthetic City X', agencyDirectory: path.join(directory, 'agency') }), inspectRealtime: async () => snapshot }, { clock: () => observationTime * 1000, provider: { available: false, status: () => ({ available: false }) } })
await service.connect('fixture', {})
const harness = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {AgencyPanel} from '/src/components/AgencyPanel.tsx';
import '/src/App.css';
import '/src/index.css';
Date.now = () => ${observationTime * 1000};
const noop = () => {};
const root = createRoot(document.getElementById('root'));
const shell = child => React.createElement('div',{className:'app-shell page-project view-agency',style:{display:'block',height:'100vh'}},child);
let observationReads = 0;
const originalFetch = window.fetch;
window.fetch = (url, init) => { if(String(url).includes('/agency?') && (!init?.method || init.method === 'GET')) observationReads++; return originalFetch(url, init); };
const renderWorkspace = (snapshot = null) => root.render(shell(React.createElement(AgencyPanel,{projectId:'fixture',snapshot,realtimeRequest:null,realtimeMessage:'',realtimeLoading:false,onConnect:noop,onDisconnect:noop,onLocate:noop,onBrowseRoute:noop,onClearSelection:noop,onResult:noop,onOpenData:noop,mapOpen:false,onToggleMap:noop})));
// Old prototype selections must recover to the focused workspace.
sessionStorage.setItem('agency-mode-fixture','operations');
renderWorkspace();
const wait = async test => { const end=performance.now()+15000; while(performance.now()<end) { if(test()) return; await new Promise(resolve=>setTimeout(resolve,30)); } throw Error('UI condition timed out: '+test.toString()+'; '+document.body.innerText); };
const button = label => [...document.querySelectorAll('button')].find(item=>item.textContent.trim()===label);
const click = async label => { await wait(()=>button(label) && !button(label).disabled); button(label).click(); };
const fill = (element,value) => { const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(element,value); element.dispatchEvent(new Event('input',{bubbles:true})); };
window.runTests = async () => {
  await wait(()=>document.getElementById('agency-briefing'));
  const snapshot = {...${JSON.stringify(snapshot)}, counts: {vehicles: ${snapshot.vehicles.length}, tripUpdates: ${snapshot.tripUpdates.length}, alerts: ${snapshot.alerts.length}}};
  const previousReads = observationReads;
  renderWorkspace(snapshot);
  await wait(()=>observationReads > previousReads);
  const connectedReads = observationReads;
  for(let i=0;i<5;i++) { renderWorkspace({...snapshot,fetchedAt:new Date(Date.now()+i*1000).toISOString()}); await new Promise(resolve=>setTimeout(resolve,30)); }
  if(observationReads !== connectedReads) throw Error('Map feed updates must not start duplicate dashboard assessments');

  await click('Routes');
  await wait(()=>document.querySelector('.agency-route-browser'));
  if(document.querySelectorAll('[role=tab]').length!==3) throw Error('Keep only three primary views');
  fill(document.querySelector('[aria-label="Find a route"]'),'no such route');
  await wait(()=>document.querySelector('.agency-route-browser').textContent.includes('No routes match'));
  document.querySelector('[aria-label="Clear route search"]').click();
  await wait(()=>document.querySelector('.agency-route-list button'));
  document.getElementById('agency-tab-live').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));
  await wait(()=>document.getElementById('agency-tab-ask').getAttribute('aria-selected')==='true');
  await wait(()=>document.querySelector('.agency-conversation-toolbar'));
  document.querySelector('.agency-more summary').click();
  if(button('Research') || button('Service desk')) throw Error('Prototype navigation must stay outside the daily workspace');
  await click('Feed settings');
  await wait(()=>document.querySelector('.agency-connect'));
  document.querySelector('[aria-label="Close feed settings"]').click();
  await click('Routes');
  await wait(()=>document.querySelector('.agency-route-browser'));
  return {snapshotRefreshIsolation:true,focusedWorkspace:true,legacyModeRecovery:true,keyboardTabs:true,routeSearch:true,feedSettings:true};
};
window.layoutCheck = async () => {
  const panel=document.querySelector('.agency-panel'); panel.style.height=innerHeight<=400?'176px':'100vh';
  const overflow=[...document.querySelectorAll('.agency-panel,.agency-scroll,.agency-tabs')].filter(item=>item.scrollWidth>item.clientWidth+2).map(item=>item.className);
  if(overflow.length) throw Error('Horizontal overflow at '+innerWidth+': '+overflow.join(', ')+'; '+JSON.stringify([...document.querySelector('.agency-panel').children].map(item=>[item.className,item.clientWidth,item.scrollWidth])));
  const views=[];
  for(const id of ['live','ask']) {
    document.getElementById('agency-tab-'+id).click();
    await wait(()=>document.getElementById('agency-'+id));
    const nav=document.querySelector('.agency-navigation').getBoundingClientRect();
    if(nav.top < 0 || nav.height > 90) throw Error('Navigation must remain compact and visible');
    const content=document.querySelector('.agency-scroll');
    if(content.scrollWidth>content.clientWidth+2) throw Error('Network content overflows at '+innerWidth);
    if(id==='ask') {
      const composer=document.querySelector('.agency-question-form').getBoundingClientRect();
      if(composer.bottom > panel.getBoundingClientRect().bottom || composer.top < nav.bottom) throw Error('Composer must remain visible below navigation');
      const originalTop=composer.top;
      const spacer=document.createElement('div'); spacer.style.height='1800px'; content.appendChild(spacer); content.scrollTop=900;
      if(Math.abs(document.querySelector('.agency-question-form').getBoundingClientRect().top-originalTop)>1) throw Error('Reading history must not move the composer');
      spacer.remove(); content.scrollTop=0;
      document.querySelector('.agency-provider-toggle').click();
      await wait(()=>document.getElementById('agency-ai-settings'));
      if(content.scrollWidth>content.clientWidth+2) throw Error('AI settings overflow at '+innerWidth);
      document.querySelector('.agency-provider-toggle').click();
    }
    views.push(id);
  }
  return {width:innerWidth,height:innerHeight,overflow:false,views};
};`
const server = await createServer({ root, configFile: false, plugins: [react(), {
  name: 'network-workspace-fixture',
  configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
    try {
      if (req.url === '/network-workspace-fixture.html') { res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml(req.url, '<div id="root"></div><script type="module" src="/network-workspace-fixture.js"></script>')); return }
      if (req.url === '/network-workspace-fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end((await vite.transformRequest('virtual:network-workspace-fixture')).code); return }
      if (req.url?.startsWith('/api/projects/fixture/agency')) {
        let text = ''; for await (const chunk of req) text += chunk
        const result = req.method === 'GET' ? await service.state('fixture') : await service.handle('fixture', JSON.parse(text))
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result)); return
      }
      next()
    } catch (error) { res.statusCode = error.statusCode || 500; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: error.message })) }
  }) },
  resolveId(id) { if (id === 'virtual:network-workspace-fixture' || id === '/network-workspace-fixture.js') return 'virtual:network-workspace-fixture' }, load(id) { if (id === 'virtual:network-workspace-fixture') return harness },
}], server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { include: ['react', 'react-dom/client'] } })
await server.listen()
const main = path.join(directory, 'main.cjs')
await fs.writeFile(main, `const {app,BrowserWindow}=require('electron'); const fs=require('node:fs');
app.setPath('userData',${JSON.stringify(path.join(directory, 'profile'))});
app.whenReady().then(async()=>{ try {
  const window=new BrowserWindow({show:false,width:1280,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  window.webContents.on('console-message', event=>{if(event.level==='error') console.error(event.message)});
  await window.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/network-workspace-fixture.html`)});
  await window.webContents.executeJavaScript('new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{if(window.runTests){clearInterval(timer);resolve()}else if(Date.now()-start>20000){clearInterval(timer);reject(Error("Fixture did not load"))}},50)})');
  const result=await window.webContents.executeJavaScript('window.runTests()');
  for(const [width,height] of [[1280,1000],[760,1000],[390,1000],[320,1000],[760,400]]) { window.setContentSize(width,height); await new Promise(resolve=>setTimeout(resolve,200)); result[width+'x'+height]=await window.webContents.executeJavaScript('window.layoutCheck()'); if(width===1280||width===320) fs.writeFileSync(${JSON.stringify(directory)}+'/network-workspace-'+width+'.png',(await window.webContents.capturePage()).toPNG()); }
  console.log(JSON.stringify({passed:true,...result,screenshots:${JSON.stringify(directory)}})); app.exit(0);
}catch(error){console.error(error);app.exit(1)}});`)
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronPath, [...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []), main], { env, stdio: 'inherit' })
  const timeout = setTimeout(() => child.kill(), 90_000)
  try { const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }); if (code !== 0) throw new Error(`Network workspace fixture exited ${code}`) }
  finally { clearTimeout(timeout) }
} finally { await server.close(); service.close() }
