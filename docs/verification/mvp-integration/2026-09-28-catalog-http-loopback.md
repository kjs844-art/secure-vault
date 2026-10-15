# M01A-2A — 합성 loopback HTTP 통합 QA 검증

2026-09-28 KST. Branch `codex/firstvibe-mvp-01a-2a-http-qa-20260928`.
시작 HEAD `32856a6eecfedf19848bffb63d77c84332955600` 일치 확인.

이번 작업은 M01A의 loopback HTTP QA 위임 담당이다. 기존 Fetch 객체 직접 전달
테스트(`tests/catalog-http.test.ts`)와 달리, 테스트가 소유한 127.0.0.1 임시
서버에서 실제 HTTP 요청·응답·연결 종료를 통해 요청 경계를 검증한다.
M01A 전체나 공개 서비스 완료가 아니다.

## 바꾼 것

- `apps/benefits-web/tests/support/catalog-http-loopback.ts`: 127.0.0.1 port(0)
  임시 서버 fixture. 합성 session/admission/memory adapter만 주입하고 운영
  route에 mount하지 않는다. 소켓 body를 web ReadableStream으로 변환해
  Request 생성 전 무제한 buffering 없이 handler에 넘긴다. handler의
  byte ceiling·deadline·취소가 실제 HTTP framing을 관찰한다. body cancel은
  소켓을 파괴하지 않고 drain해 고정 오류 응답(413/415 등)이 클라이언트에
  도달하게 유지한다. 연결 끊김은 AbortSignal로 request에 전파되며,
  fixture close는 진행 중 응답 settle을 bounded 대기 후 소켓을 정리한다.
- `apps/benefits-web/tests/catalog-http-loopback.test.ts`: 실제 loopback CRUD
  및 same-operation retry, origin/marker/route/method/cookie 거절, media
  type/size/malformed body 거절, 세션 전환 403, 요청 기한 408과 늦은 adapter
  응답 미기록, commit 전 중단(미commit 확인)과 commit 후 응답 상실(rollback
  아님, 동일 operation ID 재시도 안전), Node HTTP 파서의 framing 거절과
  handler 거절 구분, 서버 종료 후 소켓/listener 정리를 확인한다.

수정한 파일은 이 두 개와 이 기록뿐이다. 운영 source/routes/server, 기존
test/helper, manifest/lock, CI, smoke-server, 배포 문서는 수정하지 않았다.
프로덕션 결함은 발견하지 못했다.

## 실제 요청 관찰 범위와 미검증 구분

실제 Node HTTP framing에서 거절된 요청(비-HTTP 바이트 → 서버 400, handler
미호출)과 handler가 거절한 요청(고정 코드 JSON)을 구분했다. 세션/admission/
DB는 합성 adapter이며 실제 인증/DB/limiter/proxy/TLS/브라우저 cookie·CORS
정책은 검증하지 않았다. commit 후 응답 상실 시 rollback을 약속하지 않고
fixture commit 상태(store.controls.commits/rollbacks)를 별도로 확인했다.

## 확인한 검사

Node 22.23.2. 앱 명령 cwd는 `apps/benefits-web`.

| 명령 | 실제 결과 |
|---|---|
| `npx tsx --test tests/catalog-http-loopback.test.ts` | 담당 11/11, fail 0, exit 0 |
| `npm test` | 전체 1,181/1,181 (기존 1,170 + 신규 11), fail/cancel 0, exit 0 |
| `npm run build` | client/SSR/TypeScript, exit 0 |
| `npm run typecheck` | 별도 담당 최종 검사 exit 0 |
| `npm run check:boundaries` | source 29/client 4, exit 0 |
| `npm run test:smoke` | loopback SSR/assets 4 및 미연결 catalog route 503 유지, exit 0 |
| `git diff --check` | exit 0 |

## 남긴 메모

- 요청 abort 후 commit 여부는 fixture 기준으로만 확인했다. 실제 DB에서의
  commit-then-lose 경로는 운영 배치 시 별도 확인이 필요하다.
- `tests/catalog-http-loopback.test.ts`의 세션 반복 조회 횟수는 handler
  구현(현재 요청당 6회 이상)에 의존한다. 조회 횟기를 고정하지 않고
  하한으로만 검증했다.
