# SQLite Namespace Hardening Checkpoint

## Scope

This checkpoint reduces path-alias, final lock-entry, and dangling sidecar risk
for the synthetic SQLite store. All fixtures and sentinels were synthetic.
Actual passwords, API keys, recovery material, and personal vault data were not
used.

`REAL_SECRET_GATE=CLOSED` remains unchanged.

## Changes

- Store locations reject Windows-ambiguous components, including trailing dots
  or spaces, alternate-data-stream colons, reserved DOS device basenames, and
  the supported superscript device aliases. The portable policy applies this
  spelling rule on every build so a persisted relative location cannot become
  a Windows alias later.
- On Windows the adjacent lock is opened with final-component reparse-point
  handling and without write/delete sharing, then validated from the opened
  handle as a regular, non-reparse file. A live guard therefore blocks another
  writer and prevents deleting or renaming that final entry.
- SQLite sidecar names are constructed by appending to the exact `OsString`
  instead of using a lossy string conversion.
- Initialization checks use `symlink_metadata`, so a dangling sidecar symlink
  or junction is preserved and rejected rather than mistaken for absence.

No suspicious entry is deleted, repaired, followed, or overwritten.

## Verification

- Focused `lock_and_flags` integration tests: 9 passed, 0 failed.
- Dangling-sidecar preservation regression: 1 passed.
- Exact Windows `OsString` suffix regression: 1 passed.
- Existing lingering-sidecar preservation regression: 1 passed.
- Full `vault-local-store-sqlite` crate: 97 passed, 0 failed, 1 ignored; exit
  `0`.
- Clippy for all crate targets and features with `-D warnings`: exit `0`.
- `cargo fmt --all -- --check`: exit `0`.
- `git diff --check`: exit `0`.
- Repository Secret scan: `SECRET_SCAN_PASSED`,
  `REAL_SECRET_GATE=CLOSED`.
- Independent review: Critical 0, Important 0, Minor 0 for this bounded patch.

The first Windows dangling-sidecar fixture attempted a file symlink and was
denied by Windows privilege error `1314`. No privilege or policy bypass was
used. The test was changed to an administrator-free directory junction and
then passed while proving that the external synthetic sentinel remained
unchanged.

## Unresolved release blockers

This checkpoint does **not** make the SQLite store safe for real Secret input.

- Parent-directory rename, junction replacement, and namespace identity are
  not pinned for the complete store lifetime.
- Pre-existing hard-link count is not checked; no new unsafe platform FFI was
  introduced to imitate that guarantee.
- The stock SQLite pathname open still does not bind the main database, WAL,
  and SHM to an actual-handle VFS or a separate broker security principal.
- The absent-WAL/SHM creation race and complete file-family lifetime guard
  therefore remain unresolved.
- A Windows file-symlink runtime fixture remains unverified on this host; the
  junction case is evidence only for the tested final-component reparse class.

Actual Secret support remains blocked until the approved actual-handle VFS
Phase 0 gate or a separately approved broker design succeeds, followed by the
remaining recovery, rollback, independent review, and penetration-test gates.
