import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Map } from '../../src/app/mapRuntime'
import { VigoMap } from '../../src/VigoMap'
import { ServiceStateControl, ServiceToolbar } from '../../src/components/ServiceStateControl'
import { buildServiceVehicleFrame } from '../../src/serviceVehicles'
import '../../src/App.css'
import '../../src/index.css'

let map, setClock, setMode, setAppearance
const addControl = Map.prototype.addControl
Map.prototype.addControl = function(...args) { map = this; return addControl.apply(this,args) }
const stops = [['a','South Station',-71.06,42.35],['b','JFK/Columbia',-71.05,42.32],['c','Wachusett',-71.08,42.3]].map(([id,name,lon,lat])=>({id,name,lon,lat,routes:['R'],tripCount:1,transferScore:0}))
const preview = {routes:[{id:'R',routeId:'R',shortName:'Regional Rail',longName:'Wachusett – Greenbush',mode:'rail',color:'#8c4387',tripCount:1,stopCount:3,coordinates:stops.map(s=>[s.lon,s.lat]),points:[],stopIds:stops.map(s=>s.id)}],stops,stopPairs:[]}
function Fixture() {
  const [time,changeTime]=useState(690), [mode,changeMode]=useState('schedule'), [appearance,changeAppearance]=useState('dark')
  const [playing,toggle]=useState(false), [step,changeStep]=useState(1), [date,changeDate]=useState('2026-10-19')
  setClock=changeTime; setMode=changeMode; setAppearance=changeAppearance
  const scheduledVehicles=time<750 ? [{id:'scheduled-1',routeFeatureId:'R',routeId:'R',routeShortName:'Regional Rail',routeColor:'#8c4387',tripId:'weekday-regional-rail-outbound-example-110554',serviceDate:date,state:'moving',nextStopId:time<700?'b':'c',nextStopArrivalMinutes:time<700?696:750,destinationStopId:'c',coordinate:[-71.055,42.335],bearing:140,elapsedMinutes:time-660,runtimeMinutes:90,progress:(time-660)/90,scheduleTimeMinutes:time}] : []
  const frame=buildServiceVehicleFrame({mode,preview,scheduledVehicles,realtimeSnapshot:null})
  return <div className={`app-shell page-project has-stage view-agency agency-map-open appearance-${appearance}`} style={{display:'block'}}>
    <section className="route-surface" style={{height:'100%',position:'relative'}}>
      <ServiceToolbar><ServiceStateControl mode={mode} frame={frame} vehicleCount={frame.vehicles.length} diagnostics={{tone:'good',title:`${frame.vehicles.length} vehicles`,detail:'Fixture timetable'}} scheduleTimeMinutes={time} scheduleServiceDate={date} scheduleEndMinutes={1800} playbackRunning={playing} playbackStep={step} onModeChange={changeMode} onTogglePlayback={()=>toggle(!playing)} onPlaybackStepChange={changeStep} onScheduleTimeChange={changeTime} onScheduleServiceDateChange={changeDate} onNow={()=>changeTime(720)} /></ServiceToolbar>
      <div className="surface-panel route-map-shell"><VigoMap preview={preview} feedName="Fixture" layers={{routes:true,stops:true,access:false,transfers:false}} networkLens="network" basemap="none" appearance={appearance} selectedRouteId="" selectedStopId="" vehicleFrame={frame} focusMode="network" onSelectRoute={()=>{}} onSelectStop={()=>{}} /></div>
    </section>
  </div>
}
flushSync(()=>createRoot(document.getElementById('root')).render(<Fixture/>))
const pause=ms=>new Promise(r=>setTimeout(r,ms))
const check=(ok,message)=>{if(!ok)throw Error(message)}
const until=async(test,message)=>{for(let i=0;i<300;i++){if(test())return;await pause(25)}throw Error(message)}
window.prepareInspector=async()=>{
  await until(()=>map?.getLayer('vigo-vehicles'),'Vehicle layer missing')
  map.jumpTo({center:[-71.055,42.335],zoom:12})
  await until(()=>map.queryRenderedFeatures(map.project([-71.055,42.335]),{layers:['vigo-vehicles']}).length,'Vehicle not rendered')
  map.fire('click',{point:map.project([-71.055,42.335]),lngLat:{lng:-71.055,lat:42.335},originalEvent:{shiftKey:false}})
  await until(()=>document.querySelector('.scheduled-vehicle-detail'),'Vehicle inspector missing')
  check(document.querySelector('.scheduled-vehicle-call').textContent.includes('11:36'),'Initial arrival missing')
  flushSync(()=>setClock(702))
  await until(()=>document.querySelector('.scheduled-vehicle-call').textContent.includes('12:30'),'Selected vehicle remained frozen after playback advanced')
  check(document.querySelector('.scheduled-vehicle-call').textContent.includes('Wachusett'),'Next stop did not advance')
  flushSync(()=>setClock(760))
  check(document.querySelector('.scheduled-vehicle-inactive'),'Inactive trip still shows old timing')
  check(!document.querySelector('.scheduled-vehicle-call'),'Inactive trip retained a next-stop forecast')
  flushSync(()=>setClock(690))
  check(document.querySelector('.scheduled-vehicle-call'),'Scrubbing back did not restore the selected trip')
  document.querySelector('.service-playback-toggle').click()
  await until(()=>document.querySelector('[aria-label="Pause service playback"]'),'Play button did not update')
  document.querySelector('.service-clock-input').dispatchEvent(new FocusEvent('focusin', {bubbles:true}))
  await until(()=>document.querySelector('[aria-label="Play service playback"]'),'Editing the clock did not pause playback')
  document.querySelector('.service-clock-input').blur()
  return true
}
window.checkInspectorLayout=async(appearance,expanded=false)=>{
  flushSync(()=>setAppearance(appearance))
  document.querySelector('.scheduled-vehicle-provenance').open=expanded
  await pause(180)
  const card=document.querySelector('.map-live-card'),toolbar=document.querySelector('.service-state-panel')
  const c=card.getBoundingClientRect(),t=toolbar.getBoundingClientRect(),surface=document.querySelector('.route-surface').getBoundingClientRect()
  check(c.width > 200 && c.height > 100 && t.width > 200 && t.height > 30, 'Inspector or toolbar is hidden')
  check(c.bottom+10<=t.top || t.bottom<=c.top,'Playback overlaps inspector: '+JSON.stringify({c:c.toJSON(),t:t.toJSON()}))
  check(c.top>=surface.top && c.bottom<=surface.bottom,'Inspector escaped map bounds')
  check(card.scrollWidth<=card.clientWidth+1,'Inspector has horizontal overflow')
  check(toolbar.scrollWidth<=toolbar.clientWidth+1,'Playback has horizontal overflow')
  for(const el of toolbar.querySelectorAll('input,select,button')) {const r=el.getBoundingClientRect();check(r.left>=t.left-1&&r.right<=t.right+1,'Control escapes playback dock: '+el.outerHTML)}
  return {appearance,width:innerWidth,height:innerHeight,expanded,clearance:Math.round(t.top>=c.bottom?t.top-c.bottom:c.top-t.bottom),toolbarHeight:Math.round(t.height)}
}
window.finishInspector=async()=>{
  flushSync(()=>setMode('live'))
  await until(()=>!document.querySelector('.has-scheduled-trip'),'Scheduled card survived switching to live')
  check(document.querySelector('.service-live-meta'),'Live state missing')
  return 'Playback, scrubbing, inactive trips and live-mode transition passed'
}
