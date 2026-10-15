use vault_client_bridge::ClientCatalogEntryViewV1;

fn expose_stable_revision(entry: &ClientCatalogEntryViewV1<'_>) {
    let _ = entry.revision_id();
}

fn main() {}
