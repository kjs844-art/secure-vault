//! Write-free structural and authenticated admission for an existing synthetic vault.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
#[cfg(feature = "test-seams")]
use std::sync::atomic::{AtomicUsize, Ordering};

use vault_crypto::{
    PasswordEnvelopeStorageDispositionV1, RecordEnvelopeStorageDispositionV1, VaultCommitment,
    inspect_password_envelope_for_storage_v1, inspect_record_envelope_for_storage_v1,
};
use vault_local_core::{
    CredentialStorageAuthenticatorV1, OwnedRehydratedCredentialOutcomeV1,
    OwnedRehydratedCredentialV1, StoredCredentialAuthenticationOutcomeV1,
    StoredPaddingBucketV0Alpha1,
};

use crate::preflight_query::PreflightQueryGate;
use crate::rows::AuthenticatedRevisionNodeV1;
use crate::schema_contract::{self, APPLICATION_ID, STORAGE_SCHEMA_VERSION};
use crate::store::ExistingVaultOpenOutcomeV1;
use crate::{
    StorageError, StorageErrorCode, StoreLocationV1, StoreLockV1, SyntheticWritableStoreV1,
    UntrustedStoredRevisionV1,
};

#[cfg(feature = "test-seams")]
static WRITABLE_OPEN_COUNT: AtomicUsize = AtomicUsize::new(0);

#[allow(
    clippy::large_enum_variant,
    reason = "the staged capability is returned once and keeps its SQL handle private"
)]
pub enum ExistingVaultPreflightOutcomeV1 {
    Current(ExistingVaultPreflightV1),
    SchemaUpgradeRequired,
    CryptoUpgradeRequired,
    ReadOnlyPreservation,
}

#[allow(
    clippy::large_enum_variant,
    reason = "the authenticated stage is returned once without heap-indirecting its capability"
)]
pub enum PreflightAuthenticationOutcomeV1<'auth> {
    Current(AuthenticatedVaultPreflightV1<'auth>),
    CryptoUpgradeRequired,
    ReadOnlyPreservation,
}

/// A valid structural snapshot. Its fields are private so neither a SQL
/// handle nor untrusted rows can escape this read-only stage.
pub struct ExistingVaultPreflightV1 {
    gate: PreflightQueryGate,
    lock: StoreLockV1,
    database_path: PathBuf,
    password_envelope: Vec<u8>,
    password_commitment: [u8; 32],
    logical_digest: [u8; 32],
}

/// A password-derived, fully authenticated snapshot that is still read-only.
pub struct AuthenticatedVaultPreflightV1<'auth> {
    structural: ExistingVaultPreflightV1,
    authenticator: &'auth CredentialStorageAuthenticatorV1<'auth>,
    current_heads: Vec<OwnedRehydratedCredentialV1>,
}

enum StructuralGateOutcomeV1 {
    Current {
        gate: PreflightQueryGate,
        password_envelope: Vec<u8>,
        password_commitment: [u8; 32],
        logical_digest: [u8; 32],
    },
    SchemaUpgradeRequired,
    CryptoUpgradeRequired,
    ReadOnlyPreservation,
}

impl ExistingVaultPreflightV1 {
    pub fn password_envelope(&self) -> &[u8] {
        self.password_envelope.as_slice()
    }

    pub fn logical_digest(&self) -> &[u8; 32] {
        &self.logical_digest
    }

    pub fn with_revisions(
        &mut self,
        action: impl FnMut(UntrustedStoredRevisionV1<'_>) -> Result<(), StorageError>,
    ) -> Result<(), StorageError> {
        self.gate.with_revisions(action)
    }

    #[doc(hidden)]
    #[cfg(feature = "test-seams")]
    pub fn writable_open_count_for_test_v1() -> usize {
        WRITABLE_OPEN_COUNT.load(Ordering::Relaxed)
    }

    #[allow(
        clippy::drop_non_drop,
        reason = "the exact borrowed receipt must end before canonical-head ciphertext is copied"
    )]
    pub fn authenticate_current_revisions<'auth>(
        mut self,
        authenticator: &'auth CredentialStorageAuthenticatorV1<'auth>,
    ) -> Result<PreflightAuthenticationOutcomeV1<'auth>, StorageError> {
        if authenticator.vault_commitment() != VaultCommitment::from_bytes(self.password_commitment)
        {
            return Ok(PreflightAuthenticationOutcomeV1::ReadOnlyPreservation);
        }

        let head_keys = match self.gate.current_head_keys() {
            Ok(heads) => heads,
            Err(_) => return Ok(PreflightAuthenticationOutcomeV1::ReadOnlyPreservation),
        };
        let mut revisions_by_record = BTreeMap::<[u8; 16], BTreeSet<[u8; 32]>>::new();
        let mut authenticated_nodes = Vec::<AuthenticatedRevisionNodeV1>::new();
        let mut current_heads = Vec::<OwnedRehydratedCredentialV1>::new();
        let mut seen_heads = BTreeSet::<([u8; 16], [u8; 32])>::new();
        let mut preservation = false;
        let mut crypto_upgrade = false;

        if self
            .gate
            .with_revisions(|revision| {
                let Ok(record_id) = <[u8; 16]>::try_from(revision.record_id()) else {
                    preservation = true;
                    return Ok(());
                };
                let Ok(revision_id) = <[u8; 32]>::try_from(revision.revision_id()) else {
                    preservation = true;
                    return Ok(());
                };
                let authentication =
                    match authenticator.authenticate_stored_credential_v1(revision.envelope()) {
                        Ok(authentication) => authentication,
                        Err(_) => {
                            preservation = true;
                            return Ok(());
                        }
                    };
                let StoredCredentialAuthenticationOutcomeV1::Current(receipt) = authentication
                else {
                    crypto_upgrade = true;
                    return Ok(());
                };
                let exact_borrow = receipt.envelope().len() == revision.envelope().len()
                    && std::ptr::eq(receipt.envelope().as_ptr(), revision.envelope().as_ptr());
                let cache_matches = receipt.record_id().as_bytes() == &record_id
                    && receipt.revision_id().as_bytes() == &revision_id
                    && revision.wire_version == i64::from(receipt.wire_version())
                    && revision.suite_id == i64::from(receipt.suite_id())
                    && revision.key_epoch == i64::from(receipt.key_epoch())
                    && revision.padding_bucket == padding_bucket_bytes(receipt.padding_bucket());
                if !exact_borrow || !cache_matches {
                    preservation = true;
                    drop(receipt);
                    return Ok(());
                }

                let parent_revision_id = receipt
                    .parent_revision_id()
                    .map(|parent| *parent.as_bytes());
                authenticated_nodes.push(AuthenticatedRevisionNodeV1 {
                    record_id,
                    revision_id,
                    parent_revision_id,
                });
                revisions_by_record
                    .entry(record_id)
                    .or_default()
                    .insert(revision_id);

                let is_head = head_keys.contains(&(record_id, revision_id));
                drop(receipt);
                if is_head {
                    let owned_envelope = revision.envelope().to_vec();
                    match authenticator.rehydrate_owned_stored_credential_v1(owned_envelope) {
                        Ok(OwnedRehydratedCredentialOutcomeV1::Current(head)) => {
                            seen_heads.insert((record_id, revision_id));
                            current_heads.push(head);
                        }
                        Ok(OwnedRehydratedCredentialOutcomeV1::UpgradeRequired(_)) => {
                            crypto_upgrade = true;
                        }
                        Err(_) => preservation = true,
                    }
                }
                Ok(())
            })
            .is_err()
        {
            preservation = true;
        }

        if crypto_upgrade {
            return Ok(PreflightAuthenticationOutcomeV1::CryptoUpgradeRequired);
        }
        if preservation
            || seen_heads != head_keys
            || authenticated_nodes.iter().any(|node| {
                !revisions_by_record
                    .get(&node.record_id)
                    .is_some_and(|revisions| revisions.contains(&node.revision_id))
                    || node.parent_revision_id.is_some_and(|parent| {
                        !revisions_by_record
                            .get(&node.record_id)
                            .is_some_and(|revisions| revisions.contains(&parent))
                    })
            })
        {
            return Ok(PreflightAuthenticationOutcomeV1::ReadOnlyPreservation);
        }
        match self.gate.validate_and_digest() {
            Ok(digest) if digest == self.logical_digest => {}
            _ => return Ok(PreflightAuthenticationOutcomeV1::ReadOnlyPreservation),
        }

        Ok(PreflightAuthenticationOutcomeV1::Current(
            AuthenticatedVaultPreflightV1 {
                structural: self,
                authenticator,
                current_heads,
            },
        ))
    }
}

impl<'auth> PreflightAuthenticationOutcomeV1<'auth> {
    pub fn into_authenticated(self) -> Option<AuthenticatedVaultPreflightV1<'auth>> {
        match self {
            Self::Current(authenticated) => Some(authenticated),
            Self::CryptoUpgradeRequired | Self::ReadOnlyPreservation => None,
        }
    }
}

impl AuthenticatedVaultPreflightV1<'_> {
    pub fn current_heads(&self) -> &[OwnedRehydratedCredentialV1] {
        self.current_heads.as_slice()
    }

    pub fn promote(self) -> Result<ExistingVaultOpenOutcomeV1, StorageError> {
        self.promote_with_observer(|_| {})
    }

    #[doc(hidden)]
    #[cfg(feature = "test-seams")]
    pub fn promote_with_test_observer_v1(
        self,
        observer: impl FnMut(usize),
    ) -> Result<ExistingVaultOpenOutcomeV1, StorageError> {
        self.promote_with_observer(observer)
    }

    fn promote_with_observer(
        mut self,
        mut observer: impl FnMut(usize),
    ) -> Result<ExistingVaultOpenOutcomeV1, StorageError> {
        for attempt in 0..=1 {
            let ExistingVaultPreflightV1 {
                gate,
                lock,
                database_path,
                password_envelope: _,
                password_commitment: _,
                logical_digest,
            } = self.structural;
            drop(gate);

            record_writable_open();
            let writable_gate = PreflightQueryGate::open_hardened_writable(&database_path)?;
            writable_gate.begin_immediate()?;
            let recheck = inspect_gate(writable_gate)?;
            match recheck {
                StructuralGateOutcomeV1::Current {
                    gate,
                    logical_digest: observed_digest,
                    ..
                } if observed_digest == logical_digest => {
                    gate.commit_immediate()?;
                    let connection = gate.into_connection();
                    let store = SyntheticWritableStoreV1::from_initialized(connection, lock);
                    return Ok(ExistingVaultOpenOutcomeV1::opened(
                        store,
                        self.current_heads,
                    ));
                }
                StructuralGateOutcomeV1::Current { gate, .. } => drop(gate),
                StructuralGateOutcomeV1::SchemaUpgradeRequired
                | StructuralGateOutcomeV1::CryptoUpgradeRequired
                | StructuralGateOutcomeV1::ReadOnlyPreservation => {}
            }

            if attempt == 1 {
                return Err(StorageError::new(StorageErrorCode::Busy));
            }

            let restarted = preflight_with_lock(&database_path, lock)?;
            let current = match restarted {
                ExistingVaultPreflightOutcomeV1::Current(current) => current,
                ExistingVaultPreflightOutcomeV1::SchemaUpgradeRequired => {
                    return Ok(ExistingVaultOpenOutcomeV1::SchemaUpgradeRequired);
                }
                ExistingVaultPreflightOutcomeV1::CryptoUpgradeRequired => {
                    return Ok(ExistingVaultOpenOutcomeV1::CryptoUpgradeRequired);
                }
                ExistingVaultPreflightOutcomeV1::ReadOnlyPreservation => {
                    return Ok(ExistingVaultOpenOutcomeV1::ReadOnlyPreservation);
                }
            };
            self = match current.authenticate_current_revisions(self.authenticator)? {
                PreflightAuthenticationOutcomeV1::Current(authenticated) => authenticated,
                PreflightAuthenticationOutcomeV1::CryptoUpgradeRequired => {
                    return Ok(ExistingVaultOpenOutcomeV1::CryptoUpgradeRequired);
                }
                PreflightAuthenticationOutcomeV1::ReadOnlyPreservation => {
                    return Ok(ExistingVaultOpenOutcomeV1::ReadOnlyPreservation);
                }
            };
            observer(attempt + 1);
        }
        unreachable!("promotion attempts are bounded")
    }
}

pub fn preflight_existing_v1(
    location: &StoreLocationV1,
) -> Result<ExistingVaultPreflightOutcomeV1, StorageError> {
    let lock = StoreLockV1::try_acquire(location)?;
    preflight_with_lock(location.database_path(), lock)
}

fn preflight_with_lock(
    database_path: &Path,
    lock: StoreLockV1,
) -> Result<ExistingVaultPreflightOutcomeV1, StorageError> {
    let gate = PreflightQueryGate::open_read_only(database_path)?;
    match inspect_gate(gate)? {
        StructuralGateOutcomeV1::Current {
            gate,
            password_envelope,
            password_commitment,
            logical_digest,
        } => Ok(ExistingVaultPreflightOutcomeV1::Current(
            ExistingVaultPreflightV1 {
                gate,
                lock,
                database_path: database_path.to_path_buf(),
                password_envelope,
                password_commitment,
                logical_digest,
            },
        )),
        StructuralGateOutcomeV1::SchemaUpgradeRequired => {
            Ok(ExistingVaultPreflightOutcomeV1::SchemaUpgradeRequired)
        }
        StructuralGateOutcomeV1::CryptoUpgradeRequired => {
            Ok(ExistingVaultPreflightOutcomeV1::CryptoUpgradeRequired)
        }
        StructuralGateOutcomeV1::ReadOnlyPreservation => {
            Ok(ExistingVaultPreflightOutcomeV1::ReadOnlyPreservation)
        }
    }
}

fn inspect_gate(mut gate: PreflightQueryGate) -> Result<StructuralGateOutcomeV1, StorageError> {
    let application_id = gate.application_id()?;
    if application_id != APPLICATION_ID {
        return Ok(StructuralGateOutcomeV1::ReadOnlyPreservation);
    }
    let user_version = gate.user_version()?;
    if user_version > STORAGE_SCHEMA_VERSION {
        return Ok(StructuralGateOutcomeV1::SchemaUpgradeRequired);
    }
    if user_version != STORAGE_SCHEMA_VERSION {
        return Ok(StructuralGateOutcomeV1::ReadOnlyPreservation);
    }
    let snapshot = match gate.schema_snapshot() {
        Ok(snapshot) => snapshot,
        Err(error)
            if matches!(
                error.code(),
                StorageErrorCode::CorruptStorage | StorageErrorCode::LimitsExceeded
            ) =>
        {
            return Ok(StructuralGateOutcomeV1::ReadOnlyPreservation);
        }
        Err(error) => return Err(error),
    };
    if schema_contract::verify_schema_snapshot(&snapshot).is_err() {
        return Ok(StructuralGateOutcomeV1::ReadOnlyPreservation);
    }
    if let Err(error) = gate.verify_bounded_integrity() {
        return if matches!(
            error.code(),
            StorageErrorCode::CorruptStorage | StorageErrorCode::LimitsExceeded
        ) {
            Ok(StructuralGateOutcomeV1::ReadOnlyPreservation)
        } else {
            Err(error)
        };
    }
    // This digest walk is also the cap+1 admission pass for every application
    // table. It must finish before foreign-key validation can inspect rows.
    let logical_digest = match gate.validate_and_digest() {
        Ok(digest) => digest,
        Err(error)
            if matches!(
                error.code(),
                StorageErrorCode::CorruptStorage | StorageErrorCode::LimitsExceeded
            ) =>
        {
            return Ok(StructuralGateOutcomeV1::ReadOnlyPreservation);
        }
        Err(error) => return Err(error),
    };
    if let Err(error) = gate.verify_foreign_keys() {
        return if matches!(
            error.code(),
            StorageErrorCode::CorruptStorage | StorageErrorCode::LimitsExceeded
        ) {
            Ok(StructuralGateOutcomeV1::ReadOnlyPreservation)
        } else {
            Err(error)
        };
    }
    let password = match gate.password() {
        Ok(password) => password,
        Err(_) => return Ok(StructuralGateOutcomeV1::ReadOnlyPreservation),
    };
    let password_inspection = match inspect_password_envelope_for_storage_v1(&password.envelope) {
        Ok(PasswordEnvelopeStorageDispositionV1::Current(inspection)) => inspection,
        Ok(PasswordEnvelopeStorageDispositionV1::FutureWire(inspection)) => {
            if password.wire_version != i64::from(inspection.wire_version()) {
                return Ok(StructuralGateOutcomeV1::ReadOnlyPreservation);
            }
            return Ok(StructuralGateOutcomeV1::CryptoUpgradeRequired);
        }
        Ok(PasswordEnvelopeStorageDispositionV1::UnsupportedSuite(inspection)) => {
            if password.wire_version != i64::from(inspection.wire_version()) {
                return Ok(StructuralGateOutcomeV1::ReadOnlyPreservation);
            }
            return Ok(StructuralGateOutcomeV1::CryptoUpgradeRequired);
        }
        Err(_) => return Ok(StructuralGateOutcomeV1::ReadOnlyPreservation),
    };
    if password.wire_version != i64::from(password_inspection.wire_version())
        || password.suite_id != i64::from(password_inspection.suite_id())
    {
        return Ok(StructuralGateOutcomeV1::ReadOnlyPreservation);
    }
    let commitment = *password_inspection.vault_commitment();
    let mut crypto_upgrade = false;
    let mut malformed = false;
    if gate
        .with_revisions(|revision| {
            match inspect_record_envelope_for_storage_v1(revision.envelope) {
                Ok(RecordEnvelopeStorageDispositionV1::Current(inspection)) => {
                    if revision.record_id != inspection.record_id()
                        || revision.revision_id != inspection.revision_id()
                        || revision.wire_version != i64::from(inspection.wire_version())
                        || revision.suite_id != i64::from(inspection.suite_id())
                        || revision.key_epoch != i64::from(inspection.key_epoch())
                        || revision.padding_bucket != inspection.padding_bucket_bytes() as i64
                        || inspection.vault_commitment() != &commitment
                    {
                        malformed = true;
                    }
                }
                Ok(RecordEnvelopeStorageDispositionV1::FutureWire(inspection)) => {
                    if revision.wire_version == i64::from(inspection.wire_version()) {
                        crypto_upgrade = true;
                    } else {
                        malformed = true;
                    }
                }
                Ok(RecordEnvelopeStorageDispositionV1::UnsupportedSuite(inspection)) => {
                    if revision.wire_version == i64::from(inspection.wire_version()) {
                        crypto_upgrade = true;
                    } else {
                        malformed = true;
                    }
                }
                Err(_) => malformed = true,
            }
            Ok(())
        })
        .is_err()
    {
        return Ok(StructuralGateOutcomeV1::ReadOnlyPreservation);
    }
    if malformed {
        return Ok(StructuralGateOutcomeV1::ReadOnlyPreservation);
    }
    if crypto_upgrade {
        return Ok(StructuralGateOutcomeV1::CryptoUpgradeRequired);
    }
    Ok(StructuralGateOutcomeV1::Current {
        gate,
        password_envelope: password.envelope,
        password_commitment: commitment,
        logical_digest,
    })
}

const fn padding_bucket_bytes(bucket: StoredPaddingBucketV0Alpha1) -> i64 {
    match bucket {
        StoredPaddingBucketV0Alpha1::Bytes1024 => 1_024,
        StoredPaddingBucketV0Alpha1::Bytes4096 => 4_096,
        StoredPaddingBucketV0Alpha1::Bytes16384 => 16_384,
        StoredPaddingBucketV0Alpha1::Bytes61440 => 61_440,
    }
}

#[cfg(feature = "test-seams")]
fn record_writable_open() {
    WRITABLE_OPEN_COUNT.fetch_add(1, Ordering::Relaxed);
}

#[cfg(not(feature = "test-seams"))]
const fn record_writable_open() {}
