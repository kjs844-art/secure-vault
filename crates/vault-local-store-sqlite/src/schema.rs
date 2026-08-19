use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::Duration;

use blake3::Hasher;
use rusqlite::config::DbConfig;
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use vault_crypto::{
    PasswordEnvelopeBootstrapProjectionV1, PasswordEnvelopeStorageDispositionV1,
    inspect_password_envelope_for_storage_v1,
};

use crate::schema_contract::{APPLICATION_ID, MAX_ENVELOPE_BYTES, STORAGE_SCHEMA_VERSION};
use crate::{
    StorageError, StorageErrorCode, StoreLocationV1, StoreLockV1, SyntheticWritableStoreV1,
};

pub const SCHEMA_V1_SQL: &str = include_str!("../../../contracts/storage-v1/schema-v1.sql");

const COMMON_FLAGS: OpenFlags = OpenFlags::SQLITE_OPEN_NO_MUTEX
    .union(OpenFlags::SQLITE_OPEN_PRIVATE_CACHE)
    .union(OpenFlags::SQLITE_OPEN_NOFOLLOW)
    .union(OpenFlags::SQLITE_OPEN_EXRESCODE);

pub enum InitializeStoreOutcomeV1 {
    Created(SyntheticWritableStoreV1),
    AlreadyInitialized,
}

#[derive(Clone, Copy)]
enum InitialFileState {
    Absent,
    Zero(FileIdentity),
    NonEmpty,
}

#[derive(Clone, Copy, Eq, PartialEq)]
struct FileIdentity {
    first: u64,
    second: u64,
}

struct TargetOwnershipGuard {
    file: Option<File>,
    identity: FileIdentity,
}

#[derive(Clone, Copy)]
#[allow(dead_code)]
enum InitFailPoint {
    Never,
    AfterHardeningStep(usize),
    AfterDdlStatement(usize),
    AfterSingleton,
    AfterReadback,
}

struct InitObserver {
    failpoint: InitFailPoint,
    hardening_step: usize,
    ddl_statement: usize,
    post_close_hook: Option<fn(&Path)>,
    allow_path_replacement: bool,
}

impl InitObserver {
    const fn production() -> Self {
        Self {
            failpoint: InitFailPoint::Never,
            hardening_step: 0,
            ddl_statement: 0,
            post_close_hook: None,
            allow_path_replacement: false,
        }
    }

    fn hardening_applied(&mut self) -> Result<(), StorageError> {
        let current = self.hardening_step;
        self.hardening_step += 1;
        if matches!(self.failpoint, InitFailPoint::AfterHardeningStep(step) if step == current) {
            return Err(StorageError::new(StorageErrorCode::InvariantViolation));
        }
        Ok(())
    }

    fn ddl_applied(&mut self) -> Result<(), StorageError> {
        let current = self.ddl_statement;
        self.ddl_statement += 1;
        if matches!(self.failpoint, InitFailPoint::AfterDdlStatement(step) if step == current) {
            return Err(StorageError::new(StorageErrorCode::InvariantViolation));
        }
        Ok(())
    }

    fn singleton_applied(&self) -> Result<(), StorageError> {
        if matches!(self.failpoint, InitFailPoint::AfterSingleton) {
            return Err(StorageError::new(StorageErrorCode::InvariantViolation));
        }
        Ok(())
    }

    fn readback_complete(&self) -> Result<(), StorageError> {
        if matches!(self.failpoint, InitFailPoint::AfterReadback) {
            return Err(StorageError::new(StorageErrorCode::InvariantViolation));
        }
        Ok(())
    }
}

pub fn initialize_v1(
    location: &StoreLocationV1,
    bootstrap: PasswordEnvelopeBootstrapProjectionV1<'_>,
) -> Result<InitializeStoreOutcomeV1, StorageError> {
    initialize_with_observer(location, bootstrap, InitObserver::production())
}

fn initialize_with_observer(
    location: &StoreLocationV1,
    bootstrap: PasswordEnvelopeBootstrapProjectionV1<'_>,
    mut observer: InitObserver,
) -> Result<InitializeStoreOutcomeV1, StorageError> {
    validate_bootstrap(&bootstrap)?;
    let lock = StoreLockV1::try_acquire(location)?;
    let (initial_state, ownership) =
        acquire_target_ownership(location.database_path(), observer.allow_path_replacement)?;
    match initial_state {
        InitialFileState::NonEmpty => {
            drop(ownership);
            initialize_existing(location, bootstrap, lock)
        }
        InitialFileState::Absent | InitialFileState::Zero(_) => {
            if let Err(error) = ensure_initialization_sidecars_absent(location.database_path()) {
                restore_unopened_target(
                    location.database_path(),
                    initial_state,
                    ownership.ok_or_else(|| StorageError::new(StorageErrorCode::CorruptStorage))?,
                )?;
                return Err(error);
            }
            initialize_zero_byte(
                location,
                bootstrap,
                lock,
                initial_state,
                ownership.ok_or_else(|| StorageError::new(StorageErrorCode::CorruptStorage))?,
                &mut observer,
            )
        }
    }
}

fn initialize_existing(
    location: &StoreLocationV1,
    bootstrap: PasswordEnvelopeBootstrapProjectionV1<'_>,
    lock: StoreLockV1,
) -> Result<InitializeStoreOutcomeV1, StorageError> {
    let connection = open_read_only(location.database_path())?;
    let application_id = pragma_i64(&connection, "application_id")?;
    if application_id != APPLICATION_ID {
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }
    let user_version = pragma_i64(&connection, "user_version")?;
    if user_version > STORAGE_SCHEMA_VERSION {
        return Err(StorageError::new(StorageErrorCode::SchemaUpgradeRequired));
    }
    if user_version != STORAGE_SCHEMA_VERSION {
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }
    verify_schema_fingerprint(&connection)?;
    let stored = read_password_singleton(&connection)?;
    if stored.wire_version == i64::from(bootstrap.wire_version())
        && stored.suite_id == i64::from(bootstrap.suite_id())
        && stored.envelope.as_slice() == bootstrap.envelope()
    {
        drop(connection);
        drop(lock);
        Ok(InitializeStoreOutcomeV1::AlreadyInitialized)
    } else {
        Err(StorageError::new(StorageErrorCode::InvariantViolation))
    }
}

fn initialize_zero_byte(
    location: &StoreLocationV1,
    bootstrap: PasswordEnvelopeBootstrapProjectionV1<'_>,
    lock: StoreLockV1,
    initial_state: InitialFileState,
    ownership: TargetOwnershipGuard,
    observer: &mut InitObserver,
) -> Result<InitializeStoreOutcomeV1, StorageError> {
    let flags = COMMON_FLAGS | OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE;
    let mut connection = match Connection::open_with_flags(location.database_path(), flags) {
        Ok(connection) => connection,
        Err(_) => {
            restore_unopened_target(location.database_path(), initial_state, ownership)?;
            return Err(StorageError::new(StorageErrorCode::UnsupportedPlatform));
        }
    };
    let owned_main_identity = ownership.identity;
    if file_identity(location.database_path())? != owned_main_identity {
        drop(connection);
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }
    if let InitialFileState::Zero(original_identity) = initial_state
        && owned_main_identity != original_identity
    {
        drop(connection);
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }

    let initialization = (|| {
        harden_writable(&connection, observer)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| StorageError::new(StorageErrorCode::Io))?;
        for statement in golden_statements()? {
            transaction
                .execute_batch(statement)
                .map_err(|_| StorageError::new(StorageErrorCode::CorruptStorage))?;
            observer.ddl_applied()?;
        }
        transaction
            .execute(
                "INSERT INTO vault_state(\
                    singleton,password_wire_version,password_suite_id,password_envelope\
                 ) VALUES(1,?1,?2,?3)",
                params![
                    i64::from(bootstrap.wire_version()),
                    i64::from(bootstrap.suite_id()),
                    bootstrap.envelope(),
                ],
            )
            .map_err(|_| StorageError::new(StorageErrorCode::InvariantViolation))?;
        observer.singleton_applied()?;
        verify_identity_and_singleton(&transaction, &bootstrap)?;
        observer.readback_complete()?;
        transaction
            .commit()
            .map_err(|_| StorageError::new(StorageErrorCode::Io))?;
        Ok(())
    })();

    if let Err(initialization_error) = initialization {
        if connection.close().is_err() {
            return Err(StorageError::new(StorageErrorCode::CorruptStorage));
        }
        if let Some(hook) = observer.post_close_hook {
            hook(location.database_path());
        }
        if restore_pre_call_state(
            location.database_path(),
            initial_state,
            owned_main_identity,
            &ownership,
        )
        .is_err()
        {
            return Err(StorageError::new(StorageErrorCode::CorruptStorage));
        }
        return Err(initialization_error);
    }

    drop(ownership);
    Ok(InitializeStoreOutcomeV1::Created(
        SyntheticWritableStoreV1::from_initialized(connection, lock),
    ))
}

fn validate_bootstrap(
    bootstrap: &PasswordEnvelopeBootstrapProjectionV1<'_>,
) -> Result<(), StorageError> {
    let disposition = inspect_password_envelope_for_storage_v1(bootstrap.envelope())
        .map_err(|_| StorageError::new(StorageErrorCode::InvariantViolation))?;
    let PasswordEnvelopeStorageDispositionV1::Current(inspection) = disposition else {
        return Err(StorageError::new(StorageErrorCode::CryptoUpgradeRequired));
    };
    if inspection.wire_version() != bootstrap.wire_version()
        || inspection.suite_id() != bootstrap.suite_id()
        || inspection.vault_commitment() != bootstrap.vault_commitment()
        || inspection.envelope() != bootstrap.envelope()
    {
        return Err(StorageError::new(StorageErrorCode::InvariantViolation));
    }
    Ok(())
}

pub(crate) fn open_read_only(path: &Path) -> Result<Connection, StorageError> {
    let connection =
        Connection::open_with_flags(path, crate::schema_contract::read_only_open_flags())
            .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?;
    connection
        .load_extension_disable()
        .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?;
    Ok(connection)
}

#[allow(dead_code)]
pub(crate) fn open_existing_writable(path: &Path) -> Result<Connection, StorageError> {
    let connection =
        Connection::open_with_flags(path, COMMON_FLAGS | OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?;
    let mut observer = InitObserver::production();
    harden_writable(&connection, &mut observer)?;
    Ok(connection)
}

fn harden_writable(
    connection: &Connection,
    observer: &mut InitObserver,
) -> Result<(), StorageError> {
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?;
    observer.hardening_applied()?;
    connection
        .load_extension_disable()
        .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?;
    observer.hardening_applied()?;

    let journal_mode: String = connection
        .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
        .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(StorageError::new(StorageErrorCode::UnsupportedPlatform));
    }
    observer.hardening_applied()?;
    connection
        .execute_batch("PRAGMA synchronous=FULL; PRAGMA recursive_triggers=ON;")
        .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?;
    if pragma_i64(connection, "synchronous")? != 2
        || pragma_i64(connection, "recursive_triggers")? != 1
    {
        return Err(StorageError::new(StorageErrorCode::UnsupportedPlatform));
    }
    observer.hardening_applied()?;

    for (config, expected) in [
        (DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true),
        (DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false),
        (DbConfig::SQLITE_DBCONFIG_ENABLE_FKEY, true),
        (DbConfig::SQLITE_DBCONFIG_ENABLE_TRIGGER, true),
        (DbConfig::SQLITE_DBCONFIG_DQS_DML, false),
        (DbConfig::SQLITE_DBCONFIG_DQS_DDL, false),
        (DbConfig::SQLITE_DBCONFIG_ENABLE_ATTACH_CREATE, false),
        (DbConfig::SQLITE_DBCONFIG_ENABLE_ATTACH_WRITE, false),
    ] {
        let applied = connection
            .set_db_config(config, expected)
            .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?;
        let verified = connection
            .db_config(config)
            .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?;
        if applied != expected || verified != expected {
            return Err(StorageError::new(StorageErrorCode::UnsupportedPlatform));
        }
        observer.hardening_applied()?;
    }

    if connection
        .is_readonly("main")
        .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?
        || pragma_i64(connection, "foreign_keys")? != 1
        || pragma_i64(connection, "trusted_schema")? != 0
    {
        return Err(StorageError::new(StorageErrorCode::UnsupportedPlatform));
    }
    observer.hardening_applied()?;
    Ok(())
}

fn verify_identity_and_singleton(
    connection: &Connection,
    bootstrap: &PasswordEnvelopeBootstrapProjectionV1<'_>,
) -> Result<(), StorageError> {
    if pragma_i64(connection, "application_id")? != APPLICATION_ID
        || pragma_i64(connection, "user_version")? != STORAGE_SCHEMA_VERSION
    {
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }
    verify_schema_fingerprint(connection)?;
    let stored = read_password_singleton(connection)?;
    if stored.wire_version != i64::from(bootstrap.wire_version())
        || stored.suite_id != i64::from(bootstrap.suite_id())
        || stored.envelope.as_slice() != bootstrap.envelope()
    {
        return Err(StorageError::new(StorageErrorCode::InvariantViolation));
    }
    Ok(())
}

struct StoredPasswordSingleton {
    wire_version: i64,
    suite_id: i64,
    envelope: Vec<u8>,
}

fn read_password_singleton(
    connection: &Connection,
) -> Result<StoredPasswordSingleton, StorageError> {
    let row = connection
        .query_row(
            "SELECT password_wire_version,password_suite_id,\
                    length(password_envelope),password_envelope \
             FROM vault_state WHERE singleton=1",
            [],
            |row| {
                let length: i64 = row.get(2)?;
                if !(1..=MAX_ENVELOPE_BYTES).contains(&length) {
                    return Err(rusqlite::Error::InvalidQuery);
                }
                let envelope: Vec<u8> = row.get(3)?;
                if i64::try_from(envelope.len()).ok() != Some(length) {
                    return Err(rusqlite::Error::InvalidQuery);
                }
                Ok(StoredPasswordSingleton {
                    wire_version: row.get(0)?,
                    suite_id: row.get(1)?,
                    envelope,
                })
            },
        )
        .optional()
        .map_err(|_| StorageError::new(StorageErrorCode::CorruptStorage))?
        .ok_or_else(|| StorageError::new(StorageErrorCode::CorruptStorage))?;
    Ok(row)
}

fn pragma_i64(connection: &Connection, pragma: &str) -> Result<i64, StorageError> {
    let sql = match pragma {
        "application_id" => "PRAGMA application_id",
        "user_version" => "PRAGMA user_version",
        "synchronous" => "PRAGMA synchronous",
        "recursive_triggers" => "PRAGMA recursive_triggers",
        "foreign_keys" => "PRAGMA foreign_keys",
        "trusted_schema" => "PRAGMA trusted_schema",
        _ => return Err(StorageError::new(StorageErrorCode::InvariantViolation)),
    };
    connection
        .query_row(sql, [], |row| row.get(0))
        .map_err(|_| StorageError::new(StorageErrorCode::CorruptStorage))
}

fn golden_statements() -> Result<Vec<&'static str>, StorageError> {
    let mut statements = Vec::new();
    let mut start = 0;
    let mut offset = 0;
    let mut in_trigger = false;
    for line in SCHEMA_V1_SQL.split_inclusive('\n') {
        let trimmed = line.trim();
        let syntactic = trimmed.split("--").next().unwrap_or("").trim();
        if trimmed.starts_with("CREATE TRIGGER ") {
            in_trigger = true;
        }
        offset += line.len();
        let complete = if in_trigger {
            syntactic == "END;"
        } else {
            syntactic.ends_with(';')
        };
        if complete {
            statements.push(&SCHEMA_V1_SQL[start..offset]);
            start = offset;
            in_trigger = false;
        }
    }
    if !SCHEMA_V1_SQL[start..].trim().is_empty() || statements.len() != 10 {
        return Err(StorageError::new(StorageErrorCode::InvariantViolation));
    }
    Ok(statements)
}

pub(crate) fn verify_schema_fingerprint(connection: &Connection) -> Result<(), StorageError> {
    let expected = Connection::open_in_memory()
        .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?;
    expected
        .execute_batch(SCHEMA_V1_SQL)
        .map_err(|_| StorageError::new(StorageErrorCode::InvariantViolation))?;
    if schema_fingerprint(connection)? != schema_fingerprint(&expected)? {
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }
    Ok(())
}

fn schema_fingerprint(connection: &Connection) -> Result<[u8; 32], StorageError> {
    let mut hasher = Hasher::new();
    feed_i64(
        &mut hasher,
        "application_id",
        pragma_i64(connection, "application_id")?,
    );
    feed_i64(
        &mut hasher,
        "user_version",
        pragma_i64(connection, "user_version")?,
    );

    let mut objects = connection
        .prepare(
            "SELECT type,name,tbl_name,coalesce(sql,'') FROM sqlite_schema \
             WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name",
        )
        .map_err(|_| StorageError::new(StorageErrorCode::CorruptStorage))?;
    let mut rows = objects
        .query([])
        .map_err(|_| StorageError::new(StorageErrorCode::CorruptStorage))?;
    while let Some(row) = rows
        .next()
        .map_err(|_| StorageError::new(StorageErrorCode::CorruptStorage))?
    {
        feed_text(
            &mut hasher,
            "object-type",
            row.get::<_, String>(0)?.as_str(),
        );
        feed_text(
            &mut hasher,
            "object-name",
            row.get::<_, String>(1)?.as_str(),
        );
        feed_text(
            &mut hasher,
            "object-table",
            row.get::<_, String>(2)?.as_str(),
        );
        let sql = row.get::<_, String>(3)?;
        feed_text(&mut hasher, "object-sql", normalize_sql(&sql).as_str());
    }
    drop(rows);
    drop(objects);

    for table in ["conflicts", "heads", "revisions", "vault_state"] {
        feed_text(&mut hasher, "table", table);
        fingerprint_query(
            connection,
            &format!(
                "SELECT cid,name,type,\"notnull\",dflt_value,pk,hidden \
                 FROM pragma_table_xinfo('{table}') ORDER BY cid"
            ),
            7,
            &mut hasher,
        )?;
        fingerprint_query(
            connection,
            &format!(
                "SELECT id,seq,\"table\",\"from\",\"to\",on_update,on_delete,match \
                 FROM pragma_foreign_key_list('{table}') ORDER BY id,seq"
            ),
            8,
            &mut hasher,
        )?;
        fingerprint_query(
            connection,
            &format!(
                "SELECT seq,name,\"unique\",origin,partial \
                 FROM pragma_index_list('{table}') ORDER BY name,seq"
            ),
            5,
            &mut hasher,
        )?;
    }
    Ok(*hasher.finalize().as_bytes())
}

fn fingerprint_query(
    connection: &Connection,
    sql: &str,
    columns: usize,
    hasher: &mut Hasher,
) -> Result<(), StorageError> {
    use rusqlite::types::ValueRef;

    let mut statement = connection
        .prepare(sql)
        .map_err(|_| StorageError::new(StorageErrorCode::CorruptStorage))?;
    let mut rows = statement
        .query([])
        .map_err(|_| StorageError::new(StorageErrorCode::CorruptStorage))?;
    while let Some(row) = rows
        .next()
        .map_err(|_| StorageError::new(StorageErrorCode::CorruptStorage))?
    {
        for column in 0..columns {
            match row
                .get_ref(column)
                .map_err(|_| StorageError::new(StorageErrorCode::CorruptStorage))?
            {
                ValueRef::Null => feed_bytes(hasher, "null", &[]),
                ValueRef::Integer(value) => feed_bytes(hasher, "integer", &value.to_be_bytes()),
                ValueRef::Real(value) => feed_bytes(hasher, "real", &value.to_bits().to_be_bytes()),
                ValueRef::Text(value) => feed_bytes(hasher, "text", value),
                ValueRef::Blob(value) => feed_bytes(hasher, "blob", value),
            }
        }
    }
    Ok(())
}

fn normalize_sql(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
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

fn acquire_target_ownership(
    path: &Path,
    allow_path_replacement: bool,
) -> Result<(InitialFileState, Option<TargetOwnershipGuard>), StorageError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(StorageError::new(StorageErrorCode::UnsupportedPlatform))
        }
        Ok(metadata) if metadata.len() > 0 => Ok((InitialFileState::NonEmpty, None)),
        Ok(_) => {
            let file = open_ownership_file(path, false, allow_path_replacement)?;
            let metadata = file
                .metadata()
                .map_err(|_| StorageError::new(StorageErrorCode::Io))?;
            if metadata.len() != 0 {
                return Ok((InitialFileState::NonEmpty, None));
            }
            let identity = identity_from_metadata(&metadata)?;
            Ok((
                InitialFileState::Zero(identity),
                Some(TargetOwnershipGuard {
                    file: Some(file),
                    identity,
                }),
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let file = open_ownership_file(path, true, allow_path_replacement)?;
            let metadata = file
                .metadata()
                .map_err(|_| StorageError::new(StorageErrorCode::Io))?;
            let identity = identity_from_metadata(&metadata)?;
            Ok((
                InitialFileState::Absent,
                Some(TargetOwnershipGuard {
                    file: Some(file),
                    identity,
                }),
            ))
        }
        Err(_) => Err(StorageError::new(StorageErrorCode::Io)),
    }
}

#[cfg(windows)]
fn open_ownership_file(
    path: &Path,
    create_new: bool,
    allow_path_replacement: bool,
) -> Result<File, StorageError> {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_SHARE_DELETE: u32 = 0x0000_0004;
    let share_mode = FILE_SHARE_READ
        | FILE_SHARE_WRITE
        | if allow_path_replacement {
            FILE_SHARE_DELETE
        } else {
            0
        };
    OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(create_new)
        .share_mode(share_mode)
        .open(path)
        .map_err(|_| StorageError::new(StorageErrorCode::Io))
}

#[cfg(not(windows))]
fn open_ownership_file(
    path: &Path,
    create_new: bool,
    _allow_path_replacement: bool,
) -> Result<File, StorageError> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(create_new)
        .open(path)
        .map_err(|_| StorageError::new(StorageErrorCode::Io))?;
    file.try_lock()
        .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?;
    Ok(file)
}

fn sidecar_paths(database_path: &Path) -> [PathBuf; 3] {
    let base = database_path.as_os_str().to_string_lossy();
    [
        PathBuf::from(format!("{base}-wal")),
        PathBuf::from(format!("{base}-shm")),
        PathBuf::from(format!("{base}-journal")),
    ]
}

fn ensure_initialization_sidecars_absent(database_path: &Path) -> Result<(), StorageError> {
    for path in sidecar_paths(database_path) {
        if path
            .try_exists()
            .map_err(|_| StorageError::new(StorageErrorCode::Io))?
        {
            return Err(StorageError::new(StorageErrorCode::CorruptStorage));
        }
    }
    Ok(())
}

fn restore_unopened_target(
    database_path: &Path,
    initial_state: InitialFileState,
    ownership: TargetOwnershipGuard,
) -> Result<(), StorageError> {
    ensure_initialization_sidecars_absent(database_path)?;
    if file_identity(database_path)? != ownership.identity {
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }
    match initial_state {
        InitialFileState::Absent => {}
        InitialFileState::Zero(original_identity) if original_identity == ownership.identity => {}
        InitialFileState::Zero(_) | InitialFileState::NonEmpty => {
            return Err(StorageError::new(StorageErrorCode::CorruptStorage));
        }
    }
    truncate_and_recheck_owned_target(database_path, ownership.identity, &ownership)?;
    Ok(())
}

fn restore_pre_call_state(
    database_path: &Path,
    initial_state: InitialFileState,
    owned_main_identity: FileIdentity,
    ownership: &TargetOwnershipGuard,
) -> Result<(), StorageError> {
    ensure_initialization_sidecars_absent(database_path)?;
    if ownership.identity != owned_main_identity
        || file_identity(database_path)? != owned_main_identity
    {
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }
    match initial_state {
        InitialFileState::Absent => {}
        InitialFileState::Zero(original_identity) if original_identity == owned_main_identity => {}
        InitialFileState::Zero(_) | InitialFileState::NonEmpty => {
            return Err(StorageError::new(StorageErrorCode::CorruptStorage));
        }
    }
    truncate_and_recheck_owned_target(database_path, owned_main_identity, ownership)?;
    Ok(())
}

fn truncate_and_recheck_owned_target(
    database_path: &Path,
    expected_identity: FileIdentity,
    ownership: &TargetOwnershipGuard,
) -> Result<(), StorageError> {
    let file = ownership
        .file
        .as_ref()
        .ok_or_else(|| StorageError::new(StorageErrorCode::CorruptStorage))?;
    file.set_len(0)
        .map_err(|_| StorageError::new(StorageErrorCode::Io))?;
    file.sync_all()
        .map_err(|_| StorageError::new(StorageErrorCode::Io))?;

    let retained_metadata = file
        .metadata()
        .map_err(|_| StorageError::new(StorageErrorCode::Io))?;
    ensure_initialization_sidecars_absent(database_path)?;
    if retained_metadata.len() != 0
        || identity_from_metadata(&retained_metadata)? != expected_identity
        || file_identity(database_path)? != expected_identity
    {
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }
    Ok(())
}

fn file_identity(path: &Path) -> Result<FileIdentity, StorageError> {
    let metadata = fs::metadata(path).map_err(|_| StorageError::new(StorageErrorCode::Io))?;
    identity_from_metadata(&metadata)
}

#[cfg(windows)]
fn identity_from_metadata(metadata: &fs::Metadata) -> Result<FileIdentity, StorageError> {
    use std::os::windows::fs::MetadataExt;

    Ok(FileIdentity {
        first: metadata.creation_time(),
        second: u64::from(metadata.file_attributes()),
    })
}

#[cfg(unix)]
fn identity_from_metadata(metadata: &fs::Metadata) -> Result<FileIdentity, StorageError> {
    use std::os::unix::fs::MetadataExt;

    Ok(FileIdentity {
        first: metadata.dev(),
        second: metadata.ino(),
    })
}

#[cfg(not(any(windows, unix)))]
fn identity_from_metadata(_metadata: &fs::Metadata) -> Result<FileIdentity, StorageError> {
    Err(StorageError::new(StorageErrorCode::UnsupportedPlatform))
}

impl From<rusqlite::Error> for StorageError {
    fn from(_error: rusqlite::Error) -> Self {
        StorageError::new(StorageErrorCode::CorruptStorage)
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;
    use vault_crypto::PasswordEnvelopeStorageDispositionV1;

    use super::*;
    use crate::StoreLocationPolicyV1;

    const HARDENING_STEPS: usize = 13;
    const SYNTHETIC_PASSWORD_ENVELOPE: &[u8] = &[
        138, 0, 25, 161, 1, 1, 80, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 26, 0, 1,
        0, 0, 3, 4, 88, 32, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33,
        34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 88, 24, 80, 81, 82, 83, 84, 85, 86,
        87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 88, 48, 151, 12,
        220, 163, 233, 59, 147, 250, 92, 52, 232, 245, 250, 193, 37, 80, 255, 39, 16, 143, 232,
        159, 89, 181, 82, 68, 79, 67, 166, 149, 154, 159, 148, 219, 0, 42, 88, 26, 45, 251, 183,
        191, 25, 101, 179, 127, 118, 36,
    ];

    fn bootstrap_bytes() -> Vec<u8> {
        SYNTHETIC_PASSWORD_ENVELOPE.to_vec()
    }

    fn with_bootstrap(
        bytes: &[u8],
        action: impl FnOnce(PasswordEnvelopeBootstrapProjectionV1<'_>),
    ) {
        let disposition = inspect_password_envelope_for_storage_v1(bytes).unwrap();
        let PasswordEnvelopeStorageDispositionV1::Current(inspection) = disposition else {
            panic!("synthetic current envelope was not current");
        };
        action(inspection.bootstrap_projection());
    }

    fn assert_failpoint_restores_and_retries(
        bytes: &[u8],
        failpoint: InitFailPoint,
        precreate_zero: bool,
    ) {
        let directory = tempdir().unwrap();
        let policy = StoreLocationPolicyV1::new(directory.path()).unwrap();
        let location = policy.location("vault.sqlite3").unwrap();
        if precreate_zero {
            fs::write(location.database_path(), []).unwrap();
        }
        with_bootstrap(bytes, |bootstrap| {
            let result = initialize_with_observer(
                &location,
                bootstrap,
                InitObserver {
                    failpoint,
                    hardening_step: 0,
                    ddl_statement: 0,
                    post_close_hook: None,
                    allow_path_replacement: false,
                },
            );
            assert!(result.is_err());
        });
        assert_eq!(fs::metadata(location.database_path()).unwrap().len(), 0);
        for sidecar in sidecar_paths(location.database_path()) {
            assert!(
                !sidecar.exists(),
                "lingering sidecar: {}",
                sidecar.display()
            );
        }
        with_bootstrap(bytes, |bootstrap| {
            assert!(matches!(
                initialize_v1(&location, bootstrap),
                Ok(InitializeStoreOutcomeV1::Created(_))
            ));
        });
    }

    #[test]
    fn every_hardening_ddl_and_singleton_failpoint_restores_absent_and_zero_byte_state() {
        let bytes = bootstrap_bytes();
        for precreate_zero in [false, true] {
            for step in 0..HARDENING_STEPS {
                assert_failpoint_restores_and_retries(
                    &bytes,
                    InitFailPoint::AfterHardeningStep(step),
                    precreate_zero,
                );
            }
            for step in 0..golden_statements().unwrap().len() {
                assert_failpoint_restores_and_retries(
                    &bytes,
                    InitFailPoint::AfterDdlStatement(step),
                    precreate_zero,
                );
            }
            assert_failpoint_restores_and_retries(
                &bytes,
                InitFailPoint::AfterSingleton,
                precreate_zero,
            );
            assert_failpoint_restores_and_retries(
                &bytes,
                InitFailPoint::AfterReadback,
                precreate_zero,
            );
        }
    }

    fn replace_main_after_identity_check(database_path: &Path) {
        let detached = database_path.with_extension("call-owned-zero");
        fs::rename(database_path, detached).unwrap();
        #[cfg(windows)]
        {
            use std::io::Write;
            use std::os::windows::fs::OpenOptionsExt;

            const FILE_ATTRIBUTE_HIDDEN: u32 = 0x0000_0002;
            let mut replacement = OpenOptions::new()
                .write(true)
                .create_new(true)
                .attributes(FILE_ATTRIBUTE_HIDDEN)
                .open(database_path)
                .unwrap();
            replacement
                .write_all(b"replacement-bytes-must-survive")
                .unwrap();
        }
        #[cfg(not(windows))]
        fs::write(database_path, b"replacement-bytes-must-survive").unwrap();
    }

    #[test]
    fn cleanup_never_deletes_or_truncates_a_replacement_path() {
        let bytes = bootstrap_bytes();
        let directory = tempdir().unwrap();
        let policy = StoreLocationPolicyV1::new(directory.path()).unwrap();
        let location = policy.location("vault.sqlite3").unwrap();

        with_bootstrap(&bytes, |bootstrap| {
            let error = match initialize_with_observer(
                &location,
                bootstrap,
                InitObserver {
                    failpoint: InitFailPoint::AfterReadback,
                    hardening_step: 0,
                    ddl_statement: 0,
                    post_close_hook: Some(replace_main_after_identity_check),
                    allow_path_replacement: true,
                },
            ) {
                Ok(_) => panic!("replacement path was accepted during cleanup"),
                Err(error) => error,
            };
            assert_eq!(error.code(), StorageErrorCode::CorruptStorage);
        });

        assert_eq!(
            fs::read(location.database_path()).unwrap(),
            b"replacement-bytes-must-survive"
        );
    }

    fn inject_lingering_wal(database_path: &Path) {
        let wal_path = PathBuf::from(format!("{}-wal", database_path.to_string_lossy()));
        fs::write(wal_path, b"lingering-sidecar-must-survive").unwrap();
    }

    #[test]
    fn cleanup_preserves_an_injected_lingering_sidecar_exactly() {
        let bytes = bootstrap_bytes();
        let directory = tempdir().unwrap();
        let policy = StoreLocationPolicyV1::new(directory.path()).unwrap();
        let location = policy.location("vault.sqlite3").unwrap();

        with_bootstrap(&bytes, |bootstrap| {
            let error = match initialize_with_observer(
                &location,
                bootstrap,
                InitObserver {
                    failpoint: InitFailPoint::AfterReadback,
                    hardening_step: 0,
                    ddl_statement: 0,
                    post_close_hook: Some(inject_lingering_wal),
                    allow_path_replacement: false,
                },
            ) {
                Ok(_) => panic!("lingering sidecar was not preserved as an error"),
                Err(error) => error,
            };
            assert_eq!(error.code(), StorageErrorCode::CorruptStorage);
        });

        let wal_path = PathBuf::from(format!(
            "{}-wal",
            location.database_path().to_string_lossy()
        ));
        assert_eq!(
            fs::read(wal_path).unwrap(),
            b"lingering-sidecar-must-survive"
        );
    }
}
