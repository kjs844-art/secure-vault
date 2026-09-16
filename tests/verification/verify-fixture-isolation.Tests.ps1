#requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$exitCode = 0
$passed = 0
$sandboxCreated = $false
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$engine = [IO.Path]::GetFullPath((Get-Process -Id $PID).Path)
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$temporaryPrefix = $temporaryRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
$sandboxPath = [IO.Path]::GetFullPath((Join-Path $temporaryRoot ('keyatlas-fixture-isolation-' + [guid]::NewGuid().ToString('N'))))
$originalPath = $env:PATH
$originalPathExt = $env:PATHEXT
$originalFailure = $env:KEYATLAS_TEST_FAIL_STAGE
$originalMarker = $env:KEYATLAS_ISOLATION_MARKER

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Copy-TestProject {
    param([string]$Destination, [bool]$IncludeFixture)
    $scriptDirectory = Join-Path $Destination 'scripts'
    $verificationDirectory = Join-Path $Destination 'tests\verification'
    New-Item -ItemType Directory -Path $scriptDirectory -Force | Out-Null
    New-Item -ItemType Directory -Path $verificationDirectory -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'scripts\verify-local.ps1') -Destination (Join-Path $scriptDirectory 'verify-local.ps1')
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'scripts\check-repository-secrets.ps1') -Destination (Join-Path $scriptDirectory 'check-repository-secrets.ps1')
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'Cargo.toml') -Destination (Join-Path $Destination 'Cargo.toml')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'verify-local.Tests.ps1') -Destination (Join-Path $verificationDirectory 'verify-local.Tests.ps1')
    foreach ($baselinePath in @(
            'crates\vault-client-wasm\src\archive.rs',
            'crates\vault-crypto\examples\synthetic_local_alpha.rs',
            'crates\vault-crypto\src\v0alpha1\tests.rs',
            'tests\fixtures\synthetic\v0alpha1-vectors.json')) {
        $baselineSource = Join-Path $repositoryRoot $baselinePath
        $baselineDestination = Join-Path $Destination $baselinePath
        New-Item -ItemType Directory -Path (Split-Path -Path $baselineDestination -Parent) -Force | Out-Null
        Copy-Item -LiteralPath $baselineSource -Destination $baselineDestination
    }
    if ($IncludeFixture) {
        $fixtureDirectory = Join-Path $verificationDirectory 'fixtures'
        New-Item -ItemType Directory -Path $fixtureDirectory | Out-Null
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'fixtures\cargo.cmd') -Destination (Join-Path $fixtureDirectory 'cargo.cmd')
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'fixtures\rg.cmd') -Destination (Join-Path $fixtureDirectory 'rg.cmd')
    }
    Join-Path $verificationDirectory 'verify-local.Tests.ps1'
}

function Invoke-IsolatedHarness {
    param([string]$Harness, [string]$Marker)
    $env:KEYATLAS_ISOLATION_MARKER = $Marker
    $env:KEYATLAS_TEST_FAIL_STAGE = ''
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& $engine -NoProfile -NonInteractive -File $Harness 2>&1)
        $code = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $savedPreference }
    [pscustomobject]@{
        Code = $code
        Text = ($lines -join "`n")
        FallbackExecuted = (Test-Path -LiteralPath $Marker -PathType Leaf)
    }
}

try {
    Assert-Condition ($sandboxPath.StartsWith($temporaryPrefix, [StringComparison]::OrdinalIgnoreCase)) 'The owned sandbox must be inside the temporary directory.'
    Assert-Condition (-not (Test-Path -LiteralPath $sandboxPath)) 'The owned sandbox path must not already exist.'
    New-Item -ItemType Directory -Path $sandboxPath | Out-Null
    $sandboxCreated = $true

    $fallbackDirectory = Join-Path $sandboxPath 'fallback'
    New-Item -ItemType Directory -Path $fallbackDirectory | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'fixtures\fallback\cargo.cmd') -Destination (Join-Path $fallbackDirectory 'cargo.cmd')
    $missingHarness = Copy-TestProject -Destination (Join-Path $sandboxPath 'missing fixture') -IncludeFixture $false
    $normalHarness = Copy-TestProject -Destination (Join-Path $sandboxPath 'normal fixture') -IncludeFixture $true

    # Never expose the caller's actual Cargo to either child process.
    $env:PATH = $fallbackDirectory
    # The absolute PowerShell child executable must remain invocable too.
    $env:PATHEXT = '.EXE;.CMD'

    $missingMarker = [IO.Path]::GetFullPath((Join-Path $sandboxPath 'missing-fixture-fallback.marker'))
    $result = Invoke-IsolatedHarness -Harness $missingHarness -Marker $missingMarker
    $problems = @()
    if ($result.Code -ne 1) { $problems += "Missing fixture must return 1; observed $($result.Code)." }
    if ($result.FallbackExecuted) { $problems += 'Fallback Cargo executed: its sandbox marker file was created.' }
    if ($result.Text.Contains('ISOLATION_FALLBACK_CARGO_EXECUTED')) { $problems += 'Fallback Cargo execution was reported in child output.' }
    if ($result.Text.Contains('VERIFIER_TESTS_PASSED')) { $problems += 'Missing fixture must not report successful verifier tests.' }
    if (-not $result.Text.Contains('synthetic Cargo fixture')) { $problems += 'Missing fixture must have an explicit synthetic Cargo fixture failure.' }
    Assert-Condition ($problems.Count -eq 0) ($problems -join ' ')
    $passed++
    Write-Output 'PASS: missing synthetic Cargo fixture fails before fallback execution'

    $normalMarker = [IO.Path]::GetFullPath((Join-Path $sandboxPath 'normal-fixture-fallback.marker'))
    $result = Invoke-IsolatedHarness -Harness $normalHarness -Marker $normalMarker
    Assert-Condition (-not $result.FallbackExecuted) 'The normal fixture run must not create the fallback marker file.'
    Assert-Condition (-not $result.Text.Contains('ISOLATION_FALLBACK_CARGO_EXECUTED')) 'The normal fixture run must not report fallback execution.'
    Assert-Condition ($result.Code -eq 0) "The copied normal harness must return 0; observed $($result.Code). Child output: $($result.Text)"
    Assert-Condition ($result.Text -match '(?m)^VERIFIER_TESTS_PASSED=12\r?$') 'The copied normal harness must pass its 12 regression cases.'
    $passed++
    Write-Output 'PASS: copied normal fixture passes without inherited fallback Cargo'
}
catch {
    $exitCode = 1
    Write-Output "FAIL: $($_.Exception.Message)"
}
finally {
    $env:PATH = $originalPath
    $env:PATHEXT = $originalPathExt
    $env:KEYATLAS_TEST_FAIL_STAGE = $originalFailure
    $env:KEYATLAS_ISOLATION_MARKER = $originalMarker
    if ($sandboxCreated -and (Test-Path -LiteralPath $sandboxPath)) {
        try {
            $cleanupPath = (Resolve-Path -LiteralPath $sandboxPath).ProviderPath
            $sandboxItem = Get-Item -LiteralPath $cleanupPath -Force
            Assert-Condition ([string]::Equals($cleanupPath, $sandboxPath, [StringComparison]::OrdinalIgnoreCase)) 'Refusing cleanup of a different resolved sandbox path.'
            Assert-Condition ($cleanupPath.StartsWith($temporaryPrefix, [StringComparison]::OrdinalIgnoreCase)) 'Refusing cleanup outside the temporary directory.'
            Assert-Condition (($sandboxItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'Refusing cleanup of a reparse-point sandbox.'
            Remove-Item -LiteralPath $cleanupPath -Recurse -Force
        }
        catch {
            $exitCode = 1
            Write-Output "FAIL: owned sandbox cleanup failed: $($_.Exception.Message)"
        }
    }
}

if ($exitCode -eq 0) { Write-Output "FIXTURE_ISOLATION_TESTS_PASSED=$passed" }
exit $exitCode
