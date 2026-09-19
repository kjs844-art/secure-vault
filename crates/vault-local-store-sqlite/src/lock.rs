use std::ffi::{OsStr, OsString};
use std::fs::{File, OpenOptions};
use std::path::{Component, Path, PathBuf};

use crate::{StorageError, StorageErrorCode};

pub struct TrustedLocalAppDataRootV1 {
    app_root: PathBuf,
}

pub struct StoreLocationPolicyV1 {
    app_root: PathBuf,
}

pub struct StoreLocationV1 {
    database_path: PathBuf,
    lock_path: PathBuf,
}

pub struct StoreLockV1 {
    file: File,
}

impl TrustedLocalAppDataRootV1 {
    pub fn for_current_user() -> Result<Self, StorageError> {
        let app_root = vault_local_platform_windows::trusted_local_app_data_root_v1()
            .map_err(|_| StorageError::new(StorageErrorCode::UnsupportedPlatform))?;
        if !app_root.is_absolute()
            || path_is_network_like(&app_root)
            || path_is_disallowed(&app_root)
        {
            return Err(StorageError::new(StorageErrorCode::UnsupportedPlatform));
        }
        Ok(Self { app_root })
    }

    pub fn path(&self) -> &Path {
        &self.app_root
    }
}

impl StoreLocationPolicyV1 {
    pub fn new(
        trusted_local_app_data_root: &TrustedLocalAppDataRootV1,
        app_root: &Path,
    ) -> Result<Self, StorageError> {
        if !app_root.is_absolute() || path_is_network_like(app_root) || path_is_disallowed(app_root)
        {
            return Err(StorageError::new(StorageErrorCode::UnsupportedPlatform));
        }
        let canonical = app_root
            .canonicalize()
            .map_err(|_| StorageError::new(StorageErrorCode::Io))?;
        if !canonical.is_absolute()
            || !canonical.starts_with(trusted_local_app_data_root.path())
            || path_is_network_like(&canonical)
            || path_is_disallowed(&canonical)
            || has_repository_marker(&canonical)
        {
            return Err(StorageError::new(StorageErrorCode::UnsupportedPlatform));
        }
        Ok(Self {
            app_root: canonical,
        })
    }

    pub fn location(
        &self,
        relative_path: impl AsRef<Path>,
    ) -> Result<StoreLocationV1, StorageError> {
        let relative_path = relative_path.as_ref();
        if relative_path.as_os_str().is_empty()
            || relative_path.is_absolute()
            || path_is_network_like(relative_path)
            || path_is_disallowed(relative_path)
            || relative_path.components().any(|component| match component {
                Component::Normal(value) => windows_component_is_ambiguous(value),
                _ => true,
            })
        {
            return Err(StorageError::new(StorageErrorCode::UnsupportedPlatform));
        }
        let database_path = self.app_root.join(relative_path);
        let Some(parent) = database_path.parent() else {
            return Err(StorageError::new(StorageErrorCode::UnsupportedPlatform));
        };
        let canonical_parent = parent
            .canonicalize()
            .map_err(|_| StorageError::new(StorageErrorCode::Io))?;
        if !canonical_parent.starts_with(&self.app_root)
            || path_is_disallowed(&canonical_parent)
            || path_is_network_like(&canonical_parent)
            || has_repository_marker_between(&canonical_parent, &self.app_root)
        {
            return Err(StorageError::new(StorageErrorCode::UnsupportedPlatform));
        }
        let Some(file_name) = database_path.file_name() else {
            return Err(StorageError::new(StorageErrorCode::UnsupportedPlatform));
        };
        let mut lock_name = OsString::from(file_name);
        lock_name.push(".lock");
        let database_path = canonical_parent.join(file_name);
        let lock_path = canonical_parent.join(lock_name);
        Ok(StoreLocationV1 {
            database_path,
            lock_path,
        })
    }
}

fn has_repository_marker(path: &Path) -> bool {
    [".git", ".hg", ".svn"]
        .iter()
        .any(|marker| path.join(marker).exists())
}

fn has_repository_marker_between(target_parent: &Path, trusted_root: &Path) -> bool {
    target_parent
        .ancestors()
        .take_while(|ancestor| ancestor.starts_with(trusted_root))
        .any(has_repository_marker)
}

impl StoreLocationV1 {
    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    pub fn lock_path(&self) -> &Path {
        &self.lock_path
    }
}

impl StoreLockV1 {
    pub fn try_acquire(location: &StoreLocationV1) -> Result<Self, StorageError> {
        let file = open_store_lock_file(location.lock_path())?;
        validate_store_lock_file(&file)?;
        match file.try_lock() {
            Ok(()) => Ok(Self { file }),
            Err(std::fs::TryLockError::WouldBlock) => {
                Err(StorageError::new(StorageErrorCode::Busy))
            }
            Err(std::fs::TryLockError::Error(_)) => Err(StorageError::new(StorageErrorCode::Io)),
        }
    }
}

#[cfg(windows)]
fn open_store_lock_file(path: &Path) -> Result<File, StorageError> {
    use std::os::windows::fs::OpenOptionsExt;

    const ERROR_SHARING_VIOLATION: i32 = 32;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

    // OPEN_ALWAYS is atomic. OPEN_REPARSE_POINT protects the final component,
    // while omitting WRITE and DELETE sharing pins that entry for this guard's
    // lifetime. Parent-directory namespace replacement remains out of scope.
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| {
            if error.raw_os_error() == Some(ERROR_SHARING_VIOLATION) {
                StorageError::new(StorageErrorCode::Busy)
            } else {
                StorageError::new(StorageErrorCode::Io)
            }
        })
}

#[cfg(not(windows))]
fn open_store_lock_file(path: &Path) -> Result<File, StorageError> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|_| StorageError::new(StorageErrorCode::Io))
}

fn validate_store_lock_file(file: &File) -> Result<(), StorageError> {
    let metadata = file
        .metadata()
        .map_err(|_| StorageError::new(StorageErrorCode::Io))?;
    if !metadata.file_type().is_file() || metadata_is_windows_reparse_point(&metadata) {
        return Err(StorageError::new(StorageErrorCode::CorruptStorage));
    }
    Ok(())
}

#[cfg(windows)]
fn metadata_is_windows_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_windows_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

impl Drop for StoreLockV1 {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

fn path_is_network_like(path: &Path) -> bool {
    let text = path.as_os_str().to_string_lossy();
    platform_path_is_network_like(path)
        || text.starts_with("//")
        || text.contains("://")
        || text.starts_with("file:")
}

#[cfg(windows)]
fn platform_path_is_network_like(path: &Path) -> bool {
    use std::path::Prefix;

    matches!(
        path.components().next(),
        Some(Component::Prefix(prefix))
            if matches!(
                prefix.kind(),
                Prefix::UNC(_, _) | Prefix::VerbatimUNC(_, _) | Prefix::DeviceNS(_)
            )
    )
}

#[cfg(not(windows))]
fn platform_path_is_network_like(_path: &Path) -> bool {
    false
}

fn path_is_disallowed(path: &Path) -> bool {
    path.components().any(|component| {
        let Component::Normal(value) = component else {
            return false;
        };
        let lower = value.to_string_lossy().to_ascii_lowercase();
        matches!(lower.as_str(), ".git" | ".hg" | ".svn") || is_cloud_component(&lower)
    })
}

// Apply Windows-safe spelling on every build so a persisted relative location
// cannot become an alias after moving the same configuration to Windows.
fn windows_component_is_ambiguous(component: &OsStr) -> bool {
    let Some(component) = component.to_str() else {
        return true;
    };
    if component.is_empty()
        || component.ends_with('.')
        || component.ends_with(' ')
        || component.contains(':')
    {
        return true;
    }

    let basename = component
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ');
    let uppercase = basename.to_ascii_uppercase();
    matches!(
        uppercase.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "CLOCK$"
            | "CONIN$"
            | "CONOUT$"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
            | "COM¹"
            | "COM²"
            | "COM³"
            | "LPT¹"
            | "LPT²"
            | "LPT³"
    )
}

fn is_cloud_component(component: &str) -> bool {
    const PROVIDERS: &[&str] = &[
        "onedrive",
        "dropbox",
        "google drive",
        "googledrive",
        "icloud drive",
        "icloud",
    ];
    PROVIDERS.iter().any(|provider| {
        component == *provider
            || component
                .strip_prefix(provider)
                .is_some_and(|suffix| suffix.starts_with(" - "))
    })
}
