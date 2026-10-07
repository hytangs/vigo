import { createViteTestServer as createServer } from './helpers/vite-test-server.mjs'
import react from '@vitejs/plugin-react'
import electronPath from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const directory = await fs.mkdtemp(path.join(root, 'temp', 'city-delete-runtime-'))
const fixture = `import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ProjectEditorDialog} from '/src/components/ProjectDialogs.tsx';
import '/src/App.css';import '/src/index.css';
let submitted=0,closed=0;
function Fixture(){
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 window.setBusy=setBusy;window.setError=setError;
 return React.createElement(ProjectEditorDialog,{state:{mode:'delete',projectId:'synthetic',name:'Synthetic City',region:'Test'},busy,error,
  onClose:()=>closed++,onSubmit:()=>submitted++});
}
flushSync(()=>createRoot(document.getElementById('root')).render(React.createElement(Fixture)));
window.checkNavigation=async()=>{
 // Hidden Windows fixtures may not receive animation frames. Commit React
 // changes synchronously; the assertions below read DOM state and layout.
 const input=document.querySelector('input'),button=document.querySelector('button[type=submit]');
 const fill=(value)=>flushSync(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))});
 if(!document.querySelector('[role=dialog]')||!document.body.textContent.includes('Delete City'))throw Error('Delete dialog missing');
 fill('');if(!button.disabled)throw Error('Empty confirmation accepted');
 fill('synthetic city');if(!button.disabled)throw Error('Wrong case accepted');
 fill('Synthetic City ');if(!button.disabled)throw Error('Extra whitespace accepted');
 fill('Synthetic City');if(button.disabled)throw Error('Exact name rejected');
 flushSync(()=>button.click());if(!submitted)throw Error('Confirmation did not submit');
 flushSync(()=>window.setBusy(true));if(!button.disabled||!input.disabled)throw Error('Busy deletion permits duplicate input');
 const before=closed;window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));if(closed!==before)throw Error('Busy dialog dismissed');
 flushSync(()=>{window.setBusy(false);window.setError('Synthetic deletion failed')});
 if(!document.querySelector('[role=alert]')?.textContent.includes('Synthetic deletion failed'))throw Error('Failure hidden');
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));if(closed!==before+1)throw Error('Escape did not cancel');
 const r=button.getBoundingClientRect();if(r.width<=0||r.height<=0||r.bottom>innerHeight||r.right>innerWidth)throw Error('Delete button clipped');
 return {width:innerWidth,height:innerHeight,exactConfirmation:true,busyGuard:true,errorVisible:true,cancel:true};
};`
const server = await createServer({ root, cacheDir: path.join(directory, 'vite-cache'), configFile: false, plugins: [react(), {
  name: 'navigation-fixture',
  resolveId(id) { if (id === '/navigation-fixture.js') return id },
  load(id) { if (id === '/navigation-fixture.js') return fixture },
  configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
    if (req.url !== '/navigation-fixture.html') return next()
    res.setHeader('Content-Type', 'text/html')
    res.end(await vite.transformIndexHtml(req.url, '<div id="root"></div><script type="module" src="/navigation-fixture.js"></script>'))
  }) },
}], server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { include: ['react', 'react-dom/client'] } })
await server.listen()
const main = path.join(directory, 'main.cjs')
await fs.writeFile(main, `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');
app.setPath('userData',${JSON.stringify(path.join(directory, 'profile'))});
app.whenReady().then(async()=>{try{
 const window=new BrowserWindow({show:true,width:1280,height:900,webPreferences:{backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}});
 await window.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/navigation-fixture.html`)});
 await window.webContents.executeJavaScript('new Promise((resolve,reject)=>{const timer=setInterval(()=>{if(window.checkNavigation){clearInterval(timer);resolve()}},20);setTimeout(()=>{clearInterval(timer);reject(Error("Fixture timed out"))},15000)})');
 const results=[];
 for(const [width,height] of [[320,640],[760,708],[1280,900]]){
  window.setContentSize(width,height);await new Promise(resolve=>setTimeout(resolve,100));
  results.push(await window.webContents.executeJavaScript('window.checkNavigation()'));
 }
 const screenshot=await window.webContents.capturePage();
 if(screenshot.isEmpty())throw Error('Layout fixture screenshot is empty');
 fs.writeFileSync(${JSON.stringify(path.join(directory, 'navigation.png'))},screenshot.toPNG());
 console.log(JSON.stringify({passed:true,results}));app.exit(0);
}catch(error){console.error(error);app.exit(1)}});`)
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronPath, [...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []), main], { env, stdio: 'inherit' })
  const timeout = setTimeout(() => child.kill(), 60_000)
  try { const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }); if (code !== 0) throw new Error(`Navigation fixture exited ${code}`) }
  finally { clearTimeout(timeout) }
} finally { await server.close() }
