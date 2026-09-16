import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import electronPath from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createAgencyService } from '../src/server/agency-api.mjs'
import { createAgencyFixture, realtimeFixture, tripUpdate, observationTime } from './fixtures/agency.mjs'

const root = path.resolve(import.meta.dirname, '..')
const directory = await fs.mkdtemp(path.join(root, 'temp', 'network-workspace-runtime-'))
const file = path.join(directory, 'schedule.sqlite')
createAgencyFixture(file)
const timetable = new DatabaseSync(file)
timetable.exec(`INSERT INTO routes VALUES ('R2','2','Harbor local',3,'0066AA'),('R7','7','Hill connector',3,'806600'),('R10','10','Airport express',3,'A04060');
  INSERT INTO trips VALUES ('T20','R2','S','0'),('T70','R7','S','0'),('T100','R10','S','0');
  INSERT INTO connections VALUES (43500,43800,'T20','R2','S','0','A','C',10),(43500,43800,'T70','R7','S','0','A','C',10),(43500,43800,'T100','R10','S','0','A','C',10);`)
timetable.close()
const snapshot = realtimeFixture([tripUpdate('T1', 300), tripUpdate('T2', 800), tripUpdate('T3', 300), tripUpdate('T20', 0, { routeId: 'R2' }), tripUpdate('T100', 600, { routeId: 'R10' })])
const alertSource = 'https://example.org/alerts.pb'
snapshot.feeds.push({ sourceUrl: alertSource, kind: 'alerts', feedTimestamp: observationTime, fetchedAt: snapshot.fetchedAt })
snapshot.alerts = Array.from({ length: 45 }, (_, index) => ({ id: `fixture-notice-${index}`, header: `River service notice ${index + 1}`, routeIds: ['R'], sourceUrl: alertSource }))
const service = createAgencyService({ context: async () => ({ storePath: file, cityName: 'Synthetic City X', agencyDirectory: path.join(directory, 'agency') }), inspectRealtime: async () => snapshot }, { clock: () => observationTime * 1000, provider: { available: true, model: 'Fixture model', status: () => ({ available: true, model: 'Fixture model' }) } })
await service.connect('fixture', {})
await service.handle('fixture', { action: 'briefing-settings', preferences: { automatic: false, intervalMinutes: 15 } })
const harness = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {AgencyPanel} from '/src/components/AgencyPanel.tsx';
import '/src/App.css';
import '/src/index.css';
Date.now = () => ${observationTime * 1000};
const noop = () => {};
const root = createRoot(document.getElementById('root'));
let appearance='light', renderKey=0, failLatestBriefing=true;
const shell = child => React.createElement('div',{className:'app-shell appearance-'+appearance+' page-project view-agency',style:{display:'block',height:'100vh',maxWidth:'480px'}},child);
let observationReads = 0, legacyTimetable = false;
let selectedScope = {}, activeSnapshot = null, browseRequest = 0, holdObservation = false, providerAvailable = true, failNextObservation = false;
const pendingObservations = [], pendingQuestions = [], downloads = [], blobs = new Map();
const originalFetch = window.fetch;
window.fetch = (url, init) => {
  if(String(url).includes('/agency?') && (!init?.method || init.method === 'GET')) {
    observationReads++;
    if(failNextObservation) {failNextObservation=false;return Promise.reject(Error('Fixture observation offline'))}
    if(holdObservation) return new Promise((resolve,reject)=>pendingObservations.push({resolve,reject,url,init}));
  }
  if(init?.method === 'POST' && JSON.parse(init.body).action === 'ask') return new Promise((resolve,reject)=>pendingQuestions.push({resolve,reject,body:JSON.parse(init.body),signal:init.signal}));
  if(init?.method === 'POST' && JSON.parse(init.body).action === 'briefing-latest' && failLatestBriefing) {failLatestBriefing=false;return Promise.reject(Error('Fixture briefing temporarily unavailable'))}
  return originalFetch(url, init).then(async response=>{
    if(legacyTimetable && init?.method === 'POST' && JSON.parse(init.body).includeTrips && response.ok) {
      const result=await response.json(); delete result.trips; delete result.trip; return Response.json(result);
    }
    if(!providerAvailable && String(url).includes('/agency?') && response.ok) {
      const state=await response.json();
      return Response.json({...state,provider:{...state.provider,available:false,model:null}});
    }
    return response;
  });
};
const originalObjectURL=URL.createObjectURL, originalAnchorClick=HTMLAnchorElement.prototype.click;
URL.createObjectURL=blob=>{const url=originalObjectURL(blob);blobs.set(url,blob);return url};
HTMLAnchorElement.prototype.click=function(){if(this.download){downloads.push({name:this.download,blob:blobs.get(this.href)});return}return originalAnchorClick.call(this)};
// App's onBrowseRoute selects the route; only external map browsing increments browseRequest.
const browseRoute = id => {selectedScope={routeId:id};renderWorkspace(activeSnapshot)};
const locate = (routeIds,stopIds) => {selectedScope={routeId:routeIds[0],stopId:stopIds[0]};renderWorkspace(activeSnapshot)};
const clearSelection = () => {selectedScope={};renderWorkspace(activeSnapshot)};
const renderWorkspace = (snapshot = null) => {activeSnapshot=snapshot;root.render(shell(React.createElement(AgencyPanel,{key:renderKey,projectId:'fixture',snapshot,selection:selectedScope,timetable:React.createElement('div',{'data-testid':'stop-patterns'},'Stop patterns'),browseRequest,realtimeRequest:null,realtimeMessage:'',realtimeLoading:false,onConnect:noop,onDisconnect:noop,onLocate:locate,onBrowseRoute:browseRoute,onClearSelection:clearSelection,onResult:noop,onOpenData:noop,mapOpen:false,onToggleMap:noop})))};
// Old prototype selections must recover to the focused workspace.
sessionStorage.setItem('agency-mode-fixture','operations');
renderWorkspace();
const wait = async test => { const end=performance.now()+15000; while(performance.now()<end) { if(test()) return; await new Promise(resolve=>setTimeout(resolve,30)); } throw Error('UI condition timed out: '+test.toString()+'; '+document.body.innerText); };
const button = label => [...document.querySelectorAll('button')].find(item=>item.textContent.trim()===label);
const click = async label => { await wait(()=>button(label) && !button(label).disabled); button(label).click(); };
const fill = (element,value) => { const setter=Object.getOwnPropertyDescriptor(element.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set; setter.call(element,value); element.dispatchEvent(new Event('input',{bubbles:true})); };
const select = (label,value) => {const element=document.querySelector('[aria-label="'+label+'"]');element.value=value;element.dispatchEvent(new Event('change',{bubbles:true}))};
const routes = () => [...document.querySelectorAll('.agency-route-list button .agency-route-label')].map(item=>item.textContent);
const filterButton = label => [...document.querySelectorAll('.agency-route-filters button')].find(item=>item.firstElementChild.textContent===label);
const metric = label => [...document.querySelectorAll('.agency-overview-metrics button')].find(item=>item.firstElementChild.textContent===label);
const check = (condition,message) => {if(!condition)throw Error(message)};
const settle = () => new Promise(resolve=>setTimeout(resolve,50));
const shortcut = (options={}) => document.getElementById('agency-question').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,...options}));
const openTools = () => {if(!document.querySelector('.agency-more').open)document.querySelector('.agency-more summary').click()};
const completeObservation = async () => {holdObservation=false;const pending=pendingObservations.shift();pending.resolve(await originalFetch(pending.url,pending.init))};
window.runTests = async () => {
  await wait(()=>document.getElementById('agency-briefing'));
  check(!document.querySelector('.agency-secondary-section').open && !document.querySelector('.agency-service-events').open,'Network starts with summary and review routes; secondary sections stay collapsed');
  document.querySelector('.agency-secondary-section > summary').click();
  await wait(()=>button('Retry briefing'));
  check(document.querySelector('[aria-label="Update network briefing"]').disabled && document.querySelector('[aria-label="Briefing refresh interval"]').disabled,'A failed initial briefing read cannot start a conflicting assessment or preference write');
  await click('Retry briefing');
  await wait(()=>!button('Retry briefing') && !document.querySelector('[aria-label="Briefing refresh interval"]').disabled);
  check(!document.querySelector('[aria-label="Update network briefing"]').disabled,'Retrying the initial briefing read restores its controls');
  await wait(()=>metric('Routes')?.querySelector('strong').textContent==='4');
  check(metric('Reporting routes').querySelector('strong').textContent==='3','The overview must distinguish current reporting routes from indexed routes');
  check(metric('To review').querySelector('strong').textContent==='2','The overview review count must match reported issues');
  document.querySelector('.agency-priority-route').click();
  await wait(()=>document.getElementById('agency-tab-live').getAttribute('aria-selected')==='true' && document.querySelector('.network-selection h1')?.textContent==='R');
  await wait(()=>document.activeElement===document.querySelector('.network-selection > button'));
  await wait(()=>document.querySelector('.agency-trip-timetable tbody tr'));
  check(!document.querySelector('.network-timetable') && !document.querySelector('.agency-service-events'),'A route opens just its trip timetable, without competing stop lists and updates');
  check(document.querySelector('.agency-trip-timetable select').value==='T1','The initial trip is selected without a vehicle click');
  await click('Stops');
  await wait(()=>document.querySelector('[data-testid="stop-patterns"]'));
  check(!document.querySelector('.agency-trip-timetable') && document.querySelector('[data-testid="stop-patterns"]'),'Stops is a distinct route section');
  await click('Updates');
  await wait(()=>document.querySelector('.agency-service-events'));
  check(!document.querySelector('.network-timetable') && !document.querySelector('.agency-trip-timetable'),'Updates is a distinct route section');
  legacyTimetable=true;
  await click('Trip times');
  await wait(()=>document.querySelector('.agency-trip-timetable [role="alert"]'));
  check(document.querySelector('.agency-trip-timetable [role="alert"]').textContent.includes('Restart the local API server'),'An older route-line API must report the compatibility problem without crashing the workspace');
  await click('Stops');
  await wait(()=>document.querySelector('[data-testid="stop-patterns"]'));
  legacyTimetable=false;
  await click('Trip times');
  await wait(()=>document.querySelector('.agency-trip-timetable tbody tr'));

  document.querySelector('.network-selection button').click();
  await wait(()=>!document.querySelector('.network-selection'));
  await wait(()=>document.activeElement===document.querySelector('[aria-label="Find a route"]'));
  await click('Network');
  await wait(()=>document.querySelectorAll('.agency-event').length===40);
  document.querySelector('.agency-service-events > summary').click();
  document.querySelector('.agency-event').click();
  await wait(()=>document.querySelector('.agency-evidence') && !document.querySelector('.network-selection'));
  await wait(()=>document.activeElement===document.querySelector('.agency-evidence > button'));
  await click('Back to service updates');
  await wait(()=>document.getElementById('agency-briefing') && document.querySelector('.agency-service-events'));
  await wait(()=>document.activeElement===document.querySelector('.agency-service-events > summary'));
  check(document.getElementById('agency-tab-briefing').getAttribute('aria-selected')==='true','Returning from a Network event must restore Network, not the route browser');
  await click('Show all updates');
  await wait(()=>!button('Show all updates') && document.querySelectorAll('.agency-event').length===40);
  const initialEvents=[...document.querySelectorAll('.agency-event strong')].map(item=>item.textContent);
  await click('More updates');
  await wait(()=>document.querySelectorAll('.agency-event').length>40);
  check(initialEvents.every((title,index)=>document.querySelectorAll('.agency-event strong')[index].textContent===title),'Loading more updates must retain the first page');
  holdObservation=true;
  select('Filter event type','service-alert');
  await wait(()=>pendingObservations.length===1);
  await wait(()=>document.querySelectorAll('.agency-event').length===0);
  openTools();
  check(!button('Export report') && !button('Export observations'),'A pending event filter must not export old events under the new filter');
  await completeObservation();
  await wait(()=>document.querySelector('.agency-event-pagination')?.textContent.includes('Showing 40 of 45'));
  check(button('Export report') && button('Export observations'),'Exports return when the displayed filter has completed');
  document.querySelector('.agency-more summary').click();
  check(document.querySelectorAll('.agency-event').length===40,'Changing the event filter resets pagination');
  await click('More updates');
  await wait(()=>document.querySelectorAll('.agency-event').length===45);
  check(!button('More updates'),'The complete alert listing must not offer another empty page');
  select('Filter event type','all');
  await wait(()=>document.querySelectorAll('.agency-event').length===40);
  document.querySelector('.agency-scroll').scrollTop=document.querySelector('.agency-scroll').scrollHeight;
  openTools();
  button('Feed settings').focus();
  button('Feed settings').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  check(!document.querySelector('.agency-more').open && document.activeElement===document.querySelector('.agency-more summary'),'Escape closes Network tools and returns focus to its disclosure');
  openTools();
  await click('Feed settings');
  await wait(()=>document.querySelector('.agency-connect'));
  await settle();
  const feedSettings=document.querySelector('.agency-connect').getBoundingClientRect();
  check(feedSettings.top>=document.querySelector('.agency-navigation').getBoundingClientRect().bottom && feedSettings.top<innerHeight,'Feed settings must open within view from a scrolled service list');
  check(document.activeElement===document.querySelector('[aria-label="Close feed settings"]'),'Opening feed settings must move keyboard focus into the revealed content');
  document.querySelector('[aria-label="Close feed settings"]').click();
  const snapshot = {...${JSON.stringify(snapshot)}, counts: {vehicles: ${snapshot.vehicles.length}, tripUpdates: ${snapshot.tripUpdates.length}, alerts: ${snapshot.alerts.length}}};
  const previousReads = observationReads;
  renderWorkspace(snapshot);
  await wait(()=>observationReads > previousReads);
  const connectedReads = observationReads;
  for(let i=0;i<5;i++) { renderWorkspace({...snapshot,fetchedAt:new Date(Date.now()+i*1000).toISOString()}); await new Promise(resolve=>setTimeout(resolve,30)); }
  if(observationReads !== connectedReads) throw Error('Map feed updates must not start duplicate dashboard assessments');

  metric('Reporting routes').click();
  await wait(()=>document.querySelector('.agency-route-browser') && filterButton('Reporting')?.getAttribute('aria-pressed')==='true');
  await wait(()=>document.activeElement===document.querySelector('[aria-label="Find a route"]'));
  check(routes().join(',')==='2,10,R','Reporting routes must exclude unreported service and use numeric route order');
  await click('Network');
  await wait(()=>metric('To review'));
  metric('To review').click();
  await wait(()=>filterButton('Needs attention')?.getAttribute('aria-pressed')==='true');
  check(routes().join(',')==='R,10','Network review action must open the scoped review list');
  await click('Network');
  await wait(()=>metric('Routes'));
  metric('Routes').click();
  await wait(()=>document.querySelector('.agency-route-browser'));
  check(routes().join(',')==='2,7,10,R','All routes action must restore the complete route list');
  select('Sort routes','delay');
  await wait(()=>routes().join(',')==='R,10,2,7');
  filterButton('Reporting').click();
  await wait(()=>routes().join(',')==='R,10,2');
  fill(document.querySelector('[aria-label="Find a route"]'),'airport express');
  await wait(()=>routes().join(',')==='10');
  if(document.querySelectorAll('[role=tab]').length!==3) throw Error('Keep only three primary views');
  fill(document.querySelector('[aria-label="Find a route"]'),'no such route');
  await wait(()=>document.querySelector('.agency-route-browser').textContent.includes('No routes match'));
  await click('Reset filters');
  await wait(()=>routes().join(',')==='2,7,10,R');
  check(filterButton('All routes').getAttribute('aria-pressed')==='true' && document.querySelector('[aria-label="Sort routes"]').value==='name','Reset filters must recover the full default route view');
  check(document.activeElement===document.querySelector('[aria-label="Find a route"]'),'Reset filters returns keyboard focus to route search');
  fill(document.querySelector('[aria-label="Find a route"]'),'Harbor');
  await wait(()=>routes().join(',')==='2');
  document.querySelector('[aria-label="Clear route search"]').click();
  await wait(()=>routes().length===4);
  openTools();
  await click('Export report');
  await wait(()=>downloads.length===1);
  const networkReport=await downloads[0].blob.text();
  check(downloads[0].name.endsWith('.md') && networkReport.includes('Synthetic City X') && networkReport.includes('Route selection: All routes'),'Markdown export must retain the actual City and network scope');
  check(networkReport.includes('GTFS service date: 2026-09-13') && networkReport.includes('https://example.org/alerts.pb') && networkReport.includes('Predicted departure spacing is not measured vehicle passage'),'The report must retain service dates, source evidence and prediction limits');
  openTools();
  await click('Export observations');
  await wait(()=>downloads.length===2);
  const exportedObservation=JSON.parse(await downloads[1].blob.text());
  check(exportedObservation.routes.length===4 && exportedObservation.filteredEventCount>40,'Raw observation export retains the full response beyond the displayed page');
  holdObservation=true;
  [...document.querySelectorAll('.agency-route-list button')].find(item=>item.querySelector('.agency-route-label').textContent==='10').click();
  await wait(()=>pendingObservations.length===1 && document.querySelector('.network-selection'));
  openTools();
  check(!button('Export report') && !button('Export observations'),'A pending route selection must not export the old network scope');
  await completeObservation();
  await wait(()=>button('Export report') && document.querySelector('.network-selection h1').textContent==='10');
  await click('Export report');
  await wait(()=>downloads.length===3);
  check((await downloads[2].blob.text()).includes('Route selection: 10 (R10)'),'A route report must retain the completed exact route identity');
  document.querySelector('.network-selection button').click();
  await wait(()=>!document.querySelector('.network-selection') && routes().length===4);
  document.getElementById('agency-tab-live').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));
  await wait(()=>document.getElementById('agency-tab-ask').getAttribute('aria-selected')==='true');
  await wait(()=>document.querySelector('.agency-conversation-toolbar'));
  check(document.querySelector('#agency-ask h1')?.textContent==='Ask','Ask keeps a single clear page heading ahead of settings');
  fill(document.getElementById('agency-question'),'Check River service.');
  await settle();
  shortcut({isComposing:true});
  await settle();
  check(pendingQuestions.length===0,'An IME composition must not submit the question');
  shortcut();shortcut();
  await wait(()=>pendingQuestions.length===1 && button('Stop'));
  shortcut();
  await settle();
  check(pendingQuestions.length===1,'Keyboard shortcuts must not duplicate a pending investigation');
  pendingQuestions[0].reject(Error('Fixture investigation unavailable'));
  await wait(()=>document.querySelector('.agency-question-form button[type="submit"]') && !document.querySelector('.agency-question-form button[type="submit"]').disabled);
  check(document.getElementById('agency-question').value==='Check River service.','A failed question must be restored for retry');
  shortcut();
  await wait(()=>pendingQuestions.length===2 && button('Stop'));
  fill(document.getElementById('agency-question'),'Keep this new question.');
  await settle();
  pendingQuestions[1].reject(Error('Fixture retry unavailable'));
  await wait(()=>document.querySelector('.agency-question-form button[type="submit"]') && !document.querySelector('.agency-question-form button[type="submit"]').disabled);
  check(document.getElementById('agency-question').value==='Keep this new question.','A failed earlier request cannot overwrite a newly typed draft');
  await click('Routes');
  await wait(()=>document.getElementById('agency-live'));
  check(!document.querySelector('.agency-scroll > .agency-error'),'An Ask failure must not appear as a Routes page error');
  document.getElementById('agency-tab-ask').click();
  await wait(()=>document.getElementById('agency-question'));
  check(document.getElementById('agency-question').value==='Keep this new question.','Page navigation preserves the Ask draft');
  fill(document.getElementById('agency-question'),'');
  failNextObservation=true;
  openTools();
  await click('Refresh observations');
  await wait(()=>button('Retry refresh'));
  check(document.querySelector('.agency-scroll > .agency-error strong').textContent==='Could not refresh observations' && document.querySelector('.agency-scroll > .agency-error p').textContent==='Fixture observation offline','Refresh errors must show their own message even when a prior Ask failed');
  await click('Retry refresh');
  await wait(()=>!button('Retry refresh'));
  providerAvailable=false;
  openTools();
  await click('Refresh observations');
  await wait(()=>document.querySelector('.agency-question-form button[type="submit"]')?.textContent.includes('Connect AI'));
  const setupButton=document.querySelector('.agency-question-form button[type="submit"]');
  check(!setupButton.disabled,'An unconfigured model must offer setup even with an empty question');
  fill(document.getElementById('agency-question'),'Keep my setup question.');
  await settle();
  setupButton.click();
  await wait(()=>document.getElementById('agency-ai-settings'));
  check(document.getElementById('agency-question').value==='Keep my setup question.' && pendingQuestions.length===2,'Opening model setup preserves the question and does not submit it');
  await wait(()=>document.activeElement===document.querySelector('#agency-ai-settings input[type="url"]'));
  document.querySelector('.agency-provider-toggle').click();
  providerAvailable=true;
  openTools();
  await click('Refresh observations');
  await wait(()=>document.querySelector('.agency-question-form button[type="submit"]')?.textContent.trim()==='Ask');
  fill(document.getElementById('agency-question'),'');
  document.querySelector('.agency-more summary').click();
  if(button('Research') || button('Service desk')) throw Error('Prototype navigation must stay outside the daily workspace');
  await click('Feed settings');
  await wait(()=>document.querySelector('.agency-connect'));
  document.querySelector('[aria-label="Close feed settings"]').click();
  await click('Routes');
  await wait(()=>document.querySelector('.agency-route-browser'));
  return {snapshotRefreshIsolation:true,focusedWorkspace:true,legacyModeRecovery:true,keyboardTabs:true,overviewFilters:true,priorityRouteNavigation:true,eventReturnNavigation:true,routeSearchSortReset:true,eventPagination:true,pendingFilterTruth:true,scopedExports:true,questionRetry:true,questionDraftPreserved:true,imeAndBusyGuard:true,modelSetupPreservesDraft:true,feedSettingsFocus:true,disclosureEscape:true,observationRetry:true,briefingReadRetry:true};
};
window.visualCheck = async theme => {
  appearance=theme;selectedScope={};renderKey++;sessionStorage.setItem('agency-mode-fixture','briefing');renderWorkspace(activeSnapshot);
  await wait(()=>document.getElementById('agency-briefing') && metric('Routes')?.querySelector('strong').textContent==='4' && !document.querySelector('[aria-label="Briefing refresh interval"]').disabled);
  await settle();
  const panel=document.querySelector('.agency-panel');
  check(![panel,document.querySelector('.agency-scroll'),document.querySelector('.agency-tabs')].some(item=>item.scrollWidth>item.clientWidth+2),'The '+theme+' theme must fit the viewport at '+innerWidth);
  return {theme,width:innerWidth,background:getComputedStyle(document.querySelector('.app-shell')).backgroundColor,text:getComputedStyle(document.querySelector('.agency-page-heading h1')).color,overflow:false};
};
window.pageCheck = async id => {
  selectedScope={};renderWorkspace(activeSnapshot);
  document.getElementById('agency-tab-'+id).click();
  await wait(()=>document.getElementById('agency-'+id));
  if(id==='live') await wait(()=>routes().length===4);
  await settle();
};
window.routeCheck = async () => {
  await window.pageCheck('live');
  [...document.querySelectorAll('.agency-route-list button')].find(item=>item.querySelector('.agency-route-label').textContent==='R').click();
  await wait(()=>document.querySelector('.agency-trip-timetable tbody tr'));
  const content=document.querySelector('.agency-scroll');
  check(content.scrollWidth<=content.clientWidth+2,'Route timetable controls must fit the panel');
  const chooser=document.querySelector('.agency-trip-timetable select');
  chooser.value='T2';chooser.dispatchEvent(new Event('change',{bubbles:true}));
  await wait(()=>document.querySelector('.agency-trip-timetable select').value==='T2' && document.querySelector('.agency-trip-timetable tbody tr'));
  await wait(()=>document.querySelector('.agency-trip-timetable tbody')?.textContent.includes('12:28'));
  check(document.querySelector('.agency-trip-timetable select').value==='T2','Changing the trip updates its predictions');
};
window.layoutCheck = async () => {
  const panel=document.querySelector('.agency-panel'); panel.style.height=innerHeight<=400?'176px':'100vh';
  const overflow=[...document.querySelectorAll('.agency-panel,.agency-scroll,.agency-tabs')].filter(item=>item.scrollWidth>item.clientWidth+2).map(item=>item.className);
  if(overflow.length) throw Error('Horizontal overflow at '+innerWidth+': '+overflow.join(', ')+'; '+JSON.stringify([...document.querySelector('.agency-panel').children].map(item=>[item.className,item.clientWidth,item.scrollWidth])));
  const views=[];
  for(const id of ['briefing','live','ask']) {
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
const server = await createServer({ root, cacheDir: path.join(directory, 'vite-cache'), configFile: false, plugins: [react(), {
  name: 'network-workspace-fixture',
  configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
    try {
      if (req.url === '/network-workspace-fixture.html') { res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml(req.url, '<div id="root"></div><script type="module" src="/network-workspace-fixture.js"></script>')); return }
      if (req.url === '/network-workspace-fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end((await vite.transformRequest('virtual:network-workspace-fixture')).code); return }
      if (req.url?.startsWith('/api/projects/fixture/agency')) {
        let text = ''; for await (const chunk of req) text += chunk
        const result = req.method === 'GET' ? await service.state('fixture', Object.fromEntries(new URL(req.url, 'http://fixture').searchParams)) : await service.handle('fixture', JSON.parse(text))
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
  result.themes=[];
  for(const theme of ['light','dark']) for(const width of [1280,320]) {window.setContentSize(width,1000);await new Promise(resolve=>setTimeout(resolve,100));result.themes.push(await window.webContents.executeJavaScript('window.visualCheck('+JSON.stringify(theme)+')'));fs.writeFileSync(${JSON.stringify(directory)}+'/network-overview-'+theme+'-'+width+'.png',(await window.webContents.capturePage()).toPNG())}
  for(const width of [480,320]) {
    window.setContentSize(width,1000);
    for(const id of ['briefing','live','ask']) { await window.webContents.executeJavaScript('window.pageCheck('+JSON.stringify(id)+')'); fs.writeFileSync(${JSON.stringify(directory)}+'/page-'+id+'-'+width+'.png',(await window.webContents.capturePage()).toPNG()); }
    await window.webContents.executeJavaScript('window.routeCheck()'); fs.writeFileSync(${JSON.stringify(directory)}+'/route-trips-'+width+'.png',(await window.webContents.capturePage()).toPNG());
  }
  if(result.themes[0].background===result.themes[2].background) throw Error('Light and dark screenshot fixtures must use distinct actual theme variants');
  console.log(JSON.stringify({passed:true,...result,screenshots:${JSON.stringify(directory)}})); app.exit(0);
}catch(error){console.error(error);app.exit(1)}});`)
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronPath, [...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []), main], { env, stdio: 'inherit' })
  const timeout = setTimeout(() => child.kill(), 90_000)
  try { const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }); if (code !== 0) throw new Error(`Network workspace fixture exited ${code}`) }
  finally { clearTimeout(timeout) }
} finally { await server.close(); service.close() }
