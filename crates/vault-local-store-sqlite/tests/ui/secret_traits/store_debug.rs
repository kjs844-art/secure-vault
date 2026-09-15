use serde::Serialize;
use std::fmt::{Debug, Display};
use vault_local_store_sqlite::{ExistingVaultOpenOutcomeV1, SyntheticWritableStoreV1};

fn requires_debug<T: Debug>() {}
fn requires_display<T: Display>() {}
fn requires_clone<T: Clone>() {}
fn requires_serialize<T: Serialize>() {}

fn main() {
    requires_debug::<SyntheticWritableStoreV1>();
    requires_display::<SyntheticWritableStoreV1>();
    requires_clone::<SyntheticWritableStoreV1>();
    requires_serialize::<SyntheticWritableStoreV1>();
    requires_debug::<ExistingVaultOpenOutcomeV1>();
    requires_display::<ExistingVaultOpenOutcomeV1>();
    requires_clone::<ExistingVaultOpenOutcomeV1>();
    requires_serialize::<ExistingVaultOpenOutcomeV1>();
}
