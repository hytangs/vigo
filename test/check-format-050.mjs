// Permanent published-0.5 baseline. Never rebuild the frozen archive to fix a failure.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'
import { published050 } from './helpers/published-050.mjs'
const root = path.resolve(import.meta.dirname, '..')
const fixture = path.join(root, 'test/fixtures/format-0.5.0')
const manifest = JSON.parse(fs.readFileSync(path.join(fixture, 'manifest.json')))
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
for (const [file, expected] of Object.entries(manifest.files)) {
  assert.equal(fs.statSync(path.join(fixture, file)).size, expected.bytes)
  assert.equal(digest(path.join(fixture, file)), expected.sha256)
}
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-format-050-'))
const cli = process.env.VIGO_CLI_PATH || path.join(root, 'public/vigo.mjs')
const base = {serviceDate:manifest.serviceDate,time:'07:55',maxWalkKm:.2,requireTransitRide:true}
function verify(binary, city) {
  const run = (kind, request) => JSON.parse(execFileSync(binary, [kind,'--city',city,'--request','-'],
    {input:JSON.stringify({...base,...request}),encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024}))
  const endpoints = {origin:{stopId:'A'},destination:{stopId:'B'}}
  const route = run('route', endpoints)
  assert.equal(route.schema,'vigo.route.v1');assert.equal(route.status,'ok')
  assert.equal(route.journey.arrivalTime,'08:30:00')
  const arrive = run('route',{...endpoints,time:'08:35',timePreference:'arrive_by'})
  assert.equal(arrive.status,'ok');assert.equal(arrive.journey.departureTime,'08:00:00')
  const walk = run('route',{mode:'walk',requireTransitRide:false,maxWalkKm:5,
    origin:{coordinate:[-77.049,38.9005]},destination:{coordinate:[-77.031,38.9095]}})
  assert.equal(walk.status,'ok');assert(walk.journey.durationSeconds>0)
  const matrix = run('matrix',{origins:[{stopId:'A'}],destinations:[{stopId:'B'}]})
  assert.equal(matrix.schema,'vigo.matrix.v1');assert(matrix.durationsSeconds[0][0]>0)
  const reach = run('reach',{requireTransitRide:undefined,origin:{stopId:'A'},cutoffsMinutes:[45],rasterSize:16,
    bounds:[-77.06,38.89,-77.02,38.92],reachFormat:'map'})
  assert.equal(reach.schema,'vigo.reach.v1');assert.equal(reach.status,'ok')
}
try {
  const reference = await published050(temporary)
  execFileSync('tar',['-xzf',path.join(fixture,'city.tar.gz'),'-C',temporary])
  verify(standaloneBinary,path.join(temporary,'city'))
  const candidate = path.join(temporary,'candidate')
  execFileSync(process.execPath,[cli,'build','--gtfs',path.join(fixture,'fixture.zip'),
    '--gtfs-scope','fixture','--osm',path.join(fixture,'fixture.osm.pbf'),'--street-modes','walk',
    '--prepare-date',manifest.serviceDate,'--output',candidate],{cwd:root,stdio:['ignore','ignore','pipe'],timeout:120000})
  verify(reference,candidate)
  console.log('Published 0.5.0 City reader and writer compatibility passed: route, arrive-by, walk, matrix, reach.')
} finally { fs.rmSync(temporary,{recursive:true,force:true}) }
