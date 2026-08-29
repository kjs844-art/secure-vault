#![cfg(windows)]

mod support;

use std::{fs, io};

use support::FramedChildV1;
use tempfile::tempdir;
use vault_local_sqlite_vfs_windows::probe_protocol::{
    EXIT_V1, MUTATE_V1, MUTATED_V1, READY_V1, SYNTHETIC_MAPPING_INITIAL_V1,
    SYNTHETIC_MAPPING_MUTATED_V1, SYNTHETIC_MAPPING_MUTATION_OFFSET_V1,
};
use vault_local_sqlite_vfs_windows::{VfsProbeErrorCodeV1, acquire_main_read_guard_v1};

const INITIAL_LAST_BYTE: u8 = b'A';
const MUTATED_LAST_BYTE: u8 = b'B';

fn initial_io_marker_v1(operation: &str, error: &io::Error) -> String {
    format!(
        "INCONCLUSIVE_MAPPING_GATE:{operation}:os={:?}",
        error.raw_os_error()
    )
}

#[test]
fn synthetic_mapping_values_change_only_the_last_byte_from_a_to_b() {
    assert_eq!(
        SYNTHETIC_MAPPING_INITIAL_V1.len(),
        SYNTHETIC_MAPPING_MUTATED_V1.len()
    );
    assert_eq!(
        &SYNTHETIC_MAPPING_INITIAL_V1[..SYNTHETIC_MAPPING_MUTATION_OFFSET_V1],
        &SYNTHETIC_MAPPING_MUTATED_V1[..SYNTHETIC_MAPPING_MUTATION_OFFSET_V1]
    );
    assert_eq!(
        SYNTHETIC_MAPPING_INITIAL_V1[SYNTHETIC_MAPPING_MUTATION_OFFSET_V1],
        INITIAL_LAST_BYTE
    );
    assert_eq!(
        SYNTHETIC_MAPPING_MUTATED_V1[SYNTHETIC_MAPPING_MUTATION_OFFSET_V1],
        MUTATED_LAST_BYTE
    );
}

#[test]
fn initial_io_markers_keep_operation_and_raw_os_code() {
    let error = io::Error::from_raw_os_error(5);
    assert_eq!(
        initial_io_marker_v1("tempdir", &error),
        "INCONCLUSIVE_MAPPING_GATE:tempdir:os=Some(5)"
    );
    assert_eq!(
        initial_io_marker_v1("fixture_write", &error),
        "INCONCLUSIVE_MAPPING_GATE:fixture_write:os=Some(5)"
    );
}

fn control_read_and_drop(path: &std::path::Path, phase: &str) -> u8 {
    let guard = acquire_main_read_guard_v1(path).unwrap_or_else(|error| {
        panic!(
            "INCONCLUSIVE_MAPPING_GATE:{phase}_control_open:code={:?}:os={:?}",
            error.code(),
            error.os_code()
        )
    });
    guard
        .read_byte_at_v1(SYNTHETIC_MAPPING_MUTATION_OFFSET_V1 as u64)
        .unwrap_or_else(|error| {
            panic!(
                "INCONCLUSIVE_MAPPING_GATE:{phase}_control_read:code={:?}:os={:?}",
                error.code(),
                error.os_code()
            )
        })
}

#[test]
#[ignore = "explicit security feasibility gate; run before store integration"]
fn preexisting_writable_mapping_must_block_guard_acquisition() {
    let directory =
        tempdir().unwrap_or_else(|error| panic!("{}", initial_io_marker_v1("tempdir", &error)));
    let path = directory.path().join("synthetic-mapping-probe.bin");
    fs::write(&path, SYNTHETIC_MAPPING_INITIAL_V1)
        .unwrap_or_else(|error| panic!("{}", initial_io_marker_v1("fixture_write", &error)));

    let pre_child = control_read_and_drop(&path, "pre_child");
    assert_eq!(
        pre_child, INITIAL_LAST_BYTE,
        "INCONCLUSIVE_MAPPING_GATE:pre_child_control_byte"
    );

    let mut child = FramedChildV1::spawn(&path);
    child.expect(READY_V1);

    match acquire_main_read_guard_v1(&path) {
        Err(error) if error.code() == VfsProbeErrorCodeV1::SharingViolation => {
            assert_eq!(
                error.os_code(),
                Some(32),
                "INCONCLUSIVE_MAPPING_GATE:sharing_code_mismatch"
            );
            child.send(EXIT_V1);
            child.finish_success();
            let post_child = control_read_and_drop(&path, "post_child");
            assert_eq!(
                post_child, INITIAL_LAST_BYTE,
                "INCONCLUSIVE_MAPPING_GATE:post_child_control_byte"
            );
        }
        Err(error) => {
            child.send(EXIT_V1);
            child.finish_success();
            panic!(
                "INCONCLUSIVE_MAPPING_GATE:hostile_acquire:code={:?}:os={:?}",
                error.code(),
                error.os_code()
            );
        }
        Ok(guard) => {
            child.send(MUTATE_V1);
            child.expect(MUTATED_V1);
            let observed = guard
                .read_byte_at_v1(SYNTHETIC_MAPPING_MUTATION_OFFSET_V1 as u64)
                .unwrap_or_else(|error| {
                    panic!(
                        "INCONCLUSIVE_MAPPING_GATE:guarded_read:code={:?}:os={:?}",
                        error.code(),
                        error.os_code()
                    )
                });
            child.send(EXIT_V1);
            child.finish_success();
            match observed {
                MUTATED_LAST_BYTE => {
                    panic!("NO_GO_PREEXISTING_WRITABLE_MAPPING_ACCEPTED_AND_MUTATED")
                }
                _ => panic!("NO_GO_PREEXISTING_WRITABLE_MAPPING_ACCEPTED"),
            }
        }
    }
}
