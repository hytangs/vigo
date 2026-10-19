// Public synthetic workload; no City, licensed feed or private benchmark input.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import { transitNetworkCatalog, transitNetworkInput, bundleNetworkScope } from '../src/server/transit-network-tiles.mjs'
import { registerNativeTransitNetwork, renderNativeTransitNetworkTile, releaseNativeTransitNetwork } from '../src/server/native-routing-kernel.mjs'

const routes = Array.from({ length: 400 }, (_, index) => ({
  id: `route-${index}`, routeId: `route-${index}`, shortName: String(index), longName: `Synthetic route ${index}`,
  routeType: index % 10 ? 3 : 1, color: '#2465a2', tripCount: 100, headwayMinutes: 12, spanHours: 20,
  stopCount: 10, frequencyClass: 'high', geometrySource: 'shape', points: [], stopIds: [],
  coordinates: Array.from({ length: 100 }, (_, point) => [4.8 + point / 500, 52.3 + index / 4000 + Math.sin(point / 10) / 1000]),
}))
const stops = routes.flatMap((route, index) => route.coordinates.filter((_, point) => point % 10 === 0).map(([lon, lat], point) => ({
  id: `stop-${index}-${point}`, name: `Synthetic stop ${index}-${point}`, lon, lat, routes: [route.id], tripCount: 100, transferScore: 0,
})))
const project = { id: 'synthetic-network-profile', feeds: [{ id: 'feed', name: 'Public synthetic fixture', routeCount: routes.length, stopCount: stops.length,
  importedAt: '2026-01-01', routingStore: { builtAt: '2026-01-01' }, mapPreview: { routes, stops, stopPairs: [] }, routeMetrics: [], stopMetrics: [],
}] }
const full = JSON.stringify(project)
const catalog = JSON.stringify(transitNetworkCatalog(project))
assert(!JSON.parse(catalog).feeds[0].mapPreview.routes[0].coordinates)
const summary = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return { samples: sorted.length, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.floor(sorted.length * .95)] }
}
const parse = text => { const start = performance.now(); const result = JSON.parse(text); assert.equal(result.feeds[0].mapPreview.routes.length, 400); return performance.now() - start }
const before = [], after = []
for (let n = 0; n < 128; n++) {
  const left = n % 2 ? parse(catalog) : parse(full)
  const right = n % 2 ? parse(full) : parse(catalog)
  if (n >= 8) { before.push(n % 2 ? right : left); after.push(n % 2 ? left : right) }
}
const input = JSON.stringify(transitNetworkInput(project, bundleNetworkScope))
const key = `profile-${crypto.randomUUID()}`
try {
  const start = performance.now()
  await registerNativeTransitNetwork(key, input)
  const registrationMs = performance.now() - start
  const samples = [], sizes = [], hashes = new Set()
  const z = 12, x = Math.floor((4.9 + 180) / 360 * 2 ** z), lat = 52.35 * Math.PI / 180
  const y = Math.floor((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2 * 2 ** z)
  for (let n = 0; n < 108; n++) {
    const start = performance.now()
    const bytes = await renderNativeTransitNetworkTile(key, z, x, y)
    const elapsed = performance.now() - start
    assert(bytes.length > 0)
    hashes.add(crypto.createHash('sha256').update(bytes).digest('hex'))
    if (n >= 8) { samples.push(elapsed); sizes.push(bytes.length) }
  }
  assert.equal(hashes.size, 1, 'Identical tiles must encode deterministically')
  const result = { schemaVersion: 'vigo.network-tiles.profile.v1', workload: { synthetic: true, routes: routes.length, vertices: 40000, stops: stops.length },
    catalog: { fullBytes: Buffer.byteLength(full), catalogBytes: Buffer.byteLength(catalog), fullParse: summary(before), catalogParse: summary(after) },
    native: { registrationMs, warmTile: summary(samples), tileBytes: sizes[0], tileSha256: [...hashes][0] },
    timingBoundary: 'Node JSON.parse on alternating identical synthetic catalogs; native registration and warm tile calls include the NAPI async boundary. Excludes HTTP, map rendering, SQLite preparation, and routing.',
  }
  if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally { releaseNativeTransitNetwork(key) }
