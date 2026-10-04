# T1 출시 기준·artifact 연결 계획 — 2026-10-04 KST

DESIGN_ONLY / LOCAL_REVIEW_DRAFT / DEPLOYMENT_HOLD.
이 문서는 기준·runtime·검증의 연결 부족분을 정리한다. 실제 host/DNS/DB/계정/배포를
생성하거나 runtime·CI·인증·보안 정책을 변경하지 않았다. `REAL_SECRET_GATE=CLOSED`.

## 현재 실행 단위는 두 개다

| 실행 단위 | 고정 source와 산출물 | 현재 직접 근거 | 실제 공개 전에 필요한 결정·검사 |
| --- | --- | --- | --- |
| `apps/web` | Vite `dist/index.html`·JS/CSS·Worker·WASM. 현재 여섯 합성 화면은 이 앱 안에서만 이동 | 새 공통 셸의 1280/360/320px·본문 바로가기·문서 이동·금고 재열기, 기존 합성 browser 검사 | 공개할 화면, 정확한 origin/base path, Worker/WASM MIME·cache·CSP·오래된 자산/rollback·다른 browser/실제 기기 |
| `apps/benefits-web` | TanStack Start/Nitro `node-server`; `.output/server/index.mjs`와 `.output/public`을 함께 사용 | 앞선 동일 source의 SSR/hydration·serverFn·smoke/boundaries·혜택 현재/지난 기록 검사 | SSR runtime/Node 지원·proxy/HTTPS·request headers·운영 로그·수집 정책·정적 자산/서버 버전의 일치 |

현재 C06에는 native bfcache 복귀 시 후보·동의를 지우는 합성 UI 보완도 포함한다.
이는 실제 개인정보/Secret의 heap erasure나 모든 browser/OS의 출시 승인 증거가 아니다.
현재 web 셸은 benefits 앱을 같은 origin에 배치하거나 서비스 간 인증을 연결하지 않는다.
benefits의 `.output/public`만 정적 host에 올리면 SSR/server function까지 동작한다고
가정할 수 없다. web의 정적 build가 있다는 사실도 실제 host의 Worker/WASM 실행을 보증하지 않는다.
어느 앱을 T1의 공개 진입점으로 쓸지는 사용자 결정이다. 이 문서가 앱/host를 선택한 것은 아니다.

`apps/benefits-web/scripts/start-local.mjs`는 `.output/server/index.mjs`만 시작하며,
`local-environment.mjs`는 필요 OS 변수만 복사하고 HOST/NITRO_HOST를 `127.0.0.1`, mode를
`synthetic`으로 고정한다. 이 local launcher를 공개 운영 launcher로 취급하거나 bind/env
제한을 없애지 않는다. 승인된 운영 환경이 생기면 별도 manifest로 필요한 설정을 검토한다.

`runtime-policy.ts`는 실제 연결 대상 `/auth`, `/oauth`, `/gmail`, `/analyze`, `/api/catalog`
등을 503으로 유지하고, 지원하지 않는 mode도 503으로 차단한다. `/api/integration-status`는
고정 공개 상태일 뿐 계정 인증·권한 증거가 아니다. 현재 CSP는 `frame-ancestors`, `base-uri`,
`object-src`, `form-action` 일부이며 script/connect 경계 전체를 완성하지 않았다.
503/mode flag/부분 CSP를 실제 인증·egress sandbox·실제 Secret 사용 허가로 승격하지 않는다.

## 게시 후보를 고정하는 순서

1. 로컬 readiness의 미푸시 9개 파일 경로/diff와 검사한 SHA·exit를 받는다. cloud의 9개
   client/loopback 파일과 대조한다. 실제 비밀값·원본 로그는 받지 않는다. 현재는 NOT_RECEIVED다.
2. source 기준은 `afbc0fbc4dd41669e468d8658965ef8f5f10ee7d` + 승인받을 exact overlay다.
   [최신 manifest](../../verification/mvp-integration/2026-10-04-cloud-shell-source-manifest.json)의
   경로·hash와 적용 가능한 clean checkout을 정한다. HEAD만으로 현재 source를 식별하지 않는다.
3. 원격 main `65d10dceb13039dc69cf2368aa0e31d7ad5cc6b2`는 이번 앱 기반과 다르다.
   기존 overlay의 main archive 적용 check는 exit 1이었다. main의 AGPLv3 LICENSE와
   이식 source의 고지·기준 tree의 LICENSE 부재를 대조한다. 라이선스를 임의 변경하지 않는다.
4. 기존 PR의 실제 base/state/최신 CI evidence를 읽어 보완/승격 경로를 정한다.
   Git ref/ancestry나 과거 CI PASS를 현재 merge·현재 CI로 쓰지 않는다. CI 재실행은 보류다.
5. 사용자가 게시를 승인하면 소유 파일만 명시적으로 stage/commit하고 source SHA를 고정한다.
   게시 승인에 main merge/force push/CI rerun/배포 승인이 포함된다고 가정하지 않는다.
6. 최종 source·고정 toolchain/dependency·WASM 생성 조건·build 명령·artifact 경로/hash를
   한 묶음으로 기록한다. 코드/source manifest와 build artifact manifest는 다른 증거다.
7. M02 보완과 M05A QA가 끝난 마지막 source를 M04A/R4A가 독립 리뷰한다. 작성자의 자체 QA는
   독립 보안 승인으로 세지 않는다. 환경 부족과 기존 실패를 삭제/skip/재시도로 숨기지 않는다.

## 실제 환경을 재개한 뒤의 검증 순서

아래 단계는 아직 실행하지 않았다. 구체적인 provider/region/budget/운영자와 재개 승인 전에는
실행하지 않는다. hosting access log·analytics·오류 수집도 T1의 개인정보 범위에 포함해 검토한다.

| 단계 | 요구 증거 | 현재 상태 |
| --- | --- | --- |
| 승인된 staging 준비 | 두 앱 중 공개할 범위, runtime·origin·HTTPS·env allowlist·Secret CLOSED·비용/지역 | NOT_RUN / 환경 보류 |
| 정적/SSR 버전 일치 | source SHA→build→Worker/WASM·JS/CSS·SSR server의 size/hash; 실제 HTTP 응답 byte 대조 | 로컬 합성 artifact만 직접 검사. 외부 HTTP NOT_RUN |
| 공개 기능의 수집 경계 | 실제 계정·메일/AI/DB 연결 부재, 비활성 API 503, 로그/수신자/보존·권리 안내 | source/local QA와 설계 근거. 실제 host 검사 NOT_RUN |
| 지원 환경 | browser·실제 모바일/screen reader·native Windows/OS dialog 등 공개 범위에 필요한 evidence | Chromium 일부만 PASS. 나머지 지원 환경별 BLOCKED/NOT_RUN |
| 안전한 업데이트/rollback | 이전 immutable artifact, cache/Worker 불일치, 클라이언트 합성 IndexedDB 보존·재열기 | 계획만 있음. 운영 변경·삭제·migration·rollback 실행 NOT_RUN |
| 실제 공개·관찰 | 사용자 최종 승인, 운영 연락처·장애 담당·수집 설정·관찰 시간·되돌리기 기준 | NOT_RUN / DEPLOYMENT_HOLD |

합성 금고 IndexedDB가 브라우저에 있다는 이유로 rollback이 안전하다고 단정하지 않는다.
자산만 되돌린 뒤 오래된 코드가 새 archive/schema를 읽을 수 있는지 별도 확인해야 하며,
호환성이 불명확하면 삭제·초기화·자동 migration으로 해결하지 않는다. 이는 실제 Secret의
rollback anchor/복구 설계를 대체하지 않는다.

## 계획 기간과 다음 담당

이번 셸 보완은 기존 T1 UI/통합 공수 안의 진척이다. 실제 환경 대기는 줄어들지 않았다.
[기존 산정](SERVICE_READINESS_2026-10-03.md)의 숙련 인력 2명/실효 1.5명 전제로
T1 1~2주 + 승인 대기, T2 6~10주 + Google 등 외부 대기, T4 6~12+개월을 유지한다.
1시간의 합성 보완으로 실제 Gmail MVP나 배포 완료를 주장하지 않는다.

M01A는 baseline·공용 셸/routes·HTTP·artifact 연결을 맡고, M02는 허용된 화면 부족분,
M05A는 지원 환경 QA, M06는 운영/개인정보 미정 값, M04A/R4A는 마지막 source의 독립 리뷰를
맡기는 [배정 초안](NEXT_ASSIGNMENTS_2026-10-04.md)을 준비했다. 아직 실제 배정하지 않았다.
