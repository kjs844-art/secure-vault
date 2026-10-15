//! Linear, authenticated revision histories for the synthetic v3 transport.
//! This is not SQLite conflict storage or an anti-rollback/completeness anchor.

use std::collections::{BTreeMap, BTreeSet};

use vault_local_core::StoredCredentialAuthenticationOutcomeV1;

use super::*;

pub(super) fn validate(
    session: &vault_crypto::VaultSession,
    parsed: &ParsedArchive<'_>,
) -> Result<(), ArchiveError> {
    let authenticator = CredentialStorageAuthenticatorV1::new(session);
    let mut revisions = BTreeMap::new();
    let mut leaves = BTreeMap::new();
    let mut record_ids = Vec::with_capacity(parsed.records.len());
    for (index, envelope) in parsed.records.iter().enumerate() {
        // Authentication includes every non-head payload; metadata is a receipt
        // derived from authenticated contents, not an untrusted envelope header.
        let revision = match authenticator
            .authenticate_stored_credential_v1(envelope)
            .map_err(|error| map_local_error(error.code()))?
        {
            StoredCredentialAuthenticationOutcomeV1::Current(revision) => revision,
            StoredCredentialAuthenticationOutcomeV1::AuthenticatedFutureInner(_) => {
                return Err(ArchiveError::UpgradeRequired);
            }
        };
        let record_id = revision.record_id();
        let revision_id = revision.revision_id();
        if revisions.contains_key(&revision_id) {
            return Err(ArchiveError::InvalidArchive);
        }
        if let Some(parent) = revision.parent_revision_id() {
            let &(parent_record, parent_index) =
                revisions.get(&parent).ok_or(ArchiveError::InvalidArchive)?;
            // Parent-before-child is a wire ordering rule. Requiring the latest
            // leaf also rejects multiple children, cycles and disconnected roots.
            if parent_record != record_id || leaves.get(&record_id) != Some(&parent_index) {
                return Err(ArchiveError::InvalidArchive);
            }
        } else if leaves.contains_key(&record_id) {
            return Err(ArchiveError::InvalidArchive);
        }
        revisions.insert(revision_id, (record_id, index));
        leaves.insert(record_id, index);
        record_ids.push(record_id);
    }
    if leaves.len() != parsed.heads.len() {
        return Err(ArchiveError::InvalidArchive);
    }
    let mut head_records = BTreeSet::new();
    for &index in &parsed.heads {
        let record_id = record_ids.get(index).ok_or(ArchiveError::InvalidArchive)?;
        if !head_records.insert(*record_id) || leaves.get(record_id) != Some(&index) {
            return Err(ArchiveError::InvalidArchive);
        }
    }
    Ok(())
}

pub(super) fn encode(
    password: &[u8],
    revisions: &[&[u8]],
    heads: &[usize],
) -> Result<Vec<u8>, ArchiveError> {
    check_record_count(HISTORY_ARCHIVE_VERSION, heads.len())?;
    if revisions.len() > MAX_REVISION_COUNT {
        return Err(ArchiveError::LimitsExceeded);
    }
    if revisions.len() < heads.len() {
        return Err(ArchiveError::InvalidArchive);
    }
    let mut seen = BTreeSet::new();
    for &head in heads {
        if head >= revisions.len() || !seen.insert(head) {
            return Err(ArchiveError::InvalidArchive);
        }
    }
    let mut size = 20_usize
        .checked_add(
            heads
                .len()
                .checked_mul(4)
                .ok_or(ArchiveError::LimitsExceeded)?,
        )
        .ok_or(ArchiveError::LimitsExceeded)?;
    for envelope in std::iter::once(password).chain(revisions.iter().copied()) {
        check_envelope_length(envelope.len())?;
        size = size
            .checked_add(4)
            .and_then(|size| size.checked_add(envelope.len()))
            .ok_or(ArchiveError::LimitsExceeded)?;
    }
    if size > MAX_ARCHIVE_BYTES {
        return Err(ArchiveError::LimitsExceeded);
    }
    let mut output = Vec::with_capacity(size);
    output.extend_from_slice(ARCHIVE_MAGIC);
    output.extend_from_slice(&HISTORY_ARCHIVE_VERSION.to_le_bytes());
    output.extend_from_slice(&(heads.len() as u32).to_le_bytes());
    output.extend_from_slice(&(revisions.len() as u32).to_le_bytes());
    for envelope in std::iter::once(password).chain(revisions.iter().copied()) {
        output.extend_from_slice(&(envelope.len() as u32).to_le_bytes());
        output.extend_from_slice(envelope);
    }
    for &head in heads {
        output.extend_from_slice(&(head as u32).to_le_bytes());
    }
    Ok(output)
}
