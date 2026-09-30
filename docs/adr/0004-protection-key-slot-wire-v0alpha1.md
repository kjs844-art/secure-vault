# ADR 0004: Protection Key Slot wire v0alpha1 제안

- 상태: Proposed — synthetic-only; 구현 승인 전
- 기준일: 2026-09-19
- 적용 범위: 마스터 비밀번호, 오프라인 복구 키, Android 기기 보호 수단이 같은 세대의 Vault Root Key를 여는 합성 Key Slot wire
- 출시 경계: **`REAL_SECRET_GATE=CLOSED`**

## 1. 결정 상태와 금지선

이 문서는 ADR 0003의 제품 정책을 실제 구현 전에 검토 가능한 wire 제안으로 좁힌다. 아직 Accepted 상태가 아니며, 알고리즘·식별자·의존성·테스트 벡터의 승인을 뜻하지 않는다.

다음은 이 제안의 승인 여부와 관계없이 현재 지켜야 하는 금지선이다.

- 실제 비밀번호, API 키, Secret, 복구 키 또는 개인 금고 데이터를 입력·가져오기·저장하지 않는다.
- 기존 `password-envelope-v0alpha1`의 object kind `1`을 Key Slot로 재해석하거나 선택 필드를 덧붙이지 않는다.
- 기존 `contracts/storage-v1` schema를 수정해 다중 Slot 저장소처럼 사용하지 않는다.
- 이 ADR이 Accepted 되고, 독립 암호 설계 검토와 별도 구현 계획이 승인되기 전에는 wire·KDF·복구 UI를 구현하지 않는다.
- 합성 구현이 통과해도 실제 Secret gate를 열지 않는다. recovery transition, rollback·누락 anchor, Android, 동기화와 복구 훈련은 별도 출시 차단 조건이다.

## 2. 맥락

ADR 0003은 보호 수단마다 현재 `Vault Root Key`를 여는 독립된 버전형 AEAD Key Slot을 두고, Slot의 AAD에 vault commitment, Slot ID, 수단 종류, protocol·suite version과 `key_epoch`를 결합하도록 결정했다.

현재 합성 `password-envelope-v0alpha1`에는 Slot ID, 수단 종류와 `key_epoch`가 없다. 현재 unlock 함수는 인증된 envelope에서 epoch를 복원하지 않고 `KeyEpoch::initial()`을 사용한다. 이 형식은 합성 초기 금고의 password wrap 회귀용이며 복구·회전 wire가 아니다.

현재 `storage-v1`의 `vault_state`도 password envelope 하나만 저장한다. 다중 Slot, 폐기 상태, Slot roster 또는 epoch transition을 표현하지 않으며 계약 문서가 recovery를 명시적으로 범위 밖으로 둔다.

따라서 Recovery Key Slot은 새 wire와 새 저장 계약을 요구한다. 기존 형식을 조용히 확장하면 과거 Slot의 재사용, 수단 종류 바꿔치기, 다른 epoch에 대한 Root Key 개방과 downgrade를 정확하게 거부할 수 없다.

## 3. 목표와 비목표

### 목표

- 하나의 보호 수단과 하나의 vault·Slot·epoch에 정확히 결합된 Root Key ciphertext를 만든다.
- 비밀번호, 고엔트로피 오프라인 복구 비밀, Android device-slot secret의 서로 다른 KDF 정책을 wire에서 구분한다.
- current wire는 엄격하게 검증하고, future wire는 실행하지 않은 채 exact bytes로 보존할 수 있게 한다.
- wrong secret와 정상 형태 ciphertext 변조를 민감한 세부 정보 없이 실패-폐쇄한다.
- Root Key, KEK와 복구 비밀이 public getter, formatting, cloning 또는 serialization 경계로 노출되지 않게 한다.
- 독립 구현이 같은 canonical bytes와 테스트 벡터를 만들 수 있는 계약을 제공한다.

### 비목표

- 실제 Secret 지원 또는 운영 배포
- recovery transition, 전체 item re-encryption, checkpoint CAS와 서버 동기화 구현
- Android Keystore·BiometricPrompt 구현
- 물리 보안키 PRF와 guardian quorum 암호 구성
- 운영자 escrow 또는 모든 복구 경로를 잃은 사용자의 우회 복구
- 기존 `storage-v1`의 in-place migration

## 4. 위협모델

공격자는 Slot envelope, 로컬 DB, 백업 또는 서버 저장본을 읽고 바꾸며, 다음을 시도할 수 있다.

- 다른 vault의 Slot 또는 Root Key ciphertext로 교체
- password, offline recovery, Android device 수단 종류를 바꿔치기
- 과거 epoch의 정상 Slot 또는 폐기된 Slot을 replay
- Slot ID, KDF profile, salt, nonce 또는 wrapped Root Key 변조
- 비정상·비정규 CBOR, oversized input, future version과 unknown suite 주입
- 같은 Slot ID 중복, 서로 다른 epoch의 Slot 혼합과 roster 일부 누락
- 잘못된 비밀번호·복구 키에 대한 오류·시간 차이 수집
- 로그, crash report, fixture, `Debug` 또는 serialization을 통한 비밀 유출

이 wire 하나는 다음 공격을 해결하지 못한다.

- 잠금 해제된 클라이언트의 악성코드
- 독립 anchor가 없는 완전 신규 복구 클라이언트에 대한 targeted rollback
- 인증된 Slot roster·checkpoint 전체의 누락 또는 fork
- 분실 기기가 과거에 이미 본 평문 회수

## 5. 필수 보안 불변조건

Accepted wire는 다음을 모두 만족해야 한다.

1. Root Key ciphertext는 protocol version, suite, object kind, vault commitment, Slot ID, protector kind, `key_epoch`와 KDF profile 전체에 인증 결합된다.
2. Slot ID는 vault 안에서 유일한 CSPRNG opaque identifier이며 사용자 정보나 순번을 인코딩하지 않는다.
3. password, offline recovery와 Android device protector kind는 허용된 KDF profile과 정확히 1:1로 매핑된다. 불일치 조합은 복호화 전에 거부한다.
4. 인증된 Slot의 `key_epoch`만 새 `VaultSession`에 전달한다. 초기 epoch를 암묵적으로 대입하지 않는다.
5. 한 활성 roster의 Slot은 동일한 vault commitment와 `key_epoch`를 가져야 한다.
6. Slot bytes 또는 commitment는 인증된 checkpoint·transition manifest에 포함되어야 한다. 서버가 제공한 Slot 목록만으로 최신성·완전성을 주장하지 않는다.
7. future wire와 unknown suite는 사용할 수 없지만 exact bytes를 보존한다. 손상된 current wire는 자동 repair·delete·overwrite하지 않는다.
8. wrong secret와 인증 태그 실패는 외부에 동일한 비민감 오류 분류를 제공한다.
9. Root Key, KEK, offline recovery secret와 device-slot secret은 zeroizing owner 안에서만 소유하며 공개 raw-key getter를 만들지 않는다.
10. 동일 키 아래 nonce 재사용을 허용하지 않으며 CSPRNG 실패는 전체 작업 실패다.

## 6. wire 골격 요구사항

최종 CDDL은 고정 길이 canonical CBOR array를 사용하고 최소한 다음 논리 필드를 가져야 한다. 순서, 정확한 정수 식별자와 byte 길이는 이 ADR의 Accepted 전환 때 별도 검토로 고정한다.

```text
[
  wire_version,
  suite_id,
  object_kind,
  vault_commitment,
  slot_id,
  protector_kind,
  key_epoch,
  kdf_profile,
  root_nonce,
  wrapped_root_key
]
```

필드 의미는 다음과 같다.

| 필드 | 요구사항 |
| --- | --- |
| `wire_version` | unsigned, canonical, supported version과 정확히 일치 |
| `suite_id` | 기존 `0xA101` password envelope와 구별되는 별도 suite |
| `object_kind` | 기존 object kind `1`과 구별되는 별도 kind |
| `vault_commitment` | 정확히 한 vault에 결합하는 public 32-byte commitment |
| `slot_id` | CSPRNG로 생성한 opaque fixed-length ID |
| `protector_kind` | password, offline recovery, Android device 중 하나; unknown 값 fail-closed |
| `key_epoch` | `1..=4,294,967,295`; 0과 overflow 거부 |
| `kdf_profile` | kind별 고정 tag·salt·parameter array; 자유로운 attacker-selected 비용 금지 |
| `root_nonce` | suite가 정한 fixed-length random nonce |
| `wrapped_root_key` | 정확히 32-byte Root Key와 AEAD tag의 fixed-length 결과 |

decoder는 전체 envelope 상한을 먼저 검사하고, 고정 배열 길이·canonical encoding·header·모든 fixed length·kind/KDF 조합을 검증한 뒤에만 KDF 또는 Keystore 경계로 진행한다.

## 7. 검토 후보 — 아직 결정이 아님

이 절의 값은 상호운용성·의존성·독립 암호 검토를 위한 출발점일 뿐이다. **아래 후보를 코드, fixture, schema 또는 UI에 사용해서는 안 된다.** Accepted 전환 시 유지·변경·폐기 여부와 근거를 기록한다.

### 식별자 후보

- `wire_version = 0`
- `suite_id = 0xA102` (`41218`)
- `object_kind = 6`
- protector kind: `password = 1`, `offline_recovery = 2`, `android_device = 3`

이 값은 저장소의 현재 사용 값과 충돌하지 않는지 재검사하고 중앙 식별자 registry를 만든 뒤에만 승인할 수 있다.

### 암호·KDF 후보

- Root Key wrap: 새 random 24-byte nonce를 사용하는 XChaCha20-Poly1305
- password KEK: 현재 합성 후보와 분리 검토한 Argon2id v1.3 고정 profile
- offline recovery/device-slot secret KEK: 32-byte 고엔트로피 입력에 HKDF-SHA-256과 kind별 domain-separated info 사용
- KDF salt: password는 16 random bytes, 고엔트로피 protector는 32 random bytes
- wrapped Root Key: 32-byte ciphertext와 16-byte authentication tag

HKDF와 SHA-256은 현재 `vault-crypto` 의존성에 없다. 승인 전에는 dependency나 `Cargo.lock`을 변경하지 않는다. 채택 시 정확한 crate/version/features, 공급망 검토, known-answer vector와 독립 구현 비교가 필요하다.

### 오프라인 복구 키 표시 후보

- CSPRNG 32-byte secret
- encoding version과 typo-detection checksum이 있는 lower-case Bech32m 계열 문자열
- 검토용 HRP 예시 `karec`
- QR은 같은 canonical 문자열만 표현하며 별도 비밀 형식을 만들지 않음

Bech32m도 현재 결정이 아니다. 채택 시 최대 길이, 대소문자·공백 정규화, Unicode 거부, QR·인쇄 왕복, 접근성, checksum 오류와 authentication 오류의 UI 구분을 고정해야 한다. checksum은 오타 감지일 뿐 entropy 또는 암호 인증으로 설명하지 않는다.

## 8. AAD와 domain separation 요구사항

최종 AAD는 별도 exact ASCII/UTF-8 domain byte string과 다음 context를 canonical CBOR로 인코딩해야 한다.

```text
[
  domain,
  wire_version,
  suite_id,
  object_kind,
  vault_commitment,
  slot_id,
  protector_kind,
  key_epoch,
  kdf_profile
]
```

필드를 생략·재정렬하거나 CBOR byte/text type을 바꾸면 안 된다. AAD 인코딩 변경은 새 suite 또는 wire version을 요구하며 기존 ID를 재사용하지 않는다.

고엔트로피 KDF 후보를 채택한다면 KDF info도 protector kind, vault commitment, Slot ID와 epoch에 domain-separated 결합해야 한다. AEAD AAD와 KDF info가 같은 목적이라고 가정하지 않고 각각 exact contract를 둔다.

## 9. Slot 수명 주기와 epoch 경계

- 새 Slot 추가는 최근 금고 잠금 해제와 강한 재인증을 요구한다.
- 새 Slot은 current Root Key, current vault commitment와 current epoch에 대해서만 생성한다.
- 생성한 Slot을 실제 roster에 추가하기 전에 새 Slot으로 Root Key를 다시 열고
  commitment·epoch뿐 아니라 **현재 Root Key와 동일한 키가 복원됐는지** 확인한다.
  vault commitment는 Root Key와 독립 난수이므로 commitment 일치만 key confirmation으로
  취급하지 않는다. 확인은 zeroizing secret owner 내부의 constant-time equality 또는 현재
  Root Key로만 열 수 있는 인증된 고정 확인 객체로 수행하고, raw key getter를 추가하지
  않으며 비교용 후보를 즉시 폐기한다.
- 침해 징후 없는 password Slot의 원자적 교체와 단순 Slot 추가만 같은 epoch를 유지할 수 있다.
- Root Key를 단독으로 열 수 있던 device/recovery Slot의 폐기, 복구 경로 사용 또는 password 침해 의심은 ADR 0003의 recovery transition과 새 epoch를 요구한다.
- 새 epoch의 전체 manifest·ciphertext·활성 Slot·checkpoint가 검증되기 전에 이전 epoch Slot을 삭제하지 않는다.
- Slot wire 구현은 recovery transition 구현이 아니다. signed-checkpoint v0alpha1의 same-roster successor 기능만으로 폐기를 완료했다고 주장하지 않는다.

## 10. 저장과 migration 경계

기존 `contracts/storage-v1/schema-v1.sql`은 변경하지 않는다. 후속 저장 설계는 별도 `storage-v2` 계약에서 최소한 다음을 다뤄야 한다.

- immutable 또는 versioned Slot rows
- current epoch와 active Slot roster commitment
- duplicate Slot ID와 mixed-epoch 차단
- future wire/suite exact-byte preservation
- current corruption의 store-wide read-only preservation
- Slot roster, transition manifest와 checkpoint의 원자적 commit
- crash 전·후 상태와 재시도 가능한 operation ID
- v1 합성 저장소의 보존형 migration 또는 명시적 unsupported 처리

실제 사용자 데이터가 없다는 이유로 v1 bytes를 새 wire로 묵시적으로 승격하지 않는다.

## 11. 오류·메모리·관측 정책

- 구조·version·suite·limit 오류는 안정적인 비민감 code만 반환한다.
- 구조가 정상인 wrong secret와 AEAD tag 실패는 `AuthenticationFailed`로 합친다.
- 오류에 복구 문자열, salt, nonce, ciphertext, commitment, Slot ID 전체 또는 KDF 입력을 넣지 않는다.
- secret owner는 `Clone`, `Copy`, `Debug`, `Display`, serialization과 raw getter를 구현하지 않는다.
- 복구 키 표시 화면에서는 analytics, session replay와 자동 crash attachment를 비활성화한다.
- Git fixture에는 공개된 합성 vector만 둘 수 있고 실제 복구 키·vault DB·backup은 금지한다.
- 서버가 관찰 가능한 protector kind·Slot count 같은 metadata는 보안·개인정보 문서에 정직하게 기록한다.

## 12. 거부한 대안

- 기존 password object kind `1`에 선택 필드 추가: 이전 parser·fixture와 의미가 충돌하고 epoch·kind 결합을 보장하지 못하므로 거부
- `storage-v1`의 password envelope column에 여러 Slot을 포장: schema 의미와 보존 계약을 깨므로 거부
- 모든 수단에 같은 password KDF 적용: 고엔트로피 protector와 저엔트로피 password의 위협·비용 모델이 다르므로 거부
- Slot ID·kind·epoch를 AAD에서 제외: 유효 ciphertext 바꿔치기를 허용하므로 거부
- 복구 키 원문 또는 검증 가능한 단순 hash를 서버에 저장: 서버 탈취 시 복구 비밀 노출·검증 oracle이 되므로 거부
- 서버 로그인 세션만으로 새 Slot 또는 epoch 승인: 계정 인증과 금고 복호화 경계를 깨므로 거부
- future/손상 Slot 자동 삭제·repair: 유일한 복구본을 파괴할 수 있으므로 거부
- 운영자 Root Key escrow: 제로지식 경계를 깨므로 거부

## 13. Accepted 전환 수용 기준

### 문서·독립 검토

- 숫자 식별자, CDDL, domain bytes, KDF, AEAD, nonce/salt 길이와 최대 envelope 크기 확정
- 각 의존성의 exact version/features와 공급망 검토
- 내부 작성자와 분리된 암호 설계 리뷰에서 Critical/Important 미해결 0개
- ADR 0003, Android ADR, checkpoint/transition 명세와 상충 없음 확인

### 합성 자동 테스트 계획

- password/offline-recovery/Android-device 합성 Slot round trip
- 별도 구현의 canonical golden vector와 exact-byte 일치
- wrong secret와 ciphertext·nonce·AAD tamper 거부
- commitment·epoch는 맞지만 다른 Root Key를 감싼 새 Slot의 등록 전 self-check 거부
- vault commitment, Slot ID, protector kind, epoch와 KDF profile 각각의 substitution 거부
- noncanonical CBOR, trailing bytes, wrong field count/type/length, oversized input 거부
- unknown current kind/suite 사용 거부와 future wire exact-byte 보존
- duplicate Slot ID, mixed commitment와 mixed epoch roster 거부
- revoked Slot·과거 checkpoint replay와 부분 roster 누락 거부
- RNG 실패와 nonce 재사용 방지 경계
- secret type의 `Clone`·`Copy`·formatting·serialization·raw getter compile-fail
- 성공·오류·panic 경계의 zeroization 검토
- 보호 수단 3/4/5개 합성 등록·잠금 해제·폐기·복구 시나리오
- storage-v2 crash 전후 원자성과 wrong-secret 무쓰기
- repository secret scanner에서 실제 Secret 0개

테스트 통과는 synthetic wire correctness의 일부 증거일 뿐 실제 복구 가능성, Android 하드웨어 보증 또는 공개 베타 승인이 아니다.

## 14. 후속 구현 대상 — 승인 전 수정 금지

Accepted 이후 별도 계획과 파일 소유권을 승인할 때만 다음 변경을 검토한다.

- `contracts/protection-slot-v0alpha1/`
- `crates/vault-crypto/src/protection_slot_v0alpha1/`
- `crates/vault-crypto/src/secret.rs`
- `crates/vault-crypto/src/lib.rs`
- `crates/vault-crypto/tests/`
- `tests/fixtures/synthetic/`
- 새 `contracts/storage-v2/`
- 승인된 새 dependency와 `Cargo.lock`

기존 `contracts/v0alpha1/envelope.cddl`, object kind `1`과 `contracts/storage-v1/schema-v1.sql`은 호환성 기준으로 보존한다.

## 15. 관련 문서

- [ADR 0002: v0alpha1 합성 암호 스위트 경계](0002-v0alpha1-crypto-suite.md)
- [ADR 0003: 보호 수단별 Key Slot과 복구 정책](0003-protection-key-slots-and-recovery-policy.md)
- [복구·보호 수단 설계](../superpowers/specs/2026-08-14-recovery-protection-design.md)
- [합성 Signed Checkpoint v0alpha1 명세](../superpowers/specs/2026-09-16-synthetic-signed-checkpoint-v0alpha1.md)
- [RFC 5869: HKDF](https://www.rfc-editor.org/rfc/rfc5869)
- [BIP 350: Bech32m](https://github.com/bitcoin/bips/blob/master/bip-0350.mediawiki)
