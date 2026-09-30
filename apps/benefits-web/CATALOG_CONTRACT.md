# 사용자 서비스 목록과 검토된 혜택의 화면 데이터

2026-09-28. provider 독립 내부 코드와 합성 메모리 테스트만 구현했다.
실제 DB·로그인·공개 API·화면 연결은 아니다. DB/도메인/배포는 사용자 재개 전까지 보류한다.
원본 benefit-validator/Lovable/DB는 동결하며 `REAL_SECRET_GATE=CLOSED`다.

## 위치와 흐름

```text
사용자가 서비스 이름/분류 입력
  → catalog.create/update/get/list (서버 내부)
  → review.preview: 후보 + 같은 서비스 ID/revision을 고정
  → 별도 사용자 확인 → review.confirm
  → projectReviewReceipt: 화면에 필요한 값만 투영
  → decoder/reducer: 인증 문맥 + generation + revision 검사
  → 향후 화면 연결 (현재 미구현)
```

- `src/server/catalog/`: 서비스 CRUD/list와 엄격한 명령 검증.
- `src/server/review/presentation.ts`: 내부 receipt를 화면용 데이터로 투영.
- `src/domain/reviewed-benefit-view.ts`: 서버 import 없는 unknown decoder/상태 reducer.
- `tests/support/review-memory-store.ts`: catalog/inbox/review가 함께 쓰는 **테스트 전용** 어댑터.

## 서비스 명령

| 명령 | 입력 | 동작 |
|---|---|---|
| create | operationId, decision=create, profile | 새 ID 발급; 같은 표시 이름으로 자동 병합하지 않음 |
| update | serviceId, expectedRevision, operationId, decision=update, profile | 버전 일치 때 수정; pending preview 내용 제거 |
| remove | serviceId, expectedRevision, operationId, decision=delete | live 혜택이 없을 때만 삭제 표식/최소 기록 유지 |
| get | serviceId | 현재 live 정보 또는 deleted/null |
| list | limit=1..50, cursor=null 또는 이전 cursor | live 항목을 고정 ID 순서로 최대 50개 조회 |

profile은 name/provider/planName/accountLabel/timezone/subscriptionStatus/trialEndsAt/notes다.
name과 subscriptionStatus 외 모르는 값은 명시적 null을 쓴다. 임의 UTC나 만료일을 채우지 않는다.
서비스 상태를 active로 입력해도 **user-reported**이고 accountProof는 **not-established**다.
실제 가입/로그인/현재 요금제 증명을 뜻하지 않는다. 기존 `ServiceRecord`로 강제 캐스팅하지 않는다.

문자열 길이, 날짜, 명시적인 timezone, exact keys, ID/revision, getter 미호출을 검사한다.
notes의 일반 줄바꿈은 보존한다. 이 검사는 비밀 탐지·PII 제거·HTML sanitizer가 아니다.
실제 키/비밀번호를 notes에 넣으면 안 된다. 향후 UI는 텍스트로 출력하고 HTML 실행을 금지해야 한다.

## 삭제·재시도·동시 작업

- catalog와 review가 별도 복사본이 아닌 **동일한 서비스 행/버전**을 참조한다.
- 수정 때 revision을 올려 이전 preview를 무효화한다. 이미 확인된 혜택의
  serviceNameAtReview는 당시 기록이며 새 서비스명으로 몰래 바꾸지 않는다.
- live 혜택이 연결돼 있으면 서비스 삭제를 거절한다. 혜택까지 자동 cascade하지 않는다.
  사용자가 별도로 혜택을 삭제한 뒤 서비스를 삭제할 수 있다.
- 삭제는 profile=null/name=고정 삭제 표식, 서비스별 모든 preview 내용 제거를 원자적으로 요청한다.
  원래 메일 후보/메일 원문까지 지우는 동작은 아니다. source 서비스명은 별도 출처 기록이다.
- ledger에는 명령 종류/소유권/operation/대상 ID/정규화 요청 SHA256만 남긴다.
  profile 원문을 중복 보관하지 않지만 digest도 익명화나 암호화는 아니다.
- 같은 operation/같은 명령은 **현재 행**을 반환한다. 삭제 전 create/update의 재호출도
  deleted/null을 반환하며 과거 profile을 부활시키거나 새 ID를 생성하지 않는다.
- 같은 operation에 다른 내용/종류/generation을 보내면 충돌한다. 변경된 값은 새 operation이 필요하다.
- 오류 뒤에도 commit이 이미 됐을 수 있다. 실패를 rollback 증거로 쓰지 않는다.

실제 어댑터는 auth entry/commit, 기한, unique/CAS, collection revision, live-benefit 참조 검사와
preview 삭제를 같은 직렬화 경계에서 강제해야 한다. `requireServiceVersion`은 다른 transaction의
변경을 막는 **변경 전 버전 조건**이다. 자신의 수정/삭제 결과에 old/live 조건을 요구하지 않는다.
이 조건과 benefit 삽입을 분리하면 서비스 삭제 뒤 혜택이 삽입되는 경쟁이 생길 수 있다.
현재 메모리 queue 검사는 운영 DB의 격리/RLS/내구성 증거가 아니다.

각 서비스 변경은 owner/generation별 catalogRevision도 올린다. cursor의 revision이 달라지면
목록을 처음부터 갱신해야 한다. 여러 페이지에 걸쳐 영구 snapshot이 유지된다고 주장하지 않는다.
목록에서 항목이 빠졌다는 이유만으로 삭제를 추론하지 않는다.

## 화면 데이터와 늦은 응답

`projectReviewReceipt`는 권한 확인을 끝낸 **내부 receipt에만** 사용한다. 인증 API가 아니다.
operation/session/grant/mailbox/candidate/analysis ID, 원문, quote/span, fingerprint는 제외한다.
표시 이름/값도 개인정보일 수 있어 익명 데이터나 zero-knowledge를 보장하지 않는다.

수신일/분석일/원래 관찰일(sourceObservedAt)/사용자 수정 관찰일(values.observedAt)/검토일을
구분한다. null, 날짜만 있는 정밀도, offset, PARTIAL_MAIL_TEXT 등 검토 이유를 보존한다.
accepted-by-user는 검토 완료일 뿐 현재 잔액/가입 인증이 아니다. 잔액 합계로 자동 변환하지 않는다.

화면 연결자는 다음 순서를 지켜야 한다.

1. 인증된 화면 문맥마다 이전에 쓰지 않은 불투명 viewScope를 만든다.
2. 요청 **시작 시** scope를 캡처한다. 응답 도착 후 현재 scope를 붙이면 안 된다.
3. reducer가 capturedScope → generation → ID/revision 순서로 검사하게 한다.
4. 로그아웃/계정 전환/명시적 갱신 때 새 scope로 초기화하고 과거 scope를 재사용하지 않는다.

두 계정은 generation=1일 수 있으므로 generation만으로 계정을 구분하지 않는다.
낮거나 같은 revision은 기존 결과를 덮지 못한다. deleted ID는 높은 saved revision도 거부한다.
최대 1,000개(삭제 표식 포함)는 기술적 메모리 한도이며 요금제 제한이 아니다. 넘치면 기존 상태를
보존한다. 실제 UI는 한도/갱신 필요를 안내해야 하며 조용히 저장 성공으로 표시하면 안 된다.
이 코드는 이미 반환한 payload/브라우저 메모리/로그/백업을 원격 회수하는 기능이 아니다.

## 남은 연결

실제 인증 principal/HTTP body 제한/CSRF/rate limit, DB adapter와 RLS/경쟁 테스트,
UI의 scope 생명주기·로그아웃/삭제 E2E, provider 연결, 계정 전체 삭제/보존 정책은 남아 있다.
호스팅/도메인/운영 DB 준비를 코드 또는 테스트 성공으로 대신하지 않는다.
사용자 준비 전까지 공개 route와 실메일 호출을 열지 않는다.
