# 2026-09-17 합성 회전 Worker/Client 경계 검증

`REAL_SECRET_GATE=CLOSED`.

브랜치: `codex/firstvibe-rotation-worker-client`.
기준 커밋: `a4d577e51129058c268fbe2bb9c2b66c212a6c95`.

이 slice는 인증된 합성 rotation archive/WASM API를 브라우저 Worker와
Worker client까지 연결한다. 실제 Secret, 외부 provider, 저장 성공, UI 완료 또는
배포 승인을 뜻하지 않는다.

## 구현한 경계

- UI 쪽 rotation 선택은 정확히 다섯 필드만 허용한다. reference는 `0..127`의
  safe integer이며 `-0`을 거부하고, fixture 상태와 폐기 증명은 닫힌 enum만
  허용한다. getter, 상속·추가 필드, 비표준 prototype과 coercion을 거부한다.
- Worker는 입력 archive와 선택을 WASM 초기화 전에 검증하고 복사한다.
  `inspectRotation`은 고정 checklist만, `createRotationCutover`는 소유한 archive
  복사본만 반환한다.
- `WasmRotationChecklistAdapter`는 실제 WASM handle을 두 차례 exact primitive
  boolean으로 확인한다. 비boolean lock 상태는 `INVALID_CATALOG`, `true`는
  `LOCKED`로 fail-closed한다.
- checklist handle은 `lock()` 후 `free()`된 다음에만 plain frozen projection이
  게시된다. cleanup은 두 작업을 모두 시도하며 실패 상세는 공개하지 않는다.
- structured clone 이후 client가 generation, readiness, fixture, boolean, count와
  상호 상태 불변식을 다시 검증하고 새 frozen 객체로 만든다. Secret, 임의 문자열,
  archive ID 또는 revision ID를 투영하지 않는다.
- 작업마다 새 Worker를 쓰고 timeout, cancel, 교체, 늦은 callback, transport 오류를
  하나의 settled gate로 닫는다. 입력·출력 ciphertext는 각 경계에서 복사한다.
- cutover 응답은 Worker가 소유한 정확한 buffer만 transfer하며, 실제 Node
  structured-clone 회귀에서 그 buffer가 detach되고 원래 WASM 반환값은 보존됨을
  확인한다.

## 독립 RED 리뷰와 수정

첫 독립 정적 리뷰는 Critical 0 / Important 1이었다. 두 `isLocked()` 결과를
truthiness로 판단해 `undefined`, `null`, `0`, 빈 문자열 또는 `NaN`을 unlocked로
오인할 수 있는 fail-open 경로였다. 두 위치를 exact boolean 검사로 바꾸고 첫 번째와
두 번째 검사 각각의 다섯 falsey nonboolean 회귀를 추가했다.

수정 후 독립 재리뷰 결과는 Critical 0 / Important 0이다. 재리뷰가 실행한 집중
Worker/Client tests 86개와 TypeScript typecheck도 통과했다.

## 검증 증거

| 검사 | 결과와 적용 범위 |
|---|---|
| 어댑터 집중 검사 | `WasmRotationChecklistAdapter.test.ts` 59 passed. 두 lock-state read의 falsey nonboolean 거부와 cleanup 확인 |
| Worker/Client 집중 검사 | 5 files, 148 passed. 입력 mapping, 복사, 고정 오류, 취소·늦은 응답, handle 정리 확인 |
| transport/transfer 추가 회귀 | 2 files, 29 passed. 동기 `postMessage` 예외 정리와 owned buffer transfer/detach 확인 |
| 실제 생성 WASM 결합 | `WasmRotationChecklistAdapter.wasm.test.ts` 1 passed. 실제 wasm-bindgen handle → adapter → frozen projection 및 lock-before-free 확인 |
| 전체 웹 회귀 | `npm test -- --maxWorkers=1` exit 0, 30 files 및 1125 tests passed |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0, 45 modules transformed; Worker 20.80 kB, WASM 407.82 kB |
| repository Secret scan | exit 0, baseline 4, `SECRET_SCAN_PASSED`, `REAL_SECRET_GATE=CLOSED` |
| `git diff --check` | exit 0 |

## 명시적으로 보장하지 않는 것

- 실제 Secret/API key/password 입력·표시·복사·교체·폐기
- 실제 provider가 완료나 폐기를 증명했다는 보장
- 후보 archive의 IndexedDB 저장, expected-exact-bytes CAS, conflict loser 보존
- canonical latest head, rollback·누락·ABA 방지 anchor
- 실제 브라우저 Worker 왕복, 멀티탭, 오프라인 및 모바일 수명 주기
- UI workflow, 생체인증, 복구, 동기화, 운영 서버·DB·도메인·결제·배포

## 다음 slice

다음은 `SyntheticVaultSession`과 기존 IndexedDB store를 연결한다. 현재 표시된
authenticated bytes와 generation을 하나의 snapshot으로 묶고, 후보를 저장 전 인증한
뒤 expected exact bytes CAS를 한 번만 수행한다. 경쟁에서 진 후보는 conflict archive로
보존하며 authoritative bytes를 다시 읽고 재인증하기 전에는 성공 상태를 게시하지 않는다.
자동 retry, overwrite, merge 또는 실제 Secret gate 개방은 하지 않는다.
