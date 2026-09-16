import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import electronPath from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const directory = await fs.mkdtemp(path.join(root, 'temp', 'navigation-runtime-'))
const fixture = `import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PrimaryNav} from '/src/components/PrimaryNav.tsx';
import '/src/App.css';
import '/src/index.css';
function Fixture(){
 const [view,setView]=useState('agency');
 return React.createElement('main',{className:'app-shell page-project view-'+view},
  React.createElement('header',{className:'topbar'},'Synthetic City'),
  React.createElement('div',{className:'shell-body'},
   React.createElement('aside',{className:'app-sidebar'},
    React.createElement(PrimaryNav,{page:'project',activeRouteTool:view,hasActiveData:true,onOpenNetwork:()=>setView('agency'),onOpenRouting:()=>setView('pathfinder'),onOpenAnalyze:()=>setView('analyze'),onOpenSettings:()=>setView('data')}),
    ['pathfinder','analyze'].includes(view)?React.createElement('section',{className:'sidebar-panel'},React.createElement('h2',null,view),React.createElement('label',null,'Fixture input',React.createElement('input'))):null),
   React.createElement('div',{className:'app-frame'},React.createElement('section',{className:'project-workbench'},'Workspace'))));
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
window.checkNavigation=async()=>{
 const nav=document.querySelector('.sidebar-rail');
 if(!nav) throw Error('Navigation missing');
 const buttons=[...nav.querySelectorAll('button')],names=buttons.map(b=>b.getAttribute('aria-label'));
 if(names.join(',')!=='Network,Route,Analyze,City') throw Error('Unexpected destinations');
 for(const button of buttons){
  const name=button.getAttribute('aria-label');
  if(button.textContent.trim()||!button.querySelector('svg')) throw Error('Primary navigation must stay icon-only');
  if(button.title!==name+' ('+button.getAttribute('aria-keyshortcuts')+')') throw Error('Icon navigation must retain its destination tooltip and shortcut');
  button.click(); await new Promise(resolve=>requestAnimationFrame(resolve));
  if(button.getAttribute('aria-current')!=='page'||nav.querySelectorAll('[aria-current=page]').length!==1) throw Error('Active destination is not exposed');
  if(innerWidth<=760){
   const r=nav.getBoundingClientRect(),boxes=buttons.map(b=>b.getBoundingClientRect()),centers=boxes.map(b=>b.x+b.width/2),gaps=centers.slice(1).map((c,i)=>c-centers[i]);
   if(Math.abs(r.bottom-innerHeight)>1) throw Error('Bottom navigation moved in '+name);
   if(Math.max(...gaps)-Math.min(...gaps)>1) throw Error('Empty navigation slot');
   for(let i=0;i<boxes.length;i++){
    const b=boxes[i];
    if(b.width<44||b.height<44) throw Error('Touch target too small');
    if(!buttons[i].contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))) throw Error('Navigation obscured');
   }
   const frame=document.querySelector('.app-frame').getBoundingClientRect();
   if(frame.bottom>r.top+1) throw Error('Navigation overlaps workspace '+JSON.stringify({width:innerWidth,height:innerHeight,view:name,frame:frame.toJSON(),nav:r.toJSON()}));
  }else if(nav.getBoundingClientRect().width>48) throw Error('Desktop rail expanded');
 }
 const scroll=document.documentElement.scrollWidth;
 if(scroll>innerWidth+1) throw Error('Horizontal overflow');
 buttons[0].click();
 return {width:innerWidth,height:innerHeight,equalSpacing:true,allViews:true,visible:true,iconOnly:true};
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
 const window=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
 await window.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/navigation-fixture.html`)});
 await window.webContents.executeJavaScript('new Promise((resolve,reject)=>{const timer=setInterval(()=>{if(window.checkNavigation){clearInterval(timer);resolve()}},20);setTimeout(()=>{clearInterval(timer);reject(Error("Fixture timed out"))},15000)})');
 const results=[];
 for(const [width,height] of [[320,640],[390,844],[760,708],[760,400],[761,900],[1280,900]]){
  window.setContentSize(width,height);await new Promise(resolve=>setTimeout(resolve,100));
  results.push(await window.webContents.executeJavaScript('window.checkNavigation()'));
 }
 fs.writeFileSync(${JSON.stringify(path.join(directory, 'navigation.png'))},(await window.webContents.capturePage()).toPNG());
 console.log(JSON.stringify({passed:true,results}));app.exit(0);
}catch(error){console.error(error);app.exit(1)}});`)
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronPath, [...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []), main], { env, stdio: 'inherit' })
  const timeout = setTimeout(() => child.kill(), 60_000)
  try { const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }); if (code !== 0) throw new Error(`Navigation fixture exited ${code}`) }
  finally { clearTimeout(timeout) }
} finally { await server.close() }
