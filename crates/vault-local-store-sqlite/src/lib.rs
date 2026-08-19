//! Hardened synthetic-only SQLite storage boundary for Secure Vault.
//!
//! This alpha crate is not approved for real passwords, API keys, or recovery data.

#![forbid(unsafe_code)]
#![cfg_attr(
    not(feature = "test-seams"),
    doc = r#"
The deterministic integration seams are compiled out of ordinary downstream builds and cannot be
named unless the explicit, non-default `test-seams` feature is enabled.

```compile_fail
use vault_local_store_sqlite::ExistingVaultPreflightV1;

let _ = ExistingVaultPreflightV1::writable_open_count_for_test_v1();
```

```compile_fail
use vault_local_store_sqlite::AuthenticatedVaultPreflightV1;

fn cannot_observe_promotion(stage: AuthenticatedVaultPreflightV1<'_>) {
    let _ = stage.promote_with_test_observer_v1(|_| {});
}
```
"#
)]

mod commit;
#[cfg(test)]
mod crash_tests;
mod digest;
mod error;
mod lock;
mod preflight;
mod preflight_query;
mod rows;
mod schema;
mod schema_contract;
mod store;

pub use commit::CommitOutcomeV1;
pub use error::{StorageError, StorageErrorCode};
pub use lock::{StoreLocationPolicyV1, StoreLocationV1, StoreLockV1};
pub use preflight::{
    AuthenticatedVaultPreflightV1, ExistingVaultPreflightOutcomeV1, ExistingVaultPreflightV1,
    PreflightAuthenticationOutcomeV1, preflight_existing_v1,
};
pub use rows::UntrustedStoredRevisionV1;
pub use schema::{InitializeStoreOutcomeV1, SCHEMA_V1_SQL, initialize_v1};
pub use store::{ExistingVaultOpenOutcomeV1, SyntheticWritableStoreV1};
