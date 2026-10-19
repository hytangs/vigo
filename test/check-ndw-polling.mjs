// Exercise the real Rust HTTP supervisor, producer and query worker against a
// controllable NDW HTTP source. No internet or provider clock dependency.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { gzipSync } from 'node:zlib'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary as binary } from './helpers/standalone-runtime.mjs'
const root = path.resolve(import.meta.dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-ndw-poll-'))
const city = path.join(dir, 'city')
const configTemplate = fs.readFileSync('crates/vigo-traffic/tests/fixtures/sites.xml', 'utf8')
  .replace('52 5 52 5.002', '38.9 -77.05 38.905 -77.04 38.91 -77.03')
const dataTemplate = fs.readFileSync('crates/vigo-traffic/tests/fixtures/measurements.xml', 'utf8')
  .replace('<roa:duration>30</roa:duration>', '<roa:duration>900</roa:duration>')
let sourceMode = 'failure', stamp = new Date().toISOString(), version = '4', configFetches = 0
// The authored fixture site is version 4; rotate it to exercise metadata refresh.
const fixtureVersion = configTemplate.match(/measurementSite\b[^>]*version="([^"]+)"/)[1]
version = fixtureVersion
const source = http.createServer((req, res) => {
  if (sourceMode === 'failure') { res.writeHead(503); res.end(); return }
  if (sourceMode === 'slow') { res.writeHead(200); res.write(' '); return }
  const config = req.url === '/sites'
  if (config) configFetches++
  if (sourceMode === 'invalid') { res.end(Buffer.from([0x1f, 0x8b, 0])); return }
  let xml = config ? configTemplate : dataTemplate.replaceAll('2026-10-19T06:07:00Z', stamp).replaceAll('2026-10-19T06:06:00Z', stamp)
  xml = xml.replaceAll(`version="${fixtureVersion}"`, `version="${version}"`)
  res.end(gzipSync(xml))
})
let server
const delay = (n) => new Promise(resolve => setTimeout(resolve, n))
async function until(fn, timeout = 20000) {
  const start = Date.now(); let last
  while (Date.now() - start < timeout) { try { last = await fn(); if (last) return last } catch {} await delay(50) }
  throw new Error(`Timed out; last=${JSON.stringify(last)}`)
}
try {
  const inputs = await writeCliFixtureInputs(dir)
  execFileSync(process.execPath, ['public/vigo.mjs', 'build', `--gtfs=${inputs.gtfsPath}`, `--osm=${inputs.osmPath}`, `--output=${city}`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] })
  source.listen(0, '127.0.0.1'); await once(source, 'listening')
  const probe = http.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening')
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const sourceUrl = `http://127.0.0.1:${source.address().port}`
  fs.writeFileSync(path.join(dir, 'ndw.json'), JSON.stringify({configurationUrl:`${sourceUrl}/sites`, measurementsUrl:`${sourceUrl}/data`, intervalSeconds:1, ttlSeconds:8, timeoutSeconds:1}))
  stamp = new Date().toISOString()
  server = spawn(binary, ['serve', '--city', city, '--port', String(port), '--ndw-poll', path.join(dir, 'ndw.json')], {cwd:root, stdio:['ignore','pipe','pipe'], env:{...process.env, RAYON_NUM_THREADS:'2'}})
  let stderr=''; server.stderr.on('data', v => {stderr+=v})
  const url=`http://127.0.0.1:${port}`
  const status=async () => (await fetch(`${url}/v1/traffic`)).json()
  const query={mode:'drive', serviceDate:'2026-07-15', time:'08:00', origin:{coordinate:[-77.05,38.9]},destination:{coordinate:[-77.03,38.91]}}
  const route=async q => { const r=await fetch(`${url}/v1/route`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(q)}); const v=await r.json(); assert.equal(r.status,200,JSON.stringify(v)); return v }
  await until(async () => (await status()).enabled)
  const pending=await route({...query,dataMode:'realtime'})
  assert.equal(pending.meta.traffic.status,'unavailable_fallback')
  stamp=new Date().toISOString(); sourceMode='good'
  await until(async () => (await status()).generation>0)
  const baseline=await route(query)
  const realtime=await route({...query,dataMode:'realtime'})
  assert.equal(realtime.meta.traffic.status,'applied',stderr)
  assert(realtime.journey.durationSeconds>baseline.journey.durationSeconds)
  const matrix=await (await fetch(`${url}/v1/matrix`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'drive',routingDataMode:'realtime',serviceDate:query.serviceDate,time:query.time,origins:[query.origin],destinations:[query.destination]})})).json()
  assert.equal(matrix.meta.traffic.status,'applied')
  assert.equal((await route({...query,routingDataMode:'scheduled'})).journey.durationSeconds,baseline.journey.durationSeconds)
  assert.equal((await route({...query,routingDataMode:'realtime',traffic:{observedAt:stamp,observations:[{coordinates:[[-77.05,38.9],[-77.04,38.905],[-77.03,38.91]],delayFactor:1}]}})).journey.durationSeconds,baseline.journey.durationSeconds)
  // A failed download keeps the last complete snapshot, which still expires.
  sourceMode='failure'
  const failed=await until(async()=> {const s=await status();return s.consecutiveFailures ? s : false})
  assert(failed.lastError && failed.nextAttemptAtMs>failed.lastAttemptAtMs)
  await until(async()=> (await status()).status==='stale_fallback')
  const stale=await route({...query,routingDataMode:'realtime'})
  assert.equal(stale.meta.traffic.status,'stale_fallback')
  assert.equal(stale.journey.durationSeconds,baseline.journey.durationSeconds)
  // Recovery joins against refreshed site versions; stale data is not stamped anew.
  sourceMode='good'; version='99'; stamp=new Date().toISOString()
  const generation=failed.generation
  await until(async()=> {const s=await status(); return s.generation>generation && s.status==='fresh' && !s.consecutiveFailures})
  assert(configFetches>=2)
  assert.equal((await route({...query,routingDataMode:'realtime'})).meta.traffic.status,'applied')
  const recoveredGeneration=(await status()).generation
  sourceMode='invalid'
  await until(async()=> (await status()).consecutiveFailures>0)
  assert.equal((await status()).generation,recoveredGeneration,'Malformed gzip cannot replace last good snapshot')
  // A timeout cannot stall baseline queries.
  sourceMode='slow'
  const before=(await status()).attempts
  await until(async()=> (await status()).attempts>before)
  const started=performance.now(); await route(query)
  assert(performance.now()-started<1000,'Polling must not block routing')
  console.log(JSON.stringify({status:'passed',configFetches, checks:['route','matrix','scheduled','inline override','failure retention','expiry','site version refresh','gzip failure','timeout isolation']}))
} finally {
  if(server){const closed=once(server,'exit');server.kill();await closed}
  source.closeAllConnections(); await new Promise(resolve=>source.close(resolve))
  fs.rmSync(dir,{recursive:true,force:true})
}
