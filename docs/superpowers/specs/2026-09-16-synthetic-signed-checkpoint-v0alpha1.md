# 합성 Signed Checkpoint v0alpha1 명세

- 상태: 구현 전 보안 명세 고정; 의존성·독립 벡터 승인 전 구현 금지
- 기준일: 2026-09-16
- 적용 범위: 사용자·계정·서버 없이 수행하는 합성 successor checkpoint 코어
- 출시 경계: **`REAL_SECRET_GATE=CLOSED`**

## 1. 목적

현재 로컬 코어의 immutable revision, expected-head CAS, envelope 인증과
RO→RW logical digest는 정상 API의 stale writer와 같은 process 안의 변화를
다룬다. 그러나 유효한 과거 DB/WAL 전체 복원, canonical head rollback, 논리
record 전체 누락을 탐지하는 freshness/completeness anchor는 아니다.

이 명세는 기존 제로지식·기기 키 방향을 유지하면서 다음 한 단위만 고정한다.

> 이미 신뢰된 이전 checkpoint anchor와 고정된 기기 서명 roster가 있을 때,
> 합성 current-head/tombstone manifest commitment를 포함한 다음 checkpoint의
> canonical bytes를 만들고 Ed25519 기기 서명을 검증한다.

이번 단위는 contract, 순수 Rust codec/commitment/verifier와 합성 테스트까지다.
SQLite, IndexedDB, Web UI, 서버, 계정, Android Keystore, 복구 상태기계 또는
운영 배포에는 연결하지 않는다. 첫 checkpoint를 신뢰하게 만드는 bootstrap도
구현하지 않는다.

블록체인은 필요하지 않으며 도입하지 않는다. 이 문제에 필요한 최소 구성은
기기 서명, hash-linked checkpoint, 이전에 신뢰된 외부 anchor다. 독립 witness가
필요한 후속 위협모델도 특정 블록체인 구현을 요구하지 않는다.

## 2. 기존 결정과 이번 명세의 관계

다음 기존 결정을 바꾸지 않는다.

- 서버는 금고 평문과 의미 있는 메타데이터를 복호화하지 않는다.
- wrapping key와 device signing key는 서로 다른 키다.
- 기기는 checkpoint의 canonical bytes를 별도 signing key로 서명한다.
- checkpoint는 이전 checkpoint hash, 현재 `key_epoch`, 기기 roster, 현재
  item heads와 tombstone commitment에 결합한다.
- 기존 신뢰 기기는 마지막 checkpoint hash를 별도 보존하고, parent 불일치나
  fork를 자동 병합하지 않는다.
- 완전 신규 복구 클라이언트의 강한 targeted rollback 탐지는 외부에 기억된
  최신 상태 또는 독립 witness 없이는 보장하지 않는다.

현재 `RevisionIdV1`은 32-byte 난수 식별자이며 content hash가 아니다. 따라서
manifest는 `(record_id, revision_id)`만 묶지 않고, 권위 있는 head blob의 정확한
bytes에 대한 별도 `head_blob_commitment`도 반드시 묶는다.

## 3. 범위와 비범위

### 3.1 포함

- bounded canonical manifest와 device signer roster
- domain-separated BLAKE3 commitment
- canonical checkpoint body와 signed checkpoint envelope
- 외부 signer가 서명할 exact message 생성
- 고정 roster의 Ed25519 public key를 사용한 successor 검증
- 이전 trusted anchor에 대한 parent, global sequence, per-device sequence 검증
- same-epoch, same-roster successor만 허용하는 fail-closed 상태 전이
- 합성 active head와 합성 tombstone commitment 테스트

### 3.2 제외

- 최초 checkpoint 또는 trust-on-first-use bootstrap
- raw 서버 응답을 trusted anchor로 승격하는 API
- roster 추가·교체·폐기, recovery transition, `key_epoch` 증가
- 개별 revision 서명과 parent event DAG
- 제품용 signed tombstone event, 삭제·GC
- SQLite/IndexedDB schema와 영속 anchor
- 서버 CAS, sync API, 계정·세션·도메인
- OS monotonic counter, Android Keystore, 생체 승인, attestation
- checkpoint 본문 암호화와 full device/recovery-slot roster
- transparency witness, gossip 또는 다중 기기 fork 비교
- 실제 Secret, 실제 사용자 데이터와 공개 베타

## 4. 위협모델

### 4.1 다루는 공격

저장소·서버·네트워크는 신뢰하지 않는다. 공격자는 다음을 시도할 수 있다.

- 과거에 유효했던 signed checkpoint replay
- 독립적으로 완전성이 확인된 observed manifest와 signed commitment 사이의
  record/head/tombstone 불일치
- manifest entry 재정렬·중복·대체
- 같은 record/revision ID 아래 head blob bytes 바꿔치기
- 다른 vault·epoch·roster의 checkpoint 교체
- checkpoint parent 건너뛰기 또는 sequence 되감기
- roster에 없는 기기의 self-signed checkpoint 제시
- 같은 parent에서 갈라진 sibling checkpoint 제시

### 4.2 신뢰 전제

이 단위는 다음 입력만 신뢰한다.

- 호출자가 이미 별도 경로로 신뢰한 `TrustedCheckpointAnchorV0Alpha1`
- 그 anchor에 commitment로 묶인 exact signer roster bytes
- roster 안 기기의 uncompromised Ed25519 public/private key 관계
- manifest entry가 앞 단계에서 exact authoritative blob과 연결됐다는 로컬
  adapter의 인증 결과
- 승인된 canonical codec, BLAKE3와 Ed25519 구현

`CanonicalManifestV0Alpha1`이라는 이름은 정렬·중복·encoding 규칙을
만족했다는 뜻일 뿐, 입력이 완전하거나 최신이라는 뜻이 아니다.

### 4.3 보안 판정의 범위

검증 성공은 오직 다음을 뜻한다.

1. candidate가 prior anchor의 exact successor다.
2. prior roster의 지정 기기 서명이 candidate body에 유효하다.
3. candidate가 제시한 manifest commitment와 호출자가 제공한 canonical
   manifest가 일치한다.
4. same vault, same epoch, same roster와 증가한 sequence 규칙을 만족한다.

검증 성공만으로 manifest source가 완전했다거나 OS가 prior anchor를 rollback에서
보호했다는 결론을 내리지 않는다.

특히 저장소가 record를 숨긴 뒤 signer와 verifier 양쪽에 같은 불완전 manifest를
제공하면 이 primitive만으로는 그 누락을 탐지할 수 없다. successor 자체의
completeness를 검증하려면 후속 단계에서 prior manifest entry 집합 또는 인증된
event transition/delta proof가 별도 검증 입력으로 필요하다.

## 5. 정확한 primitive와 상수

아래 정수는 unsigned다. 모든 byte array는 고정 길이다.

| 이름 | 값/범위 |
| --- | --- |
| `CHECKPOINT_WIRE_VERSION` | `0` |
| `CHECKPOINT_SUITE_ID` | `0xA201` (`41473`) — 합성 전용 |
| checkpoint object kind | `3` |
| manifest object kind | `4` |
| signer-roster object kind | `5` |
| `VaultCommitment` | 32 bytes |
| `OpaqueRecordId` | 16 bytes |
| `RevisionId` | 32 bytes |
| `DeviceId` | 16 bytes |
| BLAKE3 commitment/hash | 32 bytes |
| Ed25519 public key | 32 bytes |
| Ed25519 signature | 64 bytes |
| `key_epoch` | `1..=4_294_967_295` |
| checkpoint/device sequence | `1..=18_446_744_073_709_551_615` |
| manifest entries | `0..=5_000` |
| signer roster entries | `1..=64` |
| authoritative head blob | `1..=65_536` bytes |
| canonical manifest | 최대 `524_288` bytes |
| canonical signer roster | 최대 `8_192` bytes |
| canonical checkpoint body | 최대 `512` bytes |
| signed checkpoint envelope | 최대 `640` bytes |

`0xA201`은 기존 encryption suite `0xA101`을 재사용하지 않기 위한 이 명세의
합성 전용 식별자다. 실제 Secret용 protocol suite로 승인된 값이 아니다.

## 6. Domain separation과 hash

아래 문자열은 newline이나 trailing NUL이 없는 exact ASCII다.

```text
keyatlas/synthetic-signed-checkpoint-v0alpha1/head-blob
keyatlas/synthetic-signed-checkpoint-v0alpha1/manifest
keyatlas/synthetic-signed-checkpoint-v0alpha1/signer-roster
keyatlas/synthetic-signed-checkpoint-v0alpha1/checkpoint-id
keyatlas/synthetic-signed-checkpoint-v0alpha1/ed25519-signature
```

네 hash는 모두 BLAKE3 derive-key mode를 사용한다. 각 operation은 해당 exact
context string으로 새 hasher를 만들고 payload bytes를 한 번의 논리 stream으로
입력한 뒤 32-byte output을 사용한다. context를 일반 payload prefix로 대체하거나
서로 다른 operation에서 재사용하지 않는다.

```text
head_blob_commitment = BLAKE3-DERIVE(head-blob-domain, exact_head_blob)
manifest_commitment  = BLAKE3-DERIVE(manifest-domain, canonical_manifest)
roster_commitment    = BLAKE3-DERIVE(signer-roster-domain, canonical_roster)
checkpoint_hash      = BLAKE3-DERIVE(checkpoint-id-domain,
                                    canonical_signed_checkpoint)
```

Ed25519가 서명·검증하는 message는 다음 exact concatenation이다.

```text
ASCII(ed25519-signature-domain)
|| 0x00
|| uint64_be(canonical_checkpoint_body.length)
|| canonical_checkpoint_body
```

signature는 checkpoint body CBOR만 직접 서명하거나, checkpoint hash만 서명하거나,
Ed25519ph로 임의 변경해서는 안 된다. 이 규칙을 바꾸면 새 suite ID가 필요하다.

## 7. Canonical CBOR 계약

RFC 8949 deterministic encoding의 아래 제한 subset만 허용한다.

- definite-length array, unsigned integer와 byte string만 사용한다.
- integer와 length는 가능한 가장 짧은 encoding을 사용한다.
- map, text string, tag, float, negative integer, `null`, indefinite length를
  허용하지 않는다.
- top-level object 뒤 trailing bytes를 허용하지 않는다.
- decoder는 구조·상한을 확인한 뒤 다시 encode해 input과 byte-for-byte 비교한다.
- 알려지지 않은 field 추가, field 생략·재정렬은 허용하지 않는다.

### 7.1 Manifest

```cddl
manifest-v0alpha1 = [
  0,
  41473,
  4,
  entries: [* manifest-entry-v0alpha1]
]

manifest-entry-v0alpha1 = [
  opaque-record-id: bytes .size 16,
  revision-id: bytes .size 32,
  disposition: 0 / 1, ; 0=current, 1=tombstone
  head-blob-commitment: bytes .size 32
]
```

entry는 `opaque-record-id`의 unsigned byte lexicographic order로 엄격하게
증가해야 한다. 같은 record ID가 두 번 나오면 revision·disposition이 달라도
`DuplicateRecord`다. builder는 입력 순서와 무관하게 정렬하지만 wire decoder는
정렬되지 않은 bytes를 non-canonical로 거부한다. 빈 manifest는 허용한다.

`current`의 authoritative blob은 exact canonical record envelope 또는 후속 signed
revision event다. `tombstone`의 authoritative blob은 후속 signed tombstone event다.
현재 제품 tombstone wire는 없으므로 이번 단위에서 `tombstone`은 합성 fixture로만
검증하며 production adapter가 생성해서는 안 된다.

### 7.2 Checkpoint signer roster

```cddl
signer-roster-v0alpha1 = [
  0,
  41473,
  5,
  devices: [1* signer-device-v0alpha1]
]

signer-device-v0alpha1 = [
  device-id: bytes .size 16,
  ed25519-public-key: bytes .size 32,
  role-bits: 1..3
]
```

`role-bits`는 `sync_client=0x01`, `recovery_authenticator=0x02`이며 이외 bit는
거부한다. 이번 same-roster slice에서는 두 role 모두 checkpoint 서명 권한을
부여하지 않는다. checkpoint signer는 반드시 `sync_client` bit를 가져야 한다.

device entry는 `device-id` 순으로 엄격하게 증가하고 ID·public key 중복을 모두
거부한다. 이 roster는 checkpoint signer 검증에 필요한 최소 공개 subset이다.
기기 이름, wrapping key, Key Slot, attestation과 사용자 정보는 포함하지 않는다.
full product device/recovery roster라고 부르지 않는다.

### 7.3 Checkpoint body와 signed envelope

```cddl
checkpoint-body-v0alpha1 = [
  0,
  41473,
  3,
  vault-commitment: bytes .size 32,
  checkpoint-sequence: 1..18446744073709551615,
  previous-checkpoint-hash: bytes .size 32,
  key-epoch: 1..4294967295,
  signer-roster-commitment: bytes .size 32,
  signer-roster-entry-count: 1..64,
  manifest-commitment: bytes .size 32,
  manifest-entry-count: 0..5000,
  signer-device-id: bytes .size 16,
  signer-device-sequence: 1..18446744073709551615
]

signed-checkpoint-v0alpha1 = [
  canonical-body: bytes .size (1..512),
  ed25519-signature: bytes .size 64
]
```

`canonical-body`는 위 checkpoint body의 exact canonical CBOR bytes다. signed
envelope decoder는 body를 다시 strict decode/re-encode하고 exact equality를
확인한다. signature가 유효해도 non-canonical body는 거부한다.

timestamp는 권위 있는 ordering source가 아니므로 넣지 않는다. 표시용 시각이
필요해도 이 protocol의 rollback 판정에 사용하지 않는다.

## 8. 상태 전이 규칙

candidate가 prior anchor의 successor가 되려면 모두 만족해야 한다.

1. `vault_commitment == prior.vault_commitment`
2. `previous_checkpoint_hash == prior.checkpoint_hash`
3. `checkpoint_sequence == prior.checkpoint_sequence + 1`
4. `key_epoch == prior.key_epoch`
5. roster commitment와 entry count가 prior와 정확히 같음
6. 제공 roster bytes의 commitment/count가 prior와 정확히 같음
7. signer device가 roster에 있고 `sync_client` bit를 가짐
8. `signer_device_sequence == prior.last_device_sequence[signer] + 1`
9. Ed25519 signature가 exact signing message에 유효함
10. 제공 manifest의 commitment/count가 candidate와 정확히 같음

sequence가 최대값이면 wrap하지 않고 `CounterExhausted`다. exact candidate hash가
prior checkpoint hash와 같더라도, 제공 roster와 observed manifest의 commitment/count가
prior anchor와 각각 정확히 일치하는지 먼저 검증한다. 둘 중 하나라도 다르면 성공이나
`AlreadyTrusted`가 아니라 candidate rejection이다. 모두 일치할 때만 새 successor가
아닌 idempotent `AlreadyTrusted` outcome이다. 다른 과거 candidate는 자동
복구·병합하지 않는다.

`last_device_sequences` map은 trusted anchor가 결합한 roster의 `sync_client` device
ID 전체와 정확히 같은 key set을 가져야 한다. 아직 checkpoint를 서명하지 않은
sync client의 값은 `0`이다. successor anchor는 prior map 전체를 그대로 복사한 뒤
이번 signer의 값 하나만 candidate의 값으로 교체한다. 다른 기기의 값이나 key를
삭제·감소·추가해서는 안 되며, 이 불변조건 위반은 candidate 오류가 아니라 내부
`InvariantViolation`이다.

이번 버전에서 epoch 또는 roster가 달라지면 유효한 서명이 있어도 각각
`EpochTransitionUnsupported`, `RosterTransitionUnsupported`다. 새 기기가 자기
public key를 넣고 자기 roster를 self-sign해서 신뢰를 얻을 수 없다.

## 9. Rust type와 API 계약

향후 승인 뒤 별도 순수 crate `vault-checkpoint-core`에 아래 API를 구현한다.
이 crate는 storage, network, Web, Android 또는 account crate에 의존하지 않는다.

```rust
pub enum ManifestDispositionV0Alpha1 {
    Current = 0,
    Tombstone = 1,
}

pub struct ManifestEntryV0Alpha1 {
    record_id: [u8; 16],
    revision_id: [u8; 32],
    disposition: ManifestDispositionV0Alpha1,
    head_blob_commitment: [u8; 32],
}

pub struct SignerRosterEntryV0Alpha1 {
    device_id: [u8; 16],
    ed25519_public_key: [u8; 32],
    role_bits: u8,
}

pub struct CanonicalManifestV0Alpha1 {
    bytes: Vec<u8>,
    commitment: [u8; 32],
    entry_count: u32,
}

pub struct CanonicalSignerRosterV0Alpha1 {
    bytes: Vec<u8>,
    commitment: [u8; 32],
    entry_count: u16,
}

pub struct TrustedCheckpointAnchorV0Alpha1 {
    vault_commitment: [u8; 32],
    checkpoint_hash: [u8; 32],
    checkpoint_sequence: u64,
    key_epoch: u32,
    signer_roster_commitment: [u8; 32],
    signer_roster_entry_count: u16,
    manifest_commitment: [u8; 32],
    manifest_entry_count: u32,
    last_device_sequences: BTreeMap<[u8; 16], u64>,
}

pub struct CheckpointSigningRequestV0Alpha1 {
    canonical_body: Vec<u8>,
    signing_message: Vec<u8>,
}

pub struct SignedCheckpointV0Alpha1 {
    canonical_envelope: Vec<u8>,
}

pub struct VerifiedCheckpointV0Alpha1 {
    anchor: TrustedCheckpointAnchorV0Alpha1,
}

pub enum CheckpointVerificationOutcomeV0Alpha1 {
    Accepted(VerifiedCheckpointV0Alpha1),
    AlreadyTrusted,
}
```

모든 field는 private다. public getter는 public commitment, count, sequence와 exact
signing message의 borrowed view만 제공한다. `TrustedCheckpointAnchorV0Alpha1`에는
raw bytes, hash 또는 caller-provided counters로 만드는 public constructor와
`Deserialize`를 제공하지 않는다.

정확한 함수 경계는 다음과 같다.

```rust
pub fn commit_head_blob_v0alpha1(
    exact_authoritative_blob: &[u8],
) -> Result<[u8; 32], CheckpointErrorV0Alpha1>;

pub fn build_manifest_v0alpha1(
    entries: Vec<ManifestEntryV0Alpha1>,
) -> Result<CanonicalManifestV0Alpha1, CheckpointErrorV0Alpha1>;

pub fn build_signer_roster_v0alpha1(
    entries: Vec<SignerRosterEntryV0Alpha1>,
) -> Result<CanonicalSignerRosterV0Alpha1, CheckpointErrorV0Alpha1>;

pub fn prepare_checkpoint_successor_v0alpha1(
    prior: &TrustedCheckpointAnchorV0Alpha1,
    observed_manifest: &CanonicalManifestV0Alpha1,
    signer_roster: &CanonicalSignerRosterV0Alpha1,
    signer_device_id: &[u8; 16],
) -> Result<CheckpointSigningRequestV0Alpha1, CheckpointErrorV0Alpha1>;

pub fn attach_device_signature_v0alpha1(
    request: CheckpointSigningRequestV0Alpha1,
    signature: [u8; 64],
    signer_roster: &CanonicalSignerRosterV0Alpha1,
) -> Result<SignedCheckpointV0Alpha1, CheckpointErrorV0Alpha1>;

pub fn verify_checkpoint_successor_v0alpha1(
    prior: &TrustedCheckpointAnchorV0Alpha1,
    candidate: &[u8],
    observed_manifest: &CanonicalManifestV0Alpha1,
    signer_roster: &CanonicalSignerRosterV0Alpha1,
) -> Result<CheckpointVerificationOutcomeV0Alpha1, CheckpointErrorV0Alpha1>;
```

product private signing key type은 이 crate에 두지 않는다. signer는
`CheckpointSigningRequestV0Alpha1::signing_message()`의 exact bytes를 플랫폼
보호 키에 전달하고 64-byte signature만 반환한다. 테스트 전용 deterministic
in-memory key는 `#[cfg(test)]` 또는 fixture crate에만 존재해야 한다.

`ManifestEntryV0Alpha1`과 `SignerRosterEntryV0Alpha1`의 raw fixture constructor는
첫 구현에서 crate-private/test-only다. 후속 integration은 인증된 storage/event
projection에서만 production entry를 만들어야 하며 caller가 임의 authoritative
blob identity를 current state로 승격하게 해서는 안 된다.

## 10. Trust bootstrap 제한

이번 API에는 genesis checkpoint를 만드는 함수, 서버가 준 첫 checkpoint를
신뢰하는 함수, 임의 hash를 `TrustedCheckpointAnchorV0Alpha1`로 바꾸는 함수가 없다.

합성 테스트는 private `synthetic_trusted_anchor_fixture_v0alpha1`만 사용한다.
production bootstrap은 다음 중 하나를 먼저 별도 ADR로 승인해야 한다.

- 이미 신뢰된 기기와의 명시적 pairing
- 검증된 복구 transition과 이전 epoch 소유 증명
- 기기 보호 저장소에 있던 기존 anchor
- 별도 승인된 independent witness proof

checkpoint와 anchor를 같은 공격자 제어 DB에 함께 저장하는 것만으로는 rollback
보호가 되지 않는다. `load bytes -> TrustedCheckpointAnchor` 같은 편의 API는
금지한다. 영속 anchor의 저장 위치·rollback 저항성은 후속 플랫폼 ADR의 책임이다.

## 11. 오류 taxonomy와 판정 순서

```rust
pub enum CheckpointErrorCodeV0Alpha1 {
    UnsupportedVersion,
    UnsupportedSuite,
    MalformedEncoding,
    NonCanonicalEncoding,
    LimitsExceeded,
    InvalidManifestInput,
    InvalidRosterInput,
    CandidateRejected,
    InvariantViolation,
}

// Crate-private and test-only diagnostics. These values never cross a WASM,
// UI, network, analytics or product logging boundary.
enum CheckpointDiagnosticCodeV0Alpha1 {
    DuplicateRecord,
    DuplicateDevice,
    DuplicatePublicKey,
    InvalidRoleBits,
    WrongVault,
    ParentMismatch,
    CheckpointSequenceMismatch,
    DeviceSequenceMismatch,
    CounterExhausted,
    EpochTransitionUnsupported,
    RosterTransitionUnsupported,
    RosterCommitmentMismatch,
    RosterCountMismatch,
    ManifestCommitmentMismatch,
    ManifestCountMismatch,
    UntrustedSigner,
    InvalidSignature,
    InvariantViolation,
}
```

manifest/roster builder는 caller가 제공한 합성 로컬 입력의 형식 오류를 각각
`InvalidManifestInput`과 `InvalidRosterInput`으로 정규화한다. 내부 test는 위의
crate-private diagnostic으로 정확한 거부 지점을 검증할 수 있지만, production
getter나 `Debug`가 diagnostic을 노출해서는 안 된다.

successor 검증의 내부 판정 순서는 다음과 같이 고정한다.

1. outer/body 길이와 allocation 상한
2. 구조, version/suite/kind, strict canonical encoding
3. candidate hash와 exact already-trusted 여부 계산
4. 제공 roster bytes의 commitment/count 검증과 prior roster의 signer public key 선택
5. exact already-trusted이면 observed manifest commitment/count도 prior와 대조한 뒤
   일치할 때만 `AlreadyTrusted` 반환
6. successor이면 선택한 roster key로 Ed25519 signature 검증
7. vault, previous hash, global sequence, same epoch와 same roster 판정
8. per-device sequence 및 anchor map 불변조건 판정
9. observed manifest commitment/count 판정
10. prior map 전체를 보존하고 signer 값 하나만 갱신한 새 anchor 구성

canonical parse/limit을 통과한 뒤의 signature, vault, parent, sequence, epoch, roster,
signer와 manifest 관련 candidate 실패는 public API에서 모두 `CandidateRejected`로
정규화한다. 반면 이미 신뢰된 anchor 자체의 map 불변조건 위반은 외부 candidate가
만든 거부 사유로 가장하지 않고 public `InvariantViolation`으로 중단한다. path,
device/record ID, public key, signature,
checkpoint bytes, manifest bytes, ciphertext 또는 fixture contents를 `Debug`, log,
panic, analytics와 error message에 넣지 않는다. WASM/UI/network에는 오직 이 public
code만 전달하며, 상세 diagnostic과 분기별 message를 노출하지 않는다. 이 정규화는
오류 내용 oracle을 줄이는 계약이지 전체 timing side-channel 방어를 보장하지 않는다.

## 12. Dependency approval gate

**다음 gate가 모두 별도로 승인되기 전에는 이 명세의 Rust code, Cargo manifest,
lockfile 또는 fixture를 구현·변경하지 않는다.**

1. Ed25519 구현 crate의 exact version, default feature 사용 여부와 feature allowlist
2. crate 출처, license, 유지보수 상태, 알려진 advisory와 transitive dependency
3. strict verification semantics와 malformed/non-canonical public key·signature 처리
4. RNG가 필요한 signing path와 verification-only path의 분리
5. RFC 8032 공식 vector와 별도 독립 구현이 생성한 이 명세의 canonical
   checkpoint/signature vector 검토
6. BLAKE3 derive-key context, canonical CBOR와 Ed25519 signing message를 두 구현이
   byte-for-byte 동일하게 재현했다는 증거
7. 새 direct dependency와 `Cargo.lock` diff에 대한 사용자 승인
8. 플랫폼 hardware signer가 exact Ed25519 message를 지원하지 않을 때 software
   key로 조용히 fallback하거나 이를 high-assurance device라고 부르지 않는 정책

Ed25519를 직접 구현하지 않는다. 현재 workspace에 signature 구현이 없다는 이유로
임시 MAC, password-derived signing key, wrapping key 재사용 또는 자체 암호 코드를
추가하지 않는다. gate가 실패하면 구현을 멈추고 suite/플랫폼 ADR을 다시 검토한다.

## 13. Test matrix

모든 fixture는 명백한 합성 값만 사용한다.

### 13.1 독립 vector와 canonical encoding

- exact manifest, roster, checkpoint body, signing message, signature,
  signed-envelope와 checkpoint hash vector
- 공식 Ed25519 vector와 독립 구현 생성 vector의 byte-for-byte 일치
- integer/length non-minimal encoding, indefinite array, tag/map/text/null/float,
  trailing bytes와 field 재정렬 거부
- unknown version/suite/kind fail-closed
- encode→decode→re-encode exact equality

### 13.2 Manifest와 omission

- 같은 entry 집합을 모든 대표 입력 순서로 넣어 같은 canonical bytes/hash 생성
- unsorted wire, duplicate record와 5,001번째 entry 거부
- 각 index를 하나씩 제거하면 `ManifestCommitmentMismatch` 또는 count mismatch
- 같은 record/revision ID에서 authoritative blob 한 byte 변경 시 mismatch
- `Current ↔ Tombstone` 변경 시 mismatch
- 빈 manifest, 1개, 5,000개와 encoded-byte 경계 검사
- 0-byte와 65,537-byte head blob은 거부하고 1-byte와 65,536-byte는 처리

### 13.3 Roster와 signer

- device order와 무관한 canonical roster 생성
- duplicate device ID, duplicate public key, unknown role bit, empty roster와 65번째
  device 거부
- roster에 없는 signer, `recovery_authenticator`만 있는 signer, 다른 public key와
  invalid signature 거부
- wrapping-key bytes를 signing public key로 바꿔 끼우는 fixture 거부

### 13.4 Successor, replay와 fork

- exact parent, `sequence + 1`, same epoch/roster, per-device `sequence + 1` 수락
- anchor map이 roster의 모든 `sync_client`와 정확히 같은 key set을 가지며 미사용
  signer는 `0`으로 시작하는지 검사
- A→B→A 교대 서명에서 prior map의 A/B 값을 모두 보존하고 현재 signer 값 하나만
  증가시키며, B 이후 A의 재사용 sequence와 map key 삭제·추가·감소를 거부
- previous hash, vault commitment, global/device sequence의 각 1-byte mutation 거부
- 낮은 sequence, 건너뛴 sequence와 counter overflow 거부
- exact same checkpoint와 일치하는 observed manifest/roster retry만 `AlreadyTrusted`이며
  anchor를 두 번 전진시키지 않음
- exact same checkpoint라도 observed manifest의 entry 누락·변경 또는 roster
  commitment/count 불일치가 있으면 `AlreadyTrusted`나 성공을 반환하지 않음
- 같은 parent의 A를 수락한 뒤 sibling B는 parent/sequence mismatch로 거부
- 서로 격리된 두 prior anchor가 A와 B를 각각 수락할 수 있다는 한계를 별도
  negative-oracle test 문서에 유지
- epoch 증가·감소와 roster 변경은 유효 signature라도 unsupported transition

### 13.5 Mutation, bounds와 API traits

- checkpoint body의 모든 field class를 한 번씩 바꾸는 mutation matrix
- signature와 signed envelope 모든 byte 위치의 대표 mutation rejection
- random bytes가 panic 없이 bounded stable error로 끝나는 property test
- oversized length가 payload allocation 전에 거부되는 allocation observer test
- `TrustedCheckpointAnchorV0Alpha1` raw constructor와 deserialize compile-fail
- production crate에 private signing key·seed·signing RNG API가 없다는 source/trait test
- error/log/panic에 fixture ID, public key, signature, manifest 또는 ciphertext가 없음
- canonical parse/limit 이후의 잘못된 signature, vault, parent, sequence, epoch, roster,
  signer와 manifest가 외부에서는 모두 같은 `CandidateRejected` code로 보임

테스트 통과는 현재 선택한 구현의 regression 증거다. 독립 암호 검토, 실제 기기
보호, storage freshness 또는 실제 Secret 출시 승인이 아니다.

## 14. 명시적으로 보장하지 않는 것

이 단위가 완료되어도 다음은 보장하지 않는다.

- DB, checkpoint와 prior anchor를 함께 과거 상태로 복원하는 공격 탐지
- signer가 처음부터 불완전한 manifest를 받아 서명한 경우의 omission 탐지
- 저장소가 signer와 verifier 양쪽에 같은 불완전 manifest를 제공한 경우의 omission
  탐지; 후속 prior-manifest 또는 authenticated transition/delta proof가 필요함
- 모든 기기를 잃은 신규 복구 클라이언트의 targeted rollback 탐지
- 서로 격리된 기기에 다른 유효 fork를 보여 주는 server equivocation 탐지
- compromised signer, unlocked malware 또는 루팅 기기 방어
- revoked device 차단, roster 변경, recovery와 key-epoch transition
- revision 작성자, parent DAG와 전체 append-only event history 증명
- 제품 tombstone 생성, deletion conflict와 GC 안전성
- SQLite/IndexedDB crash·power-loss 내구성 또는 server CAS 원자성
- OS/hardware monotonic anchor, Android hardware-backed key·biometric·attestation
- checkpoint body와 full manifest의 제품용 암호화·metadata 은닉
- independent witness 가용성·정직성
- 독립 암호 설계·구현 검토 또는 실제 Secret 안전성

따라서 허용되는 완료 표현은 다음뿐이다.

> 합성 데이터에서, 이미 신뢰된 prior anchor와 고정 signer roster에 상대적인
> canonical signed checkpoint successor 검증 primitive를 만들었다.

`rollback 방어 완료`, `누락을 항상 탐지`, `복구 구현 완료`, `실제 Secret 사용
가능`이라고 표현해서는 안 된다. **`REAL_SECRET_GATE=CLOSED`**를 유지한다.

## 15. 구현 시작 조건과 종료 조건

구현 시작 조건은 12절 dependency approval gate의 전 항목 승인이다. 그 전에는
이 문서 외 code, dependency, lockfile 또는 vector fixture를 변경하지 않는다.

승인 후 첫 구현의 종료 조건은 다음과 같다.

- 이 문서의 exact bytes·bounds·error/API 계약을 구현
- 13절 test matrix 통과
- 새 dependency/lockfile과 security-sensitive diff 독립 재검토
- storage/server/platform integration이 없음을 diff로 확인
- verification 문서에 합성 전용·상대적 anchor 보장과 비보장 항목 기록
- `REAL_SECRET_GATE=CLOSED` 유지

이번 명세 자체는 구현 승인이 아니며, dependency 추가·설치·다운로드·commit·push를
승인하지 않는다.
