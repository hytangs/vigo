import { build } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
await fs.mkdir(path.join(root, 'temp'), { recursive: true })
const directory = await fs.mkdtemp(path.join(root, 'temp', 'map-controls-'))
let softwareLoader
try {
  await fs.writeFile(path.join(directory, 'index.html'), '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="../../test/fixtures/map-controls.ts"></script>')
  await fs.writeFile(path.join(directory, 'inspection.html'), '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="../../test/fixtures/reach-inspection.tsx"></script>')
  await build({ configFile: false, root: directory, publicDir: false, logLevel: 'warn', plugins: [react()],
    build: { chunkSizeWarningLimit: 1500, rollupOptions: { input: [path.join(directory, 'index.html'), path.join(directory, 'inspection.html')] } } })
  const main = path.join(directory, 'main.cjs')
  await fs.writeFile(main, `
const {app,BrowserWindow,protocol,net}=require('electron');
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const {layoutFrame,resizeLayout}=require(${JSON.stringify(path.join(root, 'test/helpers/layout-frame.cjs'))});
app.setPath('userData',${JSON.stringify(path.join(directory, 'profile'))});
protocol.registerSchemesAsPrivileged([{scheme:'vigo',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
app.whenReady().then(async()=>{try{
  protocol.handle('vigo',request=>net.fetch(pathToFileURL(path.join(${JSON.stringify(path.join(directory, 'dist'))},new URL(request.url).pathname==='/'?'index.html':decodeURIComponent(new URL(request.url).pathname))).href));
  const w=new BrowserWindow({show:false,width:1280,height:920,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}});
  const external=[];
  w.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>{external.push(details.url);callback({cancel:true})});
  await w.loadURL('vigo://studio/');
  await w.webContents.executeJavaScript('window.controlsReady');
  w.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});w.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
  const behavior=await w.webContents.executeJavaScript('window.checkControls()');
  const results=[];
  for(const width of [1280,980,761,760,390,320]){
    await resizeLayout(w,width,920);
    for(const dark of [false,true]){
      for(const overlay of ['none','journey','stop','network','agency']){
        results.push(await w.webContents.executeJavaScript('window.checkControlsLayout('+dark+','+JSON.stringify(overlay)+')'));
      }
      await w.webContents.executeJavaScript('window.checkControlsLayout('+dark+',"none")');
      if(${JSON.stringify(Boolean(process.env.VIGO_MAP_CONTROLS_SCREENSHOT_DIR))}){
        fs.mkdirSync(${JSON.stringify(process.env.VIGO_MAP_CONTROLS_SCREENSHOT_DIR ?? directory)},{recursive:true});
        fs.writeFileSync(path.join(${JSON.stringify(process.env.VIGO_MAP_CONTROLS_SCREENSHOT_DIR ?? directory)},width+'-'+(dark?'dark':'light')+'.png'),(await layoutFrame(w)).toPNG());
      }
    }
  }
  await resizeLayout(w,1280,920);
  await w.loadURL('vigo://studio/inspection.html?view=routing');
  const quietRouting=await w.webContents.executeJavaScript('window.checkQuietMaps()');
  await w.loadURL('vigo://studio/inspection.html');
  const quietAnalysis=await w.webContents.executeJavaScript('window.checkQuietMaps()');
  const inspection=await w.webContents.executeJavaScript('window.checkReachInspection()');
  const inspectionLayouts=[];
  for(const width of [1280,760,390,320]){
    await resizeLayout(w,width,920);
    for(const dark of [false,true]){
      inspectionLayouts.push(await w.webContents.executeJavaScript('window.checkInspectionLayout('+dark+')'));
      if(${JSON.stringify(Boolean(process.env.VIGO_MAP_CONTROLS_SCREENSHOT_DIR))}) fs.writeFileSync(path.join(${JSON.stringify(process.env.VIGO_MAP_CONTROLS_SCREENSHOT_DIR ?? directory)},'inspection-'+width+'-'+(dark?'dark':'light')+'.png'),(await layoutFrame(w)).toPNG());
    }
  }
  if(external.length) throw Error('Offline controls attempted external requests: '+external.join(', '));
  console.log(JSON.stringify({passed:true,behavior,results,quietRouting,quietAnalysis,inspection,inspectionLayouts}));app.exit(0);
}catch(error){console.error(error);app.exit(1)}});
`)
  const nativeGraphics = process.platform === 'darwin' && process.arch === 'arm64' && process.env.VIGO_TEST_SOFTWARE_RENDERING !== '1'
  const graphics = nativeGraphics ? [] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  if (process.platform === 'darwin' && !nativeGraphics) {
    const libraries = path.resolve(path.dirname(electron), '../Frameworks/Electron Framework.framework/Versions/A/Libraries')
    const alias = path.join(libraries, 'libvulkan.dylib')
    try { await fs.link(path.join(libraries, 'libvk_swiftshader.dylib'), alias); softwareLoader = alias }
    catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []), ...graphics, main], { env, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill(), 120_000)
  try { const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }); if (code !== 0) throw Error(`Map controls runtime check failed (${code})`) }
  finally { clearTimeout(timer) }
} finally {
  if (softwareLoader) await fs.unlink(softwareLoader)
  await fs.rm(directory, { recursive: true, force: true })
}
