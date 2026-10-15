use vault_client_bridge::ClientCatalogSnapshotV1;

fn require_display<T: std::fmt::Display>() {}

fn main() {
    require_display::<ClientCatalogSnapshotV1>();
}
