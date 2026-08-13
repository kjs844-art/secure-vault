# 단계적 수익화·스토어·OpenAI 플러그인 설계

- 상태: 초안 — 사용자 검토 대기
- 기준일: 2026-08-13
- 적용 제품: Secure Vault 개인용 금고

## 1. 결정 요약

Secure Vault는 처음부터 유료화하지 않는다. 보안 신뢰와 복구 가능성을 먼저 증명하고 다음 순서로 출시한다.

1. 개인 로컬 알파: 합성 데이터만 사용하고 결제 기능을 만들지 않는다.
2. 웹·Android 무료 비공개 베타: 결제수단 없이 모든 베타 기능을 제공한다.
3. 보안 출시 게이트 통과: 암호 설계 검토, 복구·기기분실 훈련, 침투 테스트, 개인정보·계정삭제 준비를 완료한다.
4. 웹·Android 공개 Free/Pro: 그 시점부터 구독을 활성화한다.
5. 네이티브 iOS 앱과 StoreKit 구독을 추가한다.
6. 금고 데이터에 접근하지 않는 OpenAI 보안 가이드·앱 딥링크 플러그인의 타당성을 별도 심사한다. 공개 등록은 당시 정책과 기능 유용성을 다시 확인한 뒤 결정한다.

무료 여부와 관계없이 암호화, 복구 키, 안전한 내보내기, 계정 삭제, 로컬 비밀번호 생성 같은 핵심 안전 기능은 결제벽 뒤에 두지 않는다.

## 2. 무료 베타

무료 베타의 내부 plan code는 `BETA_V1`이다. 유료 결제 화면, 결제 SDK, 카드 입력, 상품 SKU, 자동 갱신은 포함하지 않는다.

베타 사용자는 다음 한도를 무료로 사용한다.

- 암호화 레코드 슬롯 최대 5,000개
- 현재·이력 동기화 암호문 합계 50 MiB
- 신뢰 기기 10대
- 암호화 이력·휴지통 90일
- 서비스/API/MCP 템플릿과 로컬 회전 알림
- Android 오프라인 사용과 웹 동기화

베타 단계의 실제 Secret 사용은 기존 보안 명세의 출시 게이트를 통과한 빌드에서만 허용한다. 그전에는 합성 데이터만 사용한다.

유료 전환 최소 60일 전에 앱 안과 등록 이메일로 한도·가격·전환일을 고지한다. 기존 베타 사용자는 유료 출시일부터 90일간 무료 Pro 권한을 받는다. 사용자가 결제하지 않아 Free 한도를 초과해도 기존 암호문을 삭제하지 않는다.

## 3. 공개 요금제

서버는 암호문 안에 실제 비밀번호나 API 키가 몇 개 들어 있는지 알 수 없다. 따라서 제품은 “API 키 N개”가 아니라 검증 가능한 **암호화 레코드 수와 동기화 용량**을 한도로 표시한다.

### Free — `FREE_V1`

- 월 0달러
- 암호화 레코드 슬롯 최대 100개
- 현재·이력 동기화 암호문 합계 2 MiB
- 신뢰 기기 2대
- 암호화 이력·휴지통 7일
- 암호화, 복구, 검색, 보기, 복사, 내보내기, 계정 삭제 포함
- 기본 서비스/API/MCP 템플릿과 단일 기기 로컬 만료·회전 알림
- 첨부파일 미지원

### Pro — `PRO_V1`

- 출시 가격 가설: 월 US$3.99 또는 연 US$35.88
- 스토어·국가별 세금과 가격 구간에 따라 현지화하되 기능 한도는 동일
- 암호화 레코드 슬롯 최대 5,000개
- 현재·이력 동기화 암호문 합계 50 MiB
- 신뢰 기기 10대
- 암호화 이력·휴지통 90일
- 일괄 가져오기, 다중 기기 동기화 알림 규칙, 일괄 회전 대시보드
- 첨부파일은 별도 보안 설계 전까지 미지원

가격은 현재 판매 가격이 아니라 무료 베타 이후 검증할 출시 가설이다. 유료화 승인 시점에 인프라 원가, 세금, 스토어 수수료, 경쟁 가격을 다시 측정하고 사용자가 별도로 승인한 가격표 버전을 활성화한다.

## 4. 한도와 다운그레이드 안전

암호문 한 개 안에 실제 비밀번호나 API 키를 몇 개 넣었는지는 서버가 검증할 수 없다. 이 문서의 “레코드”는 공식 클라이언트가 논리 항목 하나에 배정하는 **암호화 레코드 슬롯**을 뜻하며, 실제 Secret 개수를 뜻하지 않는다.

각 논리 항목은 클라이언트가 생성한 무작위 `opaque_record_id`를 계속 사용한다. 서버는 그 식별자의 의미와 평문을 모르지만 활성 슬롯 수, 같은 슬롯의 revision 빈도, 삭제 시각은 볼 수 있다. 이 노출은 한도와 안전한 교체를 강제하기 위한 의도적 운영 메타데이터이며 개인정보 문서에 공개한다.

서버가 직접 측정하는 값은 활성 레코드 슬롯 수, 현재 revision 암호문 byte, 이력 암호문 byte, 요청 body의 실제 byte, 기기 수와 이력 보관기간이다. 클라이언트가 보고한 사용량을 신뢰하지 않는다. 일반 변경은 DB transaction의 원자적 조건부 갱신으로 `usage + delta <= limit`를 강제하고, 아래의 `safety swap`만 별도 무증가 조건으로 허용한다. 슬롯 수와 byte 한도는 동시에 적용한다.

- 레코드당 암호문 최대 64 KiB이며 1/4/16/64 KiB 패딩 버킷을 사용한다. 버킷 값은 암호 프로토콜 검토에서 변경할 수 있다.
- `(user_id, opaque_record_id)`는 활성 슬롯에서 고유하고 `(user_id, opaque_event_id)`는 전체 이벤트에서 고유하다. 재전송으로 슬롯이나 byte가 중복 증가하지 않는다.
- 모든 변경은 새 서명 revision을 append한다. 기존 revision의 hash와 checkpoint commitment는 보존하고, 허용된 보관기간이 지난 암호문 body만 검증된 checkpoint 뒤에 GC한다.
- 오프라인에서 만든 초과 항목은 삭제하지 않고 “로컬 전용·동기화 안 됨”으로 표시한다.
- 결제 실패·취소·환불·다운그레이드로 기존 암호문을 삭제하지 않는다.
- 한도 초과 상태에서도 읽기, 검색, 복사, 내보내기와 삭제를 허용한다.
- 기존 자격 증명 교체는 동일한 `opaque_record_id`, `expected_head_hash`, 기존 패딩 버킷 안에서 원자적 compare-and-append `safety swap`으로 허용한다. 새 revision과 checkpoint를 먼저 확정하고 이전 body는 billable usage와 분리된 `history_safety_reserve`로 옮긴다. 활성 슬롯 수와 정상 현재 byte는 증가하지 않지만 이전 body를 즉시 GC하지 않는다.
- `history_safety_reserve`는 슬롯별 이전 body 한 개만 보관하며, 전체 cap은 over-limit 진입 시점의 활성 현재 암호문 byte와 직전 entitlement의 전체 ciphertext 한도 중 작은 값이다. 각 body의 만료일은 수락 당시 entitlement의 7일/90일 이력기간으로 고정하고 이후 다운그레이드로 앞당기지 않는다.
- reserve body는 만료일이 지나고 그 body를 포함한 checkpoint가 최소 두 개의 신뢰 기기 또는 한 개의 신뢰 기기와 검증된 암호화 export에서 확인된 뒤에만 GC한다. 확인 수단이 부족하면 만료 뒤에도 격리 보존하고 사용자에게 정리 필요 상태를 표시한다.
- 같은 슬롯의 reserve body가 아직 남아 있거나 전체 reserve cap을 넘는 추가 swap은 서버가 받지 않는다. 새 값은 기기의 로컬 충돌 복구함에 보존하고 `SYNC_SAFETY_RESERVE_FULL`을 표시한다. 사용자는 다른 기기 확인·암호화 export·기존 이력 정리 또는 Pro 복원 후 다시 동기화할 수 있으며, 그전에는 성공으로 표시하지 않는다.
- 같은 `expected_head_hash`에서 시작한 첫 번째 competing stale revision 한 개는 슬롯별 conflict reserve에 받아 최대 두 개 head와 패딩 버킷 두 배까지만 보존한다. 충돌 중에는 어느 head body도 GC하지 않고 사용자가 두 값을 확인해 새 merge revision을 만들 때까지 지속 경고한다.
- 세 번째 competing head, 알 수 없는 frontier에서 늦게 도착한 revision 또는 reserve 상한을 넘는 값은 서버에서 거부한다. 거부된 암호화 revision은 해당 기기의 로컬 충돌 복구함에 남기고 `SYNC_CONFLICT_LOCAL_ONLY`를 표시하며, 사용자가 최신 head와 명시적으로 해결하기 전에는 성공으로 표시하지 않는다.
- 삭제와 swap이 같은 head에서 갈라지면 기본 목록에서는 삭제를 유지하고 수정값은 conflict reserve의 암호화 복구본으로 보존한다. 사용자가 복원하기 전에는 자동으로 활성 슬롯을 되살리지 않는다.
- 더 큰 버킷이 필요한 교체는 다른 항목을 삭제해 공간을 확보하거나 Pro를 복원할 때까지 로컬 전용으로 남기며, 서버 동기화 성공으로 표시하지 않는다.
- 신규 레코드와 일반 이력 축적만 중단한다. 유효한 Pro가 복원되면 제공자 API 재검증 후 동기화를 재개한다.
- 변조된 클라이언트가 한 슬롯에 여러 Secret을 포장하는 것은 서버가 탐지할 수 없으므로 레코드 한도는 보안 경계가 아니다. 저장 byte·기기·요청 크기 한도만 서버가 확실히 강제한다.

## 5. 결제 권한 모델

모든 채널은 공통 내부 plan code와 버전형 plan catalog에 매핑한다. 결제 성공 화면이나 클라이언트 영수증만으로 권한을 부여하지 않는다.

공통 서버 모델:

- `provider_subscription`: 제공자 구독 ID, 내부 사용자, 상품, 상태, 기간 종료, grace, 자동 갱신
- `entitlement_snapshot`: 사용자, plan code, access mode, limits, 유효기간, 출처와 버전
- `billing_event`: 제공자 이벤트 ID와 digest, 수신·처리 시각; 제공자별 이벤트 ID 고유
- `provider_purchase_binding`: provider, sandbox/production 환경, application/package, product, 원 구매 ID, 내부 사용자와 binding nonce
- `quota_usage`: 활성 레코드 슬롯 수, billable 현재·이력 byte, history safety reserve byte, conflict reserve byte, version
- `access_mode`: `NORMAL`, `GRACE`, `OVER_LIMIT_READ_WRITE_EXISTING`, `LOCAL_ONLY`

Webhook은 원문 서명 검증 후 durable inbox에 기록하고 중복 제거한다. 이벤트 도착 순서를 신뢰하지 않으며 제공자 API에서 현재 상태를 다시 조회한다. 일일 reconciliation과 로그인·결제관리 진입 시 제한된 재검증으로 누락을 복구한다.

구매 전 서버가 일회용 `billing_binding_id`를 발급한다. 웹 Checkout은 이 값을 서버 세션에 묶고, Play는 이를 기반으로 만든 비식별 HMAC `obfuscatedAccountId`, Apple은 무작위 UUID `appAccountToken`을 사용한다. 검증 결과의 provider, 환경, application/package, product가 서버 allowlist와 모두 일치해야 한다.

`(provider, environment, application_id, original_purchase_id)`는 전역 고유하며 첫 내부 사용자에게 원자적으로 귀속한다. 계정이 존재하는 동안 같은 사용자의 복원만 허용하고 다른 계정으로 자동 이전하지 않는다. 계정 삭제 뒤의 스토어 구매 복원은 8절의 제한된 새 빈 금고 재귀속만 허용하며 삭제한 금고는 복구하지 않는다. production에서 sandbox 영수증을 받거나 이미 귀속된 구매를 다른 사용자가 재사용하면 권한을 부여하지 않는다.

여러 채널에서 중복 구독해도 용량을 합산하지 않고 가장 높은 유효 tier 하나만 적용한다. 사용자가 각 구독의 구매처를 확인하고 해당 채널에서 취소할 수 있게 한다.

## 6. 채널별 결제

### 무료 베타

프로덕션 결제 제공자와 Secret을 구성하지 않는다. 현재 무료 베타 마일스톤에서는 결제 SDK, billing adapter, 상품 SKU, 결제 UI를 구현하지 않고 서버가 서명한 정적 `BETA_V1` 권한만 사용한다.

결제 구현은 Free/Pro 활성화 게이트를 사용자가 별도로 승인한 뒤 시작한다. 그때 provider contract test용 합성 이벤트 fixture를 추가하되 실제 결제 Secret과 실제 카드 정보는 테스트에 사용하지 않는다.

### 웹

웹 결제는 `WebBillingProvider` 인터페이스 뒤에 둔다. 현재 Stripe 공식 글로벌 계정 목록에 한국이 직접 지원 국가로 표시되지 않으므로 한국 사업자라는 가정만으로 Stripe를 고정하지 않는다.

유료화 시점에 다음 순서로 별도 승인한다.

1. 실제 판매 주체와 사업자 소재지 확인
2. 해당 소재지를 공식 지원하는 국내 PG, Merchant of Record 또는 Stripe 지원 법인 경로 비교
3. 정기결제, 환불, 세금계산, 개인정보 처리위탁, 한국 소비자 고지를 검토
4. 사용자가 비용과 계약조건을 승인한 제공자 adapter만 구현

Stripe를 선택할 수 있는 지원 법인이 확인되면 hosted Checkout과 Customer Portal을 사용한다. price/customer ID는 서버 allowlist로 제한하고 모든 POST는 idempotency key를 사용한다.

### Android

Google Play 배포판의 앱 내 디지털 구독은 Play Billing을 사용한다. purchase token을 백엔드에서 Google API로 검증하고 Real-time Developer Notifications는 상태 변화 신호로만 사용한다. 최초 구매는 정해진 기한 내 acknowledge한다.

### iOS

iOS 앱은 Swift/SwiftUI, Keychain·Secure Enclave·Face ID와 공유 Rust 암호화 코어를 사용하는 네이티브 클라이언트로 별도 구현한다. 앱 내 구독은 StoreKit을 사용하고 App Store Server Notifications V2와 Server API로 검증한다. 강한 암호화를 사용하므로 App Store Connect의 수출 규정 판정과 요구 서류를 제출한다.

웹이나 다른 스토어에서 산 유효 권한은 같은 Secure Vault 계정에서 사용할 수 있지만, 모바일 앱 안에서 신규 구독을 판매할 때는 해당 스토어 결제를 제공한다.

## 7. 결제 상태 전이

- 신규 `pending/incomplete`: Free 유지
- 결제·구매의 서버 검증 성공: Pro 즉시 활성화
- 자발적 취소·예약 다운그레이드: 현재 결제기간 종료 후 Free 전환
- 결제 실패: 제공자 정책과 내부 7일 grace 중 더 짧은 범위를 적용
- 갱신 성공: Pro 즉시 복원
- 환불·revoke·만료: 확인 즉시 초과 안전 모드로 전환
- 환불 취소·권한 복원: 제공자 API 검증 후 Pro 복원

환불이 구독 취소를 자동으로 의미한다고 가정하지 않는다. 관리 작업은 refund, cancel, entitlement refresh를 하나의 idempotent workflow로 실행한다.

## 8. 스토어·개인정보 출시 요건

Google Play와 Apple App Store에 다음을 준비한다.

- 공개 개인정보처리방침, 이용약관, 지원 연락처
- 앱 내부 계정 삭제 시작 기능
- Google Play용 앱 외부 공개 계정 삭제 URL
- 이메일, 내부 계정 ID, 결제 내역, IP·요청 시각, 진단 정보 등 운영 메타데이터의 정확한 공개
- 서버가 복호화할 수 없는 금고 암호문과 운영 메타데이터의 구분
- 합성 Secret만 포함한 심사용 데모 계정
- Android Data Safety와 Apple Privacy Label
- 암호화 수출 규정 판정
- 서드파티 광고·행동 분석 SDK 미사용

Apple에서 Google 로그인을 제공할 때 적용 요건에 맞는 Sign in with Apple도 제공한다. 개인 개발자 계정의 Google Play 신규 공개 조건이 적용되면 공식 비공개 테스트 요건을 먼저 충족한다.

### 계정 삭제와 활성 구독

활성 구독은 계정 삭제를 막지 않는다. 최종 확인 화면은 구매 채널, 현재 권한 종료일과 해당 스토어의 구독 관리 링크를 보여 주고, 앱 계정 삭제가 Play·App Store 구독을 자동 취소한다고 가정하면 안 된다는 점을 명시한다.

- 웹 구독은 삭제 요청과 함께 durable cancellation job에 넣고 제공자 API로 취소한다. 제공자 장애가 있어도 금고 삭제를 막지 않으며 권한은 즉시 중단하고 취소 요청을 idempotent하게 재시도한다.
- Play·App Store 구독은 공식 관리 화면을 열어 사용자가 취소할 수 있게 하고 고지를 확인받되, 취소 완료를 계정 삭제의 조건으로 삼지 않는다.
- 삭제 확정 즉시 세션과 기기 권한을 폐기하고 live wrapped key와 ciphertext를 삭제 queue에 넣는다. 백업 복사본은 계속 암호화된 상태로 격리하며 30일 안에 물리 삭제한다. 백업까지 즉시 사라진다고 과장하지 않는다.
- 세금·환불·분쟁 대응에 법적으로 필요한 결제 기록은 금고 DB와 분리하고 해당 관할에서 요구하는 최소 결제 식별정보만 보관한다. 금고 내용과 암호화 키는 포함하지 않는다.

구매 replay 방지 tombstone은 provider, 환경, application/package, product, 원 구매 ID의 keyed HMAC, 최종 권한 종료·revoke 시각, 삭제 시각과 retention deadline만 보관한다. 원 구매 ID 원문은 일반 운영 로그에 남기지 않는다. 목적과 법적 근거는 개인정보처리방침에 공개한다. 보존기간은 제공자별 최대 환불·chargeback 기간에 30일을 더한 기간과 법정 보존기간 중 긴 쪽이며, 공학적 하한은 최종 권한 종료 후 180일이다. 실제 판매 주체의 관할 법률 검토와 provider별 기간표가 승인되지 않으면 Free/Pro를 활성화하지 않는다.

삭제 뒤에도 유효한 Play·App Store 구매는 공식 Restore Purchase와 제공자 API 검증을 다시 통과하고 다른 활성 binding이 없을 때 한 개의 새 빈 Secure Vault 계정에만 원자적으로 재귀속할 수 있다. 이 복원은 구독 권한만 되살리며 삭제한 ciphertext, 키, 기기 또는 이력을 절대 되살리지 않는다. 반복 재귀속은 rate limit과 보안 감사 대상으로 삼는다.

## 9. OpenAI 플러그인

대상은 과거 GPT Plugin이 아니라 현재의 OpenAI Plugins Directory다. 첫 후보 플러그인은 별도 패키지와 공개 MCP endpoint를 사용하지만 Secure Vault 계정, 금고 API, 암호문 DB, 결제 API에 연결하지 않는다. 즉 메타데이터 전용이 아니라 **금고 데이터 비접근** 도우미다.

허용 도구:

- `get_security_guide`: 고정 enum 주제에 대한 정적 보안 체크리스트 반환
- `get_provider_rotation_steps`: 고정 allowlist의 공개 서비스 category ID에 대한 일반적인 키 회전 절차 반환
- `open_vault_deep_link`: 고정 enum 화면만 앱에서 열며 사용자·항목 식별자를 받거나 반환하지 않음

금지 도구와 응답:

- 비밀번호, API 키, Secret, MFA/OTP, 복구 코드, 개인키의 입력·저장·조회·표시·복사
- 사용자명, 실제 이메일, URL, 자유 입력 별칭, 메모, 항목 수, 만료일, 회전 상태의 전송
- 채팅 내용에서 Secret을 추출해 금고에 저장
- 외부 API에 금고 Secret을 주입하거나 실행
- 플러그인 안에서 구독 판매·업그레이드·결제 링크 제공

모든 tool input은 enum과 boolean의 닫힌 schema만 사용하고 추가 필드를 거부한다. API key처럼 보이는 문자열, 이메일, URL, 긴 고엔트로피 문자열과 prompt injection이 어느 필드로 들어와도 요청 전체를 거부하고 값 자체를 로그에 남기지 않는다.

개인 요약·별칭·날짜를 공유하는 `AI Safe View`는 이번 설계에서 구현하지 않는다. 그런 기능은 서버가 의미 메타데이터를 읽는 별도 projection을 만들기 때문에 zero-knowledge 경계를 변경한다. 별도 위협 모델, 격리 저장소, TTL, audience binding, replay 방지, 로그 금지, 전면 폐기 설계와 사용자의 새 승인이 모두 있기 전에는 추가하지 않는다.

첫 후보는 사용자 인증을 요구하지 않는다. 훗날 인증형 MCP를 제출한다면 심사용 로그인/비밀번호는 실제 계정 인증의 우회로가 아니라 실제 금고 API에 접근할 수 없는 격리된 합성 reviewer tenant에만 연결한다. 운영 사용자의 Google OIDC/passkey 정책에는 password bypass를 추가하지 않는다.

공개 제출 전 검증된 개발자/사업자 신원, 공개 웹사이트·지원·개인정보·약관 URL, 공개 production MCP URL, 도메인 검증, 정확한 tool annotations, 최소 5개 성공·3개 실패 테스트를 준비한다. 당시 정책을 다시 확인하고 단순 홍보성 딥링크가 아니라 독립적인 보안 가이드 효용을 입증할 때만 등록한다.

## 10. 출시 게이트

### 무료 비공개 베타 시작

- 핵심 암호 테스트 벡터와 변조 거부 테스트 통과
- 합성 데이터 E2E와 복구 훈련 통과
- 서버·클라이언트 로그 Secret 검사 통과
- 계정 삭제와 암호화 export 검증
- P0/P1 보안 결함 0개

### 실제 Secret 베타

- 독립 암호 설계 검토 완료
- 침투 테스트의 고위험 미해결 0개
- 분실 기기 폐기와 key epoch 회전 훈련 통과
- 개인정보처리방침과 사고대응 절차 공개

### Free/Pro 활성화

- 인프라 단위원가와 환불·세금·스토어 수수료 재측정
- 생산 결제 제공자와 계약조건 사용자 승인
- 구매·중복 webhook·비순차 이벤트·취소·환불·grace·복원 테스트 통과
- provider별 계정 삭제·구독 취소·Restore Purchase·구매 tombstone 보존기간표와 법적 근거 검토 완료
- 무료 한도 초과 시 데이터 비삭제·내보내기 보장 검증
- 가격과 유료 전환일 60일 사전 고지

### iOS·OpenAI 플러그인

- iOS 암호화 수출 규정과 App Review 준비 완료
- 플러그인이 금고 API·계정·결제 시스템과 네트워크 수준에서 분리됐음을 검증
- Restricted Data, 자유 입력, 추가 schema 필드와 prompt injection을 거부하는 negative test 통과
- OpenAI 심사용 합성 fixture와 공개 정책 자료 준비 완료
- 제출 당시 정책과 독립적 사용자 효용을 다시 검토해 사용자 승인

## 11. 테스트 시나리오

- 동시에 레코드를 생성해도 활성 슬롯과 byte quota를 초과하거나 이중 계산하지 않는다.
- 초과 상태의 같은 버킷 자격 증명 교체가 append-only revision과 checkpoint 연속성을 유지하며, 서버 확인 전 성공으로 표시되지 않는다.
- safety swap의 이전 body가 수락 당시 7일/90일 이력기간과 복구 확인조건 전에는 GC되지 않으며 reserve가 찬 추가 swap은 로컬 안전본으로 남는다.
- 초과 상태의 동시 교체는 두 server head까지만 conflict reserve에 보존하고 세 번째·늦은 writer는 로컬 충돌 복구함에 보존하며 미동기화 상태를 명확히 표시한다.
- 초과 상태의 삭제·교체 충돌에서 삭제는 기본 목록을 유지하고 수정값은 사용자가 복원할 때까지 자동 부활하지 않는다.
- 결제 성공 redirect만 조작해도 Pro가 활성화되지 않는다.
- 중복·역순 webhook이 최신 entitlement를 되돌리지 않는다.
- sandbox/production 혼용, 다른 사용자 구매 replay, 잘못된 app·package·product는 권한을 만들지 않는다.
- 결제 실패와 취소 후에도 모든 기존 암호문을 읽고 내보낼 수 있다.
- 다운그레이드 후 기존 비밀번호·키 교체가 막히지 않는다.
- 오프라인 초과 항목이 삭제되지 않고 로컬 전용으로 표시된다.
- Play·StoreKit·웹 중복 구독이 quota를 합산하지 않는다.
- 계정 삭제가 ciphertext, wrapped key, device roster를 제거하고 법적 보관 결제기록만 분리 보존한다.
- 결제 제공자가 응답하지 않아도 계정 삭제는 완료되고 웹 구독 취소 job은 idempotent하게 재시도된다.
- 삭제 계정의 스토어 구매 복원은 한 개의 새 빈 계정에 권한만 귀속하며 삭제한 금고 데이터나 다른 활성 계정 권한을 되살리지 않는다.
- OpenAI 플러그인의 모든 schema와 응답에서 인증 비밀·개인 식별자·자유 입력이 거부된다.
- prompt injection으로도 금고 또는 Secure Vault 계정 API에 접근하지 못한다.

## 12. 공식 근거

- [OpenAI 플러그인 제출](https://developers.openai.com/plugins/deploy/submission)
- [OpenAI 플러그인 지침](https://developers.openai.com/plugins/app-guidelines)
- [Stripe 글로벌 계정 지원 국가](https://stripe.com/global)
- [Stripe webhook](https://docs.stripe.com/webhooks)
- [Google Play 결제 정책](https://support.google.com/googleplay/android-developer/answer/9858738)
- [Google Play Billing 백엔드](https://developer.android.com/google/play/billing/backend)
- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Apple 암호화 수출 규정](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance)
