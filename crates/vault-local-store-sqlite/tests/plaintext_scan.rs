use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use vault_crypto::{
    MasterPassword, PasswordEnvelopeStorageDispositionV1, create_vault_v0alpha1,
    inspect_password_envelope_for_storage_v1, unlock_vault_v0alpha1,
};
use vault_local_core::{
    CredentialStorageAuthenticatorV1, SyntheticCredentialFixtureId, seal_synthetic_fixture_v1,
};
use vault_local_store_sqlite::{
    ExistingVaultPreflightOutcomeV1, InitializeStoreOutcomeV1, StoreLocationPolicyV1,
    TrustedLocalAppDataRootV1, initialize_v1, preflight_existing_v1,
};

const PASSWORD_TEXT: &str = "DEMO_VALUE_ONLY_plaintext_scan_password.invalid";
const MARKERS: [&[u8]; 7] = [
    b"Example AI Workshop",
    b"demo-account",
    b"demo-project",
    b"DEMO_VALUE_ONLY_API_KEY_0001",
    b"example-workshop-mcp",
    b"EXAMPLE_WORKSHOP_API_KEY",
    b"Example CLI",
];

fn files_below(root: &Path) -> Vec<PathBuf> {
    let mut pending = vec![root.to_path_buf()];
    let mut files = Vec::new();
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
            } else if path.is_file() {
                files.push(path);
            }
        }
    }
    files.sort();
    files
}

fn file_role(path: &Path, database: &Path) -> &'static str {
    let name = path.file_name();
    let database_name = database.file_name().unwrap();
    let mut wal_name = OsString::from(database_name);
    wal_name.push("-wal");
    let mut shm_name = OsString::from(database_name);
    shm_name.push("-shm");
    let mut journal_name = OsString::from(database_name);
    journal_name.push("-journal");
    if name == Some(database_name) {
        "main database"
    } else if name == Some(wal_name.as_os_str()) {
        "wal"
    } else if name == Some(shm_name.as_os_str()) {
        "shared memory"
    } else if name == Some(journal_name.as_os_str()) {
        "rollback journal"
    } else if path.to_string_lossy().ends_with(".lock") {
        "lock bookkeeping"
    } else {
        "temporary snapshot candidate"
    }
}

fn read_file_for_scan(path: &Path, role: &str) -> Vec<u8> {
    if role == "lock bookkeeping" {
        return Vec::new();
    }
    #[cfg(windows)]
    if role == "shared memory" {
        use std::fs::File;
        use std::os::windows::fs::FileExt;

        let file = File::open(path).unwrap();
        let length = file.metadata().unwrap().len();
        let mut bytes = Vec::with_capacity(length as usize);
        for offset in 0..length {
            let mut byte = [0_u8; 1];
            match file.seek_read(&mut byte, offset) {
                Ok(1) => bytes.push(byte[0]),
                Ok(_) => panic!("shared-memory scan ended early"),
                Err(error) if error.raw_os_error() == Some(33) => {
                    // SQLite holds byte-range locks in SHM coordination bytes on Windows.
                    // Insert a separator so marker matching cannot cross the unread lock byte.
                    bytes.push(0);
                }
                Err(_) => panic!("shared-memory scan failed outside SQLite lock bookkeeping"),
            }
        }
        return bytes;
    }
    fs::read(path).unwrap()
}

#[test]
fn no_known_synthetic_plaintext_marker_occurs_in_store_files() {
    let directory = tempfile::tempdir().unwrap();
    let trusted_root = TrustedLocalAppDataRootV1::for_current_user().unwrap();
    let policy = StoreLocationPolicyV1::new(&trusted_root, directory.path()).unwrap();
    let location = policy.location("vault.sqlite3").unwrap();
    let password = MasterPassword::from_utf8(PASSWORD_TEXT.to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let PasswordEnvelopeStorageDispositionV1::Current(inspection) =
        inspect_password_envelope_for_storage_v1(&created.password_envelope).unwrap()
    else {
        panic!("synthetic password envelope must be current");
    };
    let mut store = match initialize_v1(&location, inspection.bootstrap_projection()).unwrap() {
        InitializeStoreOutcomeV1::Created(store) => store,
        InitializeStoreOutcomeV1::AlreadyInitialized => panic!("temporary store already existed"),
    };
    for fixture in [
        SyntheticCredentialFixtureId::UnconnectedApiKey,
        SyntheticCredentialFixtureId::SingleMcpConnection,
        SyntheticCredentialFixtureId::MultipleConsumers,
    ] {
        let record = seal_synthetic_fixture_v1(&created.session, fixture).unwrap();
        store
            .commit_candidate(record.persistence_projection_v1())
            .unwrap();
    }
    drop(store);
    drop(created);
    drop(password);

    let preflight = match preflight_existing_v1(&location).unwrap() {
        ExistingVaultPreflightOutcomeV1::Current(preflight) => preflight,
        _ => panic!("synthetic store did not reopen structurally"),
    };
    let password = MasterPassword::from_utf8(PASSWORD_TEXT.to_owned()).unwrap();
    let session = unlock_vault_v0alpha1(&password, preflight.password_envelope()).unwrap();
    let authenticator = CredentialStorageAuthenticatorV1::new(&session);
    let authenticated = preflight
        .authenticate_current_revisions(&authenticator)
        .unwrap()
        .into_authenticated()
        .expect("synthetic revisions should authenticate");
    let opened = authenticated.promote().unwrap();
    let (store, heads) = opened
        .into_parts()
        .expect("authenticated current store should promote");
    assert_eq!(heads.len(), 3);
    drop(heads);

    let scan_connection = Connection::open(location.database_path()).unwrap();
    scan_connection
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    let suite_id: i64 = scan_connection
        .query_row(
            "SELECT password_suite_id FROM vault_state WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    scan_connection
        .execute(
            "UPDATE vault_state SET password_suite_id=?1 WHERE singleton=1",
            [suite_id + 1],
        )
        .unwrap();
    scan_connection
        .execute(
            "UPDATE vault_state SET password_suite_id=?1 WHERE singleton=1",
            [suite_id],
        )
        .unwrap();

    let wal = PathBuf::from(format!("{}-wal", location.database_path().display()));
    assert!(wal.exists(), "wal role was absent before plaintext scan");
    assert!(
        fs::metadata(&wal).unwrap().len() > 0,
        "wal role was empty before plaintext scan"
    );

    let mut scanned_nonempty_wal = false;
    for path in files_below(directory.path()) {
        let role = file_role(&path, location.database_path());
        let bytes = read_file_for_scan(&path, role);
        if role == "wal" {
            scanned_nonempty_wal = !bytes.is_empty();
        }
        for (marker_index, marker) in MARKERS.iter().enumerate() {
            assert!(
                !bytes.windows(marker.len()).any(|window| window == *marker),
                "plaintext marker index {marker_index} found in file role {role}"
            );
        }
    }
    assert!(scanned_nonempty_wal, "non-empty wal role was not scanned");
    drop(scan_connection);
    drop(store);
}
