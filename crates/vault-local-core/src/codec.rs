#![allow(
    dead_code,
    reason = "the crate-private codec boundary is consumed by the next record-bridge task"
)]

use core::convert::Infallible;

use minicbor::{Decoder, Encoder, data::Type, encode::Write};
use zeroize::Zeroize;

use crate::LocalVaultError;
use crate::ids::{EntityIdV1, RevisionIdV1};
use crate::model::{
    ConnectionStatusV1, ConnectionV1, ConsumerTypeV1, CopyPolicyV1, CredentialFieldBindingV1,
    CredentialItemV1, CredentialStatusV1, CredentialTypeV1, ExternalRevocationAttestationV1,
    ExternalRevocationStatusV1, FieldRoleV1, McpExecutionPolicyV1, McpIntegrationV1,
    McpTransportV1, RevealPolicyV1, RotationStateV1, SecretFieldV1, SensitivityV1,
    TimestampProvenanceV1, UtcTimestampV1, VerificationSourceV1,
};
use crate::secret::SecretValueV1;

const ITEM_SCHEMA_VERSION: u64 = 1;
const ITEM_FIELD_COUNT: u64 = 30;
const SECRET_FIELD_COUNT: u64 = 7;
const CONNECTION_FIELD_COUNT: u64 = 14;
const MCP_FIELD_COUNT: u64 = 8;
const BINDING_FIELD_COUNT: u64 = 2;
const ROTATION_FIELD_COUNT: u64 = 6;
const MAX_PAYLOAD_BYTES: usize = 60_000;

const MAX_SECRET_FIELDS: u64 = 16;
const MAX_CONNECTIONS: u64 = 128;
const MAX_SCOPES: u64 = 64;
const MAX_TAGS: u64 = 32;
const MAX_MCP_ARGUMENTS: u64 = 32;
const MAX_MCP_BINDINGS: u64 = 16;
const MAX_ROTATION_CONNECTION_IDS: u64 = 128;

#[allow(
    clippy::large_enum_variant,
    reason = "the planned crate-private boundary returns the owned current model without indirection"
)]
pub(crate) enum DecodedItem {
    Current(CredentialItemV1),
    UpgradeRequired { version: u64 },
}

pub(crate) fn encode_current_item(
    item: &CredentialItemV1,
    current_revision: RevisionIdV1,
) -> Result<vault_crypto::SecretBytes, LocalVaultError> {
    item.validate(current_revision)?;
    let mut encoded = encode_item_into(Vec::with_capacity(4_096), item)?;
    if let Err(error) = reject_if_over_product_limit(&encoded) {
        encoded.zeroize();
        return Err(error);
    }
    vault_crypto::SecretBytes::new(encoded).map_err(map_secret_bytes_error)
}

pub(crate) fn decode_item(
    plaintext: &vault_crypto::SecretBytes,
    current_revision: RevisionIdV1,
) -> Result<DecodedItem, LocalVaultError> {
    let input = plaintext.expose_secret();
    reject_if_over_product_limit(input)?;

    let mut decoder = Decoder::new(input);
    let field_count = decoder
        .array()
        .map_err(decode_error)?
        .ok_or(LocalVaultError::NonCanonicalEncoding)?;
    if field_count == 0 {
        return Err(LocalVaultError::NonCanonicalEncoding);
    }
    let version = decoder.u64().map_err(decode_error)?;

    if version == 0 {
        return Err(LocalVaultError::InvalidItem);
    }
    if version > ITEM_SCHEMA_VERSION {
        return Ok(DecodedItem::UpgradeRequired { version });
    }
    if field_count != ITEM_FIELD_COUNT {
        return Err(LocalVaultError::NonCanonicalEncoding);
    }

    let item = decode_current_item_fields(&mut decoder, version)?;
    if decoder.position() != input.len() {
        return Err(LocalVaultError::NonCanonicalEncoding);
    }

    item.validate(current_revision)?;
    let comparator = encode_item_into(CanonicalComparator::new(input), &item)?;
    if !comparator.is_exact_match() {
        return Err(LocalVaultError::NonCanonicalEncoding);
    }

    Ok(DecodedItem::Current(item))
}

fn encode_item_into<W: Write>(writer: W, item: &CredentialItemV1) -> Result<W, LocalVaultError> {
    let mut encoder = Encoder::new(writer);
    encoder.array(ITEM_FIELD_COUNT).map_err(encode_error)?;
    encoder
        .u64(item.item_schema_version)
        .map_err(encode_error)?;
    encode_optional_revision(&mut encoder, item.parent_revision_id)?;
    encoder.str(&item.item_name).map_err(encode_error)?;
    encode_optional_text(&mut encoder, item.provider_template_id.as_deref())?;
    encoder.str(&item.provider_name).map_err(encode_error)?;
    encode_optional_text(&mut encoder, item.console_url.as_deref())?;
    encode_optional_entity(&mut encoder, item.issuer_account_ref)?;
    encode_optional_entity(&mut encoder, item.issuer_project_ref)?;
    encode_optional_text(&mut encoder, item.issuer_account_identifier.as_deref())?;
    encode_optional_text(
        &mut encoder,
        item.issuer_organization_or_workspace.as_deref(),
    )?;
    encode_optional_text(&mut encoder, item.issuer_project.as_deref())?;
    encode_optional_text(&mut encoder, item.issuer_environment.as_deref())?;
    encoder
        .u64(item.credential_type as u64)
        .map_err(encode_error)?;
    encode_secret_fields(&mut encoder, &item.secret_fields)?;
    encode_optional_text(&mut encoder, item.display_hint.as_deref())?;
    encode_text_array(&mut encoder, &item.scopes_or_permissions)?;
    encode_optional_timestamp(&mut encoder, item.issued_at.as_ref())?;
    encode_optional_timestamp(&mut encoder, item.expires_at.as_ref())?;
    encode_optional_timestamp(&mut encoder, item.rotate_at.as_ref())?;
    encoder
        .u64(item.timestamp_provenance as u64)
        .map_err(encode_error)?;
    encoder.u64(item.status as u64).map_err(encode_error)?;
    encoder
        .u64(item.external_revocation_status as u64)
        .map_err(encode_error)?;
    encoder
        .u64(item.external_revocation_attestation as u64)
        .map_err(encode_error)?;
    encode_optional_timestamp(&mut encoder, item.revoked_at.as_ref())?;
    encode_optional_rotation(&mut encoder, item.rotation_state.as_ref())?;
    encode_connections(&mut encoder, &item.connections)?;
    encode_text_array(&mut encoder, &item.tags)?;
    encode_optional_text(&mut encoder, item.notes.as_deref())?;
    encoder
        .str(item.created_at.as_str())
        .map_err(encode_error)?;
    encoder
        .str(item.updated_at.as_str())
        .map_err(encode_error)?;
    Ok(encoder.into_writer())
}

fn encode_optional_revision<W: Write>(
    encoder: &mut Encoder<W>,
    value: Option<RevisionIdV1>,
) -> Result<(), LocalVaultError> {
    match value {
        Some(id) => {
            encoder.bytes(id.as_bytes()).map_err(encode_error)?;
        }
        None => {
            encoder.null().map_err(encode_error)?;
        }
    }
    Ok(())
}

fn encode_optional_entity<W: Write>(
    encoder: &mut Encoder<W>,
    value: Option<EntityIdV1>,
) -> Result<(), LocalVaultError> {
    match value {
        Some(id) => {
            encoder.bytes(id.as_bytes()).map_err(encode_error)?;
        }
        None => {
            encoder.null().map_err(encode_error)?;
        }
    }
    Ok(())
}

fn encode_optional_text<W: Write>(
    encoder: &mut Encoder<W>,
    value: Option<&str>,
) -> Result<(), LocalVaultError> {
    match value {
        Some(text) => {
            encoder.str(text).map_err(encode_error)?;
        }
        None => {
            encoder.null().map_err(encode_error)?;
        }
    }
    Ok(())
}

fn encode_optional_timestamp<W: Write>(
    encoder: &mut Encoder<W>,
    value: Option<&UtcTimestampV1>,
) -> Result<(), LocalVaultError> {
    match value {
        Some(timestamp) => {
            encoder.str(timestamp.as_str()).map_err(encode_error)?;
        }
        None => {
            encoder.null().map_err(encode_error)?;
        }
    }
    Ok(())
}

fn encode_text_array<W: Write>(
    encoder: &mut Encoder<W>,
    values: &[String],
) -> Result<(), LocalVaultError> {
    encoder
        .array(length_as_u64(values.len())?)
        .map_err(encode_error)?;
    for value in values {
        encoder.str(value).map_err(encode_error)?;
    }
    Ok(())
}

fn encode_secret_fields<W: Write>(
    encoder: &mut Encoder<W>,
    fields: &[SecretFieldV1],
) -> Result<(), LocalVaultError> {
    encoder
        .array(length_as_u64(fields.len())?)
        .map_err(encode_error)?;
    for field in fields {
        encoder.array(SECRET_FIELD_COUNT).map_err(encode_error)?;
        encoder
            .bytes(field.field_id.as_bytes())
            .map_err(encode_error)?;
        encoder.str(&field.label).map_err(encode_error)?;
        encoder.u64(field.field_role as u64).map_err(encode_error)?;
        encoder
            .u64(field.sensitivity as u64)
            .map_err(encode_error)?;
        encoder.bytes(field.value.expose()).map_err(encode_error)?;
        encoder
            .u64(field.reveal_policy as u64)
            .map_err(encode_error)?;
        encoder
            .u64(field.copy_policy as u64)
            .map_err(encode_error)?;
    }
    Ok(())
}

fn encode_connections<W: Write>(
    encoder: &mut Encoder<W>,
    connections: &[ConnectionV1],
) -> Result<(), LocalVaultError> {
    encoder
        .array(length_as_u64(connections.len())?)
        .map_err(encode_error)?;
    for connection in connections {
        encoder
            .array(CONNECTION_FIELD_COUNT)
            .map_err(encode_error)?;
        encoder
            .bytes(connection.connection_id.as_bytes())
            .map_err(encode_error)?;
        encoder
            .u64(connection.consumer_type as u64)
            .map_err(encode_error)?;
        encoder
            .str(&connection.consumer_name)
            .map_err(encode_error)?;
        encode_optional_text(&mut *encoder, connection.consumer_project.as_deref())?;
        encode_optional_text(&mut *encoder, connection.consumer_environment.as_deref())?;
        encode_optional_text(&mut *encoder, connection.purpose.as_deref())?;
        encode_optional_text(&mut *encoder, connection.configuration_reference.as_deref())?;
        encode_optional_text(
            &mut *encoder,
            connection.credential_alias_or_env_name.as_deref(),
        )?;
        encoder
            .bool(connection.required_for_cutover)
            .map_err(encode_error)?;
        encoder
            .u64(connection.status as u64)
            .map_err(encode_error)?;
        encoder
            .u64(connection.verification_source as u64)
            .map_err(encode_error)?;
        encode_optional_timestamp(&mut *encoder, connection.last_verified_at.as_ref())?;
        encode_optional_text(&mut *encoder, connection.notes.as_deref())?;
        encode_optional_mcp(&mut *encoder, connection.mcp_integration.as_ref())?;
    }
    Ok(())
}

fn encode_optional_mcp<W: Write>(
    encoder: &mut Encoder<W>,
    integration: Option<&McpIntegrationV1>,
) -> Result<(), LocalVaultError> {
    let Some(integration) = integration else {
        encoder.null().map_err(encode_error)?;
        return Ok(());
    };

    encoder.array(MCP_FIELD_COUNT).map_err(encode_error)?;
    encoder
        .u64(integration.transport as u64)
        .map_err(encode_error)?;
    encoder
        .str(&integration.server_identifier)
        .map_err(encode_error)?;
    encode_optional_text(
        &mut *encoder,
        integration.package_or_executable_reference.as_deref(),
    )?;
    encode_text_array(&mut *encoder, &integration.argument_template)?;
    encode_optional_text(&mut *encoder, integration.endpoint_url.as_deref())?;
    encoder
        .array(length_as_u64(integration.credential_field_bindings.len())?)
        .map_err(encode_error)?;
    for binding in &integration.credential_field_bindings {
        encoder.array(BINDING_FIELD_COUNT).map_err(encode_error)?;
        encoder
            .str(&binding.configuration_key_name)
            .map_err(encode_error)?;
        encoder
            .bytes(binding.field_id.as_bytes())
            .map_err(encode_error)?;
    }
    encode_optional_text(&mut *encoder, integration.configuration_location.as_deref())?;
    encoder
        .u64(integration.execution_policy as u64)
        .map_err(encode_error)?;
    Ok(())
}

fn encode_optional_rotation<W: Write>(
    encoder: &mut Encoder<W>,
    rotation: Option<&RotationStateV1>,
) -> Result<(), LocalVaultError> {
    let Some(rotation) = rotation else {
        encoder.null().map_err(encode_error)?;
        return Ok(());
    };

    encoder.array(ROTATION_FIELD_COUNT).map_err(encode_error)?;
    encoder
        .bytes(rotation.supersedes_revision_id.as_bytes())
        .map_err(encode_error)?;
    encode_entity_array(&mut *encoder, &rotation.required_connection_ids)?;
    encode_entity_array(&mut *encoder, &rotation.completed_connection_ids)?;
    encoder
        .u64(rotation.superseded_external_revocation_status as u64)
        .map_err(encode_error)?;
    encoder
        .u64(rotation.superseded_external_revocation_attestation as u64)
        .map_err(encode_error)?;
    encode_optional_timestamp(&mut *encoder, rotation.superseded_revoked_at.as_ref())?;
    Ok(())
}

fn encode_entity_array<W: Write>(
    encoder: &mut Encoder<W>,
    ids: &[EntityIdV1],
) -> Result<(), LocalVaultError> {
    encoder
        .array(length_as_u64(ids.len())?)
        .map_err(encode_error)?;
    for id in ids {
        encoder.bytes(id.as_bytes()).map_err(encode_error)?;
    }
    Ok(())
}

fn decode_current_item_fields(
    decoder: &mut Decoder<'_>,
    version: u64,
) -> Result<CredentialItemV1, LocalVaultError> {
    Ok(CredentialItemV1 {
        item_schema_version: version,
        parent_revision_id: decode_optional_revision(decoder)?,
        item_name: decode_text(decoder)?,
        provider_template_id: decode_optional_text(decoder)?,
        provider_name: decode_text(decoder)?,
        console_url: decode_optional_text(decoder)?,
        issuer_account_ref: decode_optional_entity(decoder)?,
        issuer_project_ref: decode_optional_entity(decoder)?,
        issuer_account_identifier: decode_optional_text(decoder)?,
        issuer_organization_or_workspace: decode_optional_text(decoder)?,
        issuer_project: decode_optional_text(decoder)?,
        issuer_environment: decode_optional_text(decoder)?,
        credential_type: decode_credential_type(decoder)?,
        secret_fields: decode_secret_fields(decoder)?,
        display_hint: decode_optional_text(decoder)?,
        scopes_or_permissions: decode_text_array(decoder, MAX_SCOPES)?,
        issued_at: decode_optional_timestamp(decoder)?,
        expires_at: decode_optional_timestamp(decoder)?,
        rotate_at: decode_optional_timestamp(decoder)?,
        timestamp_provenance: decode_timestamp_provenance(decoder)?,
        status: decode_credential_status(decoder)?,
        external_revocation_status: decode_external_revocation_status(decoder)?,
        external_revocation_attestation: decode_external_revocation_attestation(decoder)?,
        revoked_at: decode_optional_timestamp(decoder)?,
        rotation_state: decode_optional_rotation(decoder)?,
        connections: decode_connections(decoder)?,
        tags: decode_text_array(decoder, MAX_TAGS)?,
        notes: decode_optional_text(decoder)?,
        created_at: decode_timestamp(decoder)?,
        updated_at: decode_timestamp(decoder)?,
    })
}

fn decode_optional_revision(
    decoder: &mut Decoder<'_>,
) -> Result<Option<RevisionIdV1>, LocalVaultError> {
    if decode_null(decoder)? {
        return Ok(None);
    }
    let bytes = decoder.bytes().map_err(decode_error)?;
    let bytes: [u8; 32] = bytes.try_into().map_err(|_| LocalVaultError::InvalidItem)?;
    Ok(Some(RevisionIdV1::from_bytes(bytes)))
}

fn decode_optional_entity(
    decoder: &mut Decoder<'_>,
) -> Result<Option<EntityIdV1>, LocalVaultError> {
    if decode_null(decoder)? {
        return Ok(None);
    }
    decode_entity(decoder).map(Some)
}

fn decode_entity(decoder: &mut Decoder<'_>) -> Result<EntityIdV1, LocalVaultError> {
    let bytes = decoder.bytes().map_err(decode_error)?;
    let bytes: [u8; 16] = bytes.try_into().map_err(|_| LocalVaultError::InvalidItem)?;
    Ok(EntityIdV1::from_bytes(bytes))
}

fn decode_optional_text(decoder: &mut Decoder<'_>) -> Result<Option<String>, LocalVaultError> {
    if decode_null(decoder)? {
        return Ok(None);
    }
    decode_text(decoder).map(Some)
}

fn decode_text(decoder: &mut Decoder<'_>) -> Result<String, LocalVaultError> {
    decoder.str().map(str::to_owned).map_err(decode_error)
}

fn decode_optional_timestamp(
    decoder: &mut Decoder<'_>,
) -> Result<Option<UtcTimestampV1>, LocalVaultError> {
    if decode_null(decoder)? {
        return Ok(None);
    }
    decode_timestamp(decoder).map(Some)
}

fn decode_timestamp(decoder: &mut Decoder<'_>) -> Result<UtcTimestampV1, LocalVaultError> {
    UtcTimestampV1::new(decode_text(decoder)?)
}

fn decode_null(decoder: &mut Decoder<'_>) -> Result<bool, LocalVaultError> {
    if decoder.datatype().map_err(decode_error)? == Type::Null {
        decoder.null().map_err(decode_error)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

fn decode_text_array(
    decoder: &mut Decoder<'_>,
    maximum: u64,
) -> Result<Vec<String>, LocalVaultError> {
    let count = decode_array_length(decoder, maximum)?;
    let mut values = Vec::with_capacity(count);
    for _ in 0..count {
        values.push(decode_text(decoder)?);
    }
    Ok(values)
}

fn decode_secret_fields(decoder: &mut Decoder<'_>) -> Result<Vec<SecretFieldV1>, LocalVaultError> {
    let count = decode_array_length(decoder, MAX_SECRET_FIELDS)?;
    let mut fields = Vec::with_capacity(count);
    for _ in 0..count {
        require_fixed_array(decoder, SECRET_FIELD_COUNT)?;
        fields.push(SecretFieldV1 {
            field_id: decode_entity(decoder)?,
            label: decode_text(decoder)?,
            field_role: decode_field_role(decoder)?,
            sensitivity: decode_sensitivity(decoder)?,
            value: SecretValueV1::new(decoder.bytes().map_err(decode_error)?.to_vec())?,
            reveal_policy: decode_reveal_policy(decoder)?,
            copy_policy: decode_copy_policy(decoder)?,
        });
    }
    Ok(fields)
}

fn decode_connections(decoder: &mut Decoder<'_>) -> Result<Vec<ConnectionV1>, LocalVaultError> {
    let count = decode_array_length(decoder, MAX_CONNECTIONS)?;
    let mut connections = Vec::with_capacity(count);
    for _ in 0..count {
        require_fixed_array(decoder, CONNECTION_FIELD_COUNT)?;
        connections.push(ConnectionV1 {
            connection_id: decode_entity(decoder)?,
            consumer_type: decode_consumer_type(decoder)?,
            consumer_name: decode_text(decoder)?,
            consumer_project: decode_optional_text(decoder)?,
            consumer_environment: decode_optional_text(decoder)?,
            purpose: decode_optional_text(decoder)?,
            configuration_reference: decode_optional_text(decoder)?,
            credential_alias_or_env_name: decode_optional_text(decoder)?,
            required_for_cutover: decoder.bool().map_err(decode_error)?,
            status: decode_connection_status(decoder)?,
            verification_source: decode_verification_source(decoder)?,
            last_verified_at: decode_optional_timestamp(decoder)?,
            notes: decode_optional_text(decoder)?,
            mcp_integration: decode_optional_mcp(decoder)?,
        });
    }
    Ok(connections)
}

fn decode_optional_mcp(
    decoder: &mut Decoder<'_>,
) -> Result<Option<McpIntegrationV1>, LocalVaultError> {
    if decode_null(decoder)? {
        return Ok(None);
    }
    require_fixed_array(decoder, MCP_FIELD_COUNT)?;
    let transport = decode_mcp_transport(decoder)?;
    let server_identifier = decode_text(decoder)?;
    let package_or_executable_reference = decode_optional_text(decoder)?;
    let argument_template = decode_text_array(decoder, MAX_MCP_ARGUMENTS)?;
    let endpoint_url = decode_optional_text(decoder)?;
    let binding_count = decode_array_length(decoder, MAX_MCP_BINDINGS)?;
    let mut credential_field_bindings = Vec::with_capacity(binding_count);
    for _ in 0..binding_count {
        require_fixed_array(decoder, BINDING_FIELD_COUNT)?;
        credential_field_bindings.push(CredentialFieldBindingV1 {
            configuration_key_name: decode_text(decoder)?,
            field_id: decode_entity(decoder)?,
        });
    }
    let configuration_location = decode_optional_text(decoder)?;
    let execution_policy = decode_mcp_execution_policy(decoder)?;
    Ok(Some(McpIntegrationV1 {
        transport,
        server_identifier,
        package_or_executable_reference,
        argument_template,
        endpoint_url,
        credential_field_bindings,
        configuration_location,
        execution_policy,
    }))
}

fn decode_optional_rotation(
    decoder: &mut Decoder<'_>,
) -> Result<Option<RotationStateV1>, LocalVaultError> {
    if decode_null(decoder)? {
        return Ok(None);
    }
    require_fixed_array(decoder, ROTATION_FIELD_COUNT)?;
    let revision = decoder.bytes().map_err(decode_error)?;
    let revision: [u8; 32] = revision
        .try_into()
        .map_err(|_| LocalVaultError::InvalidItem)?;
    Ok(Some(RotationStateV1 {
        supersedes_revision_id: RevisionIdV1::from_bytes(revision),
        required_connection_ids: decode_entity_array(decoder)?,
        completed_connection_ids: decode_entity_array(decoder)?,
        superseded_external_revocation_status: decode_external_revocation_status(decoder)?,
        superseded_external_revocation_attestation: decode_external_revocation_attestation(
            decoder,
        )?,
        superseded_revoked_at: decode_optional_timestamp(decoder)?,
    }))
}

fn decode_entity_array(decoder: &mut Decoder<'_>) -> Result<Vec<EntityIdV1>, LocalVaultError> {
    let count = decode_array_length(decoder, MAX_ROTATION_CONNECTION_IDS)?;
    let mut ids = Vec::with_capacity(count);
    for _ in 0..count {
        ids.push(decode_entity(decoder)?);
    }
    Ok(ids)
}

fn decode_array_length(decoder: &mut Decoder<'_>, maximum: u64) -> Result<usize, LocalVaultError> {
    let count = decoder
        .array()
        .map_err(decode_error)?
        .ok_or(LocalVaultError::NonCanonicalEncoding)?;
    if count > maximum {
        return Err(LocalVaultError::LimitsExceeded);
    }
    usize::try_from(count).map_err(|_| LocalVaultError::LimitsExceeded)
}

fn require_fixed_array(decoder: &mut Decoder<'_>, expected: u64) -> Result<(), LocalVaultError> {
    if decoder.array().map_err(decode_error)? != Some(expected) {
        return Err(LocalVaultError::NonCanonicalEncoding);
    }
    Ok(())
}

macro_rules! decode_enum {
    ($name:ident, $type:ty, { $($value:literal => $variant:path),+ $(,)? }) => {
        fn $name(decoder: &mut Decoder<'_>) -> Result<$type, LocalVaultError> {
            match decoder.u64().map_err(decode_error)? {
                $($value => Ok($variant),)+
                _ => Err(LocalVaultError::InvalidItem),
            }
        }
    };
}

decode_enum!(decode_credential_type, CredentialTypeV1, {
    0 => CredentialTypeV1::Password,
    1 => CredentialTypeV1::ApiKey,
    2 => CredentialTypeV1::OauthClient,
    3 => CredentialTypeV1::CloudAccessKey,
    4 => CredentialTypeV1::Token,
    5 => CredentialTypeV1::RecoveryCode,
    6 => CredentialTypeV1::Custom,
});
decode_enum!(decode_field_role, FieldRoleV1, {
    0 => FieldRoleV1::Identifier,
    1 => FieldRoleV1::Secret,
    2 => FieldRoleV1::Token,
    3 => FieldRoleV1::Configuration,
});
decode_enum!(decode_sensitivity, SensitivityV1, {
    0 => SensitivityV1::PublicIdentifier,
    1 => SensitivityV1::PrivateMetadata,
    2 => SensitivityV1::Secret,
});
decode_enum!(decode_reveal_policy, RevealPolicyV1, {
    0 => RevealPolicyV1::Masked,
    1 => RevealPolicyV1::RevealAfterReauth,
});
decode_enum!(decode_copy_policy, CopyPolicyV1, {
    0 => CopyPolicyV1::AllowedAfterReauth,
    1 => CopyPolicyV1::Never,
});
decode_enum!(decode_timestamp_provenance, TimestampProvenanceV1, {
    0 => TimestampProvenanceV1::UserEntered,
    1 => TimestampProvenanceV1::ProviderVerified,
    2 => TimestampProvenanceV1::ImportedFixture,
});
decode_enum!(decode_credential_status, CredentialStatusV1, {
    0 => CredentialStatusV1::Active,
    1 => CredentialStatusV1::RotationDue,
    2 => CredentialStatusV1::Rotating,
    3 => CredentialStatusV1::Expired,
    4 => CredentialStatusV1::Compromised,
    5 => CredentialStatusV1::Revoked,
    6 => CredentialStatusV1::Disabled,
    7 => CredentialStatusV1::Unknown,
});
decode_enum!(decode_external_revocation_status, ExternalRevocationStatusV1, {
    0 => ExternalRevocationStatusV1::NotRequested,
    1 => ExternalRevocationStatusV1::Pending,
    2 => ExternalRevocationStatusV1::UserConfirmed,
    3 => ExternalRevocationStatusV1::ProviderVerified,
    4 => ExternalRevocationStatusV1::Failed,
    5 => ExternalRevocationStatusV1::Unknown,
});
decode_enum!(decode_external_revocation_attestation, ExternalRevocationAttestationV1, {
    0 => ExternalRevocationAttestationV1::None,
    1 => ExternalRevocationAttestationV1::User,
    2 => ExternalRevocationAttestationV1::ProviderConnector,
});
decode_enum!(decode_consumer_type, ConsumerTypeV1, {
    0 => ConsumerTypeV1::App,
    1 => ConsumerTypeV1::BrowserExtension,
    2 => ConsumerTypeV1::Plugin,
    3 => ConsumerTypeV1::McpServer,
    4 => ConsumerTypeV1::Cli,
    5 => ConsumerTypeV1::Server,
    6 => ConsumerTypeV1::CiCd,
    7 => ConsumerTypeV1::CloudProject,
    8 => ConsumerTypeV1::Custom,
});
decode_enum!(decode_connection_status, ConnectionStatusV1, {
    0 => ConnectionStatusV1::Connected,
    1 => ConnectionStatusV1::UpdateRequired,
    2 => ConnectionStatusV1::Verified,
    3 => ConnectionStatusV1::Removed,
    4 => ConnectionStatusV1::Unknown,
});
decode_enum!(decode_verification_source, VerificationSourceV1, {
    0 => VerificationSourceV1::User,
    1 => VerificationSourceV1::ProviderConnector,
    2 => VerificationSourceV1::None,
});
decode_enum!(decode_mcp_transport, McpTransportV1, {
    0 => McpTransportV1::Stdio,
    1 => McpTransportV1::StreamableHttp,
    2 => McpTransportV1::Sse,
    3 => McpTransportV1::Custom,
});
decode_enum!(decode_mcp_execution_policy, McpExecutionPolicyV1, {
    0 => McpExecutionPolicyV1::RecordOnly,
});

fn reject_if_over_product_limit(input: &[u8]) -> Result<(), LocalVaultError> {
    if input.len() > MAX_PAYLOAD_BYTES {
        return Err(LocalVaultError::LimitsExceeded);
    }
    Ok(())
}

fn length_as_u64(length: usize) -> Result<u64, LocalVaultError> {
    u64::try_from(length).map_err(|_| LocalVaultError::LimitsExceeded)
}

fn decode_error(_: minicbor::decode::Error) -> LocalVaultError {
    LocalVaultError::NonCanonicalEncoding
}

fn encode_error<E>(_: minicbor::encode::Error<E>) -> LocalVaultError {
    LocalVaultError::NonCanonicalEncoding
}

fn map_secret_bytes_error(error: vault_crypto::CryptoError) -> LocalVaultError {
    match error.code() {
        vault_crypto::CryptoErrorCode::LimitsExceeded => LocalVaultError::LimitsExceeded,
        _ => LocalVaultError::CryptoFailure,
    }
}

struct CanonicalComparator<'a> {
    expected: &'a [u8],
    position: usize,
    matches: bool,
}

impl<'a> CanonicalComparator<'a> {
    const fn new(expected: &'a [u8]) -> Self {
        Self {
            expected,
            position: 0,
            matches: true,
        }
    }

    fn is_exact_match(&self) -> bool {
        self.matches && self.position == self.expected.len()
    }
}

impl Write for CanonicalComparator<'_> {
    type Error = Infallible;

    fn write_all(&mut self, bytes: &[u8]) -> Result<(), Self::Error> {
        let Some(end) = self.position.checked_add(bytes.len()) else {
            self.matches = false;
            return Ok(());
        };
        if self.expected.get(self.position..end) != Some(bytes) {
            self.matches = false;
        }
        self.position = end;
        Ok(())
    }
}

#[cfg(test)]
pub(super) enum SyntheticCodecMutation {
    WrongTopLevelArrayLength,
    EmptyTopLevelArrayWithExternalFutureVersion,
    WrongNestedArrayLength,
    IndefiniteTopLevelArray,
    IndefiniteText,
    NonMinimalSchemaVersion,
    SchemaVersionZero,
    RawPayloadOverProductLimit,
    EncodedItemOverProductLimit,
    DeclaredConnectionCountOverLimit,
    TruncatedPayload,
    InvalidUtf8,
    TrailingBytes,
    UnknownCurrentEnum,
    DuplicateFieldId,
}

#[cfg(test)]
pub(super) fn reject_synthetic_codec_mutation_v1(
    mutation: SyntheticCodecMutation,
) -> Result<(), LocalVaultError> {
    let current_revision = synthetic_current_revision();

    if matches!(mutation, SyntheticCodecMutation::RawPayloadOverProductLimit) {
        let plaintext = vault_crypto::SecretBytes::new(vec![0_u8; MAX_PAYLOAD_BYTES + 1])
            .map_err(map_secret_bytes_error)?;
        return decode_item(&plaintext, current_revision).map(|_| ());
    }

    if matches!(
        mutation,
        SyntheticCodecMutation::EncodedItemOverProductLimit
    ) {
        return encode_current_item(&synthetic_oversized_item()?, current_revision).map(|_| ());
    }

    let mut item = synthetic_valid_item()?;
    if matches!(
        mutation,
        SyntheticCodecMutation::DeclaredConnectionCountOverLimit
    ) {
        item.connections.push(synthetic_connection(3));
    }
    if matches!(mutation, SyntheticCodecMutation::DuplicateFieldId) {
        item.secret_fields.push(synthetic_secret_field(2)?);
    }

    let encoded = encode_current_item(&item, current_revision)?;
    let mut bytes = encoded.expose_secret().to_vec();
    apply_synthetic_mutation(&mut bytes, mutation)?;
    let plaintext = vault_crypto::SecretBytes::new(bytes).map_err(map_secret_bytes_error)?;
    decode_item(&plaintext, current_revision).map(|_| ())
}

#[cfg(test)]
pub(super) fn synthetic_codec_roundtrip_with_note_length(
    note_len: usize,
) -> Result<(), LocalVaultError> {
    let current_revision = synthetic_current_revision();
    let mut item = synthetic_valid_item()?;
    item.notes = Some("x".repeat(note_len));
    let encoded = encode_current_item(&item, current_revision)?;
    match decode_item(&encoded, current_revision)? {
        DecodedItem::Current(decoded)
            if decoded.notes.as_deref().map(str::len) == Some(note_len) =>
        {
            Ok(())
        }
        DecodedItem::Current(_) | DecodedItem::UpgradeRequired { .. } => {
            Err(LocalVaultError::InvalidItem)
        }
    }
}

#[cfg(test)]
pub(super) fn synthetic_fully_populated_codec_roundtrip_v1() -> Result<(), LocalVaultError> {
    let current_revision = synthetic_current_revision();
    let encoded = encode_current_item(&synthetic_fully_populated_item()?, current_revision)?;
    let DecodedItem::Current(decoded) = decode_item(&encoded, current_revision)? else {
        return Err(LocalVaultError::InvalidItem);
    };

    let mcp_connection = decoded
        .connections
        .iter()
        .find(|connection| connection.consumer_type == ConsumerTypeV1::McpServer)
        .ok_or(LocalVaultError::InvalidItem)?;
    let integration = mcp_connection
        .mcp_integration
        .as_ref()
        .ok_or(LocalVaultError::InvalidItem)?;
    let rotation = decoded
        .rotation_state
        .as_ref()
        .ok_or(LocalVaultError::InvalidItem)?;

    if decoded.parent_revision_id.is_none()
        || decoded.provider_template_id.is_none()
        || decoded.console_url.is_none()
        || decoded.issuer_account_ref.is_none()
        || decoded.issuer_project_ref.is_none()
        || decoded.secret_fields.len() != 2
        || decoded.connections.len() != 2
        || integration.argument_template.len() != 2
        || integration.credential_field_bindings.len() != 2
        || rotation.required_connection_ids.len() != 1
        || rotation.completed_connection_ids.len() != 1
    {
        return Err(LocalVaultError::InvalidItem);
    }
    Ok(())
}

#[cfg(test)]
pub(super) fn synthetic_well_formed_future_version_v1() -> Result<u64, LocalVaultError> {
    let mut encoder = Encoder::new(Vec::with_capacity(2));
    encoder.array(1).map_err(encode_error)?;
    encoder.u64(2).map_err(encode_error)?;
    let plaintext =
        vault_crypto::SecretBytes::new(encoder.into_writer()).map_err(map_secret_bytes_error)?;
    match decode_item(&plaintext, synthetic_current_revision())? {
        DecodedItem::UpgradeRequired { version } => Ok(version),
        DecodedItem::Current(_) => Err(LocalVaultError::InvalidItem),
    }
}

#[cfg(test)]
fn apply_synthetic_mutation(
    bytes: &mut Vec<u8>,
    mutation: SyntheticCodecMutation,
) -> Result<(), LocalVaultError> {
    match mutation {
        SyntheticCodecMutation::WrongTopLevelArrayLength => {
            require_test_prefix(bytes, &[0x98, ITEM_FIELD_COUNT as u8])?;
            bytes[1] = (ITEM_FIELD_COUNT - 1) as u8;
        }
        SyntheticCodecMutation::EmptyTopLevelArrayWithExternalFutureVersion => {
            bytes.clear();
            bytes.extend_from_slice(&[0x80, 0x02]);
        }
        SyntheticCodecMutation::WrongNestedArrayLength => {
            let pattern = synthetic_secret_prefix(1, 1);
            let position = find_subslice(bytes, &pattern).ok_or(LocalVaultError::InvalidItem)?;
            bytes[position + 1] = (SECRET_FIELD_COUNT - 1) as u8 | 0x80;
        }
        SyntheticCodecMutation::IndefiniteTopLevelArray => {
            require_test_prefix(bytes, &[0x98, ITEM_FIELD_COUNT as u8])?;
            bytes.splice(0..2, [0x9f]);
        }
        SyntheticCodecMutation::IndefiniteText => {
            let marker = b"DEMO_VALUE_ONLY_item";
            let position = find_subslice(bytes, marker).ok_or(LocalVaultError::InvalidItem)?;
            let header = position
                .checked_sub(1)
                .ok_or(LocalVaultError::InvalidItem)?;
            bytes[header] = 0x7f;
        }
        SyntheticCodecMutation::NonMinimalSchemaVersion => {
            require_test_prefix(bytes, &[0x98, ITEM_FIELD_COUNT as u8, 0x01])?;
            bytes.splice(2..3, [0x18, 0x01]);
        }
        SyntheticCodecMutation::SchemaVersionZero => {
            require_test_prefix(bytes, &[0x98, ITEM_FIELD_COUNT as u8, 0x01])?;
            bytes[2] = 0;
        }
        SyntheticCodecMutation::DeclaredConnectionCountOverLimit => {
            let pattern = synthetic_connection_prefix(3);
            let position = find_subslice(bytes, &pattern).ok_or(LocalVaultError::InvalidItem)?;
            bytes.splice(position..position + 1, [0x98, 0x81]);
        }
        SyntheticCodecMutation::TruncatedPayload => {
            bytes.pop().ok_or(LocalVaultError::InvalidItem)?;
        }
        SyntheticCodecMutation::InvalidUtf8 => {
            let marker = b"DEMO_VALUE_ONLY_item";
            let position = find_subslice(bytes, marker).ok_or(LocalVaultError::InvalidItem)?;
            bytes[position] = 0xff;
        }
        SyntheticCodecMutation::TrailingBytes => bytes.push(0),
        SyntheticCodecMutation::UnknownCurrentEnum => {
            let pattern = synthetic_credential_type_prefix(1);
            let position = find_subslice(bytes, &pattern).ok_or(LocalVaultError::InvalidItem)?;
            bytes[position] = 7;
        }
        SyntheticCodecMutation::DuplicateFieldId => {
            let marker = synthetic_entity_bytes(2);
            let mut pattern = vec![0x50];
            pattern.extend_from_slice(&marker);
            let position = find_subslice(bytes, &pattern).ok_or(LocalVaultError::InvalidItem)?;
            bytes[position + 1..position + 17].fill(1);
        }
        SyntheticCodecMutation::RawPayloadOverProductLimit
        | SyntheticCodecMutation::EncodedItemOverProductLimit => {
            return Err(LocalVaultError::InvalidItem);
        }
    }
    Ok(())
}

#[cfg(test)]
fn synthetic_valid_item() -> Result<CredentialItemV1, LocalVaultError> {
    Ok(CredentialItemV1 {
        item_schema_version: ITEM_SCHEMA_VERSION,
        parent_revision_id: None,
        item_name: "DEMO_VALUE_ONLY_item".to_owned(),
        provider_template_id: None,
        provider_name: "DEMO_VALUE_ONLY_provider".to_owned(),
        console_url: None,
        issuer_account_ref: None,
        issuer_project_ref: None,
        issuer_account_identifier: None,
        issuer_organization_or_workspace: None,
        issuer_project: None,
        issuer_environment: None,
        credential_type: CredentialTypeV1::ApiKey,
        secret_fields: vec![synthetic_secret_field(1)?],
        display_hint: None,
        scopes_or_permissions: Vec::new(),
        issued_at: None,
        expires_at: None,
        rotate_at: None,
        timestamp_provenance: TimestampProvenanceV1::ImportedFixture,
        status: CredentialStatusV1::Active,
        external_revocation_status: ExternalRevocationStatusV1::NotRequested,
        external_revocation_attestation: ExternalRevocationAttestationV1::None,
        revoked_at: None,
        rotation_state: None,
        connections: Vec::new(),
        tags: Vec::new(),
        notes: Some("DEMO_VALUE_ONLY_note".to_owned()),
        created_at: synthetic_timestamp()?,
        updated_at: synthetic_timestamp()?,
    })
}

#[cfg(test)]
fn synthetic_fully_populated_item() -> Result<CredentialItemV1, LocalVaultError> {
    let mut item = synthetic_valid_item()?;
    let parent_revision = RevisionIdV1::from_bytes([0x20; 32]);

    item.parent_revision_id = Some(parent_revision);
    item.provider_template_id = Some("DEMO_VALUE_ONLY_provider_template".to_owned());
    item.console_url = Some("https://example.invalid/DEMO_VALUE_ONLY_console".to_owned());
    item.issuer_account_ref = Some(EntityIdV1::from_bytes(synthetic_entity_bytes(5)));
    item.issuer_project_ref = Some(EntityIdV1::from_bytes(synthetic_entity_bytes(6)));
    item.issuer_account_identifier = Some("DEMO_VALUE_ONLY_user@example.invalid".to_owned());
    item.issuer_organization_or_workspace = Some("DEMO_VALUE_ONLY_workspace".to_owned());
    item.issuer_project = Some("DEMO_VALUE_ONLY_project".to_owned());
    item.issuer_environment = Some("DEMO_VALUE_ONLY_test".to_owned());
    item.credential_type = CredentialTypeV1::OauthClient;
    let mut second_field = synthetic_secret_field(2)?;
    second_field.label = "DEMO_VALUE_ONLY_refresh_token".to_owned();
    second_field.field_role = FieldRoleV1::Token;
    second_field.sensitivity = SensitivityV1::PrivateMetadata;
    second_field.reveal_policy = RevealPolicyV1::Masked;
    second_field.copy_policy = CopyPolicyV1::Never;
    item.secret_fields.push(second_field);
    item.display_hint = Some("DEMO_VALUE_ONLY_tail".to_owned());
    item.scopes_or_permissions = vec![
        "DEMO_VALUE_ONLY_models.read".to_owned(),
        "DEMO_VALUE_ONLY_models.write".to_owned(),
    ];
    item.issued_at = Some(synthetic_timestamp()?);
    item.expires_at = Some(synthetic_timestamp()?);
    item.rotate_at = Some(synthetic_timestamp()?);
    item.timestamp_provenance = TimestampProvenanceV1::ProviderVerified;
    item.status = CredentialStatusV1::Rotating;
    item.external_revocation_status = ExternalRevocationStatusV1::UserConfirmed;
    item.external_revocation_attestation = ExternalRevocationAttestationV1::User;
    item.revoked_at = Some(synthetic_timestamp()?);

    let mut required_connection = synthetic_connection(3);
    populate_synthetic_connection(&mut required_connection)?;
    required_connection.required_for_cutover = true;
    required_connection.status = ConnectionStatusV1::Verified;
    required_connection.verification_source = VerificationSourceV1::ProviderConnector;

    let mut mcp_connection = synthetic_connection(4);
    populate_synthetic_connection(&mut mcp_connection)?;
    mcp_connection.consumer_type = ConsumerTypeV1::McpServer;
    mcp_connection.status = ConnectionStatusV1::UpdateRequired;
    mcp_connection.mcp_integration = Some(McpIntegrationV1 {
        transport: McpTransportV1::StreamableHttp,
        server_identifier: "DEMO_VALUE_ONLY_mcp_server".to_owned(),
        package_or_executable_reference: Some("DEMO_VALUE_ONLY_package".to_owned()),
        argument_template: vec![
            "DEMO_VALUE_ONLY_argument_one".to_owned(),
            "DEMO_VALUE_ONLY_argument_two".to_owned(),
        ],
        endpoint_url: Some("https://example.invalid/DEMO_VALUE_ONLY_mcp".to_owned()),
        credential_field_bindings: vec![
            CredentialFieldBindingV1 {
                configuration_key_name: "DEMO_VALUE_ONLY_API_KEY".to_owned(),
                field_id: EntityIdV1::from_bytes(synthetic_entity_bytes(1)),
            },
            CredentialFieldBindingV1 {
                configuration_key_name: "DEMO_VALUE_ONLY_REFRESH_TOKEN".to_owned(),
                field_id: EntityIdV1::from_bytes(synthetic_entity_bytes(2)),
            },
        ],
        configuration_location: Some("DEMO_VALUE_ONLY_config_file".to_owned()),
        execution_policy: McpExecutionPolicyV1::RecordOnly,
    });
    item.connections = vec![required_connection, mcp_connection];
    item.rotation_state = Some(RotationStateV1 {
        supersedes_revision_id: parent_revision,
        required_connection_ids: vec![EntityIdV1::from_bytes(synthetic_entity_bytes(3))],
        completed_connection_ids: vec![EntityIdV1::from_bytes(synthetic_entity_bytes(3))],
        superseded_external_revocation_status: ExternalRevocationStatusV1::ProviderVerified,
        superseded_external_revocation_attestation:
            ExternalRevocationAttestationV1::ProviderConnector,
        superseded_revoked_at: Some(synthetic_timestamp()?),
    });
    item.tags = vec![
        "DEMO_VALUE_ONLY_ai".to_owned(),
        "DEMO_VALUE_ONLY_rotation".to_owned(),
    ];
    item.notes = Some("DEMO_VALUE_ONLY_fully_populated_fixture".to_owned());
    Ok(item)
}

#[cfg(test)]
fn populate_synthetic_connection(connection: &mut ConnectionV1) -> Result<(), LocalVaultError> {
    connection.consumer_project = Some("DEMO_VALUE_ONLY_consumer_project".to_owned());
    connection.consumer_environment = Some("DEMO_VALUE_ONLY_consumer_test".to_owned());
    connection.purpose = Some("DEMO_VALUE_ONLY_rotation_validation".to_owned());
    connection.configuration_reference = Some("DEMO_VALUE_ONLY_settings_page".to_owned());
    connection.credential_alias_or_env_name = Some("DEMO_VALUE_ONLY_API_KEY".to_owned());
    connection.last_verified_at = Some(synthetic_timestamp()?);
    connection.notes = Some("DEMO_VALUE_ONLY_connection_note".to_owned());
    Ok(())
}

#[cfg(test)]
fn synthetic_oversized_item() -> Result<CredentialItemV1, LocalVaultError> {
    let mut item = synthetic_valid_item()?;
    item.item_name = "x".repeat(128);
    item.provider_name = "x".repeat(256);
    item.console_url = Some("x".repeat(2_048));
    item.issuer_account_identifier = Some("x".repeat(256));
    item.issuer_organization_or_workspace = Some("x".repeat(256));
    item.issuer_project = Some("x".repeat(256));
    item.issuer_environment = Some("x".repeat(256));
    item.display_hint = Some("x".repeat(32));
    item.secret_fields[0].value = SecretValueV1::new(synthetic_marker_bytes(32_768))?;
    item.scopes_or_permissions = vec!["x".repeat(256); 64];
    item.tags = vec!["x".repeat(64); 32];
    item.notes = Some("x".repeat(8_192));
    Ok(item)
}

#[cfg(test)]
fn synthetic_secret_field(id: u8) -> Result<SecretFieldV1, LocalVaultError> {
    Ok(SecretFieldV1 {
        field_id: EntityIdV1::from_bytes(synthetic_entity_bytes(id)),
        label: "DEMO_VALUE_ONLY_field".to_owned(),
        field_role: FieldRoleV1::Secret,
        sensitivity: SensitivityV1::Secret,
        value: SecretValueV1::new(b"DEMO_VALUE_ONLY_not_a_real_secret".to_vec())?,
        reveal_policy: RevealPolicyV1::RevealAfterReauth,
        copy_policy: CopyPolicyV1::AllowedAfterReauth,
    })
}

#[cfg(test)]
fn synthetic_connection(id: u8) -> ConnectionV1 {
    ConnectionV1 {
        connection_id: EntityIdV1::from_bytes(synthetic_entity_bytes(id)),
        consumer_type: ConsumerTypeV1::App,
        consumer_name: "DEMO_VALUE_ONLY_consumer".to_owned(),
        consumer_project: None,
        consumer_environment: None,
        purpose: None,
        configuration_reference: None,
        credential_alias_or_env_name: None,
        required_for_cutover: false,
        status: ConnectionStatusV1::Connected,
        verification_source: VerificationSourceV1::User,
        last_verified_at: None,
        notes: None,
        mcp_integration: None,
    }
}

#[cfg(test)]
fn synthetic_timestamp() -> Result<UtcTimestampV1, LocalVaultError> {
    UtcTimestampV1::new("2026-08-15T12:00:00Z".to_owned())
}

#[cfg(test)]
const fn synthetic_current_revision() -> RevisionIdV1 {
    RevisionIdV1::from_bytes([0xfe; 32])
}

#[cfg(test)]
const fn synthetic_entity_bytes(id: u8) -> [u8; 16] {
    [id; 16]
}

#[cfg(test)]
fn synthetic_marker_bytes(length: usize) -> Vec<u8> {
    const MARKER: &[u8] = b"DEMO_VALUE_ONLY_";
    MARKER.iter().copied().cycle().take(length).collect()
}

#[cfg(test)]
fn synthetic_secret_prefix(outer_count: u8, id: u8) -> Vec<u8> {
    let mut pattern = vec![0x80 | outer_count, 0x80 | SECRET_FIELD_COUNT as u8, 0x50];
    pattern.extend_from_slice(&synthetic_entity_bytes(id));
    pattern
}

#[cfg(test)]
fn synthetic_connection_prefix(id: u8) -> Vec<u8> {
    let mut pattern = vec![0x81, 0x80 | CONNECTION_FIELD_COUNT as u8, 0x50];
    pattern.extend_from_slice(&synthetic_entity_bytes(id));
    pattern
}

#[cfg(test)]
fn synthetic_credential_type_prefix(credential_type: u8) -> Vec<u8> {
    let mut pattern = vec![credential_type, 0x81, 0x80 | SECRET_FIELD_COUNT as u8, 0x50];
    pattern.extend_from_slice(&synthetic_entity_bytes(1));
    pattern
}

#[cfg(test)]
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
fn require_test_prefix(bytes: &[u8], expected: &[u8]) -> Result<(), LocalVaultError> {
    if bytes.starts_with(expected) {
        Ok(())
    } else {
        Err(LocalVaultError::InvalidItem)
    }
}

#[cfg(test)]
#[path = "codec_tests.rs"]
mod tests;
