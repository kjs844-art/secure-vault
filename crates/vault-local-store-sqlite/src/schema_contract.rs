//! SQL-free schema facts shared by initialization and structural preflight.

use blake3::Hasher;
use rusqlite::OpenFlags;

use crate::{StorageError, StorageErrorCode};

pub(crate) const APPLICATION_ID: i64 = 0x5356_4c54;
pub(crate) const STORAGE_SCHEMA_VERSION: i64 = 1;
pub(crate) const MAX_ENVELOPE_BYTES: i64 = 65_536;

const EXPECTED_SCHEMA_FINGERPRINT_V1: [u8; 32] = [
    0xef, 0x0a, 0x9e, 0x52, 0xfd, 0xa5, 0x16, 0x22, 0xb9, 0x7c, 0xdd, 0xc2, 0x23, 0x84, 0xcd, 0x17,
    0xe6, 0xff, 0xe8, 0xb3, 0x89, 0x14, 0xcd, 0x10, 0x22, 0x26, 0xaf, 0x82, 0xc0, 0x0f, 0x55, 0x0c,
];

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
    pub(crate) sql: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SchemaColumnV1 {
    pub(crate) cid: i64,
    pub(crate) name: String,
    pub(crate) kind: String,
    pub(crate) not_null: i64,
    pub(crate) default_value: Option<String>,
    pub(crate) primary_key: i64,
    pub(crate) hidden: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SchemaForeignKeyV1 {
    pub(crate) id: i64,
    pub(crate) sequence: i64,
    pub(crate) foreign_table: String,
    pub(crate) from: String,
    pub(crate) to: String,
    pub(crate) on_update: String,
    pub(crate) on_delete: String,
    pub(crate) match_clause: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SchemaIndexV1 {
    pub(crate) sequence: i64,
    pub(crate) name: String,
    pub(crate) unique: i64,
    pub(crate) origin: String,
    pub(crate) partial: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SchemaTableSnapshotV1 {
    pub(crate) name: String,
    pub(crate) columns: Vec<SchemaColumnV1>,
    pub(crate) foreign_keys: Vec<SchemaForeignKeyV1>,
    pub(crate) indexes: Vec<SchemaIndexV1>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SchemaSnapshotV1 {
    pub(crate) objects: Vec<SchemaObjectV1>,
    pub(crate) tables: [SchemaTableSnapshotV1; 4],
}

/// Verify only bounded typed data captured by the query gate. This module
/// normalizes and compares data but never opens a connection or executes SQL.
pub(crate) fn verify_schema_snapshot(snapshot: &SchemaSnapshotV1) -> Result<(), StorageError> {
    let expected_counts = [
        ("conflicts", 4, 6, 1),
        ("heads", 2, 2, 1),
        ("revisions", 7, 0, 1),
        ("vault_state", 4, 0, 0),
    ];
    if snapshot.objects.len() != 8
        || !snapshot
            .tables
            .iter()
            .zip(expected_counts)
            .all(|(table, expected)| {
                (
                    table.name.as_str(),
                    table.columns.len(),
                    table.foreign_keys.len(),
                    table.indexes.len(),
                ) == expected
            })
        || schema_fingerprint(snapshot) != EXPECTED_SCHEMA_FINGERPRINT_V1
    {
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }
    Ok(())
}

fn schema_fingerprint(snapshot: &SchemaSnapshotV1) -> [u8; 32] {
    let mut hasher = Hasher::new();
    feed_i64(&mut hasher, "application_id", APPLICATION_ID);
    feed_i64(&mut hasher, "user_version", STORAGE_SCHEMA_VERSION);

    for object in &snapshot.objects {
        feed_text(&mut hasher, "object-type", &object.kind);
        feed_text(&mut hasher, "object-name", &object.name);
        feed_text(&mut hasher, "object-table", &object.table);
        feed_text(&mut hasher, "object-sql", &normalize_sql(&object.sql));
    }

    for table in &snapshot.tables {
        feed_text(&mut hasher, "table", &table.name);
        for column in &table.columns {
            feed_value_i64(&mut hasher, column.cid);
            feed_value_text(&mut hasher, &column.name);
            feed_value_text(&mut hasher, &column.kind);
            feed_value_i64(&mut hasher, column.not_null);
            feed_optional_text(&mut hasher, column.default_value.as_deref());
            feed_value_i64(&mut hasher, column.primary_key);
            feed_value_i64(&mut hasher, column.hidden);
        }
        for foreign_key in &table.foreign_keys {
            feed_value_i64(&mut hasher, foreign_key.id);
            feed_value_i64(&mut hasher, foreign_key.sequence);
            feed_value_text(&mut hasher, &foreign_key.foreign_table);
            feed_value_text(&mut hasher, &foreign_key.from);
            feed_value_text(&mut hasher, &foreign_key.to);
            feed_value_text(&mut hasher, &foreign_key.on_update);
            feed_value_text(&mut hasher, &foreign_key.on_delete);
            feed_value_text(&mut hasher, &foreign_key.match_clause);
        }
        for index in &table.indexes {
            feed_value_i64(&mut hasher, index.sequence);
            feed_value_text(&mut hasher, &index.name);
            feed_value_i64(&mut hasher, index.unique);
            feed_value_text(&mut hasher, &index.origin);
            feed_value_i64(&mut hasher, index.partial);
        }
    }
    *hasher.finalize().as_bytes()
}

fn normalize_sql(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn feed_value_i64(hasher: &mut Hasher, value: i64) {
    feed_bytes(hasher, "integer", &value.to_be_bytes());
}

fn feed_value_text(hasher: &mut Hasher, value: &str) {
    feed_bytes(hasher, "text", value.as_bytes());
}

fn feed_optional_text(hasher: &mut Hasher, value: Option<&str>) {
    match value {
        Some(value) => feed_value_text(hasher, value),
        None => feed_bytes(hasher, "null", &[]),
    }
}

fn feed_i64(hasher: &mut Hasher, domain: &str, value: i64) {
    feed_bytes(hasher, domain, &value.to_be_bytes());
}

fn feed_text(hasher: &mut Hasher, domain: &str, value: &str) {
    feed_bytes(hasher, domain, value.as_bytes());
}

fn feed_bytes(hasher: &mut Hasher, domain: &str, value: &[u8]) {
    hasher.update(&(domain.len() as u64).to_be_bytes());
    hasher.update(domain.as_bytes());
    hasher.update(&(value.len() as u64).to_be_bytes());
    hasher.update(value);
}
