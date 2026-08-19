use std::path::PathBuf;

use vault_local_store_sqlite::TrustedLocalAppDataRootV1;

fn main() {
    let _ = TrustedLocalAppDataRootV1 {
        app_root: PathBuf::from(r"Z:\mapped-remote"),
    };
}
