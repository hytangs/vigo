//! Routing algorithms independent of transports, storage and process configuration.
pub mod buffer;
pub mod error;
pub mod timetable;
mod timetable_validation;
pub use buffer::Buffer;
pub use error::{Error, ErrorCode, Result};
pub const MAXIMUM_MATRIX_PAIRS: usize = 100_000;

/// Typed numeric storage and errors shared by native operators.
pub mod types {
    pub use crate::{Buffer, Error, ErrorCode, Result};
    pub type U32Buffer = Buffer<u32>;
    pub type U8Buffer = Buffer<u8>;
    pub type F64Buffer = Buffer<f64>;
}
