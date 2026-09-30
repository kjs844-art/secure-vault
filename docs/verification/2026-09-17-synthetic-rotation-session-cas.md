# 2026-09-17 합성 회전 Session/IndexedDB CAS 검증

`REAL_SECRET_GATE=CLOSED`.

브랜치: `codex/firstvibe-rotation-session-cas`.
기준 커밋: `b99d28d492a42805ce953b3345ca6819765113a0`.

이 slice는 앞선 합성 rotation Worker/Client 경계를 로컬 vault session과
IndexedDB ciphertext store에 연결한다. 실제 Secret, 외부 provider, UI 완료,
공개 배포 또는 운영 데이터 승인을 뜻하지 않는다.

## 구현한 경계

- checklist 검사는 현재 `open` 세션이 표시 중인 authenticated archive bytes와
  정확한 vault generation을 하나의 비공개 snapshot으로 묶는다. 공개 상태에는
  고정 allowlist checklist와 review version만 남고 ciphertext, conflict ID,
  selection 원본 또는 임의 provider 문자열은 노출하지 않는다.
- cutover는 호출자가 현재 vault generation과 현재 review version을 모두 다시
  제시하고, 표시 bytes가 검토했던 bytes와 byte-exact로 같을 때만 시작한다.
  오래된 두 token 조합은 Worker 호출, 저장 쓰기, 알림 또는 상태 변경 없이 끝난다.
- Worker가 만든 후보는 세션 소유 복사본으로 만들고 원본과 동일한 no-op 후보를
  거부한다. 후보 전체를 저장 전에 다시 인증한 뒤에만 conflict-preserving CAS를
  정확히 한 번 호출한다.
- 일반 CAS로 우회하지 않는다. atomic CAS loser는 새 canonical 값을 덮어쓰거나
  자동 retry/merge/rebase하지 않고 conflict archive로 보존된 결과를 오류로
  보고한다.
- CAS 성공 뒤 store의 authoritative bytes를 다시 읽는다. 후보와 다르면 세션의
  정확한 후보를 bounded conflict outbox에 보존하고 성공을 게시하지 않는다.
  정확히 일치하면 그 readback 복사본을 다시 인증·투영한 뒤에만 `open` 상태로
  전환한다.
- injected Worker/store capability getter, busy subscriber, 비교 getter와 모든 await
  경계 뒤 generation을 다시 검사한다. lock 뒤 늦게 끝난 KDF, CAS, readback,
  conflict 보존 또는 재인증 continuation은 세션을 다시 열거나 새 작업을 시작하지
  못한다.
- 세션이 소유한 predecessor, candidate, readback 및 인증 임시 ciphertext는 성공,
  오류와 stale continuation 경로에서 wipe한다. Worker와 store에 전달하는 archive도
  별도 복사본이며 호출이 끝나면 wipe한다.
- conflict review와 rotation review는 같은 Worker를 공유하므로 서로의 snapshot을
  무효화한다. conflict exact-delete가 진행 중일 때 새 conflict/rotation review를
  시작하지 않는다.

## 회귀 검증

| 검사 | 결과와 적용 범위 |
|---|---|
| rotation session 집중 검사 | `SyntheticVaultRotation.test.ts` 33 passed. stale token, getter/subscriber 재진입, hostile result, alias mutation, outbox 오류, 모든 lock stage와 zeroization 확인 |
| 실제 WASM/저장 결합 | `SyntheticVaultRotation.wasm.test.ts` 3 passed. 실제 생성 WASM + fake IndexedDB에서 재시작, 동시 writer, prewrite tamper, post-CAS displacement 확인 |
| 정확한 경쟁 후보 결박 | canonical current가 winner의 정확한 candidate이고 conflict가 loser의 정확한 candidate임을 byte-exact 비교. displacement에서는 current가 injected successor, conflict가 세션 candidate임을 확인 |
| 관련 session 회귀 | 9 files, 210 passed. rotation, session, conflict review, registration, connection edit, auto-lock 및 실제 WASM 경로 포함 |
| 전체 웹 회귀 | `npm test -- --maxWorkers=1` exit 0, 32 files 및 1161 tests passed |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0, 45 modules transformed; Worker 20.80 kB, WASM 407.82 kB, main JS 303.17 kB |
| repository Secret scan | exit 0, baseline 4, `SECRET_SCAN_PASSED`, `REAL_SECRET_GATE=CLOSED` |
| `git diff --check` | 코드 변경 기준 exit 0. 문서 반영 뒤 최종 재실행한다 |

## 독립 리뷰 상태

최종 읽기 전용 RED 재검토 결과는 **Critical 0 / Important 0**이다. 검토자는
reentrant capability getter와 subscriber lock, 오래된 두 token의 true no-op,
candidate ownership·alias mutation·native wipe, CAS loser 보존, post-CAS displacement,
fallback/retry/overwrite 부재, late continuation의 상태 부활 방지와 malformed/hostile
입력의 fail-closed 처리를 최신 세 파일에서 확인했다.

리뷰 대상 SHA-256은 Session
`5FCAEFE548E70AA65E8611485B5F65D145F6E588985BFA6A601D93EE7C6D4BE4`, unit test
`D59B40CF32C9F8742C0ACEBB6742E9281FBB2FFD30CFDFCFEF9778178F406A6A`, WASM test
`A4E3C84A83FDA93A0624F0247A7E259BF2C72C0AF608D9703E9766A7AFF8ABC1`이다. 리뷰는
부모가 실행한 33 unit + 3 actual-WASM + 210 관련 회귀 증거를 사용하고 중복 테스트를
실행하지 않았다.

## 명시적으로 보장하지 않는 것

- 실제 Secret/API key/password 입력·표시·복사·교체·폐기
- 실제 provider가 키 갱신 또는 이전 키 폐기를 증명했다는 보장
- 실제 브라우저 Worker, 실제 브라우저 IndexedDB, 멀티탭·오프라인·모바일 수명 주기
- rotation UI, 생체인증, 복구, 동기화 또는 운영 서버·DB·도메인·결제·배포
- signed latest-head/rollback/누락/ABA anchor
- 자동 retry, overwrite, merge, conflict 승격 또는 무제한 conflict 보관

실제 WASM 검사는 실행했지만 Worker 호출은 테스트 harness 안의 inline adapter이고,
저장소는 fake IndexedDB다. 따라서 이 결과를 실제 브라우저 통합 증거로 해석하지
않는다.

## 다음 자율 slice

이 checkpoint가 독립 리뷰를 통과하면 UI나 실제 Secret gate를 열기 전에, 닫힌 합성
입력만 사용하는 중간 rotation workflow의 durable 상태 모델 또는 browser-level
Worker/IndexedDB 검증 중 현재 환경에서 재현 가능한 경계를 선택한다. 자동 재시도,
실제 provider 호출, 공개 배포와 main 병합은 별도 승인 없이 진행하지 않는다.
