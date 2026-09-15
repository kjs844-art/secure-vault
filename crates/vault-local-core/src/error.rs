#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LocalVaultErrorCode {
    NonCanonicalEncoding,
    InvalidItem,
    LimitsExceeded,
    AuthenticationFailed,
    RngUnavailable,
    CryptoFailure,
}

#[derive(Debug, thiserror::Error)]
pub enum LocalVaultError {
    #[error("credential payload is not canonical")]
    NonCanonicalEncoding,
    #[error("credential item is invalid")]
    InvalidItem,
    #[error("credential item limit exceeded")]
    LimitsExceeded,
    #[error("record authentication failed")]
    AuthenticationFailed,
    #[error("operating-system randomness unavailable")]
    RngUnavailable,
    #[error("cryptographic operation failed")]
    CryptoFailure,
}

impl LocalVaultError {
    pub const fn code(&self) -> LocalVaultErrorCode {
        match self {
            Self::NonCanonicalEncoding => LocalVaultErrorCode::NonCanonicalEncoding,
            Self::InvalidItem => LocalVaultErrorCode::InvalidItem,
            Self::LimitsExceeded => LocalVaultErrorCode::LimitsExceeded,
            Self::AuthenticationFailed => LocalVaultErrorCode::AuthenticationFailed,
            Self::RngUnavailable => LocalVaultErrorCode::RngUnavailable,
            Self::CryptoFailure => LocalVaultErrorCode::CryptoFailure,
        }
    }
}
