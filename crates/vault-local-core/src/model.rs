#![allow(
    dead_code,
    reason = "the crate-private V1 model boundary is consumed by the next codec task"
)]

use std::collections::BTreeSet;

use crate::LocalVaultError;
use crate::ids::{EntityIdV1, RevisionIdV1};
use crate::secret::SecretValueV1;

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum CredentialTypeV1 {
    Password = 0,
    ApiKey = 1,
    OauthClient = 2,
    CloudAccessKey = 3,
    Token = 4,
    RecoveryCode = 5,
    Custom = 6,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum FieldRoleV1 {
    Identifier = 0,
    Secret = 1,
    Token = 2,
    Configuration = 3,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum SensitivityV1 {
    PublicIdentifier = 0,
    PrivateMetadata = 1,
    Secret = 2,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum RevealPolicyV1 {
    Masked = 0,
    RevealAfterReauth = 1,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum CopyPolicyV1 {
    AllowedAfterReauth = 0,
    Never = 1,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum TimestampProvenanceV1 {
    UserEntered = 0,
    ProviderVerified = 1,
    ImportedFixture = 2,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum CredentialStatusV1 {
    Active = 0,
    RotationDue = 1,
    Rotating = 2,
    Expired = 3,
    Compromised = 4,
    Revoked = 5,
    Disabled = 6,
    Unknown = 7,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum ExternalRevocationStatusV1 {
    NotRequested = 0,
    Pending = 1,
    UserConfirmed = 2,
    ProviderVerified = 3,
    Failed = 4,
    Unknown = 5,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum ExternalRevocationAttestationV1 {
    None = 0,
    User = 1,
    ProviderConnector = 2,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum ConsumerTypeV1 {
    App = 0,
    BrowserExtension = 1,
    Plugin = 2,
    McpServer = 3,
    Cli = 4,
    Server = 5,
    CiCd = 6,
    CloudProject = 7,
    Custom = 8,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum ConnectionStatusV1 {
    Connected = 0,
    UpdateRequired = 1,
    Verified = 2,
    Removed = 3,
    Unknown = 4,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum VerificationSourceV1 {
    User = 0,
    ProviderConnector = 1,
    None = 2,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum McpTransportV1 {
    Stdio = 0,
    StreamableHttp = 1,
    Sse = 2,
    Custom = 3,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum McpExecutionPolicyV1 {
    RecordOnly = 0,
}

pub(crate) struct CredentialItemV1 {
    pub item_schema_version: u64,
    pub parent_revision_id: Option<RevisionIdV1>,
    pub item_name: String,
    pub provider_template_id: Option<String>,
    pub provider_name: String,
    pub console_url: Option<String>,
    pub issuer_account_ref: Option<EntityIdV1>,
    pub issuer_project_ref: Option<EntityIdV1>,
    pub issuer_account_identifier: Option<String>,
    pub issuer_organization_or_workspace: Option<String>,
    pub issuer_project: Option<String>,
    pub issuer_environment: Option<String>,
    pub credential_type: CredentialTypeV1,
    pub secret_fields: Vec<SecretFieldV1>,
    pub display_hint: Option<String>,
    pub scopes_or_permissions: Vec<String>,
    pub issued_at: Option<UtcTimestampV1>,
    pub expires_at: Option<UtcTimestampV1>,
    pub rotate_at: Option<UtcTimestampV1>,
    pub timestamp_provenance: TimestampProvenanceV1,
    pub status: CredentialStatusV1,
    pub external_revocation_status: ExternalRevocationStatusV1,
    pub external_revocation_attestation: ExternalRevocationAttestationV1,
    pub revoked_at: Option<UtcTimestampV1>,
    pub rotation_state: Option<RotationStateV1>,
    pub connections: Vec<ConnectionV1>,
    pub tags: Vec<String>,
    pub notes: Option<String>,
    pub created_at: UtcTimestampV1,
    pub updated_at: UtcTimestampV1,
}

pub(crate) struct SecretFieldV1 {
    pub field_id: EntityIdV1,
    pub label: String,
    pub field_role: FieldRoleV1,
    pub sensitivity: SensitivityV1,
    pub value: SecretValueV1,
    pub reveal_policy: RevealPolicyV1,
    pub copy_policy: CopyPolicyV1,
}

pub(crate) struct ConnectionV1 {
    pub connection_id: EntityIdV1,
    pub consumer_type: ConsumerTypeV1,
    pub consumer_name: String,
    pub consumer_project: Option<String>,
    pub consumer_environment: Option<String>,
    pub purpose: Option<String>,
    pub configuration_reference: Option<String>,
    pub credential_alias_or_env_name: Option<String>,
    pub required_for_cutover: bool,
    pub status: ConnectionStatusV1,
    pub verification_source: VerificationSourceV1,
    pub last_verified_at: Option<UtcTimestampV1>,
    pub notes: Option<String>,
    pub mcp_integration: Option<McpIntegrationV1>,
}

pub(crate) struct McpIntegrationV1 {
    pub transport: McpTransportV1,
    pub server_identifier: String,
    pub package_or_executable_reference: Option<String>,
    pub argument_template: Vec<String>,
    pub endpoint_url: Option<String>,
    pub credential_field_bindings: Vec<CredentialFieldBindingV1>,
    pub configuration_location: Option<String>,
    pub execution_policy: McpExecutionPolicyV1,
}

pub(crate) struct CredentialFieldBindingV1 {
    pub configuration_key_name: String,
    pub field_id: EntityIdV1,
}

pub(crate) struct RotationStateV1 {
    pub supersedes_revision_id: RevisionIdV1,
    pub required_connection_ids: Vec<EntityIdV1>,
    pub completed_connection_ids: Vec<EntityIdV1>,
    pub superseded_external_revocation_status: ExternalRevocationStatusV1,
    pub superseded_external_revocation_attestation: ExternalRevocationAttestationV1,
    pub superseded_revoked_at: Option<UtcTimestampV1>,
}

pub(crate) struct UtcTimestampV1(String);

impl UtcTimestampV1 {
    pub(crate) fn new(value: String) -> Result<Self, LocalVaultError> {
        let bytes = value.as_bytes();
        if bytes.len() != 20
            || !value.is_ascii()
            || bytes[4] != b'-'
            || bytes[7] != b'-'
            || bytes[10] != b'T'
            || bytes[13] != b':'
            || bytes[16] != b':'
            || bytes[19] != b'Z'
        {
            return Err(LocalVaultError::InvalidItem);
        }

        let year = parse_decimal(bytes, 0, 4).ok_or(LocalVaultError::InvalidItem)?;
        let month = parse_decimal(bytes, 5, 2).ok_or(LocalVaultError::InvalidItem)?;
        let day = parse_decimal(bytes, 8, 2).ok_or(LocalVaultError::InvalidItem)?;
        let hour = parse_decimal(bytes, 11, 2).ok_or(LocalVaultError::InvalidItem)?;
        let minute = parse_decimal(bytes, 14, 2).ok_or(LocalVaultError::InvalidItem)?;
        let second = parse_decimal(bytes, 17, 2).ok_or(LocalVaultError::InvalidItem)?;

        if year == 0
            || !(1..=12).contains(&month)
            || day == 0
            || day > days_in_month(year, month)
            || hour > 23
            || minute > 59
            || second > 59
        {
            return Err(LocalVaultError::InvalidItem);
        }

        Ok(Self(value))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

fn parse_decimal(bytes: &[u8], start: usize, length: usize) -> Option<u32> {
    let mut value = 0_u32;
    for byte in bytes.get(start..start + length)? {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value
            .checked_mul(10)?
            .checked_add(u32::from(*byte - b'0'))?;
    }
    Some(value)
}

const fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

const fn is_leap_year(year: u32) -> bool {
    year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
}

impl CredentialItemV1 {
    pub(crate) fn validate(&self, current_revision: RevisionIdV1) -> Result<(), LocalVaultError> {
        if self.item_schema_version != 1 {
            return Err(LocalVaultError::InvalidItem);
        }
        if self.parent_revision_id == Some(current_revision) {
            return Err(LocalVaultError::InvalidItem);
        }
        require_nonempty(&self.item_name)?;
        require_max_bytes(&self.item_name, 128)?;
        validate_item_text_limits(self)?;
        validate_secret_fields(&self.secret_fields)?;
        validate_connections(&self.connections, &self.secret_fields)?;
        validate_rotation(self)?;
        validate_timestamp_storage(self);
        Ok(())
    }
}

fn validate_item_text_limits(item: &CredentialItemV1) -> Result<(), LocalVaultError> {
    require_optional_max_bytes(item.provider_template_id.as_deref(), 256)?;
    require_max_bytes(&item.provider_name, 256)?;
    require_optional_max_bytes(item.console_url.as_deref(), 2_048)?;
    require_optional_max_bytes(item.issuer_account_identifier.as_deref(), 256)?;
    require_optional_max_bytes(item.issuer_organization_or_workspace.as_deref(), 256)?;
    require_optional_max_bytes(item.issuer_project.as_deref(), 256)?;
    require_optional_max_bytes(item.issuer_environment.as_deref(), 256)?;
    require_optional_max_bytes(item.display_hint.as_deref(), 32)?;
    require_optional_max_bytes(item.notes.as_deref(), 8_192)?;

    if item.scopes_or_permissions.len() > 64 || item.tags.len() > 32 {
        return Err(LocalVaultError::LimitsExceeded);
    }
    for scope in &item.scopes_or_permissions {
        require_max_bytes(scope, 256)?;
    }
    for tag in &item.tags {
        require_nonempty(tag)?;
        require_max_bytes(tag, 64)?;
    }
    Ok(())
}

fn validate_secret_fields(secret_fields: &[SecretFieldV1]) -> Result<(), LocalVaultError> {
    if secret_fields.is_empty() {
        return Err(LocalVaultError::InvalidItem);
    }
    if secret_fields.len() > 16 {
        return Err(LocalVaultError::LimitsExceeded);
    }

    let mut field_ids = BTreeSet::new();
    let mut total_secret_bytes = 0_usize;
    for field in secret_fields {
        if !field_ids.insert(*field.field_id.as_bytes()) {
            return Err(LocalVaultError::InvalidItem);
        }
        require_max_bytes(&field.label, 256)?;
        total_secret_bytes = total_secret_bytes
            .checked_add(field.value.expose().len())
            .ok_or(LocalVaultError::LimitsExceeded)?;
        if total_secret_bytes > 32_768 {
            return Err(LocalVaultError::LimitsExceeded);
        }
    }
    Ok(())
}

fn validate_connections(
    connections: &[ConnectionV1],
    secret_fields: &[SecretFieldV1],
) -> Result<(), LocalVaultError> {
    if connections.len() > 128 {
        return Err(LocalVaultError::LimitsExceeded);
    }

    let field_ids: BTreeSet<[u8; 16]> = secret_fields
        .iter()
        .map(|field| *field.field_id.as_bytes())
        .collect();
    let mut connection_ids = BTreeSet::new();

    for connection in connections {
        if !connection_ids.insert(*connection.connection_id.as_bytes()) {
            return Err(LocalVaultError::InvalidItem);
        }
        validate_connection_text_limits(connection)?;

        match (&connection.consumer_type, &connection.mcp_integration) {
            (ConsumerTypeV1::McpServer, Some(integration)) => {
                validate_mcp_integration(integration, &field_ids)?;
            }
            (ConsumerTypeV1::McpServer, None) => {}
            (_, Some(_)) => return Err(LocalVaultError::InvalidItem),
            (_, None) => {}
        }
    }
    Ok(())
}

fn validate_connection_text_limits(connection: &ConnectionV1) -> Result<(), LocalVaultError> {
    require_max_bytes(&connection.consumer_name, 256)?;
    require_optional_max_bytes(connection.consumer_project.as_deref(), 256)?;
    require_optional_max_bytes(connection.consumer_environment.as_deref(), 256)?;
    require_optional_max_bytes(connection.purpose.as_deref(), 256)?;
    require_optional_max_bytes(connection.configuration_reference.as_deref(), 256)?;
    require_optional_max_bytes(connection.credential_alias_or_env_name.as_deref(), 256)?;
    require_optional_max_bytes(connection.notes.as_deref(), 256)?;
    Ok(())
}

fn validate_mcp_integration(
    integration: &McpIntegrationV1,
    field_ids: &BTreeSet<[u8; 16]>,
) -> Result<(), LocalVaultError> {
    require_max_bytes(&integration.server_identifier, 256)?;
    require_optional_max_bytes(integration.package_or_executable_reference.as_deref(), 256)?;
    require_optional_max_bytes(integration.endpoint_url.as_deref(), 2_048)?;
    require_optional_max_bytes(integration.configuration_location.as_deref(), 256)?;

    if integration.argument_template.len() > 32 || integration.credential_field_bindings.len() > 16
    {
        return Err(LocalVaultError::LimitsExceeded);
    }
    for argument in &integration.argument_template {
        require_max_bytes(argument, 256)?;
    }

    let mut binding_pairs = BTreeSet::new();
    for binding in &integration.credential_field_bindings {
        require_nonempty(&binding.configuration_key_name)?;
        require_max_bytes(&binding.configuration_key_name, 256)?;
        if !field_ids.contains(binding.field_id.as_bytes())
            || !binding_pairs.insert((
                binding.configuration_key_name.as_str(),
                *binding.field_id.as_bytes(),
            ))
        {
            return Err(LocalVaultError::InvalidItem);
        }
    }
    Ok(())
}

fn validate_rotation(item: &CredentialItemV1) -> Result<(), LocalVaultError> {
    let Some(rotation) = &item.rotation_state else {
        return Ok(());
    };
    let Some(parent_revision_id) = item.parent_revision_id else {
        return Err(LocalVaultError::InvalidItem);
    };
    if rotation.supersedes_revision_id != parent_revision_id {
        return Err(LocalVaultError::InvalidItem);
    }

    let expected_required: BTreeSet<[u8; 16]> = item
        .connections
        .iter()
        .filter(|connection| {
            connection.required_for_cutover && connection.status != ConnectionStatusV1::Removed
        })
        .map(|connection| *connection.connection_id.as_bytes())
        .collect();
    let required = unique_entity_ids(&rotation.required_connection_ids)?;
    let completed = unique_entity_ids(&rotation.completed_connection_ids)?;
    if required != expected_required || !completed.is_subset(&required) {
        return Err(LocalVaultError::InvalidItem);
    }

    if rotation.superseded_revoked_at.is_some()
        && !matches!(
            (
                rotation.superseded_external_revocation_status,
                rotation.superseded_external_revocation_attestation,
            ),
            (
                ExternalRevocationStatusV1::UserConfirmed,
                ExternalRevocationAttestationV1::User,
            ) | (
                ExternalRevocationStatusV1::ProviderVerified,
                ExternalRevocationAttestationV1::ProviderConnector,
            )
        )
    {
        return Err(LocalVaultError::InvalidItem);
    }
    Ok(())
}

fn unique_entity_ids(ids: &[EntityIdV1]) -> Result<BTreeSet<[u8; 16]>, LocalVaultError> {
    let mut unique = BTreeSet::new();
    for id in ids {
        if !unique.insert(*id.as_bytes()) {
            return Err(LocalVaultError::InvalidItem);
        }
    }
    Ok(unique)
}

fn require_nonempty(value: &str) -> Result<(), LocalVaultError> {
    if value.is_empty() {
        Err(LocalVaultError::InvalidItem)
    } else {
        Ok(())
    }
}

fn require_max_bytes(value: &str, maximum: usize) -> Result<(), LocalVaultError> {
    if value.len() > maximum {
        Err(LocalVaultError::LimitsExceeded)
    } else {
        Ok(())
    }
}

fn require_optional_max_bytes(value: Option<&str>, maximum: usize) -> Result<(), LocalVaultError> {
    value.map_or(Ok(()), |text| require_max_bytes(text, maximum))
}

fn validate_timestamp_storage(item: &CredentialItemV1) {
    for timestamp in [
        item.issued_at.as_ref(),
        item.expires_at.as_ref(),
        item.rotate_at.as_ref(),
        item.revoked_at.as_ref(),
        Some(&item.created_at),
        Some(&item.updated_at),
    ]
    .into_iter()
    .flatten()
    {
        let _ = timestamp.as_str();
    }
    for connection in &item.connections {
        if let Some(timestamp) = &connection.last_verified_at {
            let _ = timestamp.as_str();
        }
    }
    if let Some(timestamp) = item
        .rotation_state
        .as_ref()
        .and_then(|rotation| rotation.superseded_revoked_at.as_ref())
    {
        let _ = timestamp.as_str();
    }
}

#[cfg(test)]
pub(super) enum SyntheticInvalidFixtureId {
    EmptyItemName,
    DanglingMcpFieldBinding,
    DuplicateConnectionId,
    DuplicateSecretFieldId,
    McpPayloadOnNonMcpConsumer,
    DuplicateMcpBinding,
    RotationParentMismatch,
    RequiredConnectionSetMismatch,
    CompletedConnectionOutsideRequiredSet,
    InvalidSupersededRevocationAttestation,
    SelfParentRevision,
    ItemNameOver128Bytes,
    ConsoleUrlOver2048Bytes,
    NotesOver8192Bytes,
    TooManySecretFields,
    SecretBytesOverLimit,
    TooManyConnections,
}

#[cfg(test)]
pub(super) fn validate_invalid_fixture_v1(
    fixture: SyntheticInvalidFixtureId,
) -> Result<(), LocalVaultError> {
    let current_revision = RevisionIdV1::from_bytes([0xfe; 32]);
    let mut item = synthetic_valid_item();

    match fixture {
        SyntheticInvalidFixtureId::EmptyItemName => item.item_name.clear(),
        SyntheticInvalidFixtureId::DanglingMcpFieldBinding => {
            item.connections
                .push(synthetic_mcp_connection(vec![CredentialFieldBindingV1 {
                    configuration_key_name: "DEMO_VALUE_ONLY_API_KEY".to_owned(),
                    field_id: entity_id(99),
                }]));
        }
        SyntheticInvalidFixtureId::DuplicateConnectionId => {
            item.connections.push(synthetic_connection(10));
            item.connections.push(synthetic_connection(10));
        }
        SyntheticInvalidFixtureId::DuplicateSecretFieldId => {
            item.secret_fields.push(synthetic_secret_field(1));
        }
        SyntheticInvalidFixtureId::McpPayloadOnNonMcpConsumer => {
            let mut connection = synthetic_connection(10);
            connection.mcp_integration = Some(synthetic_mcp_integration(Vec::new()));
            item.connections.push(connection);
        }
        SyntheticInvalidFixtureId::DuplicateMcpBinding => {
            let binding = || CredentialFieldBindingV1 {
                configuration_key_name: "DEMO_VALUE_ONLY_API_KEY".to_owned(),
                field_id: entity_id(1),
            };
            item.connections
                .push(synthetic_mcp_connection(vec![binding(), binding()]));
        }
        SyntheticInvalidFixtureId::RotationParentMismatch => {
            item.connections.push(synthetic_required_connection(10));
            item.parent_revision_id = Some(RevisionIdV1::from_bytes([0x20; 32]));
            item.rotation_state = Some(synthetic_rotation(
                RevisionIdV1::from_bytes([0x21; 32]),
                vec![entity_id(10)],
                Vec::new(),
            ));
        }
        SyntheticInvalidFixtureId::RequiredConnectionSetMismatch => {
            let parent = RevisionIdV1::from_bytes([0x20; 32]);
            item.connections.push(synthetic_required_connection(10));
            item.parent_revision_id = Some(parent);
            item.rotation_state = Some(synthetic_rotation(parent, Vec::new(), Vec::new()));
        }
        SyntheticInvalidFixtureId::CompletedConnectionOutsideRequiredSet => {
            let parent = RevisionIdV1::from_bytes([0x20; 32]);
            item.connections.push(synthetic_required_connection(10));
            item.parent_revision_id = Some(parent);
            item.rotation_state = Some(synthetic_rotation(
                parent,
                vec![entity_id(10)],
                vec![entity_id(11)],
            ));
        }
        SyntheticInvalidFixtureId::InvalidSupersededRevocationAttestation => {
            let parent = RevisionIdV1::from_bytes([0x20; 32]);
            item.parent_revision_id = Some(parent);
            let mut rotation = synthetic_rotation(parent, Vec::new(), Vec::new());
            rotation.superseded_external_revocation_status =
                ExternalRevocationStatusV1::UserConfirmed;
            rotation.superseded_external_revocation_attestation =
                ExternalRevocationAttestationV1::ProviderConnector;
            rotation.superseded_revoked_at = Some(synthetic_timestamp());
            item.rotation_state = Some(rotation);
        }
        SyntheticInvalidFixtureId::SelfParentRevision => {
            item.parent_revision_id = Some(current_revision);
        }
        SyntheticInvalidFixtureId::ItemNameOver128Bytes => {
            item.item_name = "x".repeat(129);
        }
        SyntheticInvalidFixtureId::ConsoleUrlOver2048Bytes => {
            item.console_url = Some("x".repeat(2_049));
        }
        SyntheticInvalidFixtureId::NotesOver8192Bytes => {
            item.notes = Some("x".repeat(8_193));
        }
        SyntheticInvalidFixtureId::TooManySecretFields => {
            for id in 2..=17 {
                item.secret_fields.push(synthetic_secret_field(id));
            }
        }
        SyntheticInvalidFixtureId::SecretBytesOverLimit => {
            item.secret_fields[0].value = SecretValueV1::new(vec![0x41; 32_769])?;
        }
        SyntheticInvalidFixtureId::TooManyConnections => {
            for id in 0..=128 {
                item.connections.push(synthetic_connection_u16(id));
            }
        }
    }

    item.validate(current_revision)
}

#[cfg(test)]
fn synthetic_valid_item() -> CredentialItemV1 {
    CredentialItemV1 {
        item_schema_version: 1,
        parent_revision_id: None,
        item_name: "DEMO_VALUE_ONLY_OpenAI_key".to_owned(),
        provider_template_id: Some("DEMO_VALUE_ONLY_openai".to_owned()),
        provider_name: "DEMO_VALUE_ONLY_OpenAI".to_owned(),
        console_url: Some("https://example.invalid/DEMO_VALUE_ONLY_console".to_owned()),
        issuer_account_ref: Some(entity_id(2)),
        issuer_project_ref: Some(entity_id(3)),
        issuer_account_identifier: Some("DEMO_VALUE_ONLY_user@example.invalid".to_owned()),
        issuer_organization_or_workspace: Some("DEMO_VALUE_ONLY_workspace".to_owned()),
        issuer_project: Some("DEMO_VALUE_ONLY_project".to_owned()),
        issuer_environment: Some("DEMO_VALUE_ONLY_test".to_owned()),
        credential_type: CredentialTypeV1::ApiKey,
        secret_fields: vec![synthetic_secret_field(1)],
        display_hint: Some("DEMO_VALUE_ONLY_tail".to_owned()),
        scopes_or_permissions: vec!["DEMO_VALUE_ONLY_models.read".to_owned()],
        issued_at: Some(synthetic_timestamp()),
        expires_at: None,
        rotate_at: None,
        timestamp_provenance: TimestampProvenanceV1::ImportedFixture,
        status: CredentialStatusV1::Active,
        external_revocation_status: ExternalRevocationStatusV1::NotRequested,
        external_revocation_attestation: ExternalRevocationAttestationV1::None,
        revoked_at: None,
        rotation_state: None,
        connections: Vec::new(),
        tags: vec!["DEMO_VALUE_ONLY_ai".to_owned()],
        notes: Some("DEMO_VALUE_ONLY_synthetic fixture".to_owned()),
        created_at: synthetic_timestamp(),
        updated_at: synthetic_timestamp(),
    }
}

#[cfg(test)]
fn synthetic_secret_field(id: u8) -> SecretFieldV1 {
    SecretFieldV1 {
        field_id: entity_id(id),
        label: "DEMO_VALUE_ONLY_API key".to_owned(),
        field_role: FieldRoleV1::Secret,
        sensitivity: SensitivityV1::Secret,
        value: SecretValueV1::new(b"DEMO_VALUE_ONLY_not_a_real_secret".to_vec())
            .expect("the synthetic secret is non-empty"),
        reveal_policy: RevealPolicyV1::RevealAfterReauth,
        copy_policy: CopyPolicyV1::AllowedAfterReauth,
    }
}

#[cfg(test)]
fn synthetic_connection(id: u8) -> ConnectionV1 {
    synthetic_connection_with_id(entity_id(id))
}

#[cfg(test)]
fn synthetic_connection_u16(id: u16) -> ConnectionV1 {
    let bytes = id.to_be_bytes();
    let mut value = [0_u8; 16];
    value[..2].copy_from_slice(&bytes);
    synthetic_connection_with_id(EntityIdV1::from_bytes(value))
}

#[cfg(test)]
fn synthetic_connection_with_id(connection_id: EntityIdV1) -> ConnectionV1 {
    ConnectionV1 {
        connection_id,
        consumer_type: ConsumerTypeV1::App,
        consumer_name: "DEMO_VALUE_ONLY_application".to_owned(),
        consumer_project: Some("DEMO_VALUE_ONLY_project".to_owned()),
        consumer_environment: Some("DEMO_VALUE_ONLY_test".to_owned()),
        purpose: Some("DEMO_VALUE_ONLY_synthetic test".to_owned()),
        configuration_reference: Some("DEMO_VALUE_ONLY_settings page".to_owned()),
        credential_alias_or_env_name: Some("DEMO_VALUE_ONLY_API_KEY".to_owned()),
        required_for_cutover: false,
        status: ConnectionStatusV1::Connected,
        verification_source: VerificationSourceV1::User,
        last_verified_at: Some(synthetic_timestamp()),
        notes: Some("DEMO_VALUE_ONLY_connection".to_owned()),
        mcp_integration: None,
    }
}

#[cfg(test)]
fn synthetic_required_connection(id: u8) -> ConnectionV1 {
    let mut connection = synthetic_connection(id);
    connection.required_for_cutover = true;
    connection
}

#[cfg(test)]
fn synthetic_mcp_connection(bindings: Vec<CredentialFieldBindingV1>) -> ConnectionV1 {
    let mut connection = synthetic_connection(10);
    connection.consumer_type = ConsumerTypeV1::McpServer;
    connection.mcp_integration = Some(synthetic_mcp_integration(bindings));
    connection
}

#[cfg(test)]
fn synthetic_mcp_integration(bindings: Vec<CredentialFieldBindingV1>) -> McpIntegrationV1 {
    McpIntegrationV1 {
        transport: McpTransportV1::Stdio,
        server_identifier: "DEMO_VALUE_ONLY_mcp_server".to_owned(),
        package_or_executable_reference: Some("DEMO_VALUE_ONLY_package".to_owned()),
        argument_template: vec!["DEMO_VALUE_ONLY_argument".to_owned()],
        endpoint_url: None,
        credential_field_bindings: bindings,
        configuration_location: Some("DEMO_VALUE_ONLY_config".to_owned()),
        execution_policy: McpExecutionPolicyV1::RecordOnly,
    }
}

#[cfg(test)]
fn synthetic_rotation(
    supersedes_revision_id: RevisionIdV1,
    required_connection_ids: Vec<EntityIdV1>,
    completed_connection_ids: Vec<EntityIdV1>,
) -> RotationStateV1 {
    RotationStateV1 {
        supersedes_revision_id,
        required_connection_ids,
        completed_connection_ids,
        superseded_external_revocation_status: ExternalRevocationStatusV1::NotRequested,
        superseded_external_revocation_attestation: ExternalRevocationAttestationV1::None,
        superseded_revoked_at: None,
    }
}

#[cfg(test)]
fn synthetic_timestamp() -> UtcTimestampV1 {
    UtcTimestampV1::new("2026-08-15T12:00:00Z".to_owned())
        .expect("the synthetic timestamp is valid")
}

#[cfg(test)]
fn entity_id(value: u8) -> EntityIdV1 {
    EntityIdV1::from_bytes([value; 16])
}

#[cfg(test)]
#[path = "model_tests.rs"]
mod tests;
