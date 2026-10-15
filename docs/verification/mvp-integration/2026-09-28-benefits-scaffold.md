# M01A — 독립 benefits 웹 첫 코드 체크포인트

실행일: 2026-09-27~28 KST. 검증 환경: Windows, Node 24.19.0, npm 11.17.0.
대상: `codex/firstvibe-mvp-01a-integration-20260927`.
변경 전 HEAD/origin: `9ca4995069895e9fba8e48e377e176438e1199fe`, clean 확인.
이 보고서가 포함된 후속 커밋이 코드 체크포인트다.
원본 고정 SHA: `954da8da0b12d55a342d187fab17abe57b93fbb0`.

## 구현한 범위

- `apps/benefits-web/` 독립 React/TanStack Start/Nitro Node SSR 패키지와 lockfile.
- 원본 per-request QueryClient, Korean document shell, 명시적 CSRF middleware를
  선택적으로 유지. Lovable 전용 Vite/MCP 플러그인, 원본 route tree, install patch,
  auth hook, 원격 폰트, 오류 수집기는 가져오지 않았다.
- `/` 기술용 안내 및 `/status` 고정 공개 상태 서버 함수/화면.
  `/api/integration-status`는 고정 공개 JSON만 반환한다.
- 미연결 로그인/Gmail/MCP/실데이터 route는 서버에서 503.
  지원하지 않는 runtime mode와 내부 예외도 고정 코드로 거부한다.
- Vite .env 자동 로딩/공개 prefix 비활성, local launcher 부모 환경 allowlist,
  loopback bind, 요청 오류/원문을 반환/출력하지 않는 자체 wrapper.
- 원본 benefits 타입/한국어 label/export format 식별자와 순수 규칙 이식.
  unknown/0, overflow, 단위, 월말/윤년, microseconds, 관찰 날짜/시간대 회귀.

원본 디자인을 대체하지 않는다. 이 화면은 M02가 실제 기존 웹 화면을 연결하기 위한
기술용 placeholder다. M02 예약 파일과 기존 vault 소스는 수정하지 않았다.
실제 provider credential, 메일, 운영 DB, 금고 파일을 입력/조회하지 않았다.

## 검사

아래 앱 명령은 `apps/benefits-web`에서 실행했다.
이 표는 로컬 결과이며 원격 CI 성공으로 해석하면 안 된다.

| 검사 | 범위 / 결과 |
|---|---|
| `npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org` | 최종 재설치 exit 0 |
| `npm test` | 49/49 통과, 실패/skip 0, exit 0; domain 포함 23개 |
| `npm run build` | client + SSR + Nitro + TypeScript exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run check:boundaries` | source 10 / client 4 파일, import/env/version/registry/integrity/bundle marker 검사 exit 0 |
| `npm run test:smoke` | loopback SSR/asset 4/status/not-connected/404/own-child cleanup exit 0 |
| `npm audit --json --registry=https://registry.npmjs.org` | exit 0, advisory 조회 0건. 전체 안전성 보장은 아님 |
| 저장소 `scripts/check-repository-secrets.ps1` | exit 0 / baseline 4 / SECRET_SCAN_PASSED / REAL_SECRET_GATE=CLOSED |
| 문서 relative link / `git diff --check` | README 상대 경로 오류 수정 후 문서 8개 링크 검사 exit 0, diff check exit 0 |

Browser: Codex in-app browser, `http://127.0.0.1:4317/`.
홈 → typed Link `/status` → 홈 이동을 직접 확인했고 고정 not-connected/CLOSED 상태가
화면에 표시되었다. 이 관찰 구간의 console error/warn 0건. 페이지의 script/CSS URL은
관찰된 loopback 주소였고 입력 필드는 없었다. 모든 네트워크 흐름을 캡처한 것은 아니다.
이는 제한된 SSR/hydration/navigation 증거이며 모바일, 실사용 인증 또는 메일 E2E가 아니다.
개발자가 만든 테스트 탭/서버만 정리하며 다른 Node/IDE 프로세스를 종료하지 않는다.
테스트 탭을 닫고 자기 로컬 서버를 Ctrl+C로 종료한 뒤 4317 listener 부재를 확인했다.
최종 연속 검사 전체 exit 0 및 `FINAL_BENEFITS_CHECKS_PASSED`를 확인했다.

## 독립 리뷰와 반영

- 서버 경계 리뷰: 실제 donor 환경/host marker 추가,
  smoke의 redirect 추적 금지로 검사 출력과 실행 범위를 일치시켰다.
- 리뷰 제안의 README 상대 경로는 실제 링크 검사에서 실패하여 `../../docs`로
  바로잡았다. 정적 리뷰 의견도 파일/실행 증거와 대조하며 자동으로 정답으로 처리하지 않는다.
- domain 리뷰: 유효한 DB microseconds 거부 회귀 및 날짜만 기록한 관찰의 시간대
  미래 판정 누락을 수정. 표시/검토 여부에 공통 metadata 검증을 적용했다.
- 다시 검토하여 두 domain 문제 해결 및 새 must-fix 없음 확인.
  독립 reviewer는 domain 23/23 exit 0도 실행했다.
- 별도 review 없는 무제한 수학/보안 정확성을 주장하지 않는다.
  날짜 반복은 원본과 같이 UTC anchor 기준이며 모든 제공자의 DST 정책을 아는 것이 아니다.

## 아직 하지 않은 것

- 원본 demo/실제 UI 전체 이식, 사용자 최종 디자인, 모바일 브라우저 검증.
- 실제 로그인/Google OAuth/Gmail/외부 AI/MCP/DB/RLS/삭제/복구 E2E.
- 완전한 production CSP, rate limiting, 운영 장애/비용/동의/알림/백업 정책.
- 기존 vault Rust/WASM/Web 전체 회귀 재실행. 이번 변경은 별도 앱이며 그 소스는 변경 없음.
- vault B05 실제 파일 다운로드→새 프로필 복원. 기존 BLOCKED 근거는 별도 유지.
- 새 앱을 기존 GitHub CI 명령에 연결하거나 원격 CI 성공 확인.
- main merge, 새로운 PR, 도메인/계정 생성, 실제 배포.

Git 상태, 로컬/원격 SHA 일치와 CI/PR 상태는 별도의 실제 GitHub 확인으로 보고한다.
`REAL_SECRET_GATE=CLOSED`. 체크포인트는 전체 M01A/2주 목표/전체 서비스 완료가 아니다.
