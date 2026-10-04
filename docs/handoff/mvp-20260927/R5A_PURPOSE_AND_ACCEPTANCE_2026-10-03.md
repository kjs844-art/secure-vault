# R5A — Gmail MVP의 목적·승인·검증 기준

2026-10-03 / **DESIGN_ONLY / LOCAL_REVIEW_DRAFT**.
기준 HEAD: `afbc0fbc4dd41669e468d8658965ef8f5f10ee7d` 및 현재 미커밋 합성 보완.
사용자 제공 Issue #30: 실제 R5A는 설계 후 승인된 범위 구현이다. 이 문서로 구현/환경/호출/
credential 주입·게시 권한이 확대되지 않는다. `REAL_SECRET_GATE=CLOSED`.

## 현재 구분해야 하는 두 목적

| 항목 | 가입 흔적 metadata 탐색 | 혜택 내용 분석 |
| --- | --- | --- |
| 현재 합성 source | `apps/web/src/features/signup-mail-discovery/**`의 KA-C06 slice | `apps/benefits-web/src/server/mail/**` |
| 입력 | `.invalid` 발신 domain·제목·수신 시각, 정확한 3개 header 필드 | Gmail FULL JSON의 bounded MIME/plain text/snippet 정규화 |
| 목적 | 제한된 서비스의 coarse 가입 문구를 검토 후보로 제시 | 메일에 나타난 혜택 이름·단위·수량·날짜를 검토 후보로 제시 |
| local 제한 | service 선택·최대 90일·최대 100 headers·subject UTF-8 512 bytes, preview 5분 | JSON 2 MiB/30 messages와 MIME/분석 내용 한도; 기본 실행 30초, 최대 120초 |
| 현재 동의 | 같은 local session의 exact preview에 명시적 true, 한 번 사용 | 검증된 authority에서 mailRead/externalAnalysis·recipient·policy·revision 결합을 요구 |
| 현재 결과 | service·signals·UTC 날짜·manual review 상태. 원문/계정 식별자 없음 | 근거 위치 검증, pending-review/unverified, 수신일·관찰일/지급량·잔량 구분 |
| 실제 연결 | 없음. live provider는 항상 거부 | 없음. 주입형 fixture만 사용하고 공개 라우트는 차단 |
| 최소 권한 | metadata-only 제안, Gmail `q` 검색 제약과 coverage/pagination 설계 검토 필요 | 현재 고정 제목 query/FULL 경로에 필요한 별도 최소 권한·본문 필요성 검토 |

metadata 목적의 동의를 FULL body/외부 분석 허가로 넓히지 않는다.
현재 C06·C04는 앱 내 합성 화면에서 열리지만, 공유 근거 저장·실제 계정·혜택 DB에 연결되지 않았다.
두 목적을 모두 T2 첫 베타에 포함할지는 사용자 결정이다. 더 넓은 권한을 자동 선택하지 않는다.
Google 공식 scope/list/사용자 데이터 정책 읽기는 2026-10-03 network URLError로 BLOCKED였다.
최신 정책·실제 effective grant·provider 호환성/심사는 아직 검증되지 않았다.

## 승인 묶음과 선행 조건

| 묶음 | 승인할 구체적 범위 | 선행/완료 기준 |
| --- | --- | --- |
| R5A-1 authority | source/config manifest, trusted login/session resolver, owner/session/revision/generation/expiry, 목적별 consent/grant와 철회 | caller JSON의 권한 주장 거부; 사용자·연결 계정 전환/로그아웃/만료/동의·grant 철회가 진행 작업과 오래된 응답을 차단 |
| R5A-2 persistence | 별도 환경 대상·지역/비용, schema/RLS·transaction·unique/CAS·operation/quota·삭제/보존 manifest | 실제 다중 owner/인스턴스 동시성, entry/commit의 authority·deadline, atomic ACK·unknown 결과·삭제 세대·backup 재유입 검증 |
| R5A-3 mail/analysis | 선택 목적·필드·scope·기간·budget·recipient/AI·token 수명·pagination·dispatch 재검증, 설정/콜 제한 | 실제 최소 grant 검증, source authenticity 한계·중복/순서/coverage·철회/오류/제한·raw payload/log 최소화·삭제 E2E |
| 앱 연결/출시 | exact 공용 타입·routes/client/UI/config manifest와 실제 연결/초대 범위 | 고정 변경 SHA의 동의→후보→명시 검토→저장/조회/삭제, 계정 전환·실패·지원 범위·운영/개인정보 판정 |

실제 OAuth·DB·Gmail/AI·deployment 실행은 현재 보류다. 환경을 만들거나 인증 키를 채팅/Git에
넣지 않는다. 원본 Lovable/DB를 fixture나 운영 환경으로 공유하지 않는다.

## 기존 계약에서 바꾸지 않을 경계

1. `readSession/readAuthority`는 trusted verifier·저장소의 현재 상태다. body의 owner/role/
   동의/adapter 객체를 그대로 반환하거나 실제 인증인 것처럼 mount하지 않는다.
2. 현재 mail authority는 `externalAnalysis: true`와 recipient/policy를 요구한다. 로컬 분석으로
   선택할 때 동의 없이 true를 채우지 않는다. 목적 변경이면 계약·consent version·quota·검사를
   함께 승인받아야 하며, 기존 type의 의미를 조용히 바꾸지 않는다.
3. 원자 quota/operation key는 owner와 실행에 결합한다. retry/unknown/실패 이후 비용과
   차감을 실제 ledger로 대조하며 자동 환불·자동 재실행으로 처리하지 않는다.
4. mail/analyzer는 원격 전송 직전 현재 권한을 다시 확인한다. caller timeout/abort만으로
   provider 작업/비용이 중단되거나 이미 저장된 명령이 rollback됐다고 표시하지 않는다.
5. 후보의 confidence/manual confirmation·메일 가입 문구는 계정 소유·현재 가입·현재 잔액
   증명이 아니다. null/0·수신일/관찰일·현재/과거·불명확함을 보존한다.
6. client의 captured scope는 동일 generation뿐 아니라 owner/session/revision/expiry까지
   결합해야 한다. Scope 변경 후 오래된 성공/error/replay를 새 화면에 적용하지 않는다.
7. reader·응답 byte/time 한도, origin/cookie 경계·고정 오류·권한·crypto·CI 정책을
   연결 편의를 위해 완화하지 않는다. 테스트 memory/session adapter를 runtime에 사용하지 않는다.

## 프로세스와 provenance 경계

현재 `runMailAnalysis`의 성공 객체는 module-private WeakMap으로 원래 authority에 결합된다.
`getVerifiedAnalysisHandoff`는 원본 성공 객체만 인정하며 복사본·가짜 receipt·실패는 거부한다.
이는 같은 프로세스의 내부 출처 증거다. JSON으로 직렬화한 UI 결과나 다른 프로세스의 객체를
원본으로 다시 취급할 수 없으며, crash/worker 간 영속 출처·인증을 제공하지 않는다.

승인 후 가능한 설계 후보는 다음과 같다. 아직 구현하거나 새 wire/DB schema를 만들지 않는다.

- 같은 요청/프로세스에서 원본 성공 객체를 trusted 내부 staging으로 넘기고, 현재 authority와
  별도 저장 동의를 다시 확인한 뒤 원자 transaction으로 처리한다.
- worker/queue/restart가 필요하면 별도 검토한 opaque handoff 참조·소유권/동의 revision·
  삭제 세대·만료·single-use/replay 계약과 trusted persistence를 설계한다.
- C06의 local hints/C04 표시 DTO를 그대로 서버의 verified analysis나 encrypted evidence로
  받아들이지 않는다. 본문 없는 가입 힌트의 별도 목적·최소 근거 계약이 필요하다.

현재 HTTP 경계는 catalog만의 주입형 handler다. 공개 `/api/catalog/**`와 auth/Gmail 경로의
503 차단을 유지하고, 새 운영 route나 허위 인증을 이 문서만으로 추가하지 않는다.

## 승인 후 acceptance 검사 표

| 검증 | 꼭 비교할 조건 | 합성 근거가 대신할 수 없는 결과 |
| --- | --- | --- |
| 권한/동의 | owner/session/연결 계정·revision/세대·recipient/policy 변경, known expiry·철회 중 대기/dispatch | 실제 grant introspection/현재 trusted 상태·이벤트/전송 경쟁 경계 |
| 최소 mail 처리 | headers와 FULL 목적 분리, 범위·budget·pagination/중복/순서·byte/time·잘못된 응답 | 실제 mailbox coverage와 최소 권한. 모두 찾았다는 주장 금지 |
| 데이터 수신자 | local/AI 목적·payload projection·공급자/region/보존·비용 | 실제 전송/수신/철회·학습/보존 정책/조건 확인 |
| DB/불명확한 ACK | concurrent quota/CAS, same-operation replay, 늦은 commit, entry/commit 권한 | 실제 atomic commit·다중 인스턴스·durable ledger/RLS·복구 |
| 수신함/검토 | 원본 provenance·명시 저장 동의, 삭제 세대·preview/revision·과거/unknown/0 | 실제 소유권·저장/조회/삭제 E2E·지원되는 handoff 수명 |
| UI/lifecycle | 취소/계정 전환/잠금/만료, stale reply와 상태/초점·민감 DOM 제거 | 실환경 인증 cookie/proxy·기기/browser·철회/삭제 전파 |
| 운영 | 제한·fixed errors·최소 로그·문의·비용·backup·rollback/삭제 재유입 | 승인 환경과 실제 운영 훈련·개인정보/보안 판정 |

실제 검사는 전부 NOT_RUN이다. cloud의 client→HTTP 16개, C04 browser, C06 99개 합성 검사·
browser scope/TTL 검사는 선행 근거로만 사용한다. standalone web 합성 PASS, PR 제출,
main 통합, 실제 MVP end-to-end, deployment 완료를 별도로 기록한다.

근거: [R5A port 설계](PROVIDER_ADAPTER_PLAN.md),
[authority/OAuth/늦은 결과 설계](R5A_AUTHORITY_AND_OAUTH_DESIGN_2026-10-03.md),
[원자 저장·철회·Unknown·삭제 후속 설계](R5A_TRANSACTION_AND_DELETION_DESIGN_2026-10-03.md),
[mail authority](../../../apps/benefits-web/MAIL_RUN_CONTRACT.md),
[candidate inbox](../../../apps/benefits-web/INBOX_CONTRACT.md),
[HTTP](../../../apps/benefits-web/HTTP_CONTRACT.md),
[한국 데이터 처리 초안](../../privacy/mvp/2026-10-03-korea-data-handling-draft.md),
[출시 운영 초안](../../deployment/mvp/2026-10-03-release-operations-draft.md).
