//! Credential-independent history integrity and separate synthetic admission.
//!
//! Archive framing is neither an origin proof nor an anti-rollback anchor.
//! Legacy API snapshots retain their prior read policy; newly supported
//! Password records require exact closed fixtures and complete ancestry.

use std::collections::BTreeMap;

use vault_local_core::{
    CatalogCredentialTypeV1, OpenCredentialOutcome, StoredCredentialAuthenticationOutcomeV1,
    inspect_credential_chain_v1, inspect_synthetic_password_record_v1, open_credential_record_v1,
};

use super::*;

pub(super) fn validate(
    session: &vault_crypto::VaultSession,
    parsed: &ParsedArchive<'_>,
) -> Result<(), ArchiveError> {
    let authenticator = CredentialStorageAuthenticatorV1::new(session);
    let mut owned = Vec::with_capacity(parsed.records.len());
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
        receipts.push((receipt.record_id(), receipt.parent_revision_id()));
        let record = match authenticator
            .rehydrate_owned_stored_credential_v1(envelope.to_vec())
            .map_err(|error| map_local_error(error.code()))?
        {
            OwnedRehydratedCredentialOutcomeV1::Current(record) => record,
            OwnedRehydratedCredentialOutcomeV1::UpgradeRequired(_) => {
                return Err(ArchiveError::UpgradeRequired);
            }
        };
        owned.push(record);
    }

    for &head_index in &parsed.heads {
        let head = owned
            .get(head_index)
            .ok_or(ArchiveError::InvalidArchive)?
            .sealed_record();
        let &(record_id, parent_id) = receipts
            .get(head_index)
            .ok_or(ArchiveError::InvalidArchive)?;
        let mut ancestors = Vec::new();
        let kind = if parsed.version < HISTORY_ARCHIVE_VERSION {
            // Rehydration above rebuilt this locator from the authenticated
            // envelope. No caller-supplied cached locator is authoritative.
            let projection = match open_credential_record_v1(session, head)
                .map_err(|error| map_local_error(error.code()))?
            {
                OpenCredentialOutcome::Current(item) => item.into_catalog_projection_v1(),
                OpenCredentialOutcome::UpgradeRequired => {
                    return Err(ArchiveError::UpgradeRequired);
                }
            };
            let kind = projection.credential_type();
            if kind == CatalogCredentialTypeV1::Password {
                // No new missing-ancestor exception: legacy Password is genesis
                // only. Successors require v3/v4 with their entire history.
                inspect_credential_chain_v1(session, head, &[])
                    .map_err(|error| map_local_error(error.code()))?;
            }
            kind
        } else {
            let mut next = parent_id;
            while let Some(parent) = next {
                let index = *by_revision
                    .get(&parent)
                    .ok_or(ArchiveError::InvalidArchive)?;
                let &(ancestor_record, ancestor_parent) = &receipts[index];
                if ancestor_record != record_id || ancestors.len() >= parsed.records.len() {
                    return Err(ArchiveError::InvalidArchive);
                }
                ancestors.push(owned[index].sealed_record());
                next = ancestor_parent;
            }
            // Every ancestor must have the same credential type. A Password
            // node cannot hide inside an API chain, nor the reverse.
            inspect_credential_chain_v1(session, head, &ancestors)
                .map_err(|error| map_local_error(error.code()))?
                .credential_type()
        };

        match kind {
            CatalogCredentialTypeV1::ApiKey => {
                if parsed.version == STAGING_ARCHIVE_VERSION {
                    // v4 canonical API histories must be complete; an encrypted
                    // unfinished stage cannot be promoted to a head or ancestor.
                    rotation::validate_api_canonical_chain(session, head, &ancestors)?;
                }
            }
            CatalogCredentialTypeV1::Password => {
                for record in std::iter::once(head).chain(ancestors.iter().copied()) {
                    inspect_synthetic_password_record_v1(session, record)
                        .map_err(|error| map_local_error(error.code()))?;
                }
            }
            _ => return Err(ArchiveError::InvalidArchive),
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "archive_canonical_tests.rs"]
mod tests;
