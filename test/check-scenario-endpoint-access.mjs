import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'
const root = path.resolve(import.meta.dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-endpoint-collection-'))
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const execute = (binary, city, requests, residents = 3) => {
  const result = execFileSync(binary, ['stream', '--city', city], {
    input: requests.map(q => JSON.stringify(q)).join('\n') + '\n', encoding: 'utf8',
    env: { ...process.env, VIGO_MAX_RESIDENT_SCENARIOS: String(residents) }, timeout: 60000,
  })
  return result.trim().split('\n').map(line => JSON.parse(line))
}
try {
  const { gtfsPath, osmPath } = await writeCliFixtureInputs(dir, { terminalAccess: true })
  const alternative = await JSZip.loadAsync(fs.readFileSync(gtfsPath))
  // Put a stop on the otherwise disconnected public footway at the home end
  // of the private access link. This changes the authorized boundary set.
  alternative.file('stops.txt', (await alternative.file('stops.txt').async('string')).replace('38.900,-77.050', '38.900,-77.054'))
  const otherFeed = path.join(dir, 'other.zip')
  fs.writeFileSync(otherFeed, await alternative.generateAsync({ type: 'nodebuffer' }))
  const spec = { schemaVersion: 'vigo.scenarios.source.v1', privateAccess: 'endpoints',
    osm: { path: osmPath }, maximumResidentScenarios: 3,
    scenarios: ['a', 'b', 'c'].map(id => ({ id, feeds: [{ path: id === 'b' ? otherFeed : gtfsPath, scope: 'test' }] })) }
  const source = path.join(dir, 'source.json'), output = path.join(dir, 'collection')
  const build = ['public/vigo.mjs', 'build-scenarios', '--spec', source, '--output', output]
  for (const invalid of [{ privateAccess: 'all' }, { privateAccess: ['endpoints'] }, { privateAccess: 'endpoints', wheelchair: true }]) {
    fs.writeFileSync(source, JSON.stringify({ ...spec, ...invalid }))
    const result = spawnSync(process.execPath, build, { cwd: root, encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /privateAccess/)
    assert(!fs.existsSync(output))
  }
  fs.writeFileSync(source, JSON.stringify(spec))
  const summary = JSON.parse(execFileSync(process.execPath, build, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  assert.equal(summary.sharedStreetCopies, 1)
  const moved = path.join(dir, 'moved'); fs.renameSync(output, moved)
  const locals = spec.scenarios.map(({ id }) => path.join(moved, 'cities', id, 'osm'))
  const base = 'street-index.sqlite.street-accelerator-v7.bin'
  const overlay = 'street-index.sqlite.terminal-access-v1.json'
  assert.equal(new Set(locals.map(p => fs.realpathSync(path.join(p, base)))).size, 1)
  assert.equal(new Set(locals.map(p => fs.realpathSync(path.join(p, overlay)))).size, 3)
  assert.notEqual(digest(path.join(locals[0], overlay)), digest(path.join(locals[1], overlay)), 'Fixture must have distinct timetable boundaries')
  for (const local of locals) {
    for (const name of fs.readdirSync(local)) {
      const member = path.join(local, name)
      const cch = name.endsWith('.structure') || name.endsWith('.metric')
      assert.equal(fs.lstatSync(member).isSymbolicLink(), name !== overlay && !cch)
      if (name !== overlay) {
        if (cch) assert.equal(new Set(locals.map(p => { const s = fs.statSync(path.join(p, name)); return `${s.dev}:${s.ino}` })).size, 1)
        else assert(!path.isAbsolute(fs.readlinkSync(member)))
      }
    }
  }
  const checksums = JSON.parse(fs.readFileSync(path.join(moved, 'checksums.json')))
  for (const file of checksums.files) assert.equal(digest(path.join(moved, file.path)), file.sha256)
  assert.equal(checksums.files.filter(f => f.path.endsWith(base)).length, 1)
  assert.equal(checksums.files.filter(f => f.path.endsWith(overlay)).length, 3)
  const policy = { mode: 'transit', serviceDate: '2026-07-15', time: '07:55', maxWalkKm: .6, requireTransitRide: true }
  const origin = { coordinate: [-77.054, 38.9] }, destination = { stopId: 'B' }
  const queries = [
    { ...policy, kind: 'route', origin, destination },
    { ...policy, kind: 'matrix', origins: [origin, { stopId: 'A' }], destinations: [destination], time: '08:35', timePreference: 'arrive_by', includeJourneys: true },
    { ...policy, kind: 'matrix', origins: [origin], destinations: [destination, { stopId: 'X' }], includeJourneys: true },
    { kind: 'route', mode: 'walk', time: '07:55', serviceDate: '2026-07-15', origin, destination: { coordinate: [-77.05, 38.9] }, maxWalkKm: 2 },
  ]
  const content = value => { const { meta, sequence, scenarioId, ...rest } = value; return rest }
  const isolated = {}
  for (const { id, feeds } of spec.scenarios) {
    const city = path.join(dir, 'isolated-' + id)
    execFileSync(process.execPath, ['public/vigo.mjs', 'build', '--gtfs', feeds[0].path, '--gtfs-scope', 'test', '--osm', osmPath,
      '--private-access', 'endpoints', '--output', city], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] })
    isolated[id] = execute(standaloneBinary, city, queries).map(content)
    assert.equal(isolated[id][0].status, 'ok')
    assert.equal(digest(path.join(city, 'osm', overlay)), digest(path.join(moved, 'cities', id, 'osm', overlay)))
    if (process.env.VIGO_REFERENCE_RC1_PATH) {
      assert.deepEqual(execute(process.env.VIGO_REFERENCE_RC1_PATH, path.join(moved, 'cities', id), queries).map(content), isolated[id], 'Published reader opens shared-base City')
    }
  }
  for (const residents of [1, 2, 3]) {
    const order = ['a', 'b', 'c', 'b', 'a', 'c']
    const requests = order.flatMap(scenarioId => queries.map(q => ({ ...q, scenarioId })))
    requests.push({ kind: 'info' })
    const results = execute(standaloneBinary, moved, requests, residents)
    const info = results.pop()
    assert.deepEqual(results.map(content), order.flatMap(id => isolated[id]), 'Scenario switching/eviction must preserve isolated overlay journeys')
    assert.equal(info.residency.sharedStreetGraphs, 1)
    assert.equal(info.residency.loadedScenarios, residents)
    const ledgers = info.residency.scenarios.map(s => s.memory.ledger)
    assert.equal(info.memory.mappedFileBytes, ledgers[0].street.sharedMappedFileBytes
      + ledgers.reduce((sum, s) => sum + s.street.accessMappedFileBytes + s.contextMappedFileBytes, 0))
  }
  console.log('Shared base streets with distinct endpoint overlays passed: relocation, isolated parity, resident switching, eviction, checksums and memory accounting')
} finally { fs.rmSync(dir, { recursive: true, force: true }) }
