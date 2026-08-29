use std::fs::File;
use std::path::Path;

use crate::{VfsProbeErrorCodeV1, VfsProbeErrorV1};

pub struct BoundReadGuardV1 {
    _file: File,
}

pub fn acquire_main_read_guard_v1(_path: &Path) -> Result<BoundReadGuardV1, VfsProbeErrorV1> {
    Err(VfsProbeErrorV1::new(
        VfsProbeErrorCodeV1::UnsupportedPlatform,
        None,
    ))
}
