# Personal Vault MVP

## 목표 사용자

OpenAI, Claude, Manus, Grok, Meta, Supabase 등 여러 개발·AI 서비스를 사용하는 개인 사용자입니다.

사용자는 어느 Console에서 어떤 API 키·Secret을 발급했고, 어느 앱·플러그인·MCP 서버·프로젝트·환경에 연결했는지를 잊지 않고 관리하려고 합니다. Secure Vault는 단순 목록이 아니라 자격 증명의 출처와 사용처를 연결하는 로컬 관계 지도를 제공합니다.

### 사용자 재확인 — 2026-09-15

API 키 관리뿐 아니라 **어떤 계정/로그인 방법으로 어느 서비스에 가입했는지**도 관리합니다.
Google·카카오·네이버 계정 같은 로그인 수단, 가입한 서비스의 계정, 그 서비스에서 발급한
자격 증명, 자격 증명을 연결한 도구를 서로 다른 개념으로 구분합니다.
소셜 로그인만 사용하는 서비스에는 별도 서비스 비밀번호가 없을 수 있으므로 가짜 비밀번호
필드를 만들거나 소셜 계정 비밀번호를 매 서비스에 중복 보관하도록 요구하지 않습니다.

```text
로그인 수단/계정 → 가입한 서비스 계정 → 발급 자격 증명 → 앱·MCP·CLI 등의 연결처
```

이는 제품 목표이며 현재 실제 소셜 계정 조회 기능이 구현됐다는 뜻이 아닙니다.
사용자의 한 번의 로그인이나 이메일 주소만으로 모든 가입 서비스/API 키/사용처를 자동
발견했다고 표시하지 않습니다. 수동 기록과 별도 동의·권한 아래 공식적으로 확인한 정보는
출처·마지막 확인 시점·확인 불가 상태를 구분해야 합니다. 소셜 연결 해제와 대상 서비스의
회원 탈퇴도 동일한 상태로 취급하지 않습니다. 임의 이메일/브라우저/클립보드 배경 수집은
활성화하지 않습니다. 의미 있는 계정 정보는 기존 암호화·로컬 표시 경계를 따릅니다.

디자인은 사용자가 Claude Code와 진행합니다. 기능/보안 구현과 파일 충돌을 피하는 기준은
[디자인 협업 인계](handoff/CLAUDE_CODE_DESIGN_HANDOFF.md)에 기록합니다.

## 현재 구현 상태

현재 구현된 범위는 합성 데이터 전용 `v0alpha1` 로컬 암호화 코어, 암호문 SQLite 영속 저장 slice, 별도의 웹 Worker/WASM·IndexedDB 합성 데모입니다. 이것은 사용할 수 있는 비밀번호 관리자가 아닙니다.

- 합성 비밀번호로 Vault Root Key를 생성·래핑하고 다시 잠금 해제
- 타입이 고정된 `CredentialItemV1`과 세 가지 합성 관계 fixture
- 추가 등록용 닫힌 API Key 프로필 2종과 Password 프로필 1종. API는 credential `0`과 연결 0~3개, Password는 credential `1|2`와 빈 연결 목록만 허용하며 core→WASM→Worker→session→UI로 저장합니다. 기존 암호문을 보존하는 archive와 catalog의 계정/workspace/project/환경 private local-only 표시·검색을 유지합니다.
- 합성 연결 편집 내부 API: 같은 record의 successor와 v3 불변 선형 이력/명시적 head, 표시 당시 bytes+generation을 결합한 CAS·재인증. 웹 저장소는 CAS loser와 CAS 직후 readback 경합 후보를 최대 8개의 암호문 conflict outbox에 원자적으로 보존한다. 후보 전체 인증 뒤 위치 기반 읽기 전용 검토와 exact-byte 2단계 폐기를 제공하고, 미해결 후보가 있으면 합성 backup export를 차단한다. 자동 병합·승격과 outbox 포함 백업 형식은 없다. [편집 검증](verification/2026-09-15-synthetic-connection-edit.md), [outbox 검증](verification/2026-09-16-synthetic-conflict-outbox.md), [검토 UI](verification/2026-09-16-synthetic-conflict-review-ui.md), [백업 guard](verification/2026-09-16-synthetic-backup-conflict-guard.md)를 따른다.
- 합성 레코드를 로컬에서 seal/open하고 authenticated restore
- 세션을 버린 뒤 다시 잠금 해제해 동일한 관계를 복구
- canonical CBOR만 허용하는 엄격한 payload 및 envelope 코덱
- 비밀번호 오류, epoch·문맥 교체, 암호문 변조, 미래 버전과 비정상 인코딩 처리
- 의미 있는 평문 metadata를 두지 않는 SQLite schema와 bounded read-only preflight
- immutable revision, expected-head CAS, stale candidate의 암호문 충돌 보존
- 올바른 합성 비밀번호 인증 후 같은 process lock을 유지하는 writable 승격과 current-head 복원
- 완료된 합성 회전 event를 해당 immutable revision에 남기고, 실제 post-cutover 세대·세대별 timestamp·모든 non-removed 연결 상태까지 다시 확인한 successor에서만 새 payload의 event를 비우는 lifecycle. metadata만 조작한 `0001`, 비정상 optional 연결과 legacy incomplete event는 읽을 수 있지만 mutation과 RNG 전에 거부합니다. 닫힌 합성 값 `0001→0002→0003`의 반복 회전과 중간 일반·연결 편집을 지원합니다.
- caller가 제공한 head와 ancestor를 최대 512 revisions/8 MiB로 제한하고 모두 인증·연결한 뒤, root와 각 revision의 `0001→0002→0003` 연속성까지 확인하여 회전 event의 opaque revision/parent, bounded counts, completion/revocation-source enum만 최신순으로 반환하는 합성 history projection. Secret·메모·임의 표시 문자열은 반환하지 않습니다.
- Archive v4 안에서 합성 회전 진행을 canonical head와 분리해 암호화 저장·잠금·재개·최종 확정하고, 신규 저장 시 ready/final cutover에 필요한 revision·ciphertext 공간을 미리 예약합니다. 이는 금고 내부 512 revisions/512 KiB 예산이며 실제 디스크·IndexedDB quota나 과거 이미 가득 찬 금고를 보장하지 않습니다.
- private command layer는 API Key와 Password 초기 item을 공통 builder로 만들고, item name/notes/tags/updated time만 바꾸는 metadata successor를 제공합니다. 기존 닫힌 합성 API Key 등록과 공개 Rust의 닫힌 Password 예제 팩토리가 같은 builder를 재사용합니다. Password 팩토리 입력은 빌드에 포함된 고정 enum 2개뿐이며, 웹·Worker·JS/WASM에는 그 enum을 고르는 닫힌 숫자 tuple만 연결됩니다. 임의 문자열·free-text·실제 Secret 입력은 연결되지 않았습니다.
- 일반 credential 이력 검사는 caller가 제공한 head와 모든 조상의 same-record/parent/constant credential type을 인증하고 최대 512 revisions/8 MiB를 제한합니다. 이는 Secret reveal, 회전 권한, 최신 이력 또는 합성 출처 증명이 아닙니다. archive는 별도로 Password의 정확한 내장 sensitive 값·필드 정책과 connection/rotation 부재를 모든 허용 revision에서 검사합니다. Password의 v1/v2 읽기는 genesis만, v3/v4는 full ancestry만 허용하며 API와 같은 금고에 함께 보관할 수 있습니다. v4 API의 완전한 회전 이력 검사는 유지되고 Password에는 connection edit/rotation/staging capability가 없습니다. 실제 비밀번호 지원 완료가 아니라 닫힌 합성 통합 기반입니다.
- 닫힌 Password 등록 화면은 credential kind 변경 시 연결·동의를 초기화하고 stale handler·검토 후 변경·중복 submit을 차단합니다. Password catalog row와 original reference는 유지하지만 API 전용 action은 제외합니다. 실제 WASM + fake IndexedDB에서 저장·재열기·백업/복원 및 기존 API rotation stage와의 공존을 검사했습니다.
- 닫힌 합성 등록 session은 현재 표시된 authenticated snapshot에 의도를 결합하고 후보 전체를 저장 전에 인증한 뒤 conflict-preserving CAS를 한 번만 수행합니다. CAS loser와 CAS 직후 displacement 후보를 exact ciphertext로 outbox에 보존하고 authoritative readback의 byte equality와 재인증 뒤에만 성공을 게시합니다. 자동 retry·rebase·merge·overwrite는 없으며 [등록 충돌 보존 검증](verification/2026-09-18-registration-conflict-preservation.md)을 따릅니다.
- wrong password 무쓰기, future version 원문 보존, current 손상의 store-wide 읽기 전용 보존
- DB/WAL 계열 합성 marker scan, process-crash transaction 원자성, secret-bearing API compile-fail 경계

**실제 비밀번호, API 키, Secret, 복구 코드 또는 사용자 데이터를 입력하거나 가져오는 것은 금지합니다.**

웹 데모에는 합성 목록·로컬 검색·자동 잠금·합성 백업/복원 화면이 있습니다. [현재 통합 증거](verification/2026-09-15-backup-session-integration.md)는 실제 브라우저 복원을 포함하지만, 디스크 다운로드/네이티브 파일 선택 왕복은 미검증입니다. 이 데모는 아래의 제품 MVP 완료를 의미하지 않습니다.

후속 [원자 백업 snapshot](verification/2026-09-17-atomic-backup-snapshot.md)은 같은 transaction에서 archive와 conflicts를 읽고, 인증 후 다시 읽은 바이트가 같을 때만 시점 백업을 반환합니다. 로컬 단위 검사와 원격 run `35112935398`의 Secret/Rust/WASM/web gate가 통과했습니다. outbox 포함 백업이나 다운로드 이후 최신성·전체 rollback 탐지를 보장하지 않습니다.

후속 [합성 회전 lifecycle/history](verification/2026-09-17-synthetic-rotation-lifecycle-history.md)는 과거 회전 event를 immutable ciphertext에 유지하면서 완료된 event 뒤의 일반·연결 편집과 두 번째 합성 회전을 허용하고, 제공된 체인 전체와 세대 연속성을 인증해 공개 가능한 event metadata만 조회합니다. 관련 코어 38 tests, SQLite 집중 1 test, format/Clippy/Secret scan과 최종 독립 리뷰(Critical 0/Important 0), 기준 커밋 `8ef81d9`의 원격 run `35119009675` attempt 2가 통과했습니다. 이 history API 자체는 supplied head가 실제 최신 head라는 증명, rollback/누락 anchor 또는 provider 갱신·폐기 확인이 아닙니다. durable intermediate checklist와 웹 저장·재개는 아래 v4 후속에서 별도로 구현했습니다.

후속 durable rotation v4와 완료 공간 예약은 합성 중간 진행의 저장·재개·확정을 웹까지 연결하고 신규 저장의 완료 가능 공간을 보호합니다. capacity 기준 커밋 `0ec551a`의 원격 run `35287783960`은 head SHA 일치와 전체 성공을 확인했습니다. 실제 provider 회전, canonical latest-head/rollback anchor, 실제 모바일·복구·동기화 증거는 아닙니다.

후속 [private credential command](verification/2026-09-18-private-credential-commands.md)는 등록 item의 민감 필드와 ID를 Rust 내부에서 구성하고, 인증된 predecessor의 Secret/type/provider/connections/lifecycle을 보존하는 metadata allowlist를 둡니다. 집중 회귀에 이어 코어 전체 106 tests, workspace compile-fail 11개, 웹 1,360 tests, 새 WASM smoke·Clippy·build·Secret scan과 독립 읽기 리뷰(Critical 0/Important 0)가 통과했습니다. 새 exact SHA 원격 CI는 별도 확인 대상이며 이 내부 경계는 임의 API Key/Password를 제품에 입력하거나 읽고 복사할 수 있다는 뜻이 아닙니다.

현재 [혼합 credential archive](verification/2026-09-18-mixed-credential-archive.md)는 generic full-chain constant-type integrity와 Password exact closed-fixture admission을 archive 읽기 경계에 결합하고, API의 v4 전체 회전 ancestry를 그대로 유지하면서 Password의 connection edit/rotation/staging을 거부합니다. 코어 집중 10+7 tests, core 전체 release 123 tests(19.71초), core Clippy, native WASM archive 69 tests(44.52초)와 독립 소스 리뷰(Critical 0/Important 0)가 통과했습니다. WASM package Clippy와 현재 mixed 변경의 exact-SHA 원격 CI는 아직 미확정이며, 직전 `238f8b8`의 진행 중 CI는 이 변경의 증거가 아닙니다.

현재 [닫힌 Password 등록](verification/2026-09-18-password-registration.md)은 고정 tagged tuple을 코어부터 UI까지 전달하고 Password catalog/reference 보존, API action 제외, 실제 WASM+fake IndexedDB 저장·재열기·백업/복원과 혼합 API stage 보존을 검사합니다. 웹 전체 46 files/1,438 tests, core release 126 tests(28.88초), native WASM 73 tests, focused archive 13+registration 7 tests, 새 default/demo generated-WASM 40/1,735 checks, typecheck/build와 독립 리뷰(Critical 0/Important 0)가 통과했습니다. 실제 격리 브라우저는 제어 도구 연결 실패로 미검증이며 통합 테스트를 브라우저 증거로 대신하지 않습니다. mixed 기준 `21bca74`의 원격 CI도 현재 미커밋 등록 변경의 증거가 아닙니다.

후속 [등록 충돌 보존](verification/2026-09-18-registration-conflict-preservation.md)은 candidate 저장 전 전체 인증, 원자적 winner/loser 결정, loser와 post-CAS displacement exact-ciphertext outbox 보존, authoritative reread·재인증을 등록 경로에 적용했습니다. 집중 3 files/109 tests, 웹 전체 46 files/1,449 tests, typecheck/build와 Secret scan이 통과했고 독립 읽기 리뷰는 Critical 0/Important 0입니다. 실제 브라우저 멀티탭과 exact-SHA 원격 CI는 별도 미검증입니다.

[합성 등록 저장 경로 증거](verification/2026-09-15-synthetic-registration-storage.md)는 v1/v2 백업과 실제 WASM/Node 세션 재열기를 포함합니다. 후속 [등록 화면·issuer 검색 증거](verification/2026-09-15-synthetic-registration-ui.md)는 선택형 폼, 실제 Comet의 0/1/3 연결 등록과 순서 보존, 검색·잠금·재열기·새로고침·탭 전환 검사를 포함합니다. 임의 자격 증명 등록이나 실제 모바일 검증은 아닙니다.

실제 자격 증명 입력·가져오기, 자유 입력 Password 웹 등록, 제품용 검색, optional 연결의 실제 provider 확인을 포함한 키 회전 workflow, recovery Key Slot, 기기 폐기·철회, 동기화/checkpoint, Android 통합/UI, 지원되는 실제 데이터용 backup/export, 결제, 스토어 출시, plugin/MCP 실행과 실제 Secret 지원은 아직 구현되지 않았습니다. 현재 CAS와 합성 history는 정상 API의 stale writer 및 caller가 제공한 체인을 다룰 뿐, 유효한 과거 DB/WAL 전체 복원·canonical latest head rollback·완전한 row 누락을 탐지하지 못합니다. 등록의 candidate 사전 인증과 conflict outbox 보존은 구현했지만 실제 브라우저 멀티탭 증거는 별도입니다. 닫힌 Password fixture가 archive와 UI에 존재할 수 있다는 것은 사용자 비밀번호 입력·복사·회전 지원을 의미하지 않습니다.

실제 Secret gate는 rollback/누락 anchor, recovery Key Slot, hardware-backed 기기 키·생체 인증 흐름, Android 통합, sync/checkpoint, 독립 암호 검토, 침투 테스트와 backup/export 복구 훈련이 모두 끝날 때까지 닫혀 있습니다.

GitHub는 소스 코드와 설계의 백업 장소일 뿐 사용자 금고 데이터의 백업 장소가 아닙니다. 현재 코어에는 실제 자격 증명을 입력하면 안 됩니다.

## 첫 번째 사용 가능 버전의 제품 목표 — 현재 미구현

- 서비스 → 계정 → 조직/워크스페이스/프로젝트 → 환경 → Secret/MCP 계층
- 비밀번호, API 키, Secret, MCP 연결 정보, 2FA 복구 코드 저장
- 한 자격 증명에 여러 앱·플러그인·MCP 서버·배포 환경 연결
- 회전 시 사용자가 기록한 연결처 전체의 갱신 체크리스트
- 서비스 템플릿과 사용자 정의 필드
- 수동 입력. 클라이언트 내부 로컬 가져오기는 수동 흐름과 안전 경계를 검증한 뒤의 후속 범위
- 잠금 해제 후 로컬 검색, 보기, 복사
- Android 오프라인 열람과 기기 생체 인증
- 암호화 백업과 강한 재인증 후 로컬 평문 내보내기
- 90일 암호화 이력·휴지통
- 만료·회전 알림의 기기 로컬 처리

## 이번 범위에서 제외

- 브라우저/앱 자동 입력
- 결제 카드, 신분증, 일반 파일 보관
- 팀 금고와 사용자 간 Secret 공유
- TOTP 코드 생성
- AI가 Secret 원문을 읽는 기능
- 서버 측 검색과 분석
- 광고·분석 SDK·채팅 위젯
- 공개 블로그나 애드센스와 같은 origin/runtime 공유
- 브라우저의 배경 DOM·클립보드 감시와 모든 사이트 자동 캡처
- 모든 외부 서비스 계정과 API 키 사용처를 자동 발견했다는 주장

## 제품 MVP 완료 기준 — 현재 미달성

합성 데이터만으로 Android와 웹에서 금고 생성, 자격 증명과 연결처의 수동 등록, 관계 지도 검색, 회전 체크리스트, 저장, 잠금, 재잠금 해제, 복사, 오프라인 열람, 동기화, 충돌 보존, 백업·복구를 재현하고 위협 모델의 보안 불변조건을 자동 테스트해야 합니다.
