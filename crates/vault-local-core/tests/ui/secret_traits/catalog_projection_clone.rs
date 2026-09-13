use vault_local_core::CredentialCatalogProjectionV1;

fn require_clone<T: Clone>() {}

fn main() {
    require_clone::<CredentialCatalogProjectionV1>();
}
