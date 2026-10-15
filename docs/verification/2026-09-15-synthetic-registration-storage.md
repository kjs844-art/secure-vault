# 합성 등록: Rust → WASM → Worker → 저장본 재인증

기준: 2026-09-15, `codex/firstvibe-local-session-hardening`, 기준 커밋 `37980a0` 이후.
`REAL_SECRET_GATE=CLOSED`, `PHASE_0A_VERDICT=UNCHANGED`.

## 구현한 범위

이 체크포인트는 수동 등록의 내부 저장 경로다. 사용자 화면과 계정/프로젝트/환경
projection은 다음 작업이며, 관계 관리 전체나 서비스 출시 완료로 표시하지 않는다.

```text
열린 합성 금고 + 닫힌 선택값
  → 이전 화면 비우기 / 새 요청 세대
  → 현재 IndexedDB 암호문 읽기
  → Worker: Rust가 기존 레코드 전체 인증
  → 기존 envelope 그대로 + 새 암호화 레코드 → archive v2 후보
  → IndexedDB 단일 transaction bytes CAS
      ├─ 충돌/부재/실패 → 화면 비움, 자동 재시도·초기화 없음
      └─ 커밋 완료 → 저장소 다시 읽기 → 후보와 정확히 같은지 확인
                     → Worker 전체 인증 → 저장본 목록만 표시
잠금/새 세대 발생 → 오래된 성공·실패 결과는 표시하지 않음
```

### 코드 위치

| 계층 | 파일 | 역할 |
|---|---|---|
| Rust core | `crates/vault-local-core/src/registration.rs` | 공개 문자열 없이 프로필·자격증명·연결 ID 선택, 모든 데이터 암호화 |
| 공통 sealing | `crates/vault-local-core/src/record.rs` | 기존 fixture와 새 등록이 같은 canonical validation/암호화 경로 사용 |
| WASM archive | `crates/vault-client-wasm/src/archive.rs`, `demo.rs` | v1/v2 프레임 읽기, 전체 인증 후 암호문 보존 append |
| 입력 계약 | `apps/web/src/features/local-vault/syntheticRegistration.ts` | 정확한 필드·닫힌 숫자 ID·중복/크기 제한, 동기 복사 |
| Worker | `SyntheticVaultWorkerClient.ts`, `syntheticVault.worker.ts` | 한 요청당 Worker, append 후보 암호문만 반환 |
| 세션 | `SyntheticVaultSession.ts` | 열린 상태 요구, CAS/저장본 재인증, 잠금 후 늦은 결과 차단 |
| 백업 | `SyntheticVaultBackup.ts` | v1/v2 헤더 허용 후 기존 전체 인증 및 빈 저장소 전용 복원 |

프로필 0은 Example AI Workshop의 demo-account/demo-project/demo,
프로필 1은 Example Cloud Lab의 lab-account/lab-project/staging이다.
조직/Console/계정/프로젝트/환경도 암호화 payload에 들어간다.
자격 증명은 빌드에 포함된 합성 API 키 한 종류뿐이다. 연결 ID 0/1/2는 MCP/CLI/CI로,
0~3개의 중복 없는 선택 순서를 보존한다. MCP는 기록 전용이며 실행하지 않는다.
공급자가 연결을 확인했다고 주장하지 않고 동일 이름의 계정을 자동 병합하지 않는다.

## 보존과 한계

- 생성은 계속 v1·정확히 3개. 등록은 v2·3~128개. 총 512 KiB/각 envelope 65,536 bytes 유지.
- 기존 password와 record envelope는 바이트 그대로 복사한다. 버전/개수 헤더는 변경된다.
- 신규 ID는 Rust CSPRNG. 기본 non-demo WASM에는 등록 API를 export하지 않는다.
- WASM 숫자는 f64 검사 후 변환하여 NaN/소수/무한대/범위 초과를 닫힌 ID로 오인하지 않는다.
- 저장본 재읽기·인증 실패는 이미 완료된 커밋을 되돌린다는 뜻이 아니다. 자동 중복 등록 방지를 위해 재시도하지 않는다.
- 서명된 manifest, collection completeness, rollback/origin 보장은 추가하지 않았다.
- 공개 합성 비밀번호이므로 이 암호문이 실제 Secret을 보호한다고 주장하지 않는다.
- append-only whole-archive CAS는 레코드 편집/회전/충돌 outbox/다중 기기 동기화가 아니다.

## 리뷰와 검증 기록

독립 Rust 리뷰는 기존 전체 인증 → 신규 sealing 순서, 닫힌 입력, 버전/크기 상한,
원본 보존을 확인했다. 독립 TS 리뷰에서 요청한 배열 길이 선검사, 각 비동기 단계에
실제로 진입했음을 확인한 잠금 테스트, 잠금·재열기 뒤 오래된 실패 차단 테스트를 반영했다.

| 검사 | 최종 결과 |
|---|---|
| `cargo test -p vault-client-wasm --features synthetic-demo --locked --offline` | exit 0, 18/18, 67.37초 |
| `cargo test -p vault-local-core --lib --locked --offline registration::tests -- --test-threads=1` | 최종 테스트 입력 조정 후 exit 0, 4/4 |
| core 전체 `--lib` (독립 담당자 실행) | 29/29. 이후 테스트 선택값만 조정했고 위 focused 4개 재검증 |
| `cargo clippy -p vault-local-core -p vault-client-wasm --features synthetic-demo --all-targets --locked --offline -- -D warnings` | exit 0 |
| `cargo fmt -p vault-local-core -p vault-client-wasm -- --check` | exit 0 |
| `scripts/build-wasm.ps1 -SyntheticDemo` | debug build exit 0 |
| `scripts/build-wasm.ps1 -SyntheticDemo -Release` / 기본 `-Release` | 양쪽 exit 0 |
| `node scripts/test-wasm.mjs --demo` | debug/release 모두 exit 0, 624 checks, 5 catalogs, 54 archive rejections, 3 registrations |
| `node scripts/test-wasm.mjs` | 기본 export 부재 포함 exit 0, 11 checks |
| `npm.cmd run typecheck --prefix apps/web` | exit 0 |
| `npm.cmd test --prefix apps/web -- --maxWorkers=1` | release WASM 최종 전체 exit 0, 16 files, 601/601, 28.11초 |
| `npm.cmd run build --prefix apps/web` | exit 0, 38 modules |

첫 전체 웹 검사는 debug WASM에서 여러 KDF를 반복하는 신규 등록 통합 테스트 하나가
30초를 초과해 600 passed/1 timeout이었다. 해당 다중 작업 테스트만 90초로 조정하고
검사 조건은 유지했다. debug focused 2/2 재검증(59.48초), 이후 release 전체 601/601을
확인했다. 초기 Rust export 줄의 포맷 오류도 수정 후 최종 포맷 검사를 통과했다.

Node의 실제 WASM + fake-indexeddb 검사는 브라우저 Worker/IndexedDB·실제 파일
다운로드·모바일 실행의 증거가 아니다. 이번에는 브라우저 등록 UI 검사를 하지 않았다.
네이티브 전체 workspace/SQLite 보안 gate는 재실행하지 않았고 승인도 바꾸지 않았다.

## 남은 작업

1. 계정·프로젝트·환경의 의도된 local-only projection을 Rust/bridge/WASM/TS로 연결.
2. Claude Code의 디자인과 충돌하지 않는 선택형 등록 UI 및 재열기/검색 실제 브라우저 검사.
3. 관계 편집·회전 체크리스트와 레코드 revision/CAS를 별도 구현·검증.
4. 실제 비밀번호·API 키 입력은 복구/기기키/독립 보안 리뷰 등 기존 출시 조건 이후에만 개방.
