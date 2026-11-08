import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { createPublicRoutingGateway } from '../src/server/public-routing-gateway.mjs'
import { searchAddresses } from '../src/server/address-search.mjs'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-public-cities-'))
await fs.writeFile(path.join(root, 'index.html'), '<html><body>Routes</body></html>')
const received = []
const originalFetch = globalThis.fetch
let release
const upstream = http.createServer(async (req, res) => {
  let input = ''; for await (const part of req) input += part
  received.push({ url: req.url, body: input ? JSON.parse(input) : null })
  if (release && req.url.endsWith('/national-route')) await new Promise(resolve => { release.resolve = resolve })
  const id = req.url.split('/')[3]?.split('?')[0]
  res.setHeader('content-type','application/json')
  res.end(JSON.stringify(req.url.includes('?detail=catalog') ? { project: { id, name: id, feeds: [], osmStreetIndex: { status: 'ready' } } } : { choices: [] }))
})
upstream.listen(0, '127.0.0.1'); await once(upstream,'listening')
const gateway = createPublicRoutingGateway({ upstream: `http://127.0.0.1:${upstream.address().port}`, publicOrigin: 'https://app.example.test', staticRoot: root, maxActive: 1,
  cities: [{cityId:'bos2',name:'Boston',realtimeRequest:{provider:'legacy'},bounds:[-72.5,41,-70,43.5]}, {cityId:'singapore',name:'Singapore',bounds:[103.59,1.15,104.1,1.49],timeZone:'Asia/Singapore',realtimeRequest:{provider:'legacy'},coverage:'Estimated weekday service'}] })
gateway.listen(0,'127.0.0.1'); await once(gateway,'listening')
const base = `http://127.0.0.1:${gateway.address().port}`
const post = (id, point) => fetch(`${base}/api/projects/${id}/national-route`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({origin:{coordinate:point},destination:{coordinate:point},mode:'walk'})})
try {
  const catalog = await (await fetch(base+'/api/projects')).json()
  assert.deepEqual(catalog.projects.map(p=>p.id),['bos2','singapore'])
  assert(catalog.projects.every(p=>p.publicRouting.realtime===false),'Every City disables live routing, including legacy configurations')
  assert.equal(catalog.projects[1].publicRouting.coverage,'Estimated weekday service')
  assert.equal((await post('singapore',[103.8,1.3])).status,200)
  assert.equal(received.at(-1).url,'/api/projects/singapore/national-route')
  await fetch(`${base}/api/projects/singapore/national-route`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({origin:{coordinate:[103.8,1.3]},destination:{coordinate:[103.85,1.3]},mode:'transit',routingDataMode:'realtime',departNow:true})})
  assert.equal(received.at(-1).body.routingDataMode,undefined,'Leave-now queries use the native clock with default scheduled provenance')
  assert.equal(received.at(-1).body.departNow,true)
  await fetch(`${base}/api/projects/singapore/national-ready`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'transit',routingDataMode:'realtime',departNow:true})})
  assert.equal(received.at(-1).body.routingDataMode,'scheduled')
  assert.equal(received.at(-1).body.departNow,undefined,'Readiness receives the City-local date')
  const localClock = Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Singapore',hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit'}).formatToParts(new Date()).map(p=>[p.type,p.value]))
  assert.equal(received.at(-1).body.serviceDate,`${localClock.year}-${localClock.month}-${localClock.day}`)
  assert.equal(Math.floor(received.at(-1).body.departMinutes / 60),Number(localClock.hour))
  assert.equal(received.filter(r=>r.url.endsWith('/agency')).length,0,'No City may fetch live feeds')
  assert.equal((await post('singapore',[-71,42])).status,400)
  assert.equal((await post('private',[103.8,1.3])).status,403)
  assert.equal((await fetch(base+'/api/projects',{headers:{Origin:'https://evil.test'}})).status,403)
  release = {}; const busy = post('bos2',[-71,42])
  while (!release.resolve) await new Promise(r=>setTimeout(r,5))
  assert.equal((await post('singapore',[103.8,1.3])).status,429,'Cities share the same concurrency budget')
  release.resolve(); release = null; await busy
  let called = 0
  const fetcher = async url => { called++; assert.equal(url.searchParams.get('bbox'),'103.59,1.15,104.1,1.49'); return {ok:true,json:async()=>({features:[
    {geometry:{type:'Point',coordinates:[103.85,1.28]},properties:{name:'Gardens by the Bay',city:'Singapore'}},
    {geometry:{type:'Point',coordinates:[-71,42]},properties:{name:'Wrong city'}},
    {geometry:{type:'Point',coordinates:[103.85,1.28]},properties:{name:'Gardens by the Bay',city:'Singapore'}},
  ]})} }
  const options={fetcher,endpoint:'https://geocoder.example.test/api/'}
  const result=await searchAddresses('Gardens by the Bay',[103.59,1.15,104.1,1.49],options)
  assert.equal(result.results.length,1,'Search filters out-of-region results and duplicates')
  assert.deepEqual(await searchAddresses('Gardens by the Bay',[103.59,1.15,104.1,1.49],options),result)
  assert.equal(called,1,'Repeated searches are cached')
  await assert.rejects(searchAddresses('x',null,options),{status:400})
  await assert.rejects(searchAddresses('valid',null,{fetcher:async()=>({ok:false}),endpoint:'https://fail.example.test/'}),{status:503})
  const canceled = new AbortController(); canceled.abort()
  await assert.rejects(searchAddresses('Gardens by the Bay',[103.59,1.15,104.1,1.49],{...options,signal:canceled.signal}),{name:'AbortError'},'Canceled queries must not return cached results')

  // Hold Photon responses without contacting the public service. A disconnected
  // autocomplete request must release its upstream slot before the next edit.
  const held = [], aborted = []
  globalThis.fetch = (url, init) => {
    const target = new URL(url)
    if (target.hostname !== 'photon.komoot.io') return originalFetch(url, init)
    const query = target.searchParams.get('q')
    if (!query.startsWith('Hold')) return Promise.resolve({ok:true,json:async()=>({features:[]})})
    return new Promise((resolve,reject) => {
      held.push({query,signal:init.signal,resolve:()=>resolve({ok:true,json:async()=>({features:[]})})})
      init.signal.addEventListener('abort',()=>{aborted.push(query);reject(init.signal.reason)},{once:true})
    })
  }
  const until = async predicate => {
    const deadline = Date.now() + 2000
    while (!predicate()) { assert(Date.now() < deadline,'Timed out waiting for request cancellation'); await new Promise(r=>setTimeout(r,5)) }
  }
  const address = (id, query, signal, ip='198.51.100.1') => originalFetch(`${base}/api/projects/${id}/address-search`,{
    method:'POST',headers:{'Content-Type':'application/json','cf-connecting-ip':ip},body:JSON.stringify({query}),signal,
  })
  const first = new AbortController(), second = new AbortController()
  const firstRequest = address('bos2','Hold first',first.signal).catch(error=>error)
  const secondRequest = address('singapore','Hold second',second.signal).catch(error=>error)
  await until(()=>held.length===2)
  assert.equal((await address('bos2','Third search')).status,429,'Cities share the two-lookup geocoder limit')
  assert.equal((await post('bos2',[-71,42])).status,200,'Pending geocoding must not block route computation')
  first.abort(); assert.equal((await firstRequest).name,'AbortError')
  await until(()=>aborted.includes('Hold first'))
  const replacement = address('bos2','Hold replacement')
  await until(()=>held.length===3)
  held[2].resolve(); assert.equal((await replacement).status,200,'Canceled lookups release capacity for new text')
  second.abort(); assert.equal((await secondRequest).name,'AbortError')
  await until(()=>aborted.includes('Hold second'))
  for (let i=0;i<60;i++) assert.equal((await address(i%2?'bos2':'singapore','Cached query',undefined,'198.51.100.2')).status,200)
  assert.equal((await address('bos2','Cached query',undefined,'198.51.100.2')).status,429,'Autocomplete keeps a bounded request budget shared across Cities')
  const routeAfterTyping = await originalFetch(`${base}/api/projects/bos2/national-route`,{method:'POST',headers:{'Content-Type':'application/json','cf-connecting-ip':'198.51.100.2'},body:JSON.stringify({origin:{coordinate:[-71,42]},destination:{coordinate:[-71,42]},mode:'walk'})})
  assert.equal(routeAfterTyping.status,200,'Autocomplete cannot exhaust the route query budget')
  console.log('Public Cities: catalog, region bounds, endpoint isolation, shared concurrency, geocoding cache/failure/cancellation and independent search budgets passed.')
} finally {
  globalThis.fetch = originalFetch
  gateway.closeAllConnections(); await gateway.shutdown()
  upstream.closeAllConnections(); await new Promise(r=>upstream.close(r))
  await fs.rm(root,{recursive:true,force:true})
}
