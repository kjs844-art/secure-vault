//! Connection-only regression checks never print decoded private values.

use vault_crypto::{MasterPassword, VaultSession, create_vault_v0alpha1};

use super::*;
use crate::codec::preservation_tests::assert_item_preserved;
use crate::codec::{DecodedItem, decode_item};
use crate::ids::RevisionIdV1;
use crate::model::*;
use crate::record::{record_context, seal_item_v1, sealed_from_current_envelope};
use crate::secret::SecretValueV1;
use crate::synthetic::build_synthetic_fixture_v1;
use crate::{
    LocalVaultErrorCode, SyntheticCredentialFixtureId, SyntheticRegistrationSelectionV1,
    seal_synthetic_fixture_v1, seal_synthetic_registration_v1,
};

fn session() -> VaultSession {
    let password = MasterPassword::from_utf8("DEMO_VALUE_ONLY_connection_edit".to_owned()).unwrap();
    create_vault_v0alpha1(&password).unwrap().session
}

fn decode(session: &VaultSession, record: &SealedCredentialRecordV0Alpha1) -> CredentialItemV1 {
    let context = record_context(
        session,
        record.locator.record_id,
        record.locator.revision_id,
        record.locator.key_epoch,
        record.locator.padding_bucket,
    )
    .unwrap();
    let plaintext =
        vault_crypto::open_record_v0alpha1(session, &context, &record.envelope).unwrap();
    match decode_item(&plaintext, record.locator.revision_id).unwrap() {
        DecodedItem::Current(item) => item,
        _ => panic!("current item required"),
    }
}

fn edit(
    session: &VaultSession,
    predecessor: &SealedCredentialRecordV0Alpha1,
    ids: &[u32],
) -> SealedCredentialRecordV0Alpha1 {
    let before = predecessor.envelope.clone();
    let selection = SyntheticConnectionSelectionV1::from_ids(ids).unwrap();
    let successor =
        create_synthetic_connection_successor_v1(session, predecessor, &selection).unwrap();
    let projection = successor.persistence_projection_v1();
    assert!(projection.record_id() == predecessor.locator.record_id);
    assert!(projection.revision_id() != predecessor.locator.revision_id);
    assert!(projection.expected_revision_id() == Some(predecessor.locator.revision_id));
    let sealed = sealed_from_current_envelope(projection.envelope().to_vec()).unwrap();
    let actual = decode(session, &sealed);
    assert!(actual.parent_revision_id == Some(predecessor.locator.revision_id));
    assert!(actual.connections.len() == ids.len());
    for (&id, connection) in ids.iter().zip(&actual.connections) {
        assert!(
            connection.consumer_type
                == match id {
                    0 => ConsumerTypeV1::McpServer,
                    1 => ConsumerTypeV1::Cli,
                    2 => ConsumerTypeV1::CiCd,
                    _ => panic!("invalid test ID"),
                }
        );
    }
    assert!(predecessor.envelope == before);
    sealed
}

fn assert_rejected(session: &VaultSession, predecessor: &SealedCredentialRecordV0Alpha1) {
    let before = predecessor.envelope.clone();
    for ids in [&[][..], &[0], &[2, 1, 0]] {
        let selection = SyntheticConnectionSelectionV1::from_ids(ids).unwrap();
        assert!(
            create_synthetic_connection_successor_v1(session, predecessor, &selection).is_err()
        );
        assert!(predecessor.envelope == before);
    }
}

#[test]
fn closed_selection_rejects_duplicates_unknown_and_excessive_ids() {
    for ids in [&[3][..], &[u32::MAX], &[0, 0], &[1, 1], &[2, 2], &[0, 1, 0]] {
        let Err(error) = SyntheticConnectionSelectionV1::from_ids(ids) else {
            panic!("invalid selection accepted");
        };
        assert_eq!(error.code(), LocalVaultErrorCode::InvalidItem);
    }
    let Err(error) = SyntheticConnectionSelectionV1::from_ids(&[0, 1, 2, 0]) else {
        panic!("oversized selection accepted");
    };
    assert_eq!(error.code(), LocalVaultErrorCode::LimitsExceeded);
}

#[test]
fn catalog_and_both_registration_profiles_support_zero_one_three_zero_and_repeated_edits() {
    let session = session();
    let mut initial = vec![
        seal_synthetic_fixture_v1(&session, SyntheticCredentialFixtureId::UnconnectedApiKey)
            .unwrap(),
    ];
    for profile in [0, 1] {
        let selection = SyntheticRegistrationSelectionV1::from_ids(profile, 0, &[]).unwrap();
        initial.push(seal_synthetic_registration_v1(&session, &selection).unwrap());
    }
    for mut record in initial {
        for ids in [&[0][..], &[2, 0, 1], &[], &[1], &[1], &[0, 2]] {
            let mut expected = decode(&session, &record);
            let next = edit(&session, &record, ids);
            let mut actual = decode(&session, &next);
            expected.parent_revision_id = actual.parent_revision_id;
            expected.connections.clear();
            actual.connections.clear();
            assert_item_preserved(&expected, &actual);
            record = next;
        }
    }
}

#[test]
fn retained_connections_keep_all_fields_and_order_new_connections_get_new_ids() {
    let session = session();
    let mut initial = Vec::new();
    for fixture in [
        SyntheticCredentialFixtureId::SingleMcpConnection,
        SyntheticCredentialFixtureId::MultipleConsumers,
    ] {
        initial.push(seal_synthetic_fixture_v1(&session, fixture).unwrap());
    }
    for profile in [0, 1] {
        let selection = SyntheticRegistrationSelectionV1::from_ids(profile, 0, &[0, 1, 2]).unwrap();
        initial.push(seal_synthetic_registration_v1(&session, &selection).unwrap());
    }
    for original in initial {
        let full = edit(&session, &original, &[0, 1, 2]);
        let mut expected = decode(&session, &full);
        let reordered = edit(&session, &full, &[2, 0, 1]);
        let actual = decode(&session, &reordered);
        expected.connections.rotate_right(1);
        expected.parent_revision_id = actual.parent_revision_id;
        assert_item_preserved(&expected, &actual);
        let old_id = actual.connections[1].connection_id;
        let removed = edit(&session, &reordered, &[2, 1]);
        let added = edit(&session, &removed, &[2, 0, 1]);
        let replacement = decode(&session, &added);
        assert!(replacement.connections[1].connection_id != old_id);
        assert!(replacement.connections[0].connection_id == actual.connections[0].connection_id);
        assert!(replacement.connections[2].connection_id == actual.connections[2].connection_id);
    }
}

#[test]
fn populated_multi_secret_item_and_retained_connection_metadata_are_preserved() {
    let session = session();
    let mut item =
        build_synthetic_fixture_v1(SyntheticCredentialFixtureId::MultipleConsumers).unwrap();
    item.item_name = "DEMO_VALUE_ONLY_custom_name".to_owned();
    item.console_url = Some("https://console.example.invalid/preserved-custom-page".to_owned());
    item.issuer_account_identifier = Some("DEMO_VALUE_ONLY_preserved_account".to_owned());
    item.issuer_organization_or_workspace = Some("DEMO_VALUE_ONLY_workspace".to_owned());
    item.issuer_project = Some("DEMO_VALUE_ONLY_preserved_project".to_owned());
    item.issuer_environment = Some("DEMO_VALUE_ONLY_preserved_environment".to_owned());
    item.notes = Some("DEMO_VALUE_ONLY_notes\n보존".to_owned());
    item.tags = vec![
        "DEMO_VALUE_ONLY_second".to_owned(),
        "DEMO_VALUE_ONLY_first".to_owned(),
    ];
    item.scopes_or_permissions = vec!["DEMO_VALUE_ONLY_read".to_owned()];
    item.display_hint = Some("DEMO_VALUE_ONLY_hint".to_owned());
    item.secret_fields[0].copy_policy = CopyPolicyV1::Never;
    item.secret_fields[1].reveal_policy = RevealPolicyV1::Masked;
    item.secret_fields[0].value =
        SecretValueV1::new(b"DEMO_VALUE_ONLY_changed_key".to_vec()).unwrap();
    item.secret_fields[1].value =
        SecretValueV1::new(b"DEMO_VALUE_ONLY_changed_token".to_vec()).unwrap();
    item.created_at = UtcTimestampV1::new("2026-08-01T01:02:03Z".to_owned()).unwrap();
    item.updated_at = UtcTimestampV1::new("2026-09-02T02:03:04Z".to_owned()).unwrap();
    item.expires_at = Some(UtcTimestampV1::new("2027-01-02T02:03:04Z".to_owned()).unwrap());
    item.rotate_at = Some(UtcTimestampV1::new("2026-12-02T02:03:04Z".to_owned()).unwrap());
    item.timestamp_provenance = TimestampProvenanceV1::UserEntered;
    item.status = CredentialStatusV1::Compromised;
    item.external_revocation_status = ExternalRevocationStatusV1::UserConfirmed;
    item.external_revocation_attestation = ExternalRevocationAttestationV1::User;
    item.revoked_at = Some(UtcTimestampV1::new("2026-09-01T02:03:04Z".to_owned()).unwrap());
    for connection in &mut item.connections {
        connection.purpose = Some("DEMO_VALUE_ONLY_populated_purpose".to_owned());
        connection.notes = Some("DEMO_VALUE_ONLY_retained_connection_notes".to_owned());
        connection.required_for_cutover = true;
        connection.status = ConnectionStatusV1::Verified;
    }
    let sealed = seal_item_v1(&session, item).unwrap();
    let mut expected = decode(&session, &sealed);
    let successor = edit(&session, &sealed, &[1, 2, 0]);
    let actual = decode(&session, &successor);
    expected.parent_revision_id = actual.parent_revision_id;
    expected.connections.rotate_left(1);
    assert_item_preserved(&expected, &actual);
    let removed = edit(&session, &successor, &[]);
    let mut restored = decode(&session, &edit(&session, &removed, &[0, 1, 2]));
    expected.parent_revision_id = restored.parent_revision_id;
    expected.connections.clear();
    restored.connections.clear();
    assert_item_preserved(&expected, &restored);
}

#[test]
fn selection_is_detached_from_input_and_wrong_session_fails_closed() {
    let session = session();
    let sealed =
        seal_synthetic_fixture_v1(&session, SyntheticCredentialFixtureId::UnconnectedApiKey)
            .unwrap();
    let mut ids = [2, 0];
    let selection = SyntheticConnectionSelectionV1::from_ids(&ids).unwrap();
    ids.fill(u32::MAX);
    let successor =
        create_synthetic_connection_successor_v1(&session, &sealed, &selection).unwrap();
    let restored =
        sealed_from_current_envelope(successor.persistence_projection_v1().envelope().to_vec())
            .unwrap();
    let item = decode(&session, &restored);
    assert!(item.connections[0].consumer_type == ConsumerTypeV1::CiCd);
    assert!(item.connections[1].consumer_type == ConsumerTypeV1::McpServer);
    let password = MasterPassword::from_utf8("DEMO_VALUE_ONLY_other_session".to_owned()).unwrap();
    let other = create_vault_v0alpha1(&password).unwrap();
    assert_rejected(&other.session, &sealed);
}

#[test]
fn tampered_and_future_predecessors_fail_without_modification() {
    let session = session();
    let mut sealed =
        seal_synthetic_fixture_v1(&session, SyntheticCredentialFixtureId::UnconnectedApiKey)
            .unwrap();
    *sealed.envelope.last_mut().unwrap() ^= 1;
    assert_rejected(&session, &sealed);
    let future = crate::record::seal_synthetic_future_inner_v2(&session).unwrap();
    assert_rejected(&session, &future);
}

#[test]
fn unsupported_semantics_and_ambiguous_connections_fail_closed_even_when_removing_all() {
    let session = session();
    for case in 0..15 {
        let mut item =
            build_synthetic_fixture_v1(SyntheticCredentialFixtureId::MultipleConsumers).unwrap();
        match case {
            0 => item.provider_name = "DEMO_VALUE_ONLY_other_provider".to_owned(),
            1 => item.connections[0].consumer_type = ConsumerTypeV1::Custom,
            2 => {
                item.connections[0]
                    .mcp_integration
                    .as_mut()
                    .unwrap()
                    .server_identifier = "DEMO_VALUE_ONLY_other_server".to_owned()
            }
            3 => {
                item.connections[0]
                    .mcp_integration
                    .as_mut()
                    .unwrap()
                    .credential_field_bindings[0]
                    .field_id = item.secret_fields[1].field_id
            }
            4 => item.connections[1].consumer_name = "Example CI".to_owned(),
            5 => {
                item.connections[2].consumer_type = ConsumerTypeV1::Cli;
                item.connections[2].consumer_name = "Example CLI".to_owned();
            }
            6 => {
                item.connections[0]
                    .mcp_integration
                    .as_mut()
                    .unwrap()
                    .package_or_executable_reference = Some("DEMO_VALUE_ONLY_command".to_owned())
            }
            7 => {
                item.connections[2].configuration_reference =
                    Some("DEMO_VALUE_ONLY_other_config".to_owned())
            }
            8 => item.secret_fields[1].label = item.secret_fields[0].label.clone(),
            9 => item.secret_fields[0].field_role = FieldRoleV1::Configuration,
            10 => {
                item.connections[0]
                    .mcp_integration
                    .as_mut()
                    .unwrap()
                    .credential_field_bindings[0]
                    .configuration_key_name = "DEMO_VALUE_ONLY_other_binding".to_owned()
            }
            11 => {
                item.connections[0]
                    .mcp_integration
                    .as_mut()
                    .unwrap()
                    .configuration_location = Some("DEMO_VALUE_ONLY_other_location".to_owned())
            }
            12 => item.connections[0]
                .mcp_integration
                .as_mut()
                .unwrap()
                .argument_template
                .push("DEMO_VALUE_ONLY_argument".to_owned()),
            13 => item.provider_template_id = Some("synthetic-cloud-lab-v1".to_owned()),
            14 => item.status = CredentialStatusV1::Rotating,
            _ => unreachable!(),
        }
        // Model-valid unsupported semantics must still be rejected by editing.
        if case == 1 {
            item.connections[0].mcp_integration = None;
        }
        let sealed = seal_item_v1(&session, item).unwrap();
        assert_rejected(&session, &sealed);
    }
}

#[test]
fn rotation_state_is_not_silently_rewritten_or_dropped() {
    let session = session();
    let mut item =
        build_synthetic_fixture_v1(SyntheticCredentialFixtureId::MultipleConsumers).unwrap();
    item.parent_revision_id = Some(RevisionIdV1::from_bytes([0x53; 32]));
    item.connections[0].required_for_cutover = true;
    item.status = CredentialStatusV1::Rotating;
    item.rotation_state = Some(RotationStateV1 {
        supersedes_revision_id: RevisionIdV1::from_bytes([0x53; 32]),
        required_connection_ids: vec![item.connections[0].connection_id],
        completed_connection_ids: vec![],
        superseded_external_revocation_status: ExternalRevocationStatusV1::NotRequested,
        superseded_external_revocation_attestation: ExternalRevocationAttestationV1::None,
        superseded_revoked_at: None,
    });
    let sealed = seal_item_v1(&session, item).unwrap();
    assert_rejected(&session, &sealed);
}

#[test]
fn malformed_authenticated_payload_and_unsupported_envelopes_fail_closed() {
    let session = session();
    let mut sealed =
        seal_synthetic_fixture_v1(&session, SyntheticCredentialFixtureId::UnconnectedApiKey)
            .unwrap();
    let context = record_context(
        &session,
        sealed.locator.record_id,
        sealed.locator.revision_id,
        sealed.locator.key_epoch,
        sealed.locator.padding_bucket,
    )
    .unwrap();
    let malformed = vault_crypto::SecretBytes::new(vec![0x80]).unwrap();
    sealed.envelope = vault_crypto::seal_record_v0alpha1(&session, &context, &malformed).unwrap();
    assert_rejected(&session, &sealed);
    for future in [true, false] {
        let mut sealed =
            seal_synthetic_fixture_v1(&session, SyntheticCredentialFixtureId::UnconnectedApiKey)
                .unwrap();
        if future {
            sealed.envelope = vec![0x81, 0x01];
        } else {
            sealed.envelope[4] ^= 0x01;
        }
        assert_rejected(&session, &sealed);
    }
}
