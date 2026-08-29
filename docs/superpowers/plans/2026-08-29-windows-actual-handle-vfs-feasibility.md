# Windows Actual-Handle VFS Phase 0A Pre-existing-Mapping Primitive Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the pinned Windows host, determine whether KeyAtlas can reject a pre-existing writable main/WAL mapping whose creator file handle has already been closed, record a reproducible Phase 0A Go/No-Go result, and prevent all SQLite-store integration when that primitive cannot be proven.

**Architecture:** Add an isolated `vault-local-sqlite-vfs-windows` feasibility crate without connecting it to `vault-local-store-sqlite`. A synthetic child process creates a writable file mapping, closes its original file handle, and synchronizes with the parent through fixed stdin/stdout frames; the parent performs successful pre-child and post-child control acquisitions around the hostile acquisition attempt. The explicit gate either proves this one primitive and authorizes a separate full-VFS feasibility plan, or records No-Go and keeps the real-Secret/store-integration gates closed.

**Tech Stack:** Rust 1.95.0 (`x86_64-pc-windows-msvc`), edition 2024, `windows-sys` 0.61.2, `rusqlite` 0.40.2 with bundled SQLite 3.53.2, `tempfile` 3.27.0, Win32 file mapping APIs, Cargo, rustfmt, Clippy, PowerShell.

**Spec:** `docs/superpowers/specs/2026-08-29-windows-actual-handle-sqlite-vfs-design.md`

## Global Constraints

- This plan is Phase 0A, a precursor to the mandatory multi-proof Phase 0 gate in the approved spec. It does not complete that full gate, register a SQLite VFS, add Backup API support, modify `vault-local-store-sqlite`, or open real-Secret support.
- Only synthetic bytes `DEMO_VALUE_ONLY_MAPPING_A` and `DEMO_VALUE_ONLY_MAPPING_B` may be written. No real password, API key, Secret, recovery key, `.env`, vault DB, WAL, or SHM may be used.
- The test target is Windows NT build `10.0.26200.0`, Rust `1.95.0 (59807616e 2026-04-14)`, host `x86_64-pc-windows-msvc`, `rusqlite` `0.40.2`, `libsqlite3-sys` `0.38.2`, and bundled SQLite `3.53.2`.
- `vault-local-store-sqlite` retains `#![forbid(unsafe_code)]`. Every new unsafe Win32 call lives in the isolated VFS crate or its feasibility-only child/test harness.
- The child closes the original `std::fs::File` after `CreateFileMappingW` and `MapViewOfFile`; only the writable mapping object and mapped view remain when the parent attempts acquisition.
- Synchronization uses fixed pipe frames. Timing sleeps, probabilistic races, retry-until-pass loops, and filesystem polling are forbidden. A 20-second timeout is only a hang guard.
- A non-Windows host, Windows Application Control error `4551`, unexpected OS error, protocol mismatch, missing executable, or skipped explicit gate is `Inconclusive` or `UnsupportedPlatform`, never Go.
- Go for this plan requires successful before/after control acquisitions plus rejection of the acquisition only while the mapping exists. It means only that the pre-existing-mapping primitive was rejected on the pinned host. It is not completion of the full Phase 0 gate or approval of VFS callbacks, WAL/SHM behavior, snapshot authentication, store integration, production readiness, or real Secret input.
- No-Go occurs if the parent acquires the proposed read guard while the child retains the writable mapped view, whether or not the parent's immediate read observes the changed byte. The design requires acquisition itself to reject that mapping.
- External on-disk `-shm` is outside this primitive: product feasibility must ignore it and prove that it cannot influence private SHM. This plan tests main/WAL-style mapped files only.
- The new crate is never added to `vault-local-store-sqlite/Cargo.toml` during this plan.
- Stage exact files only; never use `git add .`, force push, main merge, or push.

Official primary references:

- [CreateFile sharing modes](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
- [CreateFileMapping lifecycle](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createfilemappingw)
- [Byte-range locks and mapped files](https://learn.microsoft.com/en-us/windows/win32/fileio/locking-and-unlocking-byte-ranges-in-files)
- [Writable-section oplock behavior](https://learn.microsoft.com/en-us/windows-hardware/drivers/ifs/fs-filter-acquire-for-section-synchronization2)

Microsoft documents that `CreateFile` sharing flags do not affect memory-mapped files, byte-range locks are ignored by memory-mapped files, and creating a new writable section breaks current oplocks without waiting for acknowledgment. These facts motivate the probe but do not replace it.

---

## Planned File Structure

```text
Cargo.toml
crates/
└── vault-local-sqlite-vfs-windows/
    ├── Cargo.toml
    ├── src/
    │   ├── lib.rs
    │   ├── error.rs
    │   ├── file_guard.rs
    │   ├── probe_protocol.rs
    │   ├── windows_mapping_probe.rs
    │   └── bin/vault-vfs-feasibility-child.rs
    └── tests/
        ├── platform_contract.rs
        ├── actual_handle_feasibility.rs
        └── support/mod.rs
docs/
└── verification/windows-actual-handle-vfs-feasibility.md
```

The gate ends before SQLite VFS callback implementation. A Go result produces a second plan for `xOpen/xRead/xWrite/xFileSize/xTruncate/xLock/xUnlock/xSync/xShm*`, private SHM, crash-WAL, path tracing, and absent-WAL races. A No-Go or Inconclusive result returns to broker/service-boundary design.

## Decision Flow

```text
pre-child control acquisition succeeds and closes
        ↓
child maps synthetic file writable
        ↓
child closes original File handle
        ↓ READY
parent attempts BoundReadGuardV1 acquisition
        ├── ERROR_SHARING_VIOLATION → child exits → post-child control succeeds → primitive GO
        ├── guard acquired          → primitive NO-GO
        └── any other result        → INCONCLUSIVE

Any failed control acquisition or unexpected control byte is Inconclusive, never Go.
```

### Task 1: Scaffold the isolated pinned-platform crate

**Files:**

- Modify: `Cargo.toml`
- Create: `crates/vault-local-sqlite-vfs-windows/Cargo.toml`
- Create: `crates/vault-local-sqlite-vfs-windows/src/lib.rs`
- Create: `crates/vault-local-sqlite-vfs-windows/src/error.rs`
- Create: `crates/vault-local-sqlite-vfs-windows/tests/platform_contract.rs`

**Interfaces:**

- Consumes: workspace dependency pins and `rusqlite::version()`.
- Produces: `PlatformDispositionV1`, `VfsProbeErrorCodeV1`, `VfsProbeErrorV1`, and `PINNED_SQLITE_VERSION_V1`.

- [ ] **Step 1: Run the package RED command**

```powershell
cargo test --locked -p vault-local-sqlite-vfs-windows --test platform_contract -- --test-threads=1
```

Expected: Cargo reports that package `vault-local-sqlite-vfs-windows` does not exist.

- [ ] **Step 2: Add the workspace member**

Add exactly one member to root `Cargo.toml`:

```toml
[workspace]
members = [
    "crates/vault-crypto",
    "crates/vault-local-core",
    "crates/vault-local-platform-windows",
    "crates/vault-local-sqlite-vfs-windows",
    "crates/vault-local-store-sqlite",
]
resolver = "3"
```

- [ ] **Step 3: Create the exact crate manifest**

Create `crates/vault-local-sqlite-vfs-windows/Cargo.toml`:

```toml
[package]
name = "vault-local-sqlite-vfs-windows"
version = "0.0.1-alpha.1"
edition.workspace = true
rust-version.workspace = true
license.workspace = true
publish = false

[features]
default = []
feasibility-probe = []

[dependencies]
rusqlite.workspace = true
thiserror.workspace = true

[target.'cfg(windows)'.dependencies]
windows-sys = { workspace = true, features = [
    "Win32_Foundation",
    "Win32_Security",
    "Win32_Storage_FileSystem",
    "Win32_System_Memory",
    "Win32_System_Threading",
] }

[dev-dependencies]
tempfile.workspace = true

[[bin]]
name = "vault-vfs-feasibility-child"
path = "src/bin/vault-vfs-feasibility-child.rs"
required-features = ["feasibility-probe"]
```

- [ ] **Step 4: Add the stable non-sensitive error type**

Create `src/error.rs`:

```rust
use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VfsProbeErrorCodeV1 {
    SharingViolation,
    Io,
    Protocol,
    UnsupportedPlatform,
}

pub struct VfsProbeErrorV1 {
    code: VfsProbeErrorCodeV1,
    os_code: Option<i32>,
}

impl VfsProbeErrorV1 {
    pub const fn code(&self) -> VfsProbeErrorCodeV1 {
        self.code
    }

    pub const fn os_code(&self) -> Option<i32> {
        self.os_code
    }

    pub(crate) const fn new(code: VfsProbeErrorCodeV1, os_code: Option<i32>) -> Self {
        Self { code, os_code }
    }

    pub(crate) fn from_io(error: &std::io::Error) -> Self {
        const ERROR_SHARING_VIOLATION: i32 = 32;
        let os_code = error.raw_os_error();
        let code = if os_code == Some(ERROR_SHARING_VIOLATION) {
            VfsProbeErrorCodeV1::SharingViolation
        } else {
            VfsProbeErrorCodeV1::Io
        };
        Self::new(code, os_code)
    }

    pub const fn protocol() -> Self {
        Self::new(VfsProbeErrorCodeV1::Protocol, None)
    }
}

impl fmt::Display for VfsProbeErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self.code {
            VfsProbeErrorCodeV1::SharingViolation => "file sharing policy rejected access",
            VfsProbeErrorCodeV1::Io => "feasibility input/output failure",
            VfsProbeErrorCodeV1::Protocol => "feasibility protocol failure",
            VfsProbeErrorCodeV1::UnsupportedPlatform => "feasibility platform unsupported",
        })
    }
}

impl fmt::Debug for VfsProbeErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VfsProbeErrorV1")
            .field("code", &self.code)
            .field("os_code", &self.os_code)
            .finish()
    }
}

impl std::error::Error for VfsProbeErrorV1 {}
```

- [ ] **Step 5: Add the crate root and initial compile-only shells**

Create `src/lib.rs`:

```rust
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
```

Create `src/file_guard.rs`:

```rust
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
```

Create `src/probe_protocol.rs`:

```rust
pub const READY_V1: &str = "V1 READY";
```

Create `src/windows_mapping_probe.rs`:

```rust
pub struct WritableMappedViewV1;
```

Create `src/bin/vault-vfs-feasibility-child.rs`:

```rust
fn main() {
    std::process::exit(64);
}
```

- [ ] **Step 6: Add the platform contract test**

Create `tests/platform_contract.rs`:

```rust
use vault_local_sqlite_vfs_windows::{
    PINNED_SQLITE_VERSION_V1, PlatformDispositionV1, platform_disposition_v1,
};

#[test]
fn crate_records_manifest_msrv_and_sqlite_contract() {
    assert_eq!(env!("CARGO_PKG_RUST_VERSION"), "1.95");
    assert_eq!(rusqlite::version(), PINNED_SQLITE_VERSION_V1);
}

#[test]
fn platform_disposition_is_explicit() {
    let expected = if cfg!(windows) {
        PlatformDispositionV1::WindowsProbeAvailable
    } else {
        PlatformDispositionV1::UnsupportedPlatform
    };
    assert_eq!(platform_disposition_v1(), expected);
}
```

- [ ] **Step 7: Refresh the lockfile once, offline, and inspect it**

The new workspace package needs its own `Cargo.lock` stanza. Perform exactly one unlocked but offline resolution:

```powershell
cargo check --offline -p vault-local-sqlite-vfs-windows --all-targets --features feasibility-probe
$lockRefreshExit = $LASTEXITCODE
"LOCK_REFRESH_EXIT=$lockRefreshExit"
if ($lockRefreshExit -ne 0) {
    throw "INCONCLUSIVE_PHASE_0A_LOCK_REFRESH_FAILURE:exit=$lockRefreshExit"
}
git diff -- Cargo.lock
```

Accept the lockfile diff only if it adds the local `vault-local-sqlite-vfs-windows 0.0.1-alpha.1` package with dependencies `rusqlite`, `tempfile`, `thiserror`, and `windows-sys`, without changing registry package versions or checksums. Reject and investigate any other lockfile change. All later Cargo commands return to `--locked`.

- [ ] **Step 8: Enforce the pinned host precondition, then run focused GREEN verification**

```powershell
$expectedRust = 'rustc 1.95.0 (59807616e 2026-04-14)'
$actualRust = (rustc --version).Trim()
$actualHost = ((rustc --version --verbose | Select-String '^host:').Line -replace '^host:\s*', '').Trim()
$actualOs = [System.Environment]::OSVersion.Version.ToString()
if ($actualRust -ne $expectedRust -or $actualHost -ne 'x86_64-pc-windows-msvc' -or $actualOs -ne '10.0.26200.0') {
    throw "INCONCLUSIVE_PINNED_PLATFORM_MISMATCH:rust=$actualRust;host=$actualHost;os=$actualOs"
}
cargo test --locked -p vault-local-sqlite-vfs-windows --test platform_contract -- --test-threads=1
cargo check --locked -p vault-local-sqlite-vfs-windows --all-targets --features feasibility-probe
cargo tree -p vault-local-sqlite-vfs-windows -i libsqlite3-sys
```

Expected: the exact environment comparison succeeds, two tests pass, all targets compile with the refreshed lockfile, and the dependency tree contains only `libsqlite3-sys 0.38.2`. `WindowsProbeAvailable` deliberately does not claim that every Windows build is the pinned host.

- [ ] **Step 9: Commit Task 1 with exact staging**

```powershell
git add -- Cargo.toml Cargo.lock crates/vault-local-sqlite-vfs-windows/Cargo.toml crates/vault-local-sqlite-vfs-windows/src/lib.rs crates/vault-local-sqlite-vfs-windows/src/error.rs crates/vault-local-sqlite-vfs-windows/src/file_guard.rs crates/vault-local-sqlite-vfs-windows/src/probe_protocol.rs crates/vault-local-sqlite-vfs-windows/src/windows_mapping_probe.rs crates/vault-local-sqlite-vfs-windows/src/bin/vault-vfs-feasibility-child.rs crates/vault-local-sqlite-vfs-windows/tests/platform_contract.rs
git diff --cached --check
git commit -m "test: scaffold Windows VFS feasibility gate"
```

### Task 2: Implement the deterministic pre-existing writable-mapping gate

**Files:**

- Replace: `crates/vault-local-sqlite-vfs-windows/src/file_guard.rs`
- Replace: `crates/vault-local-sqlite-vfs-windows/src/probe_protocol.rs`
- Replace: `crates/vault-local-sqlite-vfs-windows/src/windows_mapping_probe.rs`
- Replace: `crates/vault-local-sqlite-vfs-windows/src/bin/vault-vfs-feasibility-child.rs`
- Create: `crates/vault-local-sqlite-vfs-windows/tests/support/mod.rs`
- Create: `crates/vault-local-sqlite-vfs-windows/tests/actual_handle_feasibility.rs`

**Interfaces:**

- Consumes: `VfsProbeErrorV1`, Win32 mapping APIs, `OpenOptionsExt::share_mode`, and the fixed pipe frames.
- Produces: `acquire_main_read_guard_v1(&Path) -> Result<BoundReadGuardV1, VfsProbeErrorV1>`, `BoundReadGuardV1::read_byte_at_v1`, and the explicit ignored security test.

- [ ] **Step 1: Write the explicit security assertion**

Create `tests/actual_handle_feasibility.rs`:

```rust
#![cfg(windows)]

mod support;

use std::fs;

use support::FramedChildV1;
use tempfile::tempdir;
use vault_local_sqlite_vfs_windows::probe_protocol::{
    EXIT_V1, MUTATE_V1, MUTATED_V1, READY_V1, SYNTHETIC_MAPPING_INITIAL_V1,
    SYNTHETIC_MAPPING_MUTATED_V1, SYNTHETIC_MAPPING_MUTATION_OFFSET_V1,
};
use vault_local_sqlite_vfs_windows::{
    VfsProbeErrorCodeV1, acquire_main_read_guard_v1,
};

const INITIAL_LAST_BYTE: u8 = b'A';
const MUTATED_LAST_BYTE: u8 = b'B';

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
    let directory = tempdir().expect("synthetic temp directory");
    let path = directory.path().join("synthetic-mapping-probe.bin");
    fs::write(&path, SYNTHETIC_MAPPING_INITIAL_V1).expect("synthetic probe file");

    let pre_child = control_read_and_drop(&path, "pre_child");
    assert_eq!(
        pre_child,
        INITIAL_LAST_BYTE,
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
                post_child,
                INITIAL_LAST_BYTE,
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
```

- [ ] **Step 2: Run a compile-only RED check before replacing the shells**

```powershell
cargo check --locked -p vault-local-sqlite-vfs-windows --features feasibility-probe --test actual_handle_feasibility
```

Expected: compile failure because the child harness, complete protocol, and `read_byte_at_v1` do not exist.

- [ ] **Step 3: Replace the file guard shell**

Replace `src/file_guard.rs`:

```rust
use std::fs::{File, OpenOptions};
use std::os::windows::fs::{FileExt, OpenOptionsExt};
use std::path::Path;

use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
};

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
```

- [ ] **Step 4: Replace the protocol shell with bounded frames**

Replace `src/probe_protocol.rs`:

```rust
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
    let frame = std::str::from_utf8(&bytes[..length])
        .map_err(|_| VfsProbeErrorV1::protocol())?;
    if !matches!(frame, READY_V1 | MUTATE_V1 | MUTATED_V1 | EXIT_V1) {
        return Err(VfsProbeErrorV1::protocol());
    }
    Ok(frame.to_owned())
}
```

- [ ] **Step 5: Replace the mapping shell with one safe lifetime owner**

Replace `src/windows_mapping_probe.rs`:

```rust
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
    CreateFileMappingW, FILE_MAP_WRITE, FlushViewOfFile, MEMORY_MAPPED_VIEW_ADDRESS,
    MapViewOfFile, PAGE_READWRITE, UnmapViewOfFile,
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
            CreateFileMappingW(
                file.as_raw_handle(),
                null(),
                PAGE_READWRITE,
                0,
                0,
                null(),
            )
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
        Ok(Self {
            mapping,
            view,
            mapped_length,
        })
    }

    pub fn write_last_byte_and_flush_v1(
        &mut self,
        value: u8,
    ) -> Result<(), VfsProbeErrorV1> {
        let last_byte = unsafe {
            self.view.Value.cast::<u8>().add(self.mapped_length - 1)
        };
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

impl Drop for WritableMappedViewV1 {
    fn drop(&mut self) {
        unsafe {
            UnmapViewOfFile(self.view);
            CloseHandle(self.mapping);
        }
    }
}
```

- [ ] **Step 6: Replace the child shell with the fixed state machine**

Replace `src/bin/vault-vfs-feasibility-child.rs`:

```rust
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

    use vault_local_sqlite_vfs_windows::probe_protocol::{
        EXIT_V1, MUTATE_V1, MUTATED_V1, READY_V1, SYNTHETIC_MAPPING_MUTATED_V1,
        SYNTHETIC_MAPPING_MUTATION_OFFSET_V1, read_frame_v1, write_frame_v1,
    };
    use vault_local_sqlite_vfs_windows::WritableMappedViewV1;

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
```

- [ ] **Step 7: Add the child harness with a real process timeout**

Create `tests/support/mod.rs`:

```rust
#![cfg(windows)]

use std::io::{BufReader, Write};
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};

use vault_local_sqlite_vfs_windows::probe_protocol::{
    read_frame_v1, write_frame_v1,
};
use vault_local_sqlite_vfs_windows::VfsProbeErrorV1;
use windows_sys::Win32::Foundation::{
    GetLastError, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Threading::WaitForSingleObject;

const CHILD_TIMEOUT_MS: u32 = 20_000;

pub struct FramedChildV1 {
    child: Option<Child>,
    stdin: ChildStdin,
    frames: std::sync::mpsc::Receiver<Result<String, VfsProbeErrorV1>>,
}

impl FramedChildV1 {
    pub fn spawn(path: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_vault-vfs-feasibility-child"))
            .arg(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap_or_else(|error| {
                panic!(
                    "INCONCLUSIVE_MAPPING_GATE:child_spawn:os={:?}",
                    error.raw_os_error()
                )
            });
        let stdin = child
            .stdin
            .take()
            .unwrap_or_else(|| panic!("INCONCLUSIVE_MAPPING_GATE:missing_child_stdin"));
        let stdout = child
            .stdout
            .take()
            .unwrap_or_else(|| panic!("INCONCLUSIVE_MAPPING_GATE:missing_child_stdout"));
        let (sender, frames) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let frame = read_frame_v1(&mut reader);
                let terminal = frame.is_err();
                if sender.send(frame).is_err() {
                    break;
                }
                if terminal {
                    break;
                }
            }
        });
        Self {
            child: Some(child),
            stdin,
            frames,
        }
    }

    pub fn send(&mut self, frame: &str) {
        write_frame_v1(&mut self.stdin, frame).unwrap_or_else(|error| {
            panic!(
                "INCONCLUSIVE_MAPPING_GATE:child_send:code={:?}:os={:?}",
                error.code(),
                error.os_code()
            )
        });
    }

    pub fn expect(&self, expected: &str) {
        let received = self
            .frames
            .recv_timeout(std::time::Duration::from_millis(u64::from(CHILD_TIMEOUT_MS)))
            .unwrap_or_else(|error| {
                panic!("INCONCLUSIVE_MAPPING_GATE:child_frame_wait:{error:?}")
            });
        let observed = received.unwrap_or_else(|error| {
            panic!(
                "INCONCLUSIVE_MAPPING_GATE:child_frame_read:code={:?}:os={:?}",
                error.code(),
                error.os_code()
            )
        });
        assert_eq!(
            observed,
            expected,
            "INCONCLUSIVE_MAPPING_GATE:child_frame_mismatch"
        );
    }

    pub fn finish_success(mut self) {
        self.stdin.flush().unwrap_or_else(|error| {
            panic!(
                "INCONCLUSIVE_MAPPING_GATE:child_flush:os={:?}",
                error.raw_os_error()
            )
        });
        let child = self
            .child
            .as_mut()
            .unwrap_or_else(|| panic!("INCONCLUSIVE_MAPPING_GATE:missing_live_child"));
        let wait = unsafe {
            WaitForSingleObject(child.as_raw_handle(), CHILD_TIMEOUT_MS)
        };
        match wait {
            WAIT_OBJECT_0 => {}
            WAIT_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("INCONCLUSIVE_MAPPING_GATE:child_timeout");
            }
            WAIT_FAILED => {
                let os_code = unsafe { GetLastError() };
                let _ = child.kill();
                let _ = child.wait();
                panic!("INCONCLUSIVE_MAPPING_GATE:child_wait_failed:os={os_code}");
            }
            other => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("INCONCLUSIVE_MAPPING_GATE:child_wait_unexpected:wait={other}");
            }
        }
        let status = child.wait().unwrap_or_else(|error| {
            panic!(
                "INCONCLUSIVE_MAPPING_GATE:child_wait_collect:os={:?}",
                error.raw_os_error()
            )
        });
        assert!(
            status.success(),
            "INCONCLUSIVE_MAPPING_GATE:child_exit:code={:?}",
            status.code()
        );
        self.child = None;
    }
}

impl Drop for FramedChildV1 {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
```

- [ ] **Step 8: Format and run one completed decision execution for this candidate revision**

```powershell
cargo fmt --all
$formatWriteExit = $LASTEXITCODE
if ($formatWriteExit -ne 0) {
    throw "INCONCLUSIVE_PHASE_0A_FORMAT_FAILURE:exit=$formatWriteExit"
}
cargo test --locked -p vault-local-sqlite-vfs-windows --features feasibility-probe --test actual_handle_feasibility preexisting_writable_mapping_must_block_guard_acquisition -- --ignored --exact --test-threads=1 --nocapture
$gateExit = $LASTEXITCODE
"PHASE_0A_GATE_EXIT=$gateExit"
```

Interpret only these outcomes:

- `PASS`: the pre-child control succeeded, acquisition returned `ERROR_SHARING_VIOLATION (32)` only while the mapping existed, and the post-child control succeeded with the unchanged synthetic byte. Mark this primitive Go.
- `FAIL` containing `NO_GO_PREEXISTING_WRITABLE_MAPPING_ACCEPTED`: mark No-Go. Do not weaken the threat model or add polling, hashing, byte locks, retries, or a pathname fallback.
- Any compile error, timeout, child exit, error `4551`, or different OS error: mark Inconclusive.

This is the only completed verdict execution for the candidate revision. The earlier RED command was compile-only. If later fixes change gate behavior, invalidate this observation, create a new reviewed candidate revision, and record one new completed execution rather than silently reusing the old result.

- [ ] **Step 9: Run non-gate hygiene checks**

```powershell
cargo fmt --all -- --check
$formatExit = $LASTEXITCODE
cargo clippy --locked -p vault-local-sqlite-vfs-windows --all-targets --features feasibility-probe -- -D warnings
$clippyExit = $LASTEXITCODE
cargo test --locked -p vault-local-sqlite-vfs-windows --features feasibility-probe -- --test-threads=1
$ordinaryTestExit = $LASTEXITCODE
git diff --check
$diffCheckExit = $LASTEXITCODE
"FORMAT_EXIT=$formatExit"
"CLIPPY_EXIT=$clippyExit"
"ORDINARY_TEST_EXIT=$ordinaryTestExit"
"DIFF_CHECK_EXIT=$diffCheckExit"
if ($formatExit -ne 0 -or $clippyExit -ne 0 -or $ordinaryTestExit -ne 0 -or $diffCheckExit -ne 0) {
    throw "INCONCLUSIVE_PHASE_0A_HYGIENE_FAILURE"
}
```

Expected: formatting, Clippy, and non-ignored tests pass. The ordinary test output must show the security gate as ignored, not passed.

If formatting, Clippy, an ordinary test, or `git diff --check` fails, do not write or commit a Go verdict. Fix and review the failure first. If it cannot be fixed without changing gate behavior, classify the checkpoint Inconclusive and require a new candidate revision and completed gate execution.

- [ ] **Step 10: Commit the reproducible gate without claiming Go**

```powershell
git add -- crates/vault-local-sqlite-vfs-windows/src/error.rs crates/vault-local-sqlite-vfs-windows/src/file_guard.rs crates/vault-local-sqlite-vfs-windows/src/probe_protocol.rs crates/vault-local-sqlite-vfs-windows/src/windows_mapping_probe.rs crates/vault-local-sqlite-vfs-windows/src/bin/vault-vfs-feasibility-child.rs crates/vault-local-sqlite-vfs-windows/tests/support/mod.rs crates/vault-local-sqlite-vfs-windows/tests/actual_handle_feasibility.rs
git diff --cached --check
git commit -m "test: probe preexisting Windows writable mappings"
```

### Task 3: Record the authoritative verdict and update the user-facing trail

**Files:**

- Create: `docs/verification/windows-actual-handle-vfs-feasibility.md`
- Modify: `docs/PRODUCT_BUILD_AND_DEPLOY_GUIDE.md`
- Modify outside Git repo: `C:\Users\USER\Desktop\KeyAtlas_보안_설계_패키지_2026-08-29\06_RED_TEAM_중심_작업기록.md`
- Modify outside Git repo: `C:\Users\USER\Desktop\KeyAtlas_보안_설계_패키지_2026-08-29\09_구현_파일구조와_변경기록.md`

**Interfaces:**

- Consumes: the one completed gate execution for the final reviewed candidate revision and the exact hygiene-command results.
- Produces: one non-ambiguous `Go`, `No-Go`, or `Inconclusive` record, plus an ADHD-friendly map from files to behavior and RED implications.

- [ ] **Step 1: Capture the exact environment and Git evidence**

Run:

```powershell
$expectedRust = 'rustc 1.95.0 (59807616e 2026-04-14)'
$actualRust = (rustc --version).Trim()
$actualHost = ((rustc --version --verbose | Select-String '^host:').Line -replace '^host:\s*', '').Trim()
$actualOs = [System.Environment]::OSVersion.Version.ToString()
$actualRust
$actualHost
$actualOs
cargo --version
if ($actualRust -ne $expectedRust -or $actualHost -ne 'x86_64-pc-windows-msvc' -or $actualOs -ne '10.0.26200.0') {
    throw "INCONCLUSIVE_PINNED_PLATFORM_MISMATCH:rust=$actualRust;host=$actualHost;os=$actualOs"
}
git branch --show-current
git rev-parse HEAD
git rev-parse refs/remotes/origin/codex/firstvibe-sqlite-store
git status --short --branch
cargo tree -p vault-local-sqlite-vfs-windows -i libsqlite3-sys
```

Do not fetch, pull, or push. The remote-tracking SHA is local Git evidence only.
Do not copy the pinned values into the verdict record unless the comparison above succeeds. If it fails, record the actual non-sensitive values and classify the checkpoint Inconclusive.

- [ ] **Step 2: Create the verification record**

Create `docs/verification/windows-actual-handle-vfs-feasibility.md` with this common body:

```markdown
# Windows Actual-Handle VFS Phase 0A Pre-existing-Mapping Primitive Verdict

Date: 2026-08-29 KST

## Scope

This record covers one primitive only: whether the pinned Windows host accepts the same synthetic path before and after the hostile interval but rejects a parent no-write/no-delete-share read acquisition while another process retains a pre-existing writable mapped view after closing its creator file handle.

It does not complete the approved spec's multi-proof Phase 0 gate and does not prove a SQLite VFS, WAL/private-SHM correctness, snapshot authentication, store integration, production readiness, or safety for actual passwords/API keys/Secrets.

## Pinned environment

- Windows NT: `10.0.26200.0`
- Rust: `1.95.0 (59807616e 2026-04-14)`
- Host: `x86_64-pc-windows-msvc`
- rusqlite: `0.40.2`
- libsqlite3-sys: `0.38.2`
- bundled SQLite: `3.53.2`
- branch: `codex/firstvibe-sqlite-store`

## Synthetic-only fixture

- Initial bytes: `DEMO_VALUE_ONLY_MAPPING_A`
- Mutated bytes: `DEMO_VALUE_ONLY_MAPPING_B` (last byte changed from `A` to `B`)
- Real password, API key, Secret, recovery key, vault DB, WAL, and SHM were not used.

## Deterministic protocol

1. The parent proves a pre-child control acquisition and read succeed, then drops that guard.
2. The child opens the same synthetic file read/write and creates a writable mapped view.
3. The child closes its original file handle while retaining the mapping object and view.
4. The child emits `V1 READY` through stdout.
5. Only after that frame, the parent attempts `acquire_main_read_guard_v1` with `FILE_SHARE_READ`.
6. After exact sharing rejection, the child exits and the parent proves a post-child control acquisition plus unchanged-byte read succeed.
7. A 20-second watchdog detects a hang; it is not a timing assumption or retry.

## Decision rule

- `Go` only if both controls succeed with the expected synthetic byte and the hostile acquisition alone returns `ERROR_SHARING_VIOLATION (32)`.
- `No-Go` if acquisition succeeds while the writable mapped view exists.
- `Inconclusive` for a failed control, unexpected control byte, build or hygiene failure, timeout, child failure, Application Control error `4551`, unsupported/mismatched platform, protocol error, or any other OS error.

## Command exit-code evidence

For every invoked gate and hygiene command, copy the exact command and its observed integer exit code from the terminal. Do not replace an exit code with a bare `PASS` or `FAIL` label. Also record whether the ordinary suite reported the hard gate as ignored.
```

Append exactly one result block:

```markdown
## Result

### Primitive verdict: Go

The explicit ignored gate passed because both control acquisitions succeeded with the expected synthetic byte and acquisition returned `ERROR_SHARING_VIOLATION (32)` only while the child retained the writable mapped view. This authorizes only a separate full native-VFS feasibility plan. It does not complete full Phase 0 or authorize integration into `vault-local-store-sqlite` or actual Secret input.

## Commands run

- Record every exact command and its observed integer exit code.
- A word such as PASS without its exit code is forbidden.
- The ordinary crate test must record that the explicit security gate remained ignored.

## Remaining RED gates

- actual SQLite `xOpen/xRead/xWrite/xFileSize/xTruncate/xLock/xUnlock/xSync` callbacks
- private `xShm*` behavior without trusting external `-shm`
- WAL recovery, checkpoint, crash, and absent-WAL race semantics
- path trace proving no stock-VFS/pathname fallback
- file identity/epoch continuity through RO authentication and RW promotion
- wrong-password no-write, future/corrupt preservation, crash atomicity, and compile-fail regression
- monotonic completeness anchor for coherent old rollback and whole-row omission

## Product gate

Actual passwords, API keys, Secrets, and recovery keys remain prohibited.
```

Use the block above only for exact `ERROR_SHARING_VIOLATION (32)`. For a clean guard-acquired failure, instead use:

```markdown
## Result

### Primitive verdict: No-Go

The parent acquired the proposed read guard while the child retained the pre-existing writable mapped view. The explicit test emitted `NO_GO_PREEXISTING_WRITABLE_MAPPING_ACCEPTED` or `NO_GO_PREEXISTING_WRITABLE_MAPPING_ACCEPTED_AND_MUTATED`.

The actual-handle VFS design must not be connected to `vault-local-store-sqlite`. Do not weaken the threat model with byte-range locks, polling, repeated hashes, retries, or pathname reopen.

## Required redesign

Move authoritative SQLite file ownership behind a broker/service boundary with a distinct security principal or make a new user-approved threat-model decision. The current store remains synthetic-only, and actual passwords, API keys, Secrets, and recovery keys remain prohibited.
```

For any other result, instead use:

```markdown
## Result

### Primitive verdict: Inconclusive

The gate did not produce either exact `ERROR_SHARING_VIOLATION (32)` or a clean guard-acquired No-Go marker. No security guarantee is inferred.

The actual-handle VFS design must not be connected to `vault-local-store-sqlite`. Repair or rerun the same assertion on the pinned environment without weakening it. Actual passwords, API keys, Secrets, and recovery keys remain prohibited.
```

- [ ] **Step 3: Update the product and Desktop RED records**

Append one matching dated line to `docs/PRODUCT_BUILD_AND_DEPLOY_GUIDE.md`:

- Go: `Phase 0A controls succeeded and the hostile interval alone returned exact sharing violation 32; primitive Go only; full Phase 0/VFS/store/real-Secret gates remain closed.`
- No-Go: `Phase 0A accepted the guard while a writable mapping remained; store integration stopped; redesign required.`
- Inconclusive: `Phase 0A did not produce an authoritative result; no guarantee inferred; integration stopped.`

Append a matching entry to `06_RED_TEAM_중심_작업기록.md` that records:

1. attacker pre-creates a writable mapping and closes only the creator handle,
2. fixed `READY → parent acquire → optional MUTATE → EXIT` frames,
3. no sleep or probabilistic retry,
4. acquisition itself must fail with OS code 32,
5. external `-shm` and full VFS remain outside this primitive,
6. the observed verdict and the still-closed actual-Secret gate.

- [ ] **Step 4: Extend the Desktop implementation/file map**

Append to `09_구현_파일구조와_변경기록.md`:

```text
crates/vault-local-sqlite-vfs-windows/
├── Cargo.toml
├── src/
│   ├── lib.rs                              # public types and pinned platform contract
│   ├── error.rs                            # non-sensitive stable error codes
│   ├── file_guard.rs                       # FILE_SHARE_READ actual-handle guard
│   ├── probe_protocol.rs                   # bounded fixed frames
│   ├── windows_mapping_probe.rs            # retained writable mapped view
│   └── bin/vault-vfs-feasibility-child.rs  # hostile child state machine
└── tests/
    ├── platform_contract.rs
    ├── actual_handle_feasibility.rs
    └── support/mod.rs                      # child process and 20-second hang watchdog

docs/verification/
└── windows-actual-handle-vfs-feasibility.md
```

Record the code flow exactly:

```text
synthetic file
  → pre-child control open/read succeeds and closes
  → child writable mapping/view
  → creator File handle closes
  → READY
  → parent guard acquisition
      ├─ sharing violation 32 → post-child control succeeds: primitive Go
      ├─ guard acquired: No-Go
      └─ anything else: Inconclusive
  → verdict record
  → no existing SQLite-store integration in this plan
```

Also record that `file_guard.rs` pathname open is allowed only inside this isolated primitive probe and does not authorize a pathname fallback in the eventual VFS.

- [ ] **Step 5: Re-run hygiene and review the exact diff**

```powershell
cargo fmt --all -- --check
$formatExit = $LASTEXITCODE
cargo clippy --locked -p vault-local-sqlite-vfs-windows --all-targets --features feasibility-probe -- -D warnings
$clippyExit = $LASTEXITCODE
cargo test --locked -p vault-local-sqlite-vfs-windows --features feasibility-probe -- --test-threads=1
$ordinaryTestExit = $LASTEXITCODE
git diff --check
$diffCheckExit = $LASTEXITCODE
git status --short
$statusExit = $LASTEXITCODE
git diff -- docs/verification/windows-actual-handle-vfs-feasibility.md docs/PRODUCT_BUILD_AND_DEPLOY_GUIDE.md
$reviewDiffExit = $LASTEXITCODE
"FORMAT_EXIT=$formatExit"
"CLIPPY_EXIT=$clippyExit"
"ORDINARY_TEST_EXIT=$ordinaryTestExit"
"DIFF_CHECK_EXIT=$diffCheckExit"
"GIT_STATUS_EXIT=$statusExit"
"REVIEW_DIFF_EXIT=$reviewDiffExit"
if ($formatExit -ne 0 -or $clippyExit -ne 0 -or $ordinaryTestExit -ne 0 -or $diffCheckExit -ne 0 -or $statusExit -ne 0 -or $reviewDiffExit -ne 0) {
    throw "INCONCLUSIVE_PHASE_0A_FINAL_HYGIENE_FAILURE"
}
```

The explicit gate must remain ignored in the ordinary test command. Its one completed Task 2 execution for the final reviewed candidate revision is the only verdict source.

- [ ] **Step 6: Commit only the in-repository evidence**

```powershell
git add -- docs/verification/windows-actual-handle-vfs-feasibility.md docs/PRODUCT_BUILD_AND_DEPLOY_GUIDE.md
git diff --cached --name-status
git diff --cached --check
git commit -m "docs: record Windows VFS feasibility verdict"
```

Expected staged names: exactly the two documentation files above. The Desktop package remains outside this Git repository.

- [ ] **Step 7: Stop or authorize only the next planning phase**

- If `No-Go` or `Inconclusive`: stop all VFS/store integration and write a broker/service-boundary redesign spec before more product code.
- If `Go`: write and review a separate full native-VFS feasibility plan covering callback ABI, main/WAL ownership, private SHM, SQLite locks, WAL recovery, crash behavior, absent-WAL races, path tracing, bounded Backup API snapshot, and capability promotion. Do not begin it inside this plan.

---

## Plan Completion Gate

- [ ] The exact OS build, target host, and rustc comparison passed, and the crate platform contract passed.
- [ ] The final reviewed candidate revision had one completed explicit gate execution with `--ignored --exact --test-threads=1 --nocapture`.
- [ ] Pre-child and post-child controls both succeeded with the expected synthetic byte before any primitive Go classification.
- [ ] The result was classified only as `Go`, `No-Go`, or `Inconclusive` by the exact rule.
- [ ] No product-store dependency or VFS registration was added.
- [ ] Repository and Desktop records agree with command output.
- [ ] Exact integer exit codes for the gate, formatting, crate Clippy, ordinary tests, and diff checks are recorded without turning an ignored gate into a false pass.
- [ ] Only exact reviewed files were staged and committed; nothing was pushed.
- [ ] No actual password, API key, Secret, recovery key, vault DB, WAL, SHM, or `.env` was used.

## Final Handoff

Report the Phase 0A verdict and why, the three local commit SHAs, exact changed files, exact command outcomes and integer exit codes, whether the ordinary suite kept the gate ignored, the next permitted action, and confirmation that full Phase 0 remains incomplete and no store integration, push, or actual Secret input occurred.
