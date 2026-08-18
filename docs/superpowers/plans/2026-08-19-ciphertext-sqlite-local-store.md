# Ciphertext-only SQLite Local Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 합성 자격 증명 record를 의미 있는 평문 metadata 없이 SQLite의 immutable revision graph에 저장하고, 프로세스 재시작 뒤 올바른 합성 master password로만 인증·복원하며 stale writer의 암호문을 충돌함에 보존하는 첫 로컬 저장 adapter를 완성한다.

**Architecture:** `vault-crypto`는 canonical outer envelope 검사와 AAD metadata 파생을, `vault-local-core`는 session-bound persistence projection과 합성 successor 생성을, 새 `vault-local-store-sqlite` crate는 opaque BLOB·revision graph·exclusive process lock·two-stage open·CAS만 소유한다. 기존 DB는 반드시 no-create read-only preflight와 모든 current envelope 인증을 통과한 뒤에만 no-create writable WAL handle로 승격한다. future schema/wire, wrong password와 current corruption은 서로 다른 비쓰기 outcome으로 보존한다.

**Tech Stack:** Rust 1.95.0 (edition 2024), `rusqlite` 0.40.2 with bundled SQLite 3.53.2 and exactly the `bundled` + `load_extension` features (the latter only for safe runtime disable), `blake3` 1.8.5 in portable pure mode for streaming same-run logical digests, standard-library `std::fs::File::try_lock`, `tempfile` 3.27.0 for tests, existing `vault-crypto` 0.0.1-alpha.1, existing `vault-local-core` 0.0.1-alpha.1, `minicbor` 2.3.0, `thiserror` 2.0.20, `trybuild` 1.0.120, Cargo, rustfmt, Clippy.

**Spec:** `docs/superpowers/specs/2026-08-17-ciphertext-sqlite-local-store-design.md`

## Global Constraints

- 이 계획은 **합성 데이터 전용**이다. 실제 아이디, 비밀번호, API 키, Secret, recovery key, session cookie 또는 개인 금고 데이터를 입력·가져오기·저장하지 않는다.
- 합성 fixture는 기존 `SyntheticCredentialFixtureId`와 `DEMO_VALUE_ONLY_` 값만 사용한다. 자유 문자열, paste/import, CLI, browser, MCP, plugin 또는 network 입력 경로를 만들지 않는다.
- SQLite에는 password envelope, record envelope와 opaque `record_id`, `revision_id`, `wire_version`, `suite_id`, `key_epoch`, `padding_bucket`, head/conflict graph만 저장한다. provider, URL, account, organization/project, environment, secret, tag, note, connection, rotation state와 의미 있는 timestamp는 모두 item ciphertext 안에 둔다.
- 검색어와 파생 검색·관계 index는 DB나 item ciphertext에 저장하지 않는다. 후속 unlocked-memory index는 인증된 원본 관계 필드에서만 재구축한다.
- password/record envelope 하나는 1..=65,536 bytes, head는 5,000개, revision은 10,000개, conflict는 5,000개, record envelope 합계는 128 MiB로 제한한다.
- existing DB는 OS exclusive lock 뒤 `SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NOFOLLOW` no-create connection으로 먼저 검사한다. application ID, user version, schema, bounds, wire 분류, unlock과 모든 current revision 인증 전에는 writable connection을 만들지 않는다.
- `application_id=0x53564C54`, `user_version=1`이다. `user_version>1`은 v1 table query보다 먼저 file-level `SchemaUpgradeRequired`가 된다.
- writable current DB는 `SQLITE_OPEN_READ_WRITE | SQLITE_OPEN_NOFOLLOW`, 5초 busy timeout, `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `trusted_schema=OFF`, `SQLITE_DBCONFIG_DEFENSIVE=ON`을 적용하고 반환값을 재검증한다. rusqlite `load_extension` Cargo feature는 안전한 `load_extension_disable()` 호출에만 허용하고, store crate의 unsafe 금지와 source scan으로 runtime enable/load 호출을 금지한다.
- `revisions`는 append-only다. revision insert, expected-head CAS와 conflict insert는 하나의 short `BEGIN IMMEDIATE` transaction이다. LWW, 문자열 merge, 자동 repair/delete/overwrite를 하지 않는다.
- 같은 candidate bytes의 idempotency 판정은 CAS보다 먼저 한다. 기존 conflict mapping은 최초 expected/observed를 보존하고 현재 head 진행과 무관하게 `ConflictPreserved`; conflict가 없는 동일 revision은 `AlreadyCommitted`이다.
- 다른 vault candidate는 `WrongVaultCandidate`, 존재하지 않는 expected base 또는 head 없는 successor는 `MissingBase`이며 둘 다 어떤 row도 쓰거나 store를 corruption latch하지 않는다.
- higher schema/wire/inner schema는 `UpgradeRequired`, wrong password는 `AuthenticationFailed`, current schema/envelope/invariant 손상은 `ReadOnlyPreservation`이다. 세 경우 모두 자동 초기화·migration·write를 하지 않는다.
- current v0alpha1은 정상 DB/WAL 전체 rollback, valid head rollback과 완전한 row omission을 탐지하지 못한다. 이 한계를 문서와 verification에서 유지하고 실제 Secret 지원을 계속 차단한다.
- live WAL DB의 main 파일만 복사하거나 GitHub에 올리지 않는다. backup/export API는 이번 계획의 비범위다.
- envelope-bearing type은 blanket `Debug`, `Display`, `Serialize`, `Clone`, `Copy`를 갖지 않는다. opened secret getter, caller-provided ID/AAD/nonce/entropy와 public raw constructor를 추가하지 않는다.
- 오류, panic, log, assertion message에 DB path, SQL parameter, opaque ID, envelope, ciphertext 또는 합성 plaintext를 포함하지 않는다. public error는 안정적인 비민감 code만 반환한다.
- 각 Task는 focused RED → 최소 GREEN → 전체 회귀 → 명시적 stage → 한 커밋 순서로 끝낸다. `git add .`는 사용하지 않는다.
- 최종 gate는 `cargo metadata`, `cargo fmt --check`, Clippy `-D warnings`, full workspace tests single-threaded, trybuild, example, dependency tree, `git diff --check`와 bounded secret-pattern scan이다. 통과를 독립 암호 검토나 실제 Secret 출시 승인으로 표현하지 않는다.

---

## Planned File Structure

- `contracts/storage-v1/schema-v1.sql`: checked-in golden SQLite v1 DDL의 단일 원천.
- `contracts/storage-v1/README.md`: application/schema/wire version 분리와 Android Room 후속 BLOB/INTEGER 계약.
- `crates/vault-crypto/src/v0alpha1/storage.rs`: bounded first-version discriminator와 current password/record storage inspection.
- `crates/vault-crypto/tests/storage_inspection.rs`: canonical current/future/malformed envelope 경계.
- `crates/vault-local-core/src/persistence.rs`: private-field projection, envelope-only rehydrate와 closed synthetic successor API.
- `crates/vault-local-core/tests/persistence_boundary.rs`: restart projection, siblings, cross-vault와 compile-fail boundary.
- `crates/vault-local-store-sqlite/src/error.rs`: stable non-sensitive storage error/outcome codes.
- `crates/vault-local-store-sqlite/src/lock.rs`: adjacent advisory lock file의 exclusive lifetime guard.
- `crates/vault-local-store-sqlite/src/schema.rs`: golden DDL application/fingerprint and connection hardening.
- `crates/vault-local-store-sqlite/src/rows.rs`: bounded streaming row/header validation.
- `crates/vault-local-store-sqlite/src/digest.rs`: length-delimited, ordered streaming digest for same-run RO→RW change detection only.
- `crates/vault-local-store-sqlite/src/commit.rs`: immutable insert, idempotency-first CAS and conflict preservation.
- `crates/vault-local-store-sqlite/src/preflight.rs`: no-create read-only structural preflight, version ordering, opaque authentication handoff and writable promotion.
- `crates/vault-local-store-sqlite/src/store.rs`: public locked/writable store state and narrow synthetic APIs.
- `crates/vault-local-store-sqlite/tests/`: schema, CAS, restart, future/corruption, crash, raw-scan and compile-fail gates.

### Task 1: Add bounded outer-wire and storage metadata inspection to `vault-crypto`

**Files:**
- Create: `crates/vault-crypto/src/v0alpha1/storage.rs`
- Modify: `crates/vault-crypto/src/v0alpha1/mod.rs`
- Modify: `crates/vault-crypto/src/v0alpha1/codec.rs`
- Modify: `crates/vault-crypto/src/lib.rs`
- Modify: `contracts/v0alpha1/envelope.cddl`
- Create: `crates/vault-crypto/tests/storage_inspection.rs`
- Create: `crates/vault-crypto/tests/storage_traits.rs`
- Create: `crates/vault-crypto/tests/ui/storage_traits/inspection_constructor.rs`
- Create: `crates/vault-crypto/tests/ui/storage_traits/inspection_constructor.stderr`
- Create: `crates/vault-crypto/tests/ui/storage_traits/bootstrap_clone.rs`
- Create: `crates/vault-crypto/tests/ui/storage_traits/bootstrap_clone.stderr`

**Interfaces:**
- Consumes: existing strict `decode_password_envelope`, `decode_record_envelope`, `VaultCommitment`, `OpaqueRecordId`, `RevisionId`, `KeyEpoch`, `PaddingBucketV0Alpha1`.
- Produces: `inspect_password_envelope_for_storage_v1(&[u8]) -> Result<PasswordEnvelopeStorageDispositionV1<'_>, CryptoError>` and `inspect_record_envelope_for_storage_v1(&[u8]) -> Result<RecordEnvelopeStorageDispositionV1<'_>, CryptoError>`; their current variants provide private-field borrowed bootstrap/record projections.

- [ ] **Step 1: Write focused RED tests**

Create `storage_inspection.rs` with tests named exactly:

```rust
#[test]
fn current_password_and_record_metadata_are_derived_from_canonical_envelopes() {}

#[test]
fn future_first_version_with_changed_field_count_and_unknown_tail_is_preserved() {}

#[test]
fn empty_indefinite_nonminimal_trailing_and_oversized_inputs_are_rejected() {}
```

The current test creates a synthetic vault and record, asserts wire `0`, suite `0xA101`, exact commitment/record/revision/epoch/bucket values from getters, and never parses test bytes independently. The future test uses canonical CBOR arrays `[1]` and `[2, h'0102', 42]`, asserts `FutureWire(1)`/`FutureWire(2)`, and verifies the borrowed input slices are unchanged. The malformed matrix includes empty bytes, zero-field array, indefinite array, nonminimal encoding of `1`, trailing current byte and 65,537 bytes. A canonical current-shape unknown suite must be `UnsupportedSuite`, while malformed current-shape unknown-suite bytes must be rejected as corruption rather than upgrade.

- [ ] **Step 2: Run RED**

Run:

```powershell
cargo test -p vault-crypto --test storage_inspection -- --test-threads=1
```

Expected: compile failure because the three storage inspection exports do not exist.

- [ ] **Step 3: Implement the exact public surface with private fields**

Add these declarations to `storage.rs`:

```rust
pub enum PasswordEnvelopeStorageDispositionV1<'a> {
    Current(PasswordEnvelopeStorageInspectionV1<'a>),
    FutureWire(FutureWireStorageInspectionV1),
    UnsupportedSuite(CurrentSuiteStorageInspectionV1),
}

pub enum RecordEnvelopeStorageDispositionV1<'a> {
    Current(RecordEnvelopeStorageInspectionV1<'a>),
    FutureWire(FutureWireStorageInspectionV1),
    UnsupportedSuite(CurrentSuiteStorageInspectionV1),
}

pub struct PasswordEnvelopeStorageInspectionV1<'a> {
    wire_version: u32,
    suite_id: u32,
    vault_commitment: VaultCommitment,
    envelope: &'a [u8],
}

pub struct RecordEnvelopeStorageInspectionV1<'a> {
    wire_version: u32,
    suite_id: u32,
    vault_commitment: VaultCommitment,
    record_id: OpaqueRecordId,
    revision_id: RevisionId,
    key_epoch: KeyEpoch,
    padding_bucket: PaddingBucketV0Alpha1,
    envelope: &'a [u8],
}

pub struct PasswordEnvelopeBootstrapProjectionV1<'a> {
    wire_version: u32,
    suite_id: u32,
    vault_commitment: [u8; 32],
    envelope: &'a [u8],
}
```

Only add copy-returning getters for numeric values, borrowed exact `envelope()`, byte-array references for opaque values, and `PasswordEnvelopeStorageInspectionV1::bootstrap_projection()`. The bootstrap projection copies only the non-secret commitment/numbers and borrows the exact envelope; it has no public constructor. Do not expose salt, nonce, wrapped Root Key, encrypted body, `Debug`, serialization, raw setters or public constructors. The shared first-version discriminator must enforce 1..=65,536 bytes, a definite array with at least one field, a minimal canonical unsigned first value, and no requirement about the future tail. Version `1..=u32::MAX` returns `FutureWire`; values above `u32::MAX` return `LimitsExceeded`. Version `0` must fully validate current shape/canonical bytes before it can return either `Current` or `UnsupportedSuite`. Add a comment-only future-prefix preservation rule to the CDDL; do not change current wire bytes or field counts.

For the two current inspectors, call the existing strict decoder and convert its validated borrowed fields to fixed typed values. Add crate-private conversion helpers in `codec.rs`; do not duplicate the canonical decoder. A future input passed to a current inspector remains `UnsupportedVersion`.

- [ ] **Step 4: Run focused and full crypto verification**

```powershell
cargo test -p vault-crypto --test storage_inspection -- --test-threads=1
cargo test -p vault-crypto --test storage_traits -- --test-threads=1
cargo test -p vault-crypto --all-features -- --test-threads=1
cargo fmt --all -- --check
cargo clippy -p vault-crypto --all-targets --all-features -- -D warnings
```

Expected: all pass; existing vector fixture SHA remains unchanged.

- [ ] **Step 5: Commit**

```powershell
git add contracts/v0alpha1/envelope.cddl crates/vault-crypto/src/lib.rs crates/vault-crypto/src/v0alpha1/mod.rs crates/vault-crypto/src/v0alpha1/codec.rs crates/vault-crypto/src/v0alpha1/storage.rs crates/vault-crypto/tests/storage_inspection.rs crates/vault-crypto/tests/storage_traits.rs crates/vault-crypto/tests/ui/storage_traits
git diff --cached --check
git commit -m "feat: inspect vault envelopes for storage"
```

### Task 2: Add the closed persistence boundary and synthetic successor API

**Files:**
- Create: `crates/vault-local-core/src/persistence.rs`
- Modify: `crates/vault-local-core/src/lib.rs`
- Modify: `crates/vault-local-core/src/ids.rs`
- Modify: `crates/vault-local-core/src/record.rs`
- Modify: `crates/vault-local-core/src/model.rs`
- Modify: `crates/vault-local-core/src/error.rs`
- Create: `crates/vault-local-core/tests/persistence_boundary.rs`
- Modify: `crates/vault-local-core/tests/secret_traits.rs`
- Create: `crates/vault-local-core/tests/ui/secret_traits/projection_constructor.rs`
- Create: `crates/vault-local-core/tests/ui/secret_traits/projection_constructor.stderr`
- Create: `crates/vault-local-core/tests/ui/secret_traits/sealed_clone.rs`
- Create: `crates/vault-local-core/tests/ui/secret_traits/sealed_clone.stderr`

**Interfaces:**
- Consumes: Task 1 storage metadata inspectors, existing seal/open functions and typed IDs.
- Produces: borrowed `CredentialCommitPersistenceProjectionV1<'_>`, `CredentialStorageAuthenticatorV1<'_>`, borrowed `StoredCredentialAuthenticationOutcomeV1<'_>` for streaming proof, owned `OwnedRehydratedCredentialOutcomeV1` for current-head runtime restore, `SyntheticCredentialSuccessorV1`, and `create_synthetic_successor_v1`.

- [ ] **Step 1: Write RED persistence tests**

The integration tests must cover:

```rust
#[test]
fn sealed_fixture_projects_and_rehydrates_without_caller_locator_fields() {}

#[test]
fn two_successors_keep_the_record_id_and_receive_distinct_csprng_revisions() {}

#[test]
fn cross_vault_rehydrate_fails_without_mutating_the_envelope() {}
```

The first test seals `SingleMcpConnection`, borrows its projection, copies only the projection's opaque columns and canonical envelope into test storage, drops the original sealed value, then uses a session-bound authenticator on the envelope alone and authenticates provider/connection count through the existing normal open path. The second creates two siblings from one predecessor and asserts same record ID, distinct revision IDs and the same expected predecessor ID. No test may supply an ID, AAD, nonce or entropy to a production function.

- [ ] **Step 2: Run RED**

```powershell
cargo test -p vault-local-core --test persistence_boundary -- --test-threads=1
```

Expected: compile failure because persistence exports do not exist.

- [ ] **Step 3: Add exact private-field types and functions**

Use this public shape in `persistence.rs`:

```rust
pub struct CredentialCommitPersistenceProjectionV1<'a> {
    vault_commitment: &'a [u8; 32],
    record_id: RecordIdV1,
    revision_id: RevisionIdV1,
    expected_revision_id: Option<RevisionIdV1>,
    wire_version: u32,
    suite_id: u32,
    key_epoch: u32,
    padding_bucket: StoredPaddingBucketV0Alpha1,
    envelope: &'a [u8],
}

pub struct CredentialStorageAuthenticatorV1<'session> {
    session: &'session VaultSession,
}

pub enum StoredCredentialAuthenticationOutcomeV1<'a> {
    Current(AuthenticatedStoredCredentialRevisionV1<'a>),
    AuthenticatedFutureInner(PreservedStoredCredentialEnvelopeV1<'a>),
}

pub struct AuthenticatedStoredCredentialRevisionV1<'a> {
    envelope: &'a [u8],
    record_id: RecordIdV1,
    revision_id: RevisionIdV1,
    parent_revision_id: Option<RevisionIdV1>,
    key_epoch: u32,
    padding_bucket: StoredPaddingBucketV0Alpha1,
}

pub struct SyntheticCredentialSuccessorV1 {
    sealed: SealedCredentialRecordV0Alpha1,
    expected_revision_id: RevisionIdV1,
}

pub enum OwnedRehydratedCredentialOutcomeV1 {
    Current(OwnedRehydratedCredentialV1),
    UpgradeRequired(OwnedPreservedCredentialEnvelopeV1),
}
```

Provide read-only getters returning fixed-size copied IDs/numbers, `expected_revision_id()`, `vault_commitment()`, and borrowed exact `envelope()`. Provide no raw constructor and no blanket clone/format/serialize traits. `SealedCredentialRecordV0Alpha1::persistence_projection_v1()` returns an initial borrowed projection with `expected=None`; `SyntheticCredentialSuccessorV1::persistence_projection_v1()` returns a borrowed projection with its fixed predecessor.

`CredentialStorageAuthenticatorV1::new(session)` is the only session handoff and exposes only its non-secret vault commitment plus the two methods below; store code accepts this capability, never a `VaultSession`:

```rust
pub fn authenticate_stored_credential_v1<'a>(
    &self,
    envelope: &'a [u8],
) -> Result<StoredCredentialAuthenticationOutcomeV1<'a>, LocalVaultError>;

pub fn rehydrate_owned_stored_credential_v1(
    &self,
    envelope: Vec<u8>,
) -> Result<OwnedRehydratedCredentialOutcomeV1, LocalVaultError>;
```

Both derive all locator fields from Task 1 current record inspection, verify commitment/epoch, AEAD-open and strict-decode the inner item, and never accept cache columns. The borrowed method captures authenticated `parent_revision_id`, immediately drops opened plaintext and returns a receipt borrowing the exact input envelope. The owned method reuses the same validation and returns a private-field current sealed owner for app/head restore; future outcome owns the unchanged Vec and remains read-only. Future outer/suite is classified before these methods; authenticated future inner returns the appropriate preserved outcome.

`create_synthetic_successor_v1(session, predecessor)` must authenticate/open the predecessor first, preserve its record ID and synthetic item, draw exactly one new 32-byte revision with `getrandom::fill`, set authenticated `parent_revision_id` and expected revision to the predecessor revision, validate/encode/seal with the current session epoch and return the closed successor. Add a crate-private deterministic entropy seam for unit tests only.

- [ ] **Step 4: Lock the public boundary with trybuild**

Add compile-fail cases proving callers cannot construct `CredentialCommitPersistenceProjectionV1`, `CredentialStorageAuthenticatorV1` or authentication receipts, clone a sealed/projection/authenticator value, create IDs from bytes, or pass entropy/AAD/nonce. Update the trybuild harness with exact fixture paths and accept `.stderr` only after confirming each failure is caused by the intended private field/absent trait/absent function.

- [ ] **Step 5: Verify and commit**

```powershell
cargo test -p vault-local-core --test persistence_boundary -- --test-threads=1
cargo test -p vault-local-core --test secret_traits -- --test-threads=1
cargo test -p vault-local-core --all-features -- --test-threads=1
cargo fmt --all -- --check
cargo clippy -p vault-local-core --all-targets --all-features -- -D warnings
git add crates/vault-local-core/src/lib.rs crates/vault-local-core/src/ids.rs crates/vault-local-core/src/record.rs crates/vault-local-core/src/model.rs crates/vault-local-core/src/error.rs crates/vault-local-core/src/persistence.rs crates/vault-local-core/tests/persistence_boundary.rs crates/vault-local-core/tests/secret_traits.rs crates/vault-local-core/tests/ui/secret_traits
git diff --cached --check
git commit -m "feat: add credential persistence boundary"
```

### Task 3: Create the SQLite crate, golden schema and hardened connection boundary

**Files:**
- Modify: `Cargo.toml`
- Modify: `Cargo.lock`
- Create: `contracts/storage-v1/schema-v1.sql`
- Create: `contracts/storage-v1/README.md`
- Create: `crates/vault-local-store-sqlite/Cargo.toml`
- Create: `crates/vault-local-store-sqlite/src/lib.rs`
- Create: `crates/vault-local-store-sqlite/src/error.rs`
- Create: `crates/vault-local-store-sqlite/src/lock.rs`
- Create: `crates/vault-local-store-sqlite/src/schema.rs`
- Create: `crates/vault-local-store-sqlite/tests/schema_contract.rs`
- Create: `crates/vault-local-store-sqlite/tests/lock_and_flags.rs`

**Interfaces:**
- Consumes: Task 1 password inspection, Task 2 projection types. Store code may import only session-free inspection/projection types, never `MasterPassword`, `VaultSession`, seal/open/create/unlock functions or plaintext models.
- Produces: `initialize_v1(location, PasswordEnvelopeBootstrapProjectionV1<'_>) -> InitializeStoreOutcomeV1`, where only a genuinely new zero-byte store returns `Created(SyntheticWritableStoreV1)` and an exact existing store returns non-writable `AlreadyInitialized`; also `StoreLockV1`, `StorageError`, `StorageErrorCode`, exact `SCHEMA_V1_SQL` and hardened connection helpers.

- [ ] **Step 1: Pin dependencies and write RED schema tests**

Add exact workspace dependencies:

```toml
blake3 = { version = "=1.8.5", default-features = false, features = ["pure"] }
rusqlite = { version = "=0.40.2", default-features = false, features = ["bundled", "load_extension"] }
tempfile = "=3.27.0"
```

Add the new member and a crate manifest depending on `blake3`, `rusqlite`, `thiserror`, `vault-crypto`, `vault-local-core`; use `tempfile` only as a dev-dependency. Enable rusqlite `load_extension` solely so the safe `load_extension_disable()` hardening call is available; the store crate must declare `#![forbid(unsafe_code)]`, so the unsafe enable/load APIs cannot be called. Do not enable `functions`, `backup`, `serialize` or `bundled-sqlcipher`. Assert the feature tree is exactly the allowed set, source-scan the store crate for `load_extension_enable`/`load_extension(`, and assert `rusqlite::version() == "3.53.2"` so lockfile/source drift fails visibly.

Write tests asserting application ID `0x53564C54`, user version `1`, four exact application tables, four exact immutable triggers, foreign keys, column declared types/constraints and rejection of revision/conflict UPDATE/DELETE/`INSERT OR REPLACE`. Every numeric metadata column must have final stored `typeof(...)='integer'` and reject values that remain REAL/TEXT after SQLite affinity as well as out-of-range integers; the contract does not claim to distinguish a losslessly coerced SQL literal from an integer after affinity. Production inserts bind Rust integer parameters. Add a second test opening the same lock path twice; the second `try_lock` returns stable `Busy`, and dropping the first guard allows a new guard.

- [ ] **Step 2: Run RED**

```powershell
cargo test -p vault-local-store-sqlite --test schema_contract -- --test-threads=1
cargo test -p vault-local-store-sqlite --test lock_and_flags -- --test-threads=1
```

Expected: compile failure because the crate/API does not exist.

- [ ] **Step 3: Check in the exact golden DDL**

Copy the complete SQL block from approved spec section 5, unchanged, into `contracts/storage-v1/schema-v1.sql`: both pragmas, `vault_state`, `revisions`, `heads`, `conflicts`, and the four immutable revision/conflict triggers. `schema.rs` must use `include_str!("../../../contracts/storage-v1/schema-v1.sql")`; do not keep a second DDL string.

The fingerprint validator compares in fixed order: application-owned object names/types, `table_xinfo`, PK positions, `foreign_key_list`, `index_list`, and whitespace-normalized trigger SQL. Unknown application table/index/trigger or any mismatch returns `CorruptStorage`; it never executes migration.

- [ ] **Step 4: Implement lock and connection hardening**

`StoreLockV1::try_acquire(db_path: &Path)` opens an adjacent non-secret `.lock` file read/write/create, calls stable Rust 1.95 `std::fs::File::try_lock`, owns the file for its lifetime and maps `TryLockError::WouldBlock` to `Busy`. `StoreLocationPolicyV1` accepts only an OS-provided trusted local app-data root plus a DB path beneath it. It scans every ancestor from target through that root inclusive for `.git`/`.hg`/`.svn` markers and provider-prefixed cloud components such as `OneDrive - Personal`, but intentionally stops at the trusted root; user-profile/volume ancestors above it are outside the policy boundary. Reject a trusted root that is itself network/cloud. Add tests for a repository marker at arbitrary depth inside the root, cloud-prefixed components, and a `.git` above the trusted root that must not reject an otherwise valid app-data path.

Use `Connection::open_with_flags` with exact flags and no URI mode. Common flags are `NO_MUTEX | PRIVATE_CACHE | NOFOLLOW | EXRESCODE`; read-only adds `READ_ONLY`, existing writable adds `READ_WRITE`, and only the explicit zero-byte initialization path adds `READ_WRITE | CREATE`. Set `busy_timeout(Duration::from_secs(5))` and call `load_extension_disable()`. On writable connections call and verify `DEFENSIVE=true`, `TRUSTED_SCHEMA=false`, `ENABLE_FKEY=true`, `ENABLE_TRIGGER=true`, `DQS_DML=false`, `DQS_DDL=false`, `ENABLE_ATTACH_CREATE=false`, `ENABLE_ATTACH_WRITE=false`; verify `is_readonly(MAIN_DB)==false`, `journal_mode=wal` and `synchronous=2`. If NOFOLLOW or required config is unavailable/error, return `UnsupportedPlatform`; never retry with weaker flags.

Define stable public codes: `Busy`, `Io`, `UnsupportedPlatform`, `SchemaUpgradeRequired`, `CryptoUpgradeRequired`, `AuthenticationFailed`, `CorruptStorage`, `InvariantViolation`, `LimitsExceeded`, `WrongVaultCandidate`, `MissingBase`. The error display text contains only the code-level description.

- [ ] **Step 5: Implement atomic zero-byte initialization**

`initialize_v1(location, bootstrap)` acquires the OS lock first and permits `CREATE` only when the target does not exist or is exactly zero bytes. Record which of those two byte states existed before opening. In one `BEGIN IMMEDIATE` transaction it applies the golden DDL and inserts singleton `1` from the private-field bootstrap projection after rechecking its current inspection. Commit only after application ID, user version, schema fingerprint and singleton readback all match. Any nonempty file, partial schema, missing singleton or version-zero file enters read-only preservation and is never completed/reset.

An already valid v1 store passed to initialization is opened only far enough to compare the bootstrap projection: byte-identical password wire/suite/envelope returns non-writable `AlreadyInitialized`; any difference returns `InvariantViolation` without overwrite. `AlreadyInitialized` owns no connection and the caller must use the normal Task 5–6 preflight/unlock/authentication flow before writing. Add tests for failure after writable hardening and at each initialization statement using a crate-private test executor seam. Acquire the original main-file ownership handle before SQLite open/create, retain it through SQLite close and never reacquire it by pathname. After close, first perform a no-mutation check for lingering WAL/SHM/journal and pathname↔handle identity. If either is anomalous, perform no truncate, sync, unlink or pathname mutation and return preservation failure. Only the clean branch truncates+syncs the exact ownership handle to zero, then rechecks identity/sidecars; an originally absent target may therefore become a safe call-owned zero-byte retry state, while a pre-existing zero-byte target remains zero. Clean failpoint cases must restore zero/no-sidecar and allow retry. Separate injected lingering-sidecar and rename-and-replace cases must return preservation with replacement/sidecar bytes unchanged and no retryability assertion. If retained-handle semantics cannot be guaranteed on a platform, return `UnsupportedPlatform` rather than weaken cleanup. Assert no half schema/singleton remains.

- [ ] **Step 6: Verify dependency features and commit**

```powershell
cargo metadata --format-version 1 --no-deps
cargo tree -p vault-local-store-sqlite -e features
cargo test -p vault-local-store-sqlite --test schema_contract -- --test-threads=1
cargo test -p vault-local-store-sqlite --test lock_and_flags -- --test-threads=1
cargo fmt --all -- --check
cargo clippy -p vault-local-store-sqlite --all-targets --all-features -- -D warnings
git add Cargo.toml Cargo.lock contracts/storage-v1 crates/vault-local-store-sqlite/Cargo.toml crates/vault-local-store-sqlite/src/lib.rs crates/vault-local-store-sqlite/src/error.rs crates/vault-local-store-sqlite/src/lock.rs crates/vault-local-store-sqlite/src/schema.rs crates/vault-local-store-sqlite/tests/schema_contract.rs crates/vault-local-store-sqlite/tests/lock_and_flags.rs
git diff --cached --check
git commit -m "feat: add hardened sqlite store boundary"
```

### Task 4: Implement immutable candidate commit and idempotency-first CAS

**Files:**
- Create: `crates/vault-local-store-sqlite/src/commit.rs`
- Create: `crates/vault-local-store-sqlite/src/store.rs`
- Modify: `crates/vault-local-store-sqlite/src/lib.rs`
- Modify: `crates/vault-local-store-sqlite/src/schema.rs`
- Create: `crates/vault-local-store-sqlite/tests/commit_cas.rs`

**Interfaces:**
- Consumes: `CredentialCommitPersistenceProjectionV1<'_>`, initialized schema and locked writable connection.
- Produces: `SyntheticWritableStoreV1::commit_candidate(CredentialCommitPersistenceProjectionV1<'_>) -> Result<CommitOutcomeV1, StorageError>` with `Committed`, `AlreadyCommitted`, `ConflictPreserved`.

- [ ] **Step 1: Write the complete RED CAS matrix**

Public integration tests must cover initial commit, correct successor, two siblings, winner retry after a later head, stale conflict retry after a later head, different-vault candidate and missing expected base using only closed Task 2 projections. Snapshot table counts and canonical head before each rejected case and assert no change afterward. Edge cases that cannot be produced through the closed public API — same PK/different persistent bytes, existing conflict with changed expected, headless successor and initial candidate for an existing record — belong in `commit.rs` crate-private unit tests over a private `PreparedCandidateV1` and private DB fixture seam. The invariant tests must then submit a known-good candidate after the latch is set and prove stable `InvariantViolation`, unchanged logical DB state, and a private SQL-access counter of zero for that second call. Cover both same-PK persistent-byte mismatch and projection/envelope metadata mismatch as latch triggers. No public raw projection/ID/SQL constructor may be added for testing.

- [ ] **Step 2: Run RED**

```powershell
cargo test -p vault-local-store-sqlite --test commit_cas -- --test-threads=1
```

Expected: compile failure because writable store/commit API does not exist.

- [ ] **Step 3: Implement one `BEGIN IMMEDIATE` algorithm in the approved order**

Use `transaction_with_behavior(TransactionBehavior::Immediate)`. Before any insert:

1. Strictly inspect projection/envelope metadata and compare all cached columns.
2. Compare candidate commitment to the current password-envelope commitment; mismatch returns `WrongVaultCandidate` and rolls back without latching.
3. Query same PK before base/head validation or CAS. Different stored fields/envelope rolls back, returns `InvariantViolation`, and one-way latches this writable handle so every later commit returns `InvariantViolation` without DB access. Same bytes with a conflict row verifies only stored expected; mismatch is an invariant violation before any base lookup, while a match returns `ConflictPreserved` without comparing/changing observed. Same bytes without a conflict row returns `AlreadyCommitted` regardless of current head or supplied expected because canonical revisions do not persist expected provenance.
4. Only for a new PK with expected set, require both the same-record base revision and current head; missing returns `MissingBase` and rolls back without latching.
5. Only for a new PK, insert the immutable revision and perform initial/head CAS. Every revision, initial-head and conflict plain `INSERT` must report exactly one affected row; `Ok(0)` (including a later `RAISE(IGNORE)` trigger) or any other unexpected count rolls back and one-way latches before returning `InvariantViolation`. Successor head `UPDATE` accepts only `1` as committed and `0` as the stale-conflict path. On mismatch insert one conflict row with first expected/observed and keep head unchanged. Add private trigger fixtures proving ignored revision/head/conflict inserts cannot commit an orphan, and the later known-good call performs zero SQL after latch. `WrongVaultCandidate` and `MissingBase` never latch; projection/envelope metadata mismatch follows the same invariant latch as a same-PK byte mismatch.

Do not expose SQL connection or generic execute/query APIs. Do not add update/delete methods.

- [ ] **Step 4: Verify and commit**

```powershell
cargo test -p vault-local-store-sqlite --test commit_cas -- --test-threads=1
cargo test -p vault-local-store-sqlite --all-features -- --test-threads=1
cargo fmt --all -- --check
cargo clippy -p vault-local-store-sqlite --all-targets --all-features -- -D warnings
git add crates/vault-local-store-sqlite/src/lib.rs crates/vault-local-store-sqlite/src/schema.rs crates/vault-local-store-sqlite/src/commit.rs crates/vault-local-store-sqlite/src/store.rs crates/vault-local-store-sqlite/tests/commit_cas.rs
git diff --cached --check
git commit -m "feat: preserve immutable sqlite revisions"
```

### Task 5: Implement bounded, write-free structural preflight

**Files:**
- Create: `crates/vault-local-store-sqlite/src/rows.rs`
- Create: `crates/vault-local-store-sqlite/src/digest.rs`
- Create: `crates/vault-local-store-sqlite/src/schema_contract.rs`
- Create: `crates/vault-local-store-sqlite/src/preflight_query.rs`
- Create: `crates/vault-local-store-sqlite/src/preflight.rs`
- Modify: `crates/vault-local-store-sqlite/src/schema.rs`
- Modify: `crates/vault-local-store-sqlite/src/lib.rs`
- Create: `crates/vault-local-store-sqlite/tests/preflight.rs`
- Create: `crates/vault-local-store-sqlite/tests/bounds.rs`

**Interfaces:**
- Consumes: Task 1 classifiers plus Task 3's process lock and store location. It extracts Task 3's application/schema constants, shared read-only flag policy and pure schema-verification data types into `schema_contract.rs`; both Task 3 and Task 5 consume that pure contract. Task 5 must not call Task 3's connection-returning `open_read_only` or connection-backed `verify_schema_fingerprint`/`schema_fingerprint` acquisition path. It does not import or accept `VaultSession`, `MasterPassword`, create/unlock/seal/open functions or plaintext models.
- Produces: `preflight_existing_v1(location) -> Result<ExistingVaultPreflightOutcomeV1, StorageError>`, private-field `ExistingVaultPreflightV1`, streaming `UntrustedStoredRevisionV1<'row>`, and non-writing `SchemaUpgradeRequired`, `CryptoUpgradeRequired`, `ReadOnlyPreservation` outcomes.

- [ ] **Step 1: Write RED ordering and non-writing outcome tests**

Tests must prove: a valid current store returns `ExistingVaultPreflightV1`; a higher user version returns schema upgrade before any v1 table query; future outer/current unknown suite returns crypto upgrade; malformed current row returns preservation. For every terminal outcome compare main and an actually live pre-existing `-wal` byte-for-byte before/after and compare logical row counts; ignore transient `-shm` bookkeeping only. Do not enable rusqlite's `trace` feature.

`preflight_query.rs` is the **only preflight-reachable module that may import or receive `rusqlite::Connection`, `Statement` or `Row`, open a SQLite connection, or execute SQL**. `PreflightQueryGate::open_read_only(path)` opens the no-create connection itself with the exact shared `schema_contract::read_only_open_flags()` policy; Task 3's `schema::open_read_only` is refactored to use the same pure flag policy but is never called from Task 5. The gate owns the connection and exposes only fixed operations backed by a closed private `PreflightQueryStage` enum; callers cannot supply a stage label, SQL or closure that receives a raw rusqlite handle. The gate invokes a `cfg(test)` observer immediately before **each actual fixed SQL statement**, including application ID, user version, schema objects, `table_xinfo`, foreign keys, indexes, integrity checks, row pages and digest reads. A wrapper that emits one observation around several interior queries is forbidden.

Move application/schema constants, `read_only_open_flags()`, `SchemaSnapshotV1`-style captured typed data and pure normalization/comparison functions into `schema_contract.rs`; that module accepts no connection, statement or row and executes no SQL. Existing Task 3 connection-backed acquisition wrappers remain in `schema.rs`, consume the pure contract, and are retained only for Task 3 initialization/tests. `PreflightQueryGate` must issue every Task 5 schema/integrity query itself, build the captured typed data, and pass only that data to the pure verifier. `preflight.rs`, `rows.rs` and `digest.rs` accept only `&mut PreflightQueryGate`, never raw rusqlite handles, and may import only the pure schema contract—not `schema.rs`; `ExistingVaultPreflightV1` lives in `preflight.rs` and owns the gate plus process lock, so Task 5 does not modify or route through writable `store.rs`. Add compile/source boundary checks over the exact Task 5 preflight modules (`preflight.rs`, `rows.rs`, `digest.rs`, `schema_contract.rs`, and their `lib.rs` exports): outside `preflight_query.rs`, reject `rusqlite::{Connection, Statement, Row}` and all direct SQL entry families (`open*`, `prepare*`, `query*`, `execute*`, `pragma*`, `transaction*`); in Task 5 call paths reject any import or call from `schema.rs`, including the old read-only opener and connection-backed fingerprint helpers. The higher-version fixture must observe exactly `[ApplicationId, UserVersion]`; the claim is limited to no additional **application-issued** v1/fingerprint/integrity SQL, not SQLite engine-internal catalog work. Assert Cargo features remain exactly `bundled + load_extension`. Wrong-password and authenticated future-inner tests belong to Task 6 because this task performs no unlock.

- [ ] **Step 2: Write RED bounded-loader tests**

Use synthetic databases at cap and cap+1 for heads/revisions/conflicts, 128 MiB aggregate revision-envelope boundary via `length(envelope)` values, zero-length and 65,537-byte BLOBs, malformed ID widths, and numeric cache values that remain REAL/TEXT after affinity. Instrument the row reader under `cfg(test)` to prove it checks SQL `typeof`/`length()` before obtaining or copying BLOB bytes, streams one row at a time, uses checked aggregate addition, and never collects all envelopes or reserves from attacker-controlled count.

- [ ] **Step 3: Implement the read-only structural half of the state machine**

With the exclusive lock held:

1. Acquire the exclusive process lock, then call only `PreflightQueryGate::open_read_only(location.database_path())`; the gate opens no-create read-only with the shared pure flag policy and retains the connection.
2. Read `application_id`; reject mismatch/nonempty version zero as preservation.
3. Read `user_version` before schema queries; `>1` returns schema upgrade immediately.
4. For v1 only, use `PreflightQueryGate` fixed operations to capture the schema snapshot, pass it to the pure schema verifier, then validate integrity, foreign keys and caps using `cap+1` keyset pagination. No Task 3 connection-backed schema acquisition helper is called.
5. Classify password/record first-version prefix. Strictly inspect current outer envelopes and compare derived metadata; preserve future bytes without trusting legacy cache columns beyond wire-version equality.
6. Return `ExistingVaultPreflightV1` owning the read-only connection, process lock, password envelope and logical digest. It exposes `password_envelope(&self) -> &[u8]` and later streams private-field `UntrustedStoredRevisionV1<'row>` only inside a borrowing callback; no `Row`, `Statement`, BLOB borrow or cache locator can escape, and no raw SQL handle is exposed. Task 6 must consume this preflight, finish/drop statements, explicitly close only the read-only connection while retaining the same lock, then open no-create writable and revalidate; it must never drop/reacquire the lock between stages.

The bounded loader uses keyset pagination and `cap+1`, checks `typeof` and SQL `length()` before BLOB allocation, and checked-adds aggregate size. It must reject INTEGER cache values stored as REAL/TEXT. Higher `user_version` must be proven by the closed private query-gate observer to issue only application-ID/user-version operations while the dependency tree remains exactly `bundled + load_extension`. The exact digest byte stream is: ASCII `SVLT-LOCAL-DIGEST-V1`; then for each table in fixed order `vault_state=0x01`, `revisions=0x02`, `heads=0x03`, `conflicts=0x04`, append `TABLE=0x54 || one-byte table tag`; for every row in that table's primary-key byte order append `ROW=0x52`, then every DDL column in 1-based ordinal order; after the last row append `END_TABLE=0x45`. Each field is `one-byte ordinal || type tag || u64 big-endian payload length || payload`, with `NULL=0x00`, `INTEGER=0x01`, `BLOB=0x02`. INTEGER payload is exactly 8-byte signed two's-complement big-endian; BLOB payload is the exact bytes; NULL has length zero. Each table's fixed DDL column count plus explicit row/table markers makes the stream unambiguous, and nullable expected-head is distinct from an empty BLOB. Tests mutate every field class to cause a mismatch and prove different insertion order yields the same logical digest. This digest detects changes between this process's read-only and writable stages only; schema/pragma are revalidated separately, and the digest is not persisted, authenticated, or described as rollback/omission protection.

- [ ] **Step 4: Verify and commit**

```powershell
cargo test -p vault-local-store-sqlite --test preflight -- --test-threads=1
cargo test -p vault-local-store-sqlite --test bounds -- --test-threads=1
cargo test -p vault-local-store-sqlite --all-features -- --test-threads=1
cargo fmt --all -- --check
cargo clippy -p vault-local-store-sqlite --all-targets --all-features -- -D warnings
git add crates/vault-local-store-sqlite/src/lib.rs crates/vault-local-store-sqlite/src/schema.rs crates/vault-local-store-sqlite/src/schema_contract.rs crates/vault-local-store-sqlite/src/rows.rs crates/vault-local-store-sqlite/src/digest.rs crates/vault-local-store-sqlite/src/preflight_query.rs crates/vault-local-store-sqlite/src/preflight.rs crates/vault-local-store-sqlite/tests/preflight.rs crates/vault-local-store-sqlite/tests/bounds.rs
git diff --cached --check
git commit -m "feat: preflight encrypted sqlite stores"
```

### Task 6: Authenticate, promote, restore after restart and prove no plaintext-at-rest

**Files:**
- Create: `crates/vault-local-store-sqlite/tests/restart_roundtrip.rs`
- Create: `crates/vault-local-store-sqlite/tests/future_and_corruption.rs`
- Create: `crates/vault-local-store-sqlite/tests/plaintext_scan.rs`
- Create: `crates/vault-local-store-sqlite/examples/synthetic_sqlite_roundtrip.rs`
- Modify: `crates/vault-local-store-sqlite/src/preflight.rs`
- Modify: `crates/vault-local-store-sqlite/src/rows.rs`
- Modify: `crates/vault-local-store-sqlite/src/store.rs`

**Interfaces:**
- Consumes: Task 2 `CredentialStorageAuthenticatorV1`/borrowed and owned authentication outcomes and Task 5 `ExistingVaultPreflightV1`.
- Produces: `ExistingVaultPreflightV1::authenticate_current_revisions(&CredentialStorageAuthenticatorV1<'_>)`, private-field `AuthenticatedVaultPreflightV1`, `AuthenticatedVaultPreflightV1::promote() -> ExistingVaultOpenOutcomeV1`, encrypted current-head owners for app restore, executable restart proof and adversarial preservation regression. Store source still imports no session/password/plaintext type.

- [ ] **Step 1: Add the restart test and safe example**

The test performs create vault → initialize DB → seal/commit fixture → drop session/store → structural preflight → caller reads password envelope and invokes existing `unlock_vault_v0alpha1` outside the store crate → caller creates `CredentialStorageAuthenticatorV1` → store streams each row through that capability → store compares exact borrowed envelope and envelope-derived receipt metadata to its cache → parent graph validation → authenticated stage → promote → integration layer opens the retained owned encrypted current head and asserts provider/connection count. The store crate receives the opaque authenticator capability but never receives or imports the session, password or opened plaintext model. The example prints exactly four non-sensitive lines:

```text
synthetic store initialized
encrypted revision committed
store closed and reopened locked
synthetic relationship authenticated
```

- [ ] **Step 2: Implement authentication handoff and two-stage writable promotion**

`ExistingVaultPreflightV1::authenticate_current_revisions` accepts only the local-core capability:

```rust
pub fn authenticate_current_revisions(
    self,
    authenticator: &CredentialStorageAuthenticatorV1<'_>,
) -> Result<PreflightAuthenticationOutcomeV1, StorageError>;
```

The store first compares `authenticator.vault_commitment()` with the password-envelope inspection commitment, so even an empty revision graph cannot bypass password-derived vault authentication. For each streaming row it calls the borrowed method; the returned receipt must borrow that exact envelope, so a receipt from another row cannot substitute. Store compares receipt-derived record/revision/epoch/bucket/wire/suite with cache columns, validates authenticated parents against the same-record revision set, immediately drops non-head receipts and calls the owned rehydrate method only for canonical heads whose ciphertext must cross the RO→RW transition. Authenticated future inner returns global crypto upgrade; current auth failure/commitment mismatch/dangling parent returns preservation.

`promote()` closes read-only while keeping the OS lock, opens no-create writable, applies/verifies all required settings, starts `BEGIN IMMEDIATE`, and rechecks application/schema/count/graph plus a deterministic logical digest over opaque fields and exact BLOBs. One change restarts the full read-only preflight once; a second change returns `Busy`. Only then return the narrow writable store.

Wrong password is handled by the caller before creating/passing the authenticator capability: drop the preflight without ever opening writable. The integration test instruments writable-open count as zero and asserts main/existing-WAL bytes and logical rows are unchanged.

- [ ] **Step 3: Add future/corruption mutation matrix**

Cover future outer `[1]` and `[2, bytes, 42]`, authenticated future inner, higher user version, schema/trigger changes, column/header mismatch, nonce, wrapped Item DEK, body ciphertext, trailing byte, noncanonical CBOR, cross-vault/epoch swap, dangling head and dangling authenticated parent. Future outcomes preserve exact bytes; current corruption enters store-wide read-only preservation; no case auto repairs/deletes/overwrites.

- [ ] **Step 4: Add raw file scan**

After WAL writes and close/reopen, enumerate only the temp test directory and scan DB, `-wal`, `-shm`, rollback journals and temporary snapshot candidates for the known synthetic provider/account/project/secret/note/search/index markers. Assert none occur. Do not print marker contents on failure; report only a stable marker index and file role.

- [ ] **Step 5: Verify and commit**

```powershell
cargo test -p vault-local-store-sqlite --test restart_roundtrip -- --test-threads=1
cargo test -p vault-local-store-sqlite --test future_and_corruption -- --test-threads=1
cargo test -p vault-local-store-sqlite --test plaintext_scan -- --test-threads=1
cargo run -q -p vault-local-store-sqlite --example synthetic_sqlite_roundtrip
cargo fmt --all -- --check
cargo clippy -p vault-local-store-sqlite --all-targets --all-features -- -D warnings
git add crates/vault-local-store-sqlite/src/preflight.rs crates/vault-local-store-sqlite/src/rows.rs crates/vault-local-store-sqlite/src/store.rs crates/vault-local-store-sqlite/tests/restart_roundtrip.rs crates/vault-local-store-sqlite/tests/future_and_corruption.rs crates/vault-local-store-sqlite/tests/plaintext_scan.rs crates/vault-local-store-sqlite/examples/synthetic_sqlite_roundtrip.rs
git diff --cached --check
git commit -m "test: prove encrypted sqlite restart flow"
```

### Task 7: Add process-crash atomicity and API boundary regression

**Files:**
- Modify: `crates/vault-local-store-sqlite/src/lib.rs`
- Modify: `crates/vault-local-store-sqlite/src/commit.rs`
- Create: `crates/vault-local-store-sqlite/src/crash_tests.rs`
- Create: `crates/vault-local-store-sqlite/tests/secret_traits.rs`
- Create: `crates/vault-local-store-sqlite/tests/ui/secret_traits/store_debug.rs`
- Create: `crates/vault-local-store-sqlite/tests/ui/secret_traits/store_debug.stderr`
- Create: `crates/vault-local-store-sqlite/tests/ui/secret_traits/projection_clone.rs`
- Create: `crates/vault-local-store-sqlite/tests/ui/secret_traits/projection_clone.stderr`
- Create: `crates/vault-local-store-sqlite/tests/ui/secret_traits/raw_connection.rs`
- Create: `crates/vault-local-store-sqlite/tests/ui/secret_traits/raw_connection.stderr`

**Interfaces:**
- Consumes: Task 4 transaction implementation and Task 6 authenticated open/promotion boundary.
- Produces: deterministic pre/post-COMMIT child-process failpoints and compile-fail surface lock.

- [ ] **Step 1: Build deterministic child-process failpoints**

Add `#[cfg(test)] mod crash_tests;` only. The lib-test binary re-spawns `std::env::current_exe()` into an exact ignored child-test entrypoint that accepts only `SYNTHETIC_INITIAL_BEFORE_COMMIT`, `SYNTHETIC_INITIAL_AFTER_COMMIT`, `SYNTHETIC_CONFLICT_BEFORE_COMMIT`, or `SYNTHETIC_CONFLICT_AFTER_COMMIT`. A crate-private `cfg(test)` transaction observer writes a non-secret readiness byte after the transaction reaches the named point. The parent terminates the child only at the before-commit points; after-commit cases wait for commit success then terminate/exit. Normal `cargo build --lib` contains no observer, env-var branch, process execution or arbitrary SQL path.

- [ ] **Step 2: Assert atomic visibility**

Before-commit initial: neither revision nor head exists. After-commit initial: both exist. Before-commit stale: candidate revision/conflict both absent and head unchanged. After-commit stale: revision/conflict both present and head unchanged. Reopen each DB through normal preflight, not a raw assertion-only connection.

- [ ] **Step 3: Add compile-fail surface tests**

Prove callers cannot format/clone/serialize store, projection or envelope-bearing values, obtain a raw `rusqlite::Connection`, construct a candidate, or invoke generic SQL/process/network APIs through the store crate. Check each `.stderr` for the intended absent trait/private field/absent method.

- [ ] **Step 4: Verify and commit**

```powershell
cargo test -p vault-local-store-sqlite --lib crash_tests -- --test-threads=1
cargo test -p vault-local-store-sqlite --test secret_traits -- --test-threads=1
cargo test -p vault-local-store-sqlite --all-features -- --test-threads=1
cargo fmt --all -- --check
cargo clippy -p vault-local-store-sqlite --all-targets --all-features -- -D warnings
git add crates/vault-local-store-sqlite/src/lib.rs crates/vault-local-store-sqlite/src/commit.rs crates/vault-local-store-sqlite/src/crash_tests.rs crates/vault-local-store-sqlite/tests/secret_traits.rs crates/vault-local-store-sqlite/tests/ui/secret_traits
git diff --cached --check
git commit -m "test: verify sqlite crash atomicity"
```

### Task 8: Run final security verification, document limits and back up the branch

**Files:**
- Modify: `README.md`
- Modify: `docs/MVP.md`
- Modify: `docs/THREAT_MODEL.md`
- Create: `crates/vault-local-store-sqlite/README.md`
- Create: `docs/verification/ciphertext-sqlite-local-store.md`

**Interfaces:**
- Consumes: all previous tasks and the approved spec.
- Produces: honest implementation status, reproducible verification record and a clean GitHub-backed feature branch.

- [ ] **Step 1: Update status without widening release scope**

Document that the implemented slice is synthetic-only ciphertext persistence with immutable CAS, not a usable password manager. Explicitly list unresolved actual-Secret gates: rollback/omission anchor, recovery Key Slots, hardware-backed device key/biometric flow, Android integration, sync/checkpoints, independent crypto review, penetration testing and backup/export recovery drill.

- [ ] **Step 2: Run the complete final gate once**

```powershell
cargo metadata --format-version 1 --no-deps
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features -- --test-threads=1
cargo run -q -p vault-local-store-sqlite --example synthetic_sqlite_roundtrip
cargo tree --workspace -e features
git diff 95d5b7ed0dbdf135d4a9b128a7a04162ce2d2cc2..HEAD --check
rg -n --hidden --glob '!target/**' --glob '!.git/**' --glob '!docs/superpowers/**' -- '(?i)(sk-[a-z0-9]{16,}|api[_-]?key\s*[:=]\s*[A-Za-z0-9_\-]{12,}|secret\s*[:=]\s*[A-Za-z0-9_\-]{12,}|password\s*[:=]\s*[^\s]{8,}|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY)' .
```

Expected: metadata/fmt/Clippy/tests/example/tree/diff all exit 0; bounded scan exits 1 with no matches. If `gitleaks` is installed, also run `gitleaks git --redact`; if unavailable, record that it was unavailable and do not claim it passed.

- [ ] **Step 3: Record exact evidence**

The verification document records exact command, exit code, test counts, rusqlite version, bundled SQLite runtime version, example output, scan scope, gitleaks availability, branch/base/head SHA and the rollback/actual-Secret limitations. It must not include DB paths, IDs, ciphertext or fixture values.

- [ ] **Step 4: Commit only the documentation files**

```powershell
git add README.md docs/MVP.md docs/THREAT_MODEL.md crates/vault-local-store-sqlite/README.md docs/verification/ciphertext-sqlite-local-store.md
git diff --cached --check
git commit -m "docs: verify ciphertext sqlite local store"
git status --short
```

- [ ] **Step 5: Independent whole-branch review and backup**

Run one independent read-only security review against the approved spec and range `95d5b7e..HEAD`. Fix every Critical/Important issue through focused RED/GREEN commits and rerun the affected plus final gates. When clean, push without force:

```powershell
git push -u origin codex/firstvibe-sqlite-store
git rev-parse HEAD
git ls-remote --heads origin refs/heads/codex/firstvibe-sqlite-store
git status --short
```

Expected: local HEAD, tracking ref and live remote SHA match; worktree is clean. Do not merge to `main` in this plan.

## Self-review record

- Spec coverage: sections 3–6 map to Tasks 1–3, commit semantics section 8 to Task 4, two-stage open/bounds sections 6–7 to Task 5, future/corruption/storage tests sections 9–12 to Tasks 6–7, limitations/non-goals/follow-up sections 10/13/14 to Task 8.
- Placeholder scan: every code step names concrete files, signatures, assertions, commands and expected outcomes; no unresolved marker or generic implementation instruction remains.
- Type consistency: Task 1 metadata feeds Task 2 projection; Task 2 projection is the only Task 4 commit input; Task 3 schema/lock feeds Tasks 4–5; Task 5 returns the same `SyntheticWritableStoreV1` defined in Task 4; Tasks 6–7 consume only those public types.
- Scope check: backup/export, Android/Room, recovery/biometric, sync/checkpoints and monetization remain separate later subprojects and are not silently started here.
