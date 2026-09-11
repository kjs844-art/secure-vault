//! Synthetic, test-only preservation checks; assertions never print payload values.

use super::{
    DecodedItem, decode_item, encode_current_item, synthetic_current_revision,
    synthetic_fully_populated_item, synthetic_valid_item,
};
use crate::LocalVaultError;
use crate::model::{
    ConnectionV1, CredentialFieldBindingV1, CredentialItemV1, McpIntegrationV1, RotationStateV1,
    SecretFieldV1, UtcTimestampV1,
};
use crate::secret::SecretValueV1;

// The exhaustive pattern intentionally has no rest pattern. Adding a model field
// requires explicitly assigning that field to a comparison here.
macro_rules! assert_fields_preserved {
    (
        $expected:expr, $actual:expr, $kind:ident {
            $($field:ident),* $(,)?
        }; handled {
            $($handled:ident),* $(,)?
        }
    ) => {
        let $kind {
            $($field: _,)*
            $($handled: _,)*
        } = $expected;
        $(
            assert!(
                ($expected).$field == ($actual).$field,
                concat!(stringify!($kind), ".", stringify!($field)),
            );
        )*
    };
}

fn assert_sequence_preserved<T: PartialEq>(expected: &[T], actual: &[T], field: &str) {
    assert!(expected.len() == actual.len(), "{field}");
    for (expected_value, actual_value) in expected.iter().zip(actual) {
        assert!(expected_value == actual_value, "{field}");
    }
}

fn assert_optional_timestamp_preserved(
    expected: &Option<UtcTimestampV1>,
    actual: &Option<UtcTimestampV1>,
    field: &str,
) {
    assert!(
        expected.as_ref().map(UtcTimestampV1::as_str)
            == actual.as_ref().map(UtcTimestampV1::as_str),
        "{field}",
    );
}

pub(crate) fn assert_item_preserved(expected: &CredentialItemV1, actual: &CredentialItemV1) {
    assert_fields_preserved!(expected, actual, CredentialItemV1 {
        item_schema_version,
        parent_revision_id,
        item_name,
        provider_template_id,
        provider_name,
        console_url,
        issuer_account_ref,
        issuer_project_ref,
        issuer_account_identifier,
        issuer_organization_or_workspace,
        issuer_project,
        issuer_environment,
        credential_type,
        display_hint,
        timestamp_provenance,
        status,
        external_revocation_status,
        external_revocation_attestation,
        notes,
    }; handled {
        secret_fields,
        scopes_or_permissions,
        issued_at,
        expires_at,
        rotate_at,
        revoked_at,
        rotation_state,
        connections,
        tags,
        created_at,
        updated_at,
    });

    assert!(
        expected.secret_fields.len() == actual.secret_fields.len(),
        "CredentialItemV1.secret_fields",
    );
    for (expected_field, actual_field) in expected.secret_fields.iter().zip(&actual.secret_fields) {
        assert_secret_field_preserved(expected_field, actual_field);
    }
    assert_sequence_preserved(
        &expected.scopes_or_permissions,
        &actual.scopes_or_permissions,
        "CredentialItemV1.scopes_or_permissions",
    );
    assert_optional_timestamp_preserved(
        &expected.issued_at,
        &actual.issued_at,
        "CredentialItemV1.issued_at",
    );
    assert_optional_timestamp_preserved(
        &expected.expires_at,
        &actual.expires_at,
        "CredentialItemV1.expires_at",
    );
    assert_optional_timestamp_preserved(
        &expected.rotate_at,
        &actual.rotate_at,
        "CredentialItemV1.rotate_at",
    );
    assert_optional_timestamp_preserved(
        &expected.revoked_at,
        &actual.revoked_at,
        "CredentialItemV1.revoked_at",
    );
    match (&expected.rotation_state, &actual.rotation_state) {
        (Some(expected_rotation), Some(actual_rotation)) => {
            assert_rotation_preserved(expected_rotation, actual_rotation);
        }
        (None, None) => {}
        _ => panic!("CredentialItemV1.rotation_state"),
    }
    assert!(
        expected.connections.len() == actual.connections.len(),
        "CredentialItemV1.connections",
    );
    for (expected_connection, actual_connection) in
        expected.connections.iter().zip(&actual.connections)
    {
        assert_connection_preserved(expected_connection, actual_connection);
    }
    assert_sequence_preserved(&expected.tags, &actual.tags, "CredentialItemV1.tags");
    assert!(
        expected.created_at.as_str() == actual.created_at.as_str(),
        "CredentialItemV1.created_at",
    );
    assert!(
        expected.updated_at.as_str() == actual.updated_at.as_str(),
        "CredentialItemV1.updated_at",
    );
}

fn assert_secret_field_preserved(expected: &SecretFieldV1, actual: &SecretFieldV1) {
    assert_fields_preserved!(expected, actual, SecretFieldV1 {
        field_id,
        label,
        field_role,
        sensitivity,
        reveal_policy,
        copy_policy,
    }; handled { value });
    assert!(
        expected.value.expose() == actual.value.expose(),
        "SecretFieldV1.value",
    );
}

fn assert_connection_preserved(expected: &ConnectionV1, actual: &ConnectionV1) {
    assert_fields_preserved!(expected, actual, ConnectionV1 {
        connection_id,
        consumer_type,
        consumer_name,
        consumer_project,
        consumer_environment,
        purpose,
        configuration_reference,
        credential_alias_or_env_name,
        required_for_cutover,
        status,
        verification_source,
        notes,
    }; handled { last_verified_at, mcp_integration });
    assert_optional_timestamp_preserved(
        &expected.last_verified_at,
        &actual.last_verified_at,
        "ConnectionV1.last_verified_at",
    );
    match (&expected.mcp_integration, &actual.mcp_integration) {
        (Some(expected_mcp), Some(actual_mcp)) => {
            assert_mcp_preserved(expected_mcp, actual_mcp);
        }
        (None, None) => {}
        _ => panic!("ConnectionV1.mcp_integration"),
    }
}

fn assert_mcp_preserved(expected: &McpIntegrationV1, actual: &McpIntegrationV1) {
    assert_fields_preserved!(expected, actual, McpIntegrationV1 {
        transport,
        server_identifier,
        package_or_executable_reference,
        endpoint_url,
        configuration_location,
        execution_policy,
    }; handled { argument_template, credential_field_bindings });
    assert_sequence_preserved(
        &expected.argument_template,
        &actual.argument_template,
        "McpIntegrationV1.argument_template",
    );
    assert!(
        expected.credential_field_bindings.len() == actual.credential_field_bindings.len(),
        "McpIntegrationV1.credential_field_bindings",
    );
    for (expected_binding, actual_binding) in expected
        .credential_field_bindings
        .iter()
        .zip(&actual.credential_field_bindings)
    {
        assert_fields_preserved!(expected_binding, actual_binding, CredentialFieldBindingV1 {
            configuration_key_name,
            field_id,
        }; handled {});
    }
}

fn assert_rotation_preserved(expected: &RotationStateV1, actual: &RotationStateV1) {
    assert_fields_preserved!(expected, actual, RotationStateV1 {
        supersedes_revision_id,
        superseded_external_revocation_status,
        superseded_external_revocation_attestation,
    }; handled {
        required_connection_ids,
        completed_connection_ids,
        superseded_revoked_at,
    });
    assert_sequence_preserved(
        &expected.required_connection_ids,
        &actual.required_connection_ids,
        "RotationStateV1.required_connection_ids",
    );
    assert_sequence_preserved(
        &expected.completed_connection_ids,
        &actual.completed_connection_ids,
        "RotationStateV1.completed_connection_ids",
    );
    assert_optional_timestamp_preserved(
        &expected.superseded_revoked_at,
        &actual.superseded_revoked_at,
        "RotationStateV1.superseded_revoked_at",
    );
}

fn synthetic_preservation_item() -> Result<CredentialItemV1, LocalVaultError> {
    let mut item = synthetic_fully_populated_item()?;
    item.item_name = "DEMO_VALUE_ONLY_보존_🔐".to_owned();
    item.notes = Some("DEMO_VALUE_ONLY_첫째 줄\nDEMO_VALUE_ONLY_둘째 줄 🧪".to_owned());
    item.secret_fields[0].value = SecretValueV1::new(b"DEMO_VALUE_ONLY_primary_secret".to_vec())?;
    item.secret_fields[1].value = SecretValueV1::new(b"DEMO_VALUE_ONLY_secondary_token".to_vec())?;
    item.created_at = UtcTimestampV1::new("2026-09-01T00:00:00Z".to_owned())?;
    item.issued_at = Some(UtcTimestampV1::new("2026-09-02T01:02:03Z".to_owned())?);
    item.connections[0].last_verified_at =
        Some(UtcTimestampV1::new("2026-09-03T02:03:04Z".to_owned())?);
    item.connections[1].last_verified_at =
        Some(UtcTimestampV1::new("2026-09-04T03:04:05Z".to_owned())?);
    item.rotation_state
        .as_mut()
        .ok_or(LocalVaultError::InvalidItem)?
        .superseded_revoked_at = Some(UtcTimestampV1::new("2026-09-05T04:05:06Z".to_owned())?);
    item.revoked_at = Some(UtcTimestampV1::new("2026-09-06T05:06:07Z".to_owned())?);
    item.updated_at = UtcTimestampV1::new("2026-09-07T06:07:08Z".to_owned())?;
    item.rotate_at = Some(UtcTimestampV1::new("2026-10-01T07:08:09Z".to_owned())?);
    item.expires_at = Some(UtcTimestampV1::new("2026-12-01T08:09:10Z".to_owned())?);
    item.connections[0].consumer_name = "DEMO_VALUE_ONLY_앱_소비자".to_owned();
    item.connections[1].consumer_name = "DEMO_VALUE_ONLY_MCP_소비자".to_owned();
    item.connections[0].notes = Some("DEMO_VALUE_ONLY_앱 메모\nDEMO_VALUE_ONLY_확인 🔐".to_owned());
    item.connections[1].notes = Some("DEMO_VALUE_ONLY_MCP 메모 🧪".to_owned());
    Ok(item)
}

fn roundtrip_item(expected: &CredentialItemV1) -> CredentialItemV1 {
    let revision = synthetic_current_revision();
    let encoded = encode_current_item(expected, revision)
        .unwrap_or_else(|_| panic!("CredentialItemV1.encode"));
    match decode_item(&encoded, revision).unwrap_or_else(|_| panic!("CredentialItemV1.decode")) {
        DecodedItem::Current(actual) => actual,
        DecodedItem::UpgradeRequired { .. } => panic!("CredentialItemV1.item_schema_version"),
    }
}

#[test]
fn full_synthetic_codec_roundtrip_preserves_every_field() {
    let expected = synthetic_preservation_item()
        .unwrap_or_else(|_| panic!("CredentialItemV1.synthetic_fixture"));
    let actual = roundtrip_item(&expected);
    assert_item_preserved(&expected, &actual);
}

#[test]
fn minimal_synthetic_codec_roundtrip_preserves_absence_and_empty_arrays() {
    let mut expected =
        synthetic_valid_item().unwrap_or_else(|_| panic!("CredentialItemV1.synthetic_fixture"));
    expected.notes = None;
    let actual = roundtrip_item(&expected);
    assert_item_preserved(&expected, &actual);
}

// These negative controls check the comparison oracle after a successful
// roundtrip. They do not reproduce a product defect or modify encoded data.
#[test]
#[should_panic(expected = "SecretFieldV1.value")]
fn preservation_oracle_detects_swapped_synthetic_secret_values() {
    let expected = synthetic_preservation_item()
        .unwrap_or_else(|_| panic!("CredentialItemV1.synthetic_fixture"));
    let mut actual = roundtrip_item(&expected);
    let (first, remaining) = actual.secret_fields.split_at_mut(1);
    std::mem::swap(&mut first[0].value, &mut remaining[0].value);
    assert_item_preserved(&expected, &actual);
}

#[test]
#[should_panic(expected = "CredentialItemV1.issued_at")]
fn preservation_oracle_detects_swapped_synthetic_timestamps() {
    let expected = synthetic_preservation_item()
        .unwrap_or_else(|_| panic!("CredentialItemV1.synthetic_fixture"));
    let mut actual = roundtrip_item(&expected);
    std::mem::swap(&mut actual.issued_at, &mut actual.expires_at);
    assert_item_preserved(&expected, &actual);
}

#[test]
#[should_panic(expected = "CredentialFieldBindingV1.field_id")]
fn preservation_oracle_detects_changed_synthetic_binding_target() {
    let expected = synthetic_preservation_item()
        .unwrap_or_else(|_| panic!("CredentialItemV1.synthetic_fixture"));
    let mut actual = roundtrip_item(&expected);
    let integration = actual.connections[1]
        .mcp_integration
        .as_mut()
        .unwrap_or_else(|| panic!("ConnectionV1.mcp_integration"));
    integration.credential_field_bindings[0].field_id = expected.secret_fields[1].field_id;
    assert_item_preserved(&expected, &actual);
}
