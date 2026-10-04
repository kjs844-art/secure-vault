# KeyAtlas 완료 범위·잔여 작업·서비스 출시 추정

평가일: 2026-10-03. 상태: LOCAL_REVIEW_DRAFT / 합성 데이터 전용.
사용자의 수정·지속 작업 요청으로 PR #22 client 보완, #23 합성 HTTP QA,
#24 관계 화면, #26 가입 흔적 검토, KA-C06 합성 메일 탐색의 선택 통합과 이 평가 문서를 작성했다.
commit/push/PR 생성/merge와 실환경 연결·배포 보류는 유지했다.
`REAL_SECRET_GATE=CLOSED`.

## 근거와 기준

- 이번 checkout: `/workspace/secure-vault`.
- 작업 branch: `codex/firstvibe-cloud-catalog-client-fix-20261003`.
- HEAD 및 수정 전 기준: `afbc0fbc4dd41669e468d8658965ef8f5f10ee7d`.
- 원격 main 관찰값: `65d10dceb13039dc69cf2368aa0e31d7ad5cc6b2`.
- PR #22 원격 head: `3230b1ae6fa9b062f1804c04e8439a9a99f14575`.
- PR #23 원격 head: `11591798c2f771691804cf52413bc9d454f2d0d7`.
- PR #24 원격 head: `34f81d62ca1b7bf880fddaaf662f14387049c305`.
- PR #26 원격 head: `d017a9da5969ae2cd723eb72cbd56ef08e63fb0f`.
- KA-C06 원격 tip: `117a8f151615c181549432de8800a65e902baf8d`.
- PR #29 원격 head: `afbc0fbc4dd41669e468d8658965ef8f5f10ee7d`.
- Issue #30의 근거는 사용자가 전달한 본문이다. live API 조회는 Forbidden이어서
  이후 댓글·PR OPEN/MERGED 상태·최신 CI 결과는 확인하지 못했다.
- 로컬 readiness branch의 미푸시 9개 파일은 **NOT_RECEIVED**다.
  이번 변경이 그 파일과 통합됐거나 중복이 없다고 단정하지 않는다.

근거 문서는 [MVP](../../MVP.md), [시작점](START_HERE.md),
[인계](SESSION_HANDOFF.md), [실제 Secret·provider 승인 경계](REAL_SECRET_AND_BENEFIT_DELIVERY.md),
[benefits README](../../../apps/benefits-web/README.md),
[HTTP 계약](../../../apps/benefits-web/HTTP_CONTRACT.md)이다.
기존 9/30 미추적 문서 중 배정·cloud 인계·검토 기록 3개는 그대로 보존했다.
provider/실제 Secret 설계 초안 2개는 전달받은 Issue 승인 경계와 현재 port 대응을 반영했다.
보존 문서의 `PENDING_ISSUE30` 표기는 작성 당시 이력이다. 현재 판단은 전달받은 Issue
본문과 [최근 통합 검증](../../verification/mvp-integration/2026-10-03-cloud-discovery-integration.md)을 따른다.

## 무엇이 완료됐는가

여기서 '구현·검증'은 해당 소스와 합성 검사 범위를 뜻한다.
코드 작성, 로컬 검사, PR 제출, main 통합, 실환경 검증, 배포는 별도 단계다.

| 영역 | 확인된 완료 범위 | 남은 경계 |
| --- | --- | --- |
| benefits 체험 화면 | 홈/demo/status SSR, 4개 서비스와 현재 6개·지난 기록 2개 혜택, unknown/0·출처·기준시각 구분. 기존 PR #21 UI를 선별 재사용 | 합성 fixture 화면. 실제 계정·메일·저장 연결 없음. 공개 문구·접근성·운영 최종 검토 필요 |
| 메일 분석 내부 로직 | 합성 Gmail FULL 정규화, bounded 후보 검증, 주입형 auth/consent/quota/mail/analyzer runner와 취소·권한 변경 처리 | 실제 OAuth·Gmail·AI adapter, token 관리, 실환경 오류·철회 검사 없음 |
| 후보 검토·서비스 목록 | inbox staging/list/discard, preview/confirm/delete, catalog CRUD/list, revision/CAS/operation replay, 화면용 decoder/reducer | 메모리 테스트 adapter만 있음. 실제 DB·RLS·transaction·계정 삭제·UI scope 연결 필요 |
| HTTP 경계 | 내부 catalog Fetch handler, 요청 byte/time 제한, session/admission/deadline 검사와 고정 오류. #29 reader fixture 보완 포함 | 공개 `/api/catalog/**`는 503. 실제 session·공유 limiter·DB·proxy 환경 미연결 |
| 이번 client 보완 | #22의 기존 4개 모듈·12개 검사를 재사용. streaming body 제한, deadline, caller abort, 정리 동작 보완. 집중 30개 및 #23 실제 합성 HTTP 연결 16개 검사 PASS | 전용 branch의 미커밋 변경. PR 제출/main 통합 안 됨. 실제 UI·인증 문맥 연결과 provider E2E는 남음 |
| 계정·연결 관계 화면 | #24 model/UI 재사용, 독립 화면 및 열린 합성 금고에 연결. 누락/빈 계정 구분과 단계 초점 보완. desktop/360px·Enter/Tab/Escape·잠금 제거·재열기 확인 | 실제 계정/메일 자동 발견 아님. 다른 합성 slice 통합, screen reader/실제 모바일·독립 리뷰는 남음 |
| 가입 흔적 검토 | #26의 기존 model/UI/fixture를 재사용해 독립 합성 화면으로 연결. 동작을 되돌리던 state/seed 오류·불필요한 원문 필드 복사·검토 후 초점을 보완 | 고정 예제만 표시. C06 결과나 서버 근거를 저장·연결하지 않음. 실제 가입·소유권 증명 아님 |
| 합성 메일 탐색 | 기존 KA-C06 13개 파일 선택 재사용, 앱 링크·한국시간·키보드/만료 초점 보완. 기존 99개 검사와 Chromium standalone/앱 진입 검사 | scope/scanner/5분 제한은 원본 그대로. Gmail 연결·실제 OAuth·공유 저장·C04 자동 전달 없음 |
| 한국 운영·R5A 준비 | 개인정보/보존·삭제 및 출시/장애/rollback 초안, metadata와 FULL 분석 목적별 승인·acceptance 표 작성 | 법률/독립 보안 승인·운영자/지역/비용 확정·실환경 검증 아님 |
| 합성 금고 | Rust 암호화·암호문 SQLite, Worker/WASM·IndexedDB, 닫힌 등록·편집/CAS·충돌 보존·잠금·합성 백업·회전 기반 | 실제 Secret 입력·보기·복사·복구·rollback anchor·기기 철회·동기화의 출시 조건 미완료 |
| 검사 도구 | Secret 검사, 경계·SSR smoke, 합성 QA V2와 문서/manifest 도구의 재사용 근거 존재 | 전체 운영 보안 승인이나 모든 브라우저·Windows 증거로 대체할 수 없음 |

최신 직접 검사: benefits 1,354/1,354, client→HTTP 16개 × 3회, bounded reader 25/25,
관계 화면 집중 및 기존 안내 26/26(앞선 검사), 금고 웹 1,823/1,823, 두 앱 build/typecheck와
benefits boundaries/smoke PASS. 앞선 client 30개 × 5회·Chromium client 8개 근거도 보존했다.
고정 offline 의존성으로 기본/합성 WASM을 새로 build하고 debug/release smoke를 통과했다.
실제 Chromium에서 S1–S5와 디스크 파일 다운로드→새 profile 복원·재시작 B05를 확인했다.
OS 파일 dialog의 수동 조작, 기존 Node browser runner 자체, 전체 접근성 인증은 미검증이다.
후속 C04 browser 3개, C06 standalone/앱 진입 각 12개, 관계 화면 browser 3개를
현재 production build에서 검사했다. C06 취소·선택 preview·동의·분류·5분 만료와
사라지는 컨트롤의 초점 복원/유지, 한국시간·360px·원문 비표시·browser 저장소 미생성을 포함한다.
자동화된 Chromium 검사이며 실제 모바일 기기·screen reader 인증은 아니다.

Rust workspace verifier는 여전히 **FAIL / exit 101**이다. 기존 Linux Clippy 경고는
Windows 전용 컴파일 조건만 좁혀 해결했고, warning 금지 정책을 유지한 전체 Clippy가 통과했다.
이어진 SQLite 기본 테스트는 Linux에서 **30 PASS / 19 FAIL / 기존 1 ignored**이며,
Windows 전용 UnsupportedPlatform 경로와 crash-child readiness 실패를 기준 SHA에서도 재현했다.
검사를 skip하거나 filesystem 신뢰·storage/crypto 정책을 바꾸지 않았다. 후속 단계는 별도
실행해 Linux VFS 일반 검사 2개·workspace doctest 11개·SQLite API compile-fail 경계 6개가
통과했다. verifier 전체가 통과한 것은 아니며, native Windows runtime 검사는 **NOT_RUN**이다.
Secret scanner regression은 Windows junction 준비 단계에서 exit 1(앞선 100개 PASS),
보안 workflow의 Pester 검사는 모듈 미설치로 BLOCKED다. 실제 저장소 Secret scan은 PASS다.
정확한 최신 명령·exit와 collector 실패 이력은
[후속 검증 기록](../../verification/mvp-integration/2026-10-03-cloud-continuation.md),
[현재 C04/C06·후속 검사](../../verification/mvp-integration/2026-10-03-cloud-discovery-integration.md),
앞선 client 보완은 [기존 검증 기록](../../verification/mvp-integration/2026-10-03-cloud-catalog-client.md)에 있다.

2026-10-03 추가 지속 작업에서는 금고 등록/잠금, 충돌 검토, backup, 진행 불러오기 때
사라지는 foreground 키보드 초점을 재현·보완했다. 실제 두 탭 등록 overlap·8개 conflict
outbox와 9번째 거부·미해결 후보의 backup 차단·두 단계 폐기·native URL 해제·파일 크기/
형식 거부·기존 암호문 보존을 직접 확인했다. 등록한 v2 archive의 실제 disk 다운로드→
fresh owned profile/FileChooser→복원→browser 재시작도 byte equality로 확인했다.
합성 교체 진행은 새로고침 후 재검토와 새 동의가 필요하며 선택 변경 뒤 확정이 차단됐다.
모바일 버튼은 25/34.72px에서 최소 44px로 보완했고 hydration/키보드/지난 기록/serverFn/
storage·cookie 부재를 실제 browser에서 검사했다. 두 앱 전체 test/typecheck/build와
benefits boundaries/smoke는 보완 뒤에도 PASS다.

실제 시간과 가속 시계 fixture는 별도다. 실제 시간 검사에서 5분 잠금·trusted 입력의
갱신·untrusted 입력의 갱신 차단, backup URL/File 정리를 확인했다. 가속 시계의 준비 시간을
고정하는 fixture 보완은 5분 정책 변경이 아니다. 최신 전체 browser 묶음/보존/Secret/manifest
검사는 [추가 검증 기록](../../verification/mvp-integration/2026-10-03-cloud-lifecycle-qa.md)의
완료 상태를 따른다. 이전 39개 source manifest는 당시 이력으로 남긴다.

## 기존 제출물을 어떻게 사용할 것인가

| 제출물 | 현재 판단과 다음 행동 |
| --- | --- |
| #4 / #6 | 타입 pin과 task 지도는 이미 반영. branch 수·배정 수를 제품 완료율로 세지 않음 |
| #5 / #8 / #9 / #13 | UI 도구·공식 provider metadata·manifest·release 문서가 재사용 후보. 일부 집중 검증 근거가 있지만 현재 앱 통합 전체 완료 아님 |
| #16 / #19 / #21 | 원본 프로젝트 보안 검토, 합성 통합, 선택 이식 UI가 있음. 원본 보안 검토를 새 KeyAtlas 독립 승인으로 재사용하지 않음 |
| #17 / #18 | 기존 연결 참조·QA 개념은 V2 후속과 비교해 필요한 부분만 사용. 과거 브라우저 미실행을 PASS로 승격하지 않음 |
| #20 | 한국 운영/개인정보 배정 문서를 활용해 이번 세션에서 초안 2개 작성. 실제 운영/법률 검토·연락처·지역/보존 값 확정은 남음 |
| #22 | 이번 cloud에서 client 부족분을 보완. 기존 PR의 보완안이며 새 중복 PR은 만들지 않았음 |
| #23 | QA 파일 2개만 선택 재사용·수명 정리 보완. client 연결 5개를 더해 16개 × 3 통과. CI helper/정책 이식 없음. 실제 provider 검증은 아님 |
| #24 KA-C02 | 관계 화면 6개 파일과 최소 셸 연결을 선택 통합. model/키보드 부족분 보완 및 실제 합성 browser 확인. 원격/배포 통합은 아직 없음 |
| #26 KA-C04 | 6개 기존 파일 선택 재사용·앱 연결, state/필드 projection 보완과 재현·browser QA 완료. 합성 예시로 제한, 실제 메일 후보 연결은 남음 |
| #25 KA-D01 / #27 KA-C03 | 상태 계약 읽기 검토. #27이 #25를 포함해 중복 적용 금지. C03 CBOR 요소 수 불일치·D01 문서 의미 차이와 최소안을 [별도 기록](DOMAIN_CONTRACT_REVIEW_2026-10-03.md). core/wire 변경은 승인 전 보류. 실제 소셜 로그인 아님 |
| KA-C06 별도 branch | 기존 `117a8f151615c181549432de8800a65e902baf8d` slice를 현재 앱에 선택 통합·합성 검사. 이번 변경은 미커밋이며 실제 Gmail 연결은 남음 |
| #29 | bounded-json fixture 보완은 현재 기준에 포함. server reader 정책은 그대로. 최신 CI/원격 merge는 별도 확인 필요 |

Git head와 원격 ref를 확인한 것만으로 PR merge나 CI PASS를 판정하지 않았다.
추가 read-only Git 조회에서도 위 PR head와 main/history SHA는 같았다. #6/#19/#29 head는
cloud HEAD의 조상이지만 관찰한 main의 조상은 아니었다. 다른 PR의 조상 여부만으로
squash/선택 이식·OPEN/MERGED 상태를 추론하지 않는다.

소유 파일 전달용 patch는 exact `afbc0fbc…` archive에서 적용·복원한 70개 hash가 일치했다.
관찰 main `65d10dce…` archive의 `git apply --check --whitespace=error`는 exit 1이었다.
main에는 benefits/로컬 금고 앱 등 patch가 전제하는 source가 없으며 web README도 다르다.
이 검사는 별도 임시 폴더의 적용 가능성 확인이고 main merge가 아니다. 이번 overlay를
main에 바로 적용하거나 main 통합 검증 완료로 보고하지 않는다. 기존 합성 기반의 승인된
승격/통합 경로와 main의 LICENSE를 먼저 대조해야 한다.

## 이제 해야 할 일과 순서

1. **통합 기준 확정:** 로컬 9개 파일의 경로/diff/검사한 SHA를 받아 이번 client 보완 및
   #23 QA와 비교한다. 소유 파일만 검토하고 게시 권한이 확인된 뒤 commit 기준을 확정한다.
   기존 main/각 PR 관계를 정리하고 정확한 변경 SHA에 필요한 공통 검사·CI evidence를 확보한다.
2. **T1 합성 체험판:** 기존 화면의 한국어 문구·모바일·키보드·접근성·데모 표시를 마무리한다.
   [한국 데이터 처리 초안](../../privacy/mvp/2026-10-03-korea-data-handling-draft.md)과
   [출시/운영 초안](../../deployment/mvp/2026-10-03-release-operations-draft.md)을 검토한다.
   공개 개인정보 수집 없음이라는 목표는 frontend뿐 아니라 hosting access log·analytics·
   오류 수집 정책도 검토해야 한다. 한국 운영 연락처·개인정보 안내·지원·장애 대응·rollback을 준비한다.
   사용자가 환경/배포를 재개한 뒤 staging과 실제 배포를 별도로 검증한다.
3. **T2 실제 Gmail MVP:** [목적별 R5A 승인 표](R5A_PURPOSE_AND_ACCEPTANCE_2026-10-03.md)로
   metadata 가입 탐색과 FULL 혜택 분석의 첫 베타 범위를 결정한다. 권한/세션/동의 → DB 소유권·
   원자 transaction·삭제 → 최소 Gmail scope와 token 보관/갱신/철회 → 실제 사용자 확인 흐름과
   오류·quota·재시도 → 실환경 E2E·운영 훈련 순으로 진행한다. 외부 AI를 쓸 경우 처리 데이터·
   공급자·비용을 별도로 정한다. 테스트 adapter를 운영 adapter로 사용하지 않는다.
   [원자 저장·철회·삭제 설계](R5A_TRANSACTION_AND_DELETION_DESIGN_2026-10-03.md)의 실제
   DB 권한 직렬화·엄격한 commit deadline 증거·Unknown/replay·fingerprint 보존·삭제 fence를
   먼저 확인한다. app의 마지막 시각 확인이나 HTTP timeout만으로 실제 DB rollback을 보증하지 않는다.
   [authority/OAuth 설계](R5A_AUTHORITY_AND_OAUTH_DESIGN_2026-10-03.md)의 앱 로그인·Gmail grant·
   실제 금고 권한 분리, callback correlation·로그아웃/전환 뒤 늦은 결과·refresh/cleanup을 함께 검토한다.
4. **T3 실제 Secret 제한 베타:** R3A ADR·독립 암호/보안 검토와 구현 범위를 먼저 확정한다.
   실제 입력·재인증 행위 권한·노출 수명·복구/철회·rollback/누락 anchor·기기/플랫폼·
   백업 복구 훈련 증거를 갖춘 뒤 별도 출시 판정을 한다. 현재 gate는 계속 CLOSED다.
5. **T4 전체 제품:** 웹·Android·실제 Secret·다중 기기 동기화·전체 운영을 완성한다.
   `apps/android`와 `services/api`는 현재 실행 가능한 앱이 없는 scaffold이므로 신규 구현 공수가 크다.

첫 2주는 1~2번의 코드/검증 후보와 3번의 승인 가능한 설계·연결 준비를 목표로 한다.
이를 2주 안에 실제 Gmail·금고 전체가 완료된다는 약속으로 읽지 않는다.

## 배포까지 얼마나 걸리는가

다음 수치는 남은 작업을 바탕으로 한 **계획 추정**이며 납기 확약이 아니다.
개발·QA 지원을 포함한 숙련 인력 2명, 주 5일, 실효 개발 capacity 약 1.5명(주 7.5 엔지니어일),
별도 독립 리뷰 가용성을 전제한다. AI 채팅 수를 같은 수의 개발 인력으로 계산하지 않는다.
승인·계정 준비·Google 심사·외부 평가·비용 결정 대기는 공수 계산 밖이다.
현재 그 실행이 보류되어 있어 달력상 배포일은 아직 정할 수 없다.

| 단계 | 남은 작업량/계획 기간 | 완료로 판정할 결과 |
| --- | --- | --- |
| T1 공개 합성 체험판 | 약 6~11 엔지니어일, 환경 재개 후 **1~2주 + 승인 대기** | 합성 표시·접근성·운영 문서·staging/production 확인, 실제 연결 없음 |
| T2 실제 Gmail 초대형 베타 | 아래 약 39~66 엔지니어일, **6~10주 + Google 등 외부 대기** | 실제 승인된 사용자 Gmail → 후보 → 검토 → 저장/조회/삭제, 철회·quota·오류·운영 E2E |
| T3 실제 Secret 제한 베타 | ADR/대상 플랫폼 확정 후 재산정. 초기 계획 범위 **3~6+개월** | 실제 Secret gate를 별도 심사로 열 수 있는 복구·기기·노출·독립 검토 증거 |
| T4 전체 제품 | 현재 전체 MVP 범위의 보수적 계획 **6~12+개월** | 웹/Android/동기화/복구/금고와 Gmail·운영이 연결된 제품. 단계별 재산정 필요 |

T3/T4 수치는 오늘부터 단순히 T2 뒤에 더하는 확정 기간이 아니다. 설계·구현·리뷰 일부는
병렬화할 수 있지만, 실제 Secret 출시 gate와 provider 승인은 선행 조건이다.
Issue의 T2 4~8주·T4 3~6+개월은 원래의 낙관적 목표다. 이번 추정에서는 미연결 adapter,
운영/개인정보 준비, 모바일/동기화 scaffold, 미검증 복구·독립 리뷰를 반영해 여유를 늘렸다.
웹 Gmail에 집중하고 인력이 충분하며 승인·심사가 순조로우면 원래 목표에 가까워질 수 있다.

T1의 6~11일 계산은 아래처럼 나눈다. 현재 소유 파일의 합성 구현/자동화는 재사용하며,
이미 통과한 기능을 다시 만드는 공수가 아니다. 공개할 앱 범위를 줄이면 다시 계산한다.

| T1 남은 작업 | 엔지니어일 | 완료에 필요한 입력/증거 |
| --- | ---: | --- |
| 기존 기반/overlay·로컬 9개 대조와 후보 고정 | 2~4 | 누락 자료 수령, 기존 PR 관계와 main/LICENSE 대조, 승인된 게시/통합 경로 |
| 한국어·실제 모바일/접근성·지원 범위 마무리 | 1~2 | 현재 44px/키보드 QA 재사용, 기기/screen reader 및 독립 부족분 |
| T1 개인정보·운영/지원·수집 정책 확정 | 1~2 | 운영자/문의처·hosting 로그·지역/보존·소스 제공 고지 결정 |
| 승인된 환경 준비·staging/production·rollback 확인 | 2~3 | 별도 환경/배포 재개, exact artifact/config·URL와 실제 검사 |
| **합계** | **6~11** | 현재 환경·게시·배포 보류. 실행 완료 아님 |

같은 실효 인력으로 `6~11 ÷ 7.5 = 약 0.8~1.5 개발 주`이고, 순차 검토/승격 여유를 포함해
1~2주로 계획한다. 미수령 코드의 큰 충돌·지원 브라우저 변경·라이선스/보안 미해결이 발견되면
재산정한다. 독립 리뷰 가용성이나 사용자/외부 승인 대기를 0일이라고 가정하지 않는다.

T2 작업량의 계산은 다음과 같다. 항목 간 UI/검사 중복을 줄여 범위를 나눴다.

| 작업 묶음 | 엔지니어일 | 선행 조건 |
| --- | ---: | --- |
| 기존 PR·로컬 9개 비교, 공용 타입/client/HTTP 통합 | 4~7 | 누락 자료·고정 기준 SHA |
| authority: 인증·세션·동의·CSRF·철회 | 5~8 | R5A-1 설계/구현 범위 승인 |
| persistence: 소유권/RLS·원자 quota/CAS/operation·삭제 | 6~10 | R5A-2 승인과 별도 DB 대상 결정 |
| Gmail adapter: OAuth·scope/token·갱신/철회·bounded mail·provider 오류 | 7~12 | R5A-3 승인·Google 설정/심사 조건 |
| UI 실제 흐름: 서비스·후보·검토·저장·삭제·scope 전환 | 5~8 | 앞의 계약과 adapter |
| 한국 운영/개인정보·deployment/monitoring/rollback 준비 | 5~9 | 운영 주체·지역·공급자·비용 결정 |
| QA·독립 검토 대응·실환경 회귀/복구 훈련 | 7~12 | 고정 통합 SHA와 검토 인력 |
| **합계** | **39~66** | 실제 provider/배포 실행은 아직 보류 |

`39~66 ÷ 7.5 = 약 5.2~8.8 개발 주`에 순차 통합·수정 여유를 두어 6~10주로 잡았다.
한 명이 전부 맡는다면 `39~66 ÷ 5 = 약 7.8~13.2주`이며, 운영/통합 여유를 포함한
**10~16주 + 외부 대기**를 계획하는 편이 낫다. 실제 메일 처리에 필요한 Google 검증·
추가 평가의 조건과 기간은 scope/배포 방식에 따라 확인해야 하므로 고정 주수를 약속하지 않는다.

## 담당과 사용자 결정

| 담당 | 다음 부족분 | 파일 소유와 시작 조건 |
| --- | --- | --- |
| M01A / 이 세션 | PR/로컬 9개 대조, 공용 타입·셸·routes·HTTP·공통 설정의 검토/통합 | 현재 client/HTTP QA/관계 화면/최소 셸·cfg 보완은 이 세션 소유. 실제 R3A/R5A 구현은 별도 승인된 manifest 필요 |
| M02 후속 | 기존 화면의 한국어·모바일·접근성 보완 | `src/components/mvp-demo/**` 및 승인된 identity-map view/style/colocated tests. 공용 셸/routes/config/server·model/session/worker는 주 담당. 기존 #21/#24 재구현 금지 |
| M05A 후속 | browser QA, scope/취소·실패·삭제·복구 증거 | 새 전용 QA/검증 파일. product source·CI·공용 helper 변경은 제안으로 전달. 현재 B05 자동 디스크 파일 근거 보존, 수동 OS dialog/native Windows/다른 browser 보완 |
| M06 후속 | 한국 개인정보·운영·release 문서 | 새 `docs/deployment/mvp/**`, `docs/privacy/mvp/**` 초안. 실제 계약/지역/법률 판단은 미확정으로 표시 |
| M04A/R4A | 현재 경계·R3A/R5A 설계의 독립 검토 | source 읽기 전용, 별도 security/verification 문서. 자기 구현을 독립 PASS로 세지 않음 |

위 표는 배정 초안이다. 다른 채팅에 메시지를 보내거나 새 세션을 만들지 않았다.
각 담당의 exact 기준·별도 branch·허용/금지 파일·선행 조건·복사용 prompt는
[후속 배정 초안](NEXT_ASSIGNMENTS_2026-10-03.md)에 있다.
현재 HEAD만 checkout하면 이번 미커밋 client·QA·화면 보완은 포함되지 않는다. 병렬 구현 시작 전
게시를 승인받은 exact commit 또는 소유 파일 patch/hash manifest를 전달해 기준을 확정해야 한다.

사용자 결정이 필요한 것은 T1 우선 출시 여부, T2 최소 범위/분석 공급자, 운영 주체·지역·비용,
R3A/R5A 설계 후 구현 승인, commit/push/PR 및 다른 AI 실제 배정, 환경/배포 재개 시점이다.
이번 추정은 이 결정을 대신 실행하지 않는다.
