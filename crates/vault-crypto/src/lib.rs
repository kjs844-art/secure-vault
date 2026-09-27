//! Synthetic-only experimental cryptography core for Secure Vault.
//!
//! The `v0alpha1` suite is not approved for real Secret storage.

#![forbid(unsafe_code)]

#[allow(dead_code)]
#[path = "v0alpha1/entropy.rs"]
mod entropy;
mod error;
mod secret;
mod v0alpha1;

pub use error::{CryptoError, CryptoErrorCode};
pub use secret::{
    KeyEpoch, MasterPassword, OpaqueRecordId, PaddingBucketV0Alpha1, RecordContextV0Alpha1,
    RevisionId, SecretBytes, VaultCommitment, VaultSession,
};
pub use v0alpha1::codec::{
    inspect_password_envelope_v0alpha1, inspect_record_envelope_v0alpha1,
    sealed_record_envelope_len_v0alpha1,
};
pub use v0alpha1::record::{open_record_v0alpha1, seal_record_v0alpha1};
pub use v0alpha1::storage::{
    CurrentSuiteStorageInspectionV1, FutureWireStorageInspectionV1,
    PasswordEnvelopeBootstrapProjectionV1, PasswordEnvelopeStorageDispositionV1,
    PasswordEnvelopeStorageInspectionV1, RecordEnvelopeStorageDispositionV1,
    RecordEnvelopeStorageInspectionV1, inspect_password_envelope_for_storage_v1,
    inspect_record_envelope_for_storage_v1,
};
pub use v0alpha1::wrap::{CreatedVaultV0Alpha1, create_vault_v0alpha1, unlock_vault_v0alpha1};
