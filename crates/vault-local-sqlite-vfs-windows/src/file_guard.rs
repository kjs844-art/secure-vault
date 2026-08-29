use std::fs::{File, OpenOptions};
use std::os::windows::fs::{FileExt, OpenOptionsExt};
use std::path::Path;

use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ};

use crate::VfsProbeErrorV1;

pub struct BoundReadGuardV1 {
    file: File,
}

impl BoundReadGuardV1 {
    pub fn read_byte_at_v1(&self, offset: u64) -> Result<u8, VfsProbeErrorV1> {
        let mut byte = [0u8; 1];
        let read = self
            .file
            .seek_read(&mut byte, offset)
            .map_err(|error| VfsProbeErrorV1::from_io(&error))?;
        if read != 1 {
            return Err(VfsProbeErrorV1::protocol());
        }
        Ok(byte[0])
    }
}

pub fn acquire_main_read_guard_v1(path: &Path) -> Result<BoundReadGuardV1, VfsProbeErrorV1> {
    let file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| VfsProbeErrorV1::from_io(&error))?;
    Ok(BoundReadGuardV1 { file })
}
