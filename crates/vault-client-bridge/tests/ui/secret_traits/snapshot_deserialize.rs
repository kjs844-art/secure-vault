use vault_client_bridge::ClientCatalogSnapshotV1;

fn require_deserialize<T: for<'de> serde::Deserialize<'de>>() {}

fn main() {
    require_deserialize::<ClientCatalogSnapshotV1>();
}
