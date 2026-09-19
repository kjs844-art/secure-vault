use std::ffi::OsString;
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

const SECURITY_DB_CONFIGS: [(DbConfig, bool); 8] = [
    (DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true),
    (DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false),
    (DbConfig::SQLITE_DBCONFIG_ENABLE_FKEY, true),
    (DbConfig::SQLITE_DBCONFIG_ENABLE_TRIGGER, true),
    (DbConfig::SQLITE_DBCONFIG_DQS_DML, false),
    (DbConfig::SQLITE_DBCONFIG_DQS_DDL, false),
    (DbConfig::SQLITE_DBCONFIG_ENABLE_ATTACH_CREATE, false),
    (DbConfig::SQLITE_DBCONFIG_ENABLE_ATTACH_WRITE, false),
];

#[derive(Clone, Copy)]
enum ConnectionAccess {
    ReadOnly,
    Writable,
}

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
    volume_or_device: u64,
    identifier: [u8; 16],
}

impl FileIdentity {
    const fn from_full_parts(volume_or_device: u64, identifier: [u8; 16]) -> Self {
        Self {
            volume_or_device,
            identifier,
        }
    }
}

type IdentityProvider = fn(&File) -> Result<FileIdentity, StorageError>;

#[derive(Clone, Copy)]
struct TargetKindFacts {
    is_file: bool,
    is_symlink: bool,
    is_reparse: bool,
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
    pre_ownership_open_hook: Option<fn(&Path)>,
    allow_path_replacement: bool,
}

impl InitObserver {
    const fn production() -> Self {
        Self {
            failpoint: InitFailPoint::Never,
            hardening_step: 0,
            ddl_statement: 0,
            post_close_hook: None,
            pre_ownership_open_hook: None,
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
    let (initial_state, ownership) = acquire_target_ownership(
        location.database_path(),
        observer.allow_path_replacement,
        observer.pre_ownership_open_hook,
    )?;
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
    harden_connection(&connection, ConnectionAccess::ReadOnly, None)?;
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
    harden_connection(connection, ConnectionAccess::Writable, Some(observer))
}

fn harden_connection(
    connection: &Connection,
    access: ConnectionAccess,
    mut observer: Option<&mut InitObserver>,
) -> Result<(), StorageError> {
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?;
    observe_hardening(&mut observer)?;
    connection
        .load_extension_disable()
        .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?;
    observe_hardening(&mut observer)?;

    for (config, expected) in SECURITY_DB_CONFIGS {
        let applied = connection
            .set_db_config(config, expected)
            .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?;
        let verified = connection
            .db_config(config)
            .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?;
        if applied != expected || verified != expected {
            return Err(StorageError::new(StorageErrorCode::UnsupportedPlatform));
        }
        observe_hardening(&mut observer)?;
    }

    if matches!(access, ConnectionAccess::Writable) {
        let journal_mode: String = connection
            .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
            .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?;
        if !journal_mode.eq_ignore_ascii_case("wal") {
            return Err(StorageError::new(StorageErrorCode::UnsupportedPlatform));
        }
        observe_hardening(&mut observer)?;
    }

    let mode_pragmas = match access {
        ConnectionAccess::ReadOnly => {
            "PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON;"
        }
        ConnectionAccess::Writable => {
            "PRAGMA synchronous=FULL; PRAGMA query_only=OFF; PRAGMA foreign_keys=ON; \
             PRAGMA recursive_triggers=ON;"
        }
    };
    connection
        .execute_batch(mode_pragmas)
        .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?;
    if pragma_i64(connection, "foreign_keys")? != 1
        || pragma_i64(connection, "recursive_triggers")? != 1
        || match access {
            ConnectionAccess::ReadOnly => pragma_i64(connection, "query_only")? != 1,
            ConnectionAccess::Writable => {
                pragma_i64(connection, "query_only")? != 0
                    || pragma_i64(connection, "synchronous")? != 2
            }
        }
    {
        return Err(StorageError::new(StorageErrorCode::UnsupportedPlatform));
    }
    observe_hardening(&mut observer)?;

    let main_is_read_only = connection
        .is_readonly("main")
        .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?;
    if main_is_read_only != matches!(access, ConnectionAccess::ReadOnly)
        || pragma_i64(connection, "foreign_keys")? != 1
        || pragma_i64(connection, "trusted_schema")? != 0
    {
        return Err(StorageError::new(StorageErrorCode::UnsupportedPlatform));
    }
    observe_hardening(&mut observer)?;
    Ok(())
}

fn observe_hardening(observer: &mut Option<&mut InitObserver>) -> Result<(), StorageError> {
    match observer.as_deref_mut() {
        Some(observer) => observer.hardening_applied(),
        None => Ok(()),
    }
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
        "query_only" => "PRAGMA query_only",
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
    pre_open_hook: Option<fn(&Path)>,
) -> Result<(InitialFileState, Option<TargetOwnershipGuard>), StorageError> {
    acquire_target_ownership_with_identity_provider(
        path,
        allow_path_replacement,
        pre_open_hook,
        identity_from_file,
    )
}

fn acquire_target_ownership_with_identity_provider(
    path: &Path,
    allow_path_replacement: bool,
    pre_open_hook: Option<fn(&Path)>,
    identity_provider: IdentityProvider,
) -> Result<(InitialFileState, Option<TargetOwnershipGuard>), StorageError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            validate_target_kind(target_kind_facts(&metadata))?;
            if metadata.len() > 0 {
                return Ok((InitialFileState::NonEmpty, None));
            }
            let inspection_file = open_inspection_file(path, allow_path_replacement)?;
            let inspection_metadata = inspection_file
                .metadata()
                .map_err(|_| StorageError::new(StorageErrorCode::Io))?;
            validate_target_kind(target_kind_facts(&inspection_metadata))?;
            if inspection_metadata.len() != 0 {
                return Err(StorageError::new(StorageErrorCode::CorruptStorage));
            }
            let pre_call_identity = identity_provider(&inspection_file)?;
            if let Some(hook) = pre_open_hook {
                hook(path);
            }
            let file = open_ownership_file(path, false, allow_path_replacement)?;
            let opened_metadata = file
                .metadata()
                .map_err(|_| StorageError::new(StorageErrorCode::Io))?;
            validate_target_kind(target_kind_facts(&opened_metadata))?;
            let opened_identity = identity_provider(&file)?;
            if opened_identity != pre_call_identity || opened_metadata.len() != 0 {
                return Err(StorageError::new(StorageErrorCode::CorruptStorage));
            }
            drop(inspection_file);
            Ok((
                InitialFileState::Zero(pre_call_identity),
                Some(TargetOwnershipGuard {
                    file: Some(file),
                    identity: opened_identity,
                }),
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let file = open_ownership_file(path, true, allow_path_replacement)?;
            let metadata = file
                .metadata()
                .map_err(|_| StorageError::new(StorageErrorCode::Io))?;
            validate_target_kind(target_kind_facts(&metadata))?;
            if metadata.len() != 0 {
                return Err(StorageError::new(StorageErrorCode::CorruptStorage));
            }
            let identity = identity_provider(&file)?;
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
fn open_inspection_file(path: &Path, allow_path_replacement: bool) -> Result<File, StorageError> {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_SHARE_DELETE: u32 = 0x0000_0004;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    let share_mode = FILE_SHARE_READ
        | FILE_SHARE_WRITE
        | if allow_path_replacement {
            FILE_SHARE_DELETE
        } else {
            0
        };
    OpenOptions::new()
        .read(true)
        .share_mode(share_mode)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| StorageError::new(StorageErrorCode::Io))
}

#[cfg(unix)]
fn open_inspection_file(path: &Path, _allow_path_replacement: bool) -> Result<File, StorageError> {
    use std::os::unix::fs::OpenOptionsExt;

    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| StorageError::new(StorageErrorCode::Io))
}

#[cfg(not(any(windows, unix)))]
fn open_inspection_file(_path: &Path, _allow_path_replacement: bool) -> Result<File, StorageError> {
    Err(StorageError::new(StorageErrorCode::UnsupportedPlatform))
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
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
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
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| StorageError::new(StorageErrorCode::Io))
}

#[cfg(unix)]
fn open_ownership_file(
    path: &Path,
    create_new: bool,
    _allow_path_replacement: bool,
) -> Result<File, StorageError> {
    use std::os::unix::fs::OpenOptionsExt;

    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(create_new)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| StorageError::new(StorageErrorCode::Io))?;
    file.try_lock()
        .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?;
    Ok(file)
}

#[cfg(not(any(windows, unix)))]
fn open_ownership_file(
    _path: &Path,
    _create_new: bool,
    _allow_path_replacement: bool,
) -> Result<File, StorageError> {
    Err(StorageError::new(StorageErrorCode::UnsupportedPlatform))
}

fn sidecar_paths(database_path: &Path) -> [PathBuf; 3] {
    [
        sidecar_path(database_path, "-wal"),
        sidecar_path(database_path, "-shm"),
        sidecar_path(database_path, "-journal"),
    ]
}

fn sidecar_path(database_path: &Path, suffix: &str) -> PathBuf {
    let mut path = OsString::from(database_path.as_os_str());
    path.push(suffix);
    PathBuf::from(path)
}

fn ensure_initialization_sidecars_absent(database_path: &Path) -> Result<(), StorageError> {
    for path in sidecar_paths(database_path) {
        match fs::symlink_metadata(path) {
            Ok(_) => return Err(StorageError::new(StorageErrorCode::CorruptStorage)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(StorageError::new(StorageErrorCode::Io)),
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
        || identity_from_file(file)? != expected_identity
        || file_identity(database_path)? != expected_identity
    {
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }
    Ok(())
}

fn file_identity(path: &Path) -> Result<FileIdentity, StorageError> {
    let file = open_inspection_file(path, false)?;
    let metadata = file
        .metadata()
        .map_err(|_| StorageError::new(StorageErrorCode::Io))?;
    validate_target_kind(target_kind_facts(&metadata))?;
    identity_from_file(&file)
}

fn validate_target_kind(facts: TargetKindFacts) -> Result<(), StorageError> {
    if !facts.is_file || facts.is_symlink || facts.is_reparse {
        return Err(StorageError::new(StorageErrorCode::UnsupportedPlatform));
    }
    Ok(())
}

#[cfg(windows)]
fn target_kind_facts(metadata: &fs::Metadata) -> TargetKindFacts {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    TargetKindFacts {
        is_file: metadata.file_type().is_file(),
        is_symlink: metadata.file_type().is_symlink(),
        is_reparse: metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0,
    }
}

#[cfg(unix)]
fn target_kind_facts(metadata: &fs::Metadata) -> TargetKindFacts {
    TargetKindFacts {
        is_file: metadata.file_type().is_file(),
        is_symlink: metadata.file_type().is_symlink(),
        is_reparse: false,
    }
}

#[cfg(not(any(windows, unix)))]
fn target_kind_facts(_metadata: &fs::Metadata) -> TargetKindFacts {
    TargetKindFacts {
        is_file: false,
        is_symlink: false,
        is_reparse: false,
    }
}

#[cfg(windows)]
fn identity_from_file(file: &File) -> Result<FileIdentity, StorageError> {
    let information = vault_local_platform_windows::stable_file_identity_v1(file)
        .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?;
    let (volume_serial_number, file_id) = information.into_parts();
    Ok(FileIdentity::from_full_parts(volume_serial_number, file_id))
}

#[cfg(unix)]
fn identity_from_file(file: &File) -> Result<FileIdentity, StorageError> {
    use std::os::unix::fs::MetadataExt;

    let metadata = file
        .metadata()
        .map_err(|_| StorageError::new(StorageErrorCode::Io))?;

    let mut identifier = [0_u8; 16];
    identifier[..8].copy_from_slice(&metadata.ino().to_le_bytes());
    Ok(FileIdentity::from_full_parts(metadata.dev(), identifier))
}

#[cfg(not(any(windows, unix)))]
fn identity_from_file(_file: &File) -> Result<FileIdentity, StorageError> {
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
    use crate::{StoreLocationPolicyV1, TrustedLocalAppDataRootV1};

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

    #[test]
    fn all_security_db_configs_precede_sql_hardening_calls() {
        let configured = SECURITY_DB_CONFIGS.map(|(config, expected)| (config as i32, expected));
        let expected = [
            (DbConfig::SQLITE_DBCONFIG_DEFENSIVE as i32, true),
            (DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA as i32, false),
            (DbConfig::SQLITE_DBCONFIG_ENABLE_FKEY as i32, true),
            (DbConfig::SQLITE_DBCONFIG_ENABLE_TRIGGER as i32, true),
            (DbConfig::SQLITE_DBCONFIG_DQS_DML as i32, false),
            (DbConfig::SQLITE_DBCONFIG_DQS_DDL as i32, false),
            (DbConfig::SQLITE_DBCONFIG_ENABLE_ATTACH_CREATE as i32, false),
            (DbConfig::SQLITE_DBCONFIG_ENABLE_ATTACH_WRITE as i32, false),
        ];
        assert_eq!(configured, expected);

        let source = include_str!("schema.rs");
        let hardening_body = source
            .split_once("fn harden_connection(")
            .unwrap()
            .1
            .split_once("\nfn observe_hardening(")
            .unwrap()
            .0;
        let final_db_config_readback = hardening_body.find(".db_config(config)").unwrap();
        let first_sql_call = [
            ".prepare(",
            ".prepare_cached(",
            ".execute(",
            ".execute_batch(",
            ".query_row(",
            "pragma_i64(",
        ]
        .into_iter()
        .filter_map(|marker| hardening_body.find(marker))
        .min()
        .unwrap();

        assert!(
            final_db_config_readback < first_sql_call,
            "SQL hardening must not prepare or execute before all db_config settings are verified"
        );
    }

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
        let trusted_root = TrustedLocalAppDataRootV1::for_current_user().unwrap();
        let policy = StoreLocationPolicyV1::new(&trusted_root, directory.path()).unwrap();
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
                    pre_ownership_open_hook: None,
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

    fn replace_zero_with_external_hard_link(database_path: &Path) {
        let external_path = database_path.with_extension("external-zero");
        fs::remove_file(database_path).unwrap();
        fs::hard_link(external_path, database_path).unwrap();
    }

    #[test]
    fn zero_byte_metadata_to_hard_link_substitution_is_rejected_before_sqlite_open() {
        let directory = tempdir().unwrap();
        let trusted_root = TrustedLocalAppDataRootV1::for_current_user().unwrap();
        let policy = StoreLocationPolicyV1::new(&trusted_root, directory.path()).unwrap();
        let location = policy.location("vault.sqlite3").unwrap();
        let external_path = location.database_path().with_extension("external-zero");
        fs::write(location.database_path(), []).unwrap();
        fs::write(&external_path, []).unwrap();

        let bytes = bootstrap_bytes();
        with_bootstrap(&bytes, |bootstrap| {
            let result = initialize_with_observer(
                &location,
                bootstrap,
                InitObserver {
                    failpoint: InitFailPoint::Never,
                    hardening_step: 0,
                    ddl_statement: 0,
                    post_close_hook: None,
                    pre_ownership_open_hook: Some(replace_zero_with_external_hard_link),
                    allow_path_replacement: true,
                },
            );

            let error = match result {
                Ok(_) => panic!("substituted external file was accepted"),
                Err(error) => error,
            };
            assert_eq!(error.code(), StorageErrorCode::CorruptStorage);
        });
        assert_eq!(fs::read(&external_path).unwrap(), b"");
    }

    #[test]
    fn full_identity_distinguishes_refslike_same_low_64_bits() {
        let low = 0x1122_3344_5566_7788_u64.to_le_bytes();
        let mut first_id = [0_u8; 16];
        let mut second_id = [0_u8; 16];
        first_id[..8].copy_from_slice(&low);
        second_id[..8].copy_from_slice(&low);
        first_id[8..].copy_from_slice(&1_u64.to_le_bytes());
        second_id[8..].copy_from_slice(&2_u64.to_le_bytes());

        assert!(
            FileIdentity::from_full_parts(7, first_id)
                != FileIdentity::from_full_parts(7, second_id)
        );
    }

    fn unsupported_identity_provider(_file: &File) -> Result<FileIdentity, StorageError> {
        Err(StorageError::new(StorageErrorCode::UnsupportedPlatform))
    }

    thread_local! {
        static REFS_LIKE_IDENTITY_CALL: std::cell::Cell<u8> = const { std::cell::Cell::new(0) };
    }

    fn refslike_colliding_low64_provider(_file: &File) -> Result<FileIdentity, StorageError> {
        let call = REFS_LIKE_IDENTITY_CALL.with(|counter| {
            let call = counter.get();
            counter.set(call + 1);
            call
        });
        let mut identifier = [0_u8; 16];
        identifier[..8].copy_from_slice(&0x1122_3344_5566_7788_u64.to_le_bytes());
        identifier[8..].copy_from_slice(&u64::from(call + 1).to_le_bytes());
        Ok(FileIdentity::from_full_parts(7, identifier))
    }

    #[test]
    fn refslike_low64_collision_is_rejected_without_mutation() {
        REFS_LIKE_IDENTITY_CALL.with(|counter| counter.set(0));
        let directory = tempdir().unwrap();
        let database_path = directory.path().join("vault.sqlite3");
        fs::write(&database_path, []).unwrap();

        let error = match acquire_target_ownership_with_identity_provider(
            &database_path,
            false,
            None,
            refslike_colliding_low64_provider,
        ) {
            Ok(_) => panic!("ambiguous ReFS-like identity was accepted"),
            Err(error) => error,
        };

        assert_eq!(error.code(), StorageErrorCode::CorruptStorage);
        assert_eq!(fs::read(database_path).unwrap(), b"");
    }

    #[test]
    fn unsupported_stable_identity_fails_closed_without_mutation() {
        let directory = tempdir().unwrap();
        let database_path = directory.path().join("vault.sqlite3");
        fs::write(&database_path, []).unwrap();

        let error = match acquire_target_ownership_with_identity_provider(
            &database_path,
            false,
            None,
            unsupported_identity_provider,
        ) {
            Ok(_) => panic!("unsupported stable identity was accepted"),
            Err(error) => error,
        };

        assert_eq!(error.code(), StorageErrorCode::UnsupportedPlatform);
        assert_eq!(fs::read(database_path).unwrap(), b"");
    }

    #[test]
    fn nonempty_substituted_sentinel_is_never_mutated() {
        let directory = tempdir().unwrap();
        let trusted_root = TrustedLocalAppDataRootV1::for_current_user().unwrap();
        let policy = StoreLocationPolicyV1::new(&trusted_root, directory.path()).unwrap();
        let location = policy.location("vault.sqlite3").unwrap();
        let external_path = location.database_path().with_extension("external-zero");
        let sentinel = b"external-sentinel-must-survive";
        fs::write(location.database_path(), []).unwrap();
        fs::write(&external_path, sentinel).unwrap();

        let bytes = bootstrap_bytes();
        with_bootstrap(&bytes, |bootstrap| {
            assert!(
                initialize_with_observer(
                    &location,
                    bootstrap,
                    InitObserver {
                        failpoint: InitFailPoint::Never,
                        hardening_step: 0,
                        ddl_statement: 0,
                        post_close_hook: None,
                        pre_ownership_open_hook: Some(replace_zero_with_external_hard_link),
                        allow_path_replacement: true,
                    },
                )
                .is_err()
            );
        });
        assert_eq!(fs::read(&external_path).unwrap(), sentinel);
    }

    #[cfg(unix)]
    fn replace_zero_with_external_symlink(database_path: &Path) {
        let external_path = database_path.with_extension("external-symlink-target");
        fs::remove_file(database_path).unwrap();
        std::os::unix::fs::symlink(external_path, database_path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn zero_byte_metadata_to_symlink_or_reparse_substitution_is_rejected_by_ownership_open() {
        let directory = tempdir().unwrap();
        let trusted_root = TrustedLocalAppDataRootV1::for_current_user().unwrap();
        let policy = StoreLocationPolicyV1::new(&trusted_root, directory.path()).unwrap();
        let location = policy.location("vault.sqlite3").unwrap();
        let external_path = location
            .database_path()
            .with_extension("external-symlink-target");
        fs::write(location.database_path(), []).unwrap();
        fs::write(&external_path, []).unwrap();

        let bytes = bootstrap_bytes();
        with_bootstrap(&bytes, |bootstrap| {
            let result = initialize_with_observer(
                &location,
                bootstrap,
                InitObserver {
                    failpoint: InitFailPoint::Never,
                    hardening_step: 0,
                    ddl_statement: 0,
                    post_close_hook: None,
                    pre_ownership_open_hook: Some(replace_zero_with_external_symlink),
                    allow_path_replacement: true,
                },
            );

            assert!(result.is_err(), "substituted reparse target was accepted");
        });
        assert_eq!(fs::read(&external_path).unwrap(), b"");
    }

    #[test]
    fn opened_reparse_target_facts_are_rejected() {
        let result = validate_target_kind(TargetKindFacts {
            is_file: true,
            is_symlink: false,
            is_reparse: true,
        });

        assert_eq!(
            result.unwrap_err().code(),
            StorageErrorCode::UnsupportedPlatform
        );
    }

    #[test]
    fn non_regular_initial_target_is_rejected_without_mutation() {
        let directory = tempdir().unwrap();
        let database_path = directory.path().join("vault.sqlite3");
        fs::create_dir(&database_path).unwrap();

        assert!(acquire_target_ownership(&database_path, false, None).is_err());
        assert!(database_path.is_dir());
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
        let trusted_root = TrustedLocalAppDataRootV1::for_current_user().unwrap();
        let policy = StoreLocationPolicyV1::new(&trusted_root, directory.path()).unwrap();
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
                    pre_ownership_open_hook: None,
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
        let wal_path = sidecar_path(database_path, "-wal");
        fs::write(wal_path, b"lingering-sidecar-must-survive").unwrap();
    }

    #[test]
    fn cleanup_preserves_an_injected_lingering_sidecar_exactly() {
        let bytes = bootstrap_bytes();
        let directory = tempdir().unwrap();
        let trusted_root = TrustedLocalAppDataRootV1::for_current_user().unwrap();
        let policy = StoreLocationPolicyV1::new(&trusted_root, directory.path()).unwrap();
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
                    pre_ownership_open_hook: None,
                    allow_path_replacement: false,
                },
            ) {
                Ok(_) => panic!("lingering sidecar was not preserved as an error"),
                Err(error) => error,
            };
            assert_eq!(error.code(), StorageErrorCode::CorruptStorage);
        });

        let wal_path = sidecar_path(location.database_path(), "-wal");
        assert_eq!(
            fs::read(wal_path).unwrap(),
            b"lingering-sidecar-must-survive"
        );
    }

    #[cfg(any(windows, unix))]
    #[test]
    fn dangling_sidecar_namespace_entry_is_preserved_and_rejected() {
        let directory = tempdir().unwrap();
        let database_path = directory.path().join("vault.sqlite3");
        let missing_target = directory.path().join("missing-external-target");
        let wal_path = sidecar_path(&database_path, "-wal");
        fs::write(&database_path, []).unwrap();

        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            use std::process::{Command, Stdio};

            let status = Command::new("cmd")
                .args(["/D", "/C", "mklink", "/J"])
                .arg(&wal_path)
                .arg(&missing_target)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "Windows junction fixture was unavailable");
            let metadata = fs::symlink_metadata(&wal_path).unwrap();
            assert_ne!(metadata.file_attributes() & 0x0000_0400, 0);
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&missing_target, &wal_path).unwrap();

        let error = ensure_initialization_sidecars_absent(&database_path).unwrap_err();
        assert_eq!(error.code(), StorageErrorCode::CorruptStorage);
        assert_eq!(fs::read(&database_path).unwrap(), b"");
        assert!(fs::symlink_metadata(&wal_path).is_ok());
        assert!(!missing_target.exists());

        #[cfg(windows)]
        fs::remove_dir(&wal_path).unwrap();
        #[cfg(unix)]
        fs::remove_file(&wal_path).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn sidecar_suffixes_preserve_the_exact_windows_os_string() {
        use std::os::windows::ffi::OsStringExt;

        let database_name = OsString::from_wide(&[
            u16::from(b'v'),
            u16::from(b'a'),
            u16::from(b'u'),
            u16::from(b'l'),
            u16::from(b't'),
            0xD800,
        ]);
        let database_path = PathBuf::from(&database_name);
        let mut expected = database_name;
        expected.push("-wal");

        assert_eq!(sidecar_paths(&database_path)[0], PathBuf::from(expected));
    }

    #[cfg(unix)]
    #[test]
    fn sidecar_suffixes_preserve_the_exact_unix_os_string() {
        use std::os::unix::ffi::OsStringExt;

        let database_name = OsString::from_vec(vec![b'v', b'a', b'u', b'l', b't', 0xFF]);
        let database_path = PathBuf::from(&database_name);
        let mut expected = database_name;
        expected.push("-wal");

        assert_eq!(sidecar_paths(&database_path)[0], PathBuf::from(expected));
    }
}
