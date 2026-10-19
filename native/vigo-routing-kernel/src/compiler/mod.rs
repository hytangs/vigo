//! Compatibility boundary for native build operators.
#[cfg(feature = "node")]
pub use crate::timetable_node::{
    GtfsConnectionInput, GtfsConnectionResult, compile_gtfs_connections,
};
#[cfg(not(feature = "node"))]
pub use vigo_prepare::*;
