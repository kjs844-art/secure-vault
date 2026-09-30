use vault_client_bridge::ClientCatalogEntryViewV1;

fn require_debug<T: std::fmt::Debug>() {}

fn main() {
    require_debug::<ClientCatalogEntryViewV1<'static>>();
}
