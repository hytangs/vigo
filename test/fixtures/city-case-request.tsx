import { flushSync } from 'react-dom'
import './analysis-request'

const requests = [], originalFetch = window.fetch
window.fetch = (input, options = {}) => {
  const url = String(input)
  if (url.endsWith('/reach')) requests.push(JSON.parse(options.body))
  return originalFetch(input, options)
}
const assert = (condition, message) => { if (!condition) throw Error(message) }
const until = async read => { const deadline = Date.now()+5000; while(Date.now()<deadline) { if(read())return; await new Promise(resolve=>setTimeout(resolve,20)) } throw Error('Fixture timeout: '+document.body.innerText) }
const click = selector => { const node=document.querySelector(selector); assert(node,'Missing '+selector); flushSync(()=>node.click()) }
const type = (selector,value) => { const element=document.querySelector(selector); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,value); flushSync(()=>element.dispatchEvent(new Event('input',{bubbles:true}))) }
function openData() {
  document.querySelector('.reach-scenario-builder').open=true
  click('.city-case-group-link')
}
window.checkCaseRequest = async () => {
  await window.checkAnalysisRequest()
  assert(requests[0].feedIds.join() === 'first,second' && !requests[0].feedId, 'Initial case did not request its group feeds')
  click('.reach-mode-tabs button:first-child')
  openData()
  await until(()=>document.querySelector('.city-data-library'))
  click('.city-data-groups > button'); type('.city-group-name input','Second timetable')
  click('.city-group-feed:nth-of-type(2) input'); click('.city-group-dialog button[type=submit]')
  click('.city-data-switch button:last-child')
  const select=document.querySelector('.city-case-entry select')
  select.value=[...select.options].find(option=>option.textContent==='Second timetable').value
  flushSync(()=>select.dispatchEvent(new Event('change',{bubbles:true})))
  click('.city-case-entry > button')
  await until(()=>document.querySelector('.reach-run') && !document.querySelector('.reach-run').disabled)
  const before=requests.length
  click('.reach-run')
  await until(()=>requests.length===before+1 && !document.querySelector('.reach-run').textContent.includes('Cancel'))
  assert(requests.at(-1).feedIds.join()==='second','Changing the case group did not change the actual request')
  openData()
  const filter=[...document.querySelectorAll('.city-group-filters button')].find(button=>button.textContent==='Second timetable')
  flushSync(()=>filter.click())
  click('.city-data-actions > .city-data-text-action')
  click('.city-group-feed:nth-of-type(2) input'); click('.city-group-dialog button[type=submit]')
  click('.city-data-switch button:last-child'); click('.city-case-entry > button')
  await until(()=>document.querySelector('.reach-run'))
  const count=requests.length
  click('.reach-run')
  await new Promise(resolve=>setTimeout(resolve,30))
  assert(requests.length===count,'An empty group silently requested the entire City')
  assert(document.body.textContent.includes('Add a timetable to Second timetable'),'The empty group did not explain how to fix it')
  return { defaultGroup:true, groupChangesRequest:true, emptyGroupBlocked:true }
}
