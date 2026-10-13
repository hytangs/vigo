import { createViteTestServer as createServer } from './helpers/vite-test-server.mjs'
import react from '@vitejs/plugin-react'
import electron from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
await fs.mkdir(path.join(root, 'temp'), { recursive: true })
const directory = await fs.mkdtemp(path.join(root, 'temp', 'result-saving-'))
const server = await createServer({ root, cacheDir: path.join(directory, 'cache'), configFile: false, plugins: [react(), {
  name: 'result-saving',
  configureServer(server) { server.middlewares.use(async (request, response, next) => {
    if (request.url !== '/result-saving.html') return next()
    response.setHeader('Content-Type', 'text/html')
    response.end(await server.transformIndexHtml(request.url, '<meta name="viewport" content="width=device-width,initial-scale=1"><style>*,*::before,*::after{transition:none!important;animation:none!important}</style><div id="root"></div><script type="module" src="/test/fixtures/result-saving.tsx"></script>'))
  }) },
}], server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const main = path.join(directory, 'main.cjs')
await fs.writeFile(main, `
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const Papa=require(${JSON.stringify(path.join(root, 'node_modules/papaparse'))});
const {layoutFrame,resizeLayout}=require(${JSON.stringify(path.join(root, 'test/helpers/layout-frame.cjs'))});
app.disableHardwareAcceleration();app.setPath('userData',${JSON.stringify(path.join(directory, 'profile'))});
app.whenReady().then(async()=>{try{
  const w=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}});
  const run=script=>w.webContents.executeJavaScript(script,true);
  await w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/result-saving.html`)});
  w.webContents.debugger.attach('1.3');
  await run('new Promise((resolve,reject)=>{const t=setInterval(()=>{if(window.checkResultState){clearInterval(t);resolve()}},20);setTimeout(()=>reject(Error("Fixture timeout")),15000)})');
  console.log(await run('window.checkResultState()'));
  let downloaded=0;
  async function save(label,format){
    // Chromium limits download bursts. Exercise individual pointer gestures at a human pace.
    await new Promise(resolve=>setTimeout(resolve,250));
    const saved=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Download timeout: '+label+' '+format)),10000);
      w.webContents.session.once('will-download',(_event,item)=>{
        const name=item.getFilename();assert(!/[\\/]/.test(name));assert(name.startsWith('vigo-'));
        const destination=path.join(${JSON.stringify(directory)},name);item.setSavePath(destination);
        item.once('done',(_event,state)=>{clearTimeout(timer);if(state!=='completed')return reject(Error('Download '+state));downloaded++;resolve({name,text:fs.readFileSync(destination,'utf8')});});
      });
    });
    const point=await run('window.prepareSave('+JSON.stringify(label)+','+JSON.stringify(format)+')');
    for(const type of ['mousePressed','mouseReleased'])await w.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});
    await run('new Promise(resolve=>requestAnimationFrame(resolve))');
    const feedback=await run('window.downloadFeedback('+JSON.stringify(label)+')');
    assert(feedback.startsWith('Download started:'));return saved;
  }
  await run('window.showResult("journey")');
  const expected=await run('window.expectedPlan');
  const selected=JSON.parse((await save('Save journey','json')).text);assert.deepEqual(selected.plan,expected);
  assert.equal(selected.summary.totalElapsedMinutes,30.125);assert.equal(selected.summary.initialWaitMinutes,10.5);
  const markdown=(await save('Save journey','md')).text;assert(markdown.includes('24:10:30'));assert(markdown.includes('Harvard station'));
  const routeMap=JSON.parse((await save('Save journey','geojson')).text);assert.deepEqual(routeMap.features[0].geometry.coordinates,expected.legs[0].coordinates);
  const legs=Papa.parse((await save('Save journey','csv')).text,{header:true,skipEmptyLines:true});assert.deepEqual(legs.errors,[]);assert.equal(legs.data[0].to,expected.legs[0].toName);
  const options=JSON.parse((await save('Save all 7 journeys','json')).text);assert.equal(options.plans.length,7);assert.equal(options.selectedJourneyId,expected.id);
  const optionRows=Papa.parse((await save('Save all 7 journeys','csv')).text,{header:true,skipEmptyLines:true}).data;assert.equal(optionRows.length,7);assert.equal(optionRows[0].selected,'true');
  await run('window.showResult("reach")');
  const reachJson=JSON.parse((await save('Save Reach results','json')).text);assert.equal(reachJson.selectedCutoffMinutes,15);assert.equal(reachJson.selectedSummary[1].fasterOrNewlyReachedCells,1);assert.equal(reachJson.selectedSummary[1].differenceFromBaseline.areaKm2,2.5);
  const reachRows=Papa.parse((await save('Save Reach results','csv')).text,{header:true,skipEmptyLines:true}).data;assert.equal(reachRows[1].cutoff_minutes,'15');assert.equal(reachRows[1].faster_or_newly_reached_cells,'1');assert.equal(reachRows[1].total_processing_ms,'31.25');
  const reachMap=JSON.parse((await save('Save Reach results','geojson')).text);assert.equal(reachMap.features.length,2);assert(reachMap.features.every(f=>f.properties.cutoffMinutes===15));
  await run('window.checkDownloadFeedback("Save Reach results");window.checkFeedbackReset()');
  const laterRows=Papa.parse((await save('Save Reach results','csv')).text,{header:true,skipEmptyLines:true}).data;assert.equal(laterRows[1].cutoff_minutes,'30');assert.equal(laterRows[1].slower_or_lost_cells,'2');assert.equal(laterRows[1].area_delta_km2,'-1.5');
  await run('window.showResult("city")');
  const cityJson=JSON.parse((await save('Save City comparison','json')).text);assert.equal(cityJson.referenceFeedId,'reference');assert.equal(cityJson.selectedSummary[1].differenceFromReference.areaKm2,2.5);
  const cityRows=Papa.parse((await save('Save City comparison','csv')).text,{header:true,skipEmptyLines:true}).data;assert.equal(cityRows.length,2);assert.equal(cityRows[1].area_delta_km2,'2.5');assert.equal(cityRows[1].transit_stop_delta,'2');
  const cityMap=JSON.parse((await save('Save City comparison','geojson')).text);assert.equal(cityMap.features.length,2);assert(cityMap.features.every(f=>f.properties.surface==='baseline'));
  const layouts=[];
  for(const width of [320,390,1280]){
    await resizeLayout(w,width,900);
    for(const mode of ['journey','reach','city'])for(const dark of [false,true]){
      layouts.push(await run('window.checkResultLayout('+JSON.stringify(mode)+','+dark+')'));
      fs.writeFileSync(path.join(${JSON.stringify(directory)},width+'-'+mode+'-'+(dark?'dark':'light')+'.png'),(await layoutFrame(w)).toPNG());
    }
    if(width<760){const mobileRows=Papa.parse((await save('Save City comparison','csv')).text,{header:true,skipEmptyLines:true}).data;assert.equal(mobileRows[1].area_delta_km2,'2.5');}
  }
  fs.writeFileSync(path.join(${JSON.stringify(directory)},'verification.json'),JSON.stringify({downloaded,layouts},null,2));
  console.log(JSON.stringify({passed:true,downloaded,layouts,directory:${JSON.stringify(directory)}}));app.exit(0);
}catch(error){console.error(error);app.exit(1)}});
`)
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []), main], { env, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill(), 90_000)
  try { const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }); if (code !== 0) throw Error(`Result saving runtime check failed (${code})`) }
  finally { clearTimeout(timer) }
} finally { await server.close(); await Promise.all(['cache', 'profile'].map(name => fs.rm(path.join(directory, name), { recursive: true, force: true }))) }
