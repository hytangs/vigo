//! Routing-store schema, reference checks, indexes and runtime compaction
//! (gtfs/store-schema.mjs and their callers in national-gtfs-store.mjs).

use super::metadata::{admit_compiler_input, metadata_record, read_store_metadata};
use super::schema_sql::*;
use super::{STOP_ACCESS_ROLE_INDEX_VERSION, resolve};
use crate::{Error, Result};
use rusqlite::{Connection, OptionalExtension};
use std::path::Path;
use std::time::Instant;
use vigo_format::js::Js;

pub fn create_schema(db: &Connection) -> Result<()> {
    db.execute_batch(ROUTING_STORE_SCHEMA)?;
    Ok(())
}

fn exists(db: &Connection, sql: &str) -> Result<bool> {
    Ok(db.query_row(sql, [], |_| Ok(())).optional()?.is_some())
}

/// `assertNoBrokenGtfsReferences(db)`.
pub fn assert_no_broken_references(db: &Connection) -> Result<()> {
    let mut checks: Vec<(String, String)> = Vec::new();
    for kind in ["stop", "route", "trip"] {
        for side in ["from", "to"] {
            checks.push((
                format!("SELECT r.{side}_{kind}_id AS owner_id,r.{side}_{kind}_id AS referenced_id FROM transfer_rules r LEFT JOIN {kind}s t ON t.{kind}_id=r.{side}_{kind}_id WHERE r.{side}_{kind}_id IS NOT NULL AND t.{kind}_id IS NULL LIMIT 1"),
                format!("transfer_rules.{side}_{kind}_id -> {kind}s.{kind}_id"),
            ));
        }
    }
    for field in ["from_trip_id", "to_trip_id"] {
        checks.push((
            format!("SELECT l.{field} AS owner_id,l.{field} AS referenced_id FROM trip_links l LEFT JOIN trips t ON t.trip_id=l.{field} WHERE t.trip_id IS NULL LIMIT 1"),
            format!("trip_links.{field} -> trips.trip_id"),
        ));
    }
    for (query, relation) in [
        (
            "SELECT trips.trip_id AS owner_id, trips.route_id AS referenced_id FROM trips LEFT JOIN routes ON routes.route_id=trips.route_id WHERE routes.route_id IS NULL LIMIT 1",
            "trips.route_id -> routes.route_id",
        ),
        (
            "SELECT trips.trip_id AS owner_id, trips.service_id AS referenced_id FROM trips WHERE NOT EXISTS (SELECT 1 FROM calendar WHERE calendar.service_id=trips.service_id) AND NOT EXISTS (SELECT 1 FROM calendar_dates WHERE calendar_dates.service_id=trips.service_id) LIMIT 1",
            "trips.service_id -> calendar/calendar_dates.service_id",
        ),
        (
            "SELECT stops.stop_id AS owner_id, stops.parent_station AS referenced_id FROM stops LEFT JOIN stops AS parents ON parents.stop_id=stops.parent_station WHERE stops.parent_station IS NOT NULL AND parents.stop_id IS NULL LIMIT 1",
            "stops.parent_station -> stops.stop_id",
        ),
        (
            "SELECT transfers.from_stop_id AS owner_id, transfers.from_stop_id AS referenced_id FROM transfers LEFT JOIN stops ON stops.stop_id=transfers.from_stop_id WHERE stops.stop_id IS NULL LIMIT 1",
            "transfers.from_stop_id -> stops.stop_id",
        ),
        (
            "SELECT transfers.to_stop_id AS owner_id, transfers.to_stop_id AS referenced_id FROM transfers LEFT JOIN stops ON stops.stop_id=transfers.to_stop_id WHERE stops.stop_id IS NULL LIMIT 1",
            "transfers.to_stop_id -> stops.stop_id",
        ),
        (
            "SELECT frequencies.trip_id AS owner_id, frequencies.trip_id AS referenced_id FROM frequencies LEFT JOIN trips ON trips.trip_id=frequencies.trip_id WHERE trips.trip_id IS NULL LIMIT 1",
            "frequencies.trip_id -> trips.trip_id",
        ),
    ] {
        checks.push((query.to_owned(), relation.to_owned()));
    }
    for side in ["from", "to"] {
        if exists(
            db,
            &format!(
                "SELECT 1 FROM transfer_rules r JOIN trips t ON t.trip_id=r.{side}_trip_id WHERE r.{side}_route_id IS NOT NULL AND r.{side}_route_id<>t.route_id LIMIT 1"
            ),
        )? {
            return Err(Error::new(format!(
                "Conflicting GTFS {side} trip and route transfer selectors."
            )));
        }
    }
    for (side, column, order) in [
        ("from", "to_stop_id", "DESC"),
        ("to", "from_stop_id", "ASC"),
    ] {
        if exists(
            db,
            &format!(
                "SELECT 1 FROM transfer_rules r JOIN stops s ON s.stop_id=r.{side}_stop_id WHERE r.transfer_type IN (4,5) AND (COALESCE(s.location_type,0)<>0 OR r.{side}_stop_id<>(SELECT {column} FROM connections c WHERE c.trip_id=r.{side}_trip_id ORDER BY stop_sequence {order} LIMIT 1)) LIMIT 1"
            ),
        )? {
            return Err(Error::new(format!(
                "GTFS linked-trip {side}_stop_id must identify its terminal platform."
            )));
        }
    }
    if exists(
        db,
        "SELECT 1 FROM frequencies GROUP BY trip_id HAVING MIN(exact_times)<>MAX(exact_times) LIMIT 1",
    )? {
        return Err(Error::new(
            "GTFS frequency windows for a trip must use one exact_times value.",
        ));
    }
    if exists(
        db,
        "SELECT 1 FROM frequencies a JOIN frequencies b ON a.trip_id=b.trip_id AND a.rowid<b.rowid WHERE a.start_time<b.end_time AND b.start_time<a.end_time LIMIT 1",
    )? {
        return Err(Error::new("Overlapping GTFS frequency windows."));
    }
    for (query, relation) in checks {
        let violation = db
            .query_row(&query, [], |row| {
                Ok((text_of(row.get_ref(0)?), text_of(row.get_ref(1)?)))
            })
            .optional()?;
        if let Some((owner, referenced)) = violation {
            let label = |v: String| {
                if v.is_empty() {
                    "(missing)".to_owned()
                } else {
                    v
                }
            };
            return Err(Error::new(format!(
                "Broken GTFS reference {relation}: {} references {}.",
                label(owner),
                label(referenced)
            )));
        }
    }
    Ok(())
}

/// `String(value)` of a SQLite value in an error message; null is falsy.
fn text_of(value: rusqlite::types::ValueRef) -> String {
    match value {
        rusqlite::types::ValueRef::Null => String::new(),
        rusqlite::types::ValueRef::Integer(n) => {
            if n == 0 {
                String::new()
            } else {
                n.to_string()
            }
        }
        rusqlite::types::ValueRef::Real(n) => {
            if n == 0.0 || n.is_nan() {
                String::new()
            } else {
                vigo_format::js::number(n)
            }
        }
        rusqlite::types::ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
        rusqlite::types::ValueRef::Blob(_) => "[object Uint8Array]".into(),
    }
}

/// `rebuildStopAccessRoles(db)`: the number of stops that can board or alight.
pub fn rebuild_stop_access_roles(db: &Connection) -> Result<i64> {
    let has_permissions = exists(
        db,
        "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='connection_permissions'",
    )?;
    let service_connections = if exists(
        db,
        "SELECT 1 FROM sqlite_master WHERE name='headway_connections'",
    )? {
        "(SELECT * FROM connections UNION ALL SELECT * FROM headway_connections)"
    } else {
        "connections"
    };
    let permission_join = if has_permissions {
        "LEFT JOIN connection_permissions AS permission ON permission.trip_id=connection.trip_id AND permission.stop_sequence=connection.stop_sequence"
    } else {
        ""
    };
    let board = if has_permissions {
        "COALESCE(permission.can_board, 1)"
    } else {
        "1"
    };
    let alight = if has_permissions {
        "COALESCE(permission.can_alight, 1)"
    } else {
        "1"
    };
    db.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS stop_access_roles(
      stop_id TEXT PRIMARY KEY,
      can_board INTEGER NOT NULL CHECK(can_board IN (0, 1)),
      can_alight INTEGER NOT NULL CHECK(can_alight IN (0, 1))
    ) WITHOUT ROWID;
    DELETE FROM stop_access_roles;
    INSERT OR IGNORE INTO stop_access_roles(stop_id, can_board, can_alight)
    SELECT connection.from_stop_id, 1, 0 FROM {service_connections} AS connection {permission_join} WHERE {board}=1;
    INSERT INTO stop_access_roles(stop_id, can_board, can_alight)
    SELECT connection.to_stop_id, 0, 1 FROM {service_connections} AS connection {permission_join} WHERE {alight}=1
    ON CONFLICT(stop_id) DO UPDATE SET can_alight=1;"
    ))?;
    Ok(db.query_row(
        "SELECT COUNT(*) AS count FROM stop_access_roles",
        [],
        |row| row.get(0),
    )?)
}

/// `createRoutingStoreIndexes(db, { forCity })`.
pub fn create_indexes(db: &Connection, for_city: bool) -> Result<()> {
    db.execute_batch(ROUTING_STORE_INDEXES)?;
    if !for_city {
        db.execute_batch(RAW_SQL_DEPARTURE_INDEX)?;
    }
    rebuild_stop_access_roles(db)?;
    db.execute_batch(ROUTE_SERVICE_CATALOG_SCHEMA)?;
    db.execute_batch(ROUTE_SERVICE_CATALOG_REFRESH)?;
    db.execute_batch("ANALYZE;")?;
    Ok(())
}

fn upsert(db: &Connection, key: &str, value: &Js) -> Result<()> {
    db.execute(
        "INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        rusqlite::params![key, value.stringify()],
    )?;
    Ok(())
}

/// `compactNationalGtfsRuntimeStore(storePath)`: drop the raw departure
/// index, mark it deferred, VACUUM, and retire derived sidecars.
pub fn compact_runtime_store(store: &Path) -> Result<Js> {
    let resolved = resolve(store);
    let already_deferred = admit_compiler_input(&resolved)?
        .get("departureIndexState")
        .and_then(Js::as_str)
        == Some("deferred");
    let before = std::fs::metadata(&resolved)?.len();
    let result = |built: bool, after: u64| {
        Js::object()
            .with("ready", true)
            .with("built", built)
            .with("state", "deferred")
            .with("beforeBytes", before)
            .with("afterBytes", after)
            .with("bytesSaved", before as f64 - after as f64)
    };
    if already_deferred {
        return Ok(result(false, before));
    }
    {
        let db = Connection::open(&resolved)?;
        let work = || -> Result<()> {
            db.execute_batch("BEGIN IMMEDIATE")?;
            db.execute_batch("DROP INDEX IF EXISTS connections_from_departure_cover")?;
            upsert(&db, "departureIndexState", &Js::from("deferred"))?;
            db.execute_batch("COMMIT")?;
            db.execute_batch("VACUUM")?;
            Ok(())
        };
        if let Err(error) = work() {
            let _ = db.execute_batch("ROLLBACK");
            return Err(error);
        }
    }
    let directory = resolved.parent().unwrap_or(Path::new("."));
    let prefix = format!("{}.", super::basename(&resolved));
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(suffix) = name.strip_prefix(&prefix) else {
            continue;
        };
        let kernel = |stem: &str| {
            suffix
                .strip_prefix(stem)
                .and_then(|rest| rest.strip_suffix(".bin"))
                .is_some_and(|middle| !middle.is_empty())
        };
        if suffix == "static-topology.sqlite"
            || suffix == "access-context.bin"
            || kernel("active-service-kernel.")
            || kernel("native-access-profile.")
        {
            std::fs::remove_file(entry.path())?;
        }
    }
    let after = std::fs::metadata(&resolved)?.len();
    Ok(result(true, after))
}

/// `ensureNationalGtfsStopAccessRoles(storePath)`.
pub fn ensure_stop_access_roles(store: &Path) -> Result<Js> {
    let resolved = resolve(store);
    let started = Instant::now();
    read_store_metadata(&resolved)?;
    let db = Connection::open(&resolved)?;
    let metadata = metadata_record(&db)?;
    let table_ready = exists(
        &db,
        "SELECT 1 AS ready FROM sqlite_master WHERE type='table' AND name='stop_access_roles'",
    )?;
    let retained: i64 = if table_ready {
        db.query_row(
            "SELECT COUNT(*) AS count FROM stop_access_roles",
            [],
            |row| row.get(0),
        )?
    } else {
        0
    };
    let elapsed =
        |started: Instant| ((started.elapsed().as_secs_f64() * 1000.0) * 1000.0).round() / 1000.0;
    let stored_count = match metadata.get("stopAccessRoleCount") {
        Some(Js::Number(n)) => *n,
        Some(Js::String(s)) => crate::jsval::to_number(s),
        Some(Js::Null) => 0.0,
        _ => -1.0,
    };
    if metadata
        .get("stopAccessRoleIndexVersion")
        .and_then(Js::as_str)
        == Some(STOP_ACCESS_ROLE_INDEX_VERSION)
        && stored_count == retained as f64
    {
        return Ok(Js::object()
            .with("ready", true)
            .with("built", false)
            .with("schemaVersion", STOP_ACCESS_ROLE_INDEX_VERSION)
            .with("stopCount", retained)
            .with("buildMs", elapsed(started)));
    }
    if metadata.get("departureIndexState").and_then(Js::as_str) != Some("deferred") {
        db.execute_batch(RAW_SQL_DEPARTURE_INDEX)?;
    }
    db.execute_batch("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;")?;
    let stop_count = match (|| -> Result<i64> {
        let count = rebuild_stop_access_roles(&db)?;
        upsert(
            &db,
            "stopAccessRoleIndexVersion",
            &Js::from(STOP_ACCESS_ROLE_INDEX_VERSION),
        )?;
        upsert(&db, "stopAccessRoleCount", &Js::from(count))?;
        db.execute_batch("COMMIT;")?;
        Ok(count)
    })() {
        Ok(count) => count,
        Err(error) => {
            let _ = db.execute_batch("ROLLBACK;");
            return Err(error);
        }
    };
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;")?;
    Ok(Js::object()
        .with("ready", true)
        .with("built", true)
        .with("schemaVersion", STOP_ACCESS_ROLE_INDEX_VERSION)
        .with("stopCount", stop_count)
        .with("buildMs", elapsed(started)))
}
