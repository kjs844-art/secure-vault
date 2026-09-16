//! Closed synthetic connection selections and connection-only successors.

use vault_crypto::VaultSession;

use crate::LocalVaultError;
use crate::ids::EntityIdV1;
use crate::model::{
    ConnectionV1, ConsumerTypeV1, CredentialItemV1, CredentialStatusV1, CredentialTypeV1,
    FieldRoleV1, McpExecutionPolicyV1, McpTransportV1, SensitivityV1, VerificationSourceV1,
};
use crate::persistence::{SyntheticCredentialSuccessorV1, create_synthetic_edited_successor_v1};
use crate::record::SealedCredentialRecordV0Alpha1;
use crate::registration::{ConnectionFixture, PROFILES, RegistrationProfile, build_connection};

const CATALOG_FIELD: &str = "EXAMPLE_WORKSHOP_API_KEY";
const REGISTRATION_FIELD: &str = "EXAMPLE_API_KEY";

/// Owned, closed, build-included choices; no plaintext credential input.
pub struct SyntheticConnectionSelectionV1 {
    connections: Vec<ConnectionFixture>,
}

impl SyntheticConnectionSelectionV1 {
    /// IDs: 0 = Example MCP, 1 = Example CLI, 2 = Example CI.
    /// Accepts zero to three distinct IDs, preserving the caller's order.
    pub fn from_ids(ids: &[u32]) -> Result<Self, LocalVaultError> {
        if ids.len() > 3 {
            return Err(LocalVaultError::LimitsExceeded);
        }
        let mut seen = 0_u8;
        let mut connections = Vec::with_capacity(ids.len());
        for id in ids {
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
        Ok(Self { connections })
    }
}

/// Authenticates the complete predecessor before editing its connection list.
/// Unrelated payload fields and retained connection objects are moved unchanged.
/// Returns sealed ciphertext and the previous revision as the expected CAS head;
/// success still requires the caller's atomic durable commit.
pub fn create_synthetic_connection_successor_v1(
    session: &VaultSession,
    predecessor: &SealedCredentialRecordV0Alpha1,
    selection: &SyntheticConnectionSelectionV1,
) -> Result<SyntheticCredentialSuccessorV1, LocalVaultError> {
    create_synthetic_edited_successor_v1(session, predecessor, |item| {
        edit_connections(item, selection)
    })
}

pub(crate) struct ConnectionProfile {
    registration: &'static RegistrationProfile,
    catalog: bool,
    field_id: EntityIdV1,
}

impl ConnectionProfile {
    pub(crate) fn from_item(item: &CredentialItemV1) -> Result<Self, LocalVaultError> {
        if item.credential_type != CredentialTypeV1::ApiKey
            || item.rotation_state.is_some()
            || item.status == CredentialStatusV1::Rotating
        {
            return Err(LocalVaultError::InvalidItem);
        }
        let (registration, catalog) = match item.provider_template_id.as_deref() {
            None if item.provider_name == PROFILES[0].provider => (&PROFILES[0], true),
            Some(template) => (
                PROFILES
                    .iter()
                    .find(|profile| {
                        profile.template_id == template && profile.provider == item.provider_name
                    })
                    .ok_or(LocalVaultError::InvalidItem)?,
                false,
            ),
            _ => return Err(LocalVaultError::InvalidItem),
        };
        let label = if catalog {
            CATALOG_FIELD
        } else {
            REGISTRATION_FIELD
        };
        let mut fields = item
            .secret_fields
            .iter()
            .filter(|field| field.label == label);
        let field = fields.next().ok_or(LocalVaultError::InvalidItem)?;
        if fields.next().is_some()
            || !((field.field_role == FieldRoleV1::Secret
                && field.sensitivity == SensitivityV1::Secret)
                || (catalog
                    && field.field_role == FieldRoleV1::Identifier
                    && field.sensitivity == SensitivityV1::PrivateMetadata))
        {
            return Err(LocalVaultError::InvalidItem);
        }
        Ok(Self {
            registration,
            catalog,
            field_id: field.field_id,
        })
    }

    fn field_label(&self) -> &'static str {
        if self.catalog {
            CATALOG_FIELD
        } else {
            REGISTRATION_FIELD
        }
    }

    pub(crate) const fn field_id(&self) -> EntityIdV1 {
        self.field_id
    }

    pub(crate) fn classify(
        &self,
        connection: &ConnectionV1,
    ) -> Result<ConnectionFixture, LocalVaultError> {
        let fixture = match (connection.consumer_type, connection.consumer_name.as_str()) {
            (ConsumerTypeV1::McpServer, "Example MCP") => ConnectionFixture::Mcp,
            (ConsumerTypeV1::Cli, "Example CLI") => ConnectionFixture::Cli,
            (ConsumerTypeV1::CiCd, "Example CI") => ConnectionFixture::Ci,
            _ => return Err(LocalVaultError::InvalidItem),
        };
        let config = if self.catalog {
            self.registration.console_url
        } else {
            "Synthetic local settings (record only)"
        };
        let alias = if self.catalog && fixture != ConnectionFixture::Mcp {
            None
        } else {
            Some(self.field_label())
        };
        if connection.consumer_project.as_deref() != Some(self.registration.project)
            || connection.consumer_environment.as_deref() != Some(self.registration.environment)
            || connection.configuration_reference.as_deref() != Some(config)
            || connection.credential_alias_or_env_name.as_deref() != alias
        {
            return Err(LocalVaultError::InvalidItem);
        }
        match (fixture, connection.mcp_integration.as_ref()) {
            (ConnectionFixture::Mcp, Some(mcp)) => {
                let location = if self.catalog {
                    None
                } else {
                    Some("synthetic-mcp-settings")
                };
                if mcp.transport != McpTransportV1::Stdio
                    || mcp.server_identifier != self.registration.mcp_server
                    || mcp.execution_policy != McpExecutionPolicyV1::RecordOnly
                    || mcp.package_or_executable_reference.is_some()
                    || !mcp.argument_template.is_empty()
                    || mcp.endpoint_url.is_some()
                    || mcp.configuration_location.as_deref() != location
                    || mcp.credential_field_bindings.len() != 1
                    || mcp.credential_field_bindings[0].configuration_key_name != self.field_label()
                    || mcp.credential_field_bindings[0].field_id != self.field_id
                {
                    return Err(LocalVaultError::InvalidItem);
                }
            }
            (ConnectionFixture::Cli | ConnectionFixture::Ci, None) => {}
            _ => return Err(LocalVaultError::InvalidItem),
        }
        Ok(fixture)
    }

    fn build(&self, fixture: ConnectionFixture) -> Result<ConnectionV1, LocalVaultError> {
        // The shared registration builder draws exactly one new entity ID.
        let mut connection = build_connection(self.registration, fixture, self.field_id)?;
        if self.catalog {
            connection.purpose = None;
            connection.configuration_reference = Some(self.registration.console_url.to_owned());
            connection.credential_alias_or_env_name = if fixture == ConnectionFixture::Mcp {
                Some(CATALOG_FIELD.to_owned())
            } else {
                None
            };
            connection.required_for_cutover = false;
            connection.verification_source = VerificationSourceV1::None;
            connection.last_verified_at = None;
            if let Some(mcp) = connection.mcp_integration.as_mut() {
                mcp.credential_field_bindings[0].configuration_key_name = CATALOG_FIELD.to_owned();
                mcp.configuration_location = None;
            }
        }
        Ok(connection)
    }
}

fn edit_connections(
    item: &mut CredentialItemV1,
    selection: &SyntheticConnectionSelectionV1,
) -> Result<(), LocalVaultError> {
    let profile = ConnectionProfile::from_item(item)?;
    // Validate every existing connection, including ones being removed. A label
    // or matching ID alone cannot establish known fixture semantics.
    let mut fixtures = Vec::with_capacity(item.connections.len());
    for connection in &item.connections {
        let fixture = profile.classify(connection)?;
        if fixtures.contains(&fixture) {
            return Err(LocalVaultError::InvalidItem);
        }
        fixtures.push(fixture);
    }
    let mut previous: Vec<_> = fixtures
        .into_iter()
        .zip(std::mem::take(&mut item.connections))
        .collect();
    let mut selected = Vec::with_capacity(selection.connections.len());
    for fixture in &selection.connections {
        let connection = if let Some(index) = previous.iter().position(|(old, _)| old == fixture) {
            previous.remove(index).1
        } else {
            profile.build(*fixture)?
        };
        selected.push(connection);
    }
    item.connections = selected;
    Ok(())
}

#[cfg(test)]
#[path = "connection_edit_tests.rs"]
mod tests;
