//! Windows-only feasibility boundary for the KeyAtlas SQLite VFS design.
//!
//! This crate accepts synthetic probe data only and is not connected to the vault store.

#![deny(unsafe_op_in_unsafe_fn)]

mod error;
#[cfg(windows)]
mod file_guard;
#[cfg(feature = "feasibility-probe")]
pub mod probe_protocol;
#[cfg(all(windows, feature = "feasibility-probe"))]
mod windows_mapping_probe;

pub use error::{VfsProbeErrorCodeV1, VfsProbeErrorV1};
#[cfg(windows)]
pub use file_guard::{BoundReadGuardV1, acquire_main_read_guard_v1};
#[cfg(all(windows, feature = "feasibility-probe"))]
pub use windows_mapping_probe::WritableMappedViewV1;

pub const PINNED_SQLITE_VERSION_V1: &str = "3.53.2";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlatformDispositionV1 {
    WindowsProbeAvailable,
    UnsupportedPlatform,
}

pub const fn platform_disposition_v1() -> PlatformDispositionV1 {
    if cfg!(windows) {
        PlatformDispositionV1::WindowsProbeAvailable
    } else {
        PlatformDispositionV1::UnsupportedPlatform
    }
}
