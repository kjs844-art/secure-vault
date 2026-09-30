use vault_client_bridge::ClientCatalogSnapshotV1;

fn require_clone<T: Clone>() {}

fn main() {
    require_clone::<ClientCatalogSnapshotV1>();
}
