# 닫힌 합성 Password 등록 검증

기준: 2026-09-18. 기준 커밋 `21bca740d7dd3eb304fd95b484f9387305b91827`, 작업 브랜치 `codex/firstvibe-password-registration`.

`REAL_SECRET_GATE=CLOSED`. 실제 비밀번호, API 키, 계정 식별자, 사용자 데이터 또는 provider 호출을 사용하지 않았다. main 병합, 실제 Secret 입력 개방, 공개 배포, 인증·복구 정책, 도메인·IAM·결제와 디자인 결정은 범위 밖이다. 전체 제품 목표는 아직 active다.

## 구현 경계

닫힌 선택은 다음 네 조합뿐이다.

| 종류 | profile | credential | connections |
| --- | ---: | ---: | --- |
| 합성 API Key | `0` 또는 `1` | `0` | 서로 다른 `0|1|2`를 0~3개 |
| 합성 Password only | `2` | `1` | 빈 목록 |
| 합성 Password + identifier | `2` | `2` | 빈 목록 |

이 선택은 raw credential DTO가 아니다. Rust는 private tagged enum으로 다시 검증하고 빌드에 포함된 고정 fixture만 봉인한다. JavaScript parser와 Worker 경계도 exact own data fields, native array, 고정 정수, 복사·동결을 요구한다. cross-kind 조합, Password connection, getter/accessor와 추가 필드는 fail closed한다.

```mermaid
flowchart LR
  A[고정 UI 선택] --> B[descriptor-only JS parser]
  B --> C[Worker 입력 복사]
  C --> D[Rust exact tuple admission]
  D --> E[고정 합성 Password 봉인]
  E --> F[전체 archive 재인증]
  F --> G[IndexedDB 암호문 저장]
  G --> H[잠금·새 session 재열기]
```

- UI는 API Key, Password only, Password + identifier를 구분한다. 종류·API profile·connection 변경은 이전 동의를 무효화하고, 종류를 바꾸면 연결 선택도 비운다. stale event callback과 중복 submit은 저장을 시작하지 못한다.
- Password는 catalog 행과 원래 reference 순서를 유지한다. connection edit, one-shot rotation, durable stage는 API Key reference에만 허용한다. UI 필터의 배열 위치를 reference로 재사용하지 않는다.
- Password identifier는 민감 필드에만 존재한다. issuer account metadata에는 투영하지 않으며 원문 입력·표시·복사 기능이 없다.
- v1~v4 백업/복원, Password 두 형식의 잠금·새 session 재열기, 혼합 archive의 API append/stage와 Password ciphertext 보존을 실제 WASM + fake IndexedDB로 검사했다.

## 변경 파일 역할

| 영역 | 파일과 역할 |
| --- | --- |
| Rust admission | `crates/vault-local-core/src/registration.rs`, `registration_tests.rs`: exact tuple → private API/Password variant, 고정 팩토리 dispatch |
| Archive 회귀 | `crates/vault-client-wasm/src/archive_canonical_tests.rs`: 모든 archive 버전, 혼합 append/stage/capacity, 잘못된 조합·변조·한도 거부 |
| JS admission | `apps/web/src/features/local-vault/syntheticRegistration.ts` 및 테스트: descriptor-only 복사·동결·cross-kind 거부 |
| Worker 경계 | `syntheticVault.worker.test.ts`, `SyntheticVaultWorkerClient.test.ts`: await 전 입력 소유, 응답 복사, WASM/factory 호출 전 거부 |
| Session 권한 | `SyntheticVaultSession.ts`, `SyntheticVaultCapabilities.test.ts` 및 기존 회귀 fixture: 표시된 같은 reference의 API Key에만 편집·회전·stage 허용 |
| UI | `SyntheticRegistrationPanel`, `SyntheticConnectionEditor`, `SyntheticRotationStagePanel`과 interaction tests: Password 선택, 동의 무효화, API-only action, original reference |
| 통합 | `SyntheticVaultRegistration.wasm.test.ts`, `SyntheticPasswordBackup.wasm.test.ts`: 실제 WASM + fake IndexedDB 저장·재열기·백업/복원 |
| 생성 WASM smoke | `scripts/test-wasm.mjs`: 두 Password 형식 append/reopen, metadata 비노출, prefix·입력 보존, 잘못된 tuple 거부 |

## 실행 증거

| 정확한 명령 | 결과 |
| --- | --- |
| `cargo test --release --offline --locked -p vault-local-core --lib registration::tests -- --test-threads=1` | exit 0, 7 passed |
| `cargo test --release --offline --locked -p vault-client-wasm --features synthetic-demo --lib archive::canonical::tests -- --test-threads=1` | exit 0, 13 passed |
| `cargo test --offline --locked --release -p vault-local-core --lib -- --test-threads=1` | exit 0, 전체 126 passed, 28.88s |
| `cargo test --offline --locked --release -p vault-client-wasm --features synthetic-demo --lib -- --test-threads=1` | exit 0, 전체 73 passed, 57.56s |
| `npm test -- --maxWorkers=1` (`apps/web`) | exit 0, 46 files / 1,438 tests, 120.04s |
| 실제 WASM 등록/백업 집중 2파일 | exit 0, 7 passed |
| UI 집중 6파일 | exit 0, 60 passed |
| Worker/Client 집중 2파일 | exit 0, 94 passed |
| `pwsh -NoProfile -NonInteractive -File scripts/build-wasm.ps1 -Release` | exit 0, default release WASM 재생성 |
| `pwsh -NoProfile -NonInteractive -File scripts/build-wasm.ps1 -SyntheticDemo -Release` | exit 0, synthetic-demo release WASM 재생성 |
| `node scripts/test-wasm.mjs` | exit 0, default 40 checks |
| `node scripts/test-wasm.mjs --demo` | exit 0, demo 1,735 checks, Password registrations 2 |
| `npm run build` (`apps/web`) | exit 0, typecheck 포함, 48 modules |
| `cargo clippy --offline --locked -p vault-local-core --all-targets -- -D warnings` | exit 0 |
| `cargo test --offline --locked --workspace --doc` | exit 0, compile-fail doctest 11개 passed |
| `cargo fmt --all -- --check` | exit 0 |

독립 읽기 리뷰는 Critical 0 / Important 0이었다. 이는 외부 전문 보안 감사나 실제 Secret 사용 승인이 아니다.

## 테스트 중 수정과 미검증 범위

- 새 Session capability guard를 적용하자 기존 rotation/stage mock이 reference `1`을 선택하면서 catalog에는 reference `0`만 반환해 집중 회귀가 실패했다. production guard를 완화하지 않고 mock catalog에 실제 선택 reference를 추가한 뒤 웹 전체 1,438개가 통과했다.
- 독립 리뷰에서 늦은 같은-kind API stage 응답이 더 최신 선택을 되돌릴 수 있는 경합을 찾았다. 요청 version, 요청 당시 reference, 현재 selection과 최신 API catalog type을 모두 묶어 검사하고 두 회귀를 추가했다. Password 고정 display metadata의 ciphertext marker 검사도 item name/template/URL/note/tag/timestamp까지 확대했다.
- 실제 브라우저 확인은 완료하지 못했다. `agent-browser`는 연결 시 OS error 10060, Codex 내장 browser webview는 attach timeout, 현재 CUA에는 Chrome provider가 없었다. 기존 사용자 탭·브라우저 저장소·OS 보안 정책을 변경하거나 우회하지 않았다.
- mock-hook interaction, actual-WASM/fake-IDB Node 통합, generated-WASM smoke는 실제 DOM scheduling, 실제 browser Worker, 네이티브 파일 선택·다운로드의 증거가 아니다.
- WASM package Clippy는 이전 체크포인트와 같은 Windows Code Integrity macro DLL 차단 때문에 재실행하지 않았다. core Clippy, native WASM 전체 테스트와 원격 CI gate를 별도 증거로 사용한다.

## 남은 보안 작업

등록 session의 기존 simple CAS는 expected original bytes를 확인하므로 winner를 덮어쓰지는 않는다. 그러나 edit/stage 경로와 달리 후보 archive 전체를 저장 전에 별도 open/authenticate하지 않고, CAS loser 또는 저장 직후 displacement 후보를 conflict outbox에 보존하지 않는다. 이 격차를 닫기 전에는 등록이 다른 mutation과 같은 충돌 보존 수준이라고 주장하지 않는다.

실제 사용자 입력, reveal/copy, recovery Key Slot, hardware-backed device key·생체 인증, rollback/누락 anchor, sync/checkpoint, Android, 실제 데이터용 backup/export, 독립 암호 검토와 침투 테스트는 여전히 미구현이다.
