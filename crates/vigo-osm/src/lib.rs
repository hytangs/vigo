//! OpenStreetMap street-store compiler for VIGO Cities.
//!
//! Compiles an OSM PBF into `street-index.sqlite` with its local basemap,
//! place names and bicycle profile, then writes the pedestrian (v7) and
//! driving (v2) runtime snapshots and seals the store. The output is the
//! layout the published 0.5 readers open; table rows, metadata text and
//! snapshot bytes match the earlier JavaScript compiler. Native routing
//! hierarchies (street and drive CCH) are prepared by the runtime afterwards.
//! Existing stores can gain the optional place-name tables without a
//! rebuild ([`backfill_place_names`]).

mod accelerator;
mod backfill;
mod basemap;
mod bike;
mod compact;
mod jsrt;
mod pbf;
mod places;
mod rules;
mod store;
mod tags;
mod terminal;

pub use accelerator::{
    DRIVE_SNAPSHOT_SUFFIX, WALK_SNAPSHOT_SUFFIX, drive_snapshot_path, walk_snapshot_path,
};
pub use backfill::{SCHEMA_VERSION as PLACE_NAMES_SCHEMA_VERSION, backfill_place_names};
pub use compact::{NativeDrive, compact_runtime_store, drive_profile as build_drive_store};
pub use rules::WheelchairStreets;
pub use store::{
    StreetOptions, build_street_store, read_store_metadata, walk_profile as build_walk_profile,
};
pub use terminal::build_terminal_access_store;

/// Store metadata as parsed JSON (`readNationalOsmStoreMetadata`).
pub type StoreMetadata = serde_json::Map<String, serde_json::Value>;

/// A compiler failure; the message matches the JavaScript compiler's.
#[derive(Debug)]
pub struct Error {
    message: String,
    /// Why a street store was refused (`schema_version_mismatch`, ...): the
    /// `reason` of Studio's `VIGO_STREET_STORE_ADMISSION_FAILED` errors.
    pub reason: Option<&'static str>,
}

impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Error {
            message: message.into(),
            reason: None,
        }
    }

    /// A refused street store.
    pub fn admission(reason: &'static str, message: impl Into<String>) -> Self {
        Error {
            message: message.into(),
            reason: Some(reason),
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        Error::new(error.to_string())
    }
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Error::new(error.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// One progress event: `[osm] phase: detail` in the CLI.
#[derive(Clone, Copy, Debug)]
pub struct Progress<'a> {
    pub phase: &'a str,
    pub progress: f64,
    /// Empty when the event has no detail.
    pub detail: &'a str,
    /// PBF bytes read of the current pass, when the event measures one.
    pub work: Option<Work>,
}

/// `{ completed, total, unit: 'bytes' }` of one pass over the PBF.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Work {
    pub completed: u64,
    pub total: u64,
}
