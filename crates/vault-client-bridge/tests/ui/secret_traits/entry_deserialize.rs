use vault_client_bridge::ClientCatalogEntryViewV1;

fn require_deserialize<T: for<'de> serde::Deserialize<'de>>() {}

fn main() {
    require_deserialize::<ClientCatalogEntryViewV1<'static>>();
}
