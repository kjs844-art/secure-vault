use crate::LocalVaultError;
use crate::ids::EntityIdV1;
use crate::model::{
    ConnectionStatusV1, ConnectionV1, ConsumerTypeV1, CopyPolicyV1, CredentialFieldBindingV1,
    CredentialItemV1, CredentialStatusV1, CredentialTypeV1, ExternalRevocationAttestationV1,
    ExternalRevocationStatusV1, FieldRoleV1, McpExecutionPolicyV1, McpIntegrationV1,
    McpTransportV1, RevealPolicyV1, SecretFieldV1, SensitivityV1, TimestampProvenanceV1,
    UtcTimestampV1, VerificationSourceV1,
};
use crate::secret::SecretValueV1;

const PROVIDER_NAME: &str = "Example AI Workshop";
const CONSOLE_URL: &str = "https://console.example.invalid/api-keys";
const ACCOUNT: &str = "demo-account";
const PROJECT: &str = "demo-project";
const ENVIRONMENT: &str = "demo";
const API_KEY_VALUE: &[u8] = b"DEMO_VALUE_ONLY_API_KEY_0001";
const TOKEN_VALUE: &[u8] = b"DEMO_VALUE_ONLY_TOKEN_0002";
const MCP_SERVER: &str = "example-workshop-mcp";
const MCP_BINDING_KEY: &str = "EXAMPLE_WORKSHOP_API_KEY";
const MCP_CONSUMER: &str = "Example MCP";
const CLI_CONSUMER: &str = "Example CLI";
const CI_CONSUMER: &str = "Example CI";
const FIXTURE_TIMESTAMP: &str = "2026-08-14T00:00:00Z";

const ACCOUNT_ID: EntityIdV1 = EntityIdV1::from_bytes([0x01; 16]);
const PROJECT_ID: EntityIdV1 = EntityIdV1::from_bytes([0x02; 16]);
const API_KEY_FIELD_ID: EntityIdV1 = EntityIdV1::from_bytes([0x11; 16]);
const TOKEN_FIELD_ID: EntityIdV1 = EntityIdV1::from_bytes([0x12; 16]);
const MCP_CONNECTION_ID: EntityIdV1 = EntityIdV1::from_bytes([0x21; 16]);
const CLI_CONNECTION_ID: EntityIdV1 = EntityIdV1::from_bytes([0x22; 16]);
const CI_CONNECTION_ID: EntityIdV1 = EntityIdV1::from_bytes([0x23; 16]);

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum SyntheticCredentialFixtureId {
    UnconnectedApiKey,
    SingleMcpConnection,
    MultipleConsumers,
}

pub(crate) fn build_synthetic_fixture_v1(
    fixture: SyntheticCredentialFixtureId,
) -> Result<CredentialItemV1, LocalVaultError> {
    let (secret_fields, connections) = match fixture {
        SyntheticCredentialFixtureId::UnconnectedApiKey => {
            (vec![api_key_field(FieldRoleV1::Secret)?], Vec::new())
        }
        SyntheticCredentialFixtureId::SingleMcpConnection => (
            vec![api_key_field(FieldRoleV1::Secret)?],
            vec![mcp_connection(API_KEY_FIELD_ID, true)?],
        ),
        SyntheticCredentialFixtureId::MultipleConsumers => (
            vec![
                api_key_field(FieldRoleV1::Identifier)?,
                secret_field(
                    TOKEN_FIELD_ID,
                    MCP_SERVER,
                    FieldRoleV1::Secret,
                    SensitivityV1::Secret,
                    TOKEN_VALUE,
                )?,
            ],
            vec![
                mcp_connection(API_KEY_FIELD_ID, false)?,
                connection(CLI_CONNECTION_ID, ConsumerTypeV1::Cli, CLI_CONSUMER)?,
                connection(CI_CONNECTION_ID, ConsumerTypeV1::CiCd, CI_CONSUMER)?,
            ],
        ),
    };

    Ok(CredentialItemV1 {
        item_schema_version: 1,
        parent_revision_id: None,
        item_name: PROVIDER_NAME.to_owned(),
        provider_template_id: None,
        provider_name: PROVIDER_NAME.to_owned(),
        console_url: Some(CONSOLE_URL.to_owned()),
        issuer_account_ref: Some(ACCOUNT_ID),
        issuer_project_ref: Some(PROJECT_ID),
        issuer_account_identifier: Some(ACCOUNT.to_owned()),
        issuer_organization_or_workspace: None,
        issuer_project: Some(PROJECT.to_owned()),
        issuer_environment: Some(ENVIRONMENT.to_owned()),
        credential_type: CredentialTypeV1::ApiKey,
        secret_fields,
        display_hint: None,
        scopes_or_permissions: Vec::new(),
        issued_at: Some(timestamp()?),
        expires_at: None,
        rotate_at: None,
        timestamp_provenance: TimestampProvenanceV1::ImportedFixture,
        status: CredentialStatusV1::Active,
        external_revocation_status: ExternalRevocationStatusV1::NotRequested,
        external_revocation_attestation: ExternalRevocationAttestationV1::None,
        revoked_at: None,
        rotation_state: None,
        connections,
        tags: Vec::new(),
        notes: None,
        created_at: timestamp()?,
        updated_at: timestamp()?,
    })
}

fn api_key_field(field_role: FieldRoleV1) -> Result<SecretFieldV1, LocalVaultError> {
    secret_field(
        API_KEY_FIELD_ID,
        MCP_BINDING_KEY,
        field_role,
        if field_role == FieldRoleV1::Identifier {
            SensitivityV1::PrivateMetadata
        } else {
            SensitivityV1::Secret
        },
        API_KEY_VALUE,
    )
}

fn secret_field(
    field_id: EntityIdV1,
    label: &str,
    field_role: FieldRoleV1,
    sensitivity: SensitivityV1,
    value: &[u8],
) -> Result<SecretFieldV1, LocalVaultError> {
    Ok(SecretFieldV1 {
        field_id,
        label: label.to_owned(),
        field_role,
        sensitivity,
        value: SecretValueV1::new(value.to_vec())?,
        reveal_policy: RevealPolicyV1::RevealAfterReauth,
        copy_policy: CopyPolicyV1::AllowedAfterReauth,
    })
}

fn mcp_connection(
    field_id: EntityIdV1,
    required_for_cutover: bool,
) -> Result<ConnectionV1, LocalVaultError> {
    let mut connection = connection(MCP_CONNECTION_ID, ConsumerTypeV1::McpServer, MCP_CONSUMER)?;
    connection.required_for_cutover = required_for_cutover;
    connection.credential_alias_or_env_name = Some(MCP_BINDING_KEY.to_owned());
    connection.mcp_integration = Some(McpIntegrationV1 {
        transport: McpTransportV1::Stdio,
        server_identifier: MCP_SERVER.to_owned(),
        package_or_executable_reference: None,
        argument_template: Vec::new(),
        endpoint_url: None,
        credential_field_bindings: vec![CredentialFieldBindingV1 {
            configuration_key_name: MCP_BINDING_KEY.to_owned(),
            field_id,
        }],
        configuration_location: None,
        execution_policy: McpExecutionPolicyV1::RecordOnly,
    });
    Ok(connection)
}

fn connection(
    connection_id: EntityIdV1,
    consumer_type: ConsumerTypeV1,
    consumer_name: &str,
) -> Result<ConnectionV1, LocalVaultError> {
    Ok(ConnectionV1 {
        connection_id,
        consumer_type,
        consumer_name: consumer_name.to_owned(),
        consumer_project: Some(PROJECT.to_owned()),
        consumer_environment: Some(ENVIRONMENT.to_owned()),
        purpose: None,
        configuration_reference: Some(CONSOLE_URL.to_owned()),
        credential_alias_or_env_name: None,
        required_for_cutover: false,
        status: ConnectionStatusV1::Connected,
        verification_source: VerificationSourceV1::User,
        last_verified_at: Some(timestamp()?),
        notes: None,
        mcp_integration: None,
    })
}

fn timestamp() -> Result<UtcTimestampV1, LocalVaultError> {
    UtcTimestampV1::new(FIXTURE_TIMESTAMP.to_owned())
}
