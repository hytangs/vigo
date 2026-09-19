import assert from 'node:assert/strict'
import { createViteTestServer as createServer } from './helpers/vite-test-server.mjs'
import electronPath from 'electron'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const root = path.resolve(import.meta.dirname, '..')
const directory = await mkdtemp(path.join(tmpdir(), 'vigo-analysis-origin-'))
const stops = Array.from({ length: 45 }, (_, index) => ({ id: `stop-${index}`, name: `Library ${index}`, lat: 42.360123456 + index / 1000, lon: -71.058987654, x: 200, y: 300, routes: [], tripCount: 0, transferScore: 0 }))
stops.push({ id: 'missing', name: 'No geographic coordinates', x: 0, y: 0, routes: [], tripCount: 0, transferScore: 0 })
const harness = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {AnalysisOriginPicker} from '/src/components/AnalysisOriginPicker.tsx';
import '/src/App.css';
import '/src/index.css';
const stops=${JSON.stringify(stops)};
const root=createRoot(document.getElementById('root'));
window.selected=[]; window.analysisRuns=0; window.disabled=false;
window.scenario={id:'protected-case',interventions:[{id:'existing-change',name:'Keep this change'}]};
function Harness(){ const [origin,setOrigin]=React.useState(null); return React.createElement('form',{onSubmit:event=>{event.preventDefault();window.analysisRuns++}},React.createElement(AnalysisOriginPicker,{origin,stops,disabled:window.disabled,onSetOrigin:point=>{window.selected.push(point);setOrigin(point)}}),React.createElement('button',{type:'submit',id:'run-analysis'},'Run analysis')); }
window.mount=()=>root.render(React.createElement(Harness)); window.mount();
window.fill=(selector,value)=>{const input=document.querySelector(selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));};
`
const server = await createServer({ root, configFile: false, cacheDir: path.join(directory, 'vite-cache'), plugins: [{
  name: 'analysis-origin-test',
  configureServer(server) { server.middlewares.use((request, response, next) => {
    if (request.url === '/origin-test.html') { response.setHeader('Content-Type', 'text/html'); response.end('<meta name="viewport" content="width=device-width, initial-scale=1"><main style="width:100%;max-width:400px;padding:12px;box-sizing:border-box" id="root"></main><script type="module" src="/origin-test.js"></script>') }
    else if (request.url === '/origin-test.js') { response.setHeader('Content-Type', 'text/javascript'); server.transformRequest('virtual:origin-test').then(result => response.end(result.code)).catch(next) }
    else next()
  }) },
  resolveId(id) { if (id === 'virtual:origin-test') return id },
  load(id) { if (id === 'virtual:origin-test') return harness },
}], server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client'] } })
try {
  await server.listen()
  const { analysisStopOrigin, analysisStopDisplayId, searchAnalysisStops, analysisCoordinateOrigin, AnalysisOriginPicker } = await server.ssrLoadModule('/src/components/AnalysisOriginPicker.tsx')
  assert.equal(analysisStopDisplayId('feed_6413c37eef::65471'), '65471')
  assert.equal(analysisStopDisplayId('feed_6413c37eef\u001f65471'), '65471')
  assert.equal(analysisStopDisplayId('feed_6413c37eef::station::platform'), 'station::platform', 'Only the City namespace is removed')
  for (const id of ['station::65471', 'north\u001fplatform', 'feed_custom::65471', 'feed_6413c37eef0::65471', 'feed_6413c37eef::']) assert.equal(analysisStopDisplayId(id), id, 'Unrecognized prefixes and original GTFS separators stay intact')
  const scopedStop = { ...stops[0], id: 'feed_6413c37eef::65471' }
  assert.equal(searchAnalysisStops([scopedStop], scopedStop.id)[0].id, scopedStop.id, 'Full internal identity remains searchable')
  assert.equal(analysisStopOrigin(scopedStop).stopId, scopedStop.id, 'Display formatting never alters routing identity')
  assert.deepEqual(analysisStopOrigin(stops[0]), { label: stops[0].name, coordinate: [stops[0].lon, stops[0].lat], source: 'stop', stopId: stops[0].id }, 'Imported stop selection preserves exact identity and coordinate precision')
  assert.equal(analysisStopOrigin(stops.at(-1)), null, 'Projected x/y values are not geographic coordinates')
  assert.equal(searchAnalysisStops(stops, '').length, 45)
  assert.deepEqual(searchAnalysisStops(stops, 'LIBRARY stop-44').map(stop => stop.id), ['stop-44'], 'Search matches names and exact imported ID tokens without geocoding')
  assert.deepEqual(analysisCoordinateOrigin('0', '0').point.coordinate, [0, 0])
  assert.deepEqual(analysisCoordinateOrigin('42.360123456', '-71.058987654').point.coordinate, [-71.058987654, 42.360123456])
  assert.deepEqual(analysisCoordinateOrigin('-90', '180').point.coordinate, [180, -90])
  for (const pair of [['', ''], [' ', '0'], ['91', '0'], ['0', '181'], ['Infinity', '0'], ['0', 'NaN']]) assert.ok(analysisCoordinateOrigin(...pair).error, `Reject invalid coordinates ${pair}`)
  const markup = renderToStaticMarkup(createElement(AnalysisOriginPicker, { stops, origin: null, onSetOrigin: () => {} }))
  assert.match(markup, /aria-expanded="false"/)
  assert.match(markup, /Choose origin/)
  await writeFile(path.join(directory, 'main.cjs'), `const { app, BrowserWindow }=require('electron');
const assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(path.join(directory, 'profile'))});
app.whenReady().then(async()=>{try{
 const window=new BrowserWindow({show:true,width:390,height:800,webPreferences:{backgroundThrottling:false,nodeIntegration:false,contextIsolation:true,sandbox:true}});
 const evaluate=code=>window.webContents.executeJavaScript(code);
 const wait=async(code)=>{for(let i=0;i<100;i++){if(await evaluate(code))return;await new Promise(resolve=>setTimeout(resolve,30));}throw Error('Condition timed out: '+code+'; '+await evaluate('document.body.innerText'))};
 const key=async(keyCode)=>{window.webContents.focus();window.webContents.sendInputEvent({type:'keyDown',keyCode});if(keyCode==='Enter')window.webContents.sendInputEvent({type:'char',keyCode:'\\r'});window.webContents.sendInputEvent({type:'keyUp',keyCode});};
 await window.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/origin-test.html`)});
 window.focus();
 await wait("!!document.querySelector('.analysis-origin-toggle')");
 await evaluate("document.querySelector('.analysis-origin-toggle').focus()"); await key('Enter');
 await wait("document.activeElement === document.querySelector('input[type=search]')");
 assert.equal(await evaluate("document.querySelectorAll('.analysis-origin-results li').length"),20);
 assert.equal(await evaluate("getComputedStyle(document.querySelector('.analysis-origin-search input')).fontSize"),'13px','Primary origin input uses readable body size');
 assert.equal(await evaluate("getComputedStyle(document.querySelector('.analysis-origin-results strong')).fontSize"),'13px','Stop choices use readable primary labels');
 assert.equal(await evaluate("document.querySelector('.analysis-origin-coordinate-disclosure').open"),false,'Coordinate details start folded to keep stop selection concise');
 assert.match(await evaluate("document.querySelector('.analysis-origin-count').textContent"),/20 of 45/);
 await evaluate("window.fill('input[type=search]','stop-44')");
 await wait("document.querySelectorAll('.analysis-origin-results li').length===1");
 await key('Enter'); assert.equal(await evaluate('window.analysisRuns'),0,'Search must not accidentally submit analysis');
 await key('Tab');
 await wait("document.activeElement.matches('.analysis-origin-results button')");
 assert.equal(await evaluate("document.activeElement.matches('.analysis-origin-results button')"),true,'Result choices are reachable by native Tab');
 await key('Enter'); await wait('window.selected.length===1');
 assert.equal(await evaluate("window.selected[0].stopId"),'stop-44');
 assert.equal(await evaluate("window.selected[0].coordinate[0]"),${stops[44].lon});
 assert.equal(await evaluate("document.activeElement.matches('.analysis-origin-toggle')"),true,'Selection returns focus to its disclosure');
 await key('Enter'); await wait("!!document.querySelector('.analysis-origin-coordinates')");
 await evaluate("document.querySelector('.analysis-origin-coordinate-disclosure > summary').focus()");await key('Enter');
 await wait("document.querySelector('.analysis-origin-coordinate-disclosure').open");
 await evaluate("window.fill('input[min=\\\"-90\\\"]','91');window.fill('input[min=\\\"-180\\\"]','-71')");
 await evaluate("document.querySelector('.analysis-origin-confirm').focus()");await key('Enter');
 await wait("!!document.querySelector('.analysis-origin-error')");
 assert.equal(await evaluate('window.selected.length'),1,'Invalid numeric origin must not be emitted');
 assert.equal(await evaluate("document.activeElement.getAttribute('aria-invalid')"),'true');
 await evaluate("window.fill('input[min=\\\"-90\\\"]','0');window.fill('input[min=\\\"-180\\\"]','0');document.querySelector('input[min=\\\"-180\\\"]').focus()");
 await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,isComposing:true}))");
 assert.equal(await evaluate('window.selected.length'),1,'IME confirmation must not select an origin');
 await key('Enter');await wait('window.selected.length===2');
 assert.deepEqual(await evaluate('window.selected[1].coordinate'),[0,0]);
 assert.equal(await evaluate('window.selected[1].source'),'map');
 assert.equal(await evaluate('window.analysisRuns'),0,'Coordinate Enter must set an origin without running analysis');
 assert.equal(await evaluate('window.scenario.interventions[0].id'),'existing-change','Origin selection leaves scenario ownership with the parent');
 await key('Enter');await wait("!!document.querySelector('.analysis-origin-panel')");
 await evaluate("window.fill('input[type=search]','')");await wait("document.querySelectorAll('.analysis-origin-results li').length===20");
 await evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent.startsWith('Show more stops')).click()");
 await wait("document.querySelectorAll('.analysis-origin-results li').length===40");
 for(const width of [320,390]){window.setSize(width,800);await new Promise(resolve=>setTimeout(resolve,50));assert.equal(await evaluate("document.querySelector('.analysis-origin-picker').scrollWidth <= document.querySelector('.analysis-origin-picker').clientWidth+1"),true,'No picker overflow at '+width);}
 await key('Escape');await wait("!document.querySelector('.analysis-origin-panel')");
 await evaluate('window.disabled=true;window.mount()');await wait("document.querySelector('.analysis-origin-toggle').disabled");
 assert.equal(await evaluate("document.querySelectorAll('form').length"),1,'Picker never nests a form inside Reach');
 console.log('Analysis origin: precise stop identity, coordinate validation, keyboard selection, focus recovery, pagination, disabled state and 320/390px layout passed.');app.exit(0);
}catch(error){console.error(error);app.exit(1)}});`)
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(electronPath, [...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []), path.join(directory, 'main.cjs')], { stdio: 'inherit', env: environment })
  const timeout = setTimeout(() => child.kill(), 60_000)
  try {
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code ?? 1)) })
    assert.equal(code, 0, 'Origin picker browser checks failed')
  } finally { clearTimeout(timeout) }
} finally {
  await server.close()
  await rm(directory, { recursive: true, force: true })
}
