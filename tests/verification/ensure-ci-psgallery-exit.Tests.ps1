#requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Standalone process-exit regression when pinned Pester is unavailable. Reuse
# only the reviewed synthetic child fixture function, never execute the Pester
# suite or import PowerShellGet/PackageManagement. No files or settings change.
$script:PreparationPath = Join-Path $PSScriptRoot '..\..\scripts\ensure-ci-psgallery.ps1'
$fixturePath = Join-Path $PSScriptRoot 'ensure-ci-psgallery.Tests.ps1'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($fixturePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'SYNTHETIC_CHILD_FIXTURE_PARSE_FAILED' }
$definitions = @($ast.FindAll({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Invoke-SyntheticActionsChild'
}, $true))
if ($definitions.Count -ne 1) { throw 'SYNTHETIC_CHILD_FIXTURE_REQUIRED' }
. ([scriptblock]::Create($definitions[0].Extent.Text))

$beforeExit = Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
$hadExit = $null -ne $beforeExit
$exitValue = if ($hadExit) { $beforeExit.Value } else { $null }
$beforeCI = [Environment]::GetEnvironmentVariable('GITHUB_ACTIONS', 'Process')
$passed = 0
$failed = 0
foreach ($case in @('Stale', 'Read', 'Register', 'ReRead', 'WrongSource', 'Duplicate',
    'WrongProvider', 'ReadThrow', 'RegisterThrow', 'ReReadThrow', 'MissingAfter', 'NonCI')) {
    try {
        $result = Invoke-SyntheticActionsChild -Case $case
        $success = $case -in @('Stale', 'Read', 'Register', 'ReRead')
        if ($success) {
            $valid = $result.ExitCode -eq 0 -and $result.Output.Trim() -ceq 'CI_PSGALLERY_READY' -and [string]::IsNullOrEmpty($result.Error)
        }
        else {
            $combined = $result.Output + $result.Error
            $valid = $result.ExitCode -eq 1 -and $combined -notmatch 'CI_PSGALLERY_READY|SYNTHETIC_CHILD_PRIVATE_DETAIL|untrusted\.invalid' -and
                $result.Error -match 'CI_PSGALLERY_(PREPARATION_FAILED|RUNNER_ONLY)'
        }
        if (-not $valid) {
            $readyCount = @($result.Output -split '\r?\n' | Where-Object { $_ -ceq 'CI_PSGALLERY_READY' }).Count
            Write-Output "CI_PSGALLERY_EXIT_OBSERVED=$case,exit:$($result.ExitCode),ready:$readyCount,stderrEmpty:$([string]::IsNullOrEmpty($result.Error))"
            throw 'SYNTHETIC_ACTIONS_EXIT_MISMATCH'
        }
        $passed++
        Write-Output "CI_PSGALLERY_EXIT_PASS=$case"
    }
    catch {
        $failed++
        # Fixed case names only; no provider exception, fixture body or paths.
        Write-Output "CI_PSGALLERY_EXIT_FAIL=$case"
    }
}
$afterExit = Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
if (($hadExit -ne ($null -ne $afterExit)) -or ($hadExit -and $afterExit.Value -cne $exitValue) -or
    ($beforeCI -cne [Environment]::GetEnvironmentVariable('GITHUB_ACTIONS', 'Process'))) {
    throw 'SYNTHETIC_PARENT_STATE_CHANGED'
}
Write-Output "CI_PSGALLERY_EXIT_COUNTS=passed:$passed,failed:$failed"
if ($failed -ne 0 -or $passed -ne 12) { exit 1 }
Write-Output 'CI_PSGALLERY_EXIT_TESTS_PASSED=12'
exit 0
