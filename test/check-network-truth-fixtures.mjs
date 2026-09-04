import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '..')
const outDir = resolve(root, '.tmp-network-truth-check')

rmSync(outDir, { recursive: true, force: true })

const compile = spawnSync(
  process.execPath,
  [
    resolve(root, 'node_modules/typescript/bin/tsc'),
    '--target',
    'ES2022',
    '--module',
    'ES2022',
    '--moduleResolution',
    'Bundler',
    '--skipLibCheck',
    '--declaration',
    'false',
    '--outDir',
    outDir,
    '--noEmit',
    'false',
    resolve(root, 'src/networkTruth.ts'),
    resolve(root, 'src/domain.ts'),
  ],
  { cwd: root, encoding: 'utf8' },
)

if (compile.status !== 0) {
  console.error(compile.stdout)
  console.error(compile.stderr)
  process.exit(compile.status ?? 1)
}

const {
  scopePreviewToFeed,
} = await import(pathToFileURL(resolve(outDir, 'networkTruth.js')).href)

function route(id, longName, stopIds) {
  return {
    id,
    routeId: 'SL5',
    patternId: id,
    directionId: '0',
    shortName: 'SL5',
    longName,
    color: '#2f75d6',
    tripCount: 12,
    stopCount: stopIds.length,
    headwayMinutes: 12,
    spanHours: 18,
    serviceHours: 12,
    geometrySource: 'shape',
    distanceKm: 4,
    scheduledSpeedKph: 20,
    firstDepartureMinutes: 360,
    lastArrivalMinutes: 1320,
    status: 'baseline',
    coordinates: [[-71, 42], [-71.02, 42.02]],
    points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
    stopIds,
  }
}

function stop(id, name) {
  return {
    id,
    name,
    x: 0,
    y: 0,
    lat: 42,
    lon: -71,
    routes: ['SL5'],
    tripCount: 12,
    transferScore: 12,
  }
}

function feed(id, name, stopName) {
  const preview = {
    routes: [route('pattern-a', `${name} shared route`, ['shared-stop', 'second-stop'])],
    stops: [stop('shared-stop', stopName), stop('second-stop', `${name} second`)],
    stopPairs: [{
      id: 'pair-a',
      routeId: 'SL5',
      patternId: 'pattern-a',
      directionId: '0',
      fromStopId: 'shared-stop',
      toStopId: 'second-stop',
      fromStopName: stopName,
      toStopName: `${name} second`,
      sequence: 1,
      tripCount: 12,
      headwayMinutes: 12,
      medianRuntimeMinutes: 6,
      distanceKm: 2,
      speedKph: 20,
    }],
  }

  return {
    id,
    name,
    provider: name,
    versionLabel: 'fixture',
    importedAt: '2026-06-30T00:00:00.000Z',
    source: 'local-file',
    fileName: `${id}.zip`,
    fileSize: 1,
    hash: id,
    qualityScore: 100,
    routeCount: 1,
    stopCount: 2,
    tripCount: 12,
    transferCandidates: 0,
    requiredTables: {},
    optionalTables: {},
    tableProfiles: [],
    warnings: [],
    routeMetrics: preview.routes,
    stopMetrics: preview.stops,
    mapPreview: preview,
  }
}

const feedA = feed('feed-a', 'Feed A', 'Origin terminal')
const feedB = feed('feed-b', 'Feed B', 'Destination terminal')
const feedAPreview = scopePreviewToFeed(feedA, feedA.mapPreview)
const feedBPreview = scopePreviewToFeed(feedB, feedB.mapPreview)
const bundlePreview = {
  routes: [...feedAPreview.routes, ...feedBPreview.routes],
  stops: [...feedAPreview.stops, ...feedBPreview.stops],
  stopPairs: [...feedAPreview.stopPairs, ...feedBPreview.stopPairs],
}

assert.notEqual(bundlePreview.routes[0].id, bundlePreview.routes[1].id)
assert.notEqual(bundlePreview.stops[0].id, bundlePreview.stops[2].id)
assert.ok(bundlePreview.stops.every((item) => item.routes.every((routeRef) => routeRef.startsWith(`${item.id.split('::')[0]}::`))))

rmSync(outDir, { recursive: true, force: true })
console.log('Network truth fixture check passed.')
