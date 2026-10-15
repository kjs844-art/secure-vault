# KeyAtlas 협업 작업 1~100

> 통합 부모 SHA: `41eeed0492e5325816e0797bbefa727408574e3c`
> 협업 기준 브랜치: `codex/firstvibe-collab-001-100-baseline`
> 실제 작업 기준 SHA: 이 문서가 커밋·push된 뒤 위 기준 브랜치의 exact remote HEAD를
> 작업 배정 직전에 다시 확인한다.
> 실제 Secret 허용 상태: `REAL_SECRET_GATE=CLOSED`
> 이 문서의 브랜치 생성은 작업 완료나 PR 승인, `main` 병합을 뜻하지 않는다.

Git commit은 자기 자신을 포함하는 최종 SHA를 파일 안에 미리 고정할 수 없다. 따라서
`41eeed0...`는 문서가 출발한 **통합 부모**이고, 각 AI가 확인해야 하는 작업 기준 SHA는
발행된 baseline 브랜치의 HEAD다. SHA가 다르면 작업하지 않고 `BLOCKED`로 끝낸다.

## 1. 왜 100개로 나눴나

한 브랜치에는 한 가지 검증 가능한 결과만 둔다. 여러 AI가 동시에 작업하더라도
동일 파일을 고치는 충돌과, 낮은 난도의 UI 작업이 보안 핵심 변경에 섞이는 일을 줄이기
위한 구조다. 번호와 실제 브랜치의 정확한 대응은
[`KEYATLAS_COLLAB_BRANCH_MANIFEST_001_100.csv`](KEYATLAS_COLLAB_BRANCH_MANIFEST_001_100.csv)에
있다.

```text
1~21     제품·보안·배포 상위 조정 EPIC (직접 구현 금지)
22~35    외부 AI용 UI·문서·공개 metadata
36~47    격리된 Web UX·접근성 컴포넌트
48~55    합성 fixture·자동 QA
56~60    브라우저 QA·콘텐츠·데모 운영 문서
61~67    API·opaque sync·PostgreSQL 계약
68~72    OIDC·Passkey·session·HTTP·device 보안
73~80    Free/Pro·결제 sandbox·관측성·privacy lifecycle
81~86    Android·PWA
87~92    브라우저 확장·CLI·MCP
93~100   release artifact·SBOM·배포 dry-run·보안 증거·PR gate
```

## 2. A 표시 규칙

`A`는 단순히 어려워 보이는 작업이 아니다. 잘못 구현하면 Secret 노출, 계정 탈취,
데이터 손실, 결제 오류, tenant 침범, 공급망 위조 또는 잘못된 출시 승인을 만들 수 있는
작업에만 붙인다.

```text
1A 2A 6A 7A 8A 9A 12A 13A 14A 16A 17A
54A
63A 64A 65A 66A 67A 68A 69A 70A 71A 72A
74A 75A 76A 77A 78A 80A
83A 84A 86A 88A 90A 92A 95A 98A 100A
```

- 일반 작업: 외부 AI가 preflight 후 승인받아 지정 파일만 구현할 수 있다.
- `A` 작업: 외부 AI의 기본 역할은 **읽기 전용 독립 검토**다.
- `A` 구현은 보안 담당 모델과 사람이 설계·증거를 확인한 뒤 별도 승인한다.
- 증거가 없으면 `PASS`가 아니라 `UNKNOWN`이다.

### A 표기의 위험 근거

| A 묶음 | 위험 근거 |
|---|---|
| 1A, 2A | CI 신뢰 경계와 통합 기준 SHA를 잘못 판단하면 검증되지 않은 변경이 안전한 것으로 보일 수 있음 |
| 6A~9A | 복구·checkpoint·기기 키·sync 실패가 데이터 손실·rollback·평문 노출로 이어질 수 있음 |
| 12A~17A | 실제 Secret UX·인증·운영권한·사고대응 경계이며 계정 탈취·대량 노출 위험이 있음 |
| 54A | 시각 회귀 도구가 브라우저·fixture·스크린샷을 실행·보존하므로 공급망·노출 경계가 생김 |
| 63A~72A | sync·DB 격리·migration·OIDC·Passkey·session·CSRF·기기 폐기 경계 |
| 74A~80A | entitlement·결제 이벤트·telemetry redaction·개인정보 lifecycle 경계 |
| 83A~98A | 모바일 키·PWA 업데이트·확장·CLI·MCP·release provenance·보안 증거 검토 |
| 100A | PR·release 직전 최종 Go/No-Go 판정으로 잘못된 승인이 공개 배포로 이어질 수 있음 |

## 3. 공통 작업 계약

모든 작업은 다음 다섯 필드를 만족해야 한다.

1. **작업:** manifest의 한 번호만 수행한다.
2. **범위:** 지정된 파일 또는 새 디렉터리 밖을 수정하지 않는다.
3. **완료조건:** 테스트 가능한 결과물을 만든다.
4. **검증:** 실행한 명령과 exit code를 남긴다.
5. **의존성:** 선행 번호가 통합되지 않았다면 `BLOCKED`로 멈춘다.

manifest는 **예약 목록**이지 구현 허가서가 아니다. 구현 전에는 반드시
[`KEYATLAS_COLLAB_ASSIGNMENT_CONTRACT_TEMPLATE.md`](KEYATLAS_COLLAB_ASSIGNMENT_CONTRACT_TEMPLATE.md)를
복사해 exact allowed/forbidden path, deliverable, 완료조건, 검증, 담당자, base/head SHA를
고정한다. 값이 비었거나 placeholder면 기본값은 `NO/BLOCKED`다.

번호는 안정적인 작업 ID이지 실행 순서가 아니다. 뒤 번호가 앞 번호의 선행조건일 수 있다.
1~21의 mode는 모두 `EPIC_COORDINATION`이며, 하위 결과의 조정·증거 기록만 허용하고
제품 코드 구현 브랜치로 배정하지 않는다.

항상 금지되는 것:

- 실제 비밀번호, API 키, OAuth secret, 복구 키, cookie, 카드, 고객 PII 사용
- `.env`, 실제 DB/WAL/backup, 개인 브라우저 profile 읽기
- `REAL_SECRET_GATE` 개방
- 외부 cloud, OAuth, 결제, 앱스토어, IAM, DNS, signing 상태 변경
- `main` 직접 작업, force-push, 임의 rebase/reset, 다른 작업 cherry-pick
- 허용되지 않은 dependency·binary·install script·analytics·remote font 추가
- 검증하지 않은 기능을 완료·안전·production-ready로 표시

## 4. 브랜치와 PR 흐름

```text
[collab-001-100-baseline]
          │
          ├─ collab-1a, collab-2a, collab-3 ... collab-100a
          │        각 AI는 한 브랜치만 담당
          │
          ├─ Draft PR: task branch → collab baseline
          │        자동 병합 금지
          │
          ├─ 독립 리뷰 + 허용 파일 + 검사 증거 확인
          │
          └─ 검증된 묶음만 integration → main 후보
                   최종 병합은 사용자 승인 필요
```

100개 브랜치를 바로 `main` 대상으로 PR로 열지 않는다. 개별 작업은 먼저 baseline 대상
Draft PR로 검토하고, 선행 관계와 충돌을 정리한 뒤 통합 담당자가 묶는다.

## 5. 파일 소유권 기본값

| 번호 | 기본 허용 영역 | 핵심 금지 영역 |
|---|---|---|
| 1~21 | 지정된 조정·검토 문서만 | 제품 코드·workflow·IaC·main 변경 |
| 22~47 | `apps/web/src/ui/**`, 지정된 feature 신규 파일, 대응 test | crypto·bridge·storage·repository·security core |
| 48~53 | `tests/fixtures/synthetic/ui/**`, 지정 validator | 실제 fixture·암호 vector·Secret scanner |
| 54A~60 | 격리 QA config/test와 지정 문서 | 제품 보안 코어·실제 계정·배포 |
| 61~80 | `services/api/**`, `contracts/sync-v1/**`, 합성 fixture | 실제 provider·managed DB·production config |
| 81~86 | `apps/android/**`, `apps/web/public/pwa/**`, 지정 검토 문서 | signing·Keystore 실키·Play 제출·service worker 운영 등록 |
| 87~92 | 합성 extension·CLI·MCP 신규 디렉터리 또는 검토 문서 | 실제 자동채움·clipboard·vault 접근·tool network |
| 93~100 | release 도구·distribution 초안·검토 문서 | release upload·실제 서명·배포·PR 승인/병합 |

각 브랜치의 제목·난이도·mode·선행 번호는 manifest를 source of truth로 사용한다.
구체적인 allowed files는 작업 시작 전 외부 AI의 preflight 결과를 primary 담당자가 검토해
한 번 더 좁힌다.

## 6. 기존 22~35 브랜치 migration

22~35는 과거 `b05ff454029676947d8f6c515acf488b3b787d29`에 예약된 원격 브랜치다.
14개가 모두 같은 SHA이며 task별 고유 commit이 없고, 해당 SHA가 통합 부모
`41eeed0492e5325816e0797bbefa727408574e3c`의 조상임을 확인했다. 발행 직전 원격을 다시
fetch하여 이 조건을 재검증한 뒤 새 baseline으로 **fast-forward만** 한다. 조건이 달라졌거나
고유 commit이 생겼으면 즉시 중단한다. force-push는 사용하지 않는다.

## 7. 브랜치가 존재한다는 뜻

- `RESERVED`: 출발점만 만들었다. 작업하지 않았다.
- `PREFLIGHT`: AI가 읽기 전용으로 범위와 계획을 제출했다.
- `IMPLEMENTING`: 지정 파일에서만 구현 중이다.
- `PUSHED`: 커밋을 원격에 올렸다. PR은 아직일 수 있다.
- `DRAFT_PR`: 검토용 PR이 열렸다. 병합 승인이 아니다.
- `VERIFIED`: exact SHA의 관련 검사와 독립 리뷰가 통과했다.
- `MERGED`: 승인된 대상 브랜치에 반영됐다.

현재 최초 생성 직후 1~100은 모두 `RESERVED`로 취급한다.

작업 브랜치는 100개이고, 별도의 협업 baseline을 포함하면 협업용 ref는 101개다.
따라서 “GitHub 전체 브랜치가 100개”라는 뜻은 아니다.

선행 PR이 baseline에 반영된 뒤 아직 작업하지 않은 후속 `RESERVED` 브랜치는 다음 조건을
모두 만족할 때만 현재 baseline HEAD로 fast-forward한다: task 고유 commit 0개, 예상 old
HEAD 일치, old HEAD가 새 baseline의 조상, 활성 worktree·dirty 변경 없음. 하나라도 다르면
자동 갱신하지 않고 reconciliation 검토를 연다. 구현이 시작된 브랜치는 임의로 rebase,
merge, reset하지 않는다.

## 8. 외부 AI 배정 순서

1. 외부 AI에게 prompt pack의 **조회 전용 선택 프롬프트**를 준다.
2. AI가 가능한 후보 3개와 필요한 권한·도구를 보고한다.
3. primary 담당자가 충돌 없는 번호 한 개만 배정한다.
4. 일반 작업도 첫 응답은 `READ_ONLY_PREFLIGHT`로 제한한다.
5. 사용자가 구현을 승인하면 해당 prompt의 mode만 `IMPLEMENT`로 바꾼다.
6. 커밋·push·Draft PR은 각각 별도 상태로 보고한다.
7. `A` 작업은 독립 reviewer 두 명 또는 동등한 보안 검토 전에는 구현·병합하지 않는다.

## 9. 현재 제품 경계

이 분할은 개발 속도를 높이는 도구일 뿐, 실제 Secret 저장 허가가 아니다. 복구, 실제
파일 경계, 기기 키, opaque sync, 운영 권한, 독립 암호 검토, 사고·복구 훈련이 모두
완료되기 전까지 합성 데이터만 사용한다.
