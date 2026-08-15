use vault_local_core::OpenedCredentialV1;

fn require_clone<T: Clone>() {}

fn main() {
    require_clone::<OpenedCredentialV1>();
}
