// Browser integration: actual App controls, route state and request hook.
// Engine behavior is checked separately against generated Cities over HTTP.
import { flushSync } from 'react-dom'
import { route } from '../../src/state/route'
import './analysis-request'

const requests: Record<string, any>[] = [], originalFetch = window.fetch
window.fetch = async (input, options = {}) => {
  const url=String(input)
  if (url.endsWith('/api/projects/test-city?detail=catalog')) return originalFetch('/api/projects/test-city',options)
  if (url.endsWith('/street-residency')) return Response.json({job:{id:'streets',kind:'street-runtime-prepare',status:'complete',createdAt:'2026-01-01',result:{modes:{walk:true,drive:false,bike:true}}}})
  if (url.endsWith('/wheelchair-availability')) return Response.json({available:false,canPrepare:false})
  if (url.endsWith('/national-route')) {
    requests.push(JSON.parse(String(options.body)))
    return Response.json({choices:[]})
  }
  return originalFetch(input,options)
}
const assert=(condition:unknown,message:string)=>{if(!condition)throw Error(message)}
const until=async(read:()=>unknown)=>{const deadline=Date.now()+10000;while(Date.now()<deadline){if(read())return;await new Promise(resolve=>setTimeout(resolve,20))}throw Error('Fixture timed out: '+document.body.innerText)}
const click=(selector:string)=>{const element=document.querySelector<HTMLButtonElement>(selector);assert(element,'Missing '+selector);flushSync(()=>element!.click())}
const select=(label:string,value:string)=>{const element=document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;assert(element,'Missing '+label);element.value=value;flushSync(()=>element.dispatchEvent(new Event('change',{bubbles:true})))}
const input=(label:string,value:string)=>{const element=document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;assert(element,'Missing '+label);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(element,value);flushSync(()=>element.dispatchEvent(new Event('input',{bubbles:true})))}
const mode=(label:string)=>{const element=[...document.querySelectorAll<HTMLButtonElement>('.pathfinder-mode-switch button')].find(b=>b.textContent===label);assert(element,'Missing mode '+label);flushSync(()=>element!.click())}
async function check() {
  await until(()=>document.querySelector('.city-card-open'))
  click('.city-card-open')
  await until(()=>document.querySelector('.sidebar-rail [aria-label="Route"]'))
  click('.sidebar-rail [aria-label="Route"]')
  await until(()=>document.querySelector('.pathfinder-mode-switch'))
  mode('Bike')
  await until(()=>document.querySelector('select[aria-label="Bike preference"]'))
  assert(document.querySelector('input[aria-label="Routing service date"]'),'Bike must expose the date used for timed permissions')
  assert(document.querySelector<HTMLSelectElement>('select[aria-label="Maximum bicycle traffic stress"]')!.value==='','LTS must be opt-in')
  select('Bike preference','quiet');input('Cycling speed','23');select('Maximum bicycle traffic stress','2')
  input('Routing service date','2026-11-02')
  flushSync(()=>route.set({routingOrigin:{coordinate:[-77.05,38.9],label:'Origin',source:'map'},
    routingDestination:{coordinate:[-77.03,38.91],label:'Destination',source:'map'}}))
  await until(()=>requests.some(r=>r.mode==='bike'&&r.bike?.maxLts===2))
  const first=requests.find(r=>r.mode==='bike'&&r.bike?.maxLts===2)!
  assert(first.bike.profile==='quiet'&&first.bike.speedKph===23,'Profile or speed missing from actual request')
  assert(first.serviceDate==='2026-11-02','Date missing from actual request')
  select('Maximum bicycle traffic stress','1')
  await until(()=>requests.some(r=>r.mode==='bike'&&r.bike?.maxLts===1))
  const arrive=[...document.querySelectorAll<HTMLButtonElement>('.routing-setup-time button')].find(b=>b.textContent==='Arrive by')!
  flushSync(()=>arrive.click())
  await until(()=>requests.some(r=>r.mode==='bike'&&r.timePreference==='arrive'))
  mode('Walk')
  await until(()=>requests.some(r=>r.mode==='walk'))
  assert(!Object.hasOwn(requests.find(r=>r.mode==='walk')!,'bike'),'Bike options leaked into walking request')
  mode('Bike')
  await until(()=>document.querySelector<HTMLSelectElement>('select[aria-label="Maximum bicycle traffic stress"]')?.value==='1')
  select('Maximum bicycle traffic stress','')
  await until(()=>requests.some(r=>r.mode==='bike'&&r.bike?.profile==='quiet'&&!Object.hasOwn(r.bike,'maxLts')))
  const inputField=document.querySelector<HTMLInputElement>('input[aria-label="Cycling speed"]')!
  input('Cycling speed','')
  assert(inputField.value==='23','Clearing speed must not submit zero or NaN')
  return {status:'passed',requests,checks:['opt-in ceiling','profile and speed wiring','date wiring','query invalidation','arrive-by','mode isolation','preserved choices','clearing ceiling','invalid speed']}
}
const output=document.createElement('pre');output.id='bike-fixture-result';Object.assign(output.style,{position:'fixed',right:'12px',bottom:'12px',zIndex:'99999',maxWidth:'380px',maxHeight:'260px',overflow:'auto',padding:'12px',background:'white',border:'1px solid #aaa',fontSize:'11px'});document.body.append(output)
output.textContent='Running bike request checks…'
check().then(result=>{output.dataset.status='passed';output.textContent=JSON.stringify(result,null,2)},error=>{output.dataset.status='failed';output.textContent=String(error);console.error(error)})
