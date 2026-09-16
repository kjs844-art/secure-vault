#requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$runner = Join-Path $repositoryRoot 'scripts\verify-local.ps1'
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) {
    Write-Output 'FAIL: the local verification entry point has not been implemented.'
    exit 1
}
$engine = (Get-Process -Id $PID).Path
$originalPath = $env:PATH
$originalFailure = $env:KEYATLAS_TEST_FAIL_STAGE
$fixtureDirectory = Join-Path $PSScriptRoot 'fixtures'
$fixtureCargo = Join-Path $fixtureDirectory 'cargo.cmd'
$fixtureRg = Join-Path $fixtureDirectory 'rg.cmd'
$temporaryToolDirectory = Join-Path ([IO.Path]::GetTempPath()) ("keyatlas-verifier-tools-$([Guid]::NewGuid().ToString('N'))")
$temporaryRg = Join-Path $temporaryToolDirectory 'rg.cmd'
$passed = 0

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-SecurityBoundary {
    param([string]$Text)
    $lines = $Text -split '\r?\n'
    foreach ($expected in @('PHASE_0A_VERDICT=UNCHANGED', 'REAL_SECRET_GATE=CLOSED')) {
        $prefix = ($expected -split '=', 2)[0] + '='
        $markers = @($lines | Where-Object { $_.StartsWith($prefix) })
        Assert-Condition (($markers.Count -eq 1) -and ($markers[0] -eq $expected)) "Exactly one unchanged security boundary marker is required: $expected"
    }
}

function Assert-SecretScanSuccess {
    param([string]$Text)
    $lines = $Text -split '\r?\n'
    $passMarkers = @($lines | Where-Object { $_ -eq 'SECRET_SCAN_PASSED' })
    Assert-Condition ($passMarkers.Count -eq 1) 'Exactly one Secret scan success marker is required.'
    $secretIndex = $Text.IndexOf('SECRET_SCAN_PASSED', [StringComparison]::Ordinal)
    $cargoIndex = $Text.IndexOf('VERIFY_TEST_CARGO:', [StringComparison]::Ordinal)
    Assert-Condition (($secretIndex -ge 0) -and ($cargoIndex -gt $secretIndex)) 'The Secret scan must pass before Cargo starts.'
}

function Invoke-Runner {
    param([string]$Scope, [string]$FailStage = '', [string[]]$ExtraArguments = @())
    $env:KEYATLAS_TEST_FAIL_STAGE = $FailStage
    # Exercise the real process boundary without breaking the Rust workspace.
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& $engine -NoProfile -NonInteractive -File $runner -Scope $Scope @ExtraArguments 2>&1)
        $code = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $savedPreference }
    [pscustomobject]@{ Code = $code; Text = ($lines -join "`n") }
}

try {
    if (-not (Test-Path -LiteralPath $fixtureCargo -PathType Leaf)) {
        throw 'The synthetic Cargo fixture is missing; no Cargo command was started.'
    }
    if (-not (Test-Path -LiteralPath $fixtureRg -PathType Leaf)) {
        throw 'The synthetic rg fixture is missing; no verification command was started.'
    }
    # Do not fall back to a developer's real Cargo or rg if a fixture cannot resolve.
    $env:PATH = $fixtureDirectory
    $resolvedCargo = Get-Command cargo -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $resolvedRg = Get-Command rg -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (($null -eq $resolvedCargo) -or
        (-not [string]::Equals($resolvedCargo.Source, $fixtureCargo, [StringComparison]::OrdinalIgnoreCase))) {
        throw 'The synthetic Cargo fixture must be the only resolved Cargo command.'
    }
    if (($null -eq $resolvedRg) -or
        (-not [string]::Equals($resolvedRg.Source, $fixtureRg, [StringComparison]::OrdinalIgnoreCase))) {
        throw 'The synthetic rg fixture must be the only resolved rg command.'
    }
    Push-Location -LiteralPath ([IO.Path]::GetTempPath())
    try {
        $result = Invoke-Runner -Scope 'Focused'
        Assert-Condition ($result.Code -eq 0) 'Focused checks should succeed.'
        Assert-SecurityBoundary -Text $result.Text
        Assert-SecretScanSuccess -Text $result.Text
        Assert-Condition ($result.Text.Contains("VERIFY_TEST_CWD:$repositoryRoot")) 'Cargo must run at the root derived from the script location.'
        Assert-Condition ($result.Text.Contains('VERIFY_TEST_CARGO:test --offline --locked -p vault-local-sqlite-vfs-windows --tests -- --test-threads=1')) 'Default-feature tests must run.'
        Assert-Condition ($result.Text.Contains('VERIFY_TEST_CARGO:test --offline --locked -p vault-local-sqlite-vfs-windows --features feasibility-probe -- --test-threads=1')) 'Ordinary feature-enabled tests must run.'
        Assert-Condition (-not ($result.Text -match '--(?:include-)?ignored')) 'The explicit feasibility gate must stay excluded.'
        Assert-Condition ($result.Text.Contains('LOCAL_CHECKS_PASSED')) 'Success requires an explicit summary.'
        $passed++
        Write-Output 'PASS: focused matrix, relocated root, and result boundary'

        $result = Invoke-Runner -Scope 'Workspace'
        Assert-Condition ($result.Code -eq 0) 'Workspace checks should succeed.'
        Assert-SecurityBoundary -Text $result.Text
        Assert-SecretScanSuccess -Text $result.Text
        Assert-Condition ($result.Text.Contains('VERIFY_TEST_CARGO:test --offline --locked --workspace --tests -- --test-threads=1')) 'Workspace default tests must run.'
        Assert-Condition ($result.Text.Contains('VERIFY_TEST_CARGO:clippy --offline --locked --workspace --all-targets --all-features -- -D warnings')) 'Workspace lint coverage must include all targets and features.'
        Assert-Condition ($result.Text.Contains('VERIFY_TEST_CARGO:test --offline --locked --workspace --doc')) 'Workspace doctests must run.'
        Assert-Condition ($result.Text.Contains('VERIFY_TEST_CARGO:test --offline --locked -p vault-local-sqlite-vfs-windows --features feasibility-probe')) 'Workspace checks must retain feature-enabled tests.'
        $passed++
        Write-Output 'PASS: workspace coverage'

        $result = Invoke-Runner -Scope 'Focused' -FailStage 'secret-scan'
        Assert-Condition ($result.Code -eq 1) 'A Secret finding must fail the verifier.'
        Assert-SecurityBoundary -Text $result.Text
        Assert-Condition ($result.Text.Contains('SECRET_SCAN_FINDINGS=1')) 'A Secret finding count must reach the caller.'
        Assert-Condition ($result.Text.Contains('SECRET_SCAN_FILE=synthetic-secret-candidate.txt')) 'Only the synthetic relative file must be reported.'
        Assert-Condition ($result.Text.Contains('LOCAL_CHECKS_FAILED stage=repository-secret-scan exit=1')) 'Secret scan failure must identify its stage.'
        Assert-Condition (-not $result.Text.Contains('VERIFY_TEST_CARGO:')) 'Cargo must not start after a Secret scan failure.'
        Assert-Condition (-not $result.Text.Contains('LOCAL_CHECKS_PASSED')) 'A Secret scan failure must never print success.'
        $passed++
        Write-Output 'PASS: Secret scan failure stops Cargo'

        foreach ($stage in @('fmt', 'clippy', 'test')) {
            $result = Invoke-Runner -Scope 'Focused' -FailStage $stage
            Assert-Condition ($result.Code -eq 23) "The $stage exit code must reach the caller unchanged."
            Assert-SecurityBoundary -Text $result.Text
            Assert-Condition (-not $result.Text.Contains('LOCAL_CHECKS_PASSED')) 'Failure must never produce a success summary.'
            Assert-Condition ($result.Text.Contains('LOCAL_CHECKS_FAILED')) 'Failure requires an explicit summary.'
            if ($stage -eq 'fmt') {
                Assert-Condition (-not $result.Text.Contains('VERIFY_TEST_CARGO:clippy')) 'Formatter failure must stop subsequent checks.'
            }
            if ($stage -eq 'clippy') {
                Assert-Condition (-not $result.Text.Contains('VERIFY_TEST_CARGO:test')) 'Clippy failure must stop subsequent tests.'
            }
            if ($stage -eq 'test') {
                Assert-Condition (-not $result.Text.Contains('VERIFY_TEST_CARGO:test --offline --locked -p vault-local-sqlite-vfs-windows --features')) 'Default-test failure must stop the feature-enabled tests.'
            }
            $passed++
            Write-Output "PASS: $stage failure is preserved"
        }

        $result = Invoke-Runner -Scope 'Focused' -FailStage 'feature-test'
        Assert-Condition ($result.Code -eq 23) 'A last-stage-only failure must reach the caller unchanged.'
        Assert-SecurityBoundary -Text $result.Text
        Assert-Condition ($result.Text.Contains('LOCAL_CHECKS_FAILED stage=probe-ordinary-tests exit=23')) 'The failed last stage must be identified.'
        Assert-Condition (-not $result.Text.Contains('LOCAL_CHECKS_PASSED')) 'The last-stage failure must not print success.'
        $passed++
        Write-Output 'PASS: last-stage failure is preserved'

        $result = Invoke-Runner -Scope 'Workspace' -FailStage 'doctest'
        Assert-Condition ($result.Code -eq 23) 'A workspace doctest failure must reach the caller unchanged.'
        Assert-SecurityBoundary -Text $result.Text
        Assert-Condition ($result.Text.Contains('LOCAL_CHECKS_FAILED stage=workspace-doctests exit=23')) 'The doctest failure must be identified.'
        Assert-Condition (-not $result.Text.Contains('LOCAL_CHECKS_PASSED')) 'A doctest failure must not print success.'
        $passed++
        Write-Output 'PASS: workspace doctest failure is preserved'

        $fixturePath = $env:PATH
        try {
            New-Item -ItemType Directory -Path $temporaryToolDirectory -ErrorAction Stop | Out-Null
            Copy-Item -LiteralPath $fixtureRg -Destination $temporaryRg -ErrorAction Stop
            $env:PATH = $temporaryToolDirectory
            $result = Invoke-Runner -Scope 'Focused'
            Assert-Condition ($result.Code -ne 0) 'Missing Cargo must fail.'
            Assert-SecurityBoundary -Text $result.Text
            Assert-Condition ($result.Text.Contains('LOCAL_CHECKS_FAILED setup_or_execution exit=1')) 'Missing Cargo must have an explicit setup failure.'
            Assert-Condition (-not $result.Text.Contains('LOCAL_CHECKS_PASSED')) 'A missing dependency must not print success.'
        }
        finally { $env:PATH = $fixturePath }
        $passed++
        Write-Output 'PASS: missing Cargo is a setup failure'

        foreach ($extra in @('--ignored', '--include-ignored')) {
            $result = Invoke-Runner -Scope 'Focused' -ExtraArguments @($extra)
            Assert-Condition ($result.Code -ne 0) 'Unsupported test options must be rejected.'
            Assert-Condition (-not $result.Text.Contains('VERIFY_TEST_CARGO:')) 'Unsupported options must not start Cargo.'
            $passed++
            Write-Output "PASS: unsupported $extra is rejected"
        }

        $result = Invoke-Runner -Scope 'Unknown'
        Assert-Condition ($result.Code -ne 0) 'An unknown scope must be rejected.'
        Assert-Condition (-not $result.Text.Contains('VERIFY_TEST_CARGO:')) 'Invalid scope must not start Cargo.'
        $passed++
        Write-Output 'PASS: invalid scope is rejected'
    }
    finally { Pop-Location }
    Write-Output "VERIFIER_TESTS_PASSED=$passed"
}
catch {
    Write-Output "FAIL: $($_.Exception.Message)"
    exit 1
}
finally {
    $env:PATH = $originalPath
    $env:KEYATLAS_TEST_FAIL_STAGE = $originalFailure
    if (Test-Path -LiteralPath $temporaryRg -PathType Leaf) {
        Remove-Item -LiteralPath $temporaryRg -Force
    }
    if (Test-Path -LiteralPath $temporaryToolDirectory -PathType Container) {
        Remove-Item -LiteralPath $temporaryToolDirectory -Force
    }
}
