import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import electronPath from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createAgencyService } from '../src/server/agency-api.mjs'
import { createAgencyFixture, realtimeFixture, tripUpdate, observationTime } from './fixtures/agency.mjs'

const root = path.resolve(import.meta.dirname, '..')
const directory = await fs.mkdtemp(path.join(root, 'temp', 'operations-runtime-'))
const file = path.join(directory, 'schedule.sqlite')
createAgencyFixture(file)
const snapshot = realtimeFixture([tripUpdate('T1', 300), tripUpdate('T2', 800), tripUpdate('T3', 300)])
const service = createAgencyService({ context: async () => ({ storePath: file, cityName: 'Synthetic City X', agencyDirectory: path.join(directory, 'agency') }), inspectRealtime: async () => snapshot }, { clock: () => observationTime * 1000, provider: { available: false, status: () => ({ available: false }) } })
await service.connect('fixture', {})
const harness = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {AgencyPanel} from '/src/components/AgencyPanel.tsx';
import '/src/App.css';
Date.now = () => ${observationTime * 1000};
const noop = () => {};
createRoot(document.getElementById('root')).render(React.createElement('div',{className:'app-shell page-project view-agency',style:{display:'block',height:'100vh'}},React.createElement(AgencyPanel,{projectId:'fixture',snapshot:null,realtimeRequest:null,realtimeMessage:'',realtimeLoading:false,onConnect:noop,onDisconnect:noop,onLocate:noop,onBrowseRoute:noop,onClearSelection:noop,onResult:noop,onOpenData:noop,mapOpen:false,onToggleMap:noop})));
const wait = async test => { const end=performance.now()+15000; while(performance.now()<end) { if(test()) return; await new Promise(resolve=>setTimeout(resolve,30)); } throw Error('UI condition timed out: '+test.toString()+'; '+document.body.innerText); };
const button = label => [...document.querySelectorAll('button')].find(item=>item.textContent.trim()===label);
const click = async label => { await wait(()=>button(label) && !button(label).disabled); button(label).click(); };
const fill = (element,value) => { const setter=Object.getOwnPropertyDescriptor(element.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:element.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set; setter.call(element,value); element.dispatchEvent(new Event(element.tagName==='SELECT'?'change':'input',{bubbles:true})); };
window.runTests = async () => {
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
  await click('Research');
  await wait(()=>document.getElementById('agency-skills'));
  document.querySelector('.agency-more summary').click();
  await click('Service desk');
  await wait(()=>document.querySelector('.agency-ops-new'));
  document.querySelector('.agency-ops-new').open=true;
  const finding=[...document.querySelectorAll('.agency-ops-new button')].find(item=>item.textContent.includes('Wider departure'));
  if(!finding) throw Error('No current gap to track'); finding.click();
  await wait(()=>document.querySelector('.agency-ops-detail'));
  for(const action of ['Acknowledge','Investigate','Record action']) {
    fill(document.querySelector('.agency-ops-detail textarea'),'Synthetic fixture: checked source and recorded '+action+'.');
    await click(action);
    await wait(()=>!button(action) || button(action).disabled);
    await wait(()=>!document.querySelector('.agency-ops-detail textarea').value);
  }
  await click('Create draft');
  await wait(()=>button('Approve saved copy'));
  fill(document.querySelector('.agency-ops-detail textarea'),'Route R: a wider departure interval is predicted at River. Check current departures.');
  await click('Save revision');
  await wait(()=>button('Save revision').disabled);
  await click('Approve saved copy');
  await click('Release to local outbox');
  await wait(()=>button('Export approved handoff'));
  if(!document.body.innerText.includes('Record delivery only after the agency channel confirms it')) throw Error('Handoff must distinguish actual delivery');
  const receipt=[...document.querySelectorAll('.agency-ops-detail input')].find(item=>item.placeholder.includes('confirmation'));
  fill(receipt,'Synthetic UI receipt; not a real rider publication');
  await click('Record confirmed delivery');
  await wait(()=>document.body.innerText.includes('Staff-recorded delivery'));
  await click('View revision history');
  await wait(()=>document.querySelector('.agency-ops-audit details'));
  await click('History');
  fill(document.querySelector('.agency-ops-fields select'),'R');
  await click('Compare earlier service days');
  await wait(()=>document.body.innerText.includes('Building history'));
  await click('Findings');
  await wait(()=>button('Findings').getAttribute('aria-pressed')==='true');
  document.querySelector('.agency-ops-records button').click();
  await wait(()=>document.querySelector('.agency-ops-detail'));
  if(document.querySelector('[role=alert]')) throw Error(document.querySelector('[role=alert]').textContent);
  await click('Replay');
  await wait(()=>button('Open scenario'));
  await click('Open scenario');
  await wait(()=>button('Prepare selected option'));
  if(!document.querySelector('.agency-replay').textContent.includes('120 seconds')) throw Error('Constrained holding candidate missing');
  await click('Prepare selected option');
  await click('Approve option & message');
  await click('Send to sandbox');
  await click('Retry sandbox delivery');
  await wait(()=>document.querySelector('.agency-replay').textContent.includes('Sandbox receipt recorded'));
  await click('Next observation');
  await wait(()=>document.querySelector('.agency-replay').textContent.includes('Reconsider this decision'));
  if(button('Send to sandbox') || button('Retry sandbox delivery')) throw Error('Changed evidence cannot be delivered');
  await click('Open new run');
  await wait(()=>button('Prepare selected option'));
  return {keyboardTabs:true,tracked:true,workflow:true,copyRevision:true,approval:true,localOutbox:true,staffReceipt:true,audit:true,insufficientHistory:true,replayApproval:true,replayRetry:true,replayWithdrawal:true};
};
window.layoutCheck = async () => {
  const panel=document.querySelector('.agency-panel'); panel.style.height='100vh';
  const overflow=[...document.querySelectorAll('.agency-panel,.agency-scroll,.agency-tabs,.agency-operations')].filter(item=>item.scrollWidth>item.clientWidth+2).map(item=>item.className);
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
      if(composer.top > 400) throw Error('Empty chat requires too much scrolling');
      document.querySelector('.agency-provider-toggle').click();
      await wait(()=>document.getElementById('agency-ai-settings'));
      if(content.scrollWidth>content.clientWidth+2) throw Error('AI settings overflow at '+innerWidth);
      document.querySelector('.agency-provider-toggle').click();
    }
    views.push(id);
  }
  return {width:innerWidth,overflow:false,views};
};`
const server = await createServer({ root, configFile: false, plugins: [react(), {
  name: 'operations-fixture',
  configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
    try {
      if (req.url === '/operations-fixture.html') { res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml(req.url, '<div id="root"></div><script type="module" src="/operations-fixture.js"></script>')); return }
      if (req.url === '/operations-fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end((await vite.transformRequest('virtual:operations-fixture')).code); return }
      if (req.url?.startsWith('/api/projects/fixture/agency')) {
        let text = ''; for await (const chunk of req) text += chunk
        const result = req.method === 'GET' ? await service.state('fixture') : await service.handle('fixture', JSON.parse(text))
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result)); return
      }
      next()
    } catch (error) { res.statusCode = error.statusCode || 500; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: error.message })) }
  }) },
  resolveId(id) { if (id === 'virtual:operations-fixture' || id === '/operations-fixture.js') return 'virtual:operations-fixture' }, load(id) { if (id === 'virtual:operations-fixture') return harness },
}], server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { include: ['react', 'react-dom/client'] } })
await server.listen()
const main = path.join(directory, 'main.cjs')
await fs.writeFile(main, `const {app,BrowserWindow}=require('electron'); const fs=require('node:fs');
app.setPath('userData',${JSON.stringify(path.join(directory, 'profile'))});
app.whenReady().then(async()=>{ try {
  const window=new BrowserWindow({show:false,width:1280,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  window.webContents.on('console-message', event=>{if(event.level==='error') console.error(event.message)});
  await window.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/operations-fixture.html`)});
  await window.webContents.executeJavaScript('new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{if(window.runTests){clearInterval(timer);resolve()}else if(Date.now()-start>20000){clearInterval(timer);reject(Error("Fixture did not load"))}},50)})');
  const result=await window.webContents.executeJavaScript('window.runTests()');
  for(const width of [1280,760,390,320]) { window.setSize(width,1000); await new Promise(resolve=>setTimeout(resolve,200)); result[width]=await window.webContents.executeJavaScript('window.layoutCheck()'); if(width===1280||width===320) fs.writeFileSync(${JSON.stringify(directory)}+'/operations-'+width+'.png',(await window.webContents.capturePage()).toPNG()); }
  console.log(JSON.stringify({passed:true,...result,screenshots:${JSON.stringify(directory)}})); app.exit(0);
}catch(error){console.error(error);app.exit(1)}});`)
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronPath, [...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []), main], { env, stdio: 'inherit' })
  const timeout = setTimeout(() => child.kill(), 90_000)
  try { const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }); if (code !== 0) throw new Error(`Operations UI fixture exited ${code}`) }
  finally { clearTimeout(timeout) }
} finally { await server.close(); service.close() }
