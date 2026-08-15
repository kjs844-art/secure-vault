# Synthetic Credential Local Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 합성 자격 증명과 API 키·MCP 연결 관계를 엄격한 버전형 payload로 만들고, 기존 `vault-crypto` 레코드 envelope로 봉인한 뒤 세션을 버리고 다시 잠금 해제해 동일한 관계를 복구하는 첫 Rust 로컬 코어를 완성한다.

**Architecture:** 기존 `vault-crypto`는 Root Key와 Item DEK 암호화만 계속 소유하고, 새 `vault-local-core` crate가 자격 증명 모델, canonical CBOR payload, CSPRNG record/revision ID, padding 선택과 합성 fixture만 소유한다. 로컬 코어는 암호문과 비밀이 아닌 locator를 함께 보존하고 locator를 expected context로 다시 구성해 AAD를 검증한다. 이 첫 계획은 영속 DB, 검색, 회전 CAS, UI와 복구 Key Slot을 섞지 않는다.

**Tech Stack:** Rust 1.95.0 (edition 2024), 기존 `vault-crypto` 0.0.1-alpha.1, `getrandom` 0.4.3, `minicbor` 2.3.0, `zeroize` 1.9.0, `thiserror` 2.0.20, `proptest` 1.11.0, `trybuild` 1.0.120, Cargo, rustfmt, Clippy.

## Global Constraints

- 이 계획은 **합성 데이터 전용**이다. 실제 아이디, 비밀번호, API 키, Secret, 복구 키, 세션 쿠키나 개인 금고 데이터를 입력·가져오기·저장하지 않는다.
- 공개 생성 API는 `SyntheticCredentialFixtureId`만 받는다. 자유 문자열, paste, import, deep link, 브라우저 확장 메시지, CLI와 MCP 입력 경로를 만들지 않는다.
- 합성 값은 `DEMO_VALUE_ONLY_` prefix를 사용한다. 서비스·계정·프로젝트 이름도 `Example AI Workshop`, `demo-account`, `demo-project`처럼 명백한 가상 값만 사용한다.
- 현재 password envelope는 초기 `key_epoch=1` 전용이다. `VaultSession`이 소유한 epoch와 record context epoch가 다르면 seal과 open을 모두 `AuthenticationFailed`로 거부한다.
- 제품 payload의 canonical encoded 상한은 60,000 bytes다. 기존 record body의 4-byte 길이 prefix를 고려해 bucket 경계를 1,020, 4,092, 16,380, 61,436 bytes로 계산하되 제품 코어는 60,000에서 먼저 거부한다.
- `CredentialItemV1`은 fixed-length CBOR array다. 현재 schema의 잘못된 array 길이, unknown enum, non-minimal integer, indefinite string/array, trailing bytes와 대체 인코딩을 거부한다.
- 미래 `item_schema_version>1`과 미래 outer wire version은 원본 ciphertext를 수정하지 않고 `UpgradeRequired`로 반환한다. 구버전 코어는 그 레코드를 덮어쓰는 API를 제공하지 않는다.
- `SecretValueV1`, `OpenedCredentialV1`과 secret-bearing model은 `Debug`, `Display`, `Serialize`, `Clone`, `Copy`를 구현하지 않는다. Secret 원문을 포함하는 오류 variant, 로그와 assertion failure message를 만들지 않는다.
- public error는 안정적인 비민감 코드만 제공한다. 암호 오류의 입력값·길이·부분 평문을 전달하지 않는다.
- production API의 record ID 16 bytes와 revision ID 32 bytes는 한 번의 `getrandom::fill`로 얻은 48-byte block에서 만든다. caller-provided ID·nonce·entropy API는 제공하지 않는다.
- 이번 계획에서는 SQLite·파일 저장, outbox, expected-head CAS, 검색 인덱스, 회전 workflow, 충돌함, Android/Web UI, recovery key, trusted device, server sync, plugin, MCP 실행과 실제 Secret 지원을 구현하지 않는다.
- 각 Task는 focused RED → 최소 GREEN → 전체 회귀 → 명시적 파일 stage → 한 커밋 순서로 끝낸다. `git add .`는 사용하지 않는다.
- 최종 `cargo fmt --check`, Clippy `-D warnings`, 전체 test, 안전한 example, `git diff --check`, bounded Secret-pattern scan을 모두 통과해야 한다.

---

### Task 1: Bind each `VaultSession` to one key epoch

**Files:**

- Modify: `crates/vault-crypto/src/secret.rs`
- Modify: `crates/vault-crypto/src/v0alpha1/wrap.rs`
- Modify: `crates/vault-crypto/src/v0alpha1/record.rs`
- Create: `crates/vault-crypto/tests/epoch_binding.rs`

**Interfaces:**

- Consumes: 기존 password envelope는 wire 변경 없이 초기 epoch 1 Root Key를 연다.
- Produces: `KeyEpoch::initial()`, `KeyEpoch::get()`, `KeyEpoch::checked_next()`, `VaultSession::key_epoch()`; record seal/open은 session epoch와 context epoch를 일치시킨다.

- [ ] **Step 0: Create the implementation branch from the clean approved-plan commit**

```powershell
git status --short
git branch --show-current
git switch -c codex/firstvibe-credential-local-core
git branch --show-current
```

Expected: status is empty before the switch, the source branch is `codex/firstvibe-recovery-credential-design`, and the new branch is exactly `codex/firstvibe-credential-local-core`. If that branch already exists, stop and inspect it; do not reset, delete, or overwrite it.

- [ ] **Step 1: Write the failing epoch-binding tests**

Create `crates/vault-crypto/tests/epoch_binding.rs`:

```rust
use vault_crypto::{
    CryptoError, CryptoErrorCode, KeyEpoch, MasterPassword, OpaqueRecordId, PaddingBucketV0Alpha1,
    RecordContextV0Alpha1, RevisionId, SecretBytes, create_vault_v0alpha1,
    open_record_v0alpha1, seal_record_v0alpha1,
};

fn synthetic_password() -> MasterPassword {
    MasterPassword::from_utf8("synthetic epoch binding phrase".to_owned()).unwrap()
}

fn expect_crypto_error_code<T>(result: Result<T, CryptoError>) -> CryptoErrorCode {
    match result {
        Ok(_) => panic!("an invalid synthetic epoch case was unexpectedly accepted"),
        Err(error) => error.code(),
    }
}

#[test]
fn initial_password_session_is_epoch_one() {
    let created = create_vault_v0alpha1(&synthetic_password()).unwrap();
    assert_eq!(created.session.key_epoch().get(), 1);
}

#[test]
fn seal_and_open_reject_a_context_from_another_epoch() {
    let created = create_vault_v0alpha1(&synthetic_password()).unwrap();
    let wrong_epoch = RecordContextV0Alpha1::new(
        created.session.commitment(),
        OpaqueRecordId::from_bytes([0x11; 16]),
        RevisionId::from_bytes([0x22; 32]),
        KeyEpoch::new(2).unwrap(),
        PaddingBucketV0Alpha1::Bytes1024,
    );
    let payload = SecretBytes::new(b"DEMO_VALUE_ONLY_EPOCH".to_vec()).unwrap();

    assert_eq!(
        expect_crypto_error_code(seal_record_v0alpha1(
            &created.session,
            &wrong_epoch,
            &payload,
        )),
        CryptoErrorCode::AuthenticationFailed,
    );

    let right_epoch = RecordContextV0Alpha1::new(
        created.session.commitment(),
        OpaqueRecordId::from_bytes([0x11; 16]),
        RevisionId::from_bytes([0x22; 32]),
        KeyEpoch::initial(),
        PaddingBucketV0Alpha1::Bytes1024,
    );
    let envelope = seal_record_v0alpha1(&created.session, &right_epoch, &payload).unwrap();
    assert_eq!(
        expect_crypto_error_code(open_record_v0alpha1(
            &created.session,
            &wrong_epoch,
            &envelope,
        )),
        CryptoErrorCode::AuthenticationFailed,
    );
}

#[test]
fn key_epoch_cannot_wrap_past_u32_max() {
    assert_eq!(
        expect_crypto_error_code(KeyEpoch::new(u32::MAX).unwrap().checked_next()),
        CryptoErrorCode::LimitsExceeded,
    );
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
cargo test -p vault-crypto --test epoch_binding -- --test-threads=1
```

Expected: compile failure because `key_epoch`, `get`, `initial`, and `checked_next` do not exist.

- [ ] **Step 3: Add the epoch value to the live session**

In `crates/vault-crypto/src/secret.rs`, extend the existing types with exactly this public surface:

```rust
impl KeyEpoch {
    pub const fn initial() -> Self {
        Self(1)
    }

    pub const fn get(&self) -> u32 {
        self.0
    }

    pub const fn checked_next(&self) -> Result<Self, CryptoError> {
        match self.0.checked_add(1) {
            Some(next) => Ok(Self(next)),
            None => Err(CryptoError::LimitsExceeded),
        }
    }
}

pub struct VaultSession {
    root_key: HeapSecretKey,
    commitment: VaultCommitment,
    key_epoch: KeyEpoch,
}

impl VaultSession {
    pub(crate) fn new(
        root_key: HeapSecretKey,
        commitment: VaultCommitment,
        key_epoch: KeyEpoch,
    ) -> Self {
        Self {
            root_key,
            commitment,
            key_epoch,
        }
    }

    pub fn key_epoch(&self) -> KeyEpoch {
        self.key_epoch.clone()
    }

    pub(crate) fn key_epoch_value(&self) -> u32 {
        self.key_epoch.get()
    }
}
```

Retain the existing heap-stable `HeapSecretKey` backed by `Box<Zeroizing<_>>` and the commitment methods. Do not add a custom `VaultSession::drop`; the owned zeroizing key allocation remains responsible for cleanup. Replace internal `KeyEpoch::value()` calls with `get()` and remove the duplicate private getter.

In both `VaultSession::new` calls in `crates/vault-crypto/src/v0alpha1/wrap.rs`, pass `KeyEpoch::initial()` as the third argument. Do not add an epoch field to the existing password envelope; its documented meaning remains “initial epoch 1 only.”

- [ ] **Step 4: Enforce epoch equality at the record boundary**

Replace `validate_session_context` in `crates/vault-crypto/src/v0alpha1/record.rs` with:

```rust
fn validate_session_context(
    session: &VaultSession,
    context: &RecordContextV0Alpha1,
) -> Result<(), CryptoError> {
    if session.commitment_bytes() != context.commitment_bytes()
        || session.key_epoch_value() != context.key_epoch_value()
    {
        return Err(CryptoError::AuthenticationFailed);
    }
    Ok(())
}
```

- [ ] **Step 5: Run focused and full crypto verification**

Run:

```powershell
cargo test -p vault-crypto --test epoch_binding -- --test-threads=1
cargo test -p vault-crypto --all-features -- --test-threads=1
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
```

Expected: epoch tests pass; the existing regression vector and all existing tests remain byte-for-byte compatible and pass.

- [ ] **Step 6: Commit Task 1**

```powershell
git add -- crates/vault-crypto/src/secret.rs crates/vault-crypto/src/v0alpha1/wrap.rs crates/vault-crypto/src/v0alpha1/record.rs crates/vault-crypto/tests/epoch_binding.rs
git diff --cached --check
git commit -m "fix: bind vault sessions to key epochs"
```

---

### Task 2: Lock the credential payload contract and crate boundary

**Files:**

- Modify: `Cargo.toml`
- Modify: `Cargo.lock`
- Create: `contracts/local-v1/credential-item.cddl`
- Create: `contracts/local-v1/validation-rules.md`
- Create: `crates/vault-local-core/Cargo.toml`
- Create: `crates/vault-local-core/src/lib.rs`
- Create: `crates/vault-local-core/src/error.rs`
- Create: `crates/vault-local-core/README.md`

**Interfaces:**

- Consumes: `vault-crypto` public API and workspace-pinned dependencies only.
- Produces: a non-production `vault-local-core` crate, stable `LocalVaultErrorCode`, fixed array contract, and exact validation limits used by later tasks.

- [ ] **Step 1: Add a failing workspace boundary check**

Run before creating the crate:

```powershell
cargo check -p vault-local-core
```

Expected: FAIL because package `vault-local-core` does not exist.

- [ ] **Step 2: Add the new workspace member and manifest**

Change the root workspace members to:

```toml
[workspace]
members = ["crates/vault-crypto", "crates/vault-local-core"]
resolver = "3"
```

Create `crates/vault-local-core/Cargo.toml`:

```toml
[package]
name = "vault-local-core"
version = "0.0.1-alpha.1"
edition.workspace = true
rust-version.workspace = true
license.workspace = true
publish = false

[dependencies]
getrandom.workspace = true
minicbor.workspace = true
thiserror.workspace = true
vault-crypto = { path = "../vault-crypto" }
zeroize.workspace = true

[dev-dependencies]
proptest.workspace = true
serde.workspace = true
trybuild.workspace = true
```

- [ ] **Step 3: Create the strict CDDL contract**

Create `contracts/local-v1/credential-item.cddl`:

```cddl
credential-item-v1 = [
  item-schema-version: 1,
  parent-revision-id: bstr .size 32 / null,
  item-name: tstr,
  provider-template-id: tstr / null,
  provider-name: tstr,
  console-url: tstr / null,
  issuer-account-ref: bstr .size 16 / null,
  issuer-project-ref: bstr .size 16 / null,
  issuer-account-identifier: tstr / null,
  issuer-organization-or-workspace: tstr / null,
  issuer-project: tstr / null,
  issuer-environment: tstr / null,
  credential-type: 0..6,
  secret-fields: [* secret-field-v1],
  display-hint: tstr / null,
  scopes-or-permissions: [* tstr],
  issued-at: utc-timestamp / null,
  expires-at: utc-timestamp / null,
  rotate-at: utc-timestamp / null,
  timestamp-provenance: 0..2,
  status: 0..7,
  external-revocation-status: 0..5,
  external-revocation-attestation: 0..2,
  revoked-at: utc-timestamp / null,
  rotation-state: rotation-state-v1 / null,
  connections: [* connection-v1],
  tags: [* tstr],
  notes: tstr / null,
  created-at: utc-timestamp,
  updated-at: utc-timestamp
]

secret-field-v1 = [
  field-id: bstr .size 16,
  label: tstr,
  field-role: 0..3,
  sensitivity: 0..2,
  value: bstr,
  reveal-policy: 0..1,
  copy-policy: 0..1
]

connection-v1 = [
  connection-id: bstr .size 16,
  consumer-type: 0..8,
  consumer-name: tstr,
  consumer-project: tstr / null,
  consumer-environment: tstr / null,
  purpose: tstr / null,
  configuration-reference: tstr / null,
  credential-alias-or-env-name: tstr / null,
  required-for-cutover: bool,
  status: 0..4,
  verification-source: 0..2,
  last-verified-at: utc-timestamp / null,
  notes: tstr / null,
  mcp-integration: mcp-integration-v1 / null
]

mcp-integration-v1 = [
  transport: 0..3,
  server-identifier: tstr,
  package-or-executable-reference: tstr / null,
  argument-template: [* tstr],
  endpoint-url: tstr / null,
  credential-field-bindings: [* credential-field-binding-v1],
  configuration-location: tstr / null,
  execution-policy: 0
]

credential-field-binding-v1 = [
  configuration-key-name: tstr,
  field-id: bstr .size 16
]

rotation-state-v1 = [
  supersedes-revision-id: bstr .size 32,
  required-connection-ids: [* bstr .size 16],
  completed-connection-ids: [* bstr .size 16],
  superseded-external-revocation-status: 0..5,
  superseded-external-revocation-attestation: 0..2,
  superseded-revoked-at: utc-timestamp / null
]

utc-timestamp = tstr .size 20
```

- [ ] **Step 4: Write the exact validation rules**

Create `contracts/local-v1/validation-rules.md` with these normative rules:

```markdown
# Credential Item V1 validation rules

- Encoding is one definite-length CBOR array with exactly 30 fields.
- Nested arrays use the exact field counts in `credential-item.cddl`.
- Canonical encoded payload is at most 60,000 bytes.
- `item_name` is 1..=128 UTF-8 bytes.
- General display fields are at most 256 UTF-8 bytes; `display_hint` is at most 32 and `console_url` is at most 2,048.
- Item `notes` is at most 8,192 UTF-8 bytes.
- `secret_fields` contains 1..=16 entries and their value bytes total at most 32,768.
- `connections` contains 0..=128 entries.
- `tags` contains 0..=32 entries; each tag is 1..=64 UTF-8 bytes.
- `scopes_or_permissions` contains at most 64 entries; each entry is at most 256 UTF-8 bytes.
- MCP argument templates contain at most 32 entries, field bindings at most 16, and each configuration key is 1..=256 UTF-8 bytes.
- Timestamps use exactly `YYYY-MM-DDTHH:MM:SSZ` and must be valid UTC calendar values.
- Every field ID and connection ID is unique.
- MCP binding field IDs must exist in the same item; binding pairs are unique.
- `mcp_integration` is optional for `consumer_type=mcp_server` and forbidden for every other consumer type.
- MCP execution policy is exactly `record_only`; no command is executed or auto-copied.
- A rotation state requires `parent_revision_id`; `supersedes_revision_id` equals that parent.
- Required connection IDs exactly equal non-removed connections with `required_for_cutover=true`.
- Completed connection IDs are a subset of required connection IDs.
- `superseded_revoked_at` exists only with `user_confirmed` or `provider_verified` and a matching attestation.
- Current schema unknown enum values, dangling references, duplicate references, self revision references and non-canonical encodings are rejected.
- Future schema versions are preserved as ciphertext and reported as upgrade-required.
```

- [ ] **Step 5: Add a non-sensitive error contract and crate skeleton**

Create `crates/vault-local-core/src/error.rs`:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LocalVaultErrorCode {
    NonCanonicalEncoding,
    InvalidItem,
    LimitsExceeded,
    AuthenticationFailed,
    RngUnavailable,
    CryptoFailure,
}

#[derive(Debug, thiserror::Error)]
pub enum LocalVaultError {
    #[error("credential payload is not canonical")]
    NonCanonicalEncoding,
    #[error("credential item is invalid")]
    InvalidItem,
    #[error("credential item limit exceeded")]
    LimitsExceeded,
    #[error("record authentication failed")]
    AuthenticationFailed,
    #[error("operating-system randomness unavailable")]
    RngUnavailable,
    #[error("cryptographic operation failed")]
    CryptoFailure,
}

impl LocalVaultError {
    pub const fn code(&self) -> LocalVaultErrorCode {
        match self {
            Self::NonCanonicalEncoding => LocalVaultErrorCode::NonCanonicalEncoding,
            Self::InvalidItem => LocalVaultErrorCode::InvalidItem,
            Self::LimitsExceeded => LocalVaultErrorCode::LimitsExceeded,
            Self::AuthenticationFailed => LocalVaultErrorCode::AuthenticationFailed,
            Self::RngUnavailable => LocalVaultErrorCode::RngUnavailable,
            Self::CryptoFailure => LocalVaultErrorCode::CryptoFailure,
        }
    }
}
```

Create `crates/vault-local-core/src/lib.rs`:

```rust
//! Synthetic-only credential relationship core for Secure Vault.
//!
//! This alpha crate is not approved for real passwords, API keys, or recovery data.

#![forbid(unsafe_code)]

mod error;

pub use error::{LocalVaultError, LocalVaultErrorCode};
```

Create `crates/vault-local-core/README.md` with an explicit synthetic-only warning and the exact exclusions from Global Constraints.

- [ ] **Step 6: Verify and commit Task 2**

```powershell
cargo check -p vault-local-core
cargo metadata --no-deps --format-version 1
cargo fmt --all -- --check
git add -- Cargo.toml Cargo.lock contracts/local-v1/credential-item.cddl contracts/local-v1/validation-rules.md crates/vault-local-core/Cargo.toml crates/vault-local-core/src/lib.rs crates/vault-local-core/src/error.rs crates/vault-local-core/README.md
git diff --cached --check
git commit -m "feat: add synthetic credential core boundary"
```

Expected: the new crate builds without adding any unpinned third-party dependency.

---

### Task 3: Implement secret-safe IDs, model types, and validation

**Files:**

- Create: `crates/vault-local-core/src/ids.rs`
- Create: `crates/vault-local-core/src/secret.rs`
- Create: `crates/vault-local-core/src/model.rs`
- Modify: `crates/vault-local-core/src/lib.rs`
- Create: `crates/vault-local-core/src/model_tests.rs`

**Interfaces:**

- Consumes: the CDDL and validation rules from Task 2.
- Produces: CSPRNG `RecordIdV1`/`RevisionIdV1`/`EntityIdV1`, zeroizing `SecretValueV1`, crate-owned `CredentialItemV1::validate(current_revision)` and all V1 enums.

- [ ] **Step 1: Write failing model-limit tests through synthetic test constructors**

Add `#[cfg(test)] #[path = "model_tests.rs"] mod tests;` at the end of `model.rs`, then create `crates/vault-local-core/src/model_tests.rs`:

```rust
use super::{SyntheticInvalidFixtureId, UtcTimestampV1, validate_invalid_fixture_v1};
use crate::{LocalVaultError, LocalVaultErrorCode};

fn expect_local_error_code<T>(result: Result<T, LocalVaultError>) -> LocalVaultErrorCode {
    match result {
        Ok(_) => panic!("an invalid synthetic model case was unexpectedly accepted"),
        Err(error) => error.code(),
    }
}

#[test]
fn item_and_reference_limits_fail_closed() {
    for fixture in [
        SyntheticInvalidFixtureId::EmptyItemName,
        SyntheticInvalidFixtureId::DanglingMcpFieldBinding,
        SyntheticInvalidFixtureId::DuplicateConnectionId,
        SyntheticInvalidFixtureId::DuplicateSecretFieldId,
        SyntheticInvalidFixtureId::McpPayloadOnNonMcpConsumer,
        SyntheticInvalidFixtureId::DuplicateMcpBinding,
        SyntheticInvalidFixtureId::RotationParentMismatch,
        SyntheticInvalidFixtureId::RequiredConnectionSetMismatch,
        SyntheticInvalidFixtureId::CompletedConnectionOutsideRequiredSet,
        SyntheticInvalidFixtureId::InvalidSupersededRevocationAttestation,
        SyntheticInvalidFixtureId::SelfParentRevision,
    ] {
        assert_eq!(
            expect_local_error_code(validate_invalid_fixture_v1(fixture)),
            LocalVaultErrorCode::InvalidItem,
        );
    }
}

#[test]
fn byte_limits_return_one_stable_code() {
    for fixture in [
        SyntheticInvalidFixtureId::ItemNameOver128Bytes,
        SyntheticInvalidFixtureId::ConsoleUrlOver2048Bytes,
        SyntheticInvalidFixtureId::NotesOver8192Bytes,
        SyntheticInvalidFixtureId::TooManySecretFields,
        SyntheticInvalidFixtureId::SecretBytesOverLimit,
        SyntheticInvalidFixtureId::TooManyConnections,
    ] {
        assert_eq!(
            expect_local_error_code(validate_invalid_fixture_v1(fixture)),
            LocalVaultErrorCode::LimitsExceeded,
        );
    }
}

#[test]
fn utc_timestamps_accept_only_exact_valid_calendar_values() {
    assert!(UtcTimestampV1::new("2024-02-29T23:59:59Z".to_owned()).is_ok());
    for invalid in [
        "2025-02-29T23:59:59Z",
        "2026-13-01T00:00:00Z",
        "2026-01-32T00:00:00Z",
        "2026-01-01T24:00:00Z",
        "2026-01-01T00:60:00Z",
        "2026-01-01T00:00:60Z",
        "2026-01-01T00:00:00+00:00",
    ] {
        assert_eq!(
            expect_local_error_code(UtcTimestampV1::new(invalid.to_owned())),
            LocalVaultErrorCode::InvalidItem,
        );
    }
}
```

- [ ] **Step 2: Run the tests and verify RED**

```powershell
cargo test -p vault-local-core model::tests --lib
```

Expected: compile failure because the model and synthetic invalid fixture API do not exist.

- [ ] **Step 3: Implement IDs with one production entropy draw**

Create `crates/vault-local-core/src/ids.rs` around these exact types:

```rust
use crate::LocalVaultError;

#[derive(Clone, Copy, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct RecordIdV1([u8; 16]);

#[derive(Clone, Copy, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct RevisionIdV1([u8; 32]);

#[derive(Clone, Copy, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub(crate) struct EntityIdV1([u8; 16]);

pub(crate) struct RecordIdentityEntropy {
    pub record_id: RecordIdV1,
    pub revision_id: RevisionIdV1,
}

impl RecordIdV1 {
    pub(crate) const fn from_bytes(bytes: [u8; 16]) -> Self { Self(bytes) }
    pub const fn as_bytes(&self) -> &[u8; 16] { &self.0 }
}

impl RevisionIdV1 {
    pub(crate) const fn from_bytes(bytes: [u8; 32]) -> Self { Self(bytes) }
    pub const fn as_bytes(&self) -> &[u8; 32] { &self.0 }
}

impl EntityIdV1 {
    pub(crate) const fn from_bytes(bytes: [u8; 16]) -> Self { Self(bytes) }
    pub(crate) const fn as_bytes(&self) -> &[u8; 16] { &self.0 }
}

pub(crate) fn generate_record_identity() -> Result<RecordIdentityEntropy, LocalVaultError> {
    generate_record_identity_with(|block| {
        getrandom::fill(block).map_err(|_| LocalVaultError::RngUnavailable)
    })
}

fn generate_record_identity_with(
    mut fill: impl FnMut(&mut [u8]) -> Result<(), LocalVaultError>,
) -> Result<RecordIdentityEntropy, LocalVaultError> {
    let mut block = [0_u8; 48];
    fill(&mut block)?;
    Ok(record_identity_from_block(&block))
}

fn record_identity_from_block(block: &[u8; 48]) -> RecordIdentityEntropy {
    let mut record = [0_u8; 16];
    let mut revision = [0_u8; 32];
    record.copy_from_slice(&block[..16]);
    revision.copy_from_slice(&block[16..]);
    RecordIdentityEntropy {
        record_id: RecordIdV1(record),
        revision_id: RevisionIdV1(revision),
    }
}
```

Add an inline `#[cfg(test)] mod tests` in `ids.rs` that calls `generate_record_identity_with` using a closure. The success closure asserts its buffer length is 48, increments a counter, fills `0x00..=0x2f`, and the test asserts exactly one call plus record ID `0x00..=0x0f` and revision ID `0x10..=0x2f`. A second closure increments the counter and returns `LocalVaultError::RngUnavailable`; the test matches that error through a generic `match` helper that does not require `RecordIdentityEntropy: Debug` and asserts exactly one failed call. This tests the production draw and split without exposing an entropy source or caller-provided ID constructor.

- [ ] **Step 4: Implement a non-loggable secret value**

Create `crates/vault-local-core/src/secret.rs`:

```rust
use zeroize::{Zeroize, Zeroizing};

use crate::LocalVaultError;

pub(crate) struct SecretValueV1(Zeroizing<Vec<u8>>);

impl SecretValueV1 {
    pub(crate) fn new(bytes: Vec<u8>) -> Result<Self, LocalVaultError> {
        if bytes.is_empty() {
            return Err(LocalVaultError::InvalidItem);
        }
        Ok(Self(Zeroizing::new(bytes)))
    }

    pub(crate) fn expose(&self) -> &[u8] {
        self.0.as_slice()
    }
}

impl Drop for SecretValueV1 {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}
```

Do not derive or manually implement `Debug`, `Display`, `Clone`, `Copy`, `Serialize`, or `Deserialize`.

- [ ] **Step 5: Implement the exact V1 model and validation**

Create `crates/vault-local-core/src/model.rs`. Use these exact enum discriminants:

```rust
pub(crate) enum CredentialTypeV1 {
    Password = 0, ApiKey = 1, OauthClient = 2, CloudAccessKey = 3,
    Token = 4, RecoveryCode = 5, Custom = 6,
}
pub(crate) enum FieldRoleV1 { Identifier = 0, Secret = 1, Token = 2, Configuration = 3 }
pub(crate) enum SensitivityV1 { PublicIdentifier = 0, PrivateMetadata = 1, Secret = 2 }
pub(crate) enum RevealPolicyV1 { Masked = 0, RevealAfterReauth = 1 }
pub(crate) enum CopyPolicyV1 { AllowedAfterReauth = 0, Never = 1 }
pub(crate) enum TimestampProvenanceV1 { UserEntered = 0, ProviderVerified = 1, ImportedFixture = 2 }
pub(crate) enum CredentialStatusV1 {
    Active = 0, RotationDue = 1, Rotating = 2, Expired = 3,
    Compromised = 4, Revoked = 5, Disabled = 6, Unknown = 7,
}
pub(crate) enum ExternalRevocationStatusV1 {
    NotRequested = 0, Pending = 1, UserConfirmed = 2,
    ProviderVerified = 3, Failed = 4, Unknown = 5,
}
pub(crate) enum ExternalRevocationAttestationV1 { None = 0, User = 1, ProviderConnector = 2 }
pub(crate) enum ConsumerTypeV1 {
    App = 0, BrowserExtension = 1, Plugin = 2, McpServer = 3, Cli = 4,
    Server = 5, CiCd = 6, CloudProject = 7, Custom = 8,
}
pub(crate) enum ConnectionStatusV1 { Connected = 0, UpdateRequired = 1, Verified = 2, Removed = 3, Unknown = 4 }
pub(crate) enum VerificationSourceV1 { User = 0, ProviderConnector = 1, None = 2 }
pub(crate) enum McpTransportV1 { Stdio = 0, StreamableHttp = 1, Sse = 2, Custom = 3 }
pub(crate) enum McpExecutionPolicyV1 { RecordOnly = 0 }
```

Every enum uses `#[derive(Clone, Copy, Eq, PartialEq)]`; it does not derive `Debug` or serialization traits. The core structs are:

```rust
pub(crate) struct CredentialItemV1 {
    pub item_schema_version: u64,
    pub parent_revision_id: Option<RevisionIdV1>,
    pub item_name: String,
    pub provider_template_id: Option<String>,
    pub provider_name: String,
    pub console_url: Option<String>,
    pub issuer_account_ref: Option<EntityIdV1>,
    pub issuer_project_ref: Option<EntityIdV1>,
    pub issuer_account_identifier: Option<String>,
    pub issuer_organization_or_workspace: Option<String>,
    pub issuer_project: Option<String>,
    pub issuer_environment: Option<String>,
    pub credential_type: CredentialTypeV1,
    pub secret_fields: Vec<SecretFieldV1>,
    pub display_hint: Option<String>,
    pub scopes_or_permissions: Vec<String>,
    pub issued_at: Option<UtcTimestampV1>,
    pub expires_at: Option<UtcTimestampV1>,
    pub rotate_at: Option<UtcTimestampV1>,
    pub timestamp_provenance: TimestampProvenanceV1,
    pub status: CredentialStatusV1,
    pub external_revocation_status: ExternalRevocationStatusV1,
    pub external_revocation_attestation: ExternalRevocationAttestationV1,
    pub revoked_at: Option<UtcTimestampV1>,
    pub rotation_state: Option<RotationStateV1>,
    pub connections: Vec<ConnectionV1>,
    pub tags: Vec<String>,
    pub notes: Option<String>,
    pub created_at: UtcTimestampV1,
    pub updated_at: UtcTimestampV1,
}

pub(crate) struct SecretFieldV1 {
    pub field_id: EntityIdV1,
    pub label: String,
    pub field_role: FieldRoleV1,
    pub sensitivity: SensitivityV1,
    pub value: SecretValueV1,
    pub reveal_policy: RevealPolicyV1,
    pub copy_policy: CopyPolicyV1,
}

pub(crate) struct ConnectionV1 {
    pub connection_id: EntityIdV1,
    pub consumer_type: ConsumerTypeV1,
    pub consumer_name: String,
    pub consumer_project: Option<String>,
    pub consumer_environment: Option<String>,
    pub purpose: Option<String>,
    pub configuration_reference: Option<String>,
    pub credential_alias_or_env_name: Option<String>,
    pub required_for_cutover: bool,
    pub status: ConnectionStatusV1,
    pub verification_source: VerificationSourceV1,
    pub last_verified_at: Option<UtcTimestampV1>,
    pub notes: Option<String>,
    pub mcp_integration: Option<McpIntegrationV1>,
}

pub(crate) struct McpIntegrationV1 {
    pub transport: McpTransportV1,
    pub server_identifier: String,
    pub package_or_executable_reference: Option<String>,
    pub argument_template: Vec<String>,
    pub endpoint_url: Option<String>,
    pub credential_field_bindings: Vec<CredentialFieldBindingV1>,
    pub configuration_location: Option<String>,
    pub execution_policy: McpExecutionPolicyV1,
}

pub(crate) struct CredentialFieldBindingV1 {
    pub configuration_key_name: String,
    pub field_id: EntityIdV1,
}

pub(crate) struct RotationStateV1 {
    pub supersedes_revision_id: RevisionIdV1,
    pub required_connection_ids: Vec<EntityIdV1>,
    pub completed_connection_ids: Vec<EntityIdV1>,
    pub superseded_external_revocation_status: ExternalRevocationStatusV1,
    pub superseded_external_revocation_attestation: ExternalRevocationAttestationV1,
    pub superseded_revoked_at: Option<UtcTimestampV1>,
}
```

`UtcTimestampV1` exposes `pub(crate) fn new(value: String) -> Result<Self, LocalVaultError>`. It accepts exactly 20 ASCII bytes in `YYYY-MM-DDTHH:MM:SSZ`, validates leap years, month lengths, hour `00..23`, minute/second `00..59`, and stores the normalized string. `CredentialItemV1::validate(current_revision)` implements every rule in `validation-rules.md` using `BTreeSet`; it returns only `InvalidItem` or `LimitsExceeded` and never embeds field text in the error.

Under `#[cfg(test)]`, define `SyntheticInvalidFixtureId` and `fn validate_invalid_fixture_v1(fixture: SyntheticInvalidFixtureId) -> Result<(), LocalVaultError>` inside `model.rs`. They contain exactly the variants used in Step 1, build each value entirely inside the crate and never enter the public library API.

- [ ] **Step 6: Export only safe first-slice types and run GREEN**

Update `lib.rs`:

```rust
mod ids;
mod model;
mod secret;

pub use ids::{RecordIdV1, RevisionIdV1};
```

Run:

```powershell
cargo test -p vault-local-core model::tests --lib
cargo fmt --all -- --check
cargo clippy -p vault-local-core --all-targets -- -D warnings
```

- [ ] **Step 7: Commit Task 3**

```powershell
git add -- crates/vault-local-core/src/lib.rs crates/vault-local-core/src/ids.rs crates/vault-local-core/src/secret.rs crates/vault-local-core/src/model.rs crates/vault-local-core/src/model_tests.rs
git diff --cached --check
git commit -m "feat: validate synthetic credential relationships"
```

---

### Task 4: Add the strict canonical credential codec

**Files:**

- Create: `crates/vault-local-core/src/codec.rs`
- Modify: `crates/vault-local-core/src/lib.rs`
- Create: `crates/vault-local-core/src/codec_tests.rs`

**Interfaces:**

- Consumes: validated `CredentialItemV1` and current revision from Task 3.
- Produces: `encode_current_item`, `decode_item`, `DecodedItem::Current`, and `DecodedItem::UpgradeRequired { version }` without logging or returning plaintext in errors.

- [ ] **Step 1: Write the codec rejection tests**

Add `#[cfg(test)] #[path = "codec_tests.rs"] mod tests;` at the end of `codec.rs`, then create `crates/vault-local-core/src/codec_tests.rs`:

```rust
use super::{SyntheticCodecMutation, reject_synthetic_codec_mutation_v1, synthetic_codec_roundtrip_with_note_length};
use crate::LocalVaultErrorCode;
use proptest::prelude::*;

#[test]
fn current_schema_rejects_alternative_or_malformed_encodings() {
    for (mutation, expected) in [
        (SyntheticCodecMutation::WrongTopLevelArrayLength, LocalVaultErrorCode::NonCanonicalEncoding),
        (SyntheticCodecMutation::WrongNestedArrayLength, LocalVaultErrorCode::NonCanonicalEncoding),
        (SyntheticCodecMutation::IndefiniteTopLevelArray, LocalVaultErrorCode::NonCanonicalEncoding),
        (SyntheticCodecMutation::IndefiniteText, LocalVaultErrorCode::NonCanonicalEncoding),
        (SyntheticCodecMutation::NonMinimalSchemaVersion, LocalVaultErrorCode::NonCanonicalEncoding),
        (SyntheticCodecMutation::SchemaVersionZero, LocalVaultErrorCode::InvalidItem),
        (SyntheticCodecMutation::RawPayloadOverProductLimit, LocalVaultErrorCode::LimitsExceeded),
        (SyntheticCodecMutation::EncodedItemOverProductLimit, LocalVaultErrorCode::LimitsExceeded),
        (SyntheticCodecMutation::DeclaredConnectionCountOverLimit, LocalVaultErrorCode::LimitsExceeded),
        (SyntheticCodecMutation::TruncatedPayload, LocalVaultErrorCode::NonCanonicalEncoding),
        (SyntheticCodecMutation::InvalidUtf8, LocalVaultErrorCode::NonCanonicalEncoding),
        (SyntheticCodecMutation::TrailingBytes, LocalVaultErrorCode::NonCanonicalEncoding),
        (SyntheticCodecMutation::UnknownCurrentEnum, LocalVaultErrorCode::InvalidItem),
        (SyntheticCodecMutation::DuplicateFieldId, LocalVaultErrorCode::InvalidItem),
    ] {
        let code = reject_synthetic_codec_mutation_v1(mutation)
            .unwrap_err()
            .code();
        assert_eq!(code, expected);
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(128))]

    #[test]
    fn bounded_synthetic_notes_roundtrip(note_len in 0_usize..=8_192) {
        prop_assert!(synthetic_codec_roundtrip_with_note_length(note_len).is_ok());
    }
}
```

- [ ] **Step 2: Run focused RED**

```powershell
cargo test -p vault-local-core codec::tests --lib
```

Expected: compile failure because the codec test API does not exist.

- [ ] **Step 3: Implement fixed-array encode/decode with byte comparison**

Create `codec.rs` with these exact boundaries:

```rust
const ITEM_SCHEMA_VERSION: u64 = 1;
const ITEM_FIELD_COUNT: u64 = 30;
const SECRET_FIELD_COUNT: u64 = 7;
const CONNECTION_FIELD_COUNT: u64 = 14;
const MCP_FIELD_COUNT: u64 = 8;
const BINDING_FIELD_COUNT: u64 = 2;
const ROTATION_FIELD_COUNT: u64 = 6;
const MAX_PAYLOAD_BYTES: usize = 60_000;

pub(crate) enum DecodedItem {
    Current(CredentialItemV1),
    UpgradeRequired { version: u64 },
}

pub(crate) fn encode_current_item(
    item: &CredentialItemV1,
    current_revision: RevisionIdV1,
) -> Result<vault_crypto::SecretBytes, LocalVaultError>;

pub(crate) fn decode_item(
    plaintext: &vault_crypto::SecretBytes,
    current_revision: RevisionIdV1,
) -> Result<DecodedItem, LocalVaultError>;
```

`encode_current_item` validates before encoding, writes fields in the exact CDDL order, checks `<=60_000`, and moves the encoder's `Vec<u8>` directly into `SecretBytes::new`. It never clones a secret field value.

`decode_item` performs this order:

1. reject plaintext over 60,000;
2. read a definite top-level array and schema version only;
3. reject schema version 0 as `InvalidItem`;
4. return `UpgradeRequired` immediately for version greater than 1;
5. require exactly 30 fields for version 1;
6. decode all fixed nested arrays with bounded allocation before loops;
7. reject trailing bytes;
8. validate all cross references;
9. re-encode to a `CanonicalComparator` writer and require an exact byte match.

Use this comparator rather than allocating a second plaintext buffer:

```rust
struct CanonicalComparator<'a> {
    expected: &'a [u8],
    position: usize,
    matches: bool,
}

impl CanonicalComparator<'_> {
    fn is_exact_match(&self) -> bool {
        self.matches && self.position == self.expected.len()
    }
}

impl minicbor::encode::Write for CanonicalComparator<'_> {
    type Error = core::convert::Infallible;

    fn write_all(&mut self, bytes: &[u8]) -> Result<(), Self::Error> {
        let Some(end) = self.position.checked_add(bytes.len()) else {
            self.matches = false;
            return Ok(());
        };
        if self.expected.get(self.position..end) != Some(bytes) {
            self.matches = false;
        }
        self.position = end;
        Ok(())
    }
}
```

Every decoder loop checks the declared count against the approved maximum before `Vec::with_capacity`. After re-encoding, `decode_item` accepts only when `is_exact_match()` is true. Decoder and encoder errors map to `NonCanonicalEncoding`; validation failures retain `InvalidItem` or `LimitsExceeded`.

- [ ] **Step 4: Add only crate-private synthetic codec test seams**

Define `SyntheticCodecMutation`, `fn reject_synthetic_codec_mutation_v1(mutation: SyntheticCodecMutation) -> Result<(), LocalVaultError>`, and `fn synthetic_codec_roundtrip_with_note_length(note_len: usize) -> Result<(), LocalVaultError>` under `#[cfg(test)]` inside `codec.rs`. `RawPayloadOverProductLimit` passes a 60,001-byte `SecretBytes` value to decode; `EncodedItemOverProductLimit` builds an otherwise valid synthetic item whose canonical encoding exceeds 60,000 bytes and calls encode. The note helper repeats ASCII `x` exactly `note_len` times. Each helper constructs known synthetic bytes inside the crate; none is exported from `lib.rs` or accepts arbitrary plaintext.

- [ ] **Step 5: Run focused and full GREEN**

```powershell
cargo test -p vault-local-core codec::tests --lib
cargo test -p vault-local-core
cargo fmt --all -- --check
cargo clippy -p vault-local-core --all-targets -- -D warnings
```

- [ ] **Step 6: Commit Task 4**

```powershell
git add -- crates/vault-local-core/src/lib.rs crates/vault-local-core/src/codec.rs crates/vault-local-core/src/codec_tests.rs
git diff --cached --check
git commit -m "feat: add canonical credential payload codec"
```

---

### Task 5: Seal synthetic fixtures through the existing crypto core

**Files:**

- Create: `crates/vault-local-core/src/synthetic.rs`
- Create: `crates/vault-local-core/src/record.rs`
- Modify: `crates/vault-local-core/src/lib.rs`
- Create: `crates/vault-local-core/tests/synthetic_record_roundtrip.rs`
- Create: `crates/vault-local-core/src/record_tests.rs`

**Interfaces:**

- Consumes: Task 1 session epoch, Task 3 identity generation, Task 4 codec, and existing record seal/open APIs.
- Produces: `SyntheticCredentialFixtureId`, `StoredPaddingBucketV0Alpha1`, `RecordLocatorV0Alpha1`, `SealedCredentialRecordV0Alpha1`, `OpenedCredentialV1`, `OpenCredentialOutcome`, `seal_synthetic_fixture_v1`, and `open_credential_record_v1`.

- [ ] **Step 1: Write the public roundtrip test**

Create `crates/vault-local-core/tests/synthetic_record_roundtrip.rs`:

```rust
use vault_crypto::{MasterPassword, create_vault_v0alpha1, unlock_vault_v0alpha1};
use vault_local_core::{
    OpenCredentialOutcome, SyntheticCredentialFixtureId, open_credential_record_v1,
    seal_synthetic_fixture_v1,
};

#[test]
fn zero_one_and_multiple_connection_fixtures_survive_reunlock() {
    let password = MasterPassword::from_utf8("synthetic local core phrase".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();

    let cases = [
        (SyntheticCredentialFixtureId::UnconnectedApiKey, 0, 1),
        (SyntheticCredentialFixtureId::SingleMcpConnection, 1, 1),
        (SyntheticCredentialFixtureId::MultipleConsumers, 3, 2),
    ];
    let records: Vec<_> = cases
        .iter()
        .map(|(fixture, _, _)| seal_synthetic_fixture_v1(&created.session, *fixture).unwrap())
        .collect();

    drop(created.session);
    let reopened = unlock_vault_v0alpha1(&password, &created.password_envelope).unwrap();

    for ((_, expected_connections, expected_fields), record) in cases.iter().zip(records.iter()) {
        let OpenCredentialOutcome::Current(opened) =
            open_credential_record_v1(&reopened, record).unwrap()
        else {
            panic!("current synthetic fixture unexpectedly requires upgrade");
        };
        assert_eq!(opened.provider_name(), "Example AI Workshop");
        assert_eq!(opened.connection_count(), *expected_connections);
        assert_eq!(opened.secret_field_count(), *expected_fields);
    }
}
```

- [ ] **Step 2: Write tamper and context-swap tests**

Add `#[cfg(test)] #[path = "record_tests.rs"] mod tests;` at the end of `record.rs`, then create `crates/vault-local-core/src/record_tests.rs`:

```rust
use vault_crypto::{MasterPassword, create_vault_v0alpha1};

use super::{
    StoredPaddingBucketV0Alpha1, SyntheticRecordMutation, select_bucket,
    synthetic_tamper_case_v1,
};
use crate::{LocalVaultError, LocalVaultErrorCode, SyntheticCredentialFixtureId};

fn expect_local_error_code<T>(result: Result<T, LocalVaultError>) -> LocalVaultErrorCode {
    match result {
        Ok(_) => panic!("an invalid synthetic record case was unexpectedly accepted"),
        Err(error) => error.code(),
    }
}

#[test]
fn product_payload_boundaries_select_the_smallest_bucket() {
    assert!(matches!(select_bucket(1_020).unwrap(), StoredPaddingBucketV0Alpha1::Bytes1024));
    assert!(matches!(select_bucket(1_021).unwrap(), StoredPaddingBucketV0Alpha1::Bytes4096));
    assert!(matches!(select_bucket(4_092).unwrap(), StoredPaddingBucketV0Alpha1::Bytes4096));
    assert!(matches!(select_bucket(4_093).unwrap(), StoredPaddingBucketV0Alpha1::Bytes16384));
    assert!(matches!(select_bucket(16_380).unwrap(), StoredPaddingBucketV0Alpha1::Bytes16384));
    assert!(matches!(select_bucket(16_381).unwrap(), StoredPaddingBucketV0Alpha1::Bytes61440));
    assert!(matches!(select_bucket(60_000).unwrap(), StoredPaddingBucketV0Alpha1::Bytes61440));
    assert_eq!(
        expect_local_error_code(select_bucket(60_001)),
        LocalVaultErrorCode::LimitsExceeded,
    );
}

#[test]
fn locator_and_ciphertext_mutations_are_rejected() {
    let password = MasterPassword::from_utf8("synthetic tamper phrase".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    for mutation in [
        SyntheticRecordMutation::RecordId,
        SyntheticRecordMutation::RevisionId,
        SyntheticRecordMutation::KeyEpoch,
        SyntheticRecordMutation::PaddingBucket,
        SyntheticRecordMutation::Ciphertext,
    ] {
        assert_eq!(
            synthetic_tamper_case_v1(
                &created.session,
                SyntheticCredentialFixtureId::SingleMcpConnection,
                mutation,
            )
            .unwrap_err()
            .code(),
            LocalVaultErrorCode::AuthenticationFailed
        );
    }
}
```

`SyntheticRecordMutation` and `synthetic_tamper_case_v1` exist only under `#[cfg(test)]` inside `record.rs`; neither enters the public API.
Give the helper the exact signature `fn synthetic_tamper_case_v1(session: &VaultSession, fixture: SyntheticCredentialFixtureId, mutation: SyntheticRecordMutation) -> Result<(), LocalVaultError>` so the test does not require any secret-bearing success type to implement `Debug`.

- [ ] **Step 3: Implement all three synthetic fixtures**

Create `synthetic.rs` with:

```rust
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum SyntheticCredentialFixtureId {
    UnconnectedApiKey,
    SingleMcpConnection,
    MultipleConsumers,
}
```

The fixtures use these exact synthetic values:

```text
provider_name: Example AI Workshop
console_url: https://console.example.invalid/api-keys
account: demo-account
project: demo-project
environment: demo
secret values: DEMO_VALUE_ONLY_API_KEY_0001 and DEMO_VALUE_ONLY_TOKEN_0002
MCP server: example-workshop-mcp
MCP binding key: EXAMPLE_WORKSHOP_API_KEY
consumers: Example MCP, Example CLI, Example CI
timestamp: 2026-08-14T00:00:00Z
```

`UnconnectedApiKey` has zero connections, `SingleMcpConnection` has one required MCP connection with a valid field binding, and `MultipleConsumers` has three connections spanning MCP, CLI and CI/CD plus two Secret fields with identifier/secret roles. Entity IDs are fixed synthetic byte arrays inside fixtures; production record/revision IDs remain random.

- [ ] **Step 4: Implement the record bridge**

Create `record.rs` with this public shape:

```rust
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum StoredPaddingBucketV0Alpha1 {
    Bytes1024,
    Bytes4096,
    Bytes16384,
    Bytes61440,
}

pub struct RecordLocatorV0Alpha1 {
    record_id: RecordIdV1,
    revision_id: RevisionIdV1,
    key_epoch: u32,
    padding_bucket: StoredPaddingBucketV0Alpha1,
}

pub struct SealedCredentialRecordV0Alpha1 {
    locator: RecordLocatorV0Alpha1,
    envelope: Vec<u8>,
}

pub struct OpenedCredentialV1 {
    item: CredentialItemV1,
}

pub enum OpenCredentialOutcome {
    Current(OpenedCredentialV1),
    UpgradeRequired,
}

pub fn seal_synthetic_fixture_v1(
    session: &vault_crypto::VaultSession,
    fixture: SyntheticCredentialFixtureId,
) -> Result<SealedCredentialRecordV0Alpha1, LocalVaultError>;

pub fn open_credential_record_v1(
    session: &vault_crypto::VaultSession,
    record: &SealedCredentialRecordV0Alpha1,
) -> Result<OpenCredentialOutcome, LocalVaultError>;
```

`seal_synthetic_fixture_v1` performs exactly this sequence: build fixture → generate one 48-byte identity block → validate → canonical encode → select the smallest bucket → build `RecordContextV0Alpha1` with `session.commitment()` and `session.key_epoch()` → seal → return locator plus ciphertext.

Bucket selection is:

```rust
fn select_bucket(payload_len: usize) -> Result<StoredPaddingBucketV0Alpha1, LocalVaultError> {
    match payload_len {
        0..=1_020 => Ok(StoredPaddingBucketV0Alpha1::Bytes1024),
        1_021..=4_092 => Ok(StoredPaddingBucketV0Alpha1::Bytes4096),
        4_093..=16_380 => Ok(StoredPaddingBucketV0Alpha1::Bytes16384),
        16_381..=60_000 => Ok(StoredPaddingBucketV0Alpha1::Bytes61440),
        _ => Err(LocalVaultError::LimitsExceeded),
    }
}
```

`open_credential_record_v1` reconstructs the expected context only from the session and stored locator and authenticates before decoding. Use this exact crypto-error policy at the bridge:

- `AuthenticationFailed` becomes `LocalVaultError::AuthenticationFailed`;
- `RngUnavailable` becomes `LocalVaultError::RngUnavailable`;
- `LimitsExceeded` becomes `LocalVaultError::LimitsExceeded`;
- outer `UnsupportedVersion` becomes `OpenCredentialOutcome::UpgradeRequired` only on the open path; the current crypto error intentionally does not expose an untrusted version number, so the public outcome must not invent one;
- `UnsupportedSuite`, `NonCanonicalEncoding`, `InvalidLength`, and `KdfParamsRejected` become `LocalVaultError::CryptoFailure`.

A session from another vault, a locator-context swap, and a ciphertext-tag mutation therefore fail as `AuthenticationFailed`. The function never modifies `record.envelope`.

`OpenedCredentialV1` exposes only these first-slice getters:

```rust
impl OpenedCredentialV1 {
    pub fn item_name(&self) -> &str { &self.item.item_name }
    pub fn provider_name(&self) -> &str { &self.item.provider_name }
    pub fn connection_count(&self) -> usize { self.item.connections.len() }
    pub fn secret_field_count(&self) -> usize { self.item.secret_fields.len() }
    pub fn has_mcp_connection(&self) -> bool {
        self.item
            .connections
            .iter()
            .any(|connection| connection.consumer_type == ConsumerTypeV1::McpServer)
    }
}
```

Do not add a secret getter, reveal, copy, search or arbitrary create/update API.

- [ ] **Step 5: Run focused and full GREEN**

```powershell
cargo test -p vault-local-core --test synthetic_record_roundtrip -- --test-threads=1
cargo test -p vault-local-core record::tests --lib -- --test-threads=1
cargo test -p vault-local-core -- --test-threads=1
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
```

- [ ] **Step 6: Commit Task 5**

```powershell
git add -- crates/vault-local-core/src/lib.rs crates/vault-local-core/src/synthetic.rs crates/vault-local-core/src/record.rs crates/vault-local-core/src/record_tests.rs crates/vault-local-core/tests/synthetic_record_roundtrip.rs
git diff --cached --check
git commit -m "feat: seal synthetic credential relationships"
```

---

### Task 6: Preserve future records and enforce secret-bearing type boundaries

**Files:**

- Modify: `crates/vault-local-core/src/codec.rs`
- Modify: `crates/vault-local-core/src/record.rs`
- Modify: `crates/vault-local-core/src/lib.rs`
- Create: `crates/vault-local-core/src/future_version_tests.rs`
- Create: `crates/vault-local-core/tests/secret_traits.rs`
- Create: `crates/vault-local-core/tests/ui/secret_traits/opened_debug.rs`
- Create: `crates/vault-local-core/tests/ui/secret_traits/opened_debug.stderr`
- Create: `crates/vault-local-core/tests/ui/secret_traits/opened_display.rs`
- Create: `crates/vault-local-core/tests/ui/secret_traits/opened_display.stderr`
- Create: `crates/vault-local-core/tests/ui/secret_traits/opened_clone.rs`
- Create: `crates/vault-local-core/tests/ui/secret_traits/opened_clone.stderr`
- Create: `crates/vault-local-core/tests/ui/secret_traits/opened_copy.rs`
- Create: `crates/vault-local-core/tests/ui/secret_traits/opened_copy.stderr`
- Create: `crates/vault-local-core/tests/ui/secret_traits/opened_serialize.rs`
- Create: `crates/vault-local-core/tests/ui/secret_traits/opened_serialize.stderr`
- Create: `crates/vault-local-core/tests/ui/secret_traits/opened_secret_getter.rs`
- Create: `crates/vault-local-core/tests/ui/secret_traits/opened_secret_getter.stderr`
- Create: `crates/vault-local-core/tests/ui/secret_traits/caller_record_id.rs`
- Create: `crates/vault-local-core/tests/ui/secret_traits/caller_record_id.stderr`
- Create: `crates/vault-local-core/tests/ui/secret_traits/caller_revision_id.rs`
- Create: `crates/vault-local-core/tests/ui/secret_traits/caller_revision_id.stderr`

**Interfaces:**

- Consumes: authenticated record bridge from Task 5.
- Produces: read-only `UpgradeRequired` outcomes for future inner and outer versions plus compile-fail proof that opened secrets are not debuggable, displayable, cloneable, copyable, serializable or directly retrievable and callers cannot supply record/revision IDs.

- [ ] **Step 1: Write future-version preservation tests**

Add `#[cfg(test)] #[path = "future_version_tests.rs"] mod future_version_tests;` in `lib.rs`, then create `src/future_version_tests.rs`:

```rust
use vault_crypto::{MasterPassword, create_vault_v0alpha1};

use crate::{
    OpenCredentialOutcome, SyntheticFutureVersion, open_synthetic_future_version_v1,
};

#[test]
fn future_inner_and_outer_versions_require_upgrade_without_mutation() {
    let password = MasterPassword::from_utf8("synthetic future phrase".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();

    for version in [SyntheticFutureVersion::InnerSchema2, SyntheticFutureVersion::OuterWire1] {
        let (before, outcome, after) =
            open_synthetic_future_version_v1(&created.session, version).unwrap();
        assert!(matches!(outcome, OpenCredentialOutcome::UpgradeRequired));
        assert_eq!(before, after);
    }
}
```

`SyntheticFutureVersion` and `open_synthetic_future_version_v1` are crate-private under `#[cfg(test)]`. The helper returns copies of ciphertext only for this test; it never returns plaintext.

- [ ] **Step 2: Write compile-fail cases**

Create `tests/secret_traits.rs`:

```rust
#[test]
fn opened_credentials_do_not_gain_secret_exposing_traits() {
    let cases = trybuild::TestCases::new();
    cases.compile_fail("tests/ui/secret_traits/*.rs");
}
```

Create the six trait/method cases and two caller-ID cases with these exact source shapes:

`opened_debug.rs`:

```rust
use vault_local_core::OpenedCredentialV1;

fn require_debug<T: core::fmt::Debug>() {}

fn main() {
    require_debug::<OpenedCredentialV1>();
}
```

`opened_display.rs`:

```rust
use vault_local_core::OpenedCredentialV1;

fn require_display<T: core::fmt::Display>() {}

fn main() {
    require_display::<OpenedCredentialV1>();
}
```

`opened_clone.rs`:

```rust
use vault_local_core::OpenedCredentialV1;

fn require_clone<T: Clone>() {}

fn main() {
    require_clone::<OpenedCredentialV1>();
}
```

`opened_copy.rs`:

```rust
use vault_local_core::OpenedCredentialV1;

fn require_copy<T: Copy>() {}

fn main() {
    require_copy::<OpenedCredentialV1>();
}
```

`opened_serialize.rs`:

```rust
use vault_local_core::OpenedCredentialV1;

fn require_serialize<T: serde::Serialize>() {}

fn main() {
    require_serialize::<OpenedCredentialV1>();
}
```

`opened_secret_getter.rs`:

```rust
use vault_local_core::OpenedCredentialV1;

fn expose(opened: &OpenedCredentialV1) {
    let _ = opened.secret_value();
}

fn main() {}
```

`caller_record_id.rs`:

```rust
use vault_local_core::RecordIdV1;

fn main() {
    let _ = RecordIdV1::from_bytes([0_u8; 16]);
}
```

`caller_revision_id.rs`:

```rust
use vault_local_core::RevisionIdV1;

fn main() {
    let _ = RevisionIdV1::from_bytes([0_u8; 32]);
}
```

Each must fail because the intended trait is absent, the secret getter is absent, or the ID constructor is not public. Accept the generated `.stderr` only after confirming that exact reason and rejecting unrelated import or type-inference failures.

- [ ] **Step 3: Implement test-only future envelopes and stable mapping**

Add crate-private helpers that:

- seal an authenticated inner payload whose first fixed-array field is schema version 2;
- mutate only the outer wire-version integer of a valid synthetic envelope to 1;
- retain the original `SealedCredentialRecordV0Alpha1` in the caller;
- call the public open function and compare the ciphertext before and after.

Map only `CryptoErrorCode::UnsupportedVersion` to the version-agnostic public `OpenCredentialOutcome::UpgradeRequired`. `UnsupportedSuite`, malformed current wire, authentication failure and length errors remain failures; they must not be mislabeled as an upgrade. Inner schema decoding may keep the authenticated numeric version internally, but the public first-slice outcome remains version-agnostic so outer wire failures are not mislabeled with an invented number.

- [ ] **Step 4: Run focused tests, inspect trybuild output, then run all tests**

```powershell
cargo test -p vault-local-core future_version_tests --lib -- --test-threads=1
$env:TRYBUILD='overwrite'
cargo test -p vault-local-core --test secret_traits -- --test-threads=1
Remove-Item Env:TRYBUILD
cargo test -p vault-local-core --test secret_traits -- --test-threads=1
cargo test --workspace --all-features -- --test-threads=1
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
```

Expected: future ciphertext is unchanged, all eight compile-fail cases pass for the intended reason, and the workspace regression suite remains green.

- [ ] **Step 5: Commit Task 6**

```powershell
git add -- crates/vault-local-core/src/lib.rs crates/vault-local-core/src/codec.rs crates/vault-local-core/src/record.rs crates/vault-local-core/src/future_version_tests.rs crates/vault-local-core/tests/secret_traits.rs crates/vault-local-core/tests/ui/secret_traits
git diff --cached --check
git commit -m "test: preserve future credential records"
```

---

### Task 7: Add the safe example, verification record, and final gate

**Files:**

- Create: `crates/vault-local-core/examples/synthetic_credential_roundtrip.rs`
- Modify: `crates/vault-local-core/README.md`
- Modify: `README.md`
- Modify: `docs/MVP.md`
- Create: `docs/verification/synthetic-credential-local-core.md`

**Interfaces:**

- Consumes: all prior tasks.
- Produces: one non-secret example, an evidence-backed scope statement, a clean implementation branch ready for backup and the exact handoff to the next plan.

- [ ] **Step 1: Create the example with exact non-secret output**

Create `examples/synthetic_credential_roundtrip.rs`:

```rust
use vault_crypto::{MasterPassword, create_vault_v0alpha1, unlock_vault_v0alpha1};
use vault_local_core::{
    OpenCredentialOutcome, SyntheticCredentialFixtureId, open_credential_record_v1,
    seal_synthetic_fixture_v1,
};

fn main() {
    let password = MasterPassword::from_utf8("synthetic example phrase".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let record = seal_synthetic_fixture_v1(
        &created.session,
        SyntheticCredentialFixtureId::SingleMcpConnection,
    )
    .unwrap();
    drop(created.session);
    let reopened = unlock_vault_v0alpha1(&password, &created.password_envelope).unwrap();
    let OpenCredentialOutcome::Current(item) =
        open_credential_record_v1(&reopened, &record).unwrap()
    else {
        panic!("synthetic current fixture requires an unexpected upgrade");
    };

    println!("provider={}", item.provider_name());
    println!("connections={}", item.connection_count());
    println!("mcp_recorded={}", item.has_mcp_connection());
    println!("synthetic_only=true");
}
```

Expected stdout exactly:

```text
provider=Example AI Workshop
connections=1
mcp_recorded=true
synthetic_only=true
```

- [ ] **Step 2: Update the product status, verify the example, and commit the slice**

`README.md`, `docs/MVP.md`, and the crate README must say:

- typed `CredentialItemV1` and three synthetic relationship fixtures are implemented;
- re-unlock and authenticated restore are verified;
- no disk DB, search, rotation, UI, recovery Slot, sync or actual Secret support exists;
- GitHub is source/design backup, not vault-data backup;
- actual credentials still must not be entered.

Run and commit the example plus status documents before producing the verification record:

```powershell
cargo run -p vault-local-core --example synthetic_credential_roundtrip
git add -- README.md docs/MVP.md crates/vault-local-core/README.md crates/vault-local-core/examples/synthetic_credential_roundtrip.rs
git diff --cached --name-status
git diff --cached --check
git commit -m "feat: complete synthetic credential local core"
```

Expected: stdout is exactly the four lines from Step 1 and the commit succeeds.

- [ ] **Step 3: Run the complete deterministic verification against that commit**

```powershell
cargo metadata --no-deps --format-version 1
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features -- --test-threads=1
cargo run -p vault-local-core --example synthetic_credential_roundtrip
cargo tree --workspace --all-features
git diff --check codex/firstvibe-recovery-credential-design..HEAD
git rev-parse HEAD
rg -n --hidden --glob '!target/**' --glob '!.git/**' -- "(sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|AIza[0-9A-Za-z_-]{30,})" .
```

Expected: metadata/fmt/Clippy/tests/example/tree/diff all exit 0. The final `rg` exits 1 with no matches. If `gitleaks` is installed, also run `gitleaks dir . --redact`; otherwise record that it was unavailable instead of claiming it passed.

- [ ] **Step 4: Perform the plan-specific security assertions and write the evidence record**

Confirm from the staged diff:

```text
no public arbitrary-plaintext constructor
no caller-provided entropy, nonce, record ID or revision ID
no Debug/Clone/Serialize/secret getter on opened credential types
no actual credential-shaped fixture
no persistence, network, process execution, clipboard or browser code
no recovery Key Slot implementation
session epoch equals record context epoch
future versions preserve ciphertext and cannot be overwritten
```

Create `docs/verification/synthetic-credential-local-core.md` with:

- the exact SHA printed in Step 3 as `tested_commit`;
- date/time and Windows/Rust/Cargo versions;
- every Step 3 command, exit code, exact test count and example stdout;
- whether `gitleaks` ran or was unavailable;
- the eight security assertions above and how each was inspected;
- the explicit exclusions from Global Constraints;
- a statement that existing regression vectors are not independent cryptographic validation.

- [ ] **Step 5: Commit the verification record and back up the branch**

```powershell
git add -- docs/verification/synthetic-credential-local-core.md
git diff --cached --name-status
git diff --cached --check
git commit -m "docs: record synthetic credential core verification"
git diff --check codex/firstvibe-recovery-credential-design..HEAD
git status --short
git push -u origin codex/firstvibe-credential-local-core
git rev-parse HEAD
git rev-parse origin/codex/firstvibe-credential-local-core
```

Expected: the worktree is clean and local/remote branch SHAs match.

## Follow-up plan boundaries

After this plan passes, keep the remaining systems in separate implementation plans in this order:

1. ciphertext-only persistence adapter, immutable revision store, expected-head CAS and encrypted conflict preservation;
2. in-memory relationship search, 60-second reauthentication gate and rotation candidate workflow;
3. synthetic-only Android fixture-selection, list, detail, search and connection-map UI with no arbitrary input;
4. protocol-neutral recovery policy state model;
5. recovery wire ADR and synthetic test vectors;
6. Android hardware-backed trusted-device ADR, biometric key-use approval and synthetic Android local alpha;
7. encrypted sync, device roster, signed checkpoints and server metadata boundary;
8. free trust-building beta, then versioned Free/Pro entitlements and ciphertext quota enforcement without deleting over-limit ciphertext;
9. separately gated web runtime and supply-chain hardening before any web Secret support;
10. browser, CLI, MCP and GPT integration as a user-approved metadata projection that never exposes Secret plaintext to an AI model;
11. external independent design review, implementation review, penetration test and recovery drill before any actual Secret support.

The rotation plan must keep in-progress encrypted candidate snapshots as siblings of the same existing head. Only final cutover changes the canonical head by CAS; this preserves immutable revisions and keeps `rotation_state.supersedes_revision_id == parent_revision_id` true.
