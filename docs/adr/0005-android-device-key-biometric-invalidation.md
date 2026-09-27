# ADR 0005: Android 기기 키·생체 승인·무효화 정책 제안

- 상태: Proposed — synthetic-only; 구현 승인 전
- 기준일: 2026-09-19
- 적용 범위: Android hardware-backed device protector, BiometricPrompt 승인, 키 무효화와 기기 수명 주기
- 출시 경계: **`REAL_SECRET_GATE=CLOSED`**

## 1. 결정 상태와 금지선

이 문서는 ADR 0003의 Android 신뢰 기기 정책을 구현 전에 검토 가능한 플랫폼 정책으로 좁힌다. 실행 가능한 Android 앱, Keystore adapter, Rust binding 또는 실기기 검증은 아직 없다.

이 ADR이 Proposed인 동안 다음을 금지한다.

- 실제 비밀번호, API 키, Secret, 복구 키 또는 개인 금고 데이터 사용
- Android Keystore나 생체 인증이 구현·검증됐다고 UI·README·배포 문서에서 주장
- 생체 인증 성공 boolean만 받은 뒤 인증과 결합되지 않은 별도 복호화 실행
- software-backed key에 독립 Root Key Slot 또는 `recovery_authenticator` 역할 발급
- key invalidation, alias 부재 또는 앱 재설치 때 같은 device/Slot identity의 자동 재생성
- 기존 password object kind `1`이나 `storage-v1`을 Android Key Slot 저장소로 재사용
- 이 ADR의 승인, recovery Slot wire 승인과 독립 보안 검토 전 Keystore/Root Key 경계 구현

합성 Android 구현과 실기기 검사가 통과해도 전체 실제 Secret gate는 계속 닫혀 있다. recovery transition, rollback·누락 anchor, sync/checkpoint, backup/export 복구 훈련과 독립 암호·플랫폼 검토가 별도로 필요하다.

## 2. 맥락

ADR 0003은 신뢰 기기가 기기별 비반출 키와 폐기 가능한 별도 Key Slot을 사용하고, 실제 Secret 출시 조건에서는 hardware-backed로 검증된 기기에만 독립 Root Key Slot을 발급하도록 결정했다. 생체정보는 키 생성 재료가 아니라 키 사용 승인을 담당한다.

기존 복구 설계의 `비반출 개인키`, `OS PIN·생체` 표현은 플랫폼 세부 구현을
확정한 문구가 아니다. 이 ADR이 Accepted 되면 첫 Android device protector에 한해
그 표현을 **AES 대칭 wrapping key와 biometric-only auth-per-use 경로**로 구체화하며,
OS PIN은 같은 Keystore key의 fallback이 아니라 별도 마스터 비밀번호·복구 흐름으로
보낸다. Proposed 상태에서는 어느 쪽도 구현 승인으로 해석하지 않는다.

현재 `apps/android`에는 README만 있으며 Gradle project, manifest, Keystore code, BiometricPrompt flow, Rust binding과 instrumentation test가 없다. 현재 Rust `VaultSession`은 Root Key getter를 노출하지 않으며 이 경계를 유지해야 한다.

Android Keystore key material이 비반출이라고 해도 잠금 해제된 앱 프로세스, 악성 accessibility·overlay, 루팅 기기, 화면 캡처와 사용자가 복사한 평문까지 보호한다는 뜻은 아니다. hardware-backed 판정과 생체 승인은 전체 위협모델의 한 부분이다.

## 3. 목표와 비목표

### 목표

- hardware-backed 기기에서만 독립 Android device protector를 만들 수 있게 한다.
- 매번 강한 생체 인증과 정확히 한 번의 Keystore 암호 연산을 결합한다.
- 생체 등록 변경, 잠금화면 재설정, alias 삭제, 재설치와 backup restore를 명시적 상태 전이로 처리한다.
- 무효화된 기기가 같은 identity로 조용히 복구되거나 최신 epoch 쓰기 권한을 되찾지 못하게 한다.
- Android platform crypto와 공유 Rust protection-slot core의 책임 경계를 고정한다.
- prompt 취소, background, process death와 동시 요청에서 평문·세션이 남지 않게 한다.

### 비목표

- 실행 가능한 Android 앱 또는 실제 Secret 지원
- 생체 template 저장·전송·직접 처리
- 루팅 탐지를 완전한 보안 보장으로 사용
- Play Integrity 또는 Android key attestation을 곧바로 서버 신뢰 증명으로 채택
- device roster, checkpoint, recovery transition과 서버 API 구현
- 물리 보안키, guardian quorum 또는 iOS Secure Enclave 정책
- 모든 Android 기기와 OEM에서 동일한 hardware 보증 주장

## 4. 위협모델

공격자는 다음 능력 중 하나 이상을 가질 수 있다.

- 분실·도난 기기와 암호화된 앱 저장소 사본 보유
- 앱 파일, backup, device-to-device transfer 또는 오래된 app-data snapshot 복원
- Keystore alias와 로컬 Slot metadata의 삭제·교체·불일치 유발
- biometric prompt와 실제 키 사용 사이의 TOCTOU 또는 재진입 시도
- 앱 background 전환, Activity 재생성, process death와 동시 prompt 유발
- software-backed key를 hardware-backed로 가장하는 변조 클라이언트
- 과거 device roster·Slot·checkpoint replay
- 로그·crash report·screenshot·clipboard를 통한 평문·metadata 수집
- 루팅 또는 악성 앱으로 잠금 해제된 프로세스 메모리·UI 접근

이 정책은 Keystore key의 비반출과 OS 사용자 인증 강제를 활용하지만, 감염·루팅된 기기에서 사용 순간의 평문 안전이나 과거에 이미 본 Secret 회수를 보장하지 않는다.

## 5. 역할과 키 분리

하나의 Android 기기는 최소한 다음 역할을 구분한다.

| 역할 | 키·비밀 | 용도 |
| --- | --- | --- |
| device wrapping | Android Keystore의 비반출 대칭 키 | 32-byte device-slot secret의 local hardware wrap |
| protection Slot | device-slot secret에서 파생한 KEK | 제안된 공통 protection-slot wire의 Root Key wrap/open |
| device signing | 별도 비반출 signing key | revision/checkpoint 또는 roster 승인 서명 |
| unlocked session | zeroizing Rust owner의 Root Key | 잠금 해제 중 item crypto |

wrapping key와 signing key는 alias, 알고리즘, key purpose와 폐기 수명을 공유하지 않는다. 한 키를 두 역할에 재사용하지 않는다.

Android Keystore는 Root Key 자체를 장기 저장하지 않는다. 제안 경계는 Keystore key가 random device-slot secret을 hardware-wrap하고, 공유 Rust core가 그 secret을 protection Slot의 KEK 입력으로 사용하는 두 계층이다. 이 경계는 ADR 0004의 wire와 함께 검토되어야 하며, 승인 전 구현하지 않는다.

Root Key와 device-slot secret을 Kotlin public API가 반환하지 않는다. 플랫폼 adapter는 secret을 필요한 연산 동안만 callback/opaque handle 경계에 제공하고, Rust와 Kotlin/JNI의 모든 명시적 임시 배열을 `finally` 또는 동등한 guard로 덮어쓴다. JVM·JNI가 만든 모든 내부 복사본의 완전한 zeroization을 보장한다고 과장하지 않는다.

## 6. 지원 수준과 hardware-backed 판정 제안

독립 device Slot의 첫 후보 지원선은 Android 12, API 31 이상이다. 합성 UI가 더 낮은 API에서 실행되는 것과 고보증 device Slot 지원을 구분한다.

키 생성 뒤 `KeyInfo.getSecurityLevel()`을 확인한다.

- `SECURITY_LEVEL_STRONGBOX`: hardware-backed 허용 후보
- `SECURITY_LEVEL_TRUSTED_ENVIRONMENT`: hardware-backed 허용 후보
- `SECURITY_LEVEL_SOFTWARE`: 독립 Slot 금지
- `SECURITY_LEVEL_UNKNOWN`: 독립 Slot 금지
- `SECURITY_LEVEL_UNKNOWN_SECURE`: 실제 기기·target SDK 호환성과 보증 의미를 별도 검토하기 전 금지

보안영역에 key material이 있다는 사실만으로 사용자 인증 정책도 그 하드웨어에서
강제된다고 가정하지 않는다. `KeyInfo.isUserAuthenticationRequirementEnforcedBySecureHardware()`
또는 Accepted 시점의 공식 동등 API를 별도로 확인하고, 거짓·미지원·불명확 결과에는
독립 Root Key Slot을 발급하지 않는다. 이 검사는 로컬 판정이며 원격 attestation을
대체하지 않는다.

StrongBox를 우선 요청할 수 있지만 unavailable 또는 unsupported algorithm이면 명시적으로 TEE 후보로 재시도할 수 있다. software-backed로 조용히 낮추지 않는다. 최종 UI는 `StrongBox`, `TEE`, `software-only`를 같은 표현으로 표시하지 않는다.

로컬 `KeyInfo` 판정은 정상 앱 인스턴스가 자기 기기에서 확인한 결과다. 변조 클라이언트가 서버에 보내는 문자열만으로 서버가 hardware-backed 상태를 신뢰해서는 안 된다. 동기화 제품에서 서버 검증이 필요하다면 별도 attestation ADR과 개인정보·가용성 검토 전에는 원격 `recovery_authenticator` 승격을 허용하지 않는다.

## 7. Keystore key 생성 정책 제안

Accepted 전환 시 정확한 Android API·provider·algorithm compatibility matrix를 고정한다. 첫 검토 후보는 다음과 같다.

- algorithm: AES-256
- block mode: GCM
- padding: NoPadding
- purpose: encrypt/decrypt device-slot secret
- randomized encryption required: true
- user authentication required: true
- `setUserAuthenticationParameters(0, AUTH_BIOMETRIC_STRONG)`
- `setInvalidatedByBiometricEnrollment(true)`
- StrongBox 요청 여부는 capability 검사 후 명시적 정책 적용
- alias는 CSPRNG opaque identifier이며 이메일, vault 이름, device 이름과 provider 정보를 포함하지 않음

timeout `0`은 auth-per-use를 뜻한다. 양수 유효기간을 사용하지 않는다. 첫 고보증 recovery authenticator에는 `AUTH_DEVICE_CREDENTIAL`을 같은 키에 함께 허용하지 않는다. Android 공식 문서상 device credential이 포함되면 biometric enrollment invalidation 의미가 달라지므로, PIN fallback은 마스터 비밀번호·오프라인 복구 키 같은 별도 고보증 경로로 보낸다.

AES-GCM, two-layer device-slot secret과 API 31 지원선도 Proposed 값이다. 실제 구현 전 OEM 호환성, Rust binding, 독립 플랫폼 검토와 실기기 proof에서 유지·수정·거부를 결정한다.

### Local hardware-wrapped blob 계약 요구사항

Accepted 전환 때 Keystore가 감싸는 device-slot-secret blob도 별도 versioned local
contract로 고정한다. Java/Kotlin object serialization이나 provider 기본값에 맡기지 않는다.
계약은 최소한 다음을 명시해야 한다.

- 고정 blob version, 최대 전체 길이와 각 필드의 exact type·길이
- CSPRNG로 매 encrypt 생성하는 AES-GCM IV의 exact 길이, blob 안 저장 위치와
  동일 wrapping key 아래 IV 재사용 금지
- ciphertext와 authentication tag의 exact 길이
- exact domain, blob version, vault commitment, opaque device ID, Slot ID,
  `key_epoch`, wrapping-key instance/generation을 결합하는 canonical AAD
- alias mapping과 wrapping-key generation 교체 시 이전 blob을 새 identity에
  자동 연결하지 않는 규칙
- unknown version, malformed length, IV/AAD/ciphertext/tag 변조를 원문 보존하며
  fail-closed하는 규칙

이 local blob은 protection Slot wire나 Android backup 형식이 아니며, 다른 기기로
복원·이식할 수 있다고 표현하지 않는다. 정확한 encoding과 IV 길이는 독립 플랫폼
검토 전 후보일 뿐 구현에 선반영하지 않는다.

## 8. BiometricPrompt와 암호 연산 결합

정상 unlock은 다음 순서를 벗어나면 안 된다.

1. 앱은 locked 상태와 현재 generation을 확인한다.
2. 저장된 opaque alias·device ID·Slot ID mapping과 hardware security level을 검증한다.
3. Keystore key로 decrypt `Cipher`를 초기화한다. key invalidation과 alias 부재는 이 단계에서 fail-closed한다.
4. 바로 그 `Cipher`를 `BiometricPrompt.CryptoObject`에 넣고 PromptInfo의
   allowed authenticators를 `BIOMETRIC_STRONG`으로 제한해 prompt를 시작한다.
5. 성공 callback이 돌려준 결과에서 동일한 authenticated `CryptoObject`의 `Cipher`를 얻는다.
6. 그 Cipher로 정확히 한 개의 bounded device-slot-secret blob을 복호화한다.
7. 공통 Rust core가 device-slot secret, protection Slot과 authenticated epoch를 사용해 Root Key를 연다.
8. 현재 generation·Activity/session 상태를 다시 확인한 뒤에만 `VaultSession`을 publish한다.
9. 성공·오류·취소 모두에서 transient byte array, Cipher 참조와 pending operation을 폐기한다.

생체 성공 여부를 boolean permission처럼 저장하지 않는다. prompt 전에 만든 Cipher가 아닌 새 Cipher, 다른 alias의 Cipher 또는 callback 밖의 별도 복호화는 거부한다. 동일 성공 callback으로 둘 이상의 blob 또는 둘 이상의 Slot을 열지 않는다.

동시 prompt는 하나만 허용한다. lock, logout, background, 화면 꺼짐, Activity destruction, navigation 취소와 process generation 변경은 pending result를 무효화한다. 늦게 도착한 성공 callback이 세션을 되살리지 못해야 한다.

## 9. 무효화·분실 상태표

후속 상태기계와 테스트는 최소한 다음 판정을 고정한다.

| 사건 | 로컬 판정 | 자동 처리 금지 | 복구·서버 후속 |
| --- | --- | --- | --- |
| 새 강한 생체 등록 | key permanently invalidated | 같은 alias/device ID 자동 재생성 | 다른 보호 경로로 열고 device Slot 폐기·필요한 epoch 전환 |
| 모든 생체 삭제 | key permanently invalidated | device credential로 조용히 우회 | 다른 보호 경로와 재등록 |
| secure lock screen 삭제·강제 reset | key permanently invalidated | software key fallback | 기기 신뢰 폐기와 복구 절차 |
| Keystore alias 삭제·부재 | unusable device protector | 새 키를 같은 Slot에 자동 연결 | 새 device identity로 명시적 가입 |
| 앱 data clear 또는 reinstall | 이전 local identity 상실 | backup에서 이전 device identity 부활 | 새 기기로 취급, 기존 roster는 별도 폐기 |
| OS backup/D2D restore | restored blob을 사용할 수 없음 | alias가 없는데 blob만 신뢰 | 새 기기 가입 또는 다른 복구 경로 |
| 일시적 biometric lockout·취소 | 계속 locked | auth level 완화 | 재시도 또는 별도 보호 경로 |
| 앱 background·process death | pending operation cancelled | 늦은 callback publish | 처음부터 새 unlock |
| security level software/unknown | 독립 Slot 부적격 | UI에서 trusted로 표시 | password 또는 다른 고보증 경로 매번 요구 |
| 서버 roster에서 device 폐기 | 로컬 키가 남아도 권한 없음 | offline 상태를 최신으로 자동 승격 | 새 epoch/checkpoint와 전체 재가입 |
| 과거 app-data/checkpoint 복원 | rollback/fork 상태 | 자동 병합·자동 write | trusted anchor 비교와 사용자 복구 흐름 |

`KeyPermanentlyInvalidatedException`, alias missing, malformed local mapping과 AEAD authentication failure는 서로 다른 내부 운영 상태일 수 있지만 로그에 키·Slot blob·사용자 Secret을 포함하지 않는다. 사용자는 `이 기기 보호 수단을 사용할 수 없음`과 다음 안전한 복구 행동을 볼 수 있어야 한다.

## 10. backup·restore 정책

다음은 cloud Auto Backup, device-to-device transfer와 cross-platform transfer 모두에서 제외한다.

- Keystore alias와 local device identity의 권위 mapping
- hardware-wrapped device-slot-secret blob
- pending biometric operation·session generation
- unlocked session, Root Key, device-slot secret과 검색 index
- 복구 진행 중인 임시 파일과 plaintext cache

Android 12+의 `android:dataExtractionRules`와 `res/xml/data_extraction_rules.xml`에서
cloud backup과 device-to-device transfer를 모두 명시적으로 제외한다. 지원 플랫폼의
규칙 schema에 `cross-platform-transfer`가 있으면 그 section에서도 같은 device-bound
상태를 명시적으로 제외한다. 낮은 API를 지원하는 합성 앱은
`android:fullBackupContent` 규칙도 별도로 둔다. 빠진 transfer section이 자동 차단을
뜻한다고 가정하지 않으며, 지원 OS/target SDK별 실제 backup·restore 결과를 검사한다.

가능하면 key-bound local state는 `noBackupFilesDir` 아래에 두되 directory 위치만으로 충분하다고 간주하지 않고 manifest/XML 규칙과 restore 테스트를 함께 둔다. 일반 설정과 민감한 device-bound state를 같은 DataStore·SharedPreferences 파일에 섞지 않는다.

암호화된 vault ciphertext 자체의 backup/export는 별도 제품 계약이다. ciphertext를 복원할 수 있다는 사실이 이전 Android device Slot 또는 device roster identity의 복원을 뜻하지 않는다.

## 11. roster·폐기·epoch 관계

- `sync_client`와 `recovery_authenticator` 역할을 분리한다.
- software-backed Android는 sync client가 될 수 있지만 독립 recovery Slot을 가지지 않는다.
- device wrapping key와 device signing key의 public identity·commitment는 인증된 full roster와 checkpoint에 결합되어야 한다.
- local key invalidation만으로 서버 roster 폐기가 완료됐다고 주장하지 않는다.
- 서버 roster 폐기만으로 기기가 과거에 본 Root Key·평문이 회수됐다고 주장하지 않는다.
- 다른 보호 경로가 device/recovery Slot을 폐기하면 ADR 0003에 따라 새 Root Key, item re-encryption, 새 Slot roster와 checkpoint를 갖는 recovery transition을 완료한다.
- transition이 완료될 때까지 기존 epoch를 파괴하지 않되, 폐기 요청을 받은 기기의 신규 서버 쓰기는 `account_recovery_generation`으로 즉시 차단하는 후속 계약이 필요하다.

현재 signed-checkpoint v0alpha1은 same-roster successor만 다루며 Android Keystore, recovery transition과 full device/recovery roster를 범위 밖으로 둔다. 이를 Android device 폐기 완료 증거로 재사용하지 않는다.

## 12. 생체정보·UI·관측 정책

- 앱과 서버는 지문·얼굴 template 또는 biometric 원본을 받거나 저장하지 않는다.
- 앱은 OS가 제공한 성공 결과와 key-use 가능 여부만 다룬다.
- 복구 키, Secret 원문과 device-slot-secret 화면에는 screenshot 차단을 적용하고 recents preview를 가린다.
- unlock 화면과 Secret 화면에 광고, session replay, 임의 analytics SDK 또는 제3자 WebView script를 넣지 않는다.
- clipboard는 후속 별도 정책 없이는 자동 사용하지 않는다. 사용자가 복사한 이후의 외부 앱 보호를 보장하지 않는다.
- alias, exception과 prompt 오류를 기록하더라도 전체 alias·Slot ID, ciphertext, site/account name과 Secret을 로그·crash report에 포함하지 않는다.
- 루팅·debugger·overlay 탐지는 보조 신호일 뿐 hardware-backed 판정이나 생체 결합을 대체하지 않는다.

## 13. attestation 경계

이 ADR은 Android key attestation, Play Integrity 또는 별도 원격 증명 서비스를 채택하지 않는다.

- local synthetic alpha는 `KeyInfo`와 실제 Keystore 연산을 기기 내부 정책에만 사용한다.
- 서버는 클라이언트가 보낸 `hardware_backed=true` 같은 값을 독립 보증으로 신뢰하지 않는다.
- 원격 hardware claim이 제품 보안 약속이나 roster 권한에 필요하면 별도 ADR에서 challenge freshness, certificate chain·revocation, privacy, unsupported device, offline mode와 outage를 결정한다.
- attestation이 없어도 암호문 동기화는 설계할 수 있지만, 검증되지 않은 기기를 고보증 recovery authenticator라고 표시해서는 안 된다.

## 14. 거부한 대안

- biometric template 또는 biometric 결과에서 직접 암호 키 파생: OS 신뢰 경계를 위반하므로 거부
- CryptoObject 없는 `BiometricPrompt` 성공 뒤 일반 파일 키 사용: 인증과 암호 연산의 결합이 없으므로 거부
- 양수 authentication validity window: background 악성 동작의 재사용 창을 만들므로 첫 고보증 경로에서 거부
- `BIOMETRIC_WEAK`: Keystore cryptographic operation의 강한 인증 요구를 충족하지 않으므로 거부
- 같은 key에 `AUTH_DEVICE_CREDENTIAL`을 조용히 추가: biometric enrollment invalidation 정책을 약화·모호하게 하므로 첫 경로에서 거부
- software-backed key에 독립 Root Key Slot 발급: ADR 0003의 최소 보증 수준을 깨므로 거부
- invalidation 때 같은 device/Slot identity 자동 재생성: 폐기된 identity 부활과 rollback을 만들 수 있어 거부
- wrapping key와 signing key 재사용: key purpose와 폐기 범위를 결합하므로 거부
- device-bound blob을 Auto Backup/D2D에 포함: alias 없는 복원·과거 identity 부활을 유도하므로 거부
- Root Key를 SharedPreferences, Room, file 또는 Android backup에 저장: Keystore 경계를 우회하므로 거부
- root detection·Play Integrity만으로 trusted-device 판정: 우회 가능하며 key-use authorization을 대체하지 못하므로 거부

## 15. Accepted 전환 수용 기준

### 문서·설계

- ADR 0004의 Accepted protection-slot wire와 정확히 맞는 platform boundary 승인
- Android API/target/min SDK, Jetpack Biometric version과 dependency lock 결정
- algorithm·key purpose·auth parameter와 security-level allowlist 확정
- invalidation 상태표, error contract, backup rule과 device roster transition 확정
- 독립 Android 보안 설계 리뷰에서 Critical/Important 미해결 0개

### 합성 단위 테스트

- fake Keystore/Biometric adapter로 모든 상태 전이와 generation invalidation 검증
- PromptInfo가 `BIOMETRIC_STRONG` 이외의 authenticator를 허용하면 시작 전 거부
- success callback의 다른 CryptoObject/Cipher·operation, 다른 alias와 두 번째 사용 거부
- cancel, timeout, background, lock, dispose와 늦은 callback에서 session publish 0회
- alias/Slot/device mapping, IV, AAD와 ciphertext tamper 거부
- version·길이·IV·tag·AAD field를 포함한 local wrapped-blob parser의 strict
  canonical/limit 검사와 동일 wrapping key 아래 IV 중복 방지
- key invalidation·alias missing·software security level의 fail-closed 처리
- backup 복원 fixture가 이전 trusted-device identity를 만들지 못함
- secret-bearing Kotlin/native 타입의 formatting·serialization 금지와 zeroization 경계 검사

### Android instrumentation·실기기 테스트

- `BiometricPrompt.CryptoObject(Cipher)`와 auth-per-use key의 실제 encrypt/decrypt
- API 31+ TEE 기기와 가능한 StrongBox 기기의 `KeyInfo.getSecurityLevel()` 기록
- 사용자 인증 요구가 secure hardware에서 강제되는지 확인하고 거짓·미지원 결과에서
  독립 Slot 발급을 거부
- emulator 또는 software-backed 결과가 독립 Slot을 받지 못하는 negative test
- 새 biometric 등록, 전체 biometric 삭제와 secure lock screen 변경 후 invalidation
- `KeyPermanentlyInvalidatedException`, temporary/permanent lockout와 사용자 취소
- app data clear, uninstall/reinstall, OS backup restore, D2D restore와 지원되는
  cross-platform transfer restore
- Activity recreation, 화면 회전, background/foreground, screen off, process death와 동시 prompt
- reboot·OS update 뒤 정책 유지와 security-level 변화 처리
- 최소 두 OEM/보안영역 조합에서 실행한 bounded 검증 기록
- 로그, screenshot, recents, crash report와 backup artifact의 secret scan

실기기 통과는 해당 기기·OS 조합의 증거일 뿐 모든 Android 기기나 웹 채널의 승인이 아니다.

## 16. 후속 구현 대상 — 승인 전 수정 금지

Accepted 이후 별도 계획과 파일 소유권을 승인할 때만 다음을 검토한다.

- `apps/android/` Gradle project와 manifest
- `apps/android/src/main/res/xml/data_extraction_rules.xml`
- 필요한 경우 Android 11 이하용 `backup_rules.xml`
- Keystore/Biometric platform adapter와 lifecycle state machine
- Android unit·instrumentation tests
- 새 Android Rust binding crate와 workspace 등록
- 합성 Android 검증 기록

Keystore 파일, signing key, `.jks`, `local.properties`, 실제 device backup과 실제 복구 키는 Git에 추가하지 않는다.

## 17. 공식 참고자료

- [Android Keystore system](https://developer.android.com/privacy-and-security/keystore)
- [`KeyInfo.getSecurityLevel()`과 security level](https://developer.android.com/reference/android/security/keystore/KeyInfo#getSecurityLevel())
- [`KeyInfo.isUserAuthenticationRequirementEnforcedBySecureHardware()`](https://developer.android.com/reference/android/security/keystore/KeyInfo#isUserAuthenticationRequirementEnforcedBySecureHardware())
- [`KeyPermanentlyInvalidatedException`](https://developer.android.com/reference/android/security/keystore/KeyPermanentlyInvalidatedException)
- [`KeyGenParameterSpec.Builder.setUserAuthenticationParameters`](https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec.Builder#setUserAuthenticationParameters(int,%20int))
- [`KeyGenParameterSpec.Builder.setInvalidatedByBiometricEnrollment`](https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec.Builder#setInvalidatedByBiometricEnrollment(boolean))
- [`androidx.biometric.BiometricPrompt.CryptoObject`](https://developer.android.com/reference/androidx/biometric/BiometricPrompt.CryptoObject)
- [Android Auto Backup와 `data-extraction-rules`](https://developer.android.com/identity/data/autobackup)

## 18. 관련 저장소 문서

- [ADR 0003: 보호 수단별 Key Slot과 복구 정책](0003-protection-key-slots-and-recovery-policy.md)
- [ADR 0004: Protection Key Slot wire v0alpha1 제안](0004-protection-key-slot-wire-v0alpha1.md)
- [복구·보호 수단 설계](../superpowers/specs/2026-08-14-recovery-protection-design.md)
- [보안 아키텍처](../SECURITY_ARCHITECTURE.md)
- [위협 모델](../THREAT_MODEL.md)
