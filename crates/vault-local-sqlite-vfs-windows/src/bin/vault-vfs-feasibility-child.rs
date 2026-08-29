#[cfg(not(windows))]
fn main() {
    std::process::exit(64);
}

#[cfg(windows)]
fn main() {
    if let Err(error) = run() {
        eprintln!(
            "INCONCLUSIVE_MAPPING_GATE:child_run:code={:?}:os={:?}",
            error.code(),
            error.os_code()
        );
        std::process::exit(70);
    }
}

#[cfg(windows)]
fn run() -> Result<(), vault_local_sqlite_vfs_windows::VfsProbeErrorV1> {
    use std::io::{BufReader, stdin, stdout};
    use std::path::PathBuf;

    use vault_local_sqlite_vfs_windows::WritableMappedViewV1;
    use vault_local_sqlite_vfs_windows::probe_protocol::{
        EXIT_V1, MUTATE_V1, MUTATED_V1, READY_V1, SYNTHETIC_MAPPING_MUTATED_V1,
        SYNTHETIC_MAPPING_MUTATION_OFFSET_V1, read_frame_v1, write_frame_v1,
    };

    let mut arguments = std::env::args_os();
    let _program = arguments.next();
    let path = arguments
        .next()
        .map(PathBuf::from)
        .ok_or_else(vault_local_sqlite_vfs_windows::VfsProbeErrorV1::protocol)?;
    if arguments.next().is_some() {
        return Err(vault_local_sqlite_vfs_windows::VfsProbeErrorV1::protocol());
    }

    let mut mapping = WritableMappedViewV1::open_v1(&path)?;
    let mut input = BufReader::new(stdin().lock());
    let mut output = stdout().lock();
    write_frame_v1(&mut output, READY_V1)?;

    match read_frame_v1(&mut input)?.as_str() {
        EXIT_V1 => return Ok(()),
        MUTATE_V1 => {}
        _ => return Err(vault_local_sqlite_vfs_windows::VfsProbeErrorV1::protocol()),
    }
    mapping.write_last_byte_and_flush_v1(
        SYNTHETIC_MAPPING_MUTATED_V1[SYNTHETIC_MAPPING_MUTATION_OFFSET_V1],
    )?;
    write_frame_v1(&mut output, MUTATED_V1)?;
    if read_frame_v1(&mut input)? != EXIT_V1 {
        return Err(vault_local_sqlite_vfs_windows::VfsProbeErrorV1::protocol());
    }
    Ok(())
}
