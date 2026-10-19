import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import electronPath from 'electron'
import react from '@vitejs/plugin-react'
import { createViteTestServer } from './helpers/vite-test-server.mjs'
import { createAgencyService } from '../src/server/agency-api.mjs'
import { createAgencyFixture, observationTime, realtimeFixture, tripUpdate } from './fixtures/agency.mjs'
import { checkDirectory } from './helpers/check-directory.mjs'

const root = path.resolve(import.meta.dirname, '..')
const directory = await checkDirectory(root, 'network-workspace-runtime-')
const storePath = path.join(directory, 'schedule.sqlite'), agencyDirectory = path.join(directory, 'agency')
createAgencyFixture(storePath)
const snapshot = realtimeFixture([tripUpdate('T1', 900), tripUpdate('T2'), tripUpdate('T3')])
const service = createAgencyService({
  context: async () => ({ storePath, cityName: 'City X', agencyDirectory }),
  inspectRealtime: async () => snapshot,
}, { clock: () => observationTime * 1000 })
let server
try {
  for (const action of ['ask', 'skills', 'run-skill', 'skill-install', 'skill-enabled', 'notebook-clear-ask', 'web-status', 'web-connect']) {
    await assert.rejects(service.handle('fixture', { action }), error => error.statusCode === 400)
  }
  await service.connect('fixture', { sources: [{ url: snapshot.feeds[0].sourceUrl, kind: 'tripUpdates' }] })

  const fixture = `import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AgencyPanel} from '/src/components/AgencyPanel.tsx';
import {PrimaryNav} from '/src/components/PrimaryNav.tsx';
import '/src/App.css';import '/src/index.css';
Date.now=()=>${observationTime * 1000};
sessionStorage.setItem('agency-mode-fixture','ask');
const noop=()=>{};
const waitFor=async(test,label)=>{const end=performance.now()+10000;while(!test()){if(performance.now()>end)throw Error(label);await new Promise(r=>setTimeout(r,20));}};
window.exports=[];
HTMLAnchorElement.prototype.click=function(){if(this.download)fetch(this.href).then(r=>r.json()).then(value=>window.exports.push({name:this.download,value}));};
function Fixture(){const [selection,setSelection]=useState({});return <main className="app-shell page-project view-agency">
<header className="topbar">City X</header><div className="shell-body"><aside className="app-sidebar"><PrimaryNav page="project" activeRouteTool="agency" hasActiveData onOpenNetwork={noop} onOpenRouting={noop} onOpenAnalyze={noop} onOpenSettings={noop}/></aside>
<div className="app-frame"><section className="project-workbench"><div className="route-surface">Network map fixture</div>
<AgencyPanel projectId="fixture" staticFeeds={[]} snapshot={${JSON.stringify(snapshot)}} realtimeRequest={null} realtimeMessage="" realtimeLoading={false} onConnect={noop} onDisconnect={noop} onOpenData={noop} mapOpen={false} onToggleMap={noop} selection={selection} onClearSelection={()=>setSelection({})} onBrowseRoute={routeId=>setSelection({routeId})} onLocate={(routes,stops)=>setSelection({routeId:routes[0],stopId:stops[0]})} timetable={<p>Route stop details</p>}/>
</section></div></div></main>}
createRoot(document.getElementById('root')).render(<Fixture/>);
window.checkNetwork=async()=>{
 await waitFor(()=>document.querySelector('.agency-overview'),'Network did not load');
 document.querySelector('.app-shell').classList.add('appearance-'+document.documentElement.dataset.appearance);
 const tabs=[...document.querySelectorAll('.agency-tabs [role=tab]')];
 if(tabs.map(b=>b.textContent).join(',')!=='Network,Routes')throw Error('Unexpected Network tabs');
 if(tabs[0].getAttribute('aria-selected')!=='true'||sessionStorage.getItem('agency-mode-fixture')!=='overview')throw Error('Saved Ask tab did not recover to Network');
 if(document.querySelector('#agency-ask,.agency-composer-dock'))throw Error('Conversation UI remains');
 if(document.querySelector('.agency-briefing,.agency-provider-settings'))throw Error('Retired research UI remains');
 const updates=document.querySelector('.agency-service-events');updates.open=true;
 await waitFor(()=>updates.querySelector('.agency-event'),'Service updates are missing');updates.querySelector('.agency-event').click();
 await waitFor(()=>document.querySelector('.agency-evidence'),'Evidence detail did not open');
 document.querySelector('.agency-evidence > button').click();
 await waitFor(()=>document.querySelector('#agency-overview'),'Evidence did not return to Network');
 tabs[0].dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
 await waitFor(()=>tabs[1].getAttribute('aria-selected')==='true','Keyboard navigation failed');
 [...document.querySelectorAll('.network-selection button')].find(b=>b.textContent.includes('All routes'))?.click();
 await waitFor(()=>document.querySelector('[data-route-id=R]'),'Route catalog did not load');
 document.querySelector('[data-route-id=R]').click();
 await waitFor(()=>document.querySelector('.network-selection h1')?.textContent==='R','Route selection did not load');
 await waitFor(()=>document.querySelector('.agency-trip-timetable h2'),'Trip times did not load');
 if(document.querySelector('.network-selection').textContent.includes('Ask'))throw Error('Selection still links to Ask');
 [...document.querySelectorAll('.agency-route-sections button')].find(b=>b.textContent==='Stops').click();
 await waitFor(()=>document.querySelector('.network-timetable'),'Route details did not open');
 [...document.querySelectorAll('.network-selection button')].find(b=>b.textContent.includes('All routes')).click();
 await waitFor(()=>document.querySelector('.agency-route-search'),'Route catalog did not return');
 if(document.documentElement.scrollWidth>innerWidth)throw Error('Horizontal overflow');
 const color=getComputedStyle(document.querySelector('.agency-panel')).backgroundColor.match(/^rgb\\((\\d+), (\\d+), (\\d+)\\)$/);
 if(!color||(document.documentElement.dataset.appearance==='dark'?Number(color[1])>=128:Number(color[1])<=128))throw Error('Appearance did not apply to the Network panel');
 return {width:innerWidth,appearance:document.documentElement.dataset.appearance,tabs:tabs.map(b=>b.textContent),legacyTabRecovered:true,routeSelection:true,serviceEvidence:true};
};`
  server = await createViteTestServer({ root, configFile: false, cacheDir: path.join(directory, 'vite-cache'), plugins: [react(), {
    name: 'network-workspace-fixture',
    resolveId(id) { if (id === '/network-fixture.jsx') return id },
    load(id) { if (id === '/network-fixture.jsx') return fixture },
    configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
      if (req.url === '/network-fixture.html') {
        res.setHeader('Content-Type', 'text/html')
        res.end(await vite.transformIndexHtml(req.url, '<div id="root"></div><script type="module" src="/network-fixture.jsx"></script>'))
        return
      }
      if (!req.url?.startsWith('/api/projects/fixture/agency')) return next()
      try {
        const url = new URL(req.url, 'http://localhost')
        const body = req.method === 'POST' ? JSON.parse(await new Promise(resolve => { let text = ''; req.on('data', chunk => { text += chunk }); req.on('end', () => resolve(text)) })) : null
        const result = body ? await service.handle('fixture', body) : await service.state('fixture', Object.fromEntries(url.searchParams))
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result))
      } catch (error) { res.statusCode = error.statusCode ?? 500; res.end(JSON.stringify({ error: error.message })) }
    }) },
  }], server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { include: ['react', 'react-dom/client'] } })
  await server.listen()
  const main = path.join(directory, 'main.cjs')
  await fs.writeFile(main, `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');
const {layoutFrame}=require(${JSON.stringify(path.join(root, 'test/helpers/layout-frame.cjs'))});
app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});app.setPath('userData',${JSON.stringify(path.join(directory, 'profile'))});
app.whenReady().then(async()=>{try{const results=[];for(const [width,height,appearance] of [[390,844,'light'],[390,844,'dark'],[1440,900,'light'],[1440,900,'dark']]){
 const window=new BrowserWindow({show:false,frame:false,width,height,useContentSize:true,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}});
 window.setContentSize(width,height);await window.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/network-fixture.html`)});
 await window.webContents.executeJavaScript('document.documentElement.dataset.appearance='+JSON.stringify(appearance));
 await window.webContents.executeJavaScript('new Promise((resolve,reject)=>{const end=setTimeout(()=>reject(Error("Fixture timed out")),15000);const poll=setInterval(()=>{if(window.checkNetwork){clearInterval(poll);clearTimeout(end);resolve()}},20)})');
 await layoutFrame(window);results.push(await window.webContents.executeJavaScript('window.checkNetwork()'));
 fs.writeFileSync(${JSON.stringify(path.join(directory, 'network-'))}+width+'-'+appearance+'.png',(await layoutFrame(window)).toPNG());window.destroy();
 }console.log(JSON.stringify({passed:true,results,screenshots:${JSON.stringify(directory)}}));app.exit(0)}catch(error){console.error(error);app.exit(1)}});`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronPath, [...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []), main], { env, stdio: 'inherit' })
  const timeout = setTimeout(() => child.kill(), 60_000)
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    assert.equal(code, 0, 'Network workspace runtime fixture failed')
  } finally { clearTimeout(timeout) }
} finally {
  await server?.close()
  service.close()
  await Promise.all(['vite-cache', 'profile'].map(name => fs.rm(path.join(directory, name), { recursive: true, force: true })))
}
