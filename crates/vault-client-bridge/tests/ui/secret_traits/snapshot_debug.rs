use vault_client_bridge::ClientCatalogSnapshotV1;

fn require_debug<T: std::fmt::Debug>() {}

fn main() {
    require_debug::<ClientCatalogSnapshotV1>();
}
