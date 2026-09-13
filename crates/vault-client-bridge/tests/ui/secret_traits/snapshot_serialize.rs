use vault_client_bridge::ClientCatalogSnapshotV1;

fn require_serialize<T: serde::Serialize>() {}

fn main() {
    require_serialize::<ClientCatalogSnapshotV1>();
}
