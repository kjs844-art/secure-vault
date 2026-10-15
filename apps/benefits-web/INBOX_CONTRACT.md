# 메일 분석 → 후보 수신함 → 사용자 확인

2026-09-28. `src/server/inbox/`는 서버 내부 연결 코드이며 공개 API가 아니다.
실제 인증·DB·메일·AI 제공자·화면에는 연결하지 않는다. 사용자 요청에 따라 DB·도메인·배포
설정은 계속 보류한다. 원본 benefit-validator/Lovable/DB도 변경하지 않는다.

## 연결되는 흐름

```text
메일 실행기의 인증·별도 분석 동의·한도 확인
  → 제한된 메일 정규화와 근거 연결 검사
  → 성공 객체와 분석 시작의 private authority를 서버 메모리에서 결합
  → inbox.stage(원래 성공 객체): 현재 인증 + 분석 권한 + 별도 후보 저장 동의 확인
  → 후보들과 완료 batch 표식을 하나의 transaction으로 요청
  → inbox.listBatch: 현재 사용자에게 그 batch의 현재 후보 상태만 반환
  → review.preview → 사용자 화면 확인 → review.confirm
     또는 inbox.discard: 미확인 후보와 연결 preview 내용 제거
```

기존 [메일 계약](MAIL_CONTRACT.md), [확인·삭제 계약](REVIEW_CONTRACT.md)과 이어진다.
후보를 저장해도 사용자가 승인한 혜택·가입 사실·현재 잔액으로 바뀌지 않는다.
서비스 생성/검색, 사용자 화면과 실제 저장 어댑터의 연결은 별도 작업이다.

## 실제 실행 출처와 소유권

`runMailAnalysis`는 owner/session뿐 아니라 **sessionRevision/dataGeneration**도 시작부터
quota permit과 반복 권한 검사에 고정한다. 성공 객체만 module-private WeakMap에 등록한다.
`stage`는 전달받은 객체를 직접 lookup한다. 같은 필드의 JSON·객체 복사본·실패 결과·가짜
handoff envelope는 받지 않는다. 공개 receipt에 owner/session/generation을 추가하지 않는다.

이는 같은 서버 프로세스의 검증 경로를 통과했다는 증거다. 실제 OAuth 권한의 진실성,
프로세스 재시작, 다른 worker/queue로 전달된 JSON의 진위를 인증하는 수단은 아니다.
그 경우에는 별도로 검증된 서버 측 지속 handoff 설계가 필요하며 WeakMap 우회 fallback은 없다.

현재 앱 인증은 분석 당시 owner/session/revision/generation/세션 만료와 같아야 한다.
새 로그인이나 계정 삭제 세대에 오래된 분석 결과의 소유권을 사후 부착하지 않는다.
sessionRevision/dataGeneration을 모르는 인증 어댑터는 기본값 1을 만들어 통과시키면 안 된다.

## 별도 저장 권한과 기한

메일 읽기나 AI 분석 동의만으로 후보 보관까지 허용하지 않는다. trusted adapter가 반환하는
`CandidateStagingGrant`에는 다음이 명시적으로 결합된다.

- 소유자, 세션, session revision, data generation.
- 분석 operation, 메일 연결, AI 수신자, 원래 분석 grant ID/revision.
- 저장 정책 version, 저장 허용, 저장 grant ID/revision와 만료.
- 미확인 후보를 볼 수 있는 마지막 시각인 `pendingAccessUntil`.

저장 grant 만료·철회·변경 또는 원래 분석 권한 변경 시 stage를 거절한다.
transaction은 `requireCandidateStaging`으로 등록한 두 권한을 **실제 commit 시점에도**
다시 검증해야 한다. 앞단의 boolean 검사만으로 DB의 동시성·철회 대응이 구현되는 것은 아니다.

현재 접근 기간의 기술적 상한은 분석 시각부터 7일이다. 자동 동의/기본 보관 기간을 설정한
것이 아니며 실제 grant에서 더 짧거나 같은 기한을 명시해야 한다. 운영 보존 정책은 미결정이다.
pending 후보의 `expiresAt`는 생성 후 늘리거나 바꾸지 않는다.

**접근 만료 ≠ 물리 삭제 완료.** 만료된 pending은 list 결과에서 `expired/content:null`로
표시하고 preview/confirm을 거절한다. 이 작업은 자동 purge, 백업 소거, 계정 전체 삭제를
구현하지 않는다. 실제 서비스 연결 전 물리 삭제 작업과 보존 정책을 별도 구현·검증해야 한다.
한번 확인한 혜택을 원래 pending 기한 때문에 자동 삭제하거나 삭제 불가능하게 만들지는 않는다.

## 동작과 재시도

| 동작 | 입력 | 결과 |
|---|---|---|
| `stage` | 서버 내부 원본 분석 성공 객체 | 같은 소유권/동의 하의 후보 batch. 원문·quote·Gmail ID는 보관하지 않음 |
| `listBatch` | `analysisOperationId`만 | 현재 사용자·generation의 한 batch, 최대 100개. 전체 inbox 검색/페이지네이션은 아님 |
| `discard` | candidate ID, expected revision, `decision: discard` | pending 후보의 삭제 표식과 연결 preview 내용 제거 |

stage는 빈 분석 결과도 완료 표식을 남긴다. `(ownerId, analysisOperationId)`와 후보별 ID/slot은
unique여야 하고 후보 생성과 batch 완료 기록은 전부 commit하거나 전부 rollback해야 한다.
같은 operation이라도 canonical 내용/분석 권한/저장 grant가 달라지면 충돌이다.
SHA256 fingerprint와 최소 ID 목록은 private replay metadata로만 보관하고 API 응답/로그에 넣지 않는다.
SHA256은 소유권 증명이나 개인정보 익명화가 아니다. 이 메타데이터도 보존·삭제 정책의 대상이다.

동일 원본 성공 객체로 stage를 재호출하면 과거 성공 payload 대신 현재 후보 행을 읽는다.
accepted/deleted/expired의 payload는 null이며 이전 후보를 pending으로 되돌리지 않는다.
stage를 재호출할 권한이 만료됐어도 `listBatch`와 `discard`는 현재 앱 인증으로 접근할 수 있다.
따라서 메일/분석 연결 철회가 자기 후보를 확인·정리할 권한을 막지 않는다.

discard는 기한 지난 pending에도 가능하다. 이미 accepted인 후보는 기존 benefit 삭제 경로를
사용한다. 동일 expected revision의 삭제 결과가 정확히 다음 revision으로 남아 있으면 재호출은
현재 deleted/null만 반환한다. 다른 revision은 충돌이며 무조건 새로운 요청으로 덮어쓰지 않는다.

commit 후 응답 오류/권한 변경은 저장이 없었다는 뜻이 아니다. stage 재시도 또는 batch 조회로
현재 상태를 확인한다. 저장소 adapter 실패의 원문은 응답에 노출하지 않는다.

## UI와 실제 어댑터가 지켜야 할 남은 경계

- 외부 요청에서 owner/grant/functions/candidates를 받아 내부 stage의 증거로 쓰지 않는다.
- `isAnalysisAuthorized`는 전달된 객체 자체를 true라고 돌려주는 함수가 아니라 현재 서버 권한을
  조회하는 adapter여야 한다. transaction은 앱 인증·두 grant·기한을 commit 때 원자 검증한다.
- 삭제 후보 ID와 `(owner, analysis operation, candidate index)` slot은 재사용하지 않는다.
  callback 실패/CAS·unique 실패는 전부 rollback하며 삭제 중 preview 생성도 격리한다.
- list는 조회 중·commit 응답 지연 중 만료된 pending 내용을 반환 직전에 다시 가린다.
  이미 브라우저에 반환한 payload나 별도 로그/캐시를 회수하는 것은 아니다.
- UI는 문자열을 text로 표시하고 generation/revision이 오래된 응답을 무시해야 한다.
  현재 잔액/확정 회원가입 표시나 기존 domain 합계로 자동 변환하지 않는다.
- batch index는 영속 Gmail source ID가 아니다. 다른 분석 operation이 같은 메일을 다시 제안하는
  것까지 영구 차단하지 않는다. stable source 연결·보관 정책은 추가 작업이다.
- 실제 HTTP body 한도/인증·CSRF·rate limit, queue 재시작, DB RLS/내구성/병렬 서버,
  자동 삭제·실제 브라우저/E2E는 이 메모리 검증의 범위 밖이다.

agent-consent-patterns의 별도 권한 목적, 좁은 범위, 만료, 철회 후 정리 가능성과
정직한 처리 기록 원칙을 적용했다. `REAL_SECRET_GATE=CLOSED`이며 실제 서비스 연결은 열지 않는다.
