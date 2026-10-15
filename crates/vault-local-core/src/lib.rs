//! Synthetic-only credential relationship core for Secure Vault.
//!
//! This alpha crate is not approved for real passwords, API keys, or recovery data.
//!
//! Internal typed commands are not a public arbitrary-plaintext boundary:
//!
//! ```compile_fail,E0603
//! use vault_local_core::credential_commands::CredentialDraftV1;
//! ```
//!
//! ```compile_fail,E0603
//! use vault_local_core::credential_commands::create_credential_metadata_successor_v1;
//! ```
//!
//! Nor may a caller bypass that boundary through a crate-root re-export:
//!
//! ```compile_fail,E0432
//! use vault_local_core::CredentialDraftV1;
//! ```
//!
//! ```compile_fail,E0432
//! use vault_local_core::create_credential_metadata_successor_v1;
//! ```

#![forbid(unsafe_code)]

mod catalog;
mod codec;
mod connection_edit;
mod consent;
mod consent_synthetic;
mod credential_commands;
mod credential_history;
mod error;
mod ids;
mod login_method;
mod login_method_synthetic;
mod model;
mod persistence;
mod record;
mod registration;
mod rotation;
mod rotation_checklist;
mod rotation_history;
mod rotation_lifecycle;
mod rotation_staging;
mod secret;
mod synthetic;
mod synthetic_password;

pub use catalog::{
    CatalogConnectionTypeV1, CatalogConnectionViewV1, CatalogCredentialStatusV1,
    CatalogCredentialTypeV1, CredentialCatalogProjectionV1,
};
pub use connection_edit::{
    SyntheticConnectionSelectionV1, create_synthetic_connection_successor_v1,
};
pub use credential_history::{CredentialChainInspectionV1, inspect_credential_chain_v1};
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
pub use registration::{SyntheticRegistrationSelectionV1, seal_synthetic_registration_v1};
pub use rotation::{
    SyntheticRotationCutoverSelectionV1, SyntheticRotationReadinessV1,
    SyntheticVerificationEvidenceV1, create_synthetic_rotation_cutover_successor_v1,
    inspect_synthetic_rotation_readiness_v1,
};
pub use rotation_checklist::{
    SyntheticRotationChecklistEntryV1, SyntheticRotationChecklistFixtureV1,
    SyntheticRotationChecklistGenerationV1, SyntheticRotationChecklistV1,
    inspect_synthetic_rotation_checklist_v1,
};
pub use rotation_history::{
    SyntheticRotationHistoryEventV1, SyntheticRotationHistoryV1,
    SyntheticRotationRecordedCompletionV1, SyntheticRotationRevocationSourceV1,
    inspect_synthetic_rotation_history_v1,
};
pub use rotation_staging::{
    SyntheticRotationStageCapacityV1, SyntheticRotationStageCompletionV1,
    SyntheticRotationStageEntryV1, SyntheticRotationStageProjectionV1,
    SyntheticRotationStageRevocationV1, SyntheticRotationStageSelectionV1,
    SyntheticRotationStageV1, create_synthetic_rotation_cutover_from_stage_v1,
    create_synthetic_rotation_stage_v1, inspect_synthetic_rotation_stage_capacity_v1,
    inspect_synthetic_rotation_stage_v1,
};
pub use synthetic::SyntheticCredentialFixtureId;
pub use synthetic_password::{
    SyntheticPasswordFixtureIdV1, inspect_synthetic_password_record_v1,
    seal_synthetic_password_fixture_v1,
};

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
