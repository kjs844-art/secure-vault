# 보조 Windows CI — 비활성 초안

작성: 2026-08-31 01:27 KST  
상태: **문서 안의 예시일 뿐이며 GitHub Actions에 설치·활성화하지 않음**

## 목적

현재 물리 PC의 Smart App Control을 끄지 않고, 별도 GitHub hosted Windows
환경에서 ordinary suite가 실행되는지 확인하는 보조 증거용 초안이다.

이 결과가 성공해도 현재 Windows `10.0.26200.0` pinned-host Phase 0A를
Pass로 바꾸지 않는다.

현재 Phase 0A의 독립 검토 코드 후보는
`e8b29cb6a014aed24725b0f658182b9d2cfc487d`이고, 문서 후속 커밋을 포함한 Draft
PR HEAD는 `f85e547b270b3400c924ea8afe9e1f36d846b661`이다. 실행 승인을 받을 때 어느
SHA를 테스트하는지 명시해야 하며, 기존 Phase 0A 증거와 결속하려면 검토 코드
후보 SHA를 임의로 바꾸지 않는다.

## 안전 조건

- 수동 `workflow_dispatch`만 사용한다.
- `pull_request`, `push`, cron 자동 실행을 넣지 않는다.
- repository permission은 `contents: read`만 사용한다.
- 실제 Secret, API key, signing key를 넣지 않는다.
- `--ignored`, `--include-ignored`, explicit hard-gate 테스트명을 넣지 않는다.
- one-time hard gate를 재실행하지 않는다.
- third-party action은 immutable commit SHA로 고정한다.

## GitHub 수동 실행의 부트스트랩 제약

GitHub의 `workflow_dispatch`는 workflow 파일이 기본 브랜치에 존재해야 사용할
수 있다. 현재 `main`에는 workflow가 없으므로, 이 초안을 기능 PR `#1`에 넣는
것만으로는 Run workflow 버튼이 생기지 않는다.

나중에 활성화한다면 기능 코드와 분리된 **workflow-only 브랜치/PR**을 독립
검토하고, 사용자가 `main` 반영을 명시적으로 승인해야 한다. 기능 PR `#1`을
테스트하려고 그 기능 코드를 먼저 병합해서는 안 된다.

## YAML 초안

아래 코드는 아직 `.github/workflows`에 만들지 않았다.

```yaml
name: Supplemental Windows ordinary suite

on:
  workflow_dispatch:
    inputs:
      candidate_sha:
        description: Exact 40-hex commit SHA to test
        required: true
        type: string

permissions:
  contents: read

concurrency:
  group: supplemental-windows-ordinary-${{ github.ref }}
  cancel-in-progress: false

jobs:
  ordinary-suite:
    runs-on: windows-latest
    timeout-minutes: 20

    steps:
      - name: Checkout exact requested revision
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ inputs.candidate_sha }}
          fetch-depth: 1
          persist-credentials: false

      - name: Install pinned Rust toolchain
        shell: pwsh
        run: |
          rustup toolchain install 1.95.0-x86_64-pc-windows-msvc `
            --profile minimal `
            --component rustfmt `
            --component clippy
          if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

      - name: Record non-sensitive environment
        shell: pwsh
        env:
          EXPECTED_CANDIDATE_SHA: ${{ inputs.candidate_sha }}
        run: |
          Set-StrictMode -Version Latest
          $ErrorActionPreference = 'Stop'
          $PSNativeCommandUseErrorActionPreference = $true

          if ($env:EXPECTED_CANDIDATE_SHA -notmatch '^[0-9a-fA-F]{40}$') {
            throw 'candidate_sha must be an exact 40-hex commit SHA'
          }

          rustc +1.95.0-x86_64-pc-windows-msvc --version --verbose
          cargo +1.95.0-x86_64-pc-windows-msvc --version
          "RUNNER_OS_VERSION=$([System.Environment]::OSVersion.Version)"
          $actualHead = (git rev-parse HEAD).Trim().ToLowerInvariant()
          $expectedHead = $env:EXPECTED_CANDIDATE_SHA.ToLowerInvariant()
          if ($actualHead -ne $expectedHead) {
            throw "checked out HEAD does not match candidate_sha"
          }
          "CANDIDATE_HEAD=$actualHead"

      - name: Run ordinary suite only
        shell: pwsh
        run: |
          cargo +1.95.0-x86_64-pc-windows-msvc test --locked `
            -p vault-local-sqlite-vfs-windows `
            --features feasibility-probe `
            -- `
            --test-threads=1
          $ordinaryExit = $LASTEXITCODE
          "ORDINARY_TEST_EXIT=$ordinaryExit"
          exit $ordinaryExit
```

## action SHA 확인 근거

- 조회일: 2026-08-31
- 공식 저장소: `actions/checkout`
- 공식 최신 릴리스: `v7.0.1`
- tag commit SHA: `3d3c42e5aac5ba805825da76410c181273ba90b1`
- 릴리스: `https://github.com/actions/checkout/releases/tag/v7.0.1`

실제 활성화 시점에는 SHA와 upstream 보안 공지를 다시 확인한다.

## 이 CI가 증명할 수 있는 것

- 별도 hosted Windows runner에서 locked dependency로 build 가능한지
- ordinary non-ignored tests가 실행되는지
- Cargo가 반환한 exact integer exit code
- explicit hard gate를 호출하지 않았다는 workflow command 사실

## 이 CI가 증명할 수 없는 것

- 현재 물리 PC에서 Smart App Control을 통과한다는 것
- approved pinned Windows build에서 실행됐다는 것
- actual SQLite main/WAL/SHM 안전성
- full Phase 0/VFS/store/production readiness
- 실제 Secret 입력 허용

성공하더라도 authoritative Phase 0A는 계속 `Inconclusive`이고 integration은
중단 상태다. 판정을 바꾸려면 별도 승인된 권위 환경 계약과 그 계약의 모든
gate가 필요하다.

## 활성화 전 사용자 승인 항목

1. 별도 workflow-only 브랜치/PR을 만들지
2. 독립 검토 뒤 그 workflow만 `main`에 반영할지
3. GitHub Actions가 외부 hosted runner에서 소스를 build하도록 허용할지
4. 테스트할 exact 40-hex candidate SHA
5. 수동 실행 한 번을 허용할지
6. 결과를 보조 증거로만 기록하는 데 동의하는지

승인 전에는 workflow 생성, push, Actions 실행을 하지 않는다.
