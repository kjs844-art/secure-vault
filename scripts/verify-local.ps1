#requires -Version 5.1
[CmdletBinding(PositionalBinding = $false)]
param(
    [ValidateSet('Focused', 'Workspace')]
    [string]$Scope = 'Focused'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# PowerShell 7 callers may enable native-exit exceptions in their profile.
# Capture Cargo's own exit code consistently with Windows PowerShell 5.1.
$PSNativeCommandUseErrorActionPreference = $false
$exitCode = 0
$locationPushed = $false

try {
    $repositoryRoot = Split-Path -Path $PSScriptRoot -Parent
    if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot 'Cargo.toml') -PathType Leaf)) {
        throw 'The verification script must remain inside the Rust workspace scripts directory.'
    }
    $cargoPath = (Get-Command cargo -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    Push-Location -LiteralPath $repositoryRoot
    $locationPushed = $true
    $targets = @('-p', 'vault-local-sqlite-vfs-windows')
    if ($Scope -eq 'Workspace') { $targets = @('--workspace') }

    $steps = @(
        @{
            Name = 'format'
            Arguments = @('fmt', '--all', '--', '--check')
        }
        @{
            Name = 'clippy'
            Arguments = @('clippy', '--offline', '--locked') + $targets + @('--all-targets', '--all-features', '--', '-D', 'warnings')
        }
        @{
            Name = 'default-tests'
            Arguments = @('test', '--offline', '--locked') + $targets + @('--tests', '--', '--test-threads=1')
        }
        @{
            Name = 'probe-ordinary-tests'
            Arguments = @('test', '--offline', '--locked', '-p', 'vault-local-sqlite-vfs-windows', '--features', 'feasibility-probe', '--', '--test-threads=1')
        }
    )

    if ($Scope -eq 'Workspace') {
        $steps += @{
            Name = 'workspace-doctests'
            Arguments = @('test', '--offline', '--locked', '--workspace', '--doc')
        }
    }

    Write-Output "VERIFY_SCOPE=$Scope"
    Write-Output "VERIFY_ROOT=$repositoryRoot"
    foreach ($step in $steps) {
        [string[]]$arguments = $step.Arguments
        Write-Output ("CHECK=$($step.Name) cargo " + ($arguments -join ' '))
        & $cargoPath @arguments
        $exitCode = $LASTEXITCODE
        if ($null -eq $exitCode) { throw 'Cargo did not supply an exit code.' }
        Write-Output "CHECK_EXIT=$($step.Name):$exitCode"
        if ($exitCode -ne 0) {
            Write-Output "LOCAL_CHECKS_FAILED stage=$($step.Name) exit=$exitCode"
            break
        }
    }
}
catch {
    $exitCode = 1
    Write-Output 'LOCAL_CHECKS_FAILED setup_or_execution exit=1'
    Write-Output $_.Exception.Message
}
finally {
    if ($locationPushed) { Pop-Location }
}

if ($exitCode -eq 0) { Write-Output 'LOCAL_CHECKS_PASSED' }
# Ordinary checks are not the separately reviewed, explicitly ignored gate.
Write-Output 'PHASE_0A_VERDICT=UNCHANGED'
Write-Output 'REAL_SECRET_GATE=CLOSED'
exit $exitCode
