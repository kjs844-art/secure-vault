# KeyAtlas (working title) — Blue Team Security Notes

> 상태: 살아 있는 방어 관점 기록 v0.1  
> 최초 작성: 2026-08-29 10:49 KST  
> 대상 저장소: `C:\Users\USER\Desktop\secure-vault-sqlite-store-design`  
> 기준 브랜치/커밋: `codex/firstvibe-sqlite-store` / `4138dd7217528458a881275a7349fd3430defef8`  
> 이 문서는 방어 설계 메모다. 구현·테스트·독립 리뷰가 끝나기 전에는 “보안 완료” 증거가 아니다.

## 1. 현재 안전 경계

- 실제 비밀번호, API 키, Secret, 복구 키 입력 금지
- 합성 데이터만 사용
- 검토되지 않은 로컬 10커밋 원격 push 금지
- public 배포, 결제, Google 로그인, 복구 활성화 금지
- Windows LocalAppData의 신뢰 위치 capability와 앱 전용 lock 사용
- existing DB를 먼저 read-only preflight하고 인증 성공 전 writable open 금지
- future version·손상 데이터는 원본 보존 후 fail-closed

현재 소스에 여러 방어가 존재하지만, main/WAL/SHM actual-handle 결속과 전체 rollback 탐지가 남아 있어 실제 Secret gate는 닫혀 있다.

## 2. 반드시 유지할 방어 불변조건

1. 인증 전에는 원본 DB/WAL/SHM에 쓰지 않는다.
2. SQLite가 읽는 실제 파일은 사전 검사로 승인한 파일 집합과 동일해야 한다.
3. 파일 집합의 identity·크기·세대는 첫 SQL 전부터 store 종료까지 보호한다.
4. crash 후 마지막 committed 상태만 보이고 uncommitted tail은 보이지 않아야 한다.
5. future version, 손상, 변조, 상한 초과는 원본을 보존하고 실패한다.
6. raw DB connection, raw handle, Secret 원문 타입은 외부 API로 유출하지 않는다.
7. 로그·오류·telemetry에는 Secret이나 복호화된 필드를 넣지 않는다.
8. 서버·운영자·결제 시스템은 사용자의 복호화 키를 얻지 못한다.
9. 복구 경로는 평문 복구가 아니라 암호화된 키 접근 권한 복구로 설계한다.
10. 보안 주장은 통과한 결정적 테스트와 독립 리뷰 범위까지만 한다.

## 3. 현재 방어 구조와 남은 구멍

| 계층 | 현재 방어 | 남은 일 |
| --- | --- | --- |
| 위치 | Trusted LocalAppData, fixed local drive, no-follow | DACL/owner 정책과 actual opened handle 결속 확정 |
| 동시 실행 | 앱 전용 `.lock` | 비협조적인 raw file writer는 막지 못함 |
| 사전 검사 | 크기 상한, schema/version/integrity, 합성 인증 | 첫 SQL 전에 main/WAL/SHM 전체를 결속 |
| 인증 | 잘못된 비밀번호에서 writable open 금지 | 결정적 원본 hash/metadata 불변 테스트 유지 |
| 저장 원자성 | 기존 crash-atomicity 테스트 자산 | VFS/snapshot 변경 후 전체 회귀 재검증 |
| 최신성 | immutable revision/CAS/conflict | 전체 rollback과 행 누락 commitment 필요 |
| 플랫폼 | Windows capability만 공개 | 미지원 플랫폼 fail-closed를 문서와 코드에서 일치 |

## 4. TOCTOU 방어 선택지

### Option 1 — 임시 fail-closed containment

안전을 증명할 수 없는 existing DB와 sidecar 상태는 열지 않는다. 구현은 빠르지만 정상 crash-WAL을 거부할 수 있어 최종 제품 해법은 아니다.

### Option 2 — private verified snapshot

원본 main+WAL을 동결·검증해 private snapshot을 만들고 그 복사본에서 구조 검사와 인증을 수행한다. 인증 전 원본 무쓰기를 강화한다. RW 승격 결속은 별도 해결이 필요하다.

### Option 3 — Windows minimal VFS/actual-handle boundary

SQLite의 main/WAL/SHM 실제 I/O 경계를 작은 Windows adapter가 소유한다. 가장 강하지만 native/unsafe/WAL semantics에 대한 높은 수준의 리뷰와 결정적 테스트가 필요하다.

현재 조건부 권고는 **Option 3을 최종 경계로, Option 2를 RO 검사 보조 계층으로, Option 1을 완료 전 임시 차단으로** 사용하는 것이다. 사용자가 active same-user file attacker를 범위에서 제외한다면 이 결정은 다시 검토한다.

## 5. 예방

- native/unsafe 코드는 작은 platform crate로 격리한다.
- store crate의 `forbid(unsafe_code)`를 유지한다.
- 상위 계층에는 검증 완료된 opaque capability만 반환한다.
- main-only 검증이나 path-only 재검사를 완료 조건으로 인정하지 않는다.
- private snapshot은 불완전 상태에서 검증 완료 타입으로 승격할 수 없게 한다.
- 실제 Secret 기능은 별도 feature gate와 보안 승인 체크리스트 뒤에 둔다.
- 웹 블로그·광고 origin과 보안 금고 origin/쿠키/배포를 분리한다.
- MCP에는 전체 금고 대신 사용자 승인된 단일 Secret의 제한된 capability만 검토한다.

## 6. 탐지와 관측

보안 telemetry는 내용이 아니라 사건만 기록한다.

- preflight 실패 유형: identity mismatch, size cap, future version, corruption
- 파일 교체·성장 감지 시각과 익명화된 오류 코드
- 반복 unlock 실패와 복구 시도 횟수
- VFS에서 거부된 write/truncate/SHM 정책 위반 횟수
- snapshot 생성·폐기·승격 상태
- 앱 버전, schema version, 보안 정책 버전

금지 항목:

- Secret 원문, 비밀번호, API 키 일부
- 복호화된 제목·메모·서비스 이름을 기본 telemetry에 기록
- 전체 로컬 경로와 사용자 이름
- clipboard 내용과 복구 키

## 7. 대응과 복구

- 변조·future·corrupt 감지 시 원본을 자동 수정하지 않고 읽기 전용 보존
- 검증 실패 snapshot은 폐기하되 원본은 유지
- 정상 backup은 main 단독 복사가 아닌 SQLite 일관 snapshot 방식 사용
- 복구 전 원본 hash와 사용자 승인 기록
- 신뢰 기기 분실 시 해당 기기 capability 취소
- 복구 수단 변경에는 지연, 기존 기기 알림, 재인증 적용
- 구독 만료와 데이터 복구·내보내기 권리를 분리
- 보안 사고 시 실제 Secret 재노출 가능성을 기준으로 키 회전 안내

## 8. 출시 전 검증 게이트

- [ ] main/WAL/SHM actual file-set binding 설계 승인
- [ ] open→first query와 RO→RW race 결정적 테스트 통과
- [ ] committed/uncommitted crash-WAL 회귀 통과
- [ ] wrong-password 원본 main/WAL/SHM 불변 확인
- [ ] future/corrupt/oversized 입력 보존 확인
- [ ] rollback·row omission 최신성 설계 승인 및 테스트
- [ ] DB/WAL/SHM과 로그에서 합성 평문 패턴 부재 검사
- [ ] raw connection/handle/Secret 타입 compile-fail 테스트
- [ ] workspace test, format, Clippy, secret-pattern scan 통과
- [ ] Windows native 경계 독립 보안 리뷰
- [ ] Daybreak 공격 관점 재검토에서 Critical/Important 미해결 0개
- [ ] 복구·기기 분실·계정 탈취 시나리오 승인
- [ ] 웹/모바일/서버/업데이트 위협 모델 별도 승인

하나라도 미완료면 실제 Secret 입력과 공개 배포를 열지 않는다.

## 9. Daybreak 정기 리뷰 운영

- 큰 보안 설계 선택 직후
- native/crypto/auth/recovery 변경 직후
- 중요한 의존성·SQLite 버전 업데이트 시
- 실제 Secret gate 개방 직전
- 출시 후 월 1회 또는 보안 사고 후

리뷰 결과는 다음 네 가지로 분리한다.

1. 확인된 취약점
2. 방어 강화 권고
3. 재현되지 않은 가설
4. 범위 밖 또는 이미 높은 권한이 필요한 잔여 위험

## 10. 계속 기록할 로그

### 2026-08-29 — 최초 기록

- **관찰됨:** 작업 트리는 clean, 로컬 branch는 원격보다 10커밋 앞섰다.
- **관찰됨:** actual main/WAL/SHM binding과 RO→RW 연속성이 미완료다.
- **결정 대기:** same-user active file attacker를 v1 위협 범위에 포함할지 선택 필요.
- **유지:** 합성 데이터 전용, 실제 Secret 금지, push 금지.

### 2026-08-29 — 병렬 모델 교차 검토 반영

- Terra: SQLite TOCTOU 종료 후 recovery/device key와 rollback/checkpoint/sync를 P0로 진행할 것을 권고.
- Luna: RED/BLUE 기록에서 관찰과 미검증을 명확히 나눌 것을 권고.
- GPT-5.5: Option 1은 출시 차단, Option 2는 보조, Option 3은 최종 제품 경계로 역할을 분리할 것을 권고.
- 공통 제한: 읽기 전용 검토이며 새 보안 보장을 증명하지 않는다.

## 11. 큰 틀 우선순위

### P0 — 실제 Secret 전 필수

1. main/WAL/SHM TOCTOU와 RO→RW 결속 해결
2. rollback·row omission checkpoint/manifest 구현
3. 복구 key slot, hardware-backed device key, 기기 폐기·키 회전
4. 독립 암호·native·침투 검토와 backup/export 복구 훈련

### P1 — 합성 데이터로 제품 흐름 완성

- Android 금고 생성·잠금·검색·복사·자동 잠금·복구 UI
- Web 편의 클라이언트의 별도 보안 경계
- 암호문 sync API, PostgreSQL, passkey/OIDC, 충돌 UX
- 개인정보·계정 삭제·지원·배포 서명 준비

### P2 — 보안 기반 이후

- Free/Pro 결제·한도·환불·다운그레이드
- iOS, 브라우저 자동입력, 팀 공유, TOTP
- 실제 Secret에 접근하는 MCP/플러그인은 별도 고위험 프로젝트로 심사
