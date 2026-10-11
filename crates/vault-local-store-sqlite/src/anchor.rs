use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use blake3::Hasher;

use crate::{StorageError, StorageErrorCode};

const MAGIC: &[u8; 8] = b"SVLTANH1";
const ANCHOR_VERSION: u64 = 1;
const HEADER_LEN: usize = 24;
const RECORD_LEN: usize = 64;
pub(crate) const MAX_ANCHOR_RECORDS: usize = 30_000;
const MAX_ANCHOR_FILE_BYTES: usize = HEADER_LEN + RECORD_LEN * (MAX_ANCHOR_RECORDS + 1);

pub(crate) fn anchor_path(database_path: &Path) -> PathBuf {
    let mut name = database_path.as_os_str().to_os_string();
    name.push(".anchor");
    PathBuf::from(name)
}

pub(crate) struct AnchorLedger {
    confirmed: Vec<[u8; 32]>,
    tentative: Option<[u8; 32]>,
}

impl AnchorLedger {
    pub(crate) fn is_empty(&self) -> bool {
        self.confirmed.is_empty() && self.tentative.is_none()
    }
}

pub(crate) enum AnchorJudgment {
    Bootstrap,
    Current,
    ConfirmTentative,
    Rollback,
    Unknown,
}

pub(crate) fn load(database_path: &Path) -> Result<AnchorLedger, StorageError> {
    load_from_path(&anchor_path(database_path))
}

fn load_from_path(path: &Path) -> Result<AnchorLedger, StorageError> {
    let mut file = match OpenOptions::new().read(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AnchorLedger {
                confirmed: Vec::new(),
                tentative: None,
            });
        }
        Err(_) => return Err(StorageError::new(StorageErrorCode::Io)),
    };
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|_| StorageError::new(StorageErrorCode::Io))?;
    if bytes.len() > MAX_ANCHOR_FILE_BYTES {
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }
    parse(&bytes)
}

fn parse(bytes: &[u8]) -> Result<AnchorLedger, StorageError> {
    if bytes.is_empty() {
        return Ok(AnchorLedger {
            confirmed: Vec::new(),
            tentative: None,
        });
    }
    if bytes.len() < HEADER_LEN {
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }
    if &bytes[0..8] != MAGIC {
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }
    if u64::from_be_bytes(bytes[8..16].try_into().expect("version slice")) != ANCHOR_VERSION {
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }
    let confirmed_count =
        u64::from_be_bytes(bytes[16..24].try_into().expect("count slice")) as usize;
    if confirmed_count > MAX_ANCHOR_RECORDS {
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }
    let body = &bytes[HEADER_LEN..];
    let full = body.len() / RECORD_LEN;
    let partial = body.len() % RECORD_LEN;
    if full < confirmed_count || full - confirmed_count > 1 {
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }
    if partial != 0 && full != confirmed_count {
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }
    let mut confirmed = Vec::with_capacity(confirmed_count);
    for index in 0..confirmed_count {
        let record = &body[index * RECORD_LEN..index * RECORD_LEN + RECORD_LEN];
        confirmed.push(parse_record(record)?);
    }
    let tentative = if full == confirmed_count + 1 {
        let record = &body[confirmed_count * RECORD_LEN..confirmed_count * RECORD_LEN + RECORD_LEN];
        Some(parse_record(record)?)
    } else {
        None
    };
    Ok(AnchorLedger {
        confirmed,
        tentative,
    })
}

fn parse_record(record: &[u8]) -> Result<[u8; 32], StorageError> {
    let digest: [u8; 32] = record[0..32].try_into().expect("digest slice");
    let mut hasher = Hasher::new();
    hasher.update(&digest);
    if hasher.finalize().as_bytes() != &record[32..RECORD_LEN] {
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }
    Ok(digest)
}

fn encode_record(digest: &[u8; 32]) -> [u8; RECORD_LEN] {
    let mut record = [0_u8; RECORD_LEN];
    record[0..32].copy_from_slice(digest);
    let mut hasher = Hasher::new();
    hasher.update(digest);
    record[32..RECORD_LEN].copy_from_slice(hasher.finalize().as_bytes());
    record
}

pub(crate) fn classify(ledger: &AnchorLedger, digest: &[u8; 32]) -> AnchorJudgment {
    if ledger.is_empty() {
        AnchorJudgment::Bootstrap
    } else if ledger.confirmed.last() == Some(digest) {
        AnchorJudgment::Current
    } else if ledger.tentative == Some(*digest) {
        AnchorJudgment::ConfirmTentative
    } else if ledger.confirmed.iter().any(|entry| entry == digest) {
        AnchorJudgment::Rollback
    } else {
        AnchorJudgment::Unknown
    }
}

fn confirm_tentative(path: &Path) -> Result<(), StorageError> {
    let ledger = load_from_path(path)?;
    let Some(tentative) = ledger.tentative else {
        return Err(StorageError::new(StorageErrorCode::InvariantViolation));
    };
    let confirmed_count = ledger.confirmed.len();
    let mut file = open_anchor_writer(path, false)?;
    file.seek(SeekFrom::Start(
        (HEADER_LEN + RECORD_LEN * confirmed_count) as u64,
    ))
    .map_err(|_| io_error())?;
    file.write_all(&encode_record(&tentative))
        .map_err(|_| io_error())?;
    file.seek(SeekFrom::Start(16)).map_err(|_| io_error())?;
    file.write_all(&((confirmed_count + 1) as u64).to_be_bytes())
        .map_err(|_| io_error())?;
    file.sync_all().map_err(|_| io_error())?;
    Ok(())
}

fn io_error() -> StorageError {
    StorageError::new(StorageErrorCode::Io)
}

#[cfg(windows)]
fn open_anchor_writer(path: &Path, create: bool) -> Result<File, StorageError> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    if create {
        options.create(true);
    }
    options.open(path).map_err(|_| io_error())
}

#[cfg(unix)]
fn open_anchor_writer(path: &Path, create: bool) -> Result<File, StorageError> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    if create {
        options.create(true);
    }
    options
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| io_error())
}

#[cfg(not(any(windows, unix)))]
fn open_anchor_writer(_path: &Path, _create: bool) -> Result<File, StorageError> {
    Err(StorageError::new(StorageErrorCode::UnsupportedPlatform))
}

fn write_header(file: &mut File, confirmed_count: u64) -> Result<(), StorageError> {
    let mut header = [0_u8; HEADER_LEN];
    header[0..8].copy_from_slice(MAGIC);
    header[8..16].copy_from_slice(&ANCHOR_VERSION.to_be_bytes());
    header[16..24].copy_from_slice(&confirmed_count.to_be_bytes());
    file.seek(SeekFrom::Start(0)).map_err(|_| io_error())?;
    file.write_all(&header).map_err(|_| io_error())?;
    Ok(())
}

pub(crate) fn create_with_confirmed_entry(
    path: &Path,
    digest: &[u8; 32],
) -> Result<(), StorageError> {
    let mut file = open_anchor_writer(path, true)?;
    file.set_len(0).map_err(|_| io_error())?;
    write_header(&mut file, 1)?;
    file.write_all(&encode_record(digest))
        .map_err(|_| io_error())?;
    file.sync_all().map_err(|_| io_error())?;
    Ok(())
}

pub(crate) fn append_confirmed(path: &Path, digest: &[u8; 32]) -> Result<(), StorageError> {
    let ledger = load_from_path(path)?;
    if ledger.confirmed.last() == Some(digest) {
        return Ok(());
    }
    if ledger.confirmed.iter().any(|entry| entry == digest) {
        return Err(StorageError::new(StorageErrorCode::InvariantViolation));
    }
    let confirmed_count = ledger.confirmed.len();
    if confirmed_count >= MAX_ANCHOR_RECORDS {
        return Err(StorageError::new(StorageErrorCode::LimitsExceeded));
    }
    let mut file = open_anchor_writer(path, ledger.is_empty())?;
    let boundary = (HEADER_LEN + RECORD_LEN * confirmed_count) as u64;
    file.set_len(boundary).map_err(|_| io_error())?;
    if confirmed_count == 0 {
        write_header(&mut file, 0)?;
    }
    file.seek(SeekFrom::Start(boundary))
        .map_err(|_| io_error())?;
    file.write_all(&encode_record(digest))
        .map_err(|_| io_error())?;
    file.seek(SeekFrom::Start(16)).map_err(|_| io_error())?;
    file.write_all(&((confirmed_count + 1) as u64).to_be_bytes())
        .map_err(|_| io_error())?;
    file.sync_all().map_err(|_| io_error())?;
    Ok(())
}

pub(crate) fn adopt_for_promotion(path: &Path, digest: &[u8; 32]) -> Result<(), StorageError> {
    let ledger = load_from_path(path)?;
    if ledger.tentative.is_some() {
        if ledger.tentative == Some(*digest) {
            return confirm_tentative(path);
        }
        return Err(StorageError::new(StorageErrorCode::InvariantViolation));
    }
    if ledger.confirmed.last() == Some(digest) {
        return Ok(());
    }
    if ledger.is_empty() {
        return create_with_confirmed_entry(path, digest);
    }
    Err(StorageError::new(StorageErrorCode::InvariantViolation))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::{TempDir, tempdir};

    fn ledger_path() -> (TempDir, PathBuf) {
        let directory = tempdir().unwrap();
        let path = directory.path().join("vault.sqlite3.anchor");
        (directory, path)
    }

    #[test]
    fn bootstrap_admits_an_absent_or_empty_anchor() {
        let (directory, path) = ledger_path();
        assert!(matches!(
            classify(&load_from_path(&path).unwrap(), &[1_u8; 32]),
            AnchorJudgment::Bootstrap
        ));
        std::fs::write(&path, []).unwrap();
        assert!(matches!(
            classify(&load_from_path(&path).unwrap(), &[1_u8; 32]),
            AnchorJudgment::Bootstrap
        ));
        drop(directory);
    }

    #[test]
    fn append_and_classification_round_trip() {
        let (directory, path) = ledger_path();
        let first = [1_u8; 32];
        let second = [2_u8; 32];
        append_confirmed(&path, &first).unwrap();
        assert!(matches!(
            classify(&load_from_path(&path).unwrap(), &first),
            AnchorJudgment::Current
        ));
        append_confirmed(&path, &second).unwrap();
        assert!(matches!(
            classify(&load_from_path(&path).unwrap(), &second),
            AnchorJudgment::Current
        ));
        assert!(matches!(
            classify(&load_from_path(&path).unwrap(), &first),
            AnchorJudgment::Rollback
        ));
        assert!(matches!(
            classify(&load_from_path(&path).unwrap(), &[3_u8; 32]),
            AnchorJudgment::Unknown
        ));
        drop(directory);
    }

    #[test]
    fn duplicate_append_of_the_head_is_idempotent_and_history_repeats_reject() {
        let (directory, path) = ledger_path();
        let first = [1_u8; 32];
        append_confirmed(&path, &first).unwrap();
        append_confirmed(&path, &first).unwrap();
        let ledger = load_from_path(&path).unwrap();
        assert_eq!(ledger.confirmed.len(), 1);
        let second = [2_u8; 32];
        append_confirmed(&path, &second).unwrap();
        assert!(append_confirmed(&path, &first).is_err());
        drop(directory);
    }

    #[test]
    fn partial_trailing_record_is_ignored_as_a_crashed_tentative() {
        let (directory, path) = ledger_path();
        let first = [1_u8; 32];
        append_confirmed(&path, &first).unwrap();
        let mut bytes = std::fs::read(&path).unwrap();
        bytes.extend_from_slice(&encode_record(&[2_u8; 32])[..17]);
        std::fs::write(&path, bytes).unwrap();
        let ledger = load_from_path(&path).unwrap();
        assert!(ledger.tentative.is_none());
        assert!(matches!(classify(&ledger, &first), AnchorJudgment::Current));
        drop(directory);
    }

    #[test]
    fn full_trailing_record_is_a_crashed_tentative_that_promotion_confirms() {
        let (directory, path) = ledger_path();
        let first = [1_u8; 32];
        let second = [2_u8; 32];
        append_confirmed(&path, &first).unwrap();
        let mut bytes = std::fs::read(&path).unwrap();
        bytes.extend_from_slice(&encode_record(&second));
        std::fs::write(&path, bytes).unwrap();
        let ledger = load_from_path(&path).unwrap();
        assert!(ledger.tentative == Some(second));
        assert!(matches!(
            classify(&ledger, &second),
            AnchorJudgment::ConfirmTentative
        ));
        adopt_for_promotion(&path, &second).unwrap();
        assert!(matches!(
            classify(&load_from_path(&path).unwrap(), &second),
            AnchorJudgment::Current
        ));
        drop(directory);
    }

    #[test]
    fn tampered_digest_checksum_and_header_are_rejected() {
        let (directory, path) = ledger_path();
        let first = [1_u8; 32];
        append_confirmed(&path, &first).unwrap();
        let mut bytes = std::fs::read(&path).unwrap();
        bytes[HEADER_LEN] ^= 1;
        std::fs::write(&path, &bytes).unwrap();
        assert!(load_from_path(&path).is_err());
        let mut bytes = std::fs::read(&path).unwrap();
        bytes[0] ^= 1;
        std::fs::write(&path, &bytes).unwrap();
        assert!(load_from_path(&path).is_err());
        let mut bytes = std::fs::read(&path).unwrap();
        bytes[16] = 7;
        std::fs::write(&path, &bytes).unwrap();
        assert!(load_from_path(&path).is_err());
        drop(directory);
    }

    #[test]
    fn adoption_covers_bootstrap_current_confirm_and_stale_tentative() {
        let (directory, path) = ledger_path();
        let first = [1_u8; 32];
        let second = [2_u8; 32];
        adopt_for_promotion(&path, &first).unwrap();
        assert!(matches!(
            classify(&load_from_path(&path).unwrap(), &first),
            AnchorJudgment::Current
        ));
        adopt_for_promotion(&path, &first).unwrap();
        let mut bytes = std::fs::read(&path).unwrap();
        bytes.extend_from_slice(&encode_record(&second));
        std::fs::write(&path, bytes).unwrap();
        adopt_for_promotion(&path, &second).unwrap();
        assert!(matches!(
            classify(&load_from_path(&path).unwrap(), &second),
            AnchorJudgment::Current
        ));
        assert!(adopt_for_promotion(&path, &[9_u8; 32]).is_err());
        drop(directory);
    }
}
