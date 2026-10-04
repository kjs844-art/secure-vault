# Cloud 공통 합성 앱 셸 보완 — 2026-10-04 KST

상태: LOCAL_SYNTHETIC_CHECKS_COMPLETE / LOCAL_UNCOMMITTED / PUBLICATION_HOLD.
추가 1시간 시작은 한국시간 `2026-10-04 05:18:51`, 예정 종료는 `06:18:51`이다.
UTC로는 `2026-10-03 20:18:51`~`21:18:51`이다.

## 변경과 원인

기존 여섯 합성 화면은 모두 `KeyAtlas 기능 골격` 제목을 쓰고 공통 본문 바로가기·화면
이동 메뉴가 없었다. 수정 전 Chromium 관찰은 title=`KeyAtlas 기능 골격`, main=1,
skip link=0이며 새 통합 검사 exit 1이었다.

PR #5의 `b9ec53dc31e2b2af3c9666381b9c19d2b6322668`에서 기존 AppShell·CSS·tokens를
선택 재사용했다. 원본 shell test의 copyCatalog import만 고정 한국어 label로 대체해
불필요한 copy module을 이식하지 않았다. 원본 shell test 10개를 유지하고,
기존 화면의 main을 감싸는 div 모드를 추가했다. main이 중첩되지 않으며 본문 바로가기는
focusable `#main-content`를 대상으로 삼는다. 토큰 CSS/TS 일치 검사도 기존 PR에서 재사용했다.
tokens.css의 글로벌 테마는 import하지 않는다. 현재 셸에는 light token만 범위를 한정해
주입하므로 전체 앱의 dark theme 지원을 구현했다는 뜻이 아니다.

- `apps/web/src/main.tsx`: 기존 view allowlist를 닫힌 parser와 공통 셸로 연결.
- `apps/web/src/ui/shell/AppShell.tsx`, `shell.css`, `AppShell.test.tsx`: PR #5 재사용 및
  기존 main을 유지하는 최소 모드/회귀 추가.
- `apps/web/src/ui/tokens/tokens.ts`, `tokens.css`, `tokens.test.ts`: 기존 PR bytes 그대로 재사용.
- `apps/web/src/ui/shell/SyntheticAppShell.tsx`, 해당 test, `synthetic-shell.css`: 화면별 제목,
  현재 메뉴 표시, 키보드 본문 바로가기, 공통 44px 메뉴, 기존 문서 이동을 보존하는 frame.
- `apps/web/tests/mvp-browser/verify_app_shell.py`: 현재 production bytes를 검증하는 실제
  Chromium QA. 기존 synthetic IDB readonly probe를 재사용한다.

첫 실제 browser 실행은 320px backup의 native file input 넘침에서 exit 1이었다.
수정 전 오래된 화면도 scrollWidth 341px, 새 셸은 357px이었다(둘 다 viewport 320px).
native file input은 width 312px이었다. 공통 셸 범위 안에서 min-width:0/width:100%로
줄일 수 있게 보완했다. 파일 type/size/read 정책·session·worker·store는 변경하지 않았다.
이후 1280/360/320px의 여섯 화면 모두 가로 넘침 검사를 통과했다.

두 번째 browser 실행에서는 신규 QA가 기본 후보를 3개로 잘못 기대해 exit 1이었다.
기존 fixture와 기존 scanner test는 Aurora/Cedar 2개만 허용한다. Harbor의 reset mail과
기간 밖 signup은 제외된다. expectation을 정확한 2개·Aurora/Cedar 표시·Harbor 부재로
고쳤다. 기존 source/정책/fixture는 그대로이며 실패 기록도 보존했다.

## 기준과 검사 대상

- branch: `codex/firstvibe-cloud-catalog-client-fix-20261003`.
- HEAD: `afbc0fbc4dd41669e468d8658965ef8f5f10ee7d`. 새 commit/push/PR/merge 없음.
- 원격 main 관찰값: `65d10dceb13039dc69cf2368aa0e31d7ad5cc6b2`.
- remote history: `ee557c8e81807f1af88fff0e40ed949089b9337f`.
- cloud work/readiness branch ref는 이번 read-only 조회에서도 없었다. refs는 PR merge·CI
  증거가 아니다. 로컬 readiness의 9개 파일은 계속 NOT_RECEIVED다.
- 이번 시작의 70개 파일 중 `apps/web/src/main.tsx`와 C06 panel만 의도적으로 변경하고
  나머지 68개는 보존한다. 새 source/QA 11개와 새 검증·manifest·배정 문서는 별도로 식별한다.
- [10/3 검증](2026-10-03-cloud-lifecycle-qa.md)과 source manifest/ZIP은 당시 기록이다.
  현재 변경을 받으려면 [새 manifest](2026-10-04-cloud-shell-source-manifest.json)가 필요하다.

새 의존성/버전/lockfile·CI·운영 auth/DB/Gmail·암호화/reader·시간/크기 정책 변경은 없다.
기존 고정 설치·WASM과 preinstalled Python Playwright/시스템 Chromium을 재사용했다.
실제 사용자 profile/Secret/메일/외부 AI/provider/infra/배포는 사용하지 않았다.
다른 AI 메시지·세션 생성도 하지 않았다.

## 직접 검사

다음은 `apps/web` 기준이다. local evidence는 `/tmp/keyatlas-one-hour-20261004`이며 raw log,
profile·다운로드 파일·generated dependencies/build는 Git 변경에 포함하지 않는다.

| 정확한 명령 | exit | 근거 |
| --- | ---: | --- |
| `npm test -- src/ui/shell/AppShell.test.tsx src/ui/shell/SyntheticAppShell.test.tsx` | 0 | 집중 29개, token parity 파일 선택 전 |
| `npm test` | 0 | 최신 60 files / 1,858 PASS, skip/fail 0 |
| `npm run typecheck` | 0 | 최신 source |
| `npm run build` | 0 | 최신 production build |
| `python tests/mvp-browser/verify_app_shell.py --dist dist --output /tmp/keyatlas-one-hour-20261004/shell-final` | 0 | 24개 PASS/errors 0. source `eac7806137be23c9a8231147486d80c96bbc7e9fb81b2594c101da70469ce2a3` |

현재 24개는 3 widths × 6 views, 각 width의 비영속 상태 검사 3개, unknown view fallback,
실제 금고 문서 이동/뒤로 가기/명시 재열기, C06 문서 이동/뒤로 가기/재동의 필요를 포함한다.
여섯 페이지 모두 main/h1이 하나이며 첫 Tab→skip→Enter→본문 focus→다음 Tab 본문 안을
확인했다. 메뉴에는 현재 페이지 하나와 기존 same-origin href 6개만 있다.
기존 금고의 archive hash는 화면 이동·뒤로 가기·재열기·C06 탐색 뒤에도 같았다.
정적 방문만으로 localStorage/sessionStorage/IndexedDB/cookie를 만들지 않았다.
실제 수동 mobile/screen reader·bfcache activation·OS sleep·heap erase 증거는 아니다.

pagehide 수정 전 `eac780…` build의 기존 금고 lifecycle 19개(exit 0, 949.92초),
C02 3개·C04 3개·C06 entry 12개(exit 0)는 완료했다. 이들은 앞선 단계의 증거다.
pagehide 수정 후의 기존 금고 lifecycle 전체도 아래 최신 명령으로 완료했다.

## 추가 재현: C06 뒤로 가기 캐시의 후보·동의 잔존

기존 C06 panel은 React effect cleanup에서만 session을 dispose했다. 브라우저가 bfcache로
문서를 보관하면 React unmount가 실행되지 않는다. 동일 합성 build에서 실제 문서 이동 후
history.back()의 `pageshow.persisted=true`를 관찰했고 후보 2개가 그대로 있었다.
same-origin request guard 사용/미사용 두 탐색 관찰에서 모두 재현됐다.
이는 실제 Gmail/Secret 노출 검사가 아니라 현재 합성 UI의 수명 약속을 어긴 재현이다.

panel에 `pagehide` listener를 추가했다. 기존 session.dispose()로 후보·active consent를
끝내고 session ref/pending focus를 비운다. React의 빈 view/message를 flushSync로 pagehide
안에서 반영해 cached DOM이 이전 후보/확인 버튼을 남기지 않도록 했다. 강제 focus는 하지
않고 listener도 effect cleanup에서 제거한다. scope selection은 보관돼도 새 preview와 새
명시 동의 없이 후보를 다시 만들 수 없다. parser/scanner/access policy/fixture 5개는 원본
C06와 그대로이며 TTL·provider 거부·한도·store/worker/crypto는 변경하지 않았다.

새 `apps/web/tests/mvp-browser/verify_mail_page_lifecycle.py`는 Playwright의 기본
`--disable-back-forward-cache`만 제거한 fresh owned Chromium을 사용한다. browser 보안·
request/WebSocket guard·외부 호출 금지는 유지한다. native case에서 persisted=true를
assert하며 같은 canonical fixture의 정확한 두 후보/Harbor 부재를 검사한다.
이는 Windows 보안 정책 변경이나 실제 사용자 profile 접근이 아니다.

| 명령 (`apps/web`) | exit | 결과 |
| --- | ---: | --- |
| `python tests/mvp-browser/verify_mail_page_lifecycle.py --dist /tmp/keyatlas-one-hour-20261004/shell-final/dist --output /tmp/keyatlas-one-hour-20261004/mail-lifecycle-before` | 1 | cached native return의 cleared assertion 실패. product는 이전 `eac780…` build이며 QA 도구는 현재 source |
| `python tests/mvp-browser/verify_mail_page_lifecycle.py --dist dist --output /tmp/keyatlas-one-hour-20261004/mail-lifecycle-after` | 0 | native bfcache/persisted=true·재동의·scripted persisted/nonpersisted pagehide·storage/network 부재 5개 PASS/errors 0 |
| `npm test` | 0 | pagehide 보완 뒤에도 60 files / 1,858 PASS |
| `npm run build` | 0 | pagehide 보완을 포함한 production build |

현재 source/QA 집합은 `20efe70cf9e4004fc431bd404f172140b556f70a1ed9a36800749ed2a754c63c`이다.
이는 commit SHA가 아니라 sorted path+NUL+file hash+LF의 aggregate SHA-256이다.
앞선 셸 24개·C02/C04/C06 entry 검사와 `eac780…`는 pagehide 수정 전 단계의 증거로 보존하고,
최신 build에서 필요한 검사를 새로 기록한다. native bfcache의 표준 load event를 기다리던
초기 임시 collector는 timeout/exit 1이었다. 실제 history.back 뒤 location/panel/pageshow
관찰로 fixture를 수정했으며 cache 복원을 fresh load로 취급하지 않았다.
scripted pagehide는 native cache case와 별도로 표시한다. heap erasure·다른 browser·실제
모바일·OS sleep·실제 Gmail/Secret의 안전성을 증명하지 않는다.

현재 pagehide 보완 뒤의 직접 검사도 완료했다.

| 명령 (`apps/web`) | exit | 결과 |
| --- | ---: | --- |
| `python tests/mvp-browser/verify_app_shell.py --dist dist --output /tmp/keyatlas-one-hour-20261004/shell-pagehide-final` | 0 | 현재 source의 셸 24 PASS/errors 0 |
| `python src/features/signup-mail-discovery/verifySignupMailBrowser.py --view integrated --timezone UTC --dist dist --output /tmp/keyatlas-one-hour-20261004/mail-pagehide-entry-final` | 0 | 현재 앱 진입 12 PASS/errors 0 |
| `node --input-type=module -e 'import { build } from "vite"; await build({ build: { outDir: "/tmp/keyatlas-one-hour-20261004/c06-pagehide-standalone-dist", rollupOptions: { input: "signup-mail-discovery.html" } } });'` | 0 | 별도 현재 standalone artifact, repo config/build 변경 없음 |
| `python src/features/signup-mail-discovery/verifySignupMailBrowser.py --view standalone --timezone Asia/Seoul --dist /tmp/keyatlas-one-hour-20261004/c06-pagehide-standalone-dist --output /tmp/keyatlas-one-hour-20261004/mail-standalone-pagehide-final` | 0 | 현재 독립 화면 12 PASS/errors 0 |
| `npm run typecheck` | 0 | pagehide 보완 뒤 현재 source |
| `npm run build` | 0 | 마지막 current source/QA 집합으로 build, 실제 browser copy와 5개 자산 bytes 동일 |
| `python src/features/local-vault/verifyVaultLifecycleBrowser.py --dist dist --output /tmp/keyatlas-one-hour-20261004/lifecycle-pagehide-final --mode all` | 0 | 마지막 source의 19 PASS/errors 0, 955.90초. 실제 시간/URL/File·동시성·disk v2 근거 포함 |

repo source를 수정하지 않는 임시 QA도 추가했다. 명령은 repository root에서
`python /tmp/keyatlas-one-hour-20261004/verify_native_bfcache_immediate.py --dist /workspace/secure-vault/apps/web/dist --output /tmp/keyatlas-one-hour-20261004/native-bfcache-immediate-final`이며
exit 0 / 4 PASS/errors 0이다. 도구 SHA-256은
`8be728db6c785ae9f544469eb727831009bc43ea2231e4995ec170f1d0b848a6`이다.
금고, backup URL, backup selected File, C06 모두 실제 persisted=true를 assert했다.
init-script의 첫 pageshow listener가 **다른 product resume handler보다 먼저** DOM을
관찰해 private slot 0·locked 상태, 다운로드 링크/사용 확인/선택 파일 부재, 메일 후보/동의
버튼 부재를 확인했다. 기다린 뒤의 eventual 상태만 검사한 것이 아니다. readonly probe의
archive hash도 같았다. 실제 URL 해제/File 무읽기의 기존 lifecycle 검사와 별도 증거이며,
이 임시 도구/기록은 local 검토 package에 포함한다. OS sleep·heap erasure 증거는 아니다.

PR #9의 기존 release artifact manifest 도구도 현재 web build 5개 파일에 별도 실행했다.
create/verify exit 0이며 code authenticity/signature·실제 release·전체 Pester/Windows 근거는
아니다. repo/CI에 새 tool을 추가하거나 실제 게시/배포하지 않았다. 정확한 command는
`artifact-pagehide-create.json`/`artifact-pagehide-verify.json`에 있다.

최종 Secret/whitespace/link/소유 파일 보존 및 clean archive patch 복원 결과는 local evidence의
`repository-secret-scan-frozen.json`, `final-integrity.json`, `patch-validation.json`,
`review-bundle-validation.json`을 따른다. 이것은 실제로 만들어진 최종 record의 결과를
확인하는 경로이며 처음 Secret scan과 metadata 작성 뒤의 frozen 검사를 구분한다.
새 source/QA의 60개 aggregate는 위 `20efe70c…`와 같으며 이전 snapshot들은 이력이다.

## 남은 경계와 다른 AI

이번에는 benefits 코드/검사가 변경되지 않았다. 앞선 1,354 test·boundaries/smoke는 같은
source의 앞선 근거이며 이 1시간에 새로 실행했다고 보고하지 않는다.
Rust workspace verifier의 앞선 FAIL/101·Linux SQLite 19 실패·기존 1 ignored,
native Windows NOT_RUN, Node browser runner BLOCKED/2, scanner Windows regression 실패·
Pester 모듈 BLOCKED, 최신 GitHub PR/Issue/CI API 조회 부족은 그대로다.
Firefox/WebKit executable은 이 환경에서 발견되지 않았고 새 browser를 설치하지 않았다.

실제 인증·DB·Gmail·AI·Secret·운영 인프라/배포는 아직 없다. C06→C04 결과 전달도 구현하지
않았다. core/wire 결함과 R5A 실제 adapter는 설계/승인 범위가 확정돼야 한다.
다른 AI의 허용/금지 파일·기준·선행·완료 조건과 복사 prompt는
[10/4 배정 초안](../../handoff/mvp-20260927/NEXT_ASSIGNMENTS_2026-10-04.md)에 있다.
commit/push/PR·실제 AI 배정·실환경 재개는 사용자 별도 승인 사항이다.
