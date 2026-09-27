//! Closed Password fixtures for mixed-credential archive integration.
//!
//! This is not a free-text registration boundary, a secret reveal API, or proof
//! of fixture origin. Authentication proves possession of the vault key, not
//! that an item was created by this factory. The classifier therefore checks
//! exact build-included sensitive bytes and the entire permitted field shape.

use vault_crypto::VaultSession;

use crate::LocalVaultError;
use crate::credential_commands::{
    CredentialDraftV1, RegistrationMetadataV1, build_registration_item_v1,
};
use crate::model::{
    CopyPolicyV1, CredentialItemV1, CredentialStatusV1, CredentialTypeV1,
    ExternalRevocationAttestationV1, ExternalRevocationStatusV1, FieldRoleV1, RevealPolicyV1,
    SecretFieldV1, SensitivityV1, TimestampProvenanceV1, UtcTimestampV1,
};
use crate::persistence::inspect_synthetic_predecessor_v1;
use crate::record::{SealedCredentialRecordV0Alpha1, seal_item_v1};
use crate::secret::SecretValueV1;

const PASSWORD_VALUE: &[u8] = b"DEMO_VALUE_ONLY_PASSWORD_FIXTURE_0001";
const IDENTIFIER_VALUE: &[u8] = b"DEMO_VALUE_ONLY_PASSWORD_IDENTIFIER_0001";
const PROVIDER_NAME: &str = "Example Password Service";
const TEMPLATE_ID: &str = "synthetic-password-v1";
const CONSOLE_URL: &str = "https://password.example.invalid/account";
const FIXTURE_TIMESTAMP: &str = "2026-09-18T00:00:00Z";

/// Two fixed examples, not a caller-controlled credential or plaintext DTO.
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum SyntheticPasswordFixtureIdV1 {
    PasswordOnly,
    WithIdentifier,
}

/// Seal one build-included Password example through the common private command.
/// Rust generates all field, record and revision IDs. No plaintext is returned;
/// the caller must durably commit the candidate before reporting success.
pub fn seal_synthetic_password_fixture_v1(
    session: &VaultSession,
    fixture: SyntheticPasswordFixtureIdV1,
) -> Result<SealedCredentialRecordV0Alpha1, LocalVaultError> {
    seal_item_v1(session, build_password_fixture(fixture)?)
}

/// Authenticate one actual envelope and enforce closed Password admission.
/// Cached locators are not authoritative. This checks neither the full parent
/// chain nor rollback freshness: archive admission must additionally validate
/// the exact chain and run this check on *every* Password ancestor.
///
/// Only item name, notes, tags and update time remain ordinary model-bounded
/// metadata, so private metadata/no-op successors can preserve their meaning.
/// They are not evidence of synthetic origin. All provider/issuer, lifecycle,
/// connection and sensitive-field data must match the closed fixture policy.
/// This does not authorize real secrets or open a public metadata input API.
pub fn inspect_synthetic_password_record_v1(
    session: &VaultSession,
    record: &SealedCredentialRecordV0Alpha1,
) -> Result<(), LocalVaultError> {
    inspect_synthetic_predecessor_v1(session, record, |item, _| validate_password_fixture(item))
}

fn build_password_fixture(
    fixture: SyntheticPasswordFixtureIdV1,
) -> Result<CredentialItemV1, LocalVaultError> {
    let (item_name, identifier) = match fixture {
        SyntheticPasswordFixtureIdV1::PasswordOnly => ("Example Password Only", None),
        SyntheticPasswordFixtureIdV1::WithIdentifier => (
            "Example Password With Identifier",
            Some(SecretValueV1::new(IDENTIFIER_VALUE.to_vec())?),
        ),
    };
    build_registration_item_v1(
        RegistrationMetadataV1 {
            item_name: item_name.to_owned(),
            provider_template_id: Some(TEMPLATE_ID.to_owned()),
            provider_name: PROVIDER_NAME.to_owned(),
            console_url: Some(CONSOLE_URL.to_owned()),
            issuer_account_identifier: None,
            issuer_organization_or_workspace: None,
            issuer_project: None,
            issuer_environment: None,
            scopes_or_permissions: Vec::new(),
            issued_at: None,
            timestamp_provenance: TimestampProvenanceV1::ImportedFixture,
            tags: vec!["synthetic-password".to_owned()],
            notes: Some("Build-included synthetic Password fixture only.".to_owned()),
            created_at: UtcTimestampV1::new(FIXTURE_TIMESTAMP.to_owned())?,
            updated_at: UtcTimestampV1::new(FIXTURE_TIMESTAMP.to_owned())?,
        },
        CredentialDraftV1::Password {
            identifier,
            password: SecretValueV1::new(PASSWORD_VALUE.to_vec())?,
        },
    )
}

fn validate_password_fixture(item: &CredentialItemV1) -> Result<(), LocalVaultError> {
    if item.credential_type != CredentialTypeV1::Password
        || item.provider_template_id.as_deref() != Some(TEMPLATE_ID)
        || item.provider_name != PROVIDER_NAME
        || item.console_url.as_deref() != Some(CONSOLE_URL)
        || item.issuer_account_ref.is_some()
        || item.issuer_project_ref.is_some()
        || item.issuer_account_identifier.is_some()
        || item.issuer_organization_or_workspace.is_some()
        || item.issuer_project.is_some()
        || item.issuer_environment.is_some()
        || item.display_hint.is_some()
        || !item.scopes_or_permissions.is_empty()
        || item.issued_at.is_some()
        || item.expires_at.is_some()
        || item.rotate_at.is_some()
        || item.timestamp_provenance != TimestampProvenanceV1::ImportedFixture
        || item.status != CredentialStatusV1::Active
        || item.external_revocation_status != ExternalRevocationStatusV1::NotRequested
        || item.external_revocation_attestation != ExternalRevocationAttestationV1::None
        || item.revoked_at.is_some()
        || item.rotation_state.is_some()
        || !item.connections.is_empty()
        || item.created_at.as_str() != FIXTURE_TIMESTAMP
    {
        return Err(LocalVaultError::InvalidItem);
    }

    // Order is deliberate: either PASSWORD, or USERNAME followed by PASSWORD.
    // No additional fields, aliases or configuration payloads are accepted.
    let password = match item.secret_fields.as_slice() {
        [password] => password,
        [identifier, password] => {
            validate_field(
                identifier,
                "USERNAME",
                FieldRoleV1::Identifier,
                SensitivityV1::PrivateMetadata,
                IDENTIFIER_VALUE,
            )?;
            password
        }
        _ => return Err(LocalVaultError::InvalidItem),
    };
    validate_field(
        password,
        "PASSWORD",
        FieldRoleV1::Secret,
        SensitivityV1::Secret,
        PASSWORD_VALUE,
    )
}

fn validate_field(
    field: &SecretFieldV1,
    label: &str,
    role: FieldRoleV1,
    sensitivity: SensitivityV1,
    value: &[u8],
) -> Result<(), LocalVaultError> {
    if field.label != label
        || field.field_role != role
        || field.sensitivity != sensitivity
        || field.value.expose() != value
        || field.reveal_policy != RevealPolicyV1::RevealAfterReauth
        || field.copy_policy != CopyPolicyV1::AllowedAfterReauth
    {
        return Err(LocalVaultError::InvalidItem);
    }
    Ok(())
}

#[cfg(test)]
#[path = "synthetic_password_tests.rs"]
mod tests;
