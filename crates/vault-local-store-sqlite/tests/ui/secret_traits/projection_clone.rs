use serde::Serialize;
use std::fmt::{Debug, Display};
use vault_local_core::CredentialCommitPersistenceProjectionV1;
use vault_local_store_sqlite::UntrustedStoredRevisionV1;

fn requires_clone<T: Clone>() {}
fn requires_debug<T: Debug>() {}
fn requires_display<T: Display>() {}
fn requires_serialize<T: Serialize>() {}

fn main() {
    requires_clone::<CredentialCommitPersistenceProjectionV1<'static>>();
    requires_debug::<CredentialCommitPersistenceProjectionV1<'static>>();
    requires_display::<CredentialCommitPersistenceProjectionV1<'static>>();
    requires_serialize::<CredentialCommitPersistenceProjectionV1<'static>>();
    requires_clone::<UntrustedStoredRevisionV1<'static>>();
    requires_debug::<UntrustedStoredRevisionV1<'static>>();
    requires_display::<UntrustedStoredRevisionV1<'static>>();
    requires_serialize::<UntrustedStoredRevisionV1<'static>>();
}
