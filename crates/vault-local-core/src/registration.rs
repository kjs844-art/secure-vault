//! Closed, build-included selections for synthetic-only manual registration.
//! No caller-supplied text, secret values, entity IDs, or executable data enter
//! this boundary. These public fixtures provide no real-secret confidentiality.

use vault_crypto::VaultSession;

use crate::LocalVaultError;
use crate::credential_commands::{
    CredentialDraftV1, RegistrationMetadataV1, build_registration_item_v1,
};
use crate::ids::{EntityIdV1, generate_entity_id};
use crate::model::{
    ConnectionStatusV1, ConnectionV1, ConsumerTypeV1, CredentialFieldBindingV1, CredentialItemV1,
    McpExecutionPolicyV1, McpIntegrationV1, McpTransportV1, TimestampProvenanceV1, UtcTimestampV1,
    VerificationSourceV1,
};
use crate::record::{SealedCredentialRecordV0Alpha1, seal_item_v1};
use crate::secret::SecretValueV1;
use crate::synthetic_password::{SyntheticPasswordFixtureIdV1, seal_synthetic_password_fixture_v1};

const API_KEY_VALUE: &[u8] = b"DEMO_VALUE_ONLY_API_KEY_0001";
const FIELD_LABEL: &str = "EXAMPLE_API_KEY";
const FIXTURE_TIMESTAMP: &str = "2026-08-14T00:00:00Z";
const CONFIGURATION_REFERENCE: &str = "Synthetic local settings (record only)";

pub(crate) struct RegistrationProfile {
    pub(crate) template_id: &'static str,
    pub(crate) provider: &'static str,
    item_name: &'static str,
    pub(crate) console_url: &'static str,
    account: &'static str,
    workspace: &'static str,
    pub(crate) project: &'static str,
    pub(crate) environment: &'static str,
    pub(crate) mcp_server: &'static str,
}

pub(crate) const PROFILES: [RegistrationProfile; 2] = [
    RegistrationProfile {
        template_id: "synthetic-workshop-v1",
        provider: "Example AI Workshop",
        item_name: "Example Workshop Registered API Key",
        console_url: "https://console.example.invalid/api-keys",
        account: "demo-account",
        workspace: "demo-workspace",
        project: "demo-project",
        environment: "demo",
        mcp_server: "example-workshop-mcp",
    },
    RegistrationProfile {
        template_id: "synthetic-cloud-lab-v1",
        provider: "Example Cloud Lab",
        item_name: "Example Cloud Lab Registered API Key",
        console_url: "https://console.cloud.example.invalid/api-keys",
        account: "lab-account",
        workspace: "lab-workspace",
        project: "lab-project",
        environment: "staging",
        mcp_server: "example-cloud-lab-mcp",
    },
];

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum ConnectionFixture {
    Mcp,
    Cli,
    Ci,
}

/// Validated local selections, not a credential DTO or authorization token.
/// The private fields prevent replacing the compile-time fixture contents.
pub struct SyntheticRegistrationSelectionV1 {
    kind: RegistrationSelectionKind,
}

enum RegistrationSelectionKind {
    ApiKey {
        profile: &'static RegistrationProfile,
        connections: Vec<ConnectionFixture>,
    },
    Password(SyntheticPasswordFixtureIdV1),
}

impl SyntheticRegistrationSelectionV1 {
    /// API profiles: 0 = Example AI Workshop, 1 = Example Cloud Lab, each with
    /// credential 0 and zero to three distinct connections in selected order:
    /// 0 = Example MCP, 1 = Example CLI, 2 = Example CI.
    /// Password profile: 2 = Example Password Service, with credential 1 for
    /// PasswordOnly or 2 for WithIdentifier and NO connections. All cross-kind
    /// combinations are rejected, never silently replaced or ignored.
    pub fn from_ids(
        profile_id: u32,
        credential_id: u32,
        connection_ids: &[u32],
    ) -> Result<Self, LocalVaultError> {
        if connection_ids.len() > 3 {
            return Err(LocalVaultError::LimitsExceeded);
        }
        let profile = match (profile_id, credential_id) {
            (0, 0) => &PROFILES[0],
            (1, 0) => &PROFILES[1],
            (2, 1 | 2) if connection_ids.is_empty() => {
                let fixture = if credential_id == 1 {
                    SyntheticPasswordFixtureIdV1::PasswordOnly
                } else {
                    SyntheticPasswordFixtureIdV1::WithIdentifier
                };
                return Ok(Self {
                    kind: RegistrationSelectionKind::Password(fixture),
                });
            }
            _ => return Err(LocalVaultError::InvalidItem),
        };
        let mut seen = 0_u8;
        let mut connections = Vec::with_capacity(connection_ids.len());
        for &id in connection_ids {
            let (bit, fixture) = match id {
                0 => (1, ConnectionFixture::Mcp),
                1 => (2, ConnectionFixture::Cli),
                2 => (4, ConnectionFixture::Ci),
                _ => return Err(LocalVaultError::InvalidItem),
            };
            if seen & bit != 0 {
                return Err(LocalVaultError::InvalidItem);
            }
            seen |= bit;
            connections.push(fixture);
        }
        Ok(Self {
            kind: RegistrationSelectionKind::ApiKey {
                profile,
                connections,
            },
        })
    }
}

/// Encrypt one newly registered synthetic credential with its selected
/// connections. All IDs are generated inside Rust, and no plaintext projection
/// or secret value is returned. The caller must durably commit before success.
pub fn seal_synthetic_registration_v1(
    session: &VaultSession,
    selection: &SyntheticRegistrationSelectionV1,
) -> Result<SealedCredentialRecordV0Alpha1, LocalVaultError> {
    match &selection.kind {
        RegistrationSelectionKind::ApiKey {
            profile,
            connections,
        } => seal_item_v1(session, build_api_registration(profile, connections)?),
        RegistrationSelectionKind::Password(fixture) => {
            seal_synthetic_password_fixture_v1(session, *fixture)
        }
    }
}

fn build_api_registration(
    profile: &RegistrationProfile,
    selected_connections: &[ConnectionFixture],
) -> Result<CredentialItemV1, LocalVaultError> {
    let mut item = build_registration_item_v1(
        RegistrationMetadataV1 {
            item_name: profile.item_name.to_owned(),
            provider_template_id: Some(profile.template_id.to_owned()),
            provider_name: profile.provider.to_owned(),
            console_url: Some(profile.console_url.to_owned()),
            issuer_account_identifier: Some(profile.account.to_owned()),
            issuer_organization_or_workspace: Some(profile.workspace.to_owned()),
            issuer_project: Some(profile.project.to_owned()),
            issuer_environment: Some(profile.environment.to_owned()),
            scopes_or_permissions: vec!["demo:read".to_owned()],
            issued_at: Some(timestamp()?),
            timestamp_provenance: TimestampProvenanceV1::ImportedFixture,
            tags: vec!["synthetic-registration".to_owned()],
            notes: Some("Build-included synthetic fixture only.".to_owned()),
            created_at: timestamp()?,
            updated_at: timestamp()?,
        },
        CredentialDraftV1::ApiKey {
            label: FIELD_LABEL.to_owned(),
            value: SecretValueV1::new(API_KEY_VALUE.to_vec())?,
        },
    )?;
    let field_id = item.secret_fields[0].field_id;
    let mut connections = Vec::with_capacity(selected_connections.len());
    for &fixture in selected_connections {
        connections.push(build_connection(profile, fixture, field_id)?);
    }
    item.connections = connections;
    Ok(item)
}

pub(crate) fn build_connection(
    profile: &RegistrationProfile,
    fixture: ConnectionFixture,
    field_id: EntityIdV1,
) -> Result<ConnectionV1, LocalVaultError> {
    let (consumer_type, consumer_name) = match fixture {
        ConnectionFixture::Mcp => (ConsumerTypeV1::McpServer, "Example MCP"),
        ConnectionFixture::Cli => (ConsumerTypeV1::Cli, "Example CLI"),
        ConnectionFixture::Ci => (ConsumerTypeV1::CiCd, "Example CI"),
    };
    let mcp_integration = if matches!(fixture, ConnectionFixture::Mcp) {
        Some(McpIntegrationV1 {
            transport: McpTransportV1::Stdio,
            server_identifier: profile.mcp_server.to_owned(),
            package_or_executable_reference: None,
            argument_template: Vec::new(),
            endpoint_url: None,
            credential_field_bindings: vec![CredentialFieldBindingV1 {
                configuration_key_name: FIELD_LABEL.to_owned(),
                field_id,
            }],
            configuration_location: Some("synthetic-mcp-settings".to_owned()),
            execution_policy: McpExecutionPolicyV1::RecordOnly,
        })
    } else {
        None
    };
    Ok(ConnectionV1 {
        connection_id: generate_entity_id()?,
        consumer_type,
        consumer_name: consumer_name.to_owned(),
        consumer_project: Some(profile.project.to_owned()),
        consumer_environment: Some(profile.environment.to_owned()),
        purpose: Some("Synthetic registration demonstration".to_owned()),
        configuration_reference: Some(CONFIGURATION_REFERENCE.to_owned()),
        credential_alias_or_env_name: Some(FIELD_LABEL.to_owned()),
        required_for_cutover: true,
        status: ConnectionStatusV1::Connected,
        // A recorded synthetic relationship is not a provider verification.
        verification_source: VerificationSourceV1::None,
        last_verified_at: None,
        notes: None,
        mcp_integration,
    })
}

fn timestamp() -> Result<UtcTimestampV1, LocalVaultError> {
    UtcTimestampV1::new(FIXTURE_TIMESTAMP.to_owned())
}

#[cfg(test)]
#[path = "registration_tests.rs"]
mod tests;
