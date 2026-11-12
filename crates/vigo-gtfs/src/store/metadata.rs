//! Store metadata, admission and source identities (gtfs/store-metadata.mjs).

use super::{STORE_SCHEMA_VERSION, TRANSFER_SEMANTICS_VERSION};
use crate::jsval;
use crate::{Error, Result};
use rusqlite::{Connection, OptionalExtension};
use std::io::Read;
use std::path::Path;
use vigo_format::js::{Js, quote};

pub const STATIC_TOPOLOGY_SOURCE_IDENTITY_VERSION: &str = "vigo.routing.static-topology-source.v3";

/// `metadataRecord(db)`: every key parsed as JSON, or kept as text.
pub fn metadata_record(db: &Connection) -> Result<Js> {
    let mut statement = db.prepare("SELECT key, value FROM metadata")?;
    let mut rows = statement.query([])?;
    let mut members = Vec::new();
    while let Some(row) = rows.next()? {
        let key: String = row.get(0)?;
        let value: String = match row.get_ref(1)? {
            rusqlite::types::ValueRef::Text(text) => String::from_utf8_lossy(text).into_owned(),
            rusqlite::types::ValueRef::Integer(n) => n.to_string(),
            rusqlite::types::ValueRef::Real(n) => vigo_format::js::number(n),
            _ => String::new(),
        };
        let parsed = jsval::parse_json(&value).unwrap_or(Js::String(value));
        members.push((key, parsed));
    }
    // Later duplicate keys replace earlier ones; objects order like JavaScript.
    let mut out: Vec<(String, Js)> = Vec::new();
    for (key, value) in members {
        match out.iter_mut().find(|(k, _)| *k == key) {
            Some(member) => member.1 = value,
            None => out.push((key, value)),
        }
    }
    Ok(jsval::object(out))
}

/// `stableJson(value)`: sorted keys, JSON.stringify leaves.
pub fn stable_json(value: &Js) -> String {
    match value {
        Js::Array(items) => format!(
            "[{}]",
            items.iter().map(stable_json).collect::<Vec<_>>().join(",")
        ),
        Js::Object(members) => {
            let mut keys: Vec<&(String, Js)> = members.iter().collect();
            // Array.prototype.sort compares UTF-16 code units.
            keys.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            format!(
                "{{{}}}",
                keys.iter()
                    .map(|(k, v)| format!("{}:{}", quote(k), stable_json(v)))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        other => other.stringify(),
    }
}

fn number_of(value: Option<&Js>, fallback: f64) -> f64 {
    // Number(value ?? fallback)
    match value {
        None | Some(Js::Null) => fallback,
        Some(Js::Number(n)) => *n,
        Some(Js::Bool(b)) => f64::from(u8::from(*b)),
        Some(Js::String(s)) => jsval::to_number(s),
        Some(Js::Array(items)) => match items.as_slice() {
            [] => 0.0,
            [one] => number_of(Some(one), f64::NAN),
            _ => f64::NAN,
        },
        Some(Js::Object(_)) => f64::NAN,
    }
}

fn or_null(value: Option<&Js>) -> Js {
    value.cloned().unwrap_or(Js::Null)
}

/// `staticTopologySourceIdentity(metadata)`.
pub fn static_topology_source_identity(metadata: &Js) -> String {
    let mut identity =
        Js::object().with("identityVersion", STATIC_TOPOLOGY_SOURCE_IDENTITY_VERSION);
    if let Some(accessibility) = metadata.get("accessibility").filter(|v| jsval::truthy(v)) {
        identity.set("accessibility", or_null(accessibility.get("profile")));
    }
    identity
        .set("storeId", or_null(metadata.get("storeId")))
        .set("schemaVersion", or_null(metadata.get("schemaVersion")))
        .set(
            "connectionCount",
            number_of(metadata.get("connectionCount"), -1.0),
        )
        .set(
            "transferCount",
            number_of(metadata.get("transferCount"), -1.0),
        )
        .set(
            "transferSemanticsVersion",
            or_null(metadata.get("transferSemanticsVersion")),
        )
        .set(
            "transferGeneration",
            or_null(metadata.get("transferGeneration")),
        )
        .set("stopCount", number_of(metadata.get("stopCount"), -1.0))
        .set(
            "bridgedUntimedGapCount",
            number_of(metadata.get("bridgedUntimedGapCount"), -1.0),
        );
    stable_json(&identity)
}

/// `staticTopologySourceFingerprint(metadata)`.
pub fn static_topology_source_fingerprint(metadata: &Js) -> String {
    let value = metadata
        .get("sourceFingerprint")
        .filter(|v| !matches!(v, Js::Null))
        .or_else(|| metadata.get("storeId").filter(|v| !matches!(v, Js::Null)));
    match value {
        None => String::new(),
        Some(Js::String(s)) => s.clone(),
        Some(Js::Number(n)) => vigo_format::js::number(*n),
        Some(other) => other.stringify(),
    }
}

fn file_generation(path: &Path, header_bytes: usize) -> Result<String> {
    let Ok(metadata) = std::fs::metadata(path) else {
        return Ok(String::new());
    };
    let mut header = vec![0u8; header_bytes];
    let mut file = std::fs::File::open(path)?;
    let mut read = 0;
    while read < header_bytes {
        let n = file.read(&mut header[read..])?;
        if n == 0 {
            break;
        }
        read += n;
    }
    let size = metadata.len();
    if read < header_bytes {
        return Ok(format!("{size}:short"));
    }
    let be = |offset: usize| u32::from_be_bytes(header[offset..offset + 4].try_into().unwrap());
    if header_bytes == 100 && &header[..16] == b"SQLite format 3\0" {
        return Ok(format!(
            "{size}:{}:{}:{}:{}",
            be(24),
            be(28),
            be(40),
            be(92)
        ));
    }
    Ok(format!("{size}:{}:{}:{}:{}", be(0), be(12), be(16), be(20)))
}

/// `sqliteStoreGeneration(storePath)`.
pub fn sqlite_store_generation(path: &Path) -> Result<String> {
    let wal = super::path_text(path) + "-wal";
    Ok(format!(
        "{}|{}",
        file_generation(path, 100)?,
        file_generation(Path::new(&wal), 32)?
    ))
}

#[cfg(unix)]
fn stat_signature(path: &Path) -> String {
    use std::os::unix::fs::MetadataExt;
    match std::fs::metadata(path) {
        Ok(m) => {
            let mtime_ns = m.mtime() as i128 * 1_000_000_000 + m.mtime_nsec() as i128;
            format!("{}:{}:{}:{}", m.dev(), m.ino(), m.size(), mtime_ns)
        }
        Err(_) => String::new(),
    }
}

#[cfg(not(unix))]
fn stat_signature(path: &Path) -> String {
    match std::fs::metadata(path) {
        Ok(m) => format!(
            "0:0:{}:{}",
            m.len(),
            m.modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos())
        ),
        Err(_) => String::new(),
    }
}

/// `staticTopologySourceStorageIdentity(storePath)`.
pub fn storage_identity(path: &Path) -> String {
    let wal = super::path_text(path) + "-wal";
    format!(
        "{}|{}",
        stat_signature(path),
        stat_signature(Path::new(&wal))
    )
}

pub fn admission_error(store: &Path, reason: &'static str, detail: &str) -> Error {
    Error::admission(
        reason,
        format!(
            "Routing store admission failed for {}: {detail} Expected an exact current {STORE_SCHEMA_VERSION} SQLite store. Rebuild the routing store from the source GTFS instead of modifying it in place.",
            super::path_text(store)
        ),
    )
}

fn js_label(value: Option<&Js>) -> String {
    // JSON.stringify(undefined) interpolates as "undefined".
    value.map_or("undefined".into(), Js::stringify)
}

/// `admitRoutingStoreVersion(storePath, metadata)`.
pub fn admit_version(store: &Path, metadata: &Js) -> Result<()> {
    if metadata.get("schemaVersion").and_then(Js::as_str) != Some(STORE_SCHEMA_VERSION) {
        return Err(admission_error(
            store,
            "schema_version_mismatch",
            &format!(
                "metadata.schemaVersion is {}.",
                js_label(metadata.get("schemaVersion"))
            ),
        ));
    }
    if !matches!(
        metadata.get("serviceModel").and_then(Js::as_str),
        Some("exact-date" | "exact-date-multi-feed")
    ) {
        return Err(admission_error(
            store,
            "service_model_mismatch",
            &format!(
                "Unsupported service model {}; rebuild from GTFS.",
                js_label(metadata.get("serviceModel"))
            ),
        ));
    }
    if metadata
        .get("transferSemanticsVersion")
        .and_then(Js::as_str)
        != Some(TRANSFER_SEMANTICS_VERSION)
    {
        let current = match metadata.get("transferSemanticsVersion") {
            None | Some(Js::Null) => "unspecified".to_owned(),
            Some(Js::String(s)) => s.clone(),
            Some(other) => other.stringify(),
        };
        return Err(admission_error(
            store,
            "transfer_semantics_mismatch",
            &format!("Transfer semantics are {current}; {TRANSFER_SEMANTICS_VERSION} is required."),
        ));
    }
    Ok(())
}

/// `admitCurrentTransferSemantics(db, storePath, metadata)`.
pub fn admit_transfer_semantics(db: &Connection, store: &Path, metadata: &Js) -> Result<()> {
    admit_version(store, metadata)?;
    let present = db
        .query_row("SELECT 1 AS ready FROM sqlite_master WHERE type='table' AND name='transfer_provenance'", [], |_| Ok(()))
        .optional()?
        .is_some();
    if !present {
        return Err(admission_error(
            store,
            "transfer_provenance_missing",
            &format!("{TRANSFER_SEMANTICS_VERSION} requires a complete transfer_provenance table."),
        ));
    }
    let incomplete = db
        .query_row(
            "SELECT 1 AS invalid FROM (SELECT from_stop_id, to_stop_id FROM transfers EXCEPT SELECT from_stop_id, to_stop_id FROM transfer_provenance) LIMIT 1",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if incomplete {
        return Err(admission_error(
            store,
            "transfer_provenance_incomplete",
            "A routable transfer lacks provenance.",
        ));
    }
    Ok(())
}

const REQUIRED_TABLES: &[&str] = &[
    "metadata",
    "stops",
    "routes",
    "trips",
    "route_services",
    "trip_details",
    "trip_shapes",
    "shape_points",
    "calendar",
    "calendar_dates",
    "transfers",
    "frequencies",
    "connections",
    "stop_modes",
    "stop_access_roles",
];
const REQUIRED_INDEXES: &[(&str, &str)] = &[
    ("calendar_dates_date", "calendar_dates"),
    ("connections_from_departure_cover", "connections"),
    ("route_services_representative", "route_services"),
    ("route_services_trip_rank", "route_services"),
    ("routes_service_identity", "routes"),
    ("stop_modes_stop_type", "stop_modes"),
    ("stop_modes_type_stop", "stop_modes"),
    ("stops_lat_lon", "stops"),
    ("stops_parent", "stops"),
    ("transfers_from", "transfers"),
    ("trip_shapes_shape", "trip_shapes"),
    ("trips_route", "trips"),
    ("trips_service", "trips"),
];

/// `admitNationalRoutingStore(db, storePath)`: required objects and version.
pub fn admit_store(db: &Connection, store: &Path) -> Result<Js> {
    let departure_state = db
        .query_row(
            "SELECT value FROM metadata WHERE key='departureIndexState'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
        .and_then(|text| jsval::parse_json(&text).ok());
    let deferred = matches!(departure_state, Some(Js::String(ref s)) if s == "deferred");
    let mut objects = std::collections::HashMap::new();
    {
        let mut statement = db
            .prepare("SELECT type, name, tbl_name FROM sqlite_schema")
            .map_err(|e| {
                admission_error(
                    store,
                    "schema_catalog_unreadable",
                    &format!("SQLite could not read the schema catalog ({e})."),
                )
            })?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let kind: String = row.get(0)?;
            let name: String = row.get(1)?;
            let table: String = row.get(2)?;
            objects.insert(name, (kind, table));
        }
    }
    for table in REQUIRED_TABLES {
        match objects.get(*table) {
            None => {
                return Err(admission_error(
                    store,
                    "required_table_missing",
                    &format!("Required table \"{table}\" is missing."),
                ));
            }
            Some((kind, owner)) if kind != "table" || owner != table => {
                return Err(admission_error(
                    store,
                    "required_table_wrong_type",
                    &format!("Required table \"{table}\" resolves to {kind}:{owner}."),
                ));
            }
            _ => {}
        }
    }
    for (index, table) in REQUIRED_INDEXES {
        if deferred && *index == "connections_from_departure_cover" {
            continue;
        }
        match objects.get(*index) {
            None => {
                return Err(admission_error(
                    store,
                    "required_index_missing",
                    &format!("Required index \"{index}\" is missing."),
                ));
            }
            Some((kind, owner)) if kind != "index" || owner != table => {
                return Err(admission_error(
                    store,
                    "required_index_wrong_target",
                    &format!(
                        "Required index \"{index}\" resolves to {kind}:{owner}; expected index:{table}."
                    ),
                ));
            }
            _ => {}
        }
    }
    let metadata = metadata_record(db).map_err(|e| {
        admission_error(
            store,
            "metadata_unreadable",
            &format!("SQLite could not read store metadata ({e})."),
        )
    })?;
    if metadata.get("schemaVersion").is_none() {
        return Err(admission_error(
            store,
            "schema_version_missing",
            "metadata.schemaVersion is missing.",
        ));
    }
    admit_version(store, &metadata)?;
    Ok(metadata)
}

/// `readNationalGtfsStoreMetadata(storePath)`.
pub fn read_store_metadata(store: &Path) -> Result<Js> {
    let db = open_read_only(store)?;
    let metadata = metadata_record(&db).map_err(|e| {
        admission_error(
            store,
            "metadata_unreadable",
            &format!("SQLite could not read store metadata ({e})."),
        )
    })?;
    admit_version(store, &metadata)?;
    Ok(metadata)
}

/// Open an existing store read-only, never creating it.
fn open_read_only(store: &Path) -> Result<Connection> {
    Connection::open_with_flags(
        store,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| {
        admission_error(
            store,
            "sqlite_open_failed",
            &format!("SQLite could not open the authoritative file read-only ({e})."),
        )
    })
}

/// The admission every compiler step applies to an existing routing store:
/// required objects, current version and complete transfer provenance.
pub fn admit_compiler_input(store: &Path) -> Result<Js> {
    let db = open_read_only(store)?;
    let metadata = admit_store(&db, store)?;
    admit_transfer_semantics(&db, store, &metadata)?;
    Ok(metadata)
}
