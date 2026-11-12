//! GTFS input formats (RFC 0001): realtime decoding, bounded GTFS ZIP/CSV
//! reading, and the compiler that writes routing stores in the permanent
//! 0.5 layout.
pub mod jsval;
pub mod realtime;
pub mod store;
pub mod zip;

pub use store::{
    BuildOptions, Feed, Progress, StoreSource, Work, build_city_store,
    build_static_topology_sidecar, build_store, compact_runtime_store, ensure_stop_access_roles,
    inspect_static_topology_sidecar, merge_stores,
};

/// A compiler failure with the message users see.
#[derive(Debug, Clone)]
pub struct Error {
    message: String,
    /// Why a routing store was refused (`transfer_semantics_mismatch`,
    /// `required_table_missing`, ...): the `reason` of Studio's
    /// `VIGO_ROUTING_STORE_ADMISSION_FAILED` errors.
    pub reason: Option<&'static str>,
}

impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Error {
            message: message.into(),
            reason: None,
        }
    }

    /// A refused routing store.
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

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Error::new(error.to_string())
    }
}

impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        Error::new(error.to_string())
    }
}

impl From<String> for Error {
    fn from(message: String) -> Self {
        Error::new(message)
    }
}

impl From<&str> for Error {
    fn from(message: &str) -> Self {
        Error::new(message)
    }
}

pub type Result<T> = std::result::Result<T, Error>;
