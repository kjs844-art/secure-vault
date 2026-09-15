use rusqlite::Connection;
use vault_local_core::OwnedRehydratedCredentialV1;

use crate::StoreLockV1;

/// A locked writable handle for the synthetic-only ciphertext store.
pub struct SyntheticWritableStoreV1 {
    pub(crate) connection: Connection,
    #[allow(dead_code, reason = "the owned guard enforces the store lock lifetime")]
    pub(crate) lock: StoreLockV1,
    pub(crate) preservation_latched: bool,
    #[cfg(test)]
    pub(crate) sql_access_count: usize,
}

impl SyntheticWritableStoreV1 {
    pub(crate) fn from_initialized(connection: Connection, lock: StoreLockV1) -> Self {
        Self {
            connection,
            lock,
            preservation_latched: false,
            #[cfg(test)]
            sql_access_count: 0,
        }
    }
}

/// The result of the authenticated read-only to writable transition.
pub enum ExistingVaultOpenOutcomeV1 {
    Opened {
        store: SyntheticWritableStoreV1,
        current_heads: Vec<OwnedRehydratedCredentialV1>,
    },
    SchemaUpgradeRequired,
    CryptoUpgradeRequired,
    ReadOnlyPreservation,
}

impl ExistingVaultOpenOutcomeV1 {
    pub(crate) fn opened(
        store: SyntheticWritableStoreV1,
        current_heads: Vec<OwnedRehydratedCredentialV1>,
    ) -> Self {
        Self::Opened {
            store,
            current_heads,
        }
    }

    pub fn current_heads(&self) -> &[OwnedRehydratedCredentialV1] {
        match self {
            Self::Opened { current_heads, .. } => current_heads.as_slice(),
            Self::SchemaUpgradeRequired
            | Self::CryptoUpgradeRequired
            | Self::ReadOnlyPreservation => &[],
        }
    }

    pub fn into_parts(
        self,
    ) -> Option<(SyntheticWritableStoreV1, Vec<OwnedRehydratedCredentialV1>)> {
        match self {
            Self::Opened {
                store,
                current_heads,
            } => Some((store, current_heads)),
            Self::SchemaUpgradeRequired
            | Self::CryptoUpgradeRequired
            | Self::ReadOnlyPreservation => None,
        }
    }
}
