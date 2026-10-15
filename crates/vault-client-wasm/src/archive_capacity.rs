//! Mutation-only completion headroom for the bounded synthetic v4 archive.
//! This protects archive slots/bytes, not browser quota or durable storage.

use vault_local_core::inspect_synthetic_rotation_stage_capacity_v1;

use super::*;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct CompletionReservation {
    revisions: usize,
    bytes: usize,
}

impl CompletionReservation {
    fn add_stage_capacity(
        &mut self,
        ready_stage_envelope_bytes: Option<usize>,
        final_envelope_bytes: usize,
    ) -> Result<(), ArchiveError> {
        check_envelope_length(final_envelope_bytes)?;
        let mut revisions = 1_usize;
        let mut bytes = 4_usize
            .checked_add(final_envelope_bytes)
            .ok_or(ArchiveError::LimitsExceeded)?;
        if let Some(ready_bytes) = ready_stage_envelope_bytes {
            check_envelope_length(ready_bytes)?;
            // The future ready sibling has a base index and length prefix.
            revisions = 2;
            bytes = bytes
                .checked_add(8)
                .and_then(|bytes| bytes.checked_add(ready_bytes))
                .ok_or(ArchiveError::LimitsExceeded)?;
        }
        let revisions = self
            .revisions
            .checked_add(revisions)
            .ok_or(ArchiveError::LimitsExceeded)?;
        let bytes = self
            .bytes
            .checked_add(bytes)
            .ok_or(ArchiveError::LimitsExceeded)?;
        self.revisions = revisions;
        self.bytes = bytes;
        Ok(())
    }

    fn validate_usage(
        self,
        actual_revisions: usize,
        actual_bytes: usize,
    ) -> Result<(), ArchiveError> {
        let revisions = actual_revisions
            .checked_add(self.revisions)
            .ok_or(ArchiveError::LimitsExceeded)?;
        let bytes = actual_bytes
            .checked_add(self.bytes)
            .ok_or(ArchiveError::LimitsExceeded)?;
        if revisions > MAX_REVISION_COUNT || bytes > MAX_ARCHIVE_BYTES {
            return Err(ArchiveError::LimitsExceeded);
        }
        Ok(())
    }
}

/// Called only after the assembled mutation candidate has authenticated in full.
/// Never enforce this from parse/open/backup: prior valid full v4 bytes stay readable.
pub(super) fn validate_candidate(
    session: &vault_crypto::VaultSession,
    candidate: &ParsedArchive<'_>,
    actual_bytes: usize,
) -> Result<(), ArchiveError> {
    let reservation = completion_reservation(session, candidate)?;
    let actual_revisions = candidate
        .records
        .len()
        .checked_add(candidate.stages.len())
        .ok_or(ArchiveError::LimitsExceeded)?;
    reservation.validate_usage(actual_revisions, actual_bytes)
}

fn completion_reservation(
    session: &vault_crypto::VaultSession,
    candidate: &ParsedArchive<'_>,
) -> Result<CompletionReservation, ArchiveError> {
    let mut reservation = CompletionReservation::default();
    if candidate.version != STAGING_ARCHIVE_VERSION {
        return Ok(reservation);
    }
    let authenticator = CredentialStorageAuthenticatorV1::new(session);
    for (reference, &head) in candidate.heads.iter().enumerate() {
        let Some(stage) = staging::latest_stage(candidate, reference) else {
            continue;
        };
        let envelope = candidate
            .records
            .get(head)
            .ok_or(ArchiveError::InvalidArchive)?;
        let base = match authenticator
            .rehydrate_owned_stored_credential_v1(envelope.to_vec())
            .map_err(|error| map_local_error(error.code()))?
        {
            OwnedRehydratedCredentialOutcomeV1::Current(base) => base,
            OwnedRehydratedCredentialOutcomeV1::UpgradeRequired(_) => {
                return Err(ArchiveError::UpgradeRequired);
            }
        };
        let capacity = inspect_synthetic_rotation_stage_capacity_v1(
            session,
            base.sealed_record(),
            stage.envelope,
        )
        .map_err(|error| map_local_error(error.code()))?;
        reservation.add_stage_capacity(
            capacity.ready_stage_envelope_bytes(),
            capacity.final_envelope_bytes(),
        )?;
    }
    Ok(reservation)
}

#[cfg(test)]
#[path = "archive_capacity_tests.rs"]
mod tests;
