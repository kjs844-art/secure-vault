//! Synthetic-only experimental cryptography core for Secure Vault.
//!
//! The `v0alpha1` suite is not approved for real Secret storage.

#![forbid(unsafe_code)]

mod error;
mod v0alpha1;

pub use error::{CryptoError, CryptoErrorCode};
pub use v0alpha1::codec::{inspect_password_envelope_v0alpha1, inspect_record_envelope_v0alpha1};
