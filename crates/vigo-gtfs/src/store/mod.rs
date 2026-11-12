//! The GTFS routing-store compiler (vigo.routing.store.v4).
//!
//! Writes the SQLite layout of the published 0.5 baseline: the same tables,
//! schema text, indexes, metadata text and storage classes as the earlier
//! JavaScript compiler, so existing readers and frozen fixtures stay valid.

mod fares;
mod flex;
mod import;
mod merge;
mod metadata;
pub mod policy;
mod schema;
mod schema_sql;
mod topology;

pub use import::{build_city_store, build_store};
pub use merge::{StoreSource, merge_stores};
pub use metadata::{
    admit_compiler_input, metadata_record, read_store_metadata, sqlite_store_generation,
    stable_json,
};
pub use schema::{compact_runtime_store, create_schema, ensure_stop_access_roles};
pub use topology::{
    build_static_topology_sidecar, inspect_static_topology_sidecar, static_topology_sidecar_path,
};

use crate::{Error, Result};
use rusqlite::types::{ToSqlOutput, Value, ValueRef};
use rusqlite::{Connection, Statement, ToSql};
use std::path::{Path, PathBuf};

pub const STORE_SCHEMA_VERSION: &str = "vigo.routing.store.v4";
pub const TRANSFER_SEMANTICS_VERSION: &str = "vigo.routing.transfers.v4";
pub const STOP_ACCESS_ROLE_INDEX_VERSION: &str = "vigo.routing.stop-access-roles.v1";
pub const ROUTE_SERVICE_CATALOG_VERSION: &str = "vigo.routing.route-services.v2";
const BUILD_SQLITE_PAGE_SIZE: u32 = 32 * 1024;
const NEARBY_TRANSFER_MAX_DISTANCE_KM: f64 = 0.25;

/// One GTFS ZIP and the scope that namespaces its identifiers.
#[derive(Clone, Debug)]
pub struct Feed {
    pub path: PathBuf,
    pub scope: String,
}

/// Wheelchair profile selection for a build.
#[derive(Clone, Debug)]
pub struct BuildOptions {
    pub wheelchair: bool,
    /// `inferred` or `verified`.
    pub wheelchair_streets: String,
}

impl Default for BuildOptions {
    fn default() -> Self {
        Self {
            wheelchair: false,
            wheelchair_streets: "inferred".into(),
        }
    }
}

/// A compiler progress event: `{ phase, progress, detail, work }`.
#[derive(Clone, Debug, PartialEq)]
pub struct Progress {
    pub phase: String,
    pub progress: f64,
    pub detail: String,
    /// Measured bytes of the table being read, when known.
    pub work: Option<Work>,
}

/// `{ completed, total, unit: 'bytes', rows }` of one GTFS table read.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Work {
    pub completed: u64,
    pub total: u64,
    pub rows: u64,
}

pub type ProgressFn<'a> = &'a mut dyn FnMut(&Progress);

pub(crate) fn report(progress: &mut dyn FnMut(&Progress), phase: &str, value: f64, detail: &str) {
    progress(&Progress {
        phase: phase.to_owned(),
        progress: value,
        detail: detail.to_owned(),
        work: None,
    });
}

/// `VIGO_BUILD_SQLITE_CACHE_KIB`, bounded as the published compiler bounds it.
pub(crate) fn build_sqlite_cache_kib() -> u32 {
    let raw = std::env::var("VIGO_BUILD_SQLITE_CACHE_KIB").ok();
    let value = raw.as_deref().map_or(32.0 * 1024.0, |text| {
        let number = crate::jsval::to_number(text);
        // Math.floor(Number(...) ?? default) || 0
        let floored = number.floor();
        if floored.is_nan() || floored == 0.0 {
            0.0
        } else {
            floored
        }
    });
    value.clamp(4.0 * 1024.0, 256.0 * 1024.0) as u32
}

pub(crate) fn configure_build_database(db: &Connection) -> Result<()> {
    db.execute_batch(&format!(
        "PRAGMA page_size={BUILD_SQLITE_PAGE_SIZE}; PRAGMA journal_mode=OFF; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-{};",
        build_sqlite_cache_kib()
    ))?;
    Ok(())
}

/// A value bound the way node:sqlite binds JavaScript values: numbers are
/// doubles, strings text, null NULL; `undefined` cannot be bound.
#[derive(Clone, Debug)]
pub(crate) enum V<'a> {
    Num(f64),
    Text(&'a str),
    Owned(String),
    Null,
    Undefined,
}

impl<'a> V<'a> {
    /// A source field: text, or `undefined` when the column is absent.
    pub fn field(value: Option<&'a str>) -> Self {
        value.map_or(V::Undefined, V::Text)
    }
    /// `value || null`.
    pub fn or_null(value: Option<&'a str>) -> Self {
        crate::jsval::or_null(value).map_or(V::Null, V::Text)
    }
    pub fn opt_num(value: Option<f64>) -> Self {
        value.map_or(V::Null, V::Num)
    }
}

impl ToSql for V<'_> {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(match self {
            V::Num(value) => ToSqlOutput::Owned(Value::Real(*value)),
            V::Text(text) => ToSqlOutput::Borrowed(ValueRef::Text(text.as_bytes())),
            V::Owned(text) => ToSqlOutput::Borrowed(ValueRef::Text(text.as_bytes())),
            V::Null | V::Undefined => ToSqlOutput::Owned(Value::Null),
        })
    }
}

pub(crate) fn check_bindable(values: &[V]) -> Result<()> {
    if let Some(index) = values.iter().position(|v| matches!(v, V::Undefined)) {
        return Err(Error::new(format!(
            "Provided value cannot be bound to SQLite parameter {}.",
            index + 1
        )));
    }
    Ok(())
}

/// `statement.run(...values)`: the number of changed rows.
pub(crate) fn run(statement: &mut Statement, values: &[V]) -> Result<usize> {
    check_bindable(values)?;
    Ok(statement.execute(rusqlite::params_from_iter(values.iter()))?)
}

/// Whether a SQLite error is a constraint violation (errcode & 0xff == 19).
pub(crate) fn is_constraint(error: &rusqlite::Error) -> bool {
    matches!(error, rusqlite::Error::SqliteFailure(e, _) if e.code == rusqlite::ErrorCode::ConstraintViolation)
}

pub(crate) fn remove_file(path: &Path) {
    let _ = std::fs::remove_file(path);
}

pub(crate) fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// `path.resolve(p)`: absolute and lexically normalized.
pub(crate) fn resolve(path: &Path) -> PathBuf {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

pub(crate) fn basename(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Insert ordered metadata members as `JSON.stringify(value)`.
pub(crate) fn write_metadata(
    db: &Connection,
    sql: &str,
    metadata: &vigo_format::js::Js,
) -> Result<()> {
    let vigo_format::js::Js::Object(members) = metadata else {
        return Ok(());
    };
    let mut insert = db.prepare(sql)?;
    for (key, value) in members {
        insert.execute(rusqlite::params![key, value.stringify()])?;
    }
    Ok(())
}

pub(crate) fn sha256_file(path: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(hash.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

pub(crate) use vigo_format::js::iso_now;

/// `count.toLocaleString()` for progress details.
pub(crate) fn grouped(count: u64) -> String {
    vigo_format::js::grouped(count as i64)
}
