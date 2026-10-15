//! Only build-included synthetic values; never print decoded sensitive fields.

use std::collections::BTreeSet;

use vault_crypto::{MasterPassword, create_vault_v0alpha1, unlock_vault_v0alpha1};

use super::*;
use crate::LocalVaultErrorCode;
use crate::credential_commands::{
    CredentialMetadataEditV1, OptionalMetadataTextEditV1, create_credential_metadata_successor_v1,
};
use crate::ids::{EntityIdV1, RecordIdV1, RevisionIdV1};
use crate::model::RotationStateV1;
use crate::persistence::{
    SyntheticCredentialSuccessorV1, create_synthetic_successor_v1,
    inspect_owned_synthetic_predecessor_v1,
};
use crate::record::{StoredPaddingBucketV0Alpha1, sealed_from_current_envelope};
use crate::registration::{ConnectionFixture, PROFILES, build_connection};

fn session() -> VaultSession {
    let password =
        MasterPassword::from_utf8("DEMO_VALUE_ONLY_password_adapter_master".to_owned()).unwrap();
    create_vault_v0alpha1(&password).unwrap().session
}

fn timestamp() -> UtcTimestampV1 {
    UtcTimestampV1::new(FIXTURE_TIMESTAMP.to_owned()).unwrap()
}

fn fixture() -> CredentialItemV1 {
    build_password_fixture(SyntheticPasswordFixtureIdV1::WithIdentifier).unwrap()
}

fn error_code<T>(result: Result<T, LocalVaultError>) -> LocalVaultErrorCode {
    match result {
        Ok(_) => panic!("invalid Password fixture was accepted"),
        Err(error) => error.code(),
    }
}

fn as_record(successor: &SyntheticCredentialSuccessorV1) -> SealedCredentialRecordV0Alpha1 {
    sealed_from_current_envelope(successor.persistence_projection_v1().envelope().to_vec()).unwrap()
}

fn assert_rejected_unchanged(session: &VaultSession, item: CredentialItemV1) {
    // A valid encrypted/model-validated payload is not sufficient for admission.
    let record = seal_item_v1(session, item).unwrap();
    let before = record.envelope.clone();
    assert_eq!(
        error_code(inspect_synthetic_password_record_v1(session, &record)),
        LocalVaultErrorCode::InvalidItem,
    );
    assert!(record.envelope == before);
}

#[test]
fn both_closed_password_shapes_generate_distinct_ids_and_remain_ciphertext_after_reunlock() {
    let password =
        MasterPassword::from_utf8("DEMO_VALUE_ONLY_password_reopen_master".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let mut field_ids = BTreeSet::new();
    let mut record_ids = BTreeSet::new();
    let mut revision_ids = BTreeSet::new();
    let mut records = Vec::new();
    for fixture in [
        SyntheticPasswordFixtureIdV1::PasswordOnly,
        SyntheticPasswordFixtureIdV1::WithIdentifier,
    ] {
        let record = seal_synthetic_password_fixture_v1(&created.session, fixture).unwrap();
        inspect_synthetic_password_record_v1(&created.session, &record).unwrap();
        let item =
            inspect_owned_synthetic_predecessor_v1(&created.session, &record, |item, _, _| {
                Ok(item)
            })
            .unwrap();
        assert!(item.parent_revision_id.is_none());
        assert!(item.credential_type == CredentialTypeV1::Password);
        assert!(
            item.secret_fields.len()
                == match fixture {
                    SyntheticPasswordFixtureIdV1::PasswordOnly => 1,
                    SyntheticPasswordFixtureIdV1::WithIdentifier => 2,
                }
        );
        for field in &item.secret_fields {
            assert!(field_ids.insert(*field.field_id.as_bytes()));
        }
        assert!(record_ids.insert(record.locator.record_id));
        assert!(revision_ids.insert(record.locator.revision_id));
        assert!(
            record
                .persistence_projection_v1()
                .expected_revision_id()
                .is_none()
        );
        for marker in [PASSWORD_VALUE, IDENTIFIER_VALUE, PROVIDER_NAME.as_bytes()] {
            assert!(
                !record
                    .envelope
                    .windows(marker.len())
                    .any(|part| part == marker)
            );
        }
        records.push(record);
    }
    let password_envelope = created.password_envelope;
    drop(created.session);
    let reopened = unlock_vault_v0alpha1(&password, &password_envelope).unwrap();
    for record in records {
        let before = record.envelope.clone();
        inspect_synthetic_password_record_v1(&reopened, &record).unwrap();
        assert!(record.envelope == before);
    }
}

#[test]
fn no_op_and_private_metadata_successors_preserve_closed_password_admission() {
    let session = session();
    for fixture in [
        SyntheticPasswordFixtureIdV1::PasswordOnly,
        SyntheticPasswordFixtureIdV1::WithIdentifier,
    ] {
        let root = seal_synthetic_password_fixture_v1(&session, fixture).unwrap();
        let root_before = root.envelope.clone();
        let no_op = as_record(&create_synthetic_successor_v1(&session, &root).unwrap());
        inspect_synthetic_password_record_v1(&session, &no_op).unwrap();
        let edit = CredentialMetadataEditV1 {
            item_name: Some("Example renamed Password".to_owned()),
            notes: OptionalMetadataTextEditV1::Set("Synthetic metadata edit only.".to_owned()),
            tags: Some(vec!["synthetic-edited".to_owned()]),
            updated_at: UtcTimestampV1::new("2026-09-19T00:00:00Z".to_owned()).unwrap(),
        };
        let edited =
            as_record(&create_credential_metadata_successor_v1(&session, &no_op, edit).unwrap());
        inspect_synthetic_password_record_v1(&session, &edited).unwrap();
        inspect_synthetic_predecessor_v1(&session, &edited, |item, _| {
            assert!(item.parent_revision_id == Some(no_op.locator.revision_id));
            assert!(item.item_name == "Example renamed Password");
            assert!(item.notes.as_deref() == Some("Synthetic metadata edit only."));
            assert!(item.tags == ["synthetic-edited"]);
            assert!(item.updated_at.as_str() == "2026-09-19T00:00:00Z");
            Ok(())
        })
        .unwrap();
        assert!(root.envelope == root_before);
    }
}

#[test]
fn arbitrary_password_and_identifier_values_are_rejected_even_with_demo_prefix() {
    let session = session();
    for index in [0, 1] {
        for bytes in [
            b"DEMO_VALUE_ONLY_unknown_password_or_identifier".as_slice(),
            b"SYNTHETIC_TEST_ONLY_unknown_value".as_slice(),
        ] {
            let mut item = fixture();
            item.secret_fields[index].value = SecretValueV1::new(bytes.to_vec()).unwrap();
            assert_rejected_unchanged(&session, item);
        }
    }
    let mut item = build_password_fixture(SyntheticPasswordFixtureIdV1::PasswordOnly).unwrap();
    item.secret_fields[0].value = SecretValueV1::new(IDENTIFIER_VALUE.to_vec()).unwrap();
    assert_rejected_unchanged(&session, item);
}

#[test]
fn field_shape_role_sensitivity_label_and_reauth_policies_are_not_interchangeable() {
    let session = session();
    let mutations: [fn(&mut CredentialItemV1); 13] = [
        |item| item.secret_fields.swap(0, 1),
        |item| {
            item.secret_fields.remove(1);
        },
        |item| item.secret_fields[0].label = "ALTERNATE_USERNAME".to_owned(),
        |item| item.secret_fields[1].label = "ALTERNATE_PASSWORD".to_owned(),
        |item| item.secret_fields[0].field_role = FieldRoleV1::Secret,
        |item| item.secret_fields[1].field_role = FieldRoleV1::Token,
        |item| item.secret_fields[0].sensitivity = SensitivityV1::PublicIdentifier,
        |item| item.secret_fields[1].sensitivity = SensitivityV1::PrivateMetadata,
        |item| item.secret_fields[0].reveal_policy = RevealPolicyV1::Masked,
        |item| item.secret_fields[1].reveal_policy = RevealPolicyV1::Masked,
        |item| item.secret_fields[0].copy_policy = CopyPolicyV1::Never,
        |item| item.secret_fields[1].copy_policy = CopyPolicyV1::Never,
        |item| {
            let mut extra =
                build_password_fixture(SyntheticPasswordFixtureIdV1::PasswordOnly).unwrap();
            item.secret_fields.push(extra.secret_fields.remove(0));
        },
    ];
    for modify in mutations {
        let mut item = fixture();
        modify(&mut item);
        assert_rejected_unchanged(&session, item);
    }
}

#[test]
fn unsupported_provider_issuer_and_lifecycle_metadata_fail_closed() {
    let session = session();
    let mutations: [fn(&mut CredentialItemV1); 27] = [
        |item| item.credential_type = CredentialTypeV1::ApiKey,
        |item| item.provider_template_id = None,
        |item| item.provider_template_id = Some("synthetic-other-template".to_owned()),
        |item| item.provider_name = "Example unsupported provider".to_owned(),
        |item| item.console_url = None,
        |item| item.console_url = Some("https://other.example.invalid/account".to_owned()),
        |item| item.issuer_account_ref = Some(EntityIdV1::from_bytes([1; 16])),
        |item| item.issuer_project_ref = Some(EntityIdV1::from_bytes([2; 16])),
        |item| item.issuer_account_identifier = Some("Example unknown account".to_owned()),
        |item| item.issuer_organization_or_workspace = Some("Example unknown workspace".to_owned()),
        |item| item.issuer_project = Some("Example unknown project".to_owned()),
        |item| item.issuer_environment = Some("Example unknown environment".to_owned()),
        |item| item.display_hint = Some("Example hint".to_owned()),
        |item| item.scopes_or_permissions = vec!["demo:read".to_owned()],
        |item| item.issued_at = Some(timestamp()),
        |item| item.expires_at = Some(timestamp()),
        |item| item.rotate_at = Some(timestamp()),
        |item| item.timestamp_provenance = TimestampProvenanceV1::ProviderVerified,
        |item| item.timestamp_provenance = TimestampProvenanceV1::UserEntered,
        |item| item.status = CredentialStatusV1::Rotating,
        |item| item.status = CredentialStatusV1::Revoked,
        |item| item.external_revocation_status = ExternalRevocationStatusV1::Pending,
        |item| item.external_revocation_status = ExternalRevocationStatusV1::ProviderVerified,
        |item| item.external_revocation_attestation = ExternalRevocationAttestationV1::User,
        |item| {
            item.external_revocation_attestation =
                ExternalRevocationAttestationV1::ProviderConnector
        },
        |item| item.revoked_at = Some(timestamp()),
        |item| item.created_at = UtcTimestampV1::new("2026-09-19T00:00:00Z".to_owned()).unwrap(),
    ];
    for modify in mutations {
        let mut item = fixture();
        modify(&mut item);
        assert_rejected_unchanged(&session, item);
    }
    for status in [
        CredentialStatusV1::RotationDue,
        CredentialStatusV1::Expired,
        CredentialStatusV1::Compromised,
        CredentialStatusV1::Disabled,
        CredentialStatusV1::Unknown,
    ] {
        let mut item = fixture();
        item.status = status;
        assert_rejected_unchanged(&session, item);
    }
}

#[test]
fn connections_bindings_and_even_structurally_valid_rotation_state_are_rejected() {
    let session = session();
    let mut connected = fixture();
    connected.connections.push(
        build_connection(
            &PROFILES[0],
            ConnectionFixture::Mcp,
            connected.secret_fields[1].field_id,
        )
        .unwrap(),
    );
    assert_rejected_unchanged(&session, connected);
    let mut rotated = fixture();
    let parent = RevisionIdV1::from_bytes([0x22; 32]);
    rotated.parent_revision_id = Some(parent);
    rotated.rotation_state = Some(RotationStateV1 {
        supersedes_revision_id: parent,
        required_connection_ids: Vec::new(),
        completed_connection_ids: Vec::new(),
        superseded_external_revocation_status: ExternalRevocationStatusV1::UserConfirmed,
        superseded_external_revocation_attestation: ExternalRevocationAttestationV1::User,
        superseded_revoked_at: Some(timestamp()),
    });
    assert_rejected_unchanged(&session, rotated);
}

#[test]
fn actual_envelope_is_authoritative_and_tampered_wrong_session_or_truncated_input_is_preserved() {
    let session = session();
    let mut record =
        seal_synthetic_password_fixture_v1(&session, SyntheticPasswordFixtureIdV1::WithIdentifier)
            .unwrap();
    // Locator fields are public projections, not the authenticated source.
    record.locator.record_id = RecordIdV1::from_bytes([0x31; 16]);
    record.locator.revision_id = RevisionIdV1::from_bytes([0x32; 32]);
    record.locator.key_epoch = u32::MAX;
    record.locator.padding_bucket = StoredPaddingBucketV0Alpha1::Bytes61440;
    record.vault_commitment = [0x33; 32];
    let original = record.envelope.clone();
    inspect_synthetic_password_record_v1(&session, &record).unwrap();
    let other = self::session();
    assert_eq!(
        error_code(inspect_synthetic_password_record_v1(&other, &record)),
        LocalVaultErrorCode::AuthenticationFailed,
    );
    assert!(record.envelope == original);
    let last = record.envelope.len() - 1;
    record.envelope[last] ^= 1;
    let tampered = record.envelope.clone();
    assert_eq!(
        error_code(inspect_synthetic_password_record_v1(&session, &record)),
        LocalVaultErrorCode::AuthenticationFailed,
    );
    assert!(record.envelope == tampered);
    record.envelope.truncate(12);
    let truncated = record.envelope.clone();
    assert!(inspect_synthetic_password_record_v1(&session, &record).is_err());
    assert!(record.envelope == truncated);
}
