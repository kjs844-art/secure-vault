use vault_client_bridge::ClientCatalogEntryViewV1;

fn require_serialize<T: serde::Serialize>() {}

fn main() {
    require_serialize::<ClientCatalogEntryViewV1<'static>>();
}
