use std::fs;

use rusqlite::Connection;
use tempfile::tempdir;
use vault_local_store_sqlite::{
    ExistingVaultPreflightOutcomeV1, SCHEMA_V1_SQL, StoreLocationPolicyV1,
    TrustedLocalAppDataRootV1, preflight_existing_v1,
};

#[test]
fn task_five_modules_cannot_bypass_the_closed_query_gate() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for file in ["preflight.rs", "rows.rs", "digest.rs", "schema_contract.rs"] {
        let source = fs::read_to_string(root.join(file)).unwrap();
        for forbidden in [
            "Connection",
            "Statement",
            "Row",
            "Connection::open",
            ".prepare(",
            ".prepare_cached(",
            ".query(",
            ".query_row(",
            ".query_map(",
            ".execute(",
            ".execute_batch(",
            ".pragma_",
            ".transaction",
            "schema::",
            "schema::open_read_only",
            "schema::verify_schema_fingerprint",
            "schema::schema_fingerprint",
        ] {
            assert!(!source.contains(forbidden), "{file} exposes {forbidden}");
        }
    }

    let exports = fs::read_to_string(root.join("lib.rs")).unwrap();
    assert!(exports.contains("mod preflight_query;"));
    assert!(exports.contains("pub use preflight::{"));
    assert!(!exports.contains("pub use preflight_query::"));
}

#[test]
fn digest_and_row_boundaries_are_declared_without_attacker_count_allocation() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let gate = fs::read_to_string(root.join("preflight_query.rs")).unwrap();
    let rows = fs::read_to_string(root.join("rows.rs")).unwrap();
    assert!(gate.contains("MAX_TOTAL_REVISION_ENVELOPE_BYTES"));
    assert!(gate.contains("checked_add"));
    assert!(gate.contains("length(envelope)"));
    assert!(gate.contains("typeof(envelope)"));
    assert!(rows.contains("MAX_REVISIONS: usize = 10_000"));
    assert!(rows.contains("MAX_HEADS: usize = 5_000"));
    assert!(rows.contains("MAX_CONFLICTS: usize = 5_000"));
    assert!(!rows.contains("MAX_ROWS_PER_TABLE"));
}

#[test]
fn every_table_loader_uses_opaque_primary_key_keyset_pages_with_cap_plus_one() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let gate = fs::read_to_string(root.join("preflight_query.rs")).unwrap();
    assert!(gate.contains("KEYSET_QUERY_LIMIT: i64 = KEYSET_PAGE_ROWS as i64 + 1"));
    assert!(gate.contains("record_id > ?1 OR (record_id = ?1 AND revision_id > ?2)"));
    assert!(gate.contains("ORDER BY record_id,revision_id LIMIT ?3"));
    assert!(gate.contains("WHERE (?1 IS NULL OR record_id > ?1) ORDER BY record_id LIMIT ?2"));
    assert!(gate.contains("record_id > ?1 OR (record_id = ?1 AND candidate_revision_id > ?2)"));
    assert!(gate.contains("ORDER BY record_id,candidate_revision_id LIMIT ?3"));
    assert!(!gate.contains("OFFSET"));
}

#[test]
fn cargo_keeps_the_exact_bundled_and_load_extension_feature_pair() {
    let workspace = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("Cargo.toml");
    let cargo = fs::read_to_string(workspace).unwrap();
    let dependency = cargo
        .lines()
        .find(|line| line.starts_with("rusqlite = "))
        .unwrap();
    assert_eq!(
        dependency,
        "rusqlite = { version = \"=0.40.2\", default-features = false, features = [\"bundled\", \"load_extension\"] }"
    );
}

#[test]
fn public_preflight_rejects_blob_and_numeric_storage_classes_at_runtime() {
    enum Malformed {
        Blob(Vec<u8>),
        Real,
        Text,
    }

    for malformed in [
        Malformed::Blob(Vec::new()),
        Malformed::Blob(vec![7_u8; 65_537]),
        Malformed::Real,
        Malformed::Text,
    ] {
        let directory = tempdir().unwrap();
        let trusted_root = TrustedLocalAppDataRootV1::for_current_user().unwrap();
        let policy = StoreLocationPolicyV1::new(&trusted_root, directory.path()).unwrap();
        let location = policy.location("vault.sqlite3").unwrap();
        let connection = Connection::open(location.database_path()).unwrap();
        connection.execute_batch(SCHEMA_V1_SQL).unwrap();
        connection
            .execute_batch("PRAGMA ignore_check_constraints=ON;")
            .unwrap();
        match malformed {
            Malformed::Blob(envelope) => {
                connection
                    .execute(
                        "INSERT INTO vault_state(singleton,password_wire_version,password_suite_id,password_envelope) VALUES(1,1,1,?1)",
                        [envelope],
                    )
                    .unwrap();
            }
            Malformed::Real => {
                connection
                    .execute(
                        "INSERT INTO vault_state(singleton,password_wire_version,password_suite_id,password_envelope) VALUES(1,1.5,1,?1)",
                        [[1_u8].as_slice()],
                    )
                    .unwrap();
            }
            Malformed::Text => {
                connection
                    .execute(
                        "INSERT INTO vault_state(singleton,password_wire_version,password_suite_id,password_envelope) VALUES(1,1,'not-an-integer',?1)",
                        [[1_u8].as_slice()],
                    )
                    .unwrap();
            }
        }
        drop(connection);
        assert!(matches!(
            preflight_existing_v1(&location).unwrap(),
            ExistingVaultPreflightOutcomeV1::ReadOnlyPreservation
        ));
    }
}
