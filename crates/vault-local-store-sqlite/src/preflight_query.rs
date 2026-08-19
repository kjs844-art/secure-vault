//! The sole owner of the preflight SQLite connection and preflight SQL.

use std::path::Path;
use std::time::Duration;

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OptionalExtension, Row};

use crate::digest::LogicalDigestV1;
use crate::rows::{
    MAX_ROWS_PER_TABLE, MAX_TOTAL_REVISION_ENVELOPE_BYTES, UntrustedStoredRevisionV1,
};
use crate::schema_contract::{self, SchemaColumnV1, SchemaObjectV1, SchemaSnapshotV1};
use crate::{StorageError, StorageErrorCode};

enum PreflightQueryStage {
    ApplicationId,
    UserVersion,
    SchemaObjects,
    TableXInfo,
    ForeignKeys,
    Indexes,
    Integrity,
    ForeignKeyCheck,
    Password,
    Revisions,
    Heads,
    Conflicts,
    Digest,
}

pub(crate) struct PasswordRowV1 {
    pub(crate) wire_version: i64,
    pub(crate) suite_id: i64,
    pub(crate) envelope: Vec<u8>,
}

pub(crate) struct PreflightQueryGate {
    connection: Connection,
}

impl PreflightQueryGate {
    pub(crate) fn open_read_only(path: &Path) -> Result<Self, StorageError> {
        let connection = Connection::open_with_flags(path, schema_contract::read_only_open_flags())
            .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?;
        connection
            .load_extension_disable()
            .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?;
        Ok(Self { connection })
    }

    pub(crate) fn application_id(&mut self) -> Result<i64, StorageError> {
        self.observe(PreflightQueryStage::ApplicationId);
        self.connection
            .query_row("PRAGMA application_id", [], |row| row.get(0))
            .map_err(corrupt)
    }

    pub(crate) fn user_version(&mut self) -> Result<i64, StorageError> {
        self.observe(PreflightQueryStage::UserVersion);
        self.connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(corrupt)
    }

    pub(crate) fn schema_snapshot(&mut self) -> Result<SchemaSnapshotV1, StorageError> {
        self.observe(PreflightQueryStage::SchemaObjects);
        let mut objects_statement = self.connection.prepare(
            "SELECT type,name,tbl_name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name",
        ).map_err(corrupt)?;
        let objects = objects_statement
            .query_map([], |row| {
                Ok(SchemaObjectV1 {
                    kind: row.get(0)?,
                    name: row.get(1)?,
                    table: row.get(2)?,
                })
            })
            .map_err(corrupt)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(corrupt)?;
        drop(objects_statement);

        let mut columns = Vec::new();
        let mut foreign_key_counts = Vec::new();
        let mut index_counts = Vec::new();
        for table in ["conflicts", "heads", "revisions", "vault_state"] {
            self.observe(PreflightQueryStage::TableXInfo);
            let mut statement = self
                .connection
                .prepare(
                    "SELECT cid,name,type,\"notnull\",pk FROM pragma_table_xinfo(?1) ORDER BY cid",
                )
                .map_err(corrupt)?;
            let rows = statement
                .query_map([table], |row| {
                    Ok(SchemaColumnV1 {
                        table: table.to_owned(),
                        cid: row.get(0)?,
                        name: row.get(1)?,
                        kind: row.get(2)?,
                        not_null: row.get(3)?,
                        primary_key: row.get(4)?,
                    })
                })
                .map_err(corrupt)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(corrupt)?;
            columns.extend(rows);
            drop(statement);

            self.observe(PreflightQueryStage::ForeignKeys);
            let foreign_key_count = self
                .connection
                .query_row(
                    "SELECT count(*) FROM pragma_foreign_key_list(?1)",
                    [table],
                    |row| row.get(0),
                )
                .map_err(corrupt)?;
            foreign_key_counts.push((table.to_owned(), foreign_key_count));
            self.observe(PreflightQueryStage::Indexes);
            let index_count = self
                .connection
                .query_row(
                    "SELECT count(*) FROM pragma_index_list(?1)",
                    [table],
                    |row| row.get(0),
                )
                .map_err(corrupt)?;
            index_counts.push((table.to_owned(), index_count));
        }
        Ok(SchemaSnapshotV1 {
            objects,
            columns,
            foreign_key_counts: foreign_key_counts
                .try_into()
                .map_err(|_| StorageError::new(StorageErrorCode::CorruptStorage))?,
            index_counts: index_counts
                .try_into()
                .map_err(|_| StorageError::new(StorageErrorCode::CorruptStorage))?,
        })
    }

    pub(crate) fn verify_integrity(&mut self) -> Result<(), StorageError> {
        self.observe(PreflightQueryStage::Integrity);
        let integrity: String = self
            .connection
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(corrupt)?;
        if integrity != "ok" {
            return Err(StorageError::new(StorageErrorCode::CorruptStorage));
        }
        self.observe(PreflightQueryStage::ForeignKeyCheck);
        let violations: i64 = self
            .connection
            .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .map_err(corrupt)?;
        if violations == 0 {
            Ok(())
        } else {
            Err(StorageError::new(StorageErrorCode::CorruptStorage))
        }
    }

    pub(crate) fn password(&mut self) -> Result<PasswordRowV1, StorageError> {
        self.observe(PreflightQueryStage::Password);
        self.connection.query_row(
            "SELECT typeof(password_wire_version),password_wire_version,typeof(password_suite_id),password_suite_id,typeof(password_envelope),length(password_envelope),password_envelope FROM vault_state WHERE singleton=1",
            [], password_row,
        ).optional().map_err(corrupt)?.ok_or_else(|| StorageError::new(StorageErrorCode::CorruptStorage))
    }

    pub(crate) fn validate_and_digest(&mut self) -> Result<[u8; 32], StorageError> {
        let mut digest = LogicalDigestV1::new();
        self.digest_vault_state(&mut digest)?;
        self.digest_revisions(&mut digest)?;
        self.digest_heads(&mut digest)?;
        self.digest_conflicts(&mut digest)?;
        Ok(digest.finish())
    }

    pub(crate) fn with_revisions(
        &mut self,
        mut action: impl FnMut(UntrustedStoredRevisionV1<'_>) -> Result<(), StorageError>,
    ) -> Result<(), StorageError> {
        self.observe(PreflightQueryStage::Revisions);
        let mut statement = self.connection.prepare(
            "SELECT typeof(record_id),length(record_id),record_id,typeof(revision_id),length(revision_id),revision_id,typeof(wire_version),wire_version,typeof(suite_id),suite_id,typeof(key_epoch),key_epoch,typeof(padding_bucket),padding_bucket,typeof(envelope),length(envelope),envelope FROM revisions ORDER BY record_id,revision_id",
        ).map_err(corrupt)?;
        let mut query = statement.query([]).map_err(corrupt)?;
        let mut count = 0usize;
        while let Some(row) = query.next().map_err(corrupt)? {
            let revision = read_revision(row)?;
            count += 1;
            if count > MAX_ROWS_PER_TABLE {
                return Err(StorageError::new(StorageErrorCode::LimitsExceeded));
            }
            action(UntrustedStoredRevisionV1 {
                record_id: revision.record_id.as_slice(),
                revision_id: revision.revision_id.as_slice(),
                wire_version: revision.wire_version,
                suite_id: revision.suite_id,
                key_epoch: revision.key_epoch,
                padding_bucket: revision.padding_bucket,
                envelope: revision.envelope.as_slice(),
            })?;
        }
        Ok(())
    }

    fn digest_vault_state(&mut self, digest: &mut LogicalDigestV1) -> Result<(), StorageError> {
        self.observe(PreflightQueryStage::Digest);
        digest.table(0x01);
        let password = self.password()?;
        digest.row();
        digest.integer(1, 1);
        digest.integer(2, password.wire_version);
        digest.integer(3, password.suite_id);
        digest.blob(4, &password.envelope);
        digest.end_table();
        Ok(())
    }

    fn digest_revisions(&mut self, digest: &mut LogicalDigestV1) -> Result<(), StorageError> {
        self.observe(PreflightQueryStage::Digest);
        let mut statement = self.connection.prepare(
            "SELECT typeof(record_id),length(record_id),record_id,typeof(revision_id),length(revision_id),revision_id,typeof(wire_version),wire_version,typeof(suite_id),suite_id,typeof(key_epoch),key_epoch,typeof(padding_bucket),padding_bucket,typeof(envelope),length(envelope),envelope FROM revisions ORDER BY record_id,revision_id",
        ).map_err(corrupt)?;
        let mut query = statement.query([]).map_err(corrupt)?;
        digest.table(0x02);
        let mut count = 0usize;
        let mut aggregate = 0usize;
        while let Some(row) = query.next().map_err(corrupt)? {
            let revision = read_revision(row)?;
            count += 1;
            if count > MAX_ROWS_PER_TABLE {
                return Err(StorageError::new(StorageErrorCode::LimitsExceeded));
            }
            aggregate = aggregate
                .checked_add(revision.envelope.len())
                .ok_or_else(|| StorageError::new(StorageErrorCode::LimitsExceeded))?;
            if aggregate > MAX_TOTAL_REVISION_ENVELOPE_BYTES {
                return Err(StorageError::new(StorageErrorCode::LimitsExceeded));
            }
            digest.row();
            digest.blob(1, &revision.record_id);
            digest.blob(2, &revision.revision_id);
            digest.integer(3, revision.wire_version);
            digest.integer(4, revision.suite_id);
            digest.integer(5, revision.key_epoch);
            digest.integer(6, revision.padding_bucket);
            digest.blob(7, &revision.envelope);
        }
        digest.end_table();
        Ok(())
    }

    fn digest_heads(&mut self, digest: &mut LogicalDigestV1) -> Result<(), StorageError> {
        self.observe(PreflightQueryStage::Heads);
        let mut statement = self.connection.prepare("SELECT typeof(record_id),length(record_id),record_id,typeof(revision_id),length(revision_id),revision_id FROM heads ORDER BY record_id").map_err(corrupt)?;
        let mut query = statement.query([]).map_err(corrupt)?;
        digest.table(0x03);
        let mut count = 0usize;
        while let Some(row) = query.next().map_err(corrupt)? {
            count += 1;
            if count > MAX_ROWS_PER_TABLE {
                return Err(StorageError::new(StorageErrorCode::LimitsExceeded));
            }
            let (record, revision) = two_blobs(row, 0, 1, 2, 3, 4, 5, 16, 32)?;
            digest.row();
            digest.blob(1, &record);
            digest.blob(2, &revision);
        }
        digest.end_table();
        Ok(())
    }

    fn digest_conflicts(&mut self, digest: &mut LogicalDigestV1) -> Result<(), StorageError> {
        self.observe(PreflightQueryStage::Conflicts);
        let mut statement = self.connection.prepare("SELECT typeof(record_id),length(record_id),record_id,typeof(candidate_revision_id),length(candidate_revision_id),candidate_revision_id,typeof(expected_head_revision_id),length(expected_head_revision_id),expected_head_revision_id,typeof(observed_head_revision_id),length(observed_head_revision_id),observed_head_revision_id FROM conflicts ORDER BY record_id,candidate_revision_id").map_err(corrupt)?;
        let mut query = statement.query([]).map_err(corrupt)?;
        digest.table(0x04);
        let mut count = 0usize;
        while let Some(row) = query.next().map_err(corrupt)? {
            count += 1;
            if count > MAX_ROWS_PER_TABLE {
                return Err(StorageError::new(StorageErrorCode::LimitsExceeded));
            }
            let (record, candidate) = two_blobs(row, 0, 1, 2, 3, 4, 5, 16, 32)?;
            let expected = nullable_blob(row, 6, 7, 8, 32)?;
            let observed = checked_blob(row, 9, 10, 11, 32)?;
            digest.row();
            digest.blob(1, &record);
            digest.blob(2, &candidate);
            match expected {
                Some(value) => digest.blob(3, &value),
                None => digest.null(3),
            };
            digest.blob(4, &observed);
        }
        digest.end_table();
        Ok(())
    }

    fn observe(&self, _stage: PreflightQueryStage) {}
}

struct RevisionRow {
    record_id: Vec<u8>,
    revision_id: Vec<u8>,
    wire_version: i64,
    suite_id: i64,
    key_epoch: i64,
    padding_bucket: i64,
    envelope: Vec<u8>,
}

fn password_row(row: &Row<'_>) -> rusqlite::Result<PasswordRowV1> {
    if row.get::<_, String>(0)? != "integer"
        || row.get::<_, String>(2)? != "integer"
        || row.get::<_, String>(4)? != "blob"
    {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let length: i64 = row.get(5)?;
    if !(1..=schema_contract::MAX_ENVELOPE_BYTES).contains(&length) {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let envelope: Vec<u8> = row.get(6)?;
    if envelope.len() != usize::try_from(length).ok().unwrap_or(0) {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(PasswordRowV1 {
        wire_version: row.get(1)?,
        suite_id: row.get(3)?,
        envelope,
    })
}

fn read_revision(row: &Row<'_>) -> Result<RevisionRow, StorageError> {
    let record_id = checked_blob(row, 0, 1, 2, 16)?;
    let revision_id = checked_blob(row, 3, 4, 5, 32)?;
    let wire_version = checked_integer(row, 6, 7, 0, u32::MAX as i64)?;
    let suite_id = checked_integer(row, 8, 9, 0, u32::MAX as i64)?;
    let key_epoch = checked_integer(row, 10, 11, 1, u32::MAX as i64)?;
    let padding_bucket = checked_integer(row, 12, 13, 0, i64::MAX)?;
    if ![1024, 4096, 16384, 61440].contains(&padding_bucket) {
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }
    let envelope = checked_blob_range(
        row,
        14,
        15,
        16,
        1,
        schema_contract::MAX_ENVELOPE_BYTES as usize,
    )?;
    Ok(RevisionRow {
        record_id,
        revision_id,
        wire_version,
        suite_id,
        key_epoch,
        padding_bucket,
        envelope,
    })
}

fn two_blobs(
    row: &Row<'_>,
    first_type: usize,
    first_length: usize,
    first_value: usize,
    second_type: usize,
    second_length: usize,
    second_value: usize,
    first_size: usize,
    second_size: usize,
) -> Result<(Vec<u8>, Vec<u8>), StorageError> {
    Ok((
        checked_blob(row, first_type, first_length, first_value, first_size)?,
        checked_blob(row, second_type, second_length, second_value, second_size)?,
    ))
}
fn nullable_blob(
    row: &Row<'_>,
    type_column: usize,
    length_column: usize,
    value_column: usize,
    expected: usize,
) -> Result<Option<Vec<u8>>, StorageError> {
    if row.get::<_, String>(type_column).map_err(corrupt)? == "null" {
        return Ok(None);
    }
    checked_blob(row, type_column, length_column, value_column, expected).map(Some)
}
fn checked_blob(
    row: &Row<'_>,
    type_column: usize,
    length_column: usize,
    value_column: usize,
    expected: usize,
) -> Result<Vec<u8>, StorageError> {
    checked_blob_range(
        row,
        type_column,
        length_column,
        value_column,
        expected,
        expected,
    )
}
fn checked_blob_range(
    row: &Row<'_>,
    type_column: usize,
    length_column: usize,
    value_column: usize,
    minimum: usize,
    maximum: usize,
) -> Result<Vec<u8>, StorageError> {
    if row.get::<_, String>(type_column).map_err(corrupt)? != "blob" {
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }
    let length: i64 = row.get(length_column).map_err(corrupt)?;
    let Some(length) = usize::try_from(length).ok() else {
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    };
    if !(minimum..=maximum).contains(&length) {
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }
    let value = match row.get_ref(value_column).map_err(corrupt)? {
        ValueRef::Blob(value) => value.to_vec(),
        _ => return Err(StorageError::new(StorageErrorCode::CorruptStorage)),
    };
    if value.len() == length {
        Ok(value)
    } else {
        Err(StorageError::new(StorageErrorCode::CorruptStorage))
    }
}
fn checked_integer(
    row: &Row<'_>,
    type_column: usize,
    value_column: usize,
    minimum: i64,
    maximum: i64,
) -> Result<i64, StorageError> {
    if row.get::<_, String>(type_column).map_err(corrupt)? != "integer" {
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }
    let value: i64 = row.get(value_column).map_err(corrupt)?;
    if (minimum..=maximum).contains(&value) {
        Ok(value)
    } else {
        Err(StorageError::new(StorageErrorCode::CorruptStorage))
    }
}
fn corrupt<T>(_error: T) -> StorageError {
    StorageError::new(StorageErrorCode::CorruptStorage)
}
