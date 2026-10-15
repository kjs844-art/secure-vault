# M01A — 카탈로그 HTTP 경계 검증

2026-09-28 KST. Worktree `agent-staging/keyatlas-mvp-01a-20260927`.
Branch `codex/firstvibe-mvp-01a-integration-20260927`.
시작 HEAD/origin `51f07f5f0e8b2eadac382aa1b02cd6c43bb26ba7` 일치 확인.
이번 작업은 M01A 안의 요청 경계 체크포인트다. M01A 전체나 공개 서비스 완료가 아니다.

## 바뀐 것

- `apps/benefits-web/src/server/http/`: bounded JSON reader, 요청 lifetime,
  cookie-session/origin/admission 경계, 실제 catalog controller 조합.
- `tests/bounded-json.test.ts`, `catalog-http.test.ts`, `request-lifetime.test.ts`:
  합성 입력·세션 전환·저장 경계·취소·기한·재시도 회귀.
- runtime-policy와 해당 tests: 미연결 `/api/catalog/**`는 계속 503.
- check-boundaries와 smoke-server: 서버 코드 공개 bundle 포함 금지 및 route 차단 검사.
- 앱 README/[HTTP 계약](../../../apps/benefits-web/HTTP_CONTRACT.md)과 인계 문서.

실제 인증/DB/제공자 port는 없다. 원본 benefit-validator/Lovable/DB, M02 UI,
vault/Rust, 다른 worktree는 건드리지 않았다. DB·도메인·배포 보류와 CLOSED 유지.

## 구현과 검토

첫 인증된 principal을 고정하고 모든 후속 조회에서 같은 owner/session/revision/generation을
확인한다. 본문이 사용자나 권한을 선택하지 못하며, 입장 허가는 해당 요청·행위·principal과
기한에 결합한다. 합성 port로 CRUD와 같은 작업 재시도를 실제 catalog 코드에 연결했다.

별도 담당이 JSON reader와 회귀를, 다른 담당이 HTTP 조합 회귀를 작성했다.
독립 읽기 검토의 null timeout 설정과 두 시계의 오류 분류 문제를 수정했다.
벽시계만/단조시계만 기한이 좁아진 네 경우의 회귀를 추가했다.
초기 타입 검사 두 오류와 테스트 호출 수 기대값 오기는 수정 후 아래 검사로 재확인했다.

agent-consent-patterns 원칙에 따라 처음 권한을 확대·교체하지 않고, 만료/철회를 반영하며,
실패를 무조건 rollback이라고 표시하지 않는다. 이미 commit한 뒤 응답이 막힐 수 있다.
추가 consent UI 패키지나 최종 디자인을 도입하지 않았다.

## 확인한 검사

Node 24.19.0/npm 11.17.0. 앱 명령 cwd는 `apps/benefits-web`.

| 명령 | 실제 결과 |
|---|---|
| `node --import tsx --test tests/bounded-json.test.ts` | 담당 25/25, exit 0 |
| `node --import tsx --test --test-reporter=dot tests/catalog-http.test.ts` | 담당 167/167, exit 0 |
| `node --import tsx --test tests/request-lifetime.test.ts` | 주 담당 4/4, exit 0 |
| `npm test` | 주 담당 1,170/1,170, fail/cancel/skip 0, exit 0 |
| `npm run build` | client/SSR/Nitro/TypeScript, exit 0 |
| `npm run typecheck` | 별도 담당 최종 검사 exit 0 |
| `npm run check:boundaries` | source 29/client 4, exit 0 |
| `npm run test:smoke` | loopback SSR/assets 4 및 catalog route 503, exit 0 |
| `pwsh -NoProfile -NonInteractive -File scripts/check-repository-secrets.ps1` | SECRET_SCAN_PASSED, baseline 4, CLOSED, exit 0 |
| umbrella `scripts/check-markdown-links.ps1 -Root <변경 Markdown>` | README/HTTP 계약/M01A/이 기록 4개, 각각 exit 0 |
| `git diff --check` | exit 0 |

## 원격/미검증 구분

직전 SHA `51f07f5`의 원격 실행 둘 다 completed/success로 확인했다.
진행 중 실행을 취소하지 않고 같은 handle로 끝까지 확인한 뒤 후속 push를 준비한다.

- [PR run 36366206491](https://github.com/kjs844-art/secure-vault/actions/runs/36366206491)
- [push run 36366201360](https://github.com/kjs844-art/secure-vault/actions/runs/36366201360)

새 HTTP 코드의 CI 결과는 별개다. 아직 새 SHA의 원격 성공을 주장하지 않는다.
Rust/vault 소스 변경이 없어 로컬 전체 Rust/WASM 회귀는 이번에 재실행하지 않았다.
Fetch 객체/메모리 store 검사이지 실제 HTTP framing/proxy, 운영 DB의 격리·내구성·취소,
OAuth/cookie 발급, 실제 Gmail/AI 호출, RLS, 브라우저 동작 검증이 아니다.
부분 bundle 검사도 완전한 보안 감사나 네트워크 sandbox 증거가 아니다.

HTTP handler를 공개 route에 연결하지 않는다. 실제 연결은 외부 환경 보류가 해제되고
별도 보안 검증을 통과해야 한다. main merge/배포/REAL_SECRET_GATE 개방은 하지 않았다.
