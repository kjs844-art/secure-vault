# 합성 연결 편집 내부 경로 검증

기준: 2026-09-15, `codex/firstvibe-local-session-hardening`, `c48d681` 이후 변경.
`REAL_SECRET_GATE=CLOSED`, `PHASE_0A_VERDICT=UNCHANGED`.

이번 체크포인트는 **내부 API와 저장 경로**다. 편집 버튼/폼은 아직 없으며 실제 키 입력,
운영 인증, 브라우저 편집 동작 또는 서비스 출시가 완료됐다는 뜻이 아니다.

## 구현 흐름

```text
표시 당시 viewGeneration + row reference + 비공개 암호문 snapshot
    ↓ 현재 저장소가 그 bytes와 정확히 같은지 확인
    ├─ 다름/없음 → 고정 오류, 편집/저장 안 함
    └─ 같음 → Worker → Rust 전체 이력 인증
         → 연결만 바꾼 same-record successor
         → 기존 모든 envelope 보존 + 새 revision + head 교체
         → 완성된 후보 전체 재검증
         → 원래 bytes 기준 IndexedDB CAS
         → 저장본 동일 bytes 재읽기 + 전체 인증 → 목록 게시

모든 await 뒤 세대 검사 / 잠금·새 작업은 이전 결과 게시 차단
CAS 충돌 → 기존 저장본 보존, 실패한 후보는 미저장 (durable outbox 없음)
```

## 파일과 계약

- `crates/vault-local-core/src/connection_edit.rs`: ID 0 MCP / 1 CLI / 2 CI,
  중복 없는 0~3개 선택. 원래 3개 fixture와 등록 프로필 2종의 명시적 의미를 확인한다.
  유지한 연결 객체/ID/바인딩·다중 비밀 필드·issuer·상태·메모·정책 등은 그대로 보존한다.
  새 연결만 새 entity ID를 가지며 unsupported/ambiguous/rotation 상태는 거부한다.
- `persistence.rs`: 기존 인증/후속 revision/validation/sealing 경로를 crate-private
  callback으로 재사용한다. 새 비밀 원문 DTO/getter를 공개하지 않는다.
- `crates/vault-client-wasm/src/archive_history.rs`: 모든 revision 인증, 고유 revision ID,
  같은 record의 앞선 최신 leaf만 부모로 허용, record당 한 root/최종 head를 검사한다.
- `archive.rs`: legacy 읽기, v3 이력 편집/추가 등록, 입력과 출력 모두 검증한다.
  CSPRNG에서 생성한 ID도 후보 전체 검증을 통과해야 반환한다.
- `demo.rs`: `editSyntheticConnections(bytes, reference, Float64Array)`를 synthetic-demo에만
  공개한다. 숫자는 f64 단계에서 검사하여 소수/비유한/음수/u32 범위 밖 값을 거부한다.
- `SyntheticVaultSession.ts`: 표시 bytes의 소유 사본과 generation을 결합한다. Worker,
  CAS, 재인증에는 각각 분리된 bytes를 전달하며 성공 후에만 다음 snapshot을 보관한다.
- `syntheticConnectionEdit.ts`, Worker client/Worker: 닫힌 선택값을 재검증한다. 입력 byte 수는
  네이티브 TypedArray getter로 확인하고, 객체에 덮어쓴 길이/비교 메서드를 신뢰하지 않는다.
- `SyntheticVaultBackup.ts`: v3 헤더를 허용하되 전체 framing/인증은 실제 WASM에 위임한다.
- `scripts/test-wasm.mjs`와 새 Rust/TS 테스트: 이전 형식과 함께 실제 생성 bundle을 검사한다.

### v3 형식과 제한

`KATLDEMO | version=3 | headCount | revisionCount | password frame | revision frames | head indexes`.
정수는 little-endian u32이며 각 frame은 길이와 암호문이다. 3~128 heads, 최대 512 revisions,
envelope 최대 65,536 bytes, 전체 최대 512 KiB를 유지한다. byte 상한이 먼저 도달할 수 있다.
자동 삭제/압축/GC는 없다. head 순서는 행 표시 순서이며 영구 ID나 서명된 manifest가 아니다.

v1/v2는 계속 열린다. 처음 편집할 때 v3로 전환하되 legacy successor의 부모가 없으면 원본을
보존하고 거부한다. 이를 root로 바꾸거나 없는 과거를 만들어내지 않는다. v3 후속 등록은
과거를 보존하며 새 root/head를 추가한다. 분기 이력은 허용하지 않는다.

## 실행 증거

아래 검사들은 중복 집계할 총점이 아니라 서로 다른 검증 범위다.

| 실행 명령/검사 | 결과 |
|---|---|
| 담당 agent: `cargo test -p vault-local-core --offline` | exit 0; unit 40, integration 6, 그중 compile-fail 14 cases, doctests 0 |
| 담당 agent: core connection_edit 집중 rerun | exit 0, 9/9 |
| root: `cargo test -p vault-client-wasm --features synthetic-demo --locked --offline archive::history_tests -- --test-threads=1` | exit 0, 11/11, 475.79s (debug) |
| root: `cargo test -p vault-client-wasm --features synthetic-demo --release --locked --offline -- --test-threads=1` | exit 0, 30/30, 27.49s; doctests 0 |
| `.\scripts\build-wasm.ps1 -SyntheticDemo -Release` | exit 0, matching bindgen 0.2.128, release demo bundle 생성 |
| `node scripts/test-wasm.mjs --demo` | exit 0, 973 checks; catalog 5, archive rejection 57, registration 3, connection edit 3 |
| `.\scripts\build-wasm.ps1 -Release` + `node scripts/test-wasm.mjs` | 모두 exit 0, 22 checks; 기본 build에 5개 합성 export 없음 |
| `cargo clippy -p vault-local-core -p vault-client-bridge -p vault-client-wasm --all-targets --features vault-client-wasm/synthetic-demo --locked --offline -- -D warnings` | exit 0 |
| `cargo fmt --all --check` | exit 0 |
| 담당 agent: TS 집중 단위 검사 | exit 0, 7 files / 315 tests (길이/비교 보강 23 regressions 포함) |
| 담당 agent: connection-edit/backup 실제 WASM 통합 | exit 0, 2 files / 25 tests, 14.91s; Node + 실제 WASM + fake IndexedDB |
| `npm.cmd run typecheck --prefix apps/web` | 담당 agent exit 0; root build에서도 tsc 실행 성공 |
| `npm.cmd test --prefix apps/web -- --maxWorkers=1` | root exit 0, 21 files / 762 tests, 19.70s |
| `npm.cmd run build --prefix apps/web` | root exit 0, tsc + Vite, 40 modules |

초기 RED: v3 읽기 테스트가 `UpgradeRequired`로 실패했다. 구현 후 신규 테스트의 Vec/slice
타입 오타 1건을 고치고 집중/전체 release 검사가 통과했다. 앱 제한·timeout을 느슨하게
바꾸지 않았다. debug/release 시간 차이는 암호 연산 최적화 차이이며 보안 보장 수치가 아니다.

주요 회귀: 0→1→3→0 연결, 두 프로필과 다중 비밀 필드, v2→v3 및 v3 추가 등록, 명시적
head 재정렬, 모든 이전 envelope 동일성, historical 손상/미래/누락/분기/중복/비-leaf
head 거부, 128개 항목 전이 및 framing 상한, stale UI/lock/비동기/CAS 충돌, 저장본 재인증.

## 독립 리뷰와 보강

별도 agent의 읽기 전용 core review에서 actionable 결함은 없었다. archive/TS review에서
두 가지를 보강했다: 후보 반환 전 전체 ID/이력 재검증, JS own property 대신 네이티브
TypedArray 길이와 직접 인덱스 비교. 후속 코드 검토와 회귀 검사로 확인했다.
리뷰 담당자는 테스트를 대신 실행하지 않았으며 root/구현 agent의 실행 증거와 구분한다.

## 미검증·다음 단계

- 편집 UI 없음. UI는 generation과 reference를 같은 render에서 캡처해야 한다.
- 이번 경로의 실제 브라우저 Worker/IndexedDB·다중 탭·모바일 동작은 미검증이다.
- CAS loser를 영구 보관하는 충돌 outbox/병합·회전 workflow는 미구현이다.
- 전체 archive rollback/downgrade/누락/출처를 보증하는 anchor/manifest는 없다.
- 실제 인증/복구/생체 인증/기기 키·동기화·DB/WAL·OS Phase 0A를 이번 검사로 승인하지 않는다.
- generated WASM/dist/node_modules는 Git 대상이 아니다. 실제 금고/.env/사용자 비밀도 제외한다.

이번 체크포인트의 문서 공백 검사와 상대 링크 검사, 선택 파일 commit/push 결과는 최종
Git 기록을 따른다. main 병합·공개 배포·Quick 인증/권한/구독 변경은 하지 않는다.
