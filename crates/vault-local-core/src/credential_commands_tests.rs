//! Private synthetic commands; assertions never print credential values.

use vault_crypto::{MasterPassword, create_vault_v0alpha1, unlock_vault_v0alpha1};

use super::*;
use crate::LocalVaultErrorCode;
use crate::codec::preservation_tests::assert_item_preserved;
use crate::ids::{EntityIdV1, RecordIdV1};
use crate::model::{ConnectionStatusV1, VerificationSourceV1};
use crate::persistence::inspect_owned_synthetic_predecessor_v1;
use crate::record::{seal_item_v1, sealed_from_current_envelope};
use crate::synthetic::build_synthetic_fixture_v1;
use crate::{
    SyntheticCredentialFixtureId, SyntheticRegistrationSelectionV1,
    SyntheticRotationCutoverSelectionV1, SyntheticRotationRecordedCompletionV1,
    SyntheticRotationStageRevocationV1, SyntheticRotationStageSelectionV1,
    SyntheticVerificationEvidenceV1, create_synthetic_rotation_cutover_successor_v1,
    create_synthetic_rotation_stage_v1, inspect_synthetic_rotation_history_v1,
    seal_synthetic_registration_v1,
};

const CREATED_AT: &str = "2026-08-14T00:00:00Z";
const UPDATED_AT: &str = "2026-09-18T00:00:00Z";
const PASSWORD: &[u8] = b"DEMO_VALUE_ONLY_private_password";
const IDENTIFIER: &[u8] = b"DEMO_VALUE_ONLY_private_identifier";

fn timestamp(value: &str) -> UtcTimestampV1 {
    UtcTimestampV1::new(value.to_owned()).unwrap()
}

fn metadata() -> RegistrationMetadataV1 {
    RegistrationMetadataV1 {
        item_name: "DEMO_VALUE_ONLY_generic_item".to_owned(),
        provider_template_id: None,
        provider_name: "DEMO_VALUE_ONLY_independent_service".to_owned(),
        console_url: Some("https://example.invalid/DEMO_VALUE_ONLY_service".to_owned()),
        issuer_account_identifier: None,
        issuer_organization_or_workspace: None,
        issuer_project: None,
        issuer_environment: None,
        scopes_or_permissions: Vec::new(),
        issued_at: None,
        timestamp_provenance: TimestampProvenanceV1::ImportedFixture,
        tags: vec!["DEMO_VALUE_ONLY_tag".to_owned()],
        notes: Some("DEMO_VALUE_ONLY_original_notes".to_owned()),
        created_at: timestamp(CREATED_AT),
        updated_at: timestamp(CREATED_AT),
    }
}

fn password_draft(with_identifier: bool) -> CredentialDraftV1 {
    CredentialDraftV1::Password {
        identifier: with_identifier.then(|| SecretValueV1::new(IDENTIFIER.to_vec()).unwrap()),
        password: SecretValueV1::new(PASSWORD.to_vec()).unwrap(),
    }
}

fn api_key_draft() -> CredentialDraftV1 {
    CredentialDraftV1::ApiKey {
        label: "DEMO_VALUE_ONLY_generic_api_field".to_owned(),
        value: SecretValueV1::new(b"DEMO_VALUE_ONLY_generic_api_value".to_vec()).unwrap(),
    }
}

fn keep_edit() -> CredentialMetadataEditV1 {
    CredentialMetadataEditV1 {
        item_name: None,
        notes: OptionalMetadataTextEditV1::Keep,
        tags: None,
        updated_at: timestamp(UPDATED_AT),
    }
}

fn session() -> VaultSession {
    let password = MasterPassword::from_utf8("DEMO_VALUE_ONLY_commands_master".to_owned()).unwrap();
    create_vault_v0alpha1(&password).unwrap().session
}

fn decode(session: &VaultSession, sealed: &SealedCredentialRecordV0Alpha1) -> CredentialItemV1 {
    inspect_owned_synthetic_predecessor_v1(session, sealed, |item, _, _| Ok(item)).unwrap()
}

fn record_from_successor(
    successor: &SyntheticCredentialSuccessorV1,
) -> SealedCredentialRecordV0Alpha1 {
    sealed_from_current_envelope(successor.persistence_projection_v1().envelope().to_vec()).unwrap()
}

fn assert_no_markers(envelope: &[u8]) {
    for marker in [PASSWORD, IDENTIFIER, b"DEMO_VALUE_ONLY_".as_slice()] {
        assert!(
            !envelope
                .windows(marker.len())
                .any(|window| window == marker)
        );
    }
}

fn assert_error<T>(result: Result<T, LocalVaultError>, code: LocalVaultErrorCode) {
    let Err(error) = result else {
        panic!("invalid private command accepted");
    };
    assert_eq!(error.code(), code);
}

#[test]
fn typed_builder_has_no_provider_fixture_dependency_and_owns_distinct_sensitive_fields() {
    let mut generated_fields = std::collections::BTreeSet::new();
    for with_identifier in [false, true] {
        let item = build_registration_item_v1(metadata(), password_draft(with_identifier)).unwrap();
        assert!(item.credential_type == CredentialTypeV1::Password);
        assert!(item.secret_fields.len() == if with_identifier { 2 } else { 1 });
        assert!(item.parent_revision_id.is_none() && item.rotation_state.is_none());
        assert!(item.connections.is_empty());
        assert!(item.issuer_account_identifier.is_none());
        for field in &item.secret_fields {
            assert!(generated_fields.insert(*field.field_id.as_bytes()));
            assert!(field.reveal_policy == RevealPolicyV1::RevealAfterReauth);
            assert!(field.copy_policy == CopyPolicyV1::AllowedAfterReauth);
        }
        let password = item.secret_fields.last().unwrap();
        assert!(password.label == "PASSWORD");
        assert!(password.field_role == FieldRoleV1::Secret);
        assert!(password.sensitivity == SensitivityV1::Secret);
        assert!(password.value.expose() == PASSWORD);
        if with_identifier {
            let identifier = &item.secret_fields[0];
            assert!(identifier.label == "USERNAME");
            assert!(identifier.field_role == FieldRoleV1::Identifier);
            assert!(identifier.sensitivity == SensitivityV1::PrivateMetadata);
            assert!(identifier.value.expose() == IDENTIFIER);
        }
    }
    let api = build_registration_item_v1(metadata(), api_key_draft()).unwrap();
    assert!(api.credential_type == CredentialTypeV1::ApiKey);
    assert!(api.secret_fields.len() == 1);
    assert!(api.secret_fields[0].label == "DEMO_VALUE_ONLY_generic_api_field");
    assert!(api.secret_fields[0].field_role == FieldRoleV1::Secret);
    assert!(api.secret_fields[0].sensitivity == SensitivityV1::Secret);
    assert!(generated_fields.insert(*api.secret_fields[0].field_id.as_bytes()));
}

#[test]
fn registration_builder_enforces_existing_utf8_and_secret_limits() {
    let mut edge = metadata();
    edge.item_name = "가".repeat(42) + "ab"; // 128 UTF-8 bytes, not 44 bytes.
    edge.provider_name = "x".repeat(256);
    edge.console_url = Some("x".repeat(2_048));
    edge.notes = Some("x".repeat(8_192));
    edge.tags = vec!["x".repeat(64); 32];
    edge.scopes_or_permissions = vec!["x".repeat(256); 64];
    let draft = CredentialDraftV1::Password {
        identifier: Some(SecretValueV1::new(vec![b'a'; 16_384]).unwrap()),
        password: SecretValueV1::new(vec![b'b'; 16_384]).unwrap(),
    };
    let edge_item = build_registration_item_v1(edge, draft).unwrap();
    // Individual model limits are not a waiver of the existing aggregate
    // canonical payload limit; the real sealing path uses this same encoder.
    assert_error(
        crate::codec::encode_current_item(&edge_item, RevisionIdV1::from_bytes([0x17; 32])),
        LocalVaultErrorCode::LimitsExceeded,
    );
    for case in 0..10 {
        let mut invalid = metadata();
        match case {
            0 => invalid.item_name.clear(),
            1 => invalid.provider_name.clear(),
            2 => invalid.item_name = "가".repeat(43),
            3 => invalid.provider_name = "x".repeat(257),
            4 => invalid.console_url = Some("x".repeat(2_049)),
            5 => invalid.notes = Some("x".repeat(8_193)),
            6 => invalid.tags = vec!["x".to_owned(); 33],
            7 => invalid.tags = vec![String::new()],
            8 => invalid.tags = vec!["x".repeat(65)],
            9 => invalid.scopes_or_permissions = vec!["x".to_owned(); 65],
            _ => unreachable!(),
        }
        assert_error(
            build_registration_item_v1(invalid, password_draft(true)),
            if matches!(case, 0 | 1 | 7) {
                LocalVaultErrorCode::InvalidItem
            } else {
                LocalVaultErrorCode::LimitsExceeded
            },
        );
    }
    let oversized = CredentialDraftV1::Password {
        identifier: Some(SecretValueV1::new(vec![b'a'; 16_385]).unwrap()),
        password: SecretValueV1::new(vec![b'b'; 16_384]).unwrap(),
    };
    assert_error(
        build_registration_item_v1(metadata(), oversized),
        LocalVaultErrorCode::LimitsExceeded,
    );
}

#[test]
fn password_encrypt_reunlock_and_metadata_successor_preserve_all_fields() {
    let password =
        MasterPassword::from_utf8("DEMO_VALUE_ONLY_commands_restart".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let mut records = Vec::new();
    for with_identifier in [false, true] {
        let item = build_registration_item_v1(metadata(), password_draft(with_identifier)).unwrap();
        let sealed = seal_item_v1(&created.session, item).unwrap();
        assert_no_markers(&sealed.envelope);
        records.push((decode(&created.session, &sealed), sealed));
    }
    let password_envelope = created.password_envelope;
    drop(created.session);
    let reopened = unlock_vault_v0alpha1(&password, &password_envelope).unwrap();
    for (mut expected, original) in records {
        let original_bytes = original.envelope.clone();
        assert_item_preserved(&expected, &decode(&reopened, &original));
        let successor = create_credential_metadata_successor_v1(
            &reopened,
            &original,
            CredentialMetadataEditV1 {
                item_name: Some("DEMO_VALUE_ONLY_edited_password_암호".to_owned()),
                notes: OptionalMetadataTextEditV1::Set(
                    "DEMO_VALUE_ONLY_edited_notes\n메모".to_owned(),
                ),
                tags: Some(vec![
                    "DEMO_VALUE_ONLY_second".to_owned(),
                    "DEMO_VALUE_ONLY_first".to_owned(),
                ]),
                updated_at: timestamp(UPDATED_AT),
            },
        )
        .unwrap();
        let projection = successor.persistence_projection_v1();
        assert!(projection.record_id() == original.locator.record_id);
        assert!(projection.revision_id() != original.locator.revision_id);
        assert!(projection.expected_revision_id() == Some(original.locator.revision_id));
        expected.parent_revision_id = Some(original.locator.revision_id);
        expected.item_name = "DEMO_VALUE_ONLY_edited_password_암호".to_owned();
        expected.notes = Some("DEMO_VALUE_ONLY_edited_notes\n메모".to_owned());
        expected.tags = vec![
            "DEMO_VALUE_ONLY_second".to_owned(),
            "DEMO_VALUE_ONLY_first".to_owned(),
        ];
        expected.updated_at = timestamp(UPDATED_AT);
        let next = record_from_successor(&successor);
        assert_item_preserved(&expected, &decode(&reopened, &next));
        assert_no_markers(&next.envelope);
        assert!(original.envelope == original_bytes);
    }
}

#[test]
fn metadata_allowlist_preserves_populated_model_bindings_policies_and_lifecycle() {
    let session = session();
    let mut item =
        build_synthetic_fixture_v1(SyntheticCredentialFixtureId::MultipleConsumers).unwrap();
    item.issuer_account_ref = Some(EntityIdV1::from_bytes([0x31; 16]));
    item.issuer_project_ref = Some(EntityIdV1::from_bytes([0x32; 16]));
    item.issuer_account_identifier = Some("DEMO_VALUE_ONLY_account".to_owned());
    item.issuer_organization_or_workspace = Some("DEMO_VALUE_ONLY_workspace".to_owned());
    item.issuer_project = Some("DEMO_VALUE_ONLY_project".to_owned());
    item.issuer_environment = Some("DEMO_VALUE_ONLY_environment".to_owned());
    item.display_hint = Some("DEMO_VALUE_ONLY_hint".to_owned());
    item.expires_at = Some(timestamp("2027-01-01T00:00:00Z"));
    item.rotate_at = Some(timestamp("2026-12-01T00:00:00Z"));
    item.timestamp_provenance = TimestampProvenanceV1::UserEntered;
    item.status = CredentialStatusV1::Compromised;
    item.external_revocation_status = ExternalRevocationStatusV1::UserConfirmed;
    item.external_revocation_attestation = ExternalRevocationAttestationV1::User;
    item.revoked_at = Some(timestamp(CREATED_AT));
    item.secret_fields[0].copy_policy = CopyPolicyV1::Never;
    item.secret_fields[1].reveal_policy = RevealPolicyV1::Masked;
    for connection in &mut item.connections {
        connection.notes = Some("DEMO_VALUE_ONLY_connection_notes".to_owned());
        connection.purpose = Some("DEMO_VALUE_ONLY_purpose".to_owned());
        connection.status = ConnectionStatusV1::Verified;
        connection.verification_source = VerificationSourceV1::ProviderConnector;
        connection.last_verified_at = Some(timestamp(CREATED_AT));
        if let Some(mcp) = &mut connection.mcp_integration {
            mcp.package_or_executable_reference = Some("DEMO_VALUE_ONLY_record_only".to_owned());
            mcp.argument_template = vec!["DEMO_VALUE_ONLY_argument".to_owned()];
            mcp.endpoint_url = Some("https://example.invalid/DEMO_VALUE_ONLY_mcp".to_owned());
        }
    }
    let sealed = seal_item_v1(&session, item).unwrap();
    let before = sealed.envelope.clone();
    let mut expected = decode(&session, &sealed);
    let successor =
        create_credential_metadata_successor_v1(&session, &sealed, keep_edit()).unwrap();
    expected.parent_revision_id = Some(sealed.locator.revision_id);
    expected.updated_at = timestamp(UPDATED_AT);
    assert_item_preserved(
        &expected,
        &decode(&session, &record_from_successor(&successor)),
    );
    assert!(sealed.envelope == before);
}

#[test]
fn notes_keep_set_empty_clear_and_utf8_metadata_limits_have_distinct_semantics() {
    let session = session();
    let mut sealed = seal_item_v1(
        &session,
        build_registration_item_v1(metadata(), password_draft(true)).unwrap(),
    )
    .unwrap();
    for case in 0..5 {
        let mut expected = decode(&session, &sealed);
        let before = sealed.envelope.clone();
        let mut edit = keep_edit();
        match case {
            0 => {}
            1 => {
                edit.notes = OptionalMetadataTextEditV1::Set(String::new());
                expected.notes = Some(String::new());
            }
            2 => {
                edit.notes = OptionalMetadataTextEditV1::Clear;
                expected.notes = None;
            }
            3 => {} // Keep None, not Some("").
            4 => {
                edit.item_name = Some("가".repeat(42) + "ab");
                expected.item_name = "가".repeat(42) + "ab";
                edit.notes = OptionalMetadataTextEditV1::Set("x".repeat(8_192));
                expected.notes = Some("x".repeat(8_192));
                edit.tags = Some(vec!["x".repeat(64); 32]);
                expected.tags = vec!["x".repeat(64); 32];
            }
            _ => unreachable!(),
        }
        if case == 2 {
            edit.tags = Some(Vec::new());
            expected.tags.clear();
        }
        let successor = create_credential_metadata_successor_v1(&session, &sealed, edit).unwrap();
        expected.parent_revision_id = Some(sealed.locator.revision_id);
        expected.updated_at = timestamp(UPDATED_AT);
        let next = record_from_successor(&successor);
        assert_item_preserved(&expected, &decode(&session, &next));
        assert!(sealed.envelope == before);
        sealed = next;
    }
}

#[test]
fn invalid_metadata_edits_return_no_candidate_and_leave_ciphertext_unchanged() {
    let session = session();
    let sealed = seal_item_v1(
        &session,
        build_registration_item_v1(metadata(), password_draft(true)).unwrap(),
    )
    .unwrap();
    let before = sealed.envelope.clone();
    for case in 0..6 {
        let mut edit = keep_edit();
        match case {
            0 => edit.item_name = Some(String::new()),
            1 => edit.item_name = Some("가".repeat(43)),
            2 => edit.notes = OptionalMetadataTextEditV1::Set("x".repeat(8_193)),
            3 => edit.tags = Some(vec!["x".to_owned(); 33]),
            4 => edit.tags = Some(vec![String::new()]),
            5 => edit.tags = Some(vec!["x".repeat(65)]),
            _ => unreachable!(),
        }
        assert_error(
            create_credential_metadata_successor_v1(&session, &sealed, edit),
            if matches!(case, 0 | 4) {
                LocalVaultErrorCode::InvalidItem
            } else {
                LocalVaultErrorCode::LimitsExceeded
            },
        );
        assert!(sealed.envelope == before);
    }
}

#[test]
fn wrong_session_tampered_and_future_envelopes_cannot_be_edited() {
    let session = session();
    let other_password =
        MasterPassword::from_utf8("DEMO_VALUE_ONLY_other_commands_master".to_owned()).unwrap();
    let other = create_vault_v0alpha1(&other_password).unwrap().session;
    let sealed = seal_item_v1(
        &session,
        build_registration_item_v1(metadata(), password_draft(true)).unwrap(),
    )
    .unwrap();
    let before = sealed.envelope.clone();
    assert!(create_credential_metadata_successor_v1(&other, &sealed, keep_edit()).is_err());
    assert!(sealed.envelope == before);
    let mut tampered = sealed_from_current_envelope(before).unwrap();
    *tampered.envelope.last_mut().unwrap() ^= 1;
    let future = crate::record::seal_synthetic_future_inner_v2(&session).unwrap();
    for invalid in [tampered, future] {
        let before = invalid.envelope.clone();
        assert!(create_credential_metadata_successor_v1(&session, &invalid, keep_edit()).is_err());
        assert!(invalid.envelope == before);
    }
}

#[test]
fn metadata_successor_uses_authenticated_identity_not_cached_locator() {
    let session = session();
    let mut sealed = seal_item_v1(
        &session,
        build_registration_item_v1(metadata(), password_draft(false)).unwrap(),
    )
    .unwrap();
    let record_id = sealed.locator.record_id;
    let revision_id = sealed.locator.revision_id;
    let before = sealed.envelope.clone();
    sealed.locator.record_id = RecordIdV1::from_bytes([0x61; 16]);
    sealed.locator.revision_id = RevisionIdV1::from_bytes([0x62; 32]);
    let successor =
        create_credential_metadata_successor_v1(&session, &sealed, keep_edit()).unwrap();
    assert!(successor.persistence_projection_v1().record_id() == record_id);
    assert!(successor.persistence_projection_v1().expected_revision_id() == Some(revision_id));
    assert!(
        decode(&session, &record_from_successor(&successor)).parent_revision_id
            == Some(revision_id)
    );
    assert!(sealed.envelope == before);
}

#[test]
fn pending_ready_stages_and_unfinished_lifecycle_cannot_be_promoted_by_metadata_edit() {
    let session = session();
    let selection = SyntheticRegistrationSelectionV1::from_ids(0, 0, &[0, 1, 2]).unwrap();
    let base = seal_synthetic_registration_v1(&session, &selection).unwrap();
    for (completed, revocation) in [
        (&[][..], SyntheticRotationStageRevocationV1::Pending),
        (
            &[0, 1, 2][..],
            SyntheticRotationStageRevocationV1::UserConfirmed,
        ),
    ] {
        let choice =
            SyntheticRotationStageSelectionV1::from_fixture_ids(completed, &[], revocation)
                .unwrap();
        let stage = create_synthetic_rotation_stage_v1(&session, &base, &choice).unwrap();
        let sealed = sealed_from_current_envelope(stage.envelope().to_vec()).unwrap();
        let before = sealed.envelope.clone();
        assert_error(
            create_credential_metadata_successor_v1(&session, &sealed, keep_edit()),
            LocalVaultErrorCode::InvalidItem,
        );
        assert!(sealed.envelope == before);
    }
    let mut item = build_registration_item_v1(metadata(), password_draft(true)).unwrap();
    item.status = CredentialStatusV1::Rotating;
    let sealed = seal_item_v1(&session, item).unwrap();
    let before = sealed.envelope.clone();
    assert_error(
        create_credential_metadata_successor_v1(&session, &sealed, keep_edit()),
        LocalVaultErrorCode::InvalidItem,
    );
    assert!(sealed.envelope == before);
}

#[test]
fn metadata_edit_keeps_completed_rotation_in_immutable_history_and_allows_next_rotation() {
    let session = session();
    let selection = SyntheticRegistrationSelectionV1::from_ids(0, 0, &[0, 1, 2]).unwrap();
    let base = seal_synthetic_registration_v1(&session, &selection).unwrap();
    let choice = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[0, 2],
        &[1],
        SyntheticVerificationEvidenceV1::UserConfirmed,
    )
    .unwrap();
    let completed = record_from_successor(
        &create_synthetic_rotation_cutover_successor_v1(&session, &base, &choice).unwrap(),
    );
    let completed_bytes = completed.envelope.clone();
    let mut expected = decode(&session, &completed);
    let mut edit = keep_edit();
    edit.notes = OptionalMetadataTextEditV1::Set("DEMO_VALUE_ONLY_post_rotation_notes".to_owned());
    let next = record_from_successor(
        &create_credential_metadata_successor_v1(&session, &completed, edit).unwrap(),
    );
    expected.parent_revision_id = Some(completed.locator.revision_id);
    expected.rotation_state = None;
    expected.notes = Some("DEMO_VALUE_ONLY_post_rotation_notes".to_owned());
    expected.updated_at = timestamp(UPDATED_AT);
    assert_item_preserved(&expected, &decode(&session, &next));
    let history =
        inspect_synthetic_rotation_history_v1(&session, &next, &[&base, &completed]).unwrap();
    assert!(history.events().len() == 1);
    assert!(history.events()[0].revision_id() == completed.locator.revision_id);
    assert!(
        history.events()[0].recorded_completion()
            == SyntheticRotationRecordedCompletionV1::Complete
    );
    let second = record_from_successor(
        &create_synthetic_rotation_cutover_successor_v1(&session, &next, &choice).unwrap(),
    );
    let history =
        inspect_synthetic_rotation_history_v1(&session, &second, &[&completed, &base, &next])
            .unwrap();
    assert!(history.events().len() == 2);
    assert!(history.events().iter().all(
        |event| event.recorded_completion() == SyntheticRotationRecordedCompletionV1::Complete
    ));
    assert!(completed.envelope == completed_bytes);
}
