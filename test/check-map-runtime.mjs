import assert from 'node:assert/strict'
import { build } from 'vite'
import electronPath from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
await fs.mkdir(path.join(root, 'temp'), { recursive: true })
const temporary = await fs.mkdtemp(path.join(root, 'temp', 'map-runtime-'))
let softwareLoader = null
try {
  await fs.writeFile(path.join(temporary, 'index.html'), '<div id="map" style="width:512px;height:512px"></div><script type="module" src="/fixture.mjs"></script>')
  await fs.writeFile(path.join(temporary, 'fixture.mjs'), `
import { Map, AttributionControl } from '../../src/app/mapRuntime.ts';
import 'maplibre-gl/dist/maplibre-gl.css';
import { ensureVehicleDirectionSprite, vehicleHeadingLayer, vehicleMarkerLayer } from '../../src/app/mapDirections.ts';
window.checkMap = async () => {
  window.attributionExecuted = false;
  const data = {type:'FeatureCollection',features:[{type:'Feature',properties:{selectedPattern:true},geometry:{type:'LineString',coordinates:[[-0.001,0],[0.001,0]]}}]};
  const map = new Map({container:'map',center:[0,0],zoom:16,attributionControl:false,
    style:{version:8,sources:{fixture:{type:'geojson',data,
      attribution:'<details open onload="void 0" ontoggle="window.attributionExecuted = true">Fixture</details>'}},
      layers:[{id:'fixture',source:'fixture',type:'line',paint:{'line-width':8,'line-color':'#007f76'}}]}});
  map.addControl(new AttributionControl({compact:false}));
  const waitForRender = () => new Promise((resolve,reject) => {
    const timer=setTimeout(()=>reject(Error('Map did not render')),30000);
    map.once('idle',()=>{clearTimeout(timer);resolve();});
  });
  await waitForRender();
  if (!map.queryRenderedFeatures({layers:['fixture']}).length) throw Error('GeoJSON worker did not render the fixture');
  ensureVehicleDirectionSprite(map);
  map.addSource('vigo-service-vehicles',{type:'geojson',data:{type:'FeatureCollection',features:[
    {type:'Feature',properties:{hasBearing:true,bearing:90,selectedRoute:false,routeColor:'#ffc72c'},geometry:{type:'Point',coordinates:[0,0]}},
    {type:'Feature',properties:{hasBearing:false,bearing:0,selectedRoute:false,routeColor:'#da291c'},geometry:{type:'Point',coordinates:[0,0.0005]}}
  ]}});
  map.addLayer(vehicleMarkerLayer);
  map.addLayer(vehicleHeadingLayer);
  await waitForRender();
  if (map.queryRenderedFeatures({layers:['vigo-vehicle-headings']}).length !== 1) throw Error('Network vehicles need a heading only when the bearing is known');
  if (map.queryRenderedFeatures({layers:['vigo-vehicles']}).length !== 2) throw Error('Colored discs must remain visible with and without a heading');
  map.setBearing(90);
  await waitForRender();
  if (map.getLayoutProperty('vigo-vehicle-headings','icon-rotation-alignment') !== 'map') throw Error('Vehicle compass bearings must rotate with the map');
  const next = waitForRender();
  map.getSource('fixture').setData({...data,features:[{...data.features[0],geometry:{type:'LineString',coordinates:[[0,-0.001],[0,0.001]]}}]});
  await next;
  if (!map.queryRenderedFeatures({layers:['fixture']}).length) throw Error('GeoJSON source update did not render');
  const details = document.querySelector('.maplibregl-ctrl-attrib details');
  if (!details || details.hasAttribute('onload') || details.hasAttribute('ontoggle') || window.attributionExecuted) throw Error('Unsafe attribution survived sanitization');
  map.remove();
  return {rendered:true,sourceUpdate:true,sanitizedAttribution:true,offlineDirections:true,networkHeadings:true,mapRotation:true};
};
`)
  await build({ configFile: false, root: temporary, publicDir: false, logLevel: 'warn', build: { chunkSizeWarningLimit: 1500 } })
  const dist = path.join(temporary, 'dist')
  await fs.writeFile(path.join(temporary, 'main.cjs'), `
const {app,BrowserWindow,protocol,net} = require('electron');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
app.setPath('userData', ${JSON.stringify(path.join(temporary, 'profile'))});
protocol.registerSchemesAsPrivileged([{scheme:'vigo',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
app.whenReady().then(async()=>{
 try {
  protocol.handle('vigo', request=>net.fetch(pathToFileURL(path.join(${JSON.stringify(dist)},new URL(request.url).pathname === '/' ? 'index.html' : decodeURIComponent(new URL(request.url).pathname))).href));
  const window=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}});
  window.webContents.on('console-message', event => console.log(event.message));
  await window.loadURL('vigo://studio/');
  console.log(JSON.stringify(await window.webContents.executeJavaScript('window.checkMap()')));
  app.exit(0);
 } catch(error) {console.error(error);app.exit(1);}
});`)
  const ciFlags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
  // Apple Silicon runners expose Metal. Intel macOS, Windows and Linux CI
  // runners use the bundled CPU renderer for this trusted, offline fixture.
  const nativeGraphics = process.platform === 'darwin' && process.arch === 'arm64'
    && process.env.VIGO_TEST_SOFTWARE_RENDERING !== '1'
  const graphicsFlags = nativeGraphics ? [] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  if (process.platform === 'darwin' && !nativeGraphics) {
    // Electron ships the CPU driver, but macOS ANGLE looks for the Vulkan
    // loader filename. Use that same bundled driver under the expected name
    // only during this offline test; the shipped application is unchanged.
    const libraries = path.resolve(path.dirname(electronPath), '../Frameworks/Electron Framework.framework/Versions/A/Libraries')
    const alias = path.join(libraries, 'libvulkan.dylib')
    try {
      await fs.link(path.join(libraries, 'libvk_swiftshader.dylib'), alias)
      softwareLoader = alias
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  // An empty value still enables Node mode on Windows; remove the variable.
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronPath, [...ciFlags, ...graphicsFlags, path.join(temporary, 'main.cjs')], {
    stdio: 'inherit', env,
  })
  const timeout = setTimeout(() => child.kill(), 60_000)
  try {
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
    assert.equal(code, 0, 'Built map must render through the Studio protocol and sanitize attribution')
  } finally { clearTimeout(timeout) }
} finally {
  if (softwareLoader) await fs.unlink(softwareLoader)
  await fs.rm(temporary, { recursive: true, force: true })
}
