import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { compileReachScenario } from '../src/server/reach.mjs'

function compile(relative, replacements = []) {
  let output = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText
  for (const [from, to] of replacements) output = output.replace(`from '${from}'`, `from '${to}'`)
  return `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
}
const { scenarioSegmentRuntimeMinutes, scenarioEdgeGeometryForBranch, joinScenarioSegmentGeometry } = await import(compile('../src/reach.ts', [
  ['./app/geometry', compile('../src/app/geometry.ts')],
  ['./networkTruth', compile('../src/networkTruth.ts')],
]))
assert.deepEqual(joinScenarioSegmentGeometry([
  [[0, 0], [0.001, 0]],
  [[0.001, 0], [0.002, 0]],
  [[0.002, 0.0001], [0.003, 0.0001]],
]), [[0, 0], [0.001, 0], [0.002, 0], [0.002, 0.0001], [0.003, 0.0001]],
'Joining shape and road segments must retain distinct boundary coordinates and deduplicate shared stops.')
assert.deepEqual(joinScenarioSegmentGeometry([[[0, 0], [0, 0]]]), [[0, 0], [0, 0]],
  'Stops snapped to the same road node still need a valid two-coordinate segment.')
const stops = [
  { id: 'A', stopId: 'A', baselineStopId: 'A', coordinate: [0, 0], editStatus: 'baseline' },
  { id: 'inserted', coordinate: [0.005, 0.01], editStatus: 'inserted' },
  { id: 'B', stopId: 'B', baselineStopId: 'B', coordinate: [0.01, 0], editStatus: 'baseline' },
]
const runtimes = scenarioSegmentRuntimeMinutes({
  id: 'pattern', stopIds: ['A', 'B'], coordinates: [[0, 0], [0.01, 0]], geometrySource: 'shape',
}, stops, {
  stops: [{ id: 'A', lon: 0, lat: 0 }, { id: 'B', lon: 0.01, lat: 0 }],
  stopPairs: [{ patternId: 'pattern', fromStopId: 'A', toStopId: 'B', medianRuntimeMinutes: 10, sequence: 1 }],
}, { segmentDistancesKm: [1, 3] })
assert.deepEqual(runtimes, [2.5, 7.5], 'A road detour must preserve the original A → B runtime.')
const service = {
  stops, timeModel: 'infer-road', segmentDistancesKm: [1, 3], segmentRuntimeMinutes: runtimes,
  addedStopDwellMinutes: 0.35, averageSpeedKph: 30, dwellMinutes: 0.5,
}
function offsets(value) {
  return compileReachScenario({ services: [value] }).overlay.directionStopOffsetsSeconds.map((number) => Math.round(number * 1e6) / 1e6)
}
assert.deepEqual(offsets(service), [0, 171, 621, 0, 471, 621], 'Inserted dwell belongs to the inserted stop in both directions.')
assert.deepEqual(offsets({ ...service, segmentRuntimeMinutes: undefined, addedStopDwellMinutes: 0, segmentDistancesKm: [2, 3] }),
  [0, 270, 660, 0, 390, 660], 'New line timing must use road distances, including the reverse direction.')
assert.throws(() => offsets({ ...service, segmentRuntimeMinutes: [10] }), /one value per stop pair/)
assert.throws(() => offsets({ ...service, segmentDistancesKm: [null, 3] }), /finite number/)
assert.throws(() => compileReachScenario({ services: 'invalid' }), /must be an array/)
assert.throws(() => compileReachScenario('invalid'), /must be an object/)
assert.throws(() => offsets({ ...service, segmentRuntimeMinutes: undefined, segmentDistancesKm: undefined }), /requires road distances/)
console.log('Scenario timing preserves published runtimes and uses road distance for new lines.')

const branch = { id: 'sibling', stopIds: ['X', 'A', 'B', 'Y'], geometrySource: 'shape',
  coordinates: [[-0.02, 0], [-0.015, 0.005], [0, 0], [0.01, 0], [0.015, -0.005], [0.02, 0]] }
const branchPreview = { stops: [{ id: 'X', lon: -0.02, lat: 0 }, { id: 'A', lon: 0, lat: 0 },
  { id: 'B', lon: 0.01, lat: 0 }, { id: 'Y', lon: 0.02, lat: 0 }],
  stopPairs: [{ patternId: 'sibling', fromStopId: 'A', toStopId: 'B', medianRuntimeMinutes: 12, sequence: 2 }] }
const editedStops = stops.map((stop) => stop.id === 'inserted'
  ? { ...stop, anchorBeforeStopId: 'A', anchorAfterStopId: 'B' } : stop)
const change = { stops: editedStops, inferredSegmentGeometry: [[[0, 0], [0.005, 0.01]], [[0.005, 0.01], [0.01, 0]]],
  inferredSegmentDistanceKm: [1, 3] }
const sibling = scenarioEdgeGeometryForBranch(change, branch, branchPreview)
assert.deepEqual(sibling.geometry, [[-0.02, 0], [-0.015, 0.005], [0, 0], [0.005, 0.01],
  [0.01, 0], [0.015, -0.005], [0.02, 0]], 'The sibling must keep its own untouched shape and receive the edited gap.')
assert.deepEqual(sibling.segmentDistancesKm.slice(1, 3), [1, 3])
const siblingStops = [{ id: 'X', stopId: 'X', coordinate: [-0.02, 0], editStatus: 'baseline' }, ...editedStops,
  { id: 'Y', stopId: 'Y', coordinate: [0.02, 0], editStatus: 'baseline' }]
const siblingRuntimes = scenarioSegmentRuntimeMinutes(branch, siblingStops, branchPreview, { segmentDistancesKm: sibling.segmentDistancesKm })
assert.deepEqual(siblingRuntimes.slice(1, 3), [3, 9], 'Each branch must preserve its own A → B runtime.')
assert.equal(scenarioEdgeGeometryForBranch({ ...change, inferredSegmentGeometry: undefined }, branch, branchPreview), undefined,
  'Incomplete inferred geometry must require a rebuild instead of substituting the original shape.')
console.log('Exact-edge edits preserve sibling shapes and runtimes.')
