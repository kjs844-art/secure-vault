# 클라우드 주 담당 배정표·복사용 프롬프트

상태: **LOCAL_DRAFT / PENDING_ISSUE30 / NOT_DISPATCHED**.
다른 채팅에 전송하거나 새 세션·sub-agent를 만들지 않았다.
Issue #30 본문·최신 결정을 받은 뒤 기준·승인 범위를 조정한다.

모든 후속 업무의 잠정 기준은 원격에 있는
`codex/firstvibe-cloud-bounded-json-20260930@afbc0fbc4dd41669e468d8658965ef8f5f10ee7d`다.
현재 문서들은 이 기준 커밋에 포함되지 않은 로컬 초안이다. 실제 배정 시 필요한 문서 본문과
해당 파일 hash 또는 새 승인된 문서 commit을 함께 전달한다. 전달되지 않은 파일은 있다고 가정하지 않는다.

M01A는 공용 타입·앱 셸·routes·HTTP·공통 설정과 R3A/R5A 설계를 소유한다.
PR #22 client와 #23 loopback/CI 제출물, 미푸시 readiness 9개 파일은 별도 대조 대상이다.
이 네 담당에게 client/loopback을 재구현하도록 배정하지 않는다.

## 배정표

아래 branch/checkout은 **제안**이다. 주 담당은 아직 생성하지 않았다.
담당자가 시작할 때 별도 clone/checkout에서 실제 HEAD·Git 상태·원격 tip을 기록한다.
변경이 있는 checkout이나 이미 사용 중인 branch를 reset/clean/force로 덮어쓰지 않는다.

| 담당 | branch / 별도 checkout 예시 | 허용 파일 | 금지 파일·선행 작업·완료 조건 |
| --- | --- | --- | --- |
| M02 후속 | `codex/firstvibe-m02-followup-kr-20260930` / `keyatlas-m02-kr-20260930` | 아래 명시한 7개 demo TSX, 새 `src/components/mvp-demo/m02-followup.css`, 새 `tests/m02-followup-*.test.ts`, `docs/verification/mvp-integration/m02-followup-20260930/**` | shared source/config·catalog-client·loopback·금고 수정 금지. 이미 이식한 #21·9/30 이력 화면을 읽고 실제 남는 UI 결함만 보완. 한국어·360px·keyboard/접근성 실제 관찰과 재현/수정 근거 제출 |
| M05A 후속 | `codex/firstvibe-m05a-followup-qa-20260930` / `keyatlas-m05a-qa-20260930` | 새 `apps/benefits-web/tests/m05a-followup-*.test.ts`, 새 `apps/benefits-web/tests/m05a-followup-browser/**`, 새 `apps/web/tests/mvp-browser/followup-20260930/**`, `docs/verification/mvp-integration/m05a-followup-20260930/**` | 기존 source·QA V2·#22/#23 파일·CI/config 금지. 기존 5-case runner를 재사용하고 fresh WASM/source 결합 먼저 확인. 이력 회귀·브라우저·B05 증거와 exit 1/2 실패 분리; 미실행 PASS 금지 |
| M06 후속 | `codex/firstvibe-m06-kr-launch-docs-20260930` / `keyatlas-m06-kr-20260930` | 새 `docs/deployment/mvp/kr-20260930/**`, 새 `docs/privacy/mvp/kr-20260930/**` | source·공용 인계·실환경/정책/config 수정 금지. #20은 배정 문서만 있으므로 한국 출시/개인정보/운영 문서가 부족분. 실제 주체·위치·가격·법률 미확정 표시, 준비/실행·실메일 gate 분리 |
| M04A/R4A | `codex/firstvibe-m04a-r4a-review-20260930` / `keyatlas-m04a-r4a-20260930` | 새 `docs/security/mvp-mail-review/followup-20260930/**`, 새 `docs/verification/real-secret-readiness/20260930/**` | 구현·테스트·CI·설정 수정 금지. 현 source 읽기 검토와 전달받은 R3A/R5A 초안 검토. #16의 원본 프로젝트 검토를 새 KeyAtlas 승인으로 재사용하지 않음. 독립 finding/잔여 위험/미검증/출시 gate 제출 |

M02의 허용 TSX는 `apps/benefits-web/src/components/mvp-demo/` 아래
`AttentionList.tsx`, `BenefitCard.tsx`, `DemoExperience.tsx`, `DemoNotice.tsx`,
`EmptyState.tsx`, `ErrorState.tsx`, `ServiceList.tsx`다.
layout/문구/접근성만 변경한다. data/provenance·이력 분류·quota·현재 잔액 의미는 M01A에 제안한다.

M02의 새 CSS는 본인이 소유한 컴포넌트에서만 import한다.
`index.ts`, 전역 `styles.css`, routes, shared lib/type/config는 허용 목록에 없다.
M05A는 M02 파일을 수정하지 않으며 찾은 source 결함은 정확한 SHA·재현 조건으로 전달한다.
R4A 결과를 주 담당의 자기 검토로 작성하거나 독립 검토 완료로 대신 표시하지 않는다.

## 공통 완료 계약

배정된 파일 안에서만 작업한다. 필요한 다른 경로는 변경안과 이유를 보고한다.
기존 submitted 코드·미푸시 코드가 전달되지 않았다면 누락이라고 기록한다.
README의 고정 설치 절차를 따르고 새 dependency/버전/lock/config 변경은 제안으로 남긴다.

모든 결과는 변경 파일, 정확한 base/HEAD 및 dirty 상태, 검사 명령·cwd·exit code,
FAIL/BLOCKED/NOT_RUN, 다른 담당 의존성 순으로 보고한다.
코드 작성·PR 제출·통합·실환경 검증·배포는 각각 별도 상태로 쓴다.
실제 실행한 검사만 PASS로 쓰며 작성자 과거 보고와 현재 재실행을 구분한다.

아래 프롬프트는 **복사용 초안**이다. 사용자의 실제 배정 승인과 자료 전달 뒤 사용한다.
commit/push/PR 승인 없이 원격 제출을 수행하지 않는다.

## ① M02 화면·모바일·접근성

```text
KeyAtlas M02 후속 화면·모바일·접근성 작업만 맡아 주세요.
Repo: https://github.com/kjs844-art/secure-vault
잠정 base: codex/firstvibe-cloud-bounded-json-20260930
정확한 SHA: afbc0fbc4dd41669e468d8658965ef8f5f10ee7d
전용 branch: codex/firstvibe-m02-followup-kr-20260930
별도 checkout 예시: keyatlas-m02-kr-20260930
시작 시 실제 HEAD, Git 상태, 원격 tip을 확인하고 다른 작업을 덮어쓰지 마세요.
Issue #30: https://github.com/kjs844-art/secure-vault/issues/30
본문/최신 결정이 전달되지 않거나 접근 불가면 요청하고 추측하지 마세요.

먼저 AGENTS.md, START_HERE.md, SESSION_HANDOFF.md, apps/benefits-web/README.md,
docs/verification/mvp-integration/2026-09-28-m02-demo-integration.md와
2026-09-30-benefit-history.md를 읽으세요. 새 주 담당 문서가 없으면 전달을 요청하세요.
#21@e19ae37872a1cb2324d4c227593fbf57f8731667 화면은 이미 선택적으로 이식됐습니다.
카드/목록/이력 기능을 다시 만들지 말고 최신 화면에서 확인한 부족분만 보완하세요.
한국어 문구, history 전환, 360px overflow, focus/keyboard, 접근성 오류를 대조하세요.

허용: apps/benefits-web/src/components/mvp-demo/의 AttentionList.tsx,
BenefitCard.tsx, DemoExperience.tsx, DemoNotice.tsx, EmptyState.tsx,
ErrorState.tsx, ServiceList.tsx; 새 m02-followup.css;
새 apps/benefits-web/tests/m02-followup-*.test.ts;
docs/verification/mvp-integration/m02-followup-20260930/**.
금지: index.ts, src/lib/**, src/domain/**, src/server/**, routes/router,
전역 styles.css, config/package/lock, apps/web/**, crates/contracts,
catalog-client 및 catalog-http-loopback, 기존 공용 handoff, CI.
분류/출처/unknown/현재 잔액 의미를 바꿀 필요가 있으면 M01A에 제안하세요.

완료: 발견한 결함의 before/after와 최소 수정, 실제 browser의 viewport·키보드·
focus·콘솔 관찰을 기록하세요. 실제 browser 실행 불가면 BLOCKED/NOT_RUN입니다.
README 고정 설치 절차와 영향에 맞는 render 회귀·typecheck·build·boundary,
저장소 Secret 검사·git diff --check의 정확한 명령/exit를 보고하세요.
새 의존성/버전/lockfile을 바꾸지 마세요.
REAL_SECRET_GATE=CLOSED, 합성 데이터만. 실제 비밀값·메일·외부 AI·OAuth·
DB/호스팅/도메인/DNS·유료 서비스·공개 배포·원본 프로젝트/DB 변경 금지.
보안/Windows 정책 우회, CI 재실행·과금 변경, main merge·force push 금지.
별도 승인 전 다른 채팅 전송·세션 생성·commit/push/PR은 하지 마세요.
최종: 변경 파일 / base·HEAD·dirty / 검사 명령·exit / 미검증 / M01A 요청.
합성 화면을 실제 Gmail 연동 또는 실사용 금고 완성으로 보고하지 마세요.
```

## ② M05A 테스트·브라우저 QA

```text
KeyAtlas M05A 후속 테스트·브라우저 QA만 맡아 주세요.
Repo: https://github.com/kjs844-art/secure-vault
잠정 base: codex/firstvibe-cloud-bounded-json-20260930
정확한 SHA: afbc0fbc4dd41669e468d8658965ef8f5f10ee7d
전용 branch: codex/firstvibe-m05a-followup-qa-20260930
별도 checkout 예시: keyatlas-m05a-qa-20260930
시작 시 실제 HEAD, Git 상태, 원격 tip을 기록하고 다른 작업을 보존하세요.
Issue #30: https://github.com/kjs844-art/secure-vault/issues/30
접근 불가/본문 누락 시 요청하고 최신 결정·권한을 추측하지 마세요.
AGENTS.md, START_HERE.md, SESSION_HANDOFF.md, 두 앱 README,
apps/web/tests/mvp-browser/README.md, 2026-09-29-m05-qa-tooling.md,
2026-09-30-benefit-history.md, 2026-09-30-cloud-bounded-json.md를 읽으세요.
새 주 담당 문서·로컬 자료가 없으면 전달받았다고 가정하지 마세요.

#18@e6e5700d5931a1ce37f93f83049e5cc145e46021의 오래된 harness를 다시 이식하지 마세요.
현 기준의 QA V2는 이미 fail/blocked exit와 cleanup을 보완했습니다.
기존 5-case runner/offline 검사를 재사용하고 이번 source의 실제 browser 실행,
혜택 이력 6→2→6·unknown/0·Asia/Seoul·과거 잔액·SSR/hydration·모바일을 검사하세요.
B05는 실제 합성 파일 다운로드 후 새 profile의 파일 선택으로 복원하고
파일 hash·상태 보존을 검증하세요. Blob/File 주입만으로 disk 왕복 PASS 금지.
기존 WASM이 이번 source에서 생성됐는지 확인하고 지원되는 절차로 생성/검사하세요.
생성/Playwright/브라우저가 준비 안 됐으면 BLOCKED, Windows 정책 우회 금지.

허용: 새 apps/benefits-web/tests/m05a-followup-*.test.ts,
새 apps/benefits-web/tests/m05a-followup-browser/**,
새 apps/web/tests/mvp-browser/followup-20260930/**,
docs/verification/mvp-integration/m05a-followup-20260930/**.
금지: 기존 app source, QA V2 원본, catalog-client, catalog-http-loopback
및 support/catalog-http-loopback.ts, bounded-json.test.ts, CI/scripts,
공용 handoff, config/package/lock, Rust/bridge/worker/contracts.
#22/#23과 미푸시 readiness 9개 파일은 M01A가 대조하므로 재구현하지 마세요.
source 결함은 SHA와 재현 조건을 보고하고 담당 파일 밖 수정은 제안만 하세요.

완료: browser/Node/tool 버전, source HEAD·dirty, 실제 server/bundle의 source 결합,
케이스별 필수 assertion·exit, cleanup·격리 profile·합성 screenshot 증거를 남기세요.
FAIL=실패, BLOCKED/NOT_RUN=미검증. skip/무조건 retry/assertion 삭제로 숨기지 마세요.
정확한 명령/cwd/exit와 전체 검사·집중 검사 차이, raw 자료 전달 여부를 보고하세요.
README 고정 의존성 설치를 따르고 새 dependency/버전/lockfile은 바꾸지 마세요.
REAL_SECRET_GATE=CLOSED. 실제 비밀값·메일·외부 서비스·유료/공개 배포·원본 DB 금지.
DB/호스팅/도메인/DNS·OAuth 연결, CI 재실행·과금 변경·보안 완화 금지.
main merge·force push, 별도 승인 전 다른 채팅 전송·새 세션·commit/push/PR 금지.
최종: 변경 파일 / base·HEAD·dirty / 검사 명령·exit / 미검증 / M01A 의존성.
합성 browser/loopback 성공과 실제 Gmail·DB·Secret 검증·배포를 구분하세요.
```

## ③ M06 한국 출시·개인정보·운영 문서

```text
KeyAtlas M06 후속 한국 출시·개인정보·운영 문서만 맡아 주세요.
Repo: https://github.com/kjs844-art/secure-vault
잠정 base: codex/firstvibe-cloud-bounded-json-20260930
정확한 SHA: afbc0fbc4dd41669e468d8658965ef8f5f10ee7d
전용 branch: codex/firstvibe-m06-kr-launch-docs-20260930
별도 checkout 예시: keyatlas-m06-kr-20260930
실제 HEAD·Git 상태·원격 tip 확인, 다른 branch/작업 덮어쓰기 금지.
Issue #30: https://github.com/kjs844-art/secure-vault/issues/30
본문·최신 승인/출시 범위가 없으면 요청하고 추측하지 마세요.
AGENTS.md, START_HERE.md, SESSION_HANDOFF.md, TWO_WEEK_PLAN.md,
INTEGRATION_BOUNDARY.md, REAL_SECRET_AND_BENEFIT_DELIVERY.md,
두 앱 README를 읽고 전달받은 PROVIDER_ADAPTER_PLAN.md를 대조하세요.
계획 파일이 없으면 내용을 인계받았다고 가정하지 마세요.
#20@e032e49593d64c4917aedaa89454fcace264a202는 M06 배정 문서만 제출했습니다.
운영 준비·개인정보 문서가 이번 부족분입니다. 앱 기능을 재구현하지 마세요.

허용: 새 docs/deployment/mvp/kr-20260930/**,
새 docs/privacy/mvp/kr-20260930/**만.
금지: 앱/core/contracts/CI/config/package/lock, 기존 공용 handoff,
원본 benefit-validator/Lovable 프로젝트/DB, 실제 환경/계정/설정 변경.
한국 운영·사용자 우선의 작은 합성 RC 체크리스트, 향후 Gmail MVP 준비,
수집 항목·목적·최소화·보존/삭제·철회·국외 이전/수탁·사고 대응을 초안으로 만드세요.
사업자/연락처·저장 지역·제공자·법률·비용은 미확정이면 미확정으로 남기세요.
공식 자료 URL·확인 날짜와 미검증을 구분하고 법률 준수 확정으로 표현하지 마세요.
main의 새 AGPL-3.0@65d10dceb13039dc69cf2368aa0e31d7ad5cc6b2를 운영 검토 대상으로
기록하되 license/source merge나 법적 결론을 임의로 실행하지 마세요.

완료: 준비→실환경 검증→독립 리뷰→사용자 승인→배포의 단계별 gate,
운영 책임·release/rollback·삭제/복구·문의/사고 runbook과 사용자 결정 표.
Gmail 동의/scope·처리·철회·삭제·검증 계획을 M01A 설계와 대조하세요.
실제 source 기준과 문서 링크/Secret 검사·git diff --check 명령/exit를 보고하세요.
문서만 변경하면 앱 테스트를 실행했다고 쓰지 마세요.
REAL_SECRET_GATE=CLOSED. 실제 비밀값·메일·Gmail/외부 AI·유료 호출 금지.
DB/호스팅/도메인/DNS·계정 생성·공개 배포는 사용자 재개 전 보류.
보안/Windows 정책 완화, CI 재실행·결제/한도 변경, main merge·force push 금지.
별도 승인 전 다른 채팅 전송·새 세션·commit/push/PR은 하지 마세요.
최종: 변경 파일 / base·HEAD·dirty / 검사 명령·exit / 미검증 / 사용자 결정.
합성 데모를 실제 Gmail 연동·실사용 금고 완성으로 표시하지 마세요.
```

## ④ M04A/R4A 독립 보안 리뷰

```text
KeyAtlas M04A/R4A 독립 보안 리뷰만 맡아 주세요. 구현 코드는 읽기 전용입니다.
Repo: https://github.com/kjs844-art/secure-vault
잠정 source base: codex/firstvibe-cloud-bounded-json-20260930
정확한 SHA: afbc0fbc4dd41669e468d8658965ef8f5f10ee7d
전용 branch: codex/firstvibe-m04a-r4a-review-20260930
별도 checkout 예시: keyatlas-m04a-r4a-20260930
시작 시 HEAD·Git 상태·원격 tip과 검토 대상 파일/hash를 고정하세요.
Issue #30: https://github.com/kjs844-art/secure-vault/issues/30
본문/최신 승인이 없으면 요청하고 추측하지 마세요.
AGENTS.md, SECURITY.md, SECURITY_ARCHITECTURE.md, START_HERE.md,
SESSION_HANDOFF.md, REAL_SECRET_AND_BENEFIT_DELIVERY.md, ADR 0004/0005,
apps/benefits-web/HTTP_CONTRACT.md와 MAIL_CONTRACT.md를 읽으세요.
M01A가 전달한 REAL_SECRET_CORE_PLAN.md와 PROVIDER_ADAPTER_PLAN.md는
로컬 설계 초안이므로 파일 hash/전달 여부를 따로 기록하세요. 없으면 설계 리뷰 NOT_RUN입니다.
#16@08c40b1d194ab92ca1b3cabbc069336ac51ad69e는 원본 benefit-validator 검토입니다.
그 결과를 새 KeyAtlas source나 최신 설계의 독립 통과로 재사용하지 마세요.

허용: 새 docs/security/mvp-mail-review/followup-20260930/**,
새 docs/verification/real-secret-readiness/20260930/**만.
금지: source/tests/core/bridge/worker/contracts/CI/config/manifest/lock 수정,
원본 프로젝트/DB 접근·변경, 실제 Secret/메일·외부 provider 호출.
현재 catalog/mail/review 경계의 세션/소유권·bounded read·quota/transaction·
미신뢰 메일/AI 지시·출처/현재 상태 오인·삭제/철회·정보 노출을 읽기 검토하세요.
R3A 설계의 재인증 행위 결합·epoch/revision·잠금/만료/늦은 결과·평문 sink·
clipboard 한계·복구/rollback/누락 anchor·same-origin 격리를 검토하세요.
R5A는 design-only이고 auth/DB/Gmail/config 연결 승인은 아직 확인되지 않았습니다.
독립 암호/플랫폼 실검증이 필요한 부분은 문서 리뷰 PASS로 대체하지 마세요.

완료: 범위·정확한 SHA/hash·finding의 근거/영향/최소 수정 제안,
재검증 필요 대상·잔여 위험·실행하지 않은 검사·실제 Secret/Gmail 출시 gate를 제출하세요.
본인이 작성한 구현의 자기 검토는 독립 승인으로 세지 마세요.
SECURITY.md에 따라 민감 finding·재현 상세는 합의된 비공개 채널에 전달하고
공개 Issue/PR 본문에는 올리지 마세요. 공개용 문서에는 정제된 상태/승인 필요만 남기세요.
실제 수행한 검사·명령·exit와 static review/NOT_RUN/BLOCKED를 구분하세요.
REAL_SECRET_GATE=CLOSED, 합성 자료만. 유료·공개 배포·환경 생성/연결 금지.
보안/Windows 정책 우회, CI 재실행·과금 변경·main merge·force push 금지.
별도 승인 전 다른 채팅 전송·새 세션·commit/push/PR은 하지 마세요.
최종: 변경 파일 / source SHA·설계 hash / 검사 명령·exit / 미검증 / gate·M01A 요청.
```
