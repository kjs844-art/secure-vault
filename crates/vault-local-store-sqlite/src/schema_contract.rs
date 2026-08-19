//! SQL-free schema facts shared by initialization and structural preflight.

use rusqlite::OpenFlags;

use crate::{StorageError, StorageErrorCode};

pub(crate) const APPLICATION_ID: i64 = 0x5356_4c54;
pub(crate) const STORAGE_SCHEMA_VERSION: i64 = 1;
pub(crate) const MAX_ENVELOPE_BYTES: i64 = 65_536;

pub(crate) const fn read_only_open_flags() -> OpenFlags {
    OpenFlags::SQLITE_OPEN_NO_MUTEX
        .union(OpenFlags::SQLITE_OPEN_PRIVATE_CACHE)
        .union(OpenFlags::SQLITE_OPEN_NOFOLLOW)
        .union(OpenFlags::SQLITE_OPEN_EXRESCODE)
        .union(OpenFlags::SQLITE_OPEN_READ_ONLY)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SchemaObjectV1 {
    pub(crate) kind: String,
    pub(crate) name: String,
    pub(crate) table: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SchemaColumnV1 {
    pub(crate) table: String,
    pub(crate) cid: i64,
    pub(crate) name: String,
    pub(crate) kind: String,
    pub(crate) not_null: i64,
    pub(crate) primary_key: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SchemaSnapshotV1 {
    pub(crate) objects: Vec<SchemaObjectV1>,
    pub(crate) columns: Vec<SchemaColumnV1>,
    pub(crate) foreign_key_counts: [(String, i64); 4],
    pub(crate) index_counts: [(String, i64); 4],
}

/// Verify only data captured by the query gate.  This module deliberately has
/// no connection or SQL dependency.
pub(crate) fn verify_schema_snapshot(snapshot: &SchemaSnapshotV1) -> Result<(), StorageError> {
    let expected_objects = [
        ("table", "conflicts", "conflicts"),
        ("table", "heads", "heads"),
        ("table", "revisions", "revisions"),
        ("table", "vault_state", "vault_state"),
        ("trigger", "conflicts_no_delete", "conflicts"),
        ("trigger", "conflicts_no_update", "conflicts"),
        ("trigger", "revisions_no_delete", "revisions"),
        ("trigger", "revisions_no_update", "revisions"),
    ];
    if snapshot.objects.len() != expected_objects.len()
        || !snapshot
            .objects
            .iter()
            .zip(expected_objects)
            .all(|(actual, expected)| {
                (
                    actual.kind.as_str(),
                    actual.name.as_str(),
                    actual.table.as_str(),
                ) == expected
            })
    {
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }

    let expected_columns = [
        ("conflicts", "record_id", "BLOB", 1, 1),
        ("conflicts", "candidate_revision_id", "BLOB", 1, 2),
        ("conflicts", "expected_head_revision_id", "BLOB", 0, 0),
        ("conflicts", "observed_head_revision_id", "BLOB", 1, 0),
        ("heads", "record_id", "BLOB", 0, 1),
        ("heads", "revision_id", "BLOB", 1, 0),
        ("revisions", "record_id", "BLOB", 1, 1),
        ("revisions", "revision_id", "BLOB", 1, 2),
        ("revisions", "wire_version", "INTEGER", 1, 0),
        ("revisions", "suite_id", "INTEGER", 1, 0),
        ("revisions", "key_epoch", "INTEGER", 1, 0),
        ("revisions", "padding_bucket", "INTEGER", 1, 0),
        ("revisions", "envelope", "BLOB", 1, 0),
        ("vault_state", "singleton", "INTEGER", 0, 1),
        ("vault_state", "password_wire_version", "INTEGER", 1, 0),
        ("vault_state", "password_suite_id", "INTEGER", 1, 0),
        ("vault_state", "password_envelope", "BLOB", 1, 0),
    ];
    if snapshot.columns.len() != expected_columns.len()
        || !snapshot
            .columns
            .iter()
            .zip(expected_columns)
            .all(|(actual, expected)| {
                (
                    actual.table.as_str(),
                    actual.name.as_str(),
                    actual.kind.as_str(),
                    actual.not_null,
                    actual.primary_key,
                ) == expected
            })
    {
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }
    if snapshot.foreign_key_counts
        != [
            ("conflicts".to_owned(), 6),
            ("heads".to_owned(), 2),
            ("revisions".to_owned(), 0),
            ("vault_state".to_owned(), 0),
        ]
        || snapshot.index_counts
            != [
                ("conflicts".to_owned(), 1),
                ("heads".to_owned(), 1),
                ("revisions".to_owned(), 1),
                ("vault_state".to_owned(), 0),
            ]
    {
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }
    Ok(())
}
