use vault_client_bridge::ClientCatalogEntryViewV1;

fn require_display<T: std::fmt::Display>() {}

fn main() {
    require_display::<ClientCatalogEntryViewV1<'static>>();
}
