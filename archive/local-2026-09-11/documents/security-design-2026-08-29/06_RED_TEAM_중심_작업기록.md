# KeyAtlas RED Team 중심 작업 기록

상태: 살아 있는 문서  
작성 시작: 2026-08-29 KST  
최종 probe 후보 revision: `e8b29cb6a014aed24725b0f658182b9d2cfc487d`

최신 문서 revision: `88fd18f22b446e8e8b09a63a12b80bc75b2ab4ef`

> 이 문서는 방어 설계를 위한 공격 관점 기록이다. 실제 공격 실행 절차, 실제 Secret, credential material을 저장하지 않는다. 가설과 확인된 finding을 구분한다.

## RED 우선 원칙

1. 공격자의 선행 권한을 먼저 적는다.
2. 현재 방어와 새로 얻는 공격 능력을 분리한다.
3. 경로 문자열, 설정 존재, 테스트 이름을 실제 보장으로 착각하지 않는다.
4. 가장 강한 반증과 잔여 위험을 함께 적는다.
5. 구현 전에는 “해결”이라고 쓰지 않는다.
6. Critical/High를 관심 끌기 위해 부풀리지 않는다.
7. 실제 Secret gate는 독립 출시 조건으로 유지한다.

## RED-01 — 사전 검사 객체와 SQLite 실제 main handle 불일치

### 선행 조건

공격자는 같은 Windows 사용자 권한에서 금고 경로의 파일을 조작할 수 있지만, KeyAtlas 프로세스 내부 코드 실행은 아직 갖지 않는다.

### 관찰됨

- 사전 검사 파일은 별도 OS handle이다.
- rusqlite는 경로를 다시 열어 SQLite 내부 handle을 만든다.
- actual SQLite main handle identity를 첫 SQL 전에 사전 검사 객체와 결속하는 완료된 경계가 없다.

### 공격자 목표

검사받은 A 대신 다른 B를 SQLite가 읽게 하거나, 같은 객체를 검사 뒤 수정해 검증과 실제 query 대상의 차이를 만든다.

### 현재 방어

- Trusted LocalAppData
- fixed local volume
- no-follow
- delete-share 제한
- retained file metadata 재검사
- 앱 전용 lock

### 반증

Windows에서 delete share를 주지 않은 retained main handle은 pathname 교체를 어렵게 한다.

### 잔여 위험

write share가 남아 같은 handle의 제자리 수정·증가가 가능하고, actual SQLite handle과의 결속도 별개다.

### 요구 테스트

- pre-open 뒤 replace/ABA
- SQLite open 뒤 첫 query 전 same-length write/growth
- actual handle identity 실패 시 query counter 0

### 상태

설계 미완료, 실제 Secret 출시 차단.

## RED-02 — WAL sidecar의 생성·증가·reset·교체

### 관찰됨

main handle용 file-control만으로 WAL과 SHM 전체를 고정할 수 없다. WAL은 최신 committed state를 포함할 수 있고 reader transaction 뒤에도 writer가 append할 수 있다.

### 공격자 목표

앱이 허용 크기를 확인한 시점과 SQLite가 recovery/read하는 시점 사이에서 WAL의 물리 상태를 바꾼다.

### 반증

정상 SQLite WAL read transaction은 논리적 end mark를 고정해 정상 writer와 일관 snapshot을 제공한다.

### 잔여 위험

raw file attacker는 정상 SQLite lock 규약을 따르지 않는다. 최초 WAL open/recovery 전 huge/sparse growth나 기존 범위 overwrite는 read transaction만으로 막을 수 없다.

### 요구 방어

- VFS `xOpen/xRead/xFileSize`에서 role/identity/budget enforcement
- WAL reset과 same-length rewrite 고려
- 정상 crash-WAL semantics를 기본 VFS에 정확히 위임

### 상태

미구현, VFS 핵심 범위.

## RED-03 — SHM 검증 착각

### 관찰됨

SHM은 main/WAL과 같은 방식의 권위 데이터 파일이 아니라 WAL index·locking에 관여한다. pathname 존재/길이 확인만으로 실제 `xShmMap/xShmLock` 사용을 결속했다고 할 수 없다.

### 공격자 목표

SHM create/delete/replace/corrupt 타이밍을 이용해 앱의 사전 검사와 SQLite locking state를 다르게 만든다.

### 요구 방어

- wrapper VFS의 SHM callback 경계
- private/bounded SHM 정책 또는 명확한 fail-closed
- stock Windows VFS locking semantics 보존 검증

### 상태

미구현, main-only fix로 닫을 수 없음.

## RED-04 — RO 승인 A와 RW 수정 B

### 관찰됨

현재 흐름은 RO gate와 pre-open handles를 drop하고 경로로 writable connection을 다시 연다. logical digest는 내용 비교 도구지만 actual file identity/freshness의 완전한 증명은 아니다.

### 공격자 목표

안전한 A에서 인증을 통과한 뒤 writable open 전에 B를 배치해 앱이 B를 수정하게 만든다.

### 요구 방어

- opaque file-set epoch를 RO→RW로 이동
- same VFS policy로 RW actual handles 결속
- `BEGIN IMMEDIATE` 안에서 identity+schema+caps+digest 재검사
- guard를 writable store lifetime까지 유지

### 상태

미구현, snapshot 단독 해결책의 가장 큰 잔여 위험.

## RED-05 — hostile DB/WAL에 대한 자원 고갈

### 관찰됨

현재 bounded integrity와 row/byte caps가 있으나, SQLite가 첫 query/recovery에서 처리한 작업이 cap 확인보다 앞설 수 있다.

### 공격자 목표

거대·sparse main/WAL이나 비정상 page graph로 unlock CPU, memory, disk I/O를 소진한다.

### 반증

현재 pre-open size caps와 bounded query가 공격 면을 줄인다.

### 잔여 위험

공격자가 cap 검사 전에 SQLite parser/recovery를 실행하게 만들 수 있다면 budget이 늦다.

### 요구 방어

- VFS read-byte budget
- page/time/cancel budget
- snapshot destination 상한
- budget 초과 전 deterministic abort

## RED-06 — 부분 snapshot의 잘못된 승격

### 공격자 목표

backup I/O 오류, cancel, panic, 프로세스 종료 뒤 불완전 destination이 “검증 완료”로 취급되게 한다.

### 요구 방어

- 생성 중 상태와 sealed snapshot 타입 분리
- backup finish 성공과 모든 cap 검사 뒤에만 type promotion
- partial destination public API 노출 금지
- 실패 시 원본 보존

## RED-07 — custom VFS가 새 취약점이 되는 위험

### 추론됨

VFS는 SQLite의 모든 파일 I/O와 locking을 건드리는 고권한 native 경계다. callback lifetime, thread safety, error mapping, buffer length, sync/lock semantics를 잘못 구현하면 기존보다 큰 손상·memory-safety 위험이 생길 수 있다.

### 요구 방어

- 작은 wrapper, 가능한 동작은 stock win32 VFS에 위임
- unsafe/FFI 별도 crate 격리
- SQLite ABI/version 고정과 upgrade review
- native static analysis, sanitizer 가능한 환경, code review
- fallback 금지와 명시적 unsupported

### 잔여 위험

VFS 구현 자체가 trusted computing base에 추가된다. 코드량과 callback 수를 최소화해야 한다.

## RED-08 — wrong password 경로의 숨은 쓰기

### 공격자/실패 목표

인증 실패 중 migration, initialize, journal mode 변경, SHM bookkeeping이 발생해 원본 상태가 바뀐다.

### 현재 방어

application writable open은 인증 뒤로 미뤄져 있다.

### 요구 증거

- 원본 main/WAL/SHM hash·length·metadata 비교
- VFS application write-event 0
- migration/initialize query 0
- error/log에 password/ciphertext 없음

## RED-09 — future/corrupt 자동 복구가 증거를 없앰

### 공격자/실패 목표

지원하지 않는 future row나 일부 손상 row를 앱이 정리·삭제·덮어써 원본 증거와 복구 가능성을 잃게 한다.

### 현재 방어

future version과 current corruption을 보존 상태로 분류하는 설계와 테스트 자산이 있다.

### 회귀 조건

VFS/snapshot 변경 뒤에도 byte preservation, no migration, no initialize를 다시 증명한다.

## RED-10 — 과거 정상 상태 rollback과 행 누락

### 관찰됨

각 row가 암호학적으로 유효해도 과거 전체 DB/WAL 조합이거나 일부 row가 통째로 빠졌을 수 있다. 현재 CAS는 정상 stale writer 충돌을 다루지만 외부 rollback/omission의 독립 freshness anchor가 아니다.

### 공격자 목표

오래된 API 키 상태로 되돌리거나, 회전·폐기·경고 기록을 제거해 사용자가 최신이라고 믿게 만든다.

### 요구 방어

- authenticated whole-store manifest
- checkpoint chain과 monotonic epoch
- 삭제 tombstone 포함
- device-protected 또는 독립 witness anchor
- rollback을 허용하는 복구 UX의 명시적 경고

### 상태

VFS 뒤에 남는 다음 P0. 실제 Secret gate 계속 차단.

## RED-11 — 잠금 해제 후 메모리·클립보드·화면

VFS가 성공해도 사용자가 Secret을 보는 순간 평문은 메모리/UI에 존재한다. 같은 사용자 malware 전체를 막았다고 주장하면 안 된다.

후속 통제 후보:

- 짧은 reveal과 auto-lock
- clipboard TTL과 clear 결과 확인
- crash dump 정책
- sensitive screen capture 정책
- 최소 평문 수명과 불필요한 복사 금지
- MCP/플러그인에 전체 금고 원문 노출 금지

## RED-12 — 공급망과 업데이트

서명된 악성 업데이트나 build credential 침해는 잠금 해제 순간 모든 Secret을 가져갈 수 있다. VFS는 이 경계를 보호하지 않는다.

후속 통제 후보:

- dependency pinning과 SBOM
- signed/reviewed release
- CI 최소 권한
- reproducible build 검토
- update rollback protection

## RED-13 — creator handle을 닫은 기존 writable mapping 우회

### 공격자 선행 조건과 목표

같은 Windows 사용자 권한의 별도 프로세스가 KeyAtlas보다 먼저 main/WAL 역할의 경로를 열어 writable mapping과 mapped view를 만든다. 공격자는 creator file handle만 닫고 mapping object와 view는 계속 유지해, 평범한 “현재 열린 writer handle 검사”를 우회하려 한다.

### 이번에 구축한 격리 반증 장치

- 경로: `crates/vault-local-sqlite-vfs-windows`
- 데이터: `DEMO_VALUE_ONLY_MAPPING_A`와 마지막 byte만 바꾼 `DEMO_VALUE_ONLY_MAPPING_B`
- geometry: exact length 25, mutation offset 24
- 순서: pre-control 성공 → child mapping/view 생성 → creator `File` drop → `READY` → parent guard acquire → 필요할 때만 `MUTATE/MUTATED` → `EXIT` → post-control
- 동기화: stdin/stdout fixed frame만 사용
- 금지: correctness용 sleep, polling, 확률적 retry, hash 반복, byte-range lock
- hang 탐지: `WaitForSingleObject` 20초 watchdog이며 race를 맞추는 타이머가 아님

### RED 판정 규칙

방어 성공의 핵심은 “나중에 byte가 바뀌었는지”가 아니라 **parent guard 획득 자체가 OS code 32로 실패하는가**다.

- hostile interval만 `ERROR_SHARING_VIOLATION (32)`이고 pre/post control 모두 원래 `A` 마지막 byte를 읽음: 단일 primitive Go 관찰
- mapping이 살아 있는데 guard 획득 성공: 즉시 No-Go. mutation 관찰 여부와 무관
- 다른 OS code, child/protocol/timeout 오류, 환경 mismatch, mandatory hygiene 실패: Inconclusive

### 독립 RED 리뷰에서 발견하고 닫은 항목

1. **허용 fixture 모순:** 첫 구현의 임의 `X` mutation 가능성을 제거하고 전체 합성 값 `A`→`B`만 쓰게 고쳤다.
2. **Win32 last-error 손실:** `MapViewOfFile` 실패 뒤 cleanup이 오류 값을 덮기 전에 `last_os_error`를 캡처하도록 고쳤다.
3. **초기 I/O 증거 불안정:** tempdir/fixture write 오류에도 operation과 raw OS code가 있는 `INCONCLUSIVE_MAPPING_GATE` marker를 추가했다.
4. **길이 TOCTOU와 pointer geometry:** metadata로 길이를 읽고 zero-length whole-file view를 요청하던 방식을 제거했다. 한 private geometry가 정확한 25 bytes를 `CreateFileMappingW`와 `MapViewOfFile` 양쪽에 전달하고 offset 24가 범위 안임을 보장한다.

최종 재검토는 Spec Compliance `Approved`, Task Quality `Approved`, Critical `0`, Important `0`이었다.

### 남은 Minor와 하드 경계

`open_synthetic_v1(&Path)`는 기존 내용이 정확히 `A` fixture인지 자체 검증하지 않는다. 현재는 parent가 만든 임시 합성 파일, `publish = false`, feasibility feature, 비-store child라는 좁은 경계라서 non-blocking이다. store 연결 전에는 content validation 또는 더 강한 capability boundary가 반드시 필요하다.

외부 on-disk `-shm`, 실제 SQLite callbacks, WAL recovery/checkpoint, absent-WAL race, RO→RW epoch 연속성은 이 primitive 밖이다. 이 결과를 full VFS 방어로 확대 해석하면 안 된다.

### 실행 관찰과 권위 판정

- final-candidate hard gate: exit `0`, 1 passed, 2 filtered → **단일 primitive Go 관찰**
- format: exit `0`
- Clippy: exit `0`
- diff check: exit `0`
- mandatory ordinary suite: library test executable 시작 전 Application Control `4551`, exit `101`
- ordinary suite는 integration test에 도달하지 못했으므로 final-candidate runtime ignored count는 주장하지 않음
- **권위 Phase 0A 체크포인트: Inconclusive**
- **store integration: 중단**
- **actual Secret gate: 계속 닫힘**

상세 명령과 결과: `프로젝트_참고문서\14_WINDOWS_VFS_PHASE0A_검증결과.md`

## 현재 RED 판정

| 항목 | 판정 |
| --- | --- |
| actual SQLite file-set binding | 미해결, P0 release blocker |
| pre-existing writable mapping primitive | 단일 Go 관찰, Phase 0A 전체는 4551 때문에 Inconclusive |
| full VFS/private SHM/store integration | 중단, 미구현 |
| wrong-password no-write | 기존 방어 자산 있음, VFS 후 재검증 필요 |
| future/corrupt preservation | 기존 방어 자산 있음, VFS 후 재검증 필요 |
| crash atomicity | 기존 테스트 자산 있음, VFS 후 재검증 필요 |
| rollback/omission | 미해결, 다음 P0 |
| actual Secret support | 금지 유지 |
| Critical/High 외부 취약점 주장 | 현재 근거로 새로 주장하지 않음 |

## 작업 로그

### 2026-08-29 — 패키지 생성

- **관찰됨:** 저장소 working tree clean, branch는 local remote-tracking ref보다 ahead 10.
- **관찰됨:** HEAD `4138dd7`, 실제 Secret gate 닫힘.
- **사용자 선택:** same-user active raw file attacker를 v1 위협 범위에 포함.
- **공식 확인:** Aardvark는 Codex Security research preview로 전환됨.
- **문서 작업:** 기존 RED/BLUE와 핵심 프로젝트 문서를 새 바탕화면 폴더에 복사.
- **코드 작업:** 없음. 설계 승인 전 구현 금지.
- **Git 변경:** 없음. commit/push 없음.
- **다음 RED gate:** custom VFS + private snapshot 설계 사용자 승인.

### 독립 리뷰 반영란

#### Daybreak RED 검토

- **확인:** Windows retained pre-open handle은 `FILE_SHARE_WRITE`를 허용한다.
- **확인:** 현재 `revalidate()`는 same-length content rewrite를 검출하지 않는다.
- **확인:** bare `BEGIN`은 deferred이므로 첫 read 전까지 SQLite snapshot 고정 증거가 아니다.
- **강화:** 기본 VFS 뒤 metadata만 재검사하는 shim은 기각한다.
- **강화:** actual main/WAL/SHM handle family 직접 소유, 외부 write/delete/mapping 배제, absent sidecar race fail-closed를 요구한다.
- **분리:** private snapshot은 VFS 뒤의 격리 보조책이다.
- **분리:** coherent old snapshot과 omission은 monotonic completeness anchor 없이는 막지 못한다.

#### Fresh-context architecture review

- 현재 executable 범위는 Rust crypto/local-core/SQLite adapter이며 Web/Android/API는 placeholder다.
- LocalAppData capability, app lock, preflight/auth/promotion, crypto envelopes가 주요 현재 경계다.
- 사용자 선택에 따라 same-user file-state attacker는 범위 안, arbitrary process-memory compromise는 보호 주장 밖으로 분리했다.
- 리뷰는 구조 지도이며 새 취약점 발견·수정·테스트 통과 증거가 아니다.

독립 리뷰 결과는 구현 완료 증거가 아니라 설계 입력이다.

### 2026-08-29 — 정식 Windows actual-handle VFS 설계 명세 확정

- **설계 파일:** `docs/superpowers/specs/2026-08-29-windows-actual-handle-sqlite-vfs-design.md`
- **문서 커밋:** `ce365736ddaf79b7ccdf6095eaf3ae99eca1d5d3`
- **핵심 선택:** 별도 Windows VFS crate가 SQLite 실제 main/WAL 핸들 계열과 private SHM을 소유한다.
- **RED hard gate:** 기존 외부 writable handle/mapping, 이후 새 writable open/mapping, path reopen, crash-WAL, absent-WAL 생성 race를 결정적으로 증명하지 못하면 store 통합을 중단한다.
- **fallback:** stock VFS 또는 경로 재오픈 방식으로 약화하지 않는다.
- **미해결 분리:** 과거 정상 전체 rollback과 완전한 행 누락은 다음 P0인 monotonic completeness anchor에서 다룬다.
- **코드 작업:** 없음. 이 커밋은 설계 문서만 포함한다.
- **테스트 실행:** 없음. 구현 전 설계 단계이므로 테스트 통과를 주장하지 않는다.
- **push:** 하지 않음. 로컬 브랜치는 원격 추적 ref보다 ahead 11이다.
- **다음 gate:** 사용자 명세 확인 후 세부 구현 계획을 작성하고, 그 계획을 승인받은 다음 feasibility spike부터 코드를 시작한다.

### 2026-08-29 — Phase 0A 상세 구현 계획과 RED 재검토

- **저장소 계획 파일:** `docs/superpowers/plans/2026-08-29-windows-actual-handle-vfs-feasibility.md`
- **바탕화면 사본:** `프로젝트_참고문서\13_WINDOWS_VFS_PHASE0A_구현계획.md`
- **문서 커밋:** `bf29357284e72d48aff437df5eb5ed6be43a5407`
- **범위:** 전체 native VFS가 아니라, creator file handle 종료 뒤에도 유지되는 기존 writable mapped view를 Windows share 정책이 거부할 수 있는지 먼저 판정하는 독립 primitive다.
- **false-Go 방지:** hostile mapping 전과 해제 후 동일 합성 파일의 control open/read가 모두 성공해야 한다. 중간 hostile acquisition만 `ERROR_SHARING_VIOLATION (32)`일 때에만 primitive Go다.
- **결정적 동기화:** `READY → parent acquire → optional MUTATE → EXIT` pipe frame을 사용한다. correctness를 위한 sleep, 확률적 retry, polling을 쓰지 않는다.
- **오류 보존:** OS code, child spawn/read/wait/exit, timeout, Application Control `4551`을 비밀 없는 marker로 남기며 예상 외 결과는 Inconclusive다.
- **pinned 조건:** Windows `10.0.26200.0`, Rust `1.95.0`, `x86_64-pc-windows-msvc`, bundled SQLite `3.53.2`가 정확히 맞지 않으면 Go로 판정하지 않는다.
- **hygiene gate:** format, Clippy, ordinary test, diff check의 실제 integer exit code를 기록한다. ordinary test에서 hard gate는 `ignored`여야 하며 이를 통과로 오인하지 않는다.
- **Cargo.lock:** 새 workspace crate 추가 직후 오프라인으로 한 번만 갱신하고 새 로컬 package stanza 외 registry 변경이 없는지 검토한다. 이후 명령은 다시 `--locked`다.
- **hard stop:** No-Go 또는 Inconclusive면 `vault-local-store-sqlite`에 연결하지 않고 broker/service boundary 재설계로 돌아간다.
- **Go의 한계:** primitive Go여도 정식 설계의 전체 Phase 0은 미완료다. callback ABI, main/WAL family, private SHM, WAL recovery, absent-WAL race, path trace와 store integration은 별도 계획 대상이다.
- **코드·테스트 실행:** 없음. 이번 커밋은 설계 보정과 실행 계획 문서만 포함한다.
- **push:** 하지 않음. 로컬 브랜치는 원격 추적 ref보다 ahead 12다.
- **actual Secret:** 실제 비밀번호·API 키·Secret·복구 키 입력 금지 유지.

### 2026-08-30 — Phase 0A 전체 브랜치 최종 RED 판정

- **검토 범위:** `bf29357..88fd18f`
- **소스·설계 정합성:** Approved, Critical `0`, Important `0`.
- **남은 Minor:** `open_synthetic_v1(&Path)`가 전달 경로의 기존 내용과 provenance를 직접 강제하지 않는다. 격리 probe 밖으로 재사용하기 전 same-handle exact fixture 검증 또는 더 강한 capability가 필요하다.
- **실행 증거:** one-time hard gate는 exit `0`/1 passed였지만 mandatory ordinary suite는 library test 시작 전 Application Control `4551`/exit `101`이었다.
- **권위 판정:** 단일 primitive Go 관찰, 전체 Phase 0A Inconclusive.
- **merge/push:** 테스트 완료 조건이 충족되지 않아 merge 준비 상태는 No이며 push·main 병합하지 않았다.
- **RED 중단선:** Application Control 환경 해결 뒤 변경 없는 후보의 ordinary suite가 exit `0`이 되기 전 full VFS/store/실제 Secret 작업으로 넘어가지 않는다.

### 2026-08-29 — Phase 0A 구현, 두 차례 RED 보강, 최종 Inconclusive 기록

- **격리 scaffold:** `3f08237`에서 새 `vault-local-sqlite-vfs-windows` crate, pinned platform contract와 비밀 없는 오류 타입을 만들었다.
- **결정적 probe:** `fe86fe2`에서 actual-handle guard, creator handle 종료 뒤 남는 writable mapping/view, fixed child protocol, pre/post control hard gate를 만들었다.
- **첫 RED 보강:** `6f2cec4`에서 허용 합성 값 `A`→`B`, MapView 오류 코드 선캡처, 초기 I/O marker를 적용했다.
- **두 번째 RED 보강:** `e8b29cb`에서 metadata-derived length와 zero-length mapping을 제거하고 exact 25-byte/offset 24 geometry를 양쪽 Win32 mapping stage에 결속했다.
- **독립 최종 재검토:** Spec/Quality Approved, Critical 0, Important 0. store 전 content validation/capability 강화가 필요한 Minor 1건은 명시적으로 남겼다.
- **단일 primitive 관찰:** final-candidate explicit hard gate exit 0, 1 passed, 2 filtered, exact sharing violation 32.
- **전체 판정:** mandatory ordinary suite가 library test 시작 전 Application Control `4551`로 exit 101이어서 Phase 0A는 Inconclusive다. 통합을 중단했다.
- **문서화:** `88fd18f`에서 권위 검증 기록을 만들었다.
- **금지 유지:** full VFS, private SHM, store integration, 실제 Secret 입력, push, main merge를 하지 않았다.

### 2026-08-31 — Application Control 4551 근본 원인 확인

- **직접 원인:** Code Integrity 이벤트 `3033/3077`이 Rust 테스트 EXE를 차단했다. 정책 이름은 Smart App Control `VerifiedAndReputableDesktop`, GUID는 `{0283ac0f-fff1-49ae-ada1-8a933130cad6}`다.
- **동일 파일 증명:** 이벤트의 SHA-256 Flat Hash와 보존된 `vault_local_sqlite_vfs_windows-386a00a316a81043.exe`의 실제 SHA-256이 정확히 일치한다.
- **서명 상태:** 해당 EXE는 `NotSigned`, requested signing level `2`, validated level `1`, status `0xc0e90002`였다.
- **범위 판단:** 같은 정책이 다른 Rust 테스트 EXE도 막았으므로 crate 고유 로직 오류가 아니라 호스트의 새 unsigned 실행 파일 신뢰 경계다. 다만 실행을 허용하면 테스트가 통과한다는 뜻은 아니므로 전체 판정은 계속 Inconclusive다.
- **하지 않은 것:** Smart App Control off, registry/policy 수정, 개별 우회, self-signed 신뢰 추가, ordinary suite 재실행, one-time hard gate 재실행을 하지 않았다.
- **RED 권고:** 현재 물리 호스트의 보안을 약화시키지 않는다. trusted RSA signing pipeline, 전용 검증 VM 계약, broker/service-boundary 재설계 중 하나를 별도 승인·설계한 뒤 진행한다.
- **현재 GitHub 상태:** 기능 브랜치는 원격 `88fd18f`와 일치하고 `main` 대상 Draft PR `#1`이 열려 있다. 병합은 계속 차단한다.
- **권위 문서:** `docs/verification/windows-smart-app-control-4551-root-cause.md`

### 2026-09-07 — 검증 누락과 잘못된 안전 판정 방지

- **범위:** 이동한 작업 폴더의 일반 검사 경로와 문서 정리. 외부 시스템 대상 테스트나 공격 코드 없이 정적 검토와 기존 합성 회귀 검사를 수행했다.
- **실제 실행:** 전체 기본 workspace 테스트 168 passed/1 ignored, 전체 Clippy·포맷·문서 예제 검사 exit 0. feature 일반 검사는 6 passed/1 ignored이며 ignored 보안 gate는 실행하지 않았다.
- **기존 변경 보존:** 옵션 전용 테스트 파일 2개의 feature gate 수정은 작업 전부터 있던 변경이다. 기본/옵션 구성 양쪽에서 다시 검사했으며 오늘 새로 만든 수정으로 계산하지 않는다.
- **실패를 성공으로 덮는 문제 방지:** 검증 스크립트가 첫 실패에서 멈추고 원래 종료 코드를 돌려준다. 최종 단계 실패에도 성공 문구가 나오지 않는지 확인했다.
- **검사 누락 발견:** 새 Workspace 검증 경로에서 문서 예제 테스트 누락을 RED 테스트로 확인(exit 1)하고 명시적 doctest 단계를 추가했다.
- **가짜 검증 방지:** 스크립트 자체 회귀 검사는 실제 하위 프로세스의 호출 marker를 확인한다. 가짜 Cargo 11개 검사 통과를 실제 암호화 안전성 검증과 혼동하지 않는다. PS5.1/PS7 각각 exit 0이다.
- **경로 이동:** 실행자의 현재 폴더가 아니라 스크립트가 있는 저장소를 기준으로 검사하며, 다른 폴더에서 호출하는 테스트를 포함했다.
- **오탐 정리:** MCP binding 이름 단독 중복 후보는 현 명세상 이름+참조 쌍 중복 금지와 다르다. 구현·기존 테스트가 명세와 일치하므로 확정 버그로 기록하지 않는다.
- **정책 확인 항목:** 추가 명세 대조 결과 이전 revision 폐기 확인 규칙은 구현·테스트가 존재한다. 현재 항목의 폐기 상태 조합 규칙은 읽은 명세에 명시되지 않아 요구사항 확인 후 판단한다. 확정 결함이나 수정 완료가 아니다.
- **남은 중단선:** 과거 4551의 해소 경위는 조사하지 않았고 보안 정책도 바꾸지 않았다. 일반 테스트 성공만으로 Phase 0A Go, full VFS/store 통합, 실제 Secret 지원을 승인하지 않는다.
- **실행/마무리 근거:** [13번 작업 결과](13_2026-09-07_작업결과.md) 및 링크된 저장소 검증 기록. 종료 예약 여부는 최종 기록을 따른다.
