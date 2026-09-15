use vault_local_sqlite_vfs_windows::{
    PINNED_SQLITE_VERSION_V1, PlatformDispositionV1, platform_disposition_v1,
};

#[test]
fn crate_records_manifest_msrv_and_sqlite_contract() {
    assert_eq!(env!("CARGO_PKG_RUST_VERSION"), "1.95");
    assert_eq!(rusqlite::version(), PINNED_SQLITE_VERSION_V1);
}

#[test]
fn platform_disposition_is_explicit() {
    let expected = if cfg!(windows) {
        PlatformDispositionV1::WindowsProbeAvailable
    } else {
        PlatformDispositionV1::UnsupportedPlatform
    };
    assert_eq!(platform_disposition_v1(), expected);
}
