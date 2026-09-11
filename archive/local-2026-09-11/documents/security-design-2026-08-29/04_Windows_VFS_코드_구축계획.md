# Windows VFS 코드 구축 계획

상태: **설계 승인 전 계획 초안**  
주의: 아래 경로와 타입은 제안이며 아직 생성·수정되지 않았다.

## 목표

SQLite가 실제로 사용하는 main/WAL/SHM I/O를 검증된 Windows handle과 결속하고, 첫 query 전부터 RW store 종료까지 그 결속을 유지한다.

## 제안하는 코드 경계

### 새 native crate

제안 경로:

`crates/vault-local-sqlite-vfs-windows`

책임:

- Windows SQLite 전용 VFS 등록·해제
- SQLite native callback과 Windows HANDLE FFI
- main/WAL/SHM actual handle family의 직접 소유와 역할 분류
- actual file ID, volume, final path, reparse, size/share policy 확인
- `xOpen`, `xRead`, `xFileSize`, `xWrite`, `xTruncate`, `xLock`, `xShmMap`, `xShmLock` 정책 적용
- 상위 crate에는 opaque capability만 반환

금지:

- Secret 복호화
- schema/비밀번호 인증
- raw HANDLE 또는 raw `sqlite3*`를 public API로 반환
- 검증 실패 시 기본 VFS로 조용히 fallback
- 기본 VFS가 다시 경로를 열게 한 뒤 metadata만 재확인하는 방식

### 기존 Windows platform crate

`crates/vault-local-platform-windows`

유지·확장 후보:

- Trusted LocalAppData root
- fixed local volume 확인
- full 128-bit file identity
- final path와 reparse 검사 helper
- 작은 Windows 정보 조회 API

VFS callback 수명과 SQLite ABI는 새 native crate가 소유하고, 일반 platform helper와 혼합하지 않는 편이 감사하기 쉽다.

### SQLite store crate

`crates/vault-local-store-sqlite`

변경 후보:

- `preflight_query.rs`: path-only open을 bound VFS open으로 교체
- `preflight.rs`: private snapshot 검사와 RO→RW epoch 전달
- `schema.rs`: writable hardening SQL 전에 actual binding 완료
- `store.rs`: connection과 guard를 함께 lifetime 보유
- `error.rs`: actual-handle, sidecar, snapshot, concurrent-change 오류 분류
- `lib.rs`: `forbid(unsafe_code)` 유지

## 제안하는 안전 타입

아래는 이름과 책임만 제안한다. 실제 Rust 선언은 design spec 승인 뒤 작성한다.

- `BoundSqliteVfsV1`: 등록된 VFS와 정책 수명 소유
- `VaultFileSetEpochV1`: main/WAL/SHM identity와 허용 snapshot 상태를 나타내는 불투명 값
- `BoundReadOnlySourceV1`: source read transaction과 file-set guard 소유
- `VerifiedSnapshotV1`: backup 완료와 구조 검사가 성공한 private DB만 표현
- `AuthenticatedSnapshotV1`: master password와 current revisions 인증까지 성공한 상태
- `BoundWritableStoreV1`: RW connection, file-set guard, app lock을 함께 소유

타입 전이는 one-way로 만든다. 부분 backup이나 인증 실패 객체에서 writable store를 만들 수 없어야 한다.

## 구현 작업 순서

### Phase 0 — 정식 spec과 공격 모델 고정

- same-user raw file attacker 범위 명시
- Windows-only v1 명시
- 정상 crash-WAL 지원 여부 명시
- SHM 정책과 fallback 금지 명시
- native code review 기준과 SQLite 버전 고정

완료 조건: 사용자 spec 승인과 Daybreak 설계 리뷰.

### Phase 1 — 임시 fail-closed release gate

- 새 경계를 지원하지 않는 existing DB는 실제 Secret 모드에서 열지 않음
- 합성 테스트 모드와 실제 Secret future gate 분리
- unsupported/file-state 오류 안정화

완료 조건: 안전을 증명하지 못한 경로가 기존 path-only open으로 내려가지 않음.

### Phase 2 — actual main handle 결속

- SQLite가 실제 연 main handle identity 확인
- pre-open handle과 actual handle 비교
- final path, volume, reparse, directory/delete-pending 검사
- 첫 application SQL 이전 실패 보장

완료 조건: main substitution/ABA 테스트가 SQL 실행 전에 fail-closed.

주의: 이 단계만으로 WAL/SHM 완료를 주장하지 않는다.

### Phase 3 — WAL/SHM wrapper VFS

- main/WAL `xOpen`의 역할·handle·크기 정책
- existing main/WAL/SHM의 write/delete sharing 배제
- absent sidecar namespace 선점 또는 동등한 race-free 정책
- read budget과 snapshot length enforcement
- WAL truncate/reset/replace/growth 경합 처리
- SHM map/lock 정책과 정상 SQLite semantics 위임
- 모든 callback 오류의 SQLite error mapping

Daybreak 반증 기준: VFS 획득 뒤 외부 `GENERIC_WRITE`, delete, writable mapping이 성공하거나 SQLite I/O가 VFS 소유 handle family 밖에서 발생하면 이 단계는 실패다. absent WAL/SHM reservation은 정상 create/checkpoint/recovery를 깨지 않는다는 것을 별도 prototype으로 증명한다.

완료 조건: 정상 crash-WAL은 정확히 복구되고 raw sidecar 경합은 혼합 snapshot 없이 실패하거나 고정 snapshot을 반환.

### Phase 4 — private in-memory snapshot

- bound source read transaction
- Backup API destination을 private memory DB로 제한
- page/byte/time/cancel budget
- 부분 destination의 type promotion 금지
- 모든 preflight/auth query를 snapshot으로 이동

완료 조건: wrong password에서 원본 write event 0, 원본 main/WAL/SHM의 보안상 의미 있는 상태 불변.

### Phase 5 — RO→RW 승격 연속성

- RO file-set epoch를 RW open에 전달
- 같은 VFS policy로 writable actual handles 결속
- `BEGIN IMMEDIATE` 안에서 identity/schema/caps/digest 재검사
- 성공 guard를 store lifetime까지 유지

완료 조건: RO 승인 A와 RW 수정 B를 다르게 만드는 모든 barrier 테스트가 쓰기 전에 실패.

### Phase 6 — API 밀봉과 compile-fail

- raw connection/handle/VFS internals 외부 노출 금지
- Secret raw type 외부 추출 금지
- invalid state transition compile-fail
- unsafe audit: native crate 밖 unsafe 0

### Phase 7 — 전체 검증과 독립 리뷰

- focused tests
- workspace tests
- format과 Clippy
- synthetic plaintext pattern scan
- dependency/license review
- Daybreak RED 재검토
- Critical/Important 수정 후 재검증

## 결정적 RED 테스트 매트릭스

| 공격 시점 | 변형 | 성공 기준 |
| --- | --- | --- |
| pre-open 뒤, SQLite open 전 | main replace/ABA | actual identity mismatch, SQL 0회 |
| SQLite open 직후, 첫 query 전 | main same-length rewrite/growth | fail-closed 또는 고정 snapshot |
| WAL `xOpen` 직전·직후 | append/truncate/reset/replace | A 또는 B 한 snapshot만, 혼합 금지 |
| 첫 WAL read 전 | huge/sparse growth | byte/page/time budget 전에 중단 |
| SHM map/lock | create/delete/replace/corrupt | private/bounded policy 또는 fail-closed |
| VFS 획득 전후 | external writer handle/mapping | 선점된 writer가 있으면 open 실패, 획득 뒤 새 writer는 sharing violation |
| backup 도중 | source writer/attacker/panic/cancel | 부분 snapshot 승격 금지 |
| 인증 실패 | wrong password | 원본 application write 0 |
| RW 승격 | RO A → RW B | BEGIN IMMEDIATE 쓰기 전 거부 |
| future/corrupt | unknown version/bad auth | 원본 byte 보존, 자동 migration 금지 |
| 프로세스 종료 | commit 전/후 kill | 이전 또는 새 commit만, 반쪽 상태 금지 |

## 정상 동작 회귀

- clean-close DB without WAL/SHM
- committed crash-WAL
- uncommitted WAL tail
- multiple immutable revisions/heads/conflicts
- restart/unlock/search/copy 합성 흐름
- supported current schema
- bounded DB at cap boundary

## 계획된 검증 명령

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
```

focused VFS/process-race test 명령은 실제 test target 이름을 정식 plan에서 확정한다. 과거 Windows Application Control 오류 `4551`가 재발하면 테스트 실패와 정책 차단을 구분하고, 차단된 실행을 통과로 보고하지 않는다.

## 완료 정의

- actual main/WAL/SHM 경계를 소스와 테스트로 증명
- 모든 SQLite file I/O가 동일 검증 handle family를 사용한다는 trace 증명
- wrong password/future/corrupt 원본 보존
- crash-WAL correctness 유지
- raw capability 비노출
- 실제 Secret gate는 여전히 닫힘
- Daybreak/Codex Security 독립 검토에서 미해결 Critical/Important가 없음

VFS 완료만으로 rollback/omission, recovery, 웹·모바일·서버 보안까지 완료된 것은 아니다.
