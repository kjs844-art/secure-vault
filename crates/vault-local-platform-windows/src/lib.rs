//! Audited safe boundary for the Win32 APIs needed by the local vault store.
//!
//! The SQLite store crate keeps `unsafe` forbidden. This crate owns the small FFI surface and
//! exports only a fail-closed lookup for the current user's OS-provided LocalAppData directory.

#![deny(unsafe_op_in_unsafe_fn)]

use std::fs::File;
#[cfg(windows)]
use std::path::Path;
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StableFileIdentityV1 {
    volume_serial_number: u64,
    file_id: [u8; 16],
}

impl StableFileIdentityV1 {
    pub const fn into_parts(self) -> (u64, [u8; 16]) {
        (self.volume_serial_number, self.file_id)
    }
}

#[cfg(windows)]
pub fn stable_file_identity_v1(file: &File) -> std::io::Result<StableFileIdentityV1> {
    use std::mem::size_of;
    use std::os::windows::io::AsRawHandle;

    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ID_INFO, FileIdInfo, GetFileInformationByHandleEx,
    };

    let mut information = FILE_ID_INFO::default();
    // SAFETY: `file` owns a live handle for the complete call; `information` is an initialized,
    // correctly aligned writable `FILE_ID_INFO`, and the buffer size exactly matches its type.
    let succeeded = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle() as HANDLE,
            FileIdInfo,
            (&raw mut information).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if succeeded == 0 {
        return Err(std::io::Error::last_os_error());
    }

    Ok(StableFileIdentityV1 {
        volume_serial_number: information.VolumeSerialNumber,
        file_id: information.FileId.Identifier,
    })
}

#[cfg(not(windows))]
pub fn stable_file_identity_v1(_file: &File) -> std::io::Result<StableFileIdentityV1> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "stable Windows file identity is unavailable",
    ))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TrustedLocalAppDataErrorV1 {
    UnsupportedPlatform,
    KnownFolderUnavailable,
    InvalidKnownFolder,
    NotTrustedLocalDrive,
    Io,
}

#[cfg(windows)]
pub fn trusted_local_app_data_root_v1() -> Result<PathBuf, TrustedLocalAppDataErrorV1> {
    let os_path = windows_known_local_app_data_v1()?;
    let canonical = os_path
        .canonicalize()
        .map_err(|_| TrustedLocalAppDataErrorV1::Io)?;
    if !canonical.is_absolute() || !windows_path_is_trusted_local_v1(&canonical, get_drive_type_v1)
    {
        return Err(TrustedLocalAppDataErrorV1::NotTrustedLocalDrive);
    }
    Ok(canonical)
}

#[cfg(not(windows))]
pub fn trusted_local_app_data_root_v1() -> Result<PathBuf, TrustedLocalAppDataErrorV1> {
    Err(TrustedLocalAppDataErrorV1::UnsupportedPlatform)
}

#[cfg(any(windows, test))]
fn drive_type_is_trusted_local_v1(drive_type: u32) -> bool {
    const DRIVE_FIXED: u32 = 3;
    drive_type == DRIVE_FIXED
}

#[cfg(windows)]
fn windows_path_is_trusted_local_v1(
    path: &Path,
    query_drive_type: impl FnOnce(&[u16]) -> u32,
) -> bool {
    let Some(root) = windows_disk_root_v1(path) else {
        return false;
    };
    drive_type_is_trusted_local_v1(query_drive_type(&root))
}

#[cfg(windows)]
fn windows_disk_root_v1(path: &Path) -> Option<[u16; 4]> {
    use std::path::{Component, Prefix};

    let Component::Prefix(prefix) = path.components().next()? else {
        return None;
    };
    let drive = match prefix.kind() {
        Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => drive,
        _ => return None,
    };
    Some([u16::from(drive), u16::from(b':'), u16::from(b'\\'), 0])
}

#[cfg(windows)]
fn get_drive_type_v1(root: &[u16]) -> u32 {
    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;

    debug_assert_eq!(root.last(), Some(&0));
    // SAFETY: `root` is a NUL-terminated drive-root buffer that lives for the complete call.
    unsafe { GetDriveTypeW(root.as_ptr()) }
}

#[cfg(windows)]
fn windows_known_local_app_data_v1() -> Result<PathBuf, TrustedLocalAppDataErrorV1> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::ptr::null_mut;

    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{
        FOLDERID_LocalAppData, KF_FLAG_DEFAULT, SHGetKnownFolderPath,
    };

    let mut raw = null_mut();
    // SAFETY: `raw` is a valid out-pointer. The null token requests the current user and the
    // returned allocation is released exactly once with `CoTaskMemFree` below.
    let status = unsafe {
        SHGetKnownFolderPath(
            &FOLDERID_LocalAppData,
            KF_FLAG_DEFAULT as u32,
            null_mut(),
            &mut raw,
        )
    };
    if status < 0 || raw.is_null() {
        if !raw.is_null() {
            // SAFETY: a non-null pointer returned by `SHGetKnownFolderPath` uses COM task memory.
            unsafe { CoTaskMemFree(raw.cast()) };
        }
        return Err(TrustedLocalAppDataErrorV1::KnownFolderUnavailable);
    }

    let mut length = 0usize;
    // SAFETY: successful `SHGetKnownFolderPath` returns a valid NUL-terminated UTF-16 string.
    unsafe {
        while *raw.add(length) != 0 {
            length += 1;
        }
    }
    // SAFETY: the scan above established exactly `length` initialized UTF-16 code units.
    let wide = unsafe { std::slice::from_raw_parts(raw, length) };
    let path = PathBuf::from(OsString::from_wide(wide));
    // SAFETY: `raw` came from `SHGetKnownFolderPath` and has not previously been released.
    unsafe { CoTaskMemFree(raw.cast()) };

    if path.as_os_str().is_empty() || !path.is_absolute() {
        return Err(TrustedLocalAppDataErrorV1::InvalidKnownFolder);
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use std::path::Path;

    use super::drive_type_is_trusted_local_v1;
    #[cfg(windows)]
    use super::windows_path_is_trusted_local_v1;

    const DRIVE_UNKNOWN: u32 = 0;
    const DRIVE_NO_ROOT_DIR: u32 = 1;
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_FIXED: u32 = 3;
    const DRIVE_REMOTE: u32 = 4;
    const DRIVE_CDROM: u32 = 5;
    const DRIVE_RAMDISK: u32 = 6;
    const DRIVE_INVALID_FUTURE_VALUE: u32 = 7;

    #[test]
    fn windows_drive_type_policy_accepts_only_fixed_local_storage() {
        assert!(drive_type_is_trusted_local_v1(DRIVE_FIXED));

        for rejected in [
            DRIVE_UNKNOWN,
            DRIVE_NO_ROOT_DIR,
            DRIVE_REMOVABLE,
            DRIVE_REMOTE,
            DRIVE_CDROM,
            DRIVE_RAMDISK,
            DRIVE_INVALID_FUTURE_VALUE,
        ] {
            assert!(
                !drive_type_is_trusted_local_v1(rejected),
                "drive type {rejected} must fail closed"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn disk_prefix_mapped_to_remote_unknown_or_invalid_storage_fails_closed() {
        let disk_prefixed_path = Path::new(r"Z:\mapped-remote\KeyAtlas");

        for rejected in [DRIVE_REMOTE, DRIVE_UNKNOWN, DRIVE_NO_ROOT_DIR] {
            assert!(
                !windows_path_is_trusted_local_v1(disk_prefixed_path, |_| rejected),
                "mapped Prefix::Disk drive type {rejected} must fail closed"
            );
        }
        assert!(windows_path_is_trusted_local_v1(disk_prefixed_path, |_| {
            DRIVE_FIXED
        }));
    }
}
