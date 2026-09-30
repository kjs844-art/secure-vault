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
$engine = [IO.Path]::GetFullPath((Get-Process -Id $PID).Path)

try {
    $repositoryRoot = Split-Path -Path $PSScriptRoot -Parent
    if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot 'Cargo.toml') -PathType Leaf)) {
        throw 'The verification script must remain inside the Rust workspace scripts directory.'
    }
    $secretScanner = Join-Path $repositoryRoot 'scripts\check-repository-secrets.ps1'
    if (-not (Test-Path -LiteralPath $secretScanner -PathType Leaf)) {
        throw 'The repository Secret scanner is missing.'
    }

    Write-Output "VERIFY_SCOPE=$Scope"
    Write-Output "VERIFY_ROOT=$repositoryRoot"
    Write-Output 'CHECK=repository-secret-scan powershell check-repository-secrets.ps1'
    $scanOutput = @(& $engine -NoProfile -NonInteractive -File $secretScanner -Root $repositoryRoot 2>&1)
    $scanExit = $LASTEXITCODE
    $scanLines = @($scanOutput | ForEach-Object { [string]$_ })
    $boundaryLines = @($scanLines | Where-Object { $_ -eq 'REAL_SECRET_GATE=CLOSED' })
    $passLines = @($scanLines | Where-Object { $_ -eq 'SECRET_SCAN_PASSED' })
    $findingHeaders = @($scanLines | Where-Object { $_ -match '^SECRET_SCAN_FINDINGS=\d+$' })
    $findingFiles = @($scanLines | Where-Object { $_ -match '^SECRET_SCAN_FILE=[^\r\n]+$' })
    $failureLines = @($scanLines | Where-Object { $_ -match '^SECRET_SCAN_FAILED (?:scanner_exit=-?\d+|setup_or_execution)$' })
    $baselineLines = @($scanLines | Where-Object { $_ -match '^SECRET_SCAN_BASELINE_ALLOWED=\d+$' })
    $allowedLines = @($boundaryLines + $passLines + $findingHeaders + $findingFiles + $failureLines + $baselineLines)
    $protocolValid = ($null -ne $scanExit) -and
        ($boundaryLines.Count -eq 1) -and
        ($allowedLines.Count -eq $scanLines.Count) -and
        ($baselineLines.Count -le 1)

    if ($protocolValid -and ($baselineLines.Count -eq 1)) {
        $declaredBaseline = [int](($baselineLines[0] -split '=', 2)[1])
        $protocolValid = $declaredBaseline -gt 0
    }

    if ($protocolValid -and ($findingFiles.Count -gt 0)) {
        $reportedPaths = @($findingFiles | ForEach-Object { ($_ -split '=', 2)[1] })
        $uniquePaths = @($reportedPaths | Sort-Object -Unique)
        $protocolValid = $uniquePaths.Count -eq $reportedPaths.Count
        foreach ($reportedPath in $reportedPaths) {
            if ([IO.Path]::IsPathRooted($reportedPath) -or
                (($reportedPath -split '[\\/]') -contains '..')) {
                $protocolValid = $false
                break
            }
        }
    }

    if ($protocolValid -and ($findingHeaders.Count -eq 1)) {
        $declaredFindings = [int](($findingHeaders[0] -split '=', 2)[1])
        $protocolValid = ($declaredFindings -gt 0) -and ($declaredFindings -eq $findingFiles.Count)
    }

    if ($protocolValid -and ($scanExit -eq 0)) {
        $protocolValid = ($passLines.Count -eq 1) -and
            ($findingHeaders.Count -eq 0) -and
            ($findingFiles.Count -eq 0) -and
            ($failureLines.Count -eq 0)
    }
    elseif ($protocolValid) {
        $protocolValid = ($passLines.Count -eq 0) -and
            ((($findingHeaders.Count -eq 1) -and ($failureLines.Count -eq 0)) -or
             (($findingHeaders.Count -eq 0) -and ($findingFiles.Count -eq 0) -and ($failureLines.Count -eq 1)))
    }

    if (-not $protocolValid) {
        Write-Output 'SECRET_SCAN_FAILED integration_protocol'
        $exitCode = 1
    }
    else {
        foreach ($line in $scanLines) {
            if ($line -ne 'REAL_SECRET_GATE=CLOSED') { Write-Output $line }
        }
        if ($scanExit -ne 0) { $exitCode = 1 }
    }
    Write-Output "CHECK_EXIT=repository-secret-scan:$exitCode"

    if ($exitCode -ne 0) {
        Write-Output 'LOCAL_CHECKS_FAILED stage=repository-secret-scan exit=1'
    }

    if ($exitCode -eq 0) {
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
