# KeyAtlas 후속 AI 배정 — 2026-10-04 KST

상태: LOCAL_DRAFT / 미전송 / 새 AI 세션 미생성 / 게시 권한 미포함.
주 담당은 M01A 통합·공용 타입·앱 셸·routes·HTTP·공통 설정을 계속 소유한다.

## 같은 코드부터 시작하기

- Git 기준은 `afbc0fbc4dd41669e468d8658965ef8f5f10ee7d`다. 현재 cloud branch는
  `codex/firstvibe-cloud-catalog-client-fix-20261003`이며 새 commit은 없다.
- 이 SHA **위의 미커밋 변경**도 필요하다. HEAD만 checkout하면 검증한 코드가 아니다.
  주 담당이 전달한 patch와
  [현재 manifest](../../verification/mvp-integration/2026-10-04-cloud-shell-source-manifest.json)의
  경로·hash를 대조한다. 실제 전달 전에는 수령했다고 보고하지 않는다.
- [10/3 배정표](NEXT_ASSIGNMENTS_2026-10-03.md)의 공통 제한을 유지한다.
  10/3 manifest·ZIP은 당시 트리의 증거다. 10/4 앱 셸을 포함한 현재 기준과 구분한다.
- 원격 main 관찰 SHA는 `65d10dceb13039dc69cf2368aa0e31d7ad5cc6b2`다.
  main에는 이번 patch가 전제하는 앱 기반이 없으며 기존 patch 적용 검사는 exit 1이었다.
  임의의 main 시작·merge·통합 완료 주장은 금지한다. main의 LICENSE 대조도 남았다.
- 로컬 readiness의 catalog-client/loopback 9개 파일은 NOT_RECEIVED다.
  다른 담당이 이 영역을 새로 구현하거나 중복 없음·통합 완료라고 보고하지 않는다.
- `AGENTS.md`, `START_HERE.md`, `SESSION_HANDOFF.md`,
  [준비 상태](SERVICE_READINESS_2026-10-03.md),
  [이번 검증](../../verification/mvp-integration/2026-10-04-cloud-shell-qa.md)을 먼저 읽는다.
- 별도 checkout과 담당 branch를 사용하고 실제 경로·HEAD·Git 상태·원격 tip·overlay hash를
  확인한다. 기존 미커밋 파일을 덮어쓰거나 대체하지 않는다.

`REAL_SECRET_GATE=CLOSED`. 합성 데이터만 사용한다. 실제 password/API key/mail,
Gmail/외부 AI 호출, 원본 Lovable/DB 변경, domain/DB/hosting/DNS/배포·유료 서비스,
CI 재실행·결제/한도 변경, 보안 검사 약화·Windows 정책 우회는 금지한다.
R3A core·R5A 실제 auth/DB/Gmail adapter는 별도 승인된 구현 manifest 없이는 변경하지 않는다.
commit/push/PR 생성/main merge/force push, 다른 채팅 메시지·세션 생성은 별도 승인 전 금지다.

## 부족분만 나누는 배정표

| 담당 / 권장 branch | 허용 파일 | 금지 파일·선행 작업 | 완료 기준 |
| --- | --- | --- | --- |
| M02 / `codex/keyatlas-m02-ui-followup-20261004` | `apps/benefits-web/src/components/mvp-demo/**`; web identity-map/discovery-inbox/signup-mail의 `*Panel.tsx`, panel tests, 해당 CSS | 공용 `src/ui/**`, App/main/routes, model/scanner/policy/fixtures, worker/store/crypto/HTTP/config/CI. 현재 overlay 먼저 수령 | 기존 44px 버튼·초점·새 셸 재구현 없이 남은 한국어·모바일·screen reader 문제만 보완. 정책·합성 안내 보존, 집중 test/typecheck/build 및 실행한 browser 증거 |
| M05A / `codex/keyatlas-m05a-qa-followup-20261004` | 새 `apps/web/tests/mvp-browser/m05a-*`; 새 benefits `tests/m05a-*.test.ts`; 새 `docs/verification/mvp-integration/2026-10-04-m05a-*.md` | 제품·기존 QA/helper·계약·dependencies/lockfile/config/CI/core. M02 전/후 source hash 구분 | 기존 Chromium 24개 셸·19개 금고 QA를 재사용. 현재 미검증인 Firefox/WebKit·실제 모바일/screen reader·native Windows/OS dialog 중 지원 환경만 확인. 미지원은 BLOCKED/NOT_RUN |
| M06 / `codex/keyatlas-m06-korea-ops-followup-20261004` | 기존 한국 개인정보/운영 초안 2개; 새 `docs/privacy/mvp/2026-10-04-m06-open-decisions.md` | 앱/계약/core/API/infra/CI/LICENSE·다른 담당 기록. T1 공개 범위·운영자 결정 미정 | 기존 초안의 hosting 로그·보존/삭제·수신자·지역·비용·연락처·권리 요청·장애/rollback 미정 값을 정리. 실사 없는 준수/출시 승인 주장 금지 |
| M04A/R4A / `codex/keyatlas-m04a-independent-review-20261004` | 새 `docs/security/reviews/m04a-2026-10-04/**`만 | 모든 product/tests/정책/CI/core는 읽기 전용. 마지막 변경의 고정 hash 수령 후 리뷰 | client/time/byte/abort·HTTP authority/commit·C04 projection/state·C06 scope/TTL·새 셸 이동/잠금·R3A/R5A 설계를 검토. 파일/행 근거·조건·최소 수정 제안·미검증 기록 |

M02와 M05A는 서로 다른 파일을 쓰더라도 검사 대상이 바뀔 수 있다. QA는 변경 전/후 hash를
구분하고 마지막 보안 리뷰는 최종 트리를 고정한 뒤 진행한다. 작성자의 자체 QA를 독립
보안 승인으로 세지 않는다. M01A 공용 셸 수정 제안은 담당에게 전달하고 직접 수정하지 않는다.

C06의 pagehide/bfcache 후보·동의 정리도 이번 후속에 포함한다. M02는 이를 다시 만들지 않고,
M05A는 `verify_mail_page_lifecycle.py`의 native persisted=true와 scripted event 구분을
보존한다. M04A/R4A는 실제 cached DOM 정리와 heap erasure/실제 권한 증명의 차이를 검토한다.

## M02 복사용 프롬프트

```text
KeyAtlas M02 화면·모바일·접근성 후속을 진행해 주세요.
기준 SHA afbc0fbc4dd41669e468d8658965ef8f5f10ee7d와 주 담당이 전달한
2026-10-04-cloud-shell-source-manifest.json/patch의 hash를 먼저 대조하세요.
별도 checkout/branch codex/keyatlas-m02-ui-followup-20261004를 사용하세요.
AGENTS.md와 NEXT_ASSIGNMENTS_2026-10-04.md의 공통 제한·M02 소유 파일을 따르세요.
이미 제출/통합된 #21/#24/#26/C06·44px 버튼·초점·공통 셸을 다시 만들지 마세요.
허용된 화면 안에서 실제 모바일·screen reader·한국어/키보드의 부족분만 수정하세요.
지원 환경이 없으면 해당 검사는 NOT_RUN입니다. 인증·보안·TTL·원문 제한은 그대로 유지하세요.
공용 셸/routes/model/scanner/policy/fixture/core/HTTP/config/CI 수정은 금지합니다.
고정 의존성으로 집중 test/typecheck/build 및 실행 가능한 browser 검사를 기록하세요.
변경 파일 / 정확한 HEAD와 overlay hash / command·exit / 미검증 / 주 담당 제안을 보고하세요.
실제 데이터·외부 호출·commit/push/PR/배포·다른 채팅 전송/세션 생성은 별도 승인 전 금지입니다.
```

## M05A 복사용 프롬프트

```text
KeyAtlas M05A QA 후속입니다. 기준 SHA afbc0fbc4dd41669e468d8658965ef8f5f10ee7d와
전달받은 10/4 overlay/manifest hash를 확인하고 별도 checkout을 사용하세요.
branch는 codex/keyatlas-m05a-qa-followup-20261004를 권장합니다.
NEXT_ASSIGNMENTS_2026-10-04.md의 M05A 허용 파일만 작성하세요.
기존 verify_app_shell.py, 금고 lifecycle 및 C02/C04/C06 browser QA를 재사용하세요.
이미 통과한 기능을 새로 구현하지 말고 교차 browser·실제 모바일/screen reader·native
Windows/OS dialog의 증거 부족분 중 현재 환경에서 가능한 것만 검사하세요.
기존 Node runner BLOCKED를 Python PASS로 바꾸지 마세요. 실패 숨김·skip·무조건 retry·
assertion 삭제·보안 정책 우회·새 dependencies/lockfile/CI 변경은 금지입니다.
M02 변경 전/후 source와 build hash·정확한 command/exit를 구분하세요.
환경 미지원은 BLOCKED/NOT_RUN, 제품 문제는 재현 근거와 최소 수정 제안으로 보고하세요.
제품/helper/정책/core 수정, 실제 데이터/외부 호출·commit/push/PR/배포·세션 생성은 금지입니다.
```

## M06 복사용 프롬프트

```text
KeyAtlas M06 한국 출시·개인정보·운영 문서 후속입니다.
기준 SHA afbc0fbc4dd41669e468d8658965ef8f5f10ee7d와 전달받은 최신 overlay hash를
확인하고 별도 checkout/branch codex/keyatlas-m06-korea-ops-followup-20261004를 사용하세요.
NEXT_ASSIGNMENTS_2026-10-04.md의 M06 허용 파일만 수정하세요.
기존 docs/privacy/mvp/2026-10-03-korea-data-handling-draft.md와
docs/deployment/mvp/2026-10-03-release-operations-draft.md를 재사용하세요.
T1 합성 체험, T2 실제 Gmail, T3 실제 Secret을 구분하고 metadata/FULL 목적,
hosting 로그·수신자/지역·보존/삭제·연락처/권리 요청·incident/rollback 미정 값을 정리하세요.
운영자·계약·법률 근거가 없으면 미확정으로 남기고 준수 인증이나 배포 승인을 주장하지 마세요.
앱/core/API/infra/계약/LICENSE/다른 담당 검증 기록은 수정 금지입니다.
실제 연락·서비스 개설·유료 호출·commit/push/PR/게시/배포·세션 생성은 승인 전 금지입니다.
변경 파일 / 근거·검사 command·exit / 미확정 값 / 사용자 결정 목록을 보고하세요.
```

## M04A/R4A 복사용 프롬프트

```text
KeyAtlas M04A/R4A 독립 보안 리뷰입니다. 기준 SHA
afbc0fbc4dd41669e468d8658965ef8f5f10ee7d와 마지막 고정 overlay/manifest hash를 수령하세요.
별도 checkout/branch codex/keyatlas-m04a-independent-review-20261004를 사용하세요.
NEXT_ASSIGNMENTS_2026-10-04.md의 읽기 전용 범위·공통 제한을 따르세요.
client cancellation/time/byte 제한, HTTP authority/commit/replay, C04 state/projection,
C06 consent/scope/TTL, 공통 셸의 문서 이동/잠금, R3A/R5A 설계 경계를 검토하세요.
현재 자기 QA와 실제 환경/독립 보안 승인을 구분하세요. 제품/tests/policy/CI/core 수정 금지입니다.
새 review 문서에 파일/행 근거·위험/조건·최소 수정 제안·미검증을 기록하세요.
실제 Secret/메일/provider 호출·실제 대상 공격·보안 우회는 금지입니다.
commit/push/PR/배포·다른 채팅 전송/세션 생성도 별도 승인 전 금지입니다.
```
