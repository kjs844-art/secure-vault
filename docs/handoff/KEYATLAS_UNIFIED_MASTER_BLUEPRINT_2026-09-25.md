# KeyAtlas 통합 마스터 청사진 — 제품·기술·보안·배포·협업

> 기준일: 2026-09-25 KST · 제품명: KeyAtlas (working title)
> 저장소: https://github.com/kjs844-art/secure-vault · 이 문서의 작업 브랜치: codex/firstvibe-luna-release-support
> 목적: 흩어진 계획·인계·보안·배포 문서를 **일상적으로는 이 파일 하나로 읽을 수 있게** 통합한 실행 청사진
> 가장 중요한 현재 상태: **REAL_SECRET_GATE=CLOSED. 실제 비밀번호·API 키·Secret·복구 코드를 입력하거나 테스트하지 않는다.**
> 범위: 웹 + Android 셀프서비스 공개 출시. 사람 지원형 Privacy Care, iOS, 브라우저 확장, 외부 AI/MCP 연동은 별도 후속 게이트.

이 문서는 기존 원문을 삭제하거나 전부 문자 그대로 이어 붙인 파일이 아니다. 제품 결정을 내리고
작업을 배정하는 데 필요한 내용을 한곳으로 정규화했다. 원문에는 검증 로그·독립 리뷰·ADR과
과거 시점의 근거가 남아 있으므로, 삭제·이동 전에 참조 관계와 Git 이력을 별도로 검증해야 한다.

## 0. 1분 요약과 판정 규칙

**한 문장 제품 정의:** 사용자가 여러 서비스의 계정·로그인 수단·비밀번호·API 키·MCP 연결처,
동의·외부 구독, 계정 정리 요청을 한곳에서 찾고 관리하는 개인 보안·프라이버시 운영센터.

| 표시 | 뜻 |
|---|---|
| [x] LOCAL/SYNTHETIC | 지정한 합성 데이터·로컬 범위에서 구현 및 근거가 있음. 출시 승인이나 main 병합은 아님 |
| [~] PARTIAL/PROPOSED | 일부 코드 또는 설계·PR 초안은 있으나 선언된 완료 조건은 열려 있음 |
| [ ] NOT DONE | 아직 제품 구현·검증·사용자 승인이 없음 |
| BLOCKED | 외부 상태나 선행 조건 때문에 다음 검증을 완료하지 못함 |
| UNKNOWN | 증거가 없어 성공·실패 원인을 판정할 수 없음 |

**사실의 우선순위:** 실제 저장소·PR 상태와 exact-SHA 검사 결과 → 최신 인계서의 시점 있는
증거 → 이 청사진 → 오래된 체크포인트·가이드·초안. 문서의 [x]는 실제 운영 가능을 뜻하지 않는다.
특히 협업 baseline에 MERGED인 항목은 origin/main 병합과 다르다.

### 2026-09-27 최신 작업판 — 아래 2026-09-26 상태판보다 우선

- [x] 공통 원격 CI의 Windows PowerShell 5.1 실패를 테스트 픽스처 인코딩 문제로 좁혔다.
  유니코드 합성값을 엄격한 BOM 없는 UTF-8로 기록·왕복 확인하도록 테스트 한 파일만 수정했다.
  `codex/firstvibe-ps51-scanner-fixture@b33b18b`는 [Draft PR #14](https://github.com/kjs844-art/secure-vault/pull/14)로
  푸시됐다. 로컬 PS5.1/PS7 스캐너 회귀는 각각 102/102, 저장소 Secret scan은 PASS다.
  GitHub의 #14 Security gates 두 실행도 Windows PowerShell 5.1을 포함해 최종 `SUCCESS`다.
  이 결과는 #14 exact head의 CI이지 다른 PR·baseline·main의 통과가 아니다.
  스캐너 본체와 실제 Secret 허용은 바꾸지 않았다.
- [x] 합성 UI 안내·검색어 입력 한도 변경 8개 파일은
  `codex/firstvibe-synthetic-ui-safety@3fced52`의 [Draft PR #15](https://github.com/kjs844-art/secure-vault/pull/15)로
  분리해 푸시했다. 전체 Web 49파일/1,487개 테스트, typecheck, production build, Secret scan,
  독립 P1/P2 리뷰가 로컬 PASS다. 격리 브라우저에서 합성 금고 열기, 한글 129/128바이트 차단,
  정상 검색 결과 2개, 잠금 후 검색 화면 제거를 확인했다. 사람의 한글 IME·모바일은 미검증이다.
- [ ] #14의 공유 baseline 반영과 #15의 공통 기반 CI 차단 해소는 미완료다.
  물리적 source checkout은 지금 UI 기능 브랜치이며, 협업 baseline Git ref는 여전히 `d9c66661`이다.
  기존 미추적 `AGENTS.md`는 #15에 넣지 않았다. PR·브랜치 생성은 baseline/main 병합이 아니다.
  `REAL_SECRET_GATE=CLOSED`.

### 2026-09-26 기준 짧은 상태판

| 구분 | 현재 판정 |
|---|---|
| 실제로 만져볼 수 있는 것 | 합성 데이터 전용 정적 UI와 React → Worker → Rust/WASM → IndexedDB 로컬 금고 흐름 일부 |
| 로컬 보안 기반 | 합성 Rust 암호화·엄격한 형식, 별도 SQLite 암호문 revision/CAS/충돌 보존 기반 |
| 제품 기능 | Identity 관계 코어 일부. 실제 계정 자동 조회, 운영 로그인, 복구, 서버 동기화, Android, 결제, Consent/Cleanup 실기능은 없음 |
| GitHub | 2026-09-25 읽기 전용 재조회에서 PR #7~#13 모두 open/Draft·미병합. 각 head의 Security gates는 completed/failure |
| 검증 | 2026-09-25 디스크 오류 112 뒤, 2026-09-26 동일 source SHA `d9c66661`의 합성 Rust/WASM/Web 로컬 회귀 PASS. PS7/PS5.1 스캐너 회귀도 각각 102/102 PASS. 격리 Chrome에서 동시 복원 경쟁은 한 탭 성공·한 탭 보존 거부로 확인. 별도 feature branch의 fake IndexedDB 경합 회귀 180/180, 전체 Web 1,468/1,468, typecheck/build PASS(아래 범위 참고). 실제 디스크 파일 왕복·네이티브 파일 선택은 미검증. 원격 CI·실제 Secret 허용은 별도. 로컬 exact-workflow 환경도 불일치: Node 24.19.0(워크플로 24.8.0), Pester 3.4.0만 있음(5.7.1 없음), wasm32 target 미설치. 설치/과금 CI 재실행은 하지 않음. Actions 예산 `$0`·`Stop usage=Yes`가 유력한 원인이나 결제 오류 가능성도 job 주석상 완전히 배제할 수 없음 |
| 공개 사용 | 배포되지 않았고 실제 Secret 입력 금지. 외부 독립 감사·법률·운영 게이트가 남음 |

**Rust 검증 보충(2026-09-26 최신 집중 실행):** `vault-local-store-sqlite`는 실행된 테스트 89개가
통과했지만 `lock_and_flags` test binary가 OS error 4551로 차단되어 package 전체는 미검증이다.
`vault-crypto`는 실행된 30개가 통과했고 4개 test target이 같은 이유로 막혔다. 두 crate의
package 전체는 미검증이다. 반면 `vault-local-core` 137/137, `vault-client-bridge` 13/13,
`vault-client-wasm --features synthetic-demo` 73/73은 통과했다. 네 핵심 crate에 대한 targeted
다섯 core crate의 targeted Clippy도 `-D warnings`로 통과했다. 별도의 Windows preexisting writable mapping feasibility gate
1/1도 통과했지만 SQLite store integration은 아니다. 이는 차단된 runtime tests·WASM target build를
대신하지 않는다.
상세 결과는 §21 참고.

**이번 통합 문서 작업 자체:** [x] 로컬 청사진 작성 및 구식/최신 문서의 충돌 정규화.
[x] 읽기 전용 독립 내용 검토·문서 중복 감사·Markdown/링크 검사. [ ] commit, [ ] push, [ ] PR,
[ ] main 병합, [ ] 원본 문서 물리적 감축.
위 체크는 각각 별도 행위이며 서로 자동으로 따라오지 않는다.

## 1. 제품을 이루는 네 축

~~~text
KeyAtlas
├─ ① Secure Vault
│    서비스 계정·비밀번호·API 키·Secret·복구 코드·보안 메모를 클라이언트에서 암호화
├─ ② Identity & Connection Map
│    로그인 수단 → 서비스/계정 → 조직/프로젝트/환경 → 키 → 연결된 앱·MCP·CLI·CI
├─ ③ Consent Center
│    마케팅/제3자 제공/OAuth 권한/외부 구독/약관 동의의 출처·상태·확인일
└─ ④ Privacy Cleanup Center
     수신 거부·권한 해제·키 폐기·탈퇴·삭제 요청을 사용자 승인과 증거로 추적
~~~

| 축 | 사용자가 얻는 것 | 지금 있는 것 | 남은 핵심 |
|---|---|---|---|
| Secure Vault | 키 원문을 필요할 때 안전하게 보기·복사, 발급처와 사용처 찾기 | 합성 로컬 암호화·검색·등록·편집·백업 연습 일부 | 실제 Secret 입력/재인증/reveal/copy, 복구, 플랫폼별 보안 승인 |
| Identity Map | Google/Kakao/Naver/이메일 등 어떤 방식으로 어디에 가입했는지 기록 | 서비스→계정→Credential→Connection 합성 도메인 코어 | 사용자 화면, 증거 기반 발견, 수동 정정, 최소권한 importer |
| Consent Center | 무심코 동의한 마케팅/OAuth/외부 구독 파악 | 요구와 작업 계약 초안 | 모델·화면·공식 경로별 철회 보조 |
| Privacy Cleanup | 탈퇴·삭제·검색 제외 등 요청과 결과 추적 | PRD 초안 Draft PR #11 | 로컬 암호화 사건 기록·승인 상태기계·공식 연동·법률 경계 |

**범위의 경계:** Google/Naver/Kakao 로그인만으로 인터넷의 모든 가입 사이트를 전수 조회할
수는 없다. 계정 발견은 사용자가 가진 메일·내보내기 파일·브라우저/비밀번호 관리자 기록·
공식 제공자 화면/API를 최소권한으로 이용해 **확인됨 / 후보 / 확인 필요**로 표시하는 목표다.
탈퇴·삭제·동의 철회·키 폐기는 사용자 최종 승인 없이 자동 실행하지 않는다.
운영자에게 금고 평문 복구 백도어를 두지 않는다.

## 2. 사용자가 겪을 핵심 흐름

| 흐름 | 목표 UX | 경계·현재 단계 |
|---|---|---|
| 서비스 등록 | OpenAI 같은 서비스, 로그인 수단, 계정, 프로젝트·환경을 기록 | 현재 합성 선택형 등록만. 실제 개인정보·키 입력 금지 |
| 키와 연결처 관리 | 키 발급처·용도·만료·상태·사용 중인 앱/MCP/CI를 함께 보고 교체 영향 확인 | 합성 관계 표시/편집 일부. 실제 제공자 자동조회·회전 없음 |
| 안전한 원문 보기 | 금고 잠금 해제 후 필요한 항목만 재인증하여 잠깐 표시·복사 | 미구현. 현재 고정 데모 비밀번호는 사용자 인증 아님 |
| 가입 흔적 찾기 | 수동 기록과 공식 증거를 가져와 후보·출처·확인일·신뢰도를 구분 | 미구현. 임의의 개인정보 입력만으로 전수 조회 약속 금지 |
| 동의·정리 | 외부 구독/마케팅/OAuth 동의를 확인하고 요청서·공식 링크·접수증을 보관 | PRD 초안만. 실제 철회/탈퇴/삭제 자동 제출 없음 |
| 분실·복구 | 마스터 비밀번호 외 독립 수단을 등록·연습하고 분실 기기를 폐기 | 설계 중심. 수단을 모두 잃으면 운영자도 복구 불가 |
| 요금제 | 무료로 시작하고 사용량·추가 편의 기능을 나중에 유료화 | 가격·한도 가설만. 필수 보안·복구 기능을 유료 장벽으로 두지 않음 |

### 복구 설계의 사용자 선택

설계 문서는 **마스터 비밀번호 + 오프라인 복구 키**를 기본 보호 수단으로 두고, 실제 Secret
사용 전 hardware-backed 신뢰 기기·지원 물리 보안키·복구 보호자 중 고보증 경로를 더해
기본 3개, 사용자가 원하면 최대 5개 경로를 권장한다. 신뢰 기기는 하나 또는 여러 개일 수 있다.
하지만 이 정책은 제품 화면과 복구 훈련으로 아직 확정·구현되지 않았다. 로그인용 passkey가
Root Key 복호화에 참여하지 않으면 금고 복구 수단으로 계산하지 않는다.

## 3. 시스템 도면: 현재와 목표를 분리

~~~text
현재: 로컬·합성 데이터만
┌─────────────────────────────────────────────────────────────┐
│ React 화면 → 세션/Worker → Rust/WASM → IndexedDB 암호문       │
│                 별도 Rust 코어 → SQLite 암호문                 │
└─────────────────────────────────────────────────────────────┘
         운영 사용자 계정·동기화·결제·Android와는 아직 분리됨

목표: 공개 서비스에서 각각 검증해야 할 경계
                      ┌─ www: 소개·가격·문서·블로그
사용자 ────────────────┤
                      ├─ vault Web: React → 전용 Worker → Rust/WASM
                      │             └─ 로컬 암호문·기기별 키
                      └─ Android: Kotlin/Compose → Rust Native
                                    └─ Keystore·BiometricPrompt·로컬 암호문

Web/Android의 서명된 불투명 revision·암호화 checkpoint
            → api: Spring Boot 인증·기기 roster·동기화·entitlement
            → PostgreSQL: 암호문과 제한 운영 메타데이터

별도: Google OIDC/passkey 로그인 → 서비스 계정 인증
별도: 마스터 비밀번호/승인된 복구 수단 → 클라이언트 금고 잠금 해제
별도: 결제·이메일·운영 모니터링·고객 지원 → 비밀 원문 접근 금지
~~~

| 신뢰 경계 | 규칙 |
|---|---|
| 금고 클라이언트 | 평문과 의미 있는 개인 메타데이터는 잠금 해제된 신뢰 클라이언트에서만 처리 |
| 서버 | 암호문·서명 상태·최소 운영 메타데이터만. 서버 로그인 토큰으로 Vault Root Key 생성 금지 |
| 서버가 여전히 알 수 있는 것 | IP, 요청 시각, 사용자 에이전트, 암호문 크기·불투명 슬롯 수·수정 빈도 같은 운영 흔적은 0이 아님 |
| vault origin | 광고·세션 재생·임의 제3자 JavaScript 금지. 소개용 www와 origin 분리 |
| AI/MCP | 키 원문 읽기·복사·자동 주입은 기본 불허. 검색 등 좁은 로컬 동작도 별도 계약·재검토 필요 |
| 외부 제공자 | 공식 API/화면과 사용자 승인만. 스크래핑·계정 전수조회·파괴적 자동화는 기본 범위 밖 |

목표 암호 설계는 CSPRNG Root Key, 마스터 비밀번호에서 Argon2id로 얻은 보호 키의 Key Slot,
항목별 DEK/AEAD, 의미 있는 메타데이터 암호화, 서명 revision과 rollback/누락 탐지용 checkpoint다.
이는 **설계 목표**이며 운영 전체 구현이 아니다. 특히 현재 SQLite 경로는 정상적인 과거
DB/WAL 복원, 최신 head rollback, 전체 row/revision 누락을 권위 있게 탐지하지 못한다.

### 개념 데이터 지도 — 운영 schema 확정 전

~~~text
Service
  └─ Account(login method, evidence)
      └─ Workspace/Project/Environment
          └─ Credential(password/API token/secret/other)
              └─ Connection(app/MCP/CLI/CI/server; purpose; lifecycle)

ConsentGrant ── Evidence(source, observed_at, confidence)
Subscription(external provider) ── ConsentGrant
CleanupCase ── Action ── Evidence ── Outcome/Verification
DeviceRoster ── KeySlot/KeyEpoch/Revocation
~~~

KeyAtlas 자체 Free/Pro 결제와 **사용자가 다른 사이트에 가입한 외부 구독**은 다른 데이터다.
증거는 출처·확인 시각·원본 보유 위치·신뢰도를 구분하고, 확인되지 않은 결과를 사실로 승격하지 않는다.
메일 본문·스크린샷·URL·계정 힌트가 비밀정보를 담을 수 있으므로 AI payload나 로그로
무심코 보내지 않는다. 실제 DB schema·보관 기간·삭제 정책은 미확정이다.

## 4. RED 우선 위협 지도와 BLUE 대응선

아래는 **공격 성공 보고서가 아니라** 출시 전 반드시 검증할 가설·설계 결손이다.
2026-08-29 RED/BLUE 기록은 역사적 참고자료이고 오늘의 통과 증거가 아니다.

| RED 관점: 무엇이 깨질 수 있나 | BLUE 관점: 필요한 방어·증거 | 현재 판정 |
|---|---|---|
| 과거 DB/WAL을 되돌리거나 row를 통째로 빼 최신 키/폐기 상태를 숨김 | 외부 freshness anchor, 서명 checkpoint, omission/fork/rollback fixture | [ ] 설계·구현·독립 검증 필요 |
| SQLite 파일 핸들/WAL/SHM 경로가 다른 파일로 바뀜 | Windows actual-handle/VFS 또는 승인된 broker의 권위 테스트 | [~] 격리된 preexisting writable mapping gate 1개 PASS; WAL/SHM·통합·경합 대체 경로는 미검증 |
| 악성 업데이트·의존성·같은 origin JS가 잠금 해제된 값을 탈취 | 고정 자산, CSP, 공급망 검증, 독립 코드 리뷰, 제3자 JS 금지 | [~] 로컬 검사 일부, 배포 증거 없음 |
| 확장 프로그램·클립보드·화면 캡처·JS 문자열에 원문이 남음 | 단계 상승 인증, 짧은 reveal, 조건부 clipboard 정리, 한계 고지 | [ ] 실제 원문 UX 미구현 |
| 서버/관리자가 동기화 데이터나 로그에서 계정·키 정보를 유추 | 클라이언트 암호화·opaque sync·secret-free 로그/APM·canary 검사 | [ ] 운영 API/로그 없음 |
| 잃어버린 기기가 남은 Key Slot으로 계속 복호화 | device roster/revoke/key epoch, 복구 훈련, 오래된 revision 정책 | [ ] 설계 중심 |
| OAuth 범위를 과도하게 받아 사용자의 메일·외부 계정이 노출 | 공급자별 최소 scope, 후보와 사실 분리, 로컬 우선, 철회 경로 | [ ] 실제 제공자 연동 없음 |
| 탈퇴/삭제/키 폐기를 오탐이나 재시도로 실행 | 대상·영향 미리보기, 재인증, 최종 승인, idempotency, 접수증 | [ ] Privacy 상태기계 미구현 |
| tenant 간 암호문·권한 혼동 또는 재생 공격 | 서버 tenant 격리·replay/rate-limit 테스트·서명 revision | [ ] 서버 없음 |
| 백업은 됐다고 표시하지만 실제 복원에 실패 | 별도 프로필/기기 파일 왕복·기존 값 보존·DR drill | [~] 합성 UI 일부, 완전한 파일·운영 DR 미검증 |

### 실제 Secret 입력 개방 전 12개 게이트

현재 **12개 모두 완료 판정이 아니다.** Android local, Web, Sync는 나중에도 각각 따로 개방한다.

- [ ] exact-SHA CI green, branch protection, 필수 독립 review
- [ ] production 암호 ADR·독립 테스트 벡터·migration 승인
- [ ] 복구 Key Slot·신뢰 기기·기기 폐기·key epoch 구현과 분실 훈련
- [ ] rollback·row omission·fork 탐지
- [ ] 플랫폼별 실제 Secret 입력·표시·복사와 메모리/클립보드 검증
- [ ] 서버 tenant 격리·opaque sync·rate limit·재해 복구
- [ ] 로그·APM·crash·analytics의 secret canary 0
- [ ] SBOM·SCA·artifact signing·provenance·배포 rollback
- [ ] 독립 암호 감사·침투 검증, Critical/High 0 및 재검토
- [ ] 개인정보·약관·내보내기/삭제·사고대응 준비
- [ ] 제한 beta·kill switch·지원·폐기/회전 비상훈련
- [ ] 사용자의 잔여 위험 확인과 플랫폼별 명시적 개방 승인

이 열두 줄은 버튼 하나나 환경변수 하나로 대체할 수 없다. REAL_SECRET_GATE=CLOSED는
현재의 고정 안전 표식이지 구현된 runtime feature flag가 아니다.

## 5. 구현·PR·검증 현황

### 로컬 기반과 미구현을 함께 보지 않기

| 영역 | 상태 | 완료로 주장할 수 있는 범위 / 남은 조건 |
|---|---|---|
| Rust 암호·형식 | [x] 합성 로컬 | 엄격한 codec·비밀 타입 경계. 운영 Root Key·recovery 전체 승인 아님 |
| SQLite 로컬 | [x] 합성 로컬, [~] 운영 경계 | 암호문 revision/CAS/충돌 보존·원자성 기반. actual-handle·freshness·운영 DR 미완 |
| React Web | [x] 일부 합성 화면 | 등록·목록·검색·잠금·연결 편집·합성 백업/복원 일부. 키 회전 workflow 자체는 미구현. 최종 UX·실Secret·다중기기 아님 |
| Identity 도메인 | [x] 관계 코어, [ ] 제품 | 실제 로그인 출처 기록·발견 화면·importer 없음 |
| Consent/Cleanup | [~] 요구·PRD | PRD 초안만. 저장 계약·화면·외부 철회/삭제 없음 |
| 복구·동기화 | [~] ADR·계약 초안 | Key Slot·checkpoint·서버 sync 구현 전 |
| API·PostgreSQL | [ ] | Spring Boot/API와 Android 모듈은 현재 placeholder. 운영 DB/IAM 미구현 |
| 운영 로그인 | [ ] | Google OIDC/passkey는 설계. 금고 잠금 해제와 분리 필요 |
| Android·생체 | [ ] | 공유 Rust 코어만. Kotlin 화면·Keystore·BiometricPrompt/실기기 검증 없음 |
| Free/Pro·결제 | [~] 정책 가설 | 결제 제공자·한도·국가·가격 승인과 SDK·환불·구독 처리 없음 |
| Cloud·법률·운영 | [ ] | 도메인/배포/백업/모니터링/고객지원/개인정보 문서/외부 감사 없음 |

### GitHub의 현재 후보 — 2026-09-25 읽기 전용 확인

| PR | 내용 | 상태·주의 |
|---|---|---|
| [#7](https://github.com/kjs844-art/secure-vault/pull/7) | evidence labels | open/Draft, 미병합 |
| [#8](https://github.com/kjs844-art/secure-vault/pull/8) | provider metadata fail-closed | open/Draft, 미병합 |
| [#9](https://github.com/kjs844-art/secure-vault/pull/9) | release artifact manifest 보완 | open/Draft, 미병합 |
| [#10](https://github.com/kjs844-art/secure-vault/pull/10) | #9 위에 쌓인 CI 연결 | open/Draft, base가 #9 head, 미병합 |
| [#11](https://github.com/kjs844-art/secure-vault/pull/11) | Privacy PRD 초안 | open/Draft, 사용자 내용 승인 전 |
| [#12](https://github.com/kjs844-art/secure-vault/pull/12) | blocked baseline regression 기록 | open/Draft, 완료된 전체 테스트 아님 |
| [#13](https://github.com/kjs844-art/secure-vault/pull/13) | release-support 문서 | open/Draft, 이번 로컬 청사진은 아직 이 PR에 없음 |

위 7개 각 head의 GitHub Actions Security gates는 이번 읽기 전용 조회에서
**completed/failure**였다. 각 job의 annotation은 최근 결제 실패 **또는** Actions
사용 한도 증가 필요를 가리킨다. 예를 들어 [#13 run 36108758056](https://github.com/kjs844-art/secure-vault/actions/runs/36108758056)의
job은 steps가 비어 있어 Secret scan·Rust·Web 테스트가 실행되지 않았다. 두 계정 상태 중
어느 쪽이 원인인지는 이 주석만으로 구분할 수 없고, 코드 실패 증거로도 볼 수 없다.
같은 날 [개인 계정 Budgets and alerts](https://github.com/settings/billing/budgets)의 `Product Actions`
행은 `$0 spent / $0 budget`, `Stop usage=Yes`, `Budget utilization=100%`였다.
따라서 0달러 사용 중단 예산이 **가장 유력한 설정 원인**이다. 포함된 Actions 분은 아직
남아 있었지만 job이 시작되지 않았고, 결제 실패 가능성을 계정 UI만으로 완전히 배제하지는
않는다. 사용자가 과금 위험과 원하는 CI 운영 방식을 결정하고 해당 계정 상태를 해결한 뒤
동일 SHA에서 다시 실행해야 CI PASS 여부를 판단할 수 있다. 이번 작업은 설정 변경·유료
전환·재실행을 하지 않았다.
원격 exact-SHA PASS 증거가 없고, 독립 리뷰·로컬 검사·PR 생성·main 병합·공개 배포는
서로 다른 단계다. 2026-09-25 canonical baseline `d9c66661`의 첫 전체 회귀는 디스크
오류 112로 중단됐지만, 2026-09-26 같은 source SHA의 합성 Rust/WASM/Web 로컬 회귀는
아래 범위에서 PASS했다. 이는 원격 CI·실브라우저·외부 보안 감사 통과가 아니다.

로컬 exact-workflow 도구 확인은 읽기 전용으로만 했다: Node `24.19.0`(workflow pins `24.8.0`),
PowerShell에 Pester `3.4.0`만 있고 required `5.7.1`은 없으며 Rust installed targets에는
`wasm32-unknown-unknown`이 없다. Pester/target 설치나 네트워크 다운로드는 하지 않아 해당
policy test와 release-WASM 생성 단계는 `NOT_RUN`이다.

### 문서 사이에서 정규화한 충돌

1. 긴 배포 체크리스트의 일부 “PR 없음”은 더 늦은 인계서와 2026-09-25 PR 조회로 갱신됐다.
2. Privacy P09~P11 번호는 문서마다 달랐다. **아래 실행 ID는 최신 인계서 체계**를 사용한다.
   가입 메일 탐색은 KA-C06, 탈퇴/삭제는 KA-PRI-P09, 알림은 P10, 법률 경계는 P11이다.
3. 오래된 아키텍처 지도에 “웹 화면 없음”이라고 적힌 부분은 이후 합성 React 구현에
   밀린 역사적 스냅샷이다. 반대로 합성 Web이 있다는 이유로 운영 웹앱 완성을 주장하지 않는다.
4. 일부 README와 계획 문서의 “완료”는 그 파일이 작성된 범위의 완료다. 최신 exact-SHA
   회귀와 플랫폼 출시 허가는 별도로 필요하다.

## 6. 하나의 실행 보드 — 의존성과 완료 증거

번호는 최신 공용 인계서 기준이다. [x]는 선언된 **작은 로컬 목표**가 증명됐다는 뜻이다.
아래 [ ]는 현재 작업을 시작할 수 있더라도 목표 완료가 아니라는 뜻이다.

| 순서 | 상태 | 작업/대표 ID | 완료 증거와 선행 관계 |
|---:|---|---|---|
| 0 | [x] | KA-A01/A02: 통합 체크포인트·협업 baseline | 별도 원격 branch에 기록. main 통합 아님 |
| 1 | [x] LOCAL_PASS만 | KA-BASE-01: canonical 합성 로컬 회귀 | clean canonical `d9c66661`에서 이번 로컬 검사 계약의 Secret scan→Rust/WASM/Web 전 단계 exit 0. 원격 CI·실브라우저·실제 Secret·명시적 ignored 보안 gate는 미완 |
| 2 | [x] 진단만, 재검증 BLOCKED | KA-A05: PR #7~#13 원격 CI 실패 원인 | 시작 전 annotation 및 Actions `$0` 중단 예산 확인. 과금·한도 정책은 사용자 결정, 동일 SHA 재실행 필요 |
| 3 | [~] C30/C58/C93 local evidence only | KA-C30/C58/C93 후보 검토와 KA-A06 통합 | C30/C58/C93 로컬 증거만 추가됨. 독립 리뷰·원격 CI·통합·사용자 main 병합 승인은 미완료 |
| 4 | [~] 브라우저 내 부분 PASS | KA-B04/B05: 실제 브라우저·파일 backup/restore | 격리 Chrome 2탭 복원 경쟁, 다운로드용 Blob/파일명 확인. production preview 경로는 동작하나 `/favicon.ico` 404; 실제 파일 왕복/네이티브 파일 선택, quota·upgrade는 미완 |
| 5 | [ ] HIGH RISK | KA-B06/B07/B08: actual-handle, signed checkpoint, recovery | 공격 fixture·권위 테스트·승인 ADR·분실 훈련 |
| 6 | [ ] | KA-C02~C06: Identity 제품 화면·근거 기반 발견 | 계정·발급처·사용처 탐색, 최소권한·오탐 수정 |
| 7 | [ ] | KA-D01~D04: Consent·외부 구독 | 상태 계약→화면→공식 철회 보조, 사용자 최종 승인 |
| 8 | [ ] | KA-PRI-P01~P06: Privacy 합성 self-service | PRD 승인→계약→암호화 로컬 기록→UI→승인 상태기계→공식 catalog |
| 9 | [ ] | KA-PRI-P07~P10: 제공자별 제한 지원 | 최소 scope·접수/거절/완료 구분·법률/개인정보 조건 |
| 10 | [ ] | KA-F01 이후: opaque sync, Spring API, Postgres, OIDC/passkey | tenant·replay·복구·migration·rate limit·실패 훈련 |
| 11 | [ ] | Android·Keystore·생체·제품 화면 | 공유 Rust 경계·hardware-backed 판정·실기기 재설치/분실 |
| 12 | [ ] | Cloud·도메인·CI/CD·관측·DR·법률·Free/Pro | 환경 분리·서명 artifact·백업 복원·결제/환불·약관 |
| 13 | [ ] | 합성 alpha → 제한 실제 Secret beta → Web/Android 출시 | 12개 gate·독립 감사·명시적 사용자 승인·스토어 심사 |
| 후속 | [ ] | KA-PRI-P11/P12 및 iOS/확장/MCP | 적법한 위임·운영 인력·별도 위협 모델·별도 승인 |

**Privacy 번호 충돌을 피하는 추가 규칙:** 옛 체크리스트의 P09 “메일/import”는
KA-C06/Identity 발견 흐름으로 취급한다. 옛 P10/P11을 현재 P10/P11과 같은 뜻으로
자동 매칭하지 않는다. PRD 승인 전에는 외부 계정에 영향을 주는 P07 이후를 켜지 않는다.

### 개발·베타·출시의 분리된 문

~~~text
로컬 합성 구현
  → exact-SHA 전체 회귀 + 실브라우저/파일 왕복
  → 합성 Private Alpha/Beta (실제 Secret 금지)
  → 복구/동기화/운영·외부 감사 + 사용자 승인
  → 플랫폼별 제한 실제-Secret Beta
  → Web 공개 gate
  → Android 공개 gate + Google Play 심사
  → 사고대응·백업 복구·지원의 상시 운영
~~~

**합성 웹 데모가 보이는 것**과 **사용자가 키를 저장해도 안전한 서비스**는 다르다.
합성 alpha도 테스트 데이터·테스터 안내·별도 URL·rollback 계획이 필요하다.

## 7. 디자인·접근성·수익화·비용

### 화면 설계 원칙

1. 사용자는 “어느 서비스의 어느 계정에 발급된 키인가 / 어디에 연결됐나”를 몇 단계 안에 찾는다.
2. 목록에서는 원문을 기본으로 숨긴다. 세부 보기·복사는 별도의 재인증과 짧은 표시 시간을 갖는다.
3. 검색·분류·연결 관계·교체 영향·만료/미사용 상태를 한 화면 계층에서 이해할 수 있게 한다.
4. 잠김·오류·복구 불가·증거 불확실·외부 요청 거절을 명확히 표시한다. 모션은 줄일 수 있다.
5. 360px 모바일, 키보드·스크린리더, 고대비·상태 색상 독립성, ADHD 친화적인 짧은 단계가 필수다.
6. 브랜드/소개 화면의 효과를 금고 origin의 제3자 코드나 민감 조작 흐름에 가져오지 않는다.

디자인 참고는 권한·라이선스 확인 후 **아이디어만** 사용한다. 공개 소개 화면은
[Framer TrustKey](https://www.framer.com/marketplace/templates/trustkey/)와
[Lusion Devin AI](https://lusion.co/projects/devin_ai/), 금고 정보 구조는
[Figma Horizon UI](https://www.figma.com/community/file/1098131983383434513/horizon-ui-trendiest-open-source-admin-template-dashboard)와
[shadcn sidebar-16](https://ui.shadcn.com/view/new-york-v4/sidebar-16)를 비교할 수 있다.
이는 디자인 결정이나 코드 도입 승인 기록이 아니다.
디자인 결정과 레퍼런스 비교는 사용자가 별도로 진행 중이며, 이 청사진에서 완료로 체크하지 않는다.

### Free/Pro와 사업 원칙

- [ ] 처음부터 유료로 잠그지 않는다. 무료 사용으로 가치와 보안 품질을 검증한다.
- [ ] 유료 한도는 저장 규모·고급 정리·편의 기능 후보이며 **필수 암호화·복구·내보내기·기기 폐기**를 인질로 삼지 않는다.
- [ ] 가격·저장 개수·결제 제공자·사업 주체·환불·세금·국가별 가능 여부는 미결정이다.
- [ ] 외부 서비스 구독 기록과 KeyAtlas 자체 결제 entitlement를 별도 데이터/화면으로 둔다.
- [ ] 광고·분석·스폰서 콘텐츠는 금고 origin에 넣지 않는다. 블로그는 www 영역의 별도 선택 트랙이다.

2026-09-16의 비용 문서는 당시의 **시나리오 예산**이지 현재 견적이 아니다. 지출 의사결정
직전 공식 가격을 다시 확인한다. 무료/저비용 합성 개발에서 시작하더라도 실제 Secret beta에는
백업·PITR·법률·독립 보안 감사·사고 대응 비용을 생략할 수 없다.

| 비용 묶음 | 시점과 사용자 결정 |
|---|---|
| 이름·도메인·운영 이메일·DNS/TLS | 최종 이름/관할/도메인 선택 뒤 구입·설정 |
| Web/API/PostgreSQL·백업·관측 | 제공자/region/IAM/데이터 보존·RPO/RTO 선택 뒤 staging→production |
| Google/Passkey/OAuth·메일 | 제공자 설정·심사·최소권한·이메일 발송 정책 |
| 결제·Google Play | 사업 주체·가격·플랜·세금·스토어 정책 결정 |
| 외부 보안/법률 | 실제 Secret 개방 전 예산과 일정 확보, 중요한 미해결 위험 수정·재검토 |

### 조건부 일정 — 날짜 약속이 아님

| 목표 | 문서의 병렬 작업 가정 | 한 명이 순차 작업 | 주의 |
|---|---:|---:|---|
| 합성 Web + 초기 Privacy 화면 안정화 | 약 3~6주 | 세부 재산정 필요 | 로컬/합성 범위 |
| 로컬 Privacy Cleanup alpha | 그 뒤 추가 약 4~8주 | 세부 재산정 필요 | 외부 계정 작업 아님 |
| 제한 실제-Secret/Privacy beta 후보 | 약 24~40주 + 독립 검토 대기 | 약 42~64주 | 12개 보안 gate 전부 필요 |
| 공개 Web + Android 셀프서비스 | 약 30~52주 이상 + 심사·법률·감사 | 약 50~78주 | 병렬도 약 7~12개월 이상인 조건부 추정 |
| 사람 지원형 Privacy Care | 공개 셀프서비스 이후 추가 3~6개월 이상 | 운영 체계 전 산정 불가 | 법률·위임·운영 인력 별도 |

**예전 “약 6개월”과의 차이:** [이전 공유 가이드](../KEYATLAS_PROJECT_SHARED_GUIDE.md)는
핵심 1명+AI 1~2, 매일 4~6시간이라는 낙관적 가정에서 공개 Web+Android를
`14~24주 이상`으로 적었고, 실측 견적이 아니며 운영·계정·스토어 결정 지연은 별도라고
명시했다. [갱신한 전체 체크리스트](KEYATLAS_ZERO_TO_PUBLIC_SERVICE_CHECKLIST_2026-09-18.md)는
같은 공개 목표도 Privacy 제외 시 `24~40주`, Privacy 핵심 포함 시 `30~52주 이상`으로
재산정했다. 즉 기능 확대 **뿐 아니라** 기존 금고의 복구·운영·보안·심사 게이트를 더
보수적으로 산정한 차이이다. 6개월은 도전적 목표일 수 있지만 출시 약속은 아니다.

여러 AI의 병렬 작업은 문서·합성 UI·일반 테스트를 단축할 수 있지만 암호 설계,
복구/장애 훈련, 독립 감사, 사용자 결정과 스토어·제공자 심사 대기를 없애지 못한다.

## 8. 다른 저장소·AI와의 경계

### benefit-validator와 KeyAtlas

[benefit-validator](https://github.com/kjs844-art/benefit-validator)는 별도 **공개**
Lovable 연결·해커톤 제출 저장소다. 그 저장소의 main으로 KeyAtlas를 병합하지 않는다.
현재의 secure-vault는 **비공개** 금고 개발 저장소이며 이 둘은 자동으로 통합되지 않는다.
나중에 혜택·가입 후보의 출처/확인일/신뢰도를 사용자 선택으로 가져오는 최소 계약은
검토할 수 있지만, 비밀번호·API 키 원문을 Lovable AI·메일 분석·MCP로 전달하지 않는다.
Git submodule이나 저장소 링크만으로 인증·데이터 연동이 완성되지는 않는다.

### 6개, 나중에 7개 이상의 세션을 함께 쓰는 규칙

- 프로젝트 묶음은 대화 기록을 자동으로 합치지 않는다. **이 파일을 제품 진입점**으로 지정한다.
- 각 AI/세션은 정확한 checkout·branch·HEAD·dirty 상태를 먼저 확인하고 한 작업 ID만 소유한다.
- 구현자는 자신이 소유한 파일만 수정한다. 공용 체크박스·상태는 통합 담당 한 명이 근거 확인 후 갱신한다.
- READ_ONLY_REVIEW / LOCAL_DONE / COMMITTED / PUSHED / DRAFT_PR / CI_PASS / MERGED / DEPLOYED를 섞지 않는다.
- 작업 완료 보고에는 변경 파일, exact SHA, 실행한 검사와 exit code, 못 한 검사, 남은 위험을 쓴다.
- main merge·강제 push·실제 Secret beta·공개 배포·유료/외부 프로비저닝은 각각 사용자 승인을 받는다.
- 현재 이 파일은 luna-release-support worktree의 **로컬 신규 파일**이다. 다른 작업이
  이 내용을 보게 하려면 검토 후 commit/push/공유가 필요하다. 파일이 생긴 것만으로 세션 동기화는 안 된다.

## 9. 사용자 결정과 AI가 혼자 할 수 있는 일

| 사용자·외부 승인 필요 | AI가 합성·로컬에서 먼저 할 수 있는 것 |
|---|---|
| 최종 이름·상표·도메인·출시 국가 | 제품 정보 구조·디자인 시안·합성 사용자 흐름 |
| 실제 Secret 입력 개방과 잔여 위험 승인 | 합성 crypto/형식/상태기계/브라우저 회귀 |
| 복구 수단 구성·분실 허용 수준 | Proposed ADR·공격 fixture·복구 훈련 설계 |
| 클라우드·DB·결제·사업자·요금제 선택 | local API/schema skeleton·가격 가설 비교 |
| Google/Kakao/Naver/OAuth 권한·메일 접근 동의 | 수동/합성 importer·증거 상태 모델 |
| 외부 탈퇴·삭제·동의 철회·법률 위임 | 공식 링크 catalog·초안 요청서·승인 UI |
| 외부 보안 감사·법률·Play 심사 | threat model·red/blue 검토 기록·검사 자동화 |

사용자는 실제 키·복구 코드를 채팅, GitHub, 스크린샷, Figma/Canva, 합성 데모에 보내지 않는다.
Daybreak Red 관련 파일은 재지원 **준비 자료**다. 신청·승인·제품 감사 완료의 증거로
간주하지 않으며, 소유/허가된 합성 staging·lab 범위 밖의 보안 테스트를 허가하지 않는다.
Ethereum/블록체인은 학습용 별도 실험 후보이지 금고 보안·복구·수익화의 필수 기반이 아니다.

## 10. 다음 실행 순서와 이번 세션 체크

1. [x] **통합 청사진 로컬 작성:** 제품 네 축, 현재/목표 도면, RED 위험, 12개 gate,
   ID 충돌 정규화, 일정·비용·사용자 결정·PR 현황을 이 파일에 모았다.
2. [x] **청사진 내용·형식 검증:** 원문·현재 PR·독립 리뷰를 대조했고,
   `scripts/check-markdown-links.ps1 -Root docs`가 51개 문서에 대해 exit 0이었다.
   청사진의 trailing whitespace 0, fenced block 균형, `git diff --check` exit 0도 확인했다.
3. [x] **원본 파일 감축 감사:** 같은 worktree의 Markdown 완전 동일 파일 0개와
   참조 관계를 확인했다. 사용자가 기존 문서를 그대로 두기로 결정했으므로 이동·삭제는
   보류한다. 파일 수 감축 완료로 체크하지 않는다.
4. [x] **KA-A05 원격 CI 읽기 전용 진단:** job 시작 전 결제/사용 한도 안내와
   Actions `$0` 중단 예산을 확인했다. [ ] 사용자 과금 정책 결정·계정 상태 해결 후 동일
   SHA CI 재실행·판정.
5. [x] **KA-BASE-01 재개 조건 읽기 전용 확인:** canonical worktree는 clean `d9c66661`이고
   검사 순서는 확인했다. 2026-09-25 여유 약 0.35GiB 때문에 중단했지만, 2026-09-26
    재조회는 약 18.01GiB였다. [x] 동일 SHA의 합성 Rust/WASM/Web 로컬 회귀 PASS.
    [x] PS7/PS5.1 Secret scanner 회귀 102/102. [ ] 원격 CI·전체 실브라우저·실제
    Secret 승인. 이전 실패 기록은 삭제하지 않는다.
6. [ ] 후보 PR별 독립 리뷰·CI 재검증·사용자 승인 후 통합. 현재 어떤 PR도
   이 청사진 작성만으로 Ready for review 또는 main 병합하지 않는다.
7. [ ] P01 사용자 여정·수용 기준 승인 뒤 P02~P06 합성 Privacy 순차 구현.
8. [ ] 이후 복구·checkpoint·opaque sync와 API/Android를 병렬화하고 플랫폼별 gate를 닫는다.
9. [~] **KA-B04/B05 격리 브라우저 부분 검사:** 새 저장공간 복원·재열기·기존 금고 보존,
   같은 origin의 2탭 동시 복원 경쟁, 다운로드 링크의 Blob·파일명 확인. [ ] 실제 디스크 파일 왕복·quota·upgrade.

**이번 턴의 완료 정의:** 통합 파일 1개 생성·읽기 검증·형식 검사·원문 보존.
GitHub 백업이나 출시 준비 완료까지를 뜻하지 않는다.

### 2026-09-26 다음 작업 계약: KA-BASE-01 로컬 재검증

- 작업자: Codex root. 기준 source/worktree:
  `agent-staging/keyatlas-collab-001-100`, branch
  `codex/firstvibe-collab-001-100-baseline`, exact SHA
  `d9c66661db7d7b66f6453e94e467c424107cba66`, tracked clean 확인.
- 허용 범위: 합성 데이터 전용 Secret scan, Rust workspace fmt/Clippy/tests/probe/doctests,
  공간이 허용하면 WASM/Web 검사. 추적 코드·의존성 lockfile·계정/결제 설정은 변경하지 않는다.
  빌드 생성물은 해당 worktree의 ignored 경로에만 쓴다.
- 사전 상태: 2026-09-26 C: 여유 약 18.01GiB, 실행 중인 Cargo/Rustc 0.
  5GiB 미만으로 내려가면 다음 단계를 시작하지 않고 결과를 부분 검증으로 기록한다.
  파일·캐시 삭제, 프로세스 강제 종료, 의존성 설치는 이 계약에 포함되지 않는다.
- 완료 판정: 실행한 각 명령의 exit code와 남은 디스크 공간을 적는다. 전체 Rust/WASM/Web
  단계가 모두 zero exit인 경우에만 KA-BASE-01의 해당 exact-SHA 로컬 회귀를 PASS로 바꾼다.
  로컬 PASS는 원격 CI, PR 통합, 실제 Secret 입력 승인과 별개다.
- [x] preflight·합성 로컬 Rust/WASM/Web 검사 실행 및 결과 기록. [x] 범위에 대한 독립
  읽기 전용 검토. [ ] 원격 CI·실브라우저·독립 보안 gate.

#### 2026-09-26 결과 — 정확한 source SHA의 로컬 검증만

| 검사 | 결과 |
|---|---|
| 사전·사후 저장소 Secret scan | 각 exit 0, `SECRET_SCAN_PASSED`, `REAL_SECRET_GATE=CLOSED`; 허용된 기존 baseline marker 4개 |
| Secret scanner 회귀: PowerShell 7 / Windows PowerShell 5.1 | 각각 `SECRET_SCANNER_TESTS_PASSED=102`, exit 0; 합성 임시 fixture만 사용 |
| Rust fmt 및 workspace Clippy | 각 exit 0; Clippy `--offline --locked --workspace --all-targets --all-features -- -D warnings` |
| Rust workspace default tests | exit 0, `--offline --locked --workspace --tests -- --test-threads=1`; 이전 Windows 오류 112 재현되지 않음 |
| Windows VFS feasibility-probe 일반 테스트·workspace doctests | 해당 workspace run에서는 각 exit 0, 실제 handle gate는 ignored. 이후 §22의 명시적 단일 feasibility gate가 exit 0 |
| 기본/합성 데모 release WASM 빌드 | 각각 exit 0, 버전 확인된 로컬 `wasm-bindgen 0.2.128` 사용 |
| 생성된 WASM 실행 검사 | 기본 40개·합성 데모 1,735개 checks, 각각 exit 0 |
| Web Vitest·타입 검사·빌드 | 46 files / 1,467 tests, typecheck와 Vite build 각각 exit 0 |
| 종료 상태 | canonical Git tracked clean, HEAD `d9c66661db7d7b66f6453e94e467c424107cba66`; C: 여유 약 16.01GiB |

**검증 경계:** 기존 `node_modules`로 Node v24.19.0/npm 11.17.0에서 실행했고 `npm ci`
새 설치나 CI의 고정 Node 24.8.0·원격 Windows runner는 재현하지 않았다. Pester 5.7.1이
설치되어 있지 않아 workflow 정책 검사는 미실행이다. 의도적으로 ignored인 crash-child
entrypoint는 PASS가 아니다. actual-handle은 당시 workspace run에서 ignored였으나 이후 §22의
좁은 preexisting mapping feasibility probe는 PASS했다. 이는 Store integration gate 완료를 뜻하지
않는다. 실제 브라우저의 디스크 파일 왕복,
기기 분실/복구, 실제 비밀번호·API 키 저장도 검사하지 않았다. `KA-BASE-01`의 [x]는
**이 SHA의 합성 로컬 회귀에만** 적용된다.

#### 2026-09-26 KA-B04/B05 격리 Chrome 부분 결과 — 디스크 E2E 아님

- 대상은 canonical clean SHA `d9c66661db7d7b66f6453e94e467c424107cba66`의
  `127.0.0.1:5187` Vite 개발 화면이다. 격리된 Chrome 153 저장공간 2개만 사용했고
  실제 계정·Secret·사용자 일상 브라우저 프로필은 사용하지 않았다.
- 출발 저장공간에서 합성 금고 3개 항목 생성 → 백업 Blob 3,892바이트 준비를 확인했다.
  별도 빈 저장공간에는 브라우저 File API로 **메모리 내** 합성 바이트를 전달해 UI의
  복원 버튼을 눌렀다. 복원 완료 후 명시적으로 다시 열면 3개 항목이 보였고, 재내보내기
  SHA-256은 원본과 같은 `59b5e5d9c61d4fe83414d8d7e654e15ec68b3d679783174d206a7928f2d163e7`였다.
- 이미 금고가 있는 저장공간에 같은 합성 파일을 다시 복원하면 `기존 금고는 그대로 보존`으로
  거부했고, 이후 재내보내기 SHA-256도 변하지 않았다. 다른 탭으로 전환하면 백업 화면의
  확인·준비 링크가 사라지는 자동 잠금도 관찰했다.
- 다운로드 링크 클릭은 UI의 `다운로드를 요청했습니다`까지만 확인했다. 사용자의 표준
  Downloads에는 이번 실행의 새 파일이 확인되지 않았으며, 브라우저 도구의 별도 저장 위치를
  배제할 수 없다. `agent-browser` 격리 시작은 `CDP response channel closed`, 직접 시작한
  headless Chrome도 포트 listener 없이 종료됐다. **앱의 다운로드 결함으로 판정하지 않고**
  실제 디스크 저장·네이티브 파일 선택·새 OS 프로필의 파일 왕복은 `NOT_VERIFIED`로 둔다.
  아래 별도 기록의 같은-origin 동시 복원 경합은 확인했다. 실제 디스크 파일 왕복,
  quota·upgrade와 Edge/모바일 브라우저는 미검증이다.
- DevTools 보존 콘솔/네트워크에는 기능 관련 오류나 외부 요청이 없었다. 출발 화면의
  유일한 404는 로컬 `/favicon.ico` 요청이다. 이번 검사는 개발 서버 환경이며 정식
  production build E2E나 보안 감사가 아니다. `REAL_SECRET_GATE=CLOSED`를 유지한다.

#### 2026-09-26 KA-B04 같은 origin 2탭 복원 경쟁

- 같은 canonical SHA에서 Vite `127.0.0.1:5193`을 실행하고 Chrome 153 격리 저장공간을
  source 1개와 빈 target 1개로 나눴다. target은 같은 격리 context 안의 두 페이지로 구성했고,
  시작 시 각 페이지에서 `indexedDB.databases()`가 빈 배열임을 확인했다.
- source에서 합성 금고 3개 항목의 백업을 준비했다(3,892 bytes, archive SHA-256
  `641d5b144f089189a196014db5a45586746e39b0c6219f43c74bb9e7ff64a550`). 같은 합성 bytes를
  두 target 페이지의 File API/DataTransfer로 각각 전달하고 두 복원 버튼을 병렬로 눌렀다.
- 결과: 한 페이지는 `복원 완료`, 다른 페이지는 `이미 금고가 있어 복원하지 않았습니다`로
  종료했다. 두 페이지가 읽은 IndexedDB archive 모두 3,892 bytes이며 source와 SHA-256이
  일치했다. 승자 페이지에서 명시적으로 다시 열었을 때 합성 항목 3개가 인증됐다.
- 이것은 같은 origin IndexedDB에서 동시 복원 시 하나만 기록되는 UI/browser 회귀 근거다.
  실제 파일 다운로드·OS 파일 선택, quota·upgrade 실패 동작, Edge/모바일은 검증하지 않았다.
  서버는 검사 종료 후 중단했다. `REAL_SECRET_GATE=CLOSED`.

#### 2026-09-26 KA-B04 자동 경합 회귀

- 격리 feature branch `codex/firstvibe-b04-idb-restore-race`에 독립 IndexedDB store 2개가
  같은 fake `IDBFactory`를 공유하며 서로 다른 합성 백업을 동시에 복원하는 테스트를 추가했다.
- 두 검증 단계를 gate로 동시 진입시킨 뒤 저장을 풀어, 성공 1건·`EXISTS` 거부 1건과 두 store의
  동일 winner readback을 확인했다. `npm test -- src/features/local-vault/SyntheticVaultBackup.test.ts`는
  180/180 PASS, 전체 Web `npm test`도 46 files / 1,468 tests PASS. 새 경쟁 테스트 자체도
  `-t 'allows exactly one concurrent restore across independent
  IndexedDB store instances'`로 10회 재실행해 10/10 PASS.
- `npm run typecheck`와 `npm run build`도 exit 0. 별도 worktree에 무시되는 `node_modules`와
  동일 baseline의 생성 WASM을 임시 junction으로 읽게 했고 검증 직후 junction을 제거했다.
  Secret scan도 exit 0 (`SECRET_SCAN_PASSED`). 이 변경은 미커밋·미푸시이며, fake IndexedDB 테스트는
  실제 브라우저·디스크 파일 왕복이나 원격 CI를 대체하지 않는다.

#### 2026-09-26 KA-B05 다운로드 링크 확인 — 실제 파일 저장은 아님

- 격리 Chrome의 새 origin storage에서 합성 금고를 만들고, 백업 화면의 동의→파일 준비 흐름을
  실제 UI로 실행했다. 검증 후 링크 이름은 `keyatlas-synthetic-v1.katldemo`, MIME은
  `application/octet-stream`, Blob은 3,892 bytes였고 합성 archive의 SHA-256은
  `136fea1c5811ee25c73ab317ca8e0efae4929254219c212f44b20a24b351b34c`였다.
- 클릭 이벤트는 브라우저/OS 파일 쓰기 전에 페이지 안에서 가로채 `preventDefault`했다.
  따라서 확인된 것은 파일 링크·Blob payload뿐이며, 다운로드 목록·디스크 파일·새 프로필 복원은
  확인하지 않았다. 실제 파일 왕복은 계속 `NOT_VERIFIED`이고 `REAL_SECRET_GATE=CLOSED`.
- 금고 생성·백업 화면 탐색·파일 준비 뒤 보존된 Chrome 네트워크 기록 174건의 URL은 모두
  `127.0.0.1:5193`이었다. 외부 URL 요청 및 console warning/error는 관찰되지 않았다.
  이는 개발 서버의 이 합성 시나리오에 한정되며 운영 배포·다른 경로의 무통신 보증은 아니다.

#### 2026-09-26 KA-B05 production-preview smoke — favicon issue

- 이미 생성한 Web production bundle을 `vite preview`의 localhost `5194`에서 열어 합성 금고 3개
  항목 확인, 백업 화면 이동, 합성 백업 준비와 다운로드 링크의 Blob 생성까지 실행했다.
  파일 링크는 다시 가로채 디스크 쓰기를 막았다. bytes 3,892; SHA-256
  `ade915ac768e91f30a9b51e9b10d4541e6ee7ecf57945e389d175f9e394835be`.
- JS/CSS/Worker/WASM 요청은 모두 localhost에서 200/304였다. 외부 URL 요청은 없었으나 console에는
  `GET /favicon.ico 404` 한 건이 있었다. `apps/web/index.html`과 `public/`에 favicon이 없어
  브라우저 기본 요청이 실패한다. 이는 백업 로직 실패가 아니며 임의 브랜드 아이콘을 만들지 않고
  미해결 디자인 자산으로 남긴다. 디스크 저장·다운로드 목록·restore는 여전히 미검증.

## 11. 원문 출처와 유지 정책

| 출처 | 지금 이 파일에 흡수한 역할 | 남기는 이유 |
|---|---|---|
| [0→공개 서비스 전체 체크리스트](KEYATLAS_ZERO_TO_PUBLIC_SERVICE_CHECKLIST_2026-09-18.md) | 전체 의존 순서·조건부 일정·12개 gate | 상세 작업/시간·역사적 계획 |
| [범용 AI 인계서·TODO](KEYATLAS_UNIVERSAL_AI_HANDOFF_AND_TODO_2026-09-24.md) | 최신 ID·작업 상태·2026-09-25 PR 스냅샷 | 증거 ledger·세션별 인계·작업 소유권 |
| [MVP](../MVP.md), [보안 아키텍처](../SECURITY_ARCHITECTURE.md), [위협 모델](../THREAT_MODEL.md) | 기능 범위·클라이언트 신뢰 경계·RED 위험 | 상세 불변식과 보안 근거 |
| [출시 준비 게이트](../RELEASE_READINESS_CHECKLIST.md) | alpha/beta/public 단계 구분 | 단계별 승인 항목 |
| 협업 baseline d9c6666의 docs/PRODUCT_BUILD_AND_DEPLOY_GUIDE.md 및 docs/CURRENT_CHECKPOINT_2026-09-19.md | 구현 경로·9월 19일 체크포인트 | 이전 구현 사실·검증 범위. 최신 TODO로 자동 승격 금지 |
| Draft [PR #11](https://github.com/kjs844-art/secure-vault/pull/11)의 docs/product/privacy-cleanup-center-prd.md | Privacy 사용자 여정·증거·승인 경계 | 승인 전 초안과 수용 기준 |
| C:\Users\USER\Documents\ChatGPT\KeyAtlas\KeyAtlas_배포비용_Daybreak_Red_재지원_준비_2026-09-16.md | 비용 항목·Daybreak 준비 | 과거 시나리오 예산·신청 전 자료. 현재 가격 아님 |
| C:\Users\USER\Desktop\PersonalProJect\KeyAtlas\자료\KeyAtlas_보안_설계_패키지_2026-08-29\06_RED_TEAM_중심_작업기록.md 및 07_BLUE_TEAM_방어요약.md | 역사적 공격·방어 가설 | 당시 실험/판정·출처. 현재 통과 증거 아님 |

**정리 원칙:** 이 청사진을 사람과 새 AI의 단일 읽기 시작점으로 사용한다. 이번 감사에서
같은 worktree의 `docs` 아래 Markdown 완전 동일본은 없었다. 즉 파일 수를 실제로 줄이려면
상세 작업판·상태 지도의 **고유 내용까지 이관하고 참조 링크를 고친 뒤** 이전 파일을 삭제해야
한다. 이번에는 읽는 진입점을 1개로 줄였지만, 실제 `docs` Markdown 개수는 신규 청사진
때문에 50개에서 51개로 늘었다. 사용자가 링크·도구 안정성을 위해 기존 파일을 그대로
두기로 했으므로 지금은 이동·삭제하지 않는다. 검증 로그, ADR, 독립 보안 근거, 외부 AI
브랜치 계약도 보존한다. 똑같아 보이는 다른 worktree 파일은 정상적인 Git checkout
복사일 수 있다.

## 12. 2026-09-26 후속 기록 — contributor guide와 정적 호스트 점검

- [x] `codex/firstvibe-b04-idb-restore-race`의 repository root에 385-word `AGENTS.md`를 작성했다.
  모듈 구조, Web/Rust 검증 명령, 스타일·테스트 규칙, PR 및 Secret 입력 경계를 담았다.
  요청된 파일은 미커밋 상태이며 release-support checkout에도 같은 로컬 사본이 있다.
- 현재 상위 집계 경로 `C:\Users\USER\Documents\ChatGPT\KeyAtlas\AGENTS.md`는 별도 373-word
  안내서다. 이는 static preview/docs와 여러 nested checkout을 구분하는 로컬 workspace 가이드이며,
  상위 경로는 commit·remote가 없어 GitHub repo root 안내서나 push 증거가 아니다.
- 상위 workspace의 `pwsh -NoProfile -NonInteractive -File .\scripts\check-markdown-links.ps1 -Root .\docs`
  는 exit 0 (1 Markdown file)이며 `check-markdown-links.Tests.ps1` 회귀 fixture도 exit 0이다.
  fixture의 `missing.md` 오류 출력은 의도한 negative case였고 상위 테스트가 이를 확인했다.
- 로컬 production-preview Lighthouse 결과는 Accessibility 100, Best Practices 100,
  SEO 91, Agentic Browsing 67이었다. 누락된 `/robots.txt`와 `/llms.txt`가 SPA fallback으로
  `index.html`을 200 응답해 SEO/agentic 검사에 영향을 준 것을 확인했다. 기능 브랜치의
  `apps/web/public/robots.txt`에는 공개 색인 승인 전 임시 `Disallow: /`를 두었다.
  이는 출시 설정 전 임시 기본값이며 보안 통제가 아니다. 실제 호스트가 정적 파일을
  올바른 MIME으로 제공하는지, 공개 전환 때 색인을 허용할지는 아직 검증·결정되지 않았다.
- `/llms.txt`는 AI crawler/training 정책이 결정되지 않아 추가하지 않았다. `/favicon.ico`
  404도 로컬 자산에서 관찰됐지만 로고·아이콘은 사용자가 디자인하기로 했으므로 구현하지 않았다.
- [x] feature branch의 빌드 산출물을 baseline 도구로 띄운 로컬 production preview에서도
  `/robots.txt`가 `200 text/plain`으로 정확한 임시 정책을 제공하는 것을 확인했다.
  `/llms.txt`는 `200 text/html` SPA fallback으로 남아 Agentic Browsing 개선은 미완료다.
  이는 localhost 정적 미리보기일 뿐 공개 호스트·CDN 응답 확인은 아니다.
- robots 추가 후 첫 post-build Secret scan은 안전한 `setup_or_execution` 실패로 닫혔다.
  내부 오류가 감춰져 원인은 판정하지 않았다. 임시 의존성 경로가 없는지, worktree에
  reparse point가 없는지 확인한 뒤 동일 scanner를 다시 실행해 baseline 4건 허용,
  `SECRET_SCAN_PASSED`, exit 0을 확인했다. 실제 Secret gate는 계속 `CLOSED`다.
- 별도 release-support worktree 전체를 대상으로 한 scanner 호출은 generic
  `setup_or_execution` 실패(exit 1)로 fail-closed 했다. read-only 확인에서
  `crates/vault-client-wasm/src/archive.rs`가 scanner의 알려진 합성 baseline fingerprint와
  다름을 확인했다. 알려진 synthetic exception을 임의로 갱신하지 않는다. 이 불일치는 실제
  credential 발견 증거는 아니지만 전체 저장소 Secret scan도 PASS가 아니다. 변경된 Markdown이
  있는 `docs/`만 검사한 범위 한정 호출은 `SECRET_SCAN_PASSED`, exit 0이다. 실제 Secret gate는
  닫혀 있다. 이는 현재 화면에 보인 GitHub Actions run의 원인으로 판정하지 않는다. 그 run은
  계정 결제/사용 한도 메시지와 함께 job 자체가 시작되지 않은 상태였고, 여기 결과는 로컬
  cross-worktree 검사다.
- 이번 문단까지 갱신한 뒤 `git diff --check`와 Markdown 상대 링크 검사를 재실행했고,
  두 명령 모두 exit 0 (`51 files checked`)이다.
  B04/B05 및 공개 배포는 실제 파일 저장/복원, 외부 호스트, 사용자 승인 전까지 계속 부분 상태다.
- [ ] `/llms.txt` 응답 정책, 공개 검색 색인, favicon은 사용자 디자인·정책 결정 후 처리한다.
- 2026-09-26 read-only 확인 시 C: 여유 공간은 14.87 GiB였다. 앞선 전체 Rust 회귀가
  Windows disk error 112로 막혔고 충분한 여유가 확인되지 않아 이번에는 전체 workspace
  재실행을 보류했다. 캐시·`target`은 정리하지 않았다.
- 작업 branch: `codex/firstvibe-b04-idb-restore-race`, base `d9c66661db7d7b66f6453e94e467c424107cba66`.
  AGENTS, robots, 경쟁 회귀 테스트는 모두 로컬 미커밋이며 push/PR/merge/배포하지 않았다.

## 13. 2026-09-26 후속 기록 — C30 provider metadata 입력 상한

- [~] C30 후보 `534b37c18582ea120e2d9303cfe73635ad16dcf3`를 기준으로 별도 로컬 clone의
  `codex/firstvibe-c30-provider-metadata-bounds` branch에 한정 구현했다. 기존 C30 branch의
  shared Git metadata 위치 쓰기가 거부되어 원본 worktree를 바꾸지 않고 clone을 사용했다.
- validator는 JSON parse 후 catalog 2,048 entries, ID 64자, hostname 253자, official host 32개,
  credential type 허용 목록 크기, 문서 링크 kind 수, URL 4,096자로 검사를 제한한다. 파서 자체의
  메모리 비용이나 Proxy/getter 입력은 이 보완의 보장 범위에 포함하지 않는다.
- 경계 회귀는 초과 catalog/ID/host/credential/doc-link/URL 및 상한 catalog 통과를 다룬다.
  전체 Web Vitest 47 files / 1,563 tests, `npm run build`의 TypeScript와 Vite 단계,
  `check-repository-secrets.ps1` (허용 baseline 4, `SECRET_SCAN_PASSED`, exit 0),
  `git diff --check`가 모두 로컬 exit 0이다. 임시 `node_modules`·합성 WASM junction은
  대상 경로를 확인한 뒤 제거했다.
- 이 clone의 두 TypeScript 파일은 미커밋이며 GitHub branch/PR/CI가 아니다. 독립 보안 리뷰,
  source repo에의 cherry-pick, C58/C93 통합, 원격 CI, 사용자 main 승인, 실제 Secret 입력은
  아직 수행하지 않았다. 따라서 KA-C30 검토와 KA-A06 통합은 미완료 상태다.
- 후속 독립 읽기 전용 리뷰에서 현재 정적 curated catalog 사용 경로의 P1/P2는 0건이었다. 다만 외부
  catalog/import를 열기 전에는 두 조건을 별도 gate로 닫아야 한다. 첫째, 원본 JSON byte·객체별
  property 수 상한 없이 `Reflect.ownKeys` 배열을 만들므로 한 entry의 대량 키에서 parse 후 검증 비용이
  상한으로 묶이지 않는다. 둘째, `officialHosts`와 문서 URL을 같은 입력 entry가 주장하므로 서로
  일치해도 실제 제공자의 공식 도메인임을 증명하지 못한다. provider ID별 신뢰 도메인을 코드·서명된
  catalog 같은 별도 신뢰 경계에서 고정해야 한다. `linkCheck: PASS`도 HTTP 실행 증거가 아니라 작성자
  주장으로만 표시한다. 이 두 조건이 닫히기 전 외부 metadata 수신에는 사용하지 않는다.

### 2026-09-26 C30 후속 — 검토 목록 경계 보강

- [x] 같은 C30 clone의 기존 두 파일을 보존하면서, 제공자 ID별 호스트와 **정확한 문서 URL**을
  catalog 입력 밖의 코드 상수로 고정했다. 독립 리뷰가 발견한 `github.com` 사용자 경로 우회는
  정확한 URL pin과 회귀로 닫았다. 이름·범주·credential 종류·문서 kind·링크 확인 상태도
  코드 소유 정적 snapshot과 대조해, 호스트만 맞는 변조 항목을 신뢰하지 않는다.
- [x] JSON 호환 객체의 과도한 enumerable field는 `Reflect.ownKeys` 배열 생성 전에 거부하고,
  긴 hostname/credential 문자열은 중복 Set 검사 전에 거부한다. 별도 JSON 진입 함수는
  파싱 전 **64 KiB UTF-8** 상한을 적용하고 검증 후에도 파싱 객체를 돌려주지 않고 고정된
  코드 소유 항목만 반환한다. 이 함수는 아직 UI·네트워크 import에 연결되지 않았다.
- [x] focused Vitest `providerMetadata.test.ts` **106/106 PASS**, 해당 TypeScript 소스의
  strict 단독 typecheck와 repository Secret scan (`SECRET_SCAN_PASSED`, 기존 synthetic baseline 4),
  `git diff --check` exit 0. 별도 clone에 의존성 설치나 junction을 남기지 않았다.
- [x] 독립 읽기 전용 재검토에서 최종 diff의 P1/P2 신규 문제는 발견되지 않았다. 2개 파일만
  커밋 `8f834d1d5f87214d76399e6739856dfab23071b2`로 정리해 기존
  [draft PR #8](https://github.com/kjs844-art/secure-vault/pull/8)의 head branch에 비강제 push했다.
  PR base는 협업 baseline이며 `main` 병합은 아니다. 원격 CI 두 실행은 저장소 Secret scan과
  PowerShell 7 scanner 회귀 102개를 통과한 뒤 Windows PowerShell 5.1 단계의
  `The prefilter must not expand this engine's invariant Unicode regex language`에서 실패했다.
  Rust/Web 단계는 실행되지 않았다. 전체 Web test/typecheck/build는 이 최종 변경에 대해 로컬에서도
  실행하지 않았다.
- [ ] `linkCheck: PASS`는 여전히 사람이 작성한 도달성 주장이다. 외부 목록 수신을 실제로
  열려면 모든 호출부가 이 제한된 parser/curated gate를 통과하는지 별도 검토하고,
  독립 리뷰·exact SHA CI·UI 링크 표시 정책을 완료해야 한다. 실제 Secret gate는 닫혀 있다.

### 2026-09-26 저장 공간 관찰

- C: 여유 공간이 같은 작업 중 약 1.09 GiB, 12.48 GiB, 3.75 GiB, 8.42 GiB 사이에서 크게
  변동했다. 5 GiB 미만 시 production build를 시작하지 않는 안전 기준을 적용했고 실제 시도도
  `BUILD_SKIPPED_LOW_SPACE`로 종료됐다. 이는 코드 빌드 실패가 아니다.
- 읽기 전용 크기 점검에서 원격 데스크톱 진단 ETL 약 5.48 GiB, KeyAtlas Rust `target` 약
  3.32 GiB, 자동 관리 pagefile 약 16.1 GiB를 보았다. ETL의 최근 1시간 증가량은 약
  48 MiB이고 `target`의 최근 수정 시각도 급변과 맞지 않아, 수 분 내 수 GiB 변동의
  원인을 특정하지 못했다. 파일 삭제·프로세스 종료·설정 변경은 하지 않았다.

## 14. 2026-09-26 후속 기록 — C93 release manifest의 로컬 증거

- 검토한 worktree: `agent-staging/keyatlas-c93-ci-01`, branch
  `codex/firstvibe-collab-93-ci-fix-01`, SHA
  `c9a1d638ccc28aae08adae71c77b813654ad2cda`. 현재 로컬 `origin/` tracking ref와
  SHA가 일치했고, 시작/종료 시 worktree는 clean이었다. 이는 live remote 확인이나 병합 증거가 아니다.
- 합성 fixture 전용 `tests/verification/new-release-artifact-manifest.Tests.ps1`는
  PowerShell 7에서 10개 시나리오 모두 통과했다. 전체 worktree Secret scan도 허용 synthetic
  baseline 4개, `SECRET_SCAN_PASSED`, `REAL_SECRET_GATE=CLOSED`, exit 0이었고,
  `git diff --check`도 exit 0이었다.
- manifest 검사는 빌드 파일의 경로·크기·SHA-256 일관성을 확인한다. 그것만으로 Secret 부재,
  서명, 빌드 출처/provenance 또는 게시 권한을 증명하지 않는다.
- `verify-security-workflow.Tests.ps1`는 로컬 Pester 3.4.0으로 실행하지 않았다
  (workflow는 5.7.1을 pin하며 PSGallery 설치는 하지 않음). Windows PowerShell 5.1 로컬
  실행도 정책에 막혀 bypass하지 않았다. 이 branch의 GitHub Actions, 외부 소비, release upload,
  독립 리뷰는 미검증이다. 따라서 C93 gate 완성이나 배포 준비로 승격하지 않는다.

## 15. 2026-09-26 후속 기록 — C58 evidence label의 N/A 구분

- 검토 대상 원본 `keyatlas-c58-fix-01`의 branch는
  `codex/firstvibe-collab-58-evidence-labels-fix-01`, SHA
  `090c7313a4ec0b6bd181d9889d7282f1ae7c1caf`였고, 당시 로컬 tracking ref와 일치했다.
  이는 live remote 상태 검증이 아니다.
- 문서가 일반 기능 테스트에도 `Critical=0`/`High=0`을 의무처럼 요구해, 평가하지 않은 값을
  0으로 기록할 수 있는 모호성을 발견했다. 원본 checkout은 건드리지 않고 별도 local clone의
  `codex/firstvibe-c58-evidence-na`에서 한 문서만 고쳐, 평가하지 않은 severity는 `N/A`,
  실행하지 않은 필수 보안 검사는 `UNKNOWN`으로 구분하도록 했다.
- clone 전체 Markdown 상대 링크 77개 통과, 변경 문서의 docs-only Secret scan `SECRET_SCAN_PASSED`
  (`REAL_SECRET_GATE=CLOSED`), `git diff --check` 및 trailing whitespace 검사는 exit 0이다.
  이 문서 수정은 미커밋·미푸시이며 독립 리뷰, PR, 원격 CI는 아직 없다.

## 16. 2026-09-26 후속 기록 — 실제 Secret 입력은 아직 닫혀 있음

- canonical baseline `d9c66661db7d7b66f6453e94e467c424107cba66`의
  `SyntheticRegistrationPanel.tsx`는 고정된 가상 프로필·자격증명 종류·연결만 고르는 선택형 UI다.
  그 화면에는 자유 형식 비밀번호/API 키 입력이나 파일 가져오기 컨트롤이 없고,
  `LocalVaultPanel.tsx`도 `SyntheticCiphertextStore`와 synthetic worker를 연결한다.
- 이 화면의 두 Vitest 파일(`SyntheticRegistrationPanel.interaction.test.tsx`,
  `SyntheticRegistrationPanel.test.ts`)은 14/14 통과(exit 0)했다. 이는 해당 합성 등록 흐름의
  증거일 뿐, 앱 전체의 모든 화면/경로를 증명하거나 실제 Secret 지원을 허가하지 않는다.
  `REAL_SECRET_GATE=CLOSED`와 실제 Secret 입력 금지 상태는 그대로다.

## 17. 2026-09-26 후속 기록 — 합성 등록 입력 경계 회귀 검토

- canonical baseline `d9c66661db7d7b66f6453e94e467c424107cba66`에서
  `parseSyntheticRegistration`이 실제 등록 세션과 Worker client의 첫 경계임을 확인했다.
  고정된 데모 ID tuple만 허용하고, 입력을 비동기 작업 전에 복사·동결하며, 추가 필드·getter·
  잘못된 배열 shape·중복/범위 밖 연결 ID·예외를 공개 오류 `INVALID_ARCHIVE`로 닫는다.
- `syntheticRegistration.test.ts`, `SyntheticVaultRegistration.test.ts`,
  `SyntheticVaultWorkerClient.test.ts`를 실행해 3 files / 141 tests PASS (exit 0).
  검토 범위에서 회귀나 명확한 취약점을 찾지 못해 코드는 변경하지 않았다.
- 이는 동일 프로세스 내부의 합성 선택 DTO에 한정된 코드/단위 테스트 검토다. hostile Proxy trap에
  대한 자원 격리나 전체 화면 경로의 실비밀 거부를 증명하지 않으며 실제 Secret 입력은 계속 금지다.

## 18. 2026-09-26 후속 기록 — 로컬 후보 2차 읽기 검토

- [x] C30 metadata 상한 변경, C58 `N/A` severity 규칙, C93 artifact-manifest validator와
  workflow를 현재 작업자가 다시 읽었다. 이 추가 읽기 범위에서 명확한 새 결함은 발견하지 못했다.
- [ ] 위 검토는 독립 reviewer 승인으로 세지 않는다. 실제 독립 리뷰, exact head SHA의 원격 CI,
  후보 branch 통합 및 사용자 `main` 승인도 여전히 미완료다. 후보 clone의 로컬 PASS를 PR/배포
  상태로 승격하지 않는다.

## 19. 2026-09-26 후속 기록 — 실제 브라우저 백업 파일 왕복 시도

- 로컬 production-preview 정적 파일 서버는 `127.0.0.1:5198`에서 HTTP 200을 반환했다.
  별도 agent-browser session으로 열려 했지만 `CDP response channel closed`가 발생했고,
  session 상태는 `browserLaunched=false`, page 0이었다. `doctor --offline --quick`도 출력 없이
  멈춰 해당 진단 프로세스만 중단했다. 브라우저 설치·보안 정책 우회·수동 다운로드는 하지 않았다.
- 이 시도에서 파일을 만들거나 업로드하지 않았다. 빈 격리 다운로드 폴더는 위치와 내용이 비어
  있음을 확인한 후 제거했고, 직접 시작한 로컬 서버와 새 session만 닫았다. 기존 다른 browser
  session은 닫지 않았다.
- 별도 임시 user-data-dir을 지정한 system Chrome 대안도 포트 `5199`를 열기 전에 프로세스가
  종료되어 연결되지 않았다. 해당 고유 임시 profile은 프로세스 종료·포트 미수신·workspace 내부
  경로를 확인한 뒤 제거했다. 설치, 사용자 Chrome profile 재사용, 보안 정책 변경은 하지 않았다.
- 실제 다운로드·새 격리 프로필 복원은 여전히 `NOT_VERIFIED`; 앞선 Blob 준비 확인을 파일
  왕복 근거로 승격하지 않는다. 이후에는 브라우저 런타임 진단 또는 사용자 쪽 앱 설치 상태가
  해결된 뒤 다시 시도한다.
- 후속 Codex 격리 브라우저에서는 `127.0.0.1:5173`의 기존 합성 금고 3개를 열고 백업 화면의
  확인 checkbox → `합성 백업 파일 준비`까지 실제 React UI로 진행했다. Blob 다운로드 링크와
  `다운로드를 요청했습니다` 상태는 표시됐지만, 브라우저 download event와 media 저장은 각각
  timeout됐고 OS `Downloads`에는 2026-09-14의 기존 3,892-byte 파일만 있었다. 임시 폴더에서도
  새 `.katldemo` 파일을 찾지 못했다. 따라서 이번 실행이 만든 디스크 파일은 0개이며, 파일 선택·
  복원은 수행하지 않았다. 실제 디스크 저장·새 격리 프로필 복원은 계속 `NOT_VERIFIED`다.

## 20. 2026-09-26 후속 기록 — Web의 실비밀 입력 부재 확인

- baseline의 비테스트 `apps/web/src/**/*.tsx`를 읽기 전용 검색했다. 발견한 입력은 검색창,
  확인용 checkbox, 합성 `.katldemo` 파일 선택뿐이고 `text/password/email/url/tel/number` 타입은
  없었다. 등록·연결 편집·회전 화면의 기존 4개 Vitest 파일도 43/43 PASS (exit 0)했다.
- 같은 비테스트 Web source pattern scan에서 `dangerouslySetInnerHTML`, `innerHTML`,
  `document.write`, `window.open`, iframe 사용은 발견하지 못했다. 보이는 링크는 내부 고정 route와
  합성 백업 Blob URL뿐이다. 이는 정적 검색이지 전체 XSS/security audit가 아니다.
- 이 결과는 지금 소스의 해당 React 화면과 기존 단위 테스트만 설명한다. 빌드 artifact 전체,
  브라우저 동작, 제3자 DOM 주입, Android/서버의 입력 경계까지 검증한 것은 아니다.
  실제 Secret 입력 허가는 아니며 `REAL_SECRET_GATE=CLOSED`를 유지한다.
- baseline exact SHA `d9c66661db7d7b66f6453e94e467c424107cba66`에서 full repository Secret scan은
  synthetic baseline 4개 허용 후 `SECRET_SCAN_PASSED`, `REAL_SECRET_GATE=CLOSED` (exit 0).
  `cargo fmt --all -- --check`와 tracked `git diff --check`도 exit 0이다. 그 checkout은 tracked
  source 변경 없이 untracked `AGENTS.md`만 보이며, baseline 안내서도 아직 commit/push하지 않았다.
- 같은 exact SHA의 Web 전체 `npm test`는 46 files / 1,467 tests PASS, `npm run typecheck`도
  exit 0이다. `npm run build`는 기존 ignored `apps/web/dist`를 덮어쓸 수 있어 이번에는 재실행하지
  않았다. 따라서 이 시점의 새 production build는 `NOT_RUN`이다.
- 같은 baseline의 PowerShell 7 `tests/verification/check-repository-secrets.Tests.ps1`는
  `SECRET_SCANNER_TESTS_PASSED=102`, 102/102 PASS (exit 0). 전부 합성 회귀이며 실제 Secret을
  넣은 탐지 검증은 하지 않았다.

## 21. 2026-09-26 후속 기록 — SQLite 저장소 패키지 테스트와 OS 실행 차단

- canonical baseline `d9c66661db7d7b66f6453e94e467c424107cba66`에서
  `cargo test -p vault-local-store-sqlite --no-fail-fast`를 실행했다. 단위 테스트 48개,
  integration suites 38개, Secret trait test 1개, doctest 2개 등 실제 실행된 테스트는
  총 89 PASS, 0 FAIL이고 unit test 1개는 의도적으로 ignored였다. 여기에는 별도 자식 test
  process를 실제 kill/exit한 뒤 SQLite preflight·인증으로 재오픈하는 crash atomicity의
  2개 parent test도 PASS로 포함된다.
- `tests/lock_and_flags.rs` 실행 파일은 Windows Application Control이 시작 자체를 거부했다
  (OS error 4551). 그 파일의 테스트는 실행되지 않았고 Cargo 전체 명령 종료 코드는 1이다.
  해당 target의 9개 case(기본 LocalAppData 한정·exclusive lock 및 Windows live-lock/junction·
  cloud/alias 경로 거부·초기화 재시도·SQLite open flags)는 이 시도에서 하나도 실행되지 않았다.
  정책 우회·서명 우회·다른 위치에서 실행은 하지 않았다. 따라서 이 패키지 검증은 **부분 PASS,
  전체 패키지 PASS 아님**으로 기록한다.
- 같은 패키지의 `cargo clippy -p vault-local-store-sqlite --all-targets -- -D warnings`는
  exit 0으로 통과했다. 이는 컴파일·lint 증거이며 차단된 test binary의 runtime 검증을 대체하지 않는다.
- 추가로 `cargo clippy -p vault-local-store-sqlite --all-targets --all-features -- -D warnings`도
  exit 0이다. 이는 명시적 `test-seams` feature를 포함한 compile/lint 결과이며 runtime 검증은 아니다.
- `cargo test -p vault-crypto --no-fail-fast`에서도 OS error 4551이 발생했다. `codec_limits` 22,
  `epoch_binding` 3, `local_alpha_flow` 1, `properties` 1, `secret_traits` 1,
  `storage_traits` 1, `vectors` 1 및 doctest 0개는 실행 완료했다. 총 30 PASS, 0 실행 테스트 실패다.
  반면 library unit tests, `password_wrap`, `storage_inspection`, `tamper_rejection` 네 test target은
  실행 전에 Application Control이 차단해 결과를 얻지 못했으며 Cargo 종료 코드는 1이다. 같은 정책을
  우회하지 않았으므로 crypto package 전체도 PASS가 아니다.
- `cargo clippy -p vault-crypto --all-targets -- -D warnings`는 exit 0이다. 이는 static compile/lint
  확인이며 위 네 개 차단 target의 test 실행이나 암호학적 외부 리뷰를 의미하지 않는다.
- `cargo test -p vault-local-core --no-fail-fast`는 126 unit + 6 integration/trait + 5 doctests,
  총 137 PASS / 0 FAIL (exit 0)이다. `cargo test -p vault-client-bridge --no-fail-fast`도
  catalog snapshot 8 + Secret-trait 1 + doctest 4, 총 13 PASS / 0 FAIL (exit 0)이다.
- `vault-client-wasm` 기본 feature 명령은 0 tests였으므로 별도 증거가 아니다. 실제 UI가 사용하는
  `cargo test -p vault-client-wasm --features synthetic-demo --no-fail-fast`에서는 73/73 PASS,
  0 FAIL (exit 0)였다. 다만 이는 host native test binary이며 wasm32 artifact build/smoke test는 아니다.
- `cargo clippy -p vault-local-core`, `-p vault-client-bridge`, `-p vault-client-wasm` 각각에
  `--all-targets -- -D warnings`를 적용해 모두 exit 0이었다. 또한
  `cargo clippy -p vault-client-wasm --all-targets --features synthetic-demo -- -D warnings`도
  exit 0으로 합성 UI feature를 포함해 확인했다. 모든 위 테스트 데이터는 synthetic이다.
- 이전 전체 workspace default-test 결과는 §16에 exit 0으로 기록되어 있다. 이번 패키지 집중 재실행에서
  OS 정책이 차단한 네 test target은 이번 실행 시도 기준 미검증이다. 이는 과거 workspace PASS를
  지우지 않지만, 차단된 개별 target의 최신 재현 증거도 아니다. Linux/macOS 동작이나 Windows OS
  전체 파일 플래그 보장도 대체하지 않는다. `REAL_SECRET_GATE=CLOSED`; 데이터는 합성값뿐이다.

## 22. 2026-09-26 후속 기록 — Windows 실제 writable mapping feasibility gate

- 기본 `cargo test -p vault-local-sqlite-vfs-windows`에서는 opt-in feature가 꺼져 있어
  `actual_handle_feasibility.rs`가 0 tests였다. 이를 gate PASS로 세지 않는다.
- 코드를 확인한 뒤 feature `feasibility-probe`와 명시적 ignored test만 한 번 실행했다:
  `cargo test -p vault-local-sqlite-vfs-windows --features feasibility-probe --test actual_handle_feasibility preexisting_writable_mapping_must_block_guard_acquisition -- --ignored --exact --nocapture`.
  자식 프로세스가 OS temp 안의 25-byte synthetic mapping에 writable view를 먼저 만든 뒤 main
  guard 취득을 시도했고, 기대한 `SharingViolation` / Win32 error 32가 확인되어 1/1 PASS (exit 0).
- 같은 feature의 비-ignored 모듈 시험은 2 PASS / 1 ignored (exit 0); feature 활성화한
  `cargo clippy -p vault-local-sqlite-vfs-windows --all-targets --features feasibility-probe -- -D warnings`
  도 exit 0이다. VFS 기본 package의 일반 platform-contract test도 2/2 PASS지만 feasibility
  feature가 꺼진 실행이므로 위 gate와 별개다. `vault-local-platform-windows`의 drive-type
  정책 test도 2/2 PASS이고 `cargo clippy -p vault-local-platform-windows --all-targets -- -D warnings`
  는 exit 0이다.
- 이 결과는 현재 Windows에서 **미리 열어 둔 writable memory mapping 한 종류**를 guard가 거부하는
  격리 증거다. 앱이 실제 SQLite main/WAL/SHM 접근에 이 VFS를 사용함, guard 취득 후의 hostile race,
  다른 교체 방식·파일 유형·플랫폼의 권위성은 증명하지 않는다. Production store integration,
  post-acquisition race/sidecar 검사와 독립 보안 review는 남아 있으며 [ ] 상태다. 파일·비밀은 전부
  합성값; `REAL_SECRET_GATE=CLOSED` 유지.
- 정적 call-site 확인상 `acquire_main_read_guard_v1`는 별도 probe crate에서 export되고 위 feasibility
  test만 사용한다. `vault-local-store-sqlite`의 production open path에 연결되어 있지 않다. 이 helper는
  read-only/`FILE_SHARE_READ`/`OPEN_REPARSE_POINT` handle을 열어 유지하지만 자체적인 regular-file·
  reparse-point·stable-identity 판정을 하지 않는다. Store의 `schema.rs`에는 별도 ownership handle의
  `stable_file_identity_v1` 비교가 있고 `preflight_query.rs`도 열린 파일/sidecar의 identity·크기를 추적한다.
  이는 유효한 기존 hardening이지만, SQLite가 실제 사용하는 handle과 같은 파일임을 완전히 증명하지는
  않는다. 통합 시 handle identity/속성을 SQLite가 실제 사용하는 main/WAL/SHM handle에 결합하는
  권위 테스트가 필요하다. 현재 이를 보안 결함으로
  승격하지 않고, 미통합 feasibility utility의 한계 및 HIGH-risk integration TODO로 남긴다.
- source baseline은 `d9c66661db7d7b66f6453e94e467c424107cba66`이고 검증 중 원본 코드는 바꾸지 않았다.
  이 청사진 수정은 `codex/firstvibe-luna-release-support`의 로컬 변경이며 commit/push/PR/merge하지 않았다.
- 당시 다음 증거 순서는 Application Control이 허용하는 환경에서 잠금 및 암호 test targets를
  재검증하는 것이었다. 후속 결과는 §23에 기록했다. 정책 비활성화·서명 우회는 하지 않았으며,
  다음 기술 과제는 별도 코드 변경·main/WAL/SHM 경합 테스트·독립 리뷰를 통해 feasibility helper의
  SQLite store 통합을 심사하는 것이다. 그때까지 `REAL_SECRET_GATE=CLOSED`를 유지한다.

## 23. 2026-09-26 후속 기록 — SQLite 및 암호 패키지 재검증

- 확인한 깨끗한 source checkout은 `agent-staging/keyatlas-sqlite-namespace-hardening`, branch
  `codex/firstvibe-sqlite-namespace-hardening`, HEAD `c1718f97055497bc608d16b0a557077a955bbf29`이며
  시작/검증 종료 시 추적 파일 변경이 없었다. 이 검증은 source 코드나 기존 branch를 수정하지 않았다.
- `cargo test -p vault-local-store-sqlite --test lock_and_flags -- --test-threads=1`는 9/9 PASS,
  exit 0. 이어 `cargo test -p vault-local-store-sqlite --no-fail-fast`는 unit 48 PASS/1 ignored,
  통합·trait 48 PASS, doctest 2 PASS로 총 98 PASS / 0 FAIL / 1 ignored, exit 0이었다.
  crash subprocess 원자성, synthetic plaintext 잔존, 잘못된 비밀번호 이후 read-only 보존,
  lock namespace·junction 거부 검사를 포함한다. `secret_traits`의 6 trybuild compile-fail cases도
  PASS하여 public raw SQLite handle·secret projection capability 경계를 확인했다.
- 같은 SQLite package 전체를 이번에는 기본 병렬 test runner로 다시 실행해도 98 PASS / 0 FAIL /
  1 ignored, exit 0이었다. crash subprocess를 포함한 해당 합성 테스트들이 서로 간섭하지 않은 것까지
  확인한 로컬 재실행이지, multi-process production stress나 실제 기기 손실 검증은 아니다.
- `cargo clippy -p vault-local-store-sqlite --all-targets --all-features -- -D warnings`,
  `cargo fmt --all -- --check`, `git diff --check`는 각각 exit 0이다.
- `cargo test -p vault-crypto --no-fail-fast`는 실행된 테스트 57 PASS / 0 test failure이나,
  `tests/vectors.rs` 실행 파일 시작이 Windows Application Control OS error 4551로 거부돼 Cargo
  종료 코드는 1이다. vectors target은 미검증이며 crypto crate 전체 PASS가 아니다. 우회는 하지 않았다.
  `cargo clippy -p vault-crypto --all-targets -- -D warnings`와 포맷 검사는 exit 0이다.
- 같은 checkout에서 `cargo test -p vault-local-core --no-fail-fast`는 137/137 PASS,
  `cargo test -p vault-client-bridge --no-fail-fast`는 13/13 PASS,
  `cargo test -p vault-client-wasm --features synthetic-demo --no-fail-fast`는 73/73 PASS였다.
- 제공된 안전 실행 예제 `cargo run --offline --locked -p vault-local-store-sqlite --example
  synthetic_sqlite_roundtrip`도 exit 0으로 임시 폴더에서 합성 금고 생성 → 암호문 revision 저장 →
  닫고 잠금 상태 재오픈 → 관계 인증을 확인했다. 예제는 고정 `DEMO_VALUE_ONLY_...` 값만 사용하고
  종료 시 `tempfile` 임시 디렉터리를 제거한다. 실제 비밀을 시험할 수 있다는 뜻은 아니다.
- 공식 집중 래퍼 `pwsh -NoProfile -NonInteractive -File .\scripts\verify-local.ps1`는
  `VERIFY_SCOPE=Focused`, repository scan·fmt·VFS all-features Clippy·기본/ordinary probe tests 모두
  `CHECK_EXIT=...:0`, `LOCAL_CHECKS_PASSED`, exit 0을 냈다. 기본 platform-contract 2/2 PASS,
  probe unit 2/2 및 platform-contract 2/2 PASS다. 별도 writable-mapping gate는 기본 래퍼에서
  ignored이며, 위 10회 반복 실행으로 따로 확인했다. 전체 Rust workspace 검증은 아니다.
- WASM Rust 테스트 73/73은 host-native 테스트이지 wasm32 artifact 증거가 아니다. 별도로
  `scripts/build-wasm.ps1 -SyntheticDemo` debug artifact를 현재 source로 빌드하고
  `node scripts/test-wasm.mjs --demo`를 실행해 실제 WASM runtime checks 1,735개 PASS를 확인했다.
  `scripts/build-wasm.ps1 -Release` 기본/production artifact 및 `node scripts/test-wasm.mjs`도
  fresh release artifact 기준 40/40 PASS다. 생성 파일은 Git 무시 경로 `apps/web/src/generated/`에만 있다.
  이 Node/WASM runtime 검사는 UI의 브라우저 통합, actual secret 흐름, production 웹 서버를 검증하지 않는다.
- 추가로 기본(non-demo) `cargo test --offline --locked -p vault-client-wasm --no-fail-fast`는 exit 0이나
  feature가 닫혀 있어 0 tests였다. 기본 feature all-target Clippy `-D warnings`는 exit 0이다. 기능 검증은
  위의 generated default WASM 40 runtime checks로 한정한다.
- Web 회귀는 별도 canonical baseline `d9c66661db7d7b66f6453e94e467c424107cba66`에서
  `npm test` 46 files / 1,467 tests PASS와 `npm run typecheck` exit 0이다. 이 checkout은
  `AGENTS.md` 외 tracked source 변경이 없다. 기존 ignored `apps/web/dist` (2026-09-26 02:24,
  5 outputs)는 보존하고, 새 빈 `dist/codex-validation-20260926`에만
  `npm run build -- --outDir dist/codex-validation-20260926 --emptyOutDir false`를 실행해
  Vite build exit 0을 확인했다. 다섯 산출물 모두 기존 `dist`의 대응 파일과 SHA-256이
  일치했다. 이 검사는 이미 있던 `apps/web/src/generated` WASM 입력을 소비했으므로,
  baseline checkout에서 WASM을 새로 빌드했다는 증거는 아니다. `node_modules`는 이미 있었고
  설치하지 않았다.
- 명시적 ignored gate인 `preexisting_writable_mapping_must_block_guard_acquisition`를
  `feasibility-probe` feature로 실행해 기존 1/1 PASS에 더해 같은 명령을 10회 반복해 10/10 PASS했다.
  각 실행은 isolated synthetic mapping fixture만 다뤘다. VFS package tests는 6 PASS/1 ignored,
  `vault-local-platform-windows`는 2/2 PASS였다. core, bridge, synthetic-demo WASM, VFS probe,
  platform Windows Clippy는 각 all-targets `-D warnings`로 exit 0이다.
- default/demo WASM과 격리 Vite validation bundle 생성 후 전체 checkout Secret scan도 실행했다.
  Git-ignored generated WASM·`dist`를 포함해 `SECRET_SCAN_BASELINE_ALLOWED=4`,
  `SECRET_SCAN_PASSED`, `REAL_SECRET_GATE=CLOSED`, exit 0이었다. 사용한 입력은 합성 fixture뿐이다.
- Secret scanner의 회귀 스크립트 `pwsh -NoProfile -NonInteractive -File
  tests/verification/check-repository-secrets.Tests.ps1`도 102/102 PASS,
  `SECRET_SCANNER_TESTS_PASSED=102`, exit 0이다. 테스트는 자체 임시 fixture와 junction만 사용했다.
- 같은 source checkout에서 Windows PowerShell 5.1 반복은 정책 변경 없이 시도했지만,
  시스템 실행 정책이 script load를 막아 테스트가 시작되지 않았다. `-ExecutionPolicy Bypass`나
  policy 변경은 하지 않았으므로 PS5.1 결과는 이 exact checkout에서 `NOT_RUN`; 위 PS7 102/102 결과와
  별도로 취급한다.
- canonical Web의 비테스트 `apps/web/src`를 대상으로 한 정적 red-team pattern pass에서
  위험 DOM sink 0건, outbound network API 0건, clipboard API 0건, external navigation sink 0건을
  확인했다. IndexedDB 참조 4건은 이름 그대로 `SyntheticCiphertextStore`와 합성 화면·백업 설명에
  한정됐다. 기본 화면의 AI payload 버튼은 allowlisted synthetic metadata JSON만 화면에 미리 보여주며
  AI로 전송하지 않는다. 이는 특정 문자열 검색·화면 코드 확인이지 런타임/전체 XSS 감사가 아니며,
  Web은 아직 합성 저장소다.
- Rust 전체 `crates/**/*.rs`의 `unsafe` 위치 검색에서는 Windows platform FFI 7곳, Windows VFS의
  합성 probe와 그 tests 9곳, probe child-test helper 2곳만 나타났다. 두 Windows boundary crate는
  `unsafe_op_in_unsafe_fn`을 deny한다. 이는 검색·문맥 확인 결과이며 FFI/aliasing/concurrency의
  formal unsafe audit로 볼 수 없다.
- `apps/web/index.html`·Vite 설정·배포 설정에서는 적용된 CSP/Trusted Types/응답 보안 헤더를
  찾지 못했다. 이는 현재 합성 개발 preview의 출시 장애 결함 판정이 아니라 공개 서비스 전 필수 미완료다:
  별도 금고 origin에 맞는 CSP·Trusted Types·egress 제한을 실제 hosting response에서 적용하고,
  Rust/WASM·Worker·Blob backup 경로와 함께 브라우저에서 회귀 검증해야 한다.
- 유일한 GitHub workflow 파일도 소스만 읽어 확인했다: job `contents: read`, checkout의
  `persist-credentials: false`, 두 외부 Action의 전체 commit SHA pin, repository Secret scan 우선 실행,
  Rust·Node 고정 버전이 보인다. 단, 해당 workflow의 원격 실행은 결제/사용 한도 차단 때문에 증거가
  없고 local 검사가 hosted runner·Pester 5.7.1 policy test를 대신하지 않는다.
- **Red-team 다음 gate — 미실행·미구현**: 실제 Secret을 고려하기 전 별도 설계·코드 리뷰와 아래
  Windows 권위 테스트가 필요하다. 한 항목이라도 검증 불가/불일치이면 쓰기를 거부해야 한다.

  | 공격/경계 | 필요한 증거 |
  |---|---|
  | 검사 뒤 경로 교체 | preflight가 확인한 main 파일과 SQLite가 실제 연 main handle의 OS identity가 같음. 두 단계 사이 rename/replace/reparse 경합 시 write 없음 |
  | WAL·SHM·rollback journal | SQLite가 실제 연 sidecar handles도 신뢰 경로·파일 정책에 묶임. 예기치 않은 링크·교체·sidecar 생성/제거는 fail-closed |
  | 활성 handle 중 공격 | 연결/commit/checkpoint 도중 별도 프로세스의 교체·mapping·재시도에서도 다른 파일로 쓰거나 이전 검증을 재사용하지 않음 |
  | 기존 writable mapping | 이미 기록된 25-byte probe 외에 실제 SQLite open 경로에서 mapping 선점·사후 mapping 시도 둘 다 기대대로 거부 |
  | 충돌·복구 freshness | 예전의 유효한 DB/WAL/SHM 묶음 복원 또는 revision/head 되감기를 탐지하거나 제품 한계로 명시하고 복구 확인을 차단 |
  | crash/durability 범위 | commit 전후 process crash와 WAL checkpoint 회귀를 반복. process 종료 결과를 물리 전원 손실 보장으로 과장하지 않음 |
  | 사람에 의한 독립 검토 | 경합 모델·FFI 안전성·Windows sharing semantics·실패 로그 비밀 비노출을 독립 reviewer가 재검토하고 exact SHA에 기록 |

- 이 결과는 c1718f9 체크아웃의 해당 패키지 테스트·정적 검사만 입증한다. SQLite production 경로의
  actual-handle VFS 결합, 독립 보안 리뷰, vector target, wasm32/browser 동작, 다른 OS/실제 기기,
  실비밀 허가를 증명하지 않는다. `REAL_SECRET_GATE=CLOSED`; commit/push/PR/merge/배포는 하지 않았다.

## 24. 2026-09-26 후속 기록 — AI preview 안내 정확도

- Web checkout `agent-staging/keyatlas-collab-001-100`의 기준 HEAD는
  `d9c66661db7d7b66f6453e94e467c424107cba66`이며, `apps/web/src/App.tsx`의 AI 경계 안내가
  실제 전송이 구현된 것처럼 오해될 수 있어 로컬 미커밋 수정했다. 이제 실제 AI 연동/전송이
  없고 버튼이 합성 데이터의 허용목록 preview만 화면에 표시한다고 명시한다. 화면에 보이는 서비스명·
  환경·권한·날짜를 사람이 외부 AI로 복사/공유하기 전에 직접 검토하라는 경고도 함께 표시한다.
- 추가한 `apps/web/src/App.test.tsx`는 정적 렌더링에서 해당 고지와 기본 버튼 라벨을 확인한다.
  전체 Vitest 회귀는 47 files / 1,469 tests PASS, `npm run typecheck` PASS다. 격리 경로
  `apps/web/dist/codex-validation-20260926-copy-clarity-v2`에 한 `npm run build -- --outDir
  dist/codex-validation-20260926-copy-clarity-v2 --emptyOutDir false`도 exit 0이다. 산출 JS에 새
  미전송 고지가 있고 종전 오해 문구가 없음을 확인했다. 기존 `dist`는 건드리지 않았다.
- `toAiSafeInventory.test.ts`에는 제외 필드(`id`, `accountHint`, `notes`, `sourceUrl`), connection
  label 원소와 앞으로 추가될 수 있는 `apiKey`, `password`, `secretKey`, OAuth/MCP 인증값, recovery code의
  getter·합성 값이 변환 과정에서 읽히거나 직렬화되지 않는 회귀를 추가했다. full Vitest 47 files /
  1,469 tests PASS, `npm run typecheck` PASS다. 이는 현재 변환기 동작만 검증하며 AI 전송을 구현하거나
  검증하지 않는다.
- 동시 build/scan과 겹친 full test 한 번은 대용량 IndexedDB CAS test의 15초 timeout으로 실패했다.
  해당 test 단독은 2.63초에 1/1 PASS했고, 이후 다른 검사 없이 재실행한 full suite는 47/1,469 PASS,
  exit 0이다. 이를 코드 실패로 결론 내리지는 않되, 병렬 검증 부하의 timing sensitivity 기록은 유지한다.
- 변경 후 non-test `apps/web/src` pattern pass도 반복했다: outbound network API, 위험 DOM sink,
  clipboard/external-navigation API가 각각 0개 파일에서 검색됐다. 이는 검색 기반 결과이며 동적 호출,
  dependency 내부 코드, 서버 response headers/CSP, XSS 전반을 입증하는 감사가 아니다.
- 최신 Web source/test 변경 뒤 repository Secret scanner 최종 실행은
  `SECRET_SCAN_BASELINE_ALLOWED=4`, `SECRET_SCAN_PASSED`, `REAL_SECRET_GATE=CLOSED`, exit 0이다.
- 최종 후 `docs/handoff` subtree scanner도 `SECRET_SCAN_PASSED`,
  `REAL_SECRET_GATE=CLOSED`, exit 0이다. 전체 docs worktree에 대한 결과로 확대 해석하지 않는다.
- **Red-team 잔여 위험:** 이름 기반 allowlist는 값 자체의 민감도를 판별하지 않는다. 특히 허용된
  `serviceName` 같은 사용자 입력과 날짜·권한 필드는 의미상 정보 노출을 가릴 수 있으므로, 미래의 외부
  AI 전송 전에 필드별 사용자 동의, 값 검증·마스킹, 네트워크 egress 검토 및 실제 전송 경계 테스트를
  별도 완료해야 한다.
- docs worktree 전체를 별도 source checkout의 scanner에 넘긴 시도는
  `SECRET_SCAN_FAILED setup_or_execution`으로 끝났다. 그 뒤 범위를 정확한 `docs/handoff` subtree로 좁혀
  같은 scanner를 실행해 `SECRET_SCAN_PASSED`, `REAL_SECRET_GATE=CLOSED`, exit 0을 확인했다.
  따라서 handoff 문서 subtree는 검사됐지만 전체 docs worktree는 이 결과로 포괄되지 않는다.
  Markdown 상대 링크 검사는 51 files PASS, 새 청사진의 trailing-whitespace 0 / final newline PASS다.
- 전용 branch 생성은 linked checkout의 Git common dir이 쓰기 허용 밖
  `C:/Users/USER/Desktop/PersonalProJect/KeyAtlas/secure-vault/.git`를 가리켜 OS permission으로
  거부됐다. 권한 확대·경로 우회는 하지 않았고, 변경은 현재 baseline branch의 로컬 미커밋 상태다.
  해당 branch의 기존 untracked `AGENTS.md`도 유지했다. commit/push/PR/merge는 없으며
  `REAL_SECRET_GATE=CLOSED`다.

### 2026-09-26 후속 기록 — UTF-8 로컬 검색 입력 한도

- `SyntheticToolPanel`의 HTML 글자 수 제한만으로는 한국어·이모지가 프로토콜의 128 UTF-8 바이트
  한도와 다르게 보일 수 있었다. 화면이 실제 UTF-8 바이트 수를 보여주고 한도 초과 시 실행을 막도록
  바꿨다. 초과 입력은 그대로 표시되므로 사용자가 스스로 줄일 수 있고, `aria-invalid`·오류 설명도
  연결한다. 후속 독립 검토에서 고립 UTF-16 surrogate는 화면에서 유효해 보이지만 프로토콜에서만
  거절되는 P3 불일치를 찾아, 공용 well-formed 판정을 화면과 프로토콜이 함께 사용하도록 보완했다.
  손상된 문자는 제출 전에 별도 안내와 함께 차단한다. 외부 전송이나 비밀 입력은 없다.
- 프로토콜·화면 공용 한도 판정과 `TextEncoder` 길이 계산을 회귀 테스트했다: ASCII 128바이트,
  한글 42자(126바이트)/43자(129바이트), 이모지 32개(128바이트)/33개(132바이트).
  화면 설명·접근성 연결과 서버 스냅샷 초기 렌더, 한도 초과·손상 입력의 제출 차단과 정상값 수정 뒤
  재활성화를 콜백 단위 테스트로 확인했다. 해당 테스트는 한글 129/128, 이모지 132/128, 손상 입력
  3/128의 카운터 값도 고정한다.
- 검증: 최종 변경 전 집중 테스트 3파일/82개 PASS, 전체 Web 회귀 49파일/1,487개 PASS,
  `npm run typecheck` PASS. 카운터 assertion 추가 뒤 해당 interaction test 1파일/3개 PASS,
  `git diff --check` exit 0이다. 저장소 Secret scan은 `SECRET_SCAN_BASELINE_ALLOWED=4`,
  `SECRET_SCAN_PASSED`, `REAL_SECRET_GATE=CLOSED`, exit 0이다.
- Codex 격리 브라우저의 실제 React 화면에서도 합성 금고 3개를 열고 도구 패널을 조작했다. 한글 43자는
  129/128, 이모지 33개는 132/128로 표시되며 `aria-invalid=true`, 오류 안내, 실행 버튼 비활성화를
  확인했다. `Example`로 고치면 버튼이 다시 활성화되고 고정 receipt
  `{"kind":"ok","action":"search_catalog"}`와 사용자 화면 전용 합성 결과 3개만 표시됐다.
  도구 잠금 뒤 금고 상태는 잠김으로 바뀌고 도구 패널·검색 결과가 DOM에서 사라졌다.
- 독립 읽기 전용 재검토는 최종 Unicode 정렬 diff에서 P1/P2 0건으로 판정했다. 상호작용 test는 React
  hook과 도구 호출을 모킹하므로 실제 effect lifecycle을 증명하지 않지만, 위 브라우저 조작이 DOM 상태와
  제출/잠금 경로를 별도로 확인했다.
- **검증 경계:** 브라우저 조작은 자동화된 `fill`/키보드 경로이며 사람의 OS 한글 IME 조합·모바일·
  screen reader는 확인하지 않았다. 마지막 작은 보완 뒤 C: 여유 공간은 작업 중
  2,750,889,984 bytes에서 약 1.09~1.28 GB대로 감소·변동해 문서의 5 GiB 안전 기준보다 작았다.
  페이지 파일 사용은 확인했지만 감소 원인은 확정하지 않았고 파일 삭제·프로세스 종료도 하지 않았다.
  따라서 production build를 새로 시작하지 않았으며 앞선 build를 최종 diff의 증거로 승격하지 않는다.
  원격 CI도 실행하지 않았다. 수정과 테스트는 source checkout의 기존 로컬 미커밋 작업이며
  commit/push/PR/merge하지 않았다. Sourcery 메일은 접근 권한/업그레이드 안내이지 리뷰 완료 증거가 아니다.
