//! Mutation-only completion checks. Legacy authenticated payloads remain readable.

use std::collections::BTreeSet;

use crate::LocalVaultError;
use crate::model::{
    ConnectionStatusV1, CredentialItemV1, CredentialStatusV1, ExternalRevocationAttestationV1,
    ExternalRevocationStatusV1, VerificationSourceV1,
};

/// A cutover event belongs to its own immutable revision. Only a fully completed
/// event may be left behind when creating a successor; incomplete events must
/// never disappear through a generic/no-op edit. This is recorded synthetic
/// evidence, not proof of provider-side updates or revocation.
pub(crate) fn validate_completed_rotation_event_v1(
    item: &CredentialItemV1,
) -> Result<(), LocalVaultError> {
    let Some(event) = &item.rotation_state else {
        return Ok(());
    };
    if item.status != CredentialStatusV1::Active
        || item.external_revocation_status != ExternalRevocationStatusV1::NotRequested
        || item.external_revocation_attestation != ExternalRevocationAttestationV1::None
        || item.revoked_at.is_some()
        || item.parent_revision_id != Some(event.supersedes_revision_id)
        || event.superseded_revoked_at.is_none()
        || !matches!(
            (
                event.superseded_external_revocation_status,
                event.superseded_external_revocation_attestation,
            ),
            (
                ExternalRevocationStatusV1::UserConfirmed,
                ExternalRevocationAttestationV1::User
            ) | (
                ExternalRevocationStatusV1::ProviderVerified,
                ExternalRevocationAttestationV1::ProviderConnector
            )
        )
    {
        return Err(LocalVaultError::InvalidItem);
    }

    let expected_timestamp = crate::rotation::completed_synthetic_rotation_timestamp_v1(item)?;
    if item.updated_at.as_str() != expected_timestamp
        || event
            .superseded_revoked_at
            .as_ref()
            .is_none_or(|timestamp| timestamp.as_str() != expected_timestamp)
    {
        return Err(LocalVaultError::InvalidItem);
    }

    let required: BTreeSet<_> = event.required_connection_ids.iter().copied().collect();
    let completed: BTreeSet<_> = event.completed_connection_ids.iter().copied().collect();
    let current_required: BTreeSet<_> = item
        .connections
        .iter()
        .filter(|connection| {
            connection.required_for_cutover && connection.status != ConnectionStatusV1::Removed
        })
        .map(|connection| connection.connection_id)
        .collect();
    if required.len() != event.required_connection_ids.len()
        || completed.len() != event.completed_connection_ids.len()
        || required != completed
        || required != current_required
    {
        return Err(LocalVaultError::InvalidItem);
    }
    for connection in item
        .connections
        .iter()
        .filter(|connection| connection.status != ConnectionStatusV1::Removed)
    {
        let verified_for_cutover = connection.status == ConnectionStatusV1::Verified
            && connection
                .last_verified_at
                .as_ref()
                .is_some_and(|timestamp| timestamp.as_str() == expected_timestamp)
            && matches!(
                connection.verification_source,
                VerificationSourceV1::User | VerificationSourceV1::ProviderConnector
            );
        let pending_optional = connection.status == ConnectionStatusV1::UpdateRequired
            && connection.verification_source == VerificationSourceV1::None
            && connection.last_verified_at.is_none();
        if (required.contains(&connection.connection_id) && !verified_for_cutover)
            || (!required.contains(&connection.connection_id)
                && !verified_for_cutover
                && !pending_optional)
        {
            return Err(LocalVaultError::InvalidItem);
        }
    }
    Ok(())
}

pub(crate) fn prepare_rotation_successor_v1(
    item: &mut CredentialItemV1,
) -> Result<(), LocalVaultError> {
    validate_completed_rotation_event_v1(item)?;
    // `item` is the newly authenticated, owned successor payload. No stored
    // envelope is overwritten; history remains in the predecessor ciphertext.
    item.rotation_state = None;
    Ok(())
}
