// Arrive-by Reach: where a destination can be reached from by a deadline.
// Node builds the public synthetic Cities; every query runs the Rust binary.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary as binary } from './helpers/standalone-runtime.mjs'

const root = path.resolve(import.meta.dirname, '..')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-arrive-reach-'))
const env = { PATH: '', NODE_PATH: '', RAYON_NUM_THREADS: '2' }
const serviceDate = '2026-07-15'

async function build(name, options) {
  const inputs = path.join(directory, name)
  fs.mkdirSync(inputs)
  const { gtfsPath, osmPath } = await writeCliFixtureInputs(inputs, options)
  const city = path.join(directory, `${name}-city`)
  execFileSync(process.execPath, [path.join(root, 'public/vigo.mjs'), 'build', `--gtfs=${gtfsPath}`, `--osm=${osmPath}`, `--output=${city}`], { stdio: ['ignore', 'ignore', 'pipe'] })
  return city
}
const invoke = (city, kind, request) => spawnSync(binary, [kind, '--city', city, '--request', '-'],
  { input: JSON.stringify({ ...request, diagnostics: 'trace' }), env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
function run(city, kind, request) {
  const p = invoke(city, kind, request)
  assert.equal(p.status, 0, p.stderr)
  const result = JSON.parse(p.stdout)
  return result.trace ?? result
}
function rejects(city, kind, request, pattern) {
  const p = invoke(city, kind, request)
  assert.equal(p.status, 2, p.stdout)
  assert.match(p.stderr, pattern)
}
const reached = values => values.filter(value => value !== null).length
function cellAt({ bounds: [west, south, east, north], width, height, values }, [longitude, latitude]) {
  const x = Math.floor((longitude - west) / (east - west) * width)
  const y = Math.floor((north - latitude) / (north - south) * height)
  return values[y * width + x]
}

try {
  const city = await build('standard')
  const query = { serviceDate, time: '08:30', timePreference: 'arrive_by', destination: { stopId: 'B' }, maxWalkKm: 0.2,
    rasterSize: 48, extentRadiusKm: 2, cutoffsMinutes: [15, 30, 45], includeStreetEdges: true }
  const reach = run(city, 'reach', query)
  assert.equal(reach.timePreference, 'arrive_by')
  assert.deepEqual(reach.destination, { stopId: 'B' })
  assert.equal(reach.origin, undefined)

  // A stop's duration is its latest boarding that still arrives by 08:30.
  const fromA = run(city, 'route', { serviceDate, time: '08:30', timePreference: 'arrive_by', origin: { stopId: 'A' },
    destination: { stopId: 'B' }, maxWalkKm: 0.2, requireTransitRide: true })
  const duration = id => reach.stops.find(stop => stop.stopId === id)?.durationMinutes
  assert.equal(duration('A'), 510 - fromA.departureMinutes)
  assert.equal(duration('A'), 30, 'T1 leaves A at 08:00 for the 08:15 T2 to B')
  assert.equal(duration('X'), 15, 'T2 leaves X at 08:15')
  const atA = cellAt(reach.surface, [-77.05, 38.9])
  assert(atA >= 30 && atA < 31, `Leaving A's cell takes A's boarding time plus its street attachment, not ${atA}`)

  // Intervals run from the end nearer the destination, so time grows along each.
  const edges = reach.surface.edges
  assert(edges.count > 0)
  for (let i = 0; i < edges.count; i += 1) {
    assert(edges.durationMinutes[i] >= edges.fromDurationMinutes[i] - 1e-9)
    assert(Number.isInteger(edges.edgeIds[i]))
  }

  // Exclusions and planned services change the timetable searched backwards.
  const removed = run(city, 'reach', { ...query, includeStreetEdges: false, scenario: { excludedTripIds: ['T2'] } })
  assert(!removed.stops.some(stop => ['A', 'X'].includes(stop.stopId)))
  const express = { id: 'express', name: 'Express', services: [{ id: 'express', name: 'Express', operation: 'add', timeModel: 'preserve-scheduled',
    scheduleMode: 'frequency', bidirectional: false, stops: [{ stopId: 'A' }, { stopId: 'B' }], startMinutes: 475, endMinutes: 600, headwayMinutes: 5, segmentRuntimeMinutes: [5] }] }
  const planned = run(city, 'reach', { ...query, includeStreetEdges: false, scenario: express })
  assert.equal(planned.stops.find(stop => stop.stopId === 'A')?.durationMinutes, 5, 'The 08:25 express arrives at 08:30')
  assert.equal(planned.diagnostics.transit.scenario.id, 'express')

  // Cell-center sampling routes from each cell center to the destination.
  const grid = run(city, 'reach', { ...query, includeStreetEdges: false, surfaceSampling: 'cell-center', maxWalkKm: 1.2 })
  const sampled = grid.surface.values.findIndex(value => value !== null && value > 0)
  assert(sampled >= 0)
  const { bounds: [west, south, east, north], width } = grid.surface
  const center = [west + ((sampled % width) + 0.5) / width * (east - west), north - (Math.floor(sampled / width) + 0.5) / width * (north - south)]
  const matrix = run(city, 'matrix', { serviceDate, time: '08:30', timePreference: 'arrive_by', origins: [{ coordinate: center }],
    destinations: [{ stopId: 'B' }], maxWalkKm: 1.2, horizonMinutes: 45, disableCache: true })
  assert(Math.abs(matrix.durationsMinutes[0][0] - grid.surface.values[sampled]) < 1e-3)

  // Two-way streets: walking to a place takes as long as walking from it.
  const walk = { mode: 'walk', time: '08:30', maxWalkKm: 5, rasterSize: 48, extentRadiusKm: 2, cutoffsMinutes: [30] }
  const place = { coordinate: [-77.03, 38.91] }
  assert.deepEqual(run(city, 'reach', { ...walk, timePreference: 'arrive_by', destination: place }).surface.values,
    run(city, 'reach', { ...walk, origin: place }).surface.values)

  // An arrive-by deadline before the longest cutoff searches the preceding date's clock.
  assert.equal(run(city, 'reach', { ...query, time: '00:20', includeStreetEdges: false }).stops.length, 0)

  rejects(city, 'reach', { ...query, origin: { stopId: 'A' } }, /takes a destination/)
  rejects(city, 'reach', { ...query, timePreference: 'depart_at' }, /arrive_by/)
  rejects(city, 'reach', { ...query, scenario: { overlay: { overlayStopCount: 0, stops: [] } } }, /overlay applies to depart-at/)

  // A one-way footway from A's end to B's: walking toward B uses it, from B cannot.
  const oneway = await build('oneway', { terminalWayTags: { 10: { 'oneway:foot': 'yes' } } })
  const toB = run(oneway, 'reach', { ...walk, timePreference: 'arrive_by', destination: place })
  const fromB = run(oneway, 'reach', { ...walk, origin: place })
  const fromA2 = run(oneway, 'reach', { ...walk, origin: { coordinate: [-77.05, 38.9] } })
  assert(cellAt(toB.surface, [-77.05, 38.9]) > 0, 'A reaches B along the one-way footway')
  assert.equal(cellAt(fromB.surface, [-77.05, 38.9]), null, 'B cannot walk back against it')
  assert(reached(toB.surface.values) > 4 * reached(fromB.surface.values))
  assert(Math.abs(cellAt(toB.surface, [-77.05, 38.9]) - cellAt(fromA2.surface, [-77.03, 38.91])) < 0.5,
    'Arriving at B from A takes as long as departing A for B')

  // The Node CLI sends the same request to this runtime, one-shot and resident.
  const cli = (args, input) => {
    const p = spawnSync(process.execPath, [path.join(root, 'public/vigo.mjs'), ...args],
      { input, env: { ...process.env, VIGO_STANDALONE_PATH: binary }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    assert.equal(p.status, 0, p.stderr)
    return p.stdout
  }
  const depart = { serviceDate, time: '07:55', origin: { stopId: 'A' }, maxWalkKm: 0.2, rasterSize: 48, extentRadiusKm: 2, cutoffsMinutes: [15, 30, 45] }
  const arrive = { ...query, includeStreetEdges: false }
  for (const request of [depart, arrive]) {
    const native = spawnSync(binary, ['reach', '--city', city, '--request', '-'], { input: JSON.stringify(request), env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const expected = JSON.parse(native.stdout)
    const actual = JSON.parse(cli(['reach', `--city=${city}`, '--request=-'], JSON.stringify(request)))
    assert.deepEqual(actual.query, expected.query)
    assert.deepEqual(actual.surface.valuesSeconds, expected.surface.valuesSeconds)
    assert.deepEqual(actual.stops, expected.stops)
  }
  const streamed = cli(['stream', `--city=${city}`, '--stream-output=detailed'], [depart, arrive, depart]
    .map((request, index) => JSON.stringify({ id: `reach-${index}`, kind: 'reach', ...request })).join('\n') + '\n')
    .trim().split('\n').map(line => JSON.parse(line).trace)
  assert.deepEqual(streamed.map(result => result.query.timePreference), ['depart_at', 'arrive_by', 'depart_at'])
  assert.deepEqual(streamed[1].surface.values, run(city, 'reach', arrive).surface.values)
  assert.equal(streamed[2].timing.openMs, 0, 'One resident runtime answers both directions')
  // Reverse propagation has the same monotone elapsed-time proof as forward
  // propagation. Compare its full surface and directed edge evidence, including
  // new service, cuts and changes of direction that must discard the reference.
  const resident = (target, requests) => {
    const p = spawnSync(binary, ['stream', '--city', target], {env, encoding:'utf8', maxBuffer:64*1024*1024,
      input:requests.map(request => JSON.stringify({kind:'reach', ...request, diagnostics:'trace'})).join('\n')+'\n'})
    assert.equal(p.status,0,p.stderr)
    return p.stdout.trim().split('\n').map(line=>JSON.parse(line).trace)
  }
  for (const target of [city, oneway]) {
    const base={...query, surfaceReuse:'baseline'}
    for (const change of [{}, {scenario:express}, {scenario:{excludedTripIds:['T2']}}]) {
      const [baseline, reused, fresh]=resident(target,[base, {...query,...change,surfaceReuse:'scenario'}, {...query,...change}])
      assert.deepEqual(reused.surface,fresh.surface,'Reverse cached grids and directed edge evidence match a fresh search')
      assert.deepEqual(reused.stops,fresh.stops)
      if (!change.scenario) {
        assert(reused.diagnostics.surface.reusedLabels>0)
        assert.equal(reused.diagnostics.surface.settledLabels,0)
        assert.deepEqual(reused.surface,baseline.surface)
      }
    }
    const forward={...walk,origin:place,includeStreetEdges:true,diagnostics:'trace'}
    const reverse={...walk,timePreference:'arrive_by',destination:place,includeStreetEdges:true,diagnostics:'trace'}
    const [, switched, fresh]=resident(target,[{...forward,surfaceReuse:'baseline'},{...reverse,surfaceReuse:'scenario'},reverse])
    assert.equal(switched.diagnostics.surface.reusedLabels,0,'A reference from the opposite street direction must be rejected')
    assert.deepEqual(switched.surface,fresh.surface)
  }
  // A planned stop that names a GTFS stop joins it rather than standing beside it.
  const joined = JSON.parse(cli(['reach', `--city=${city}`, '--request=-'], JSON.stringify({ ...depart,
    origin: { coordinate: [-77.0505, 38.9003] }, maxWalkKm: 0.5, scenario: { services: [{ operation: 'add', scheduleMode: 'frequency',
      bidirectional: false, startMinutes: 475, endMinutes: 600, headwayMinutes: 5, segmentRuntimeMinutes: [5],
      stops: [{ stopId: 'A', coordinate: [-77.05, 38.9] }, { stopId: 'B', coordinate: [-77.03, 38.91] }] }] } })))
  assert(joined.stops.some(stop => stop.stop?.id === 'B'), 'The planned express reaches GTFS stop B')
  assert.equal(joined.scenarioStops.find(stop => stop.name === 'stop-2')?.stop?.id, 'B')
  console.log(`Arrive-by Reach passed (${reach.stops.length} seeded stops, ${reached(toB.surface.values)} one-way cells toward B, ${reached(fromB.surface.values)} from B).`)
} finally {
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
