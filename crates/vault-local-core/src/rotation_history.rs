//! Bounded, authenticated synthetic rotation-event history.
//!
//! This inspects the caller-supplied head and its exact ancestor chain. It is
//! not a trusted latest-head/rollback anchor, provider call, or proof that an
//! external credential was revoked. No Secret or arbitrary display text is
//! returned, and every source envelope remains unchanged.

use std::collections::BTreeMap;

use vault_crypto::VaultSession;

use crate::LocalVaultError;
use crate::ids::RevisionIdV1;
use crate::model::ExternalRevocationAttestationV1;
use crate::persistence::{
    CredentialStorageAuthenticatorV1, StoredCredentialAuthenticationOutcomeV1,
    inspect_synthetic_predecessor_v1,
};
use crate::record::SealedCredentialRecordV0Alpha1;
use crate::rotation::{SyntheticApiKeyGeneration, classify_synthetic_generation_v1};
use crate::rotation_lifecycle::validate_completed_rotation_event_v1;

const MAX_HISTORY_REVISIONS: usize = 512;
const MAX_HISTORY_CIPHERTEXT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum SyntheticRotationRecordedCompletionV1 {
    Complete,
    /// Decoder-valid legacy evidence that does not authorize a new edit.
    Incomplete,
}

/// Recorded attestation source only; neither variant proves provider activity.
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum SyntheticRotationRevocationSourceV1 {
    None,
    User,
    ProviderConnector,
}

/// Sanitized event metadata with no public constructor or raw payload access.
pub struct SyntheticRotationHistoryEventV1 {
    revision_id: RevisionIdV1,
    parent_revision_id: RevisionIdV1,
    required_connection_count: u32,
    completed_connection_count: u32,
    recorded_completion: SyntheticRotationRecordedCompletionV1,
    superseded_revocation_source: SyntheticRotationRevocationSourceV1,
}

impl SyntheticRotationHistoryEventV1 {
    pub const fn revision_id(&self) -> RevisionIdV1 {
        self.revision_id
    }

    pub const fn parent_revision_id(&self) -> RevisionIdV1 {
        self.parent_revision_id
    }

    pub const fn required_connection_count(&self) -> u32 {
        self.required_connection_count
    }

    pub const fn completed_connection_count(&self) -> u32 {
        self.completed_connection_count
    }

    pub const fn recorded_completion(&self) -> SyntheticRotationRecordedCompletionV1 {
        self.recorded_completion
    }

    pub const fn superseded_revocation_source(&self) -> SyntheticRotationRevocationSourceV1 {
        self.superseded_revocation_source
    }
}

pub struct SyntheticRotationHistoryV1 {
    events: Vec<SyntheticRotationHistoryEventV1>,
}

impl SyntheticRotationHistoryV1 {
    /// Events in parent-chain order, newest first; wall-clock text is not used.
    pub fn events(&self) -> &[SyntheticRotationHistoryEventV1] {
        &self.events
    }
}

struct AuthenticatedHistoryNode {
    parent_revision_id: Option<RevisionIdV1>,
    generation: SyntheticApiKeyGeneration,
    event: Option<SyntheticRotationHistoryEventV1>,
}

/// Authenticate exactly one complete record chain before exposing any events.
///
/// `ancestors` may be supplied in any order, but each revision must occur once
/// and belong to the selected head's chain. Missing parents, cycles, unrelated
/// records and unused branches fail closed. Counts and ciphertext size are
/// bounded before authentication, including the head. Future versions produce
/// an error without modifying any supplied bytes. Incomplete legacy events
/// remain readable and never become permission to mutate that revision.
pub fn inspect_synthetic_rotation_history_v1(
    session: &VaultSession,
    head: &SealedCredentialRecordV0Alpha1,
    ancestors: &[&SealedCredentialRecordV0Alpha1],
) -> Result<SyntheticRotationHistoryV1, LocalVaultError> {
    validate_history_size_limits(head, ancestors)?;
    let authenticator = CredentialStorageAuthenticatorV1::new(session);
    let mut nodes = BTreeMap::new();
    let mut selected_record = None;
    let mut head_revision = None;

    for record in std::iter::once(head).chain(ancestors.iter().copied()) {
        // Authenticate the canonical envelope, never the mutable cached locator.
        let StoredCredentialAuthenticationOutcomeV1::Current(receipt) =
            authenticator.authenticate_stored_credential_v1(&record.envelope)?
        else {
            return Err(LocalVaultError::CryptoFailure);
        };
        if receipt.key_epoch() != session.key_epoch().get() {
            return Err(LocalVaultError::AuthenticationFailed);
        }
        if let Some(record_id) = selected_record {
            if receipt.record_id() != record_id {
                return Err(LocalVaultError::InvalidItem);
            }
        } else {
            selected_record = Some(receipt.record_id());
            head_revision = Some(receipt.revision_id());
        }
        if nodes.contains_key(&receipt.revision_id()) {
            return Err(LocalVaultError::InvalidItem);
        }

        let (generation, event) =
            inspect_synthetic_predecessor_v1(session, record, |item, revision_id| {
                if revision_id != receipt.revision_id()
                    || item.parent_revision_id != receipt.parent_revision_id()
                {
                    return Err(LocalVaultError::AuthenticationFailed);
                }
                let generation = classify_synthetic_generation_v1(item)?;
                let Some(rotation) = &item.rotation_state else {
                    return Ok((generation, None));
                };
                let parent_revision_id = item
                    .parent_revision_id
                    .ok_or(LocalVaultError::InvalidItem)?;
                let required_connection_count =
                    u32::try_from(rotation.required_connection_ids.len())
                        .map_err(|_| LocalVaultError::LimitsExceeded)?;
                let completed_connection_count =
                    u32::try_from(rotation.completed_connection_ids.len())
                        .map_err(|_| LocalVaultError::LimitsExceeded)?;
                let recorded_completion = if validate_completed_rotation_event_v1(item).is_ok() {
                    SyntheticRotationRecordedCompletionV1::Complete
                } else {
                    SyntheticRotationRecordedCompletionV1::Incomplete
                };
                let superseded_revocation_source =
                    match rotation.superseded_external_revocation_attestation {
                        ExternalRevocationAttestationV1::None => {
                            SyntheticRotationRevocationSourceV1::None
                        }
                        ExternalRevocationAttestationV1::User => {
                            SyntheticRotationRevocationSourceV1::User
                        }
                        ExternalRevocationAttestationV1::ProviderConnector => {
                            SyntheticRotationRevocationSourceV1::ProviderConnector
                        }
                    };
                Ok((
                    generation,
                    Some(SyntheticRotationHistoryEventV1 {
                        revision_id,
                        parent_revision_id,
                        required_connection_count,
                        completed_connection_count,
                        recorded_completion,
                        superseded_revocation_source,
                    }),
                ))
            })?;
        nodes.insert(
            receipt.revision_id(),
            AuthenticatedHistoryNode {
                parent_revision_id: receipt.parent_revision_id(),
                generation,
                event,
            },
        );
    }

    let mut next = head_revision;
    let mut chain = Vec::new();
    while let Some(revision_id) = next {
        // Removing each visited node also makes cycles fail at the first revisit.
        let node = nodes
            .remove(&revision_id)
            .ok_or(LocalVaultError::InvalidItem)?;
        next = node.parent_revision_id;
        chain.push(node);
    }
    if !nodes.is_empty() {
        return Err(LocalVaultError::InvalidItem);
    }

    let mut parent_generation: Option<SyntheticApiKeyGeneration> = None;
    for node in chain.iter_mut().rev() {
        match parent_generation {
            None => {
                if node.generation != SyntheticApiKeyGeneration::Initial0001 {
                    return Err(LocalVaultError::InvalidItem);
                }
            }
            Some(parent) => match node.event.as_mut() {
                Some(event)
                    if event.recorded_completion
                        == SyntheticRotationRecordedCompletionV1::Complete
                        && parent.next() != Some(node.generation) =>
                {
                    event.recorded_completion = SyntheticRotationRecordedCompletionV1::Incomplete;
                }
                Some(_) => {}
                None if node.generation != parent => return Err(LocalVaultError::InvalidItem),
                None => {}
            },
        }
        parent_generation = Some(node.generation);
    }
    let events = chain.into_iter().filter_map(|node| node.event).collect();
    Ok(SyntheticRotationHistoryV1 { events })
}

fn validate_history_size_limits(
    head: &SealedCredentialRecordV0Alpha1,
    ancestors: &[&SealedCredentialRecordV0Alpha1],
) -> Result<(), LocalVaultError> {
    let count = ancestors
        .len()
        .checked_add(1)
        .ok_or(LocalVaultError::LimitsExceeded)?;
    if count > MAX_HISTORY_REVISIONS {
        return Err(LocalVaultError::LimitsExceeded);
    }
    let mut total = 0_usize;
    for record in std::iter::once(head).chain(ancestors.iter().copied()) {
        total = total
            .checked_add(record.envelope.len())
            .ok_or(LocalVaultError::LimitsExceeded)?;
        if total > MAX_HISTORY_CIPHERTEXT_BYTES {
            return Err(LocalVaultError::LimitsExceeded);
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "rotation_history_tests.rs"]
mod tests;
