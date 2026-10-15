# M01A-2A — CI PSGallery 준비 단계 수리

2026-09-29. 사용자 승인 범위: 이 준비 단계의 수정·로컬 검증·2A 브랜치 push 및 새 CI 확인.
일반 개발 중지, DB/domain/deployment 보류, 원본 동결, REAL_SECRET_GATE=CLOSED는 유지한다.

- PR: [#23](https://github.com/kjs844-art/secure-vault/pull/23), OPEN / M01A 통합 브랜치 대상.
- branch: `codex/firstvibe-mvp-01a-2a-http-qa-20260928`.
- 시작 local/origin/PR head: `fdccf6a2c706c50ccefb8e5065ee49c840a8868f`, clean 확인.
- 주 담당의 깨끗한 M01A checkout을 이 브랜치로 전환하고 fast-forward만 적용했다.
  원격 제출자의 HTTP 코드 4개 파일을 수정하거나 다른 변경을 reset/stash하지 않았다.
- 이 기록을 포함하는 새 commit이 수리 체크포인트이며, main 병합은 수행하지 않는다.

## 확인한 원인

[원 실행 36392216088, attempt 2](https://github.com/kjs844-art/secure-vault/actions/runs/36392216088)
job `109330509980`는 Pester 5.7.1 설치 단계에서 exit 1이었다.
로그는 `Unable to find repository 'PSGallery'.`를 보고했다.
이는 이번 시도의 결제 차단이나 HTTP 기능 assertion 실패가 아니다. Pester 이후 검사는 실행되지 않았다.
PSGallery 등록이 왜 없었는지까지 runner 내부에서 재현·증명한 것은 아니다.

## 좁은 변경과 보존 조건

- [준비 helper](../../../scripts/ensure-ci-psgallery.ps1): GitHub Actions process marker를 확인한다.
  정상 조회에서만 PSGallery 부재를 판단하고 `Register-PSRepository -Default`를 한 번 수행한다.
  등록 후 다시 조회하며 정확히 한 개의 공식 HTTPS v2 source와 NuGet provider만 허용한다.
- 조회 장애·잘못된 기존 등록은 덮어쓰기/해제/자동 재설정하지 않고 고정 오류로 중단한다.
  별도 provider 설치, 설치 신뢰 정책 변경, 원문 URL/예외 출력은 추가하지 않았다.
- [workflow](../../../.github/workflows/security-gates.yml): 초기 Secret 검사 뒤,
  Pester 설치 바로 앞에 준비 단계를 추가한다. 기존 Pester 5.7.1 install/import는 그대로다.
- [정책 회귀](../../../tests/verification/verify-security-workflow.Tests.ps1): 새 단계의 정확한 명령,
  순서·누락·중복·조건부 skip·실패 무시 및 테스트 0개를 성공 처리하는 변형을 거부한다.
- [동작 회귀](../../../tests/verification/ensure-ci-psgallery.Tests.ps1): 실제 명령을 throw-only 함수로
  가린 뒤 Pester mock으로만 실행한다. 실제 repository 조회·등록·모듈 설치·네트워크 요청은 없다.
- 두 Pester container 각각 nonzero/Passed, 전체 Passed/skip 0을 요구한다.
  암호화/금고/HTTP 앱 코드, lockfile, 결제/IAM, 브랜치 보호나 다른 CI 검사는 변경하지 않는다.

## 로컬 검사와 독립 검토

새 모듈 설치 없이 기존 Pester 5.7.1을 다음 경로에서 import했다:
`C:/Users/USER/Documents/ChatGPT/KeyAtlas/secure-vault-session-hardening/target/verification-modules/Pester/5.7.1/Pester.psd1`.

두 엔진 모두 `-NoProfile -NonInteractive -Command`에서 위 모듈을 import하고 다음을 실행했다:

```powershell
$ciResult = Invoke-Pester -Path ./tests/verification/verify-security-workflow.Tests.ps1, ./tests/verification/ensure-ci-psgallery.Tests.ps1 -Output None -PassThru
```

wrapper는 전체 Result=Passed와 실패 없음 및 process `GITHUB_ACTIONS` 원값의 `-cne` 비교를
확인한 뒤 exit 0을 반환했다. 정책 19개 + mock 동작 46개 = 65개다.

| 환경 | 실제 결과 |
|---|---|
| PowerShell 7.6.5 / Pester 5.7.1 | 미존재·빈 문자열·합성 문자열 시작 조건 각각 65/65, 환경 복구 true, exit 0 |
| Windows PowerShell 5.1.26100.9444 / Pester 5.7.1 | 65/65, 환경 복구 true, exit 0 |
| PowerShell AST parser, helper/정책/동작 회귀 3개 | 오류 0, exit 0 |
| Secret scanner | SECRET_SCAN_PASSED, baseline 4, REAL_SECRET_GATE=CLOSED, exit 0 |
| 변경 문서 2개 상대 링크 검사 / `git diff --check` | 각각 exit 0 |

초기 회귀 작성 중 Pester mock의 script-scope 접근을 closure로 보정했다.
추가 검사에서 PS7의 null→빈 문자열 변환 때문에 환경 복구 검증이 실패했고,
null이면 현재 process Env 항목만 제거하고 다른 문자열은 그대로 복구하도록 수정했다.
문자열 변환으로 차이를 숨기지 않고 매 테스트 후 `-cne`로 검증한다.
사용자/시스템의 persistent 환경 설정은 변경하지 않았다.

최종 fixture 보정 후 주 담당이 PS7에서 실제 workflow와 동일한 종료 조건으로 다시 실행했다.
구조화 출력은 Total/Passed=65, Failed/Skipped=0, Result=Passed,
Containers=[19/19 Passed, 46/46 Passed], EnvRestored=true였고 exit 0이었다.
각 container nonzero/Passed와 전체 성공/skip 0 조건을 실제 적용해 확인했다.
CI의 종료 조건은 workflow에 명시했고 정책 변형 회귀가 그 내용을 보호한다.

독립 읽기 검토에서 두 파일 중 하나가 0 tests여도 합산 성공이 될 수 있는 점을 지적받아,
각 container 검사와 전체 성공/skip 조건을 추가했다. 최종 정적 리뷰의 추가 확정 중요 이슈는 없었다.
이 정적 검토는 실제 runner의 모듈 다운로드 성공이나 보안 감사 완료를 뜻하지 않는다.

## 원격 결과와 미검증

이 기록 작성 시 새 수정의 CI는 아직 실행 전이다. Push가 만든 새 SHA의 실행을 별도로 확인한다.
옛 attempt 재실행은 수정 코드를 반영하지 않으므로, 고친 branch의 새 실행을 사용한다.
로컬에서는 실제 PSGallery 등록·Pester 다운로드를 실행하지 않았다. 변경이 CI 준비/검사에
한정되어 앱/Rust/WASM 전체 로컬 빌드도 반복하지 않았다. 원격 준비 단계 통과와 전체 CI 통과는 별개다.

기존 M01A PR #19 / M01A-1A PR #22의 attempt 2는 이번 수리 중 completed/success를 확인했다.
그 성공이 PR #23이나 이 새 수리 commit의 성공을 의미하지는 않는다.
