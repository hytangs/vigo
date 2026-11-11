//! Rust-owned buffers and errors for the executable build. No Node-API code is
//! compiled or dynamically loaded when the `node` feature is disabled.
pub type Uint32Array = Vec<u32>;
pub type Float64Array = Vec<f64>;

/// A numeric column owned by the worker or read in place from an immutable
/// mapped City file, which the column keeps open.
pub enum Column<T> {
    Owned(Vec<T>),
    Mapped {
        _file: std::sync::Arc<vigo_format::Snapshot>,
        data: *const T,
        len: usize,
    },
}
// SAFETY: a mapped column is an immutable view of a read-only file mapping
// owned by the column itself.
unsafe impl<T: Sync> Send for Column<T> {}
unsafe impl<T: Sync> Sync for Column<T> {}
impl<T> std::ops::Deref for Column<T> {
    type Target = [T];
    #[inline]
    fn deref(&self) -> &[T] {
        match self {
            Self::Owned(values) => values,
            // SAFETY: `mapped` checked bounds and alignment of this range,
            // and the mapping lives as long as the column.
            Self::Mapped { data, len, .. } => unsafe { std::slice::from_raw_parts(*data, *len) },
        }
    }
}
impl<T> From<Vec<T>> for Column<T> {
    fn from(values: Vec<T>) -> Self {
        Self::Owned(values)
    }
}
impl Column<f64> {
    pub fn mapped(
        file: &std::sync::Arc<vigo_format::Snapshot>,
        name: &str,
    ) -> vigo_format::FormatResult<Self> {
        let bytes = file.array(name, "Float64Array", 8)?;
        match Self::view(file, bytes) {
            Some(column) => Ok(column),
            None => file.f64(name).map(Self::Owned),
        }
    }
}
impl Column<u32> {
    pub fn mapped(
        file: &std::sync::Arc<vigo_format::Snapshot>,
        name: &str,
    ) -> vigo_format::FormatResult<Self> {
        let bytes = file.array(name, "Uint32Array", 4)?;
        match Self::view(file, bytes) {
            Some(column) => Ok(column),
            None => file.u32(name).map(Self::Owned),
        }
    }
}
impl<T> Column<T> {
    /// Owned allocation; a mapped column's bytes belong to its file.
    pub fn heap_bytes(&self) -> usize {
        match self {
            Self::Owned(values) => values.capacity() * std::mem::size_of::<T>(),
            Self::Mapped { .. } => 0,
        }
    }
    pub fn mapped_bytes(&self) -> usize {
        match self {
            Self::Owned(_) => 0,
            Self::Mapped { len, .. } => len * std::mem::size_of::<T>(),
        }
    }
    /// Little-endian, aligned file bytes are read in place; anything else is
    /// decoded into an owned copy by the caller.
    fn view(file: &std::sync::Arc<vigo_format::Snapshot>, bytes: &[u8]) -> Option<Self> {
        (cfg!(target_endian = "little")
            && bytes.as_ptr().align_offset(std::mem::align_of::<T>()) == 0
            && bytes.len().is_multiple_of(std::mem::size_of::<T>()))
        .then(|| Self::Mapped {
            _file: file.clone(),
            data: bytes.as_ptr().cast(),
            len: bytes.len() / std::mem::size_of::<T>(),
        })
    }
}
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
    pub use super::{ClassInstance, Error, Float64Array, Result, Uint32Array, Utf16String};
}

impl From<vigo_route::Error> for Error {
    fn from(error: vigo_route::Error) -> Self {
        Self::new(
            match error.code {
                vigo_route::ErrorCode::InvalidInput => Status::InvalidArg,
                vigo_route::ErrorCode::OperationFailed => Status::GenericFailure,
            },
            error.reason,
        )
    }
}
