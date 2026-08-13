# v0alpha1 Synthetic Crypto Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a synthetic-data-only Rust harness that creates a random vault root key, wraps it with an Argon2id-derived password key, seals one opaque record with an item key, restores it, and rejects wrong passwords, malformed encodings, context swaps, and ciphertext tampering.

**Architecture:** A single Rust crate owns the experimental `v0alpha1` wire contract, strict deterministic CBOR codec, password root-key wrapping, and per-record envelope encryption. Public APIs obtain randomness only from the operating system and never expose root/item keys or nonce injection. Passwords, plaintext, and live root keys use non-loggable zeroizing types. Android, WebAssembly, persistence, sync, recovery, billing, and real Secret entry stay outside this plan.

**Tech Stack:** Rust 1.95.0 (edition 2024), `argon2` 0.5.3, `chacha20poly1305` 0.11.0 with XChaCha20-Poly1305, `poly1305` 0.9.1, `getrandom` 0.4.3, `minicbor` 2.3.0, `zeroize` 1.9.0, `thiserror` 2.0.20, `proptest` 1.11.0, `trybuild` 1.0.120, Cargo, rustfmt, Clippy.

## Global Constraints

- This is an experimental, synthetic-only `v0alpha1` format. It is not a stable `v1` and must never be described as approved for real passwords, API keys, recovery codes, or private keys.
- Demo code and committed fixtures use only the literal synthetic payload `DEMO_VALUE_ONLY_0001`, the synthetic labels `Example Workshop` and `demo-user`, and the documented synthetic password phrases. Primitive known-answer and property tests may generate explicit in-memory synthetic byte arrays, but no test may paste, import, or log a real credential.
- The public API accepts a password and plaintext because a client eventually needs those values, but it never accepts a caller-provided nonce, salt, root key, item key, or entropy source.
- `MasterPassword`, `SecretBytes`, and `VaultSession` must not implement `Debug`, `Display`, `Serialize`, `Clone`, or `Copy`. `VaultSession` has no raw-key getter.
- Wrong passwords and all AEAD authentication failures map to the same `AuthenticationFailed` code.
- Decode limits and the single accepted KDF profile are checked before Argon2 allocation or ciphertext allocation.
- The entire encoded record envelope is at most 65,536 bytes. Encrypted-body padding buckets are 1,024, 4,096, 16,384, and 61,440 bytes; the largest plaintext is 61,436 bytes after a four-byte length prefix.
- CBOR objects are fixed-length arrays, not maps. A decoded value is re-encoded and byte-compared with the input, so non-minimal integers, indefinite lengths, trailing bytes, and alternative encodings are rejected.
- Production paths use one `getrandom::fill` call for the complete 104-byte vault-creation entropy block and one call for the complete 80-byte record-sealing entropy block. No key or nonce processing starts until that call succeeds. Deterministic and failing entropy sources exist only inside crate unit tests.
- Do not implement device/recovery wrapping, epoch rotation, event logs, checkpoints, JNI/WASM, local persistence, server APIs, account login, payment, OpenAI plugin access, export, or clipboard behavior in this plan.
- `cargo fmt`, Clippy with warnings denied, all tests, the synthetic example, `git diff --check`, and a repository Secret-pattern scan must pass before the implementation branch is backed up.

---

## Task 1: Lock the experimental boundary and Cargo workspace

**Files:**

- Create: `Cargo.toml`
- Create: `rust-toolchain.toml`
- Create: `crates/vault-crypto/Cargo.toml`
- Create: `docs/adr/0002-v0alpha1-crypto-suite.md`
- Create: `contracts/v0alpha1/envelope.cddl`
- Create: `contracts/v0alpha1/domain-separation.md`
- Modify: `docs/superpowers/specs/2026-08-13-staged-monetization-and-distribution-design.md`
- Modify: `crates/vault-crypto/README.md`

- [ ] **Step 0: Create and verify the implementation branch from a clean approved-plan commit**

```powershell
git status --short
git switch -c codex/firstvibe-v0alpha1-crypto
git branch --show-current
```

Expected: status is empty before the switch and the reported branch is exactly `codex/firstvibe-v0alpha1-crypto`. If the branch already exists, stop and inspect it; do not reset, delete, or overwrite it.

- [ ] **Step 1: Create the workspace manifests with pinned direct dependencies**

Root `Cargo.toml`:

```toml
[workspace]
members = ["crates/vault-crypto"]
resolver = "3"

[workspace.package]
edition = "2024"
rust-version = "1.95"
license = "MIT OR Apache-2.0"

[workspace.dependencies]
argon2 = { version = "=0.5.3", default-features = false, features = ["zeroize"] }
chacha20poly1305 = { version = "=0.11.0", default-features = false, features = ["alloc", "zeroize"] }
getrandom = "=0.4.3"
minicbor = { version = "=2.3.0", features = ["std"] }
poly1305 = { version = "=0.9.1", default-features = false, features = ["zeroize"] }
proptest = "=1.11.0"
serde = { version = "=1.0.229", features = ["derive"] }
serde_json = "=1.0.151"
thiserror = "=2.0.20"
trybuild = "=1.0.120"
zeroize = { version = "=1.9.0", features = ["derive"] }
```

`rust-toolchain.toml`:

```toml
[toolchain]
channel = "1.95.0"
components = ["clippy", "rustfmt"]
profile = "minimal"
```

`crates/vault-crypto/Cargo.toml`:

```toml
[package]
name = "vault-crypto"
version = "0.0.1-alpha.1"
edition.workspace = true
rust-version.workspace = true
license.workspace = true
publish = false

[dependencies]
argon2.workspace = true
chacha20poly1305.workspace = true
getrandom.workspace = true
minicbor.workspace = true
poly1305.workspace = true
thiserror.workspace = true
zeroize.workspace = true

[dev-dependencies]
proptest.workspace = true
serde.workspace = true
serde_json.workspace = true
trybuild.workspace = true
```

- [ ] **Step 2: Write ADR 0002 with an explicit non-production decision**

The ADR must state all of the following concrete decisions:

- wire version `0`, suite ID `0xA101`, password-envelope kind `1`, record-envelope kind `2`;
- Argon2id v1.3 candidate profile: memory 65,536 KiB, time 3, lanes 4, output 32 bytes, 16-byte random salt;
- random 32-byte Vault Root Key and Item DEK;
- XChaCha20-Poly1305 with 24-byte random nonces and 16-byte tags;
- `argon2/zeroize`, `chacha20poly1305/zeroize`, and `poly1305/zeroize` enabled; explicitly allocated Argon2 working memory and all plaintext/key buffers are zeroized on every return path;
- random public 32-byte vault commitment generated independently of the root key;
- password envelope fields and record envelope fields defined by the CDDL below;
- 64 KiB full-envelope limit and 1/4/16/60 KiB encrypted-body buckets;
- this suite is compatibility-testable but not approved for real Secret storage;
- protocol vectors produced here are regression vectors until independently reproduced;
- root-key/device/recovery rotation semantics are unresolved and block actual Secret beta.

- [ ] **Step 3: Write the fixed-array CDDL contract**

`contracts/v0alpha1/envelope.cddl`:

```cddl
wire-version = 0
suite-id = 41217 ; 0xA101

password-envelope-v0alpha1 = [
  wire-version,
  suite-id,
  1,
  salt: bytes .size 16,
  memory-kib: 65536,
  time-cost: 3,
  lanes: 4,
  vault-commitment: bytes .size 32,
  root-nonce: bytes .size 24,
  wrapped-root-key: bytes .size 48
]

record-envelope-v0alpha1 = [
  wire-version,
  suite-id,
  2,
  vault-commitment: bytes .size 32,
  opaque-record-id: bytes .size 16,
  revision-id: bytes .size 32,
  key-epoch: uint .gt 0,
  padding-bucket: 1024 / 4096 / 16384 / 61440,
  item-key-nonce: bytes .size 24,
  wrapped-item-key: bytes .size 48,
  body-nonce: bytes .size 24,
  encrypted-body: bytes
]
```

State beside the CDDL that `encrypted-body.size == padding-bucket + 16`, that the fixed decoded body is `uint32_be(plaintext_length) || plaintext || zero_padding`, and that the complete encoded envelope must be at most 65,536 bytes.

- [ ] **Step 4: Define exact domain-separated AAD arrays**

`contracts/v0alpha1/domain-separation.md` must specify these byte strings exactly:

```text
secure-vault/v0alpha1/password-root-wrap
secure-vault/v0alpha1/item-dek-wrap
secure-vault/v0alpha1/item-body
```

Password-root AAD is deterministic CBOR for:

```text
[domain, wire_version, suite_id, object_kind, salt,
 memory_kib, time_cost, lanes, vault_commitment]
```

Item-DEK and item-body AAD use their respective domains and deterministic CBOR for:

```text
[domain, wire_version, suite_id, object_kind, vault_commitment,
 opaque_record_id, revision_id, key_epoch, padding_bucket]
```

- [ ] **Step 5: Align the approved design's bucket wording**

Replace the earlier `1/4/16/64 KiB 패딩 버킷` sentence with an explicit `1/4/16/60 KiB encrypted-body padding bucket; full encoded envelope maximum 64 KiB` statement. Do not change Free/Pro quotas or implement billing.

- [ ] **Step 6: Fetch and lock dependencies, then inspect duplicate crypto stacks**

Run:

```powershell
cargo fetch
cargo metadata --locked --format-version 1 --no-deps
cargo tree --workspace --locked -d
```

Expected: `Cargo.lock` is created, the workspace contains only `vault-crypto`, and any duplicate cryptographic crate versions are reviewed before continuing.

Inspect `cargo tree -e features` as well and verify that `argon2/zeroize`, `chacha20poly1305/zeroize`, and `poly1305/zeroize` are active. The direct `poly1305` dependency exists only to activate its zeroization feature through Cargo feature unification; application code must continue to use the high-level XChaCha20-Poly1305 AEAD API.

- [ ] **Step 7: Commit the boundary and workspace explicitly**

```powershell
git add Cargo.toml Cargo.lock rust-toolchain.toml crates/vault-crypto/Cargo.toml crates/vault-crypto/README.md contracts/v0alpha1/envelope.cddl contracts/v0alpha1/domain-separation.md docs/adr/0002-v0alpha1-crypto-suite.md docs/superpowers/specs/2026-08-13-staged-monetization-and-distribution-design.md
git diff --cached --check
git diff --cached --name-status
git commit -m "docs: lock v0alpha1 synthetic crypto boundary"
```

---

## Task 2: Build the strict codec through failing tests

**Files:**

- Create: `crates/vault-crypto/src/lib.rs`
- Create: `crates/vault-crypto/src/error.rs`
- Create: `crates/vault-crypto/src/v0alpha1/mod.rs`
- Create: `crates/vault-crypto/src/v0alpha1/codec.rs`
- Create: `crates/vault-crypto/tests/codec_limits.rs`

- [ ] **Step 1: Write public error-code tests before implementation**

Start `crates/vault-crypto/tests/codec_limits.rs` with tests that call the public decode probes and assert these exact errors:

```rust
use vault_crypto::{CryptoErrorCode, inspect_password_envelope_v0alpha1};

#[test]
fn rejects_oversized_input_before_decoding() {
    let input = vec![0_u8; 65_537];
    let error = inspect_password_envelope_v0alpha1(&input).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::LimitsExceeded);
}

#[test]
fn rejects_empty_input_without_panicking() {
    let error = inspect_password_envelope_v0alpha1(&[]).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::NonCanonicalEncoding);
}
```

The probes intentionally return no parsed fields:

```rust
pub fn inspect_password_envelope_v0alpha1(input: &[u8]) -> Result<(), CryptoError>;
pub fn inspect_record_envelope_v0alpha1(input: &[u8]) -> Result<(), CryptoError>;
```

They exist for compatibility and bounded-parser tests without exposing mutable envelope structs.

Add hand-authored CBOR cases and enforce this error table:

| Input condition | Error code |
|---|---|
| empty or truncated CBOR | `NonCanonicalEncoding` |
| wrong fixed-array length | `NonCanonicalEncoding` |
| indefinite array/bytes | `NonCanonicalEncoding` |
| non-minimal integer or alternate encoding | `NonCanonicalEncoding` |
| trailing bytes | `NonCanonicalEncoding` |
| version other than `0` | `UnsupportedVersion` |
| suite other than `0xA101` | `UnsupportedSuite` |
| wrong object kind for the called decoder | `NonCanonicalEncoding` |
| fixed byte field has the wrong length | `InvalidLength` |
| KDF profile differs from `65536/3/4` | `KdfParamsRejected` |
| record epoch is zero or does not fit `u32` | `InvalidLength` |
| bucket is not `1024/4096/16384/61440` | `LimitsExceeded` |
| encrypted body length differs from bucket plus 16 | `InvalidLength` |
| full input exceeds 65,536 bytes | `LimitsExceeded` |

The decoder checks the top-level size, canonical structure, version, suite, kind, fixed lengths, and bounded numeric profile in that order. Tests must assert the first applicable row.

- [ ] **Step 2: Run the focused test and observe RED**

```powershell
cargo test -p vault-crypto --test codec_limits --locked
```

Expected: compilation fails because the public API and codec do not exist. A passing test at this point means the test is not exercising the intended contract.

- [ ] **Step 3: Implement the non-sensitive error contract**

`error.rs` must expose:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CryptoErrorCode {
    UnsupportedVersion,
    UnsupportedSuite,
    NonCanonicalEncoding,
    InvalidLength,
    LimitsExceeded,
    KdfParamsRejected,
    AuthenticationFailed,
    RngUnavailable,
}

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("unsupported wire version")]
    UnsupportedVersion,
    #[error("unsupported crypto suite")]
    UnsupportedSuite,
    #[error("non-canonical envelope encoding")]
    NonCanonicalEncoding,
    #[error("invalid field length")]
    InvalidLength,
    #[error("configured limit exceeded")]
    LimitsExceeded,
    #[error("KDF parameters rejected")]
    KdfParamsRejected,
    #[error("authentication failed")]
    AuthenticationFailed,
    #[error("operating-system randomness unavailable")]
    RngUnavailable,
}
```

Implement `CryptoError::code()` as a total match. Error values must contain no password, plaintext, key, nonce, ciphertext, field value, or user-provided string.

- [ ] **Step 4: Implement bounded fixed-array decode and canonical re-encode**

Use internal structs `PasswordEnvelopeFields` and `RecordEnvelopeFields`. Each decode function must follow this order:

```rust
fn decode_password_envelope(input: &[u8]) -> Result<PasswordEnvelopeFields, CryptoError> {
    reject_if_over_64_kib(input)?;
    let fields = parse_fixed_password_array(input)?;
    validate_version_suite_kind(&fields)?;
    validate_password_field_lengths(&fields)?;
    validate_exact_candidate_kdf(&fields)?;
    if encode_password_envelope(&fields)? != input {
        return Err(CryptoError::NonCanonicalEncoding);
    }
    Ok(fields)
}
```

For records, also validate allowed bucket, exact `encrypted_body.len() == bucket + 16`, positive epoch, and full-envelope size. Never allocate from an untrusted length until the 64 KiB input cap and allowed bucket have been checked.

- [ ] **Step 5: Run codec tests to GREEN and format**

```powershell
cargo test -p vault-crypto --test codec_limits --locked
cargo fmt --all --check
```

- [ ] **Step 6: Commit the codec slice**

```powershell
git add crates/vault-crypto/src/lib.rs crates/vault-crypto/src/error.rs crates/vault-crypto/src/v0alpha1/mod.rs crates/vault-crypto/src/v0alpha1/codec.rs crates/vault-crypto/tests/codec_limits.rs
git diff --cached --check
git commit -m "feat: reject malformed v0alpha1 envelopes"
```

---

## Task 3: Add zeroizing secret types and OS entropy isolation

**Files:**

- Create: `crates/vault-crypto/src/secret.rs`
- Create: `crates/vault-crypto/src/v0alpha1/entropy.rs`
- Create: `crates/vault-crypto/tests/secret_traits.rs`
- Create: `crates/vault-crypto/tests/ui/secret_traits/*.rs`
- Create: `crates/vault-crypto/tests/ui/secret_traits/*.stderr`
- Modify: `crates/vault-crypto/src/lib.rs`

- [ ] **Step 1: Write compile-fail tests first**

`tests/secret_traits.rs`:

```rust
#[test]
fn secret_types_do_not_gain_logging_or_clone_traits() {
    let cases = trybuild::TestCases::new();
    cases.compile_fail("tests/ui/secret_traits/*.rs");
}
```

Create fifteen UI cases: `MasterPassword`, `SecretBytes`, and `VaultSession` each separately attempting `Debug`, `Display`, `Clone`, `Copy`, and `serde::Serialize`. Add a sixteenth case attempting `session.root_key_bytes()` to prove there is no raw root-key getter. Each file must fail for the expected missing trait or missing method. Generate and inspect every `.stderr` file using the pinned Rust toolchain; do not blindly accept unrelated compiler failures.

- [ ] **Step 2: Write unit tests for deterministic and failing test entropy**

Inside `entropy.rs`, under `#[cfg(test)]`, add a deterministic byte-stream entropy source and a source that always fails. Vault creation requests one 104-byte block for salt, commitment, root key, and root nonce; record sealing requests one 80-byte block for Item DEK, Item-DEK nonce, and body nonce. Tests must prove exact byte consumption and `CryptoErrorCode::RngUnavailable` without panic. They must also prove that a failed block fill performs no KDF or AEAD operation and returns no partially initialized key/nonce state. These test sources remain private to the crate and are not feature-gated public APIs.

- [ ] **Step 3: Run focused tests and observe RED**

```powershell
cargo test -p vault-crypto --test secret_traits --locked
cargo test -p vault-crypto entropy --locked
```

- [ ] **Step 4: Implement secret-bearing types without derived leak paths**

The public surface in `secret.rs` is:

```rust
pub struct MasterPassword(zeroize::Zeroizing<Vec<u8>>);
pub struct SecretBytes(zeroize::Zeroizing<Vec<u8>>);

impl MasterPassword {
    pub fn from_utf8(value: String) -> Result<Self, CryptoError>;
    pub(crate) fn expose_bytes(&self) -> &[u8];
}

impl SecretBytes {
    pub fn new(value: Vec<u8>) -> Result<Self, CryptoError>;
    pub fn expose_secret(&self) -> &[u8];
}
```

`MasterPassword` accepts 1 through 1,024 UTF-8 bytes and performs no Unicode normalization. `SecretBytes` accepts 0 through 61,436 bytes. Neither type derives traits. The explicit `expose_secret` method is the only plaintext read path and its documentation must warn callers not to log the result.

Both constructors must move the caller-owned `String` or `Vec<u8>` into a `Zeroizing` owner before checking its length. If validation fails, the rejected input is zeroized on drop rather than returned in an error.

Define `VaultCommitment([u8; 32])`, `OpaqueRecordId([u8; 16])`, `RevisionId([u8; 32])`, `KeyEpoch(u32)`, `PaddingBucketV0Alpha1`, `RecordContextV0Alpha1`, and `VaultSession`. Metadata types may implement `Clone`, `Eq`, and `PartialEq`, but not `Debug`, `Display`, or `Serialize`. `KeyEpoch::new(0)` returns `InvalidLength`.

`VaultSession` owns `Zeroizing<[u8; 32]>` and a commitment, exposes only `commitment()`, and has no key-byte getter.

- [ ] **Step 5: Implement OS entropy behind a private trait**

```rust
pub(crate) trait EntropySource {
    fn fill(&mut self, destination: &mut [u8]) -> Result<(), CryptoError>;
}

pub(crate) struct OsEntropy;

impl EntropySource for OsEntropy {
    fn fill(&mut self, destination: &mut [u8]) -> Result<(), CryptoError> {
        getrandom::fill(destination).map_err(|_| CryptoError::RngUnavailable)
    }
}
```

- [ ] **Step 6: Run tests to GREEN**

```powershell
cargo test -p vault-crypto --test secret_traits --locked
cargo test -p vault-crypto entropy --locked
cargo fmt --all --check
```

- [ ] **Step 7: Commit the secret-type slice**

```powershell
git add crates/vault-crypto/src/lib.rs crates/vault-crypto/src/secret.rs crates/vault-crypto/src/v0alpha1/entropy.rs crates/vault-crypto/tests/secret_traits.rs crates/vault-crypto/tests/ui
git diff --cached --check
git commit -m "feat: isolate zeroizing vault secret types"
```

---

## Task 4: Implement password root-key wrapping with TDD

**Files:**

- Create: `crates/vault-crypto/src/v0alpha1/kdf.rs`
- Create: `crates/vault-crypto/src/v0alpha1/wrap.rs`
- Create: `crates/vault-crypto/tests/password_wrap.rs`
- Modify: `crates/vault-crypto/src/v0alpha1/codec.rs`
- Modify: `crates/vault-crypto/src/v0alpha1/mod.rs`
- Modify: `crates/vault-crypto/src/lib.rs`

- [ ] **Step 1: Write black-box password-wrap tests first**

Tests must cover:

```rust
#[test]
fn creates_and_unlocks_a_synthetic_vault() {
    let password = MasterPassword::from_utf8("synthetic master phrase only".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let unlocked = unlock_vault_v0alpha1(&password, &created.password_envelope).unwrap();
    assert!(unlocked.commitment() == created.session.commitment());
}

#[test]
fn wrong_password_is_only_authentication_failed() {
    let password = MasterPassword::from_utf8("synthetic master phrase only".to_owned()).unwrap();
    let wrong = MasterPassword::from_utf8("different synthetic phrase".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let error = match unlock_vault_v0alpha1(&wrong, &created.password_envelope) {
        Ok(_) => panic!("a different synthetic password unexpectedly unlocked the vault"),
        Err(error) => error,
    };
    assert_eq!(error.code(), CryptoErrorCode::AuthenticationFailed);
}

#[test]
fn repeated_creation_with_the_same_password_has_different_envelopes() {
    let password = MasterPassword::from_utf8("synthetic master phrase only".to_owned()).unwrap();
    let first = create_vault_v0alpha1(&password).unwrap();
    let second = create_vault_v0alpha1(&password).unwrap();
    assert_ne!(first.password_envelope, second.password_envelope);
}

#[test]
fn unicode_password_bytes_are_not_normalized() {
    let composed = MasterPassword::from_utf8("synthetic caf\u{00e9} phrase".to_owned()).unwrap();
    let decomposed = MasterPassword::from_utf8("synthetic cafe\u{0301} phrase".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&composed).unwrap();
    let error = match unlock_vault_v0alpha1(&decomposed, &created.password_envelope) {
        Ok(_) => panic!("distinct UTF-8 password bytes unexpectedly unlocked the vault"),
        Err(error) => error,
    };
    assert_eq!(error.code(), CryptoErrorCode::AuthenticationFailed);
}
```

The public calls are:

```rust
pub struct CreatedVaultV0Alpha1 {
    pub password_envelope: Vec<u8>,
    pub session: VaultSession,
}

pub fn create_vault_v0alpha1(
    password: &MasterPassword,
) -> Result<CreatedVaultV0Alpha1, CryptoError>;

pub fn unlock_vault_v0alpha1(
    password: &MasterPassword,
    password_envelope: &[u8],
) -> Result<VaultSession, CryptoError>;
```

- [ ] **Step 2: Run the focused test and observe RED**

```powershell
cargo test -p vault-crypto --test password_wrap --locked
```

- [ ] **Step 3: Implement and test the RFC 9106 Argon2id primitive vector**

In `kdf.rs`, add an internal test using RFC 9106 section 5.3 inputs: 32-byte password of `0x01`, 16-byte salt of `0x02`, 8-byte secret of `0x03`, 12-byte associated data of `0x04`, 32 KiB memory, 3 passes, 4 lanes, and this published 32-byte tag:

```text
0d 64 0d f5 8d 78 76 6c 08 c0 37 a3 4a 8b 53 c9
d0 1e f0 45 2d 75 b6 5e b5 25 20 e9 6b 01 e6 59
```

This test checks the primitive independently of the application profile.

The runtime derivation uses Argon2id v1.3 with exactly 65,536 KiB, 3 passes, 4 lanes, and a 32-byte output. Reject any decoded profile mismatch before calling Argon2. Allocate exactly `params.block_count()` `argon2::Block` values inside a zeroizing owner, call `hash_password_into_with_memory`, and explicitly zeroize the working blocks and 32-byte output on every success or error return. Do not use the convenience allocator whose internal working-memory lifetime cannot be controlled by this crate.

- [ ] **Step 4: Implement root wrapping with exact AAD and zeroization**

Internal creation flow:

```text
OS RNG -> salt[16], commitment[32], root_key[32], root_nonce[24]
Argon2id(password bytes, salt) -> Zeroizing password_kek[32]
canonical password-root AAD -> bytes
XChaCha20-Poly1305(password_kek).encrypt(
    root_nonce,
    Payload { msg: root_key, aad: &aad },
)
strict encode password envelope
return encoded envelope plus VaultSession(root_key, commitment)
```

AAD is never concatenated to plaintext. The exact same `Payload { msg, aad }` pattern is mandatory for password-root wrapping, Item-DEK wrapping, and record-body encryption and decryption.

Unlock flow decodes and validates first, derives the KEK, recreates AAD, authenticates and decrypts the 48-byte wrapped root, immediately moves the returned `Vec<u8>` into `Zeroizing<Vec<u8>>`, validates the recovered key length, copies it into the session's zeroizing fixed array, and returns a session. Map both wrong password and root-wrap tampering to `AuthenticationFailed`. A constructor failure must not leave an unwrapped input buffer outside a zeroizing owner.

- [ ] **Step 5: Add mutation cases that cannot allocate attacker-selected KDF work**

Add tests for salt mutation, commitment mutation, root nonce mutation, wrapped-root first/middle/last-byte mutation, rejected KDF parameters, unsupported version, and unsupported suite. The abnormal KDF parameter test must prove it returns `KdfParamsRejected` before the Argon2 call by using an internal counting KDF wrapper or a unit-test-only hook.

- [ ] **Step 6: Run password tests to GREEN**

```powershell
cargo test -p vault-crypto --test password_wrap --locked -- --test-threads=1
cargo test -p vault-crypto kdf --locked
cargo fmt --all --check
```

- [ ] **Step 7: Commit the root-wrap slice**

```powershell
git add crates/vault-crypto/src/lib.rs crates/vault-crypto/src/v0alpha1/codec.rs crates/vault-crypto/src/v0alpha1/kdf.rs crates/vault-crypto/src/v0alpha1/mod.rs crates/vault-crypto/src/v0alpha1/wrap.rs crates/vault-crypto/tests/password_wrap.rs
git diff --cached --check
git commit -m "feat: wrap synthetic vault roots with Argon2id"
```

---

## Task 5: Implement per-record item envelopes and tamper rejection

**Files:**

- Create: `crates/vault-crypto/src/v0alpha1/record.rs`
- Create: `crates/vault-crypto/tests/local_alpha_flow.rs`
- Create: `crates/vault-crypto/tests/tamper_rejection.rs`
- Modify: `crates/vault-crypto/src/v0alpha1/codec.rs`
- Modify: `crates/vault-crypto/src/v0alpha1/mod.rs`
- Modify: `crates/vault-crypto/src/lib.rs`

- [ ] **Step 1: Write the synthetic round-trip test first**

```rust
use vault_crypto::{
    KeyEpoch, MasterPassword, OpaqueRecordId, PaddingBucketV0Alpha1,
    RecordContextV0Alpha1, RevisionId, SecretBytes, create_vault_v0alpha1,
    open_record_v0alpha1, seal_record_v0alpha1,
};

#[test]
fn seals_and_opens_one_explicitly_synthetic_record() {
    let password = MasterPassword::from_utf8("synthetic master phrase only".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let context = RecordContextV0Alpha1::new(
        created.session.commitment(),
        OpaqueRecordId::from_bytes([0x11; 16]),
        RevisionId::from_bytes([0x22; 32]),
        KeyEpoch::new(1).unwrap(),
        PaddingBucketV0Alpha1::Bytes1024,
    );
    let original = SecretBytes::new(b"DEMO_VALUE_ONLY_0001".to_vec()).unwrap();
    let envelope = seal_record_v0alpha1(&created.session, &context, &original).unwrap();
    let restored = open_record_v0alpha1(&created.session, &context, &envelope).unwrap();
    assert_eq!(restored.expose_secret(), b"DEMO_VALUE_ONLY_0001");
    assert!(envelope.len() <= 65_536);
}
```

- [ ] **Step 2: Write tamper and context-swap tests before implementation**

Cover all of these cases:

- different vault commitment;
- different record ID;
- different revision ID;
- different key epoch;
- different padding bucket;
- swapped record ciphertext from another record;
- first, middle, and last byte of wrapped item key;
- first, middle, and last byte of encrypted body;
- truncated envelope and appended trailing byte;
- plaintext exactly 0, 1, bucket-minus-4, and bucket-minus-3 bytes;
- largest 61,436-byte plaintext in the 61,440-byte bucket;
- plaintext larger than 61,436 bytes.

Context swaps and AEAD mutations must return only `AuthenticationFailed`; invalid local plaintext sizes return `LimitsExceeded`; malformed envelope structure returns the documented codec error. Because `SecretBytes` deliberately has no `Debug`, negative tests must use `match` instead of `unwrap_err()` on `Result<SecretBytes, CryptoError>`.

- [ ] **Step 3: Run the two tests and observe RED**

```powershell
cargo test -p vault-crypto --test local_alpha_flow --locked
cargo test -p vault-crypto --test tamper_rejection --locked
```

- [ ] **Step 4: Implement item-key wrapping and padded body encryption**

The internal seal flow is exactly:

```text
verify session commitment equals context commitment
verify the caller-selected allowed bucket fits 4 + plaintext length
OS RNG -> item_dek[32], item_key_nonce[24], body_nonce[24]
body_plaintext = uint32_be(length) || plaintext || zero padding to bucket
wrap item_dek under Vault Root Key with `Payload { msg: item_dek, aad: &item_dek_aad }`
encrypt body_plaintext under item_dek with `Payload { msg: body_plaintext, aad: &item_body_aad }`
zeroize item_dek and padded body buffers
strict encode and enforce full-envelope <= 65,536 bytes
```

The open flow strictly decodes, compares every envelope context field with the expected context, unwraps the Item DEK, immediately moves the returned key bytes into a zeroizing owner, decrypts the body with the separate body AAD, immediately moves that returned `Vec<u8>` into `Zeroizing<Vec<u8>>`, validates its four-byte length prefix and all remaining zero padding, and returns `SecretBytes`. It must never return a partial plaintext or overwrite caller state on failure.

- [ ] **Step 4a: Test authenticated malformed bodies and cleanup paths**

In a crate-private test, use a fixed synthetic test session and the internal sealing primitive to create valid AEAD tags for two invalid padded bodies: a length prefix larger than the selected bucket and a valid length followed by nonzero padding. Both open attempts return `AuthenticationFailed`, the same outward code as tampering. Instrument a test-only zeroizing buffer wrapper with a drop counter and assert the decrypted body and unwrapped Item DEK cleanup paths execute on both failures.

- [ ] **Step 5: Run record tests to GREEN**

```powershell
cargo test -p vault-crypto --test local_alpha_flow --locked
cargo test -p vault-crypto --test tamper_rejection --locked
cargo fmt --all --check
```

- [ ] **Step 6: Commit the record slice**

```powershell
git add crates/vault-crypto/src/lib.rs crates/vault-crypto/src/v0alpha1/codec.rs crates/vault-crypto/src/v0alpha1/mod.rs crates/vault-crypto/src/v0alpha1/record.rs crates/vault-crypto/tests/local_alpha_flow.rs crates/vault-crypto/tests/tamper_rejection.rs
git diff --cached --check
git commit -m "feat: seal synthetic records with item envelopes"
```

---

## Task 6: Add bounded property tests, regression vectors, and a safe example

**Files:**

- Create: `crates/vault-crypto/src/v0alpha1/tests.rs`
- Create: `crates/vault-crypto/tests/properties.rs`
- Create: `crates/vault-crypto/tests/vectors.rs`
- Create: `crates/vault-crypto/examples/synthetic_local_alpha.rs`
- Create: `tests/fixtures/synthetic/v0alpha1-vectors.json`
- Modify: `tests/fixtures/synthetic/README.md`
- Modify: `crates/vault-crypto/src/v0alpha1/mod.rs`

- [ ] **Step 1: Write bounded codec property tests**

Use `proptest` to feed byte vectors of length 0 through 70,000 to both public envelope inspection functions inside `catch_unwind`. Assert only that decoding returns normally without panic; cap the number of cases at 256 and do not invoke Argon2 in this property test.

Add a second property test inside crate-only `v0alpha1/tests.rs` that constructs one fixed test session without running the password KDF, generates synthetic plaintext lengths 0 through 1,020, and asserts exact seal/open round-trip. Configure 32 cases and a single test thread to bound memory and runtime. The test session constructor remains private under `#[cfg(test)]`; integration tests and production code cannot call it.

- [ ] **Step 2: Add deterministic internal entropy regression vectors**

Inside the crate-only `v0alpha1/tests.rs`, create a deterministic entropy stream containing sequential bytes `0x00..0x67` for vault creation and `0x80..0xCF` for record sealing. Use the private test-only entropy path and the literal password `synthetic vector phrase` plus payload `DEMO_VALUE_ONLY_0001`.

The internal test first prints one compact JSON object containing the following fixed scalar fields and the two exact decimal byte arrays produced by the deterministic entropy stream:

```text
status = compatibility-regression-only-not-independently-verified
wire_version = 0
suite_id = 41217
password = synthetic vector phrase
payload = DEMO_VALUE_ONLY_0001
opaque_record_id_byte = 17
revision_id_byte = 34
key_epoch = 1
padding_bucket = 1024
password_envelope_bytes = exact non-empty decimal byte array
record_envelope_bytes = exact non-empty decimal byte array
```

Inspect that one-time output, then use `apply_patch` to create `tests/fixtures/synthetic/v0alpha1-vectors.json` with those exact arrays. Change the vector test to load the committed fixture and compare each byte exactly. The test must explicitly assert that neither array is empty, and no empty-vector fixture may be committed. Review that the fixture contains only the literal synthetic values above. Record in the ADR that these bytes are compatibility regression data, not independent cryptographic validation.

The crate-private unit test owns deterministic generation and exact-byte comparison. The public integration test `tests/vectors.rs` loads the same fixture, unlocks its password envelope through the public API, opens its record envelope through the public API, and checks the synthetic payload. This proves both the private regression generator and the public compatibility reader exercise the committed bytes.

- [ ] **Step 2a: Add an upstream XChaCha20-Poly1305 known-answer test**

Add a primitive unit test using the draft-irtf-cfrg-xchacha Appendix A.3.1 key, 24-byte nonce, AAD, plaintext, and ciphertext-with-tag. Keep the vector in a dedicated test constant and cite the draft section in a comment. This is separate from the application envelope vector.

- [ ] **Step 3: Write the safe CLI example**

The example creates, locks, unlocks, seals, tampers with a copy, and opens one embedded synthetic record. It must print only:

```text
SYNTHETIC_ALPHA_OK
items=1
tamper_rejected=true
```

It must not accept command-line input, environment variables, files, stdin, clipboard data, or network data, and must not print password, plaintext, IDs, keys, nonces, envelope bytes, or errors containing inputs.

- [ ] **Step 4: Run vector, property, and example checks**

```powershell
cargo test -p vault-crypto v0alpha1::tests --locked -- --test-threads=1
cargo test -p vault-crypto --test vectors --locked
cargo test -p vault-crypto --test properties --locked -- --test-threads=1
cargo run -p vault-crypto --example synthetic_local_alpha --locked
```

Expected example output is exactly the three lines above.

- [ ] **Step 5: Commit the assurance slice**

```powershell
git add crates/vault-crypto/src/v0alpha1/mod.rs crates/vault-crypto/src/v0alpha1/tests.rs crates/vault-crypto/tests/properties.rs crates/vault-crypto/tests/vectors.rs crates/vault-crypto/examples/synthetic_local_alpha.rs tests/fixtures/synthetic/README.md tests/fixtures/synthetic/v0alpha1-vectors.json docs/adr/0002-v0alpha1-crypto-suite.md
git diff --cached --check
git commit -m "test: harden the synthetic crypto harness"
```

---

## Task 7: Verify the whole alpha and back up the implementation branch

**Files:**

- Modify: `README.md`
- Modify: `crates/vault-crypto/README.md`
- Modify: `docs/MVP.md`
- Create: `docs/verification/v0alpha1-synthetic-crypto-harness.md`

- [ ] **Step 1: Document only verified capability**

Update the READMEs and MVP status to say:

- implemented: local synthetic password-root wrap, synthetic record seal/open, strict v0alpha1 codec, mutation rejection tests;
- not implemented: real Secret support, recovery, device revocation, persistence, sync, Web/Android UI, billing, store release, OpenAI plugin;
- prohibited: entering or importing real credentials;
- next gate: independent crypto review plus a separate recovery/device-key ADR.

- [ ] **Step 2: Run the complete deterministic verification set**

```powershell
cargo metadata --locked --format-version 1 --no-deps
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --all-features --locked -- --test-threads=1
cargo run -p vault-crypto --example synthetic_local_alpha --locked
cargo tree --workspace --locked -d
git diff --check
git status --short
```

Record command, exit code, date, Rust version, commit hash, and the exact three-line example output in `docs/verification/v0alpha1-synthetic-crypto-harness.md`. Do not paste full environment dumps or any local credential-like value.

- [ ] **Step 3: Run a bounded repository Secret-pattern scan**

If `gitleaks` is available, run:

```powershell
gitleaks dir . --redact --no-banner
gitleaks git . --redact --no-banner
```

If it is unavailable, record that limitation and run the repository's bounded fallback patterns with `rg` for common private-key headers and known token prefixes, then manually inspect every newly added fixture and staged diff. A fallback pass must not be represented as equivalent to gitleaks.

- [ ] **Step 4: Review the staged file set before commit**

```powershell
git add README.md crates/vault-crypto/README.md docs/MVP.md docs/verification/v0alpha1-synthetic-crypto-harness.md
git diff --cached --check
git diff --cached --name-status
git diff --cached
git status --short
```

Expected: only documented v0alpha1 source, tests, contracts, synthetic fixtures, and verification records are present. No `.env`, database, export, log, key, keystore, token, build output, or unrelated workspace file is staged.

- [ ] **Step 5: Commit and push the implementation branch**

```powershell
git commit -m "feat: complete v0alpha1 synthetic crypto harness"
git push -u origin codex/firstvibe-v0alpha1-crypto
```

- [ ] **Step 6: State the truthful handoff**

Report that the Private GitHub branch is a code backup and review surface, not a vault-data backup. Explicitly state that the alpha remains synthetic-only and that actual passwords/API keys must not be entered until the independent-review and recovery/device gates are complete.
