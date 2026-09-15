# KeyAtlas (working title) 제품 개발·배포 가이드

> 이 문서는 현재 구현 사실과 앞으로 필요한 일을 초보자 눈높이로 연결하는 살아 있는 기록입니다.
> `KeyAtlas`는 **내부 작업명**일 뿐 최종 상표·앱 이름이 아닙니다. 공개 출시 전 상표·앱 이름·도메인 중복 조사가 필요합니다.

## 1. 만들고 있는 제품

여러 사이트의 아이디·비밀번호, API 키, Secret, MCP 연결 정보를 한곳에 정리하는 개인용 보안 금고입니다. 단순 메모장이 아니라 다음 관계를 함께 기록하는 것이 핵심입니다.

```text
서비스 → 계정 → 조직/프로젝트 → 개발·테스트·운영 환경 → 자격 증명 → 연결된 앱/MCP/배포 환경
```

예를 들어 OpenAI Console에서 만든 키가 어느 프로젝트, MCP 서버, 로컬 앱과 연결됐는지 기록하고 키를 교체할 때 갱신할 연결처를 보여 주는 제품입니다.

## 2. 현재 실제 구현 상태

| 영역 | 상태 | 현재 의미 |
|---|---|---|
| Rust 암호화 코어 | 구현·합성 테스트 완료 | 합성 마스터 비밀번호, Root Key 래핑, 항목별 암호화와 변조 거부를 검증했습니다. |
| 자격 증명 데이터 모델 | 구현·합성 테스트 완료 | 서비스·계정·프로젝트·환경·MCP 연결 관계를 엄격한 형식으로 표현합니다. |
| SQLite 암호문 저장소 Task 1~7 | 구현·합성 검증 완료 | immutable revision, canonical head/CAS, 충돌 보존, bounded preflight, 잠금 해제 후 재시작 복구와 커밋 전·후 프로세스 종료 원자성을 구현했습니다. |
| SQLite 보안 문서·전체 검토(Task 8) | 진행 중; 일반 검증 통과, 보안 승인 미완료 | 2026-09-07 전체 기본 workspace 테스트, 전체 Clippy와 문서 예제 검사가 exit 0이었다. 기존 open→첫 쿼리 경계 및 Phase 0A 권위 검토는 별도 미완료다. 일반 검사 통과를 출시·Ready 전환·main 병합 승인으로 간주하지 않는다. 과거 Draft PR #1의 현재 원격 상태는 이번 작업에서 갱신하지 않았다. |
| Windows actual-handle Phase 0A | 격리 probe; 과거 Inconclusive 판정 유지 | 과거 단일 primitive 관찰과 4551 차단 기록은 보존한다. 2026-09-07 feature 일반 suite는 exit 0, 6 passed/1 ignored였으나 명시적 보안 gate는 재실행하지 않았다. 현재 후보의 별도 권위 판정, full Phase 0 및 VFS/store 통합 승인은 내리지 않았다. |
| Web·Android 화면 | 미구현 | 현재 폴더는 자리표시자이며 사용자가 볼 수 있는 금고 화면은 아직 없습니다. |
| Spring Boot API·PostgreSQL·동기화 | 미구현 | 서버 인증, 암호문 동기화, 기기 roster와 checkpoint가 남아 있습니다. |
| 로그인·복구·생체 인증 | 설계 단계 | Google/패스키 로그인과 금고 잠금 해제는 분리하며 Android Keystore 구현이 필요합니다. |
| 결제·Free/Pro | 정책 설계만 완료 | 공개 베타와 보안 게이트 전에는 결제 SDK나 실제 상품을 연결하지 않습니다. |
| 공개 배포·앱스토어 | 미구현 | 보안 감사·복구 훈련·정책 문서·스토어 계정 준비가 먼저입니다. |

현재 코드는 **합성 데이터 전용 보안 기반 공사**입니다. 실제 비밀번호, API 키, 복구 키 또는 개인 금고를 입력하면 안 됩니다.

### 현재 작업 경로와 다시 검사하는 방법 (2026-09-07)

코드는 `C:\Users\USER\Desktop\PersonalProJect\KeyAtlas\worktrees\secure-vault-sqlite-store-design`에 있으며 작업 브랜치는 `codex/firstvibe-sqlite-store`입니다. `secure-vault` 폴더의 `main` 체크아웃과 구분해 사용합니다. 바탕화면 설명 문서는 같은 KeyAtlas 아래 `자료\KeyAtlas_보안_설계_패키지_2026-08-29`에 있습니다.

작업 폴더에서 `powershell -NoProfile -File .\scripts\verify-local.ps1 -Scope Workspace`를 실행하면 전체 일반 검사를 다시 수행할 수 있습니다. 검증 스크립트 자체 테스트는 `powershell -NoProfile -File .\tests\verification\verify-local.Tests.ps1`입니다. 후자는 가짜 Cargo를 사용하므로 실제 Rust 테스트 통과와 구분합니다. 오프라인 의존성이 준비돼 있어야 하며 실제 Secret과 ignored 보안 gate는 여전히 제외됩니다.

[상세 변경 파일·검사 결과·남은 경계](verification/2026-09-07-local-verification-maintenance.md)를 함께 확인하세요.

## 3. 전체 아키텍처 그림

```text
[React 웹 / Android 앱]
          │ 사용자가 잠금 해제한 기기에서만 암·복호화
          ▼
[공유 Rust 보안 코어]
          │ 서버에는 암호문과 제한된 운영 메타데이터만 전달
          ▼
[Spring Boot API] ── [PostgreSQL 암호문 동기화 저장소]
          │
          ├─ Google OIDC / Passkey 서비스 로그인
          ├─ 기기·세션·요금제 entitlement
          └─ Stripe/스토어 결제 상태(후속 단계)
```

- **React/Android**: 사용자가 보고 입력하는 화면입니다.
- **Rust 코어**: 금고의 자물쇠와 금고 내부 형식을 담당합니다.
- **Spring Boot**: 로그인, 동기화, 기기 목록과 결제 권한을 중계합니다. Secret 평문을 읽어서는 안 됩니다.
- **PostgreSQL**: 나중에 서버 동기화용 암호문을 보관합니다. 현재 구현된 SQLite는 우선 로컬 기기 저장소입니다.

## 4. 배포까지의 권장 순서

1. 일반 workspace 검증의 성공 기록과 별도로 Task 8·Windows 저장 경계의 권위 검증 조건을 검토하고 최종 승인합니다. 일반 검사만으로 보안 승인과 출시 준비를 완료 처리하지 않습니다.
2. 복구 Key Slot·신뢰 기기·Android Keystore를 합성 데이터로 구현합니다.
3. Android 고보증 클라이언트에서 금고 생성·잠금·복구 훈련을 완성합니다.
4. Spring Boot API와 PostgreSQL에 암호문 동기화·체크포인트를 구현합니다.
5. 합성 데이터 전용 비공개 React 미리보기를 배포합니다.
6. 독립 암호 검토, 침투 테스트, 백업·복구 훈련을 통과합니다.
7. 통과 후에만 제한된 실제 Secret 베타를 검토합니다.
8. 이용약관·개인정보·가격·환불 정책과 스토어 심사를 준비합니다.

## 5. 초기 비용 전략

- 로컬 개발과 비공개 합성 미리보기: **월 0원 목표**
- 웹 정적 미리보기: Cloudflare Pages/Access 무료 범위 우선
- Spring Boot 소규모 API: Cloud Run 무료 범위 우선
- PostgreSQL 실험: Neon Free 우선, 사용량과 백업 요구가 커지면 유료 전환
- Google Play 공개 개발자 계정: 공식 등록비를 실제 등록 직전 다시 확인
- Apple Developer Program: 연간 비용을 iOS 착수 직전 다시 확인
- 도메인·상표·결제 사업자: 최종 서비스명과 사업 형태가 결정된 뒤 구매·계약

가격과 무료 한도는 변하므로 가입·구매 직전에 공식 페이지에서 다시 확인합니다.

## 6. 도구·플러그인 사용 원칙

| 도구 범주 | 사용 시점 | 안전 경계 |
|---|---|---|
| Superpowers/계획 실행 | 명세→TDD→독립 리뷰 작업 관리 | 계획과 검증을 대신하지 않고 기록을 남깁니다. |
| GitHub | 소스·설계·합성 fixture 백업 | 실제 금고 DB·백업·토큰은 올리지 않습니다. |
| Web/React 도구 | 합성 UI 단계 | 실제 Secret 입력 UI는 보안 게이트 전 열지 않습니다. |
| Neon/Cloudflare/Google Cloud | 서버·비공개 미리보기 단계 | 계정 생성, IAM, 결제 활성화는 사용자 승인 뒤 진행합니다. |
| Stripe/스토어 결제 | 공개 제품 안정화 뒤 | 지원 국가·사업자·환불 정책을 다시 검증합니다. |
| Ethereum | v1에서 제외 | 비밀번호·API 키·복구 키·seed phrase를 온체인에 저장하지 않습니다. |

## 7. 사용자가 나중에 결정하거나 준비할 것

- 최종 서비스명, 상표 검색과 도메인
- Google Cloud/Cloudflare/Neon 등 실제 소유 계정과 프로젝트
- Google/Apple 개발자 계정
- 사업자·결제 제공자·가격·환불 정책
- 개인정보처리방침·이용약관·보안 문의 창구
- 복구 수단 구성과 실제 복구 훈련 승인
- 독립 보안 검토 또는 전문 감사 예산

어떤 경우에도 비밀번호, API 키, 복구 키를 채팅·문서·GitHub 이슈에 붙여 넣지 않습니다.

## 8. 현재 보안 출시 게이트

실제 Secret 입력을 열기 전에 최소한 다음이 모두 필요합니다.

- 독립 암호 설계·구현 검토
- rollback/row omission 탐지용 신뢰 checkpoint 설계
- 복구 Key Slot과 모든 수단 분실 시 영구 손실 안내
- Android hardware-backed Keystore와 생체 승인
- 동기화 충돌·기기 폐기·키 epoch 회전 검증
- 백업/내보내기/복구 훈련
- 공급망·침투 테스트와 사고 대응 절차
- Windows actual-handle Phase 0A의 mandatory ordinary suite exit 0 및 이후 별도 full Phase 0 승인
- 위 Phase 0A 조건을 충족하거나 별도로 승인된 새 권위 검증 계약과 그 gate를 통과하기 전에는 Draft PR을 Ready로 전환하거나 `main`에 병합하지 않음

## 9. 작업 로그

- 2026-08-20 01:32 KST — `codex/firstvibe-sqlite-store`와 GitHub 원격이 `cb6acb7`로 일치하는 것을 확인했습니다. 전체 workspace 기준선 테스트가 exit 0이었고, 아직 완료되지 않은 Task 6 구현 실행을 시작했습니다.
- 2026-08-20 02:54 KST — Task 6의 암호화 SQLite 종료·재실행·잠금 해제, 잘못된 비밀번호 무쓰기, 미래 버전·손상 보존, live WAL 포함 합성 평문 부재 검증을 완료했습니다. 전체 Task 6 패키지 66개 테스트와 포맷·Clippy가 통과했고, 독립 재검토에서 Critical/Important 문제가 없음을 확인한 뒤 `418a55e`까지 GitHub에 비강제 푸시했습니다.
- 2026-08-20 03:32 KST (2시간 중간 기록) — Task 7의 SQLite 커밋 전·후 프로세스 종료 원자성 테스트와 공개 API 차단 compile-fail 테스트를 로컬 `2307d4f`까지 구현했습니다. 집중 테스트·포맷·Clippy·일반 라이브러리 빌드는 통과했고 독립 리뷰를 시작했습니다. 정확한 최종 트리 전체 패키지 재실행은 Windows Application Control이 새 통합 테스트 실행 파일 하나를 실행 전에 차단해 아직 완료로 판정하거나 GitHub에 푸시하지 않았습니다.
- 2026-08-20 03:55 KST — Task 7의 공개 preflight 타입 경계를 보강한 `416f53d`까지 독립 재검토를 통과해 GitHub에 비강제 푸시했습니다. 강제 종료 테스트 2개와 trybuild 경계 테스트가 통과했으며, 전체 패키지의 한 실행 파일은 계속 오류 4551로 실행 전 차단됐다고 기록했습니다.
- 2026-08-20 05:29 KST — Task 8 전체 브랜치 리뷰에서 Critical은 없고 Important 3건이 확인됐습니다. 매핑 원격 드라이브 우회와 zero-byte 초기화 경로 바꿔치기는 수정 후 독립 재리뷰를 통과했습니다. bounded preflight는 1차 보강 뒤에도 SQLite open→첫 쿼리 사이의 더 좁은 TOCTOU가 남아 Round 2를 진행 중입니다. 합쳐진 브랜치의 preflight 24/24, 파일 소유권 10/10, 로컬 경로 정책 6/6, 포맷과 workspace Clippy는 통과했지만, 검증되지 않은 Task 8 변경은 GitHub에 푸시하지 않았습니다. 실제 Secret 입력 금지는 계속 유지합니다.
- 2026-08-29 KST — Windows actual-handle Phase 0A 격리 probe를 `3f08237`→`fe86fe2`→`6f2cec4`→`e8b29cb`로 구현·보강했습니다. 최종 독립 RED 재검토는 Spec/Quality Approved, Critical 0, Important 0이었고, 단일 pre-existing writable-mapping hard gate는 exit 0으로 정확한 sharing violation 32를 관찰했습니다. 그러나 mandatory ordinary suite는 library test 실행 전에 Windows Application Control 오류 4551로 exit 101이었습니다. **Phase 0A did not produce an authoritative result; no guarantee inferred; integration stopped.** primitive Go 관찰은 좁은 증거로만 보존하며 full Phase 0/VFS/store/real-Secret gate는 닫힌 상태입니다.
- 2026-08-31 KST — 읽기 전용 Code Integrity 조사로 `4551`의 직접 원인을 Smart App Control `VerifiedAndReputableDesktop`가 unsigned Rust test EXE를 차단한 것으로 확인했습니다. 이벤트 `3077/3089`, SHA-256 Flat Hash 일치, Authenticode `NotSigned`를 교차검증했고 정책은 변경하지 않았습니다. 원인 확인은 ordinary suite 통과가 아니므로 Phase 0A는 계속 Inconclusive입니다. 근거는 `docs/verification/windows-smart-app-control-4551-root-cause.md`에 기록했습니다. Draft PR `#1` 상태 자체를 영구적인 보안 통제로 간주하지 않으며, 위 증거 기반 gate를 통과하기 전에는 Ready 전환과 `main` 병합을 금지합니다.
- 2026-09-07 KST — PersonalProJect 아래 실제 작업 폴더에서 기본/feature 검증 경로를 보강했습니다. `scripts/verify-local.ps1`과 실패 전파 회귀 검사 11개를 추가했고 PowerShell 5.1/7에서 통과했습니다. 전체 직접 실행 최종 exit 0(기본 168 passed/1 ignored, feature 일반 6 passed/1 ignored, 문서 예제 2 passed), 전체 Clippy·포맷도 통과했습니다. 원격 기능 브랜치의 기존 SHA `f85e547`은 읽기 전용 조회로 확인했지만 오늘 변경은 미커밋·미푸시입니다. 실제 Secret/Phase 0A 승인은 유지 보류합니다. RED·BLUE 및 바탕화면 13번 기록도 갱신했습니다. 다른 편집기의 저장 여부가 확인되지 않아 종료 예약은 만들지 않았고 후속 자동화를 PAUSED로 전환했습니다. 상세 증거는 [2026-09-07 작업 기록](verification/2026-09-07-local-verification-maintenance.md)을 확인하세요.
