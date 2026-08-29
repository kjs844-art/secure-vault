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
    mapped_length: usize,
}

impl WritableMappedViewV1 {
    pub fn open_v1(path: &Path) -> Result<Self, VfsProbeErrorV1> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .open(path)
            .map_err(|error| VfsProbeErrorV1::from_io(&error))?;
        let mapped_length = usize::try_from(
            file.metadata()
                .map_err(|error| VfsProbeErrorV1::from_io(&error))?
                .len(),
        )
        .map_err(|_| VfsProbeErrorV1::protocol())?;
        if mapped_length == 0 {
            return Err(VfsProbeErrorV1::protocol());
        }
        let mapping = unsafe {
            CreateFileMappingW(file.as_raw_handle(), null(), PAGE_READWRITE, 0, 0, null())
        };
        if mapping.is_null() {
            return Err(VfsProbeErrorV1::from_io(&std::io::Error::last_os_error()));
        }
        let view = map_writable_view_v1(
            mapping,
            |mapping| unsafe { MapViewOfFile(mapping, FILE_MAP_WRITE, 0, 0, 0) },
            |mapping| unsafe {
                CloseHandle(mapping);
            },
        )?;

        // Core hostile condition: only the mapping object and mapped view remain.
        drop(file);
        Ok(Self {
            mapping,
            view,
            mapped_length,
        })
    }

    pub fn write_last_byte_and_flush_v1(&mut self, value: u8) -> Result<(), VfsProbeErrorV1> {
        let last_byte = unsafe { self.view.Value.cast::<u8>().add(self.mapped_length - 1) };
        unsafe {
            last_byte.write(value);
        }
        let flushed = unsafe { FlushViewOfFile(last_byte.cast(), 1) };
        if flushed == 0 {
            return Err(VfsProbeErrorV1::from_io(&std::io::Error::last_os_error()));
        }
        Ok(())
    }
}

fn map_writable_view_v1(
    mapping: HANDLE,
    map_view: impl FnOnce(HANDLE) -> MEMORY_MAPPED_VIEW_ADDRESS,
    close_mapping: impl FnOnce(HANDLE),
) -> Result<MEMORY_MAPPED_VIEW_ADDRESS, VfsProbeErrorV1> {
    let view = map_view(mapping);
    if view.Value.is_null() {
        let error = std::io::Error::last_os_error();
        close_mapping(mapping);
        return Err(VfsProbeErrorV1::from_io(&error));
    }
    Ok(view)
}

impl Drop for WritableMappedViewV1 {
    fn drop(&mut self) {
        unsafe {
            UnmapViewOfFile(self.view);
            CloseHandle(self.mapping);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::ptr::{dangling_mut, null_mut};

    use windows_sys::Win32::Foundation::SetLastError;

    use super::{HANDLE, MEMORY_MAPPED_VIEW_ADDRESS, map_writable_view_v1};

    #[test]
    fn map_view_failure_preserves_original_os_code_before_cleanup() {
        let cleanup_called = Cell::new(false);
        let mapping: HANDLE = dangling_mut();

        let result = map_writable_view_v1(
            mapping,
            |_| {
                unsafe {
                    SetLastError(5);
                }
                MEMORY_MAPPED_VIEW_ADDRESS { Value: null_mut() }
            },
            |_| {
                cleanup_called.set(true);
                unsafe {
                    SetLastError(87);
                }
            },
        );

        let error = match result {
            Ok(_) => panic!("expected a mapped-view failure"),
            Err(error) => error,
        };
        assert!(cleanup_called.get());
        assert_eq!(error.os_code(), Some(5));
    }
}
