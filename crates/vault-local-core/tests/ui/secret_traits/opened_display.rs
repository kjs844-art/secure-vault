use vault_local_core::OpenedCredentialV1;

fn require_display<T: core::fmt::Display>() {}

fn main() {
    require_display::<OpenedCredentialV1>();
}
