# R5A 인증·DB·Gmail provider 설계 초안

상태: **DESIGN_ONLY / LOCAL_DRAFT / ISSUE30_BODY_RECEIVED**. 2026-10-03 갱신.
기준: `afbc0fbc4dd41669e468d8658965ef8f5f10ee7d`. `REAL_SECRET_GATE=CLOSED`.
실제 auth/DB/Gmail/외부 AI 연결·환경 생성·비용·데이터 처리 승인은 확인되지 않았다.
이 문서는 인터페이스·검증 계획이며 mock 성공을 provider 성공으로 세지 않는다.

[기존 R5A 인계](REAL_SECRET_AND_BENEFIT_DELIVERY.md),
[HTTP 계약](../../../apps/benefits-web/HTTP_CONTRACT.md),
[메일 계약](../../../apps/benefits-web/MAIL_CONTRACT.md)을 읽기 기준으로 사용한다.
Issue #30은 사용자가 전달한 본문을 근거로 한다. 실제 adapter는 설계 후 승인 범위 구현이며,
본문 전달 자체는 DB/Gmail/AI 호출이나 환경 생성·게시 승인이 아니다. live API의 최신 변경은
미확인이다. 사용자의 지속 작업 요청에 따라 허용된 합성 보완·설계·검토를 이어간다.

## 재사용할 것과 미연결 부분

현재 `src/server/http/catalog-http.ts`는 session/admission/transaction을 주입하는 handler이며
실제 SSR endpoint에는 mount되지 않았다. `src/server/runtime-policy.ts`의 차단을 유지한다.
`src/server/mail/**`, `inbox/**`, `review/**`, `catalog/**`의 계약은 합성 검증 출발점이다.
PR #22의 client와 #23의 loopback QA는 기존 소스를 선별 재사용했다. cloud의 미커밋 client
보완과 합성 client→HTTP→memory 연결 검사는 별도 근거다. 로컬 미푸시 9개 파일은 아직
전달되지 않았으므로 그 파일과의 대조·통합 완료는 주장하지 않는다.

원본 benefit-validator/Lovable·DB·설정을 그대로 보존한다. 기존 RLS/migration 코드가
있다는 사실은 새 DB에서 실제 적용·격리·삭제가 검증됐다는 뜻이 아니다.

## 제안 경계

| port / 경계 | 필요한 계약 | 승인 후 별도 검증 |
| --- | --- | --- |
| 계정 session | trusted verifier가 owner/session revision/generation/expiry 반환; 브라우저 body의 owner 주장은 권한이 아님 | 로그인/로그아웃·철회·계정 전환·만료·위조/다른 사용자 거부 |
| 동의·Gmail grant | 목적·scope·동의 버전·사용자 행위·연결 계정·철회 상태 결합 | OAuth state/PKCE/redirect, consent 취소, 최소 scope, 필요한 Google 검증 절차 |
| admission / quota | 소유자·작업·request ID·만료·정확한 operation 결합, 원자적 quota 소비 | concurrent quota/drop 실패, provider 제한·고정 오류·bounded Retry-After |
| DB transaction | 현재 authority의 원자 재검사, CAS·idempotent operation·세대/삭제 경계 | 실제 RLS/권한·isolation·동시 변경·원자 commit·rollback·불명확한 ACK |
| mail source | 승인 범위의 최소 필드·관찰 시각·출처·페이지/크기/시간 상한 | 실제 pagination·중복·quota·철회 중 수집·소유권 전환·삭제 |
| 후보/검토/혜택 | 미신뢰 메일을 후보로 보존, 명시적 검토, 현재 계정 상태 증명과 구분 | 사용자별 정렬/조회, unknown/0·충돌·과거 잔액·재시도/삭제 |
| disconnect / 삭제 | 신규 수집 중단, grant 철회·token 폐기·진행 작업 무효화·보존 정책에 따른 삭제 | cache/queue/DB/로그/backup의 삭제 범위·실패·재시작·법정 보존 예외 |

이 표는 새 운영 타입이나 route를 추가하는 승인이 아니다. 로컬 보완·통합 기준을 확인한 뒤
별도 구현 manifest와 R5A-1/2/3 승인 범위를 확정한다.
권한/동의와 transaction의 검증을 단순 UI 상태나 mocked success로 대체하지 않는다.

## 기존 port에 대응하는 승인 전 검증 계획

아래는 현재 source 계약의 대응표이며 운영 adapter 구현은 아니다.

| 기존 port / 위치 | 운영 설계의 필수 조건 | 합성 재사용·승인 후 증거 |
| --- | --- | --- |
| `CatalogHttpDependencies.readSession` / `src/server/http/catalog-http-contracts.ts` | cookie는 verifier의 입력일 뿐 principal이 아님. owner/session/revision/generation/expiry를 검증하고 반복 읽기 때 철회·전환을 관찰 | 같은 generation의 다른 계정, 만료/철회, verifier 실패, 위조 cookie 거절. 실제 issuer/cookie policy는 별도 |
| 같은 계약의 `admit` | request ID/action/authority/notAfter에 정확히 결합한 공유 원자 permit. 같은 operation ID도 매 요청 admission 필요 | 병렬 quota·permit 재사용·지연 ACK·provider 429. 응답 Retry-After만 보고 자동 mutation retry하지 않음 |
| `CatalogDependencies.transaction` / `src/server/catalog/contracts.ts` | 같은 DB transaction에서 entry/commit authority와 deadline, CAS/revision, 참조, operation unique/fingerprint, collection revision을 검사 | 서로 다른 사용자·동시 수정/삭제·같은 operation 다른 내용·삭제 후 replay·불명확한 commit ACK. 실제 DB/RLS/isolation 증거는 미완료 |
| `MailAnalysisAdapters` / `src/server/mail/run-analysis.ts` | captured session/mailbox/grant/recipient/policy에 결합한 수집·분석·quota. 철회 뒤 late result를 다음 scope에 넣지 않음 | 실제 mail pagination/갱신/철회/제한과 별도 동의, 후보가 현재 계정·잔액 증명이 아님을 유지 |
| inbox/review staging·confirm/delete | 분석 원본 handoff 검증, 별도 staging 동의, service/benefit revision과 preview·operation 경계 보존 | 사용자 확인 전 저장 확정 금지, 계정 삭제/보존/철회 정책과 DB 원자 경계 검증 |

현재 mail runner의 `RunAuthority`는 `externalAnalysis: true`, `recipientId`, 고정 policy를
요구한다. Gmail MVP에서 외부 분석을 사용할지, 별도 로컬 처리 목적을 둘지 먼저 결정해야 한다.
외부 호출을 피하려고 실제 동의 없이 이 필드를 true로 채우거나 같은 policy를 다른 목적으로
사용하지 않는다. 목적 변경이 필요하면 계약·동의·quota·검사의 승인 범위를 함께 확정한다.

응답 timeout/abort 이후의 상태는 실시간 취소 또는 rollback 증명이 아니다. 승인 후 DB는
acknowledgement 손실에도 같은 command/operation을 확인할 수 있어야 하고, UI는 다음 계정
scope로 오래된 응답을 적용하지 않아야 한다. cloud loopback 검사는 이런 합성 경계를 확인하며
실제 DB transaction이나 브라우저 인증 cookie 동작을 증명하지 않는다.

## Gmail MVP 준비 결정

[앱 authority·OAuth·늦은 결과 설계](R5A_AUTHORITY_AND_OAUTH_DESIGN_2026-10-03.md)는
기존 session/mail port의 결합을 구체화한다. 실제 login/callback/cookie/token이나 새 route의
구현이 아니며 R5A-1 manifest/환경 승인 입력이다.

[목적별 승인·검증 기준](R5A_PURPOSE_AND_ACCEPTANCE_2026-10-03.md)에서 metadata 가입 흔적과
현재 FULL/외부 분석 혜택 목적을 구분한다. C06 합성 화면의 앱 연결이나 C04 표시 DTO는
server의 verified analysis 원본·실제 grant·DB 근거가 아니다. 같은 프로세스의 WeakMap
handoff와 향후 worker/queue/persistence 경계를 별도로 승인·검증해야 한다.

[원자 저장·철회·불명확한 결과·삭제 설계](R5A_TRANSACTION_AND_DELETION_DESIGN_2026-10-03.md)는
기존 transaction port의 실제 DB 직렬화·commit deadline 증거, operation fingerprint의
개인정보 경계, access expiry/물리 삭제/backup 재유입의 구분을 구체화한다.
새 DB/endpoint나 C06→C04 handoff 구현은 포함하지 않는다.

초기 후보는 필요한 메일 메타데이터·본문 부분만 단계적으로 처리하는 흐름이다.
필요한 필드·scope를 기능별로 정당화하고 OAuth 검증·제한 scope 절차와 외부 처리 여부를
공식 자료로 확인한다. Google 승인 소요 시간이 2주 안에 끝난다고 약속하지 않는다.

메일 문구는 계정 가입·해지·현재 잔액의 자동 확정이나 권한 증명이 아니다.
candidate provenance/receivedAt/observedAt, 기준시각, 사용자 검토 상태를 유지한다.
원문 보존을 기본값으로 정하지 않고 목적·최소 수집·보존 기간·삭제 범위를 먼저 결정한다.
메일 속 지시를 실행하거나 메일 내용을 tool/AI 권한으로 해석하지 않는다.
실제 외부 AI 호출은 별도 처리/국외 이전 검토와 사용자 재개 전 보류다.

서비스 session과 provider refresh token, 클라이언트 금고 Root Key를 분리한다.
서버 token 저장·암호화·접근/회전/철회 정책은 별도 검토하며 금고의 zero-knowledge 주장과
혼합하지 않는다. 이 문서에 credential 값·메일 주소·실메일·provider 설정을 넣지 않는다.

M06는 한국어 수집/이용·국외 이전·보존/삭제·철회 안내와 운영 초안을 준비한다.
처리 주체·수탁/제공 관계·국내외 저장 위치·연락처·법적 검토 결과는 미확정으로 표시한다.
특정 법률 준수나 국내 저장 완료를 문서만으로 확정하지 않는다.

## 실환경 재개 전 필요한 승인 묶음

1. 전달받은 Issue 역할/제한을 유지하면서 exact 통합 SHA·R5A 구현 manifest와 게시 권한을 별도 확정.
2. 별도 KeyAtlas 환경의 provider/지역·비용 한도·운영 주체. 원본 DB 공유/재사용 제외.
3. Gmail 목적·최소 scope·초대 대상·동의/철회·데이터 보존/삭제·외부 AI 처리 여부.
4. 정확한 auth/DB/mail/config 변경 manifest, provider credentials의 승인된 주입 경로.
5. 독립 보안 검토, 실제 RLS/quota/transaction·메일 실패/삭제 end-to-end 검증 계획.
6. 공개/초대 범위·배포 후보 SHA·운영/복구/롤백 검증과 별도 배포 승인.

현재 실제 provider 검사는 모두 **NOT_RUN**이며 새 환경·OAuth·migration·도메인·DNS·배포를
실행하지 않았다. 문서 준비와 실제 환경 생성/검증/배포 완료를 따로 보고한다.
