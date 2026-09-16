# KeyAtlas 자율 작업 상태표

기준: 2026-09-17, 현재 작업 브랜치 `codex/firstvibe-rotation-worker-client`.
전체 목표는 사용자 결정(도메인, 배포, 디자인 등)을 제외한 구현·검증의 진행이다. 이 표는 범위를 줄인 완료 선언이 아니다. 제품 요구 기준은 [MVP](MVP.md)와 [보안 설계](SECURITY_ARCHITECTURE.md)를 유지한다.

별도 `codex/firstvibe-synthetic-rotation-checklist` 체크포인트: 합성 연결처의 필수 완료 조건을 확인하고 최종 암호문 후보만 생성하는 코어를 추가했다. 새 코어 11 tests와 SQLite 충돌/재실행 테스트를 포함해 Node 타입 수정판 `06349e8`의 원격 run `35106829156`이 전체 성공했다. 기존 PR #4의 `ce518ee`도 run `35106625311` 전체 성공을 확인했다. 로컬 Windows 앱 제어 4551 정책은 변경하지 않았다. 단발성 코어이며 후속 회전·연결 편집·UI는 미지원이다. [검증 기록](verification/2026-09-16-synthetic-rotation-cutover.md)을 참고한다.

현재 후속 작업: archive와 conflicts의 원자 snapshot 및 인증 후 exact-byte 재확인으로 백업 중 저장 경합을 닫았다. 로컬 22파일 965 tests와 독립 소스 리뷰를 통과했고, 원격 run `35112935398`도 Secret/Rust/WASM/web 전체 gate 성공으로 끝났다. [구현·검증 경계](verification/2026-09-17-atomic-backup-snapshot.md)를 참고한다.

완료된 lifecycle/history 기준 작업: 완료된 합성 회전 event가 붙은 revision 뒤의 일반 편집을 허용하되 새 successor payload에서만 event를 비우고 과거 암호문은 바꾸지 않도록 했다. metadata만 조작한 `0001`, 비정상 optional 연결, 비연속 세대와 legacy incomplete event는 읽기 호환성을 유지하면서 generic/no-op/연결 편집/다음 회전과 RNG 전에 fail-closed한다. 합성 값 `0001→0002→0003`의 두 차례 회전과 그 사이 편집을 지원하며, caller가 제공한 head와 모든 ancestor를 인증·연결하고 세대 연속성을 확인한 뒤 Secret/메모 없이 회전 event만 최신순으로 돌려주는 bounded history API를 추가했다. 기준 커밋 `8ef81d9`는 원격 run `35119009675` attempt 2에서 모든 step이 `SUCCESS`로 끝났다. 이는 provider 갱신/폐기 증명, latest-head/rollback anchor, 웹·WASM·Android workflow가 아니다. [lifecycle/history 검증 기록](verification/2026-09-17-synthetic-rotation-lifecycle-history.md)을 따른다.

현재 rotation archive/WASM slice: 인증된 합성 archive head에서 고정 generation·fixture·필수 여부·남은 개수만 투영하는 checklist와, 원본 revision을 다시 쓰지 않고 선택한 head에만 새 합성 cutover 후보를 붙이는 내부 경로를 추가했다. JavaScript 표면은 `synthetic-demo` 전용이며 primitive boolean/number만 엄격히 받고 임의 Secret·문자열·provider 자료를 받지 않는다. 최종 현재 트리에서 `vault-client-wasm` 합성 demo 40 tests, default release WASM runtime 32 checks, demo release WASM runtime 1520 checks(5 checklist, 2 cutover, 100 rejection)와 직접 constructor의 고정 `Error("CONSTRUCTOR_DISABLED")` 거부가 통과했다. 손상 archive의 신규 API 거부, `0002→일반 편집→0003` 부모 연결, 0002/0003 후보의 합성 평문 비노출도 별도 회귀로 고정했다. 코어 checklist 8 tests, Secret scanner 회귀 양쪽 99 tests, 실제 저장소 scan, Node 문법·format·Clippy·diff, 웹 25 files/997 tests·typecheck·production build도 통과했다. 이전 generated WASM 부재 실패는 생성 전 과거 시도이며 현재 증거가 아니다. 이 브랜치 exact SHA의 원격 CI 성공은 아직 주장하지 않는다. [부분 검증 기록](verification/2026-09-17-synthetic-rotation-archive-wasm.md)을 따른다.

현재 Worker/Client slice: 닫힌 합성 rotation 선택을 Worker 전에 검증·복사하고, 실제 demo WASM checklist/cutover를 작업별 고정 응답으로 연결했다. checklist handle은 두 차례 exact boolean lock 상태를 확인한 뒤 lock/free되고, structured clone 뒤에도 client가 고정 필드·상태 불변식을 다시 검증해 frozen projection만 공개한다. cutover ciphertext는 경계마다 복사하고 Worker 소유 buffer만 transfer한다. 첫 RED 리뷰의 truthiness fail-open Important 1건은 두 검사와 10개 회귀로 수정했으며 독립 재리뷰는 Critical/Important 0이다. mock 경계뿐 아니라 실제 생성 WASM handle과 어댑터의 결합도 별도 검사했다. 저장 CAS와 UI는 아직 연결하지 않았다. [검증 기록](verification/2026-09-17-synthetic-rotation-worker-client.md)을 따른다.

## 현재 확인한 것

| 항목 | 현재 증거 | 남은 일 |
|---|---|---|
| 암호화/필드 보존 | 기존 코어, 후속 67개 필드 비교 검사 cherry-pick | 통합 상태의 네이티브 회귀, 독립 리뷰 |
| 로컬 웹 저장/복원 | IndexedDB·Worker·WASM 구현, 통합 웹 전체 932 tests; 합성 등록 후 저장본 재열기·새로고침 확인, v3 편집·충돌 보존·검토 UI·백업 guard는 실제 WASM+fake IndexedDB 검증 | 파일 다운로드 경로, 실제 브라우저 다중 writer/오프라인 통합 검사 |
| 자동 잠금 | 5분/숨김/절전 후 만료/시계 오류 처리, 신규 18 tests | 실제 브라우저·모바일 수명 주기 확인 |
| 키와 연결처 목록 | 계정/workspace/project/환경 private projection·검색; 실제 Comet에서 3→6개 등록, 0/1/3 연결과 순서 보존, 검색·잠금·재열기·360px 검사 | 임의 데이터 수동 등록/편집, 회전 체크리스트, 실제 모바일/큰 목록 검증 |
| 합성 백업/복원 | 기존 guard 후속으로 한 readonly transaction의 archive+conflicts snapshot 2회와 인증 bytes 비교, raw 원본 보존; Store 122/Backup 167/Session 47 tests 통과 | 해당 백업 checkpoint의 actual-WASM·전체 CI, 실제 브라우저 경합·다운로드·네이티브 파일 선택 왕복 미검증. 마지막 snapshot 이후 변경은 포함하지 않음. 실제 데이터용 기능 아님 |
| 로컬 도구 경계 | 입력 64 tests + 세션 62 tests; 격리 Comet 검색/분류/잠금/재열기/숨김 검사, 중복 React key 수정 후 콘솔 경고 0 | 외부 AI/MCP 연결·개인 projection 승인 아님; 실제 모바일 검증 별도 |
| 웹 등록 화면/저장 경로 | 닫힌 2프로필/0~3연결 폼 → archive v2 → Worker/세션 CAS → 저장본 전체 재인증; 실제 브라우저 이중 클릭 한 번 저장·계정 정보 보존·탭 전환 잠금 확인 | 합성 선택형만 지원. 편집 UI 실제 저장/회전·rollback/누락 보장은 아직 없음 |
| 웹 연결 편집 내부 경로 | 같은 record의 successor·immutable v3 이력/명시적 head·표시 bytes+generation 결합·후보 사전 인증·원자 CAS/재인증, Rust release 30 tests 및 실제 demo WASM 973 checks | 실제 브라우저 편집 Worker/IDB 미검증, 회전·signed rollback/누락 anchor 미구현 |
| 합성 회전 lifecycle/history | 완료 event를 revision-local 기록으로 보존하고, 인증된 successor에서만 event를 비운 뒤 일반·연결 편집과 두 번째 합성 회전을 진행. 최대 512 revisions/8 MiB의 caller-supplied chain 전체와 `0001→0002→0003` 세대 연속성을 인증하고 회전 event의 opaque ID·bounded counts·enum만 최신순 projection. 기준 `8ef81d9`의 원격 run `35119009675` attempt 2 전체 성공 | 중간 checklist 저장, provider 실제 증명, latest-head/rollback anchor, 웹·Android 연결 미구현 |
| 합성 회전 archive/WASM | 인증된 선택 head에서 고정 checklist를 투영하고 v1/v2 genesis를 v3 history로 옮기거나 `0001→0002→0003` 후보를 생성한다. 기존 envelope와 다른 head를 보존하고 선택 head만 전진시키며 assembled archive를 다시 인증한다. JS API는 `synthetic-demo` 전용, 직접 생성 거부/getter-only/lockable checklist와 엄격한 primitive 입력만 노출. 최종 native 40 tests, default release WASM 32 checks, demo release WASM 1520 checks(5 checklist, 2 cutover, 100 rejection), 웹 25 files/997 tests·typecheck·production build 통과 | 현재 branch exact SHA 원격 CI, 저장 CAS, Worker/session/UI, 실제 Secret/provider proof, latest-head/rollback anchor 미검증 |
| 합성 회전 Worker/Client | exact 5-field 선택 parser, 실제 WASM handle 소유 adapter, Worker의 checklist/cutover dispatch와 client structured-clone 재검증을 구현. 입력·출력 복사, lock/free, 고정 오류, 취소·timeout·늦은 응답, 동기 transport 실패, owned transfer/detach를 회귀로 고정. 독립 수정 후 RED Critical/Important 0 | IndexedDB expected-byte CAS, conflict loser 보존, authoritative reread/re-authentication, 실제 브라우저 Worker와 UI 미구현 |
| 암호문 conflict outbox | DB v1/store 유지, 최대 8개 무퇴거 후보, CAS loser 보존, 전체 인증 뒤 위치 기반 검토, exact-byte 2단계 폐기, 미해결 후보 backup 차단 | 자동 병합·승격 정책과 outbox 포함 백업 형식, 실제 브라우저 멀티탭·모바일 검증 |
| 웹 연결 편집 UI | 검토 UI 포함 통합 웹 932 tests, typecheck/build exit 0; 독립 보안 리뷰 Critical/Important 0 | 저장/취소/포커스/잠금·멀티탭 충돌의 실제 브라우저 검증과 모바일 검증 |
| 공유 메모리 입력 경계 | Store·Session·Worker client/worker·Backup에서 SharedArrayBuffer를 DB/Worker/WASM 작업 전에 고정 오류로 거부 | cross-origin-isolated 실제 브라우저의 동시 변경 통합 검사는 미실행 |
| 원격 CI 보안 gate | `ce518ee`, `06349e8`, atomic-backup 후속 run `35112935398`, lifecycle/history `8ef81d9` run `35119009675` attempt 2의 성공 확인 | 현재 미커밋 rotation archive/WASM 변경은 원격 검증 전. branch protection과 ignored 보안 gate 승인은 별도 |
| SQLite 읽기 전용 preflight | 8 DB_CONFIG를 첫 SQL 전에 적용하고 query_only와 공통 hardening을 읽기 전용 연결에도 강제; 패키지 91 passed/1 ignored, 독립 재리뷰 Critical/Important 0 | 악성 schema 실제 통합 fixture와 WR 대칭 profile assertion은 residual |
| 네이티브 전체 QA | `5d439eb` 기능 묶음 기준 Workspace Secret scan·format·Clippy·tests·ordinary VFS·doctests exit 0. 후속 scanner-only 트리는 집중 회귀와 실제 저장소 scan 통과 | 후속판 전체 Workspace 재실행과 명시적으로 ignored인 Phase 0A 보안 gate·권위 승인은 별도 필요 |

## 이어서 할 수 있는 구현

1. 합성 백업·복원의 디스크 다운로드/네이티브 선택 검증을 지원되는 환경에서 보완한다. 브라우저 File API로 전달한 검사는 실제 파일 다운로드 성공과 구분한다. [통합 검증 기록](verification/2026-09-15-backup-session-integration.md)을 따른다.
2. 연결된 합성 편집 UI의 [부분 검증 기록](verification/2026-09-15-synthetic-connection-editor-ui.md)에 따라 실제 브라우저 저장/취소/포커스/잠금/변경/충돌을 검증한다. row reference와 generation은 같은 표시 snapshot에서 캡처하며 합성 선택형과 Claude Code 디자인 경계를 보존한다.
3. 합성 회전 Worker/Client 경계를 마친 뒤 session/IndexedDB CAS로 잇는다. 후보 생성과 durable 성공을 구분하고, 표시된 authenticated bytes·generation이 현재 값과 exact 일치할 때만 원자 저장하며 loser 보존·authoritative reread·재인증·잠금/취소 세대 검사를 포함한다. 실제 Secret/provider 입력은 열지 않는다.
4. durable conflict outbox의 저장·인증 목록·명시적 exact-byte 폐기와 백업 차단 경계는 구현했다. 실제 브라우저 다중 창 검증과 intermediate 회전 checklist 저장·optional 연결 확인 API로 진행한다. 자동 재시도·병합·승격·퇴거는 열지 않는다.
5. 외부 계정 없이 검증 가능한 API 계약·동기화 충돌 모델·로컬 테스트 환경을 명세에 맞춰 준비한다. 클라우드 연결을 했다고 주장하지 않는다.
6. 보안 수명 주기·복구·기기 해제의 미결 설계와 구현 증거를 비교하고, 사용자 선택이 필요한 부분과 독립 리뷰가 필요한 부분을 분리한다.

각 항목은 테스트·빌드·실제 동작 범위를 명시한 체크포인트로 남긴다. 모두 끝날 때까지 목표는 active이며 좁은 테스트 통과를 서비스 완성으로 대체하지 않는다.

## 사용자 또는 별도 권한/리뷰가 필요한 경계

- 서비스명/도메인, 최종 디자인, 공개 배포, 운영 DB/IAM 및 결제 계정 선택.
- 가격·결제 활성화, 개인정보·법률 문서 확정, 앱스토어 제출.
- 실제 Secret 입력 개방, 사용자 키/복구 방식의 미결 결정 및 독립 보안 검토.
- OS 앱 제어 정책 변경/예외는 자율 실행 범위 밖. main 병합도 별도 승인 대상.

현재 사용자에게 위 항목을 즉시 결정하라고 요구하지 않는다. 안전하게 독립 진행할 수 있는 구현이 남아 있다.

## 현황 공유·다른 기기 협업

[2026-09-15 갱신 공유 가이드](KEYATLAS_PROJECT_SHARED_GUIDE.md)에 조건부 기간, 작업 경로, 역할/브랜치 제안 및 병렬 협업 범위를 정리했다. 같은 본문을 사용자 요청의 바탕화면 파일에도 반영했다. 이전 9월 12일 본문은 archive에 보존한다.
기기 연결·원격 제어·연산 오케스트레이션은 KeyAtlas 밖의 비공개 운영 저장소에서 관리한다. KeyAtlas에는 별도 clone/worktree, 담당 파일, base/head SHA, 재현 가능한 검사 명령과 종료 코드만 남기며 장치·계정·접근 설정은 기록하지 않는다.
