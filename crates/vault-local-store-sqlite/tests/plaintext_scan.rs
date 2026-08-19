use std::fs;
use std::path::{Path, PathBuf};

use vault_crypto::{
    MasterPassword, PasswordEnvelopeStorageDispositionV1, create_vault_v0alpha1,
    inspect_password_envelope_for_storage_v1, unlock_vault_v0alpha1,
};
use vault_local_core::{
    CredentialStorageAuthenticatorV1, SyntheticCredentialFixtureId, seal_synthetic_fixture_v1,
};
use vault_local_store_sqlite::{
    ExistingVaultPreflightOutcomeV1, InitializeStoreOutcomeV1, StoreLocationPolicyV1,
    initialize_v1, preflight_existing_v1,
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
    let text = path.to_string_lossy();
    let database_text = database.to_string_lossy();
    if path == database {
        "main database"
    } else if text == format!("{database_text}-wal") {
        "wal"
    } else if text == format!("{database_text}-shm") {
        "shared memory"
    } else if text == format!("{database_text}-journal") {
        "rollback journal"
    } else if text.ends_with(".lock") {
        "lock bookkeeping"
    } else {
        "temporary snapshot candidate"
    }
}

#[test]
fn no_known_synthetic_plaintext_marker_occurs_in_store_files() {
    let directory = tempfile::tempdir().unwrap();
    let policy = StoreLocationPolicyV1::new(directory.path()).unwrap();
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
    drop(store);

    for path in files_below(directory.path()) {
        let bytes = fs::read(&path).unwrap();
        let role = file_role(&path, location.database_path());
        for (marker_index, marker) in MARKERS.iter().enumerate() {
            assert!(
                !bytes.windows(marker.len()).any(|window| window == *marker),
                "plaintext marker index {marker_index} found in file role {role}"
            );
        }
    }
}
