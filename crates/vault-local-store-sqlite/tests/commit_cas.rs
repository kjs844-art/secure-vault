use rusqlite::{Connection, OpenFlags, OptionalExtension};
use tempfile::TempDir;
use vault_crypto::{
    CreatedVaultV0Alpha1, MasterPassword, PasswordEnvelopeStorageDispositionV1,
    create_vault_v0alpha1, inspect_password_envelope_for_storage_v1,
};
use vault_local_core::{
    CredentialStorageAuthenticatorV1, OwnedRehydratedCredentialOutcomeV1,
    SealedCredentialRecordV0Alpha1, SyntheticCredentialFixtureId, SyntheticCredentialSuccessorV1,
    create_synthetic_successor_v1, seal_synthetic_fixture_v1,
};
use vault_local_store_sqlite::{
    CommitOutcomeV1, InitializeStoreOutcomeV1, StorageErrorCode, StoreLocationPolicyV1,
    StoreLocationV1, SyntheticWritableStoreV1, initialize_v1,
};

struct TestStore {
    _directory: TempDir,
    location: StoreLocationV1,
    created: CreatedVaultV0Alpha1,
    store: SyntheticWritableStoreV1,
}

#[derive(Debug, Eq, PartialEq)]
struct TableSnapshot {
    revisions: i64,
    heads: i64,
    conflicts: i64,
    head: Option<Vec<u8>>,
}

fn new_store(password: &str) -> TestStore {
    let directory = tempfile::tempdir().unwrap();
    let policy = StoreLocationPolicyV1::new(directory.path()).unwrap();
    let location = policy.location("vault.sqlite3").unwrap();
    let password = MasterPassword::from_utf8(password.to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let disposition = inspect_password_envelope_for_storage_v1(&created.password_envelope).unwrap();
    let PasswordEnvelopeStorageDispositionV1::Current(inspection) = disposition else {
        panic!("synthetic password envelope was not current");
    };
    let store = match initialize_v1(&location, inspection.bootstrap_projection()).unwrap() {
        InitializeStoreOutcomeV1::Created(store) => store,
        InitializeStoreOutcomeV1::AlreadyInitialized => {
            panic!("new temporary store was already initialized")
        }
    };
    TestStore {
        _directory: directory,
        location,
        created,
        store,
    }
}

fn read_only(location: &StoreLocationV1) -> Connection {
    Connection::open_with_flags(
        location.database_path(),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .unwrap()
}

fn snapshot(location: &StoreLocationV1, record_id: &[u8; 16]) -> TableSnapshot {
    let connection = read_only(location);
    let count = |table: &str| {
        connection
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap()
    };
    let head = connection
        .query_row(
            "SELECT revision_id FROM heads WHERE record_id=?1",
            [record_id.as_slice()],
            |row| row.get(0),
        )
        .optional()
        .unwrap();
    TableSnapshot {
        revisions: count("revisions"),
        heads: count("heads"),
        conflicts: count("conflicts"),
        head,
    }
}

fn initial_record(test: &TestStore) -> SealedCredentialRecordV0Alpha1 {
    seal_synthetic_fixture_v1(
        &test.created.session,
        SyntheticCredentialFixtureId::SingleMcpConnection,
    )
    .unwrap()
}

fn successor_record(
    created: &CreatedVaultV0Alpha1,
    successor: &SyntheticCredentialSuccessorV1,
) -> vault_local_core::OwnedRehydratedCredentialV1 {
    let envelope = successor.persistence_projection_v1().envelope().to_vec();
    let authenticator = CredentialStorageAuthenticatorV1::new(&created.session);
    match authenticator
        .rehydrate_owned_stored_credential_v1(envelope)
        .unwrap()
    {
        OwnedRehydratedCredentialOutcomeV1::Current(record) => record,
        OwnedRehydratedCredentialOutcomeV1::UpgradeRequired(_) => {
            panic!("synthetic successor unexpectedly required an upgrade")
        }
    }
}

#[test]
fn initial_commit_and_correct_successor_advance_the_canonical_head() {
    let mut test = new_store("DEMO_VALUE_ONLY_commit_initial_and_successor");
    let initial = initial_record(&test);
    let initial_projection = initial.persistence_projection_v1();
    let record_id = *initial_projection.record_id().as_bytes();
    let initial_revision = *initial_projection.revision_id().as_bytes();

    assert!(matches!(
        test.store.commit_candidate(initial_projection).unwrap(),
        CommitOutcomeV1::Committed
    ));
    assert_eq!(
        snapshot(&test.location, &record_id),
        TableSnapshot {
            revisions: 1,
            heads: 1,
            conflicts: 0,
            head: Some(initial_revision.to_vec()),
        }
    );

    let successor = create_synthetic_successor_v1(&test.created.session, &initial).unwrap();
    let successor_revision = *successor
        .persistence_projection_v1()
        .revision_id()
        .as_bytes();
    assert!(matches!(
        test.store
            .commit_candidate(successor.persistence_projection_v1())
            .unwrap(),
        CommitOutcomeV1::Committed
    ));
    assert_eq!(
        snapshot(&test.location, &record_id),
        TableSnapshot {
            revisions: 2,
            heads: 1,
            conflicts: 0,
            head: Some(successor_revision.to_vec()),
        }
    );
}

#[test]
fn two_siblings_keep_the_winner_as_head_and_preserve_the_stale_ciphertext() {
    let mut test = new_store("DEMO_VALUE_ONLY_commit_sibling_conflict");
    let initial = initial_record(&test);
    let record_id = *initial.persistence_projection_v1().record_id().as_bytes();
    test.store
        .commit_candidate(initial.persistence_projection_v1())
        .unwrap();
    let winner = create_synthetic_successor_v1(&test.created.session, &initial).unwrap();
    let stale = create_synthetic_successor_v1(&test.created.session, &initial).unwrap();
    let winner_revision = *winner.persistence_projection_v1().revision_id().as_bytes();

    assert!(matches!(
        test.store
            .commit_candidate(winner.persistence_projection_v1())
            .unwrap(),
        CommitOutcomeV1::Committed
    ));
    assert!(matches!(
        test.store
            .commit_candidate(stale.persistence_projection_v1())
            .unwrap(),
        CommitOutcomeV1::ConflictPreserved
    ));
    assert_eq!(
        snapshot(&test.location, &record_id),
        TableSnapshot {
            revisions: 3,
            heads: 1,
            conflicts: 1,
            head: Some(winner_revision.to_vec()),
        }
    );
}

#[test]
fn canonical_retry_after_a_later_head_is_already_committed_without_writes() {
    let mut test = new_store("DEMO_VALUE_ONLY_commit_canonical_retry");
    let initial = initial_record(&test);
    let record_id = *initial.persistence_projection_v1().record_id().as_bytes();
    test.store
        .commit_candidate(initial.persistence_projection_v1())
        .unwrap();
    let winner = create_synthetic_successor_v1(&test.created.session, &initial).unwrap();
    test.store
        .commit_candidate(winner.persistence_projection_v1())
        .unwrap();
    let winner_record = successor_record(&test.created, &winner);
    let later = create_synthetic_successor_v1(&test.created.session, winner_record.sealed_record())
        .unwrap();
    test.store
        .commit_candidate(later.persistence_projection_v1())
        .unwrap();

    let before = snapshot(&test.location, &record_id);
    assert!(matches!(
        test.store
            .commit_candidate(winner.persistence_projection_v1())
            .unwrap(),
        CommitOutcomeV1::AlreadyCommitted
    ));
    assert_eq!(snapshot(&test.location, &record_id), before);
}

#[test]
fn conflict_retry_after_a_later_head_preserves_the_first_mapping_without_writes() {
    let mut test = new_store("DEMO_VALUE_ONLY_commit_conflict_retry");
    let initial = initial_record(&test);
    let record_id = *initial.persistence_projection_v1().record_id().as_bytes();
    test.store
        .commit_candidate(initial.persistence_projection_v1())
        .unwrap();
    let winner = create_synthetic_successor_v1(&test.created.session, &initial).unwrap();
    let stale = create_synthetic_successor_v1(&test.created.session, &initial).unwrap();
    test.store
        .commit_candidate(winner.persistence_projection_v1())
        .unwrap();
    test.store
        .commit_candidate(stale.persistence_projection_v1())
        .unwrap();
    let winner_record = successor_record(&test.created, &winner);
    let later = create_synthetic_successor_v1(&test.created.session, winner_record.sealed_record())
        .unwrap();
    test.store
        .commit_candidate(later.persistence_projection_v1())
        .unwrap();

    let before = snapshot(&test.location, &record_id);
    assert!(matches!(
        test.store
            .commit_candidate(stale.persistence_projection_v1())
            .unwrap(),
        CommitOutcomeV1::ConflictPreserved
    ));
    assert_eq!(snapshot(&test.location, &record_id), before);
}

#[test]
fn wrong_vault_candidate_is_non_latching_and_changes_no_rows() {
    let mut test = new_store("DEMO_VALUE_ONLY_commit_destination_vault");
    let initial = initial_record(&test);
    let record_id = *initial.persistence_projection_v1().record_id().as_bytes();
    test.store
        .commit_candidate(initial.persistence_projection_v1())
        .unwrap();

    let other_password =
        MasterPassword::from_utf8("DEMO_VALUE_ONLY_commit_source_vault".to_owned()).unwrap();
    let other_vault = create_vault_v0alpha1(&other_password).unwrap();
    let other_candidate = seal_synthetic_fixture_v1(
        &other_vault.session,
        SyntheticCredentialFixtureId::UnconnectedApiKey,
    )
    .unwrap();
    let before = snapshot(&test.location, &record_id);
    let error = test
        .store
        .commit_candidate(other_candidate.persistence_projection_v1())
        .unwrap_err();
    assert_eq!(error.code(), StorageErrorCode::WrongVaultCandidate);
    assert_eq!(snapshot(&test.location, &record_id), before);

    let valid = create_synthetic_successor_v1(&test.created.session, &initial).unwrap();
    assert!(matches!(
        test.store
            .commit_candidate(valid.persistence_projection_v1())
            .unwrap(),
        CommitOutcomeV1::Committed
    ));
}

#[test]
fn missing_expected_base_is_non_latching_and_changes_no_rows() {
    let mut test = new_store("DEMO_VALUE_ONLY_commit_missing_base");
    let initial = initial_record(&test);
    let record_id = *initial.persistence_projection_v1().record_id().as_bytes();
    test.store
        .commit_candidate(initial.persistence_projection_v1())
        .unwrap();

    let absent_predecessor = seal_synthetic_fixture_v1(
        &test.created.session,
        SyntheticCredentialFixtureId::UnconnectedApiKey,
    )
    .unwrap();
    let absent_successor =
        create_synthetic_successor_v1(&test.created.session, &absent_predecessor).unwrap();
    let before = snapshot(&test.location, &record_id);
    let error = test
        .store
        .commit_candidate(absent_successor.persistence_projection_v1())
        .unwrap_err();
    assert_eq!(error.code(), StorageErrorCode::MissingBase);
    assert_eq!(snapshot(&test.location, &record_id), before);

    let valid = create_synthetic_successor_v1(&test.created.session, &initial).unwrap();
    assert!(matches!(
        test.store
            .commit_candidate(valid.persistence_projection_v1())
            .unwrap(),
        CommitOutcomeV1::Committed
    ));
}
