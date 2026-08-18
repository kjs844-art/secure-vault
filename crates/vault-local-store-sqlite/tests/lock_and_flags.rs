use std::fs;

use tempfile::tempdir;
use vault_crypto::{
    MasterPassword, PasswordEnvelopeStorageDispositionV1, create_vault_v0alpha1,
    inspect_password_envelope_for_storage_v1,
};
use vault_local_store_sqlite::{
    InitializeStoreOutcomeV1, StorageErrorCode, StoreLocationPolicyV1, StoreLockV1, initialize_v1,
};

#[test]
fn adjacent_lock_is_exclusive_and_reacquirable_after_drop() {
    let directory = tempdir().unwrap();
    let policy = StoreLocationPolicyV1::new(directory.path()).unwrap();
    let location = policy.location("vault.sqlite3").unwrap();
    let first = StoreLockV1::try_acquire(&location).unwrap();
    let second_error = match StoreLockV1::try_acquire(&location) {
        Ok(_) => panic!("second process lock was acquired"),
        Err(error) => error,
    };
    assert_eq!(second_error.code(), StorageErrorCode::Busy);
    drop(first);
    StoreLockV1::try_acquire(&location).unwrap();
    assert_eq!(
        location.lock_path().parent(),
        location.database_path().parent()
    );
}

#[test]
fn policy_rejects_relative_parent_repository_cloud_and_uri_locations() {
    let directory = tempdir().unwrap();
    let policy = StoreLocationPolicyV1::new(directory.path()).unwrap();
    for path in [
        "../escape.sqlite3",
        ".git/vault.sqlite3",
        "OneDrive/vault.sqlite3",
        "file:vault.sqlite3?mode=rwc",
    ] {
        let error = match policy.location(path) {
            Ok(_) => panic!("disallowed location was accepted"),
            Err(error) => error,
        };
        assert_eq!(
            error.code(),
            StorageErrorCode::UnsupportedPlatform,
            "{path}"
        );
    }
    let relative_error = match StoreLocationPolicyV1::new(std::path::Path::new("relative-root")) {
        Ok(_) => panic!("relative app root was accepted"),
        Err(error) => error,
    };
    assert_eq!(relative_error.code(), StorageErrorCode::UnsupportedPlatform);
}

#[test]
fn policy_rejects_deep_repository_ancestors_and_provider_prefixed_cloud_roots() {
    let trusted_root = tempdir().unwrap();
    let marker_parent = trusted_root.path().join("a/b");
    fs::create_dir_all(marker_parent.join(".git")).unwrap();
    fs::create_dir_all(marker_parent.join("c/d/e")).unwrap();
    let policy = StoreLocationPolicyV1::new(trusted_root.path()).unwrap();
    let repository_error = match policy.location("a/b/c/d/e/vault.sqlite3") {
        Ok(_) => panic!("deep repository descendant was accepted"),
        Err(error) => error,
    };
    assert_eq!(
        repository_error.code(),
        StorageErrorCode::UnsupportedPlatform
    );

    for provider_root in [
        "OneDrive - Personal",
        "Dropbox - Company",
        "Google Drive - Company",
        "iCloud Drive - Personal",
    ] {
        let cloud_parent = trusted_root.path().join(provider_root).join("SecureVault");
        fs::create_dir_all(&cloud_parent).unwrap();
        let cloud_error =
            match policy.location(format!("{provider_root}/SecureVault/vault.sqlite3")) {
                Ok(_) => panic!("provider-prefixed cloud descendant was accepted"),
                Err(error) => error,
            };
        assert_eq!(
            cloud_error.code(),
            StorageErrorCode::UnsupportedPlatform,
            "{provider_root}"
        );
    }

    let repository_above_root = tempdir().unwrap();
    fs::create_dir(repository_above_root.path().join(".git")).unwrap();
    let trusted_app_data = repository_above_root.path().join("trusted-app-data");
    fs::create_dir(&trusted_app_data).unwrap();
    let policy = StoreLocationPolicyV1::new(&trusted_app_data).unwrap();
    policy.location("vault.sqlite3").unwrap();
}

#[test]
fn failed_zero_byte_initialization_restores_pre_call_state_and_can_retry() {
    let directory = tempdir().unwrap();
    let policy = StoreLocationPolicyV1::new(directory.path()).unwrap();
    let location = policy.location("vault.sqlite3").unwrap();
    fs::write(location.database_path(), []).unwrap();

    let invalid = [0x81_u8, 0x01];
    assert!(inspect_password_envelope_for_storage_v1(&invalid).is_ok());
    let password =
        MasterPassword::from_utf8("synthetic sqlite atomic initialization phrase".to_owned())
            .unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let disposition = inspect_password_envelope_for_storage_v1(&created.password_envelope).unwrap();
    let PasswordEnvelopeStorageDispositionV1::Current(inspection) = disposition else {
        panic!("synthetic current envelope was not current");
    };

    let outcome = initialize_v1(&location, inspection.bootstrap_projection()).unwrap();
    assert!(matches!(outcome, InitializeStoreOutcomeV1::Created(_)));
}

#[test]
fn runtime_and_source_lock_extension_and_open_flag_contract() {
    assert_eq!(rusqlite::version(), "3.53.2");
    let source = [
        include_str!("../src/lib.rs"),
        include_str!("../src/lock.rs"),
        include_str!("../src/schema.rs"),
    ]
    .join("\n");
    assert!(source.contains("load_extension_disable"));
    assert!(!source.contains("load_extension_enable"));
    assert!(!source.contains("load_extension("));
    assert!(!source.contains("SQLITE_OPEN_URI"));
    for required in [
        "SQLITE_OPEN_NO_MUTEX",
        "SQLITE_OPEN_PRIVATE_CACHE",
        "SQLITE_OPEN_NOFOLLOW",
        "SQLITE_OPEN_EXRESCODE",
    ] {
        assert!(source.contains(required), "missing {required}");
    }
}
