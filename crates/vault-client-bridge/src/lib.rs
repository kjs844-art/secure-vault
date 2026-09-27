//! Platform-neutral client boundary for the synthetic-only KeyAtlas alpha.
//!
//! The catalog produced here is secret-value-free, but its names and issuer fields are private
//! metadata. Keep it inside an unlocked local UI. It is not safe for logs,
//! analytics, AI prompts, or network transfer.

#![forbid(unsafe_code)]

use std::collections::BTreeSet;

use vault_crypto::VaultSession;
pub use vault_local_core::{
    CatalogConnectionTypeV1, CatalogConnectionViewV1, CatalogCredentialStatusV1,
    CatalogCredentialTypeV1,
};
use vault_local_core::{
    CredentialCatalogProjectionV1, LocalVaultError, LocalVaultErrorCode, OpenCredentialOutcome,
    OwnedRehydratedCredentialV1, open_credential_record_v1,
};

pub const CLIENT_CATALOG_ENTRY_LIMIT_V1: usize = 5_000;

pub const fn client_catalog_entry_count_is_supported_v1(entry_count: usize) -> bool {
    entry_count <= CLIENT_CATALOG_ENTRY_LIMIT_V1
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClientBridgeErrorCodeV1 {
    NonCanonicalEncoding,
    InvalidItem,
    LimitsExceeded,
    AuthenticationFailed,
    RngUnavailable,
    CryptoFailure,
    UpgradeRequired,
}

#[derive(Debug, thiserror::Error)]
pub enum ClientBridgeErrorV1 {
    #[error("credential payload is not canonical")]
    NonCanonicalEncoding,
    #[error("credential item is invalid")]
    InvalidItem,
    #[error("credential item limit exceeded")]
    LimitsExceeded,
    #[error("record authentication failed")]
    AuthenticationFailed,
    #[error("operating-system randomness unavailable")]
    RngUnavailable,
    #[error("cryptographic operation failed")]
    CryptoFailure,
    #[error("a newer client is required to open this catalog")]
    UpgradeRequired,
}

/// An owned catalog for one unlocked local UI session.
///
/// The type intentionally has no `Clone`, `Debug`, `Display`, or serialization
/// implementation. Callers can inspect one allowlisted entry at a time.
pub struct ClientCatalogSnapshotV1 {
    entries: Vec<CredentialCatalogProjectionV1>,
}

/// Borrowed allowlist view of one catalog row.
///
/// `reference` is meaningful only while the parent snapshot remains alive. No
/// stable record or revision identifier crosses this client boundary.
/// Issuer account, workspace, project, and environment are private local display
/// metadata, not an AI projection. Other metadata is deliberately inaccessible:
///
/// ```compile_fail
/// use vault_client_bridge::ClientCatalogEntryViewV1;
/// fn read(entry: &ClientCatalogEntryViewV1<'_>) { let _ = entry.notes(); }
/// ```
/// ```compile_fail
/// use vault_client_bridge::ClientCatalogEntryViewV1;
/// fn read(entry: &ClientCatalogEntryViewV1<'_>) { let _ = entry.console_url(); }
/// ```
/// ```compile_fail
/// use vault_client_bridge::ClientCatalogEntryViewV1;
/// fn read(entry: &ClientCatalogEntryViewV1<'_>) { let _ = entry.issuer_account_ref(); }
/// ```
/// ```compile_fail
/// use vault_client_bridge::ClientCatalogEntryViewV1;
/// fn read(entry: &ClientCatalogEntryViewV1<'_>) { let _ = entry.issuer_project_ref(); }
/// ```
pub struct ClientCatalogEntryViewV1<'snapshot> {
    reference: u32,
    projection: &'snapshot CredentialCatalogProjectionV1,
}

impl ClientCatalogSnapshotV1 {
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn entry(&self, reference: u32) -> Option<ClientCatalogEntryViewV1<'_>> {
        let index = usize::try_from(reference).ok()?;
        let projection = self.entries.get(index)?;
        Some(ClientCatalogEntryViewV1 {
            reference,
            projection,
        })
    }
}

impl ClientCatalogEntryViewV1<'_> {
    pub const fn reference(&self) -> u32 {
        self.reference
    }

    pub fn item_name(&self) -> &str {
        self.projection.item_name()
    }

    pub fn provider_name(&self) -> &str {
        self.projection.provider_name()
    }

    pub fn issuer_account_identifier(&self) -> Option<&str> {
        self.projection.issuer_account_identifier()
    }

    pub fn issuer_organization_or_workspace(&self) -> Option<&str> {
        self.projection.issuer_organization_or_workspace()
    }

    pub fn issuer_project(&self) -> Option<&str> {
        self.projection.issuer_project()
    }

    pub fn issuer_environment(&self) -> Option<&str> {
        self.projection.issuer_environment()
    }

    pub fn credential_type(&self) -> CatalogCredentialTypeV1 {
        self.projection.credential_type()
    }

    pub fn status(&self) -> CatalogCredentialStatusV1 {
        self.projection.status()
    }

    pub fn connection_count(&self) -> usize {
        self.projection.connection_count()
    }

    pub fn connection(&self, index: usize) -> Option<CatalogConnectionViewV1<'_>> {
        self.projection.connection(index)
    }

    pub fn secret_field_count(&self) -> usize {
        self.projection.secret_field_count()
    }

    pub fn mcp_connection_count(&self) -> usize {
        self.projection.mcp_connection_count()
    }
}

/// Builds a fail-closed, secret-value-free catalog from authenticated heads.
///
/// This function performs no SQLite write, writable-store promotion, network
/// call, logging, or generic serialization. Input ordering is preserved. If
/// any head cannot be opened, the partial catalog is dropped and no snapshot
/// is returned.
///
/// The entry limit and uniqueness of record IDs are checked before any head
/// is decrypted here. Repeating a record, including a different revision of
/// that record, returns [`ClientBridgeErrorV1::InvalidItem`]; this function
/// never silently chooses a revision or deduplicates the input.
///
/// Each input head was individually authenticated when rehydrated, and is
/// opened again with `session`. That does not prove that the input is the
/// complete or current catalog. The caller must obtain canonical heads from
/// the authenticated storage boundary. This projection cannot detect an
/// omitted record, a stale but valid revision, or rollback of an entire store.
pub fn project_authenticated_catalog_v1(
    session: &VaultSession,
    heads: &[OwnedRehydratedCredentialV1],
) -> Result<ClientCatalogSnapshotV1, ClientBridgeErrorV1> {
    enforce_client_catalog_entry_limit_v1(heads.len())?;
    let mut record_ids = BTreeSet::new();
    for head in heads {
        let record_id = head.sealed_record().persistence_projection_v1().record_id();
        if !record_ids.insert(record_id) {
            return Err(ClientBridgeErrorV1::InvalidItem);
        }
    }

    let mut entries = Vec::with_capacity(heads.len());

    for head in heads {
        let opened = match open_credential_record_v1(session, head.sealed_record())
            .map_err(ClientBridgeErrorV1::from)?
        {
            OpenCredentialOutcome::Current(opened) => opened,
            OpenCredentialOutcome::UpgradeRequired => {
                return Err(ClientBridgeErrorV1::UpgradeRequired);
            }
        };
        entries.push(opened.into_catalog_projection_v1());
    }

    Ok(ClientCatalogSnapshotV1 { entries })
}

fn enforce_client_catalog_entry_limit_v1(entry_count: usize) -> Result<(), ClientBridgeErrorV1> {
    if !client_catalog_entry_count_is_supported_v1(entry_count) {
        return Err(ClientBridgeErrorV1::LimitsExceeded);
    }
    Ok(())
}

impl ClientBridgeErrorV1 {
    pub const fn code(&self) -> ClientBridgeErrorCodeV1 {
        match self {
            Self::NonCanonicalEncoding => ClientBridgeErrorCodeV1::NonCanonicalEncoding,
            Self::InvalidItem => ClientBridgeErrorCodeV1::InvalidItem,
            Self::LimitsExceeded => ClientBridgeErrorCodeV1::LimitsExceeded,
            Self::AuthenticationFailed => ClientBridgeErrorCodeV1::AuthenticationFailed,
            Self::RngUnavailable => ClientBridgeErrorCodeV1::RngUnavailable,
            Self::CryptoFailure => ClientBridgeErrorCodeV1::CryptoFailure,
            Self::UpgradeRequired => ClientBridgeErrorCodeV1::UpgradeRequired,
        }
    }
}

impl From<LocalVaultError> for ClientBridgeErrorV1 {
    fn from(error: LocalVaultError) -> Self {
        match error.code() {
            LocalVaultErrorCode::NonCanonicalEncoding => Self::NonCanonicalEncoding,
            LocalVaultErrorCode::InvalidItem => Self::InvalidItem,
            LocalVaultErrorCode::LimitsExceeded => Self::LimitsExceeded,
            LocalVaultErrorCode::AuthenticationFailed => Self::AuthenticationFailed,
            LocalVaultErrorCode::RngUnavailable => Self::RngUnavailable,
            LocalVaultErrorCode::CryptoFailure => Self::CryptoFailure,
        }
    }
}
