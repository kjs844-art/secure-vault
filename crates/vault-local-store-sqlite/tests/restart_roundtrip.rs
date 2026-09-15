use std::fs;

use rusqlite::Connection;
use tempfile::TempDir;
use vault_crypto::{
    MasterPassword, PasswordEnvelopeStorageDispositionV1, create_vault_v0alpha1,
    inspect_password_envelope_for_storage_v1, unlock_vault_v0alpha1,
};
use vault_local_core::{
    CredentialCommitPersistenceProjectionV1, CredentialStorageAuthenticatorV1,
    OpenCredentialOutcome, StoredPaddingBucketV0Alpha1, SyntheticCredentialFixtureId,
    open_credential_record_v1, seal_synthetic_fixture_v1,
};
#[cfg(feature = "test-seams")]
use vault_local_store_sqlite::StorageErrorCode;
use vault_local_store_sqlite::{
    ExistingVaultPreflightOutcomeV1, ExistingVaultPreflightV1, InitializeStoreOutcomeV1,
    StoreLocationPolicyV1, StoreLocationV1, TrustedLocalAppDataRootV1, initialize_v1,
    preflight_existing_v1,
};

const PASSWORD_TEXT: &str = "DEMO_VALUE_ONLY_restart_roundtrip.invalid";

#[test]
fn opened_plaintext_is_never_formatted_by_task_six_assertions() {
    let source = include_str!("restart_roundtrip.rs");
    let forbidden_provider_assertion = ["assert_", "eq!(opened.provider_name()"].concat();
    let forbidden_item_assertion = ["assert_", "eq!(opened.item_name()"].concat();
    let forbidden_file_bytes_assertion = ["assert_", "eq!(fs::read"].concat();
    let forbidden_multiline_file_bytes_assertion = ["assert_", "eq!(\n        fs::read"].concat();
    let forbidden_rows_assertion = ["assert_", "eq!(rows_after"].concat();
    assert!(
        !source.contains(&forbidden_provider_assertion)
            && !source.contains(&forbidden_item_assertion)
            && !source.contains(&forbidden_file_bytes_assertion)
            && !source.contains(&forbidden_multiline_file_bytes_assertion)
            && !source.contains(&forbidden_rows_assertion),
        "opened plaintext assertion formatting detected"
    );
}

#[test]
fn deterministic_integration_seams_require_an_explicit_non_default_feature() {
    let manifest = include_str!("../Cargo.toml").replace("\r\n", "\n");
    let source = include_str!("../src/preflight.rs");
    assert!(
        manifest.contains("[features]\ndefault = []\ntest-seams = []"),
        "test seam feature declaration is missing or enabled by default"
    );
    for api in [
        "pub fn writable_open_count_for_test_v1",
        "pub fn promote_with_test_observer_v1",
    ] {
        let position = source
            .find(api)
            .expect("required integration seam is missing");
        let start = position.saturating_sub(160);
        let attributes = &source[start..position];
        assert!(
            attributes.contains("#[cfg(feature = \"test-seams\")]"),
            "integration seam lacks the explicit feature gate"
        );
        assert!(
            !attributes.contains("#[cfg(debug_assertions)]"),
            "ordinary debug builds expose an integration seam"
        );
    }
}

struct RestartFixture {
    _directory: TempDir,
    location: StoreLocationV1,
}

fn committed_fixture() -> RestartFixture {
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
    drop(created);
    drop(password);
    RestartFixture {
        _directory: directory,
        location,
    }
}

fn current_preflight(location: &StoreLocationV1) -> ExistingVaultPreflightV1 {
    match preflight_existing_v1(location).unwrap() {
        ExistingVaultPreflightOutcomeV1::Current(preflight) => preflight,
        _ => panic!("synthetic current store was not admitted structurally"),
    }
}

fn insert_valid_independent_head(
    connection: &Connection,
    projection: CredentialCommitPersistenceProjectionV1<'_>,
) {
    let padding_bucket = match projection.padding_bucket() {
        StoredPaddingBucketV0Alpha1::Bytes1024 => 1_024,
        StoredPaddingBucketV0Alpha1::Bytes4096 => 4_096,
        StoredPaddingBucketV0Alpha1::Bytes16384 => 16_384,
        StoredPaddingBucketV0Alpha1::Bytes61440 => 61_440,
    };
    connection
        .execute(
            "INSERT INTO revisions(record_id,revision_id,wire_version,suite_id,key_epoch,padding_bucket,envelope) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            rusqlite::params![
                projection.record_id().as_bytes().as_slice(),
                projection.revision_id().as_bytes().as_slice(),
                i64::from(projection.wire_version()),
                i64::from(projection.suite_id()),
                i64::from(projection.key_epoch()),
                padding_bucket,
                projection.envelope(),
            ],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO heads(record_id,revision_id) VALUES(?1,?2)",
            rusqlite::params![
                projection.record_id().as_bytes().as_slice(),
                projection.revision_id().as_bytes().as_slice(),
            ],
        )
        .unwrap();
}

#[test]
fn encrypted_head_is_authenticated_promoted_and_opened_after_restart() {
    let fixture = committed_fixture();
    let preflight = current_preflight(&fixture.location);
    let password = MasterPassword::from_utf8(PASSWORD_TEXT.to_owned()).unwrap();
    let session = unlock_vault_v0alpha1(&password, preflight.password_envelope()).unwrap();
    let authenticator = CredentialStorageAuthenticatorV1::new(&session);

    let authenticated = preflight
        .authenticate_current_revisions(&authenticator)
        .unwrap()
        .into_authenticated()
        .expect("current revisions should authenticate");
    let opened_store = authenticated.promote().unwrap();
    let (store, current_heads) = opened_store
        .into_parts()
        .expect("authenticated current store should promote");

    assert_eq!(current_heads.len(), 1);
    let OpenCredentialOutcome::Current(opened) =
        open_credential_record_v1(&session, current_heads[0].sealed_record()).unwrap()
    else {
        panic!("current encrypted head unexpectedly required an upgrade");
    };
    assert!(
        opened.provider_name() == "Example AI Workshop",
        "restored synthetic provider relationship mismatch"
    );
    assert_eq!(opened.connection_count(), 1);
    drop(store);
}

#[test]
fn wrong_password_never_opens_writable_and_preserves_live_files_and_rows() {
    let fixture = committed_fixture();
    let connection = Connection::open(fixture.location.database_path()).unwrap();
    connection
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    connection
        .execute(
            "UPDATE vault_state SET password_suite_id=password_suite_id",
            [],
        )
        .unwrap();
    let wal_path = fixture
        .location
        .database_path()
        .with_extension("sqlite3-wal");
    let main_before = fs::read(fixture.location.database_path()).unwrap();
    let wal_before = fs::read(&wal_path).unwrap();
    let rows_before: Vec<i64> = ["vault_state", "revisions", "heads", "conflicts"]
        .into_iter()
        .map(|table| {
            connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap()
        })
        .collect();
    #[cfg(feature = "test-seams")]
    let writable_before = ExistingVaultPreflightV1::writable_open_count_for_test_v1();

    let preflight = current_preflight(&fixture.location);
    let wrong =
        MasterPassword::from_utf8("DEMO_VALUE_ONLY_wrong_password.invalid".to_owned()).unwrap();
    assert!(unlock_vault_v0alpha1(&wrong, preflight.password_envelope()).is_err());
    drop(preflight);

    let rows_after: Vec<i64> = ["vault_state", "revisions", "heads", "conflicts"]
        .into_iter()
        .map(|table| {
            connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap()
        })
        .collect();
    #[cfg(feature = "test-seams")]
    assert_eq!(
        ExistingVaultPreflightV1::writable_open_count_for_test_v1(),
        writable_before
    );
    assert!(
        fs::read(fixture.location.database_path()).unwrap() == main_before,
        "main database changed after rejected authentication"
    );
    assert!(
        fs::read(wal_path).unwrap() == wal_before,
        "wal changed after rejected authentication"
    );
    assert!(
        rows_after == rows_before,
        "logical rows changed after rejected authentication"
    );
}

#[test]
fn one_valid_change_restarts_full_preflight_and_authentication_once() {
    let fixture = committed_fixture();
    let preflight = current_preflight(&fixture.location);
    let password = MasterPassword::from_utf8(PASSWORD_TEXT.to_owned()).unwrap();
    let session = unlock_vault_v0alpha1(&password, preflight.password_envelope()).unwrap();
    let authenticator = CredentialStorageAuthenticatorV1::new(&session);
    let authenticated = preflight
        .authenticate_current_revisions(&authenticator)
        .unwrap()
        .into_authenticated()
        .unwrap();
    let additional =
        seal_synthetic_fixture_v1(&session, SyntheticCredentialFixtureId::UnconnectedApiKey)
            .unwrap();
    let connection = Connection::open(fixture.location.database_path()).unwrap();
    insert_valid_independent_head(&connection, additional.persistence_projection_v1());

    let opened = authenticated.promote().unwrap();
    let (store, heads) = opened
        .into_parts()
        .expect("valid change should reauthenticate");
    assert_eq!(heads.len(), 2);
    drop(store);
}

#[test]
#[cfg(feature = "test-seams")]
fn a_second_change_during_the_single_restart_returns_busy() {
    let fixture = committed_fixture();
    let preflight = current_preflight(&fixture.location);
    let password = MasterPassword::from_utf8(PASSWORD_TEXT.to_owned()).unwrap();
    let session = unlock_vault_v0alpha1(&password, preflight.password_envelope()).unwrap();
    let authenticator = CredentialStorageAuthenticatorV1::new(&session);
    let authenticated = preflight
        .authenticate_current_revisions(&authenticator)
        .unwrap()
        .into_authenticated()
        .unwrap();
    let first =
        seal_synthetic_fixture_v1(&session, SyntheticCredentialFixtureId::UnconnectedApiKey)
            .unwrap();
    let second =
        seal_synthetic_fixture_v1(&session, SyntheticCredentialFixtureId::MultipleConsumers)
            .unwrap();
    let connection = Connection::open(fixture.location.database_path()).unwrap();
    insert_valid_independent_head(&connection, first.persistence_projection_v1());
    #[cfg(feature = "test-seams")]
    let writable_before = ExistingVaultPreflightV1::writable_open_count_for_test_v1();

    let error = match authenticated.promote_with_test_observer_v1(|restart_count| {
        assert!(restart_count == 1, "unexpected promotion restart count");
        insert_valid_independent_head(&connection, second.persistence_projection_v1());
    }) {
        Ok(_) => panic!("a second logical change was unexpectedly promoted"),
        Err(error) => error,
    };
    assert_eq!(error.code(), StorageErrorCode::Busy);
    assert_eq!(
        ExistingVaultPreflightV1::writable_open_count_for_test_v1(),
        writable_before + 2
    );
}

#[test]
fn empty_revision_graph_still_requires_the_password_derived_vault_commitment() {
    let directory = tempfile::tempdir().unwrap();
    let trusted_root = TrustedLocalAppDataRootV1::for_current_user().unwrap();
    let policy = StoreLocationPolicyV1::new(&trusted_root, directory.path()).unwrap();
    let location = policy.location("empty.sqlite3").unwrap();
    let password = MasterPassword::from_utf8("DEMO_VALUE_ONLY_empty_vault.invalid".into()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let PasswordEnvelopeStorageDispositionV1::Current(inspection) =
        inspect_password_envelope_for_storage_v1(&created.password_envelope).unwrap()
    else {
        panic!("synthetic password envelope must be current");
    };
    let store = match initialize_v1(&location, inspection.bootstrap_projection()).unwrap() {
        InitializeStoreOutcomeV1::Created(store) => store,
        InitializeStoreOutcomeV1::AlreadyInitialized => panic!("temporary store already existed"),
    };
    drop(store);
    drop(created);

    let other_password =
        MasterPassword::from_utf8("DEMO_VALUE_ONLY_other_empty_vault.invalid".into()).unwrap();
    let other = create_vault_v0alpha1(&other_password).unwrap();
    let authenticator = CredentialStorageAuthenticatorV1::new(&other.session);
    #[cfg(feature = "test-seams")]
    let writable_before = ExistingVaultPreflightV1::writable_open_count_for_test_v1();
    assert!(matches!(
        current_preflight(&location)
            .authenticate_current_revisions(&authenticator)
            .unwrap(),
        vault_local_store_sqlite::PreflightAuthenticationOutcomeV1::ReadOnlyPreservation
    ));
    #[cfg(feature = "test-seams")]
    assert_eq!(
        ExistingVaultPreflightV1::writable_open_count_for_test_v1(),
        writable_before
    );
}
