# KeyAtlas 검증 증거 단계 상태 표현 가이드

> 협업 작업: #58 `codex/firstvibe-collab-58-evidence-labels`
> 적용 범위: 협업 브랜치 보고, `docs/verification/**` 기록, PR 본문, 합성 데모 안의 상태 문구
> 실제 Secret 허용 상태: `REAL_SECRET_GATE=CLOSED`

이 문서는 "무엇을 실제로 확인했는가"를 한 단어로 과장하지 않고 적는 규칙이다.
작업 진행 단계, 개별 검사 결과, 증거의 출처는 서로 다른 축이다. 하나의 라벨로 섞어
쓰지 않는다.

## 1. 세 개의 축

```text
작업 단계 (브랜치가 어디까지 왔나)
  RESERVED → PREFLIGHT → IMPLEMENTING → PUSHED → DRAFT_PR → VERIFIED → MERGED

검사 결과 (한 명령·한 검토가 무엇을 말했나)
  PASS | FAIL | BLOCKED | NOT_RUN | UNKNOWN

증거 출처 (그 결과를 어디서 얻었나)
  LOCAL | REMOTE_CI | INDEPENDENT_REVIEW | HUMAN_CHECK | SIMULATION
```

- 작업 단계의 정의는 [`KEYATLAS_COLLAB_TASKS_001_100.md`](KEYATLAS_COLLAB_TASKS_001_100.md)
  7절이 source of truth다. 이 문서는 그 단계에 필요한 증거 조건만 덧붙인다.
- 검사 결과는 반드시 증거 출처와 짝을 이룬다. `PASS`만 단독으로 쓰지 않는다.

## 2. 검사 결과 라벨

| 라벨 | 뜻 | 쓸 수 있는 조건 |
|---|---|---|
| `PASS` | 선언된 성공 기준을 모두 충족했다 | exact SHA, 검사 범위(scope)와 불변조건(invariants), `Critical=0`, `High=0`, 필수 항목 `UNKNOWN=0`이 모두 기록되고 충족됨 |
| `FAIL` | 선언된 실패 기준을 충족했다 | exact SHA, 검사 범위, 충족된 실패 기준과 명령·exit code 또는 finding이 기록됨. 원인이 확정되지 않았다는 이유만으로 `FAIL`을 쓰지 않음 |
| `BLOCKED` | 전제 조건이 없어 실행하지 못했다 | 막힌 원인(선행 작업, 권한, 결제, 도구 부재 등)을 한 줄로 기록 |
| `NOT_RUN` | 실행할 수 있었지만 하지 않았다 | 범위 밖이거나 비용 때문에 생략한 이유를 기록 |
| `UNKNOWN` | 증거가 없거나 서로 모순된다 | 기본값이다. 증거가 비어 있으면 자동으로 이 값이다 |

규칙:

1. 증거가 없으면 `PASS`가 아니라 `UNKNOWN`이다.
2. 원격 job이 시작조차 되지 않은 경우(예: 결제·지출 한도로 runner 미할당)는
   `FAIL`이 아니라 `BLOCKED`로 적는다. 코드 결함과 계정 상태를 섞지 않는다.
3. `SIMULATION`(예: `merge-tree`, 읽기 전용 ancestry 검사)의 `PASS`는 실제 병합·실행의
   `PASS`를 대신하지 않는다.
4. 다른 SHA의 `PASS`를 새 SHA로 옮겨 적지 않는다. 문서만 바뀐 commit이라도 새 SHA는
   다시 확인하거나 `UNKNOWN`으로 둔다.
5. 부분 실행은 5절 형식을 유지하면서 범위를 숫자로 적는다. 예:
   `Scanner regressions: PASS (LOCAL, d9c66661db7d, fail-closed scanner invariants, 102/102; Critical=0; High=0; required UNKNOWN=0)`.
6. `Low` 또는 `Medium` finding만 있다는 이유로 자동 `FAIL` 처리하지 않는다. 작업 계약에
   선언된 실패 기준을 실제로 충족했는지 판정하고, 미충족이면 해당 finding과 잔여 위험을
   별도로 기록한다.

## 3. 증거 출처 라벨

| 라벨 | 예 | 한계 |
|---|---|---|
| `LOCAL` | 작업자 PC의 `npm test`, `scripts/check-repository-secrets.ps1` | 환경 차이·누락된 전역 타입을 가릴 수 있다 |
| `REMOTE_CI` | GitHub Actions `Security gates` run | 같은 head SHA이고 `completed/success`일 때만 인정 |
| `INDEPENDENT_REVIEW` | 구현자가 아닌 AI·사람의 읽기 전용 검토 | 검토한 exact SHA와 범위가 없으면 `UNKNOWN` |
| `HUMAN_CHECK` | 실제 브라우저에서 사람이 확인한 화면 | 브라우저·버전·화면크기·합성 fixture 이름을 적는다 |
| `SIMULATION` | 통합 시뮬레이션, dry-run | 실제 반영·배포 증거가 아니다 |

## 4. 작업 단계별 최소 증거

| 단계 | 올리기 위한 최소 증거 |
|---|---|
| `RESERVED` | 브랜치가 baseline exact SHA를 가리킴 |
| `PREFLIGHT` | 읽기 전용 계획, allowed/forbidden path, 선행 작업 상태(각 라벨 포함) |
| `IMPLEMENTING` | 배정 계약의 `file_write_approved: YES` |
| `PUSHED` | 원격 ref의 SHA가 로컬 HEAD와 일치 |
| `DRAFT_PR` | PR base가 협업 baseline이고 draft 상태 |
| `VERIFIED` | 같은 exact SHA에서 필수 검사 `PASS (REMOTE_CI)` + `PASS (INDEPENDENT_REVIEW)`. `A` 작업은 독립 검토 2건 |
| `MERGED` | 사용자 승인 기록과 병합 commit SHA |

`REMOTE_CI`가 `BLOCKED`인 동안 작업은 `VERIFIED`로 올라갈 수 없다. 로컬 `PASS`를 모두
모았더라도 `BLOCKED` 자체가 `DRAFT_PR`을 만들거나 뜻하지는 않는다. 실제로 확인된 현재
단계(예: `PUSHED` 또는 이미 생성된 `DRAFT_PR`)를 그대로 유지하고 보고에
`REMOTE_CI: BLOCKED (확인된 사실; 원인 미확정이면 UNKNOWN)`를 남긴다.

## 5. 보고 한 줄 형식

```text
<검사 이름>: <결과> (<출처>, <exact SHA 앞 12자리>, <명령 또는 범위>, <수치 또는 N/A>)
```

예:

```text
Secret scan: PASS (LOCAL, d9c66661db7d, repository secret-gate invariants, exit 0; Critical=0; High=0; required UNKNOWN=0)
Scanner regressions: PASS (LOCAL, d9c66661db7d, fail-closed scanner invariants, 102/102; Critical=0; High=0; required UNKNOWN=0)
Security gates workflow: BLOCKED (REMOTE_CI, d9c66661db7d, Security gates job, N/A: job not started; cause UNKNOWN)
Web unit tests: NOT_RUN (LOCAL, d9c66661db7d, npm test, N/A: docs-only scope)
Browser multi-tab: UNKNOWN (HUMAN_CHECK, d9c66661db7d, browser multi-tab behavior, N/A: no human record)
```

## 6. 제품·데모 화면 문구

합성 데모 화면이나 공개 문서에서 검증 상태를 사용자에게 보여 줄 때는 아래 문구만
쓴다. 내부 라벨을 그대로 노출하지 않는다. 검사 이름을 생략하지 않으며, 합성 fixture와
`REMOTE_CI`가 겹치면 합성 데이터라는 한계를 우선 보존한다.

| 내부 상태 | 한국어 | English |
|---|---|---|
| `PASS` + 합성 fixture (`REMOTE_CI` 포함) | `<검사명>: 합성 데이터 자동 검사를 통과함` | `<Check name>: Passed automated checks with synthetic data` |
| `PASS` + `REMOTE_CI` (비합성 검사만) | `<검사명>: 자동 검사를 통과함` | `<Check name>: Passed automated checks` |
| `FAIL` | `<검사명>: 확인 실패` | `<Check name>: Check failed` |
| `BLOCKED` | `<검사명>: 확인 대기 중` | `<Check name>: Waiting to be checked` |
| `NOT_RUN` | `<검사명>: 이번 범위에서 확인하지 않음` | `<Check name>: Not checked in this scope` |
| `UNKNOWN` | `<검사명>: 확인되지 않음` | `<Check name>: Not verified` |

금지 표현(상태와 관계없이 사용하지 않는다):

- "안전함", "완벽하게 보호됨", "해킹 불가", "production-ready", "보안 인증됨"
- "secure", "unbreakable", "fully protected", "certified", "bank-grade"
- 합성 데이터 결과를 실제 Secret 지원처럼 읽히게 하는 표현

색만으로 상태를 구분하지 않는다. 텍스트 라벨을 항상 함께 두고, `UNKNOWN`과
`BLOCKED`를 성공 색으로 칠하지 않는다.

## 7. 검토 체크리스트

- [ ] 모든 `PASS`에 exact SHA와 출처가 붙어 있는가
- [ ] 다른 SHA의 결과를 재사용하지 않았는가
- [ ] 원격 미실행을 `FAIL`이나 `PASS`로 적지 않았는가
- [ ] `SIMULATION` 결과를 실제 반영 증거로 쓰지 않았는가
- [ ] 화면 문구가 6절의 허용 표현 안에 있는가
- [ ] `REAL_SECRET_GATE=CLOSED`를 바꾸는 표현이 없는가
