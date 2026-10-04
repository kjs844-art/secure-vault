# KeyAtlas 클라우드 주 담당 인계 — 2026-09-30

상태: **LOCAL_DRAFT / PENDING_ISSUE30 / NOT_DISPATCHED**.
사용자의 2026-09-30 요청에 따라 이 클라우드 세션이 M01A 개발 통합·보안 설계의 주 담당이다.
기존 문서는 당시 이력으로 보존한다. 다른 세션의 미커밋 코드를 인계받았다는 뜻은 아니다.

- 저장소: https://github.com/kjs844-art/secure-vault
- 최신 계획의 확인 대상: https://github.com/kjs844-art/secure-vault/issues/30
- 작업 브랜치: `codex/firstvibe-cloud-mvp-lead-20260930`
- 현재 HEAD / 잠정 협업 기준: `afbc0fbc4dd41669e468d8658965ef8f5f10ee7d`
- 원격 main 관찰값: `65d10dceb13039dc69cf2368aa0e31d7ad5cc6b2`
- Issue #30 본문·댓글: GitHub API `Forbidden`, **BLOCKED**. 본문을 사용자에게 요청했다.
  출시 계획·승인 범위·최종 기준 SHA를 Issue의 내용으로 추정하지 않는다.

[검토 원장](../../verification/mvp-integration/2026-09-30-cloud-lead-review.md)과
[배정표·복사용 프롬프트](CLOUD_DELEGATION_2026-09-30.md)가 이번 인계의 근거다.
이 신규 문서는 현재 로컬 초안이며 다른 AI의 checkout에는 아직 없다.

## 제품 목표와 완료 상태

한국 운영·한국 사용자 우선으로, 향후 2주 동안 작은 출시 후보와 실제 Gmail MVP 연결의
준비에 집중한다. 2주 목표는 실환경 연결·공개 날짜의 확약이 아니다.
기존 `TWO_WEEK_PLAN.md`의 9/27~10/10 일정은 과거 가정이며 Issue #30의 새 일정으로 세지 않는다.

| 단계 | 현재 판정 |
| --- | --- |
| 코드 작성 | 합성 혜택 화면·이력, provider 독립 계약, M03 V2, M05 QA tooling V2가 현 기준에 있다. PR #22/#23 코드는 별도 원격 제출 상태다. |
| PR 제출 | Git 원격에서 #16~#29 head를 관찰했다. 이번 주 담당 문서 작업의 commit/push/PR은 없다. |
| 통합 | PR #19 head와 #29 head는 현 기준의 조상이다. M02 선택적 이식은 존재한다. #22/#23과 KA 후속 PR의 통합 완료를 선언하지 않는다. |
| 실환경 검증 | 실제 인증·Gmail·DB, 실제 Secret, 최신 통합 브라우저 전체 QA는 미검증이다. 합성 loopback 검사와 분리한다. |
| 배포 | 이번 세션에서 실행하지 않았다. 사용자 재개 전 보류다. |

## 소유권과 현재 실행 경계

M01A는 공용 타입, 앱 셸, routes, HTTP 연결, runtime 정책과 공통 설정을 관리한다.
`apps/benefits-web/src/routes/**`, `src/server/**`, `src/domain/**`, `src/lib/**`,
`src/router.tsx`, `src/server.ts`, `src/styles.css` 및 각 앱 manifest/lock/config는 다른 담당의 수정 범위가 아니다.
금고 앱의 셸·Worker·bridge·공용 계약도 별도 명시 없이 UI 담당에게 넘기지 않는다.
파일 소유권은 코어/실환경 구현 승인과 다르다.

| 작업 | 이번에 허용된 진행 | 선행 조건·남은 경계 |
| --- | --- | --- |
| M01A | 읽기 검토, 원장·배정 문서, 기존 승인 범위의 합성 연결 부족분 검토 | Issue #30과 로컬 9개 파일을 확인해 중복·기준 충돌을 해소한 뒤 코드 통합 범위를 확정 |
| R3A | [코어 수명 주기 설계 초안](REAL_SECRET_CORE_PLAN.md) | ADR 승인·독립 암호 검토·파일별 구현 승인이 없다. wire/KDF/복구/실제 입력 구현 금지 |
| R5A | [provider 설계 초안](PROVIDER_ADAPTER_PLAN.md) | 실제 auth/DB/Gmail 환경·비용·처리 승인이 없다. 연결·migration·OAuth·외부 호출 금지 |
| M02/M05A/M06/M04A·R4A | 배정표와 복사용 프롬프트 준비 | 실제 다른 채팅 전송·세션 생성은 별도 승인 전 실행하지 않음 |

`REAL_SECRET_GATE=CLOSED`. 실제 비밀번호/API 키/메일의 입력·수집·사용을 하지 않는다.
합성 데모 비밀번호나 mock 인증은 실제 사용자 인증·실사용 금고 완성의 근거가 아니다.
현재 SSR 앱의 `/api/catalog`, `/auth`, `/oauth`, `/gmail` 등 차단 경계를 유지한다.
합성 handler와 loopback 서버가 있어도 운영 endpoint 연결 완료로 세지 않는다.

도메인 구매·DNS·DB/호스팅 개설 및 연결·실제 Gmail/외부 AI·유료 서비스·공개 배포는 보류한다.
benefit-validator/Lovable 원본 프로젝트·DB는 변경하지 않는다.
보안 검사·Windows 정책을 약화하거나 우회하지 않는다.
CI 수동 재실행·결제/한도 변경·main 병합·force push도 이번 승인 범위에 없다.

이전 bounded-json 작업의 commit/push 승인은 그 두 파일에 한정된다.
이번 신규 작업의 commit/push/PR 범위는 Issue #30 또는 사용자의 별도 지시로 확인한다.
확인 전에 문서 준비·합성 검토를 진행하며 원격 발행은 하지 않는다.

## 향후 2주 작업 순서 제안

Issue #30 확인 전의 **상대 순서 제안**이다. 담당자를 실제로 실행시킨 일정이 아니다.

| 기간 | 준비할 산출물 | 다음 단계 조건 |
| --- | --- | --- |
| D1~D2 | PR 원장, 소유권, 로컬 누락 목록, 기준 SHA·승인 범위 고정 | Issue #30과 로컬 9개 파일의 내용/검사 대상 확인 |
| D3~D6 | #22/#23의 부족분 해결·선별 통합 검토, 한국어 화면·접근성, 합성 연결 회귀 | 합성 계약 검사 통과, 파일 소유권 충돌 없음; 운영 차단 유지 |
| D7~D10 | 고정 SHA의 브라우저 QA, B05 파일 왕복 증거, 독립 보안 검토, 개인정보·운영 초안 | 실제 사용한 도구·서빙 bundle과 source 결합, FAIL/BLOCKED 분리 |
| D11~D14 | 작은 합성 출시 후보의 검증 묶음, Gmail 연결 준비 체크리스트 | 사용자 검토용 후보·잔여 위험을 제출. 실환경 재개·배포 승인은 별도 |

Gmail 준비 완료의 최소 산출물은 세션/소유권·동의 범위, 최소 메일 데이터 처리,
보존/삭제·철회·오류/재시도·quota 계약, 한국 이용자 고지 초안, 검증 계획이다.
OAuth 검증이나 실메일 end-to-end 성공은 이 준비 문서로 대체하지 않는다.

## 정확히 누락된 자료

1. Issue #30 본문과 최신 결정 댓글: 계획·분담·기준 SHA·R3A/R5A·원격 발행 승인.
2. 로컬 `codex/firstvibe-mvp-readiness-20260930`의 미푸시 9개 파일:
   경로 목록·diff·HEAD/기준 SHA·검사 명령/exit/검사 대상. 그 브랜치는 원격 heads에 없었다.
   catalog-client와 loopback 보완이 이 클라우드에 있다고 가정하지 않는다.
3. API로만 확인 가능한 PR의 현재 OPEN/CLOSED/MERGED 상태·실제 base·check run/attempt/result.
4. 최신 고정 SHA의 전체 브라우저 QA와 B05 디스크 다운로드→새 profile 파일 선택 복원 증거.
   과거 Windows 임시 raw report는 이 checkout에 전달되지 않았다.
5. 이번 설계에 대한 독립 R4A 검토, 실제 Secret 출시 승인, 실제 provider 환경 승인.

필요한 정보는 합성 코드·정제된 결과만 받는다. 실제 비밀값·메일 원문·쿠키·HAR/DB 덤프는 받지 않는다.
자료가 도착하면 기준과 배정표를 갱신하고, 충돌하는 기존 구현을 덮어쓰지 않는다.
