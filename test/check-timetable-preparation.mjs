import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { prepareNativeTimetableIndexes, readNativeServiceTimetable } from '../src/server/native-routing-kernel.mjs'
import { prepareTimetableIndexes } from '../src/server/gtfs/timetable-preparation.mjs'
import { stationFallbackSeconds } from '../src/server/station-access.mjs'

// Independent reference: scan departures per stop, then use ordered JS Maps
// for transfer precedence. This is test-only; production has no JS fallback.
function reference(input) {
  const n = input.retainedStops.length, departureOffset = [0], departureOrder = []
  const transferOffset = [0], transferTo = [], transferDuration = []
  for (let stop = 0; stop < n; stop++) {
    departureOrder.push(...Array.from(input.fromStop.keys()).filter(i => input.fromStop[i] === stop && input.canBoard[i])
      .sort((a, b) => input.departureSeconds[a] - input.departureSeconds[b] || a - b))
    departureOffset.push(departureOrder.length)
  }
  const forbidden = new Set(Array.from(input.forbiddenFrom, (from, i) => `${from}:${input.forbiddenTo[i]}`))
  const rows = Array.from({ length: n }, () => new Map())
  let sourceExpandedTransferEdges = 0, excludedNonServiceTransferEdges = 0, excludedNonServiceStationMembers = 0
  for (let i = 0; i < input.transferFrom.length; i++) {
    const from = input.transferFrom[i], to = input.transferTo[i]
    if (forbidden.has(`${from}:${to}`)) continue
    sourceExpandedTransferEdges++
    if (!input.retainedStops[to]) { excludedNonServiceTransferEdges++; continue }
    if (from === 0xffffffff || from === to) continue
    const seconds = Number.isFinite(input.transferSeconds[i]) ? Math.max(0, input.transferSeconds[i]) : 0
    rows[from].set(to, Math.min(rows[from].get(to) ?? Infinity, seconds))
  }
  for (let i = 1; i < input.stationOffset.length; i++) {
    const unique = [...new Set(input.stationMembers.slice(input.stationOffset[i - 1], input.stationOffset[i]))]
    const members = unique.filter(stop => input.retainedStops[stop])
    excludedNonServiceStationMembers += unique.length - members.length
    for (const from of members) for (const to of members) {
      if (from === to || forbidden.has(`${from}:${to}`) || rows[from].has(to)) continue
      const point = stop => ({ lon: input.coordinates[stop * 2], lat: input.coordinates[stop * 2 + 1] })
      const seconds = stationFallbackSeconds(point(from), point(to), input.walkingSpeedKph)
      rows[from].set(to, Number.isFinite(seconds) ? seconds : 0)
    }
  }
  for (const row of rows) {
    for (const [to, seconds] of row) { transferTo.push(to); transferDuration.push(seconds) }
    transferOffset.push(transferTo.length)
  }
  return { departureOffset, departureOrder, transferOffset, transferTo, transferDuration: Array.from(Uint32Array.from(transferDuration)),
    sourceExpandedTransferEdges, excludedNonServiceTransferEdges, excludedNonServiceStationMembers }
}
const typed = (input) => Object.fromEntries(Object.entries(input).map(([key, value]) => [key,
  ['coordinates', 'transferSeconds'].includes(key) ? Float64Array.from(value)
    : ['canBoard', 'retainedStops'].includes(key) ? Uint8Array.from(value)
      : Array.isArray(value) ? Uint32Array.from(value) : value]))
const plain = result => Object.fromEntries(Object.entries(result).map(([key, value]) => [key, ArrayBuffer.isView(value) ? Array.from(value) : value]))
const base = typed({ departureSeconds: [30, 10, 10, 0], fromStop: [0, 0, 0, 1], canBoard: [1, 1, 1, 0],
  retainedStops: [1, 1, 0], coordinates: [0, 0, .01, 0, .02, 0],
  transferFrom: [0, 0, 1, 2, 0, 0xffffffff], transferTo: [1, 1, 0, 1, 2, 1], transferSeconds: [900, 600, 0, 0, 4, 3],
  forbiddenFrom: [1], forbiddenTo: [0], stationOffset: [0, 4], stationMembers: [0, 1, 2, 2], walkingSpeedKph: 4.8 })
assert.deepEqual(plain(prepareNativeTimetableIndexes(base)), reference(base))
assert.deepEqual(reference(base).transferDuration, [600, 0], 'Published minimum wins over faster station fallback; non-service origins may transfer to service')
let seed = 411
const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n }
for (let trial = 0; trial < 300; trial++) {
  const n = 1 + random(24), segments = random(150), edges = random(120)
  const input = typed({
    departureSeconds: Array.from({ length: segments }, () => random(30)), fromStop: Array.from({ length: segments }, () => random(n)),
    canBoard: Array.from({ length: segments }, () => random(2)), retainedStops: Array.from({ length: n }, () => random(2)),
    coordinates: Array.from({ length: n * 2 }, () => random(10000) / 10000),
    transferFrom: Array.from({ length: edges }, () => random(8) ? random(n) : 0xffffffff),
    transferTo: Array.from({ length: edges }, () => random(8) ? random(n) : 0xffffffff),
    transferSeconds: Array.from({ length: edges }, () => [0, -1, NaN, Infinity, 2 ** 32 + 5, random(1000) + .8][random(6)]),
    forbiddenFrom: Array.from({ length: n }, () => random(n)), forbiddenTo: Array.from({ length: n }, () => random(n)),
    stationOffset: [0, n, n * 2], stationMembers: Array.from({ length: n * 2 }, () => random(n)), walkingSpeedKph: 1.5 + random(650) / 100,
  })
  assert.deepEqual(plain(prepareNativeTimetableIndexes(input)), reference(input), `Seeded graph ${trial}`)
}
const empty = typed({ departureSeconds: [], fromStop: [], canBoard: [], retainedStops: [], coordinates: [], transferFrom: [], transferTo: [], transferSeconds: [], forbiddenFrom: [], forbiddenTo: [], stationOffset: [0], stationMembers: [], walkingSpeedKph: 4.8 })
assert.deepEqual(plain(prepareNativeTimetableIndexes(empty)), reference(empty))
for (const override of [
  { coordinates: new Float64Array(1) }, { fromStop: Uint32Array.of(4, 0, 0, 1) }, { canBoard: Uint8Array.of(2, 1, 1, 0) },
  { transferTo: new Uint32Array(0) }, { transferFrom: Uint32Array.of(3, 0, 1, 2, 0, 0) },
  { stationOffset: Uint32Array.of(0, 5, 4) }, { stationMembers: Uint32Array.of(0, 1, 3, 2) },
  { forbiddenFrom: Uint32Array.of(3) }, { walkingSpeedKph: 0 }, { walkingSpeedKph: NaN },
]) assert.throws(() => prepareNativeTimetableIndexes({ ...base, ...override }), /Timetable preparation/)
const ids = ['A', 'B', 'C'], index = new Map(ids.map((id, i) => [id, i]))
const store = { stopRecords: new Map(ids.map((id, i) => [id, { lon: i * .01, lat: 0 }])),
  transfers: new Map([['A', [{ to_stop_id: 'B', min_transfer_time: 900 }, { to_stop_id: 'B', min_transfer_time: 600 }, { to_stop_id: 'C', min_transfer_time: 4 }]],
    ['B', [{ to_stop_id: 'A', min_transfer_time: 0 }]], ['C', [{ to_stop_id: 'B', min_transfer_time: 0 }]],
    ['missing', [{ to_stop_id: 'B', min_transfer_time: 3 }, { to_stop_id: 'absent', min_transfer_time: 2 }]]]),
  forbiddenTransferPairs: new Set(['B\u0000A', 'missing\u0000absent']), stationMembers: new Map([['station', ['A', 'B', 'C', 'C', 'missing']]]) }
assert.deepEqual(plain(prepareTimetableIndexes(store, ids, index, base.retainedStops, { departureSeconds: base.departureSeconds, fromStop: base.fromStop, canBoard: base.canBoard })), reference(base))
// A stale binding or a failing native operator must fail, never select a JS
// implementation or silently substitute another installed native binding.
const fixture = mkdtempSync(path.join(tmpdir(), 'vigo-required-preparation-'))
try {
  const storePath = path.join(fixture, 'source.sqlite')
  const db = new DatabaseSync(storePath)
  db.exec(`CREATE TABLE connections(departure INTEGER,arrival INTEGER,trip_id TEXT,route_id TEXT,service_id TEXT,direction_id TEXT,from_stop_id TEXT,to_stop_id TEXT,stop_sequence INTEGER,PRIMARY KEY(trip_id,stop_sequence)) WITHOUT ROWID;
    CREATE TABLE connection_permissions(trip_id TEXT,stop_sequence INTEGER,can_board INTEGER,can_alight INTEGER,PRIMARY KEY(trip_id,stop_sequence)) WITHOUT ROWID;`)
  const insert = db.prepare('INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?)')
  for (const row of [
    [10,20,'a','r','s',null,'A','B',1],
    [20,30,'a','r','s',null,'B','C',2],
    [40,50,'a','r','s',null,'D','E',4], // admitted untimed gap
    [50,60,'a','r','s',null,'A','B',5], // unsafe discontinuity
    [70,80,'b','r','s','1','B','A',1],
    [90,100,'inactive','r','off','0','A','B',1],
  ]) insert.run(...row)
  db.exec("INSERT INTO connection_permissions VALUES('a',2,0,1)")
  db.close()
  const sourceInput = { storePath, stopIds: ['A','B'], serviceIds: ['s'], hasConnectionPermissions: true, segmentCount: 5 }
  const compiled = readNativeServiceTimetable(sourceInput)
  assert.deepEqual(compiled.stopIds, ['A','B','C','D','E'])
  for (const [name, expected] of Object.entries({
    departureSeconds: [10,20,40,50,70], arrivalSeconds: [20,30,50,60,80],
    fromStop: [0,1,3,0,1], toStop: [1,2,4,1,0], sequence: [1,2,4,5,1],
    segmentTrip: [0,0,0,0,1], segmentRun: [0,0,0,1,2], continuityBreak: [0,0,0,1,0],
    canBoard: [1,0,1,1,1], canAlight: [1,1,1,1,1], tripStart: [0,4,5],
  })) assert.deepEqual([...compiled[name]], expected, name)
  assert.deepEqual(readNativeServiceTimetable({ ...sourceInput, segmentCount: undefined }), compiled)
  assert.equal(compiled.runCount, 3)
  assert.deepEqual(compiled.directionIds, ['', '1'])
  assert.deepEqual([...readNativeServiceTimetable({ ...sourceInput, hasConnectionPermissions: false }).canBoard], [1,1,1,1,1])
  assert.throws(() => readNativeServiceTimetable({ ...sourceInput, segmentCount: 4 }), /slice changed/)
  assert.throws(() => readNativeServiceTimetable({ ...sourceInput, segmentCount: 6 }), /slice changed/)
  assert.equal(readNativeServiceTimetable({ ...sourceInput, serviceIds: [], segmentCount: 0 }).runCount, 0)
  const binding = path.join(fixture, 'binding.cjs')
  for (const [source, message, operator = 'prepareNativeTimetableIndexes'] of [
    ['module.exports = {}', 'lacks timetable preparation'],
    ['module.exports = {}', 'lacks service timetable compilation', 'readNativeServiceTimetable'],
    ['module.exports = {}', 'lacks realtime compilation', 'compileNativeRealtimeTimetable'],
    ['module.exports = {}', 'lacks station path compilation', 'compileNativeStationPaths'],
    ['module.exports = {}', 'lacks station path validation', 'validateNativeStationPaths'],
    ["exports.compileRealtimeTimetable = () => { throw Error('fixture native failure') }", 'fixture native failure', 'compileNativeRealtimeTimetable'],
    ["exports.compileStationPaths = () => { throw Error('fixture native failure') }", 'fixture native failure', 'compileNativeStationPaths'],
    ["exports.prepareTimetableIndexes = () => { throw Error('fixture native failure') }", 'fixture native failure'],
  ]) {
    writeFileSync(binding, source)
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict'
      import { ${operator} as execute } from ${JSON.stringify(new URL('../src/server/native-routing-kernel.mjs', import.meta.url).href)}
      assert.throws(() => execute({}), new RegExp(${JSON.stringify(message)}))
    `], { env: { ...process.env, VIGO_NATIVE_ROUTING_KERNEL: binding }, encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
  }
} finally { rmSync(fixture, { recursive: true, force: true }) }
console.log('Native timetable preparation: 300 seeded graphs, ordering, transfer precedence, station projection, malformed arrays and source identity adapter passed.')
