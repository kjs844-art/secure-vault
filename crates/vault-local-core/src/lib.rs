//! Synthetic-only credential relationship core for Secure Vault.
//!
//! This alpha crate is not approved for real passwords, API keys, or recovery data.

#![forbid(unsafe_code)]

mod codec;
mod consent;
mod consent_synthetic;
mod error;
mod ids;
mod login_method;
mod login_method_synthetic;
mod model;
mod persistence;
mod record;
mod secret;
mod synthetic;

pub use error::{LocalVaultError, LocalVaultErrorCode};
pub use ids::{RecordIdV1, RevisionIdV1};
pub use persistence::{
    AuthenticatedStoredCredentialRevisionV1, CredentialCommitPersistenceProjectionV1,
    CredentialStorageAuthenticatorV1, OwnedPreservedCredentialEnvelopeV1,
    OwnedRehydratedCredentialOutcomeV1, OwnedRehydratedCredentialV1,
    PreservedStoredCredentialEnvelopeV1, StoredCredentialAuthenticationOutcomeV1,
    SyntheticCredentialSuccessorV1, create_synthetic_successor_v1,
};
pub use record::{
    OpenCredentialOutcome, OpenedCredentialV1, RecordLocatorV0Alpha1,
    SealedCredentialRecordV0Alpha1, StoredPaddingBucketV0Alpha1, open_credential_record_v1,
    seal_synthetic_fixture_v1,
};
pub use synthetic::SyntheticCredentialFixtureId;

#[cfg(test)]
pub(crate) use record::{SyntheticFutureVersion, open_synthetic_future_version_v1};

#[cfg(test)]
#[path = "consent_tests.rs"]
mod consent_tests;
#[cfg(test)]
#[path = "future_version_tests.rs"]
mod future_version_tests;
#[cfg(test)]
#[path = "login_method_tests.rs"]
mod login_method_tests;
