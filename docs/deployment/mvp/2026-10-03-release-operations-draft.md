# 한국 우선 MVP — 출시·운영 runbook 초안

2026-10-03 / **LOCAL_REVIEW_DRAFT / DEPLOYMENT_HOLD**.
현재 운영 환경·도메인·DB·비용·실제 배포는 없다. 이 문서는 실행 승인이나 설정 완료가 아니다.
`REAL_SECRET_GATE=CLOSED`. 원본 benefit-validator/Lovable/원본 DB는 그대로 보존한다.
main merge/force push/CI 수동 재실행·과금 변경·다른 AI 세션/메시지는 실행하지 않는다.

## 후보의 기능·환경을 분리할 것

| 후보 | 필요한 런타임/경계 | 현재 근거와 미완료 |
| --- | --- | --- |
| `apps/web` 합성 금고·관계·가입 흔적 | Vite production 자산, 실제 Worker/WASM, browser의 합성 IndexedDB/file 동작 | 로컬 합성 source·build·Chromium 근거만 있음. hosting path/MIME/cache/CSP·다른 브라우저 실환경은 미검증 |
| `apps/benefits-web` 합성 혜택 체험 | TanStack SSR/server-function이 가능한 별도 런타임 | localhost SSR/boundaries/smoke 근거만 있음. 정적 파일 hosting만으로 전체 동작을 가정하지 않음 |
| T2 실제 Gmail | 승인된 auth/session·동의·quota·DB·Gmail/분석 adapter, 실제 처리·삭제/철회 운영 | 현재 구현은 주입형 계약과 합성 adapter. 실제 환경/호출/운영 E2E 없음 |
| T3 실제 Secret | R3A ADR·플랫폼/복구·키 수명·독립 검토·별도 gate | 이번 후보와 분리. 합성 WASM/backup PASS로 허용하지 않음 |

초기 공개 범위·동일 origin/경로 구성·두 앱의 release 묶음은 미확정이다.
‘웹이 보인다’, ‘server가 시작한다’, ‘실제 Gmail end-to-end’, ‘배포 완료’를 구분한다.

## 환경 재개 전 필요한 입력

- 사용자에게 승인받은 기능 범위, 구현/게시 manifest, exact source SHA와 별도 runtime 설정 버전.
- 별도 KeyAtlas 환경의 공급자·지역·운영 주체·문의처·비용 상한·접근자·보존 정책.
- domain/hosting/DB/OAuth/외부 AI 필요 여부와 해당 단계별 재개 승인. 실제 credential은 승인된
  secret 주입 경로만 사용하며 채팅·Git·로그에 넣지 않는다. 현 단계에는 주입하지 않는다.
- T1 hosting/CDN/오류 수집/analytics의 실제 개인정보 수집과 안내 대조.
- 성공/실패·철회·삭제·복구·rollback 검증 담당과 지원 기기·브라우저 범위.

운영 값이 없는 지금은 위 목록과 후보 artifact를 준비한다. 예산/region/hosting을 자동 선택하거나
원본 환경 공유로 보류를 우회하지 않는다. 자동 구매·배포 예약도 만들지 않는다.

## 배포 전 후보 고정과 코드 검사

현재 cloud HEAD는 `afbc0fbc4dd41669e468d8658965ef8f5f10ee7d`이고 변경은 미커밋이다.
소스 patch/hash와 검사 기록은 cloud에만 있다. 게시 승인 뒤 소유 파일을 검토·명시적으로
commit한 exact SHA를 기준으로 검증하고, 그 상태의 artifact를 승격해야 한다.
로컬 readiness 미푸시 9개 파일은 **NOT_RECEIVED**다. 대조 전 통합 완료로 판정하지 않는다.

| 검사 | 명령/조건 | 통과가 의미하는 범위 |
| --- | --- | --- |
| 설치 | 각 앱 README의 고정 `npm ci --ignore-scripts`; 새 버전/lockfile 변경 없음 | 지정 의존성 재현. runtime/보안 승인 아님 |
| 금고 웹 | fresh `build-wasm.ps1 -SyntheticDemo -Release`, 기본/합성 `test-wasm.mjs`; apps/web `npm test`, `npm run typecheck`, `npm run build` | 닫힌 합성 경로와 compiled WASM/Worker |
| 혜택 웹 | bounded/client/HTTP 집중, `npm test`, `npm run build`, `npm run typecheck`, `npm run check:boundaries`, `npm run test:smoke` | 현재 local SSR·합성 경계. 실제 auth/DB/메일 아님 |
| Rust | `verify-local.ps1 -Scope Workspace`, 실패 단계와 별도 개별 검사 기록 | 현재 Linux 기본 SQLite 19 FAIL을 전체 PASS로 표기하지 않음. native Windows 근거 별도 |
| Secret/소유/무결성 | `check-repository-secrets.ps1`, `git diff --check`, 미추적 파일 별도 check, exact source/build hash | targeted local 검사. Git 전체 이력·모든 파일의 보안 감사 아님 |
| browser/file | fresh 소유 profile, production build, 실제 다운로드/디스크 파일 복원, 잠금/만료/버전·오류·모바일·키보드 | 검사한 실제 browser·합성 fixture 범위만 |

기존 Windows Application Control/Phase 0A 불확정 기록은 별도 미완료다.
새 Clippy/ordinary Linux 검사로 authoritative Windows 보안 결과를 대신하지 않는다.
검사 skip·정책 약화·Windows 보안 우회·CI rerun으로 통과를 만들지 않는다.
현재 실패와 미검증 항목의 출시 관련성·gate는 maintainer와 독립 리뷰가 판단한다.

원격 main `65d10dceb13039dc69cf2368aa0e31d7ad5cc6b2`에는 AGPLv3 LICENSE가 있으나
현재 기준 HEAD tree에는 LICENSE가 없다. 최종 승인 후보에서 기존 license/의존성/원본 이식물
사용권·고지·소스 제공을 대조한다. 여기서 새 license를 선택하거나 법률 검토 완료로 표시하지 않는다.

## 승인 후 staging에서 확인할 것

1. 기록한 SHA의 source/artifact/config만 사용한다. 같은 이름으로 덮어쓴 자산을 근거 없이 신뢰하지 않는다.
2. 두 앱의 origin/base path·SSR/server function·static 자산·Worker·WASM MIME/loading을 실제 환경에서 확인한다.
3. HTTPS/redirect/CSP/cache·오류 응답/503 차단, 인증이 필요한 기능의 unauthenticated·다른 owner·만료 접근을 검사한다.
4. T1에서는 실제 연결 경로·Secret 자유 입력을 차단하고 합성/부분 구현 문구와 지원 범위를 확인한다.
5. 원래 데이터/profile 보존, quota 실패·future version·잠금·새로고침·desktop/360px·키보드·file round trip을 확인한다.
6. T2가 승인됐다면 실제 승인 계정의 consent/grant·quota·DB 소유권/CAS/원자 operation·메일 pagination/
   철회·취소·불명확한 ACK·삭제·재시작을 별도 end-to-end로 검증한다. test adapter 성공을 재사용하지 않는다.
7. 실제 수집/logging/region/비용 설정과 개인정보 notice가 일치하는지 대조한다.
8. deployment URL·source/config/build SHA·명령/exit·실패/지원 제외 범위·판정자를 기록한다.

현재 모든 staging/production 항목은 **NOT_RUN**이다. 이 목록을 작성한 것이 배포 완료는 아니다.

## 운영 신호와 제한

T1 신호 후보: static/SSR 로딩 실패, fixed 오류 비율, Worker/WASM 로딩, browser 저장 quota/future-version
실패, 운영 문의. T2는 consent/철회·quota·provider 실패·transaction/CAS·삭제 지연을 더 검토한다.
지표·알람의 threshold, 수집 방식·보존·연락처·on-call 담당은 미확정이다.
관측을 위해 raw mail·Secret·token·전체 URL/input·backup·session replay를 자동 수집하지 않는다.
request correlation이나 서비스/계정 metadata도 민감할 수 있으므로 최소화·검토한다.

비용을 줄이거나 오류를 감추려고 reader 한도·auth·crypto·CI gate를 낮추지 않는다.
로그 원문·HAR·사용자 DB/backup을 issue/채팅에 요청하지 않는다. 고정 코드·검사 범위·sanitized
상태와 해당 source SHA부터 받아 필요한 자료를 승인된 경로로 최소화한다.

## 사고·장애 대응 초안

| 상황 | 담당이 수행할 승인 범위의 대응 | 유지할 증거/금지 |
| --- | --- | --- |
| 단순 static/SSR 로딩 실패 | 배포 artifact/path/MIME/Worker·runtime 상태를 확인, 지원 범위와 재현 조건 기록 | 데이터 삭제·금고 초기화나 자동 재시도로 해결하지 않음 |
| 저장 quota/미래 버전/불명확한 저장 | 원래 bytes/profile 보존, 표시 상태와 보관 범위를 설명, user-controlled 재열기/지원 절차 | 다른 사용자/기존 archive 덮어쓰기·강제 downgrade 금지 |
| 실제 권한/데이터 노출 의심(승인 후) | 승인된 담당에게 비공개 접수, 신규 관련 처리 차단·최소 증거 보존·영향 평가/법률·provider 대응 | 공개 issue에 비밀값/실메일/취약점 원문 게시 금지 |
| provider 철회/삭제 실패(승인 후) | 신규 수집과 오래된 authority 차단, provider/DB 상태를 따로 확인, 승인된 idempotent 재처리 | client timeout을 rollback/철회 성공으로 오인하지 않음 |

사고 분류·통지/신고 필요성·법정 기한·수신자·대응 책임은 운영 주체와 법률 검토에서 확정한다.
현재 실제 운영 연락·알람·자동 대응을 구성하지 않았다.

## rollback·복구 기준

- 사용자가 승인한 immutable 이전 artifact/config와 복구 자료를 준비하고 exact SHA를 기록한다.
- 필요 시 승인된 담당이 신규 provider 처리를 제한한 뒤 영향을 확인한다. REAL_SECRET_GATE와
  consent/authority·503 차단을 유지하고 이전 코드라고 gate를 자동 개방하지 않는다.
- 코드 rollback과 데이터 migration/삭제/복구는 별도다. 오래된 코드·backup이 권한/삭제 상태를
  되살리지 않는지 검증하고, 호환되지 않으면 중단·검토한다.
- 원본 DB 공유·실데이터 초기화·자동 복원·키 회전은 이 문서로 허용되지 않는다.
- RTO/RPO·실제 backup 주기·보존/삭제·훈련 일정은 미확정이며 합성 B05가 이를 증명하지 않는다.

실제 R5A adapter 승인 전 [transaction/철회/Unknown/삭제 설계](../../handoff/mvp-20260927/R5A_TRANSACTION_AND_DELETION_DESIGN_2026-10-03.md)를
확인한다. 특히 driver ACK 손실과 HTTP timeout, DB의 영속 commit을 구분하고,
엄격한 commit deadline·삭제 generation/fence·복구 뒤 재유입 방지의 실제 근거를 요구한다.
현재 계약을 app 시각 확인이나 임의 자동 retry로 완화하는 운영 절차를 만들지 않는다.

## 공개/초대 판정에 남길 기록

source와 artifact 작성 → 코드 검사 → 원격 제출 → maintainer/독립 검토 → 승인된 환경 검증 →
제한 출시 → 실제 운영 확인을 구분한다. 현재는 source 작성·로컬 합성 검사와 설계 초안 단계다.
기능 범위/지원 제외, exact SHA, 명령/exit, 미완료 위험·담당, 운영/개인정보 승인, 별도 배포
승인과 실제 URL/확인 결과가 모이기 전 RELEASED/실제 MVP라고 표시하지 않는다.

기간/인력의 조건부 계산은 [서비스 평가](../../handoff/mvp-20260927/SERVICE_READINESS_2026-10-03.md)를 따른다.
환경·승인·Google 등 외부 대기는 개발 공수와 별도이며 아직 고정 배포일이 없다.
