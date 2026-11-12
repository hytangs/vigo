// Actual App controls and request state; native HTTP tests cover computation.
import { flushSync } from 'react-dom'
import { reachExtent } from '../../src/app/reachExtent'
import './analysis-request'

const requests: Record<string, any>[] = [], originalFetch = window.fetch
window.fetch = async (input, options = {}) => {
  const url = String(input)
  if (url.endsWith('/api/projects/test-city?detail=catalog')) return originalFetch('/api/projects/test-city', options)
  if (url.endsWith('/street-residency')) return Response.json({job:{id:'streets',kind:'street-runtime-prepare',status:'complete',createdAt:'2026-01-01',result:{modes:{walk:true,drive:false,bike:true}}}})
  if (url.endsWith('/wheelchair-availability')) return Response.json({available:false,canPrepare:false})
  if (url.endsWith('/reach')) requests.push(JSON.parse(String(options.body)))
  return originalFetch(input, options)
}
const assert = (condition: unknown, message: string) => { if (!condition) throw Error(message) }
const until = async (read: () => unknown) => { const deadline = Date.now() + 10000; while (Date.now() < deadline) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 20)) } throw Error('Fixture timed out: ' + document.body.innerText) }
const click = (selector: string) => { const element = document.querySelector<HTMLButtonElement>(selector); assert(element, 'Missing ' + selector); flushSync(() => element!.click()) }
const fill = (element: HTMLInputElement | null, value: string) => { assert(element, 'Missing input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); flushSync(() => element!.dispatchEvent(new Event('input', {bubbles:true}))) }
const field = (name: string) => [...document.querySelectorAll('label')].find(l => l.querySelector('span')?.textContent === name)?.querySelector('input') ?? null
const select = (label: string, value: string) => { const element = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; assert(element, 'Missing ' + label); element.value = value; flushSync(() => element.dispatchEvent(new Event('change', {bubbles:true}))) }
const mode = (label: string) => { const element = [...document.querySelectorAll<HTMLButtonElement>('.reach-travel-mode button')].find(b => b.getAttribute('aria-label') === label); assert(element, 'Missing mode ' + label); flushSync(() => element!.click()) }
async function run() {
  const count = requests.length
  click('.reach-run')
  await until(() => requests.length === count + 1 && !document.querySelector('.reach-run')?.textContent?.includes('Cancel'))
  return requests.at(-1)!
}
async function check() {
  await until(() => document.querySelector('.city-card-open')); click('.city-card-open')
  await until(() => document.querySelector('.sidebar-rail [aria-label="Analyze"]')); click('.sidebar-rail [aria-label="Analyze"]')
  await until(() => document.querySelector('.analysis-origin-toggle')); click('.analysis-origin-toggle')
  document.querySelector<HTMLDetailsElement>('.analysis-origin-coordinate-disclosure')!.open = true
  fill(document.querySelector('input[min="-90"]'), '38.9'); fill(document.querySelector('input[min="-180"]'), '-77.05')
  click('.analysis-origin-confirm'); mode('Bike')
  await until(() => document.querySelector('select[aria-label="Bike preference"]'))
  select('Bike preference', 'quiet'); select('Maximum bicycle traffic stress', '2')
  fill(document.querySelector('input[aria-label="Cycling speed"]'), '23')
  fill(field('Endpoint walk limit'), '0.35'); fill(field('Endpoint walking speed'), '4.65')
  const depart = await run()
  assert(depart.mode === 'bike' && depart.bike.profile === 'quiet' && depart.bike.speedKph === 23 && depart.bike.maxLts === 2, 'Bike settings missing')
  // The square holds everything the budget can cycle, not a fixed 8 km.
  const area = reachExtent('bike', Math.max(...depart.cutoffsMinutes), { profile: 'quiet', speedKph: 23 })
  assert(depart.surfaceSampling === 'cell-center' && depart.includeStreetEdges === false && depart.rasterSize === area.rasterSize && depart.radiusKm === area.radiusKm && area.radiusKm > 8, 'Bike grid settings incorrect: ' + JSON.stringify({ radiusKm: depart.radiusKm, rasterSize: depart.rasterSize, area }))
  assert(depart.maxWalkKm === 0.35 && depart.walkSpeedKph === 4.65 && !depart.monteCarlo, 'Endpoint or simulation settings incorrect')
  const arriveButton = [...document.querySelectorAll<HTMLButtonElement>('.reach-time-preference button')].find(b => b.textContent === 'Arrive by')!
  assert(arriveButton, 'Missing arrive-by'); flushSync(() => arriveButton.click())
  const arrive = await run()
  assert(arrive.timePreference === 'arrive' && arrive.destination.coordinate.join() === '-77.05,38.9' && !arrive.origin, 'Arrive-by place incorrect')
  mode('Transit & walk'); const transit = await run()
  assert(!Object.hasOwn(transit, 'bike'), 'Bike settings leaked into transit')
  assert(transit.rasterSize === 384, 'Bike preview resolution must not reduce transit resolution')
  mode('Bike'); select('Maximum bicycle traffic stress', ''); const cleared = await run()
  assert(cleared.bike.profile === 'quiet' && cleared.bike.speedKph === 23 && !Object.hasOwn(cleared.bike, 'maxLts'), 'Bike preferences were lost')
  return {status:'passed', requests, checks:['bike preferences','grid extent and resolution','endpoint settings','arrive-by','transit isolation','preserved choices','optional stress ceiling']}
}
const output = document.createElement('pre'); output.id = 'bike-reach-fixture-result'
Object.assign(output.style, {position:'fixed',right:'12px',bottom:'12px',zIndex:'99999',maxWidth:'380px',maxHeight:'220px',overflow:'auto',padding:'12px',background:'white',border:'1px solid #aaa',fontSize:'11px'})
document.body.append(output); output.textContent = 'Running Bike Reach checks…'
check().then(result => { output.dataset.status = 'passed'; output.textContent = JSON.stringify(result,null,2) }, error => { output.dataset.status = 'failed'; output.textContent = String(error); console.error(error) })
