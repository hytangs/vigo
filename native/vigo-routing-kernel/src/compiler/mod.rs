//! Incremental City compiler operators. Source admission and orchestration stay
//! in the caller; these operators work on private, unpublished build databases.
mod connections;
pub use connections::{GtfsConnectionInput, GtfsConnectionResult, compile_gtfs_connections};
