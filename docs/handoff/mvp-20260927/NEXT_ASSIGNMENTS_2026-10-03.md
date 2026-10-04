# 후속 AI 배정·복사용 프롬프트

2026-10-03 / LOCAL_REVIEW_DRAFT. 실제 다른 채팅 전송·세션 생성은 하지 않았다.
사용자의 별도 승인 뒤 배정할 초안이다. commit/push/PR/merge 권한도 포함하지 않는다.

## 모든 담당의 기준과 선행 조건

- repository: `https://github.com/kjs844-art/secure-vault`.
- 확정 Git 시작 SHA: `afbc0fbc4dd41669e468d8658965ef8f5f10ee7d`.
- 이 SHA 위의 cloud 미커밋 client/HTTP QA/C02/C04/C06 보완을 포함한 **소유 파일 overlay**가
  필요하다. HEAD만 받으면 이번 수정·검증과 같은 트리가 아니다. 최근 검증 기록과
  `docs/verification/mvp-integration/2026-10-03-cloud-lifecycle-source-manifest.json`의 파일 hash를
  함께 전달한다. 이전 `2026-10-03-cloud-source-manifest.json`의 39개 집합은 당시 이력이며
  후속 focus/모바일/QA 변경을 포함하지 않는다. 최신 manifest와 검증의 완료 상태를 먼저 확인한다.
- 게시/전달 전에는 overlay를 받았다고 가정하지 않는다. 승인된 exact commit이 생기면
  주 담당이 이 문서의 Git SHA와 overlay 조건을 함께 교체한다. 임의의 최신 main 사용 금지.
- 현재 전달용 patch는 exact `afbc0fbc…` archive에서만 복원 검증됐다. 관찰 main archive의
  적용 가능성 검사는 exit 1이며 필요한 앱 기반이 없다. 다른 담당은 main으로 기준을 바꾸거나
  main 통합/CI/배포 완료로 승격하지 않는다. patch/manifest 전달 역시 실제 전송 전에는 미수령이다.
- 시작 전 실제 경로·HEAD·branch·상태·원격 tip·받은 overlay hash를 확인하고 별도 checkout과
  담당 branch를 사용한다. 다른 AI의 미커밋/미푸시 파일은 전달된 목록만 인정한다.
- 로컬 readiness의 미푸시 9개 파일은 NOT_RECEIVED. catalog-client/loopback 중복 여부는 미확정.
- 먼저 `AGENTS.md`, `START_HERE.md`, `SESSION_HANDOFF.md`,
  `SERVICE_READINESS_2026-10-03.md`, 최근 통합 검증, 담당 계약을 읽는다.
- `REAL_SECRET_GATE=CLOSED`, 합성 데이터만 사용. 실제 password/API key/mail, 원본
  Lovable/DB 변경, 외부 Gmail/AI 호출, paid service, domain/DB/hosting/DNS/배포,
  CI 재실행/과금 변경, 보안 검사 약화·Windows 정책 우회, main merge/force push 금지.
- 공용 타입·App/main/routes·HTTP/client·설정은 M01A 소유. R3A core·R5A 운영 adapter는
  승인된 별도 manifest 없이 변경 금지. 담당 범위를 벗어난 수정은 근거와 patch 제안으로 보고한다.
- 정확한 검사 command/exit·검사한 source hash·FAIL/BLOCKED/NOT_RUN을 기록한다.
  구현/PR 제출/main 통합/실환경 검증/배포를 구분한다.

## 배정표

| 담당 / 권장 branch | 허용 파일 | 금지/주 담당 소유 | 선행 / 완료 기준 |
| --- | --- | --- | --- |
| M02 / `codex/keyatlas-m02-ui-followup-20261003` | `apps/benefits-web/src/components/mvp-demo/**`; web identity-map/Discovery Inbox/signup-mail의 `*Panel.tsx`, panel colocated tests, 각 CSS만 | model/scanner/access policy/fixtures, protocol/worker/store/crypto, 공용 셸/routes/config/HTTP/CI, QA runner | overlay를 먼저 확인. #21/#24/#26/C06 재구현 없이 실제 부족분의 한국어·360px·키보드/초점·명도 대비를 보완. 기존 취소/TTL/한도/합성 표시 유지, typecheck/build/focused 검사와 실제 browser 증거 |
| M05A / `codex/keyatlas-m05a-qa-followup-20261003` | 새 `apps/web/tests/mvp-browser/m05a-*` QA 파일, 새 `apps/benefits-web/tests/m05a-*.test.ts`, 새 `docs/verification/mvp-integration/2026-10-03-m05a-*.md` | product source·기존 helper/runner·contracts/config/dependencies/CI·core | overlay/고정 build와 기존 결과 먼저 확인. 기존 browser runner 실행을 재사용하고 교차 browser·실제 모바일/screen reader·OS dialog/native Windows 부족분 중 실행 가능 범위만 검증. 미지원 환경은 BLOCKED/NOT_RUN. 실패 숨김·무조건 retry·삭제된 assertion 금지 |
| M06 / `codex/keyatlas-m06-korea-ops-followup-20261003` | 기존 `docs/privacy/mvp/2026-10-03-korea-data-handling-draft.md`, `docs/deployment/mvp/2026-10-03-release-operations-draft.md`; 새 `docs/privacy/mvp/2026-10-03-m06-open-decisions.md` | 앱/Rust/계약/API/infra 설정·기존 인계/검증 기록·LICENSE | 초안 2개를 재사용. metadata/FULL 목적·hosting 로그/수신자/보존/삭제·운영 연락처·지역/비용·incident/rollback의 미확정 값과 근거를 정리. 법률 준수/배포 가능 판정·실제 연락·서비스 개설 금지 |
| M04A/R4A / `codex/keyatlas-m04a-independent-review-20261003` | 새 `docs/security/reviews/m04a-2026-10-03/**`만 | 모든 product/test/policy/CI/core source 읽기 전용, 다른 담당 문서 수정 금지 | 다른 담당 구현이 고정된 뒤 별도 리뷰. client cancellation/byte bounds·HTTP authority/commit·C04 projection/state·C06 scope/TTL·R3A/R5A 설계의 경계·증거 한계를 검토. 근거 파일/행·위험/조건·최소 수정 제안·미검증 포함, 실제 대상 공격/Secret/provider 호출 금지 |

M02와 M05A의 동시 실행은 source와 QA 파일 소유가 겹치지 않아도 검사 대상이 달라질 수 있다.
M05A는 M02 변경 전/후를 별도 hash로 식별하고, 최종 independent 리뷰는 마지막 source가 고정된
후 실행한다. self QA를 독립 보안 승인으로 세지 않는다. 기준 전달·배정·게시 권한은 미승인이다.

2026-10-03 추가 작업의 기존 증거는
[수명 주기·파일·동시성·mobile 검증](../../verification/mvp-integration/2026-10-03-cloud-lifecycle-qa.md)이다.
M02는 현재 44px 버튼과 금고/backup/conflict/stage의 초점 보완을 재구현하지 않는다.
M05A는 실제 다중 탭·8개 outbox·disk v2·실제 5분/갱신·backup URL/File의 증거를 보존하고,
기존 Node runner의 BLOCKED를 Python PASS로 승격하지 않는다.
M04A/R4A는 [R5A transaction/삭제 초안](R5A_TRANSACTION_AND_DELETION_DESIGN_2026-10-03.md)의
권한/commit deadline·Unknown/replay·fingerprint 개인정보·backup 재유입 경계를 추가 검토한다.
[authority/OAuth 초안](R5A_AUTHORITY_AND_OAUTH_DESIGN_2026-10-03.md)의 앱/Gmail/금고 권한 분리·
callback/늦은 결과·token/refresh 경계도 독립 검토하며 실제 auth 구현으로 취급하지 않는다.

## M02 복사용 프롬프트

```text
KeyAtlas M02 화면 후속을 진행해 주세요. 시작 SHA는
afbc0fbc4dd41669e468d8658965ef8f5f10ee7d 입니다.
주 담당이 전달한 승인된 overlay와 source-manifest의 hash가 일치해야 시작할 수 있습니다.
별도 checkout/branch codex/keyatlas-m02-ui-followup-20261003을 사용하세요.
AGENTS 및 NEXT_ASSIGNMENTS_2026-10-03.md의 공통 제한·M02 허용/금지 파일을 따르세요.
이미 선택 통합된 #21/#24/#26/KA-C06 화면의 부족분만 보완하세요.
모바일·한국어·키보드·접근성 개선이며 model/scanner/access policy와 공용 셸은 수정 금지입니다.
취소·고정 TTL·읽기/크기 한도·합성 표시를 유지하고, 실제 메일/Secret·외부 호출은 금지입니다.
고정 의존성으로 typecheck/build/집중 검사와 실제 browser 증거를 확보하세요.
변경 파일, exact HEAD/overlay hash, command/exit, 실패·미검증, 주 담당 제안을 보고하세요.
commit/push/PR/다른 채팅 전송/세션 생성/배포는 별도 승인 전 금지입니다.
```

## M05A 복사용 프롬프트

```text
KeyAtlas M05A QA 후속입니다. 기준 SHA
afbc0fbc4dd41669e468d8658965ef8f5f10ee7d와 승인된 overlay hash를 먼저 확인하세요.
별도 checkout/branch codex/keyatlas-m05a-qa-followup-20261003을 사용하고
NEXT_ASSIGNMENTS_2026-10-03.md의 공통 제한·M05A 파일 소유를 따르세요.
기존 client→HTTP·C02/C04/C06 Python Chromium 검사와 synthetic IDB probe를 재사용하세요.
이미 통과한 기능을 새로 만들지 말고 교차 browser, 실제 모바일/screen reader,
OS file dialog, native Windows 중 현재 환경에서 가능한 미검증을 보완하세요.
product/helper/policy/config/dependency/CI 수정·보안 우회는 금지입니다.
새 QA 파일과 검증 기록만 작성하고 실패 원인은 최소 수정 제안으로 전달하세요.
source/build hash와 실제 command/exit를 기록하고 환경 미지원은 BLOCKED/NOT_RUN으로 표시하세요.
자기 QA를 독립 보안 승인이나 실제 Gmail/금고·배포 완료로 보고하지 마세요.
commit/push/PR/세션 생성/외부 연락/배포는 별도 승인 전 금지입니다.
```

## M06 복사용 프롬프트

```text
KeyAtlas M06 한국 출시·개인정보·운영 문서 후속입니다.
기준 SHA afbc0fbc4dd41669e468d8658965ef8f5f10ee7d와 승인된 overlay를 확인하고
별도 checkout/branch codex/keyatlas-m06-korea-ops-followup-20261003을 사용하세요.
NEXT_ASSIGNMENTS_2026-10-03.md의 M06 허용 파일에 있는 기존 초안 2개를 보완하세요.
T1 합성 체험, T2 실제 Gmail, T3 실제 Secret을 구분하고 metadata와 FULL 분석 목적,
hosting 로그/수신자/지역/보존·삭제, 연락처/권리 처리, incident/rollback 결정을 정리하세요.
실제 사업자·계약·법률 근거가 없으면 미확정으로 남기고 준수 인증을 주장하지 마세요.
앱/core/API/infra/Lovable/DB/계약/검증 기록/LICENSE는 수정 금지입니다.
실제 메일·연락·유료 서비스·설정·게시·배포·commit/push/PR은 별도 승인 전 금지입니다.
변경 파일, 근거/검사 command/exit, 미확정 값과 사용자 결정 목록을 보고하세요.
```

## M04A/R4A 복사용 프롬프트

```text
KeyAtlas 독립 보안 리뷰입니다. 기준 SHA
afbc0fbc4dd41669e468d8658965ef8f5f10ee7d와 주 담당의 고정 overlay/hash를 확인하세요.
별도 checkout/branch codex/keyatlas-m04a-independent-review-20261003을 사용하세요.
NEXT_ASSIGNMENTS_2026-10-03.md 공통 제한·M04A 읽기 전용 범위를 따르세요.
client의 streaming/time/abort, HTTP 권한/commit/replay, C04 state/projection,
C06 exact consent/scope/TTL, R3A/R5A 설계·provenance 경계를 검토하세요.
작성자가 한 합성 QA와 실제/독립 보안 승인을 구분하세요. 제품/core/tests/CI 수정 금지입니다.
새 review 문서에 근거 파일/행·위험/조건·최소 수정 제안·실패/미검증을 기록하세요.
실제 Secret/메일/provider 호출·실제 대상 공격·보안 우회는 금지입니다.
commit/push/PR/다른 채팅 전송/세션 생성/배포는 별도 승인 전 금지입니다.
```
