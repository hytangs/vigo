import { createViteTestServer } from './helpers/vite-test-server.mjs'
import react from '@vitejs/plugin-react'
import electronPath from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-search-accessibility-'))
const fixture = `import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {SearchPalette} from '/src/features/search/SearchPalette.tsx';
const options=[{id:'stop:a',kind:'stop',group:'stops',title:'Alpha',subtitle:'Stop'},
 {id:'route:b',kind:'route',group:'routes',title:'Bravo',subtitle:'Service'}];
function Fixture(){
 const [value,setValue]=useState('a'),[results,setResults]=useState(options);
 return <><SearchPalette value={value} results={results} onChange={setValue}
  onActivate={result=>window.activated=result.id} onSubmit={()=>window.submitted=true}/>
  <button id="empty" onClick={()=>setResults([])}>Empty results</button>
  <button id="after">After search</button></>;
}
flushSync(()=>createRoot(document.getElementById('root')).render(<Fixture/>));
window.checkSearch=()=>{
 const assert=(ok,message)=>{if(!ok)throw Error(message)};
 const input=document.querySelector('[role=combobox]');
 const press=key=>flushSync(()=>input.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true})));
 const open=()=>flushSync(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',code:'KeyK',metaKey:true,bubbles:true})));
 open();
 const list=document.getElementById(input.getAttribute('aria-controls'));
 assert(input.getAttribute('aria-expanded')==='true'&&list?.getAttribute('role')==='listbox','Open results must expose a listbox');
 const items=[...list.querySelectorAll('[role=option]')];
 assert(items.length===2&&items.every(item=>item.tabIndex===-1),'Options must not add Tab stops');
 assert(input.getAttribute('aria-activedescendant')===items[0].id,'The first option must be announced');
 press('ArrowDown');
 assert(input.getAttribute('aria-activedescendant')===items[1].id,'Arrow keys must update the active option');
 assert(document.activeElement===input,'Arrow navigation must keep focus in the input');
 press('Enter');
 assert(window.activated==='route:b'&&input.getAttribute('aria-expanded')==='false','Enter must open the active result and close the list');
 open();
 flushSync(()=>document.getElementById('empty').click());
 const status=document.querySelector('.search-palette [role=status]');
 assert(status?.textContent.includes('No results'),'Empty search must announce its outcome');
 assert(!document.querySelector('[role=listbox]')&&input.getAttribute('aria-expanded')==='false'&&!input.hasAttribute('aria-controls'),
  'Empty results must not be exposed as listbox options');
 press('Escape');
 assert(!document.querySelector('.search-palette [role=status]'),'Escape must close the popup');
 return {keyboard:true,focus:true,emptyStatus:true};
};`

const server = await createViteTestServer({ root, cacheDir: path.join(directory, 'vite-cache'), configFile: false,
  plugins: [react(), {
    name: 'search-accessibility-fixture',
    resolveId(id) { if (id === '/search-accessibility-fixture.jsx') return id },
    load(id) { if (id === '/search-accessibility-fixture.jsx') return fixture },
    configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
      if (req.url !== '/search-accessibility-fixture.html') return next()
      res.setHeader('Content-Type', 'text/html')
      res.end(await vite.transformIndexHtml(req.url, '<div id="root"></div><script type="module" src="/search-accessibility-fixture.jsx"></script>'))
    }) },
  }], server: { host: '127.0.0.1', port: 0 } })

try {
  await server.listen()
  const main = path.join(directory, 'main.cjs')
  await fs.writeFile(main, `const {app,BrowserWindow}=require('electron');
app.disableHardwareAcceleration();
app.setPath('userData',${JSON.stringify(path.join(directory, 'profile'))});
app.whenReady().then(async()=>{try{
 const win=new BrowserWindow({show:false,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}});
 await win.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/search-accessibility-fixture.html`)});
 await win.webContents.executeJavaScript('new Promise((resolve,reject)=>{const timer=setInterval(()=>{if(window.checkSearch){clearInterval(timer);resolve()}},20);setTimeout(()=>{clearInterval(timer);reject(Error("Fixture timed out"))},15000)})');
 console.log(JSON.stringify(await win.webContents.executeJavaScript('window.checkSearch()')));
 win.destroy();app.exit(0);
}catch(error){console.error(error);app.exit(1)}});`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronPath, [...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []), main], { env, stdio: 'inherit' })
  const timeout = setTimeout(() => child.kill(), 60_000)
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    if (code !== 0) throw new Error(`Search accessibility fixture exited ${code}`)
  } finally { clearTimeout(timeout) }
} finally {
  await server.close()
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
