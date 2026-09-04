import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import Papa from 'papaparse'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'

const root = path.resolve(import.meta.dirname, '..')
const cliPath = process.env.VIGO_CLI_PATH ? path.resolve(process.env.VIGO_CLI_PATH) : path.join(root, 'public', 'vigo.mjs')
const executable = cliPath.endsWith('.mjs') ? process.execPath : cliPath
const prefix = cliPath.endsWith('.mjs') ? [cliPath] : []
const run = (args) => execFileSync(executable, [...prefix, ...args], { encoding: 'utf8' })
const invoke = (args) => spawnSync(executable, [...prefix, ...args], { encoding: 'utf8' })

assert(fs.existsSync(cliPath), 'Built CLI is missing.')
assert(!fs.existsSync(path.join(root, 'public', 'vigo-runtime.mjs')), 'VIGO must ship as one CLI file.')

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-cli-'))
try {
  const { gtfsPath, osmPath } = await writeCliFixtureInputs(temporaryRoot)
  const cityPath = path.join(temporaryRoot, 'fixture-city')
  const city = JSON.parse(run(['build', `--gtfs=${gtfsPath}`, `--osm=${osmPath}`, `--output=${cityPath}`]))

  assert.equal(city.schemaVersion, 'vigo.city.v1')
  assert.equal(city.kind, 'city')
  assert.match(city.builtAt, /^\d{4}-\d{2}-\d{2}T/u)
  assert.match(city.revisionId, /^\d{8}T\d{6}-\d{3}Z$/u)
  assert.equal(city.name, 'fixture-city')
  assert.deepEqual(city.inputs.gtfs.map((source) => Object.keys(source).sort()), [['name', 'scope']])
  assert.deepEqual(Object.keys(city.inputs.osmPbf), ['name'])
  assert.equal(city.routingStore.connectionCount, 2)
  assert.equal(city.streetStore.edgeCount, 4)
  assert.equal(typeof city.timing.rawCompilerConcurrency.gtfsAndOsmParallel, 'boolean')
  assert(fs.existsSync(path.join(cityPath, 'network.json')))
  assert(fs.existsSync(path.join(cityPath, 'routing', 'project.sqlite')))
  assert(fs.existsSync(path.join(cityPath, 'osm', 'street-index.sqlite')))

  const help = run(['--help'])
  for (const command of ['build', 'capabilities', 'inspect', 'route', 'matrix', 'reach', 'compare']) {
    assert(help.includes(`vigo ${command}`), `Help is missing ${command}.`)
  }
  for (const removed of ['build-network', 'one-to-many', 'isochrone', 'route-ndjson', 'prepare']) {
    assert(!help.includes(`vigo ${removed}`), `Help still exposes ${removed}.`)
    assert.notEqual(invoke([removed, '--help']).status, 0, `${removed} still runs.`)
  }

  const inspected = JSON.parse(run(['inspect', `--city=${cityPath}`]))
  assert.equal(inspected.schemaVersion, 'vigo.city.inspect.v1')
  assert.equal(inspected.revisionId, city.revisionId)
  assert.equal(inspected.builtAt, city.builtAt)
  assert.equal(inspected.sources.gtfs[0].name, path.basename(gtfsPath))
  assert.equal(inspected.sources.osm.name, path.basename(osmPath))

  const routeRequest = path.join(temporaryRoot, 'route.json')
  fs.writeFileSync(routeRequest, JSON.stringify({ origin: 'A', destination: 'B' }))
  const route = JSON.parse(run([
    'route', `--city=${cityPath}`, `--request=${routeRequest}`,
    '--time=07:55', '--service-date=2026-07-15', '--max-walk=0.2',
  ]))
  assert.equal(route.schemaVersion, 'vigo.result.route.v1')
  assert.equal(route.kind, 'route')
  assert.equal(route.status, 'ready')
  assert.equal(route.result.status, 'ready')
  assert(!Object.hasOwn(route.result.diagnostics.searchStats, 'resultCachePolicy'))
  assert(Number.isFinite(route.timing.openMs) && Number.isFinite(route.timing.computeMs))
  const removedRouteOption = invoke([
    'route', `--city=${cityPath}`, `--request=${routeRequest}`,
    '--time=07:55', '--service-date=2026-07-15', '--routing-preference=fastest',
  ])
  assert.equal(removedRouteOption.status, 2)
  assert(removedRouteOption.stderr.includes('--objective=earliest_arrival'))

  const waypointRequest = path.join(temporaryRoot, 'waypoint-route.json')
  fs.writeFileSync(waypointRequest, JSON.stringify({
    origin: 'A',
    waypoints: ['X'],
    destination: 'B',
  }))
  const waypointRoute = JSON.parse(run([
    'route', `--city=${cityPath}`, `--request=${waypointRequest}`,
    '--mode=walk', '--time=07:55', '--service-date=2026-07-15',
  ]))
  assert.equal(waypointRoute.status, 'ready')
  assert.equal(waypointRoute.result.waypoints.length, 1)
  assert.equal(waypointRoute.result.diagnostics.orderedPointCount, 3)

  const matrixRequest = path.join(temporaryRoot, 'matrix.json')
  fs.writeFileSync(matrixRequest, JSON.stringify({
    origins: [{ id: 'a', point: 'A' }],
    destinations: [{ id: 'x', point: 'X' }, { id: 'b', point: 'B' }],
  }))
  const matrixPath = path.join(temporaryRoot, 'matrix-result.json')
  const matrix = JSON.parse(run([
    'matrix', `--city=${cityPath}`, `--request=${matrixRequest}`,
    `--output=${matrixPath}`,
    '--time=07:55', '--service-date=2026-07-15', '--max-walk=0.2', '--horizon=90',
  ]))
  assert.equal(matrix.schemaVersion, 'vigo.result.matrix.v1')
  assert.equal(matrix.kind, 'matrix')
  assert.deepEqual(matrix.rows.map((row) => row.destinationId), ['x', 'b'])
  assert(matrix.rows.every((row) => row.status === 'ready'))
  assert(Number.isFinite(matrix.timing.openMs) && Number.isFinite(matrix.timing.computeMs))
  assert.deepEqual(JSON.parse(fs.readFileSync(matrixPath, 'utf8')), matrix)

  const reachRequest = path.join(temporaryRoot, 'reach.json')
  fs.writeFileSync(reachRequest, JSON.stringify({ origin: 'A', cutoffsMinutes: [5, 15, 40], extentRadiusKm: 2, rasterSize: 48 }))
  const reachPath = path.join(temporaryRoot, 'reach-result.json')
  const reach = JSON.parse(run([
    'reach', `--city=${cityPath}`, `--request=${reachRequest}`, `--output=${reachPath}`,
    '--time=07:55', '--service-date=2026-07-15', '--max-walk=0.2',
  ]))
  assert.equal(reach.schemaVersion, 'vigo.result.reach.v1')
  assert.equal(reach.kind, 'reach')
  assert.equal(reach.surface.values.length, 48 * 48)
  assert.equal(reach.contours.type, 'FeatureCollection')
  assert(Number.isFinite(reach.timing.openMs) && Number.isFinite(reach.timing.computeMs))
  assert(fs.existsSync(reachPath))
  const removedReachOption = invoke([
    'reach', `--city=${cityPath}`, `--request=${reachRequest}`,
    '--time=07:55', '--service-date=2026-07-15', '--radius=2',
  ])
  assert.equal(removedReachOption.status, 2)
  assert(removedReachOption.stderr.includes('--extent-radius'))

  const scenarioReachRequest = path.join(temporaryRoot, 'scenario-reach.json')
  fs.writeFileSync(scenarioReachRequest, JSON.stringify({
    origin: 'A',
    cutoffsMinutes: [15, 40],
    extentRadiusKm: 2,
    rasterSize: 48,
    scenario: {
      name: 'Crosstown service',
      services: [{
        name: 'Crosstown',
        headwayMinutes: 10,
        stops: [
          { label: 'Alpha', coordinate: [-77.050, 38.900] },
          { label: 'Bravo', coordinate: [-77.030, 38.910] },
        ],
      }],
    },
  }))
  const scenarioReach = JSON.parse(run([
    'reach', `--city=${cityPath}`, `--request=${scenarioReachRequest}`,
    '--time=07:55', '--service-date=2026-07-15', '--max-walk=0.2',
  ]))
  assert.equal(scenarioReach.query.scenario.name, 'Crosstown service')
  assert.equal(scenarioReach.query.scenario.services.length, 1)
  assert.equal(scenarioReach.scenarioStops.length, 2)
  assert.equal(scenarioReach.surface.values.length, 48 * 48)

  const odPath = path.join(temporaryRoot, 'od.csv')
  const routesPath = path.join(temporaryRoot, 'routes.csv')
  fs.writeFileSync(odPath, 'id,origin_stop_id,destination_stop_id\nfirst,A,B\nsecond,A,B\n')
  const batch = JSON.parse(run([
    'route', `--city=${cityPath}`, `--input=${odPath}`, `--output=${routesPath}`,
    '--time=07:55', '--service-date=2026-07-15', '--max-walk=0.2',
  ]))
  const rows = Papa.parse(fs.readFileSync(routesPath, 'utf8'), { header: true, skipEmptyLines: true }).data
  assert.equal(batch.schemaVersion, 'vigo.result.route.v1')
  assert.equal(batch.rows.ready, 2)
  assert.equal(batch.results.length, 2)
  assert(rows.every((row) => !Object.hasOwn(row, 'cache_hit') && !Object.hasOwn(row, 'cache_key')))

  const before = path.join(temporaryRoot, 'before.json')
  const after = path.join(temporaryRoot, 'after.json')
  fs.writeFileSync(before, JSON.stringify({ kind: 'route', result: { status: 'ready', durationMinutes: 20, transfers: 1 } }))
  fs.writeFileSync(after, JSON.stringify({ kind: 'route', result: { status: 'ready', durationMinutes: 17, transfers: 0 } }))
  const comparison = JSON.parse(run(['compare', `--before=${before}`, `--after=${after}`]))
  assert.equal(comparison.schemaVersion, 'vigo.result.comparison.v1')
  assert.equal(comparison.change.durationChangeMinutes, -3)
  assert.equal(comparison.change.transferChange, -1)

  const noCity = invoke(['route', `--request=${routeRequest}`, '--service-date=2026-07-15'])
  assert.equal(noCity.status, 2)
  assert(noCity.stderr.includes('requires --city'))

  console.log('Canonical VIGO CLI passed.')
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
}
