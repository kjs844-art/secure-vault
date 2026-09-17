//! Append-only encrypted rotation siblings inside the bounded v4 archive.
//! Staging order is local progress selection, not an anti-rollback authority.

use std::collections::BTreeSet;

use vault_local_core::{
    StoredCredentialAuthenticationOutcomeV1, SyntheticRotationStageProjectionV1,
    SyntheticRotationStageRevocationV1, SyntheticRotationStageSelectionV1,
    create_synthetic_rotation_cutover_from_stage_v1, create_synthetic_rotation_stage_v1,
    inspect_synthetic_rotation_checklist_v1, inspect_synthetic_rotation_stage_v1,
};

use super::*;

/// Save a sibling; no canonical head is replaced or added here.
pub(crate) fn create_rotation_stage_candidate(
    input: &[u8],
    reference: u32,
    user_confirmed: &[u32],
    provider_verified: &[u32],
    revocation: SyntheticRotationStageRevocationV1,
) -> Result<Vec<u8>, ArchiveError> {
    let selection = SyntheticRotationStageSelectionV1::from_fixture_ids(
        user_confirmed,
        provider_verified,
        revocation,
    )
    .map_err(|error| map_local_error(error.code()))?;
    let prepared = rotation::prepare_archive(input, reference)?;
    if prepared.parsed.records.len() + prepared.parsed.stages.len() >= MAX_REVISION_COUNT {
        return Err(ArchiveError::LimitsExceeded);
    }
    let reference = rotation::checked_reference(&prepared.parsed, reference)?;
    let stage = create_synthetic_rotation_stage_v1(
        &prepared.session,
        prepared.selected.head.sealed_record(),
        &selection,
    )
    .map_err(|error| map_local_error(error.code()))?;
    let mut stages = prepared.parsed.stages.clone();
    stages.push(StagedEnvelope {
        base_index: prepared.parsed.heads[reference],
        envelope: stage.envelope(),
    });
    let candidate = encode(
        prepared.parsed.password_envelope,
        &prepared.parsed.records,
        &prepared.parsed.heads,
        &stages,
    )?;
    let candidate = verify_candidate(&prepared.session, candidate)?;
    let verified = parse_archive(&candidate)?;
    if verified.version != STAGING_ARCHIVE_VERSION
        || verified.password_envelope != prepared.parsed.password_envelope
        || verified.records != prepared.parsed.records
        || verified.heads != prepared.parsed.heads
        || verified.stages != stages
    {
        return Err(ArchiveError::InvalidArchive);
    }
    Ok(candidate)
}

/// The latest saved sibling of the exact current head, after full authentication.
/// Old stages remain authenticated but are not rebased onto a newer head.
pub(crate) fn inspect_rotation_stage(
    input: &[u8],
    reference: u32,
) -> Result<Option<SyntheticRotationStageProjectionV1>, ArchiveError> {
    let prepared = rotation::prepare_archive(input, reference)?;
    let reference = rotation::checked_reference(&prepared.parsed, reference)?;
    latest_stage(&prepared.parsed, reference)
        .map(|stage| {
            inspect_synthetic_rotation_stage_v1(
                &prepared.session,
                prepared.selected.head.sealed_record(),
                stage.envelope,
            )
            .map_err(|error| map_local_error(error.code()))
        })
        .transpose()
}

/// Only a ready, authenticated saved sibling can produce the final canonical
/// successor. All saved snapshots, including the finalized one, stay immutable.
pub(crate) fn create_rotation_cutover_from_stage_candidate(
    input: &[u8],
    reference: u32,
) -> Result<Vec<u8>, ArchiveError> {
    let prepared = rotation::prepare_archive(input, reference)?;
    let index = rotation::checked_reference(&prepared.parsed, reference)?;
    if prepared.parsed.records.len() + prepared.parsed.stages.len() >= MAX_REVISION_COUNT {
        return Err(ArchiveError::LimitsExceeded);
    }
    let stage = latest_stage(&prepared.parsed, index).ok_or(ArchiveError::InvalidArchive)?;
    let base = prepared.selected.head.sealed_record();
    let progress = inspect_synthetic_rotation_stage_v1(&prepared.session, base, stage.envelope)
        .map_err(|error| map_local_error(error.code()))?;
    let successor =
        create_synthetic_rotation_cutover_from_stage_v1(&prepared.session, base, stage.envelope)
            .map_err(|error| map_local_error(error.code()))?;
    let before = base.persistence_projection_v1();
    let after = successor.persistence_projection_v1();
    if before.record_id() != after.record_id()
        || after.expected_revision_id() != Some(before.revision_id())
        || before.revision_id() == after.revision_id()
    {
        return Err(ArchiveError::InvalidArchive);
    }
    let mut records = prepared.parsed.records.clone();
    let mut heads = prepared.parsed.heads.clone();
    heads[index] = records.len();
    records.push(after.envelope());
    let candidate = encode(
        prepared.parsed.password_envelope,
        &records,
        &heads,
        &prepared.parsed.stages,
    )?;
    let candidate = verify_candidate(&prepared.session, candidate)?;
    let verified = rotation::prepare_archive(&candidate, reference)?;
    rotation::verify_candidate_layout(&prepared.parsed, &verified.parsed, index, after.envelope())?;
    let checklist = inspect_synthetic_rotation_checklist_v1(
        &verified.session,
        verified.selected.head.sealed_record(),
    )
    .map_err(|error| map_local_error(error.code()))?;
    if checklist.generation() != progress.target_generation()
        || latest_stage(&verified.parsed, index).is_some()
    {
        return Err(ArchiveError::InvalidArchive);
    }
    Ok(candidate)
}

pub(super) fn latest_stage<'a>(
    parsed: &'a ParsedArchive<'a>,
    reference: usize,
) -> Option<&'a StagedEnvelope<'a>> {
    let current = parsed.heads[reference];
    parsed
        .stages
        .iter()
        .rev()
        .find(|stage| stage.base_index == current)
}

/// Authenticate every stage, even obsolete ones, and reject revision collisions
/// across the canonical and staged sets before anything is displayed.
pub(super) fn validate(
    session: &vault_crypto::VaultSession,
    parsed: &ParsedArchive<'_>,
) -> Result<(), ArchiveError> {
    rotation::validate_canonical_chains(session, parsed)?;
    let authenticator = CredentialStorageAuthenticatorV1::new(session);
    let mut revisions = BTreeSet::new();
    for envelope in parsed
        .records
        .iter()
        .copied()
        .chain(parsed.stages.iter().map(|stage| stage.envelope))
    {
        let receipt = match authenticator
            .authenticate_stored_credential_v1(envelope)
            .map_err(|error| map_local_error(error.code()))?
        {
            StoredCredentialAuthenticationOutcomeV1::Current(receipt) => receipt,
            StoredCredentialAuthenticationOutcomeV1::AuthenticatedFutureInner(_) => {
                return Err(ArchiveError::UpgradeRequired);
            }
        };
        if !revisions.insert(receipt.revision_id()) {
            return Err(ArchiveError::InvalidArchive);
        }
    }
    for stage in &parsed.stages {
        let envelope = parsed
            .records
            .get(stage.base_index)
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
        inspect_synthetic_rotation_stage_v1(session, base.sealed_record(), stage.envelope)
            .map_err(|error| map_local_error(error.code()))?;
    }
    Ok(())
}

pub(super) fn encode(
    password: &[u8],
    revisions: &[&[u8]],
    heads: &[usize],
    stages: &[StagedEnvelope<'_>],
) -> Result<Vec<u8>, ArchiveError> {
    check_record_count(STAGING_ARCHIVE_VERSION, heads.len())?;
    if revisions
        .len()
        .checked_add(stages.len())
        .ok_or(ArchiveError::LimitsExceeded)?
        > MAX_REVISION_COUNT
    {
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
    if stages
        .iter()
        .any(|stage| stage.base_index >= revisions.len())
    {
        return Err(ArchiveError::InvalidArchive);
    }
    let mut size = 24_usize
        .checked_add(
            heads
                .len()
                .checked_mul(4)
                .ok_or(ArchiveError::LimitsExceeded)?,
        )
        .and_then(|size| size.checked_add(stages.len().checked_mul(4)?))
        .ok_or(ArchiveError::LimitsExceeded)?;
    for envelope in std::iter::once(password)
        .chain(revisions.iter().copied())
        .chain(stages.iter().map(|stage| stage.envelope))
    {
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
    for value in [
        STAGING_ARCHIVE_VERSION,
        heads.len() as u32,
        revisions.len() as u32,
        stages.len() as u32,
    ] {
        output.extend_from_slice(&value.to_le_bytes());
    }
    for envelope in std::iter::once(password).chain(revisions.iter().copied()) {
        output.extend_from_slice(&(envelope.len() as u32).to_le_bytes());
        output.extend_from_slice(envelope);
    }
    for &head in heads {
        output.extend_from_slice(&(head as u32).to_le_bytes());
    }
    for stage in stages {
        output.extend_from_slice(&(stage.base_index as u32).to_le_bytes());
        output.extend_from_slice(&(stage.envelope.len() as u32).to_le_bytes());
        output.extend_from_slice(stage.envelope);
    }
    Ok(output)
}

#[cfg(test)]
#[path = "archive_staging_tests.rs"]
mod tests;
