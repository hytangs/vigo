//! Compatibility boundary. All timetable computation lives in vigo-route.
#[cfg(feature = "node")]
pub use crate::timetable_node::*;
#[cfg(not(feature = "node"))]
pub use vigo_format::timetable::*;
#[cfg(not(feature = "node"))]
pub use vigo_route::timetable::*;
