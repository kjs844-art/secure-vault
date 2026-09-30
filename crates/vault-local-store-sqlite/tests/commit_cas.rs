use rusqlite::{Connection, OpenFlags, OptionalExtension};
use tempfile::TempDir;
use vault_crypto::{
    CreatedVaultV0Alpha1, MasterPassword, PasswordEnvelopeStorageDispositionV1,
    create_vault_v0alpha1, inspect_password_envelope_for_storage_v1, unlock_vault_v0alpha1,
};
use vault_local_core::{
    CatalogCredentialStatusV1, CredentialCommitPersistenceProjectionV1,
    CredentialStorageAuthenticatorV1, OpenCredentialOutcome, OwnedRehydratedCredentialOutcomeV1,
    SealedCredentialRecordV0Alpha1, StoredCredentialAuthenticationOutcomeV1,
    SyntheticConnectionSelectionV1, SyntheticCredentialFixtureId, SyntheticCredentialSuccessorV1,
    SyntheticRotationCutoverSelectionV1, SyntheticVerificationEvidenceV1,
    create_synthetic_connection_successor_v1, create_synthetic_rotation_cutover_successor_v1,
    create_synthetic_successor_v1, open_credential_record_v1, seal_synthetic_fixture_v1,
};
use vault_local_store_sqlite::{
    CommitOutcomeV1, ExistingVaultPreflightOutcomeV1, InitializeStoreOutcomeV1, StorageErrorCode,
    StoreLocationPolicyV1, StoreLocationV1, SyntheticWritableStoreV1, TrustedLocalAppDataRootV1,
    initialize_v1, preflight_existing_v1,
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
    let trusted_root = TrustedLocalAppDataRootV1::for_current_user().unwrap();
    let policy = StoreLocationPolicyV1::new(&trusted_root, directory.path()).unwrap();
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

fn assert_rotation_history(
    location: &StoreLocationV1,
    record_id: &[u8; 16],
    predecessor: (&[u8; 32], &[u8]),
    winner: (&[u8; 32], &[u8]),
    stale: (&[u8; 32], &[u8]),
) {
    let connection = read_only(location);
    for (revision_id, expected_envelope) in [predecessor, winner, stale] {
        let stored: Vec<u8> = connection
            .query_row(
                "SELECT envelope FROM revisions WHERE record_id=?1 AND revision_id=?2",
                rusqlite::params![record_id.as_slice(), revision_id.as_slice()],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            stored == expected_envelope,
            "rotation history ciphertext changed"
        );
    }
    let (expected_head, observed_head): (Vec<u8>, Vec<u8>) = connection
        .query_row(
            "SELECT expected_head_revision_id, observed_head_revision_id FROM conflicts WHERE record_id=?1 AND candidate_revision_id=?2",
            rusqlite::params![record_id.as_slice(), stale.0.as_slice()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(expected_head, predecessor.0.as_slice());
    assert_eq!(observed_head, winner.0.as_slice());
}

#[test]
fn rotation_cutover_siblings_preserve_exact_history_and_reauthenticate_after_restart() {
    const ROTATION_TEST_PHRASE: &str = "DEMO_VALUE_ONLY_rotation_commit_restart";
    let mut test = new_store(ROTATION_TEST_PHRASE);
    let initial = initial_record(&test);
    let record_id = *initial.persistence_projection_v1().record_id().as_bytes();
    let initial_revision = *initial.persistence_projection_v1().revision_id().as_bytes();
    let initial_envelope = initial.persistence_projection_v1().envelope().to_vec();
    assert!(matches!(
        test.store
            .commit_candidate(initial.persistence_projection_v1())
            .unwrap(),
        CommitOutcomeV1::Committed
    ));

    let selection = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[0],
        &[],
        SyntheticVerificationEvidenceV1::UserConfirmed,
    )
    .unwrap();
    let winner =
        create_synthetic_rotation_cutover_successor_v1(&test.created.session, &initial, &selection)
            .unwrap();
    let stale =
        create_synthetic_rotation_cutover_successor_v1(&test.created.session, &initial, &selection)
            .unwrap();
    let winner_revision = *winner.persistence_projection_v1().revision_id().as_bytes();
    let stale_revision = *stale.persistence_projection_v1().revision_id().as_bytes();
    let winner_envelope = winner.persistence_projection_v1().envelope().to_vec();
    let stale_envelope = stale.persistence_projection_v1().envelope().to_vec();
    assert_ne!(winner_revision, stale_revision);
    for candidate in [&winner, &stale] {
        assert!(
            candidate.persistence_projection_v1().expected_revision_id()
                == Some(initial.persistence_projection_v1().revision_id())
        );
    }

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
    let expected_snapshot = TableSnapshot {
        revisions: 3,
        heads: 1,
        conflicts: 1,
        head: Some(winner_revision.to_vec()),
    };
    assert_eq!(snapshot(&test.location, &record_id), expected_snapshot);
    assert_rotation_history(
        &test.location,
        &record_id,
        (&initial_revision, &initial_envelope),
        (&winner_revision, &winner_envelope),
        (&stale_revision, &stale_envelope),
    );

    for _ in 0..2 {
        for canonical in [
            initial.persistence_projection_v1(),
            winner.persistence_projection_v1(),
        ] {
            assert!(matches!(
                test.store.commit_candidate(canonical).unwrap(),
                CommitOutcomeV1::AlreadyCommitted
            ));
        }
        assert!(matches!(
            test.store
                .commit_candidate(stale.persistence_projection_v1())
                .unwrap(),
            CommitOutcomeV1::ConflictPreserved
        ));
        assert_eq!(snapshot(&test.location, &record_id), expected_snapshot);
        assert_rotation_history(
            &test.location,
            &record_id,
            (&initial_revision, &initial_envelope),
            (&winner_revision, &winner_envelope),
            (&stale_revision, &stale_envelope),
        );
    }

    drop(initial);
    drop(winner);
    drop(stale);
    drop(test.store);
    drop(test.created);

    let ExistingVaultPreflightOutcomeV1::Current(preflight) =
        preflight_existing_v1(&test.location).unwrap()
    else {
        panic!("rotation history was not structurally admitted after restart");
    };
    let password = MasterPassword::from_utf8(ROTATION_TEST_PHRASE.to_owned()).unwrap();
    let session = unlock_vault_v0alpha1(&password, preflight.password_envelope()).unwrap();
    let authenticator = CredentialStorageAuthenticatorV1::new(&session);
    let authenticated = preflight
        .authenticate_current_revisions(&authenticator)
        .unwrap()
        .into_authenticated()
        .expect("all rotation revisions should authenticate after restart");
    assert_eq!(authenticated.current_heads().len(), 1);
    let head = authenticated.current_heads()[0].sealed_record();
    assert_eq!(
        head.persistence_projection_v1().revision_id().as_bytes(),
        &winner_revision
    );
    assert!(head.persistence_projection_v1().envelope() == winner_envelope);
    let OpenCredentialOutcome::Current(opened) = open_credential_record_v1(&session, head).unwrap()
    else {
        panic!("rotation winner unexpectedly required an upgrade");
    };
    let catalog = opened.into_catalog_projection_v1();
    assert!(catalog.status() == CatalogCredentialStatusV1::Active);
    assert_eq!(catalog.connection_count(), 1);
    assert_eq!(catalog.secret_field_count(), 1);
    drop(catalog);

    let reopened = authenticated.promote().unwrap();
    let (store, heads) = reopened
        .into_parts()
        .expect("authenticated rotation history should promote after restart");
    assert_eq!(heads.len(), 1);
    assert_eq!(snapshot(&test.location, &record_id), expected_snapshot);
    assert_rotation_history(
        &test.location,
        &record_id,
        (&initial_revision, &initial_envelope),
        (&winner_revision, &winner_envelope),
        (&stale_revision, &stale_envelope),
    );
    drop(store);
}

struct HistoryExpectation {
    revision_id: [u8; 32],
    parent_revision_id: Option<[u8; 32]>,
    envelope: Vec<u8>,
}

fn history_expectation(
    projection: CredentialCommitPersistenceProjectionV1<'_>,
) -> HistoryExpectation {
    HistoryExpectation {
        revision_id: *projection.revision_id().as_bytes(),
        parent_revision_id: projection.expected_revision_id().map(|id| *id.as_bytes()),
        envelope: projection.envelope().to_vec(),
    }
}

fn assert_authenticated_lifecycle_history(
    location: &StoreLocationV1,
    record_id: &[u8; 16],
    history: &[HistoryExpectation],
    authenticator: &CredentialStorageAuthenticatorV1<'_>,
) {
    let connection = read_only(location);
    for expected in history {
        let stored: Vec<u8> = connection
            .query_row(
                "SELECT envelope FROM revisions WHERE record_id=?1 AND revision_id=?2",
                rusqlite::params![record_id.as_slice(), expected.revision_id.as_slice()],
                |row| row.get(0),
            )
            .unwrap();
        assert!(stored == expected.envelope, "lifecycle ciphertext changed");
        let StoredCredentialAuthenticationOutcomeV1::Current(receipt) = authenticator
            .authenticate_stored_credential_v1(&stored)
            .unwrap()
        else {
            panic!("lifecycle revision unexpectedly required an upgrade");
        };
        assert_eq!(receipt.record_id().as_bytes(), record_id);
        assert_eq!(receipt.revision_id().as_bytes(), &expected.revision_id);
        assert_eq!(
            receipt.parent_revision_id().map(|id| *id.as_bytes()),
            expected.parent_revision_id
        );
        assert!(receipt.envelope() == expected.envelope);
    }
}

#[test]
fn completed_rotations_allow_edits_and_preserve_the_full_chain_after_restart() {
    const LIFECYCLE_TEST_PHRASE: &str = "DEMO_VALUE_ONLY_rotation_lifecycle_restart";
    let mut test = new_store(LIFECYCLE_TEST_PHRASE);
    let initial = initial_record(&test);
    let record_id = *initial.persistence_projection_v1().record_id().as_bytes();
    assert!(matches!(
        test.store
            .commit_candidate(initial.persistence_projection_v1())
            .unwrap(),
        CommitOutcomeV1::Committed
    ));

    let first_selection = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[0],
        &[],
        SyntheticVerificationEvidenceV1::UserConfirmed,
    )
    .unwrap();
    let first = create_synthetic_rotation_cutover_successor_v1(
        &test.created.session,
        &initial,
        &first_selection,
    )
    .unwrap();
    let first_record = successor_record(&test.created, &first);
    let unchanged =
        create_synthetic_successor_v1(&test.created.session, first_record.sealed_record()).unwrap();
    let unchanged_record = successor_record(&test.created, &unchanged);
    let connection_selection = SyntheticConnectionSelectionV1::from_ids(&[0, 1]).unwrap();
    let edited = create_synthetic_connection_successor_v1(
        &test.created.session,
        unchanged_record.sealed_record(),
        &connection_selection,
    )
    .unwrap();
    let edited_record = successor_record(&test.created, &edited);
    let second_selection = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[0],
        &[1],
        SyntheticVerificationEvidenceV1::ProviderVerified,
    )
    .unwrap();
    let second = create_synthetic_rotation_cutover_successor_v1(
        &test.created.session,
        edited_record.sealed_record(),
        &second_selection,
    )
    .unwrap();
    let stale = create_synthetic_rotation_cutover_successor_v1(
        &test.created.session,
        edited_record.sealed_record(),
        &second_selection,
    )
    .unwrap();
    let history = [
        initial.persistence_projection_v1(),
        first.persistence_projection_v1(),
        unchanged.persistence_projection_v1(),
        edited.persistence_projection_v1(),
        second.persistence_projection_v1(),
        stale.persistence_projection_v1(),
    ]
    .map(history_expectation);
    assert_ne!(history[4].revision_id, history[5].revision_id);
    for (index, expected) in history[1..5].iter().enumerate() {
        assert_eq!(
            expected.parent_revision_id,
            Some(history[index].revision_id)
        );
    }
    assert_eq!(history[5].parent_revision_id, Some(history[3].revision_id));

    for canonical in [&first, &unchanged, &edited, &second] {
        assert!(matches!(
            test.store
                .commit_candidate(canonical.persistence_projection_v1())
                .unwrap(),
            CommitOutcomeV1::Committed
        ));
    }
    assert!(matches!(
        test.store
            .commit_candidate(stale.persistence_projection_v1())
            .unwrap(),
        CommitOutcomeV1::ConflictPreserved
    ));
    let expected_snapshot = TableSnapshot {
        revisions: 6,
        heads: 1,
        conflicts: 1,
        head: Some(history[4].revision_id.to_vec()),
    };
    let second_record = successor_record(&test.created, &second);
    assert!(
        create_synthetic_rotation_cutover_successor_v1(
            &test.created.session,
            second_record.sealed_record(),
            &second_selection,
        )
        .is_err(),
        "terminal synthetic key generation must not rotate again"
    );
    assert!(matches!(
        test.store
            .commit_candidate(first.persistence_projection_v1())
            .unwrap(),
        CommitOutcomeV1::AlreadyCommitted
    ));
    assert!(matches!(
        test.store
            .commit_candidate(stale.persistence_projection_v1())
            .unwrap(),
        CommitOutcomeV1::ConflictPreserved
    ));
    assert_eq!(snapshot(&test.location, &record_id), expected_snapshot);
    assert_authenticated_lifecycle_history(
        &test.location,
        &record_id,
        &history,
        &CredentialStorageAuthenticatorV1::new(&test.created.session),
    );
    assert_rotation_history(
        &test.location,
        &record_id,
        (&history[3].revision_id, &history[3].envelope),
        (&history[4].revision_id, &history[4].envelope),
        (&history[5].revision_id, &history[5].envelope),
    );

    drop(initial);
    drop(first);
    drop(first_record);
    drop(unchanged);
    drop(unchanged_record);
    drop(edited);
    drop(edited_record);
    drop(second);
    drop(second_record);
    drop(stale);
    drop(test.store);
    drop(test.created);

    let ExistingVaultPreflightOutcomeV1::Current(preflight) =
        preflight_existing_v1(&test.location).unwrap()
    else {
        panic!("completed rotation chain was not structurally admitted after restart");
    };
    let password = MasterPassword::from_utf8(LIFECYCLE_TEST_PHRASE.to_owned()).unwrap();
    let session = unlock_vault_v0alpha1(&password, preflight.password_envelope()).unwrap();
    let authenticator = CredentialStorageAuthenticatorV1::new(&session);
    let authenticated = preflight
        .authenticate_current_revisions(&authenticator)
        .unwrap()
        .into_authenticated()
        .expect("completed rotation chain must authenticate after restart");
    assert_eq!(authenticated.current_heads().len(), 1);
    let head = authenticated.current_heads()[0].sealed_record();
    assert_eq!(
        head.persistence_projection_v1().revision_id().as_bytes(),
        &history[4].revision_id
    );
    assert!(head.persistence_projection_v1().envelope() == history[4].envelope);
    let OpenCredentialOutcome::Current(opened) = open_credential_record_v1(&session, head).unwrap()
    else {
        panic!("second cutover head unexpectedly required an upgrade");
    };
    let catalog = opened.into_catalog_projection_v1();
    assert!(catalog.status() == CatalogCredentialStatusV1::Active);
    assert_eq!(catalog.connection_count(), 2);
    assert_eq!(catalog.mcp_connection_count(), 1);
    assert_eq!(catalog.secret_field_count(), 1);
    drop(catalog);

    let reopened = authenticated.promote().unwrap();
    let (store, heads) = reopened
        .into_parts()
        .expect("completed rotation history should promote after restart");
    assert_eq!(heads.len(), 1);
    assert_eq!(snapshot(&test.location, &record_id), expected_snapshot);
    assert_authenticated_lifecycle_history(&test.location, &record_id, &history, &authenticator);
    assert_rotation_history(
        &test.location,
        &record_id,
        (&history[3].revision_id, &history[3].envelope),
        (&history[4].revision_id, &history[4].envelope),
        (&history[5].revision_id, &history[5].envelope),
    );
    drop(store);
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
