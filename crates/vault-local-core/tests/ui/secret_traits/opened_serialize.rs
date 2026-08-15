use vault_local_core::OpenedCredentialV1;

fn require_serialize<T: serde::Serialize>() {}

fn main() {
    require_serialize::<OpenedCredentialV1>();
}
