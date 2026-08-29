use std::fs::OpenOptions;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::ptr::null;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
};
use windows_sys::Win32::System::Memory::{
    CreateFileMappingW, FILE_MAP_WRITE, FlushViewOfFile, MEMORY_MAPPED_VIEW_ADDRESS, MapViewOfFile,
    PAGE_READWRITE, UnmapViewOfFile,
};

use crate::VfsProbeErrorV1;

pub struct WritableMappedViewV1 {
    mapping: HANDLE,
    view: MEMORY_MAPPED_VIEW_ADDRESS,
}

impl WritableMappedViewV1 {
    pub fn open_v1(path: &Path) -> Result<Self, VfsProbeErrorV1> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .open(path)
            .map_err(|error| VfsProbeErrorV1::from_io(&error))?;
        let mapping = unsafe {
            CreateFileMappingW(file.as_raw_handle(), null(), PAGE_READWRITE, 0, 0, null())
        };
        if mapping.is_null() {
            return Err(VfsProbeErrorV1::from_io(&std::io::Error::last_os_error()));
        }
        let view = unsafe { MapViewOfFile(mapping, FILE_MAP_WRITE, 0, 0, 0) };
        if view.Value.is_null() {
            unsafe {
                CloseHandle(mapping);
            }
            return Err(VfsProbeErrorV1::from_io(&std::io::Error::last_os_error()));
        }

        // Core hostile condition: only the mapping object and mapped view remain.
        drop(file);
        Ok(Self { mapping, view })
    }

    pub fn write_first_byte_and_flush_v1(&mut self, value: u8) -> Result<(), VfsProbeErrorV1> {
        unsafe {
            self.view.Value.cast::<u8>().write(value);
        }
        let flushed = unsafe { FlushViewOfFile(self.view.Value, 1) };
        if flushed == 0 {
            return Err(VfsProbeErrorV1::from_io(&std::io::Error::last_os_error()));
        }
        Ok(())
    }
}

impl Drop for WritableMappedViewV1 {
    fn drop(&mut self) {
        unsafe {
            UnmapViewOfFile(self.view);
            CloseHandle(self.mapping);
        }
    }
}
