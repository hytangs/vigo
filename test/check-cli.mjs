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

  const originalManifest = fs.readFileSync(path.join(cityPath, 'network.json'), 'utf8')
  const buildArguments = ['build', `--gtfs=${gtfsPath}`, `--osm=${osmPath}`, `--output=${cityPath}`]
  assert.equal(invoke(buildArguments).status, 2, 'Replacing a City requires explicit --replace.')
  const invalidGtfsPath = path.join(temporaryRoot, 'invalid.zip')
  fs.writeFileSync(invalidGtfsPath, 'not a GTFS archive')
  const failedReplacement = invoke([
    'build', `--gtfs=${invalidGtfsPath}`, `--osm=${osmPath}`, `--output=${cityPath}`, '--replace',
  ])
  assert.equal(failedReplacement.status, 2, 'A failed compiler must fail the build.')
  assert.equal(fs.readFileSync(path.join(cityPath, 'network.json'), 'utf8'), originalManifest)
  const replacement = JSON.parse(run([...buildArguments, '--replace']))
  assert.equal(replacement.name, city.name)
  assert.notEqual(replacement.revisionId, city.revisionId)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cityPath, 'network.json'), 'utf8')), replacement)
  assert(!fs.readdirSync(temporaryRoot).some((name) => name.startsWith('.fixture-city.vigo-')),
    'Successful and failed compilation must release and clean staging directories.')

  const merged = JSON.parse(run([
    'build', `--gtfs=${gtfsPath}`, `--gtfs=${gtfsPath}`, '--gtfs-scope=east', '--gtfs-scope=west',
    `--osm=${osmPath}`, `--output=${path.join(temporaryRoot, 'merged city')}`,
  ]))
  assert.equal(merged.name, 'merged city')
  assert.deepEqual(merged.sources.gtfs.map((source) => source.scope), ['east', 'west'])
  assert.equal(merged.routingStore.connectionCount, city.routingStore.connectionCount * 2)

  const privateInputs = path.join(temporaryRoot, 'private-inputs')
  fs.mkdirSync(privateInputs)
  const terminalFixture = await writeCliFixtureInputs(privateInputs, { terminalAccess: true })
  const terminalCityPath = path.join(temporaryRoot, 'terminal-city')
  const terminalCity = JSON.parse(run(['build', `--gtfs=${terminalFixture.gtfsPath}`,
    `--osm=${terminalFixture.osmPath}`, `--output=${terminalCityPath}`, '--private-access=endpoints']))
  assert.equal(terminalCity.streetStore.terminalAccess.model, 'authorized_endpoints')
  assert.equal(terminalCity.streetStore.terminalAccess.privateWays, 2)
  const terminalRequest = path.join(temporaryRoot, 'terminal-route.json')
  fs.writeFileSync(terminalRequest, JSON.stringify({ origin: { coordinate: [-77.054, 38.9] }, destination: 'B', allowLongWalk: false }))
  const terminalRoute = JSON.parse(run(['route', `--city=${terminalCityPath}`, `--request=${terminalRequest}`,
    '--time=08:30', '--time-preference=arrive', '--service-date=2026-07-15', '--max-walk=0.6', '--max-transfers=1']))
  assert.equal(terminalRoute.status, 'ready')
  assert.equal(terminalRoute.result.diagnostics.walkingAccessPermission, 'authorized_endpoints')
  assert.equal(terminalRoute.result.transfers, 1)

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
  assert.equal(inspected.revisionId, replacement.revisionId)
  assert.equal(inspected.builtAt, replacement.builtAt)
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
  for (const mode of ['walk', 'drive']) {
    for (const time of ['08:30', '00:00']) {
      const arrival = JSON.parse(run([
        'route', `--city=${cityPath}`, `--request=${waypointRequest}`,
        `--mode=${mode}`, `--time=${time}`, '--time-preference=arrive', '--service-date=2026-07-15',
      ]))
      assert.equal(arrival.status, 'ready')
      assert.equal(arrival.result.arriveMinutes, time === '08:30' ? 510 : 0)
    }
  }

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
  assert(Math.abs(matrix.rows[1].durationMinutes - route.result.durationMinutes) < 0.001,
    'Public transit Route and Matrix must both include a faster direct walk.')

  for (const timePreference of ['depart', 'arrive']) {
    for (const maxTransfers of [0, 1]) {
      const options = [`--time-preference=${timePreference}`, '--time=08:00',
        '--service-date=2026-07-15', '--max-walk=0.2', `--max-transfers=${maxTransfers}`]
      const capped = JSON.parse(run(['route', `--city=${cityPath}`, `--request=${routeRequest}`, ...options]))
      assert.equal(capped.query.maxTransfers, maxTransfers)
      if (capped.result.status === 'ready') assert(capped.result.transfers <= maxTransfers)
      const cappedMatrix = JSON.parse(run(['matrix', `--city=${cityPath}`, `--request=${matrixRequest}`, ...options]))
      assert.equal(cappedMatrix.query.maxTransfers, maxTransfers)
      assert.equal(cappedMatrix.rows[1].status, capped.result.status)
      if (capped.result.status === 'ready') {
        const field = timePreference === 'arrive' ? 'departMinutes' : 'arriveMinutes'
        assert(Math.abs(cappedMatrix.rows[1][field] - capped.result[field]) <= 0.002)
      }
    }
  }
  for (const maximum of ['-1', '0.5', '32', 'no']) {
    assert.equal(invoke(['route', `--city=${cityPath}`, `--request=${routeRequest}`,
      '--service-date=2026-07-15', `--max-transfers=${maximum}`]).status, 2)
  }

  const largeMatrixRequest = path.join(temporaryRoot, 'large-matrix.json')
  fs.writeFileSync(largeMatrixRequest, JSON.stringify({
    origins: [{ id: 'a', point: 'A' }],
    destinations: Array.from({ length: 1024 }, (_, i) => ({ id: `point_${i}`, point: i % 2 ? 'B' : 'X' })),
  }))
  const largeMatrix = JSON.parse(run([
    'matrix', `--city=${cityPath}`, `--request=${largeMatrixRequest}`,
    '--time=07:55', '--service-date=2026-07-15', '--max-walk=0.2', '--horizon=90',
  ]))
  assert.equal(largeMatrix.rows.length, 1024)
  for (const [index, row] of largeMatrix.rows.entries()) {
    assert.equal(row.destinationId, `point_${index}`)
    assert.equal(row.status, matrix.rows[index % 2].status)
    assert.equal(row.durationMinutes, matrix.rows[index % 2].durationMinutes)
  }

  for (const timePreference of ['depart', 'arrive']) {
    for (const manyOrigins of [false, true]) {
      fs.writeFileSync(largeMatrixRequest, JSON.stringify({
        origins: Array.from({ length: manyOrigins ? 1024 : 1 }, (_, i) => ({ id: `origin_${i}`, point: 'A' })),
        destinations: Array.from({ length: manyOrigins ? 1 : 1024 }, (_, i) => ({ id: `destination_${i}`, point: 'B' })),
        timePreference,
      }))
      const result = JSON.parse(run(['matrix', `--city=${cityPath}`, `--request=${largeMatrixRequest}`,
        '--time=08:30', '--service-date=2026-07-15', '--max-walk=0.2', '--horizon=90']))
      assert.equal(result.query.timePreference, timePreference)
      assert.equal(result.rows.length, 1024)
      for (const row of result.rows) {
        assert.equal(row.status, result.rows[0].status)
        assert.equal(row.departMinutes, result.rows[0].departMinutes)
        assert.equal(row.arriveMinutes, result.rows[0].arriveMinutes)
        assert.equal(row.originId, `origin_${row.originIndex}`)
        assert.equal(row.destinationId, `destination_${row.destinationIndex}`)
      }
      if (timePreference === 'arrive') {
        assert.equal(result.rows[0].status, 'ready')
        assert.equal(result.rows[0].arriveMinutes, 510)
        assert(result.rows[0].departMinutes <= 510)
      }
    }
  }

  const streamedMatrices = execFileSync(executable, [...prefix, '_route-stream', `--city=${cityPath}`,
    '--service-date=2026-07-15'], {
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    input: [
      { id: 'morning', kind: 'matrix', origins: Array.from({ length: 1024 }, (_, i) => ({ id: `point_${i}`, point: 'A' })),
        destinations: [{ id: 'school', point: 'B' }], timePreference: 'arrive', time: '08:30', maxWalkKm: 0.2 },
      { id: 'invalid', kind: 'matrix', origins: [], destinations: [{ id: 'school', point: 'B' }] },
      { id: 'afternoon', kind: 'matrix', origins: [{ id: 'school', point: 'A' }],
        destinations: Array.from({ length: 1024 }, (_, i) => ({ id: `point_${i}`, point: 'B' })),
        timePreference: 'depart', time: '07:55', maxWalkKm: 0.2 },
    ].map(value => JSON.stringify(value)).join('\n') + '\n',
  }).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(streamedMatrices.map(result => result.status), ['ready', 'error', 'ready'])
  assert.equal(streamedMatrices[0].rows.length, 1024)
  assert.equal(streamedMatrices[0].query.timePreference, 'arrive')
  assert.equal(streamedMatrices[0].query.timeMinutes, 510)
  assert.equal(streamedMatrices[0].diagnostics.reverseSearches, 1)
  assert.equal(streamedMatrices[2].rows.length, 1024)
  assert.equal(streamedMatrices[2].query.timeMinutes, 475)
  assert.equal(streamedMatrices[2].timing.openMs, 0, 'Later Matrix requests must reuse the loaded City.')
  assert.equal(streamedMatrices[2].diagnostics.forwardSearches, 1)

  // A separate process releases native memory maps before Windows fixture cleanup.
  execFileSync(process.execPath, [
    path.join(root, 'test', 'helpers', 'assert-cli-matrix-parity.mjs'),
    cityPath, String(route.result.durationMinutes),
  ], { stdio: 'inherit' })

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
  assert.equal(invoke([
    'reach', `--city=${cityPath}`, `--request=${reachRequest}`,
    '--time=07:55', '--service-date=2026-07-15', '--mode=drive',
  ]).status, 2, 'Unsupported Reach modes must not silently run transit.')
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

  const replacementRequest = JSON.parse(fs.readFileSync(scenarioReachRequest, 'utf8'))
  replacementRequest.scenario.services[0].operation = 'replace'
  replacementRequest.scenario.services[0].sourceRouteId = 'R1'
  fs.writeFileSync(scenarioReachRequest, JSON.stringify(replacementRequest))
  const replaced = JSON.parse(run([
    'reach', `--city=${cityPath}`, `--request=${scenarioReachRequest}`,
    '--time=07:55', '--service-date=2026-07-15', '--max-walk=0.2',
  ]))
  assert.equal(replaced.query.scenario.excludedRouteIds.length, 1,
    'Replacing service must remove its scheduled baseline in CLI and Python Reach.')
  assert.match(replaced.query.scenario.excludedRouteIds[0], /R1$/)
  replacementRequest.scenario.services.push({ ...replacementRequest.scenario.services[0] })
  fs.writeFileSync(scenarioReachRequest, JSON.stringify(replacementRequest))
  const conflicting = invoke([
    'reach', `--city=${cityPath}`, `--request=${scenarioReachRequest}`,
    '--time=07:55', '--service-date=2026-07-15',
  ])
  assert.equal(conflicting.status, 2)
  assert.match(conflicting.stderr, /Conflicting replacement services/)
  replacementRequest.scenario.services.pop()
  replacementRequest.scenario.services[0].sourceRouteId = 'missing-route'
  fs.writeFileSync(scenarioReachRequest, JSON.stringify(replacementRequest))
  assert.equal(invoke([
    'reach', `--city=${cityPath}`, `--request=${scenarioReachRequest}`,
    '--time=07:55', '--service-date=2026-07-15',
  ]).status, 2, 'A missing source route cannot silently turn replacement into added service.')

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
