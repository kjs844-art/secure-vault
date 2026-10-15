use vault_client_bridge::ClientCatalogEntryViewV1;

fn expose_stable_identity(entry: &ClientCatalogEntryViewV1<'_>) {
    let _ = entry.record_id();
}

fn main() {}
