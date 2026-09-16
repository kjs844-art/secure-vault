//! Closed, synthetic-only credential rotation cutover.
//!
//! This boundary accepts fixture IDs and build-included demonstration values
//! only. It performs no provider call and does not prove real-world revocation.
//! This is a one-shot core fixture: completed rotation history currently blocks
//! further connection edits and rotation. It is not wired to the web UI.

use vault_crypto::VaultSession;

use crate::LocalVaultError;
use crate::connection_edit::ConnectionProfile;
use crate::ids::EntityIdV1;
use crate::model::{
    ConnectionStatusV1, CredentialItemV1, CredentialStatusV1, ExternalRevocationAttestationV1,
    ExternalRevocationStatusV1, RotationStateV1, UtcTimestampV1, VerificationSourceV1,
};
#[cfg(test)]
use crate::persistence::create_synthetic_edited_successor_with_predecessor_and_revision_fill_v1;
use crate::persistence::{
    SyntheticCredentialSuccessorV1, create_synthetic_edited_successor_with_predecessor_v1,
    inspect_synthetic_predecessor_v1,
};
use crate::record::SealedCredentialRecordV0Alpha1;
use crate::registration::ConnectionFixture;
use crate::secret::SecretValueV1;

const CURRENT_SYNTHETIC_API_KEY: &[u8] = b"DEMO_VALUE_ONLY_API_KEY_0001";
const ROTATED_SYNTHETIC_API_KEY: &[u8] = b"DEMO_VALUE_ONLY_ROTATED_API_KEY_0002";
const ROTATION_TIMESTAMP: &str = "2026-09-16T00:00:00Z";

#[derive(Clone, Copy, Eq, PartialEq)]
/// Simulated fixture evidence only, not an authorization or provider proof.
pub enum SyntheticVerificationEvidenceV1 {
    UserConfirmed,
    ProviderVerified,
}

/// A closed selection of build-included synthetic connections and evidence.
/// No Secret, timestamp, entity ID, URL, command, or arbitrary text can enter.
pub struct SyntheticRotationCutoverSelectionV1 {
    completed: Vec<(ConnectionFixture, SyntheticVerificationEvidenceV1)>,
    superseded_revocation: SyntheticVerificationEvidenceV1,
}

impl SyntheticRotationCutoverSelectionV1 {
    /// Fixture IDs: 0 = Example MCP, 1 = Example CLI, 2 = Example CI.
    /// Each ID may appear exactly once across both completion lists.
    pub fn from_fixture_ids(
        user_confirmed: &[u32],
        provider_verified: &[u32],
        superseded_revocation: SyntheticVerificationEvidenceV1,
    ) -> Result<Self, LocalVaultError> {
        let total = user_confirmed
            .len()
            .checked_add(provider_verified.len())
            .ok_or(LocalVaultError::LimitsExceeded)?;
        if total > 3 {
            return Err(LocalVaultError::LimitsExceeded);
        }

        let mut seen = 0_u8;
        let mut completed = Vec::with_capacity(total);
        for (ids, evidence) in [
            (
                user_confirmed,
                SyntheticVerificationEvidenceV1::UserConfirmed,
            ),
            (
                provider_verified,
                SyntheticVerificationEvidenceV1::ProviderVerified,
            ),
        ] {
            for id in ids {
                let fixture = fixture_from_id(*id)?;
                let bit = fixture_bit(fixture);
                if seen & bit != 0 {
                    return Err(LocalVaultError::InvalidItem);
                }
                seen |= bit;
                completed.push((fixture, evidence));
            }
        }

        Ok(Self {
            completed,
            superseded_revocation,
        })
    }

    fn evidence_for(&self, fixture: ConnectionFixture) -> Option<SyntheticVerificationEvidenceV1> {
        self.completed
            .iter()
            .find_map(|(selected, evidence)| (*selected == fixture).then_some(*evidence))
    }
}

pub enum SyntheticRotationReadinessV1 {
    RequiredPending { remaining_required: u32 },
    Ready { remaining_optional: u32 },
}

/// Authenticates and inspects the predecessor without producing a successor or
/// consuming revision entropy.
pub fn inspect_synthetic_rotation_readiness_v1(
    session: &VaultSession,
    predecessor: &SealedCredentialRecordV0Alpha1,
    selection: &SyntheticRotationCutoverSelectionV1,
) -> Result<SyntheticRotationReadinessV1, LocalVaultError> {
    inspect_synthetic_predecessor_v1(session, predecessor, |item, _| {
        let inspection = inspect_item(item, selection)?;
        if inspection.remaining_required == 0 {
            Ok(SyntheticRotationReadinessV1::Ready {
                remaining_optional: inspection.remaining_optional,
            })
        } else {
            Ok(SyntheticRotationReadinessV1::RequiredPending {
                remaining_required: inspection.remaining_required,
            })
        }
    })
}

/// Creates a closed encrypted cutover candidate. The caller must still commit
/// its persistence projection atomically before presenting success.
/// Completed candidates cannot yet be edited or rotated again.
pub fn create_synthetic_rotation_cutover_successor_v1(
    session: &VaultSession,
    predecessor: &SealedCredentialRecordV0Alpha1,
    selection: &SyntheticRotationCutoverSelectionV1,
) -> Result<SyntheticCredentialSuccessorV1, LocalVaultError> {
    create_synthetic_edited_successor_with_predecessor_v1(
        session,
        predecessor,
        |item, predecessor_revision| apply_cutover(item, predecessor_revision, selection),
    )
}

struct RotationInspection {
    field_id: EntityIdV1,
    required_connection_ids: Vec<EntityIdV1>,
    remaining_required: u32,
    remaining_optional: u32,
}

fn inspect_item(
    item: &CredentialItemV1,
    selection: &SyntheticRotationCutoverSelectionV1,
) -> Result<RotationInspection, LocalVaultError> {
    let profile = ConnectionProfile::from_item(item)?;
    let field_id = profile.field_id();
    let mut matching_fields = item
        .secret_fields
        .iter()
        .filter(|field| field.field_id == field_id);
    let field = matching_fields.next().ok_or(LocalVaultError::InvalidItem)?;
    if matching_fields.next().is_some() || field.value.expose() != CURRENT_SYNTHETIC_API_KEY {
        return Err(LocalVaultError::InvalidItem);
    }

    let mut present = 0_u8;
    let mut selectable = 0_u8;
    let mut required_connection_ids = Vec::new();
    let mut remaining_required = 0_u32;
    let mut remaining_optional = 0_u32;

    for connection in &item.connections {
        let fixture = profile.classify(connection)?;
        let bit = fixture_bit(fixture);
        if present & bit != 0 {
            return Err(LocalVaultError::InvalidItem);
        }
        present |= bit;

        if connection.status == ConnectionStatusV1::Removed {
            continue;
        }
        selectable |= bit;
        let completed = selection.evidence_for(fixture).is_some();
        if connection.required_for_cutover {
            required_connection_ids.push(connection.connection_id);
            if !completed {
                remaining_required = remaining_required
                    .checked_add(1)
                    .ok_or(LocalVaultError::LimitsExceeded)?;
            }
        } else if !completed {
            remaining_optional = remaining_optional
                .checked_add(1)
                .ok_or(LocalVaultError::LimitsExceeded)?;
        }
    }

    for (fixture, _) in &selection.completed {
        if selectable & fixture_bit(*fixture) == 0 {
            return Err(LocalVaultError::InvalidItem);
        }
    }

    Ok(RotationInspection {
        field_id,
        required_connection_ids,
        remaining_required,
        remaining_optional,
    })
}

fn apply_cutover(
    item: &mut CredentialItemV1,
    predecessor_revision: crate::RevisionIdV1,
    selection: &SyntheticRotationCutoverSelectionV1,
) -> Result<(), LocalVaultError> {
    let inspection = inspect_item(item, selection)?;
    if inspection.remaining_required != 0 {
        return Err(LocalVaultError::InvalidItem);
    }

    let profile = ConnectionProfile::from_item(item)?;
    let field = item
        .secret_fields
        .iter_mut()
        .find(|field| field.field_id == inspection.field_id)
        .ok_or(LocalVaultError::InvalidItem)?;
    field.value = SecretValueV1::new(ROTATED_SYNTHETIC_API_KEY.to_vec())?;

    for connection in &mut item.connections {
        if connection.status != ConnectionStatusV1::Removed {
            connection.status = ConnectionStatusV1::UpdateRequired;
            connection.verification_source = VerificationSourceV1::None;
            connection.last_verified_at = None;
        }
    }
    for connection in &mut item.connections {
        if connection.status == ConnectionStatusV1::Removed {
            continue;
        }
        let fixture = profile.classify(connection)?;
        if let Some(evidence) = selection.evidence_for(fixture) {
            connection.status = ConnectionStatusV1::Verified;
            connection.verification_source = verification_source(evidence);
            connection.last_verified_at = Some(rotation_timestamp()?);
        }
    }

    item.status = CredentialStatusV1::Active;
    item.external_revocation_status = ExternalRevocationStatusV1::NotRequested;
    item.external_revocation_attestation = ExternalRevocationAttestationV1::None;
    item.revoked_at = None;
    item.updated_at = rotation_timestamp()?;

    let (revocation_status, revocation_attestation) =
        revocation_evidence(selection.superseded_revocation);
    let completed_connection_ids = inspection.required_connection_ids.clone();
    item.rotation_state = Some(RotationStateV1 {
        supersedes_revision_id: predecessor_revision,
        required_connection_ids: inspection.required_connection_ids,
        completed_connection_ids,
        superseded_external_revocation_status: revocation_status,
        superseded_external_revocation_attestation: revocation_attestation,
        superseded_revoked_at: Some(rotation_timestamp()?),
    });
    Ok(())
}

const fn fixture_from_id(id: u32) -> Result<ConnectionFixture, LocalVaultError> {
    match id {
        0 => Ok(ConnectionFixture::Mcp),
        1 => Ok(ConnectionFixture::Cli),
        2 => Ok(ConnectionFixture::Ci),
        _ => Err(LocalVaultError::InvalidItem),
    }
}

const fn fixture_bit(fixture: ConnectionFixture) -> u8 {
    match fixture {
        ConnectionFixture::Mcp => 1,
        ConnectionFixture::Cli => 2,
        ConnectionFixture::Ci => 4,
    }
}

const fn verification_source(evidence: SyntheticVerificationEvidenceV1) -> VerificationSourceV1 {
    match evidence {
        SyntheticVerificationEvidenceV1::UserConfirmed => VerificationSourceV1::User,
        SyntheticVerificationEvidenceV1::ProviderVerified => {
            VerificationSourceV1::ProviderConnector
        }
    }
}

const fn revocation_evidence(
    evidence: SyntheticVerificationEvidenceV1,
) -> (ExternalRevocationStatusV1, ExternalRevocationAttestationV1) {
    match evidence {
        SyntheticVerificationEvidenceV1::UserConfirmed => (
            ExternalRevocationStatusV1::UserConfirmed,
            ExternalRevocationAttestationV1::User,
        ),
        SyntheticVerificationEvidenceV1::ProviderVerified => (
            ExternalRevocationStatusV1::ProviderVerified,
            ExternalRevocationAttestationV1::ProviderConnector,
        ),
    }
}

fn rotation_timestamp() -> Result<UtcTimestampV1, LocalVaultError> {
    UtcTimestampV1::new(ROTATION_TIMESTAMP.to_owned())
}

#[cfg(test)]
#[path = "rotation_tests.rs"]
mod tests;
