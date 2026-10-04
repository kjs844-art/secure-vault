# R5A-1 — 앱 권한·Gmail 연결·늦은 OAuth 결과 설계

2026-10-03 / **DESIGN_ONLY / LOCAL_REVIEW_DRAFT**.
기준 HEAD: `afbc0fbc4dd41669e468d8658965ef8f5f10ee7d` + 미커밋 합성 overlay.
실제 로그인·OAuth callback·cookie·token 저장/갱신·provider 호출 구현은 없다.
`REAL_SECRET_GATE=CLOSED`. DB/Google 설정·credential 주입·배포도 실행하지 않는다.
이 문서는 R5A-1 승인 manifest의 입력이며 구현/환경 재개 승인이 아니다.

## 세 가지 권한을 구분한다

| 권한 | trusted 경계에서 확인할 근거 | 허용하지 않는 해석 |
| --- | --- | --- |
| KeyAtlas 앱 로그인 | 승인된 verifier의 identity와 현재 app session/owner/revision/expiry | caller JSON·email 표시·UI 로그인 boolean을 principal로 사용 |
| Gmail 처리 | 앱 owner에 연결한 mailbox/grant와 실제 effective scope, 목적별 consent/revision/expiry | OAuth 연결을 외부 AI 분석·모든 메일 처리 동의로 사용 |
| 실제 금고 unlock/보기/복사 | 별도 R3A의 key possession·행위 권한·수명 | 앱 로그인/Gmail 연결로 Root Key를 자동 unlock |

Google을 앱 로그인에도 사용할지, 별도 app identity에 Gmail만 연결할지는 **미확정**이다.
로그인 provider를 사용한다면 검증한 issuer/subject/audience와 해당 방식의 nonce/expiry 등을
확인해야 한다. 표시 email을 계정 결합의 유일한 식별자로 삼거나 자동 계정 병합하지 않는다.
provider 선택·검증 library·의존성·복구/계정 결합·session 정책은 별도 승인 대상이다.

## 기존 source에 넘길 수 있는 값

| 현재 source/port | 정확한 기존 결합 | 운영 설계 조건 |
| --- | --- | --- |
| [ReviewAuthority](../../../apps/benefits-web/src/server/review/contracts.ts) | `ownerId`, `sessionId`, `sessionRevision`, `dataGeneration`, `expiresAt` | verifier와 저장소의 현재 상태에서 조립. body/URL/localStorage의 동일 이름 값은 권한 근거가 아님 |
| [Catalog readSession](../../../apps/benefits-web/src/server/http/catalog-http-contracts.ts) | cookie는 credential context의 입력, 반환값은 미신뢰 `unknown`부터 검사 | 실제 session 확인과 반복 읽기의 logout/revoke/계정 전환/expiry 관찰. trusted origin은 Host/Forwarded로 추론하지 않음 |
| 같은 계약의 `admit` | `requestId`, action, authority, `notAfter`에 결합한 공유 permit | 같은 operation replay라도 매 요청 admission. session 바뀐 permit 재사용 금지 |
| [RunAuthority](../../../apps/benefits-web/src/server/mail/run-analysis.ts) | 앱 session/data generation, mailbox/grant ID·revision/expiry, operation, recipient/policy, `mailRead`·`externalAnalysis` | 현재 두 목적의 consent/grant를 검증해 조립. 어느 capability가 바뀌어도 revision 변경·이른 expiry 적용 |

현재 mail authority가 요구하는 `externalAnalysis: true`를 metadata/local 분석에 동의 없이
채우지 않는다. 새 목적이면 기존 계약·policy·consent·quota의 승인 범위를 함께 정한다.
같은 `dataGeneration`만 비교해서 다른 owner/session을 같은 scope로 취급하지 않는다.

## OAuth 연결 요청부터 결과까지

아래는 provider와 auth 방식을 정한 뒤 검토할 흐름이다. endpoint/DB schema/숫자 TTL은
정하지 않았고 코드에 새 route를 추가하지 않았다. 공개 auth/Gmail/catalog 503 차단은 유지한다.

1. 현재 trusted app session에서 **Gmail 연결**과 목적/범위를 명시적으로 요청한다.
   기존 연결 계정/범위·recipient를 보여주고 metadata/FULL/외부 분석 동의를 구분한다.
2. trusted 서버가 session/owner/data generation·연결 요청 identity·목적/scope·redirect·
   만료에 결합한 single-use correlation을 만든다. state와 PKCE의 S256 지원/검증 및
   로그인 identity를 처리하는 경우의 nonce 검증을 설계한다. 값/보관 방식은 아직 구현하지 않는다.
3. callback은 승인된 정확한 redirect와 원래 요청에만 결합한다. browser body의 owner,
   임의 return URL, 수정한 요청 scope를 받아 새 권한으로 만들지 않는다. 중복/만료/취소 요청은 닫힌다.
4. 실제 code 교환이 승인된 뒤에는 bounded 응답·실제 effective grant·대상 계정 결합을 검증한다.
   표시 계정과 사용자가 의도한 연결이 다르면 자동 수락/계정 병합하지 않고 명시적으로 다시 확인한다.
5. 외부 응답 뒤 **현재** app session/owner/generation/요청 상태를 재검사한다. 로그아웃·전환·
   삭제/철회된 요청의 늦은 token/성공을 새 계정이나 새 요청에 붙이지 않는다.
6. [원자 저장 설계](R5A_TRANSACTION_AND_DELETION_DESIGN_2026-10-03.md)의 같은 권한 경계에서
   grant 저장·revision·single-use 완료를 처리하고 확인된 결과만 같은 captured scope에 표시한다.

OAuth callback의 cross-site 상위 navigation과 API mutation의 origin/CSRF 경계를 구분한다.
callback을 지원하려고 기존 HTTP/CSRF 검사를 전역적으로 풀지 않는다. SameSite 등 cookie
정책과 callback method/return 흐름은 provider 호환성·실제 browser 검사 뒤 route별 manifest로
승인한다. 지금 cookie나 header 설정을 바꾼 것은 아니다.
callback URL에는 provider가 보낸 code/state 등이 들어올 수 있으므로 해당 경로의 query·
Referer·오류 수집/로그·cache를 별도로 검토한다. 처리 뒤 parameter 없는 승인된 return으로
이동하는 설계도 원래 URL/브라우저 기록/외부 사본이 모두 삭제됐다는 증거로 사용하지 않는다.

로그아웃 직전에 provider가 이미 grant를 발급했다면 app DB 저장을 거부한 것만으로 외부
grant까지 철회됐다고 보고하지 않는다. 승인된 cleanup/revocation 경로와 최소 재개 기록의
보존을 설계하고, provider 결과가 불명확하면 성공/롤백으로 단정하지 않는다. 임의 code 재교환이나
새 연결 operation으로 자동 반복하지 않는다. 현재 그런 provider cleanup은 구현되지 않았다.

## Session과 token의 저장·실패 경계

- 실제 app session은 trusted 서버 상태와 연결한다. 운영 cookie의 Secure/HttpOnly·경로·
  수명/회전·SameSite·logout/revoke 정책은 승인 대상이다. T1 합성 데모의 현재 cookie 부재를
  T2 session 구현의 성공 근거로 쓰지 않는다.
- Gmail access/refresh token·PKCE verifier·원본 code/state/nonce는 private adapter 영역이다.
  client DTO, URL 재표시, local/sessionStorage, 오류/로그/HAR, 분석 payload, 채팅/Git에 넣지 않는다.
  token 암호화/키 관리·지역/접근·backup/삭제는 별도 운영 설계이며 실제 금고 Root Key와 분리한다.
- 갱신은 owner/mailbox/grant revision에 결합해 다른 인스턴스와 경쟁을 조정한다. provider가
  refresh token을 교체한 뒤 ACK가 불명확할 수 있는 경우를 다룬다. 만료/철회 오류를 숨기고
  같은 credential로 무제한 retry하거나 다른 계정 token을 fallback으로 사용하지 않는다.
- logout, Gmail disconnect, 분석 동의 철회, 계정 삭제는 서로 다른 수명 종료다. 새 dispatch
  차단·late result scope 무효화와 DB/token/로그/backup/외부 grant 정리의 완료를 구분한다.
- HttpOnly cookie는 같은 origin의 악성 script가 사용자의 권한으로 동작하는 것을 완전히
  막는 격리가 아니다. CSP·제3자 script·dependency·HTML 표시 경계는 독립 검토해야 한다.

## 승인 후 acceptance

실제 계정/메일/credential을 쓰는 검사는 현재 모두 **NOT_RUN**이다. 먼저 합성 사례와
trusted adapter 계약을 검토하고 별도 exact 구현 SHA를 고정해야 한다.

| 묶음 | 필수 조건 | 완료로 오해하면 안 되는 현재 근거 |
| --- | --- | --- |
| 앱 identity/session | verifier 실패·issuer/subject/audience/expiry, logout/revoke·session 회전·다른 owner/같은 generation | fixture authority 및 UI 상태는 실제 로그인 아님 |
| 연결 correlation | 취소/만료/중복 callback·redirect 결합, 목적/scope/계정 변경 | C06 local preview의 단일 사용 동의는 OAuth state/PKCE 검증 아님 |
| 늦은 결과 | code 교환/갱신 중 logout·계정 전환·삭제/철회, grant 발급 후 저장 거부/ACK 불명확 | client→HTTP scope 테스트는 실제 Google/DB 경쟁 검사 아님 |
| grant/consent | 실제 effective scope·mailbox binding·독립 외부 분석 동의·recipient/policy 변경·이른 expiry | manual confirmed/메일 문구는 계정 소유·현재 가입 증명 아님 |
| 저장/전송 | private token 경계·원자 grant revision·refresh 경쟁·로그/URL/storage/cookie·삭제/backup | plaintext 없는 client DTO만으로 서버 token 보호가 완성되지 않음 |

승인 전에 정할 것은 app login 방식/지원 계정 결합, 첫 Gmail 목적/최소 scope/recipient,
session/cookie 정책, callback/저장 허용 파일과 trusted issuer, token 보관/갱신/철회·cleanup,
개인정보/지역/비용, 독립 리뷰와 실환경 검사 범위다. Google 최신 정책/심사 조건은 기존
공식 자료 GET의 URLError로 아직 검증하지 못했으며 기간·호환성을 확정하지 않는다.

연결 문서: [R5A port 계획](PROVIDER_ADAPTER_PLAN.md),
[목적별 승인](R5A_PURPOSE_AND_ACCEPTANCE_2026-10-03.md),
[원자 저장/삭제](R5A_TRANSACTION_AND_DELETION_DESIGN_2026-10-03.md),
[R3A 별도 gate](REAL_SECRET_CORE_PLAN.md),
[한국 개인정보 초안](../../privacy/mvp/2026-10-03-korea-data-handling-draft.md).
