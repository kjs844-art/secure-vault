use vault_local_core::CredentialCatalogProjectionV1;

fn expose(projection: &CredentialCatalogProjectionV1) {
    let _ = projection.secret_value();
}

fn main() {}
