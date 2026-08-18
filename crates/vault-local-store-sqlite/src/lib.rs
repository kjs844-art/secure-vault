//! Hardened synthetic-only SQLite storage boundary for Secure Vault.
//!
//! This alpha crate is not approved for real passwords, API keys, or recovery data.

#![forbid(unsafe_code)]

mod error;
mod lock;
mod schema;

use rusqlite::Connection;

pub use error::{StorageError, StorageErrorCode};
pub use lock::{StoreLocationPolicyV1, StoreLocationV1, StoreLockV1};
pub use schema::{InitializeStoreOutcomeV1, SCHEMA_V1_SQL, initialize_v1};

/// A newly initialized, locked SQLite store. Candidate commits are added in Task 4.
pub struct SyntheticWritableStoreV1 {
    #[allow(dead_code)]
    pub(crate) connection: Connection,
    #[allow(dead_code)]
    pub(crate) lock: StoreLockV1,
}
