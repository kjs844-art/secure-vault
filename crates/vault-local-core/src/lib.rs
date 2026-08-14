//! Synthetic-only credential relationship core for Secure Vault.
//!
//! This alpha crate is not approved for real passwords, API keys, or recovery data.

#![forbid(unsafe_code)]

mod codec;
mod error;
mod ids;
mod model;
mod secret;

pub use error::{LocalVaultError, LocalVaultErrorCode};
pub use ids::{RecordIdV1, RevisionIdV1};
