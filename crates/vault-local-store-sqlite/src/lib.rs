//! Hardened synthetic-only SQLite storage boundary for Secure Vault.
//!
//! This alpha crate is not approved for real passwords, API keys, or recovery data.

#![forbid(unsafe_code)]

mod commit;
mod error;
mod lock;
mod schema;
mod store;

pub use commit::CommitOutcomeV1;
pub use error::{StorageError, StorageErrorCode};
pub use lock::{StoreLocationPolicyV1, StoreLocationV1, StoreLockV1};
pub use schema::{InitializeStoreOutcomeV1, SCHEMA_V1_SQL, initialize_v1};
pub use store::SyntheticWritableStoreV1;
