# 합성 연결 편집 UI — 부분 검증 체크포인트

기준일: 2026-09-15. 기준 내부 구현: `c6010ba`.
브랜치: `codex/firstvibe-local-session-hardening`.
실제 Secret gate: **CLOSED**. 자동 검사 통과는 제품 출시 승인이나 브라우저 검증 완료가 아니다.

## 변경 파일과 역할

- `apps/web/src/features/local-vault/SyntheticConnectionEditor.tsx`: 행별 편집 폼, 고정 MCP/CLI/CI 선택, 변경 확인, 중복 submit 차단, 삭제 의미 설명.
- `apps/web/src/features/local-vault/syntheticConnectionEditorModel.ts`: 지원 프로필의 보수적인 기본 선택 힌트, 순서 비교. 인증 경계가 아니다.
- `apps/web/src/features/local-vault/syntheticConnectionEditorModel.test.ts`: 모델 58 tests.
- `apps/web/src/features/local-vault/SyntheticConnectionEditor.test.tsx`: SSR 19 tests. 이벤트/effect/포커스/저장 검사가 아니다.
- `apps/web/src/features/local-vault/LocalCatalogSearch.tsx`: 원래 catalog entry를 유지하는 행 action 확장점.
- `apps/web/src/features/local-vault/LocalVaultPanel.tsx`: 같은 snapshot의 entries/generation으로 편집 subtree 연결.
- `apps/web/src/features/local-vault/local-vault.css`: 제한된 편집 레이아웃/포커스 표시. 최종 디자인 아님.
- `apps/web/vite.config.ts`: `.test.tsx`를 테스트 검색 대상에 포함.

## RED 관점 — 방어 검토 기록

- 필터된 배열 index로 다른 항목을 바꾸지 않도록 원래 `entry.reference`를 유지한다. 오래된 callback에서 새 generation을 읽지 않고 표시 당시 generation을 캡처한다.
- Promise가 끝났다는 이유로 저장 성공을 표시하지 않는다. 기존 세션의 CAS·전체 재인증을 통과한 catalog만 결과로 표시한다.
- 미지원 항목은 전체를 편집 불가로 처리한다. 일부 미인식 연결을 조용히 버린 기본 선택을 만들지 않는다. 이 UI 힌트는 Rust 인증/숨은 필드 검사를 대체하지 않는다.
- 선택 변경 후 확인 체크를 초기화한다. 같은 선택/순서는 저장하지 않으며 동기 ref로 중복 submit을 제한한다.
- 연결 기록 제외와 외부 서비스 연결 해제/실제 키 삭제를 구분해 표시한다. 임의 키·URL·명령 입력이나 외부 연결은 추가하지 않았다.
- 독립 읽기 전용 리뷰에서 다른 행으로 전환할 때 이전 opener가 포커스를 가져갈 수 있는 문제가 발견되었다. 명시적 취소에만 복귀 ref를 설정하도록 수정했다. 실제 브라우저 포커스 회귀는 아직 검증하지 않았다.
- `exactOptionalPropertyTypes`에 따른 타입 오류는 optional callback의 명시적 undefined 허용으로 수정했고 이후 전체 빌드가 통과했다.

## BLUE 관점 — 검증된 보호와 운영 경계

- 기존 세션/Worker/Rust의 fail-closed·generation·CAS 계약을 재사용한다. 이번 변경에 보안 코어 수정은 없다.
- 자동 테스트는 지원/미지원 프로필, 0/1/3 연결 및 순서, 텍스트 escaping, 원래 reference 전달, SSR 중 session 비호출을 확인한다.
- 잠금/저장 상태 전환 시 generation-keyed subtree로 편집 초안을 분리한다. 실제 UI 이벤트 검증은 아래 잔여 항목이다.
- 웹 conflict outbox·rollback/누락 anchor·복구/기기 키·실제 Secret 지원은 새로 구현하지 않았다.

## 자동 검사 결과

실제 작업 폴더에서 실행했다. 과거 코어 검증은 [내부 편집 기록](2026-09-15-synthetic-connection-edit.md)과 구분한다.

| 명령 | 결과 |
|---|---|
| `npm.cmd test --prefix apps/web -- --maxWorkers=1` | exit 0, 23 files / 839 tests. 첫 검사 17.29초, PUSH 직전 재검사 18.86초 |
| `npm.cmd run build --prefix apps/web` | exit 0, TypeScript + Vite, 42 modules |
| 모델 집중 테스트 | 58/58, exit 0 |
| SSR 집중 테스트 | 19/19, exit 0 |

## 실제 브라우저: 관찰한 범위만 기록

격리 Comet, loopback 개발 서버에서 합성 금고를 생성·열고 항목 3개를 확인했다.
예시 3의 편집 폼에서 MCP/CLI/CI 기본 체크, 확인 미체크, 저장 버튼 비활성 상태를 snapshot으로 관찰했다.
그 뒤 조작 도구가 `Daemon version mismatch detected` / `CDP response channel closed`를 보고했다.
후속 DOM/포커스 자동 assertions는 완료되지 않았다. `doctor --offline --quick`도 완료 전 중단되어 진단 성공으로 처리하지 않는다.

사용자가 현황 정리를 요청하여 새 구현/브라우저 검사를 중단했고 개발 서버를 Ctrl+C로 종료했다.
이 종료의 exit 1은 의도적인 중단이며 빌드 실패가 아니다. 개인 브라우저 프로세스를 임의로 종료하지 않았다.

미검증: 실제 저장/취소, 확인 reset 이벤트, 중복 클릭, 필터 후 참조, 포커스 이동/복귀,
잠금 중 늦은 결과, 새로고침/재열기, 충돌, 모바일 화면, 실제 디스크 백업 왕복.
따라서 이번 UI는 **자동 검사를 통과한 부분 체크포인트**로만 백업한다.

## 다음 시작점

1. 정상 작동하는 격리 브라우저 환경에서 위 미검증 UI 시나리오를 합성 데이터로 확인한다.
2. 실패가 있으면 수정 후 관련 자동 검사와 브라우저 회귀를 수행한다.
3. UI 검증 완료와 별도로 durable conflict outbox·회전/복구·기기 키·동기화 작업을 이어간다.

전체 일정/다른 기기와 AI 담당안은 [공유 가이드](../KEYATLAS_PROJECT_SHARED_GUIDE.md)를 참고한다.
