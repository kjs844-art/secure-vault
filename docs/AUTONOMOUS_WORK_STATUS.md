# KeyAtlas 자율 작업 상태표

기준: 2026-09-16, `codex/firstvibe-local-session-hardening`.
전체 목표는 사용자 결정(도메인, 배포, 디자인 등)을 제외한 구현·검증의 진행이다. 이 표는 범위를 줄인 완료 선언이 아니다. 제품 요구 기준은 [MVP](MVP.md)와 [보안 설계](SECURITY_ARCHITECTURE.md)를 유지한다.

별도 `codex/firstvibe-synthetic-rotation-checklist` 체크포인트: 합성 연결처의 필수 완료 조건을 확인하고 최종 암호문 후보만 생성하는 코어를 추가했다. 독립 소스 리뷰와 코어 Clippy/format/Secret scan은 통과했으나 Windows 앱 제어 4551로 최종 테스트 실행은 보류됐다. 단발성 코어이며 후속 회전·연결 편집·UI는 미지원이다. [검증 기록](verification/2026-09-16-synthetic-rotation-cutover.md)의 원격 검증 상태를 확인한다.

## 현재 확인한 것

| 항목 | 현재 증거 | 남은 일 |
|---|---|---|
| 암호화/필드 보존 | 기존 코어, 후속 67개 필드 비교 검사 cherry-pick | 통합 상태의 네이티브 회귀, 독립 리뷰 |
| 로컬 웹 저장/복원 | IndexedDB·Worker·WASM 구현, 통합 웹 전체 932 tests; 합성 등록 후 저장본 재열기·새로고침 확인, v3 편집·충돌 보존·검토 UI·백업 guard는 실제 WASM+fake IndexedDB 검증 | 파일 다운로드 경로, 실제 브라우저 다중 writer/오프라인 통합 검사 |
| 자동 잠금 | 5분/숨김/절전 후 만료/시계 오류 처리, 신규 18 tests | 실제 브라우저·모바일 수명 주기 확인 |
| 키와 연결처 목록 | 계정/workspace/project/환경 private projection·검색; 실제 Comet에서 3→6개 등록, 0/1/3 연결과 순서 보존, 검색·잠금·재열기·360px 검사 | 임의 데이터 수동 등록/편집, 회전 체크리스트, 실제 모바일/큰 목록 검증 |
| 합성 백업/복원 | 기존 경로에 미해결 conflict export fail-closed guard 추가; 집중 192 tests, 전체 웹 932 tests, 별도 브라우저 복원 후 암호문 SHA-256 일치 | 목록 확인 직후 새 conflict가 생기는 비원자 TOCTOU, 디스크 다운로드·네이티브 파일 선택 왕복 미검증. 실제 데이터용 기능 아님 |
| 로컬 도구 경계 | 입력 64 tests + 세션 62 tests; 격리 Comet 검색/분류/잠금/재열기/숨김 검사, 중복 React key 수정 후 콘솔 경고 0 | 외부 AI/MCP 연결·개인 projection 승인 아님; 실제 모바일 검증 별도 |
| 웹 등록 화면/저장 경로 | 닫힌 2프로필/0~3연결 폼 → archive v2 → Worker/세션 CAS → 저장본 전체 재인증; 실제 브라우저 이중 클릭 한 번 저장·계정 정보 보존·탭 전환 잠금 확인 | 합성 선택형만 지원. 편집 UI 실제 저장/회전·rollback/누락 보장은 아직 없음 |
| 웹 연결 편집 내부 경로 | 같은 record의 successor·immutable v3 이력/명시적 head·표시 bytes+generation 결합·후보 사전 인증·원자 CAS/재인증, Rust release 30 tests 및 실제 demo WASM 973 checks | 실제 브라우저 편집 Worker/IDB 미검증, 회전·signed rollback/누락 anchor 미구현 |
| 암호문 conflict outbox | DB v1/store 유지, 최대 8개 무퇴거 후보, CAS loser 보존, 전체 인증 뒤 위치 기반 검토, exact-byte 2단계 폐기, 미해결 후보 backup 차단 | 자동 병합·승격 정책과 outbox 포함 백업 형식, 실제 브라우저 멀티탭·모바일 검증 |
| 웹 연결 편집 UI | 검토 UI 포함 통합 웹 932 tests, typecheck/build exit 0; 독립 보안 리뷰 Critical/Important 0 | 저장/취소/포커스/잠금·멀티탭 충돌의 실제 브라우저 검증과 모바일 검증 |
| 공유 메모리 입력 경계 | Store·Session·Worker client/worker·Backup에서 SharedArrayBuffer를 DB/Worker/WASM 작업 전에 고정 오류로 거부 | cross-origin-isolated 실제 브라우저의 동시 변경 통합 검사는 미실행 |
| 원격 CI 보안 gate | 최소 권한 Windows workflow와 구조 회귀 9 tests 작성; 외부 검색 실행기 없는 내장 Secret scan을 첫 저장소 명령과 웹 build 뒤에 배치. 기존 `5d439eb` 원격 run `35046207820`은 첫 Secret 단계에서 fail-closed 종료 | built-in 후속판은 로컬 PS7·5.1 각 99/99와 정책 9/9 통과, 이 기록 시점 원격 재실행 전. branch protection은 별도 |
| SQLite 읽기 전용 preflight | 8 DB_CONFIG를 첫 SQL 전에 적용하고 query_only와 공통 hardening을 읽기 전용 연결에도 강제; 패키지 91 passed/1 ignored, 독립 재리뷰 Critical/Important 0 | 악성 schema 실제 통합 fixture와 WR 대칭 profile assertion은 residual |
| 네이티브 전체 QA | `5d439eb` 기능 묶음 기준 Workspace Secret scan·format·Clippy·tests·ordinary VFS·doctests exit 0. 후속 scanner-only 트리는 집중 회귀와 실제 저장소 scan 통과 | 후속판 전체 Workspace 재실행과 명시적으로 ignored인 Phase 0A 보안 gate·권위 승인은 별도 필요 |

## 이어서 할 수 있는 구현

1. 합성 백업·복원의 디스크 다운로드/네이티브 선택 검증을 지원되는 환경에서 보완한다. 브라우저 File API로 전달한 검사는 실제 파일 다운로드 성공과 구분한다. [통합 검증 기록](verification/2026-09-15-backup-session-integration.md)을 따른다.
2. 연결된 합성 편집 UI의 [부분 검증 기록](verification/2026-09-15-synthetic-connection-editor-ui.md)에 따라 실제 브라우저 저장/취소/포커스/잠금/변경/충돌을 검증한다. row reference와 generation은 같은 표시 snapshot에서 캡처하며 합성 선택형과 Claude Code 디자인 경계를 보존한다.
3. durable conflict outbox의 저장·인증 목록·명시적 exact-byte 폐기와 백업 차단 경계는 구현했다. 실제 브라우저 다중 창 검증 뒤 자동 재시도·병합·승격·퇴거를 열지 않은 채 회전 상태 전이·갱신 체크리스트로 진행한다.
4. 외부 계정 없이 검증 가능한 API 계약·동기화 충돌 모델·로컬 테스트 환경을 명세에 맞춰 준비한다. 클라우드 연결을 했다고 주장하지 않는다.
5. 보안 수명 주기·복구·기기 해제의 미결 설계와 구현 증거를 비교하고, 사용자 선택이 필요한 부분과 독립 리뷰가 필요한 부분을 분리한다.

각 항목은 테스트·빌드·실제 동작 범위를 명시한 체크포인트로 남긴다. 모두 끝날 때까지 목표는 active이며 좁은 테스트 통과를 서비스 완성으로 대체하지 않는다.

## 사용자 또는 별도 권한/리뷰가 필요한 경계

- 서비스명/도메인, 최종 디자인, 공개 배포, 운영 DB/IAM 및 결제 계정 선택.
- 가격·결제 활성화, 개인정보·법률 문서 확정, 앱스토어 제출.
- 실제 Secret 입력 개방, 사용자 키/복구 방식의 미결 결정 및 독립 보안 검토.
- OS 앱 제어 정책 변경/예외는 자율 실행 범위 밖. main 병합도 별도 승인 대상.

현재 사용자에게 위 항목을 즉시 결정하라고 요구하지 않는다. 안전하게 독립 진행할 수 있는 구현이 남아 있다.

## 현황 공유·다른 기기 협업

[2026-09-15 갱신 공유 가이드](KEYATLAS_PROJECT_SHARED_GUIDE.md)에 조건부 기간, 작업 경로, 역할/브랜치 제안 및 병렬 협업 범위를 정리했다. 같은 본문을 사용자 요청의 바탕화면 파일에도 반영했다. 이전 9월 12일 본문은 archive에 보존한다.
기기 연결·원격 제어·연산 오케스트레이션은 KeyAtlas 밖의 비공개 운영 저장소에서 관리한다. KeyAtlas에는 별도 clone/worktree, 담당 파일, base/head SHA, 재현 가능한 검사 명령과 종료 코드만 남기며 장치·계정·접근 설정은 기록하지 않는다.
