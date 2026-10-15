//! Closed synthetic rotation over one authenticated archive head.
//!
//! This module never accepts arbitrary secret, text, timestamp, URL, entity ID,
//! command, or provider response. The caller selects only built-in
//! fixtures. An archive remains caller-supplied state: successful authentication
//! does not prove that its selected head is globally latest or rollback-free.

use std::collections::BTreeMap;

use vault_local_core::{
    CredentialStorageAuthenticatorV1, OwnedRehydratedCredentialOutcomeV1,
    OwnedRehydratedCredentialV1, StoredCredentialAuthenticationOutcomeV1,
    SyntheticRotationChecklistFixtureV1, SyntheticRotationChecklistGenerationV1,
    SyntheticRotationCutoverSelectionV1, SyntheticRotationReadinessV1,
    SyntheticRotationRecordedCompletionV1, SyntheticVerificationEvidenceV1,
    create_synthetic_rotation_cutover_successor_v1, inspect_synthetic_rotation_checklist_v1,
    inspect_synthetic_rotation_history_v1, inspect_synthetic_rotation_readiness_v1,
};

use super::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ArchiveRotationGenerationV1 {
    Initial0001,
    Rotated0002,
    Terminal0003,
}

impl ArchiveRotationGenerationV1 {
    const fn next(self) -> Option<Self> {
        match self {
            Self::Initial0001 => Some(Self::Rotated0002),
            Self::Rotated0002 => Some(Self::Terminal0003),
            Self::Terminal0003 => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ArchiveRotationFixtureV1 {
    Mcp,
    Cli,
    Ci,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ArchiveRotationReadinessStateV1 {
    RequiredPending,
    Ready,
    Terminal,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ArchiveRotationChecklistEntryV1 {
    fixture: ArchiveRotationFixtureV1,
    required_for_cutover: bool,
}

impl ArchiveRotationChecklistEntryV1 {
    pub(crate) const fn fixture(&self) -> ArchiveRotationFixtureV1 {
        self.fixture
    }

    pub(crate) const fn required_for_cutover(&self) -> bool {
        self.required_for_cutover
    }
}

/// Sanitized fixed-enum projection. It intentionally contains no record ID,
/// revision ID, display string, provider response, timestamp, or secret value.
pub(crate) struct ArchiveRotationChecklistV1 {
    generation: ArchiveRotationGenerationV1,
    entries: Vec<ArchiveRotationChecklistEntryV1>,
    readiness_state: ArchiveRotationReadinessStateV1,
    remaining_required: u32,
    remaining_optional: u32,
}

impl ArchiveRotationChecklistV1 {
    pub(crate) const fn generation(&self) -> ArchiveRotationGenerationV1 {
        self.generation
    }

    pub(crate) fn entries(&self) -> &[ArchiveRotationChecklistEntryV1] {
        &self.entries
    }

    pub(crate) const fn readiness_state(&self) -> ArchiveRotationReadinessStateV1 {
        self.readiness_state
    }

    pub(crate) const fn remaining_required(&self) -> u32 {
        self.remaining_required
    }

    pub(crate) const fn remaining_optional(&self) -> u32 {
        self.remaining_optional
    }
}

struct HeadChecklist {
    generation: ArchiveRotationGenerationV1,
    entries: Vec<ArchiveRotationChecklistEntryV1>,
}

struct Receipt {
    record_id: vault_local_core::RecordIdV1,
    parent_revision_id: Option<vault_local_core::RevisionIdV1>,
}

pub(super) struct SelectedChain {
    pub(super) head: OwnedRehydratedCredentialV1,
    ancestors: Vec<OwnedRehydratedCredentialV1>,
}

struct RotationHistorySummary {
    event_count: usize,
    newest_event: Option<(
        vault_local_core::RevisionIdV1,
        vault_local_core::RevisionIdV1,
    )>,
}

pub(super) struct PreparedArchive<'a> {
    pub(super) parsed: ParsedArchive<'a>,
    pub(super) session: vault_crypto::VaultSession,
    pub(super) selected: SelectedChain,
    checklist: HeadChecklist,
    rotation_history: RotationHistorySummary,
}

/// Authenticate the complete archive and the selected head's exact ancestor
/// chain before returning a fixed, sanitized rotation checklist. A terminal
/// generation has no next cutover, so otherwise well-formed completion
/// selections are intentionally ignored and its remaining counts are zero.
pub(crate) fn inspect_rotation_checklist(
    input: &[u8],
    reference: u32,
    user_confirmed: &[u32],
    provider_verified: &[u32],
    superseded_revocation: SyntheticVerificationEvidenceV1,
) -> Result<ArchiveRotationChecklistV1, ArchiveError> {
    let selection = cutover_selection(user_confirmed, provider_verified, superseded_revocation)?;
    let prepared = prepare_archive(input, reference)?;
    let (readiness_state, remaining_required, remaining_optional) =
        if prepared.checklist.generation == ArchiveRotationGenerationV1::Terminal0003 {
            (ArchiveRotationReadinessStateV1::Terminal, 0, 0)
        } else {
            match inspect_synthetic_rotation_readiness_v1(
                &prepared.session,
                prepared.selected.head.sealed_record(),
                &selection,
            )
            .map_err(|error| map_local_error(error.code()))?
            {
                SyntheticRotationReadinessV1::RequiredPending { remaining_required } => (
                    ArchiveRotationReadinessStateV1::RequiredPending,
                    remaining_required,
                    0,
                ),
                SyntheticRotationReadinessV1::Ready { remaining_optional } => (
                    ArchiveRotationReadinessStateV1::Ready,
                    0,
                    remaining_optional,
                ),
            }
        };
    Ok(ArchiveRotationChecklistV1 {
        generation: prepared.checklist.generation,
        entries: prepared.checklist.entries,
        readiness_state,
        remaining_required,
        remaining_optional,
    })
}

/// Append exactly one closed synthetic cutover revision to the selected head.
///
/// `user_confirmed` and `provider_verified` are fixture IDs (0 MCP, 1 CLI,
/// 2 CI). The revocation evidence is a fixed enum, not a provider call. The
/// returned v3 archive is only a candidate for the host's later storage CAS.
pub(crate) fn create_rotation_cutover_candidate(
    input: &[u8],
    reference: u32,
    user_confirmed: &[u32],
    provider_verified: &[u32],
    superseded_revocation: SyntheticVerificationEvidenceV1,
) -> Result<Vec<u8>, ArchiveError> {
    let selection = cutover_selection(user_confirmed, provider_verified, superseded_revocation)?;
    let prepared = prepare_archive(input, reference)?;
    let expected_generation = prepared
        .checklist
        .generation
        .next()
        .ok_or(ArchiveError::InvalidArchive)?;
    if prepared.parsed.records.len() + prepared.parsed.stages.len() >= MAX_REVISION_COUNT {
        return Err(ArchiveError::LimitsExceeded);
    }

    let predecessor = prepared.selected.head.sealed_record();
    if !matches!(
        inspect_synthetic_rotation_readiness_v1(&prepared.session, predecessor, &selection)
            .map_err(|error| map_local_error(error.code()))?,
        SyntheticRotationReadinessV1::Ready { .. }
    ) {
        return Err(ArchiveError::InvalidArchive);
    }
    let predecessor_projection = predecessor.persistence_projection_v1();
    let successor =
        create_synthetic_rotation_cutover_successor_v1(&prepared.session, predecessor, &selection)
            .map_err(|error| map_local_error(error.code()))?;
    let successor_projection = successor.persistence_projection_v1();
    if successor_projection.record_id() != predecessor_projection.record_id()
        || successor_projection.expected_revision_id() != Some(predecessor_projection.revision_id())
        || successor_projection.revision_id() == predecessor_projection.revision_id()
    {
        return Err(ArchiveError::InvalidArchive);
    }

    let reference = checked_reference(&prepared.parsed, reference)?;
    let appended_index = prepared.parsed.records.len();
    let mut records = prepared.parsed.records.clone();
    records.push(successor_projection.envelope());
    let mut heads = prepared.parsed.heads.clone();
    heads[reference] = appended_index;
    let candidate = if prepared.parsed.version == STAGING_ARCHIVE_VERSION {
        super::staging::encode(
            prepared.parsed.password_envelope,
            &records,
            &heads,
            &prepared.parsed.stages,
        )
    } else {
        super::history::encode(prepared.parsed.password_envelope, &records, &heads)
    }?;
    let candidate = verify_candidate(&prepared.session, candidate)?;

    // Reparse/re-authenticate the assembled output rather than trusting the
    // generator. Prefix bytes, every other head and the one appended revision
    // are checked before ciphertext can leave this boundary.
    let verified = prepare_archive(
        &candidate,
        u32::try_from(reference).map_err(|_| ArchiveError::LimitsExceeded)?,
    )?;
    verify_candidate_layout(
        &prepared.parsed,
        &verified.parsed,
        reference,
        successor_projection.envelope(),
    )?;
    if verified.checklist.generation != expected_generation
        || verified.rotation_history.event_count
            != prepared
                .rotation_history
                .event_count
                .checked_add(1)
                .ok_or(ArchiveError::LimitsExceeded)?
        || verified.rotation_history.newest_event
            != Some((
                successor_projection.revision_id(),
                predecessor_projection.revision_id(),
            ))
    {
        return Err(ArchiveError::InvalidArchive);
    }
    Ok(candidate)
}

pub(super) fn prepare_archive<'a>(
    input: &'a [u8],
    reference: u32,
) -> Result<PreparedArchive<'a>, ArchiveError> {
    let parsed = parse_archive(input)?;
    inspect_envelopes(&parsed)?;
    let session = unlock_vault_v0alpha1(&demo_password()?, parsed.password_envelope)
        .map_err(|error| map_crypto_error(error.code()))?;

    // Authenticate and project every head. The explicit history validation is
    // also required for v1/v2: only genuine genesis records may migrate to v3;
    // a legacy successor without its ancestors must not fabricate history.
    drop(project_archive(&session, &parsed)?);
    super::history::validate(&session, &parsed)?;
    let selected = selected_chain(&session, &parsed, reference)?;
    let (checklist, rotation_history) = validate_selected_chain(&session, &selected)?;
    Ok(PreparedArchive {
        parsed,
        session,
        selected,
        checklist,
        rotation_history,
    })
}

fn selected_chain(
    session: &vault_crypto::VaultSession,
    parsed: &ParsedArchive<'_>,
    reference: u32,
) -> Result<SelectedChain, ArchiveError> {
    let selected_head = parsed.heads[checked_reference(parsed, reference)?];
    let authenticator = CredentialStorageAuthenticatorV1::new(session);
    let mut receipts = Vec::with_capacity(parsed.records.len());
    let mut by_revision = BTreeMap::new();
    for (index, envelope) in parsed.records.iter().enumerate() {
        let receipt = match authenticator
            .authenticate_stored_credential_v1(envelope)
            .map_err(|error| map_local_error(error.code()))?
        {
            StoredCredentialAuthenticationOutcomeV1::Current(receipt) => receipt,
            StoredCredentialAuthenticationOutcomeV1::AuthenticatedFutureInner(_) => {
                return Err(ArchiveError::UpgradeRequired);
            }
        };
        if by_revision.insert(receipt.revision_id(), index).is_some() {
            return Err(ArchiveError::InvalidArchive);
        }
        receipts.push(Receipt {
            record_id: receipt.record_id(),
            parent_revision_id: receipt.parent_revision_id(),
        });
    }

    let selected_record = receipts
        .get(selected_head)
        .ok_or(ArchiveError::InvalidArchive)?
        .record_id;
    let mut indexes = Vec::new();
    let mut next = Some(selected_head);
    while let Some(index) = next {
        let receipt = receipts.get(index).ok_or(ArchiveError::InvalidArchive)?;
        if receipt.record_id != selected_record {
            return Err(ArchiveError::InvalidArchive);
        }
        indexes.push(index);
        next = match receipt.parent_revision_id {
            Some(parent) => Some(
                *by_revision
                    .get(&parent)
                    .ok_or(ArchiveError::InvalidArchive)?,
            ),
            None => None,
        };
        if indexes.len() > parsed.records.len() {
            return Err(ArchiveError::InvalidArchive);
        }
    }

    let mut owned = Vec::with_capacity(indexes.len());
    for index in indexes {
        let envelope = parsed
            .records
            .get(index)
            .ok_or(ArchiveError::InvalidArchive)?;
        match authenticator
            .rehydrate_owned_stored_credential_v1(envelope.to_vec())
            .map_err(|error| map_local_error(error.code()))?
        {
            OwnedRehydratedCredentialOutcomeV1::Current(record) => owned.push(record),
            OwnedRehydratedCredentialOutcomeV1::UpgradeRequired(_) => {
                return Err(ArchiveError::UpgradeRequired);
            }
        }
    }
    let mut owned = owned.into_iter();
    let head = owned.next().ok_or(ArchiveError::InvalidArchive)?;
    Ok(SelectedChain {
        head,
        ancestors: owned.collect(),
    })
}

fn validate_selected_chain(
    session: &vault_crypto::VaultSession,
    selected: &SelectedChain,
) -> Result<(HeadChecklist, RotationHistorySummary), ArchiveError> {
    let ancestors = selected
        .ancestors
        .iter()
        .map(OwnedRehydratedCredentialV1::sealed_record)
        .collect::<Vec<_>>();
    validate_record_chain(session, selected.head.sealed_record(), &ancestors)
}

fn validate_record_chain(
    session: &vault_crypto::VaultSession,
    head: &vault_local_core::SealedCredentialRecordV0Alpha1,
    ancestors: &[&vault_local_core::SealedCredentialRecordV0Alpha1],
) -> Result<(HeadChecklist, RotationHistorySummary), ArchiveError> {
    let history = inspect_synthetic_rotation_history_v1(session, head, ancestors)
        .map_err(|error| map_local_error(error.code()))?;
    ensure_complete_history(
        history
            .events()
            .iter()
            .map(|event| event.recorded_completion()),
    )?;
    let checklist = inspect_synthetic_rotation_checklist_v1(session, head)
        .map_err(|error| map_local_error(error.code()))?;
    let generation = match checklist.generation() {
        SyntheticRotationChecklistGenerationV1::Initial0001 => {
            ArchiveRotationGenerationV1::Initial0001
        }
        SyntheticRotationChecklistGenerationV1::Rotated0002 => {
            ArchiveRotationGenerationV1::Rotated0002
        }
        SyntheticRotationChecklistGenerationV1::Terminal0003 => {
            ArchiveRotationGenerationV1::Terminal0003
        }
    };
    let entries = checklist
        .entries()
        .iter()
        .map(|entry| ArchiveRotationChecklistEntryV1 {
            fixture: match entry.fixture() {
                SyntheticRotationChecklistFixtureV1::Mcp => ArchiveRotationFixtureV1::Mcp,
                SyntheticRotationChecklistFixtureV1::Cli => ArchiveRotationFixtureV1::Cli,
                SyntheticRotationChecklistFixtureV1::Ci => ArchiveRotationFixtureV1::Ci,
            },
            required_for_cutover: entry.required_for_cutover(),
        })
        .collect();
    let newest_event = history
        .events()
        .first()
        .map(|event| (event.revision_id(), event.parent_revision_id()));
    Ok((
        HeadChecklist {
            generation,
            entries,
        },
        RotationHistorySummary {
            event_count: history.events().len(),
            newest_event,
        },
    ))
}

/// API-only canonical admission after common topology and type validation.
/// This preserves v4's complete-event requirement without treating Password
/// records as API rotation candidates.
pub(super) fn validate_api_canonical_chain(
    session: &vault_crypto::VaultSession,
    head: &vault_local_core::SealedCredentialRecordV0Alpha1,
    ancestors: &[&vault_local_core::SealedCredentialRecordV0Alpha1],
) -> Result<(), ArchiveError> {
    validate_record_chain(session, head, ancestors).map(|_| ())
}

fn cutover_selection(
    user_confirmed: &[u32],
    provider_verified: &[u32],
    superseded_revocation: SyntheticVerificationEvidenceV1,
) -> Result<SyntheticRotationCutoverSelectionV1, ArchiveError> {
    SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        user_confirmed,
        provider_verified,
        superseded_revocation,
    )
    .map_err(|error| map_local_error(error.code()))
}

fn ensure_complete_history(
    completions: impl IntoIterator<Item = SyntheticRotationRecordedCompletionV1>,
) -> Result<(), ArchiveError> {
    if completions
        .into_iter()
        .any(|completion| completion == SyntheticRotationRecordedCompletionV1::Incomplete)
    {
        return Err(ArchiveError::InvalidArchive);
    }
    Ok(())
}

pub(super) fn checked_reference(
    parsed: &ParsedArchive<'_>,
    reference: u32,
) -> Result<usize, ArchiveError> {
    let reference = usize::try_from(reference).map_err(|_| ArchiveError::InvalidArchive)?;
    parsed
        .heads
        .get(reference)
        .ok_or(ArchiveError::InvalidArchive)?;
    Ok(reference)
}

pub(super) fn verify_candidate_layout(
    before: &ParsedArchive<'_>,
    after: &ParsedArchive<'_>,
    selected_reference: usize,
    appended_envelope: &[u8],
) -> Result<(), ArchiveError> {
    let expected_version = if before.version == STAGING_ARCHIVE_VERSION {
        STAGING_ARCHIVE_VERSION
    } else {
        HISTORY_ARCHIVE_VERSION
    };
    if after.version != expected_version
        || after.password_envelope != before.password_envelope
        || after.records.len()
            != before
                .records
                .len()
                .checked_add(1)
                .ok_or(ArchiveError::LimitsExceeded)?
        || after.records[..before.records.len()] != before.records[..]
        || after.records.last().copied() != Some(appended_envelope)
        || after.heads.len() != before.heads.len()
        || after.stages != before.stages
    {
        return Err(ArchiveError::InvalidArchive);
    }
    for (index, (&old, &new)) in before.heads.iter().zip(&after.heads).enumerate() {
        let expected = if index == selected_reference {
            before.records.len()
        } else {
            old
        };
        if new != expected {
            return Err(ArchiveError::InvalidArchive);
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "archive_rotation_tests.rs"]
mod tests;
