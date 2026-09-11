# Windows Actual-Handle VFS Phase 0A Pre-existing-Mapping Primitive Verification

Date: 2026-08-29 KST

Final source candidate: `e8b29cb6a014aed24725b0f658182b9d2cfc487d`

Branch: `codex/firstvibe-sqlite-store`

## Scope

This record covers one primitive only: whether the pinned Windows host accepts the same synthetic path before and after the hostile interval but rejects a parent no-write/no-delete-share read acquisition while another process retains a pre-existing writable mapped view after closing its creator file handle.

It does not complete the approved spec's multi-proof Phase 0 gate and does not prove a SQLite VFS, WAL/private-SHM correctness, snapshot authentication, store integration, production readiness, or safety for actual passwords, API keys, Secrets, or recovery keys.

## Pinned environment

The controller's exact comparison completed with exit code `0` before the final-candidate gate:

- Windows NT: `10.0.26200.0`
- Rust: `rustc 1.95.0 (59807616e 2026-04-14)`
- Cargo: `cargo 1.95.0`
- Host: `x86_64-pc-windows-msvc`
- rusqlite: `0.40.2`
- libsqlite3-sys: `0.38.2`
- bundled SQLite: `3.53.2`
- branch: `codex/firstvibe-sqlite-store`
- candidate revision: `e8b29cb6a014aed24725b0f658182b9d2cfc487d`

The local remote-tracking reference was not fetched or treated as current server proof. No pull or push occurred.

## Synthetic-only fixture

- Initial bytes: `DEMO_VALUE_ONLY_MAPPING_A`
- Mutated bytes: `DEMO_VALUE_ONLY_MAPPING_B` (last byte changed from `A` to `B`)
- Mapping geometry: exact length `25`, last-byte offset `24`, passed explicitly to both `CreateFileMappingW` and `MapViewOfFile`
- Real password, API key, Secret, recovery key, `.env`, vault DB, WAL, and SHM were not used.

## Deterministic protocol

1. The parent proves a pre-child control acquisition and read succeed, then drops that guard.
2. The child opens the same synthetic file read/write and requests an exact 25-byte mapping object and 25-byte writable mapped view.
3. The child closes its original file handle while retaining the mapping object and view.
4. The child emits `V1 READY` through stdout.
5. Only after that frame, the parent attempts `acquire_main_read_guard_v1` with `FILE_SHARE_READ`.
6. If the acquisition is accepted, the fixed `MUTATE`/`MUTATED` frames expose the No-Go branch before `EXIT`.
7. After exact sharing rejection, the child exits and the parent proves a post-child control acquisition plus unchanged-byte read succeed.
8. A 20-second watchdog detects a hang; it is not a timing assumption or retry.

## Decision rule

- A single primitive `Go` observation requires both controls to succeed with the expected synthetic byte and the hostile acquisition alone to return `ERROR_SHARING_VIOLATION (32)`.
- `No-Go` occurs if acquisition succeeds while the writable mapped view exists, whether or not the immediate read observes the mutation.
- The authoritative Phase 0A checkpoint is `Inconclusive` for a failed mandatory hygiene command, failed control, unexpected control byte, build failure, timeout, child failure, Application Control error `4551`, unsupported or mismatched platform, protocol error, or any other OS error.
- A primitive `Go` observation cannot override an `Inconclusive` Phase 0A checkpoint.

## Independent RED review

The final candidate received:

- Spec Compliance: `Approved`
- Task Quality: `Approved`
- Critical findings: `0`
- Important findings: `0`

Review fixes incorporated across `6f2cec4` and `e8b29cb`:

- unified the synthetic mutation to the permitted complete `A` to `B` transition;
- captured the original `MapViewOfFile` error before cleanup could overwrite the Win32 last-error value;
- added stable initial-I/O `INCONCLUSIVE_MAPPING_GATE` markers;
- removed metadata-derived pointer geometry and zero-length whole-file mapping;
- passed one exact 25-byte geometry to both Win32 mapping stages and bounded the write offset to byte 24.

One Minor, non-blocking limitation remains: `open_synthetic_v1(&Path)` does not independently verify that the existing file contents are exactly the `A` fixture. This is acceptable only for the current `publish = false`, feasibility-feature, non-store child whose parent creates the synthetic temporary fixture. Before any store integration, content validation or a stronger capability boundary is required.

## Result

### Single pre-existing-mapping primitive observation: Go

The final-candidate explicit ignored gate exited `0` with exactly one passed test and two filtered tests. That test can pass only after both controls read the expected last byte and the hostile acquisition alone returns `ERROR_SHARING_VIOLATION (32)` while the child retains the writable mapped view.

This observation is limited to that primitive on the pinned host. It does not authorize a native SQLite VFS, `vault-local-store-sqlite` integration, or actual Secret input.

### Authoritative Phase 0A checkpoint: Inconclusive

The mandatory ordinary crate suite exited `101` because Windows Application Control rejected the library test executable with OS error `4551` before it ran. The suite therefore never reached the integration-test executable. No final-candidate runtime ignored count is claimed; only the static source annotation `#[ignore = "explicit security feasibility gate; run before store integration"]` is confirmed.

Because a mandatory hygiene command did not complete, no full Phase 0A security guarantee is inferred. Store integration stopped. The primitive `Go` observation is retained as narrow evidence, not promoted to a Phase 0A pass.

## Command and exit-code evidence

The following results were supplied by the controller for the reviewed final candidate and were not rerun while writing this record.

### Pinned environment comparison

```powershell
$expectedRust = 'rustc 1.95.0 (59807616e 2026-04-14)'
$actualRust = (rustc --version).Trim()
$actualHost = ((rustc --version --verbose | Select-String '^host:').Line -replace '^host:\s*', '').Trim()
$actualOs = [System.Environment]::OSVersion.Version.ToString()
if ($actualRust -ne $expectedRust -or $actualHost -ne 'x86_64-pc-windows-msvc' -or $actualOs -ne '10.0.26200.0') {
    throw "INCONCLUSIVE_PINNED_PLATFORM_MISMATCH:rust=$actualRust;host=$actualHost;os=$actualOs"
}
cargo --version
git branch --show-current
git rev-parse HEAD
cargo tree -p vault-local-sqlite-vfs-windows -i libsqlite3-sys
```

Observed: `PINNED_ENVIRONMENT_EXIT=0`.

### One final-candidate explicit gate execution

```powershell
cargo test --locked -p vault-local-sqlite-vfs-windows --features feasibility-probe --test actual_handle_feasibility preexisting_writable_mapping_must_block_guard_acquisition -- --ignored --exact --test-threads=1 --nocapture
```

Observed:

```text
PHASE_0A_GATE_EXIT=0
running 1 test
preexisting_writable_mapping_must_block_guard_acquisition ... ok
1 passed; 0 failed; 0 ignored; 0 measured; 2 filtered out
```

### Final-candidate formatting, lint, and repository checks

```powershell
cargo fmt --all -- --check
```

Observed: `FORMAT_EXIT=0`.

```powershell
cargo clippy --locked -p vault-local-sqlite-vfs-windows --all-targets --features feasibility-probe -- -D warnings
```

Observed: `CLIPPY_EXIT=0`.

```powershell
git diff --check
```

Observed: `DIFF_CHECK_EXIT=0`.

```powershell
git status --short
```

Observed: `GIT_STATUS_EXIT=0`; output was empty at candidate revision `e8b29cb`.

### Mandatory ordinary suite

```powershell
cargo test --locked -p vault-local-sqlite-vfs-windows --features feasibility-probe -- --test-threads=1
```

Observed:

```text
ORDINARY_TEST_EXIT=101
An Application Control policy has blocked this file. (os error 4551)
```

The block occurred before the library test executable ran. The ordinary suite did not reach `tests/actual_handle_feasibility.rs`, so this run provides no runtime evidence that the explicit hard gate was reported as ignored.

## Remaining RED gates

- actual SQLite `xOpen/xRead/xWrite/xFileSize/xTruncate/xLock/xUnlock/xSync` callbacks
- private `xShm*` behavior without trusting external `-shm`
- WAL recovery, checkpoint, crash, and absent-WAL race semantics
- path trace proving no stock-VFS or pathname fallback
- file identity and epoch continuity through RO authentication and RW promotion
- wrong-password no-write, future/corrupt preservation, crash atomicity, and compile-fail regression after any boundary change
- content validation or a stronger capability boundary before `open_synthetic_v1` could leave the isolated fixture harness
- monotonic completeness anchor for coherent old rollback and whole-row omission

## Product gate and next permitted action

Actual passwords, API keys, Secrets, and recovery keys remain prohibited. `vault-local-sqlite-vfs-windows` is not connected to `vault-local-store-sqlite`.

Because the authoritative checkpoint is `Inconclusive`, full VFS/store integration remains stopped. The next work must stay non-integrating: resolve the Application Control environment and rerun the same mandatory ordinary suite on an unchanged reviewed candidate, or write the broker/service-boundary redesign specification required by the approved plan. A full native-VFS implementation requires a separate user-approved plan after the checkpoint is no longer Inconclusive.
