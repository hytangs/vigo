#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FormatErrorCode {
    Io,
    InvalidArtifact,
}

#[derive(Debug)]
pub struct FormatError {
    pub code: FormatErrorCode,
    message: String,
}
impl FormatError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: FormatErrorCode::InvalidArtifact,
            message: message.into(),
        }
    }
}
impl std::fmt::Display for FormatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.message.fmt(f)
    }
}
impl std::error::Error for FormatError {}
impl From<std::io::Error> for FormatError {
    fn from(error: std::io::Error) -> Self {
        Self {
            code: FormatErrorCode::Io,
            message: error.to_string(),
        }
    }
}
impl From<&str> for FormatError {
    fn from(message: &str) -> Self {
        Self::invalid(message)
    }
}
impl From<String> for FormatError {
    fn from(message: String) -> Self {
        Self::invalid(message)
    }
}
macro_rules! invalid_artifact {
    ($($error:ty),* $(,)?) => { $(
        impl From<$error> for FormatError {
            fn from(error: $error) -> Self { Self::invalid(error.to_string()) }
        }
    )* };
}
invalid_artifact!(
    serde_json::Error,
    std::num::TryFromIntError,
    std::array::TryFromSliceError,
    std::str::Utf8Error
);
pub type FormatResult<T> = std::result::Result<T, FormatError>;
