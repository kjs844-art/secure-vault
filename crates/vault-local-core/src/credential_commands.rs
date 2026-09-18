//! Private credential commands behind the closed synthetic adapters.
//!
//! These types are not an input DTO, plaintext projection, or permission to use
//! real secrets. Password commands remain Rust-internal until a separately
//! approved public boundary and archive integration exist.

use vault_crypto::VaultSession;

use crate::LocalVaultError;
use crate::ids::{RevisionIdV1, generate_entity_id};
use crate::model::{
    CopyPolicyV1, CredentialItemV1, CredentialStatusV1, CredentialTypeV1,
    ExternalRevocationAttestationV1, ExternalRevocationStatusV1, FieldRoleV1, RevealPolicyV1,
    SecretFieldV1, SensitivityV1, TimestampProvenanceV1, UtcTimestampV1,
};
use crate::persistence::{SyntheticCredentialSuccessorV1, create_synthetic_edited_successor_v1};
use crate::record::SealedCredentialRecordV0Alpha1;
use crate::secret::SecretValueV1;

// Deliberately no Clone, Debug, serialization, or caller-selected field IDs.
pub(crate) enum CredentialDraftV1 {
    ApiKey {
        label: String,
        value: SecretValueV1,
    },
    #[allow(dead_code, reason = "Password stays private and synthetic-test-only")]
    Password {
        identifier: Option<SecretValueV1>,
        password: SecretValueV1,
    },
}

pub(crate) struct RegistrationMetadataV1 {
    pub item_name: String,
    pub provider_template_id: Option<String>,
    pub provider_name: String,
    pub console_url: Option<String>,
    pub issuer_account_identifier: Option<String>,
    pub issuer_organization_or_workspace: Option<String>,
    pub issuer_project: Option<String>,
    pub issuer_environment: Option<String>,
    pub scopes_or_permissions: Vec<String>,
    pub issued_at: Option<UtcTimestampV1>,
    pub timestamp_provenance: TimestampProvenanceV1,
    pub tags: Vec<String>,
    pub notes: Option<String>,
    pub created_at: UtcTimestampV1,
    pub updated_at: UtcTimestampV1,
}

/// Build an initial item, never a successor or a rotation event. Connections are
/// attached by the closed adapter after Rust has generated the secret-field ID.
pub(crate) fn build_registration_item_v1(
    metadata: RegistrationMetadataV1,
    credential: CredentialDraftV1,
) -> Result<CredentialItemV1, LocalVaultError> {
    if metadata.provider_name.is_empty() {
        return Err(LocalVaultError::InvalidItem);
    }
    let (credential_type, secret_fields) = match credential {
        CredentialDraftV1::ApiKey { label, value } => (
            CredentialTypeV1::ApiKey,
            vec![secret_field(
                label,
                FieldRoleV1::Secret,
                SensitivityV1::Secret,
                value,
            )?],
        ),
        CredentialDraftV1::Password {
            identifier,
            password,
        } => {
            let mut fields = Vec::with_capacity(2);
            if let Some(identifier) = identifier {
                fields.push(secret_field(
                    "USERNAME".to_owned(),
                    FieldRoleV1::Identifier,
                    SensitivityV1::PrivateMetadata,
                    identifier,
                )?);
            }
            fields.push(secret_field(
                "PASSWORD".to_owned(),
                FieldRoleV1::Secret,
                SensitivityV1::Secret,
                password,
            )?);
            (CredentialTypeV1::Password, fields)
        }
    };
    let item = CredentialItemV1 {
        item_schema_version: 1,
        parent_revision_id: None,
        item_name: metadata.item_name,
        provider_template_id: metadata.provider_template_id,
        provider_name: metadata.provider_name,
        console_url: metadata.console_url,
        // Account/project entity ownership is not inferred from display names.
        issuer_account_ref: None,
        issuer_project_ref: None,
        issuer_account_identifier: metadata.issuer_account_identifier,
        issuer_organization_or_workspace: metadata.issuer_organization_or_workspace,
        issuer_project: metadata.issuer_project,
        issuer_environment: metadata.issuer_environment,
        credential_type,
        secret_fields,
        display_hint: None,
        scopes_or_permissions: metadata.scopes_or_permissions,
        issued_at: metadata.issued_at,
        expires_at: None,
        rotate_at: None,
        timestamp_provenance: metadata.timestamp_provenance,
        status: CredentialStatusV1::Active,
        external_revocation_status: ExternalRevocationStatusV1::NotRequested,
        external_revocation_attestation: ExternalRevocationAttestationV1::None,
        revoked_at: None,
        rotation_state: None,
        connections: Vec::new(),
        tags: metadata.tags,
        notes: metadata.notes,
        created_at: metadata.created_at,
        updated_at: metadata.updated_at,
    };
    // A new item has no parent or rotation state, so model validation cannot
    // depend on the eventual revision. This sentinel is never stored or returned
    // as an identity; seal_item_v1 still generates and validates the real one.
    item.validate(RevisionIdV1::from_bytes([0; 32]))?;
    Ok(item)
}

fn secret_field(
    label: String,
    field_role: FieldRoleV1,
    sensitivity: SensitivityV1,
    value: SecretValueV1,
) -> Result<SecretFieldV1, LocalVaultError> {
    Ok(SecretFieldV1 {
        field_id: generate_entity_id()?,
        label,
        field_role,
        sensitivity,
        value,
        reveal_policy: RevealPolicyV1::RevealAfterReauth,
        copy_policy: CopyPolicyV1::AllowedAfterReauth,
    })
}

#[allow(
    dead_code,
    reason = "private metadata commands are synthetic-test-only until UI approval"
)]
pub(crate) enum OptionalMetadataTextEditV1 {
    Keep,
    Set(String),
    Clear,
}

/// The allowlist intentionally excludes secret fields, IDs, credential type,
/// provider identity, connection bindings, lifecycle state and verification.
#[allow(
    dead_code,
    reason = "private metadata commands are synthetic-test-only until UI approval"
)]
pub(crate) struct CredentialMetadataEditV1 {
    pub item_name: Option<String>,
    pub notes: OptionalMetadataTextEditV1,
    pub tags: Option<Vec<String>>,
    pub updated_at: UtcTimestampV1,
}

#[allow(
    dead_code,
    reason = "private metadata commands are synthetic-test-only until UI approval"
)]
pub(crate) fn create_credential_metadata_successor_v1(
    session: &VaultSession,
    predecessor: &SealedCredentialRecordV0Alpha1,
    edit: CredentialMetadataEditV1,
) -> Result<SyntheticCredentialSuccessorV1, LocalVaultError> {
    // Authenticates the actual envelope, validates completed rotation events,
    // and establishes the immutable parent before the canonical encode/seal.
    // A completed event remains in the predecessor, not copied as a new event.
    create_synthetic_edited_successor_v1(session, predecessor, move |item| {
        if matches!(item.status, CredentialStatusV1::Rotating) {
            return Err(LocalVaultError::InvalidItem);
        }
        if let Some(item_name) = edit.item_name {
            item.item_name = item_name;
        }
        match edit.notes {
            OptionalMetadataTextEditV1::Keep => {}
            OptionalMetadataTextEditV1::Set(notes) => item.notes = Some(notes),
            OptionalMetadataTextEditV1::Clear => item.notes = None,
        }
        if let Some(tags) = edit.tags {
            item.tags = tags;
        }
        item.updated_at = edit.updated_at;
        Ok(())
    })
}

#[cfg(test)]
#[path = "credential_commands_tests.rs"]
mod tests;
