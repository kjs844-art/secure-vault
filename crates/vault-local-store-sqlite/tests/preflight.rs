use std::fs;

use rusqlite::Connection;
use tempfile::tempdir;
use vault_crypto::{
    MasterPassword, PasswordEnvelopeStorageDispositionV1, create_vault_v0alpha1,
    inspect_password_envelope_for_storage_v1,
};
use vault_local_store_sqlite::{
    ExistingVaultPreflightOutcomeV1, InitializeStoreOutcomeV1, StoreLocationPolicyV1,
    initialize_v1, preflight_existing_v1,
};

fn initialized_location() -> (tempfile::TempDir, vault_local_store_sqlite::StoreLocationV1) {
    let directory = tempdir().unwrap();
    let policy = StoreLocationPolicyV1::new(directory.path()).unwrap();
    let location = policy.location("synthetic.invalid").unwrap();
    let password =
        MasterPassword::from_utf8("DEMO_VALUE_ONLY_preflight.invalid".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let PasswordEnvelopeStorageDispositionV1::Current(inspection) =
        inspect_password_envelope_for_storage_v1(&created.password_envelope).unwrap()
    else {
        panic!("fixture must be current");
    };
    let outcome = initialize_v1(&location, inspection.bootstrap_projection()).unwrap();
    assert!(matches!(outcome, InitializeStoreOutcomeV1::Created(_)));
    drop(outcome);
    (directory, location)
}

fn assert_outcome_preserves_live_main_and_wal(
    location: &vault_local_store_sqlite::StoreLocationV1,
    expected: fn(&ExistingVaultPreflightOutcomeV1) -> bool,
) {
    let connection = Connection::open(location.database_path()).unwrap();
    connection
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    connection
        .execute(
            "UPDATE vault_state SET password_suite_id=password_suite_id",
            [],
        )
        .unwrap();
    let wal = std::path::PathBuf::from(format!("{}-wal", location.database_path().display()));
    let main_before = fs::read(location.database_path()).unwrap();
    let wal_before = fs::read(&wal).unwrap();
    let counts_before: Vec<i64> = ["vault_state", "revisions", "heads", "conflicts"]
        .iter()
        .map(|table| {
            connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap()
        })
        .collect();
    let outcome = preflight_existing_v1(location).unwrap();
    assert!(expected(&outcome));
    let counts_after: Vec<i64> = ["vault_state", "revisions", "heads", "conflicts"]
        .iter()
        .map(|table| {
            connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap()
        })
        .collect();
    assert_eq!(fs::read(location.database_path()).unwrap(), main_before);
    assert_eq!(fs::read(&wal).unwrap(), wal_before);
    assert_eq!(counts_after, counts_before);
}

#[test]
fn valid_current_store_returns_a_private_preflight() {
    let (_directory, location) = initialized_location();
    assert_outcome_preserves_live_main_and_wal(&location, |outcome| {
        matches!(outcome, ExistingVaultPreflightOutcomeV1::Current(_))
    });
}

#[test]
fn future_schema_short_circuits_before_v1_queries() {
    let (_directory, location) = initialized_location();
    let connection = Connection::open(location.database_path()).unwrap();
    connection
        .pragma_update(None, "user_version", 2_i64)
        .unwrap();
    drop(connection);
    assert_outcome_preserves_live_main_and_wal(&location, |outcome| {
        matches!(
            outcome,
            ExistingVaultPreflightOutcomeV1::SchemaUpgradeRequired
        )
    });
}

#[test]
fn same_shape_but_changed_trigger_sql_is_preserved() {
    let (_directory, location) = initialized_location();
    let connection = Connection::open(location.database_path()).unwrap();
    connection
        .execute_batch(
            "DROP TRIGGER conflicts_no_delete;
             CREATE TRIGGER conflicts_no_delete
             BEFORE DELETE ON conflicts
             BEGIN
                 SELECT RAISE(ABORT, 'changed immutable conflict rule');
             END;",
        )
        .unwrap();
    drop(connection);
    assert_outcome_preserves_live_main_and_wal(&location, |outcome| {
        matches!(
            outcome,
            ExistingVaultPreflightOutcomeV1::ReadOnlyPreservation
        )
    });
}

#[test]
fn future_outer_password_envelope_requires_crypto_upgrade() {
    let (_directory, location) = initialized_location();
    let connection = Connection::open(location.database_path()).unwrap();
    connection
        .execute(
            "UPDATE vault_state SET password_wire_version=1,password_envelope=?1",
            [[0x82_u8, 0x01, 0x40].as_slice()],
        )
        .unwrap();
    drop(connection);
    assert_outcome_preserves_live_main_and_wal(&location, |outcome| {
        matches!(
            outcome,
            ExistingVaultPreflightOutcomeV1::CryptoUpgradeRequired
        )
    });
}

#[test]
fn future_outer_cache_version_mismatch_is_preserved() {
    let (_directory, location) = initialized_location();
    let connection = Connection::open(location.database_path()).unwrap();
    connection
        .execute(
            "UPDATE vault_state SET password_envelope=?1",
            [[0x82_u8, 0x01, 0x40].as_slice()],
        )
        .unwrap();
    drop(connection);
    assert_outcome_preserves_live_main_and_wal(&location, |outcome| {
        matches!(
            outcome,
            ExistingVaultPreflightOutcomeV1::ReadOnlyPreservation
        )
    });
}

#[test]
fn malformed_current_password_row_is_preserved_without_writes() {
    let (_directory, location) = initialized_location();
    let connection = Connection::open(location.database_path()).unwrap();
    connection
        .execute(
            "UPDATE vault_state SET password_envelope=?1",
            [[0x80_u8].as_slice()],
        )
        .unwrap();
    drop(connection);
    assert_outcome_preserves_live_main_and_wal(&location, |outcome| {
        matches!(
            outcome,
            ExistingVaultPreflightOutcomeV1::ReadOnlyPreservation
        )
    });
}
