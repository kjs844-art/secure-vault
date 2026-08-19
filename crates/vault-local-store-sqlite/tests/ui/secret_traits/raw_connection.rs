use vault_local_store_sqlite::SyntheticWritableStoreV1;

fn cannot_reach_generic_capabilities(mut store: SyntheticWritableStoreV1) {
    let _ = store.connection();
    let _ = store.execute("SELECT 1");
    let _ = store.spawn("synthetic-child");
    let _ = store.connect("example.invalid:443");
}

fn main() {}
