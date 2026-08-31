import { statSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const searchStoreCache = new Map()
const maximumSearchStores = 4

function storageIdentity(storePath) {
  const stats = statSync(storePath)
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`
}

function closeSearchStore(entry) {
  try { entry?.db?.close() } catch {}
}

function openSearchStore(storePath) {
  const resolvedStorePath = path.resolve(storePath)
  const identity = storageIdentity(resolvedStorePath)
  const cached = searchStoreCache.get(resolvedStorePath)
  if (cached?.identity === identity) {
    searchStoreCache.delete(resolvedStorePath)
    searchStoreCache.set(resolvedStorePath, cached)
    return cached.db
  }
  if (cached) {
    searchStoreCache.delete(resolvedStorePath)
    closeSearchStore(cached)
  }
  const db = new DatabaseSync(resolvedStorePath, { readOnly: true })
  db.exec('PRAGMA query_only=ON; PRAGMA mmap_size=1073741824; PRAGMA cache_size=-8192; PRAGMA temp_store=MEMORY;')
  searchStoreCache.set(resolvedStorePath, { db, identity })
  while (searchStoreCache.size > maximumSearchStores) {
    const oldestPath = searchStoreCache.keys().next().value
    const oldest = searchStoreCache.get(oldestPath)
    searchStoreCache.delete(oldestPath)
    closeSearchStore(oldest)
  }
  return db
}

export function disposeNationalStopSearchStore(storePath) {
  const resolvedStorePath = path.resolve(storePath)
  const entry = searchStoreCache.get(resolvedStorePath)
  if (!entry) return
  searchStoreCache.delete(resolvedStorePath)
  closeSearchStore(entry)
}

export function searchNationalGtfsStops(storePath, query, limit = 8) {
  const normalized = String(query ?? '').trim()
  if (normalized.length < 2) return []
  const rows = openSearchStore(storePath).prepare(`
    WITH matching_groups AS (
      SELECT COALESCE(NULLIF(parent_station,''), stop_id) AS station_id,
        MIN(CASE
          WHEN lower(name) = lower(?) THEN 0
          WHEN lower(name) LIKE lower(?) THEN 1
          ELSE 2
        END) AS match_rank
      FROM stops
      WHERE lower(name) LIKE lower(?)
      GROUP BY COALESCE(NULLIF(parent_station,''), stop_id)
    ), group_statistics AS (
      SELECT matching_groups.station_id,
        SUM(CASE
          WHEN lat IS NOT NULL AND lon IS NOT NULL
            AND lat BETWEEN -90 AND 90 AND lon BETWEEN -180 AND 180
            AND NOT (ABS(lat) < 0.000000001 AND ABS(lon) < 0.000000001)
            AND COALESCE(location_type, 0) IN (0, 1, 4)
          THEN 1 ELSE 0
        END) AS platform_count
      FROM matching_groups
      JOIN stops ON stops.stop_id = matching_groups.station_id OR stops.parent_station = matching_groups.station_id
      GROUP BY matching_groups.station_id
    ), ranked_names AS (
      SELECT matching_groups.station_id, stops.name,
        ROW_NUMBER() OVER (
          PARTITION BY matching_groups.station_id
          ORDER BY CASE
            WHEN stops.stop_id = matching_groups.station_id AND COALESCE(stops.location_type, 0) = 1 THEN 0
            WHEN stops.stop_id = matching_groups.station_id THEN 1
            WHEN COALESCE(stops.location_type, 0) IN (0, 4) THEN 2
            WHEN COALESCE(stops.location_type, 0) = 1 THEN 3
            WHEN COALESCE(stops.location_type, 0) = 2 THEN 4
            ELSE 5
          END, length(stops.name), stops.name, stops.stop_id
        ) AS name_rank
      FROM matching_groups
      JOIN stops ON stops.stop_id = matching_groups.station_id OR stops.parent_station = matching_groups.station_id
    ), ranked_coordinates AS (
      SELECT matching_groups.station_id, stops.lat, stops.lon,
        ROW_NUMBER() OVER (
          PARTITION BY matching_groups.station_id
          ORDER BY CASE
            WHEN stops.stop_id = matching_groups.station_id AND COALESCE(stops.location_type, 0) = 1 THEN 0
            WHEN COALESCE(stops.location_type, 0) IN (0, 4) THEN 1
            WHEN COALESCE(stops.location_type, 0) = 1 THEN 2
            WHEN COALESCE(stops.location_type, 0) = 2 THEN 3
            ELSE 4
          END, stops.stop_id
        ) AS coordinate_rank
      FROM matching_groups
      JOIN stops ON stops.stop_id = matching_groups.station_id OR stops.parent_station = matching_groups.station_id
      WHERE stops.lat IS NOT NULL AND stops.lon IS NOT NULL
        AND stops.lat BETWEEN -90 AND 90 AND stops.lon BETWEEN -180 AND 180
        AND NOT (ABS(stops.lat) < 0.000000001 AND ABS(stops.lon) < 0.000000001)
        AND COALESCE(stops.location_type, 0) != 3
    )
    SELECT matching_groups.station_id, ranked_names.name,
      ranked_coordinates.lat, ranked_coordinates.lon,
      MAX(1, group_statistics.platform_count) AS platform_count
    FROM matching_groups
    JOIN group_statistics ON group_statistics.station_id = matching_groups.station_id
    JOIN ranked_names ON ranked_names.station_id = matching_groups.station_id
      AND ranked_names.name_rank = 1
    JOIN ranked_coordinates ON ranked_coordinates.station_id = matching_groups.station_id
      AND ranked_coordinates.coordinate_rank = 1
    ORDER BY matching_groups.match_rank, platform_count DESC, name
    LIMIT ?
  `).all(normalized, `${normalized}%`, `%${normalized}%`, Math.max(1, Math.min(25, limit)))
  return rows.map((row) => ({
    id: row.station_id,
    name: row.name,
    coordinate: [row.lon, row.lat],
    platformCount: row.platform_count,
  }))
}
