import assert from 'node:assert/strict'
import { emptyScenarios, parseStoredScenarios } from '../src/app/scenarioDraftStorage.ts'

const change = { id: 'change', kind: 'change-line', name: 'Detour', headwayMinutes: 10, averageSpeedKph: 20,
  startMinutes: 480, endMinutes: 1080, bidirectional: true, geometryStatus: 'loading',
  stops: [{ id: 'stop', label: 'New stop', source: 'map', coordinate: [-71, 42] }] }
const draft = { cases: [{ id: 'case', name: 'Case', interventions: [change] }], activeCaseId: 'case', activeChangeId: 'change' }
const restored = parseStoredScenarios(JSON.stringify(draft))
assert.equal(restored.cases[0].interventions[0].geometryStatus, 'idle', 'Interrupted geometry work must be restartable.')
assert.deepEqual(restored.cases[0].interventions[0].stops, change.stops)
assert.equal(restored.activeChangeId, 'change')
for (const scheduleMode of ['preserve-trips', 'frequency']) {
  const saved = { ...draft, cases: [{ ...draft.cases[0], interventions: [{ ...change, scheduleMode }] }] }
  assert.equal(parseStoredScenarios(JSON.stringify(saved)).cases[0].interventions[0].scheduleMode, scheduleMode,
    'Reopening a saved draft must retain its explicit departure mode.')
}
assert.throws(() => parseStoredScenarios(JSON.stringify({ ...draft,
  cases: [{ ...draft.cases[0], interventions: [{ ...change, scheduleMode: 'unknown' }] }],
})), /stored copy has been kept/)
assert.deepEqual(parseStoredScenarios(null), emptyScenarios())
assert.equal(parseStoredScenarios(JSON.stringify({ ...draft, activeCaseId: 'missing', activeChangeId: 'missing' })).activeChangeId, '')
for (const text of ['{', 'null', '{}', JSON.stringify({ ...draft, cases: [draft.cases[0], draft.cases[0]] }),
  JSON.stringify({ ...draft, cases: [{ ...draft.cases[0], interventions: [{ ...change, inferredSegmentGeometry: [null] }] }] })]) {
  assert.throws(() => parseStoredScenarios(text), /stored copy has been kept/)
}
console.log('Scenario drafts preserve edits and selections, and reject damaged storage.')
