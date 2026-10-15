use vault_client_bridge::ClientCatalogEntryViewV1;

fn expose_secret(entry: &ClientCatalogEntryViewV1<'_>) {
    let _ = entry.secret_value();
}

fn main() {}
