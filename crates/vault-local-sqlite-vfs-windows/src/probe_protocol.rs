use std::io::{BufRead, Write};

use crate::VfsProbeErrorV1;

pub const READY_V1: &str = "V1 READY";
pub const MUTATE_V1: &str = "V1 MUTATE";
pub const MUTATED_V1: &str = "V1 MUTATED";
pub const EXIT_V1: &str = "V1 EXIT";
pub const SYNTHETIC_MAPPING_INITIAL_V1: &[u8] = b"DEMO_VALUE_ONLY_MAPPING_A";
pub const SYNTHETIC_MAPPING_MUTATED_V1: &[u8] = b"DEMO_VALUE_ONLY_MAPPING_B";
pub const SYNTHETIC_MAPPING_MUTATION_OFFSET_V1: usize = SYNTHETIC_MAPPING_INITIAL_V1.len() - 1;

pub fn write_frame_v1(writer: &mut impl Write, frame: &str) -> Result<(), VfsProbeErrorV1> {
    if !matches!(frame, READY_V1 | MUTATE_V1 | MUTATED_V1 | EXIT_V1) {
        return Err(VfsProbeErrorV1::protocol());
    }
    writer
        .write_all(frame.as_bytes())
        .and_then(|()| writer.write_all(b"\n"))
        .and_then(|()| writer.flush())
        .map_err(|error| VfsProbeErrorV1::from_io(&error))
}

pub fn read_frame_v1(reader: &mut impl BufRead) -> Result<String, VfsProbeErrorV1> {
    let mut bytes = [0u8; 32];
    let mut length = 0usize;
    loop {
        let mut byte = [0u8; 1];
        reader
            .read_exact(&mut byte)
            .map_err(|error| VfsProbeErrorV1::from_io(&error))?;
        if byte[0] == b'\n' {
            break;
        }
        if length == bytes.len() {
            return Err(VfsProbeErrorV1::protocol());
        }
        bytes[length] = byte[0];
        length += 1;
    }
    if length > 0 && bytes[length - 1] == b'\r' {
        length -= 1;
    }
    let frame = std::str::from_utf8(&bytes[..length]).map_err(|_| VfsProbeErrorV1::protocol())?;
    if !matches!(frame, READY_V1 | MUTATE_V1 | MUTATED_V1 | EXIT_V1) {
        return Err(VfsProbeErrorV1::protocol());
    }
    Ok(frame.to_owned())
}
