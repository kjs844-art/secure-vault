# 2026-09-30 클라우드 bounded JSON fixture 검증

## 결론과 범위

listener 정리 테스트가 성공·invalid·abort·timeout 모두에 20ms를 부여해,
정상 입력도 실행 지연이 끼면 `BODY_TIMEOUT`으로 거부될 수 있음을 확인했다.
timeout 경로는 20ms를 유지하고 나머지 세 경로의 테스트 예산만 1,000ms로
분리했다. reader의 시간·크기 제한과 운영 코드는 변경하지 않았다.

평상시 시작점 집중 10회와 전체 1회에서는 원래 실패가 자연 재현되지 않았다.
50ms의 통제된 실행 지연으로 같은 테스트의 성공 경로에서 같은 오류를
재현했다. 이는 fixture의 지연 민감성을 입증하지만, 사용자가 관찰한 로컬
전체 실행의 실제 부하·스케줄링 원인까지 확정하는 증거는 아니다.

`REAL_SECRET_GATE=CLOSED`. 실제 비밀번호, API 키, 메일, DB, 외부 분석,
유료 호출, 공개 배포 또는 CI 정책 변경을 사용한 검증이 아니다.

## 시작점과 소유권

- 저장소: `kjs844-art/secure-vault`, 클라우드 `/workspace/secure-vault`.
- 작업 전 실제 HEAD: `117a8f151615c181549432de8800a65e902baf8d`,
  기존 KA-C06 브랜치; tracked/untracked Git 상태 clean.
- 시작 브랜치 `codex/firstvibe-benefit-history-20260929`의 원격 tip과 fetch
  결과가 지정 SHA `ee557c8e81807f1af88fff0e40ed949089b9337f`와 일치했다.
- 그 SHA에서 `codex/firstvibe-cloud-bounded-json-20260930`을 새로 만들었다.
  기존 브랜치를 reset하거나 다른 작업의 변경을 덮어쓰지 않았다.
- 먼저 `AGENTS.md`, `START_HERE.md`, `SESSION_HANDOFF.md`, benefits-web
  `README.md`, `HTTP_CONTRACT.md`를 읽었다.
- 변경 파일은 `apps/benefits-web/tests/bounded-json.test.ts`와 이 문서뿐이다.
- 로컬 `codex/firstvibe-mvp-readiness-20260930`의 미푸시 9개 파일은
  전달받지 않았다. catalog-client·HTTP loopback QA의 중복 구현, 통합 또는
  검증 완료를 주장하지 않는다.

## 분석과 최소 변경

reader는 `performance.now() + timeoutMs`로 deadline을 정하고, timer뿐 아니라
각 checkpoint에서도 경과 시간을 검사한다. 실행이 지연돼 deadline을 넘으면
짧은 정상 body라도 `BODY_TIMEOUT`을 반환하는 것은 현재 계약에 맞다.
`finally`에서 등록 listener 제거와 reader lock 해제가 이루어진다.

임시 Node import 훅으로 `readBoundedJson`이 호출하는 `getReader()`를 각 50ms
지연했다. 원본 테스트는 첫 success 경로에서 exit 1 / `BODY_TIMEOUT`이었다.
수정 뒤 같은 명령은 네 경로를 모두 실행하고 exit 0이었다. 훅은 `/tmp`에만
존재하며 테스트, 운영 코드 또는 빌드 산출물에 포함되지 않는다.

변경은 다음 예산 분리와 그 목적을 설명하는 주석뿐이다.

```ts
const timeoutMs = outcome === "timeout" ? 20 : 1000;
const task = readBoundedJson(input, { signal, timeoutMs });
```

네 경로의 실제 결과와 `BODY_INVALID` / `BODY_ABORTED` / `BODY_TIMEOUT` 구분,
고정 오류 속성·비공개 값 미노출, listener 등록/제거 각각 1회, unlocked body
assertion을 모두 유지했다. 외부 testcase 제한 2,000ms와 별도의 실제 timeout,
cancel-once, reject/never-settling cancel, abort 회귀도 그대로다.
skip, assertion 삭제, 성공할 때까지 재시도 또는 생산 코드 수정은 없다.
운영 코드 결함은 이 범위에서 확인되지 않아 별도 수정안을 제안하지 않는다.

## 환경과 검사

Debian 13, Node `v24.19.0`, npm `11.9.0`을 사용했다. README의 고정 설치 명령
`npm ci --ignore-scripts --no-audit --no-fund`에 캐시 위치
`--cache /tmp/keyatlas-bounded-json-npm-cache`만 추가했으며 exit 0이었다.
의존성 선언, 버전 또는 lockfile은 바꾸지 않았다. README에 따라 build로
ignored route tree를 생성한 후 standalone typecheck를 실행했다.

추가 설치 단계도 재실행해 고정 npm 설치와 PowerShell 버전 확인 exit 0을
확인했다. 재사용할 `install_script`와 `start_skill`은 기존 내용을 보존해
클라우드 환경 draft에 저장했다(`status=saved`). 환경 공개나 새 머신 검증은 아니다.

반복 횟수는 실행 전에 고정했다. 각 실행의 실제 exit code와 전체 출력은
`/tmp/keyatlas-bounded-json-evidence/`에 별도로 수집했으며 실패를 재시도로
덮어쓰지 않았다. 이 로컬 출력 파일은 커밋하지 않는다.

다음 명령의 작업 디렉터리는 `apps/benefits-web`이다.

| 명령 / 조건 | 실제 exit code | 결과 |
|---|---|---|
| `node --import tsx --test tests/bounded-json.test.ts`, 시작점 10회 | 매회 0 | 매회 25/25; skip 0 |
| `npm test`, 시작점 1회 | 0 | 1,308/1,308; skip 0 |
| 아래 지연 진단 명령, 원본 | 1 | 선택된 테스트 0/1; success 경로 `BODY_TIMEOUT` |
| 같은 지연 진단 명령, 수정본 | 0 | 선택된 테스트 1/1; 네 경로 모두 검증 |
| `node --import tsx --test tests/bounded-json.test.ts`, 수정본 10회 | 매회 0 | 매회 25/25; skip 0 |
| `npm test`, 수정본 3회 | 매회 0 | 매회 1,308/1,308; skip 0 |
| `npm run typecheck` | 0 | TypeScript 검사 완료 |
| `npm run build` | 0 | Vite production build + TypeScript 검사 완료 |
| `npm run check:boundaries` | 0 | source 40개 / client 8개; 정적 경계 검사 |
| `npm run test:smoke` | 0 | assets 7개; 자체 loopback 서버 시작·검사·종료 |

지연 진단의 재현 명령은 다음과 같다. 선택 실행은 진단용이며 전체 검사를
대체하지 않는다. 훅 없이 집중 파일과 전체 앱을 별도로 실행했다.

```sh
node --import tsx --import /tmp/keyatlas-bounded-json-delay.mjs --test \
  --test-name-pattern 'listeners are removed after success, invalid input, abort and timeout' \
  tests/bounded-json.test.ts
```

해당 임시 훅의 전체 내용:

```js
const original = ReadableStream.prototype.getReader;
ReadableStream.prototype.getReader = function (...args) {
  if (new Error().stack?.includes("readBoundedJson")) {
    const start = performance.now();
    while (performance.now() - start < 50) { /* Bounded diagnostic event-loop delay. */ }
    process.stderr.write("DIAGNOSTIC_READER_DELAY_50MS\n");
  }
  return Reflect.apply(original, this, args);
};
```

## Secret 검사와 검증 파일 식별

PowerShell이 기본 설치되어 있지 않아 공식 Microsoft Debian 저장소의
`7.6.6-1.deb`를 `/tmp/keyatlas-powershell-tools/`에 준비했다. Microsoft 공개키
fingerprint `BC528686B50D79E339D3721CEB3E94ADBE1229CF`, InRelease 서명,
서명된 Packages.gz의 SHA-256 및 실제 패키지 SHA-256을 모두 검증했다.
TLS나 패키지 검증을 끄지 않았다. 기본 캐시가 read-only라 첫 CLI 시작은
실패했으며, 지원되는 XDG 경로를 `/tmp`로 지정한 뒤 PowerShell 7.6.6과
저장소 scanner를 실제 실행했다. 최초 시작 실패는 scanner 통과로 집계하지 않는다.

저장소 루트에서 실제 실행한 환경과 명령:

```sh
export XDG_CACHE_HOME=/tmp/keyatlas-powershell-tools/xdg-cache
export XDG_CONFIG_HOME=/tmp/keyatlas-powershell-tools/xdg-config
export XDG_DATA_HOME=/tmp/keyatlas-powershell-tools/xdg-data
/tmp/keyatlas-powershell-tools/extracted/opt/microsoft/powershell/7/pwsh \
  -NoProfile -NonInteractive -File ./scripts/check-repository-secrets.ps1 \
  -Root /workspace/secure-vault
git diff --check
git diff --cached --check
```

저장소 Secret 검사는 exit 0, `SECRET_SCAN_BASELINE_ALLOWED=4`,
`SECRET_SCAN_PASSED`, `REAL_SECRET_GATE=CLOSED`였다. 문서를 포함한 staged
변경에도 Secret 검사와 두 diff 검사 exit 0을 확인했다.
gitleaks는 설치되어 있지 않아 별도 gitleaks 검사는 `NOT_RUN`이다.

검증한 변경 테스트의 SHA-256은
`e69d4e080c57c701b05e9e70e5c43f7be4079b822efdfa63cbe69329f1203fa6`이다.
reader는 시작점과 byte-for-byte 일치하며 SHA-256은
`47b6ccf119a532c835d8a5bd215b4e961b1e52990a597668ec06aa4bfbaea9cf`이다.
package.json / package-lock.json도 시작점과 byte-for-byte 일치했다.
이 문서를 포함하는 제출 commit의 정확한 SHA는 최종 보고와 원격 Git ref로 식별한다.

## 제출과 미검증

전용 브랜치로 비강제 push하고, PR의 base는
`codex/firstvibe-benefit-history-20260929`로 지정한다. Git 읽기는 가능하지만,
GitHub API PR 조회는 `gh api --method GET repos/kjs844-art/secure-vault/pulls`
(`state=open`, 이번 head/base 지정)에서 exit 1 / `Forbidden`이었다.
Draft PR 생성도 같은 API 권한에 의존한다. 생성 여부와 URL, push 후 확인한
정확한 SHA는 세션 최종 보고에 남기며 main이나 시작 브랜치에 merge하지 않는다.

GitHub Actions 실행·성공, Windows PowerShell 5.1, Rust workspace verifier,
apps/web 전체 검사와 실제 브라우저 hydration은 이번 좁은 범위에서 `NOT_RUN`이다.
Actions 수동 재실행·한도·결제·CI 정책 변경은 하지 않았다.
loopback smoke와 경계 검사는 실제 로그인·메일·DB·네트워크 sandbox의 증거가 아니다.
미전달 readiness 9개 파일과의 통합 및 실제 Secret 금고 출시도 미검증이다.
