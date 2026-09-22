import assert from 'node:assert/strict'
import { emptyScenarios, parseStoredScenarios, scenarioStorageKey } from '../src/app/scenarioDraftStorage.ts'

const change = { id: 'change', kind: 'change-line', name: 'Detour', headwayMinutes: 10, averageSpeedKph: 20,
  startMinutes: 480, endMinutes: 1080, bidirectional: true, geometryStatus: 'loading',
  stops: [{ id: 'stop', label: 'New stop', source: 'map', coordinate: [-71, 42] }] }
const draft = { cases: [{ id: 'case', name: 'Case', interventions: [change] }], activeCaseId: 'case', activeChangeId: 'change' }
const restored = parseStoredScenarios(JSON.stringify(draft))
assert.equal(restored.cases[0].interventions[0].geometryStatus, 'idle', 'Interrupted geometry work must be restartable.')
assert.deepEqual(restored.cases[0].interventions[0].stops, change.stops)
assert.equal(restored.activeChangeId, 'change')
assert.deepEqual(parseStoredScenarios(null), emptyScenarios())
assert.equal(parseStoredScenarios(JSON.stringify({ ...draft, activeCaseId: 'missing', activeChangeId: 'missing' })).activeChangeId, '')
for (const text of ['{', 'null', '{}', JSON.stringify({ ...draft, cases: [draft.cases[0], draft.cases[0]] }),
  JSON.stringify({ ...draft, cases: [{ ...draft.cases[0], interventions: [{ ...change, inferredSegmentGeometry: [null] }] }] })]) {
  assert.throws(() => parseStoredScenarios(text), /stored copy has been kept/)
}
const city = { id: 'city', storagePath: '/library/city', name: 'City',
  feeds: [{ id: 'feed-a', importedAt: 'first' }, { id: 'feed-b', importedAt: 'second' }] }
const key = scenarioStorageKey(city)
assert.equal(scenarioStorageKey({ ...city, name: 'Renamed', updatedAt: 'later', feeds: [...city.feeds].reverse() }), key)
assert.equal(scenarioStorageKey({ ...city, feeds: city.feeds.map((feed) => ({ ...feed, routingStore: { builtAt: 'merged store hydration' } })) }), key,
  'Loading feed detail from the merged project store must not change the draft revision.')
assert.notEqual(scenarioStorageKey({ ...city, routingStore: { builtAt: 'rebuilt project' } }), key)
assert.notEqual(scenarioStorageKey({ ...city, id: 'other' }), key)
assert.notEqual(scenarioStorageKey({ ...city, feeds: [{ ...city.feeds[0], importedAt: 'rebuilt' }] }), key)
assert.notEqual(scenarioStorageKey({ ...city, osmStreetIndex: { builtAt: 'new streets' } }), key)
assert.equal(scenarioStorageKey(undefined), '')
console.log('Scenario drafts preserve edits and selections, isolate City revisions, and reject damaged storage.')
