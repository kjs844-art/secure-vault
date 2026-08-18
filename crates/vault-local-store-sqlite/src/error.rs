use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StorageErrorCode {
    Busy,
    Io,
    UnsupportedPlatform,
    SchemaUpgradeRequired,
    CryptoUpgradeRequired,
    AuthenticationFailed,
    CorruptStorage,
    InvariantViolation,
    LimitsExceeded,
    WrongVaultCandidate,
    MissingBase,
}

pub struct StorageError {
    code: StorageErrorCode,
}

impl StorageError {
    pub const fn code(&self) -> StorageErrorCode {
        self.code
    }

    pub(crate) const fn new(code: StorageErrorCode) -> Self {
        Self { code }
    }
}

impl fmt::Display for StorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self.code {
            StorageErrorCode::Busy => "store is busy",
            StorageErrorCode::Io => "storage input/output failure",
            StorageErrorCode::UnsupportedPlatform => "required storage hardening is unavailable",
            StorageErrorCode::SchemaUpgradeRequired => "storage schema upgrade is required",
            StorageErrorCode::CryptoUpgradeRequired => "crypto upgrade is required",
            StorageErrorCode::AuthenticationFailed => "storage authentication failed",
            StorageErrorCode::CorruptStorage => "storage is not structurally valid",
            StorageErrorCode::InvariantViolation => "storage invariant violation",
            StorageErrorCode::LimitsExceeded => "storage limits exceeded",
            StorageErrorCode::WrongVaultCandidate => "candidate belongs to another vault",
            StorageErrorCode::MissingBase => "candidate base revision is missing",
        })
    }
}

impl fmt::Debug for StorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StorageError")
            .field("code", &self.code)
            .finish()
    }
}

impl std::error::Error for StorageError {}
