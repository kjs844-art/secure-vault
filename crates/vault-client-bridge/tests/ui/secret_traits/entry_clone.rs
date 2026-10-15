use vault_client_bridge::ClientCatalogEntryViewV1;

fn require_clone<T: Clone>() {}

fn main() {
    require_clone::<ClientCatalogEntryViewV1<'static>>();
}
