import React, { useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ScenarioPanel } from '/src/components/scenarios/ScenarioPanel.tsx';
import { ScenarioChangeEditor } from '/src/components/scenarios/ScenarioChangeEditor.tsx';
import { useScenarioLibrary } from '/src/app/useScenarioLibrary.ts';
import { applyScenarioStopNames } from '/src/app/useScenarioStopNames.ts';
import { scenarios } from '/src/state/scenarios.ts';
import { city } from '/src/state/city.ts';
import { shell } from '/src/state/shell.ts';
import { scenarioPointFromMap, moveScenarioStopFromMap } from '/src/state/scenarioEditor.ts';
import { buildRoutingPointFromMap } from '/src/routingUi.ts';
import '/src/index.css';
import '/src/App.css';
const project = {id:'fixture',name:'Boston',feeds:[],summary:{feeds:0,routes:0,stops:0},jobs:[],artifacts:[]};
city.set({projects:[project],selectedProjectId:project.id});
shell.set({activeRouteTool:'scenarios'});
let library, requests = 0, assembly = false;
window.fetch = async (url, options = {}) => {
  if (String(url).includes('/place?')) {
    requests++;
    const points = new URL(String(url), location.origin).searchParams.get('points').split(';');
    return Response.json({places:points.map((point, index) => ({label:Number(point.split(',')[0]) === -71.2 ? 'Moved street' : ['Cambridge Street near Ames Street','Washington Street near School Street','Beacon Street'][index % 3]}))});
  }
  return Response.json({library:null,revision:options.method === 'PUT' ? 1 : 0});
};
const stop = (id, lon) => ({id,label:'42.3500, ' + lon,coordinate:[lon,42.35],source:'map',editStatus:'added'});
const line = {id:'line',name:'Clarkson Line',kind:'add-line',geometryMode:'straight-line',stops:[stop('a',-71.08),stop('b',-71.09)],headwayMinutes:10,averageSpeedKph:25,startMinutes:300,endMinutes:1500,bidirectional:true};
function App() {
  library = useScenarioLibrary(project);
  useLayoutEffect(() => scenarios.set({projectId:project.id,library}));
  const change = library.scenarioDrafts[0]?.interventions[0];
  return React.createElement('div',{className:'app-shell appearance-light',style:{height:'100vh'}},
    React.createElement('div',{className:'sidebar-panel',style:{width:'350px',height:'100vh',overflow:'auto',padding:'12px'}},
      assembly ? React.createElement(ScenarioPanel) : React.createElement(React.Fragment,null,React.createElement('h2',null,'Scenarios'), change ? React.createElement(ScenarioChangeEditor,{change}) : null)));
}
createRoot(document.getElementById('root')).render(React.createElement(App));
const check = (condition, message) => {if(!condition) throw Error(message)};
const until = async (fn) => {for(let n=0;n<200;n++){if(fn()) return;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('Timed out');};
window.runTests = async () => {try {
  await until(()=>library?.saveState === 'saved');
  flushSync(()=>library.setScenarioDrafts([{id:'case-a',name:'HarisNet',groupId:'baseline',interventions:[line]}]));
  await until(()=>document.body.textContent.includes('Cambridge Street near Ames Street'));
  check(requests > 0,'Did not reuse place-name service');
  const getStops = () => library.scenarioDrafts[0].interventions[0].stops;
  const insert = document.querySelector('[aria-label="Insert stop between 1 and 2"]');
  check(insert,'New lines lack a middle insertion control');
  flushSync(()=>insert.click());
  flushSync(()=>scenarioPointFromMap(buildRoutingPointFromMap([-71.085,42.35],'42.35, -71.085')));
  check(getStops().length===3 && getStops()[0].id==='a' && getStops()[2].id==='b','Middle insertion reordered or replaced existing stops');
  check(getStops()[1].editStatus==='inserted','Inserted stop lost provenance');
  flushSync(()=>moveScenarioStopFromMap(0,[-71.2,42.35]));
  check(getStops()[0].label.includes('-71.2000'),'Dragging retained the old address');
  await until(()=>getStops()[0].label==='Moved street');
  const drafts=library.scenarioDrafts;
  check(applyScenarioStopNames(drafts,'line',[{id:'a',coordinate:[-71.08,42.35],label:'Stale address'}])===drafts,'Late lookup renamed a moved stop');
  check(document.querySelector('.scenario-stop-list').getBoundingClientRect().height < 160, 'Insertion controls added permanent rows');
  check(getComputedStyle(document.querySelector('.scenario-stop-insert')).opacity === '0', 'Insertion control visible at rest');
  const action=document.querySelector('.scenario-stop-action:not(:disabled)');
  check(getComputedStyle(action).opacity==='0','Stop actions visible at rest');
  action.focus();
  check(getComputedStyle(action).opacity==='1','Keyboard focus did not reveal stop actions');
  action.blur();
  for(const control of document.querySelectorAll('.reach-number-input')) {
    const input=control.querySelector('input').getBoundingClientRect(), unit=control.querySelector('span').getBoundingClientRect();
    check(unit.left-input.right>=5,'Numeric value overlaps unit');
  }
  const rows=[...document.querySelectorAll('.scenario-stop-list > li')];
  check(rows.every(row=>Math.abs(row.getBoundingClientRect().height-32)<0.1),'Stop rows have inconsistent heights');
  check(!document.querySelector('.scenario-stop-index') && !document.querySelector('.scenario-stop-name small'),'Number or edit-status labels remain');
  const originalOrder=getStops().map(stop=>stop.id);
  flushSync(()=>document.querySelector('[title="Move later"]').click());
  check(getStops()[1].id===originalOrder[0] && getStops()[0].id===originalOrder[1],'Move later did not reorder stops');
  const fields=[...document.querySelectorAll('.scenario-service .reach-number-field')];
  check(fields[0].getBoundingClientRect().top===fields[1].getBoundingClientRect().top,'Service controls did not share a compact row');
  check(document.querySelector('.sidebar-panel').scrollWidth<=350,'Panel overflows');
  return {middleInsertion:true,localNames:true,movedStopSafety:true,keyboardActions:true,unitSpacing:true};
} catch(error) {return {failed:error.stack}}};

window.runAssemblyTests = async () => {try {
  await until(()=>library?.saveState === 'saved');
  assembly = true;
  flushSync(()=>library.setScenarioDrafts([
    {id:'case-a',name:'HarisNet',groupId:'baseline',interventions:[line]},
    {id:'case-b',name:'Frequent network',groupId:'baseline',interventions:[line]},
  ]));
  await until(()=>document.querySelector('.scenario-change-library'));
  flushSync(()=>document.querySelector('.scenario-change-library > summary').click());
  const toggle = () => document.querySelector('.scenario-library-row input');
  check(toggle().checked,'Active membership not shown');
  check(document.body.textContent.includes('Shared by 2 scenarios'),'Shared edit scope is invisible');
  flushSync(()=>toggle().click());
  check(!library.scenarioDrafts[0].interventions.length && library.scenarioDrafts[1].interventions.length === 1,'Removing membership changed another scenario');
  check(library.reusableChanges.some(change=>change.id==='line'),'Removing membership deleted the reusable definition');
  flushSync(()=>toggle().click());
  check(library.scenarioDrafts[0].interventions[0].id==='line','Reassembly copied the definition');
  check(document.querySelector('.scenario-library-delete').disabled,'Used definition can be deleted accidentally');
  return {compositionControls:true,sharedScope:true};
} catch(error) {return {failed:error.stack}}};

const runButton = document.createElement('button'); runButton.textContent = 'Load test scenario'; runButton.onclick = () => (location.search.includes('assembly') ? window.runAssemblyTests() : window.runTests()).then(result => { runButton.textContent = JSON.stringify(result); }); document.body.append(runButton);
