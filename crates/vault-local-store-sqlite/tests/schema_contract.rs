use rusqlite::{Connection, params};
use tempfile::tempdir;
use vault_crypto::{
    MasterPassword, PasswordEnvelopeStorageDispositionV1, create_vault_v0alpha1,
    inspect_password_envelope_for_storage_v1,
};
use vault_local_store_sqlite::{
    InitializeStoreOutcomeV1, SCHEMA_V1_SQL, StorageErrorCode, StoreLocationPolicyV1, initialize_v1,
};

const APPLICATION_ID: i64 = 0x5356_4c54;

fn bootstrap() -> (vault_crypto::CreatedVaultV0Alpha1, Vec<u8>) {
    let password =
        MasterPassword::from_utf8("synthetic sqlite schema contract phrase".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let bytes = created.password_envelope.clone();
    (created, bytes)
}

fn apply_golden_schema(connection: &Connection) {
    connection.execute_batch(SCHEMA_V1_SQL).unwrap();
    connection
        .execute_batch("PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON;")
        .unwrap();
}

fn object_names(connection: &Connection, object_type: &str) -> Vec<String> {
    let mut statement = connection
        .prepare(
            "SELECT name FROM sqlite_schema \
             WHERE type = ?1 AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .unwrap();
    statement
        .query_map([object_type], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

#[test]
fn golden_schema_has_exact_identity_objects_columns_keys_and_triggers() {
    let connection = Connection::open_in_memory().unwrap();
    apply_golden_schema(&connection);

    assert_eq!(
        connection
            .query_row("PRAGMA application_id", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        APPLICATION_ID
    );
    assert_eq!(
        connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        object_names(&connection, "table"),
        ["conflicts", "heads", "revisions", "vault_state"]
    );
    assert_eq!(
        object_names(&connection, "trigger"),
        [
            "conflicts_no_delete",
            "conflicts_no_update",
            "revisions_no_delete",
            "revisions_no_update",
        ]
    );

    let revisions: Vec<(String, String, i64, i64)> = connection
        .prepare("PRAGMA table_xinfo(revisions)")
        .unwrap()
        .query_map([], |row| {
            Ok((row.get(1)?, row.get(2)?, row.get(3)?, row.get(5)?))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        revisions,
        [
            ("record_id".into(), "BLOB".into(), 1, 1),
            ("revision_id".into(), "BLOB".into(), 1, 2),
            ("wire_version".into(), "INTEGER".into(), 1, 0),
            ("suite_id".into(), "INTEGER".into(), 1, 0),
            ("key_epoch".into(), "INTEGER".into(), 1, 0),
            ("padding_bucket".into(), "INTEGER".into(), 1, 0),
            ("envelope".into(), "BLOB".into(), 1, 0),
        ]
    );

    let foreign_keys: i64 = connection
        .query_row(
            "SELECT count(*) FROM pragma_foreign_key_list('heads')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(foreign_keys, 2);
    let conflict_foreign_keys: i64 = connection
        .query_row(
            "SELECT count(*) FROM pragma_foreign_key_list('conflicts')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(conflict_foreign_keys, 6);
}

#[test]
fn immutable_rows_reject_update_delete_and_replace() {
    let connection = Connection::open_in_memory().unwrap();
    apply_golden_schema(&connection);
    let record = [0x11_u8; 16];
    let first = [0x21_u8; 32];
    let second = [0x22_u8; 32];

    connection
        .execute(
            "INSERT INTO revisions VALUES (?1, ?2, 0, 41217, 1, 1024, ?3)",
            params![record.as_slice(), first.as_slice(), [0xa1_u8].as_slice()],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO revisions VALUES (?1, ?2, 0, 41217, 1, 1024, ?3)",
            params![record.as_slice(), second.as_slice(), [0xa2_u8].as_slice()],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO heads VALUES (?1, ?2)",
            params![record.as_slice(), first.as_slice()],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO conflicts VALUES (?1, ?2, ?3, ?4)",
            params![
                record.as_slice(),
                second.as_slice(),
                first.as_slice(),
                first.as_slice()
            ],
        )
        .unwrap();

    for sql in [
        "UPDATE revisions SET key_epoch=2",
        "DELETE FROM revisions",
        "UPDATE conflicts SET expected_head_revision_id=NULL",
        "DELETE FROM conflicts",
        "INSERT OR REPLACE INTO revisions VALUES (x'11111111111111111111111111111111', x'2121212121212121212121212121212121212121212121212121212121212121', 0, 41217, 1, 1024, x'a1')",
        "INSERT OR REPLACE INTO conflicts VALUES (x'11111111111111111111111111111111', x'2222222222222222222222222222222222222222222222222222222222222222', x'2121212121212121212121212121212121212121212121212121212121212121', x'2121212121212121212121212121212121212121212121212121212121212121')",
    ] {
        assert!(connection.execute(sql, []).is_err());
    }
}

#[test]
fn numeric_metadata_accepts_only_final_integer_storage_classes_and_ranges() {
    let connection = Connection::open_in_memory().unwrap();
    apply_golden_schema(&connection);

    for (column, value) in [
        ("password_wire_version", "1.5"),
        ("password_suite_id", "'not-a-number'"),
    ] {
        let sql = format!(
            "INSERT INTO vault_state(singleton,password_wire_version,password_suite_id,password_envelope) \
             VALUES(1, {}, {}, x'01')",
            if column == "password_wire_version" {
                value
            } else {
                "0"
            },
            if column == "password_suite_id" {
                value
            } else {
                "0"
            },
        );
        assert!(connection.execute(&sql, []).is_err(), "{column}");
    }
    for (column, value) in [
        ("wire_version", "1.5"),
        ("suite_id", "'text'"),
        ("key_epoch", "0"),
        ("padding_bucket", "2048"),
    ] {
        let sql = format!(
            "INSERT INTO revisions(record_id,revision_id,wire_version,suite_id,key_epoch,padding_bucket,envelope) \
             VALUES(zeroblob(16),zeroblob(32),{wire},{suite},{epoch},{bucket},x'01')",
            wire = if column == "wire_version" { value } else { "0" },
            suite = if column == "suite_id" { value } else { "0" },
            epoch = if column == "key_epoch" { value } else { "1" },
            bucket = if column == "padding_bucket" {
                value
            } else {
                "1024"
            },
        );
        assert!(connection.execute(&sql, []).is_err(), "{column}");
    }
    for value in ["-1", "4294967296"] {
        let sql = format!(
            "INSERT INTO revisions VALUES(zeroblob(16),randomblob(32),{value},0,1,1024,x'01')"
        );
        assert!(connection.execute(&sql, []).is_err());
    }

    connection
        .execute(
            "INSERT INTO vault_state VALUES(1,?1,?2,?3)",
            params![0_i64, 41_217_i64, [0x01_u8].as_slice()],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO revisions VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                [0x31_u8; 16].as_slice(),
                [0x41_u8; 32].as_slice(),
                0_i64,
                41_217_i64,
                1_i64,
                1024_i64,
                [0x51_u8].as_slice(),
            ],
        )
        .unwrap();
    let stored_classes: String = connection
        .query_row(
            "SELECT typeof(wire_version)||','||typeof(suite_id)||','||\
                    typeof(key_epoch)||','||typeof(padding_bucket) FROM revisions",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored_classes, "integer,integer,integer,integer");
}

#[test]
fn initialize_is_atomic_idempotent_and_rejects_schema_drift() {
    let directory = tempdir().unwrap();
    let policy = StoreLocationPolicyV1::new(directory.path()).unwrap();
    let location = policy.location("vault.sqlite3").unwrap();
    let (created, password_bytes) = bootstrap();
    let disposition = inspect_password_envelope_for_storage_v1(&password_bytes).unwrap();
    let PasswordEnvelopeStorageDispositionV1::Current(inspection) = disposition else {
        panic!("synthetic current envelope was not current");
    };

    let outcome = initialize_v1(&location, inspection.bootstrap_projection()).unwrap();
    assert!(matches!(outcome, InitializeStoreOutcomeV1::Created(_)));
    drop(outcome);

    let disposition = inspect_password_envelope_for_storage_v1(&password_bytes).unwrap();
    let PasswordEnvelopeStorageDispositionV1::Current(inspection) = disposition else {
        panic!("synthetic current envelope was not current");
    };
    assert!(matches!(
        initialize_v1(&location, inspection.bootstrap_projection()).unwrap(),
        InitializeStoreOutcomeV1::AlreadyInitialized
    ));

    let other_password =
        MasterPassword::from_utf8("synthetic different bootstrap phrase".to_owned()).unwrap();
    let other = create_vault_v0alpha1(&other_password).unwrap();
    let other_disposition =
        inspect_password_envelope_for_storage_v1(&other.password_envelope).unwrap();
    let PasswordEnvelopeStorageDispositionV1::Current(other_inspection) = other_disposition else {
        panic!("second synthetic current envelope was not current");
    };
    let mismatch = match initialize_v1(&location, other_inspection.bootstrap_projection()) {
        Ok(_) => panic!("different bootstrap replaced an initialized store"),
        Err(error) => error,
    };
    assert_eq!(mismatch.code(), StorageErrorCode::InvariantViolation);

    let connection = Connection::open(location.database_path()).unwrap();
    connection
        .execute_batch("DROP TRIGGER conflicts_no_delete")
        .unwrap();
    drop(connection);
    let disposition = inspect_password_envelope_for_storage_v1(&password_bytes).unwrap();
    let PasswordEnvelopeStorageDispositionV1::Current(inspection) = disposition else {
        panic!("synthetic current envelope was not current");
    };
    let error = match initialize_v1(&location, inspection.bootstrap_projection()) {
        Ok(_) => panic!("schema drift was accepted"),
        Err(error) => error,
    };
    assert_eq!(error.code(), StorageErrorCode::CorruptStorage);
    drop(created);
}
