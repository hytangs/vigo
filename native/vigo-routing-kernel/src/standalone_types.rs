//! Rust-owned buffers and errors for the executable build. No Node-API code is
//! compiled or dynamically loaded when the `node` feature is disabled.
pub type Uint8Array = Vec<u8>;
pub type Uint32Array = Vec<u32>;
pub type Float64Array = Vec<f64>;
pub type Utf16String = Vec<u16>;
pub struct ClassInstance<'a, T>(pub &'a mut T);
impl<'a, T> From<&'a mut T> for ClassInstance<'a, T> {
    fn from(value: &'a mut T) -> Self {
        Self(value)
    }
}
impl<T> std::ops::Deref for ClassInstance<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        self.0
    }
}
impl<T> std::ops::DerefMut for ClassInstance<'_, T> {
    fn deref_mut(&mut self) -> &mut T {
        self.0
    }
}

#[derive(Debug, Clone, Copy)]
pub enum Status {
    InvalidArg,
    GenericFailure,
}

#[derive(Debug)]
pub struct Error {
    pub status: Status,
    pub reason: String,
}

impl Error {
    pub fn new(status: Status, reason: impl Into<String>) -> Self {
        Self {
            status,
            reason: reason.into(),
        }
    }
    pub fn from_reason(reason: impl Into<String>) -> Self {
        Self::new(Status::GenericFailure, reason)
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.reason)
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;
pub mod bindgen_prelude {
    pub use super::{
        ClassInstance, Error, Float64Array, Result, Status, Uint8Array, Uint32Array, Utf16String,
    };
}
