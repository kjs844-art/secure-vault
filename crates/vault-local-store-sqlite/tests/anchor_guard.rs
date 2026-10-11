use std::fs;

use rusqlite::Connection;
use vault_crypto::{
    MasterPassword, PasswordEnvelopeStorageDispositionV1, create_vault_v0alpha1,
    inspect_password_envelope_for_storage_v1, unlock_vault_v0alpha1,
};
use vault_local_core::{
    CredentialStorageAuthenticatorV1, SyntheticCredentialFixtureId, seal_synthetic_fixture_v1,
};
use vault_local_store_sqlite::{
    ExistingVaultPreflightOutcomeV1, InitializeStoreOutcomeV1, PreflightAuthenticationOutcomeV1,
    StoreLocationPolicyV1, StoreLocationV1, TrustedLocalAppDataRootV1, initialize_v1,
    preflight_existing_v1,
};

const PASSWORD_TEXT: &str = "DEMO_VALUE_ONLY_anchor_guard.invalid";

struct AnchorFixture {
    _directory: tempfile::TempDir,
    location: StoreLocationV1,
    #[allow(dead_code)]
    session: vault_crypto::VaultSession,
}

fn committed_fixture() -> AnchorFixture {
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
        InitializeStoreOutcomeV1::AlreadyInitialized => {
            panic!("temporary store was already initialized")
        }
    };
    let sealed = seal_synthetic_fixture_v1(
        &created.session,
        SyntheticCredentialFixtureId::SingleMcpConnection,
    )
    .unwrap();
    store
        .commit_candidate(sealed.persistence_projection_v1())
        .unwrap();
    drop(sealed);
    drop(store);
    AnchorFixture {
        _directory: directory,
        location,
        session: created.session,
    }
}

fn anchor_path(location: &StoreLocationV1) -> std::path::PathBuf {
    let mut name = location.database_path().as_os_str().to_os_string();
    name.push(".anchor");
    std::path::PathBuf::from(name)
}

fn authenticate_with_correct_password(
    location: &StoreLocationV1,
) -> Option<(vault_crypto::VaultSession, Connection)> {
    let preflight = match preflight_existing_v1(location).unwrap() {
        ExistingVaultPreflightOutcomeV1::Current(preflight) => preflight,
        _ => return None,
    };
    let password = MasterPassword::from_utf8(PASSWORD_TEXT.to_owned()).unwrap();
    let Ok(session) = unlock_vault_v0alpha1(&password, preflight.password_envelope()) else {
        return None;
    };
    let authenticator = CredentialStorageAuthenticatorV1::new(&session);
    match preflight
        .authenticate_current_revisions(&authenticator)
        .unwrap()
    {
        PreflightAuthenticationOutcomeV1::Current(_) => {
            Some((session, Connection::open(location.database_path()).unwrap()))
        }
        _ => None,
    }
}

#[test]
fn missing_anchor_sidecar_blocks_authentication_until_promotion_rewrites_it() {
    let fixture = committed_fixture();
    fs::remove_file(anchor_path(&fixture.location)).unwrap();
    assert!(authenticate_with_correct_password(&fixture.location).is_none());
    drop(fixture);
}

#[test]
fn rollback_to_an_earlier_backup_file_is_detected_and_preserved() {
    let fixture = committed_fixture();
    let (session, connection) =
        authenticate_with_correct_password(&fixture.location).expect("fresh fixture must pass");
    let anchor_before = fs::read(anchor_path(&fixture.location)).unwrap();
    let main_before = fs::read(fixture.location.database_path()).unwrap();
    drop(connection);

    let second =
        seal_synthetic_fixture_v1(&session, SyntheticCredentialFixtureId::UnconnectedApiKey)
            .unwrap();
    let preflight = match preflight_existing_v1(&fixture.location).unwrap() {
        ExistingVaultPreflightOutcomeV1::Current(preflight) => preflight,
        _ => panic!("second-commit preflight failed"),
    };
    let authenticator = CredentialStorageAuthenticatorV1::new(&session);
    let authenticated = preflight
        .authenticate_current_revisions(&authenticator)
        .unwrap()
        .into_authenticated()
        .expect("second commit should authenticate");
    let (mut store, _heads) = authenticated
        .promote()
        .unwrap()
        .into_parts()
        .expect("second commit should promote");
    store
        .commit_candidate(second.persistence_projection_v1())
        .unwrap();
    drop(store);
    drop(session);

    fs::write(fixture.location.database_path(), main_before).unwrap();
    fs::write(anchor_path(&fixture.location), anchor_before).unwrap();
    assert!(authenticate_with_correct_password(&fixture.location).is_none());
}

#[test]
fn external_row_deletion_is_detected_and_preserved() {
    let fixture = committed_fixture();
    let (_session, connection) =
        authenticate_with_correct_password(&fixture.location).expect("fresh fixture must pass");
    let anchor_before = fs::read(anchor_path(&fixture.location)).unwrap();
    connection
        .execute_batch("PRAGMA foreign_keys=OFF;")
        .unwrap();
    connection.execute("DELETE FROM heads", []).unwrap();
    connection.execute("DELETE FROM revisions", []).unwrap();
    drop(connection);
    fs::write(anchor_path(&fixture.location), anchor_before).unwrap();
    assert!(authenticate_with_correct_password(&fixture.location).is_none());
}
