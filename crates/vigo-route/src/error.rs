//! Stable native error categories; transports decide how to encode them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorCode {
    InvalidInput,
    OperationFailed,
}

#[derive(Clone, Debug)]
pub struct Error {
    pub code: ErrorCode,
    pub reason: String,
}

impl Error {
    pub fn new(code: ErrorCode, reason: impl Into<String>) -> Self {
        Self {
            code,
            reason: reason.into(),
        }
    }

    pub fn from_reason(reason: impl Into<String>) -> Self {
        Self::new(ErrorCode::OperationFailed, reason)
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.reason.fmt(f)
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;
