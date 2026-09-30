use zeroize::Zeroize;

use crate::ids::{RecordIdV1, RevisionIdV1};
use crate::model::{ConsumerTypeV1, CredentialItemV1, CredentialStatusV1, CredentialTypeV1};

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum CatalogCredentialTypeV1 {
    Password,
    ApiKey,
    OauthClient,
    CloudAccessKey,
    Token,
    RecoveryCode,
    Custom,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum CatalogCredentialStatusV1 {
    Active,
    RotationDue,
    Rotating,
    Expired,
    Compromised,
    Revoked,
    Disabled,
    Unknown,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum CatalogConnectionTypeV1 {
    App,
    BrowserExtension,
    Plugin,
    McpServer,
    Cli,
    Server,
    CiCd,
    CloudProject,
    Custom,
}

struct CatalogConnectionProjectionV1 {
    consumer_type: CatalogConnectionTypeV1,
    label: String,
}

/// Borrowed private-metadata view of one connection in an unlocked catalog.
///
/// Only the consumer type and display label are exposed. Connection identifiers,
/// URLs, account identifiers, bindings, and secret values stay outside this view.
/// The view intentionally has no `Clone`, `Debug`, or serialization implementation.
pub struct CatalogConnectionViewV1<'catalog> {
    projection: &'catalog CatalogConnectionProjectionV1,
}

impl CatalogConnectionViewV1<'_> {
    pub fn consumer_type(&self) -> CatalogConnectionTypeV1 {
        self.projection.consumer_type
    }

    pub fn label(&self) -> &str {
        &self.projection.label
    }
}

/// Owned, secret-value-free projection intended for an unlocked local UI catalog.
///
/// Item, provider, issuer metadata, and connection labels remain private metadata.
/// This type is not safe for AI prompts, analytics, logs, or network transfer.
/// It intentionally has no secret values, notes, URLs, connection identifiers,
/// bindings, serialization implementation, or public constructor. The four
/// optional issuer display fields retain absence and empty strings without
/// normalization; each authenticated source field is at most 256 UTF-8 bytes.
pub struct CredentialCatalogProjectionV1 {
    record_id: RecordIdV1,
    revision_id: RevisionIdV1,
    item_name: String,
    provider_name: String,
    issuer_account_identifier: Option<String>,
    issuer_organization_or_workspace: Option<String>,
    issuer_project: Option<String>,
    issuer_environment: Option<String>,
    credential_type: CatalogCredentialTypeV1,
    status: CatalogCredentialStatusV1,
    connections: Vec<CatalogConnectionProjectionV1>,
    secret_field_count: usize,
    mcp_connection_count: usize,
}

impl CredentialCatalogProjectionV1 {
    pub(crate) fn from_item(
        record_id: RecordIdV1,
        revision_id: RevisionIdV1,
        item: CredentialItemV1,
    ) -> Self {
        let secret_field_count = item.secret_fields.len();
        let mcp_connection_count = item
            .connections
            .iter()
            .filter(|connection| connection.consumer_type == ConsumerTypeV1::McpServer)
            .count();
        let connections = item
            .connections
            .into_iter()
            .map(|connection| CatalogConnectionProjectionV1 {
                consumer_type: connection.consumer_type.into(),
                label: connection.consumer_name,
            })
            .collect();

        Self {
            record_id,
            revision_id,
            item_name: item.item_name,
            provider_name: item.provider_name,
            issuer_account_identifier: item.issuer_account_identifier,
            issuer_organization_or_workspace: item.issuer_organization_or_workspace,
            issuer_project: item.issuer_project,
            issuer_environment: item.issuer_environment,
            credential_type: item.credential_type.into(),
            status: item.status.into(),
            connections,
            secret_field_count,
            mcp_connection_count,
        }
    }

    pub const fn record_id(&self) -> RecordIdV1 {
        self.record_id
    }

    pub const fn revision_id(&self) -> RevisionIdV1 {
        self.revision_id
    }

    pub fn item_name(&self) -> &str {
        &self.item_name
    }

    pub fn provider_name(&self) -> &str {
        &self.provider_name
    }

    pub fn issuer_account_identifier(&self) -> Option<&str> {
        self.issuer_account_identifier.as_deref()
    }

    pub fn issuer_organization_or_workspace(&self) -> Option<&str> {
        self.issuer_organization_or_workspace.as_deref()
    }

    pub fn issuer_project(&self) -> Option<&str> {
        self.issuer_project.as_deref()
    }

    pub fn issuer_environment(&self) -> Option<&str> {
        self.issuer_environment.as_deref()
    }

    pub fn credential_type(&self) -> CatalogCredentialTypeV1 {
        self.credential_type
    }

    pub fn status(&self) -> CatalogCredentialStatusV1 {
        self.status
    }

    pub fn connection_count(&self) -> usize {
        self.connections.len()
    }

    /// Returns an allowlisted connection view in its authenticated source order.
    pub fn connection(&self, index: usize) -> Option<CatalogConnectionViewV1<'_>> {
        let projection = self.connections.get(index)?;
        Some(CatalogConnectionViewV1 { projection })
    }

    pub fn secret_field_count(&self) -> usize {
        self.secret_field_count
    }

    pub fn mcp_connection_count(&self) -> usize {
        self.mcp_connection_count
    }
}

impl From<CredentialTypeV1> for CatalogCredentialTypeV1 {
    fn from(value: CredentialTypeV1) -> Self {
        match value {
            CredentialTypeV1::Password => Self::Password,
            CredentialTypeV1::ApiKey => Self::ApiKey,
            CredentialTypeV1::OauthClient => Self::OauthClient,
            CredentialTypeV1::CloudAccessKey => Self::CloudAccessKey,
            CredentialTypeV1::Token => Self::Token,
            CredentialTypeV1::RecoveryCode => Self::RecoveryCode,
            CredentialTypeV1::Custom => Self::Custom,
        }
    }
}

impl From<CredentialStatusV1> for CatalogCredentialStatusV1 {
    fn from(value: CredentialStatusV1) -> Self {
        match value {
            CredentialStatusV1::Active => Self::Active,
            CredentialStatusV1::RotationDue => Self::RotationDue,
            CredentialStatusV1::Rotating => Self::Rotating,
            CredentialStatusV1::Expired => Self::Expired,
            CredentialStatusV1::Compromised => Self::Compromised,
            CredentialStatusV1::Revoked => Self::Revoked,
            CredentialStatusV1::Disabled => Self::Disabled,
            CredentialStatusV1::Unknown => Self::Unknown,
        }
    }
}

impl From<ConsumerTypeV1> for CatalogConnectionTypeV1 {
    fn from(value: ConsumerTypeV1) -> Self {
        match value {
            ConsumerTypeV1::App => Self::App,
            ConsumerTypeV1::BrowserExtension => Self::BrowserExtension,
            ConsumerTypeV1::Plugin => Self::Plugin,
            ConsumerTypeV1::McpServer => Self::McpServer,
            ConsumerTypeV1::Cli => Self::Cli,
            ConsumerTypeV1::Server => Self::Server,
            ConsumerTypeV1::CiCd => Self::CiCd,
            ConsumerTypeV1::CloudProject => Self::CloudProject,
            ConsumerTypeV1::Custom => Self::Custom,
        }
    }
}

impl Drop for CatalogConnectionProjectionV1 {
    fn drop(&mut self) {
        self.label.zeroize();
    }
}

impl Drop for CredentialCatalogProjectionV1 {
    fn drop(&mut self) {
        self.item_name.zeroize();
        self.provider_name.zeroize();
        self.issuer_account_identifier.zeroize();
        self.issuer_organization_or_workspace.zeroize();
        self.issuer_project.zeroize();
        self.issuer_environment.zeroize();
    }
}

#[cfg(test)]
mod tests {
    use super::{CatalogConnectionTypeV1, ConsumerTypeV1, CredentialCatalogProjectionV1};
    use crate::ids::generate_record_identity;
    use crate::synthetic::{SyntheticCredentialFixtureId, build_synthetic_fixture_v1};

    #[test]
    fn issuer_projection_preserves_absence_empty_and_utf8_limit_values() {
        // These are test-only decoded payloads, not new public fixture inputs.
        let maximum = format!("{}a", "계".repeat(85));
        assert_eq!(maximum.len(), 256);
        for value in [None, Some(String::new()), Some(maximum)] {
            let mut item =
                build_synthetic_fixture_v1(SyntheticCredentialFixtureId::UnconnectedApiKey)
                    .unwrap();
            item.issuer_account_identifier = value.clone();
            item.issuer_organization_or_workspace = value.clone();
            item.issuer_project = value.clone();
            item.issuer_environment = value.clone();
            let identity = generate_record_identity().unwrap();
            item.validate(identity.revision_id).unwrap();
            let projection = CredentialCatalogProjectionV1::from_item(
                identity.record_id,
                identity.revision_id,
                item,
            );
            assert!(projection.issuer_account_identifier() == value.as_deref());
            assert!(projection.issuer_organization_or_workspace() == value.as_deref());
            assert!(projection.issuer_project() == value.as_deref());
            assert!(projection.issuer_environment() == value.as_deref());
        }
    }

    #[test]
    fn issuer_projection_moves_the_owned_source_strings_without_cloning() {
        let mut item =
            build_synthetic_fixture_v1(SyntheticCredentialFixtureId::UnconnectedApiKey).unwrap();
        item.issuer_organization_or_workspace = Some("DEMO_VALUE_ONLY_workspace".to_owned());
        let pointers = [
            item.issuer_account_identifier.as_ref().unwrap().as_ptr(),
            item.issuer_organization_or_workspace
                .as_ref()
                .unwrap()
                .as_ptr(),
            item.issuer_project.as_ref().unwrap().as_ptr(),
            item.issuer_environment.as_ref().unwrap().as_ptr(),
        ];
        let identity = generate_record_identity().unwrap();
        item.validate(identity.revision_id).unwrap();
        let projection = CredentialCatalogProjectionV1::from_item(
            identity.record_id,
            identity.revision_id,
            item,
        );
        for (source, projected) in pointers.into_iter().zip([
            projection.issuer_account_identifier(),
            projection.issuer_organization_or_workspace(),
            projection.issuer_project(),
            projection.issuer_environment(),
        ]) {
            assert!(
                source == projected.unwrap().as_ptr(),
                "source metadata ownership must move"
            );
        }
    }

    #[test]
    fn every_consumer_type_maps_to_its_allowlisted_catalog_type() {
        let cases = [
            (ConsumerTypeV1::App, CatalogConnectionTypeV1::App),
            (
                ConsumerTypeV1::BrowserExtension,
                CatalogConnectionTypeV1::BrowserExtension,
            ),
            (ConsumerTypeV1::Plugin, CatalogConnectionTypeV1::Plugin),
            (
                ConsumerTypeV1::McpServer,
                CatalogConnectionTypeV1::McpServer,
            ),
            (ConsumerTypeV1::Cli, CatalogConnectionTypeV1::Cli),
            (ConsumerTypeV1::Server, CatalogConnectionTypeV1::Server),
            (ConsumerTypeV1::CiCd, CatalogConnectionTypeV1::CiCd),
            (
                ConsumerTypeV1::CloudProject,
                CatalogConnectionTypeV1::CloudProject,
            ),
            (ConsumerTypeV1::Custom, CatalogConnectionTypeV1::Custom),
        ];

        for (consumer_type, catalog_type) in cases {
            assert!(CatalogConnectionTypeV1::from(consumer_type) == catalog_type);
        }
    }
}
