//! Encrypted, closed synthetic progress snapshots beside one canonical base.
//!
//! Every snapshot is a sibling of its original base, never the parent of the
//! next snapshot. Stages are not canonical cutovers or provider evidence.

use vault_crypto::VaultSession;

use crate::LocalVaultError;
use crate::codec::encode_current_item;
use crate::connection_edit::ConnectionProfile;
use crate::ids::RevisionIdV1;
use crate::model::{
    ConnectionStatusV1, CredentialItemV1, CredentialStatusV1, ExternalRevocationAttestationV1,
    ExternalRevocationStatusV1, RotationStateV1, VerificationSourceV1,
};
use crate::persistence::{
    CredentialStorageAuthenticatorV1, OwnedRehydratedCredentialOutcomeV1,
    SyntheticCredentialSuccessorV1, create_synthetic_edited_successor_with_predecessor_v1,
    inspect_owned_synthetic_predecessor_v1, synthetic_edited_successor_envelope_len_v1,
};
use crate::record::SealedCredentialRecordV0Alpha1;
use crate::registration::ConnectionFixture;
use crate::rotation::{
    SyntheticApiKeyGeneration, SyntheticRotationCutoverSelectionV1,
    SyntheticVerificationEvidenceV1, classify_synthetic_generation_v1,
    create_synthetic_rotation_cutover_successor_v1, inspect_item, revocation_evidence,
    rotation_timestamp, verification_source,
};
use crate::rotation_checklist::{
    SyntheticRotationChecklistFixtureV1, SyntheticRotationChecklistGenerationV1,
};
use crate::secret::SecretValueV1;

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum SyntheticRotationStageRevocationV1 {
    Pending,
    UserConfirmed,
    ProviderVerified,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum SyntheticRotationStageCompletionV1 {
    Pending,
    UserConfirmed,
    ProviderVerified,
}

/// Only build-included fixture identifiers and simulated evidence are accepted.
pub struct SyntheticRotationStageSelectionV1 {
    cutover: SyntheticRotationCutoverSelectionV1,
    revocation: SyntheticRotationStageRevocationV1,
}

impl SyntheticRotationStageSelectionV1 {
    pub fn from_fixture_ids(
        user_confirmed: &[u32],
        provider_verified: &[u32],
        revocation: SyntheticRotationStageRevocationV1,
    ) -> Result<Self, LocalVaultError> {
        // Pending is kept separately and never becomes final revocation evidence.
        let evidence = match revocation {
            SyntheticRotationStageRevocationV1::Pending
            | SyntheticRotationStageRevocationV1::UserConfirmed => {
                SyntheticVerificationEvidenceV1::UserConfirmed
            }
            SyntheticRotationStageRevocationV1::ProviderVerified => {
                SyntheticVerificationEvidenceV1::ProviderVerified
            }
        };
        Ok(Self {
            cutover: SyntheticRotationCutoverSelectionV1::from_fixture_ids(
                user_confirmed,
                provider_verified,
                evidence,
            )?,
            revocation,
        })
    }
}

/// Ciphertext only. Intentionally has no canonical commit projection.
///
/// ```compile_fail
/// use vault_local_core::SyntheticRotationStageV1;
/// fn cannot_commit_a_stage(stage: &SyntheticRotationStageV1) {
///     let _ = stage.persistence_projection_v1();
/// }
/// ```
pub struct SyntheticRotationStageV1 {
    envelope: Vec<u8>,
}

impl SyntheticRotationStageV1 {
    pub fn envelope(&self) -> &[u8] {
        &self.envelope
    }
}

pub struct SyntheticRotationStageEntryV1 {
    fixture: SyntheticRotationChecklistFixtureV1,
    required_for_cutover: bool,
    completion: SyntheticRotationStageCompletionV1,
}

impl SyntheticRotationStageEntryV1 {
    pub const fn fixture(&self) -> SyntheticRotationChecklistFixtureV1 {
        self.fixture
    }
    pub const fn required_for_cutover(&self) -> bool {
        self.required_for_cutover
    }
    pub const fn completion(&self) -> SyntheticRotationStageCompletionV1 {
        self.completion
    }
}

pub struct SyntheticRotationStageProjectionV1 {
    base_generation: SyntheticRotationChecklistGenerationV1,
    target_generation: SyntheticRotationChecklistGenerationV1,
    entries: Vec<SyntheticRotationStageEntryV1>,
    revocation: SyntheticRotationStageRevocationV1,
    remaining_required: u32,
    remaining_optional: u32,
}

/// Bounded ciphertext reservation only; no payload, key or revision is exposed.
pub struct SyntheticRotationStageCapacityV1 {
    ready_stage_envelope_bytes: Option<usize>,
    final_envelope_bytes: usize,
}

impl SyntheticRotationStageCapacityV1 {
    pub const fn ready_stage_envelope_bytes(&self) -> Option<usize> {
        self.ready_stage_envelope_bytes
    }

    pub const fn final_envelope_bytes(&self) -> usize {
        self.final_envelope_bytes
    }
}

impl SyntheticRotationStageProjectionV1 {
    pub const fn base_generation(&self) -> SyntheticRotationChecklistGenerationV1 {
        self.base_generation
    }
    pub const fn target_generation(&self) -> SyntheticRotationChecklistGenerationV1 {
        self.target_generation
    }
    pub fn entries(&self) -> &[SyntheticRotationStageEntryV1] {
        &self.entries
    }
    pub const fn revocation(&self) -> SyntheticRotationStageRevocationV1 {
        self.revocation
    }
    pub const fn remaining_required(&self) -> u32 {
        self.remaining_required
    }
    pub const fn remaining_optional(&self) -> u32 {
        self.remaining_optional
    }
    pub fn ready_for_cutover(&self) -> bool {
        self.remaining_required == 0
            && self.revocation != SyntheticRotationStageRevocationV1::Pending
    }
}

/// Create one encrypted sibling without changing any stored or canonical head.
pub fn create_synthetic_rotation_stage_v1(
    session: &VaultSession,
    base: &SealedCredentialRecordV0Alpha1,
    selection: &SyntheticRotationStageSelectionV1,
) -> Result<SyntheticRotationStageV1, LocalVaultError> {
    let sibling =
        create_synthetic_edited_successor_with_predecessor_v1(session, base, |item, revision| {
            apply_stage(item, revision, selection)
        })?;
    let stage = SyntheticRotationStageV1 {
        envelope: sibling.persistence_projection_v1().envelope().to_vec(),
    };
    // Authenticate the result too, including exact preservation against the base.
    inspect_synthetic_rotation_stage_v1(session, base, stage.envelope())?;
    Ok(stage)
}

/// Restore a bounded projection only after authenticating the pair and checking
/// every payload field against the exact closed transformation of its base.
pub fn inspect_synthetic_rotation_stage_v1(
    session: &VaultSession,
    base: &SealedCredentialRecordV0Alpha1,
    stage_envelope: &[u8],
) -> Result<SyntheticRotationStageProjectionV1, LocalVaultError> {
    authenticate_stage(session, base, stage_envelope).map(|(projection, _)| projection)
}

/// Authenticate the exact base/stage pair before reserving future ciphertext.
/// Pending progress reserves a ready sibling with every nonremoved fixture
/// completed, including optional fixtures, and confirmed revocation. Both
/// supported evidence sources have the same canonical one-byte enum width.
/// An already-ready stage reserves only its exact selected final sibling.
/// No entropy or candidate encryption is used to compute these lengths.
pub fn inspect_synthetic_rotation_stage_capacity_v1(
    session: &VaultSession,
    base: &SealedCredentialRecordV0Alpha1,
    stage_envelope: &[u8],
) -> Result<SyntheticRotationStageCapacityV1, LocalVaultError> {
    let (projection, selected) = authenticate_stage(session, base, stage_envelope)?;
    let ready = projection.ready_for_cutover();
    let selection = if ready {
        selected
    } else {
        let all = projection
            .entries
            .iter()
            .map(|entry| match entry.fixture {
                SyntheticRotationChecklistFixtureV1::Mcp => 0,
                SyntheticRotationChecklistFixtureV1::Cli => 1,
                SyntheticRotationChecklistFixtureV1::Ci => 2,
            })
            .collect::<Vec<_>>();
        SyntheticRotationStageSelectionV1::from_fixture_ids(
            &all,
            &[],
            SyntheticRotationStageRevocationV1::UserConfirmed,
        )?
    };
    let ready_stage_envelope_bytes = if ready {
        None
    } else {
        Some(synthetic_edited_successor_envelope_len_v1(
            session,
            base,
            |item, revision| apply_stage(item, revision, &selection),
        )?)
    };
    let final_envelope_bytes =
        synthetic_edited_successor_envelope_len_v1(session, base, |item, revision| {
            crate::rotation::apply_cutover(item, revision, &selection.cutover)
        })?;
    Ok(SyntheticRotationStageCapacityV1 {
        ready_stage_envelope_bytes,
        final_envelope_bytes,
    })
}

/// The stored stage supplies all completion choices. The returned final sibling
/// still needs the caller's ordinary expected-head CAS and durable readback.
pub fn create_synthetic_rotation_cutover_from_stage_v1(
    session: &VaultSession,
    base: &SealedCredentialRecordV0Alpha1,
    stage_envelope: &[u8],
) -> Result<SyntheticCredentialSuccessorV1, LocalVaultError> {
    let (projection, selection) = authenticate_stage(session, base, stage_envelope)?;
    if !projection.ready_for_cutover() {
        return Err(LocalVaultError::InvalidItem);
    }
    create_synthetic_rotation_cutover_successor_v1(session, base, &selection.cutover)
}

fn authenticate_stage(
    session: &VaultSession,
    base: &SealedCredentialRecordV0Alpha1,
    stage_envelope: &[u8],
) -> Result<
    (
        SyntheticRotationStageProjectionV1,
        SyntheticRotationStageSelectionV1,
    ),
    LocalVaultError,
> {
    // Bound allocation before copying caller-owned bytes.
    if stage_envelope.len() > 65_536 {
        return Err(LocalVaultError::LimitsExceeded);
    }
    let staged = match CredentialStorageAuthenticatorV1::new(session)
        .rehydrate_owned_stored_credential_v1(stage_envelope.to_vec())?
    {
        OwnedRehydratedCredentialOutcomeV1::Current(staged) => staged,
        OwnedRehydratedCredentialOutcomeV1::UpgradeRequired(_) => {
            return Err(LocalVaultError::CryptoFailure);
        }
    };
    inspect_owned_synthetic_predecessor_v1(
        session,
        base,
        |mut expected, base_record, base_revision| {
            crate::rotation_lifecycle::prepare_rotation_successor_v1(&mut expected)?;
            let base_generation = classify_synthetic_generation_v1(&expected)?;
            let target_generation = base_generation.next().ok_or(LocalVaultError::InvalidItem)?;
            inspect_owned_synthetic_predecessor_v1(
                session,
                staged.sealed_record(),
                |actual, stage_record, stage_revision| {
                    if stage_record != base_record
                        || stage_revision == base_revision
                        || actual.parent_revision_id != Some(base_revision)
                    {
                        return Err(LocalVaultError::InvalidItem);
                    }
                    let selection = recover_selection(&actual)?;
                    let inspection = inspect_item(&expected, &selection.cutover)?;
                    let profile = ConnectionProfile::from_item(&expected)?;
                    let mut entries = Vec::new();
                    for connection in &expected.connections {
                        if connection.status == ConnectionStatusV1::Removed {
                            continue;
                        }
                        let fixture = profile.classify(connection)?;
                        entries.push(SyntheticRotationStageEntryV1 {
                            fixture: project_fixture(fixture),
                            required_for_cutover: connection.required_for_cutover,
                            completion: project_completion(selection.cutover.evidence_for(fixture)),
                        });
                    }
                    apply_stage(&mut expected, base_revision, &selection)?;
                    expected.parent_revision_id = Some(base_revision);
                    let expected_bytes = encode_current_item(&expected, stage_revision)?;
                    let actual_bytes = encode_current_item(&actual, stage_revision)?;
                    // Canonical full-payload equality covers all current and future
                    // model fields automatically; both temporary buffers zeroize.
                    if expected_bytes.expose_secret() != actual_bytes.expose_secret() {
                        return Err(LocalVaultError::InvalidItem);
                    }
                    Ok((
                        SyntheticRotationStageProjectionV1 {
                            base_generation: project_generation(base_generation),
                            target_generation: project_generation(target_generation),
                            entries,
                            revocation: selection.revocation,
                            remaining_required: inspection.remaining_required,
                            remaining_optional: inspection.remaining_optional,
                        },
                        selection,
                    ))
                },
            )
        },
    )
}

fn apply_stage(
    item: &mut CredentialItemV1,
    base_revision: RevisionIdV1,
    selection: &SyntheticRotationStageSelectionV1,
) -> Result<(), LocalVaultError> {
    let inspection = inspect_item(item, &selection.cutover)?;
    if inspection.remaining_required != 0
        && selection.revocation != SyntheticRotationStageRevocationV1::Pending
    {
        return Err(LocalVaultError::InvalidItem);
    }
    let profile = ConnectionProfile::from_item(item)?;
    let field = item
        .secret_fields
        .iter_mut()
        .find(|field| field.field_id == inspection.field_id)
        .ok_or(LocalVaultError::InvalidItem)?;
    field.value = SecretValueV1::new(inspection.next_secret.to_vec())?;
    let mut completed_required = Vec::new();
    for connection in &mut item.connections {
        if connection.status == ConnectionStatusV1::Removed {
            continue;
        }
        let fixture = profile.classify(connection)?;
        match selection.cutover.evidence_for(fixture) {
            Some(evidence) => {
                connection.status = ConnectionStatusV1::Verified;
                connection.verification_source = verification_source(evidence);
                connection.last_verified_at = Some(rotation_timestamp(inspection.timestamp)?);
                if connection.required_for_cutover {
                    completed_required.push(connection.connection_id);
                }
            }
            None => {
                connection.status = ConnectionStatusV1::UpdateRequired;
                connection.verification_source = VerificationSourceV1::None;
                connection.last_verified_at = None;
            }
        }
    }
    let (status, attestation, revoked_at) = match selection.revocation {
        SyntheticRotationStageRevocationV1::Pending => (
            ExternalRevocationStatusV1::Pending,
            ExternalRevocationAttestationV1::None,
            None,
        ),
        revocation => {
            let evidence = match revocation {
                SyntheticRotationStageRevocationV1::ProviderVerified => {
                    SyntheticVerificationEvidenceV1::ProviderVerified
                }
                _ => SyntheticVerificationEvidenceV1::UserConfirmed,
            };
            let (status, attestation) = revocation_evidence(evidence);
            (
                status,
                attestation,
                Some(rotation_timestamp(inspection.timestamp)?),
            )
        }
    };
    item.status = CredentialStatusV1::Rotating;
    item.external_revocation_status = ExternalRevocationStatusV1::NotRequested;
    item.external_revocation_attestation = ExternalRevocationAttestationV1::None;
    item.revoked_at = None;
    item.updated_at = rotation_timestamp(inspection.timestamp)?;
    item.rotation_state = Some(RotationStateV1 {
        supersedes_revision_id: base_revision,
        required_connection_ids: inspection.required_connection_ids,
        completed_connection_ids: completed_required,
        superseded_external_revocation_status: status,
        superseded_external_revocation_attestation: attestation,
        superseded_revoked_at: revoked_at,
    });
    Ok(())
}

fn recover_selection(
    item: &CredentialItemV1,
) -> Result<SyntheticRotationStageSelectionV1, LocalVaultError> {
    if item.status != CredentialStatusV1::Rotating {
        return Err(LocalVaultError::InvalidItem);
    }
    let event = item
        .rotation_state
        .as_ref()
        .ok_or(LocalVaultError::InvalidItem)?;
    let revocation = match (
        event.superseded_external_revocation_status,
        event.superseded_external_revocation_attestation,
    ) {
        (ExternalRevocationStatusV1::Pending, ExternalRevocationAttestationV1::None) => {
            SyntheticRotationStageRevocationV1::Pending
        }
        (ExternalRevocationStatusV1::UserConfirmed, ExternalRevocationAttestationV1::User) => {
            SyntheticRotationStageRevocationV1::UserConfirmed
        }
        (
            ExternalRevocationStatusV1::ProviderVerified,
            ExternalRevocationAttestationV1::ProviderConnector,
        ) => SyntheticRotationStageRevocationV1::ProviderVerified,
        _ => return Err(LocalVaultError::InvalidItem),
    };
    let profile = ConnectionProfile::from_item_structure(item)?;
    let mut user = Vec::new();
    let mut provider = Vec::new();
    for connection in &item.connections {
        if connection.status == ConnectionStatusV1::Removed {
            continue;
        }
        let id = match profile.classify(connection)? {
            ConnectionFixture::Mcp => 0,
            ConnectionFixture::Cli => 1,
            ConnectionFixture::Ci => 2,
        };
        match (connection.status, connection.verification_source) {
            (ConnectionStatusV1::UpdateRequired, VerificationSourceV1::None) => {}
            (ConnectionStatusV1::Verified, VerificationSourceV1::User) => user.push(id),
            (ConnectionStatusV1::Verified, VerificationSourceV1::ProviderConnector) => {
                provider.push(id)
            }
            _ => return Err(LocalVaultError::InvalidItem),
        }
    }
    SyntheticRotationStageSelectionV1::from_fixture_ids(&user, &provider, revocation)
}

const fn project_generation(
    generation: SyntheticApiKeyGeneration,
) -> SyntheticRotationChecklistGenerationV1 {
    match generation {
        SyntheticApiKeyGeneration::Initial0001 => {
            SyntheticRotationChecklistGenerationV1::Initial0001
        }
        SyntheticApiKeyGeneration::Rotated0002 => {
            SyntheticRotationChecklistGenerationV1::Rotated0002
        }
        SyntheticApiKeyGeneration::Rotated0003 => {
            SyntheticRotationChecklistGenerationV1::Terminal0003
        }
    }
}

const fn project_fixture(fixture: ConnectionFixture) -> SyntheticRotationChecklistFixtureV1 {
    match fixture {
        ConnectionFixture::Mcp => SyntheticRotationChecklistFixtureV1::Mcp,
        ConnectionFixture::Cli => SyntheticRotationChecklistFixtureV1::Cli,
        ConnectionFixture::Ci => SyntheticRotationChecklistFixtureV1::Ci,
    }
}

const fn project_completion(
    evidence: Option<SyntheticVerificationEvidenceV1>,
) -> SyntheticRotationStageCompletionV1 {
    match evidence {
        None => SyntheticRotationStageCompletionV1::Pending,
        Some(SyntheticVerificationEvidenceV1::UserConfirmed) => {
            SyntheticRotationStageCompletionV1::UserConfirmed
        }
        Some(SyntheticVerificationEvidenceV1::ProviderVerified) => {
            SyntheticRotationStageCompletionV1::ProviderVerified
        }
    }
}

#[cfg(test)]
#[path = "rotation_staging_tests.rs"]
mod tests;
