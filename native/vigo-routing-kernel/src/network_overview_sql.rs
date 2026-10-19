// Read-only queries moved from gtfs-analysis-store.mjs at e2fa31a.
pub(super) const REPRESENTATIVE_TRIP: &str = r#"SELECT trip.trip_id, trip.direction_id, shape.shape_id
      FROM trips AS trip INDEXED BY trips_route
      LEFT JOIN trip_shapes AS shape ON shape.trip_id=trip.trip_id
      WHERE trip.route_id=?
      ORDER BY CASE WHEN shape.shape_id IS NULL OR shape.shape_id='' THEN 1 ELSE 0 END, trip.trip_id
      LIMIT 1"#;

pub(super) const CANDIDATE_TRIPS: &str = r#"SELECT trip.trip_id, trip.direction_id, shape.shape_id
      FROM trips AS trip INDEXED BY trips_route
      LEFT JOIN trip_shapes AS shape ON shape.trip_id=trip.trip_id
      WHERE trip.route_id=?
      ORDER BY CASE WHEN shape.shape_id IS NULL OR shape.shape_id='' THEN 1 ELSE 0 END, trip.trip_id
      LIMIT 12"#;

pub(super) const CONNECTIONS: &str = r#"SELECT connection.departure, connection.arrival, connection.stop_sequence,
        source.stop_id AS from_stop_id, source.name AS from_name,
        source.lat AS from_lat, source.lon AS from_lon,
        source.parent_station AS from_parent_station,
        source.location_type AS from_location_type,
        source.platform_code AS from_platform_code,
        target.stop_id AS to_stop_id, target.name AS to_name,
        target.lat AS to_lat, target.lon AS to_lon,
        target.parent_station AS to_parent_station,
        target.location_type AS to_location_type,
        target.platform_code AS to_platform_code
      FROM connections AS connection
      JOIN stops AS source ON source.stop_id=connection.from_stop_id
      JOIN stops AS target ON target.stop_id=connection.to_stop_id
      WHERE connection.trip_id=?
      ORDER BY connection.stop_sequence, connection.from_stop_id, connection.to_stop_id"#;

pub(super) const SHAPE_POINTS: &str = r#"SELECT lon, lat
      FROM shape_points
      WHERE shape_id=?
      ORDER BY sequence"#;

pub(super) const SERVICE_STATS: &str = r#"WITH trip_bounds AS (
        SELECT trip.service_id,
          (
            SELECT connection.departure
            FROM connections AS connection
            WHERE connection.trip_id=trip.trip_id
            ORDER BY connection.stop_sequence
            LIMIT 1
          ) AS first_departure,
          (
            SELECT connection.arrival
            FROM connections AS connection
            WHERE connection.trip_id=trip.trip_id
            ORDER BY connection.stop_sequence DESC
            LIMIT 1
          ) AS last_arrival
        FROM trips AS trip INDEXED BY trips_route
        WHERE trip.route_id=?
      ),
      service_bounds AS (
        SELECT service_id,
          MIN(first_departure) AS first_departure,
          MAX(first_departure) AS last_departure,
          MAX(last_arrival) AS last_arrival,
          SUM(CASE WHEN last_arrival>=first_departure THEN last_arrival-first_departure ELSE 0 END) AS runtime_seconds,
          COUNT(*) AS trip_count
        FROM trip_bounds
        WHERE first_departure IS NOT NULL AND last_arrival IS NOT NULL
        GROUP BY service_id
      )
      SELECT MIN(first_departure) AS first_departure,
        MAX(last_arrival) AS last_arrival,
        SUM(runtime_seconds) AS runtime_seconds,
        SUM(trip_count) AS trip_count,
        SUM(CASE WHEN trip_count>1 THEN last_departure-first_departure ELSE 0 END) AS headway_span_seconds,
        SUM(CASE WHEN trip_count>1 THEN trip_count-1 ELSE 0 END) AS headway_gap_count
      FROM service_bounds"#;

pub(super) const SERVICES_LEGACY: &str = r#"WITH route_trip_counts AS (
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
        route.route_id AS representative_route_id,
        route.short_name, route.long_name, route.color,
        1 AS variant_count,
        COALESCE(route_trip_counts.trip_count, 0) AS trip_count
      FROM routes AS route
      LEFT JOIN route_trip_counts ON route_trip_counts.route_id=route.route_id
      WHERE (?1='' OR (route.route_id>=?2 AND route.route_id<?3))
      ORDER BY route.route_type,
        LOWER(COALESCE(NULLIF(TRIM(route.short_name), ''), NULLIF(TRIM(route.long_name), ''), route.route_id)),
        route.route_id"#;

pub(super) const SERVICES: &str = r#"SELECT source_scope, route_type, service_key, representative_route_id,
      short_name, long_name, color, variant_count, trip_count
    FROM route_services
    WHERE (?1='' OR source_scope=?1)
    ORDER BY route_type,
      LOWER(COALESCE(NULLIF(TRIM(short_name), ''), NULLIF(TRIM(long_name), ''), representative_route_id)),
      representative_route_id"#;
