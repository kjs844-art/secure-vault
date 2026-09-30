use vault_local_core::CredentialCatalogProjectionV1;

fn require_serialize<T: serde::Serialize>() {}

fn main() {
    require_serialize::<CredentialCatalogProjectionV1>();
}
