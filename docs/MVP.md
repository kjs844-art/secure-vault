# Personal Vault MVP

## 목표 사용자

OpenAI, Claude, Manus, Grok, Meta, Supabase 등 여러 개발·AI 서비스를 사용하는 개인 사용자입니다.

사용자는 어느 Console에서 어떤 API 키·Secret을 발급했고, 어느 앱·플러그인·MCP 서버·프로젝트·환경에 연결했는지를 잊지 않고 관리하려고 합니다. Secure Vault는 단순 목록이 아니라 자격 증명의 출처와 사용처를 연결하는 로컬 관계 지도를 제공합니다.

## 현재 구현 상태

현재 구현된 범위는 합성 데이터 전용 `v0alpha1` 로컬 암호화 코어, 암호문 SQLite 영속 저장 slice, 별도의 웹 Worker/WASM·IndexedDB 합성 데모입니다. 이것은 사용할 수 있는 비밀번호 관리자가 아닙니다.

- 합성 비밀번호로 Vault Root Key를 생성·래핑하고 다시 잠금 해제
- 타입이 고정된 `CredentialItemV1`과 세 가지 합성 관계 fixture
- 합성 레코드를 로컬에서 seal/open하고 authenticated restore
- 세션을 버린 뒤 다시 잠금 해제해 동일한 관계를 복구
- canonical CBOR만 허용하는 엄격한 payload 및 envelope 코덱
- 비밀번호 오류, epoch·문맥 교체, 암호문 변조, 미래 버전과 비정상 인코딩 처리
- 의미 있는 평문 metadata를 두지 않는 SQLite schema와 bounded read-only preflight
- immutable revision, expected-head CAS, stale candidate의 암호문 충돌 보존
- 올바른 합성 비밀번호 인증 후 같은 process lock을 유지하는 writable 승격과 current-head 복원
- wrong password 무쓰기, future version 원문 보존, current 손상의 store-wide 읽기 전용 보존
- DB/WAL 계열 합성 marker scan, process-crash transaction 원자성, secret-bearing API compile-fail 경계

**실제 비밀번호, API 키, Secret, 복구 코드 또는 사용자 데이터를 입력하거나 가져오는 것은 금지합니다.**

웹 데모에는 합성 목록·로컬 검색·자동 잠금·합성 백업/복원 화면이 있습니다. [현재 통합 증거](verification/2026-09-15-backup-session-integration.md)는 실제 브라우저 복원을 포함하지만, 디스크 다운로드/네이티브 파일 선택 왕복은 미검증입니다. 이 데모는 아래의 제품 MVP 완료를 의미하지 않습니다.

실제 자격 증명 입력·가져오기, 제품용 검색, 키 회전 workflow, recovery Key Slot, 기기 폐기·철회, 동기화/checkpoint, Android 통합/UI, 지원되는 실제 데이터용 backup/export, 결제, 스토어 출시, plugin/MCP 실행과 실제 Secret 지원은 아직 구현되지 않았습니다. 현재 CAS는 정상 API의 stale writer를 다룰 뿐, 유효한 과거 DB/WAL 전체 복원·canonical head rollback·완전한 row 누락을 탐지하지 못합니다.

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
