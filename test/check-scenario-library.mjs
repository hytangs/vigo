import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeScenarioLibrary, readScenarioLibrary, scenarioLibraryPath, writeScenarioLibrary } from '../src/server/scenario-library.mjs'

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value))
  await fs.rename(`${file}.tmp`, file)
}

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-scenarios-'))
try {
  const change = {
    id: 'line', kind: 'add-line', name: 'Crosstown', stops: [
      { id: 'a', label: 'A', source: 'map', coordinate: [-71.08, 42.33], editStatus: 'added' },
      { id: 'b', label: 'B', source: 'route', coordinate: [-71.07, 42.35], stopId: 'place-b' },
    ], headwayMinutes: 8, averageSpeedKph: 24, startMinutes: 360, endMinutes: 1320, bidirectional: true,
    geometryMode: 'auto-road', geometryStatus: 'loading', geometryError: 'stale', unknownField: 'dropped',
  }
  const library = {
    groups: [{ id: 'baseline', name: 'Baseline', feedIds: ['mbta', 'mbta'] }, { id: 'future', name: 'Future', feedIds: ['mbta', 'rail-link'] }],
    scenarios: [{ id: 'case-a', name: 'Crosstown bus', groupId: 'future', changes: [change] }],
  }

  assert.deepEqual(await readScenarioLibrary(directory), { library: null, revision: 0 }, 'A City without saved scenarios has none.')
  const first = await writeScenarioLibrary(directory, library, 0, writeJsonAtomic)
  assert.equal(first.revision, 1)
  const saved = (await readScenarioLibrary(directory)).library
  assert.deepEqual(saved.groups[0].feedIds, ['mbta'], 'Repeated timetables collapse.')
  assert.equal(saved.scenarios[0].groupId, 'future', 'A scenario keeps the remix it runs on.')
  assert.equal(saved.scenarios[0].changes[0].geometryStatus, 'idle', 'Road matching in flight restarts after a reload.')
  assert.equal(saved.scenarios[0].changes[0].geometryError, undefined)
  assert.equal(saved.scenarios[0].changes[0].unknownField, undefined, 'Unknown fields are not stored.')
  assert.deepEqual(saved.scenarios[0].changes[0].stops[1].stopId, 'place-b')

  await assert.rejects(writeScenarioLibrary(directory, library, 0, writeJsonAtomic), error => {
    assert.equal(error.statusCode, 409, 'A stale window cannot overwrite newer scenarios.')
    assert.equal(error.revision, 1)
    assert.equal(error.library.scenarios[0].name, 'Crosstown bus')
    return true
  })

  // Concurrent saves from the same revision: exactly one wins.
  const results = await Promise.allSettled([1, 2].map(index => writeScenarioLibrary(directory,
    { ...library, scenarios: [{ ...library.scenarios[0], name: `Edit ${index}` }] }, 1, writeJsonAtomic)))
  assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected'], 'Writes for one City are serialized.')
  assert.equal((await readScenarioLibrary(directory)).revision, 2)

  for (const [label, value] of [
    ['an unknown change kind', { ...library, scenarios: [{ ...library.scenarios[0], changes: [{ ...change, kind: 'teleport' }] }] }],
    ['an invalid coordinate', { ...library, scenarios: [{ ...library.scenarios[0], changes: [{ ...change, stops: [{ ...change.stops[0], coordinate: [500, 0] }] }] }] }],
    ['repeated scenario ids', { ...library, scenarios: [library.scenarios[0], library.scenarios[0]] }],
    ['an unnamed group', { ...library, groups: [{ id: 'g', name: ' ', feedIds: [] }] }],
    ['too many scenarios', { ...library, scenarios: Array.from({ length: 49 }, (_, index) => ({ ...library.scenarios[0], id: `s${index}` })) }],
  ]) assert.throws(() => normalizeScenarioLibrary(value), error => error.statusCode === 400, `A library with ${label} is rejected.`)

  const legacy = normalizeScenarioLibrary({...library, scenarios:[library.scenarios[0], {...library.scenarios[0],id:'legacy-copy'}]});
  assert.notEqual(legacy.scenarios[0].changes[0].id, legacy.scenarios[1].changes[0].id, 'Legacy per-scenario IDs must not silently become shared');
  const shared = normalizeScenarioLibrary({ ...library, sharedChanges: [{ ...change, headwayMinutes: 6 }],
    scenarios: [{id:'a',name:'A',groupId:'baseline',changes:[change]}, {id:'b',name:'B',groupId:'baseline',changes:[change]}] });
  assert(shared.scenarios.every(scenario => scenario.changes[0].headwayMinutes === 6), 'Shared definitions must resolve identically in each scenario');
  const unused = normalizeScenarioLibrary({...shared, scenarios:shared.scenarios.map(scenario => ({...scenario,changes:[]}))});
  assert.equal(unused.sharedChanges[0].headwayMinutes, 6, 'Unassigned definitions must survive saving');
  assert.throws(() => normalizeScenarioLibrary({...library,sharedChanges:[change,change]}), /repeated id/);
  assert.throws(() => normalizeScenarioLibrary({...library,sharedChanges:[{...change,kind:'invalid'}]}), /kind/);
  const fullDefinitions = Array.from({length:3072}, (_, index) => ({...change,id:`saved-${index}`}));
  assert.throws(() => normalizeScenarioLibrary({...library,sharedChanges:fullDefinitions}), /at most 3072/, 'Embedded changes must not create a library that cannot be reopened');

  await fs.writeFile(scenarioLibraryPath(directory), '{"damaged":')
  await assert.rejects(readScenarioLibrary(directory), /kept unchanged/)
  await assert.rejects(writeScenarioLibrary(directory, library, 2, writeJsonAtomic), /kept unchanged/, 'A damaged copy is never overwritten.')
  assert.equal(await fs.readFile(scenarioLibraryPath(directory), 'utf8'), '{"damaged":')
} finally {
  await fs.rm(directory, { recursive: true, force: true })
}
console.log('Scenario libraries keep remixes and changes, reject stale or invalid writes, and never overwrite a damaged copy.')
