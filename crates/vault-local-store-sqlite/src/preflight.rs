//! Write-free structural admission for an already-existing synthetic vault.

use vault_crypto::{
    PasswordEnvelopeStorageDispositionV1, RecordEnvelopeStorageDispositionV1,
    inspect_password_envelope_for_storage_v1, inspect_record_envelope_for_storage_v1,
};

use crate::preflight_query::PreflightQueryGate;
use crate::schema_contract::{self, APPLICATION_ID, STORAGE_SCHEMA_VERSION};
use crate::{StorageError, StoreLocationV1, StoreLockV1, UntrustedStoredRevisionV1};

pub enum ExistingVaultPreflightOutcomeV1 {
    Current(ExistingVaultPreflightV1),
    SchemaUpgradeRequired,
    CryptoUpgradeRequired,
    ReadOnlyPreservation,
}

/// A valid structural snapshot.  Its fields are private so neither a SQL
/// handle nor untrusted rows can escape this read-only stage.
pub struct ExistingVaultPreflightV1 {
    gate: PreflightQueryGate,
    #[allow(dead_code, reason = "the lock intentionally spans Task 6 promotion")]
    lock: StoreLockV1,
    password_envelope: Vec<u8>,
    logical_digest: [u8; 32],
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
}

pub fn preflight_existing_v1(
    location: &StoreLocationV1,
) -> Result<ExistingVaultPreflightOutcomeV1, StorageError> {
    let lock = StoreLockV1::try_acquire(location)?;
    let mut gate = PreflightQueryGate::open_read_only(location.database_path())?;
    let application_id = gate.application_id()?;
    if application_id != APPLICATION_ID {
        return Ok(ExistingVaultPreflightOutcomeV1::ReadOnlyPreservation);
    }
    let user_version = gate.user_version()?;
    if user_version > STORAGE_SCHEMA_VERSION {
        return Ok(ExistingVaultPreflightOutcomeV1::SchemaUpgradeRequired);
    }
    if user_version != STORAGE_SCHEMA_VERSION {
        return Ok(ExistingVaultPreflightOutcomeV1::ReadOnlyPreservation);
    }
    let snapshot = gate.schema_snapshot()?;
    if schema_contract::verify_schema_snapshot(&snapshot).is_err() {
        return Ok(ExistingVaultPreflightOutcomeV1::ReadOnlyPreservation);
    }
    if gate.verify_integrity().is_err() {
        return Ok(ExistingVaultPreflightOutcomeV1::ReadOnlyPreservation);
    }
    let password = match gate.password() {
        Ok(password) => password,
        Err(_) => return Ok(ExistingVaultPreflightOutcomeV1::ReadOnlyPreservation),
    };
    let password_inspection = match inspect_password_envelope_for_storage_v1(&password.envelope) {
        Ok(PasswordEnvelopeStorageDispositionV1::Current(inspection)) => inspection,
        Ok(PasswordEnvelopeStorageDispositionV1::FutureWire(_))
        | Ok(PasswordEnvelopeStorageDispositionV1::UnsupportedSuite(_)) => {
            return Ok(ExistingVaultPreflightOutcomeV1::CryptoUpgradeRequired);
        }
        Err(_) => return Ok(ExistingVaultPreflightOutcomeV1::ReadOnlyPreservation),
    };
    if password.wire_version != i64::from(password_inspection.wire_version())
        || password.suite_id != i64::from(password_inspection.suite_id())
    {
        return Ok(ExistingVaultPreflightOutcomeV1::ReadOnlyPreservation);
    }
    let commitment = *password_inspection.vault_commitment();
    let mut crypto_upgrade = false;
    let mut malformed = false;
    gate.with_revisions(|revision| {
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
            Ok(RecordEnvelopeStorageDispositionV1::FutureWire(_))
            | Ok(RecordEnvelopeStorageDispositionV1::UnsupportedSuite(_)) => crypto_upgrade = true,
            Err(_) => malformed = true,
        }
        Ok(())
    })?;
    if crypto_upgrade {
        return Ok(ExistingVaultPreflightOutcomeV1::CryptoUpgradeRequired);
    }
    if malformed {
        return Ok(ExistingVaultPreflightOutcomeV1::ReadOnlyPreservation);
    }
    let logical_digest = match gate.validate_and_digest() {
        Ok(digest) => digest,
        Err(_) => return Ok(ExistingVaultPreflightOutcomeV1::ReadOnlyPreservation),
    };
    Ok(ExistingVaultPreflightOutcomeV1::Current(
        ExistingVaultPreflightV1 {
            gate,
            lock,
            password_envelope: password.envelope,
            logical_digest,
        },
    ))
}
