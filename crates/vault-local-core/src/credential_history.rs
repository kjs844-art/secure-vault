//! Bounded authenticated topology for a single credential's immutable history.
//!
//! This is a generic integrity check, not authorization to rotate a credential,
//! proof of closed synthetic fixture values, or a trusted latest-head/rollback
//! anchor. Callers must apply their type-specific admission and lifecycle policy
//! separately. No Secret value or arbitrary display text is returned.

use std::collections::BTreeMap;

use vault_crypto::VaultSession;

use crate::LocalVaultError;
use crate::catalog::CatalogCredentialTypeV1;
use crate::ids::RevisionIdV1;
use crate::persistence::{
    CredentialStorageAuthenticatorV1, StoredCredentialAuthenticationOutcomeV1,
    inspect_synthetic_predecessor_v1,
};
use crate::record::SealedCredentialRecordV0Alpha1;

const MAX_CHAIN_REVISIONS: usize = 512;
const MAX_CHAIN_CIPHERTEXT_BYTES: usize = 8 * 1024 * 1024;

/// Secret-free chain summary with no public constructor or serialization.
pub struct CredentialChainInspectionV1 {
    credential_type: CatalogCredentialTypeV1,
    revision_count: usize,
}

impl CredentialChainInspectionV1 {
    pub const fn credential_type(&self) -> CatalogCredentialTypeV1 {
        self.credential_type
    }

    pub const fn revision_count(&self) -> usize {
        self.revision_count
    }
}

/// Authenticate exactly the supplied head and its complete rooted parent chain.
///
/// Ancestors may occur in any order. Every canonical envelope must authenticate
/// under the session, share one record identity and credential type, and occur
/// exactly once in the selected chain. Missing parents, cycles, foreign records,
/// duplicate revisions and unused branches fail closed. The cached locator is
/// not an authority. Counts and aggregate ciphertext bytes are bounded before
/// authentication. Inputs are never modified, including unsupported versions.
///
/// Success proves neither that this head is the newest revision nor that a
/// credential's contents satisfy synthetic-only or rotation-lifecycle policy.
pub fn inspect_credential_chain_v1(
    session: &VaultSession,
    head: &SealedCredentialRecordV0Alpha1,
    ancestors: &[&SealedCredentialRecordV0Alpha1],
) -> Result<CredentialChainInspectionV1, LocalVaultError> {
    let revision_count = validate_chain_size_limits(head, ancestors)?;
    let authenticator = CredentialStorageAuthenticatorV1::new(session);
    let mut nodes = BTreeMap::<RevisionIdV1, Option<RevisionIdV1>>::new();
    let mut selected_record = None;
    let mut selected_type = None;
    let mut head_revision = None;

    for record in std::iter::once(head).chain(ancestors.iter().copied()) {
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

        let credential_type =
            inspect_synthetic_predecessor_v1(session, record, |item, revision_id| {
                if revision_id != receipt.revision_id()
                    || item.parent_revision_id != receipt.parent_revision_id()
                {
                    return Err(LocalVaultError::AuthenticationFailed);
                }
                Ok(item.credential_type)
            })?;
        if let Some(expected_type) = selected_type {
            if credential_type != expected_type {
                return Err(LocalVaultError::InvalidItem);
            }
        } else {
            selected_type = Some(credential_type);
        }
        nodes.insert(receipt.revision_id(), receipt.parent_revision_id());
    }

    let mut next = head_revision;
    while let Some(revision_id) = next {
        // Removing visited nodes makes a cycle fail on its first repeated node.
        next = nodes
            .remove(&revision_id)
            .ok_or(LocalVaultError::InvalidItem)?;
    }
    if !nodes.is_empty() {
        return Err(LocalVaultError::InvalidItem);
    }

    Ok(CredentialChainInspectionV1 {
        credential_type: selected_type.ok_or(LocalVaultError::InvalidItem)?.into(),
        revision_count,
    })
}

fn validate_chain_size_limits(
    head: &SealedCredentialRecordV0Alpha1,
    ancestors: &[&SealedCredentialRecordV0Alpha1],
) -> Result<usize, LocalVaultError> {
    let count = ancestors
        .len()
        .checked_add(1)
        .ok_or(LocalVaultError::LimitsExceeded)?;
    if count > MAX_CHAIN_REVISIONS {
        return Err(LocalVaultError::LimitsExceeded);
    }
    let mut total = 0_usize;
    for record in std::iter::once(head).chain(ancestors.iter().copied()) {
        total = total
            .checked_add(record.envelope.len())
            .ok_or(LocalVaultError::LimitsExceeded)?;
        if total > MAX_CHAIN_CIPHERTEXT_BYTES {
            return Err(LocalVaultError::LimitsExceeded);
        }
    }
    Ok(count)
}

#[cfg(test)]
#[path = "credential_history_tests.rs"]
mod tests;
