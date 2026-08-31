import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const read = (relativePath) => readFileSync(path.join(root, relativePath), 'utf8')

const packageJson = JSON.parse(read('package.json'))
const app = read('src/App.tsx')
const routingHook = read('src/app/useNationalRouting.ts')
const routingModel = read('src/routingModel.ts')
const routingUi = read('src/routingUi.ts')
const api = read('server/vigo-api.mjs')
const worker = read('server/national-route-worker.mjs')
const osmImportWorker = read('server/national-osm-worker.mjs')
const engine = read('server/national-gtfs-store.mjs')
const osmEngine = read('server/national-osm-store.mjs')
const cli = read('scripts/vigo-cli.ts')
const projectStreetRebuild = read('scripts/rebuild-project-street-store.mjs')

const removedFiles = [
  'src/timeAwareRouting.ts',
  'src/osmWalkNetwork.ts',
  'scripts/check-routing-fixtures.mjs',
  'scripts/perf-attribution.mjs',
  'scripts/lib/routing-engine.mjs',
  'scripts/run-dc-student-monte-carlo.mjs',
]
for (const relativePath of removedFiles) {
  assert(!existsSync(path.join(root, relativePath)), `Legacy router artifact still exists: ${relativePath}`)
}

const scriptCommands = Object.values(packageJson.scripts ?? {}).join('\n')
for (const relativePath of removedFiles.filter((file) => file.startsWith('scripts/'))) {
  assert(!scriptCommands.includes(relativePath), `package.json still exposes removed router artifact: ${relativePath}`)
}

assert(app.includes("from './routingModel'"), 'The UI must consume the transport-neutral routing result model.')
assert(app.includes("from './routingUi'"), 'The UI must keep search helpers separate from the routing engine.')
assert(!app.includes('planRouteChoices'), 'The desktop must not contain a browser routing implementation.')
assert(routingHook.includes('/national-route'), 'Desktop route requests must cross the canonical national-route boundary.')
assert(api.includes("action === 'national-route'"), 'The API must expose exactly one desktop route action.')
assert(api.includes("new URL('./national-route-worker.mjs'"), 'Desktop routing must execute in the packaged route worker.')
assert(worker.includes("import('./national-gtfs-store.mjs')"), 'The route worker must lazily import the canonical transit engine.')
assert(!worker.includes("from './national-gtfs-store.mjs'"), 'Standalone street routing must not eagerly load the transit backend.')
assert(worker.includes('routeNationalGtfsStore'), 'The route worker must call the canonical point router.')
assert(worker.includes('routeNationalGtfsDepartureWindow'), 'The route worker must call the canonical profile router.')
assert(worker.includes('routeNationalGtfsMatrix'), 'The route worker must call the canonical matrix router.')
assert(!existsSync(path.join(root, 'server/national-matrix-worker.mjs')), 'Matrix routing must not retain a second per-request worker entrypoint.')
assert(cli.includes("from '../server/national-gtfs-store.mjs'"), 'The CLI must import the same canonical SQLite engine as the desktop worker.')
assert(cli.includes('buildNationalGtfsStore') && cli.includes('mergeNationalGtfsStores'), 'The CLI must compile raw GTFS with the production store builders.')
assert(cli.includes('buildNationalOsmStore'), 'The CLI must compile raw OSM with the production street-store builder.')
assert(cli.includes('routeNationalGtfsStore'), 'The CLI point-query surface must call the canonical router.')
assert(cli.includes('routeNationalGtfsDepartureWindow'), 'The CLI profile surface must call the canonical router.')
assert(projectStreetRebuild.includes('compactNationalOsmRuntimeStore'), 'Project street rebuilds must seal the published OSM store before activation.')
assert(osmImportWorker.includes('compactNationalOsmRuntimeStore'), 'GUI OSM imports must seal the street store before publication.')
assert(osmImportWorker.includes('buildNativeStreetCchIndex'), 'GUI OSM imports must publish the pedestrian CCH required by routing.')
assert(api.includes('storageLayout: message.result.storageLayout'), 'The API must persist the sealed OSM storage layout in project metadata.')
assert(osmEngine.includes('function openRuntimeStreetStore'), 'Street queries must use the sealed runtime admission path.')
assert(osmEngine.includes('function openSourceStreetStore'), 'Raw OSM tables must remain compiler-only.')
assert(!osmEngine.includes('function admitStreetStore'), 'The removed dual-layout street admission function must not return.')
assert(!api.includes('FROM walk_nodes AS from_node'), 'The local-streets API must not retain a raw SQLite geometry fallback.')
assert(!api.includes('JOIN edges AS edge ON edge.from_node'), 'The local-streets API must use the sealed street snapshot.')
assert.match(engine, /export function routeNationalGtfsStore\(/, 'The canonical SQLite point router must remain exported.')
assert.match(engine, /export function routeNationalGtfsDepartureWindow\(/, 'The canonical SQLite profile router must remain exported.')
assert.match(engine, /export function routeNationalGtfsMatrix\(/, 'The canonical SQLite matrix router must remain exported.')
assert(routingModel.includes("RoutingTravelMode = 'transit' | 'walk' | 'drive'"), 'The result model must expose the transit, walk, and drive modes returned by the SQLite engines.')
assert(!routingModel.includes("'bike'") && !routingModel.includes("'personal'"), 'Unsupported personal-mode result types must remain removed.')
assert(!routingUi.includes('planTimeAwareRoute') && !routingUi.includes('planRouteChoices'), 'UI helpers must not hide a second router.')

console.log('Single resident-kernel router contract passed.')
