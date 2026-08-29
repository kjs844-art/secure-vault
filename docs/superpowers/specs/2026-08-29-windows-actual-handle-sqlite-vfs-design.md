# Windows Actual-Handle SQLite VFS and Verified Snapshot Design

Status: approved design; implementation not started

Approved threat scope: 2026-08-29

Security source baseline: `4138dd7217528458a881275a7349fd3430defef8`

Implementation-planning baseline: `ce365736ddaf79b7ccdf6095eaf3ae99eca1d5d3` (the approved-spec commit and a documentation-only descendant of the source baseline)
Product label: KeyAtlas (working title)

## 1. Decision

The Windows v1 local vault will defend against a separate process running as the same Windows user that can directly modify the SQLite main, WAL, or SHM files while the vault is opening or unlocking.

The selected design combines three layers:

1. Keep the real-Secret release gate fail-closed until the new boundary passes all acceptance gates.
2. Add a Windows-only SQLite VFS that owns the actual main/WAL/SHM handle family and mediates every relevant SQLite file and shared-memory operation.
3. After trusted source acquisition, copy one logical read snapshot into a private in-memory SQLite database and perform structural inspection and password authentication only on that snapshot. Reopen the source for writes through the same VFS policy and bind RO approval to RW promotion with an opaque file-set epoch and logical digest.

This design does not open real-Secret support. Valid historical rollback and complete record/revision omission remain separate P0 work.

## 2. Scope

### 2.1 Included attacker

The attacker:

- runs as the same Windows user;
- knows the vault database path;
- can ignore the cooperative application `.lock` file;
- can attempt to open, replace, grow, truncate, reset, map, or rewrite the main, WAL, or SHM objects during open, preflight, authentication, or RO-to-RW promotion;
- can use same-length rewrites and timing races, not only pathname replacement or size growth.

The intended security gain is that raw file authority alone cannot cause SQLite to consume an unbound or mixed file-set state and cannot change the bound file family after acquisition.

### 2.2 Explicitly excluded attacker capabilities

This slice does not claim protection from:

- arbitrary code execution inside the KeyAtlas process;
- unrestricted process-memory reads, process injection, or handle duplication;
- administrator, SYSTEM, kernel, or raw-volume writes;
- a malicious signed application update or compromised build pipeline;
- denial of service by a local attacker;
- plaintext exposure after an authorized reveal, copy, or paste.

These exclusions prevent the file-boundary claim from being misrepresented as complete local-malware resistance.

### 2.3 Non-goals

The following work is intentionally outside this design:

- authenticated monotonic freshness/completeness anchors;
- recovery key slots, device revocation, and key-epoch rotation;
- Android Keystore and biometric integration;
- Web, sync service, PostgreSQL, backup/export product flows, or billing;
- real passwords, API keys, Secrets, or recovery material.

## 3. Current Failure Mode

The current preflight boundary retains separately opened main/WAL/SHM files, revalidates their identity or length, and then asks rusqlite to open the pathname again. The retained objects are not the same objects SQLite proves it uses for all I/O.

Source evidence:

- the retained file-set capture is in `crates/vault-local-store-sqlite/src/preflight_query.rs:95-140`;
- retained-file metadata revalidation is in `crates/vault-local-store-sqlite/src/preflight_query.rs:169-229`;
- the Windows pre-open handle permits `FILE_SHARE_WRITE` in `crates/vault-local-store-sqlite/src/preflight_query.rs:232-246`;
- rusqlite opens the pathname separately in `crates/vault-local-store-sqlite/src/preflight_query.rs:398-430`;
- the bare `BEGIN` is deferred until the first database read in `crates/vault-local-store-sqlite/src/preflight_query.rs:414-424`;
- the first application query begins with `application_id` in `crates/vault-local-store-sqlite/src/preflight_query.rs:475-479`;
- RO-to-RW promotion drops the RO gate and reopens by path in `crates/vault-local-store-sqlite/src/preflight.rs:260-287`.

The application lock coordinates cooperating KeyAtlas processes, not arbitrary raw writers. A logical digest detects changes between two observed states but does not prove that either observation is current or complete.

## 4. Alternatives Considered

### 4.1 Alternative 1: fail-closed only

Reject every existing database state that cannot be proven quiescent.

This is the correct immediate release policy and the rollback path for this project. It preserves data and avoids false security claims, but it does not provide a useful existing-vault unlock flow and may reject valid crash-WAL states.

### 4.2 Alternative 2: actual-handle VFS on the live source only

Use a dedicated VFS for both inspection and writes directly against the source database.

This removes the extra snapshot copy and can preserve stock WAL behavior with less memory. It leaves every schema, integrity, cap, digest, and authentication query operating on attacker-originated storage. The resulting preflight and resource-accounting boundary is harder to review.

### 4.3 Alternative 3: actual-handle VFS plus private in-memory snapshot

Acquire the source through the actual-handle VFS, start a bounded logical read, copy it with the SQLite Backup API into memory, and run all application-level inspection and authentication on the copy. Use the VFS again for RW promotion.

This is the selected alternative. It makes the source-acquisition boundary small, keeps wrong-password application writes away from the source, and makes partial snapshot state a type/lifetime problem that can be sealed. It costs one bounded database copy during unlock and still requires a correct VFS for source acquisition and promotion.

| Property | Fail-closed only | VFS on live source | VFS + private snapshot |
| --- | --- | --- | --- |
| Existing crash-WAL support | Often unavailable | Possible | Possible |
| Active raw-file mutation defense | Avoids use | Directly enforced | Directly enforced before copy |
| Wrong-password source isolation | Strong | Depends on VFS/SQLite bookkeeping | Strongest separation |
| Unlock memory/latency | Lowest | Lowest | One bounded copy |
| Review complexity | Low | Highest preflight complexity | High native complexity, simpler inspection |
| Selected role | Temporary release gate | Rejected final arrangement | Product implementation target |

## 5. Security Invariants

The implementation is acceptable only if all invariants hold.

### VFS and file-family invariants

1. Before the first application SQL query, SQLite uses only VFS-owned actual handles for accepted main/WAL files and VFS-owned private memory for SHM.
2. A VFS-owned file object never silently reopens a path to satisfy later I/O.
3. Existing external write/delete handles or still-live writable mappings of main or a present WAL cause acquisition to fail before password KDF, record decryption, or writable open.
4. After acquisition, a new external write/delete open against main or WAL cannot succeed, so no new writable mapping requiring such a handle can be created for the bound family.
5. Main and WAL identity use the full Windows volume identifier plus 128-bit file identifier; path text and length are supporting evidence, not identity substitutes.
6. During RO acquisition, an absent WAL is recorded in the epoch and any later appearance is a concurrent-change rejection. During authenticated RW promotion, the VFS alone may create an absent WAL with atomic create-new semantics; an attacker winning that race causes rejection.
7. External SHM is never opened or trusted as authoritative input. Every SHM operation uses a VFS-owned bounded private mapping suitable for the single-process v1 client.
8. Unsupported SQLite, Windows, filesystem, mapping, or callback behavior returns a stable unsupported/preservation error. There is no weaker pathname fallback.

### Snapshot and authentication invariants

9. A private snapshot becomes `VerifiedSnapshotV1` only after Backup API completion, resource-cap checks, and structural verification succeed.
10. Cancellation, panic, I/O failure, budget exhaustion, or partial backup cannot produce a verified or authenticated type.
11. Application ID, user version, schema fingerprint, bounded integrity, foreign-key, row/byte caps, logical digest, password envelope, and current-revision authentication run on the private snapshot.
12. Wrong password never creates a source writable connection or application write transaction.
13. Future version, current corruption, and unsupported states preserve the original main/WAL/SHM bytes and do not initialize, migrate, repair, or delete them.

### Promotion and lifetime invariants

14. RO approval carries an opaque file-set epoch and logical digest into RW promotion.
15. RW promotion reacquires the actual family through the same VFS policy and checks identity, schema, caps, envelope graph, and digest inside `BEGIN IMMEDIATE` before a write.
16. A mismatch returns a concurrent-change or preservation error and writes nothing.
17. The writable store privately retains the application lock, VFS/file-family guard, epoch, and SQLite connection for the entire store lifetime.
18. Public APIs cannot extract raw `rusqlite::Connection`, raw SQLite/Windows handles, VFS internals, or secret-bearing raw types.

### Resource and observability invariants

19. VFS reads, source pages, destination pages, rows, aggregate envelope bytes, and snapshot memory are bounded by the existing storage caps or a stricter derived cap.
20. A hostile sparse or oversized source fails before unbounded recovery, parsing, allocation, or copying.
21. Errors, logs, traces, and test output never contain passwords, Secret plaintext, ciphertext bodies, SQL values, full user paths, or user names.

## 6. Component Architecture

### 6.1 Proposed workspace structure

```text
crates/
├── vault-crypto/                         # unchanged cryptographic ownership
├── vault-local-core/                     # unchanged synthetic credential core
├── vault-local-platform-windows/         # trusted paths and Win32 identity helpers
├── vault-local-sqlite-vfs-windows/       # new: SQLite ABI, VFS, actual handle family
└── vault-local-store-sqlite/             # preflight, snapshot auth, promotion, store API
```

The new `vault-local-sqlite-vfs-windows` crate is the only new unsafe/FFI owner. `vault-local-store-sqlite` retains `#![forbid(unsafe_code)]`.

### 6.2 `vault-local-sqlite-vfs-windows`

Responsibilities:

- register and unregister a uniquely named Windows-only SQLite VFS;
- own callback lifetime and thread-safety rules;
- acquire and retain the actual main/WAL handle family;
- classify SQLite open roles and reject unexpected roles;
- enforce trusted root, local fixed volume, reparse, file identity, sharing, size, and namespace policy;
- implement or safely delegate only operations that remain bound to the owned handle family;
- mediate every listed callback used by the pinned Windows SQLite build: `xOpen`, `xRead`, `xWrite`, `xFileSize`, `xTruncate`, `xLock`, `xUnlock`, `xSync`, `xShmMap`, `xShmLock`, `xShmBarrier`, and `xShmUnmap`;
- expose only opaque safe-Rust guard values to the store crate.

Calling the stock VFS by pathname and checking metadata afterward is not sufficient. If delegation would cause a second pathname open or external SHM use, that operation must be implemented against the owned family or rejected.

### 6.3 `vault-local-platform-windows`

Existing responsibilities remain:

- current-user LocalAppData discovery;
- trusted fixed-volume enforcement;
- full stable file identity;
- small, reviewable Windows metadata helpers.

VFS callback and SQLite ABI ownership stay in the new crate so general platform helpers do not become coupled to SQLite lifetimes.

### 6.4 `vault-local-store-sqlite`

This crate owns product/storage semantics:

- request a bound RO source from the VFS crate;
- create and seal the private in-memory snapshot;
- run structural preflight and authentication;
- carry epoch/digest approval into RW promotion;
- return a store that retains all guards;
- map native failures to stable storage-domain errors;
- preserve current revision/CAS/conflict and wrong-password/future/corruption behavior.

## 7. State and Capability Model

The following v1 safe type names and responsibilities are fixed by this design. Renaming or merging them requires a reviewed spec revision.

| Capability | Created only when | Owns | May transition to |
| --- | --- | --- | --- |
| `BoundSqliteVfsV1` | VFS registration and policy setup succeed | VFS registration/lifetime | bound source acquisition |
| `VaultFileSetEpochV1` | main/WAL/SHM family acquisition succeeds | opaque identity/presence/generation facts | RO approval and RW comparison |
| `BoundReadOnlySourceV1` | external writer exclusion and actual-family binding succeed | RO connection, family guard, app lock reference | snapshot construction |
| `SnapshotUnderConstructionV1` | bounded destination allocation succeeds | incomplete in-memory destination | verified snapshot or drop only |
| `VerifiedSnapshotV1` | backup and structural verification succeed | private DB and structural digest | authenticated snapshot |
| `AuthenticatedSnapshotV1` | password envelope and every current revision authenticate | verified snapshot, vault commitment, digest, epoch | RW promotion |
| `BoundWritableStoreV1` | `BEGIN IMMEDIATE` promotion rechecks succeed | RW connection, VFS/family guard, epoch, app lock | normal commit API |

No public conversion exposes the inner connection or native handles.

## 8. Data Flow

### 8.1 Existing vault unlock

1. Resolve `TrustedLocalAppDataRootV1` and `StoreLocationV1`.
2. Acquire `StoreLockV1`.
3. Register or obtain the process-local bound VFS instance.
4. Acquire the source main/WAL family with external write/delete exclusion. Reject ambiguity before application SQL.
5. Execute `PRAGMA locking_mode=EXCLUSIVE` through the already-bound VFS before the first database read and require the returned mode to be `exclusive`.
6. Execute `BEGIN`, immediately establish the source read snapshot with a budgeted `PRAGMA page_count`, and create a bounded private in-memory destination with the Backup API. A bare deferred `BEGIN` alone is not evidence that the snapshot is fixed.
7. Drop source query authority after successful copy; retain only the epoch/guard facts needed for promotion.
8. Inspect and authenticate the private snapshot.
9. On wrong password, future version, corruption, or cap failure, close all RO resources and return the existing preservation state without opening RW.
10. On authentication success, reacquire RW through the same VFS policy.
11. Start `BEGIN IMMEDIATE` and recheck file-set epoch, schema, caps, graph, and logical digest.
12. Commit no application changes during promotion; return the bound writable store only after all checks pass.

### 8.2 New vault initialization

Initialization remains a separate path. It must:

- prove the target is absent or exactly zero-byte under the trusted location policy;
- acquire the target namespace through the VFS without accepting attacker-created sidecars;
- create schema and password envelope in one immediate transaction;
- retain the same VFS/family guard in the returned store;
- preserve current synthetic-only input restrictions.

### 8.3 Store close and restart

Normal close releases SQLite, the family guard, VFS registration reference, and app lock in a defined order. Restart must reopen only through the bound VFS and must correctly accept a committed crash-WAL while excluding an uncommitted tail.

## 9. SHM and Single-Process Policy

The public Windows v1 client is single-process for one vault because `StoreLockV1` already serializes cooperating instances. The native design will not trust an external `-shm` file as validated state.

Before the first database read, the connection enters exclusive locking mode and every SHM callback is satisfied by a VFS-owned, bounded private mapping that cannot be replaced by another process. If the pinned SQLite build cannot preserve documented WAL recovery, checkpoint, close, and restart semantics under this policy, the platform boundary returns `UnsupportedPlatform` and the implementation does not integrate with the store.

An existing external `-shm` file is preserved on authentication or structural failure. It is not parsed as trusted application data, silently deleted, or used as proof of file-family identity. Its existence, open handles, or mappings do not by themselves produce `Busy` because that external object is not a member of the accepted family; feasibility must instead prove that changing it cannot influence SQLite's private SHM state.

The implementation plan must include a native feasibility spike proving committed crash-WAL recovery, checkpoint behavior, and close/restart behavior with this policy before product integration proceeds.

### 9.1 Mandatory Go/No-Go Feasibility Gate

Before any store integration, an isolated native prototype must prove all of the following on the pinned Windows and SQLite versions:

- a pre-existing external writable handle or still-live writable mapping of main or a present WAL prevents the source from being accepted;
- after family acquisition, a new external write/delete handle against main or WAL cannot be obtained and therefore cannot be used to create a new writable mapping;
- traced SQLite file I/O reaches only VFS-owned main/WAL handles and private SHM, never reopening main, WAL, or external SHM by pathname;
- private SHM plus exclusive locking correctly accepts a committed crash-WAL, rejects an uncommitted tail, checkpoints, closes, and restarts;
- a race that creates an absent WAL before the VFS does is rejected without consuming attacker-controlled state.

This is a hard gate, not an aspirational test. If any item cannot be demonstrated deterministically, implementation stops before `vault-local-store-sqlite` integration, the public real-Secret entry remains fail-closed, and there is no stock-VFS or pathname fallback. The design must then return for review of a broker/service boundary or an operating-system snapshot alternative.

## 10. Error Model

New internal failures map to the existing public `StorageErrorCode` variants. A private `BoundVfsPhaseV1` plus `BoundVfsReasonV1` pair may provide redacted test/trace evidence, but neither type is public and neither carries local paths or data values.

| Failure class | Required behavior |
| --- | --- |
| VFS unavailable, ABI mismatch, or unsupported SHM policy | `UnsupportedPlatform`; no fallback |
| untrusted root/volume/reparse | `InvariantViolation`; no SQLite open |
| existing external writer/mapping | `Busy`; rejection before application SQL |
| actual handle/role/identity mismatch | `InvariantViolation`; source preserved |
| sidecar namespace or RO-to-RW epoch race | `InvariantViolation`; no write |
| size/read/page/memory cap | `LimitsExceeded` |
| backup incomplete/cancelled by I/O | `Io`; discard partial destination |
| wrong password | `AuthenticationFailed`; RW never opened |
| future storage/crypto version | `SchemaUpgradeRequired` or `CryptoUpgradeRequired` |
| current structural/authenticated corruption | `CorruptStorage` |

Errors may include a stable phase and reason code. They may not include Secret material, SQL values, ciphertext bodies, or full local paths.

## 11. Resource Bounds

The implementation introduces `PreflightCapsV1` as the product-owned consolidation of the existing row and envelope constants in `rows.rs` and the derived private limits in `preflight_query.rs`. The VFS layer adds byte-accounting before SQLite can exceed the derived maximum database and WAL budget.

Required bounds:

- main file length;
- WAL accepted length and cumulative bytes read;
- SHM/private mapping length;
- SQLite page count multiplied by page size with checked arithmetic;
- private snapshot page/memory budget;
- revision, head, conflict, and aggregate envelope-byte caps;
- first foreign-key violation and bounded integrity result.

This library slice does not promise a wall-clock deadline. It promises deterministic byte/page/row/memory bounds. A later UI/service layer may add cancellation and elapsed-time policy without weakening these bounds.

## 12. Planned File Changes

| Path | Planned responsibility |
| --- | --- |
| `Cargo.toml` | add the Windows VFS workspace member |
| `Cargo.lock` | record only reviewed dependency changes |
| `crates/vault-local-sqlite-vfs-windows/Cargo.toml` | minimal SQLite/Windows FFI dependencies |
| `crates/vault-local-sqlite-vfs-windows/src/lib.rs` | safe public opaque capability API |
| `crates/vault-local-sqlite-vfs-windows/src/ffi.rs` | SQLite/Win32 ABI declarations |
| `crates/vault-local-sqlite-vfs-windows/src/vfs.rs` | registration and callback dispatch |
| `crates/vault-local-sqlite-vfs-windows/src/file_family.rs` | actual handle family, identity, sharing, namespace policy |
| `crates/vault-local-sqlite-vfs-windows/src/shm.rs` | bounded private SHM policy |
| `crates/vault-local-store-sqlite/Cargo.toml` | Windows-only VFS dependency and backup feature |
| `crates/vault-local-store-sqlite/src/preflight_query.rs` | replace path-only connection ownership with bound source/snapshot flow |
| `crates/vault-local-store-sqlite/src/preflight.rs` | carry epoch/digest through authentication and promotion |
| `crates/vault-local-store-sqlite/src/schema.rs` | bind writable open before hardening SQL |
| `crates/vault-local-store-sqlite/src/store.rs` | retain VFS/family guard for store lifetime |
| `crates/vault-local-store-sqlite/src/error.rs` | stable non-secret failure classes |
| `crates/vault-local-store-sqlite/tests/` | process/barrier race and restart regression suites |
| `docs/verification/windows-actual-handle-sqlite-vfs.md` | commands, evidence, limitations, and final gate record |
| `docs/PRODUCT_BUILD_AND_DEPLOY_GUIDE.md` | update verified/partial/missing status only after evidence exists |

Files may be split further when a native module becomes too large, but responsibilities may not be collapsed into the store crate.

## 13. Deterministic Test Design

Tests use synthetic markers only. Process tests use explicit named barriers or IPC handshakes rather than timing sleeps.

### 13.1 Acquisition races

- replace or ABA-swap main after policy inspection and before VFS acquisition;
- hold an external write handle or writable mapping before acquisition;
- attempt a new write/delete open after acquisition;
- race creation of an initially absent WAL or SHM namespace;
- rewrite main or WAL with same-size A/B content at each barrier.

Success means rejection before application SQL or one complete, authenticated snapshot. Mixed state is never accepted.

### 13.2 WAL and SHM correctness

- clean-close database without WAL/SHM;
- committed crash-WAL;
- uncommitted WAL tail;
- WAL append, truncate, reset, replace, and large sparse growth;
- SHM create, replace, corrupt, map, lock, unmap, and close/restart;
- checkpoint and reopen under the single-process policy.

Success means stock SQLite commit visibility is preserved: the old committed state or the new committed state is visible, never an uncommitted or hybrid state.

### 13.3 Snapshot and authentication

- cancel, I/O error, panic boundary, and process exit during copy;
- destination page/memory cap exhaustion;
- wrong password with source write-event count zero;
- future version and current corruption byte preservation;
- authenticated current revisions, heads, and conflicts after restart.

### 13.4 Promotion

- approve A in RO and present B before RW open;
- mutate schema, row counts, envelope graph, or digest before `BEGIN IMMEDIATE`;
- hold an external writer during promotion;
- close or crash immediately before and after a commit.

Success means any changed state is rejected before application write and current transaction atomicity remains intact.

### 13.5 API and build boundary

- compile-fail extraction of raw connection, raw native handle, VFS internals, and secret-bearing types;
- unsafe code scan proving the store crate remains unsafe-free;
- synthetic plaintext marker scan across DB, WAL, SHM, logs, and supported snapshot artifacts;
- format, Clippy, focused tests, and full workspace tests.

## 14. Verification Commands and Evidence

The implementation plan will name focused test targets. Every completed phase also runs, when allowed by the host policy:

```text
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
git diff --check
```

An execution blocked by Windows Application Control is recorded as blocked, not passed. The prior `4551` policy failure must be separated from test assertion failures.

The verification document records:

- exact branch and commit;
- commands and exit codes;
- focused race-test matrix;
- VFS trace evidence that all SQLite file I/O stayed in one accepted handle family;
- wrong-password and future/corruption preservation evidence;
- plaintext-pattern scan scope;
- independent Daybreak/Codex Security review and remaining limitations.

## 15. Rollout and Rollback

### Rollout

1. Implement and test the native VFS in isolation with synthetic files.
2. Prove SHM/WAL feasibility and actual-handle trace coverage before store integration.
3. Integrate RO source acquisition and private snapshot.
4. Integrate RW promotion and store-lifetime guard.
5. Run the full regression and independent RED review.
6. Keep real-Secret input disabled after completion; proceed to the separate freshness/completeness-anchor design.

The public existing-vault entry point never silently chooses the old path-only flow when the bound VFS is unavailable.

### Rollback

The change does not alter the storage schema or crypto wire format. If the VFS implementation is reverted or disabled, the product returns to synthetic-only fail-closed behavior for existing real-Secret use. It does not migrate, repair, rewrite, or delete a vault to regain compatibility.

## 16. Acceptance Criteria

This design is implemented only when all criteria are evidenced:

- every SQLite main/WAL/SHM operation used by the supported flow is bound to the accepted actual handle family;
- existing and new external write/delete/mapping attempts are rejected at the defined boundary;
- no pathname fallback or external SHM trust remains;
- normal clean-close and crash-WAL recovery work;
- same-length rewrite, growth, reset, replacement, and RO-to-RW race tests pass deterministically;
- wrong password causes zero application source writes;
- future and corrupt sources are preserved;
- partial snapshots cannot be promoted;
- raw capabilities remain unexportable and unsafe stays isolated;
- focused and workspace verification completes, or every environmental block is explicitly reported;
- independent RED review has no unresolved Critical or Important issue in this slice;
- documentation still says synthetic-only and lists rollback/omission as unresolved.

## 17. Follow-on Security Work

The immediate next design after this slice is an authenticated monotonic completeness anchor covering:

- vault generation;
- canonical head set;
- complete record/revision commitment or Merkle root;
- deletion tombstones;
- key and recovery generation;
- previous checkpoint hash;
- a latest anchor protected outside main/WAL/SHM.

Only after that anchor, recovery/device-key work, independent crypto review, penetration testing, and recovery drills may the product consider opening the real-Secret gate.

## 18. User-Facing Implementation Record

During implementation, each phase will update:

- `docs/verification/windows-actual-handle-sqlite-vfs.md` inside the repository for reproducible technical evidence;
- `C:\Users\USER\Desktop\KeyAtlas_보안_설계_패키지_2026-08-29\06_RED_TEAM_중심_작업기록.md` for attack-focused decisions and residual risk;
- `C:\Users\USER\Desktop\KeyAtlas_보안_설계_패키지_2026-08-29\07_BLUE_TEAM_방어요약.md` for prevention, detection, recovery, and gate status;
- a phase-by-phase file/change journal in the same desktop folder, explaining what was built, where, why, how it was tested, and which commit contains it.

The desktop record is explanatory. The repository verification document and Git history are the authoritative implementation evidence.
