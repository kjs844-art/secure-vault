# ADR 0003: 보호 수단별 Key Slot과 복구 정책

- 상태: Accepted for design; implementation gated
- 기준일: 2026-08-14

## 배경

운영자가 금고 평문을 복구할 수 없는 구조에서는 사용자가 마스터 비밀번호와 모든 복구 경로를 잃으면 데이터도 잃는다. 단일 복구 키만 제공하면 분실 위험이 크다. 여러 완전한 복구 경로는 가용성을 높이지만 가장 약한 완전 경로가 전체 위험에 영향을 주므로 경로별 최소 보증 수준이 필요하다.

## 결정

클라이언트가 생성한 `Vault Root Key` 원문은 서버에 저장하지 않는다. Root Key는 `key_epoch`마다 새로 생성하는 세대 키이며, 각 보호 수단은 현재 Root Key를 여는 별도의 버전형 AEAD `Key Slot`을 가진다.

필수 보호 수단은 마스터 비밀번호와 오프라인 복구 키다. 사용자는 신뢰 기기, 물리 보안키, 복구 보호자 중 최소 한 가지를 추가하며 총 세 가지부터 다섯 가지 보호 수단을 구성할 수 있다.

- 비밀번호 Slot은 Argon2id 파생 KEK를 사용한다.
- 복구 키 Slot은 CSPRNG 고엔트로피 비밀에서 파생한 KEK를 사용한다.
- 신뢰 기기는 기기별 비반출 키와 별도 Slot을 사용한다. 실제 Secret 출시 조건에서는 hardware-backed로 검증된 기기에만 독립 Root Key Slot을 발급한다. software-backed 기기는 독립 Slot이나 단독 편의 잠금 해제를 제공하지 않고 마스터 비밀번호 또는 다른 고보증 경로를 매번 요구한다.
- 물리 보안키는 WebAuthn PRF 또는 CTAP2 `hmac-secret`처럼 복호화 KEK 생성에 실제 참여하는 기능이 검증된 경우만 복구 수단으로 인정한다.
- 복구 보호자는 세 명 중 두 명 정족수, 7일 대기, 전체 알림과 취소를 요구한다.

Slot의 추가 인증 데이터는 vault commitment, slot ID, 수단 종류, protocol·suite version과 key epoch를 묶는다. Root Key를 단독으로 열 수 있던 device·recovery Slot을 이유와 무관하게 폐기하거나 마스터 비밀번호 침해가 의심되면 새 무작위 Root Key로 key epoch를 증가시키고, 활성 보호 수단의 Slot을 모두 새로 만들며 현재 항목을 새 Item DEK로 재암호화한다. 새 Slot 추가와 침해 징후 없는 마스터 비밀번호 Slot의 검증된 원자적 교체만 현재 epoch를 유지한다. 전환은 이전 roster의 유효한 승인 또는 이전 Root Key 소유 증명, 인증된 전체 manifest, 모든 현재 ciphertext의 1:1 재암호화·업로드와 새 checkpoint 검증을 요구한다. 서버 인증 계층의 `account_recovery_generation`도 원자적으로 증가시키고 구세대 세션·roster·기기의 새 쓰기를 거부한다.

복구 수단은 요금제와 무관하게 등록·교체·폐기할 수 있다. 마지막 선택 수단의 긴급 폐기도 허용하지만 새 수단과 복구 연습이 준비될 때까지 신규 Secret 추가를 중단한다. 모든 경로를 잃은 경우 운영자 복구를 제공하지 않고 새 빈 금고만 생성할 수 있다.

이 ADR은 제품 정책이며 wire 프로토콜 승인이 아니다. AEAD suite, canonical encoding, KDF·nonce·salt·commitment와 버전 하향 거부는 후속 wire ADR과 상호운용 테스트 벡터로 고정한다. Android 신뢰 기기의 Keystore·사용자 인증·무효화 정책도 별도 ADR을 먼저 승인한다.

물리 보안키와 보호자 정족수의 구체 암호 구성은 각각 후속 ADR과 독립 검토 전에는 구현하거나 UI에 노출하지 않는다. 첫 단계는 사용자가 없는 합성 프로토콜 테스트이며, 그 다음 Android 한정 로컬 알파가 비밀번호, 복구 키와 Android 신뢰 기기를 지원한다. Android를 포함한 모든 알파는 외부 독립 검토 전까지 합성 데이터 전용이다.

## 결과

복구 가능성은 높아지지만 Key Slot, 폐기, epoch 회전과 알림 상태기계가 복잡해진다. 서버는 금고 평문을 보지 못하지만 등록 수단의 종류·수와 복구 요청 시각 같은 운영 메타데이터를 볼 수 있다. 보호자 두 명의 공모, 모든 경로 분실, 잠금 해제 기기의 악성코드와 과거에 이미 본 평문 회수는 해결하지 못한다.

## 거부한 대안

- 다섯 수단을 모두 요구하는 `5-of-5`: 한 수단 분실로 사용자를 잠그므로 거부
- 모든 수단을 같은 낮은 보증 수준으로 취급하는 단순 `1-of-5`: 경로별 고엔트로피 비밀·비반출 키·정족수와 추가 안전조건이 없으므로 거부
- 운영자 Root Key escrow: 운영자 단독 복호화를 가능하게 해 제품의 제로지식 경계를 깨므로 거부

## 상세 명세

- [복구·보호 수단 설계](../superpowers/specs/2026-08-14-recovery-protection-design.md)
- [보안 아키텍처](../SECURITY_ARCHITECTURE.md)
- [제안 ADR 0004: Protection Key Slot wire v0alpha1](0004-protection-key-slot-wire-v0alpha1.md)
- [제안 ADR 0005: Android 기기 키·생체 승인·무효화](0005-android-device-key-biometric-invalidation.md)
