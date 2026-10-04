# Cloud 합성 통합·검증 후속 기록 — 2026-10-03

상태: **LOCAL_UNCOMMITTED / SYNTHETIC_ONLY / REAL_SECRET_GATE=CLOSED**.
사용자의 지속 작업 요청에 따른 로컬 보완이다. commit/push/PR 생성/merge,
다른 AI 세션 생성·메시지 전송, 실제 provider·환경·비용·배포 보류를 유지했다.
코드 보완·로컬 연결 검사와 원격 통합·실환경 검증·배포는 별도 단계다.

## 변경 파일

이번 후속에서 새로 가져오거나 수정한 구현·검사 파일은 다음과 같다.

| 파일 | 변경과 소유 범위 |
| --- | --- |
| `apps/benefits-web/tests/catalog-http-loopback.test.ts` | #23의 기존 11개 검사 재사용. 고정 sleep 대신 handler 완료를 기다리고 socket 정리를 확인 |
| `apps/benefits-web/tests/support/catalog-http-loopback.ts` | #23 test-only helper 재사용. 실제 비동기 handler job과 socket 종료를 추적. `whenIdle()` 및 bounded cleanup |
| `apps/benefits-web/tests/catalog-client-http-integration.test.ts` | 합성 client → 실제 loopback HTTP handler → memory adapter 연결 5개 검사 |
| `apps/web/src/features/identity-map/IdentityMapPanel.tsx` | #24 화면 재사용. 한국어 합성 안내, 단계 이동 후 초점 복원, 패널 내부 Escape, 바뀐 snapshot의 선택 초기화 |
| `apps/web/src/features/identity-map/IdentityMapPanel.test.tsx` | #24 기존 렌더링·escaping·빈 상태 검사 유지. 변경한 합성 안내 검증 |
| `apps/web/src/features/identity-map/identityMapModel.ts` | #24 model 재사용. 계정 `null`과 기록된 빈 문자열을 구별하는 임시 ID |
| `apps/web/src/features/identity-map/identityMapModel.test.ts` | 기존 검사 유지, 누락/빈 계정 혼합 회귀 추가 |
| `apps/web/src/features/identity-map/identity-map.css` | #24 스타일 재사용, 제목 초점 표시 및 긴 항목명 줄바꿈 |
| `apps/web/src/features/identity-map/syntheticIdentityMapFixture.ts` | #24의 고정 합성 예시 그대로 사용 |
| `apps/web/src/App.tsx` | 기존 합성 안내를 보존하고 독립 관계 화면 링크 추가 |
| `apps/web/src/main.tsx` | `?view=identity-map` 합성 화면 연결 |
| `apps/web/src/features/local-vault/LocalVaultPanel.tsx` | 열린 금고의 표시 snapshot만 관계 화면에 전달. phase/generation에 따라 제거·초기화 |
| `crates/vault-local-platform-windows/src/lib.rs` | Windows 전용 import/helper/test import의 컴파일 조건을 좁힘. 미사용 non-Windows private stub 제거 |

문서 변경: 이 기록, `SERVICE_READINESS_2026-10-03.md`,
`PROVIDER_ADAPTER_PLAN.md`, `REAL_SECRET_CORE_PLAN.md`.
앞선 client 보완 6개 파일과 검증 문서는 그대로 보존했다.
기존 미추적 `CLOUD_DELEGATION_2026-09-30.md`, `CLOUD_LEAD_HANDOFF_2026-09-30.md`,
`2026-09-30-cloud-lead-review.md`도 그대로 보존했다.

#23의 CI helper·workflow·manifest, #24의 과거 App/금고 파일 전체는 이식하지 않았다.
현재 금고의 rotation, capacity/bridge 오류 안내와 AI 전송 없음 문구를 보존했다.
runtime server/reader의 정책·시간·크기 제한, 인증·암호화·CI 정책을 변경하지 않았다.
새 의존성·버전·lockfile 변경이나 generated WASM commit은 없다.

## 정확한 SHA와 게시 상태

| 대상 | 확인 값 |
| --- | --- |
| checkout / branch | `/workspace/secure-vault` / `codex/firstvibe-cloud-catalog-client-fix-20261003` |
| 실제 HEAD / 수정 전 기준 | `afbc0fbc4dd41669e468d8658965ef8f5f10ee7d` |
| `origin/main` 및 실제 원격 main tip | `65d10dceb13039dc69cf2368aa0e31d7ad5cc6b2` |
| HEAD와 origin/main의 merge-base | `ceca9f43c4f92b3b0e4081d84be8612b10f03582` |
| 시작 benefit-history 원격 tip | `ee557c8e81807f1af88fff0e40ed949089b9337f` |
| #22 원격 head | `3230b1ae6fa9b062f1804c04e8439a9a99f14575` |
| #23 원격 head | `11591798c2f771691804cf52413bc9d454f2d0d7` |
| #24 원격 head | `34f81d62ca1b7bf880fddaaf662f14387049c305` |
| #29 원격 head | `afbc0fbc4dd41669e468d8658965ef8f5f10ee7d` |
| 새 commit / push / PR | 없음 / 하지 않음 / 생성하지 않음 |

마지막 `git ls-remote`는 위 원격 tip을 재확인했고 exit 0이었다.
작업 branch의 원격 ref는 조회 결과가 비어 있다. staged 파일도 없다.
검사는 HEAD **위의 미커밋 소스**에 실행했다. HEAD만 checkout해서는 이번 결과를 재현할 수 없다.
아래 evidence의 source hash manifest로 검사한 변경을 식별한다.
Git 원격 ref를 PR merge나 CI 성공 증거로 사용하지 않는다.

## 원인·보완 근거

### Client와 실제 합성 HTTP 경계

기존 #23의 테스트만으로 #22 client를 통한 연결까지 증명되지는 않았다.
새 5개 검사는 CRUD/list/replay, 저장 이후 caller abort와 명시적 replay,
admission 이전 deadline, 같은 generation에서 owner/session 전환,
429의 bounded Retry-After와 자동 재시도 없음 경계를 확인한다.
deadline 검사는 서버의 handler 완료와 admission signal의 abort를 확인한 뒤 gate를
해제하므로 client timeout만으로 서버 취소·rollback이 증명됐다고 가정하지 않는다.
이미 commit된 명령의 caller abort도 rollback으로 해석하지 않는다.

helper의 고정 지연을 의미 있는 완료 신호로 교체했다. timeout·취소·실패·socket assertion을
삭제하거나 검사를 skip하지 않았다. client deadline/HTTP server 정책은 그대로다.
Node fetch는 브라우저 cookie/origin 자동 동작을 구현하지 않으므로 test-only transport가
고정 합성 cookie/Origin을 추가한다. 실제 인증·브라우저 cookie·CORS·proxy·DB 검증은 아니다.
공개 `/api/catalog/**`의 503 차단도 그대로다.

### #24 계정 구분·키보드·잠금

기존 ID는 `issuerAccountIdentifier ?? ""`를 사용해 기록 없음과 기록된 빈 값을 합쳤다.
기존 14개 검사에 회귀를 더한 수정 전 실행은 **14 PASS / 1 FAIL / exit 1**이었다.
provider/nullable account의 JSON tuple로 임시 화면 ID만 바꿨다. 저장·wire·암호화 형식 변화는 없다.

수정 전 실제 Chromium에서는 계정을 Enter로 고른 후 버튼이 사라지면서 초점이 BODY로
이동했다(**exit 1**). 보완 후 단계 제목으로 초점을 이동하고 Tab/Enter/Escape 탐색을 검증했다.
Escape는 해당 패널 내부에서만 처리하므로 다른 금고 작업의 키 입력에 간섭하지 않는다.
새 snapshot에서는 현재 표시 상태를 기준으로 선택을 처리한다.
금고의 열린 phase에서만 embedded 화면을 mount하고 generation별로 초기화한다.
잠금 후 DOM 제거·저장 byte 보존·명시적 재열기 후 선택 초기화를 실제 WASM에서 확인했다.

### Linux Clippy와 남은 SQLite 실패

앞선 verifier는 Linux의 기존 Windows import/dead-code 경고로 Clippy exit 101이었다.
이번 컴파일 조건 보완 뒤 package 및 workspace Clippy는 `-D warnings`를 유지한 채 통과했다.
Windows의 drive/path 신뢰 판정·FFI·public API·UnsupportedPlatform 동작은 바뀌지 않았다.

전체 verifier의 다음 단계는 **default-tests FAIL / exit 101**이다.
`vault-local-store-sqlite --lib` 결과는 **30 PASS / 19 FAIL / 기존 1 ignored**다.
17개는 Windows 전용 storage 경로의 `UnsupportedPlatform`, 두 crash-child 검사는
같은 환경에서 child가 readiness 이전 종료하는 실패다.
기준 SHA의 exact Cargo/crates/contracts 소스를 별도 임시 폴더에서 실행해 동일한
30/19/1과 exit 101을 재현했다. 초기 일부 archive 비교는 contracts 누락 compile 실패였으며,
완전한 tracked contracts를 같은 SHA에서 가져온 뒤의 비교 결과만 근거로 사용했다.
후속 VFS probe와 workspace doctest는 verifier가 중단되어 **NOT_RUN**이다.
19개 검사를 skip하거나 Linux를 Windows 신뢰 저장소처럼 허용하지 않았다.

최소 후속안: 고정 변경 소스의 native Windows verifier 근거를 먼저 확보하고,
지원 플랫폼과 test fixture 분리를 검토한다. 실제 storage/core 정책 변경은 승인·독립 검토 후다.

## 검사 명령과 exit code

설치에는 기존 고정 `npm ci --ignore-scripts` 절차를 사용했다. 이 후속에서 재설치·dependency
변경은 하지 않았다. Rust는 기존 offline cache와 locked dependency를 사용했다.
`pwsh`는 설치된 `/tmp/keyatlas-powershell-tools/extracted/opt/microsoft/powershell/7/pwsh`이며
bindgen은 `/tmp/secure-vault-ka-c06-bindgen/bin/wasm-bindgen` 0.2.128이다.
Rust 1.95.0, Node 24.19.0, npm 11.9.0, Chromium 151.0.7922.173 환경이다.

| cwd | 정확한 명령 | exit / 결과 |
| --- | --- | --- |
| `apps/benefits-web` | `node --import tsx --test tests/catalog-client-http-integration.test.ts tests/catalog-http-loopback.test.ts` | 각 0, 16/16 × 3회, skip 0 |
| 같은 곳 | `node --import tsx --test tests/bounded-json.test.ts` | 0, 25/25, skip 0 |
| 같은 곳 | `npm test` | 0, 1,354/1,354, skip 0 |
| 같은 곳 | `npm run build` | 0 |
| 같은 곳 | `npm run typecheck` | 0 |
| 같은 곳 | `npm run check:boundaries` | 0 |
| 같은 곳 | `npm run test:smoke` | 0; loopback SSR, hydration 별도 |
| repo root | `cargo fmt --all -- --check` | 0 |
| repo root | `cargo clippy --offline --locked -p vault-local-platform-windows --all-targets --all-features -- -D warnings` | 0 |
| repo root | `cargo test --offline --locked -p vault-local-platform-windows` | 0; Linux에서 1개, Windows 전용 검사 아님 |
| repo root | `pwsh -NoProfile -NonInteractive -File ./scripts/verify-local.ps1 -Scope Workspace` | 101; Secret/format/Clippy 0, default-tests 101 |
| exact baseline 임시 폴더 | `cargo test --offline --locked -p vault-local-store-sqlite --lib -- --test-threads=1` | 101; 30/19/기존 ignored 1 |
| repo root | `pwsh -NoProfile -NonInteractive -File ./scripts/build-wasm.ps1 -BindgenPath /tmp/secure-vault-ka-c06-bindgen/bin/wasm-bindgen` | 0 |
| repo root | `node scripts/test-wasm.mjs` | 0; 기본 WASM 40 checks |
| repo root | `pwsh -NoProfile -NonInteractive -File ./scripts/build-wasm.ps1 -SyntheticDemo -BindgenPath /tmp/secure-vault-ka-c06-bindgen/bin/wasm-bindgen` | 0 |
| repo root | `node scripts/test-wasm.mjs --demo` | 0; debug 합성 WASM 1,735 checks |
| repo root | `pwsh -NoProfile -NonInteractive -File ./scripts/build-wasm.ps1 -Release -BindgenPath /tmp/secure-vault-ka-c06-bindgen/bin/wasm-bindgen` | 0 |
| repo root | `node scripts/test-wasm.mjs` | 0; release 기본 WASM 40 checks |
| repo root | `pwsh -NoProfile -NonInteractive -File ./scripts/build-wasm.ps1 -SyntheticDemo -Release -BindgenPath /tmp/secure-vault-ka-c06-bindgen/bin/wasm-bindgen` | 0 |
| repo root | `node scripts/test-wasm.mjs --demo` | 0; release 합성 WASM 1,735 checks |
| `apps/web` | `npm test -- --run src/features/identity-map/identityMapModel.test.ts src/features/identity-map/IdentityMapPanel.test.tsx src/features/local-vault/LocalVaultPanel.test.tsx src/App.test.tsx` | 0; 26/26 |
| 같은 곳 | `npm test` | 0; 최종 연결 소스 1,713/1,713, 52 files |
| 같은 곳 | `npm run typecheck` | 0 |
| 같은 곳 | `npm run build` | 0; fresh release WASM 포함 |
| 같은 곳 | `node --test tests/mvp-browser/qa-core.node-test.mjs tests/mvp-browser/synthetic-idb-probe.node-test.mjs tests/mvp-browser/qa-lifecycle.node-test.mjs tests/mvp-browser/runner-config.node-test.mjs` | 0; 기존 M05 offline 180/180, skip 0 |
| cloud | `python /tmp/keyatlas-cloud-continuation-20261003/identity-map-browser-final.py` | 0; standalone 1440/360 및 embedded 3개 PASS |
| cloud | `python /tmp/keyatlas-cloud-continuation-20261003/vault-browser-integrated.py` | 0; S1–S5/B05 6개 PASS |

최종 Secret/whitespace/hash 무결성 검사는 아래 기록을 따른다.
앞선 client 30 × 5 및 비교 실행 명령·결과는
[앞선 검증](2026-10-03-cloud-catalog-client.md)을 보존했다.

### 최종 무결성

- repo root: `pwsh -NoProfile -NonInteractive -File ./scripts/check-repository-secrets.ps1 -Root /workspace/secure-vault`
  — exit 0, `SECRET_SCAN_PASSED`, 기존 baseline 4개만 허용.
- repo root: `git diff --check` — exit 0. 미추적 소유 파일은 각각
  `git diff --no-index --check /dev/null <path>`로 별도 확인했다.
  새 파일 diff의 exit 1 자체는 내용 차이이며, whitespace 진단 stdout/stderr가 없음을 확인했다.
- 구현·검사 19개 파일의 source manifest SHA-256:
  `330814e9e71fdf6107de4f14c9cfe84b76ca72ab496164a7aa5b4f538bb4fdb4`.
  `source-manifest.json`의 경로순 `path + NUL + sha256 + LF`를 UTF-8로 합쳐 계산했다.
  문서·generated·dependency·로그·backup을 포함한 Git commit SHA는 아니다.
- 초기 미추적 13개 중 계획한 설계 초안 2개와 서비스 평가만 갱신했다.
  나머지 10개는 byte hash를 보존했다. staged 파일, 새 commit, manifest/lockfile 변경은 없다.

이 metadata 기록도 포함해 최종 whitespace/소스 보존 결과를 `final-integrity.json`에 남겼다.

## 실제 합성 브라우저 evidence의 한계

임시 소유 loopback 서버의 최종 production build 복사본을 사용했다. GET/HEAD 외 요청,
외부 origin·WebSocket·service worker를 차단하고 자산 bytes/hash를 실제 dist와 대조했다.
최종 두 runner의 page/harness error와 외부 요청 시도는 모두 0이다.
모바일 스크린샷도 육안 확인했다. 접근성 인증이나 모든 browser/mobile 기기 검사는 아니다.

S1 quota 실패에도 archive 유지·재열기, S2 편집 중 잠금·DOM 제거·reload 잠금,
S3 Enter 잠금/Tab 사생활 경계, S4 360px 수평 overflow 없음, S5 미래 버전 byte/store 보존을
기존 M05의 exact bounded synthetic IDB probe로 확인했다.
B05는 제품에서 실제 다운로드한 파일을 디스크에 저장하고, 새 소유 persistent profile에서
실제 FileChooser 경로로 읽어 복원·기존 archive 덮어쓰기 거부·브라우저 재시작 후 재열기를
확인했다. in-page File/Blob 주입으로 다운로드를 대신하지 않았다.

최초 browser collector는 response body 수집의 TargetClosedError가 있어 exit 0이어도
**NOT_ACCEPTED**로 보존했다. collector가 오류를 집계·실패 처리하도록 고친 뒤 새 프로필로
검증했고, 이후 UI 연결한 최종 build에서 다시 실행했다. product assertion 완화는 없다.
OS 네이티브 파일 대화상자를 사람이 조작한 검사는 **NOT_RUN**이다.
기존 제출물의 Node Playwright `local-vault-qa.mjs` runner 자체도 **NOT_RUN**이다.
이미 설치된 Python Playwright로 실행한 별도 실제 Chromium 근거임을 구별한다.

로컬 evidence: `/tmp/keyatlas-cloud-continuation-20261003/`의 `benefits-checks.json`,
`workspace-checks.json`, `baseline-sqlite-tests-complete-archive.json`, `wasm-checks.json`,
`wasm-release-checks.json`, `web-integrated-checks.json`, `browser-integrated-build-manifest.json`,
`identity-map-browser-final/vault-browser-check.json`, `browser-integrated/vault-browser-check.json`,
`source-manifest.json`, `final-integrity.json`. 이 자료는 현재 cloud 전용이며 원격 repo에 게시되지 않았다.
합성 backup·profile·screenshot·원본 로그는 Git에 추가하지 않았다.

## 미검증·다른 AI에게 넘길 일·결정

- 로컬 readiness의 미푸시 9개 파일: **NOT_RECEIVED**. 경로·diff·검사 SHA를 받기 전
  catalog-client/loopback 보완과 대조·통합 완료를 선언하지 않는다.
- native Windows trusted filesystem/SQLite/crash-child, 전체 doctest/VFS probe: **NOT_RUN**.
  전체 Rust는 위 FAIL이며 local web PASS가 이를 대신하지 않는다.
- 실제 authority·DB/RLS·Gmail/외부 AI·token 철회·실메일 E2E·staging/production: **NOT_RUN**.
- live Issue/PR 상태·CI 결과: GitHub API 접근 실패 이력 때문에 **UNVERIFIED**.
  사용자 제공 Issue #30 본문과 native Git tip만 근거로 삼았다.
- M02: 기존 #24의 나머지 focus/screen reader·모바일/한국어 검토, #26 재사용 검토.
  공용 App/main/session/worker/crypto/server/config는 주 담당 소유.
- M05: 고정 source patch/hash를 받은 뒤 Node browser runner와 native Windows 검사,
  실제 기기·수동 파일 dialog 보완. QA product/CI 변경은 제안만 전달.
- M06: 한국 운영·개인정보·보존/삭제·연락처·배포/rollback 초안. 실제 운영 주체·지역 결정과 구별.
- M04A/R4A: 현재 client/HTTP/잠금 경계와 R3A/R5A 설계의 읽기 전용 독립 검토.
  자기 구현·합성 검사 결과를 독립 출시 승인으로 세지 않는다.

다른 AI는 동일 HEAD만으로 새 코드를 전달받았다고 가정할 수 없다.
게시 승인 후 exact commit 또는 승인된 별도 patch/hash를 넘긴 다음 각 전용 checkout과
허용 파일을 확정한다. 실제 배정·세션 생성·메시지 전송은 하지 않았다.
R5A는 현재 mail authority의 `externalAnalysis: true` 목적과 실제 로컬/외부 분석 선택을
먼저 맞춰야 한다. 실제 동의 없이 필드를 true로 채우는 adapter 구현은 허용되지 않는다.

사용자 결정: commit/push/PR 권한, 미전달 9개 파일 전달, R3A/R5A 구현 manifest,
Gmail 최소 기능·분석 목적/공급자·운영 지역/비용, 다른 AI 실제 배정, 환경/배포 재개.
출시 기간은 [서비스 평가](../../handoff/mvp-20260927/SERVICE_READINESS_2026-10-03.md)의
조건부 추정을 유지한다. 이번 합성 통합만으로 실제 Gmail·실사용 금고·배포 완료로 승격하지 않는다.
