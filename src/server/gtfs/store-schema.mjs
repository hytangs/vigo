export function createRoutingStoreSchema(db) {
  db.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE stops(stop_id TEXT PRIMARY KEY, name TEXT NOT NULL, lat REAL, lon REAL, parent_station TEXT, location_type INTEGER, platform_code TEXT);
    CREATE TABLE routes(route_id TEXT PRIMARY KEY, short_name TEXT, long_name TEXT, route_type INTEGER, color TEXT);
    CREATE TABLE trips(trip_id TEXT PRIMARY KEY, route_id TEXT NOT NULL, service_id TEXT NOT NULL, direction_id TEXT);
    CREATE TABLE route_services(
      source_scope TEXT NOT NULL,
      route_type INTEGER NOT NULL,
      service_key TEXT NOT NULL,
      representative_route_id TEXT NOT NULL,
      short_name TEXT,
      long_name TEXT,
      color TEXT,
      variant_count INTEGER NOT NULL,
      trip_count INTEGER NOT NULL,
      PRIMARY KEY(source_scope, route_type, service_key)
    ) WITHOUT ROWID;
    CREATE TABLE trip_shapes(trip_id TEXT PRIMARY KEY, shape_id TEXT NOT NULL);
    CREATE TABLE shape_points(shape_id TEXT NOT NULL, sequence INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, PRIMARY KEY(shape_id, sequence)) WITHOUT ROWID;
    CREATE TABLE calendar(service_id TEXT PRIMARY KEY, monday INTEGER, tuesday INTEGER, wednesday INTEGER, thursday INTEGER, friday INTEGER, saturday INTEGER, sunday INTEGER, start_date INTEGER, end_date INTEGER);
    CREATE TABLE calendar_dates(service_id TEXT NOT NULL, date INTEGER NOT NULL, exception_type INTEGER NOT NULL, PRIMARY KEY(service_id, date));
    CREATE TABLE transfers(from_stop_id TEXT NOT NULL, to_stop_id TEXT NOT NULL, transfer_type INTEGER, min_transfer_time INTEGER, PRIMARY KEY(from_stop_id, to_stop_id));
    CREATE TABLE transfer_provenance(
      from_stop_id TEXT NOT NULL,
      to_stop_id TEXT NOT NULL,
      provenance TEXT NOT NULL CHECK(provenance IN ('gtfs_transfer', 'gtfs_pathway', 'schedule_transfer', 'schedule_pathway', 'osm_certified_radial')),
      evidence_fingerprint TEXT,
      path_distance_m REAL,
      CHECK(
        (provenance='osm_certified_radial' AND evidence_fingerprint IS NOT NULL AND path_distance_m>=0)
        OR (provenance='gtfs_pathway' AND evidence_fingerprint IS NULL AND path_distance_m>=0)
        OR (provenance!='osm_certified_radial' AND evidence_fingerprint IS NULL AND path_distance_m IS NULL)
      ),
      PRIMARY KEY(from_stop_id, to_stop_id)
    ) WITHOUT ROWID;
    CREATE TABLE frequencies(trip_id TEXT NOT NULL, start_time INTEGER NOT NULL, end_time INTEGER NOT NULL, headway_secs INTEGER NOT NULL, exact_times INTEGER);
    CREATE TABLE connections(departure INTEGER NOT NULL, arrival INTEGER NOT NULL, trip_id TEXT NOT NULL, route_id TEXT NOT NULL, service_id TEXT NOT NULL, direction_id TEXT, from_stop_id TEXT NOT NULL, to_stop_id TEXT NOT NULL, stop_sequence INTEGER NOT NULL, PRIMARY KEY(trip_id, stop_sequence)) WITHOUT ROWID;
    CREATE TABLE connection_permissions(
      trip_id TEXT NOT NULL,
      stop_sequence INTEGER NOT NULL,
      can_board INTEGER NOT NULL,
      can_alight INTEGER NOT NULL,
      PRIMARY KEY(trip_id, stop_sequence)
    ) WITHOUT ROWID;
    CREATE TABLE stop_access_roles(
      stop_id TEXT PRIMARY KEY,
      can_board INTEGER NOT NULL CHECK(can_board IN (0, 1)),
      can_alight INTEGER NOT NULL CHECK(can_alight IN (0, 1))
    ) WITHOUT ROWID;
  `)
}

export function assertNoBrokenGtfsReferences(db) {
  const checks = [
    {
      query: `
        SELECT trips.trip_id AS owner_id, trips.route_id AS referenced_id
        FROM trips LEFT JOIN routes ON routes.route_id=trips.route_id
        WHERE routes.route_id IS NULL LIMIT 1
      `,
      relation: 'trips.route_id -> routes.route_id',
    },
    {
      query: `
        SELECT trips.trip_id AS owner_id, trips.service_id AS referenced_id
        FROM trips
        WHERE NOT EXISTS (SELECT 1 FROM calendar WHERE calendar.service_id=trips.service_id)
          AND NOT EXISTS (SELECT 1 FROM calendar_dates WHERE calendar_dates.service_id=trips.service_id)
        LIMIT 1
      `,
      relation: 'trips.service_id -> calendar/calendar_dates.service_id',
    },
    {
      query: `
        SELECT stops.stop_id AS owner_id, stops.parent_station AS referenced_id
        FROM stops LEFT JOIN stops AS parents ON parents.stop_id=stops.parent_station
        WHERE stops.parent_station IS NOT NULL AND parents.stop_id IS NULL LIMIT 1
      `,
      relation: 'stops.parent_station -> stops.stop_id',
    },
    {
      query: `
        SELECT transfers.from_stop_id AS owner_id, transfers.from_stop_id AS referenced_id
        FROM transfers LEFT JOIN stops ON stops.stop_id=transfers.from_stop_id
        WHERE stops.stop_id IS NULL LIMIT 1
      `,
      relation: 'transfers.from_stop_id -> stops.stop_id',
    },
    {
      query: `
        SELECT transfers.to_stop_id AS owner_id, transfers.to_stop_id AS referenced_id
        FROM transfers LEFT JOIN stops ON stops.stop_id=transfers.to_stop_id
        WHERE stops.stop_id IS NULL LIMIT 1
      `,
      relation: 'transfers.to_stop_id -> stops.stop_id',
    },
    {
      query: `
        SELECT frequencies.trip_id AS owner_id, frequencies.trip_id AS referenced_id
        FROM frequencies LEFT JOIN trips ON trips.trip_id=frequencies.trip_id
        WHERE trips.trip_id IS NULL LIMIT 1
      `,
      relation: 'frequencies.trip_id -> trips.trip_id',
    },
  ]
  for (const check of checks) {
    const violation = db.prepare(check.query).get()
    if (!violation) continue
    throw new Error(
      `Broken GTFS reference ${check.relation}: ${violation.owner_id || '(missing)'} references ${violation.referenced_id || '(missing)'}.`,
    )
  }
}

function ensureRouteServiceCatalogSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS route_services(
      source_scope TEXT NOT NULL,
      route_type INTEGER NOT NULL,
      service_key TEXT NOT NULL,
      representative_route_id TEXT NOT NULL,
      short_name TEXT,
      long_name TEXT,
      color TEXT,
      variant_count INTEGER NOT NULL,
      trip_count INTEGER NOT NULL,
      PRIMARY KEY(source_scope, route_type, service_key)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS route_services_representative ON route_services(representative_route_id);
    CREATE INDEX IF NOT EXISTS route_services_trip_rank ON route_services(source_scope, trip_count DESC, route_type, service_key);
  `)
}

function refreshRouteServiceCatalog(db) {
  ensureRouteServiceCatalogSchema(db)
  db.exec(`
    DELETE FROM route_services;
    INSERT INTO route_services(
      source_scope, route_type, service_key, representative_route_id,
      short_name, long_name, color, variant_count, trip_count
    )
    WITH route_trip_counts AS (
      SELECT route_id, COUNT(*) AS trip_count
      FROM trips INDEXED BY trips_route
      GROUP BY route_id
    )
    SELECT
      CASE
        WHEN INSTR(route.route_id, CHAR(31)) > 0
          THEN SUBSTR(route.route_id, 1, INSTR(route.route_id, CHAR(31)) - 1)
        ELSE ''
      END AS source_scope,
      COALESCE(route.route_type, 3) AS route_type,
      CASE
        WHEN INSTR(route.route_id, CHAR(31)) > 0
          THEN SUBSTR(route.route_id, INSTR(route.route_id, CHAR(31)) + 1)
        ELSE route.route_id
      END AS service_key,
      route.route_id,
      route.short_name,
      route.long_name,
      route.color,
      1 AS variant_count,
      COALESCE(route_trip_counts.trip_count, 0) AS trip_count
    FROM routes AS route
    LEFT JOIN route_trip_counts ON route_trip_counts.route_id=route.route_id;
  `)
}

export function rebuildStopAccessRoles(db) {
  const hasConnectionPermissions = db.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type='table' AND name='connection_permissions'
  `).get()?.present === 1
  const permissionJoin = hasConnectionPermissions
    ? `LEFT JOIN connection_permissions AS permission
        ON permission.trip_id=connection.trip_id
        AND permission.stop_sequence=connection.stop_sequence`
    : ''
  db.exec(`
    CREATE TABLE IF NOT EXISTS stop_access_roles(
      stop_id TEXT PRIMARY KEY,
      can_board INTEGER NOT NULL CHECK(can_board IN (0, 1)),
      can_alight INTEGER NOT NULL CHECK(can_alight IN (0, 1))
    ) WITHOUT ROWID;
    DELETE FROM stop_access_roles;
    INSERT OR IGNORE INTO stop_access_roles(stop_id, can_board, can_alight)
    SELECT connection.from_stop_id, 1, 0
    FROM connections AS connection
    ${permissionJoin}
    WHERE ${hasConnectionPermissions ? 'COALESCE(permission.can_board, 1)' : '1'}=1;
    INSERT INTO stop_access_roles(stop_id, can_board, can_alight)
    SELECT connection.to_stop_id, 0, 1
    FROM connections AS connection
    ${permissionJoin}
    WHERE ${hasConnectionPermissions ? 'COALESCE(permission.can_alight, 1)' : '1'}=1
    ON CONFLICT(stop_id) DO UPDATE SET can_alight=1;
  `)
  return Number(db.prepare('SELECT COUNT(*) AS count FROM stop_access_roles').get()?.count ?? 0)
}

// The covering departure index belongs to the raw-build SQL lane only. Runtime
// routing uses the in-memory/native active-service representation; compacted
// stores intentionally do not retain or recreate this index.
export function ensureNationalGtfsRawSqlDepartureIndex(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS connections_from_departure_cover
      ON connections(from_stop_id, departure, service_id, trip_id, stop_sequence, arrival, to_stop_id);
  `)
}

export function createRoutingStoreIndexes(db, { forCity = false } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stop_modes AS
      SELECT COALESCE(NULLIF(s.parent_station, ''), c.from_stop_id) AS stop_id,
        r.route_type AS route_type, COUNT(*) AS departure_count
      FROM connections c
      JOIN stops s ON s.stop_id=c.from_stop_id
      JOIN routes r ON r.route_id=c.route_id
      LEFT JOIN connection_permissions permission
        ON permission.trip_id=c.trip_id AND permission.stop_sequence=c.stop_sequence
      WHERE COALESCE(permission.can_board, 1)=1
      GROUP BY COALESCE(NULLIF(s.parent_station, ''), c.from_stop_id), r.route_type;
    CREATE UNIQUE INDEX IF NOT EXISTS stop_modes_stop_type ON stop_modes(stop_id, route_type);
    CREATE INDEX IF NOT EXISTS stop_modes_type_stop ON stop_modes(route_type, stop_id);
    CREATE INDEX stops_lat_lon ON stops(lat, lon);
    CREATE INDEX stops_parent ON stops(parent_station);
    CREATE INDEX routes_service_identity ON routes(
      route_type,
      LOWER(COALESCE(NULLIF(TRIM(short_name), ''), NULLIF(TRIM(long_name), ''), route_id)),
      route_id
    );
    CREATE INDEX trips_service ON trips(service_id);
    CREATE INDEX trips_route ON trips(route_id, trip_id);
    CREATE INDEX trip_shapes_shape ON trip_shapes(shape_id, trip_id);
    CREATE INDEX calendar_dates_date ON calendar_dates(date, exception_type);
    CREATE INDEX transfers_from ON transfers(from_stop_id);
  `)
  if (!forCity) ensureNationalGtfsRawSqlDepartureIndex(db)
  rebuildStopAccessRoles(db)
  refreshRouteServiceCatalog(db)
  db.exec('ANALYZE;')
}
