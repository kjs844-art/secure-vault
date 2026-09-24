# KeyAtlas 범용 AI 인계서 · 공용 TODO 작업판

> 최초 작성: **2026-09-24 KST**
> 제품명: **KeyAtlas (working title)**
> 저장소: `https://github.com/kjs844-art/secure-vault`
> 이 문서의 역할: **어떤 AI·새 세션·다른 기기에서도 가장 먼저 읽는 작업 진입점**
> 전체 제품 설명: [0부터 공개 서비스까지 전체 체크리스트](KEYATLAS_ZERO_TO_PUBLIC_SERVICE_CHECKLIST_2026-09-18.md)
> 실제 Secret 허용 상태: **`REAL_SECRET_GATE=CLOSED`**

```text
문서 절대 경로: C:\Users\USER\Documents\ChatGPT\KeyAtlas\agent-staging\keyatlas-luna-release-support\docs\handoff\KEYATLAS_UNIVERSAL_AI_HANDOFF_AND_TODO_2026-09-24.md
문서 worktree branch: codex/firstvibe-luna-release-support
문서 worktree HEAD/upstream: 0b1c7bf2a5cf4681adbf845d30c7695251d3fb94
문서 worktree dirty: 기존 종합 문서 1개 수정 + 이 파일 1개 신규
제품 협업 baseline: codex/firstvibe-collab-001-100-baseline
제품 baseline HEAD/upstream: d9c66661db7d7b66f6453e94e467c424107cba66
제품 baseline tracked dirty: 없음
마지막 로컬 상태 확인: 2026-09-24 20:25:17 +09:00
상태 확인자: Codex root
현재 task lock: 없음 — KA-A03 문서 작업 검증 후 해제
```

이 파일은 단순 설명서가 아니라 **공용 작업판**이다. 작업을 시작하는 AI는 먼저 현재 Git
상태를 확인하고, 계약이 완성된 작업 하나만 선택한다. 다만 이 공용판은 원자적 잠금장치가
아니므로 **integration owner 한 명만 수정**한다. 작업자는 고유한 완료 보고를 제출하고,
integration owner가 증거를 확인한 뒤 체크박스를 갱신한다. 브랜치 생성·commit·push·PR·merge는
각각 별도 상태이며 사용자 승인 범위를 넘어서 실행하지 않는다.

---

## START HERE — 새 AI·새 세션이 처음 5분에 할 일

### 1단계: 제품과 금지선을 읽는다

```text
KeyAtlas
├─ Secure Vault
│  └─ 비밀번호 · API Key · Secret · 복구 코드 · 보안 메모
├─ Identity & Connection Map
│  └─ 로그인 수단 → 서비스 계정 → Credential → 앱/MCP/CLI/CI/서버
├─ Consent Center
│  └─ 마케팅 · 제3자 제공 · OAuth 권한 · 알림 · 구독 · 약관
└─ Privacy Cleanup Center
   └─ 수신 거부 · 연결 해제 · 키 폐기 · 탈퇴 · 삭제 요청 · 재확인
```

- 실제 비밀번호·API 키·OAuth Secret·복구 키·쿠키·카드·고객 개인정보를 입력하지 않는다.
- Google·Naver·Kakao 로그인만으로 모든 가입 사이트를 찾아낼 수 있다고 약속하지 않는다.
- 탈퇴·구독 취소·동의 철회·키 폐기·삭제 요청을 사용자 승인 없이 자동 실행하지 않는다.
- 운영자도 금고 평문을 복구하는 백도어를 만들지 않는다.
- `main` 직접 작업, force-push, 임의 reset/rebase, 공개 배포를 하지 않는다.

### 2단계: 지금 보고 있는 폴더가 제품 저장소인지 확인한다

이 장치의 바깥 폴더 `C:\Users\USER\Documents\ChatGPT\KeyAtlas`는 commit이 없는 별도
빈 Git 저장소처럼 보인다. 제품 코드 작업 위치로 사용하지 않는다.

2026-09-24 기준 canonical 협업 worktree:

```text
C:\Users\USER\Documents\ChatGPT\KeyAtlas\agent-staging\keyatlas-collab-001-100
branch: codex/firstvibe-collab-001-100-baseline
HEAD:   d9c66661db7d7b66f6453e94e467c424107cba66
```

다른 장치에서는 Windows 절대 경로를 그대로 복사하지 말고 그 장치의 clone/worktree
경로를 사용한다. 작업 전에 반드시 실행한다.

```powershell
git status --short --branch
git branch --show-current
git rev-parse HEAD
git remote -v
git log -1 --date=iso-strict --pretty=fuller
```

다음 중 하나라도 예상과 다르면 파일을 수정하지 말고 작업을 `BLOCKED`로 기록한다.

- 지정된 저장소가 아님
- 지정 브랜치·base SHA가 다름
- 기존 dirty 변경이 있음
- 다른 AI가 같은 파일을 소유하고 있음
- 선행 작업이 통합되지 않음
- 허용 경로·완료 조건·검증 명령이 비어 있음

### 3단계: 아래 배정 후보에서 한 작업만 고른다

- 한 AI는 동시에 작업 하나만 소유한다.
- 첫 응답은 읽기 전용 `PREFLIGHT`다.
- 담당자·worktree·branch·base SHA·허용 파일을 기록하기 전에는 구현하지 않는다.
- `A/HIGH-RISK` 작업은 읽기 전용 검토가 기본이며 별도 구현 승인이 필요하다.
- `READY_READ_ONLY`는 지정 commit을 읽고 현재 세션에 검토 보고만 남길 수 있다.
- `WAITING_ASSIGNMENT`는 integration owner가 계약을 채우기 전까지 작업을 시작하지 않는다.

### 4단계: 작업 종료 전에 고유 완료 보고를 제출한다

작업자는 공용판을 직접 수정하지 않고 다음 형식으로 현재 세션에 보고한다. assignment
contract가 쓰기를 허용한 경우에만
`docs/handoff/task-reports/<TASK_ID>/<TIMESTAMP>-<SESSION_ID>.md`처럼 다른 작업자와 겹치지
않는 새 파일로 남길 수 있다.

```text
final HEAD SHA:
changed files:
exact checks and exit codes:
browser/device/manual verification:
not verified:
actual Secret used: NO
commit / push / PR / merge state:
next safe action:
```

---

## 1. 현재 프로젝트 진실 — 2026-09-24 스냅샷

### Source of truth 순서

1. 현재 worktree의 실제 Git 상태와 GitHub PR·Actions 상태
2. 해당 작업의 exact assignment contract와 승인 기록
3. `docs/handoff/KEYATLAS_COLLAB_TASKS_001_100.md`: 1~100 협업 작업 정의
4. `docs/handoff/KEYATLAS_COLLAB_BRANCH_MANIFEST_001_100.csv`: task↔branch 대응
5. `docs/verification/**`: exact SHA의 실제 검사 증거
6. 이 파일: 현재 작업 소유권·체크박스·다음 작업의 스냅샷
7. `docs/handoff/KEYATLAS_ZERO_TO_PUBLIC_SERVICE_CHECKLIST_2026-09-18.md`: 전체 설계·비용·일정
8. `docs/CURRENT_CHECKPOINT_2026-09-19.md`: 9월 19일 통합 체크포인트
9. 보안 ADR·위협 모델: 설계 상태와 승인 여부

위 3~5번과 8번 파일은 이 문서가 있는 release-support worktree가 아니라 2026-09-24 기준
canonical 협업 worktree `agent-staging\keyatlas-collab-001-100`의 `d9c6666...`에 있다. 현재
worktree에서 파일이 안 보인다는 이유만으로 삭제됐다고 판단하지 말고 canonical worktree에서
확인한다. 이 문서가 baseline에 통합되기 전에는 다른 장치의 clone에서 자동으로 보이지 않는다.

문서와 코드가 충돌하면 코드를 추측하지 않는다. exact branch/SHA에서 다시 검사하고,
증거가 없으면 기본값은 `UNKNOWN`이다.

### Git·구현 상태

| 항목 | 현재 상태 | 근거와 한계 |
|---|---|---|
| 2026-09-19 통합 tip | `PUSHED` | `41eeed0492e5325816e0797bbefa727408574e3c` |
| 2026-09-22 협업 baseline | `PUSHED` | `d9c66661db7d7b66f6453e94e467c424107cba66` |
| 2026-09-24 C30 회귀 기록 직전 범용 작업판 snapshot | `PUSHED` | `codex/firstvibe-luna-release-support@eb0127eb10c6e123866320a89e02358e0ce8192e` |
| 1~100 원격 task branch | `RESERVED` | branch 존재는 구현 완료가 아님 |
| #30 provider metadata | `PUSHED_LOCAL_REGRESSION_PASS_REMOTE_CI_UNKNOWN` | `codex/firstvibe-collab-30-provider-metadata-fix-01@534b37c`; fail-closed 보완·독립 리뷰 P1/P2 0·Release WASM·typecheck·47/47 files/1554 tests·build·Secret scan PASS, UI·PR·통합·remote CI 미완료 |
| #58 evidence labels | `PUSHED_LOCAL_DONE` | `codex/firstvibe-collab-58-evidence-labels-fix-01@090c731`; 의미 수정 4건·문서/Secret 검사·독립 재검토 P1/P2/P3 0, PR·통합·remote CI 미완료 |
| #93 release manifest | `PUSHED_LOCAL_SECURITY_FIX_DONE` | `codex/firstvibe-collab-93-release-artifact-manifest-fix-01@594824d`; PS5.1 10/10·scanner 102/102·Secret scan·독립 리뷰 2건 P1/P2/P3 0, PS7 실행환경 차단·CI/PR/통합 미완료 |
| 원격 CI | `BLOCKED/UNKNOWN` | 기록상 계정/과금 차단, 2026-09-24 조회도 404 |
| main 통합 | `NOT_DONE` | 최신 baseline·로컬 후보가 main에 반영됐다는 증거 없음 |
| 실제 Secret | `FORBIDDEN` | 독립 감사·복구·동기화·운영 gate 미충족 |
| Privacy Cleanup | `NOT_STARTED` | 제품 방향·요구·TODO만 있고 코드 없음 |

### 기능 상태

| 영역 | 상태 | 현재 실제 의미 |
|---|---|---|
| Rust 암호화 코어 | `PARTIAL_PRODUCT` | 합성 KDF/AEAD/codec/변조 거부 기반, production 승인·외부 감사 전 |
| 로컬 SQLite | `PARTIAL_PRODUCT` | 암호문 revision/CAS/충돌/재시작 기반, 전체 파일 암호화·rollback anchor·actual-handle 보장 없음 |
| Web/WASM/IndexedDB | `PARTIAL_PRODUCT` | 합성 등록·검색·잠금·편집·회전·백업 기반, 실제 Secret·전체 브라우저 E2E 없음 |
| 계정·Credential 관계 | `PARTIAL_PRODUCT` | 관계 코어·합성 데이터 존재, 실제 계정 발견·provider 연동 없음 |
| 복구·신뢰 기기 | `DESIGN_ONLY` | ADR 일부만 있으며 wire·구현·분실 훈련 없음 |
| Spring Boot·PostgreSQL | `NOT_STARTED` | README/설계 수준 |
| Google/Kakao/Naver·Passkey | `NOT_STARTED` | 실제 OAuth·서버 세션 없음 |
| Android·생체 인증 | `NOT_STARTED` | Kotlin/Gradle/Keystore/BiometricPrompt 구현 없음 |
| 결제·공개 배포 | `NOT_STARTED` | 상품·entitlement·도메인·운영 배포 없음 |
| Consent·Privacy Cleanup | `NOT_STARTED` | domain contract·화면·외부 동작 없음 |

---

## 2. 상태·체크박스 규칙

### 세 축을 섞지 않는다

```text
task_state:   TODO | IN_PROGRESS | BLOCKED | DONE | DEFERRED
collab_stage: RESERVED → PREFLIGHT → IMPLEMENTING → LOCAL_DONE
              → PUSHED → DRAFT_PR → VERIFIED → MERGED
check_result: PASS | FAIL | BLOCKED | NOT_RUN | UNKNOWN
```

`READY_*`, `BACKLOG_*`, `HIGH_RISK_*`는 **준비도·위험 라벨**이지 협업 단계가 아니다.
모든 상세 task block에는 `task_state`, `readiness`, `collab_stage`를 따로 기록한다.

| 준비도·위험 | 뜻 |
|---|---|
| `BACKLOG` | 필요하지만 시작 조건·계약을 아직 완성하지 않음 |
| `WAITING_ASSIGNMENT` | coordinator가 exact branch·허용 경로·검사를 채워야 함 |
| `READY_READ_ONLY` | 지정 source를 읽고 세션 보고만 할 수 있음 |
| `READY_IMPLEMENT` | 파일 쓰기까지 승인된 완성 계약이 있음 |
| `HIGH_RISK` | 기본은 검토 전용이며 추가 승인·독립 리뷰가 필요함 |
| `EXTERNAL_GATE` | 사용자 계정·비용·법률·외부 전문가 등을 기다림 |

| 협업 단계 | 뜻 |
|---|---|
| `RESERVED` | task/branch만 예약, 작업 안 함 |
| `PREFLIGHT` | 읽기 전용 조사·범위·검증 계획 작성 |
| `IMPLEMENTING` | 승인된 파일에서 작업 중 |
| `LOCAL_DONE` | 로컬 산출물과 관련 검사가 있으나 push/PR/통합 전 |
| `PUSHED` | task branch 원격 SHA와 로컬 HEAD가 일치 |
| `DRAFT_PR` | baseline 대상 검토용 PR이 열림, 병합 승인 아님 |
| `VERIFIED` | 동일 SHA 필수 검사와 독립 리뷰 통과 |
| `MERGED` | 승인된 대상 branch에 반영됨 |

### 검사 결과와 출처

```text
결과: PASS | FAIL | BLOCKED | NOT_RUN | UNKNOWN
출처: LOCAL | REMOTE_CI | INDEPENDENT_REVIEW | HUMAN_CHECK | SIMULATION
```

- `PASS`에는 exact SHA, 명령/검토 범위, exit code 또는 finding 수가 있어야 한다.
- runner가 시작되지 않았으면 코드 `FAIL`이 아니라 `BLOCKED`다.
- `SIMULATION PASS`는 실제 merge·배포·브라우저 동작의 PASS가 아니다.
- 다른 SHA의 결과를 현재 SHA로 복사하지 않는다.
- 미검증 기본값은 `UNKNOWN`이다.

### 체크박스를 `[x]`로 바꾸는 조건

각 task는 먼저 `completion_target`을 선언하고 세 종류의 체크를 가진다.

```text
[ ] 산출물   지정된 파일과 수용 기준을 만족
[ ] 검증     exact SHA에서 필수 검사와 미검증 범위를 기록
[ ] 통합     승인된 branch에 반영되고 대상 SHA를 기록
```

- 일반 작업자는 `산출물`, `검증`만 체크할 수 있다.
- `통합`은 integration owner 또는 명시적으로 승인된 담당자만 체크한다.
- 기본 코드 task의 `completion_target`은 `VERIFIED` 또는 `MERGED`다.
- 문서·조사 task가 `LOCAL_DONE`이나 `PUSHED`를 최종 목표로 삼으려면 작업 시작 전에 그 목표와
  이유를 명시해야 한다.
- 선언한 목표, Definition of Done, 필수 검사가 모두 충족될 때만 task 제목을 `[x]`로 바꾼다.
- 새 commit으로 final SHA가 바뀌면 그 SHA에서 재실행하지 않은 검사는 `UNKNOWN`으로 되돌린다.
- 문서 작업이면 Web/Rust 테스트가 `NOT_RUN`일 수 있지만, 문서 검사와 이유를 남겨야 한다.
- 삭제·탈퇴·키 폐기처럼 외부 상태를 바꾸는 task는 사용자 승인 영수증 없이는 완료가 아니다.

---

## 3. 작업 소유권 등록 양식

작업 시작 전 integration owner가 해당 task block에 복사한다. placeholder가 남아 있으면
`BLOCKED`다.

```yaml
task_id: "[STABLE_ID]"
task_title: "[ONE_DELIVERABLE]"
task_state: "TODO"
readiness: "WAITING_ASSIGNMENT"
collab_stage: "PREFLIGHT"
completion_target: "VERIFIED"
assignee: "[AI_TOOL_AND_SESSION]"
integration_owner: "[OWNER_OR_UNASSIGNED]"
session_id: "[UNIQUE_SESSION_ID]"
claim_id: "[TIMESTAMP-AI-TASK]"
claimed_at: "[ISO_8601]"
last_heartbeat_at: "[ISO_8601]"

repository: "https://github.com/kjs844-art/secure-vault"
worktree: "[ABSOLUTE_PATH_ON_THIS_DEVICE]"
branch: "[EXACT_BRANCH]"
base_branch: "codex/firstvibe-collab-001-100-baseline"
base_sha: "[40_HEX_SHA]"
head_before_work: "[40_HEX_SHA]"

allowed_paths:
  - "[EXACT_PATH]"
forbidden_paths:
  - ".github/**"
  - "crates/vault-crypto/**"
  - "[TASK_SPECIFIC_PATH]"

predecessors: "[TASK_ID_AND_MERGED_SHA_OR_NONE]"
definition_of_done:
  - "[OBSERVABLE_RESULT]"
required_checks:
  - "[EXACT_COMMAND_OR_REVIEW]"

real_secret_gate: "CLOSED"
file_write_approved: "[YES_OR_NO]"
commit_approved: "NO"
push_approved: "NO"
pr_approved: "NO"
main_merge_approved: "NO"
```

### 동시 작업 충돌 규칙

- 같은 파일을 두 AI가 동시에 소유하지 않는다.
- 활성 소유권이 겹치면 새 작업자가 중단하고 integration owner에게 조정 요청을 남긴다.
- 다른 AI의 변경을 stash/reset/checkout/delete하지 않는다.
- 이 shared TODO 파일은 integration owner만 master update lock을 잡고 수정한다.
- 작업자는 현재 세션 보고 또는 contract가 허용한 고유 task-report 파일만 작성한다.
- integration owner는 보고의 branch·SHA·검사를 재확인한 뒤 task block·세션 로그·checkbox를 갱신한다.
- 단순히 시간이 지났다는 이유로 다른 AI의 소유권을 빼앗지 않는다. 종료·중단 증거 또는
  사용자의 재배정이 있어야 한다.

---

## 4. 다음 배정 후보와 즉시 가능한 읽기 전용 검토

아래 세 원본 후보의 **읽기 전용 검토는 완료**됐다. 검토 완료는 후보 통합 승인이 아니다.
#30 보완 tip `534b37c`, #58 보완 tip `090c731`, #93 보완 tip `594824d`는 각각 전용 원격 branch에 발행됐다.
수정·테스트 산출물 생성·commit·push·PR·merge는 각각 별도 상태와 증거로 기록한다.

| 선택 | ID | readiness | 읽을 source | 허용 범위 | completion target | 예상 |
|---|---|---|---|---|---|---:|
| [x] | `KA-C30-01` | `READ_ONLY_REPORT_DONE` | `codex/firstvibe-collab-30-provider-metadata@2390b55684f5f46c28bc6870b61915b949dd494f` | 검토 보고 완료; 후보는 `NEEDS_REVISION_BEFORE_INTEGRATION` | `READ_ONLY_REPORT` | 완료 |
| [x] | `KA-C58-01` | `READ_ONLY_REPORT_DONE` | `codex/firstvibe-collab-58-evidence-labels@6803eb5c4c5d002f247daae49b8b4cd024e3ef80` | 검토 보고 완료; 후보는 `NEEDS_REVISION_BEFORE_INTEGRATION` | `READ_ONLY_REPORT` | 완료 |
| [x] | `KA-C93-01` | `READ_ONLY_REPORT_DONE` | `codex/firstvibe-collab-93-release-artifact-manifest@f1a98b5acc0d24e591dba87ca60ae3f25f88344f` | 검토 보고 완료; 후보는 `NEEDS_REVISION_BEFORE_INTEGRATION` | `READ_ONLY_REPORT` | 완료 |

다음 항목은 아직 `WAITING_ASSIGNMENT`다. 새 AI가 임의 branch나 허용 경로를 만들지 않는다.

| ID | 작업 | 계약에 더 필요한 값 | 예상 |
|---|---|---|---:|
| `KA-BASE-01` | canonical exact SHA 전체 회귀 | 전용 worktree·실행환경·산출물 경로·명령 | 0.5~2일 |
| `KA-C93-CI-01` | #93 manifest test를 hard process timeout과 함께 CI에 연결 | integration base·workflow 허용 파일·PS7 runner | 0.5~1일 |
| `KA-PRI-P01` | Privacy PRD·비목표·수용 기준 | task branch·허용 파일·reviewer·completion target | 2~4일 |
| `KA-PRI-P02` | domain contract | P01 final SHA·task branch·허용 파일·검사 | 4~8일 |
| `KA-QA-01` | 브라우저 다중탭 E2E 계획 | task branch·browser fixture·산출물 경로·검사 | 1~2일 |

현재 권장 병렬 배치:

```text
완료: KA-C30-01·KA-C58-01·KA-C93-01 읽기 전용 리뷰
부분 완료: KA-C30-FIX-01 pushed commit 534b37c·focused 87/87·독립 리뷰 P1/P2 0·
          Release WASM·typecheck·전체 test 1554/1554·build·Secret scan PASS; PR·통합·remote CI는 미완료
완료: KA-C58-FIX-01 pushed commit 090c731·의미 수정 4건·Secret scan·독립 리뷰 P1/P2/P3 0
완료: KA-C93-FIX-01 pushed commit 594824d·PS5.1 10/10·scanner 102/102·Secret scan·독립 리뷰 2건 P1/P2/P3 0
남음: KA-C93-CI-01 PS7 runner·hard process timeout·workflow 연결, PR·통합·remote CI
Primary: KA-BASE-01·KA-PRI-P01·KA-QA-01 계약 작성과 충돌 관리
```

---

## 5. Master TODO — 전체 작업판

표의 첫 체크박스는 **선언된 completion target 기준의 최종 완료**다. 목표가 별도로
`LOCAL_DONE`이나 `PUSHED`로 승인된 문서·조사 task가 아니라면 그 단계만으로 `[x]` 처리하지
않는다.

아래 `상태·준비도` 열은 빠르게 훑기 위한 **비권위 요약 라벨**이다. 이 값을 `task_state`,
`readiness`, `collab_stage` 중 하나로 복사하지 않는다. 상세 task block에 세 필드가 모두 없으면
그 작업은 `WAITING_ASSIGNMENT`이며 구현할 수 없다.

### A. 저장소·협업·검증 기준선

| 완료 | ID | 상태·준비도 | 작업 | 담당 | 예상 | 완료 증거 |
|---|---|---|---|---|---:|---|
| [x] | `KA-A01` | `PUSHED` | 2026-09-19 통합 체크포인트 기록 | 완료 | 완료 | target=`PUSHED`; 원격 `codex/firstvibe-integration-20260919@41eeed0492e5325816e0797bbefa727408574e3c` |
| [x] | `KA-A02` | `PUSHED` | 1~100 협업 baseline·manifest 작성 | 완료 | 완료 | target=`PUSHED`; 원격 `codex/firstvibe-collab-001-100-baseline@d9c66661db7d7b66f6453e94e467c424107cba66` |
| [ ] | `KA-A03` | `LOCAL_DONE` | 전체 설계·현황·TODO 문서 2026-09-24 갱신 | Codex root | 완료 | 로컬 문서 완료; 검증·원격 통합 증거는 이 세션 로그 참조 |
| [ ] | `KA-BASE-01` | `WAITING_ASSIGNMENT` | canonical exact SHA 전체 로컬 회귀 | 미배정 | 0.5~2일 | Secret/Rust/WASM/Web 명령별 exit code |
| [ ] | `KA-A05` | `BLOCKED` | exact SHA 원격 CI | 사용자+AI | 외부 상태 | runner 실제 실행·동일 SHA 결과 |
| [ ] | `KA-A06` | `BACKLOG_HIGH_RISK` | main 보존 통합·충돌 해결 | primary | 2~5일 | 독립 리뷰·전체 회귀·사용자 승인 |
| [x] | `KA-C30-01` | `READ_ONLY_REPORT_DONE` | provider metadata 후보 통합 판단 | Codex root | 완료 | `E-20260924-C30-GIT-01`, `E-20260924-C30-REVIEW-01`; 후보는 통합 비권장 |
| [ ] | `KA-C30-FIX-01` | `PUSHED_LOCAL_REGRESSION_PASS_REMOTE_CI_UNKNOWN` | #30 fail-closed 입력 경계·날짜 증거·회귀 보완 | Claude 구현+Codex 검증 | 통합 전 | 원격 `534b37c`; 독립 P1/P2 0·Release WASM·typecheck·47/47 files/1554 tests·build·Secret scan PASS, PR·통합·remote CI 미완료 |
| [x] | `KA-C58-01` | `READ_ONLY_REPORT_DONE` | evidence label 후보 통합 판단 | Codex root | 완료 | `E-20260924-C58-GIT-01`, `E-20260924-C58-REVIEW-01`; 후보는 통합 비권장 |
| [x] | `KA-C58-FIX-01` | `PUSHED_LOCAL_DONE` | #58 의미상 수정점 4개 보완·재검토 | Codex+독립 reviewer | 완료 | target=`LOCAL_DONE`; 원격 `090c731`; 한 문서만 변경·Secret scan PASS·독립 P1/P2/P3 0 |
| [x] | `KA-C93-01` | `READ_ONLY_REPORT_DONE` | release manifest 후보 통합 판단 | Codex root | 완료 | `E-20260924-C93-GIT-01`, `E-20260924-C93-REVIEW-01`; 후보는 통합 비권장 |
| [x] | `KA-C93-FIX-01` | `PUSHED_LOCAL_SECURITY_FIX_DONE` | #93 stable snapshot·fail-closed 출력·strict schema·resource bound 보완 | Codex+독립 reviewer 2명 | 완료 | target=`LOCAL_SECURITY_FIX_DONE`; 원격 `594824d`; PS5.1 10/10·scanner 102/102·Secret scan PASS·P1/P2/P3 0 |
| [ ] | `KA-C93-CI-01` | `BLOCKED_PS7_ENV_AND_REMOTE_CI` | #93 manifest test의 PS7·workflow·hard timeout 연결 | integration owner | 0.5~1일 | PS7 runner 실행·workflow exact SHA 결과; PR·통합은 별도 |

### B. Secure Vault·저장·복구

| 완료 | ID | 상태·준비도 | 작업 | 담당 | 예상 | 완료 증거 |
|---|---|---|---|---|---:|---|
| [x] | `KA-B01` | `MERGED` | 합성 Rust 암호화·codec·Secret 타입 경계 | 완료 | 완료 | target=`MERGED`; `d9c66661db7d7b66f6453e94e467c424107cba66`; historical evidence `docs/verification/synthetic-credential-local-core.md`; current full regression은 `KA-BASE-01` |
| [x] | `KA-B02` | `MERGED` | 합성 SQLite revision·CAS·충돌·재시작 기반 | 완료 | 완료 | target=`MERGED`; `d9c66661db7d7b66f6453e94e467c424107cba66`; historical evidence `docs/verification/ciphertext-sqlite-local-store.md`; 전체 파일 암호화는 아님 |
| [x] | `KA-B03` | `MERGED` | 합성 Web→Worker→WASM→IndexedDB 흐름 | 완료 | 완료 | target=`MERGED`; `d9c66661db7d7b66f6453e94e467c424107cba66`; historical evidence `docs/verification/2026-09-13-synthetic-local-vault.md`; current full regression은 `KA-BASE-01` |
| [ ] | `KA-B04` | `WAITING_ASSIGNMENT` | 실제 브라우저 다중탭·quota·upgrade E2E | 미배정 | 2~5일 | Chrome/Edge 등 합성 E2E·미검증 브라우저 기록 |
| [ ] | `KA-B05` | `BACKLOG` | 실제 파일 backup→새 profile restore drill | 미배정 | 2~5일 | 파일 hash·기존 값 보존·실패 경로 |
| [ ] | `KA-B06` | `HIGH_RISK_REVIEW` | Windows actual-handle/VFS 또는 broker 경계 | 보안 담당 | 2~6주 | 권위 테스트·OS 정책 영향 분리 |
| [ ] | `KA-B07` | `HIGH_RISK_DESIGN` | signed checkpoint·rollback/omission/fork 탐지 | 보안 담당 | 3~6주 | 상태기계·공격 fixture·독립 리뷰 |
| [ ] | `KA-B08` | `HIGH_RISK_DESIGN` | recovery slot·신뢰 기기·key epoch | 보안 담당 | 4~8주 | 승인 ADR·복구/분실 훈련 |
| [ ] | `KA-B09` | `BLOCKED_BY_GATES` | 실제 Secret input/reveal/copy | 보안 담당+사용자 | 3~6주 | 재인증·clipboard 수명·누출 검사·독립 리뷰 |

### C. Identity & Connection Map

| 완료 | ID | 상태·준비도 | 작업 | 담당 | 예상 | 완료 증거 |
|---|---|---|---|---|---:|---|
| [x] | `KA-C01` | `MERGED` | 서비스→계정→프로젝트→환경→Credential→Connection 코어 | 완료 | 완료 | target=`MERGED`; `d9c66661db7d7b66f6453e94e467c424107cba66`; historical evidence `docs/verification/synthetic-credential-local-core.md`; 제품 UX는 미완료 |
| [ ] | `KA-C02` | `BACKLOG` | 실제 Identity Map 제품 화면 | 미배정 | 2~4주 | 계정·발급처·사용처를 3단계 안에 탐색 |
| [ ] | `KA-C03` | `BACKLOG` | 로그인 출처 Google/Kakao/Naver/Email/Passkey 기록 | 미배정 | 1~2주 | 수동 기록·공식 연동 출처 구분 |
| [ ] | `KA-C04` | `BACKLOG` | 가입 흔적 Discovery Inbox | 미배정 | 3~6주 | 확인됨/추정/확인 필요 구분·오탐 수정 |
| [ ] | `KA-C05` | `BACKLOG_HIGH_RISK` | password manager/browser export local importer | 보안 담당 | 3~6주 | 서버 업로드 0·평문 즉시 최소화·삭제 |
| [ ] | `KA-C06` | `BACKLOG_HIGH_RISK` | 가입 메일 최소 범위 탐색 | 보안 담당+사용자 | 4~8주 | 최소 scope·local-first·메일 본문 장기 보관 0 |

### D. Consent Center·구독 관리

| 완료 | ID | 상태·준비도 | 작업 | 담당 | 예상 | 완료 증거 |
|---|---|---|---|---|---:|---|
| [ ] | `KA-D01` | `WAITING_PREDECESSOR` | ConsentGrant·Subscription contract | 미배정 | 4~8일 | version/future-state/validation tests |
| [ ] | `KA-D02` | `BACKLOG` | 마케팅·제3자 제공·SMS·Push·OAuth scope UI | 미배정 | 2~4주 | 출처·활성·철회·마지막 확인일 표시 |
| [ ] | `KA-D03` | `BACKLOG` | 외부 구독·trial·갱신·해지 기록 | 미배정 | 1~3주 | KeyAtlas 자체 billing과 외부 구독 분리 |
| [ ] | `KA-D04` | `HIGH_RISK` | 동의 철회·수신 거부 반자동 adapter | 보안 담당+사용자 | 3~8주 | 명시적 승인·중복 실행 방지·결과 영수증 |

### E. Privacy Cleanup Center

| 완료 | ID | 상태·준비도 | 작업 | 담당 | 예상 | 완료 증거 |
|---|---|---|---|---|---:|---|
| [ ] | `KA-PRI-P01` | `WAITING_ASSIGNMENT` | Privacy PRD·비목표·과장 금지 | 미배정 | 2~4일 | 사용자 여정·수용 기준 승인 |
| [ ] | `KA-PRI-P02` | `WAITING_PREDECESSOR` | CleanupCase·Action·Evidence contract | 미배정 | 4~8일 | 상태·검증·future-version tests |
| [ ] | `KA-PRI-P03` | `BACKLOG` | 암호화 로컬 저장·검색 projection | 미배정 | 1~2주 | 잠금 시 조회 불가·평문 marker 0 |
| [ ] | `KA-PRI-P04` | `BACKLOG` | 합성 정리센터 목록·상세·timeline UI | 미배정 | 1~2주 | empty/error/locked/100건·접근성 tests |
| [ ] | `KA-PRI-P05` | `HIGH_RISK` | 재인증·영향 미리보기·최종 승인 상태기계 | 보안 담당 | 1~2주 | 승인 없는 외부 변경 0·중복 실행 0 |
| [ ] | `KA-PRI-P06` | `BACKLOG` | 공식 링크·요청서·증거 source catalog | 미배정 | 1~2주 | 출처·확인일·UNKNOWN·깨진 링크 처리 |
| [ ] | `KA-PRI-P07` | `HIGH_RISK` | 수신 거부·동의 철회 보조 | 보안 담당+사용자 | 1~3주 | 최종 사용자 승인·접수 증거 |
| [ ] | `KA-PRI-P08` | `HIGH_RISK` | OAuth 연결 조회·해제 deep link | 보안 담당+사용자 | 2~5주 | 최소 scope·외부 계정 삭제와 분리 |
| [ ] | `KA-PRI-P09` | `HIGH_RISK` | 회원탈퇴·개인정보/게시물 삭제 사건 | 보안 담당+외부 전문가 | 3~8주 | 접수/일부/거절/완료/확인 불가 구분 |
| [ ] | `KA-PRI-P10` | `BACKLOG` | 미처리·재노출 알림 | 미배정 | 2~4주 | secret-free 알림·quiet hours·재확인 |
| [ ] | `KA-PRI-P11` | `HIGH_RISK_LEGAL` | 검색 제외·불법 콘텐츠·사망자 계정 인계 | 사용자+외부 전문가 | 6~12주+ | 적법한 위임·권리자·관할·이의제기 절차 |
| [ ] | `KA-PRI-P12` | `FUTURE_BUSINESS` | 사람 지원형 Privacy Care | 사용자+외부 전문가 | 3~6개월+ | 최소 접근·교육·SLA·보험·법률 검토 |

### F. Backend·DB·인증·동기화

| 완료 | ID | 상태·준비도 | 작업 | 담당 | 예상 | 완료 증거 |
|---|---|---|---|---|---:|---|
| [ ] | `KA-F01` | `HIGH_RISK_DESIGN` | opaque sync wire·device roster | 보안 담당 | 4~8주 | 서명·replay·rollback·tenant tests |
| [ ] | `KA-F02` | `BACKLOG` | Spring Boot API skeleton·OpenAPI | 미배정 | 2~4주 | local-only 합성 endpoint tests |
| [ ] | `KA-F03` | `HIGH_RISK` | PostgreSQL schema·migration·tenant isolation | 보안 담당 | 3~6주 | migration/rollback/isolation/property tests |
| [ ] | `KA-F04` | `HIGH_RISK` | Google OIDC·Passkey 서버 세션 | 보안 담당+사용자 | 3~6주 | state/nonce/PKCE/WebAuthn·session revoke tests |
| [ ] | `KA-F05` | `BACKLOG_DECISION` | Kakao/Naver 로그인 채택 범위 | 사용자+AI | 2~5일 | 수요·scope·심사·개인정보 비교 승인 |

### G. Android·생체인증

| 완료 | ID | 상태·준비도 | 작업 | 담당 | 예상 | 완료 증거 |
|---|---|---|---|---|---:|---|
| [ ] | `KA-G01` | `BACKLOG` | Kotlin/Compose 앱 shell·Rust binding | 미배정 | 3~6주 | emulator/device build·교차 vector |
| [ ] | `KA-G02` | `HIGH_RISK` | Android SQLite·Keystore device key | 보안 담당 | 3~6주 | hardware-backed 여부·invalidation tests |
| [ ] | `KA-G03` | `HIGH_RISK` | BiometricPrompt step-up | 보안 담당 | 2~4주 | 생체 변경·실패·fallback·overlay tests |
| [ ] | `KA-G04` | `BACKLOG` | 오프라인·잠금·복구·기기 해제 화면 | 미배정 | 3~6주 | 실기기 lifecycle·분실 훈련 |

### H. 디자인·수익화·배포·법률·출시

| 완료 | ID | 상태·준비도 | 작업 | 담당 | 예상 | 완료 증거 |
|---|---|---|---|---|---:|---|
| [ ] | `KA-H01` | `BACKLOG` | ADHD 친화 디자인 시스템·접근성 | 디자인 AI+사용자 | 2~4주 | 키보드·contrast·screen reader·사용성 검사 |
| [ ] | `KA-H02` | `BACKLOG_DECISION` | 최종 이름·상표·도메인 | 사용자 | 외부 일정 | 이름·대체명·소유 도메인 |
| [ ] | `KA-H03` | `BACKLOG` | Free/Pro 정책·저장/기기/기능 한도 | 사용자+AI | 1~2주 | 보안을 유료벽으로 막지 않는 요금표 |
| [ ] | `KA-H04` | `BACKLOG` | 결제 sandbox·entitlement·webhook | AI+사용자 | 3~6주 | 중복/취소/환불/restore 합성 E2E |
| [ ] | `KA-H05` | `BACKLOG` | Cloud·IAM·도메인·DNS·TLS·email | 사용자+AI | 3~8주 | staging 분리·MFA·최소 권한·예산 알림 |
| [ ] | `KA-H06` | `BACKLOG` | 개인정보·약관·retention·삭제 정책 | 사용자+외부 전문가 | 4~10주+ | 실제 data map과 공개 문서 일치 |
| [ ] | `KA-H07` | `BACKLOG` | 모니터링·redaction·backup/DR·incident | AI+사용자 | 4~8주 | canary 0·restore/incident drill |
| [ ] | `KA-H08` | `EXTERNAL_GATE` | 독립 암호 감사·pentest·Privacy 법률 검토 | 외부 전문가 | 외부 일정 | Critical/High 수정·재검토 |
| [ ] | `KA-H09` | `BLOCKED_BY_ALL_GATES` | 제한 실제-Secret/Privacy beta | 사용자+AI | 6~10개월+ 누적 | 모든 gate·지원·rollback·동의 |
| [ ] | `KA-H10` | `BLOCKED_BY_ALL_GATES` | 공개 Web+Android self-service | 사용자+AI | 7~12개월+ 누적 | 운영·법률·스토어·감사·복구 승인 |

---

## 6. Task 작업 블록 템플릿

각 작업은 아래 블록 하나를 갖는다. integration owner가 worker의 고유 보고를 검증해 갱신한다.

~~~markdown
### [ ] TASK-ID — 한 문장 제목

- task_state: `TODO`
- readiness: `UNASSESSED`
- collab_stage: `RESERVED`
- completion_target: `VERIFIED`
- owner: `UNASSIGNED`
- integration owner: `UNASSIGNED`
- worktree: `UNSET`
- branch: `UNSET`
- base SHA: `UNSET`
- allowed paths: `UNSET`
- predecessors: `NONE`
- risk: `LOW | MEDIUM | HIGH-RISK`

Checklist:

- [ ] 읽기 전용 preflight 완료
- [ ] 파일 쓰기 범위 승인
- [ ] 산출물 완료
- [ ] 필수 검사 완료
- [ ] 독립 리뷰 완료
- [ ] commit 승인 및 commit
- [ ] push 승인 및 원격 SHA 일치
- [ ] Draft PR 승인 및 생성
- [ ] baseline 통합
- [ ] 최종 체크박스·현재 스냅샷 갱신

Evidence:

```text
final HEAD:
changed files:
checks:
not verified:
real Secret used: NO
commit:
push:
PR:
merge:
next action:
```
~~~

### 예시 — 완료를 과장하지 않는 방법

```text
산출물: PASS (LOCAL, abcdef123456, 지정 파일 2개)
단위 테스트: PASS (LOCAL, abcdef123456, npm test ..., 36/36)
전체 WASM: BLOCKED (LOCAL, abcdef123456, Windows policy 4551)
원격 CI: NOT_RUN (REMOTE_CI, push 승인 없음)
독립 리뷰: UNKNOWN
stage: LOCAL_DONE
최종 task checkbox: [ ]
```

### Append-only 증거 Ledger

검사 결과는 기존 행을 덮어쓰지 않고 아래 형식으로 추가한다. `#58` evidence-label 원본은
현재 baseline 파일이 아니라 로컬 후보
`codex/firstvibe-collab-58-evidence-labels@6803eb5c4c5d002f247daae49b8b4cd024e3ef80`
에만 있으므로, 이 문서가 핵심 상태 규칙을 자체 포함한다.

| Evidence ID | Task | 결과 | 출처 | exact SHA | 명령·검토 범위 | exit/finding | 시각 | 비고 |
|---|---|---|---|---|---|---:|---|---|
| `E-20260924-DOC-01` | `KA-A03` | `UNKNOWN` | `LOCAL` | 문서가 uncommitted라 SHA 없음 | 이 문서 최종 검증 대기 | N/A | 2026-09-24 | 검증 후 새 행 추가 |
| `E-20260924-DOC-02` | `KA-A03` | `UNKNOWN` | `LOCAL` | 문서가 uncommitted라 Git SHA 없음 | 링크·구조·Secret 형태·diff 검사와 독립 읽기 검토 관찰 | exit 0 / P1·P2 0 | 2026-09-24 | 로컬 관찰은 성공했지만 exact Git SHA가 없어 authoritative `PASS`로 승격하지 않음 |
| `E-20260924-C58-GIT-01` | `KA-C58-01` | `PASS` | `LOCAL` | `6803eb5c4c5d002f247daae49b8b4cd024e3ef80` | baseline 부모·1파일 diff·공백·상대 링크·필수 용어·고신뢰 Secret 형태 | exit 0 / link 1 / Secret 형태 0 | 2026-09-24 | 현재 local ref 기준; remote-tracking ref는 아직 baseline |
| `E-20260924-C58-REVIEW-01` | `KA-C58-01` | `FAIL` | `INDEPENDENT_REVIEW` | `6803eb5c4c5d002f247daae49b8b4cd024e3ef80` | PASS/FAIL·CI 단계·보고 형식·합성 REMOTE_CI 화면 문구 일관성 | 중요 수정점 4개 | 2026-09-24 | review deliverable은 완료; 후보는 `VERIFIED`·통합 승인 아님 |
| `E-20260925-C58-FIX-GIT-01` | `KA-C58-FIX-01` | `PASS` | `LOCAL` | `090c7313a4ec0b6bd181d9889d7282f1ae7c1caf` | base `6803eb5` 계보·허용 문서 1개·diff 공백·UTF-8/fence·필수 의미 문구·저장소 Secret scan | exit 0 / Secret scan passed / `REAL_SECRET_GATE=CLOSED` | 2026-09-25 | runtime test는 docs-only라 NOT_RUN |
| `E-20260925-C58-FIX-REVIEW-01` | `KA-C58-FIX-01` | `PASS` | `INDEPENDENT_REVIEW` | `090c7313a4ec0b6bd181d9889d7282f1ae7c1caf` | PASS/FAIL·Low/Medium·REMOTE_CI 단계·보고 예시·합성 화면 문구 일관성 | P1 0 / P2 0 / P3 0 | 2026-09-25 | 최초 재검토 P2 1/P3 1을 수정 후 finding 0; 통합 승인은 아님 |
| `E-20260925-C58-FIX-PUSH-01` | `KA-C58-FIX-01` | `PASS` | `REMOTE_REF` | `090c7313a4ec0b6bd181d9889d7282f1ae7c1caf` | 비강제 push 후 local HEAD와 upstream 비교 | SHA 일치 / clean | 2026-09-25 | 전용 원격 branch 백업; PR·merge·main·remote CI 없음 |
| `E-20260924-C30-GIT-01` | `KA-C30-01` | `PASS` | `LOCAL` | `2390b55684f5f46c28bc6870b61915b949dd494f` | baseline 직접 부모·2파일 diff·공백·계보·고신뢰 Secret 형태 | exit 0 / 377줄 / Secret 형태 0 | 2026-09-24 | local task ref만 후보 포함; remote-tracking ref는 baseline |
| `E-20260924-C30-REVIEW-01` | `KA-C30-01` | `FAIL` | `INDEPENDENT_REVIEW` | `2390b55684f5f46c28bc6870b61915b949dd494f` | untrusted runtime shape·링크 증거 날짜·UI 연결 경계 | P1 0 / P2 1 / P3 1 | 2026-09-24 | 실행 검증은 계약상 `NOT_RUN`; 후보 통합 비권장 |
| `E-20260924-C30-FIX-GIT-01` | `KA-C30-FIX-01` | `PASS` | `LOCAL` | `534b37c18582ea120e2d9303cfe73635ad16dcf3` | base `2390b55` 계보·허용 2파일·diff 공백·저장소 Secret scan | exit 0 / Secret scan passed | 2026-09-24 | local 2-commit fix tip; push·PR·merge 안 함 |
| `E-20260924-C30-FIX-FOCUSED-01` | `KA-C30-FIX-01` | `PASS` | `LOCAL` | `534b37c18582ea120e2d9303cfe73635ad16dcf3` | provider metadata focused Vitest | 1 file / 87 tests passed | 2026-09-24 | 동일 package-lock의 기존 node_modules를 임시 junction으로 연결 후 제거 |
| `E-20260924-C30-FIX-REVIEW-01` | `KA-C30-FIX-01` | `PASS` | `INDEPENDENT_REVIEW` | `534b37c18582ea120e2d9303cfe73635ad16dcf3` | malformed JSON-compatible 입력·UTC 날짜·exact own-key allowlist·허용 범위 | P1 0 / P2 0 | 2026-09-24 | 의미 검토 통과; 전체 회귀 통과나 통합 승인은 아님 |
| `E-20260924-C30-FIX-REGRESSION-01` | `KA-C30-FIX-01` | `BLOCKED` | `LOCAL` | `534b37c18582ea120e2d9303cfe73635ad16dcf3` | typecheck·전체 web test·production build | typecheck/build exit 1; 40/47 files·1509 tests pass, 7 WASM suites load fail | 2026-09-24 | `src/generated/vault-wasm-demo` 부재; 생성·재검증 전 `VERIFIED` 금지 |
| `E-20260924-C30-FIX-PUSH-01` | `KA-C30-FIX-01` | `PASS` | `REMOTE_REF` | `534b37c18582ea120e2d9303cfe73635ad16dcf3` | 비강제 push 후 `git ls-remote`와 local/upstream divergence | remote SHA 일치 / 0·0 | 2026-09-24 | 전용 원격 branch 백업 완료; PR·merge·통합·CI PASS 아님 |
| `E-20260924-C30-FIX-WASM-01` | `KA-C30-FIX-01` | `PASS` | `LOCAL` | `534b37c18582ea120e2d9303cfe73635ad16dcf3` | 고정 Rust 1.95.0·wasm-bindgen 0.2.128·`build-wasm.ps1 -SyntheticDemo -Release`·`node scripts/test-wasm.mjs --demo` | exit 0 / `WASM_BUILD_OK` / actual runtime 1735 checks | 2026-09-24 | ignore된 합성 Release 산출물; 실제 Secret 없음 |
| `E-20260924-C30-FIX-REGRESSION-02` | `KA-C30-FIX-01` | `PASS` | `LOCAL` | `534b37c18582ea120e2d9303cfe73635ad16dcf3` | Release WASM 기준 typecheck·전체 web test·production build·저장소 Secret scan | exit 0 / 47 files·1554 tests / build exit 0 / Secret scan passed | 2026-09-24 | debug WASM 실행은 timeout 10건으로 exit 1; CI와 같은 Release 기준 재실행 PASS, remote CI는 UNKNOWN |
| `E-20260924-DOC-PUSH-01` | `KA-A03` | `PASS` | `REMOTE_REF` | `eb0127eb10c6e123866320a89e02358e0ce8192e` | C30 회귀 기록 직전 범용 작업판+서비스 체크리스트 snapshot 커밋·비강제 push·원격 SHA 확인 | remote SHA 일치 / 0·0 | 2026-09-24 | `codex/firstvibe-luna-release-support`; PR·merge 안 함 |
| `E-20260924-DOC-04` | `KA-A03` | `PASS` | `INDEPENDENT_REVIEW` | base `eb0127eb10c6e123866320a89e02358e0ce8192e` + 당시 uncommitted 2-file diff | C30 상태·checkbox·고유 evidence ID·과거 BLOCKED 보존·권한 문구 | P1 0 / P2 0 / P3 0; links·UTF-8·공백·fence·diff checks pass; 고신뢰 Secret 형태 0 | 2026-09-24 | 검토 당시 갱신은 아직 commit·push 전이었음; 다른 worktree scanner 교차 실행은 setup 실패로 별도 제한 기록 |
| `E-20260924-C93-GIT-01` | `KA-C93-01` | `PASS` | `LOCAL` | `f1a98b5acc0d24e591dba87ca60ae3f25f88344f` | baseline 직접 부모·2파일 diff·PowerShell parse·계보·고신뢰 Secret 형태 | exit 0 / parser error 0 / Secret 형태 0 | 2026-09-24 | local task ref만 후보 포함; remote-tracking ref는 baseline |
| `E-20260924-C93-REVIEW-01` | `KA-C93-01` | `FAIL` | `INDEPENDENT_REVIEW` | `f1a98b5acc0d24e591dba87ca60ae3f25f88344f` | snapshot·출력 경로·strict schema·resource bound·CI·Secret gate 경계 | P1 2 / P2 4 / P3 1 | 2026-09-24 | 실행 검증은 계약상 `NOT_RUN`; 무결성 목록 도구로만 한정 |
| `E-20260925-C93-FIX-LOCAL-01` | `KA-C93-FIX-01` | `PASS` | `LOCAL` | `594824ddb9a55bd736d8dd93fd26f60f7ca58a2c` | base `f1a98b5` 계보·허용 2파일·PowerShell parse·PS5.1 manifest 회귀·scanner 회귀·저장소 Secret scan·diff 검사 | parse 2/2·manifest 10/10·scanner 102/102·exit 0·`REAL_SECRET_GATE=CLOSED` | 2026-09-25 | 실제 Secret 없음; manifest는 Secret scanner 대체가 아님 |
| `E-20260925-C93-FIX-REVIEW-01` | `KA-C93-FIX-01` | `PASS` | `INDEPENDENT_REVIEW` | `594824ddb9a55bd736d8dd93fd26f60f7ca58a2c` | same-handle snapshot·2-pass tree·strict JSON·resource bound·temp/output race·cleanup identity·cooperative timeout 문구 | reviewer 2명 모두 P1 0 / P2 0 / P3 0 | 2026-09-25 | 최초 P1/P2 공격 재현 후 exact-byte pre/post publish 검사와 불확실 temp 보존으로 수정 |
| `E-20260925-C93-FIX-PUSH-01` | `KA-C93-FIX-01` | `PASS` | `REMOTE_REF` | `594824ddb9a55bd736d8dd93fd26f60f7ca58a2c` | 비강제 push 후 local HEAD와 upstream 비교 | SHA 일치 / clean | 2026-09-25 | 전용 원격 branch 백업; PR·merge·main·remote CI 없음 |
| `E-20260925-C93-FIX-PS7-01` | `KA-C93-CI-01` | `BLOCKED` | `LOCAL_ENV` | `594824ddb9a55bd736d8dd93fd26f60f7ca58a2c` | `pwsh.exe --version`과 PS7 재실행 시도 | Windows access block / NOT_RUN | 2026-09-25 | 보안 정책을 우회하지 않음; PS5.1 실제 실행은 PASS |
| `E-20260924-DOC-03` | `KA-A03` | `UNKNOWN` | `INDEPENDENT_REVIEW` | 문서가 uncommitted라 Git SHA 없음 | C30·C93 checkbox·후보 상태·evidence ID·SHA·finding 수·권한 문구 일관성 | P1 0 / P2 0 | 2026-09-24 | 로컬 작업판 갱신은 승인 가능; authoritative `PASS`는 commit 후 재검증 필요 |

---

## 7. 세션 종료·인계 프로토콜

작업을 끝냈거나 중단할 때 반드시 아래 순서로 기록한다.

1. 새 파일·수정 파일을 정확히 나열한다.
2. 실행한 명령과 exit code를 적는다.
3. 실행하지 않은 검사를 적는다.
4. 실제 Secret 사용 여부를 `NO`로 적는다.
5. commit·push·PR·merge 상태를 각각 적는다.
6. 현재 blocker와 다음 한 단계만 적는다.
7. 고유 완료 보고를 제출하고 integration owner가 task block·세션 로그를 갱신한다.
8. 다른 AI의 작업이나 사용자의 기존 dirty 변경을 정리하지 않는다.

### 새 세션에 전달할 최소 인계 문구

```text
KeyAtlas 공용 작업판을 먼저 읽으세요:
docs/handoff/KEYATLAS_UNIVERSAL_AI_HANDOFF_AND_TODO_2026-09-24.md

작업 ID: [ID]
현재 stage: [STAGE]
worktree / branch / HEAD: [EXACT VALUES]
허용 파일: [PATHS]
완료된 것: [EVIDENCE]
미검증: [UNKNOWN/NOT_RUN/BLOCKED]
다음 한 단계: [ONE ACTION]
REAL_SECRET_GATE=CLOSED
commit/push/PR/merge 권한은 각각 다시 확인하세요.
```

---

## 8. 세션 작업 로그 — integration owner만 시간순으로 추가

### 2026-09-24 — 범용 작업판 생성

- agent/session: Codex root / current local task
- 문서 worktree: `keyatlas-luna-release-support`
- 변경: 이 범용 AI 인계서·공용 TODO 작업판 신규 작성
- 근거: 기존 전체 설계 문서, `d9c6666` 협업 지도, #30/#58/#93 로컬 후보 상태
- 제품 코드 변경: 없음
- 외부 계정·서비스 변경: 없음
- 실제 Secret 사용: NO
- 문서 상대 링크 검사: 1개 파일, exit 0
- 문서 구조 검사: trailing whitespace 0, fence 균형, table pipe 일치, exit 0
- 고신뢰 Secret 형태 검사: 0건, exit 0
- `git diff --check`: exit 0
- 독립 읽기 검토: P1 0건; 지적된 READY 계약·공용판 충돌·SHA·상태 축 문제 반영
- 증거 판정: 위 결과는 uncommitted worktree의 unstamped local observation이며 authoritative
  `PASS`는 아님; commit 승인 후 exact Git SHA에서 재검증 필요
- commit: 하지 않음
- push: 하지 않음
- PR: 만들지 않음
- merge: 하지 않음
- task lock: 검증 완료 후 해제
- 다음 안전 단계: 사용자가 문서를 확인한 뒤 별도 승인 아래 commit/push 여부 결정

### 2026-09-24 — `KA-C58-01` 읽기 전용 검토 완료

- agent/session: Codex root integration owner + 독립 읽기 전용 검토 2건
- canonical worktree: `keyatlas-collab-001-100`
- baseline: `codex/firstvibe-collab-001-100-baseline@d9c66661db7d7b66f6453e94e467c424107cba66`
- reviewed source: `codex/firstvibe-collab-58-evidence-labels@6803eb5c4c5d002f247daae49b8b4cd024e3ef80`
- 계보: 대상 commit의 유일한 부모가 baseline, ancestry 검사 exit 0
- 변경 범위: `docs/handoff/KEYATLAS_EVIDENCE_STATE_LABELS.md` 1개 추가, 120줄
- 기계 검사: `git diff --check` exit 0, 상대 링크 1개 target 존재, 필수 상태 용어 누락 0,
  고신뢰 Secret 형태 0
- 독립 의미 검토: 수정점 4개 — PASS/FAIL 기준, REMOTE_CI 차단 단계, 보고 예시 형식,
  합성 fixture+REMOTE_CI 사용자 문구
- task 판정: `READ_ONLY_REPORT_DONE`
- 후보 판정: `NEEDS_REVISION_BEFORE_INTEGRATION`
- 원격 상태: local branch만 후보 commit 포함; local remote-tracking ref는 baseline
- 제품 코드 변경: 없음
- 실제 Secret 사용: NO
- commit/push/PR/merge: 하지 않음
- 다음 안전 단계: `KA-C58-FIX-01` 계약을 만든 뒤 4개 문구를 보완하고 새 exact SHA에서 재검토

### 2026-09-24 20:54 KST — `KA-C30-01` 읽기 전용 검토 완료

- agent/session: Codex root integration owner + 독립 읽기 전용 reviewer
- canonical worktree: `keyatlas-collab-001-100`, clean baseline `d9c66661db7d7b66f6453e94e467c424107cba66`
- reviewed source: `codex/firstvibe-collab-30-provider-metadata@2390b55684f5f46c28bc6870b61915b949dd494f`
- 계보·범위: baseline이 직접 부모, ancestry exit 0, TypeScript와 test 2개·377줄 추가, `git diff --check` exit 0
- 독립 검토: P1 0, P2 1, P3 1 — malformed runtime input에서 fail-closed issue report 대신 예외 가능,
  미래 날짜·HTTP 200 증거 재현성 보완 필요
- UI·런타임 연결: 자기 test import 외 참조 없음; 사용자 기능으로 아직 노출되지 않음
- task 판정: `READ_ONLY_REPORT_DONE`; 후보 판정: `NEEDS_REVISION_BEFORE_INTEGRATION`
- 실행 검증: 계약상 `NOT_RUN`; commit message의 test 통과 주장을 독립 재현하지 않음
- 실제 Secret 사용: NO; 변경 diff의 고신뢰 Secret 형태 0
- commit/push/PR/merge: 하지 않음
- 다음 안전 단계: `KA-C30-FIX-01` 계약 후 unknown/plain-record/nested shape guard와 회귀를 보완

### 2026-09-24 20:54 KST — `KA-C93-01` 읽기 전용 검토 완료

- agent/session: Codex root integration owner + 독립 PowerShell·보안 reviewer
- canonical worktree: `keyatlas-collab-001-100`, clean baseline `d9c66661db7d7b66f6453e94e467c424107cba66`
- reviewed source: `codex/firstvibe-collab-93-release-artifact-manifest@f1a98b5acc0d24e591dba87ca60ae3f25f88344f`
- 계보·범위: baseline이 직접 부모, ancestry exit 0, script와 test 2개·439줄 추가, `git diff --check` exit 0,
  PowerShell parser error 0
- 독립 검토: P1 2, P2 4, P3 1 — stable snapshot 부재, 출력 경로 reparse·덮어쓰기 race,
  느슨한 JSON schema, resource bound, CI 미연결, Secret gate 역할 혼동, binary fixture 공백
- task 판정: `READ_ONLY_REPORT_DONE`; 후보 판정: `NEEDS_REVISION_BEFORE_INTEGRATION`
- 실행 검증: 계약상 `NOT_RUN`; CI 참조 검색은 없음, Windows 전용 junction fixture 존재
- 실제 Secret 사용: NO; 변경 diff의 고신뢰 Secret 형태 0
- commit/push/PR/merge: 하지 않음
- 다음 안전 단계: `KA-C93-FIX-01` 계약 후 integrity 도구의 경계를 명시하고 race·schema·CI를 보완

### 2026-09-24 20:54 KST — C30·C93 작업판 갱신 독립 검토

- 범위: 체크박스 의미, 후보 상태, evidence ID·exact SHA·finding 수, 후속 task, 권한 문구
- 결과: P1 0, P2 0; `READ_ONLY_REPORT_DONE`과 `NEEDS_REVISION_BEFORE_INTEGRATION`이 분리됨
- 검증 한계: 작업판은 아직 uncommitted라 authoritative exact-SHA `PASS`가 아님
- 실제 Secret 사용: NO
- commit/push/PR/merge: 하지 않음

### 2026-09-24 23:00 KST — `KA-C30-FIX-01` 구현·보안 보완 검증

- worktree/branch: `keyatlas-c30-fix-01` / `codex/firstvibe-collab-30-provider-metadata-fix-01`
- implementation base: `2390b55684f5f46c28bc6870b61915b949dd494f`
- Claude 구현 commit: `a8e86f3bbab39cb3f0a71e6bb7af125307cebb4a`
- Codex exact-own-key 보완 commit: `534b37c18582ea120e2d9303cfe73635ad16dcf3`
- 변경 범위: provider metadata source·test 2파일만; `git diff --check` exit 0
- 구현: top-level/nested malformed JSON-compatible 입력 fail-closed, UTC 미래 날짜 거부,
  `Reflect.ownKeys` 기반 symbol·non-enumerable 추가 필드 거부
- focused Vitest: exit 0, 1 file·87 tests passed
- Secret scan: exit 0, `SECRET_SCAN_PASSED`, `REAL_SECRET_GATE=CLOSED`
- 독립 재검토: P1 0, P2 0
- typecheck/build: exit 1, generated demo WASM import 8곳 부재
- 전체 web test: exit 1, 40 files·1509 tests passed; generated demo WASM을 요구하는 7 suite가 0-test load fail
- 의존성: 설치하지 않음; 같은 SHA-256 package-lock을 가진 기존 node_modules를 temporary junction으로만 연결하고 제거
- task 판정: `LOCAL_COMMIT_REVIEWED_REGRESSION_BLOCKED`; 최종 checkbox는 `[ ]`
- 실제 Secret 사용: NO
- commit: local 2개; push/PR/merge: 하지 않음
- 다음 안전 단계: exact source에서 synthetic-demo WASM을 생성하거나 검증된 exact-match 산출물을 준비한 뒤
  typecheck·전체 test·build를 재실행하고 새 증거로 판정

### 2026-09-24 — C30 보완·직전 범용 작업판 snapshot 원격 백업

- C30 원격 branch: `codex/firstvibe-collab-30-provider-metadata-fix-01@534b37c18582ea120e2d9303cfe73635ad16dcf3`
- 문서 원격 branch: `codex/firstvibe-luna-release-support@eb0127eb10c6e123866320a89e02358e0ce8192e`
- push 방식: 양쪽 모두 비강제; push 후 `git ls-remote` exact SHA 일치, local/upstream `0 0`
- 실제 Secret 사용: NO
- PR/merge/main 변경/배포: 하지 않음
- 당시 다음 안전 단계: C30 exact generated WASM 회귀 또는 `KA-C58-FIX-01` 계약 실행

### 2026-09-24 23:41 KST — `KA-C30-FIX-01` Release WASM 전체 로컬 회귀

- exact source: `codex/firstvibe-collab-30-provider-metadata-fix-01@534b37c18582ea120e2d9303cfe73635ad16dcf3`
- 합성 debug WASM 빌드: exit 0, `WASM_BUILD_OK`; 전체 test에서 암호화 연산이 timeout 10건으로 exit 1
- CI와 같은 합성 Release WASM 빌드: exit 0, `WASM_BUILD_OK`
- 합성 Release WASM actual runtime smoke: exit 0, 1735 checks PASS
- Release 기준 typecheck: exit 0
- Release 기준 전체 web test: 47/47 files, 1554/1554 tests PASS, exit 0
- production web build: exit 0
- 저장소 Secret scan: exit 0, `SECRET_SCAN_PASSED`, `REAL_SECRET_GATE=CLOSED`
- Git 상태·원격 일치: tracked clean, local HEAD=upstream=`534b37c`
- 임시 `node_modules` junction: exact package-lock SHA 일치 확인 후 사용하고 안전 제거 완료
- 판정: 로컬 회귀 차단은 해소했지만 PR·통합·remote CI가 없으므로 전체 task checkbox는 `[ ]` 유지
- 다음 안전 단계: `KA-C58-FIX-01`의 문서 의미 수정 4건을 전용 worktree에서 구현·재검토

### 2026-09-25 00:07 KST — `KA-C58-FIX-01` 구현·독립 재검토·원격 백업

- branch: `codex/firstvibe-collab-58-evidence-labels-fix-01`
- exact commit: `090c7313a4ec0b6bd181d9889d7282f1ae7c1caf`
- 변경 범위: `docs/handoff/KEYATLAS_EVIDENCE_STATE_LABELS.md` 1개만
- 의미 보완: 엄격한 PASS/FAIL 기준, REMOTE_CI 단계 상한, 4필드 보고 예시, 합성 fixture 화면 문구
- 기계 검사: diff/범위/UTF-8/fence/필수 문구/고신뢰 Secret 형태/저장소 Secret scan 모두 PASS
- 독립 리뷰: 최초 P2 1/P3 1 수정 후 P1/P2/P3 0, 네 가지 계약 DoD 충족
- Git: commit 후 비강제 push, local HEAD=upstream=`090c731`, working tree clean
- 실제 Secret 사용: NO, `REAL_SECRET_GATE=CLOSED`
- PR: 생성하지 않음; merge/main: 미실행; remote CI: `BLOCKED/UNKNOWN`이며 실행 PASS 증거 없음
- checkbox 판정: completion target=`LOCAL_DONE` 충족 및 원격 백업 완료로 `KA-C58-FIX-01`만 `[x]`
- 다음 안전 단계: `KA-C93-FIX-01` 계약 작성 또는 canonical exact SHA 전체 회귀

### 2026-09-25 01:00 KST — `KA-C93-FIX-01` 보안 보완·독립 재검토·원격 백업

- worktree/branch: `keyatlas-c93-fix-01` / `codex/firstvibe-collab-93-release-artifact-manifest-fix-01`
- implementation base: `f1a98b5acc0d24e591dba87ca60ae3f25f88344f`
- exact commit/upstream: `594824ddb9a55bd736d8dd93fd26f60f7ca58a2c`
- 변경 범위: `scripts/new-release-artifact-manifest.ps1`, `tests/verification/new-release-artifact-manifest.Tests.ps1` 두 파일만
- 보완: 한 read handle의 size+SHA-256, 두 번의 tree 관찰, strict canonical JSON, 수량·크기·깊이·시간 한도,
  reparse 거부, 비덮어쓰기 move, 이동 전·후 canonical exact-byte 검사, 불확실 temp 비삭제
- 공격 재현: 최초 같은 길이 temp 교체에서 잘못된 success와 path-guess cleanup P1/P2를 확인한 뒤 회귀로 차단
- 검사: PowerShell parse 2/2, PS5.1 manifest 10/10, scanner 102/102, 저장소 Secret scan, `git diff --check` 모두 exit 0
- 독립 리뷰: reviewer 2명 모두 최종 P1 0 / P2 0 / P3 0
- 환경 제한: `pwsh.exe`는 Windows access block으로 PS7 재실행 `NOT_RUN`; 정책 우회 없음
- Git: 비강제 push 후 local HEAD=upstream, working tree clean
- 실제 Secret 사용: NO, `REAL_SECRET_GATE=CLOSED`
- PR: 생성하지 않음; merge/main: 미실행; remote CI: `BLOCKED/UNKNOWN`이며 실행 PASS 증거 없음
- checkbox 판정: completion target=`LOCAL_SECURITY_FIX_DONE` 충족으로 `KA-C93-FIX-01` `[x]`; CI 연결은 `KA-C93-CI-01` `[ ]`
- 다음 안전 단계: canonical exact SHA 전체 회귀 또는 C93 workflow 연결 계약 작성

새 세션은 고유 완료 보고를 제출한다. integration owner만 보고를 확인해 이 아래에 새 항목을
추가한다. 기존 로그를 덮어쓰거나 과거 증거를 현재 SHA의 증거로 바꾸지 않는다.

---

## 9. 사용자 개입이 필요한 항목

- [ ] 최종 제품명·상표·도메인
- [ ] 기본 3개/선택 최대 5개 복구 수단 정책
- [ ] Google/Kakao/Naver·Cloud·DB·email·결제·Play 계정과 MFA
- [ ] GitHub Actions 계정/과금 차단 확인과 exact-SHA 재실행 승인
- [ ] Free/Pro 가격·무료 한도·환불·지원 범위
- [ ] 서비스 국가·사업 주체·법률·개인정보 처리 범위
- [ ] 독립 보안 감사·침투 테스트·법률 검토 업체와 예산
- [ ] commit·push·PR·main merge·배포·실제 Secret beta의 단계별 승인

사용자는 API 키 원문, master password, recovery key, 카드 정보, production `.env`, 신분증을
AI 채팅이나 GitHub에 붙이지 않는다. 실제 연동 시 공급자의 보안 입력창이나 승인된 Secret
Manager를 사용한다.

---

## 10. 마지막 안전 판정

```text
현재 제품 단계: 합성 alpha / security-core prototype
canonical 협업 baseline: d9c6666
1~100 task branches: RESERVED가 기본
9월 24~25일 후보: #30 `534b37c`는 Release WASM 전체 로컬 회귀 PASS; #58 `090c731`은 문서 DoD PASS; #93 `594824d`는 PS5.1·scanner·Secret scan·독립 리뷰 PASS; 모두 전용 원격 branch만 있고 PR·통합 미완료
원격 CI: BLOCKED/UNKNOWN
main 통합: 미완료
실제 Secret 입력: 금지
Identity Map: 관계 코어 일부 / 제품 UX·발견 미완료
Consent Center: 미구현
Privacy Cleanup Center: 미구현
Backend/API/DB: 미구현
Android/생체 인증: 미구현
결제·공개 배포·법률·외부 감사: 미완료
```

이 파일의 체크박스는 진행 상황을 보여 주는 도구이지 보안 인증서가 아니다. 가장 빠른
경로는 완료하지 않은 일을 `[x]`로 만드는 것이 아니라, **작은 작업 하나 → exact SHA 증거
→ 독립 검토 → 승인된 통합**을 반복하는 것이다.
