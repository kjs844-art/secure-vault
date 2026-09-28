# KeyAtlas — 2주 첫 출시와 AI 작업 시작점

2026-09-27 KST. 최신 사용자 결정: 기존 웹을 활용해 약 2주 작업한다.
**benefit-validator와 연결된 Lovable 프로젝트는 당분간 그대로 둔다.
필요한 기능은 KeyAtlas의 secure-vault repo로 가져온다.**
2026-09-28 갱신: M01A에 독립 SSR scaffold와 순수 domain 이식 코드가 추가되었다.
전체 코드 이식·로그인/Gmail·배포 완료를 뜻하지 않는다.

**2026-09-28 사용자 보류 결정:** DB·도메인 등은 사용자가 다음 주 또는 다다음 주에
준비/구매할 예정이다. 그때 사용자가 재개를 말하기 전까지 실제 DB 생성·연결·migration,
도메인 구매/DNS 연결, 호스팅 실설정·과금·배포는 보류한다. 날짜만으로 자동 재개하지 않는다.
외부 계정이 필요 없는 코드·합성 테스트는 계속하며 원본 Lovable/repo/DB는 동결한다.
아래 2주 일정은 개발 목표로 읽고, 공개 출시일은 환경 준비와 검증 후 다시 정한다.

현재 M01A에는 메일 정규화/분석 실행 제어와 사용자 확인·삭제 제어의 서버 코드도 있다.
합성 어댑터 검증이며 실제 로그인/DB/메일/화면에 연결한 상태는 아니다.
[최신 확인 제어 검사 기록](../../verification/mvp-integration/2026-09-28-review-control.md).

추가: 분석 당시 소유권과 별도 보관 동의에 결합된 stage/listBatch/discard를 확인 코드와 연결했다.
로컬 앱 합성 테스트 761/761 및 빌드/타입/경계/HTTP smoke 통과.
[후보 수신함 연결 검사](../../verification/mvp-integration/2026-09-28-candidate-inbox.md).
실제 인증·메일·DB·화면 연결, 자동 물리 삭제나 운영 배포 완료를 뜻하지 않는다.

다음 체크포인트: owned 서비스 CRUD/list와 검토된 혜택의 화면용 DTO/응답 순서 제어를 추가했다.
로컬 앱 969/969 및 build/typecheck/boundary/HTTP smoke 통과.
[카탈로그·화면 데이터 검사](../../verification/mvp-integration/2026-09-28-service-catalog.md).
실제 UI/auth/DB wiring은 미완료이고 원본 환경 동결/DB·도메인·배포 보류는 유지한다.

## 기준과 목표

- 유일한 새 개발 대상: https://github.com/kjs844-art/secure-vault (private).
- 읽기 전용 참고 원본: benefit-validator@`954da8da0b12d55a342d187fab17abe57b93fbb0`.
- KeyAtlas 코드 출발 SHA: `34b43e1a5d2f1d81eb2f6456d657fd04ca57332f`.
- 목표 기간: 2026-09-27 시작 가정, 2026-10-10까지 14일.
- 기존 100개 작업은 장기 backlog다. 이번 첫 출시는 아래 6개 우선 작업으로 진행한다.
- A는 보안/검증 난도를 뜻한다. 특정 AI 모델이나 작업 완료를 뜻하지 않는다.

## 통합의 뜻

같은 Git 저장소 안에 공개 웹과 금고를 나눠 둔다. 현재 React/Worker/WASM 금고는 유지하고,
benefit 웹의 필요한 부분을 새 `apps/benefits-web/` 영역으로 단계별 이식 중이다.
독립 실행 구조와 순수 계산은 구현했으며 기존 화면/Gmail/DB 연결은 다음 단계다.
서로 다른 origin·인증·복호화 경계는 계속 분리한다.
참고 원본 Git 이력/전체 DB를 무조건 merge하거나 복제하지 않는다.

Lovable 원본 앱·repo main·DB·환경변수·연결 브랜치·도메인에 쓰기를 하지 않는다.
새 개발에서 그 운영 DB를 기본 대상으로 삼지 않는다.
세부 규칙: [통합 경계](INTEGRATION_BOUNDARY.md).

## 6개 배정 — 모두 secure-vault 브랜치

| 작업 | 담당 | 범위 |
|---|---|---|
| [M01A](https://github.com/kjs844-art/secure-vault/blob/codex/firstvibe-mvp-01a-integration-20260927/docs/handoff/mvp-20260927/M01A.md) | Codex 주 담당 / 현재 작업 | 통합·금고 보안·최종 출시 판정 |
| [M02](https://github.com/kjs844-art/secure-vault/blob/codex/firstvibe-mvp-02-demo-ui-20260927/docs/handoff/mvp-20260927/M02.md) | 미배정 — 사용자 지정 AI 1개 | 기존 웹의 데모 UI를 KeyAtlas로 이식 |
| [M03](https://github.com/kjs844-art/secure-vault/blob/codex/firstvibe-mvp-03-connections-20260927/docs/handoff/mvp-20260927/M03.md) | 미배정 — 사용자 지정 AI 1개 | 서비스·API 사용처 관계의 합성 연결 계약 |
| [M04A](https://github.com/kjs844-art/secure-vault/blob/codex/firstvibe-mvp-04a-mail-review-20260927/docs/handoff/mvp-20260927/M04A.md) | 미배정 — 보안 검토 가능한 고급 AI | 이식 전 Gmail·로그인·개인정보 경계 검토 |
| [M05A](https://github.com/kjs844-art/secure-vault/blob/codex/firstvibe-mvp-05a-browser-qa-20260927/docs/handoff/mvp-20260927/M05A.md) | 미배정 — 브라우저 QA 가능한 AI | 독립 브라우저 QA: 저장 실패·화면·잠금 |
| [M06](https://github.com/kjs844-art/secure-vault/blob/codex/firstvibe-mvp-06-release-20260927/docs/handoff/mvp-20260927/M06.md) | 미배정 — 문서·배포 준비 AI | KeyAtlas 독립 배포·DB·도메인 준비 |

- M01A: 내가 통합·보안·실제 배포 후보 판단을 담당한다.
- M02/M06: 상대적으로 가벼운 AI도 맡을 수 있는 UI/문서 영역.
- M03: 타입·입력검증·합성 테스트를 작성할 코딩 AI.
- M04A/M05A: 보안 검토·브라우저 검증 가능한 AI.
- 각 문서 마지막에 다른 AI에게 복사할 프롬프트가 있다.
- 한 AI는 한 브랜치·별도 작업 폴더를 사용한다. 공용 파일 변경은 M01A가 통합한다.
- 기존 PR #5 UI나 #30/#58/#93 수정본을 새 업무라고 중복 개발하지 않는다.

## 첫 출시 단계

| 단계 | 기능 | 2주 내 판단 |
|---|---|---|
| 공개 체험 | KeyAtlas에 이식한 demo, 서비스·혜택·만료·확인 필요 화면 | 첫 주 내부 검증, 2주차 공개 후보 |
| 제한 파일럿 | 로그인, 서비스/혜택 CRUD, 별도 동의 Gmail 후보 분석, 저장/삭제 | 이식·사용자별 권한·운영 DB·개인정보·비용·외부 승인 통과 범위만 |
| 연결 지도 | 서비스와 API 사용처/MCP의 비밀 원문 없는 참조 | 우선 타입/합성 테스트, 이후 UI 연결 |
| 실제 Secret 금고 | 비밀번호/API key 원문, 복구·기기 분실·생체인증·동기화 | 별도 보안 출시 단계. 현재 REAL_SECRET_GATE=CLOSED |

Gmail은 핵심 수집 기능으로 유지한다. 데모를 Gmail 완성 서비스로 부르지 않는다.
도메인/DB 코드가 존재한다고 실제 계정 설정과 운영 검증이 끝났다고 말하지 않는다.
로그인·메일·AI·MCP 기능은 UI에서 숨기는 것만으로 비활성화되지 않으므로 서버 경계도 확인한다.

[2주 일정과 사용자 준비사항](TWO_WEEK_PLAN.md)에 DB/서버/도메인 선택을 정리했다.
이전 5~6개월은 전체 제품에 대한 거친 추정이었다. 첫 배포를 위해 전체 기능을 기다리지 않는다.
다만 2주는 목표이며 외부 심사와 남은 보안 문제의 완료를 보장하는 날짜는 아니다.

## 현재 코드·PR 근거

- secure-vault source는 PR #15의 `34b43e1`; collaboration baseline은 `d9c66661`.
- #30/#58/#93 수정본은 PR #8/#7/#9, #93 CI는 #10으로 이미 올라와 있다.
- #14는 PS5.1 fixture 보정, #13은 기존 공유 문서. 조회 당시 열린 PR 13개.
- PR #5가 #22/#23/#29/#42/#36 UI를 묶어 작업했으므로 예약 브랜치만 보고 미작업이라고 판단하지 않는다.
- 위 작업의 B05는 백업 준비 UI와 일부 로컬 검사가 PASS였지만 실제 디스크 저장→새 프로필
  복원은 도구의 대조군 다운로드도 실패해 BLOCKED다.
- 다른 작업의 Luna 문서와 B04 미커밋 변경은 보존한다.
- 2026-09-28 M01A 코드 체크포인트:
  [독립 SSR/domain 이식 및 검증](../../verification/mvp-integration/2026-09-28-benefits-scaffold.md).
  로컬 앱 검사와 제한된 브라우저 이동을 확인했다. 실제 로그인·메일·운영 DB·공개 배포는 미검증.

## 원본 동결 직전 작업 이력

사용자가 원본을 유지하라고 명확히 하기 전에 benefit-validator에 **문서만 담긴**
M02/M04A/M06 브랜치 3개를 push했다. main/앱 코드/DB는 바꾸지 않았다.
그 3개는 이제 참고용 과거 배정이며 사용하지 않는다. 삭제도 원본 변경이므로 남겨 둔다.
동결 이후 미푸시 문서 편집은 내가 만든 부분만 원래 커밋 상태로 되돌렸고,
새 배정은 모두 이 private secure-vault repo로 발행한다.

## 세션 관리

[세션 인계](SESSION_HANDOFF.md)를 읽는다. 현재 작업이 새 출시 계획의 조정 창구다.
위의 B05 작업 기록은 읽어 이어받았지만 대화가 자동 합쳐지거나 상시 동기화되는 것은 아니다.
다른 AI의 결과는 task / repo / branch / SHA / changed files / checks / not verified로 가져온다.
브랜치 개수나 GitHub 체크 색상은 완료 기능 수가 아니다.
