import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'
const root = path.resolve(import.meta.dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-endpoint-collection-'))
try {
  const { gtfsPath, osmPath } = await writeCliFixtureInputs(dir, { terminalAccess: true })
  const spec = { schemaVersion: 'vigo.scenarios.source.v1', privateAccess: 'endpoints',
    osm: { path: osmPath }, scenarios: ['a', 'b'].map(id => ({ id, feeds: [{ path: gtfsPath, scope: 'test' }] })) }
  const source = path.join(dir, 'source.json'), output = path.join(dir, 'collection')
  const build = ['public/vigo.mjs', 'build-scenarios', '--spec', source, '--output', output]
  for (const invalid of [{privateAccess:'all'}, {privateAccess:['endpoints']}, {privateAccess:'endpoints',wheelchair:true}]) {
    fs.writeFileSync(source, JSON.stringify({...spec,...invalid}))
    const result = spawnSync(process.execPath, build, {cwd:root,encoding:'utf8'})
    assert.notEqual(result.status,0)
    assert.match(result.stderr,/privateAccess/)
    assert(!fs.existsSync(output))
  }
  fs.writeFileSync(source, JSON.stringify(spec))
  const summary = JSON.parse(execFileSync(process.execPath, build, {cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}))
  assert.equal(summary.sharedStreetCopies,2)
  const moved = path.join(dir,'moved'); fs.renameSync(output,moved)
  const streets = spec.scenarios.map(({id})=>fs.realpathSync(path.join(moved,'cities',id,'osm')))
  assert.equal(new Set(streets).size,2,'Endpoint boundaries remain City-local')
  for (const {id} of spec.scenarios) {
    const manifest = JSON.parse(fs.readFileSync(path.join(moved,'cities',id,'network.json')))
    assert.equal(manifest.streetStore.terminalAccess.model,'authorized_endpoints')
    const result = JSON.parse(execFileSync(standaloneBinary,['route','--city',moved,'--scenario',id,'--request','-'],{
      input:JSON.stringify({mode:'transit',serviceDate:'2026-07-15',time:'07:55',maxWalkKm:.6,
        requireTransitRide:true,origin:{coordinate:[-77.054,38.9]},destination:{stopId:'B'}}),encoding:'utf8'}))
    assert.equal(result.status,'ok',JSON.stringify(result))
  }
  console.log('Scenario endpoint access passed')
} finally { fs.rmSync(dir,{ recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) }
