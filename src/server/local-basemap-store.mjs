import { DatabaseSync } from 'node:sqlite'
import { coastGeometryLimits, nearestCoastSide, oceanPolygons } from './local-basemap-geometry.mjs'

const schemaVersion = 'vigo.local-basemap.v1'
export const localBasemapBudgets = Object.freeze({ features: 4_500, vertices: 80_000, coastFeatures: coastGeometryLimits.pieces, coastVertices: coastGeometryLimits.vertices, sqliteCacheKiB: 4_096 })

const spatialSql = `FROM map_features_rtree AS box CROSS JOIN map_features AS feature ON feature.id=box.id
  WHERE box.west<=? AND box.east>=? AND box.south<=? AND box.north>=? AND box.min_lod<=? AND box.max_lod>=?
  AND box.min_rank<=? AND box.max_rank>=? AND box.min_zoom<=? AND box.max_zoom>=?`
const spatialArgs = (bounds, lod, minRank, maxRank, zoom) => [bounds.east, bounds.west, bounds.north, bounds.south, lod, lod, maxRank, minRank, zoom, zoom]

/** A short-lived 4 MiB SQLite page cache, no routing snapshot, no unbounded JS cache. */
export function readLocalBasemap(storePath, bounds, options = {}) {
  const zoom = Math.max(0, Math.min(22, Number(options.zoom) || 0))
  const lod = zoom < 9 ? 0 : zoom < 13 ? 1 : 2
  const limit = Math.max(1, Math.min(localBasemapBudgets.features, Math.floor(Number(options.limit) || localBasemapBudgets.features)))
  if (!bounds || !['west', 'east', 'south', 'north'].every((key) => Number.isFinite(bounds[key]))
    || bounds.west >= bounds.east || bounds.south >= bounds.north) throw new TypeError('Local basemap requires finite ordered bounds.')
  const db = new DatabaseSync(storePath, { readOnly: true })
  try {
    db.exec(`PRAGMA query_only=ON; PRAGMA cache_size=-${localBasemapBudgets.sqliteCacheKiB}; PRAGMA mmap_size=0; PRAGMA temp_store=FILE;`)
    const metadataRow = db.prepare("SELECT value FROM metadata WHERE key='localBasemap'").get()
    const stored = metadataRow ? JSON.parse(metadataRow.value) : null
    if (stored?.schemaVersion !== schemaVersion) return {
      type: 'FeatureCollection', features: [], metadata: { source: schemaVersion, status: 'needs-import',
        detail: 'Re-import this City’s OSM PBF to add main roads and water to the local map.' },
    }
    const features = []
    let vertexCount = 0, waterVertices = 0, waterFeatures = 0, sampled = false, coastlineComplete = null
    const waterFeatureLimit = Math.max(1, Math.floor(limit / 2))
    const addWaterFeature = (feature, vertices) => {
      if (waterFeatures >= waterFeatureLimit || waterVertices + vertices > localBasemapBudgets.vertices / 2) { sampled = true; return }
      features.push(feature); vertexCount += vertices; waterVertices += vertices; waterFeatures += 1
    }
    const readCoasts = (box) => {
      const lines = []
      let vertices = 0, complete = true
      for (const row of db.prepare(`SELECT feature.geometry,feature.vertices ${spatialSql} AND feature.kind='coastline' LIMIT ?`)
        .iterate(...spatialArgs(box, lod, 0, 0, zoom), localBasemapBudgets.coastFeatures + 1)) {
        if (lines.length >= localBasemapBudgets.coastFeatures || vertices + row.vertices > localBasemapBudgets.coastVertices) { complete = false; break }
        lines.push(JSON.parse(row.geometry).coordinates); vertices += row.vertices
      }
      return { lines, complete }
    }
    if (stored.counts.coastline && stored.bounds) {
      const oceanBounds = { west: Math.max(bounds.west, stored.bounds.west), east: Math.min(bounds.east, stored.bounds.east),
        south: Math.max(bounds.south, stored.bounds.south), north: Math.min(bounds.north, stored.bounds.north) }
      if (oceanBounds.west < oceanBounds.east && oceanBounds.south < oceanBounds.north) {
        const coasts = readCoasts(oceanBounds)
        const corner = [oceanBounds.west + 1e-8, oceanBounds.south + 1e-8]
        let reference = null
        for (let radius = 0.02; radius <= 32 && reference === null; radius *= 4) {
          const nearby = readCoasts({ west: corner[0] - radius, east: corner[0] + radius, south: corner[1] - radius, north: corner[1] + radius })
          if (nearby.complete) reference = nearestCoastSide(nearby.lines, corner)
          else break
        }
        const ocean = oceanPolygons(coasts.lines, oceanBounds, reference, coasts.complete)
        coastlineComplete = ocean.complete
        sampled ||= !coasts.complete || ocean.limited
        for (const coordinates of ocean.polygons) {
          const vertices = coordinates.reduce((sum, ring) => sum + ring.length, 0)
          addWaterFeature({ type: 'Feature', properties: { kind: 'ocean' }, geometry: { type: 'Polygon', coordinates } }, vertices)
        }
        // A thin shoreline remains useful when an extract has an incomplete coast.
        for (const coordinates of ocean.outlines) {
          addWaterFeature({ type: 'Feature', properties: { kind: 'coastline' }, geometry: { type: 'LineString', coordinates } }, coordinates.length)
        }
      }
    }
    // Independent budgets prevent many small ponds from displacing every road.
    // Sort only small metadata rows; fetch geometry after admission to the
    // response budget instead of carrying polygon JSON through SQLite's sorter.
    const readGeometry = db.prepare('SELECT geometry FROM map_features WHERE id=?')
    for (const road of options.waterOnly ? [false] : [false, true]) {
      const rows = db.prepare(`SELECT feature.id,feature.kind,feature.road_class,feature.vertices ${spatialSql} AND ${road ? "feature.kind='road'" : "feature.kind IN ('water','river')"}
        ORDER BY feature.rank,feature.area DESC,feature.id LIMIT ?`)
      for (const row of rows.iterate(...spatialArgs(bounds, lod, road ? 3 : 1, road ? 7 : 2, zoom), (road ? limit : waterFeatureLimit) + 1)) {
        if (features.length >= limit) { sampled = true; break }
        if (vertexCount + row.vertices > localBasemapBudgets.vertices) { sampled = true; continue }
        if (!road && (waterFeatures >= waterFeatureLimit || waterVertices + row.vertices > localBasemapBudgets.vertices / 2)) { sampled = true; continue }
        features.push({ type: 'Feature', id: row.id,
          properties: { kind: row.kind, roadClass: row.road_class }, geometry: JSON.parse(readGeometry.get(row.id).geometry) })
        vertexCount += row.vertices
        if (!road) { waterVertices += row.vertices; waterFeatures += 1 }
      }
    }
    return { type: 'FeatureCollection', features, metadata: { source: schemaVersion, status: 'ready', bbox: bounds, zoom,
      featureCount: features.length, vertexCount, sampled, coastlineComplete, skippedRelations: stored.skippedRelations, incompleteWays: stored.incompleteWays } }
  } finally { db.close() }
}
