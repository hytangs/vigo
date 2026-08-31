import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import Papa from 'papaparse'
import { writeCliFixtureInputs } from './lib/cli-fixture-inputs.mjs'

const root = path.resolve(import.meta.dirname, '..')
const cliPath = process.env.VIGO_CLI_PATH ? path.resolve(process.env.VIGO_CLI_PATH) : path.join(root, 'dist-cli', 'vigo.mjs')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

assert(fs.existsSync(cliPath), 'Built CLI is missing. Run npm run build:cli.')
const cliExecutable = cliPath.endsWith('.mjs') ? process.execPath : cliPath
const cliPrefix = cliPath.endsWith('.mjs') ? [cliPath] : []
const runCli = (args) => execFileSync(cliExecutable, [...cliPrefix, ...args], { encoding: 'utf8' })

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-cli-contract-'))
try {
  const { gtfsPath, osmPath } = await writeCliFixtureInputs(temporaryRoot)
  const networkPath = path.join(temporaryRoot, 'network')

  const build = JSON.parse(runCli([
    'build-network',
    `--gtfs=${gtfsPath}`,
    `--osm-pbf=${osmPath}`,
    `--output-dir=${networkPath}`,
  ]))
  const storePath = build.routingStore.path
  const streetStorePath = build.streetStore.path
  assert(build.schemaVersion === 'vigo.cli.build-network.v1', 'CLI should expose the raw-input build contract.')
  assert(build.version === packageJson.version, 'Network build should report the current CLI version.')
  assert(build.routingStore?.connectionCount === 2, 'Network build should compile the GTFS timetable.')
  const coordinateAccess = build.routingStore?.nativeCoordinateAccess
  assert(
    ['written', 'loaded', 'memory'].includes(coordinateAccess?.persistenceState)
      && Number(coordinateAccess?.snapshotBytes) > 0,
    'Network build should persist the exact local-graph coordinate-access profile before the first OD.',
  )
  assert(
    coordinateAccess?.mode === 'exact-local-graph-frontier',
    'Coordinate access should use the exact local OSM graph frontier without a CCH target-bucket build.',
  )
  assert(build.streetStore?.edgeCount === 4, 'Network build should compile directed walk edges from OSM.')
  assert(build.routingStore?.departureIndexState === 'deferred', 'Network build should publish the GTFS runtime store without the import-only departure covering index.')
  assert(build.routingStore?.runtimeCompaction?.state === 'deferred', 'Network build should report the uniform GTFS runtime compaction state.')
  assert(build.streetStore?.storageLayout === 'runtime-snapshots-v1', 'Network build should publish the uniform OSM runtime snapshot layout.')
  assert(build.streetStore?.runtimeCompaction?.storageLayout === 'runtime-snapshots-v1', 'Network build should report the uniform OSM runtime snapshot layout.')
  assert(build.streetStore?.driveAccelerator?.ready === true, 'Network build should persist the drive snapshot before sealing the street store.')
  assert(build.streetStore?.walkAccelerator?.ready === true, 'Network build should persist the native street snapshot even for a small PBF.')
  assert(build.streetStore?.streetCch?.ready === true, 'Network build should persist the exact street CCH before the first OD.')
  assert(
    Number.isFinite(build.timing?.gtfsBuildMs)
      && Number.isFinite(build.timing?.osmBuildMs)
      && Number.isFinite(build.timing?.streetCchBuildMs)
      && Number.isFinite(build.timing?.coordinateAccessBuildMs)
      && Number.isFinite(build.timing?.osmRuntimeCompactionMs)
      && Number.isFinite(build.timing?.gtfsRuntimeCompactionMs)
      && Number.isFinite(build.timing?.osmDrivePreparationMs),
    'Network build should retain raw, CCH, coordinate-access, and runtime-compaction phase timings.',
  )
  assert(fs.existsSync(storePath) && fs.existsSync(streetStorePath), 'Network build should publish both SQLite stores.')
  assert(fs.existsSync(path.join(networkPath, 'network.json')), 'Network build should persist its manifest.')
  const publishedStreetDatabase = new DatabaseSync(streetStorePath, { readOnly: true })
  const publishedStreetTables = new Set(
    publishedStreetDatabase.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name),
  )
  publishedStreetDatabase.close()
  assert(!publishedStreetTables.has('edges') && !publishedStreetTables.has('walk_nodes'), 'Published street stores must not retain the import graph tables.')
  const prepared = JSON.parse(runCli([
    'prepare',
    `--store=${storePath}`,
    `--street-store=${streetStorePath}`,
    '--service-date=2026-07-15',
    '--service-day=weekday',
  ]))
  assert(prepared.preparation?.routing?.nativeCoordinateAccess?.ready === true, 'CLI prepare should load exact coordinate access before the first OD.')

  const odPath = path.join(temporaryRoot, 'od.csv')
  const outPath = path.join(temporaryRoot, 'routes.csv')
  const jsonOutPath = path.join(temporaryRoot, 'routes.json')
  fs.writeFileSync(odPath, 'id,origin_stop_id,destination_stop_id\nfixture,A,B\n')

  const help = runCli(['--help'])
  assert(help.includes('vigo build-network') && help.includes('--gtfs PATH') && help.includes('--osm-pbf PATH'), 'CLI help must expose raw GTFS/OSM compilation.')
  assert(help.includes('--store PATH') && help.includes('--json-out PATH') && !help.includes('--feed PATH'), 'CLI help must expose SQLite and full-fidelity JSON routing output.')
  assert(help.includes('--service-date YYYY-MM-DD   Required'), 'CLI help must require an exact service date.')
  assert(help.includes('--street-store PATH         Required when either endpoint is a coordinate'), 'CLI help must fail closed for coordinate routing without OSM.')
  assert(help.includes('--routing-preference VALUE  balanced or fastest (default: balanced)'), 'CLI help must expose the shared interactive routing objective.')
  assert(help.includes('vigo one-to-many') && help.includes('--matrix-strategy VALUE'), 'CLI help must expose the resident one-to-many operator.')
  assert(help.includes('vigo isochrone') && help.includes('--cutoffs MINUTES'), 'CLI help must expose Rust-backed isochrone generation.')
  const version = runCli(['--version']).trim()
  assert(version === packageJson.version, `CLI version should be ${packageJson.version}, got ${version}`)

  const stdout = runCli([
    'route', `--store=${storePath}`, `--od=${odPath}`, `--out=${outPath}`,
    `--json-out=${jsonOutPath}`,
    '--time=07:55', '--service-day=weekday', '--service-date=2026-07-15', '--max-walk=0.2', '--departure-window=10',
  ])
  const summary = JSON.parse(stdout)
  const routed = Papa.parse(fs.readFileSync(outPath, 'utf8'), { header: true, skipEmptyLines: true }).data
  const fullResults = JSON.parse(fs.readFileSync(jsonOutPath, 'utf8'))

  assert(summary.schemaVersion === 'vigo.cli.route.v2', 'CLI should emit the canonical route summary.')
  assert(summary.engine?.storage === 'sqlite-persisted-resident-compiled', 'CLI should declare the persisted/compiled routing boundary.')
  assert(summary.engine?.persistentStore === 'sqlite', 'CLI should declare SQLite as the durable input store.')
  assert(summary.engine?.queryExecutor === 'resident-active-service-kernel', 'CLI should declare the resident query executor.')
  assert(summary.engine?.sqlRouteExecutor === false, 'CLI must not advertise a SQL route executor.')
  assert(summary.engine?.algorithm === routed[0]?.algorithm, 'CLI should report the algorithm that actually produced the plan.')
  assert(summary.engine?.algorithms?.includes(routed[0]?.algorithm), 'CLI should expose all algorithms used by the batch.')
  assert(summary.preparation?.routing?.ready === true, 'CLI should prepare one reusable routing context before its OD batch.')
  assert(Number.isFinite(summary.preparation?.elapsedMs), 'CLI should report batch preparation time separately from route time.')
  assert(summary.timing?.routingMs === summary.elapsedMs, 'CLI should keep routing time separate from output serialization.')
  assert(Number.isFinite(summary.timing?.outputMs), 'CLI should report output serialization separately.')
  assert(summary.query?.departureWindowMinutes === 10, 'CLI should report the centered departure-window profile.')
  assert(summary.query?.routingPreference === 'balanced', 'CLI must share the interactive balanced default.')
  assert(summary.routingStore?.connectionCount === 2, 'CLI should read routing-store metadata from SQLite.')
  assert(summary.rows?.ready === 1, `the SQLite fixture should route: ${JSON.stringify({ summary: summary.rows, routed })}`)
  assert(routed[0]?.status === 'ready', 'CLI CSV should contain the ready resident-kernel route.')
  assert(routed[0]?.route_sequence === 'R1 > R2', `unexpected route sequence: ${routed[0]?.route_sequence}`)
  assert(routed[0]?.query_semantics === 'centered_departure_profile', 'CLI CSV should label profile semantics.')
  assert(summary.jsonOutput === jsonOutPath, 'CLI summary should identify its full-fidelity JSON output.')
  assert(fullResults.schemaVersion === 'vigo.cli.route-results.v1', 'CLI JSON output should use the language-binding result schema.')
  assert(fullResults.engine?.storage === 'sqlite-persisted-resident-compiled', 'CLI JSON output should preserve the persisted/compiled routing boundary.')
  assert(fullResults.results?.length === 1, 'CLI JSON output should contain one result per OD row.')
  assert(fullResults.results[0]?.id === 'fixture', 'CLI JSON output should preserve the OD id.')
  assert(fullResults.results[0]?.plan?.status === 'ready', 'CLI JSON output should contain the canonical ready plan.')
  assert(fullResults.results[0]?.plan?.diagnostics?.searchProfile === 'balanced', 'The default CLI plan must use the balanced product objective.')
  assert(fullResults.results[0]?.plan?.legs?.filter((leg) => leg.type === 'ride').length === 2, 'CLI JSON output should retain full ride legs.')

  const oneToManyRequestPath = path.join(temporaryRoot, 'one-to-many.json')
  fs.writeFileSync(oneToManyRequestPath, JSON.stringify({
    origin: 'A',
    destinations: [
      { id: 'transfer', point: 'X' },
      { id: 'destination', point: 'B' },
    ],
  }))
  const oneToMany = JSON.parse(runCli([
    'one-to-many',
    `--store=${storePath}`,
    `--street-store=${streetStorePath}`,
    `--request=${oneToManyRequestPath}`,
    '--time=07:55',
    '--service-day=weekday',
    '--service-date=2026-07-15',
    '--max-walk=0.2',
    '--horizon=90',
    '--matrix-strategy=shared',
  ]))
  assert(oneToMany.schemaVersion === 'vigo.cli.one-to-many.v1', 'CLI one-to-many should expose its language-binding schema.')
  assert(oneToMany.engine?.owner === 'rust-resident-timetable-kernel', 'CLI one-to-many must declare native resident ownership.')
  assert(oneToMany.engine?.algorithm === 'rust_exact_connection_scan_one_to_many', 'CLI one-to-many must use the shared Rust matrix operator.')
  assert(oneToMany.diagnostics?.matrixStrategy === 'shared', 'CLI one-to-many should use one shared forward scan by default.')
  assert(oneToMany.diagnostics?.forwardSearches === 1, 'One origin must produce exactly one shared forward scan.')
  assert(JSON.stringify(oneToMany.rows?.map((row) => row.destinationId)) === JSON.stringify(['transfer', 'destination']), 'CLI one-to-many must preserve destination ids and order.')
  assert(oneToMany.rows?.every((row) => row.status === 'ready'), 'The fixture one-to-many targets should be reachable.')

  const isochroneRequestPath = path.join(temporaryRoot, 'isochrone.json')
  fs.writeFileSync(isochroneRequestPath, JSON.stringify({
    origin: 'A',
    cutoffsMinutes: [5, 15, 40],
    radiusKm: 2,
    rasterSize: 48,
  }))
  const isochrone = JSON.parse(runCli([
    'isochrone',
    `--store=${storePath}`,
    `--street-store=${streetStorePath}`,
    `--request=${isochroneRequestPath}`,
    '--time=07:55',
    '--service-day=weekday',
    '--service-date=2026-07-15',
    '--max-walk=0.2',
    '--walk-speed=4.8',
    '--radius=2',
    '--raster-size=48',
    '--cutoffs=5,15,40',
  ]))
  assert(isochrone.schemaVersion === 'vigo.cli.isochrone.v1', 'CLI isochrone should expose its language-binding schema.')
  assert(isochrone.engine?.owner === 'rust-resident-accessibility-pipeline', 'CLI isochrone must declare native Accessibility ownership.')
  assert(String(isochrone.engine?.algorithm).includes('one_to_many'), 'CLI isochrone must use the resident one-to-many timetable scan.')
  assert(isochrone.engine?.surfaceKernel === 'rust_mmap_street_surface_v1', 'CLI isochrone must use the Rust street-surface kernel.')
  assert(isochrone.surface?.schemaVersion === 'vigo.street.network-raster.v1', 'CLI isochrone must retain the Rust surface schema.')
  assert(Array.isArray(isochrone.surface?.values) && isochrone.surface.values.length === 48 * 48, 'CLI isochrone must serialize the complete 48x48 native raster.')
  assert(isochrone.isochrones?.type === 'FeatureCollection', 'CLI isochrone must generate GeoJSON contours.')
  assert(!fs.existsSync(path.join(temporaryRoot, 'routing', 'fixture.json')), 'CLI contract must not create a routing JSON sidecar.')
  assert(!fs.existsSync(path.join(temporaryRoot, 'osm', 'walk-network.json')), 'CLI contract must not create a walk-network JSON sidecar.')

  const ndjson = spawnSync(cliExecutable, [
    ...cliPrefix,
    'route-ndjson',
    `--store=${storePath}`,
    '--time=07:55',
    '--service-day=weekday',
    '--service-date=2026-07-15',
    '--max-walk=0.2',
  ], {
    encoding: 'utf8',
    input: [
      JSON.stringify({ id: '__VIGO_NDJSON_SERIALIZATION_MS__', origin: 'A', destination: 'B' }),
      JSON.stringify({ id: 'stream-2', origin: { stopId: 'A' }, destination: { stopId: 'B' }, time: '07:56', disableCache: true }),
      JSON.stringify({ id: 'stream-coordinate-no-osm', origin: { coordinate: [-77.05, 38.9] }, destination: 'B' }),
      '{bad json',
      '',
    ].join('\n'),
  })
  assert(ndjson.status === 0, `persistent NDJSON CLI failed: ${ndjson.stderr}`)
  const ndjsonRows = ndjson.stdout.trim().split('\n').map((line) => JSON.parse(line))
  assert(ndjsonRows.length === 4, 'persistent NDJSON CLI should return one response per non-empty input line.')
  assert(ndjsonRows[0]?.schemaVersion === 'vigo.cli.route-result.v1', 'persistent NDJSON results should use the streaming result schema.')
  assert(ndjsonRows[0]?.id === '__VIGO_NDJSON_SERIALIZATION_MS__' && ndjsonRows[0]?.plan?.status === 'ready', 'persistent NDJSON should route stop-ID strings without corrupting values that match its timing marker.')
  assert(ndjsonRows[1]?.id === 'stream-2' && ndjsonRows[1]?.plan?.status === 'ready', 'persistent NDJSON should route stop point objects without restarting.')
  assert(ndjsonRows[0]?.engine?.algorithm === ndjsonRows[0]?.plan?.diagnostics?.algorithm, 'persistent NDJSON should report the actual route algorithm.')
  assert(Number.isFinite(ndjsonRows[0]?.timing?.serializationMs), 'persistent NDJSON should report response serialization time.')
  assert(ndjsonRows[1]?.timing?.preparationMs === 0, 'persistent NDJSON should prepare once per process, not once per request.')
  assert(ndjsonRows[1]?.plan?.diagnostics?.searchStats?.resultCachePolicy === 'disabled', 'persistent NDJSON should expose cache-disabled measurement requests.')
  assert(ndjsonRows[1]?.plan?.diagnostics?.searchStats?.cacheHit !== true, 'a cache-disabled NDJSON request must execute rather than return a retained route result.')
  assert(
    ndjsonRows[2]?.status === 'error'
      && ndjsonRows[2]?.error?.message?.includes('coordinate endpoints require --street-store'),
    'persistent NDJSON must reject coordinate routing without an OSM street store.',
  )
  assert(ndjsonRows[3]?.status === 'error', 'a malformed NDJSON line should produce an isolated error response.')
  assert(Number.isFinite(ndjsonRows[3]?.timing?.serializationMs), 'persistent NDJSON errors should report response serialization time.')

  const coordinateOdPath = path.join(temporaryRoot, 'coordinate-od.csv')
  fs.writeFileSync(
    coordinateOdPath,
    'id,origin_lon,origin_lat,destination_lon,destination_lat\ncoordinate-no-osm,-77.050,38.900,-77.030,38.910\n',
  )
  const coordinateWithoutStreetStore = spawnSync(cliExecutable, [
    ...cliPrefix,
    'route',
    `--store=${storePath}`,
    `--od=${coordinateOdPath}`,
    `--out=${outPath}`,
    '--service-date=2026-07-15',
  ], { encoding: 'utf8' })
  assert(coordinateWithoutStreetStore.status === 2, 'CSV coordinate routing must fail without --street-store.')
  assert(
    coordinateWithoutStreetStore.stderr.includes('coordinate endpoints require --street-store'),
    'CSV coordinate rejection must explain the OSM street-store requirement.',
  )

  const missingDate = spawnSync(cliExecutable, [
    ...cliPrefix,
    'route',
    `--store=${storePath}`,
    `--od=${odPath}`,
    `--out=${outPath}`,
  ], { encoding: 'utf8' })
  assert(missingDate.status === 2, 'CLI should reject routing without an exact service date.')
  assert(missingDate.stderr.includes('--service-date is required'), 'CLI should explain the exact-date requirement.')

  console.log('CLI resident-kernel contract check passed.')
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
}
