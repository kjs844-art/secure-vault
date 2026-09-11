# KeyAtlas (working title) — Red Team Security Notes

> 상태: 살아 있는 공격 관점 기록 v0.1  
> 최초 작성: 2026-08-29 10:49 KST  
> 대상 저장소: `C:\Users\USER\Desktop\secure-vault-sqlite-store-design`  
> 기준 브랜치/커밋: `codex/firstvibe-sqlite-store` / `4138dd7217528458a881275a7349fd3430defef8`  
> 중요: 이 문서는 공격 실행 안내서가 아니라 방어 설계를 위한 위협 기록이다. 실제 비밀번호, API 키, Secret, 복구 키를 이 저장소나 현재 앱에 입력하면 안 된다.

## 1. 이 문서의 역할

KeyAtlas는 장차 사용자의 사이트 계정, 비밀번호, API 키, MCP 연결 정보와 복구 수단을 보관하는 보안 금고를 목표로 한다. 따라서 단순 메모 앱보다 훨씬 강한 실패 기준을 적용한다.

이 문서는 공격자 입장에서 다음을 계속 질문한다.

- 공격자가 어떤 권한을 먼저 가져야 하는가?
- 어떤 신뢰 경계를 넘을 수 있는가?
- 실제 Secret의 기밀성·무결성·가용성에 어떤 영향이 생기는가?
- 현재 방어가 공격을 제거하는가, 좁히는가, 탐지만 하는가?
- 가장 강한 반증은 무엇이며, 그래도 남는 위험은 무엇인가?

판정 라벨:

- **관찰됨**: 현재 소스나 문서에서 직접 확인했다.
- **추론됨**: 관찰된 구조로부터 합리적으로 예상되지만 아직 재현·측정하지 않았다.
- **제안됨**: 앞으로 채택 여부를 결정해야 하는 설계다.
- **미검증**: 테스트나 독립 리뷰가 아직 부족하다.

## 2. 보호할 핵심 자산

1. 사용자가 입력한 비밀번호, API 키, Secret, 토큰 원문
2. 어떤 계정과 키가 어떤 서비스·프로젝트·MCP에 연결됐는지 보여 주는 메타데이터
3. 금고 마스터 비밀번호에서 파생되는 키와 기기별 키
4. 복구 키, 신뢰 기기, 복구 승인 기록
5. 삭제·수정 이력과 마지막 정상 상태를 증명하는 무결성 정보
6. 결제 플랜, 저장 한도, 사용자 권한
7. 업데이트·배포·서명 체계

메타데이터도 민감하다. 예를 들어 사용자가 어떤 AI 서비스, 거래소, 클라우드, MCP를 쓰는지 자체가 공격 표적을 좁히는 정보가 될 수 있다.

## 3. 주요 공격자와 경계

| 공격자 | 선행 조건 | 현재 우선도 | 주의점 |
| --- | --- | --- | --- |
| 금고 파일만 훔친 공격자 | 디스크/백업 파일 접근 | 매우 높음 | 오프라인 암호 추측과 메타데이터 노출을 고려해야 한다. |
| 같은 Windows 사용자 권한의 파일 조작 프로세스 | 로컬 실행 또는 동기화/백업 도구 권한 | 매우 높음 | 현재 SQLite TOCTOU 판단의 핵심이다. |
| 사용자가 잠금 해제한 세션을 노리는 로컬 악성코드 | 프로세스·클립보드·화면 접근 | 매우 높음 | 파일 방어만으로 전체 보호를 주장할 수 없다. |
| 웹 공격자 | 향후 공개 API/웹 UI 접근 | 향후 매우 높음 | XSS, 세션 탈취, 인증·권한 우회가 핵심이다. |
| 악성 또는 과권한 MCP/플러그인 | 사용자가 연결 허용 | 향후 매우 높음 | 금고 전체가 아니라 명시적으로 선택한 Secret만 제한적으로 제공해야 한다. |
| 운영자·클라우드 침해자 | 서버/백업/IAM 접근 | 향후 매우 높음 | 서버가 평문과 복호화 키를 얻지 못하는 구조가 필요하다. |
| 공급망 공격자 | 빌드·업데이트·의존성 경로 침해 | 향후 매우 높음 | 보안 앱은 업데이트 채널이 곧 최고 권한 경계가 된다. |

## 4. 확인된 핵심 공격 경로

### RED-SQLITE-001 — 사전 검사 파일과 SQLite 실제 열린 파일이 결속되지 않음

**상태:** 관찰됨, 실제 Secret 입력 출시 차단 조건  
**일반 취약점 등급:** 아직 확정하지 않음. 현재 근거만으로 인터넷 원격 Critical/High라고 부르면 과장이다.  
**제품 게이트:** P0. 비밀번호 관리자급 제품이 실제 Secret을 받기 전에 반드시 결정·해결해야 한다.

#### 관찰된 구조

- `crates/vault-local-store-sqlite/src/preflight_query.rs`는 main/WAL/SHM을 별도 파일 핸들로 열어 크기와 일부 신원을 검사한다.
- 그 뒤 `rusqlite`가 같은 경로 문자열을 다시 열며, SQLite가 실제 연 main/WAL/SHM과 사전 검사 핸들을 하나의 capability로 결속하지 않는다.
- Windows 사전 핸들은 delete 공유를 막지만 write 공유는 허용한다. 같은 파일의 제자리 수정·성장 가능성은 남는다.
- 첫 SQLite SQL이 실행된 뒤에야 retained 파일 재검사가 수행되는 구간이 있다.
- 처음 없던 WAL/SHM은 SQLite가 사용한 뒤 나중 검사에서 처음 발견될 수 있다.

#### 공격 경로

1. 공격자는 같은 사용자 컨텍스트에서 금고의 DB 또는 sidecar 파일을 쓸 수 있다.
2. 앱은 경로 A의 main/WAL/SHM 상태를 사전 검사한다.
3. 사전 검사와 SQLite open·첫 query 사이에 공격자가 파일을 교체하거나 같은 길이로 내용을 바꾸거나 WAL을 증가시킨다.
4. SQLite는 사전 검사한 객체와 다를 수 있는 파일 집합을 읽는다.
5. 이후 경로 기반 재검사가 우연히 통과하거나, 이미 공격자 입력을 파싱한 뒤 오류가 발생할 수 있다.
6. 결과적으로 잘못된 snapshot이 정상 금고로 해석되거나, 자원 상한 이전에 과도한 작업이 발생하거나, 잘못된 상태가 승격 후보가 될 수 있다.

#### Attack Path Facts

- **범위:** 로컬 SQLite 금고는 제품 핵심 보안 경계이므로 범위 안이다.
- **벡터:** `local`; 네트워크 원격 경로는 현재 소스에서 확인되지 않았다.
- **선행 조건:** 같은 사용자 권한으로 파일을 조작할 수 있는 프로세스, 악성 동기화 도구 또는 유사 권한이 필요하다.
- **입력 통제:** main/WAL/SHM 바이트와 타이밍에 대한 공격자 통제는 가능하다고 추론되지만, 결정적 재현 테스트는 아직 필요하다.
- **경계 횡단:** 사용자가 승인하지 않은 파일 상태가 검증된 금고 상태로 해석되는 무결성 경계 횡단 가능성이다.
- **영향:** 실제 Secret 단계에서는 금고 무결성·가용성, 경우에 따라 이후 Secret 사용 결정에 영향을 줄 수 있다.
- **현재 완화:** Trusted LocalAppData, fixed local volume, no-follow open, 앱 전용 lock, 파일 크기 상한, 재검사, 읽기 전용 preflight, 잘못된 비밀번호에서 writable open 금지.
- **가장 강한 반증:** 같은 사용자 권한의 완전한 악성코드는 잠금 해제된 프로세스 메모리·클립보드 등 다른 경로도 노릴 수 있다. 따라서 이 경계를 닫아도 로컬 임의 코드 실행 전체를 막았다고 할 수 없다.
- **반증이 문제를 없애지 않는 이유:** 파일 쓰기 권한만 가진 동기화·백업·보조 프로세스와 완전한 프로세스 침해는 동일하지 않다. 또한 보안 제품은 공격 표면을 계층별로 줄여야 한다.
- **신뢰도:** 코드 구조에 대한 신뢰도 높음, 실제 악용 가능성과 비용 상한에 대한 신뢰도 중간.

#### 현재 결론

경로·길이 재검사를 더 추가하는 것만으로는 완료 처리할 수 없다. 첫 application SQL과 첫 writable hardening SQL 전에 SQLite가 실제 사용하는 파일 집합을 결속하고, 결속 capability를 store 수명까지 유지해야 한다.

### RED-SQLITE-002 — RO 검사에서 RW 승격으로 넘어갈 때 결속 상태가 끊김

**상태:** 관찰됨, RED-SQLITE-001과 연결된 별도 상태 전이 위험

- read-only gate와 사전 파일 핸들을 drop한 뒤 같은 경로로 writable connection을 다시 연다.
- logical digest는 내용 비교에 도움이 되지만 실제 파일 identity와 freshness의 증명은 아니다.
- writable open 직후 일부 hardening SQL이 actual-handle binding보다 먼저 실행될 수 있다.
- 성공한 writable store에는 SQLite connection과 앱 lock은 남지만, 현재 사전 파일 snapshot guard는 남지 않는다.

공격자 목표는 RO에서 승인받은 A와 RW에서 실제 수정되는 B를 다르게 만드는 것이다. 해결책은 RO file-set epoch를 RW 승격이 소비하고, RW actual file set과 transaction 안에서 다시 비교하며, 성공 guard를 store lifetime에 유지하는 것이다.

### RED-SQLITE-003 — WAL/SHM은 main 핸들 확인만으로 보호되지 않음

**상태:** 관찰됨/공식 SQLite 동작에 근거한 설계 제한

- `SQLITE_FCNTL_WIN32_GET_HANDLE`로 SQLite가 실제 연 main DB HANDLE을 확인할 수 있다.
- 그러나 같은 public API로 WAL HANDLE과 SHM mapping을 모두 고정할 수 없다.
- `immutable=1`은 파일을 실제로 동결하지 않는다. 변경되지 않는다고 가정하고 locking/change detection을 끄므로 live WAL DB에 쓰면 안 된다.
- 정상 SQLite writer와의 논리 snapshot은 read transaction/Backup API가 제공할 수 있지만, 악의적인 raw sidecar 교체·증가까지 자동으로 막지는 않는다.

따라서 “main HANDLE 확인 완료”를 “main/WAL/SHM TOCTOU 완료”로 보고하면 안 된다.

### RED-SQLITE-004 — 과거 정상 DB 전체 rollback과 행 전체 누락 탐지 미완료

**상태:** 관찰됨, 기존 위협 모델에 남은 명시적 한계

공격자가 과거에 유효했던 main+WAL 상태 전체를 되돌리면 개별 레코드 인증만으로 최신성 상실을 알아내지 못할 수 있다. 또한 공격자가 인증된 행을 통째로 제거한 경우 “남아 있는 행은 모두 유효함”만 확인해서는 누락을 탐지할 수 없다.

필요한 후보 통제:

- 사용자/기기별 monotonic epoch 또는 append-only checkpoint
- 독립적으로 보호된 최신 revision commitment
- 복구 시 rollback을 허용하는 명시적 사용자 승인 흐름
- 충돌·삭제 tombstone까지 포함한 전체 집합 commitment

이 문제를 해결하기 전까지 실제 Secret 입력 gate는 계속 닫혀 있어야 한다.

## 5. 아직 검증되지 않은 주요 공격 후보

아래 항목은 제품 방향상 반드시 다뤄야 하지만, 현재 저장소에서 모두 실제 취약점으로 입증된 것은 아니다.

### RED-CLIENT-001 — 잠금 해제 메모리와 클립보드 노출

- Secret을 보여 주거나 복사하는 순간 평문이 메모리에 존재한다.
- 무기한 클립보드 유지, crash dump, swap/pagefile, 화면 캡처, 접근성 API가 노출 경로가 될 수 있다.
- Zeroization은 유용하지만 컴파일러·복사본·UI 프레임워크까지 포함한 완전 제거를 자동 보장하지 않는다.
- 제안: 짧은 reveal, 자동 재잠금, 클립보드 TTL, 민감 화면 보호, crash dump 정책, 메모리 생명주기 테스트.

### RED-AUTH-001 — 복구 수단이 새 마스터 키가 되는 문제

- 복구 키, 신뢰 기기, Google 로그인, 이메일 지원 복구가 너무 강하면 금고 암호화를 우회하는 보조 마스터 키가 된다.
- 너무 약하면 사용자가 모든 복구 수단을 잃었을 때 데이터가 영구 손실된다.
- 제안: 복구 수단 3~5개 선택 모델을 암호학적 threshold와 동일시하지 말고, 각 수단의 권한·취소·지연·알림을 별도로 설계한다.
- 운영자가 평문을 복구할 수 없는 원칙과 계정 로그인 복구를 구분한다.

### RED-WEB-001 — 웹 UI의 XSS와 세션 탈취

- 향후 웹에서 복호화된 Secret을 다루면 XSS는 곧 금고 열람 권한으로 이어질 수 있다.
- 서드파티 스크립트, 광고, 분석 SDK를 금고 화면과 같은 origin에 두면 위험이 커진다.
- 블로그·애드센스 수익화 표면과 보안 금고 표면은 origin, 쿠키, 배포 파이프라인을 분리하는 방향이 안전하다.

### RED-MCP-001 — 플러그인/MCP에 금고 전체 권한 제공

- MCP가 Secret 검색·열람·복사를 광범위하게 호출할 수 있으면 악성 프롬프트나 과권한 서버가 금고를 유출할 수 있다.
- “AI가 알아서 필요한 키를 찾음”은 편리하지만 최소 권한과 사용자 의도 확인을 약화시킨다.
- 제안: Secret 원문을 MCP 리소스로 열거하지 않고, 서비스·용도·만료 시간을 지정한 일회성 capability와 매번 사용자 승인 경계를 검토한다.

### RED-CLOUD-001 — 서버·백업·동기화가 복호화 능력을 갖게 됨

- 서버가 암호문만 저장한다고 해도 키 derivation, 복구 메타데이터, 검색 index가 평문 추론을 가능하게 할 수 있다.
- 백업이 main만 복사하고 WAL을 빠뜨리면 일관성이 깨진다.
- 삭제 요청 후 오래 남는 백업과 고객지원 export도 별도 데이터 수명 정책이 필요하다.

### RED-SUPPLY-001 — 업데이트·의존성 공급망

- 서명된 악성 업데이트는 잠금 해제 순간 모든 Secret을 가져갈 수 있다.
- 자동 업데이트 서명키, CI 토큰, 릴리스 권한은 금고 데이터만큼 강하게 보호해야 한다.
- 의존성 버전 고정, SBOM, 재현 가능한 빌드, 리뷰된 릴리스, 서명·rollback 보호가 후보 통제다.

### RED-BILLING-001 — Free/Pro 한도와 권한 조작

- 클라이언트만 저장 개수 제한을 적용하면 쉽게 우회될 수 있다.
- 서버 권한만 믿으면 오프라인 금고와 충돌할 수 있다.
- 결제 상태는 Secret 암호화 키의 소유권과 분리해야 한다. 구독 만료가 사용자 데이터를 인질처럼 만들면 안 된다.

## 6. SQLite TOCTOU 설계 선택지

### Option 1 — 증명 불가능한 기존 DB open을 fail-closed

장점은 빠르고 보수적이라는 것이다. 위험한 상태에서는 원본을 바꾸지 않고 열기를 거부한다. 단점은 정상적인 crash-WAL도 일시 거부할 수 있으며 실제 Secret용 최종 해결책은 아니라는 점이다.

### Option 2 — 검증된 private snapshot에서 RO preflight/auth

main+WAL을 OS 수준에서 동결·복사하고 private snapshot에서 모든 구조 검사와 인증을 수행한다. wrong password 때 원본에 SHM bookkeeping도 남기지 않는 방향이 가능하다. 그러나 원본을 다시 writable로 승격할 때의 결속 문제는 별도 해결이 필요하다.

### Option 3 — Windows 전용 최소 VFS shim과 actual-handle capability

SQLite의 `xOpen`, `xRead`, `xFileSize`, `xWrite`, `xTruncate`, `xShmMap`, `xShmLock` 경계를 작은 native adapter가 통제한다. main/WAL/SHM의 역할·identity·크기·공유 정책을 SQLite 실제 I/O와 결속할 수 있다.

보안상 가장 강하지만 구현과 감사 난이도가 높다. 기존 Windows VFS 의미, WAL locking, sync, crash recovery를 훼손하지 않았다는 독립 native 리뷰가 필수다. `unsafe`는 작은 platform crate에만 격리하고 store crate의 `forbid(unsafe_code)`는 유지해야 한다.

### 현재 조건부 권고

- 실제 Secret 제품 목표라면 Option 3을 최종 경계로 삼는다.
- Option 2를 RO preflight/auth 단순화 계층으로 조합하는 것을 검토한다.
- Option 1은 VFS가 완성되기 전 안전 차단책으로만 사용한다.
- 사용자가 같은 사용자 권한의 active file attacker를 위협 모델에서 제외한다면 더 단순한 Backup-to-memory 설계도 가능하지만, 그 제외는 제품 보안 약속에 명시해야 한다.

## 7. 필수 결정적 테스트

1. 사전 검사 직후 main 교체와 SQLite open 직후 교체
2. main의 동일 길이 내용 변경과 파일 성장
3. WAL append, truncate, reset, replace를 각 barrier 지점에서 수행
4. SHM create, delete, replace, corrupt
5. 거대·sparse main/WAL에서 읽은 byte, page, 메모리, 시간 상한 검증
6. committed crash-WAL과 uncommitted tail의 정확한 가시성
7. wrong password에서 원본 main/WAL/SHM 해시·길이·mtime 불변
8. future version과 corrupt input 원본 보존
9. snapshot/backup 취소·I/O 오류·panic·프로세스 종료에서 부분 결과 승격 금지
10. junction, symlink, reparse, mapped/network volume fail-closed
11. RO 승인 A와 RW 승격 B를 다르게 만드는 경쟁 테스트
12. raw `Connection`, raw DB handle, Secret 원문 타입을 외부에서 꺼낼 수 없는 compile-fail 테스트

## 8. Daybreak 정기 보안 리뷰 제안

권장 시점:

- 보안 설계 옵션을 고른 직후
- VFS/native/crypto 코드가 처음 컴파일된 직후
- Task 단위 테스트가 통과한 직후
- 실제 Secret 입력 gate를 열기 직전
- 배포·업데이트·복구·결제 구조가 바뀔 때
- 정기적으로 월 1회 또는 중요한 보안 의존성 업데이트 때

Daybreak에 줄 최소 입력:

- 정확한 저장소 경로, 브랜치, 커밋 SHA
- 이번 변경 diff와 통과한 테스트 명령
- 위협 모델과 실제 Secret gate 상태
- 알려진 미해결 항목과 범위 밖 항목
- “파일 수정 금지”인지 “수정 허용”인지 명확한 권한

Daybreak가 반드시 답해야 할 질문:

- 공격자의 선행 권한을 과장하거나 축소하지 않았는가?
- main/WAL/SHM, RO→RW, crash recovery 경계가 모두 연결됐는가?
- 방어가 단지 탐지인지 실제 예방인지 구분했는가?
- 기존 테스트가 새 구현을 실제로 거치는가?
- 해결했다고 주장한 위험에 재현 가능한 음성 테스트가 있는가?
- Critical/Important 판단의 가장 강한 반증은 무엇인가?

## 9. 계속 기록할 로그

### 2026-08-29 — 최초 기록

- **관찰됨:** 현재 branch는 원격보다 10커밋 앞서며 작업 트리는 clean이었다.
- **관찰됨:** SQLite actual file-set binding이 없고 open→first query 및 RO→RW 경쟁 구간이 남는다.
- **관찰됨:** main HANDLE 확인만으로 WAL/SHM을 완료 처리할 수 없다.
- **제안됨:** Windows VFS + private snapshot 조합을 주 설계 후보로 유지한다.
- **미검증:** 같은 사용자 raw file attacker를 v1 위협 범위에 포함할지 사용자 결정이 필요하다.
- **유지:** 실제 비밀번호/API 키/Secret 입력 금지, 원격 push 금지.

### 2026-08-29 — 병렬 모델 교차 검토

- **Terra 큰 틀 감사:** 현재 결과물은 실사용 앱이 아니라 합성 데이터 전용 Rust 암호문 SQLite 코어이며, SQLite TOCTOU는 이후 복구·동기화·Android·Web 보안 기준을 안정시키는 첫 P0 게이트라고 판정했다.
- **Luna 문서 검토:** 관찰·추론·제안·미검증을 분리하고, wrong-password 무쓰기·future/corrupt 보존과 rollback/row omission 미해결을 서로 다른 계약으로 유지해야 한다고 확인했다.
- **GPT-5.5 독립 의사결정:** release gate는 Option 1, 읽기 전용 검증·복구 보조는 Option 2, 실제 제품 해법은 Option 3이라는 조건부 권고를 냈다.
- **세 검토의 합의:** private snapshot 단독으로는 RO→RW 원본 승격 경쟁을 닫지 못한다. actual main/WAL/SHM I/O 경계를 다루지 않고 실제 Secret 입력을 열면 안 된다.
- **주의:** 위 결과는 모두 소스·문서 읽기 전용 검토다. 새 구현이나 테스트 통과 증거가 아니다.
