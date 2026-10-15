# 2026-09-17 합성 회전 archive/WASM 부분 검증

`REAL_SECRET_GATE=CLOSED`.

브랜치: `codex/firstvibe-rotation-archive-wasm`.
기준 커밋: `8ef81d95ba5bea1fd29416c23703d93087465743`.

이 문서는 기준 lifecycle/history 커밋의 원격 성공과 그 위의 **미커밋
rotation archive/WASM slice**를 구분한다. 현재 slice는 로컬 부분 검증 단계이며,
현재 branch 전체의 원격 CI 성공이나 출시 승인을 뜻하지 않는다.

## 기준점 증거

[GitHub Actions run `35119009675`](https://github.com/kjs844-art/secure-vault/actions/runs/35119009675)의
attempt 2가 기준 커밋 `8ef81d9`에서 모든 step `SUCCESS`로 끝났다. 이 결과는
lifecycle/history 기준점에 적용되며, 그 뒤의 현재 미커밋 파일에는 적용되지 않는다.

## 현재 slice가 추가하는 경계

- 코어 checklist는 저장된 암호문을 인증한 뒤 합성 generation
  (`initial_0001`, `rotated_0002`, `terminal_0003`), 닫힌 fixture 분류
  (`mcp`, `cli`, `ci`), cutover 필수 여부와 남은 개수만 투영한다. Secret,
  note, 임의 표시 문자열 또는 provider 응답은 반환하지 않는다.
- archive 내부 경로는 선택한 head의 전체 ancestor를 연결·인증하고 incomplete
  lifecycle history를 거부한다. 생성 후보는 기존 password envelope와 revision
  bytes 및 다른 head를 보존하고, 새 revision 하나를 append해 선택 head만 전진시킨다.
  assembled archive는 반환 전에 다시 parse·인증한다.
- v1/v2 genesis 입력은 원본 envelope를 다시 쓰지 않고 v3 history 후보로 이동한다.
  합성 `0001→0002→0003` 두 번의 cutover까지만 지원하며 terminal에서 세 번째
  후보 생성을 거부한다.
- JavaScript export `inspectSyntheticRotationChecklist`와
  `createSyntheticRotationCutover`는 `synthetic-demo` feature에만 있다. checklist는
  직접 생성을 고정 오류로 거부하는 getter-only/lockable projection이다.
- JavaScript 경계는 reference와 revocation enum에 primitive number만, fixture별
  완료 표시에 primitive boolean만 허용한다. 문자열, truthy 값, 음수 0, 분수,
  범위 밖 index를 coercion하지 않는다. 임의 Secret·ID·문자열·provider 자료를
  받는 API가 아니다.
- cutover 함수는 후보 archive bytes만 반환한다. host storage를 쓰거나 canonical
  latest head를 정하거나 CAS 성공을 기록하지 않는다.
- 손상·잘림·잘못된 magic·미래 버전·인증 변조·잘못된 v3 head와 count 제한은
  기존 archive API뿐 아니라 checklist/cutover API 양쪽에서도 같은 고정 오류로
  거부되고 입력 bytes가 바뀌지 않는다.
- `0001→0002→일반 connection edit→0003` 경로는 편집 전후 세대와 인증된 parent
  revision을 확인한다. 0002/0003 후보 bytes도 닫힌 합성 비밀·표시·password marker를
  평문으로 포함하지 않는지 검사한다.

## 변경 파일과 책임

| 파일 | 책임 |
|---|---|
| `crates/vault-local-core/src/rotation_checklist.rs` 및 tests | 인증된 closed checklist의 최소 projection과 fail-closed 입력 검증 |
| `crates/vault-client-wasm/src/archive_rotation.rs` 및 tests | 선택 chain 인증, checklist/후보 생성, v3 append와 재인증 |
| `crates/vault-client-wasm/src/demo.rs` | strict demo-only JS 입력과 lockable checklist projection |
| `crates/vault-client-wasm/src/lib.rs` | `synthetic-demo`에서만 회전 API export |
| `scripts/test-wasm.mjs` | 실제 생성 WASM의 export 부재/존재, strict 입력, lock, 두 cutover와 거부 경계 검사 |
| `scripts/check-repository-secrets.ps1` | 변경된 합성 fixture 소스의 pinned baseline 갱신 |

## 로컬 검증 증거와 한계

| 검사 | 결과와 적용 범위 |
|---|---|
| 코어 `rotation_checklist` 집중 테스트 | exit 0, 8 passed. 현재 코어 checklist 소스에 대한 증거 |
| `cargo test --locked --offline -p vault-client-wasm --features synthetic-demo --lib -- --test-threads=1` | exit 0, 최종 현재 tree 40 passed, 0 failed |
| `pwsh -NoProfile -NonInteractive -File tests/verification/check-repository-secrets.Tests.ps1` | exit 0, `SECRET_SCANNER_TESTS_PASSED=99` |
| `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File tests/verification/check-repository-secrets.Tests.ps1` | exit 0, `SECRET_SCANNER_TESTS_PASSED=99` |
| `pwsh -NoProfile -NonInteractive -File scripts/check-repository-secrets.ps1 -Root .` | exit 0, 실제 저장소 `SECRET_SCAN_PASSED`, `REAL_SECRET_GATE=CLOSED` |
| `node --check scripts/test-wasm.mjs` | exit 0, JavaScript 문법 검사만 통과 |
| `cargo fmt --all -- --check` | exit 0 |
| `git diff --check` | exit 0 |
| `pwsh -NoProfile -File scripts/build-wasm.ps1 -Release` 및 `node scripts/test-wasm.mjs` | exit 0. default **release** WASM을 새로 생성해 32 runtime checks 통과; 회전 함수와 class가 없는 production 경계 확인 |
| `pwsh -NoProfile -File scripts/build-wasm.ps1 -SyntheticDemo -Release` 및 `node scripts/test-wasm.mjs --demo` | exit 0. demo **release** WASM을 새로 생성해 1520 runtime checks 통과; checklist 5개, cutover 2회, archive rejection 57개, rotation rejection 100개, 직접 constructor의 정확한 `Error("CONSTRUCTOR_DISABLED")` 확인 |
| 이전 generated WASM 부재 웹 시도 | 생성 전 965 assertions 뒤 WASM import 3 suites와 typecheck가 실패했으나, 이는 과거 중간 시도이며 현재 상태 증거가 아님 |
| `npm run typecheck` | 최종 generated WASM이 있는 현재 tree에서 exit 0 |
| `npm test -- --maxWorkers=1` | 최종 generated WASM 기준 exit 0, 25 files 및 997 tests passed, 431.51s |
| `npm run build` | exit 0, TypeScript 검사와 Vite production build 통과, 43 modules transformed |
| 최종 정적 gate | `cargo fmt --all -- --check`, scoped Clippy `-D warnings`, `node --check scripts/test-wasm.mjs`, `git diff --check` 모두 exit 0 |

따라서 최종 현재 tree의 native tests와 실제 생성된 default/demo release WASM runtime,
scanner, 문법, format, diff 및 typecheck 증거가 있다. 이전 `os error 4551`과 generated
WASM 부재 실패는 역사적 중간 상태이며 현재 검증 결과로 사용하지 않는다. 정확한
committed SHA의 원격 CI는 별도로 확인해야 한다.

## 명시적으로 보장하지 않는 것

- 실제 Secret 생성·입력·교체·폐기 또는 실제 provider 확인
- caller가 제공한 head가 저장소의 canonical latest head라는 증명
- rollback, 누락 revision, ABA를 탐지하는 signed anchor
- 후보 bytes의 durable 저장, expected-head CAS 성공, conflict loser 보존
- Worker 메시지 경계, session 잠금/취소 세대, IndexedDB 통합 또는 UI workflow
- 실제 브라우저, Android, 복구·동기화, 배포와 운영 승인

fixture별 user/provider 완료 boolean과 revocation enum은 합성 테스트 입력일 뿐이다.
`ProviderVerified`라는 enum 이름도 외부 provider가 호출되거나 증거가 검증됐다는 뜻이
아니다.

## 다음 slice

다음 범위는 **Worker/session/UI CAS 통합**이다.

1. Worker가 strict demo-only 입력과 현재 archive reference를 받아 checklist와 후보를
   생성하되, 임의 Secret/provider payload를 받지 않도록 한다.
2. session의 lock/cancel generation을 작업 전후에 확인하고 늦게 끝난 결과를 버린다.
3. 저장소의 expected head와 exact bytes가 일치할 때만 후보를 원자 commit하고,
   경쟁에서 진 후보는 기존 conflict 정책에 따라 보존한 뒤 canonical 결과를 재인증한다.
4. UI는 pending/ready/terminal 고정 상태와 오류만 표시하며 후보 생성을 durable 성공으로
   표시하지 않는다.

이 후속 범위도 실제 Secret/provider proof와 latest-head/rollback anchor를 열지 않는다.
