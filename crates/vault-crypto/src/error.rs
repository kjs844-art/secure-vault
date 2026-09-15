/// Stable, non-sensitive classification for public crypto failures.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CryptoErrorCode {
    UnsupportedVersion,
    UnsupportedSuite,
    NonCanonicalEncoding,
    InvalidLength,
    LimitsExceeded,
    KdfParamsRejected,
    AuthenticationFailed,
    RngUnavailable,
}

/// Public error contract. Variants deliberately carry no secret or input data.
#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("unsupported wire version")]
    UnsupportedVersion,
    #[error("unsupported crypto suite")]
    UnsupportedSuite,
    #[error("non-canonical envelope encoding")]
    NonCanonicalEncoding,
    #[error("invalid field length")]
    InvalidLength,
    #[error("configured limit exceeded")]
    LimitsExceeded,
    #[error("KDF parameters rejected")]
    KdfParamsRejected,
    #[error("authentication failed")]
    AuthenticationFailed,
    #[error("operating-system randomness unavailable")]
    RngUnavailable,
}

impl CryptoError {
    /// Return the stable public classification without exposing input details.
    pub const fn code(&self) -> CryptoErrorCode {
        match self {
            Self::UnsupportedVersion => CryptoErrorCode::UnsupportedVersion,
            Self::UnsupportedSuite => CryptoErrorCode::UnsupportedSuite,
            Self::NonCanonicalEncoding => CryptoErrorCode::NonCanonicalEncoding,
            Self::InvalidLength => CryptoErrorCode::InvalidLength,
            Self::LimitsExceeded => CryptoErrorCode::LimitsExceeded,
            Self::KdfParamsRejected => CryptoErrorCode::KdfParamsRejected,
            Self::AuthenticationFailed => CryptoErrorCode::AuthenticationFailed,
            Self::RngUnavailable => CryptoErrorCode::RngUnavailable,
        }
    }
}
