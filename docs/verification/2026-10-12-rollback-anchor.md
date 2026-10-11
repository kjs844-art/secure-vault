# 2026-10-12 — rollback·누락 anchor 저장 경계 검증 기록

## 배경

`docs/MVP.md`와 `docs/ARCHITECTURE_STATUS_MAP.md`는 현재 CAS(expected-head 비교)가 정상 API의 stale writer만 다루며, **유효한 과거 DB/WAL 전체 복원(canonical head rollback)과 완전한 row 누락**을 탐지하지 못한다고 명시했다. 이 기록은 해당 갭을 닫는 rollback/누락 탐지 anchor 구현을 다룬다.

## 구현된 설계

### Sidecar anchor ledger

DB 파일 옆에 `<db>.anchor` append-only 파일을 둔다. 스키마 v1(SQLite 내부)은 불변이며 기존 지문 계약도 그대로다.

```text
[offset 0..8]   MAGIC "SVLTANH1"
[offset 8..16]  anchor format version (1)
[offset 16..24] confirmed record count (u64 BE)
[이후 64바이트마다] logical digest 32B + blake3(digest) 32B
```

- 레코드 수는 파일 크기로 유도된다. 마지막 레코드가 미완선(64바이트 미만)이면 crash로 남은 tentative로 간주해 무시된다.
- 각 레코드는 자체 blake3 체크섬으로 무결성이 검증되고, 헤더의 confirmed count와 실제 레코드 수가 맞아야 한다.

### 판정 규칙 (`authenticate_current_revisions` 마지막 단계)

인증된 DB logical digest를 anchor와 비교한다.

| 판정 | 조건 | 결과 |
|---|---|---|
| `Bootstrap` | anchor 부재/빈 파일 | 첫 승격에서 anchor 생성 |
| `Current` | 최신 confirmed 레코드와 일치 | 정상 |
| `ConfirmTentative` | 마지막 tentative와 일치 (crash 창) | 승격에서 확정 |
| `Rollback` | 과거 confirmed 레코드와 일치 | **ReadOnlyPreservation** (과거 백업 복원 감지) |
| `Unknown` | 어디에도 없는 digest | **ReadOnlyPreservation** (row 누락·외부 변경 감지) |

구조 손상·변조된 anchor는 오류로 거부된다(보존). anchor 부재(`Bootstrap`)는 기존 v1 저장소 마이그레이션을 위해 첫 승격까지만 허용되고, 이후 다시 사라지면 보존된다.

### 쓰기 경로

- `initialize_v1`: 초기 singleton 확정 후 anchor를 생성한다.
- `commit_candidate`: SQLite 커밋 성공 직후 DB의 logical digest를 계산해 confirmed 레코드로 append한다. append 실패 시 store는 preservation latch로 전환된다. 커밋은 반복돼도 동일 digest는 중복 기록되지 않는다(idempotent).
- `promote`: 승격 재검증 통과 후 `adopt_for_promotion`으로 tentative 확정/정리/신규 생성을 수행한다.

crash 창 분석: SQLite 커밋 후 anchor append 전에 crash가 나면 DB는 새 digest, anchor는 과거 상태가 되어 재시작 시 `Unknown` → 보존 처리된다. 데이터는 보존되고 writable 승격만 거부된다(안전 방향 실패). tentative 레코드 전체가 crash로 남으면 `ConfirmTentative`로 회복된다.

## 변경 파일

- `crates/vault-local-store-sqlite/src/anchor.rs` (신규) — ledger 파서·판정·쓰기, 단위 테스트 7개
- `crates/vault-local-store-sqlite/src/commit.rs` — 커밋 후 confirmed append
- `crates/vault-local-store-sqlite/src/preflight.rs` — authenticate 단계 anchor 판정, promote 시 adopt
- `crates/vault-local-store-sqlite/src/schema.rs` — 초기화 시 anchor 생성
- `crates/vault-local-store-sqlite/src/store.rs` — database_path·anchor_path 보유
- `crates/vault-local-store-sqlite/src/preflight_query.rs` — from_hardened_connection 생성자, database_path 접근자
- `crates/vault-local-store-sqlite/tests/anchor_guard.rs` (신규) — anchor 부재·rollback·row 누락 통합 시나리오
- `crates/vault-local-store-sqlite/tests/restart_roundtrip.rs` — 외부 원시 SQL 쓰기 2개 시나리오의 기대치를 보존 방향으로 갱신

## 검증 결과

이 기록 작성 환경은 Linux 샌드박스로, `TrustedLocalAppDataRootV1::for_current_user()`가 `UnsupportedPlatform`을 반환한다. 스토리지 통합 테스트는 전부 이 단계에서 차단되므로 실제 파일 시스템 시나리오는 Windows 로컬 검증(`scripts/verify-local.ps1 -Scope Workspace`)에서 실행해야 한다.

- `cargo test --workspace --no-fail-fast`: 변경 전후 실패 목록 완전 동일(19+α개, 전부 기존 Windows 전용 환경 실패). 회귀 없음.
- 신규 통과: `vault-local-store-sqlite` lib 26→33 passed (+7 anchor 단위 테스트, Linux에서 실행 가능한 유일한 계층).
- 신규 `anchor_guard` 통합 테스트 3개: Linux에선 다른 모든 스토리지 테스트와 동일한 `UnsupportedPlatform`으로 실패하며, Windows 검증 스크립트에서 실제 시나리오(anchor sidecar 부재, 과거 백업 복원, row 삭제)를 검증한다.
- `cargo clippy -p vault-local-store-sqlite --all-targets --all-features`: store-sqlite 크레이트 경고 0.
- `cargo fmt --all -- --check`: 통과.

기존 `vault-local-platform-windows`의 Linux dead-code clippy 경로는 기준 상태와 동일하며 이 변경과 무관하다.

## 승격·보안 게이트 영향

- `REAL_SECRET_GATE=CLOSED` 유지. 실제 Secret 입력 금지는 변함없다.
- Phase 0A 보안 승인 대상 아님. 이 변경은 저장 경계의 잠금 해제 이전 방어 계층이다.
- MVP 문서가 지적한 "과거 DB/WAL 복원 탐지"와 "완전한 row 누락 탐지" 갭이 닫혔다. 남은 ①단계 과제는 anchor ledger의 최대 레코드 수(30,000) 운영 정책과 anchor 파일 자체의 백업·훈련 시나리오 검토다.
