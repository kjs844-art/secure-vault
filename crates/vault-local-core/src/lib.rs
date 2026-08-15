//! Synthetic-only credential relationship core for Secure Vault.
//!
//! This alpha crate is not approved for real passwords, API keys, or recovery data.

#![forbid(unsafe_code)]

mod codec;
mod error;
mod ids;
mod model;
mod record;
mod secret;
mod synthetic;

pub use error::{LocalVaultError, LocalVaultErrorCode};
pub use ids::{RecordIdV1, RevisionIdV1};
pub use record::{
    OpenCredentialOutcome, OpenedCredentialV1, RecordLocatorV0Alpha1,
    SealedCredentialRecordV0Alpha1, StoredPaddingBucketV0Alpha1, open_credential_record_v1,
    seal_synthetic_fixture_v1,
};
pub use synthetic::SyntheticCredentialFixtureId;

#[cfg(test)]
pub(crate) use record::{SyntheticFutureVersion, open_synthetic_future_version_v1};

#[cfg(test)]
#[path = "future_version_tests.rs"]
mod future_version_tests;
