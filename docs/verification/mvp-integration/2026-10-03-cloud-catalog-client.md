# Cloud catalog client 보완 검증

2026-10-03. LOCAL_CODE_COMPLETE / LOCAL_CHECKS_PARTIAL.
`REAL_SECRET_GATE=CLOSED`. 합성 데이터만 사용했다.

## 기준과 소유 파일

- checkout: `/workspace/secure-vault`
- branch: `codex/firstvibe-cloud-catalog-client-fix-20261003`
- HEAD: `afbc0fbc4dd41669e468d8658965ef8f5f10ee7d` (새 commit 없음)
- 재사용 원본 PR #22: `3230b1ae6fa9b062f1804c04e8439a9a99f14575`
- 원격 main: `65d10dceb13039dc69cf2368aa0e31d7ad5cc6b2`
- 로컬의 미푸시 readiness 9개 파일: NOT_RECEIVED. 그 파일의 통합/검증 완료를 주장하지 않는다.

현재 HEAD에 없던 원본 4개 모듈과 기존 테스트를 명시적으로 가져왔다.
전체 PR branch나 CI·설정·인계 변경을 가져오지 않았다.

| 파일 | 처리 |
| --- | --- |
| `apps/benefits-web/src/domain/catalog-client/client.ts` | PR #22 재사용 후 아래 제한/실패 처리 보완 |
| `apps/benefits-web/src/domain/catalog-client/index.ts` | PR #22 byte-identical |
| `apps/benefits-web/src/domain/catalog-client/requests.ts` | PR #22 byte-identical |
| `apps/benefits-web/src/domain/catalog-client/responses.ts` | PR #22 byte-identical |
| `apps/benefits-web/tests/catalog-client.test.ts` | PR #22 기존 12개 검사 그대로 |
| `apps/benefits-web/tests/catalog-client-lifetime.test.ts` | 추가 회귀 18개 |
| `docs/handoff/mvp-20260927/SERVICE_READINESS_2026-10-03.md` | 완료/잔여 작업·공수/출시 추정 |
| 이 문서 | source·명령·exit·검증 범위 기록 |

기존 미추적 9/30 문서 5개 hash는 보존했다. 기존 tracked source, server reader/time/size 제한,
인증/암호/CI, dependency/version/lockfile은 변경하지 않았다. 생성물과 node_modules는 ignored다.

## 원인과 보완

원본의 timeout은 transport abort 신호에만 의존했다. 응답 본문은 전체 수집 뒤 크기를
판정했고, UTF-8 실패를 고정 결과로 변환하지 않았다. 기존 12개 검사만으로 이 경계가
충분히 검증되지 않았다. 합성 회귀 4개는 수정 전 모두 실패(exit 1)했고 수정 후 통과했다.

- client 안의 browser-safe streaming reader가 실제 누적 byte를 1 MiB로 제한한다.
  한도를 넘긴 chunk는 저장하지 않고 더 읽지 않는다. UTF-8/JSON/read 실패는 `invalid/BODY`다.
- fetch와 각 body read는 같은 전체 deadline을 사용한다. abort를 무시하는 주입 adapter도
  호출 결과를 붙잡지 못하며, timer가 늦게 실행돼도 monotonic deadline을 다시 확인한다.
- 기존 호출에 선택적 두 번째 `AbortSignal`을 추가했다. 취소 원문은 반환하지 않는다.
  종료 때 소유 reader를 cancel/release하고 timer/listener를 정리한다. 늦은 body는 폐기한다.
  cancel acknowledgement가 멈춰도 결과 반환은 기다리지 않는다.
- 고정 POST/header/credentials/redirect, 요청 builder·응답 schema, 원래 operation ID는
  유지한다. 자동 mutation retry는 없다. timeout/abort를 저장 rollback 증거로 표시하지 않는다.

UI의 로그인/계정 전환 scope 포착과 reducer 연결은 이번 보완의 완료 범위가 아니다.
실제 auth/DB/provider를 구현하지 않았고 `/api/catalog/**`의 503도 유지된다.
cancel은 협조적인 upstream 작업을 멈추도록 신호하는 것이며, adapter의 부작용이나
이미 commit된 작업의 취소를 보장하지 않는다.

## 실행한 명령과 정확한 exit

Node `v24.19.0`, npm `11.9.0`, TypeScript `5.9.3`, PowerShell `7.6.6`, Rust `1.95.0`,
Chromium `151.0.7922.173`. 기존 README의 frozen `npm ci --ignore-scripts --no-audit --no-fund`
설치로 준비된 benefits 의존성을 재사용했다. 새 설치·version/lockfile 변경은 없다.
검사 대상은 위 HEAD **+ 소유 미커밋 6개 코드/검사 파일**이며 HEAD 자체의 CI 결과가 아니다.

| cwd / 대상 | 정확한 명령 | exit | 결과 |
| --- | --- | ---: | --- |
| `apps/benefits-web`, 원본 #22 파일 | `node --import tsx --test tests/catalog-client.test.ts` | 0 | 12/12 |
| 같은 cwd, 수정 전 client + 첫 회귀 4개 | `node --import tsx --test tests/catalog-client-lifetime.test.ts` | 1 | 0 passed / 4 failed, 기존 경계 확인 |
| 같은 cwd, 최종 client | `node --import tsx --test tests/catalog-client.test.ts tests/catalog-client-lifetime.test.ts` | 0,0,0,0,0 | 5회 각각 30/30, skip 0. 무조건 실패 재시도 없이 모두 기록 |
| 같은 cwd | `node --import tsx --test tests/bounded-json.test.ts` | 0 | 25/25 |
| 같은 cwd | `npm test` | 0 | 1,338/1,338, skip 0 |
| 같은 cwd | `npm run build` | 0 | client/SSR/server build + 타입 |
| 같은 cwd | `npm run typecheck` | 0 | 타입 |
| 같은 cwd | `npm run check:boundaries` | 0 | source 44/client files 8 정적 경계 |
| 같은 cwd | `npm run test:smoke` | 0 | 자체 loopback SSR·asset·503·status smoke |
| `apps/web` | `npm test` | 0 | 50 files / 1,698 tests. 현 금고 웹 합성 회귀이며 새 WASM 생성 증거는 아님 |
| 같은 cwd | `npm run typecheck` | 0 | 기존 앱 타입 |
| 같은 cwd | `npm run build` | 0 | 기존 앱 build |
| repository root | `/tmp/keyatlas-powershell-tools/extracted/opt/microsoft/powershell/7/pwsh -NoProfile -NonInteractive -File ./scripts/verify-local.ps1 -Scope Workspace` | 101 | Secret scan 0, format 0, Clippy 101에서 중단 |
| 수정 전 HEAD Rust exact archive | `cargo clippy --offline --locked -p vault-local-platform-windows --all-targets --all-features -- -D warnings` | 101 | 같은 기존 Linux dead-code/unused-import 실패 |
| repository root | `python3 /tmp/keyatlas-catalog-fix-20261003/browser-check.py` | 0 | 아래 Chromium client 합성 8개 |

PowerShell은 지원 XDG_CACHE_HOME/CONFIG_HOME/DATA_HOME을 `/tmp/keyatlas-powershell-tools/xdg-*`에
두었다. Rust은 기존 `/tmp/secure-vault-ka-c06-rust/{cargo,rustup}` 도구/캐시를 사용했다.
추출 baseline archive의 CARGO_TARGET_DIR만 원본의 ignored `target`을 재사용했다.
`--offline --locked`, `-D warnings`, gate/보안 정책은 완화하지 않았다.

원본 HEAD의 Rust·Cargo 파일과 현 checkout의 byte equality를 확인했고, 해당 HEAD의
exact archive에서 focused Clippy 실패도 재현했다. 이 실패를 client 회귀로 분류하지 않는다.
workspace verifier의 뒤 단계 default-tests/probe-ordinary-tests/workspace-doctests는 **NOT_RUN**이다.
이번 환경의 Windows-native 검증도 **NOT_RUN**이다.

Chromium은 타입 검사한 4개 client 파일을 기존 TypeScript로 임시 transpile하고 자체
loopback module server에서 읽었다. transport는 주입한 synthetic Fetch responses만 썼다.
정상 응답, 잘못된 UTF-8, 누적 한도/reader 정리, 멈춘 transport/body, caller 취소,
늦은 body 폐기, 지연 timer 검사를 통과했다. page error/off-origin attempt 0,
cookie/localStorage/sessionStorage 0. 실제 route mount·UI/auth/Gmail E2E는 아니다.
임시 서버와 browser/context는 종료했다.

## 남은 검증과 제출 상태

- 이번 수정의 최신 원격 CI: NOT_RUN/UNKNOWN. Actions 재실행 없음.
- 실제 provider/auth/DB/Gmail/AI·운영 환경·public 배포: NOT_RUN / 사용자 보류.
- 독립 보안/암호 검토 및 실제 Secret release gate: 미완료.
- 로컬 9개 파일 대조와 통합: NOT_RECEIVED.
- 실제 파일 다운로드 → fresh browser profile 금고 복원 B05: NOT_RUN.
- commit/push/새 PR/main merge/force push: 실행하지 않음. 게시 승인 전 reviewable 로컬 변경이다.

상세 subprocess exit와 합성 실행 자료는 `/tmp/keyatlas-catalog-fix-20261003/`에 보존했다.
원본 로그 전문이나 실제 비밀값은 이 문서에 넣지 않았다. 최종 소유 파일 hash·Secret 검사·
whitespace/문서 링크 검사 결과는 아래 최종 확인에 기록한다.

## 최종 확인

최종 소유 파일별 `git diff --no-index --check /dev/null <file>` 8개는 각각 exit 1,
stdout/stderr 없음이었다. `--no-index`의 신규 파일 차이를 나타내는 exit이며 whitespace
오류가 아니다. 실제 whitespace 오류/진단을 별도로 검사한 수집기는 exit 0이었다.
`git diff --check`는 exit 0. 새 문서 2개의 로컬 링크 7개도 모두 존재했고 수집기 exit 0이다.
기존 미추적 문서 5개 hash와 tracked 파일은 그대로다.

문서 작성 뒤의 standalone Secret 검사 명령:

`/tmp/keyatlas-powershell-tools/extracted/opt/microsoft/powershell/7/pwsh -NoProfile -NonInteractive -File ./scripts/check-repository-secrets.ps1 -Root /workspace/secure-vault`

exit **0**, baseline allowed 4, `SECRET_SCAN_PASSED`, `REAL_SECRET_GATE=CLOSED`.

아래 SHA-256은 위 검사에 사용한 최종 소유 코드/테스트 snapshot을 식별한다.

| 소유 파일 | SHA-256 |
| --- | --- |
| `apps/benefits-web/src/domain/catalog-client/client.ts` | `0c6dee89b9413ed2007cd331104bfc60d9d6c643031b83e9db3c07bf5bf984a6` |
| `apps/benefits-web/src/domain/catalog-client/index.ts` | `d2f69aada6cd6a13461bde3375d8d21b7d9302335eed2d22194bba9fbf20097f` |
| `apps/benefits-web/src/domain/catalog-client/requests.ts` | `a6bcd6209074d6a3336a1d6a153e245d9ba1be3eea59fe0aea5ae0f7f7b19d66` |
| `apps/benefits-web/src/domain/catalog-client/responses.ts` | `a4c8931612b9d34a96434c20baf7d53ba7fc82ac7074e99a8246a9158a8dc139` |
| `apps/benefits-web/tests/catalog-client.test.ts` | `e6adbd5835d9cd81b3652bfca9c66b5b1a040bc226eeff3f51ccb24b41a73758` |
| `apps/benefits-web/tests/catalog-client-lifetime.test.ts` | `579c72a996bb6cd9f8b4dc89418d03ff4537621983bde5b1e488757870908a3e` |
