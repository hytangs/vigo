import { DatabaseSync } from 'node:sqlite'
import { coastGeometryLimits, joinLines, nearestCoastSide, oceanPolygons, polygonWithHoles, signedArea, simplifyLine } from './local-basemap-geometry.mjs'

const schemaVersion = 'vigo.local-basemap.v1'
const roadClasses = new Map([
  ['motorway', [0, 5]], ['trunk', [1, 6]], ['primary', [2, 8]],
  ['secondary', [3, 10]], ['tertiary', [4, 12]],
])
const tolerances = [0.001, 0.00012, 0.000008]
const maximumGeometryVertices = 8_000
const maximumRelationVertices = 200_000
export const localBasemapBudgets = Object.freeze({ features: 4_500, vertices: 80_000, coastFeatures: coastGeometryLimits.pieces, coastVertices: coastGeometryLimits.vertices, sqliteCacheKiB: 4_096 })

function classify(tags) {
  const roadClass = String(tags.highway ?? '').replace(/_link$/, '')
  const road = roadClasses.get(roadClass)
  if (road && tags.area !== 'yes') return { kind: 'road', roadClass, rank: road[0] + 3, minZoom: tags.highway.endsWith('_link') ? 12 : road[1] }
  if (tags.natural === 'coastline') return { kind: 'coastline', rank: 0, minZoom: 0 }
  if (tags.natural === 'water' || tags.waterway === 'riverbank' || ['reservoir', 'basin'].includes(tags.landuse)) {
    return { kind: 'water', rank: 1, minZoom: 0 }
  }
  if (['river', 'canal'].includes(tags.waterway) && tags.tunnel !== 'yes' && tags.covered !== 'yes') {
    return { kind: 'river', rank: 2, minZoom: tags.waterway === 'river' ? 8 : 12 }
  }
  return null
}

function geometryRings(geometry) {
  return geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates
}

function boundsOf(rings) {
  const bounds = [Infinity, -Infinity, Infinity, -Infinity]
  for (const ring of rings) for (const [lon, lat] of ring) {
    bounds[0] = Math.min(bounds[0], lon); bounds[1] = Math.max(bounds[1], lon)
    bounds[2] = Math.min(bounds[2], lat); bounds[3] = Math.max(bounds[3], lat)
  }
  return bounds
}

// Lives in the imported SQLite artifact and survives routing-table compaction.
// Temporary relation tables are on disk; no city-wide GeoJSON is kept in RAM.
export function createLocalBasemapWriter(db) {
  db.exec(`
    CREATE TABLE map_features(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, road_class TEXT,
      rank INTEGER NOT NULL, min_zoom INTEGER NOT NULL, area REAL NOT NULL,
      vertices INTEGER NOT NULL, geometry TEXT NOT NULL);
    CREATE VIRTUAL TABLE map_features_rtree USING rtree(id,west,east,south,north,min_lod,max_lod,min_rank,max_rank,min_zoom,max_zoom);
    CREATE TABLE map_relations(id INTEGER PRIMARY KEY,complete INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE map_members(relation_id INTEGER,way_id INTEGER,role TEXT,PRIMARY KEY(relation_id,way_id,role)) WITHOUT ROWID;
    CREATE INDEX map_members_way ON map_members(way_id);
    CREATE TABLE map_ways(id INTEGER PRIMARY KEY,geometry TEXT NOT NULL);
  `)
  const insertFeature = db.prepare('INSERT INTO map_features VALUES(?,?,?,?,?,?,?,?)')
  const insertBounds = db.prepare('INSERT INTO map_features_rtree VALUES(?,?,?,?,?,?,?,?,?,?,?)')
  const extendDetailRange = db.prepare('UPDATE map_features_rtree SET max_lod=? WHERE id=?')
  const insertRelation = db.prepare('INSERT OR IGNORE INTO map_relations(id) VALUES(?)')
  const incompleteRelation = db.prepare('UPDATE map_relations SET complete=0 WHERE id=?')
  const insertMember = db.prepare('INSERT OR IGNORE INTO map_members VALUES(?,?,?)')
  const memberExists = db.prepare('SELECT 1 FROM map_members WHERE way_id=? LIMIT 1')
  const insertWay = db.prepare('INSERT OR REPLACE INTO map_ways VALUES(?,?)')
  let featureId = 0, skippedRelations = 0, incompleteWays = 0
  const counts = { road: 0, water: 0, river: 0, coastline: 0 }
  const extent = [Infinity, -Infinity, Infinity, -Infinity]
  let sourceBounds = null

  const writeGeometry = (definition, geometry) => {
    const original = geometryRings(geometry)
    const bounds = boundsOf(original)
    if (!bounds.every(Number.isFinite)) return
    const area = geometry.type === 'Polygon' ? Math.abs(signedArea(original[0])) : 0
    const minZoom = geometry.type === 'Polygon'
      ? Math.max(definition.minZoom, area > 0.005 ? 0 : area > 0.0001 ? 8 : area > 0.000005 ? 11 : 14)
      : definition.minZoom
    let previousGeometry = null, previousId = null
    for (let lod = 0; lod < tolerances.length; lod += 1) {
      if (minZoom > [8, 12, 22][lod]) continue
      let rings = original.map((ring) => simplifyLine(ring, tolerances[lod]))
      let vertices = rings.reduce((sum, ring) => sum + ring.length, 0)
      // Cap even a single very intricate reservoir before serialization.
      for (let scale = 2; vertices > maximumGeometryVertices && scale <= 1024; scale *= 2) {
        rings = original.map((ring) => simplifyLine(ring, tolerances[lod] * scale))
        vertices = rings.reduce((sum, ring) => sum + ring.length, 0)
      }
      if (vertices > maximumGeometryVertices) continue
      const simplified = { type: geometry.type, coordinates: geometry.type === 'LineString' ? rings[0] : rings }
      const encoded = JSON.stringify(simplified)
      if (encoded === previousGeometry) {
        extendDetailRange.run(lod, previousId)
        continue
      }
      featureId += 1
      insertFeature.run(featureId, definition.kind, definition.roadClass ?? null, definition.rank, minZoom, area, vertices, encoded)
      insertBounds.run(featureId, ...bounds, lod, lod, definition.rank, definition.rank, minZoom, 22)
      previousGeometry = encoded; previousId = featureId
    }
    counts[definition.kind] += 1
    extent[0] = Math.min(extent[0], bounds[0]); extent[1] = Math.max(extent[1], bounds[1])
    extent[2] = Math.min(extent[2], bounds[2]); extent[3] = Math.max(extent[3], bounds[3])
  }

  return {
    setSourceBounds(bounds) {
      if (bounds && bounds.west < bounds.east && bounds.south < bounds.north) sourceBounds = bounds
    },
    selectRelation(relation, tags, strings) {
      if (tags.type !== 'multipolygon' || classify(tags)?.kind !== 'water') return
      insertRelation.run(relation.id)
      for (let i = 0; i < relation.refs.length; i += 1) {
        const role = strings[relation.roles[i]]
        if (role === undefined) throw new Error('OSM relation references an invalid role string.')
        if (relation.types[i] !== 1 && ['', 'outer', 'inner'].includes(role)) incompleteRelation.run(relation.id)
        if (relation.types[i] === 1 && ['', 'outer', 'inner'].includes(role)) {
          insertMember.run(relation.id, relation.refs[i], role === 'inner' ? 'inner' : 'outer')
        }
      }
    },
    needsWay(way, tags) { return Boolean(classify(tags) || memberExists.get(way.id)) },
    addWay(way, tags, getNode) {
      const definition = classify(tags)
      const member = Boolean(memberExists.get(way.id))
      if (!definition && !member) return
      if (way.refs.length > maximumRelationVertices) { incompleteWays += 1; return }
      const parts = [], points = []
      let current = []
      for (const id of way.refs) {
        const point = getNode.get(id)
        if (!point || !Number.isFinite(point.lon) || !Number.isFinite(point.lat)) {
          if (current.length > 1) parts.push(current)
          current = []
          continue
        }
        const coordinate = [Number(point.lon.toFixed(6)), Number(point.lat.toFixed(6))]
        current.push(coordinate); points.push(coordinate)
      }
      if (current.length > 1) parts.push(current)
      const complete = points.length === way.refs.length
      if (!complete) incompleteWays += 1
      if (member && complete && points.length <= maximumRelationVertices) insertWay.run(way.id, JSON.stringify(points))
      if (!definition) return
      if (definition.kind === 'water') {
        // Relations own their holes. Do not also paint a tagged member as a
        // solid standalone lake, which would flood its islands.
        if (!member && complete && way.refs.length >= 4 && way.refs[0] === way.refs.at(-1)) {
          writeGeometry(definition, { type: 'Polygon', coordinates: [points] })
        }
      } else {
        for (const part of parts) {
          // Spatially small pieces bound SQLite reads and coast processing.
          let start = 0
          for (let i = 1; i < part.length; i += 1) {
            if (i === part.length - 1 || i - start >= 127
              || Math.abs(part[i][0] - part[start][0]) > 0.05 || Math.abs(part[i][1] - part[start][1]) > 0.05) {
              writeGeometry(definition, { type: 'LineString', coordinates: part.slice(start, i + 1) })
              start = i
            }
          }
        }
      }
    },
    finish() {
      const members = db.prepare(`SELECT member.role,way.geometry FROM map_members AS member
        LEFT JOIN map_ways AS way ON way.id=member.way_id WHERE member.relation_id=?`)
      for (const { id, complete: supported } of db.prepare('SELECT id,complete FROM map_relations').iterate()) {
        if (!supported) { skippedRelations += 1; continue }
        const outer = [], inner = []
        let vertices = 0, complete = true
        for (const member of members.iterate(id)) {
          if (!member.geometry) { complete = false; break }
          const line = JSON.parse(member.geometry)
          vertices += line.length
          if (vertices > maximumRelationVertices) { complete = false; break }
          ;(member.role === 'inner' ? inner : outer).push(line)
        }
        if (!complete) { skippedRelations += 1; continue }
        const outers = joinLines(outer), inners = joinLines(inner)
        if (!outers.length || [...outers, ...inners].some((ring) => ring.length < 4 || String(ring[0]) !== String(ring.at(-1)))) {
          skippedRelations += 1; continue
        }
        for (const polygon of polygonWithHoles(outers, inners)) writeGeometry({ kind: 'water', rank: 1, minZoom: 0 }, { type: 'Polygon', coordinates: polygon })
      }
      db.exec('DROP TABLE map_ways; DROP TABLE map_members; DROP TABLE map_relations;')
      return { schemaVersion, counts, rows: featureId, skippedRelations, incompleteWays,
        bounds: sourceBounds ?? (extent.every(Number.isFinite) ? { west: extent[0], east: extent[1], south: extent[2], north: extent[3] } : null) }
    },
  }
}

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
    for (const road of [false, true]) {
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
