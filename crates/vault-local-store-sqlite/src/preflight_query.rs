//! The sole owner of the preflight SQLite connection and preflight SQL.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::digest::LogicalDigestV1;
use crate::rows::{
    MAX_CONFLICTS, MAX_HEADS, MAX_REVISIONS, MAX_TOTAL_REVISION_ENVELOPE_BYTES, RevisionKeyV1,
    UntrustedStoredRevisionV1,
};
use crate::schema_contract::{
    self, SchemaColumnV1, SchemaForeignKeyV1, SchemaIndexV1, SchemaObjectV1, SchemaSnapshotV1,
    SchemaTableSnapshotV1,
};
use crate::{StorageError, StorageErrorCode};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PreflightQueryStage {
    ApplicationId,
    UserVersion,
    PageCount,
    PageSize,
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
}

const KEYSET_PAGE_ROWS: usize = 256;
const KEYSET_QUERY_LIMIT: i64 = KEYSET_PAGE_ROWS as i64 + 1;
const MAX_SCHEMA_TEXT_BYTES: usize = 64 * 1024;

// These are local adversarial-input limits, not product quotas. The post-open
// page budget starts with the admitted 128 MiB revision-envelope aggregate and
// one 64 KiB password envelope. It then allows one 4 KiB SQLite page of
// structure/slack per admitted logical row plus 64 fixed schema/B-tree pages.
// The coarse pre-open main/WAL limits are twice that bounded page budget; SHM
// is index metadata and receives one thirty-second of it plus one 32 KiB region.
const SQLITE_ROW_OVERHEAD_BYTES: u64 = 4 * 1024;
const SQLITE_FIXED_OVERHEAD_PAGES: u64 = 64;
const MAX_LOGICAL_ROWS: u64 = 1 + MAX_REVISIONS as u64 + MAX_HEADS as u64 + MAX_CONFLICTS as u64;
const MAX_DATABASE_PAGE_BYTES: u64 = MAX_TOTAL_REVISION_ENVELOPE_BYTES as u64
    + schema_contract::MAX_ENVELOPE_BYTES as u64
    + (MAX_LOGICAL_ROWS + SQLITE_FIXED_OVERHEAD_PAGES) * SQLITE_ROW_OVERHEAD_BYTES;
const MAX_PREOPEN_MAIN_BYTES: u64 = MAX_DATABASE_PAGE_BYTES * 2;
const MAX_PREOPEN_WAL_BYTES: u64 = MAX_DATABASE_PAGE_BYTES * 2;
const MAX_PREOPEN_SHM_BYTES: u64 = MAX_DATABASE_PAGE_BYTES / 32 + 32 * 1024;

#[derive(Clone, Copy)]
struct StorageSizeLimits {
    max_main_bytes: u64,
    max_wal_bytes: u64,
    max_shm_bytes: u64,
}

impl StorageSizeLimits {
    const fn production() -> Self {
        Self {
            max_main_bytes: MAX_PREOPEN_MAIN_BYTES,
            max_wal_bytes: MAX_PREOPEN_WAL_BYTES,
            max_shm_bytes: MAX_PREOPEN_SHM_BYTES,
        }
    }

    #[cfg(test)]
    const fn reduced(max_main_bytes: u64, max_wal_bytes: u64, max_shm_bytes: u64) -> Self {
        Self {
            max_main_bytes,
            max_wal_bytes,
            max_shm_bytes,
        }
    }
}

#[derive(Clone, Copy)]
struct ScanLimits {
    page_rows: usize,
    query_limit: i64,
    max_revisions: usize,
    max_heads: usize,
    max_conflicts: usize,
    max_total_revision_envelope_bytes: usize,
}

impl ScanLimits {
    const fn production() -> Self {
        Self {
            page_rows: KEYSET_PAGE_ROWS,
            query_limit: KEYSET_QUERY_LIMIT,
            max_revisions: MAX_REVISIONS,
            max_heads: MAX_HEADS,
            max_conflicts: MAX_CONFLICTS,
            max_total_revision_envelope_bytes: MAX_TOTAL_REVISION_ENVELOPE_BYTES,
        }
    }

    #[cfg(test)]
    fn reduced(
        page_rows: usize,
        max_revisions: usize,
        max_heads: usize,
        max_conflicts: usize,
        aggregate_bytes: usize,
    ) -> Self {
        Self {
            page_rows,
            query_limit: i64::try_from(page_rows)
                .expect("test page size must fit i64")
                .checked_add(1)
                .expect("test query limit must fit i64"),
            max_revisions,
            max_heads,
            max_conflicts,
            max_total_revision_envelope_bytes: aggregate_bytes,
        }
    }
}

pub(crate) struct PasswordRowV1 {
    pub(crate) wire_version: i64,
    pub(crate) suite_id: i64,
    pub(crate) envelope: Vec<u8>,
}

pub(crate) struct PreflightQueryGate {
    connection: Connection,
    limits: ScanLimits,
    observer: PreflightObserver,
}

impl PreflightQueryGate {
    pub(crate) fn open_read_only(path: &Path) -> Result<Self, StorageError> {
        Self::open_read_only_with_size_limits(path, StorageSizeLimits::production())
    }

    fn open_read_only_with_size_limits(
        path: &Path,
        size_limits: StorageSizeLimits,
    ) -> Result<Self, StorageError> {
        let observer = PreflightObserver::active();
        validate_pre_open_file_sizes(path, size_limits)?;
        observer.sqlite_open_attempt();
        let connection = Connection::open_with_flags(path, schema_contract::read_only_open_flags())
            .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?;
        connection
            .load_extension_disable()
            .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?;
        connection
            .execute_batch("BEGIN")
            .map_err(|_| StorageError::new(StorageErrorCode::Busy))?;
        Ok(Self {
            connection,
            limits: ScanLimits::production(),
            observer,
        })
    }

    pub(crate) fn open_hardened_writable(path: &Path) -> Result<Self, StorageError> {
        let size_limits = StorageSizeLimits::production();
        validate_pre_open_file_sizes(path, size_limits)?;
        let connection = crate::schema::open_existing_writable(path)?;
        Ok(Self {
            connection,
            limits: ScanLimits::production(),
            observer: PreflightObserver::active(),
        })
    }

    pub(crate) fn begin_immediate(&self) -> Result<(), StorageError> {
        self.connection
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|_| StorageError::new(StorageErrorCode::Busy))
    }

    pub(crate) fn commit_immediate(&self) -> Result<(), StorageError> {
        self.connection
            .execute_batch("COMMIT")
            .map_err(|_| StorageError::new(StorageErrorCode::Io))
    }

    pub(crate) fn into_connection(self) -> Connection {
        self.connection
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
            "SELECT type,name,tbl_name,coalesce(sql,'') FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name",
        ).map_err(corrupt)?;
        let mut object_rows = objects_statement.query([]).map_err(corrupt)?;
        let mut objects = Vec::with_capacity(8);
        while let Some(row) = object_rows.next().map_err(corrupt)? {
            if objects.len() == 8 {
                return Err(StorageError::new(StorageErrorCode::CorruptStorage));
            }
            objects.push(SchemaObjectV1 {
                kind: bounded_text(row, 0, MAX_SCHEMA_TEXT_BYTES)?,
                name: bounded_text(row, 1, MAX_SCHEMA_TEXT_BYTES)?,
                table: bounded_text(row, 2, MAX_SCHEMA_TEXT_BYTES)?,
                sql: bounded_text(row, 3, MAX_SCHEMA_TEXT_BYTES)?,
            });
        }
        drop(object_rows);
        drop(objects_statement);

        let mut tables = Vec::with_capacity(4);
        for table in ["conflicts", "heads", "revisions", "vault_state"] {
            self.observe(PreflightQueryStage::TableXInfo);
            let mut statement = self
                .connection
                .prepare(
                    "SELECT cid,name,type,\"notnull\",dflt_value,pk,hidden FROM pragma_table_xinfo(?1) ORDER BY cid",
                )
                .map_err(corrupt)?;
            let mut rows = statement.query([table]).map_err(corrupt)?;
            let mut columns = Vec::with_capacity(7);
            while let Some(row) = rows.next().map_err(corrupt)? {
                if columns.len() == 7 {
                    return Err(StorageError::new(StorageErrorCode::CorruptStorage));
                }
                columns.push(SchemaColumnV1 {
                    cid: row.get(0).map_err(corrupt)?,
                    name: bounded_text(row, 1, MAX_SCHEMA_TEXT_BYTES)?,
                    kind: bounded_text(row, 2, MAX_SCHEMA_TEXT_BYTES)?,
                    not_null: row.get(3).map_err(corrupt)?,
                    default_value: bounded_optional_text(row, 4, MAX_SCHEMA_TEXT_BYTES)?,
                    primary_key: row.get(5).map_err(corrupt)?,
                    hidden: row.get(6).map_err(corrupt)?,
                });
            }
            drop(rows);
            drop(statement);

            self.observe(PreflightQueryStage::ForeignKeys);
            let mut statement = self
                .connection
                .prepare(
                    "SELECT id,seq,\"table\",\"from\",\"to\",on_update,on_delete,match FROM pragma_foreign_key_list(?1) ORDER BY id,seq",
                )
                .map_err(corrupt)?;
            let mut rows = statement.query([table]).map_err(corrupt)?;
            let mut foreign_keys = Vec::with_capacity(6);
            while let Some(row) = rows.next().map_err(corrupt)? {
                if foreign_keys.len() == 6 {
                    return Err(StorageError::new(StorageErrorCode::CorruptStorage));
                }
                foreign_keys.push(SchemaForeignKeyV1 {
                    id: row.get(0).map_err(corrupt)?,
                    sequence: row.get(1).map_err(corrupt)?,
                    foreign_table: bounded_text(row, 2, MAX_SCHEMA_TEXT_BYTES)?,
                    from: bounded_text(row, 3, MAX_SCHEMA_TEXT_BYTES)?,
                    to: bounded_text(row, 4, MAX_SCHEMA_TEXT_BYTES)?,
                    on_update: bounded_text(row, 5, MAX_SCHEMA_TEXT_BYTES)?,
                    on_delete: bounded_text(row, 6, MAX_SCHEMA_TEXT_BYTES)?,
                    match_clause: bounded_text(row, 7, MAX_SCHEMA_TEXT_BYTES)?,
                });
            }
            drop(rows);
            drop(statement);

            self.observe(PreflightQueryStage::Indexes);
            let mut statement = self
                .connection
                .prepare(
                    "SELECT seq,name,\"unique\",origin,partial FROM pragma_index_list(?1) ORDER BY name,seq",
                )
                .map_err(corrupt)?;
            let mut rows = statement.query([table]).map_err(corrupt)?;
            let mut indexes = Vec::with_capacity(1);
            while let Some(row) = rows.next().map_err(corrupt)? {
                if indexes.len() == 1 {
                    return Err(StorageError::new(StorageErrorCode::CorruptStorage));
                }
                indexes.push(SchemaIndexV1 {
                    sequence: row.get(0).map_err(corrupt)?,
                    name: bounded_text(row, 1, MAX_SCHEMA_TEXT_BYTES)?,
                    unique: row.get(2).map_err(corrupt)?,
                    origin: bounded_text(row, 3, MAX_SCHEMA_TEXT_BYTES)?,
                    partial: row.get(4).map_err(corrupt)?,
                });
            }
            drop(rows);
            drop(statement);
            tables.push(SchemaTableSnapshotV1 {
                name: table.to_owned(),
                columns,
                foreign_keys,
                indexes,
            });
        }
        Ok(SchemaSnapshotV1 {
            objects,
            tables: tables
                .try_into()
                .map_err(|_| StorageError::new(StorageErrorCode::CorruptStorage))?,
        })
    }

    pub(crate) fn verify_bounded_integrity(&mut self) -> Result<(), StorageError> {
        self.verify_bounded_integrity_with_page_limit(MAX_DATABASE_PAGE_BYTES)
    }

    fn verify_bounded_integrity_with_page_limit(
        &mut self,
        max_database_page_bytes: u64,
    ) -> Result<(), StorageError> {
        self.observe(PreflightQueryStage::PageCount);
        let page_count: i64 = self
            .connection
            .query_row("PRAGMA page_count", [], |row| row.get(0))
            .map_err(corrupt)?;
        self.observe(PreflightQueryStage::PageSize);
        let page_size: i64 = self
            .connection
            .query_row("PRAGMA page_size", [], |row| row.get(0))
            .map_err(corrupt)?;
        let page_count = u64::try_from(page_count)
            .map_err(|_| StorageError::new(StorageErrorCode::CorruptStorage))?;
        let page_size = u64::try_from(page_size)
            .ok()
            .filter(|size| *size > 0)
            .ok_or_else(|| StorageError::new(StorageErrorCode::CorruptStorage))?;
        let page_bytes = page_count
            .checked_mul(page_size)
            .ok_or_else(|| StorageError::new(StorageErrorCode::LimitsExceeded))?;
        if page_bytes > max_database_page_bytes {
            return Err(StorageError::new(StorageErrorCode::LimitsExceeded));
        }

        self.observe(PreflightQueryStage::Integrity);
        let integrity_ok = self
            .connection
            .query_row("PRAGMA integrity_check(1)", [], |row| {
                Ok(matches!(row.get_ref(0)?, ValueRef::Text(b"ok")))
            })
            .map_err(corrupt)?;
        if integrity_ok {
            Ok(())
        } else {
            Err(StorageError::new(StorageErrorCode::CorruptStorage))
        }
    }

    pub(crate) fn verify_foreign_keys(&mut self) -> Result<(), StorageError> {
        self.observe(PreflightQueryStage::ForeignKeyCheck);
        let violation = self
            .connection
            .query_row(
                "SELECT 1 FROM pragma_foreign_key_check LIMIT 1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(corrupt)?;
        if violation.is_none() {
            Ok(())
        } else {
            Err(StorageError::new(StorageErrorCode::CorruptStorage))
        }
    }

    pub(crate) fn password(&mut self) -> Result<PasswordRowV1, StorageError> {
        let observer = self.observer.clone();
        self.observe(PreflightQueryStage::Password);
        self.connection
            .query_row(
                "SELECT typeof(password_wire_version),password_wire_version,typeof(password_suite_id),password_suite_id,typeof(password_envelope),length(password_envelope),password_envelope FROM vault_state WHERE singleton=1",
                [],
                |row| password_row(row, &observer),
            )
            .optional()
            .map_err(corrupt)?
            .ok_or_else(|| StorageError::new(StorageErrorCode::CorruptStorage))
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
        let mut count = 0usize;
        let mut aggregate = 0usize;
        let mut cursor = None;
        loop {
            let has_more =
                self.scan_revision_page(&mut cursor, &mut count, &mut aggregate, |revision| {
                    action(UntrustedStoredRevisionV1 {
                        record_id: revision.record_id.as_slice(),
                        revision_id: revision.revision_id.as_slice(),
                        wire_version: revision.wire_version,
                        suite_id: revision.suite_id,
                        key_epoch: revision.key_epoch,
                        padding_bucket: revision.padding_bucket,
                        envelope: revision.envelope.as_slice(),
                    })
                })?;
            if !has_more {
                break;
            }
        }
        Ok(())
    }

    pub(crate) fn current_head_keys(&mut self) -> Result<BTreeSet<RevisionKeyV1>, StorageError> {
        let mut heads = BTreeSet::new();
        let mut count = 0usize;
        let mut cursor = None;
        loop {
            let has_more = self.scan_head_page(&mut cursor, &mut count, |head| {
                let record_id: [u8; 16] = head
                    .record_id
                    .as_slice()
                    .try_into()
                    .map_err(|_| StorageError::new(StorageErrorCode::CorruptStorage))?;
                let revision_id: [u8; 32] = head
                    .revision_id
                    .as_slice()
                    .try_into()
                    .map_err(|_| StorageError::new(StorageErrorCode::CorruptStorage))?;
                if !heads.insert((record_id, revision_id)) {
                    return Err(StorageError::new(StorageErrorCode::CorruptStorage));
                }
                Ok(())
            })?;
            if !has_more {
                break;
            }
        }
        Ok(heads)
    }

    fn digest_vault_state(&mut self, digest: &mut LogicalDigestV1) -> Result<(), StorageError> {
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
        digest.table(0x02);
        let mut count = 0usize;
        let mut aggregate = 0usize;
        let mut cursor = None;
        loop {
            let has_more =
                self.scan_revision_page(&mut cursor, &mut count, &mut aggregate, |revision| {
                    digest.row();
                    digest.blob(1, &revision.record_id);
                    digest.blob(2, &revision.revision_id);
                    digest.integer(3, revision.wire_version);
                    digest.integer(4, revision.suite_id);
                    digest.integer(5, revision.key_epoch);
                    digest.integer(6, revision.padding_bucket);
                    digest.blob(7, &revision.envelope);
                    Ok(())
                })?;
            if !has_more {
                break;
            }
        }
        digest.end_table();
        Ok(())
    }

    fn digest_heads(&mut self, digest: &mut LogicalDigestV1) -> Result<(), StorageError> {
        digest.table(0x03);
        let mut count = 0usize;
        let mut cursor = None;
        loop {
            let has_more = self.scan_head_page(&mut cursor, &mut count, |head| {
                digest.row();
                digest.blob(1, &head.record_id);
                digest.blob(2, &head.revision_id);
                Ok(())
            })?;
            if !has_more {
                break;
            }
        }
        digest.end_table();
        Ok(())
    }

    fn digest_conflicts(&mut self, digest: &mut LogicalDigestV1) -> Result<(), StorageError> {
        digest.table(0x04);
        let mut count = 0usize;
        let mut cursor = None;
        loop {
            let has_more = self.scan_conflict_page(&mut cursor, &mut count, |conflict| {
                digest.row();
                digest.blob(1, &conflict.record_id);
                digest.blob(2, &conflict.candidate_revision_id);
                match conflict.expected_head_revision_id.as_deref() {
                    Some(value) => digest.blob(3, value),
                    None => digest.null(3),
                }
                digest.blob(4, &conflict.observed_head_revision_id);
                Ok(())
            })?;
            if !has_more {
                break;
            }
        }
        digest.end_table();
        Ok(())
    }

    fn scan_revision_page(
        &mut self,
        cursor: &mut Option<(Vec<u8>, Vec<u8>)>,
        count: &mut usize,
        aggregate: &mut usize,
        mut visit: impl FnMut(&RevisionRow) -> Result<(), StorageError>,
    ) -> Result<bool, StorageError> {
        let _page = self.observer.begin_page("revisions");
        let _sql_resources = self.observer.begin_sql_resources("revisions");
        self.observe(PreflightQueryStage::Revisions);
        let mut statement = self.connection.prepare(
            "SELECT typeof(record_id),length(record_id),record_id,typeof(revision_id),length(revision_id),revision_id,typeof(wire_version),wire_version,typeof(suite_id),suite_id,typeof(key_epoch),key_epoch,typeof(padding_bucket),padding_bucket,typeof(envelope),length(envelope),envelope FROM revisions WHERE (?1 IS NULL OR record_id > ?1 OR (record_id = ?1 AND revision_id > ?2)) ORDER BY record_id,revision_id LIMIT ?3",
        ).map_err(corrupt)?;
        let (record, revision): (Option<&[u8]>, Option<&[u8]>) = match cursor.as_ref() {
            Some((record, revision)) => (Some(record.as_slice()), Some(revision.as_slice())),
            None => (None, None),
        };
        let mut query = statement
            .query(params![record, revision, self.limits.query_limit])
            .map_err(corrupt)?;
        let mut seen = 0usize;
        while let Some(row) = query.next().map_err(corrupt)? {
            seen = seen
                .checked_add(1)
                .ok_or_else(|| StorageError::new(StorageErrorCode::LimitsExceeded))?;
            if seen > self.limits.page_rows {
                self.observer.existence_row("revisions");
                return Ok(true);
            }
            let _row = self.observer.begin_row("revisions");
            increment_row_count(count, self.limits.max_revisions)?;
            let metadata = read_revision_metadata(row, &self.observer)?;
            let next_aggregate = aggregate.checked_add(metadata.envelope_length);
            self.observer
                .aggregate_checked(*aggregate, metadata.envelope_length, next_aggregate);
            let Some(next_aggregate) = next_aggregate else {
                return Err(StorageError::new(StorageErrorCode::LimitsExceeded));
            };
            if next_aggregate > self.limits.max_total_revision_envelope_bytes {
                return Err(StorageError::new(StorageErrorCode::LimitsExceeded));
            }
            let envelope = copy_blob_exact(
                row,
                16,
                metadata.envelope_length,
                "revisions.envelope",
                &self.observer,
            )?;
            *aggregate = next_aggregate;
            let revision = RevisionRow {
                record_id: metadata.record_id,
                revision_id: metadata.revision_id,
                wire_version: metadata.wire_version,
                suite_id: metadata.suite_id,
                key_epoch: metadata.key_epoch,
                padding_bucket: metadata.padding_bucket,
                envelope,
            };
            *cursor = Some((revision.record_id.clone(), revision.revision_id.clone()));
            visit(&revision)?;
        }
        Ok(false)
    }

    fn scan_head_page(
        &mut self,
        cursor: &mut Option<Vec<u8>>,
        count: &mut usize,
        mut visit: impl FnMut(&HeadRow) -> Result<(), StorageError>,
    ) -> Result<bool, StorageError> {
        let _page = self.observer.begin_page("heads");
        let _sql_resources = self.observer.begin_sql_resources("heads");
        self.observe(PreflightQueryStage::Heads);
        let mut statement = self.connection.prepare(
            "SELECT typeof(record_id),length(record_id),record_id,typeof(revision_id),length(revision_id),revision_id FROM heads WHERE (?1 IS NULL OR record_id > ?1) ORDER BY record_id LIMIT ?2",
        ).map_err(corrupt)?;
        let record = cursor.as_deref();
        let mut query = statement
            .query(params![record, self.limits.query_limit])
            .map_err(corrupt)?;
        let mut seen = 0usize;
        while let Some(row) = query.next().map_err(corrupt)? {
            seen = seen
                .checked_add(1)
                .ok_or_else(|| StorageError::new(StorageErrorCode::LimitsExceeded))?;
            if seen > self.limits.page_rows {
                self.observer.existence_row("heads");
                return Ok(true);
            }
            let _row = self.observer.begin_row("heads");
            increment_row_count(count, self.limits.max_heads)?;
            let head = HeadRow {
                record_id: checked_blob(row, 0, 1, 2, 16, "heads.record_id", &self.observer)?,
                revision_id: checked_blob(row, 3, 4, 5, 32, "heads.revision_id", &self.observer)?,
            };
            *cursor = Some(head.record_id.clone());
            visit(&head)?;
        }
        Ok(false)
    }

    fn scan_conflict_page(
        &mut self,
        cursor: &mut Option<(Vec<u8>, Vec<u8>)>,
        count: &mut usize,
        mut visit: impl FnMut(&ConflictRow) -> Result<(), StorageError>,
    ) -> Result<bool, StorageError> {
        let _page = self.observer.begin_page("conflicts");
        let _sql_resources = self.observer.begin_sql_resources("conflicts");
        self.observe(PreflightQueryStage::Conflicts);
        let mut statement = self.connection.prepare(
            "SELECT typeof(record_id),length(record_id),record_id,typeof(candidate_revision_id),length(candidate_revision_id),candidate_revision_id,typeof(expected_head_revision_id),length(expected_head_revision_id),expected_head_revision_id,typeof(observed_head_revision_id),length(observed_head_revision_id),observed_head_revision_id FROM conflicts WHERE (?1 IS NULL OR record_id > ?1 OR (record_id = ?1 AND candidate_revision_id > ?2)) ORDER BY record_id,candidate_revision_id LIMIT ?3",
        ).map_err(corrupt)?;
        let (record, candidate): (Option<&[u8]>, Option<&[u8]>) = match cursor.as_ref() {
            Some((record, candidate)) => (Some(record.as_slice()), Some(candidate.as_slice())),
            None => (None, None),
        };
        let mut query = statement
            .query(params![record, candidate, self.limits.query_limit])
            .map_err(corrupt)?;
        let mut seen = 0usize;
        while let Some(row) = query.next().map_err(corrupt)? {
            seen = seen
                .checked_add(1)
                .ok_or_else(|| StorageError::new(StorageErrorCode::LimitsExceeded))?;
            if seen > self.limits.page_rows {
                self.observer.existence_row("conflicts");
                return Ok(true);
            }
            let _row = self.observer.begin_row("conflicts");
            increment_row_count(count, self.limits.max_conflicts)?;
            let conflict = ConflictRow {
                record_id: checked_blob(row, 0, 1, 2, 16, "conflicts.record_id", &self.observer)?,
                candidate_revision_id: checked_blob(
                    row,
                    3,
                    4,
                    5,
                    32,
                    "conflicts.candidate_revision_id",
                    &self.observer,
                )?,
                expected_head_revision_id: nullable_blob(
                    row,
                    6,
                    7,
                    8,
                    32,
                    "conflicts.expected_head_revision_id",
                    &self.observer,
                )?,
                observed_head_revision_id: checked_blob(
                    row,
                    9,
                    10,
                    11,
                    32,
                    "conflicts.observed_head_revision_id",
                    &self.observer,
                )?,
            };
            *cursor = Some((
                conflict.record_id.clone(),
                conflict.candidate_revision_id.clone(),
            ));
            visit(&conflict)?;
        }
        Ok(false)
    }

    fn observe(&self, stage: PreflightQueryStage) {
        self.observer.query(stage);
    }
}

struct RevisionMetadata {
    record_id: Vec<u8>,
    revision_id: Vec<u8>,
    wire_version: i64,
    suite_id: i64,
    key_epoch: i64,
    padding_bucket: i64,
    envelope_length: usize,
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

struct HeadRow {
    record_id: Vec<u8>,
    revision_id: Vec<u8>,
}

struct ConflictRow {
    record_id: Vec<u8>,
    candidate_revision_id: Vec<u8>,
    expected_head_revision_id: Option<Vec<u8>>,
    observed_head_revision_id: Vec<u8>,
}

fn bounded_text(row: &Row<'_>, column: usize, maximum: usize) -> Result<String, StorageError> {
    match row.get_ref(column).map_err(corrupt)? {
        ValueRef::Text(value) if value.len() <= maximum => std::str::from_utf8(value)
            .map(str::to_owned)
            .map_err(corrupt),
        _ => Err(StorageError::new(StorageErrorCode::CorruptStorage)),
    }
}

fn bounded_optional_text(
    row: &Row<'_>,
    column: usize,
    maximum: usize,
) -> Result<Option<String>, StorageError> {
    match row.get_ref(column).map_err(corrupt)? {
        ValueRef::Null => Ok(None),
        ValueRef::Text(value) if value.len() <= maximum => std::str::from_utf8(value)
            .map(str::to_owned)
            .map(Some)
            .map_err(corrupt),
        _ => Err(StorageError::new(StorageErrorCode::CorruptStorage)),
    }
}

fn password_row(row: &Row<'_>, observer: &PreflightObserver) -> rusqlite::Result<PasswordRowV1> {
    if row.get::<_, String>(0)? != "integer" || row.get::<_, String>(2)? != "integer" {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let wire_version: i64 = row.get(1)?;
    let suite_id: i64 = row.get(3)?;
    if !(0..=u32::MAX as i64).contains(&wire_version) || !(0..=u32::MAX as i64).contains(&suite_id)
    {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let length = checked_blob_metadata_sqlite(
        row,
        4,
        5,
        1,
        schema_contract::MAX_ENVELOPE_BYTES as usize,
        "vault_state.password_envelope",
        observer,
    )?;
    let envelope =
        copy_blob_exact_sqlite(row, 6, length, "vault_state.password_envelope", observer)?;
    Ok(PasswordRowV1 {
        wire_version,
        suite_id,
        envelope,
    })
}

fn read_revision_metadata(
    row: &Row<'_>,
    observer: &PreflightObserver,
) -> Result<RevisionMetadata, StorageError> {
    let record_id = checked_blob(row, 0, 1, 2, 16, "revisions.record_id", observer)?;
    let revision_id = checked_blob(row, 3, 4, 5, 32, "revisions.revision_id", observer)?;
    let wire_version = checked_integer(row, 6, 7, 0, u32::MAX as i64)?;
    let suite_id = checked_integer(row, 8, 9, 0, u32::MAX as i64)?;
    let key_epoch = checked_integer(row, 10, 11, 1, u32::MAX as i64)?;
    let padding_bucket = checked_integer(row, 12, 13, 0, i64::MAX)?;
    if ![1024, 4096, 16384, 61440].contains(&padding_bucket) {
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }
    let envelope_length = checked_blob_metadata(
        row,
        14,
        15,
        1,
        schema_contract::MAX_ENVELOPE_BYTES as usize,
        "revisions.envelope",
        observer,
    )?;
    Ok(RevisionMetadata {
        record_id,
        revision_id,
        wire_version,
        suite_id,
        key_epoch,
        padding_bucket,
        envelope_length,
    })
}

fn increment_row_count(count: &mut usize, maximum: usize) -> Result<(), StorageError> {
    *count = count
        .checked_add(1)
        .ok_or_else(|| StorageError::new(StorageErrorCode::LimitsExceeded))?;
    if *count > maximum {
        Err(StorageError::new(StorageErrorCode::LimitsExceeded))
    } else {
        Ok(())
    }
}

fn nullable_blob(
    row: &Row<'_>,
    type_column: usize,
    length_column: usize,
    value_column: usize,
    expected: usize,
    label: &'static str,
    observer: &PreflightObserver,
) -> Result<Option<Vec<u8>>, StorageError> {
    let kind: String = row.get(type_column).map_err(corrupt)?;
    observer.blob_type_checked(label);
    if kind == "null" {
        let length: Option<i64> = row.get(length_column).map_err(corrupt)?;
        observer.blob_length_checked(label, None);
        if length.is_some()
            || !matches!(row.get_ref(value_column).map_err(corrupt)?, ValueRef::Null)
        {
            return Err(StorageError::new(StorageErrorCode::CorruptStorage));
        }
        return Ok(None);
    }
    if kind != "blob" {
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }
    let length = checked_blob_length(row, length_column, expected, expected, label, observer)?;
    copy_blob_exact(row, value_column, length, label, observer).map(Some)
}

fn checked_blob(
    row: &Row<'_>,
    type_column: usize,
    length_column: usize,
    value_column: usize,
    expected: usize,
    label: &'static str,
    observer: &PreflightObserver,
) -> Result<Vec<u8>, StorageError> {
    let length = checked_blob_metadata(
        row,
        type_column,
        length_column,
        expected,
        expected,
        label,
        observer,
    )?;
    copy_blob_exact(row, value_column, length, label, observer)
}

fn checked_blob_metadata(
    row: &Row<'_>,
    type_column: usize,
    length_column: usize,
    minimum: usize,
    maximum: usize,
    label: &'static str,
    observer: &PreflightObserver,
) -> Result<usize, StorageError> {
    if row.get::<_, String>(type_column).map_err(corrupt)? != "blob" {
        observer.blob_type_checked(label);
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }
    observer.blob_type_checked(label);
    checked_blob_length(row, length_column, minimum, maximum, label, observer)
}

fn checked_blob_metadata_sqlite(
    row: &Row<'_>,
    type_column: usize,
    length_column: usize,
    minimum: usize,
    maximum: usize,
    label: &'static str,
    observer: &PreflightObserver,
) -> rusqlite::Result<usize> {
    if row.get::<_, String>(type_column)? != "blob" {
        observer.blob_type_checked(label);
        return Err(rusqlite::Error::InvalidQuery);
    }
    observer.blob_type_checked(label);
    let length: i64 = row.get(length_column)?;
    let length = usize::try_from(length).map_err(|_| rusqlite::Error::InvalidQuery)?;
    observer.blob_length_checked(label, Some(length));
    if (minimum..=maximum).contains(&length) {
        Ok(length)
    } else {
        Err(rusqlite::Error::InvalidQuery)
    }
}

fn checked_blob_length(
    row: &Row<'_>,
    length_column: usize,
    minimum: usize,
    maximum: usize,
    label: &'static str,
    observer: &PreflightObserver,
) -> Result<usize, StorageError> {
    let length: i64 = row.get(length_column).map_err(corrupt)?;
    let Some(length) = usize::try_from(length).ok() else {
        observer.blob_length_checked(label, None);
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    };
    observer.blob_length_checked(label, Some(length));
    if (minimum..=maximum).contains(&length) {
        Ok(length)
    } else {
        Err(StorageError::new(StorageErrorCode::CorruptStorage))
    }
}

fn copy_blob_exact(
    row: &Row<'_>,
    value_column: usize,
    expected: usize,
    label: &'static str,
    observer: &PreflightObserver,
) -> Result<Vec<u8>, StorageError> {
    let value = match row.get_ref(value_column).map_err(corrupt)? {
        ValueRef::Blob(value) if value.len() == expected => value.to_vec(),
        _ => return Err(StorageError::new(StorageErrorCode::CorruptStorage)),
    };
    observer.blob_copied(label, value.len());
    Ok(value)
}

fn copy_blob_exact_sqlite(
    row: &Row<'_>,
    value_column: usize,
    expected: usize,
    label: &'static str,
    observer: &PreflightObserver,
) -> rusqlite::Result<Vec<u8>> {
    let value = match row.get_ref(value_column)? {
        ValueRef::Blob(value) if value.len() == expected => value.to_vec(),
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    observer.blob_copied(label, value.len());
    Ok(value)
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

fn validate_pre_open_file_sizes(
    database_path: &Path,
    limits: StorageSizeLimits,
) -> Result<(), StorageError> {
    for (path, maximum) in [
        (database_path.to_path_buf(), limits.max_main_bytes),
        (sidecar_path(database_path, "-wal"), limits.max_wal_bytes),
        (sidecar_path(database_path, "-shm"), limits.max_shm_bytes),
    ] {
        match fs::metadata(path) {
            Ok(metadata) if metadata.len() > maximum => {
                return Err(StorageError::new(StorageErrorCode::LimitsExceeded));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(StorageError::new(StorageErrorCode::Io)),
        }
    }
    Ok(())
}

fn sidecar_path(database_path: &Path, suffix: &str) -> PathBuf {
    let mut path = database_path.as_os_str().to_os_string();
    path.push(suffix);
    PathBuf::from(path)
}

fn corrupt<T>(_error: T) -> StorageError {
    StorageError::new(StorageErrorCode::CorruptStorage)
}

#[derive(Clone, Default)]
struct PreflightObserver {
    #[cfg(test)]
    state: Option<std::rc::Rc<TestObserverState>>,
}

impl PreflightObserver {
    fn active() -> Self {
        #[cfg(test)]
        {
            ACTIVE_TEST_OBSERVER.with(|active| Self {
                state: active.borrow().clone(),
            })
        }
        #[cfg(not(test))]
        {
            Self::default()
        }
    }

    fn sqlite_open_attempt(&self) {
        #[cfg(test)]
        self.event(TestEvent::SqliteOpenAttempt);
    }

    fn query(&self, _stage: PreflightQueryStage) {
        #[cfg(test)]
        self.event(TestEvent::Query(_stage));
    }

    fn begin_page(&self, _table: &'static str) -> PageObservation {
        #[cfg(test)]
        self.event(TestEvent::PageBegin(_table));
        PageObservation {
            #[cfg(test)]
            observer: self.clone(),
            #[cfg(test)]
            table: _table,
        }
    }

    fn existence_row(&self, _table: &'static str) {
        #[cfg(test)]
        self.event(TestEvent::ExistenceRow(_table));
    }

    fn begin_sql_resources(&self, _table: &'static str) -> SqlResourceObservation {
        #[cfg(test)]
        self.event(TestEvent::SqlResourcesBegin(_table));
        SqlResourceObservation {
            #[cfg(test)]
            observer: self.clone(),
            #[cfg(test)]
            table: _table,
        }
    }

    fn begin_row(&self, _table: &'static str) -> RowObservation {
        #[cfg(test)]
        if let Some(state) = self.state.as_ref() {
            let live = state.live_rows.get() + 1;
            state.live_rows.set(live);
            state
                .peak_live_rows
                .set(state.peak_live_rows.get().max(live));
            self.event(TestEvent::RowBegin(_table));
        }
        RowObservation {
            #[cfg(test)]
            observer: self.clone(),
            #[cfg(test)]
            table: _table,
        }
    }

    fn blob_type_checked(&self, _label: &'static str) {
        #[cfg(test)]
        self.event(TestEvent::BlobTypeChecked(_label));
    }

    fn blob_length_checked(&self, _label: &'static str, _length: Option<usize>) {
        #[cfg(test)]
        self.event(TestEvent::BlobLengthChecked(_label, _length));
    }

    fn aggregate_checked(&self, _prior: usize, _length: usize, _result: Option<usize>) {
        #[cfg(test)]
        self.event(TestEvent::AggregateChecked {
            prior: _prior,
            length: _length,
            result: _result,
        });
    }

    fn blob_copied(&self, _label: &'static str, _length: usize) {
        #[cfg(test)]
        self.event(TestEvent::BlobCopied(_label, _length));
    }

    #[cfg(test)]
    fn event(&self, event: TestEvent) {
        if let Some(state) = self.state.as_ref() {
            state.events.borrow_mut().push(event);
        }
    }
}

struct PageObservation {
    #[cfg(test)]
    observer: PreflightObserver,
    #[cfg(test)]
    table: &'static str,
}

impl Drop for PageObservation {
    fn drop(&mut self) {
        #[cfg(test)]
        self.observer.event(TestEvent::PageEnd(self.table));
    }
}

struct RowObservation {
    #[cfg(test)]
    observer: PreflightObserver,
    #[cfg(test)]
    table: &'static str,
}

struct SqlResourceObservation {
    #[cfg(test)]
    observer: PreflightObserver,
    #[cfg(test)]
    table: &'static str,
}

impl Drop for SqlResourceObservation {
    fn drop(&mut self) {
        #[cfg(test)]
        self.observer.event(TestEvent::SqlResourcesEnd(self.table));
    }
}

impl Drop for RowObservation {
    fn drop(&mut self) {
        #[cfg(test)]
        if let Some(state) = self.observer.state.as_ref() {
            let live = state.live_rows.get();
            debug_assert!(live > 0);
            state.live_rows.set(live - 1);
            self.observer.event(TestEvent::RowEnd(self.table));
        }
    }
}

#[cfg(test)]
#[derive(Clone, Debug, Eq, PartialEq)]
enum TestEvent {
    SqliteOpenAttempt,
    Query(PreflightQueryStage),
    PageBegin(&'static str),
    PageEnd(&'static str),
    SqlResourcesBegin(&'static str),
    SqlResourcesEnd(&'static str),
    ExistenceRow(&'static str),
    RowBegin(&'static str),
    RowEnd(&'static str),
    BlobTypeChecked(&'static str),
    BlobLengthChecked(&'static str, Option<usize>),
    AggregateChecked {
        prior: usize,
        length: usize,
        result: Option<usize>,
    },
    BlobCopied(&'static str, usize),
}

#[cfg(test)]
#[derive(Default)]
struct TestObserverState {
    events: std::cell::RefCell<Vec<TestEvent>>,
    live_rows: std::cell::Cell<usize>,
    peak_live_rows: std::cell::Cell<usize>,
}

#[cfg(test)]
thread_local! {
    static ACTIVE_TEST_OBSERVER: std::cell::RefCell<Option<std::rc::Rc<TestObserverState>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
mod tests {
    use std::fs::{self, OpenOptions};
    use std::path::{Path, PathBuf};
    use std::rc::Rc;

    use rusqlite::Connection;
    use tempfile::{TempDir, tempdir};

    use super::*;
    use crate::{
        ExistingVaultPreflightOutcomeV1, SCHEMA_V1_SQL, StoreLocationPolicyV1,
        preflight_existing_v1,
    };

    struct Fixture {
        _directory: TempDir,
        path: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let directory = tempdir().unwrap();
            let path = directory.path().join("vault.sqlite3");
            let connection = Connection::open(&path).unwrap();
            connection.execute_batch(SCHEMA_V1_SQL).unwrap();
            connection
                .execute(
                    "INSERT INTO vault_state(singleton,password_wire_version,password_suite_id,password_envelope) VALUES(1,1,1,?1)",
                    [[1_u8].as_slice()],
                )
                .unwrap();
            drop(connection);
            Self {
                _directory: directory,
                path,
            }
        }

        fn connection_ignoring_checks(&self) -> Connection {
            let connection = Connection::open(&self.path).unwrap();
            connection
                .execute_batch("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON;")
                .unwrap();
            connection
        }
    }

    struct ObserverReset;

    impl Drop for ObserverReset {
        fn drop(&mut self) {
            ACTIVE_TEST_OBSERVER.with(|active| {
                active.replace(None);
            });
        }
    }

    fn observed<T>(action: impl FnOnce(Rc<TestObserverState>) -> T) -> (T, Rc<TestObserverState>) {
        let state = Rc::new(TestObserverState::default());
        ACTIVE_TEST_OBSERVER.with(|active| {
            assert!(active.replace(Some(Rc::clone(&state))).is_none());
        });
        let _reset = ObserverReset;
        let result = action(Rc::clone(&state));
        assert_eq!(state.live_rows.get(), 0);
        (result, state)
    }

    fn events(state: &TestObserverState) -> Vec<TestEvent> {
        state.events.borrow().clone()
    }

    fn count_event(events: &[TestEvent], predicate: impl Fn(&TestEvent) -> bool) -> usize {
        events.iter().filter(|event| predicate(event)).count()
    }

    fn sidecar_path(database_path: &Path, suffix: &str) -> PathBuf {
        let mut path = database_path.as_os_str().to_os_string();
        path.push(suffix);
        PathBuf::from(path)
    }

    fn sparse_file(path: &Path, length: u64) {
        OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(path)
            .unwrap()
            .set_len(length)
            .unwrap();
    }

    fn record_id(index: u64) -> [u8; 16] {
        let mut value = [0_u8; 16];
        value[8..].copy_from_slice(&index.to_be_bytes());
        value
    }

    fn revision_id(index: u64) -> [u8; 32] {
        let mut value = [0_u8; 32];
        value[24..].copy_from_slice(&index.to_be_bytes());
        value
    }

    fn insert_revision(connection: &Connection, index: u64, envelope: &[u8]) {
        connection
            .execute(
                "INSERT INTO revisions(record_id,revision_id,wire_version,suite_id,key_epoch,padding_bucket,envelope) VALUES(?1,?2,1,1,1,1024,?3)",
                params![
                    record_id(index).as_slice(),
                    revision_id(index).as_slice(),
                    envelope
                ],
            )
            .unwrap();
    }

    fn insert_head(connection: &Connection, index: u64) {
        connection
            .execute(
                "INSERT INTO heads(record_id,revision_id) VALUES(?1,?2)",
                params![record_id(index).as_slice(), revision_id(index).as_slice()],
            )
            .unwrap();
    }

    fn insert_conflict(connection: &Connection, index: u64) {
        connection
            .execute(
                "INSERT INTO conflicts(record_id,candidate_revision_id,expected_head_revision_id,observed_head_revision_id) VALUES(?1,?2,NULL,?3)",
                params![
                    record_id(index).as_slice(),
                    revision_id(index).as_slice(),
                    revision_id(index + 100).as_slice()
                ],
            )
            .unwrap();
    }

    fn gate_with_limits(path: &Path, limits: ScanLimits) -> PreflightQueryGate {
        let mut gate = PreflightQueryGate::open_read_only(path).unwrap();
        gate.limits = limits;
        gate
    }

    fn assert_page_lifetimes(events: &[TestEvent], table: &'static str) {
        let first_resource_end = events
            .iter()
            .position(|event| *event == TestEvent::SqlResourcesEnd(table))
            .unwrap();
        let first_end = events
            .iter()
            .position(|event| *event == TestEvent::PageEnd(table))
            .unwrap();
        let second_query = events
            .iter()
            .enumerate()
            .filter(|(_, event)| {
                **event
                    == TestEvent::Query(match table {
                        "revisions" => PreflightQueryStage::Revisions,
                        "heads" => PreflightQueryStage::Heads,
                        "conflicts" => PreflightQueryStage::Conflicts,
                        _ => unreachable!(),
                    })
            })
            .nth(1)
            .map(|(index, _)| index)
            .unwrap();
        assert!(
            first_resource_end < first_end && first_end < second_query,
            "Statement/Rows must drop before PageEnd and before the next query"
        );
    }

    #[test]
    fn production_limits_are_exact_and_cap_plus_one_is_fixed() {
        let limits = ScanLimits::production();
        assert_eq!(limits.page_rows, 256);
        assert_eq!(limits.query_limit, 257);
        assert_eq!(limits.max_revisions, 10_000);
        assert_eq!(limits.max_heads, 5_000);
        assert_eq!(limits.max_conflicts, 5_000);
        assert_eq!(limits.max_total_revision_envelope_bytes, 128 * 1024 * 1024);
        assert_eq!(schema_contract::MAX_ENVELOPE_BYTES, 65_536);
        let sizes = StorageSizeLimits::production();
        assert_eq!(MAX_LOGICAL_ROWS, 20_001);
        assert_eq!(
            MAX_DATABASE_PAGE_BYTES,
            128 * 1024 * 1024 + 65_536 + (20_001 + 64) * 4096
        );
        assert_eq!(sizes.max_main_bytes, MAX_DATABASE_PAGE_BYTES * 2);
        assert_eq!(sizes.max_wal_bytes, MAX_DATABASE_PAGE_BYTES * 2);
        assert_eq!(
            sizes.max_shm_bytes,
            MAX_DATABASE_PAGE_BYTES / 32 + 32 * 1024
        );
    }

    #[test]
    fn oversized_sparse_main_file_is_rejected_before_sqlite_open() {
        let fixture = Fixture::new();
        sparse_file(&fixture.path, 2 * 1024 * 1024);
        let limits = StorageSizeLimits::reduced(1024 * 1024, u64::MAX, u64::MAX);

        let (result, state) = observed(|_| {
            PreflightQueryGate::open_read_only_with_size_limits(&fixture.path, limits)
        });

        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("oversized main file reached SQLite open"),
        };
        assert_eq!(error.code(), StorageErrorCode::LimitsExceeded);
        assert!(!events(&state).contains(&TestEvent::SqliteOpenAttempt));
        assert_eq!(fs::metadata(&fixture.path).unwrap().len(), 2 * 1024 * 1024);
    }

    #[test]
    fn oversized_wal_and_shm_are_each_rejected_before_sqlite_open() {
        for (suffix, limits) in [
            ("-wal", StorageSizeLimits::reduced(u64::MAX, 4096, u64::MAX)),
            ("-shm", StorageSizeLimits::reduced(u64::MAX, u64::MAX, 4096)),
        ] {
            let fixture = Fixture::new();
            let sidecar = sidecar_path(&fixture.path, suffix);
            sparse_file(&sidecar, 4097);

            let (result, state) = observed(|_| {
                PreflightQueryGate::open_read_only_with_size_limits(&fixture.path, limits)
            });

            let error = match result {
                Err(error) => error,
                Ok(_) => panic!("oversized sidecar reached SQLite open"),
            };
            assert_eq!(error.code(), StorageErrorCode::LimitsExceeded);
            assert!(!events(&state).contains(&TestEvent::SqliteOpenAttempt));
            assert_eq!(fs::metadata(sidecar).unwrap().len(), 4097);
        }
    }

    #[test]
    fn oversized_freelist_page_span_is_rejected_before_integrity_work() {
        let fixture = Fixture::new();
        let connection = fixture.connection_ignoring_checks();
        connection
            .execute_batch(
                "CREATE TABLE bounded_preflight_filler(payload BLOB NOT NULL);
                 INSERT INTO bounded_preflight_filler(payload) VALUES(zeroblob(524288));
                 DROP TABLE bounded_preflight_filler;",
            )
            .unwrap();
        let page_count: i64 = connection
            .query_row("PRAGMA page_count", [], |row| row.get(0))
            .unwrap();
        let page_size: i64 = connection
            .query_row("PRAGMA page_size", [], |row| row.get(0))
            .unwrap();
        let freelist_count: i64 = connection
            .query_row("PRAGMA freelist_count", [], |row| row.get(0))
            .unwrap();
        drop(connection);
        assert!(freelist_count > 0, "fixture must contain free pages");
        let page_span = u64::try_from(page_count)
            .unwrap()
            .checked_mul(u64::try_from(page_size).unwrap())
            .unwrap();
        let limits = StorageSizeLimits::reduced(
            fs::metadata(&fixture.path).unwrap().len(),
            u64::MAX,
            u64::MAX,
        );

        let (result, state) = observed(|_| {
            let mut gate =
                PreflightQueryGate::open_read_only_with_size_limits(&fixture.path, limits)?;
            gate.verify_bounded_integrity_with_page_limit(page_span - 1)
        });

        assert_eq!(result.unwrap_err().code(), StorageErrorCode::LimitsExceeded);
        let events = events(&state);
        assert!(events.contains(&TestEvent::Query(PreflightQueryStage::PageCount)));
        assert!(events.contains(&TestEvent::Query(PreflightQueryStage::PageSize)));
        assert!(!events.contains(&TestEvent::Query(PreflightQueryStage::Integrity)));
    }

    #[test]
    fn capped_table_scans_precede_first_foreign_key_violation_query() {
        let directory = tempdir().unwrap();
        let policy = StoreLocationPolicyV1::new(directory.path()).unwrap();
        let location = policy.location("vault.sqlite3").unwrap();
        let connection = Connection::open(location.database_path()).unwrap();
        connection.execute_batch(SCHEMA_V1_SQL).unwrap();
        connection
            .execute(
                "INSERT INTO vault_state(singleton,password_wire_version,password_suite_id,password_envelope) VALUES(1,1,1,?1)",
                [[1_u8].as_slice()],
            )
            .unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys=OFF;")
            .unwrap();
        connection.execute_batch("BEGIN IMMEDIATE;").unwrap();
        for index in 0..1024 {
            insert_head(&connection, index);
        }
        connection.execute_batch("COMMIT;").unwrap();
        drop(connection);

        let (outcome, state) = observed(|_| preflight_existing_v1(&location).unwrap());
        assert!(matches!(
            outcome,
            ExistingVaultPreflightOutcomeV1::ReadOnlyPreservation
        ));
        let queries = events(&state)
            .into_iter()
            .filter_map(|event| match event {
                TestEvent::Query(stage) => Some(stage),
                _ => None,
            })
            .collect::<Vec<_>>();
        let foreign_key_check = queries
            .iter()
            .position(|stage| *stage == PreflightQueryStage::ForeignKeyCheck)
            .unwrap();
        for capped_stage in [
            PreflightQueryStage::Revisions,
            PreflightQueryStage::Heads,
            PreflightQueryStage::Conflicts,
        ] {
            assert!(
                queries
                    .iter()
                    .position(|stage| *stage == capped_stage)
                    .is_some_and(|position| position < foreign_key_check),
                "{capped_stage:?} must run before foreign-key validation"
            );
        }
        let source = include_str!("preflight_query.rs");
        assert!(source.contains("SELECT 1 FROM pragma_foreign_key_check LIMIT 1"));
        let unbounded_count = ["SELECT count(", "*) FROM pragma_foreign_key_check"].concat();
        assert!(!source.contains(&unbounded_count));
    }

    #[test]
    fn production_revision_cap_accepts_10000_and_rejects_10001() {
        let fixture = Fixture::new();
        let connection = fixture.connection_ignoring_checks();
        connection.execute_batch("BEGIN IMMEDIATE;").unwrap();
        for index in 0..10_000 {
            insert_revision(&connection, index, &[1]);
        }
        connection.execute_batch("COMMIT;").unwrap();
        drop(connection);

        let mut visited = 0_usize;
        PreflightQueryGate::open_read_only(&fixture.path)
            .unwrap()
            .with_revisions(|_| {
                visited += 1;
                Ok(())
            })
            .unwrap();
        assert_eq!(visited, 10_000);

        let connection = fixture.connection_ignoring_checks();
        insert_revision(&connection, 10_000, &[1]);
        drop(connection);
        let error = PreflightQueryGate::open_read_only(&fixture.path)
            .unwrap()
            .with_revisions(|_| Ok(()))
            .unwrap_err();
        assert_eq!(error.code(), StorageErrorCode::LimitsExceeded);
    }

    #[test]
    fn production_head_cap_accepts_5000_and_rejects_5001() {
        let fixture = Fixture::new();
        let connection = fixture.connection_ignoring_checks();
        connection.execute_batch("BEGIN IMMEDIATE;").unwrap();
        for index in 0..5_000 {
            insert_head(&connection, index);
        }
        connection.execute_batch("COMMIT;").unwrap();
        drop(connection);

        let mut gate = PreflightQueryGate::open_read_only(&fixture.path).unwrap();
        let mut digest = LogicalDigestV1::new();
        gate.digest_heads(&mut digest).unwrap();
        drop(gate);

        let connection = fixture.connection_ignoring_checks();
        insert_head(&connection, 5_000);
        drop(connection);
        let mut gate = PreflightQueryGate::open_read_only(&fixture.path).unwrap();
        let mut digest = LogicalDigestV1::new();
        let error = gate.digest_heads(&mut digest).unwrap_err();
        assert_eq!(error.code(), StorageErrorCode::LimitsExceeded);
    }

    #[test]
    fn production_conflict_cap_accepts_5000_and_rejects_5001() {
        let fixture = Fixture::new();
        let connection = fixture.connection_ignoring_checks();
        connection.execute_batch("BEGIN IMMEDIATE;").unwrap();
        for index in 0..5_000 {
            insert_conflict(&connection, index);
        }
        connection.execute_batch("COMMIT;").unwrap();
        drop(connection);

        let mut gate = PreflightQueryGate::open_read_only(&fixture.path).unwrap();
        let mut digest = LogicalDigestV1::new();
        gate.digest_conflicts(&mut digest).unwrap();
        drop(gate);

        let connection = fixture.connection_ignoring_checks();
        insert_conflict(&connection, 5_000);
        drop(connection);
        let mut gate = PreflightQueryGate::open_read_only(&fixture.path).unwrap();
        let mut digest = LogicalDigestV1::new();
        let error = gate.digest_conflicts(&mut digest).unwrap_err();
        assert_eq!(error.code(), StorageErrorCode::LimitsExceeded);
    }

    #[test]
    fn future_schema_observes_only_application_id_then_user_version() {
        let directory = tempdir().unwrap();
        let policy = StoreLocationPolicyV1::new(directory.path()).unwrap();
        let location = policy.location("vault.sqlite3").unwrap();
        let connection = Connection::open(location.database_path()).unwrap();
        connection.execute_batch(SCHEMA_V1_SQL).unwrap();
        connection
            .execute(
                "INSERT INTO vault_state(singleton,password_wire_version,password_suite_id,password_envelope) VALUES(1,1,1,?1)",
                [[1_u8].as_slice()],
            )
            .unwrap();
        connection.pragma_update(None, "user_version", 2).unwrap();
        drop(connection);

        let (outcome, state) = observed(|_| preflight_existing_v1(&location).unwrap());
        assert!(matches!(
            outcome,
            ExistingVaultPreflightOutcomeV1::SchemaUpgradeRequired
        ));
        let queries = events(&state)
            .into_iter()
            .filter_map(|event| match event {
                TestEvent::Query(stage) => Some(stage),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            queries,
            [
                PreflightQueryStage::ApplicationId,
                PreflightQueryStage::UserVersion
            ]
        );
    }

    #[test]
    fn revision_cap_and_cap_plus_one_stream_without_copying_the_existence_row() {
        for rows in [3_u64, 4] {
            let fixture = Fixture::new();
            let connection = fixture.connection_ignoring_checks();
            for index in 0..rows {
                insert_revision(&connection, index, &[index as u8]);
            }
            drop(connection);
            let limits = ScanLimits::reduced(3, 3, 8, 8, 16);
            let (result, state) =
                observed(|_| gate_with_limits(&fixture.path, limits).with_revisions(|_| Ok(())));
            if rows == 3 {
                assert!(result.is_ok());
            } else {
                assert_eq!(result.unwrap_err().code(), StorageErrorCode::LimitsExceeded);
            }
            let events = events(&state);
            assert_eq!(
                count_event(&events, |event| matches!(
                    event,
                    TestEvent::BlobCopied("revisions.envelope", _)
                )),
                3
            );
            assert_eq!(state.peak_live_rows.get(), 1);
            if rows == 4 {
                assert_eq!(
                    count_event(&events, |event| {
                        *event == TestEvent::ExistenceRow("revisions")
                    }),
                    1
                );
                assert_page_lifetimes(&events, "revisions");
            }
        }
    }

    #[test]
    fn head_cap_and_cap_plus_one_use_opaque_record_id_pages() {
        for rows in [3_u64, 4] {
            let fixture = Fixture::new();
            let connection = fixture.connection_ignoring_checks();
            for index in 0..rows {
                insert_head(&connection, index);
            }
            drop(connection);
            let limits = ScanLimits::reduced(3, 8, 3, 8, 16);
            let (result, state) = observed(|_| {
                let mut gate = gate_with_limits(&fixture.path, limits);
                let mut digest = LogicalDigestV1::new();
                gate.digest_heads(&mut digest)
            });
            if rows == 3 {
                assert!(result.is_ok());
            } else {
                assert_eq!(result.unwrap_err().code(), StorageErrorCode::LimitsExceeded);
            }
            let events = events(&state);
            assert_eq!(
                count_event(&events, |event| matches!(
                    event,
                    TestEvent::BlobCopied("heads.record_id", _)
                )),
                3
            );
            assert_eq!(state.peak_live_rows.get(), 1);
            if rows == 4 {
                assert_eq!(
                    count_event(&events, |event| {
                        *event == TestEvent::ExistenceRow("heads")
                    }),
                    1
                );
                assert_page_lifetimes(&events, "heads");
            }
        }
    }

    #[test]
    fn conflict_cap_and_cap_plus_one_use_the_composite_opaque_key() {
        for rows in [3_u64, 4] {
            let fixture = Fixture::new();
            let connection = fixture.connection_ignoring_checks();
            for index in 0..rows {
                insert_conflict(&connection, index);
            }
            drop(connection);
            let limits = ScanLimits::reduced(3, 8, 8, 3, 16);
            let (result, state) = observed(|_| {
                let mut gate = gate_with_limits(&fixture.path, limits);
                let mut digest = LogicalDigestV1::new();
                gate.digest_conflicts(&mut digest)
            });
            if rows == 3 {
                assert!(result.is_ok());
            } else {
                assert_eq!(result.unwrap_err().code(), StorageErrorCode::LimitsExceeded);
            }
            let events = events(&state);
            assert_eq!(
                count_event(&events, |event| matches!(
                    event,
                    TestEvent::BlobCopied("conflicts.record_id", _)
                )),
                3
            );
            assert_eq!(state.peak_live_rows.get(), 1);
            if rows == 4 {
                assert_eq!(
                    count_event(&events, |event| {
                        *event == TestEvent::ExistenceRow("conflicts")
                    }),
                    1
                );
                assert_page_lifetimes(&events, "conflicts");
            }
        }
    }

    #[test]
    fn revision_type_and_length_precede_checked_aggregate_and_blob_copy() {
        let fixture = Fixture::new();
        let connection = fixture.connection_ignoring_checks();
        insert_revision(&connection, 0, &[1]);
        insert_revision(&connection, 1, &[2, 3]);
        drop(connection);

        let exact_limits = ScanLimits::reduced(8, 8, 8, 8, 3);
        let (result, state) =
            observed(|_| gate_with_limits(&fixture.path, exact_limits).with_revisions(|_| Ok(())));
        assert!(result.is_ok());
        let envelope_events = events(&state)
            .into_iter()
            .filter(|event| {
                matches!(
                    event,
                    TestEvent::BlobTypeChecked("revisions.envelope")
                        | TestEvent::BlobLengthChecked("revisions.envelope", _)
                        | TestEvent::AggregateChecked { .. }
                        | TestEvent::BlobCopied("revisions.envelope", _)
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            envelope_events,
            [
                TestEvent::BlobTypeChecked("revisions.envelope"),
                TestEvent::BlobLengthChecked("revisions.envelope", Some(1)),
                TestEvent::AggregateChecked {
                    prior: 0,
                    length: 1,
                    result: Some(1)
                },
                TestEvent::BlobCopied("revisions.envelope", 1),
                TestEvent::BlobTypeChecked("revisions.envelope"),
                TestEvent::BlobLengthChecked("revisions.envelope", Some(2)),
                TestEvent::AggregateChecked {
                    prior: 1,
                    length: 2,
                    result: Some(3)
                },
                TestEvent::BlobCopied("revisions.envelope", 2),
            ]
        );

        let plus_one_limits = ScanLimits::reduced(8, 8, 8, 8, 2);
        let (result, state) = observed(|_| {
            let mut gate = gate_with_limits(&fixture.path, plus_one_limits);
            let mut digest = LogicalDigestV1::new();
            gate.digest_revisions(&mut digest)
        });
        assert_eq!(result.unwrap_err().code(), StorageErrorCode::LimitsExceeded);
        let events = events(&state);
        assert!(events.windows(3).any(|window| {
            window
                == [
                    TestEvent::BlobTypeChecked("revisions.envelope"),
                    TestEvent::BlobLengthChecked("revisions.envelope", Some(2)),
                    TestEvent::AggregateChecked {
                        prior: 1,
                        length: 2,
                        result: Some(3),
                    },
                ]
        }));
        assert_eq!(
            count_event(&events, |event| matches!(
                event,
                TestEvent::BlobCopied("revisions.envelope", _)
            )),
            1
        );
    }

    #[test]
    fn zero_and_65537_byte_revision_blobs_are_rejected_before_copy() {
        for length in [0_usize, 65_537] {
            let fixture = Fixture::new();
            let connection = fixture.connection_ignoring_checks();
            insert_revision(&connection, 0, &vec![7_u8; length]);
            drop(connection);
            let (result, state) = observed(|_| {
                PreflightQueryGate::open_read_only(&fixture.path)
                    .unwrap()
                    .with_revisions(|_| Ok(()))
            });
            assert_eq!(result.unwrap_err().code(), StorageErrorCode::CorruptStorage);
            let events = events(&state);
            assert!(events.contains(&TestEvent::BlobLengthChecked(
                "revisions.envelope",
                Some(length)
            )));
            assert!(
                !events.iter().any(|event| {
                    matches!(event, TestEvent::BlobCopied("revisions.envelope", _))
                })
            );
        }
    }

    #[test]
    fn real_and_text_numeric_cache_values_are_rejected_after_affinity() {
        for malformed_values in ["1.5,1,1,1024", "1,'not-an-integer',1,1024"] {
            let fixture = Fixture::new();
            let connection = fixture.connection_ignoring_checks();
            connection
                .execute(
                    &format!(
                        "INSERT INTO revisions(record_id,revision_id,wire_version,suite_id,key_epoch,padding_bucket,envelope) VALUES(?1,?2,{malformed_values},?3)"
                    ),
                    params![
                        record_id(0).as_slice(),
                        revision_id(0).as_slice(),
                        [9_u8].as_slice()
                    ],
                )
                .unwrap();
            drop(connection);
            let (result, state) = observed(|_| {
                PreflightQueryGate::open_read_only(&fixture.path)
                    .unwrap()
                    .with_revisions(|_| Ok(()))
            });
            assert_eq!(result.unwrap_err().code(), StorageErrorCode::CorruptStorage);
            assert!(!events(&state).iter().any(|event| {
                matches!(
                    event,
                    TestEvent::BlobTypeChecked("revisions.envelope")
                        | TestEvent::BlobLengthChecked("revisions.envelope", _)
                        | TestEvent::BlobCopied("revisions.envelope", _)
                )
            }));
        }
    }

    fn populate_digest_tables(fixture: &Fixture, order: &[u64], expected_is_null: bool) {
        let connection = fixture.connection_ignoring_checks();
        for &index in order {
            insert_revision(&connection, index, &[index as u8]);
        }
        for &index in order {
            insert_head(&connection, index);
        }
        for &index in order {
            let expected = if expected_is_null {
                None
            } else {
                Some(revision_id(index))
            };
            connection
                .execute(
                    "INSERT INTO conflicts(record_id,candidate_revision_id,expected_head_revision_id,observed_head_revision_id) VALUES(?1,?2,?3,?4)",
                    params![
                        record_id(index).as_slice(),
                        revision_id(index).as_slice(),
                        expected.as_ref().map(<[u8; 32]>::as_slice),
                        revision_id(index + 100).as_slice()
                    ],
                )
                .unwrap();
        }
    }

    fn digest(fixture: &Fixture) -> [u8; 32] {
        PreflightQueryGate::open_read_only(&fixture.path)
            .unwrap()
            .validate_and_digest()
            .unwrap()
    }

    fn independent_field(hasher: &mut blake3::Hasher, ordinal: u8, kind: u8, bytes: &[u8]) {
        hasher.update(&[ordinal, kind]);
        hasher.update(&(bytes.len() as u64).to_be_bytes());
        hasher.update(bytes);
    }

    #[test]
    fn logical_digest_matches_the_exact_v1_framing() {
        let fixture = Fixture::new();
        populate_digest_tables(&fixture, &[1], true);

        let mut expected = blake3::Hasher::new();
        expected.update(b"SVLT-LOCAL-DIGEST-V1");
        expected.update(&[0x54, 0x01, 0x52]);
        independent_field(&mut expected, 1, 0x01, &1_i64.to_be_bytes());
        independent_field(&mut expected, 2, 0x01, &1_i64.to_be_bytes());
        independent_field(&mut expected, 3, 0x01, &1_i64.to_be_bytes());
        independent_field(&mut expected, 4, 0x02, &[1]);
        expected.update(&[0x45]);

        expected.update(&[0x54, 0x02, 0x52]);
        independent_field(&mut expected, 1, 0x02, &record_id(1));
        independent_field(&mut expected, 2, 0x02, &revision_id(1));
        independent_field(&mut expected, 3, 0x01, &1_i64.to_be_bytes());
        independent_field(&mut expected, 4, 0x01, &1_i64.to_be_bytes());
        independent_field(&mut expected, 5, 0x01, &1_i64.to_be_bytes());
        independent_field(&mut expected, 6, 0x01, &1024_i64.to_be_bytes());
        independent_field(&mut expected, 7, 0x02, &[1]);
        expected.update(&[0x45]);

        expected.update(&[0x54, 0x03, 0x52]);
        independent_field(&mut expected, 1, 0x02, &record_id(1));
        independent_field(&mut expected, 2, 0x02, &revision_id(1));
        expected.update(&[0x45]);

        expected.update(&[0x54, 0x04, 0x52]);
        independent_field(&mut expected, 1, 0x02, &record_id(1));
        independent_field(&mut expected, 2, 0x02, &revision_id(1));
        independent_field(&mut expected, 3, 0x00, &[]);
        independent_field(&mut expected, 4, 0x02, &revision_id(101));
        expected.update(&[0x45]);

        assert_eq!(digest(&fixture), *expected.finalize().as_bytes());
    }

    #[test]
    fn digest_changes_for_integer_blob_and_null_field_classes() {
        let baseline = Fixture::new();
        populate_digest_tables(&baseline, &[1], true);
        let baseline_digest = digest(&baseline);

        let integer = Fixture::new();
        populate_digest_tables(&integer, &[1], true);
        let connection = integer.connection_ignoring_checks();
        connection
            .execute("UPDATE vault_state SET password_suite_id=2", [])
            .unwrap();
        drop(connection);
        assert_ne!(digest(&integer), baseline_digest);

        let blob = Fixture::new();
        populate_digest_tables(&blob, &[1], true);
        let connection = blob.connection_ignoring_checks();
        connection
            .execute(
                "UPDATE vault_state SET password_envelope=?1",
                [[2_u8].as_slice()],
            )
            .unwrap();
        drop(connection);
        assert_ne!(digest(&blob), baseline_digest);

        let nullable_blob = Fixture::new();
        populate_digest_tables(&nullable_blob, &[1], false);
        assert_ne!(digest(&nullable_blob), baseline_digest);
    }

    #[test]
    fn digest_is_independent_of_insertion_order() {
        let ascending = Fixture::new();
        populate_digest_tables(&ascending, &[1, 2], true);
        let descending = Fixture::new();
        populate_digest_tables(&descending, &[2, 1], true);
        assert_eq!(digest(&ascending), digest(&descending));
    }
}
