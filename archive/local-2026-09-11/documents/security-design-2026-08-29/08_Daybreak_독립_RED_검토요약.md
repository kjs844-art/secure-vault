# Daybreak 독립 RED 검토 요약

초기 구조 검토 대상: `codex/firstvibe-sqlite-store` / `4138dd7`  
최종 Phase 0A 재검토 대상: `e8b29cb6a014aed24725b0f658182b9d2cfc487d`  
검토 방식: 초기 구조 지도 + Phase 0A 구현 diff의 독립 RED 재검토  
검토자가 실행하지 않은 것: 실제 Secret 사용, store integration, push, main merge

## 결론

선택한 위협 범위에서 현재 코드는 아직 충분하지 않다. 실제 Secret gate는 계속 fail-closed해야 한다.

기능을 제공하면서 active raw-file mutation을 방어할 후보는 **Windows custom VFS / actual-handle binding**이다. Private snapshot은 trusted source acquisition 뒤의 방어 심화이며 단독 해결책이 아니다. VFS와 별도로 rollback/누락을 막는 authenticated monotonic completeness anchor가 필요하다.

최종 Phase 0A 후보 자체는 Spec Compliance와 Task Quality 모두 `Approved`, Critical `0`, Important `0`이었다. 다만 이 승인은 격리된 pre-existing writable-mapping primitive 코드에 대한 것이다. controller가 재검토 뒤 한 번 실행한 hard gate는 primitive Go를 관찰했지만, mandatory ordinary suite가 Application Control 오류 `4551`로 실행 전에 막혀 **권위 있는 Phase 0A 체크포인트는 Inconclusive**다. store integration은 중단 상태다.

## Phase 0A 구현 리뷰 결과

### 첫 구현에서 발견한 Important 항목과 수정

1. 허용 fixture는 `DEMO_VALUE_ONLY_MAPPING_A/B`뿐인데 mutation 경로가 임의 `X`를 쓸 수 있던 모순을 `A`→`B` 전체 fixture 전이로 통일했다.
2. `MapViewOfFile` 실패 뒤 `CloseHandle`이 Win32 last-error를 덮기 전에 원래 오류를 저장하도록 순서를 고쳤다.
3. tempdir와 fixture write 실패가 stable `INCONCLUSIVE_MAPPING_GATE:<operation>:os=<raw>` marker를 남기게 했다.

### 두 번째 리뷰에서 발견한 Important 항목과 수정

metadata 길이를 읽은 뒤 zero-length whole-file mapping을 요청하면 truncation 경쟁에서 pointer geometry가 오래된 metadata에 기대는 문제가 있었다. 최종 후보는 metadata를 pointer 안전성에서 제거하고 한 private geometry로 다음을 함께 고정했다.

- `CreateFileMappingW` maximum size: exact 25 bytes
- `MapViewOfFile` bytes to map: exact 25 bytes
- mutation offset: 24, 길이 안쪽임을 검증

### 최종 재검토 disposition

| 항목 | 결과 |
| --- | --- |
| Spec Compliance | Approved |
| Task Quality | Approved |
| Critical | 0 |
| Important | 0 |
| Minor | 1, non-blocking |

Minor: `open_synthetic_v1(&Path)`가 기존 파일 내용이 정확히 `A`인지 직접 검증하지 않는다. 현재 parent-created temp fixture, `publish = false`, feasibility feature, non-store child 범위에서는 차단 finding이 아니다. store 통합 전에는 내용 검증 또는 더 강한 capability boundary가 필요하다.

### 실행 증거와 해석

- final candidate explicit hard gate: exit `0`, 1 passed, 2 filtered → single primitive Go observation
- format/Clippy/diff/status: 모두 exit `0`
- mandatory ordinary suite: library test executable 실행 전 Application Control `4551`, exit `101`
- ordinary suite가 integration test에 도달하지 않았으므로 runtime ignored count를 주장하지 않음
- 전체 Phase 0A: Inconclusive
- full VFS/private SHM/store/actual Secret: 미승인

## 핵심 소스 근거

| 관찰 | 근거 |
| --- | --- |
| pre-open Windows handle이 write sharing 허용 | `crates/vault-local-store-sqlite/src/preflight_query.rs:232-246` |
| revalidate가 길이/경로 중심이고 same-length rewrite를 잡지 않음 | `crates/vault-local-store-sqlite/src/preflight_query.rs:201-229` |
| SQLite가 경로로 별도 connection open | `crates/vault-local-store-sqlite/src/preflight_query.rs:398-430` |
| bare BEGIN 뒤 첫 application read까지 deferred window | `crates/vault-local-store-sqlite/src/preflight_query.rs:414-424`, `:475-479` |
| RO close 뒤 경로로 RW 재open과 digest 비교 | `crates/vault-local-store-sqlite/src/preflight.rs:260-325` |
| rollback/omission 제한이 문서화됨 | `docs/THREAT_MODEL.md:52-60`, `docs/MVP.md:25-29` |

## RED 반증 기준

다음 중 하나라도 발생하면 “actual file-set binding 완료” 주장은 실패다.

- VFS 획득 뒤 외부 process의 main/WAL/SHM write/delete/writable mapping 성공
- SQLite file I/O가 VFS 소유 handle family 밖의 path-reopened handle 사용
- absent WAL/SHM create race에서 공격자 파일을 수락
- same-size A/B overwrite에서 hybrid state를 정상으로 수락
- RO에서 A를 승인하고 RW에서 B를 수정
- coherent old snapshot이나 complete omission을 최신 상태로 수락

마지막 항목은 VFS만으로 해결되지 않고 freshness/completeness anchor가 필요하다.

## 요구되는 두 보안 계층

### 계층 1 — Windows actual-handle VFS

- main/WAL/SHM file family 직접 소유
- 기존 raw writer/mapping 존재 시 첫 SQL 전 실패
- VFS 획득 뒤 외부 write/delete/mapping 차단
- 모든 SQLite I/O와 locking/shm callback을 검증 경계 안에서 수행
- `unsafe`를 별도 작은 crate에 격리

### 계층 2 — authenticated monotonic completeness anchor

- monotonic vault generation
- canonical head 전체 집합
- 전체 logical record/revision commitment 또는 Merkle root
- key epoch와 recovery generation
- 이전 checkpoint hash
- main/WAL/SHM 밖의 독립 보호 위치에 최신 anchor 저장

## Private snapshot의 정확한 역할

VFS로 source를 안전하게 획득한 다음에만 사용한다.

- preflight/auth를 공격자-controlled 원본에서 분리
- wrong password 원본 무쓰기를 명확히 함
- 부분 snapshot 승격을 type/state로 금지

제공하지 않는 것:

- source 획득 전 안전
- 원본 RW 승격 결속
- old snapshot freshness
- row omission completeness

## 최종 순서

1. 실제 Secret gate fail-closed 유지
2. Application Control `4551` 환경을 해결해 변경 없는 후보에서 mandatory ordinary suite를 다시 검증하거나 broker/service-boundary 재설계 명세 작성
3. 권위 체크포인트가 Inconclusive인 동안 full VFS/store 통합 중단
4. 향후 별도 승인 뒤 Windows actual-handle VFS 전체 callbacks/private SHM 설계·검증
5. VFS 뒤 private snapshot을 보조 계층으로 적용
6. authenticated monotonic completeness anchor 설계
7. Daybreak/Codex Security 재검토와 전체 회귀

## Phase 0A 전체 브랜치 최종 RED 리뷰

검토 범위: `bf29357..88fd18f`

- 코드 리뷰 품질: **Approved**
- Critical: `0`
- Important: `0`
- Minor: `1` — `open_synthetic_v1(&Path)`가 기존 파일이 정확한 합성 A fixture인지 스스로 보증하지 않는다. 현재 격리 probe에서는 비차단이지만 store 재사용 전 exact same-handle 내용 검증 또는 더 강한 내부 capability로 바꿔야 한다.
- merge readiness: **No** — mandatory ordinary suite가 Application Control `4551`로 exit `101`이므로 finishing gate를 통과하지 못했다.
- 허용되는 다음 행동: 변경 없는 검토 후보에서 Windows Application Control 환경을 해결한 뒤 mandatory ordinary suite만 다시 실행한다. 이미 한 번 완료한 explicit hard gate는 통과를 만들기 위해 반복하지 않는다.
- 금지: full VFS/store 통합, 실제 Secret 입력, push, main 병합.
