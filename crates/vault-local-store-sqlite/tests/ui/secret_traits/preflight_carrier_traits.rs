use serde::Serialize;
use std::fmt::{Debug, Display};
use vault_local_store_sqlite::{
    AuthenticatedVaultPreflightV1, ExistingVaultPreflightOutcomeV1, ExistingVaultPreflightV1,
    PreflightAuthenticationOutcomeV1,
};

fn requires_debug<T: Debug>() {}
fn requires_display<T: Display>() {}
fn requires_clone<T: Clone>() {}
fn requires_serialize<T: Serialize>() {}

fn main() {
    requires_debug::<ExistingVaultPreflightV1>();
    requires_display::<ExistingVaultPreflightV1>();
    requires_clone::<ExistingVaultPreflightV1>();
    requires_serialize::<ExistingVaultPreflightV1>();

    requires_debug::<AuthenticatedVaultPreflightV1<'static>>();
    requires_display::<AuthenticatedVaultPreflightV1<'static>>();
    requires_clone::<AuthenticatedVaultPreflightV1<'static>>();
    requires_serialize::<AuthenticatedVaultPreflightV1<'static>>();

    requires_debug::<ExistingVaultPreflightOutcomeV1>();
    requires_display::<ExistingVaultPreflightOutcomeV1>();
    requires_clone::<ExistingVaultPreflightOutcomeV1>();
    requires_serialize::<ExistingVaultPreflightOutcomeV1>();

    requires_debug::<PreflightAuthenticationOutcomeV1<'static>>();
    requires_display::<PreflightAuthenticationOutcomeV1<'static>>();
    requires_clone::<PreflightAuthenticationOutcomeV1<'static>>();
    requires_serialize::<PreflightAuthenticationOutcomeV1<'static>>();
}
