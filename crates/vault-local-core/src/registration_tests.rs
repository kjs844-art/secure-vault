use std::collections::BTreeSet;

use vault_crypto::{MasterPassword, VaultSession, create_vault_v0alpha1, unlock_vault_v0alpha1};

use super::*;
use crate::LocalVaultErrorCode;
use crate::codec::preservation_tests::assert_item_preserved;
use crate::codec::{DecodedItem, decode_item};
use crate::record::record_context;

fn error_code<T>(result: Result<T, LocalVaultError>) -> LocalVaultErrorCode {
    match result {
        Ok(_) => panic!("invalid synthetic selection was accepted"),
        Err(error) => error.code(),
    }
}

#[test]
fn unknown_profile_credential_and_connection_ids_are_rejected() {
    for invalid in [2, u32::MAX] {
        assert_eq!(
            error_code(SyntheticRegistrationSelectionV1::from_ids(invalid, 0, &[])),
            LocalVaultErrorCode::InvalidItem,
        );
    }
    for invalid in [1, u32::MAX] {
        assert_eq!(
            error_code(SyntheticRegistrationSelectionV1::from_ids(0, invalid, &[])),
            LocalVaultErrorCode::InvalidItem,
        );
    }
    for invalid in [3, u32::MAX] {
        assert_eq!(
            error_code(SyntheticRegistrationSelectionV1::from_ids(0, 0, &[invalid])),
            LocalVaultErrorCode::InvalidItem,
        );
    }
}

#[test]
fn duplicate_and_excessive_connections_are_rejected() {
    for duplicate in [&[0, 0][..], &[1, 1], &[2, 2], &[0, 2, 0]] {
        assert_eq!(
            error_code(SyntheticRegistrationSelectionV1::from_ids(0, 0, duplicate)),
            LocalVaultErrorCode::InvalidItem,
        );
    }
    assert_eq!(
        error_code(SyntheticRegistrationSelectionV1::from_ids(
            0,
            0,
            &[0, 1, 2, 0]
        )),
        LocalVaultErrorCode::LimitsExceeded,
    );
}

#[test]
fn validated_selection_does_not_borrow_the_callers_connection_buffer() {
    let mut ids = [2, 0];
    let selection = SyntheticRegistrationSelectionV1::from_ids(0, 0, &ids).unwrap();
    ids.fill(u32::MAX);
    let item = build_registration(&selection).unwrap();
    assert!(item.connections.len() == 2);
    assert!(item.connections[0].consumer_type == ConsumerTypeV1::CiCd);
    assert!(item.connections[1].consumer_type == ConsumerTypeV1::McpServer);
}

fn decode_sealed(
    session: &VaultSession,
    record: &SealedCredentialRecordV0Alpha1,
) -> CredentialItemV1 {
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
        DecodedItem::UpgradeRequired { .. } => panic!("registration must use the current schema"),
    }
}

fn assert_selected_metadata(item: &CredentialItemV1, profile_id: u32, connection_ids: &[u32]) {
    let (provider, item_name, template, url, account, workspace, project, environment, server) =
        match profile_id {
            0 => (
                "Example AI Workshop",
                "Example Workshop Registered API Key",
                "synthetic-workshop-v1",
                "https://console.example.invalid/api-keys",
                "demo-account",
                "demo-workspace",
                "demo-project",
                "demo",
                "example-workshop-mcp",
            ),
            1 => (
                "Example Cloud Lab",
                "Example Cloud Lab Registered API Key",
                "synthetic-cloud-lab-v1",
                "https://console.cloud.example.invalid/api-keys",
                "lab-account",
                "lab-workspace",
                "lab-project",
                "staging",
                "example-cloud-lab-mcp",
            ),
            _ => panic!("invalid test profile"),
        };
    // Boolean-only assertions avoid printing decoded credential contents.
    assert!(item.item_schema_version == 1);
    assert!(item.parent_revision_id.is_none());
    assert!(item.provider_name == provider);
    assert!(item.item_name == item_name);
    assert!(item.provider_template_id.as_deref() == Some(template));
    assert!(item.console_url.as_deref() == Some(url));
    assert!(item.issuer_account_identifier.as_deref() == Some(account));
    assert!(item.issuer_organization_or_workspace.as_deref() == Some(workspace));
    assert!(item.issuer_project.as_deref() == Some(project));
    assert!(item.issuer_environment.as_deref() == Some(environment));
    assert!(item.issuer_account_ref.is_none());
    assert!(item.issuer_project_ref.is_none());
    assert!(item.credential_type == CredentialTypeV1::ApiKey);
    assert!(item.secret_fields.len() == 1);
    let field = &item.secret_fields[0];
    assert!(field.label == "EXAMPLE_API_KEY");
    assert!(field.field_role == FieldRoleV1::Secret);
    assert!(field.sensitivity == SensitivityV1::Secret);
    assert!(field.value.expose() == b"DEMO_VALUE_ONLY_API_KEY_0001");
    assert!(field.reveal_policy == RevealPolicyV1::RevealAfterReauth);
    assert!(field.copy_policy == CopyPolicyV1::AllowedAfterReauth);
    assert!(item.display_hint.is_none());
    assert!(item.scopes_or_permissions == ["demo:read"]);
    assert!(item.timestamp_provenance == TimestampProvenanceV1::ImportedFixture);
    assert!(item.created_at.as_str() == "2026-08-14T00:00:00Z");
    assert!(item.updated_at.as_str() == "2026-08-14T00:00:00Z");
    assert!(item.issued_at.as_ref().unwrap().as_str() == "2026-08-14T00:00:00Z");
    assert!(item.expires_at.is_none() && item.rotate_at.is_none());
    assert!(item.status == CredentialStatusV1::Active);
    assert!(item.external_revocation_status == ExternalRevocationStatusV1::NotRequested);
    assert!(item.external_revocation_attestation == ExternalRevocationAttestationV1::None);
    assert!(item.revoked_at.is_none() && item.rotation_state.is_none());
    assert!(item.tags == ["synthetic-registration"]);
    assert!(item.notes.as_deref() == Some("Build-included synthetic fixture only."));
    assert!(item.connections.len() == connection_ids.len());
    for (&connection_id, connection) in connection_ids.iter().zip(&item.connections) {
        let (name, kind) = match connection_id {
            0 => ("Example MCP", ConsumerTypeV1::McpServer),
            1 => ("Example CLI", ConsumerTypeV1::Cli),
            2 => ("Example CI", ConsumerTypeV1::CiCd),
            _ => panic!("invalid test connection"),
        };
        assert!(connection.consumer_name == name);
        assert!(connection.consumer_type == kind);
        assert!(connection.consumer_project.as_deref() == Some(project));
        assert!(connection.consumer_environment.as_deref() == Some(environment));
        assert!(connection.purpose.as_deref() == Some("Synthetic registration demonstration"));
        assert!(
            connection.configuration_reference.as_deref()
                == Some("Synthetic local settings (record only)")
        );
        assert!(connection.credential_alias_or_env_name.as_deref() == Some("EXAMPLE_API_KEY"));
        assert!(connection.required_for_cutover);
        assert!(connection.status == ConnectionStatusV1::Connected);
        assert!(connection.verification_source == VerificationSourceV1::None);
        assert!(connection.last_verified_at.is_none() && connection.notes.is_none());
        if connection_id == 0 {
            let mcp = connection.mcp_integration.as_ref().unwrap();
            assert!(mcp.transport == McpTransportV1::Stdio);
            assert!(mcp.server_identifier == server);
            assert!(mcp.execution_policy == McpExecutionPolicyV1::RecordOnly);
            assert!(mcp.package_or_executable_reference.is_none());
            assert!(mcp.argument_template.is_empty() && mcp.endpoint_url.is_none());
            assert!(mcp.configuration_location.as_deref() == Some("synthetic-mcp-settings"));
            assert!(mcp.credential_field_bindings.len() == 1);
            assert!(mcp.credential_field_bindings[0].configuration_key_name == "EXAMPLE_API_KEY");
            assert!(mcp.credential_field_bindings[0].field_id == field.field_id);
        } else {
            assert!(connection.mcp_integration.is_none());
        }
    }
}

fn assert_ciphertext_only(envelope: &[u8], item: &CredentialItemV1) {
    let mut texts = vec![
        item.item_name.as_str(),
        item.provider_name.as_str(),
        item.provider_template_id.as_deref().unwrap(),
        item.console_url.as_deref().unwrap(),
        item.issuer_account_identifier.as_deref().unwrap(),
        item.issuer_organization_or_workspace.as_deref().unwrap(),
        item.issuer_project.as_deref().unwrap(),
        item.issuer_environment.as_deref().unwrap(),
        item.notes.as_deref().unwrap(),
        item.tags[0].as_str(),
        item.scopes_or_permissions[0].as_str(),
        item.created_at.as_str(),
        "DEMO_VALUE_ONLY_API_KEY_0001",
    ];
    for connection in &item.connections {
        texts.push(connection.consumer_name.as_str());
        texts.push(connection.configuration_reference.as_deref().unwrap());
        texts.push(connection.credential_alias_or_env_name.as_deref().unwrap());
    }
    for text in texts {
        assert!(
            !envelope
                .windows(text.len())
                .any(|window| window == text.as_bytes()),
            "registered plaintext must not appear in the sealed envelope",
        );
    }
}

#[test]
fn both_profiles_with_zero_one_and_three_connections_preserve_every_field_after_reunlock() {
    let password =
        MasterPassword::from_utf8("DEMO_VALUE_ONLY_registration_password".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let mut records = Vec::new();
    let mut record_ids = BTreeSet::new();
    let mut revision_ids = BTreeSet::new();
    let mut entity_ids = BTreeSet::new();
    for profile in [0, 1] {
        for ids in [&[][..], &[0], &[2, 0, 1]] {
            let selection = SyntheticRegistrationSelectionV1::from_ids(profile, 0, ids).unwrap();
            let sealed = seal_synthetic_registration_v1(&created.session, &selection).unwrap();
            let expected = decode_sealed(&created.session, &sealed);
            assert_selected_metadata(&expected, profile, ids);
            assert_ciphertext_only(&sealed.envelope, &expected);
            assert!(record_ids.insert(sealed.locator.record_id));
            assert!(revision_ids.insert(sealed.locator.revision_id));
            assert!(entity_ids.insert(expected.secret_fields[0].field_id));
            for connection in &expected.connections {
                assert!(entity_ids.insert(connection.connection_id));
            }
            assert!(
                sealed
                    .persistence_projection_v1()
                    .expected_revision_id()
                    .is_none()
            );
            records.push((profile, ids, expected, sealed));
        }
    }
    let password_envelope = created.password_envelope;
    drop(created.session);
    let reopened = unlock_vault_v0alpha1(&password, &password_envelope).unwrap();
    for (profile, ids, expected, sealed) in records {
        let before = sealed.envelope.clone();
        let actual = decode_sealed(&reopened, &sealed);
        assert_selected_metadata(&actual, profile, ids);
        assert_item_preserved(&expected, &actual);
        assert!(
            sealed.envelope == before,
            "reopening must not change ciphertext"
        );
    }
}
