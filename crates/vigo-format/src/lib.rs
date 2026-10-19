//! Prepared City I/O. Routing algorithms live in vigo-route.
pub mod timetable;
pub use timetable::*;

mod error;
pub mod snapshot;
pub use error::{FormatError, FormatErrorCode, FormatResult};
pub use snapshot::Snapshot;

pub mod snapshot_writer;
pub use snapshot_writer::{PortableArray, encode_routing_snapshot};
