# Cloud C04/C06 합성 연결·계약 검토 — 2026-10-03

상태: **LOCAL_UNCOMMITTED / SYNTHETIC_ONLY / REAL_SECRET_GATE=CLOSED**.
사용자의 지속 작업 요청 안에서 기존 제출물의 부족분을 보완했다. commit/push/PR 생성/
merge·다른 AI 실제 배정·실제 provider/Secret·infra/비용/배포 실행은 하지 않았다.
현재 검사는 HEAD 위의 미커밋 overlay 검사다. HEAD만 checkout하면 같은 source가 아니다.

## 변경 파일과 범위

| 경로 | 변경 |
| --- | --- |
| `apps/web/src/features/discovery-inbox/DiscoveryInboxPanel.tsx` | #26 선택 재사용. seed와 수정 state를 분리, 검토 후 초점, 합성/수동 분류 의미 안내 |
| `apps/web/src/features/discovery-inbox/discoveryInboxModel.ts` | #26 재사용. display whitelist로 불필요한 raw 추가 필드 복사를 차단 |
| 같은 폴더 `DiscoveryInboxPanel.test.tsx`, `discoveryInboxModel.test.ts` | 기존 검사 보존, 필드 projection 회귀·화면 안내 검사 |
| 같은 폴더 `discovery-inbox.css`, `syntheticDiscoveryInboxFixture.ts` | #26 원본 선택 재사용 |
| 같은 폴더 `verifyDiscoveryInboxBrowser.py` | 실제 production view/filter/review/focus/mobile 및 React prop 교체 검사. 고정 source/build 재사용 |
| `apps/web/src/features/signup-mail-discovery/SyntheticSignupMailDiscoveryPanel.tsx` | 기존 C06 재사용. 앱 진입 안내·KST display·사용자 동작/만료 초점 보완 |
| 같은 폴더 `SyntheticSignupMailDiscoveryPanel.test.tsx`, `signup-mail-discovery.css` | 기존 검사 유지·합성 의미 안내, 앱 공통 스타일과 충돌 없는 scoped panel |
| 같은 폴더 `verifySignupMailBrowser.py` | standalone/앱 링크 진입, UTC 환경 KST 표시, 선택/취소/만료·초점, static network/storage/360px 검사 |
| 같은 폴더 `signupMailAccessPolicy.ts`, `signupMailDiscovery.ts`, 두 model/policy tests | C06 원본 그대로. live provider 거부·exact consent·고정 TTL/한도 유지 |
| 같은 폴더 `demo.tsx`, `demo-icon.svg` 및 `apps/web/signup-mail-discovery.html` | C06 기존 standalone entry 재사용 |
| `tests/fixtures/synthetic/signup-mail-discovery-v1.json` | C06 고정 합성 fixture 그대로 |
| `contracts/local-v1/signup-mail-discovery-v1.md` | 기존 계약 선택 재사용. 현재 local 앱 연결/미연결 경계에 대한 유지보수 주석 |
| `apps/web/src/App.tsx`, `src/main.tsx`, `src/features/local-vault/LocalVaultPanel.tsx` | C04/C06 독립 합성 링크·진입. 기존 rotation/error·관계 화면·gate 안내 보존 |
| `apps/web/src/features/identity-map/IdentityMapPanel.tsx`, panel test, `identity-map.css` | embedded h2 아래 단계 h3로 의미 계층/초점 표시 보완 |
| 같은 폴더 `verifyIdentityMapBrowser.py` | 이전 실제 browser 검사를 CLI로 보존. 기존 shared synthetic IDB probe를 그대로 import, 새 dependency 없음 |
| `docs/privacy/mvp/2026-10-03-korea-data-handling-draft.md` | T1/T2/T3와 metadata/FULL 목적별 한국 개인정보·보존/삭제 초안 |
| `docs/deployment/mvp/2026-10-03-release-operations-draft.md` | 실행 보류·고정 artifact·장애/rollback·운영 미확정 값 초안 |
| `docs/handoff/mvp-20260927/R5A_PURPOSE_AND_ACCEPTANCE_2026-10-03.md` | 목적별 R5A 승인/acceptance, 동일 프로세스 provenance와 영속 handoff 구분 |
| 같은 폴더 `DOMAIN_CONTRACT_REVIEW_2026-10-03.md` | #25/#27 읽기 검토, C03 CBOR 요소 수 불일치·D01 의미 결정과 최소안. core 수정 없음 |
| 같은 폴더 `NEXT_ASSIGNMENTS_2026-10-03.md` | exact 시작점·overlay·담당 branch/파일·선행/완료 기준·복사용 prompt. 실제 전송/세션 생성 없음 |
| 같은 폴더 `PROVIDER_ADAPTER_PLAN.md`, `REAL_SECRET_CORE_PLAN.md`, `SERVICE_READINESS_2026-10-03.md` | 후속 설계/검토 링크·현재 완료/실패 범위 갱신 |
| 이 기록 및 `2026-10-03-cloud-source-manifest.json` | 현재 source hash·정확한 검사/한계 기록 |

앞선 client/HTTP QA·합성 WASM/Rust cfg 보완은 보존했다. 이후 docs에는 당시 기록을
덮어쓰지 않고 최신 결과를 추가했다. #26/C06의 과거 전체 App/core/handoff/게시 권한은
이식하지 않았다. 새 dependencies·versions·lockfile·CI/auth/crypto/reader 정책 변경 없음.

## SHA와 검사 대상

| 대상 | 값 |
| --- | --- |
| checkout / branch | `/workspace/secure-vault` / `codex/firstvibe-cloud-catalog-client-fix-20261003` |
| 실제 HEAD | `afbc0fbc4dd41669e468d8658965ef8f5f10ee7d` |
| 원격 main 관찰값 | `65d10dceb13039dc69cf2368aa0e31d7ad5cc6b2` |
| HEAD/main merge-base | `ceca9f43c4f92b3b0e4081d84be8612b10f03582` |
| #26 원격 source | `d017a9da5969ae2cd723eb72cbd56ef08e63fb0f` |
| KA-C06 원격 source | `117a8f151615c181549432de8800a65e902baf8d` |
| #25/#27 읽기 검토 source | `a72a6817ef1970c271850af18415b6fb9f5550c7` / `9dc9af3d980ba574ab0afb8715b5bd0c2239d036` |
| 현재 39개 구현/검사/fixture/entry 파일 hash 묶음 | `9caadb53e6675181a12715601a248f977f6c8b274785ad33daf34098d32471c5` |
| 새 commit / push / PR / staging | 없음 / 하지 않음 / 생성 안 함 / 없음 |

개별 hash/계산법은 [source manifest](2026-10-03-cloud-source-manifest.json)에 있다.
현재 묶음은 앞선 19개 소스 hash `330814…`를 대체하는 최신 overlay 식별값이다.
두 값은 각 검사 시점의 별도 source이며 Git commit SHA가 아니다.
Google/GitHub live 정책·PR merge/최신 CI 증거로 Git ref를 사용하지 않는다.

## 재현한 원인과 최소 보완

- **C04 동작 취소:** reducer가 items 배열을 새로 만들면 기존 `view.items === seed.items`
  비교가 실패해 매번 초기 seed를 표시했다. 기존 정적 검사 9개가 통과해도 실제 filter/review
  화면은 작동하지 않았다. 원본 production Chromium의 filter assertion은 exit 1이었다.
  초기 seed identity와 수정 view를 별도로 보관하고 prop 교체에서는 새 seed로 초기화한다.
- **C04 추가 필드 복사:** spread로 item을 복사해 declared DTO 밖의 raw 필드가 결과에 남았다.
  새 합성 회귀의 수정 전 결과는 6 PASS / 1 FAIL / exit 1. 필요한 표시 필드만 명시 복사한다.
- **C06 만료 초점:** 5분 후 active review/confirm 버튼이 제거돼 초점이 사라졌다.
  수정 전 실제 앱 build의 browser assertion exit 1. 제거될 content 안에 초점이 있을 때만
  만료 안내로 옮기며, 남아 있는 버튼/링크 또는 만료 후 timer tick에서 초점을 뺏지 않는다.
  source의 session TTL·clock·consent·provider 한도는 바꾸지 않았다.
- **C03 CBOR 계약:** #27 원본의 header 길이 3과 실제 두 요소/두 필드 CDDL이 불일치한다.
  기존 consent 6개/login 8개 내부 unit는 통과했다. 상세 근거·최소 수정안·호환성 미결은
  별도 계약 검토 문서에 기록했으며 current core/wire에는 적용하지 않았다.

C06 policy/scanner·두 경계 test·fixture 5개는 원격 source와 byte-identical이다.
실제 Gmail/Graph는 계속 거부한다. C04/C06 결과를 verified analysis·계정 소유·현재 가입으로
승격하거나 공유 DB/금고에 저장하지 않았다. 한국시간은 display만이고 결과 UTC 날짜를 보존했다.

## 정확한 검사 명령과 exit

고정 install은 기존 README 절차대로 이전 배치에서 완료했고 이번에 재설치·dependency 변경을
하지 않았다. Node 24.19.0, Rust 1.95.0/bindgen 0.2.128, 기존 Vite/Vitest/React,
설치된 Python Playwright와 Chromium 151.0.7922.173을 사용했다.
evidence root: `/tmp/keyatlas-cloud-inbox-20261003`.

다음 명령은 `apps/web` 기준이다.

| 정확한 command | exit | 결과 |
| --- | ---: | --- |
| `npm test -- --run src/features/discovery-inbox/discoveryInboxModel.test.ts src/features/discovery-inbox/DiscoveryInboxPanel.test.tsx src/App.test.tsx src/features/local-vault/LocalVaultPanel.test.tsx` | 0 | 21 PASS |
| `npm test -- --run src/features/identity-map/IdentityMapPanel.test.tsx src/features/signup-mail-discovery/SyntheticSignupMailDiscoveryPanel.test.tsx src/features/signup-mail-discovery/signupMailAccessPolicy.test.ts src/features/signup-mail-discovery/signupMailDiscovery.test.ts` | 0 | 103 PASS, 기존 C06 99개 포함 |
| `npm test` | 0 | **57 files / 1,823 PASS**, 39.01초 |
| `npm run typecheck` | 0 | 현재 TS 소스 |
| `npm run build` | 0 | 현재 앱 production build |
| `node --input-type=module -e 'import { build } from "vite"; await build({ build: { outDir: "/tmp/keyatlas-cloud-inbox-20261003/c06-final-standalone-dist", rollupOptions: { input: "signup-mail-discovery.html" } } });'` | 0 | 기존 standalone entry, 기존 고정 Vite API 사용 |
| `python src/features/discovery-inbox/verifyDiscoveryInboxBrowser.py --dist dist --output /tmp/keyatlas-cloud-inbox-20261003/final-c04-browser` | 0 | 3 PASS / errors 0. production desktop/360·keyboard·filter·review·refresh 및 실제 React prop 교체 probe |
| `python src/features/signup-mail-discovery/verifySignupMailBrowser.py --dist dist --view integrated --timezone UTC --output /tmp/keyatlas-cloud-inbox-20261003/final-c06-integrated-browser` | 0 | 12 PASS / errors 0. 앱 메뉴 링크 진입·UTC 환경에서도 KST 표시 |
| `python src/features/signup-mail-discovery/verifySignupMailBrowser.py --dist /tmp/keyatlas-cloud-inbox-20261003/c06-final-standalone-dist --output /tmp/keyatlas-cloud-inbox-20261003/final-c06-standalone-browser` | 0 | 12 PASS / errors 0. 동일 source standalone |
| `python src/features/identity-map/verifyIdentityMapBrowser.py --dist dist --output /tmp/keyatlas-cloud-inbox-20261003/final-identity-browser` | 0 | 3 PASS / page/harness errors 0. 1440/360·단계 초점·Escape 범위·embedded 제목·잠금 제거/재열기·암호문 byte 보존 |

각 browser는 새 context, service worker/WebSocket·외부 origin/수정 request 차단, 실제 static
response bytes/hash 검증을 사용한다. C04/관계 화면은 immutable dist 사본을 만든다.
C06은 검사 동안 수정하지 않은 dist를 읽었다. 기존 C06 fixture를 결과처럼 주입하는 route는
없다. browser clock은 고정 5분 expiry 검사만 가속하며 source 한도를 바꾸지 않는다.

다음은 repository root, Rust는 fixed toolchain/CARGO_HOME/RUSTUP_HOME과 `--offline --locked`다.

| 정확한 command | exit | 결과/한계 |
| --- | ---: | --- |
| `cargo test --offline --locked -p vault-local-sqlite-vfs-windows --features feasibility-probe -- --test-threads=1` | 0 | Linux에서 실행되는 일반 검사 2 PASS. Windows handle 실환경 Phase0A 증거 아님 |
| `cargo test --offline --locked --workspace --doc` | 0 | 11 doctests PASS. 앞선 full verifier의 중단 이후 별도 실행 |
| `cargo test --offline --locked -p vault-local-store-sqlite --test secret_traits` | 0 | 1 harness / 6 compile-fail API 경계 PASS. filesystem runtime 성공 증거 아님 |
| `cargo test --offline --locked -p vault-local-core --lib consent_tests` | 0 | #27 변경 없는 임시 archive에서 6 PASS / 32 filtered. current core 통합 아님 |
| `cargo test --offline --locked -p vault-local-core --lib login_method_tests` | 0 | 같은 archive에서 8 PASS / 30 filtered. 외부 CBOR/실제 인증 검증 아님 |
| `pwsh -NoProfile -NonInteractive -File ./tests/verification/check-repository-secrets.Tests.ps1` | 1 | 100 PASS 뒤 Windows junction fixture의 `ComSpec/mklink` 준비 실패. 전체 regression PASS 아님, 뒤의 검사 미실행 |
| `pwsh -NoProfile -NonInteractive -File ./tests/verification/verify-security-workflow.Tests.ps1` | 0 | **NOT_ACCEPTED**. `Describe`를 찾지 못하는 non-terminating error; 검사 실행 없음 |
| `pwsh -NoProfile -NonInteractive -Command` 및 아래 단일 argument | 3 | Pester 미설치 확인. 실제 `Invoke-Pester` workflow 검사는 BLOCKED, 새 모듈 설치 안 함 |

availability 호출의 `-Command`에 전달한 단일 argument는 다음과 같다(Python subprocess argv로
전달하여 Bash의 `$` 확장을 거치지 않음).

```powershell
$ErrorActionPreference='Stop'; $mods=@(Get-Module -ListAvailable Pester); if ($mods.Count -eq 0) { Write-Output 'PESTER_NOT_INSTALLED'; exit 3 }; $mods | Select-Object Name,Version,Path | ConvertTo-Json -Compress
```

PowerShell binary는 `/tmp/keyatlas-powershell-tools/extracted/opt/microsoft/powershell/7/pwsh`,
XDG cache/config/data는 `/tmp/keyatlas-powershell-tools/xdg-{cache,config,data}`를 사용했다.
XDG 설정 없는 availability 호출은 readonly home/cache로 exit 134였고, 설정 후 위 exit 3으로
미설치를 확인했다. 이 실행 오류를 정책 검사 통과/실패 증거로 사용하지 않는다.
Pester의 실제 실행을 확인하기 전 exit 0만으로 PASS를 기록하지 않는다.

최종 source/doc integrity 검사는 다음과 같다.

| 정확한 command | exit | 결과 |
| --- | ---: | --- |
| `pwsh -NoProfile -NonInteractive -File ./scripts/check-repository-secrets.ps1 -Root /workspace/secure-vault` | 0 | SECRET_SCAN_PASSED, 기존 baseline 허용 4개. 새 실제 Secret 없음 |
| `git diff --check` | 0 | tracked 변경 whitespace PASS |
| `python /tmp/keyatlas-cloud-inbox-20261003/verify-owned-integrity.py` | 0 | 55개 소유 파일(4 tracked/51 untracked), source hash 39개 일치, local links·untracked whitespace·예상 밖 변경·삭제·staging 없음 |
| `git ls-remote origin refs/heads/main refs/heads/codex/firstvibe-cloud-catalog-client-fix-20261003 refs/heads/codex/firstvibe-ka-c06-signup-mail-discovery-20260930 refs/pull/26/head refs/pull/27/head` | 0 | 위 main/C06/#26/#27 tip 재확인. 작업 branch 원격 ref 없음 |

시작 때의 기존 27개 파일 중 18개는 byte-identical, 9개는 이 기록에 적은 셸/관계 제목/설계
후속 변경이다. 기존 인계/배정/9월 검토 기록 3개와 앞선 client/HTTP helper는 보존했다.
package/lockfile/CI 정책 변경은 없고 staged 파일도 없다.
최종 integrity의 docs hash는 해당 기록 저장 시점이며 source hash 묶음은 위 검사 source를
계속 식별한다. 생성물·screenshots/profile/합성 backup·원본 로그는 Git에 넣지 않았다.

untracked 검사 collector는 처음에 `git diff --no-index --check`의 정상 차이 exit 1을
whitespace 오류로 오인했다. clean control은 exit 1/진단 없음, trailing-space control은
exit 3/진단 있음으로 확인한 뒤 실제 진단/오류를 판별하도록 보완했다. 검사 대상 source나
Git/Secret 정책을 약화하지 않았으며, 이전 collector 기록도 evidence에 보존했다.

앞선 benefits 1,354/1,354, client 30개×5회·Chromium 8개·HTTP 연결 16개×3회,
bounded-json 25/25 및 benefits typecheck/build/boundaries/smoke exit 0은 당시 source/hash의
근거를 [이전 검증](2026-10-03-cloud-continuation.md)에 보존했다. 해당 source는 이번에
변경하지 않았다. 검사를 이번 배치에서 다시 실행한 것처럼 적지 않는다.

## 실패·미검증·다음 일

- 전체 workspace verifier는 **FAIL / exit 101**: SQLite lib 30 PASS / 19 FAIL / 기존 1 ignored.
  정확한 시작 SHA의 동일 19개 실패 비교는 이전 evidence에 있다. Linux platform 경계를
  우회/skip하지 않았다. 이번 별도 probe/doctest 통과가 전체 PASS로 바꾸지는 않는다.
- native Windows·Phase0A handle 보안 결과, Windows junction regression, verifier 정책 runner,
  Pester security workflow, Firefox/WebKit·실제 모바일/screen reader·OS file dialog는 미검증.
  기존 Phase0A security inconclusive exit 4551도 그대로다.
- Google 공식 문서 3개 GET는 URLError로 **BLOCKED**. 최신 scope/심사/정책을 추측하지 않는다.
  실제 Gmail/DB/auth/AI/E2E·지원·배포·법률/독립 보안 검토는 NOT_RUN.
- 로컬 readiness의 9개 파일은 NOT_RECEIVED. client/loopback과의 중복/통합 판정은 못 한다.
- GitHub live Issue/PR merge/CI는 미확인. 원격 main의 AGPLv3 LICENSE와 현재 HEAD의 LICENSE
  부재도 게시 기준에서 대조해야 한다. 임의 license 선택/저장소 공개 전환은 하지 않았다.
- C03 core/wire 보완은 별도 승인·호환성 결정 후 진행할 최소안을 기록했다.

M02/M05A/M06/M04A의 후속 범위·프롬프트는
[배정 초안](../../handoff/mvp-20260927/NEXT_ASSIGNMENTS_2026-10-03.md)에 있다.
사용자 결정은 게시 권한, 누락 9개 전달, T2 metadata/FULL 목적·R3A/R5A manifest 승인,
운영 주체·지역/비용/환경·배포 재개다. 현재 로컬 합성 검사와 설계 범위를 확대하는 승인이 아니다.
