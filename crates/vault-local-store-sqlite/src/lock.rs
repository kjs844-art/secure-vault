use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::path::{Component, Path, PathBuf};

use crate::{StorageError, StorageErrorCode};

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

impl StoreLocationPolicyV1 {
    pub fn new(app_root: &Path) -> Result<Self, StorageError> {
        if !app_root.is_absolute() || path_is_network_like(app_root) || path_is_disallowed(app_root)
        {
            return Err(StorageError::new(StorageErrorCode::UnsupportedPlatform));
        }
        let canonical = app_root
            .canonicalize()
            .map_err(|_| StorageError::new(StorageErrorCode::Io))?;
        if !canonical.is_absolute()
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
            || relative_path
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
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
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(location.lock_path())
            .map_err(|_| StorageError::new(StorageErrorCode::Io))?;
        match file.try_lock() {
            Ok(()) => Ok(Self { file }),
            Err(std::fs::TryLockError::WouldBlock) => {
                Err(StorageError::new(StorageErrorCode::Busy))
            }
            Err(std::fs::TryLockError::Error(_)) => Err(StorageError::new(StorageErrorCode::Io)),
        }
    }
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
