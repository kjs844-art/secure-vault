# 2026-09-16 SQLite 읽기 전용 preflight hardening 검증

기준 작업트리: `codex/firstvibe-local-session-hardening`의 미커밋 변경.
이 기록은 `vault-local-store-sqlite`의 읽기 전용 preflight 연결 설정, 패키지 회귀와
최종 일반 workspace 검증 증거다. Windows VFS 권위 승인 또는 실사용 금고 보안 승인이 아니다.

`REAL_SECRET_GATE=CLOSED`, `PHASE_0A_VERDICT=UNCHANGED`.

## 변경한 경계

기존 `PreflightQueryGate::open_read_only`는 read-only flags로 직접 연결한 뒤 timeout과
extension 비활성화만 적용했다. 현재는 `schema::open_read_only`를 호출하고, 읽기 전용과
쓰기 가능 연결이 모두 `harden_connection`의 공통 보안 프로필을 거친다.

```text
SQLite connection open
  → busy timeout / extension loading disable
  → 아래 8개 DB_CONFIG를 설정하고 각각 readback 검증
  → 그 뒤에만 mode별 첫 SQL 실행
      read-only: query_only=ON, foreign_keys=ON, recursive_triggers=ON
      writable:  journal_mode=WAL, synchronous=FULL, query_only=OFF,
                 foreign_keys=ON, recursive_triggers=ON
  → main의 실제 read-only 상태와 foreign_keys/trusted_schema 최종 확인
```

공통으로 설정·재확인하는 DB config는 다음 8개다.

| DB config | 기대값 |
|---|---:|
| `SQLITE_DBCONFIG_DEFENSIVE` | `true` |
| `SQLITE_DBCONFIG_TRUSTED_SCHEMA` | `false` |
| `SQLITE_DBCONFIG_ENABLE_FKEY` | `true` |
| `SQLITE_DBCONFIG_ENABLE_TRIGGER` | `true` |
| `SQLITE_DBCONFIG_DQS_DML` | `false` |
| `SQLITE_DBCONFIG_DQS_DDL` | `false` |
| `SQLITE_DBCONFIG_ENABLE_ATTACH_CREATE` | `false` |
| `SQLITE_DBCONFIG_ENABLE_ATTACH_WRITE` | `false` |

읽기 전용 연결은 기존 read-only/no-follow flags에 더해 `query_only=ON`을 확인한다.
`query_only` 하나만을 파일 쓰기 보안 경계로 보지 않으며, read-only open flags,
ATTACH create/write 비활성화, DQS 비활성화, untrusted schema 및 defensive mode를 함께
적용한다. writable 연결은 같은 DB config 집합을 쓰되 `query_only=OFF`와 기존
WAL/`synchronous=FULL` 계약을 유지한다.

## 회귀 검사 내용

`read_only_preflight_connection_enforces_the_shared_security_profile`은 완성된 preflight
연결에서 다음을 확인한다.

- `main`이 실제 read-only이고 `query_only=1`, `recursive_triggers=1`,
  `foreign_keys=1`, `trusted_schema=0`이다.
- 8개 DB config readback이 위 표와 정확히 같다.
- `SELECT "not_a_column"`이 문자열 DQS fallback으로 성공하지 않는다.
- `ATTACH`가 새 파일을 만들지 못하고 database list는 `main` 1개뿐이다.
- `CREATE TEMP TABLE`도 `query_only`에 의해 거부된다.

독립 정적 리뷰는 초기 구현에서 DB config가 WAL/PRAGMA SQL **뒤에** 적용되는 순서 문제를
Important로 찾았다. 따라서 그 시점의 45개 패키지 통과를 “첫 SQL 전에 hardening 완료”의
증거로 사용하지 않는다. 후속 수정은 8개 DB config 설정과 readback을 모든 SQL보다 앞으로
옮겼다. `all_security_db_configs_precede_sql_hardening_calls`는 `harden_connection` 소스에서
마지막 DB config readback이 prepare/execute/query/PRAGMA helper보다 앞서는 순서를 고정한다.
이는 순서 회귀 검사이며 조작된 실제 SQLite 스키마를 실행한 침투 테스트는 아니다.

수정 뒤 별도 읽기 전용 재검토에서는 이 변경 범위에 남은 Critical/Important를 찾지 않았다.
검토자는 코드를 다시 읽었고 테스트를 대신 실행하지 않았으므로, 이 판단과 아래 실행 증거를
구분한다. 이는 전체 SQLite·제품 보안 승인도 아니다.

## 실행 증거와 정확한 실패 경계

검사 순서는 다음과 같다.

| 시점·명령 | 결과 |
|---|---|
| 공통 RO/WR hardening 초기 구현 뒤 `cargo test --offline --locked -p vault-local-store-sqlite --lib -- --test-threads=1` | exit 0, **45 passed / 0 failed / 1 ignored** |
| 첫 full workspace 재시도: `pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-local.ps1 -Scope Workspace` | `default-tests` 단계의 내부 `cargo test --offline --locked --workspace --tests -- --test-threads=1`에서 `vault_local_store_sqlite` lib 실행 전 Windows Application Control이 차단. `os error 4551`, 내부 cargo exit 101, verify-local exit 1 |
| 독립 리뷰의 적용 순서 Important 수정 뒤 같은 패키지 단독 명령 재실행 | exit 0, **46 passed / 0 failed / 1 ignored**, 약 71.57초 |
| 최초 filtered 확인 `cargo test -p vault-local-store-sqlite all_security_db_configs_precede_sql_hardening_calls` | 새 lib test는 통과했으나, Cargo가 필터된 integration executable `future_and_corruption`을 실행하려다 Windows Application Control `os error 4551`; 명령 전체 exit 1 |
| `cargo test -p vault-local-store-sqlite --lib all_security_db_configs_precede_sql_hardening_calls` | exit 0, 순서 회귀 **1/1** |
| `cargo test -p vault-local-store-sqlite` | exit 0, 전체 target 합산 **91 passed / 1 ignored** |
| `cargo clippy -p vault-local-store-sqlite --all-targets -- -D warnings` | exit 0 |
| `cargo fmt --all -- --check` | exit 0 |
| 최종 현재 트리 `pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-local.ps1 -Scope Workspace` | exit 0, Secret scan·format·workspace all-target/all-feature Clippy·workspace tests·VFS ordinary tests·workspace doctests 전부 통과; `LOCAL_CHECKS_PASSED`, `REAL_SECRET_GATE=CLOSED` |

마지막 lib 패키지 단독 재실행은 이 문서 작성 중 현재 트리에서 다시 확인했고, 구현 담당자의
전체 target·Clippy·format 결과도 위 표처럼 분리해 기록했다. 추가된 1개 lib test는 DB config
선행 순서 회귀다. ignored 1개는 부모 crash test가 직접 호출하는 정확한 lib-test child
entrypoint이며, 부모 원자성 검사는 통과했다.

두 `4551` 기록은 테스트 assertion 실패가 아니라 정책이 당시 테스트 실행 파일의 실행을
막은 결과다. 정책을 우회하거나 파일명을 바꾸지 않았고, 이후 동일한 최종 workspace 명령을
그대로 다시 실행해 exit 0을 확인했다. 따라서 현재 일반 workspace 검증 결과는 통과로
갱신한다. 다만 명시적으로 ignored인 Phase 0A security feasibility gate를 실행하거나 승인한
결과는 아니며 `PHASE_0A_VERDICT=UNCHANGED`다.

## 미검증·보류 경계

- 현재 수정 뒤 일반 workspace의 Secret scan·format·Clippy·tests·doctests는 하나의 최종
  run에서 통과했다. 명시적으로 ignored인 별도 보안 gate는 이 일반 run의 범위가 아니다.
- DB config 순서 검사는 소스 순서 회귀이고, 악성 schema/virtual table fixture를 이용한 실제
  open-before-query 공격 통합 검사는 아니다.
- 순서 test는 `include_str!` 기반 lexical guard라 향후 간접 helper 내부에 숨은 SQL까지
  탐지하지 못한다. 신규 runtime profile assertion도 RO 중심이며 WR 최종 프로필 전체를
  직접 assertion하는 대칭 테스트는 없다.
- Windows actual-handle Phase 0A/VFS 권위 판정, WAL/SHM 실제 adversarial race,
  process restart 전체 제품 흐름은 이번 패키지 검사 범위가 아니다.
- `query_only`와 DB config 설정은 rollback/누락 anchor, 복구, 동기화, 기기 키, Android
  Keystore 또는 독립 암호 검토를 대신하지 않는다.
- 실제 비밀번호·API key·Secret을 저장하거나 입력한 검사가 아니다.

따라서 현재 결론은 **read-only preflight가 writable 경로와 8개 DB config hardening을
공유하고 `query_only`를 강제하며, 수정 뒤 패키지와 일반 workspace 검사가 exit 0이었다**는
사실이다. Phase 0A 권위 승인과 출시 보안 판정은 계속 보류한다.
