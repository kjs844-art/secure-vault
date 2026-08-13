# ADR 0002: v0alpha1 합성 암호 스위트 경계

- 상태: Experimental — 실제 Secret 저장 금지
- 결정일: 2026-08-14
- 적용 범위: 합성 데이터 전용 로컬 암호 코어 및 호환성 테스트

## 맥락

Secure Vault의 공유 암호 코어를 구현하기 전에 wire 형식, 알고리즘 후보, 메모리 정리 규칙과 비프로덕션 경계를 하나의 변경 불가능한 실험 계약으로 고정해야 한다. 이 ADR은 실제 비밀번호, API 키, Secret 또는 사용자 데이터를 처리하도록 승인하지 않는다.

## 결정

### 프로토콜 식별자

| 항목 | 값 |
| --- | --- |
| wire version | `0` |
| suite ID | `0xA101` (`41217`) |
| password-envelope object kind | `1` |
| record-envelope object kind | `2` |

직렬화는 `contracts/v0alpha1/envelope.cddl`의 고정 길이 배열을 결정적 CBOR로 인코딩한다. 전체 encoded envelope는 65,536 bytes를 넘을 수 없다.

### 키 파생과 무작위 값

- password KEK 후보는 Argon2id v1.3으로 파생한다.
- 고정 후보 프로필은 memory 65,536 KiB, time cost 3, lanes 4, output 32 bytes와 암호학적으로 안전한 16-byte random salt다.
- Vault Root Key와 각 Item DEK는 서로 독립적인 암호학적 난수 32 bytes다.
- vault commitment는 root key에서 파생하지 않고 독립적으로 생성하는 random public 32-byte 값이다.
- salt, root key, item DEK, commitment와 모든 nonce 생성 실패는 작업 실패로 처리하며 재사용하거나 결정적 fallback을 사용하지 않는다.

### 인증 암호화

- root key wrapping, item DEK wrapping과 encrypted body에는 XChaCha20-Poly1305를 사용한다.
- 각 암호화 연산은 새 random 24-byte nonce를 사용하며 authentication tag는 16 bytes다.
- AAD는 `contracts/v0alpha1/domain-separation.md`에 고정된 서로 다른 domain과 envelope context로 결정적으로 인코딩한다.
- application code는 high-level XChaCha20-Poly1305 AEAD API만 사용한다. direct `poly1305` dependency는 Cargo feature unification을 통해 `poly1305/zeroize`를 활성화하기 위해서만 존재한다.

### 메모리 정리 요구사항

- `argon2/zeroize`, `chacha20poly1305/zeroize`, `poly1305/zeroize` 기능을 반드시 활성화한다.
- Argon2 작업 메모리는 호출자가 명시적으로 할당하고 소유하며, 성공·오류·조기 반환을 포함한 모든 반환 경로에서 zeroize한다.
- plaintext, master password, password KEK, Vault Root Key, Item DEK와 복호화 임시 버퍼를 포함한 모든 plaintext/key buffer는 모든 반환 경로에서 zeroize한다.
- 실제 구현은 소유 버퍼에 `Zeroizing` 또는 동등한 drop guard를 사용하고, key/plaintext를 `Debug`, `Display`, 직렬화 또는 복사 가능한 값으로 노출하지 않는다.

### Password envelope

Password envelope kind `1`은 CDDL에 정의된 다음 필드를 이 순서대로 가진다.

1. wire version
2. suite ID
3. object kind
4. 16-byte salt
5. memory KiB
6. time cost
7. lanes
8. 32-byte vault commitment
9. 24-byte root nonce
10. 48-byte wrapped root key (`32-byte ciphertext || 16-byte tag`)

### Record envelope

Record envelope kind `2`는 CDDL에 정의된 다음 필드를 이 순서대로 가진다.

1. wire version
2. suite ID
3. object kind
4. 32-byte vault commitment
5. 16-byte opaque record ID
6. 32-byte revision ID
7. `1..=4,294,967,295` 범위의 key epoch
8. encrypted-body padding bucket
9. 24-byte item-key nonce
10. 48-byte wrapped item key (`32-byte ciphertext || 16-byte tag`)
11. 24-byte body nonce
12. encrypted body

인증 전 body의 고정 형식은 `uint32_be(plaintext_length) || plaintext || zero_padding`이다. encrypted body 크기는 선택한 padding bucket에 16-byte tag를 더한 값이어야 한다. 허용 bucket은 1/4/16/60 KiB이며, 60 KiB 상한은 CBOR header와 나머지 envelope field를 포함한 전체 64 KiB 제한을 지키기 위한 값이다.

## 보안 및 출시 경계

- 이 스위트는 합성 데이터로 인코딩·디코딩·호환성 테스트를 수행할 수 있지만 실제 Secret 저장에는 승인되지 않았다.
- 여기서 생성하는 protocol vector는 독립 구현으로 재현되기 전까지 correctness 증명이 아니라 regression vector다.
- `tests/fixtures/synthetic/v0alpha1-vectors.json`의 바이트는 crate-private 결정적 test entropy로
  생성하고 공개 API로 다시 읽는 호환성 회귀 자료다. 이 fixture는 독립 구현으로 검증되지
  않았으며 primitive 또는 application crypto의 정확성을 독립적으로 증명하지 않는다.
- root-key rotation, device revocation rotation, recovery wrapping과 복구 후 epoch 전환 의미가 아직 해결되지 않았다.
- 위 rotation/recovery 의미가 설계되고 독립 보안 검토를 통과하기 전에는 실제 Secret beta를 시작할 수 없다.

## 결과

후속 구현은 이 경계 안에서만 합성 round trip, 실패 경로, canonical encoding과 메모리 정리 동작을 검증한다. Web, Android, 서버 동기화, 계정, 결제 및 실제 사용자 입력은 별도 승인과 별도 계획 없이는 이 ADR의 범위가 아니다.
