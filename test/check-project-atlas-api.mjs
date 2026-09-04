import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { buildNationalGtfsStore } from '../src/server/national-gtfs-store.mjs'
import { startInMemoryVigoApi } from './helpers/in-memory-vigo-api.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-project-atlas-'))
const projectsRoot = path.join(folder, 'projects')
const configRoot = path.join(folder, 'config')
const projectId = 'project-routing-atlas'
const metaRoot = path.join(projectsRoot, projectId, '.vigo')
let apiRuntime

const routes = Array.from({ length: 150 }, (_, routeIndex) => ({
  id: `pattern-${routeIndex}`,
  patternId: `pattern-${routeIndex}`,
  routeId: `route-${routeIndex}`,
  shortName: `${routeIndex}`,
  longName: `Route ${routeIndex}`,
  tripCount: 1_000 - routeIndex,
  stopCount: 3,
  stopIds: [`stop-${routeIndex}`, `stop-${routeIndex + 1}`, `stop-${routeIndex + 2}`],
  coordinates: Array.from({ length: 300 }, (_, pointIndex) => [-77.2 + pointIndex / 10_000, 38.7 + routeIndex / 10_000]),
}))
const stops = Array.from({ length: 152 }, (_, stopIndex) => ({
  id: `stop-${stopIndex}`,
  name: `Stop ${stopIndex}`,
  lon: -77.2 + (stopIndex % 100) / 1_000,
  lat: 38.7 + Math.floor(stopIndex / 100) / 1_000,
  routes: stopIndex < 152 ? [`route-${Math.min(149, stopIndex)}`] : [],
  tripCount: stopIndex < 152 ? 1 : 0,
  transferScore: 0,
}))
const feed = {
  id: 'feed-project-store-only',
  name: 'Project store only',
  routeCount: 150,
  stopCount: stops.length,
  tripCount: 150_000,
  transferCandidates: 0,
  qualityScore: 100,
  routeMetrics: routes,
  stopMetrics: stops,
  mapPreview: {
    routes,
    stops,
    stopPairs: [],
    coverage: { capped: false, stopPairsIndexed: 0 },
  },
}
const projectRoutingStore = {
  schemaVersion: 'vigo.routing.store.v1',
  status: 'ready',
  fileName: 'project.sqlite',
  connectionCount: routes.length * 2,
}
const project = {
  schemaVersion: 'vigo.project.v1',
  id: projectId,
  name: 'Project routing atlas fixture',
  region: 'DC fixture',
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T00:00:00.000Z',
  storagePath: path.join(projectsRoot, projectId),
  summary: { feeds: 1, routes: 150, stops: stops.length, transferCandidates: 0, qualityScore: 100 },
  feeds: [
    {
      id: 'feed-without-store',
      name: 'Unrelated feed without a routing store',
      routeCount: 0,
      stopCount: 0,
      tripCount: 0,
      transferCandidates: 0,
      qualityScore: 0,
    },
    {
      id: feed.id,
      name: feed.name,
      routeCount: feed.routeCount,
      stopCount: feed.stopCount,
      tripCount: feed.tripCount,
      transferCandidates: feed.transferCandidates,
      qualityScore: feed.qualityScore,
      routingStore: projectRoutingStore,
    },
  ],
  jobs: [],
  artifacts: [],
  routingStore: projectRoutingStore,
}

try {
  await fs.mkdir(path.join(metaRoot, 'routing'), { recursive: true })
  await fs.writeFile(path.join(metaRoot, 'project.json'), JSON.stringify(project))
  const storePath = path.join(metaRoot, 'routing', 'project.sqlite')
  const zipPath = path.join(folder, 'atlas-fixture.zip')
  const archive = new JSZip()
  const csv = (header, rows) => `${[header, ...rows].join('\n')}\n`
  archive.file('agency.txt', csv(
    'agency_id,agency_name,agency_url,agency_timezone',
    ['fixture,Atlas fixture,https://example.test,America/New_York'],
  ))
  archive.file('stops.txt', csv(
    'stop_id,stop_name,stop_lat,stop_lon',
    stops.map((stop) => `${stop.id},${stop.name},${stop.lat},${stop.lon}`),
  ))
  archive.file('routes.txt', csv(
    'route_id,agency_id,route_short_name,route_long_name,route_type,route_color',
    routes.map((route) => `${route.routeId},fixture,${route.shortName},${route.longName},3,${route.color ?? '005DAA'}`),
  ))
  archive.file('trips.txt', csv(
    'route_id,service_id,trip_id,direction_id,shape_id',
    routes.map((route, routeIndex) => `${route.routeId},service,trip-${routeIndex},0,shape-${routeIndex}`),
  ))
  archive.file('stop_times.txt', csv(
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    routes.flatMap((route, routeIndex) => [0, 1, 2].map((stopOffset) => {
      const minutes = stopOffset * 10
      const time = `08:${String(minutes).padStart(2, '0')}:00`
      return `trip-${routeIndex},${time},${time},stop-${routeIndex + stopOffset},${stopOffset + 1}`
    })),
  ))
  archive.file('calendar_dates.txt', csv(
    'service_id,date,exception_type',
    ['service,20260713,1'],
  ))
  archive.file('shapes.txt', csv(
    'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence',
    routes.flatMap((route, routeIndex) => route.coordinates.map(
      ([lon, lat], pointIndex) => `shape-${routeIndex},${lat},${lon},${pointIndex + 1}`,
    )),
  ))
  await fs.writeFile(zipPath, await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  await buildNationalGtfsStore({ zipPath, outputPath: storePath })
  apiRuntime = await startInMemoryVigoApi({
    repositoryRoot: root,
    environment: {
      VIGO_PROJECTS_DIR: projectsRoot,
      VIGO_CONFIG_DIR: configRoot,
    },
  })
  const apiUrl = apiRuntime.baseUrl
  const response = await apiRuntime.fetch(
    new URL(`api/projects/${projectId}`, apiUrl),
  )
  const responseText = await response.text()
  assert.equal(response.status, 200, responseText)
  const detail = JSON.parse(responseText).project
  const unrelatedFeed = detail.feeds.find((candidate) => candidate.id === 'feed-without-store')
  const routedFeed = detail.feeds.find((candidate) => candidate.id === feed.id)
  assert.equal(unrelatedFeed.routingStore, undefined, 'An unrelated outer feed must not inherit the project store.')
  assert(unrelatedFeed.warnings.some((warning) => warning.id === 'routing-store-missing'))
  const atlas = routedFeed.mapPreview
  const shapePoints = atlas.routes.reduce((sum, route) => sum + route.coordinates.length, 0)
  assert.equal(atlas.routes.length, 150, 'Every public route must remain available in the opened project atlas.')
  assert(atlas.stops.length <= 1_000)
  assert.equal(atlas.stopPairs.length, 0)
  assert.equal(shapePoints, 45_000, 'Shape-backed routes must retain every source point.')
  assert(atlas.routes.every((route) => route.geometrySource === 'shape'))
  assert(atlas.routes.every((route) => route.coordinates.length === 300))
  assert.deepEqual(
    atlas.routes.find((route) => route.routeId === 'route-149').coordinates,
    routes[149].coordinates,
    'The project API must not simplify or uniformly sample exact GTFS shape evidence.',
  )
  assert.equal(atlas.coverage.sourceScope, undefined)
  assert.equal(atlas.coverage.transportLod.stopPairsDeferred, 0)
  assert.equal(detail.summary.routes, 150, 'LOD must not rewrite exact project totals.')
  assert(Buffer.byteLength(responseText) < 10_000_000)
  console.log(JSON.stringify({
    check: 'project-atlas-api',
    responseBytes: Buffer.byteLength(responseText),
    routes: atlas.routes.length,
    stops: atlas.stops.length,
    shapePoints,
    unrelatedFeedRoutingStore: unrelatedFeed.routingStore ?? null,
  }, null, 2))
} finally {
  await apiRuntime?.stop()
  await fs.rm(folder, { recursive: true, force: true })
}
