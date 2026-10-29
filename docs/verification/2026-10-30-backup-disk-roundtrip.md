# 합성 백업 실제 파일 왕복 검증

## 범위와 현재 상태

**현재 상태: 합성 데이터의 실제 디스크 왕복을 Chrome·Edge에서 검증함. 실제 Secret 출시는 아님.**

기준 SHA: `6211b276c462defc2d6ad2e58baff62a1c0bf684`.
작업 브랜치: `codex/firstvibe-backup-roundtrip-20261030`.
기존 [백업 통합 기록](2026-09-15-backup-session-integration.md)에서 분리한
실제 다운로드와 빈 브라우저 저장소 복원(B05)의 증거 공백을 다룬다.
기존 [원자 백업 snapshot](2026-09-17-atomic-backup-snapshot.md)의 보장 범위를
확대하거나, 현재 파일이 최신 금고라는 증명을 추가하는 작업이 아니다.

기존 운영 화면의 `/?view=local-vault` 및 `/?view=synthetic-backup` 경로를
프로덕션 방식으로 빌드한 로컬 산출물로 검사한다. 실제 서비스 배포는 아니다.
공개된 합성 비밀번호와 fixture만 사용하며 **REAL_SECRET_GATE=CLOSED**다.
새 금고 UI, 새 복구 정책, 실제 자격 증명 입력, 서버 연결은 만들지 않는다.

## 실제 관찰 결과

| 경로 | 직접 확인한 증거 | Chrome / Edge |
| --- | --- | --- |
| 합성 금고 생성 | 기존 화면 버튼 → 실제 Worker/WASM → IndexedDB 저장 및 인증된 목록 | PASS / PASS |
| 실제 다운로드 | 실제 download 이벤트 완료, 디스크에 저장, 출처 context 종료 후 파일 재읽기 | PASS / PASS |
| 빈 저장소 복원 | 다른 빈 격리 context, 디스크 파일을 선택한 File input, 명시적 복원 뒤 잠김 | PASS / PASS |
| 복원 후 재열기 | 명시적으로 금고 열기, 고정된 3개 합성 항목의 제공자·필드·연결 의미 일치 | PASS / PASS |
| 다시 내보내기 | 실제 재다운로드 후 context 종료, 최초 파일과 바이트·SHA256 일치 | PASS / PASS |
| 기존 금고 보존 | 기존 금고에 손상 파일 복원을 요청하면 거부, 암호문·재열기 결과 보존 | PASS / PASS |
| 잘못된 파일 | 손상·미래 버전·잘못된 헤더 각각 거부, archive 없음과 정확한 빈 구조 확인 | PASS / PASS |
| 격리·정리 | 오류 계수 14종 모두 0, context 5개와 browser/server 정리 확인 | PASS / PASS |

파일 선택은 테스트 도구로 **실제 디스크 경로를 브라우저 File input에 전달**한다.
앱 메모리에서 File을 합성하거나 download click을 가로채 만든 파일을 복원하는 것과
구분한다. 네이티브 Windows 선택창에서 사람이 파일을 고르는 UI를 검증했다는 뜻은 아니다.
새 BrowserContext는 origin 저장소가 분리된 새 컨텍스트이며 별도 OS 계정이나
브라우저 설치/영구 프로필 재시작의 증거로 부르지 않는다.

## 고정 실행 근거

두 실행 모두 Windows, Node 기존 설치, Playwright `1.63.0`, headless,
`ko-KR`, `Asia/Seoul`, 1280×900 조건이다. 제품 입력의 커밋 차이·작업 트리 차이는
각각 0이며 시작/종료 HEAD는 위 기준 SHA와 같았다. 도구·보조 모듈·잠금 파일 및
빌드 자산의 시작/종료 해시도 일치했다.

| 항목 | Chrome | Edge |
| --- | --- | --- |
| 실제 버전 | 156.0.8078.49 | 156.0.4314.50 |
| UTC 시작–종료 | 2026-10-29 17:38:01–17:38:16 | 2026-10-29 17:51:20–17:51:39 |
| 전체 결과 / 종료 코드 | PASS / 0 | PASS / 0 |
| 검사 묶음 | 13 / 13 | 13 / 13 |
| 다운로드 파일 크기 | 3,892 bytes | 3,892 bytes |
| 고정 의미 검증 | 3개 항목, MCP/CLI/CI 연결 수 0·1·3 | 동일 |
| 잘못된 파일 거부 | 3종 | 3종 |
| 소유 자원 정리 | confirmed=true | confirmed=true |
| 로컬 증거 식별자 | backup-roundtrip-tEgle6 | backup-roundtrip-JB57Bk |
| result.json SHA256 | 9ca9d6b49521d5363034c5e28787d3a33b310eb5ee3cba48732d8d86f7771b62 | 74f32ebb629db5df76c7913ec411c74fe992fca98b2d31ced970974ae4202b05 |

각 실행이 새로 생성한 금고의 암호문은 서로 다를 수 있다. 일치 판정은 **각 실행 안에서**
출처 저장소 → 실제 다운로드 → 복원 저장소 → 실제 재다운로드를 비교한다.
서로 다른 실행의 암호문이 같아야 한다는 주장은 하지 않는다.
소유 증거 폴더는 ignored `target/reports/` 아래에만 보존하며 원본 암호문·손상 fixture는
Git/PR/Drive에 올리지 않는다. 공개 근거는 이 요약과 지문으로 제한한다.

검사 도구의 고정 지문:

- runner: `58d61a5285370d9bd2931d9777772a97eea1636e446b681ea17487ae8dcd2531`
- contract: `f9d6b6368f4c7373c6adf1635350b0d01b15e9b72bb4bc7d3cdf7216ac9889a0`
- contract test: `2d919e80c12f49a6ee68d234875cf6ff8cfc11352f9a15f5c225bd215742bb9c`
- dist index: `64cadaaff8e4391fab87c434826f2058db87061d0d1f0e260ffe982d870f4303`
- dist assets aggregate: `487b043d6be1eb0b8b2911a6fef088a546448acd4907612aec1ec3fa843c3c89`

검사 도구는 기준 SHA의 후손 커밋도 허용하지만, 보호된 제품 입력에 차이가 있으면 거부한다.
빌드 지문이 바뀌면 기존 근거를 재사용하거나 상수를 무조건 갱신하지 말고 새 빌드의 출처부터 확인한다.

## 명령과 검사 상태

저장소 루트에서 실행한 명령이다. 실제 브라우저는 한 번에 하나만 실행했다.

```powershell
node --check apps/web/scripts/verify-backup-roundtrip-browser.mjs
node --check apps/web/scripts/support/backup-roundtrip-contract.mjs
node --check apps/web/scripts/support/backup-roundtrip-contract.test.mjs
node --test apps/web/scripts/support/backup-roundtrip-contract.test.mjs
node apps/web/scripts/verify-backup-roundtrip-browser.mjs --synthetic-only --preflight --channel=chrome
node apps/web/scripts/verify-backup-roundtrip-browser.mjs --synthetic-only --preflight --channel=msedge
node apps/web/scripts/verify-backup-roundtrip-browser.mjs --synthetic-only --channel=chrome
node apps/web/scripts/verify-backup-roundtrip-browser.mjs --synthetic-only --channel=msedge
```

- 구문 검사 3개: 각각 exit 0.
- 순수 계약 테스트: 4/4 PASS, exit 0. 잘못됐지만 서로 같은 의미 목록도 거부하는 고정 oracle 포함.
- preflight: 각각 exit 0, `browserStarted=false`. 인자 검사만이며 실제 브라우저 결과와 구분.
- 잘못된 CLI 인자: 기대한 `BLOCKED / SYNTHETIC_ARGUMENTS_REQUIRED`, exit 2.
- 실제 Chrome·Edge: 위 표대로 각각 exit 0.
- CI에 순수 계약 테스트를 추가했다. 브라우저 설치/실행이나 원본 암호문 artifact 업로드는 추가하지 않았다.
- CI 정책 파일의 AST 파싱 및 새 4개 It 블록 직접 검증: exit 0. 정상 배치와 16개 잘못된 변형 거부를 확인했다.
- **로컬 Pester 5.7.1 실행: NOT_RUN.** 설치된 3.4와 혼동하지 않는다. 새 CI 커밋의 실제 원격 Pester 결과가 따로 필요하다.
- 고정 3개 도구 파일 및 CI/정책 변경을 독립 읽기 검토했고 남은 차단 지적은 없었다.

이전 PR44의 원격 Pester 92개 PASS는 이 신규 4개 It의 실행 증거가 아니다.

## 실행 및 증거 원칙

- 설치된 브라우저만 사용한다. 사용자 프로필·실제 금고·기존 브라우저 탭은 열거나 정리하지 않는다.
- 서버는 `127.0.0.1`의 임의 포트에서 고정 빌드 자산만 제공한다. 환경 파일이나 소스 파일을 제공하지 않는다.
- 실행 전 빌드/소스/검사 도구의 지문과 실행 인자를 고정한다. PASS 결과를 재실행으로 만드는 대신 바뀐 입력이 있을 때만 다시 검사한다.
- 다운로드·손상 fixture는 실행별 소유 임시 디렉터리 안에만 만든다. 원본 프로젝트의 데이터·브라우저 사용자 파일은 수정하지 않는다.
- 결과에는 고정 오류 코드·검사 이름·횟수·크기·지문만 남긴다. 암호문 파일 자체, 원문 예외, URL query나 사용자 파일명은 Git에 올리지 않는다.
- 기능 검사가 통과해도 정리가 실패하거나 예상 밖 오류가 있으면 전체 결과는 FAIL이다. 늦은 종료는 앞선 timeout을 PASS로 바꾸지 않는다.

## 기존 검사와 구분

이 기준의 기존 웹 단위 검사 2,122개, typecheck/build와 원격 CI는 그대로 별도 근거다.
이 새 파일 왕복 검사를 실행했다는 증거로 대신하지 않는다. 새 도구가 제품 코드나
의존성을 바꾸지 않으면 그와 무관한 성공한 전체 Rust/웹 suite를 반복하지 않는다.
새 도구 자체에는 문법/순수 검사/독립 읽기 검토와 실제 브라우저 실행 결과가 필요하다.

## 미검증 및 출시 제한

- 네이티브 OS 파일 선택창 수동 조작, 실제 Windows/브라우저 프로필 종료·재실행, 모바일/기기간 복원.
- 디스크 flush/전원 차단 내구성, 사용자 파일 삭제·복구, 실제 백업 보관/암호 재설정 정책.
- canonical 최신성, 전체 rollback/누락 탐지, 충돌을 포함한 백업 형식, 원본 이후 변경의 자동 동기화.
- 실제 사용자 인증·비밀번호/API 키·생체 인증·독립 암호 감사·실제 Secret 출시.

기존 실패/미검증 기록은 이 결과로 소급 삭제하지 않는다. 본 검증은 전체 제품의
완료 판정이나 실제 비밀정보를 저장해도 된다는 승인과 별개다.
