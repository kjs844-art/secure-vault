use vault_local_core::OpenedCredentialV1;

fn require_debug<T: core::fmt::Debug>() {}

fn main() {
    require_debug::<OpenedCredentialV1>();
}
