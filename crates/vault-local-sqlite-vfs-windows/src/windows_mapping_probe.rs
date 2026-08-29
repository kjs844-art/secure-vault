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
use crate::probe_protocol::{
    SYNTHETIC_MAPPING_LENGTH_V1, SYNTHETIC_MAPPING_MUTATED_V1, SYNTHETIC_MAPPING_MUTATION_OFFSET_V1,
};

#[derive(Clone, Copy)]
struct MappingGeometryV1 {
    length: usize,
    last_byte_offset: usize,
    maximum_size_high: u32,
    maximum_size_low: u32,
}

impl MappingGeometryV1 {
    fn synthetic_v1() -> Self {
        let length_u64 = SYNTHETIC_MAPPING_LENGTH_V1 as u64;
        Self {
            length: SYNTHETIC_MAPPING_LENGTH_V1,
            last_byte_offset: SYNTHETIC_MAPPING_MUTATION_OFFSET_V1,
            maximum_size_high: (length_u64 >> 32) as u32,
            maximum_size_low: length_u64 as u32,
        }
    }
}

struct BoundedMappingV1 {
    mapping: HANDLE,
    view: MEMORY_MAPPED_VIEW_ADDRESS,
    geometry: MappingGeometryV1,
}

pub struct WritableMappedViewV1 {
    mapping: HANDLE,
    view: MEMORY_MAPPED_VIEW_ADDRESS,
    geometry: MappingGeometryV1,
}

impl WritableMappedViewV1 {
    pub fn open_synthetic_v1(path: &Path) -> Result<Self, VfsProbeErrorV1> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .open(path)
            .map_err(|error| VfsProbeErrorV1::from_io(&error))?;
        let bounded = create_bounded_mapping_v1(
            file.as_raw_handle(),
            MappingGeometryV1::synthetic_v1(),
            |file, maximum_size_high, maximum_size_low| unsafe {
                CreateFileMappingW(
                    file,
                    null(),
                    PAGE_READWRITE,
                    maximum_size_high,
                    maximum_size_low,
                    null(),
                )
            },
            |mapping, bytes_to_map| unsafe {
                MapViewOfFile(mapping, FILE_MAP_WRITE, 0, 0, bytes_to_map)
            },
            |mapping| unsafe {
                CloseHandle(mapping);
            },
        )?;

        // Core hostile condition: only the mapping object and mapped view remain.
        drop(file);
        Ok(Self {
            mapping: bounded.mapping,
            view: bounded.view,
            geometry: bounded.geometry,
        })
    }

    pub fn mutate_synthetic_a_to_b_and_flush_v1(&mut self) -> Result<(), VfsProbeErrorV1> {
        let last_byte = unsafe {
            self.view
                .Value
                .cast::<u8>()
                .add(self.geometry.last_byte_offset)
        };
        unsafe {
            last_byte.write(SYNTHETIC_MAPPING_MUTATED_V1[self.geometry.last_byte_offset]);
        }
        let flushed = unsafe { FlushViewOfFile(self.view.Value, self.geometry.length) };
        if flushed == 0 {
            return Err(VfsProbeErrorV1::from_io(&std::io::Error::last_os_error()));
        }
        Ok(())
    }
}

fn create_bounded_mapping_v1(
    file: HANDLE,
    geometry: MappingGeometryV1,
    create_mapping: impl FnOnce(HANDLE, u32, u32) -> HANDLE,
    map_view: impl FnOnce(HANDLE, usize) -> MEMORY_MAPPED_VIEW_ADDRESS,
    close_mapping: impl FnOnce(HANDLE),
) -> Result<BoundedMappingV1, VfsProbeErrorV1> {
    if geometry.length == 0 || geometry.last_byte_offset >= geometry.length {
        return Err(VfsProbeErrorV1::protocol());
    }
    let mapping = create_mapping(file, geometry.maximum_size_high, geometry.maximum_size_low);
    if mapping.is_null() {
        return Err(VfsProbeErrorV1::from_io(&std::io::Error::last_os_error()));
    }
    let view = map_view(mapping, geometry.length);
    if view.Value.is_null() {
        let error = std::io::Error::last_os_error();
        close_mapping(mapping);
        return Err(VfsProbeErrorV1::from_io(&error));
    }
    Ok(BoundedMappingV1 {
        mapping,
        view,
        geometry,
    })
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
    use std::ptr::null_mut;

    use windows_sys::Win32::Foundation::SetLastError;

    use crate::probe_protocol::{
        SYNTHETIC_MAPPING_LENGTH_V1, SYNTHETIC_MAPPING_MUTATION_OFFSET_V1,
    };

    use super::{HANDLE, MEMORY_MAPPED_VIEW_ADDRESS, MappingGeometryV1, create_bounded_mapping_v1};

    #[test]
    fn exact_synthetic_length_reaches_both_mapping_stages_and_bounds_write_offset() {
        let create_maximum = Cell::new(None);
        let mapped_bytes = Cell::new(None);
        let mut file_token = 0u8;
        let mut mapping_token = 0u8;
        let mut view_token = 0u8;
        let file: HANDLE = std::ptr::from_mut(&mut file_token).cast();
        let mapping: HANDLE = std::ptr::from_mut(&mut mapping_token).cast();
        let view: *mut core::ffi::c_void = std::ptr::from_mut(&mut view_token).cast();
        let geometry = MappingGeometryV1::synthetic_v1();

        let result = create_bounded_mapping_v1(
            file,
            geometry,
            |observed_file, maximum_high, maximum_low| {
                assert_eq!(observed_file, file);
                create_maximum.set(Some((maximum_high, maximum_low)));
                mapping
            },
            |observed_mapping, bytes_to_map| {
                assert_eq!(observed_mapping, mapping);
                mapped_bytes.set(Some(bytes_to_map));
                MEMORY_MAPPED_VIEW_ADDRESS { Value: view }
            },
            |_| panic!("successful bounded mapping must retain its mapping handle"),
        );

        let bounded = match result {
            Ok(bounded) => bounded,
            Err(error) => panic!("unexpected bounded-mapping error: {error:?}"),
        };
        let (maximum_high, maximum_low) = create_maximum
            .get()
            .expect("CreateFileMappingW geometry must be observed");
        let reconstructed_maximum = (u64::from(maximum_high) << 32) | u64::from(maximum_low);

        assert_eq!(SYNTHETIC_MAPPING_LENGTH_V1, 25);
        assert_eq!(reconstructed_maximum, SYNTHETIC_MAPPING_LENGTH_V1 as u64);
        assert_eq!(mapped_bytes.get(), Some(SYNTHETIC_MAPPING_LENGTH_V1));
        assert_eq!(bounded.geometry.length, SYNTHETIC_MAPPING_LENGTH_V1);
        assert_eq!(
            bounded.geometry.last_byte_offset,
            SYNTHETIC_MAPPING_MUTATION_OFFSET_V1
        );
        assert!(bounded.geometry.last_byte_offset < bounded.geometry.length);
    }

    #[test]
    fn map_view_failure_preserves_original_os_code_before_cleanup() {
        let cleanup_called = Cell::new(false);
        let mut file_token = 0u8;
        let mut mapping_token = 0u8;
        let file: HANDLE = std::ptr::from_mut(&mut file_token).cast();
        let mapping: HANDLE = std::ptr::from_mut(&mut mapping_token).cast();

        let result = create_bounded_mapping_v1(
            file,
            MappingGeometryV1::synthetic_v1(),
            |_, _, _| mapping,
            |_, _| {
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
