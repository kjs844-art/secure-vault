# Cloud 후속 — 합성 수명 주기·충돌·백업·모바일 QA

2026-10-03 / **LOCAL_SYNTHETIC_CHECKS_COMPLETE / PUBLICATION_HOLD**.
추가 작업 시작: `2026-10-03 15:36:19 UTC`. 요청된 종료 시각: `17:36:19 UTC`.
현재 결과는 미커밋 overlay의 합성 구현/검사다. commit/push/PR/main merge,
다른 AI 세션 생성·메시지 전송, 실제 Secret/provider/DB/infra/배포는 실행하지 않았다.
`REAL_SECRET_GATE=CLOSED`.

## 기준과 소유 파일

- checkout: `/workspace/secure-vault`.
- branch: `codex/firstvibe-cloud-catalog-client-fix-20261003`.
- Git HEAD: `afbc0fbc4dd41669e468d8658965ef8f5f10ee7d`.
- 앞선 55개 변경 파일 snapshot: `/tmp/keyatlas-two-hour-20261003/before.json`.
- 앞선 [39개 source manifest](2026-10-03-cloud-source-manifest.json)는 그때의 이력이다.
  후속 UI/QA 변경을 포함한 최신 트리와 동일하지 않으며 이전 결과를 덮어쓰지 않는다.
- 로컬 readiness의 미푸시 9개 catalog-client/loopback 파일은 **NOT_RECEIVED**다.
  이번 cloud 코드와 통합됐거나 중복이 없다고 단정하지 않는다.

| 이번 추가 범위 | 경로/변경 |
| --- | --- |
| 금고·백업의 사라진 초점 | `apps/web/src/features/local-vault/LocalVaultPanel.tsx`, `SyntheticBackupPanel.tsx`: 이전 컨트롤이 제거/비활성화되어 foreground 초점이 body로 빠진 때 상태 문단으로 복원 |
| 충돌 검토 초점 | 같은 폴더 `SyntheticConflictReviewPanel.tsx`: 읽기/폐기 상태 및 후보 heading에 초점, 후보 reference와 reviewVersion 결합 유지 |
| 진행 불러오기 초점 | 같은 폴더 `SyntheticRotationStagePanel.tsx`: 명시적으로 불러오기 시작할 때 잃은 초점 복원. `SyntheticRotationStagePanel.interaction.test.tsx`의 DOM 없는 기존 callback harness는 effect를 실행하지 않는다고 명시 |
| 초점 표시 | 같은 폴더 `local-vault.css`: programmatic heading/status의 focus-visible 표시 |
| 실제 browser 회귀 | 같은 폴더 `verifyVaultLifecycleBrowser.py`: 실제 WASM/IndexedDB/파일·다중 탭·수명 주기. clock mock/real timing을 별도 구분 |
| 모바일 target | `apps/benefits-web/src/components/mvp-demo/{AttentionList,ServiceList}.tsx`: current view의 버튼을 최소 44×44px로 보완 |
| benefits hydration 회귀 | `apps/benefits-web/tests/verify_synthetic_browser.py`: 실제 production SSR·hydration·키보드·history·mobile·serverFn·저장소/cookie 부재 |
| 문서 | 두 앱 README, 현재 readiness/후속 배정과 R5A 설계의 source/evidence 구분 보완 |

시간/크기 제한, session/worker/store/wire/crypto 및 운영 인증/CSRF/CI 정책은 이번 UI 보완에서
바꾸지 않았다. 기존 Windows cfg-only 보완도 그대로 보존했다. 새 dependency/version/
lockfile 변경이나 browser 다운로드는 없다.

## 재현과 원인

| 관찰 | 수정 전 근거 | 보완/판정 |
| --- | --- | --- |
| 등록 뒤 초점 BODY | `lifecycle-focus-observed-before`, exit 1 | 제거되는 form/disabled 버튼의 foreground 초점만 상태 문단으로 복원 |
| 충돌 후보 읽기 뒤 초점 BODY | `lifecycle-after-root-focus`, exit 1 | 요청에 결합한 status/heading 초점. 두 단계 폐기·CAS·generation 조건 유지 |
| 미해결 후보의 backup 거부 뒤 초점 BODY | `backup-focus-before`, exit 1 | backup UI의 사라진 초점 복원. 거부·보존 정책 그대로 |
| 진행 불러오기 뒤 초점 BODY | `rotation-stage-focus-before`, exit 1 | stage UI에만 초점 처리. core/state/wire 변경 없음 |
| 모바일 일부 버튼 높이 25/34.72px | `benefits-mobile-target-before`, exit 1 | 44px 목표로 보완. 수정 후 current view 11개 버튼 모두 width/height ≥44px |

수동 잠금 버튼이나 다른 연결된 컨트롤에 남아 있는 초점은 유지한다. background에서
강제로 초점을 가져오지 않는다. DOM/JS 참조 정리를 heap의 안전 삭제로 표현하지 않는다.
최종 읽기 검토에서 conflict 패널의 effect에 foreground/body 조건이 빠져 있음을 발견해
다른 패널과 같은 조건을 추가했다. headless Chromium은 두 페이지 모두 `hasFocus=true`,
`hidden=false`로 보고하므로 실제 background/OS 전환의 runtime 증거는 아니다.
foreground 회귀와 전체 웹 검사는 이 조건 보완 후 다시 실행했다.

다음 실패는 product 정책 변경으로 해결하지 않은 **QA fixture/전송 방식의 보정**이다.

- benefits의 전역 `role=status`는 router announcer와 history notice 둘을 가리켰다.
  history notice를 범위로 지정하고 1개 및 내용 assertion을 유지했다.
- `route.fetch()`는 APIRequestContext 전송이어서 serverFn에 browser Fetch Metadata가 없어
  기존 CSRF가 403으로 차단했다. 해당 same-origin GET만 실제 browser transport로 전달해
  200을 확인했다. CSRF·header policy를 약화하거나 가짜 header를 주입하지 않았다.
- 두 locator click을 동시에 예약해도 짧은 작업은 actionability polling에서 순차화됐다.
  enabled/visible/위치를 먼저 확인한 실제 pointer 이벤트로 두 요청을 예약했다.
  busy interval의 실제 overlap을 계속 assert했다. 앞선 직접 검사는 973.5ms overlap,
  현재 head 1개·인증 가능한 후보 1개를 확인했다. DB commit의 나노초 동시성 증명은 아니다.
- 첫 rotation fixture는 연결 없는 public seed reference 0이었다. 연결처 검사의 assertion을
  삭제하지 않고 multi-consumer reference 2로 지정해 MCP/CLI/CI 3개를 모두 검사했다.
- `lifecycle-all-current`는 setup/crypto 중 흐른 시간이 clock 설치 뒤의 299초 경계에 포함되어
  가속 idle 검사가 exit 1이었다. clock 설치만으로 시간은 멈추지 않는다. setup 전에 명시적으로
  virtual clock을 pause한 fixture로 바꾸었고 299초 열림/301초 잠김 assertion을 그대로 유지했다.
  실제 5분 정책·실제 시간 검사는 변경하지 않았다. `controlled-clock-quick` 8개 PASS, exit 0.

실패 기록과 이전 산출물은 `/tmp/keyatlas-two-hour-20261003`에 별도로 보존했다.
skip·무조건 retry·assertion 삭제로 실패를 숨기지 않았다.

## 직접 검사 명령과 exit

표의 상대 경로는 해당 app 폴더 기준이다. 전체 Git HEAD는 위와 같고 실제 검사 대상은
각 기록의 source hash 및 복사된 production artifact다. HEAD만 checkout하면 같은 트리가 아니다.

| cwd / 정확한 명령 | exit | 결과 |
| --- | ---: | --- |
| `apps/web`: `node --test tests/mvp-browser/qa-core.node-test.mjs tests/mvp-browser/synthetic-idb-probe.node-test.mjs tests/mvp-browser/qa-lifecycle.node-test.mjs tests/mvp-browser/runner-config.node-test.mjs` | 0 | 180 PASS, FAIL/cancel/skip 0 |
| `apps/web`: `node tests/mvp-browser/local-vault-qa.mjs --synthetic-only` | 2 | **BLOCKED**, BROWSER_RUNTIME_UNAVAILABLE. Node runner PASS 아님 |
| `apps/web`: `npm test -- src/features/local-vault/SyntheticRotationStagePanel.test.tsx src/features/local-vault/SyntheticRotationStagePanel.interaction.test.tsx` | 0 | 기존 callback/static 검사 13 PASS, 실제 DOM 효과 증거와 별도 |
| `apps/web`: `npm test` | 0 | 최종 conflict 초점 조건 보완 뒤 57 files / 1,823 PASS |
| `apps/web`: `npm run typecheck` | 0 | 현재 source |
| `apps/web`: `npm run build` | 0 | 현재 production bundle |
| `apps/benefits-web`: `npm test` | 0 | target 보완 뒤 1,354 PASS, FAIL/cancel/skip 0 |
| `apps/benefits-web`: `npm run typecheck` | 0 | 현재 source |
| `apps/benefits-web`: `npm run build` | 0 | 현재 SSR/public bundle |
| `apps/benefits-web`: `npm run check:boundaries` | 0 | 기존 정책 유지 |
| `apps/benefits-web`: `npm run test:smoke` | 0 | owned loopback SSR smoke |
| `apps/benefits-web`: `node --import tsx --test tests/bounded-json.test.ts` | 0 ×3 | 25 PASS씩, 전체 1,354 검사와 비교. reader/test source 추가 변경 없음 |
| repo root: `git diff --check` | 0 | tracked whitespace 및 소유 파일/상대 링크 검사와 함께 확인 |
| repo root: `/tmp/keyatlas-powershell-tools/extracted/opt/microsoft/powershell/7/pwsh -NoProfile -NonInteractive -File ./scripts/check-repository-secrets.ps1 -Root /workspace/secure-vault` | 0 | R5A-1 문서를 추가한 70개 소유 파일 트리에서 검사. scan 동안 hash 변경 없음 |

고정 app 의존성은 앞선 README 절차로 설치된 것을 재사용했다. Node 24.19.0 / npm 11.9.0,
tool Python Playwright 1.62.0 / system Chromium 151.0.7922.173 환경이다.
app에 Python/browser dependency를 추가하거나 Node package로 alias하지 않았다.
Node의 playwright/chromium/firefox/webkit launch 경로는 실제 존재 여부를 확인했으며
없는 browser/runtime을 설치된 것처럼 만들지 않았다.
Secret scanner의 환경은 기존 전용 `/tmp/keyatlas-powershell-tools/xdg-cache`, `xdg-config`,
`xdg-data`를 각각 `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`에 설정했다.
HOME/Windows 보안 정책을 바꾸지 않았다. 70개 트리 검사 command/exit·입력 hash는
`repository-secret-scan-after-oauth-design.json`에 있고, 최종 기록 metadata 정리 뒤의 고정 트리는
별도 `repository-secret-scan-frozen.json`으로 확인한다. 이 외부 evidence 파일을 저장하는 작업은
repo source를 변경하지 않는다.

실제 Python CLI는 아래처럼 실행했다. `OUT`은 매번 새 전용 `/tmp` 경로이며,
각 command JSON에 실제 argument와 exit·경과시간이 있다.

```bash
# apps/web
python src/features/local-vault/verifyVaultLifecycleBrowser.py --dist dist --output OUT --mode quick
python src/features/local-vault/verifyVaultLifecycleBrowser.py --dist dist --output OUT --mode contention
python src/features/local-vault/verifyVaultLifecycleBrowser.py --dist dist --output OUT --mode rotation-stage
python src/features/local-vault/verifyVaultLifecycleBrowser.py --dist dist --output OUT --mode disk-backup
python src/features/local-vault/verifyVaultLifecycleBrowser.py --dist dist --output OUT --mode runtime-failure
python src/features/local-vault/verifyVaultLifecycleBrowser.py --dist dist --output OUT --mode backup-real-timing
python src/features/local-vault/verifyVaultLifecycleBrowser.py --dist dist --output OUT --mode real-timing
python src/features/local-vault/verifyVaultLifecycleBrowser.py --dist dist --output OUT --mode all
```

| 실제 output suffix / mode | exit | 확인 범위 |
| --- | ---: | --- |
| `backup-resource-qa` / quick | 0 | 당시 8개, explicit review/폐기·backup 차단·native URL revoke·actual FileChooser 크기/형식·원본 보존 |
| `native-contention-pointer-qa` / contention | 0 | 2개: overlap·현재 head/후보, 8개 outbox 보존과 9번째 거부 |
| `rotation-stage-multiple-consumers` / rotation-stage | 0 | 2개: 진행 재열기, 저장/검토/동의·선택 변경·최종 확정 후 stage 미재적용 |
| `disk-backup-v2-qa` / disk-backup | 0 | 실제 disk → fresh owned persistent profile/FileChooser → v2 restore → browser restart, byte equality·기존 금고 보존 |
| `owned-wasm-failure-qa` / runtime-failure | 0 | own WASM GET만 의도적으로 거부. 고정 BRIDGE_FAILURE, 2초 자동 retry 없음·암호문 보존, 복구 후 명시적 재열기 |
| `backup-real-clock-qa` / backup-real-timing | 0 | clock mock 없음. URL revoke 301.79초·선택 파일 해제 301.83초, 파일 읽기 0·암호문 동일 |
| `lifecycle-real-final` / real-timing | 0 | stage 초점 보완 전 artifact. idle 299.13초·untrusted input 298.21초·trusted Tab renewal 541.73초, foreground status 초점·암호문 동일 |
| `controlled-clock-quick` / quick | 0 | 현재 pause fixture에서 8개. 299초 전후 경계·manual lock 초점 유지 |
| `lifecycle-controlled-all` / all | 0 | 19개 PASS, 947.94초. 그때의 source `7eaec80…`, 이후 QA 설명/초점 guard 수정 전 기록 |
| `lifecycle-final-guard-all` / all | 0 | 최종 source/fixture 19 PASS / errors 0, 951.78초. source `ea2f2def…`와 byte-identical |

최종 실제 시간 결과는 URL revoke 301.50초, 선택 파일 해제 301.47초, idle 잠금 299.59초,
untrusted input 미연장 299.52초, trusted Tab 갱신 뒤 잠금 541.82초다. 시계 mock은 없다.
두 탭 등록 busy interval은 1,073.6ms 겹쳤고 현재 head 1개·인증 후보 1개를 확인했다.
이 값들을 DB commit의 엄밀한 동시성, OS sleep/background 동작, heap 안전 삭제로 확대하지 않는다.

최종 명령은 `apps/web`에서 다음과 같고 exit 0이다.

```bash
python src/features/local-vault/verifyVaultLifecycleBrowser.py --dist dist --output /tmp/keyatlas-two-hour-20261003/lifecycle-final-guard-all --mode all
```

같은 최종 앱 bundle의 화면 진입도 다시 확인했다. 아래 경로/명령은 `apps/web` 기준이다.

| 정확한 명령 | exit | 결과 |
| --- | ---: | --- |
| `python src/features/identity-map/verifyIdentityMapBrowser.py --dist dist --output /tmp/keyatlas-two-hour-20261003/identity-map-current-bundle` | 0 | 3개 PASS |
| `python src/features/discovery-inbox/verifyDiscoveryInboxBrowser.py --dist dist --output /tmp/keyatlas-two-hour-20261003/discovery-inbox-current-bundle` | 0 | 3개 PASS; production 및 별도 prop 교체 probe 구분 |
| `python src/features/signup-mail-discovery/verifySignupMailBrowser.py --view integrated --timezone UTC --dist dist --output /tmp/keyatlas-two-hour-20261003/signup-mail-current-integrated` | 0 | 12개 PASS |
| `python src/features/signup-mail-discovery/verifySignupMailBrowser.py --view standalone --timezone Asia/Seoul --dist dist --output /tmp/keyatlas-two-hour-20261003/signup-mail-current-standalone` | 1 | **NOT_RUN**: 기본 앱 build에는 독립 HTML이 없어 prerequisite에서 종료. product assertion 실행 안 됨 |

독립 entry는 기존 검증 문서의 Vite build API 절차로 별도 build했다. 기본 앱 설정은 바꾸지 않았다.

```bash
node --input-type=module -e 'import { build } from "vite"; await build({ build: { outDir: "/tmp/keyatlas-two-hour-20261003/c06-standalone-current-dist", rollupOptions: { input: "signup-mail-discovery.html" } } });'
python src/features/signup-mail-discovery/verifySignupMailBrowser.py --view standalone --timezone Asia/Seoul --dist /tmp/keyatlas-two-hour-20261003/c06-standalone-current-dist --output /tmp/keyatlas-two-hour-20261003/signup-mail-current-standalone-corrected
```

별도 build와 올바른 dist의 browser exit 0 / 12 PASS / errors 0이다.
`c06-standalone-corrected-checks.json`에 정확한 argument/exit/경과시간을 기록했다.
첫 실행의 prerequisite 실패는 위와 같이 보존하며 무조건 retry한 결과로 감추지 않는다.

benefits의 최신 실제 CLI는 owned ephemeral port에서 실행했다.

```text
node /tmp/keyatlas-two-hour-20261003/run-benefits-browser.mjs /tmp/keyatlas-two-hour-20261003/benefits-mobile-target-after
```

launcher는 기존 `localEnvironment` allowlist를 재사용해 provider 설정을 제외하고 자신의
SSR child만 시작/종료했다. 실제 내부 Python argument는
`benefits-mobile-target-after-command.json`에 ephemeral port까지 기록했다.
exit 0 / 7 checks / page·console·외부 request error 0 / 8 actual asset digest.
hydration·현재 6개/지난 2개·unknown/관찰 시각·키보드·360px·44px button·native serverFn 200,
local/session/IndexedDB 저장소와 cookie 부재를 확인했다.
재사용 방법은 [benefits README](../../../apps/benefits-web/README.md)에 있다.

## source·artifact 결합과 보존

현재 source/contract/fixture/QA 49개 집합의 aggregate는
`ea2f2def6aebb788b1918066feeba530d972ea2465e98a9293ab58c32a8dab2a`이다.
알고리즘은 정렬한 `path + NUL + sha256 + LF`의 SHA-256이다. commit SHA가 아니다.
`final-guard-all-source-at-start.json`은 같은 집합과 full HEAD를 가진다.
README/운영/설계/검증 문서는 이 source aggregate에서 제외한다.

앞선 19개 실행 뒤 QA module 설명의 '사용자 profile 접속 없음'과 '새 owned profile 사용'을
정확히 구분했다. 그 설명 수정 전후 executable AST hash는 같은
`1ed3ebaa70ec8ec7a793cac539562caef13b68e0e75e4e2c74c66719874d353c`였고 `--help` exit 0이었다.
이후 conflict guard도 추가했으므로 이전 `7eaec80…` source가 현재 source와 같다고 표현하지 않는다.

각 vault runner는 입력 build를 새 output/dist로 복사한다. 실제 GET response bytes가
해당 파일과 같은지 확인하고, off-origin/non-GET/WebSocket을 거부한다.
정확한 합성 DB/store/version/key shape·크기/개수를 readonly completed transaction에서
검사한 뒤 ciphertext digest/size만 기록한다. ID/암호문 원문·메일/token/log/HAR는 보고하지 않는다.
의도적 WASM load 실패는 fail fixture의 거부 1회를 별도 assert한 검사다.
native URL/file observer도 원래 browser API를 호출하며 가짜 성공을 공급하지 않는다.
병렬 실제 시간 검사는 sibling 실패 시에도 각 cleanup을 끝낸 뒤 FAIL을 반환한다.

전체 변경 파일·source/production artifact digest·원래 55개 보존·staged/head/branch·
Secret/whitespace/link 검사와 전달용 patch 검증은 아래 manifest 및 전용 임시 evidence로 구분한다.
[최신 manifest](2026-10-03-cloud-lifecycle-source-manifest.json)는 70개 소유 파일 중 자기 hash를
제외한 69개와 source 49개를 기록한다. 현재 보존 검사는 기존 55개 중 48개 동일·7개 의도한
보완, cloud client/loopback 9개와 C06 policy/scanner/fixture 5개 동일, staging 영역 비어 있음,
최종 browser에 복사한 build byte equality·tracked/untracked whitespace·상대 링크 문제 0이다.
문서 정리 뒤 최종 `integrity-current.json`을 다시 생성하고 patch 복원 hash와 함께 대조한다.

전달용 patch 초안은 `/tmp/keyatlas-two-hour-20261003/keyatlas-cloud-review.patch`다.
기준 `afbc0fbc…`의 새 `git archive` 복사본에서 `git apply --check --whitespace=error`와
`git apply --whitespace=error`가 각각 exit 0이고 소유 69개 파일 hash가 일치했다.
ignored WASM/build/node_modules/browser profile/합성 backup/raw log를 포함하지 않는다.
최종 문서 정리 뒤 patch를 재생성·재검증한다. workspace에는 apply/stage/commit하지 않았다.
R5A-1 문서를 포함한 70개 patch도 `patch-validation-post-design.json`에서 exact 기준에 복원한
모든 hash가 일치했다. 최종 metadata를 포함한 patch의 byte hash/복원은
`patch-validation-final.json`으로 고정한다. 이 기록은 patch와 같은 전용 임시 evidence에 있다.

관찰 main `65d10dce…`의 별도 archive에서 같은 `git apply --check --whitespace=error`는
exit 1이었다. 필수 앱 파일 부재와 web README context 차이다. main에 patch를 적용·병합한
것이 아니며 main 통합은 미완료다. 두 적용 대상/exit를 `patch-validation-draft.json`에 구분했다.

`remote-ref-final-review.json`의 exact `git ls-remote origin refs/heads/... refs/pull/.../head`
exit 0에서 main/history와 선택한 PR 20개의 head가 이전 관찰 SHA와 일치했다.
cloud 작업/로컬 readiness branch ref는 없었다. #6/#19/#29의 cloud HEAD ancestry와
main ancestry는 별도로 검사했고, 그 결과를 PR OPEN/MERGED·CI로 해석하지 않았다.
`git rev-list --count origin/main..HEAD` exit 0의 63개는 main과의 이력 차이이며 미푸시
commit 63개라는 뜻이 아니다. HEAD 자체는 원격 #29 tip과 같고 이번 시간 구간의 새 commit은
0개다. 누적 소유 파일 70개는 staging 밖의 미커밋 파일이며 작업 branch의 원격 ref도 없다.

브라우저 최종 실행 뒤 추가한 [R5A-1 authority/OAuth 설계](../../handoff/mvp-20260927/R5A_AUTHORITY_AND_OAUTH_DESIGN_2026-10-03.md)는
문서뿐이다. 앱/메일/실제 금고 권한 분리, callback correlation·늦은 결과·token/refresh/cleanup의
승인 전 조건을 구체화했다. 운영 코드·cookie·route·OAuth/DB 설정을 추가하지 않았고 실제 검사는
NOT_RUN이다. source 49개 및 검증한 production build hash는 이 문서 변경으로 달라지지 않았다.

## 실패·미검증·다음 담당

- 앞선 Rust workspace verifier **FAIL / exit 101**은 그대로다. Linux SQLite 기존
  19개 실패·기존 1 ignored와 exact 기준 재현, Clippy/VFS/doctest/compile-fail의 별도 결과는
  [앞선 검증](2026-10-03-cloud-discovery-integration.md)을 따른다. 이번 UI 수정으로 PASS 승격하지 않는다.
- native Windows, OS sleep/background tab·수동 파일 dialog, Firefox/WebKit·실제 모바일/
  screen reader, heap erasure, real Secret/backup rollback/기기 철회는 **NOT_RUN**이다.
- Secret scanner 전체 regression의 Windows fixture 실패, workflow Pester 미설치 BLOCKED와
  실제 repository scan은 구분한다. 실제 저장소 scan은 위 명령으로 exit 0이며 scanner 전체
  regression/Pester/Windows 검사를 PASS로 승격하지 않는다.
- GitHub Issue/PR public API의 credential 없는 GET 재확인도 URLError로 **BLOCKED / exit 3**다.
  최신 PR OPEN/MERGED·CI 결과는 추측하지 않는다. Issue #30 판단은 사용자가 전달한 본문을 유지한다.
- 실제 Gmail/auth/DB/AI, C06→C04/server의 새 handoff는 구현/검증되지 않았다.
  [원자 저장·철회·삭제 설계](../../handoff/mvp-20260927/R5A_TRANSACTION_AND_DELETION_DESIGN_2026-10-03.md)는
  proposal이며 runtime adapter·migration·endpoint·실환경 성공이 아니다.
- M05A는 현재 자동화 증거를 보존하고 native/교차 browser·수동/기기·독립 부족분을 맡는다.
  M04A/R4A의 별도 고정 SHA 리뷰는 미실행이며 자기 QA가 이를 대신하지 않는다.
  [후속 배정](../../handoff/mvp-20260927/NEXT_ASSIGNMENTS_2026-10-03.md)은 아직 실제 전송되지 않았다.

출시 기간과 미완료 목록은 [현재 readiness](../../handoff/mvp-20260927/SERVICE_READINESS_2026-10-03.md)에 있다.
승인/환경 재개 대기를 개발 공수에 포함하지 않으며 이번 합성 PASS를 배포 완료로 보고하지 않는다.
