#requires -Version 5.1

# Synthetic command mocks only. Never query or alter a developer's real Gallery
# registration, install a module, or contact the network from this suite.
Describe 'CI PowerShell Gallery preparation' {
    BeforeAll {
        $script:PreparationPath = Join-Path $PSScriptRoot '..\..\scripts\ensure-ci-psgallery.ps1'
        $script:PrivateFixtureDetail = 'SYNTHETIC_PROVIDER_FAILURE_DO_NOT_EMIT'

        # These local functions shadow the installed commands before Pester
        # builds its mocks. A missing/broken mock throws instead of falling back
        # to PowerShellGet or PackageManagement.
        function Get-PSRepository {
            [CmdletBinding()]
            param()
            throw 'SYNTHETIC_REPOSITORY_COMMAND_NOT_MOCKED'
        }
        function Register-PSRepository {
            [CmdletBinding()]
            param([switch]$Default)
            throw 'SYNTHETIC_REPOSITORY_COMMAND_NOT_MOCKED'
        }

        foreach ($name in @('Get-PSRepository', 'Register-PSRepository')) {
            $command = Get-Command -Name $name -CommandType Function -ErrorAction Stop
            if (-not $command.Definition.Contains('SYNTHETIC_REPOSITORY_COMMAND_NOT_MOCKED')) {
                throw 'SYNTHETIC_REPOSITORY_COMMAND_SHADOW_REQUIRED'
            }
        }

        function New-SyntheticRepository {
            param(
                [string]$Name = 'PSGallery',
                [AllowNull()]$SourceLocation = 'https://www.powershellgallery.com/api/v2',
                [AllowNull()]$Provider = 'NuGet'
            )
            [pscustomobject]@{
                Name = $Name
                SourceLocation = $SourceLocation
                PackageManagementProvider = $Provider
            }
        }

        function Invoke-SyntheticPreparation {
            $captured = New-Object 'System.Collections.Generic.List[object]'
            $failure = $null
            try {
                & $script:PreparationPath *>&1 | ForEach-Object { $captured.Add($_) }
            }
            catch { $failure = $_ }
            [pscustomobject]@{ Output = $captured.ToArray(); Error = $failure }
        }

        function Assert-Ready {
            param($Result)
            $Result.Error | Should -BeNullOrEmpty
            $Result.Output.Count | Should -Be 1
            $Result.Output[0] | Should -BeExactly 'CI_PSGALLERY_READY'
            (Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction Stop).Value | Should -Be 0
        }

        function Assert-FixedFailure {
            param($Result, [string]$Message = 'CI_PSGALLERY_PREPARATION_FAILED')
            $Result.Error | Should -Not -BeNullOrEmpty
            $Result.Error.Exception.Message | Should -BeExactly $Message
            $Result.Output.Count | Should -Be 0
            $rendered = ($Result.Error | Out-String) + $Result.Error.Exception.ToString()
            $rendered | Should -Not -Match ([regex]::Escape($script:PrivateFixtureDetail))
            $rendered | Should -Not -Match 'CI_PSGALLERY_READY'
            $rendered | Should -Not -Match 'untrusted\.invalid'
            $rendered | Should -Not -Match 'CI_PSGALLERY_INVALID_REGISTRATION'
            (Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction Stop).Value | Should -Be 1
        }

        function Assert-RepositoryCalls {
            param([int]$Reads, [int]$Registrations)
            Should -Invoke Get-PSRepository -Times $Reads -Exactly -Scope It
            Should -Invoke Get-PSRepository -Times $Reads -Exactly -Scope It -ParameterFilter {
                [string]$ErrorAction -ceq 'Stop'
            }
            Should -Invoke Register-PSRepository -Times $Registrations -Exactly -Scope It
            Should -Invoke Register-PSRepository -Times $Registrations -Exactly -Scope It -ParameterFilter {
                $Default -and [string]$ErrorAction -ceq 'Stop'
            }
        }

        function Invoke-SyntheticActionsChild {
            param([ValidateSet('Stale', 'Read', 'Register', 'ReRead', 'WrongSource', 'Duplicate',
                'WrongProvider', 'ReadThrow', 'RegisterThrow', 'ReReadThrow', 'MissingAfter', 'NonCI')][string]$Case)
            # No fixture files, provider imports or real repository commands. The
            # child reproduces Actions runner 2.338.0's pwsh prefix/suffix, not
            # a calculated approximation of its process exit status.
            $program = @'
$ErrorActionPreference = 'Stop'
# Load only built-in output and variable-provider cmdlets before disabling
# provider autoload. Never import PowerShellGet or PackageManagement.
Import-Module Microsoft.PowerShell.Utility, Microsoft.PowerShell.Management -ErrorAction Stop
foreach ($required in @(
    @{ Name = 'Write-Output'; Module = 'Microsoft.PowerShell.Utility' }
    @{ Name = 'Test-Path'; Module = 'Microsoft.PowerShell.Management' }
)) {
    $builtin = Get-Command -Name $required.Name -CommandType Cmdlet -ErrorAction Stop
    if ($builtin.ModuleName -cne $required.Module) { throw 'SYNTHETIC_BUILTIN_REQUIRED' }
}
$PSModuleAutoloadingPreference = 'None'
$env:GITHUB_ACTIONS = 'true'
$global:FixtureCase = '__CASE__'
$global:FixtureReads = 0
$global:LASTEXITCODE = 0
if ($global:FixtureCase -eq 'Stale') { $global:LASTEXITCODE = 1 }
if ($global:FixtureCase -eq 'NonCI') { $env:GITHUB_ACTIONS = 'false' }
function global:Get-PSRepository {
    [CmdletBinding()]param()
    # SYNTHETIC_ACTIONS_REPOSITORY_STUB
    $global:FixtureReads++
    if ($global:FixtureCase -eq 'Read') { $global:LASTEXITCODE = 1 }
    if ($global:FixtureCase -eq 'ReadThrow') { throw 'SYNTHETIC_CHILD_PRIVATE_DETAIL' }
    if ($global:FixtureCase -in @('Register', 'ReRead', 'RegisterThrow', 'ReReadThrow', 'MissingAfter')) {
        if ($global:FixtureReads -eq 1) { return }
        if ($global:FixtureCase -eq 'MissingAfter') { return }
        if ($global:FixtureCase -eq 'ReRead') { $global:LASTEXITCODE = 1 }
        if ($global:FixtureCase -eq 'ReReadThrow') { throw 'SYNTHETIC_CHILD_PRIVATE_DETAIL' }
    }
    $source = 'https://www.powershellgallery.com/api/v2'
    $provider = 'NuGet'
    if ($global:FixtureCase -eq 'WrongSource') { $source = 'https://untrusted.invalid/feed' }
    if ($global:FixtureCase -eq 'WrongProvider') { $provider = 'Other' }
    $row = [pscustomobject]@{Name='PSGallery'; SourceLocation=$source; PackageManagementProvider=$provider}
    $row
    if ($global:FixtureCase -eq 'Duplicate') { $row }
}
function global:Register-PSRepository {
    [CmdletBinding()]param([switch]$Default)
    # SYNTHETIC_ACTIONS_REPOSITORY_STUB
    if (-not $Default) { throw 'SYNTHETIC_DEFAULT_REQUIRED' }
    if ($global:FixtureCase -eq 'Register') { $global:LASTEXITCODE = 1 }
    if ($global:FixtureCase -eq 'RegisterThrow') { throw 'SYNTHETIC_CHILD_PRIVATE_DETAIL' }
}
foreach ($name in @('Get-PSRepository', 'Register-PSRepository')) {
    $command = Get-Command -Name $name -CommandType Function -ErrorAction Stop
    if (-not $command.Definition.Contains('SYNTHETIC_ACTIONS_REPOSITORY_STUB')) { throw 'SYNTHETIC_SHADOW_REQUIRED' }
}
& '__HELPER__'
if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit $LASTEXITCODE }
'@
            $program = $program.Replace('__CASE__', $Case).Replace('__HELPER__', $script:PreparationPath.Replace("'", "''"))
            $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($program))
            $info = New-Object Diagnostics.ProcessStartInfo
            $info.FileName = (Get-Process -Id $PID).Path
            $info.Arguments = '-NoProfile -NonInteractive -EncodedCommand ' + $encoded
            $info.UseShellExecute = $false
            $info.CreateNoWindow = $true
            $info.RedirectStandardOutput = $true
            $info.RedirectStandardError = $true
            $child = New-Object Diagnostics.Process
            $child.StartInfo = $info
            $started = $false
            try {
                if (-not $child.Start()) { throw 'SYNTHETIC_CHILD_START_FAILED' }
                $started = $true
                $stdout = $child.StandardOutput.ReadToEndAsync()
                $stderr = $child.StandardError.ReadToEndAsync()
                if (-not $child.WaitForExit(30000)) {
                    $child.Kill()
                    [void]$child.WaitForExit(5000)
                    throw 'SYNTHETIC_CHILD_TIMEOUT'
                }
                [pscustomobject]@{ ExitCode = $child.ExitCode; Output = $stdout.GetAwaiter().GetResult(); Error = $stderr.GetAwaiter().GetResult() }
            }
            finally {
                try {
                    if ($started -and -not $child.HasExited) {
                        $child.Kill()
                        if (-not $child.WaitForExit(5000)) { throw 'SYNTHETIC_CHILD_CLEANUP_FAILED' }
                    }
                }
                finally { $child.Dispose() }
            }
        }
    }

    BeforeEach {
        $previousExit = Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
        $script:PreviousExitPresent = $null -ne $previousExit
        $script:PreviousExitValue = if ($script:PreviousExitPresent) { $previousExit.Value } else { $null }
        $global:LASTEXITCODE = 1
        $script:PreviousGithubActions = [Environment]::GetEnvironmentVariable('GITHUB_ACTIONS', 'Process')
        $env:GITHUB_ACTIONS = 'true'
        $script:RepositoryState = @{
            Reads = 0
            ReadFailureAt = 0
            RegisterFails = $false
            RegisterOutput = $null
            NativeReadAt = 0
            NativeRegister = $false
            Before = @(New-SyntheticRepository)
            After = @(New-SyntheticRepository)
            PrivateDetail = $script:PrivateFixtureDetail
        }
        # The invoked .ps1 has its own script scope. Capture the fixture object
        # explicitly so its mock state never depends on that script's variables.
        $repositoryState = $script:RepositoryState
        Mock Get-PSRepository -MockWith {
            $repositoryState.Reads++
            if ($repositoryState.Reads -eq $repositoryState.NativeReadAt) { $global:LASTEXITCODE = 1 }
            if ($repositoryState.Reads -eq $repositoryState.ReadFailureAt) {
                throw $repositoryState.PrivateDetail
            }
            if ($repositoryState.Reads -eq 1) { $repositoryState.Before }
            else { $repositoryState.After }
        }.GetNewClosure()
        Mock Register-PSRepository -MockWith {
            if ($repositoryState.NativeRegister) { $global:LASTEXITCODE = 1 }
            if ($repositoryState.RegisterFails) { throw $repositoryState.PrivateDetail }
            $repositoryState.RegisterOutput
        }.GetNewClosure()
    }

    AfterEach {
        try {
            # PS7 can retain an empty environment value. Passing $null to the .NET
            # string parameter can become '' instead of removing the variable.
            if ($null -eq $script:PreviousGithubActions) {
                if (Test-Path Env:GITHUB_ACTIONS) {
                    Remove-Item Env:GITHUB_ACTIONS -ErrorAction Stop
                }
            }
            else {
                [Environment]::SetEnvironmentVariable('GITHUB_ACTIONS', $script:PreviousGithubActions, 'Process')
            }
            # Do not use [string]::Equals here: its argument conversion also collapses
            # $null and ''. The process must retain the original presence and value.
            if ($script:PreviousGithubActions -cne [Environment]::GetEnvironmentVariable('GITHUB_ACTIONS', 'Process')) {
                throw 'SYNTHETIC_ENV_RESTORE_FAILED'
            }
        }
        finally {
            if ($script:PreviousExitPresent) {
                Set-Variable -Name LASTEXITCODE -Scope Global -Value $script:PreviousExitValue -ErrorAction Stop
            }
            else { Remove-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue }
            $restored = Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
            if (($script:PreviousExitPresent -ne ($null -ne $restored)) -or
                ($script:PreviousExitPresent -and $restored.Value -cne $script:PreviousExitValue)) {
                throw 'SYNTHETIC_EXIT_STATE_RESTORE_FAILED'
            }
        }
    }

    It 'sets a successful exit status even when no native exit variable existed' {
        Remove-Variable -Name LASTEXITCODE -Scope Global -ErrorAction Stop
        Assert-Ready (Invoke-SyntheticPreparation)
        Assert-RepositoryCalls -Reads 1 -Registrations 0
    }

    It 'clears native status only after a successful query or verified registration: <Label>' -ForEach @(
        @{ Label = 'first query'; Reads = 1; Register = $false; ExpectedReads = 1 }
        @{ Label = 'registration'; Reads = 0; Register = $true; ExpectedReads = 2 }
        @{ Label = 'second query'; Reads = 2; Register = $false; ExpectedReads = 2 }
    ) {
        $global:LASTEXITCODE = 0
        $script:RepositoryState.NativeReadAt = $Reads
        $script:RepositoryState.NativeRegister = $Register
        if ($ExpectedReads -eq 2) { $script:RepositoryState.Before = @() }
        Assert-Ready (Invoke-SyntheticPreparation)
        Assert-RepositoryCalls -Reads $ExpectedReads -Registrations ($ExpectedReads - 1)
    }

    It 'returns actual process exit zero through the Actions wrapper after verified <Case>' -ForEach @(
        @{ Case = 'Stale' }; @{ Case = 'Read' }; @{ Case = 'Register' }; @{ Case = 'ReRead' }
    ) {
        $result = Invoke-SyntheticActionsChild -Case $Case
        $result.Output.Trim() | Should -BeExactly 'CI_PSGALLERY_READY'
        $result.Error | Should -BeNullOrEmpty
        $result.ExitCode | Should -Be 0
    }

    It 'keeps the Actions wrapper fail-closed without READY for <Case>' -ForEach @(
        @{ Case = 'WrongSource' }; @{ Case = 'Duplicate' }; @{ Case = 'WrongProvider' }
        @{ Case = 'ReadThrow' }; @{ Case = 'RegisterThrow' }; @{ Case = 'ReReadThrow' }
        @{ Case = 'MissingAfter' }; @{ Case = 'NonCI' }
    ) {
        $result = Invoke-SyntheticActionsChild -Case $Case
        $result.ExitCode | Should -Be 1
        ($result.Output + $result.Error) | Should -Not -Match 'CI_PSGALLERY_READY|SYNTHETIC_CHILD_PRIVATE_DETAIL|untrusted\.invalid'
        $result.Error | Should -Match 'CI_PSGALLERY_(PREPARATION_FAILED|RUNNER_ONLY)'
    }

    It 'accepts one existing official NuGet Gallery without registering or re-querying' {
        Assert-Ready (Invoke-SyntheticPreparation)
        Assert-RepositoryCalls -Reads 1 -Registrations 0
    }

    It 'filters all repositories by the exact Gallery name and ignores unrelated entries' {
        $script:RepositoryState.Before = @(
            New-SyntheticRepository -Name 'PSGallery-copy' -SourceLocation 'https://untrusted.invalid/feed'
            New-SyntheticRepository
            New-SyntheticRepository -Name 'Private' -Provider 'Other'
        )
        Assert-Ready (Invoke-SyntheticPreparation)
        Assert-RepositoryCalls -Reads 1 -Registrations 0
    }

    It 'compares Gallery name URL and NuGet provider ordinally without case sensitivity' {
        $script:RepositoryState.Before = @(New-SyntheticRepository -Name 'pSgAlLeRy' -SourceLocation 'HTTPS://WWW.POWERSHELLGALLERY.COM/API/V2' -Provider 'nUgEt')
        Assert-Ready (Invoke-SyntheticPreparation)
        Assert-RepositoryCalls -Reads 1 -Registrations 0
    }

    It 'registers Default once only after a successful empty query and validates the second query' {
        $script:RepositoryState.Before = @()
        $script:RepositoryState.RegisterOutput = $script:PrivateFixtureDetail
        Assert-Ready (Invoke-SyntheticPreparation)
        Assert-RepositoryCalls -Reads 2 -Registrations 1
    }

    It 'registers when unrelated repositories exist but Gallery itself is absent' {
        $script:RepositoryState.Before = @(New-SyntheticRepository -Name 'NotPSGallery')
        Assert-Ready (Invoke-SyntheticPreparation)
        Assert-RepositoryCalls -Reads 2 -Registrations 1
    }

    It 'never interprets a failed first query as an absent repository' {
        $script:RepositoryState.ReadFailureAt = 1
        Assert-FixedFailure (Invoke-SyntheticPreparation)
        Assert-RepositoryCalls -Reads 1 -Registrations 0
    }

    It 'redacts a registration exception and does not retry registration or query again' {
        $script:RepositoryState.Before = @()
        $script:RepositoryState.RegisterFails = $true
        Assert-FixedFailure (Invoke-SyntheticPreparation)
        Assert-RepositoryCalls -Reads 1 -Registrations 1
    }

    It 'redacts a failed post-registration query without attempting another registration' {
        $script:RepositoryState.Before = @()
        $script:RepositoryState.ReadFailureAt = 2
        Assert-FixedFailure (Invoke-SyntheticPreparation)
        Assert-RepositoryCalls -Reads 2 -Registrations 1
    }

    It 'fails if successful registration still leaves Gallery absent' {
        $script:RepositoryState.Before = @()
        $script:RepositoryState.After = @()
        Assert-FixedFailure (Invoke-SyntheticPreparation)
        Assert-RepositoryCalls -Reads 2 -Registrations 1
    }

    It 'does not accept an unrelated repository after registration' {
        $script:RepositoryState.Before = @()
        $script:RepositoryState.After = @(New-SyntheticRepository -Name 'PSGallery-copy')
        Assert-FixedFailure (Invoke-SyntheticPreparation)
        Assert-RepositoryCalls -Reads 2 -Registrations 1
    }

    It 'rejects multiple Gallery registrations including names that differ only in case' {
        $script:RepositoryState.Before = @(New-SyntheticRepository; New-SyntheticRepository -Name 'psgallery')
        Assert-FixedFailure (Invoke-SyntheticPreparation)
        Assert-RepositoryCalls -Reads 1 -Registrations 0
    }

    It 'rejects duplicate registrations returned after registering Default' {
        $script:RepositoryState.Before = @()
        $script:RepositoryState.After = @(New-SyntheticRepository; New-SyntheticRepository)
        Assert-FixedFailure (Invoke-SyntheticPreparation)
        Assert-RepositoryCalls -Reads 2 -Registrations 1
    }

    It 'rejects the non-exact source <Label> without trying to replace it' -ForEach @(
        @{ Label = 'http'; Source = 'http://www.powershellgallery.com/api/v2' }
        @{ Label = 'missing www'; Source = 'https://powershellgallery.com/api/v2' }
        @{ Label = 'suffix'; Source = 'https://www.powershellgallery.com/api/v2/extra' }
        @{ Label = 'trailing slash'; Source = 'https://www.powershellgallery.com/api/v2/' }
        @{ Label = 'query'; Source = 'https://www.powershellgallery.com/api/v2?x=1' }
        @{ Label = 'fragment'; Source = 'https://www.powershellgallery.com/api/v2#x' }
        @{ Label = 'explicit port'; Source = 'https://www.powershellgallery.com:443/api/v2' }
        @{ Label = 'userinfo'; Source = 'https://fixture@www.powershellgallery.com/api/v2' }
        @{ Label = 'other host'; Source = 'https://untrusted.invalid/api/v2' }
        @{ Label = 'leading space'; Source = ' https://www.powershellgallery.com/api/v2' }
        @{ Label = 'trailing space'; Source = 'https://www.powershellgallery.com/api/v2 ' }
        @{ Label = 'empty'; Source = '' }
        @{ Label = 'null'; Source = $null }
    ) {
        $script:RepositoryState.Before = @(New-SyntheticRepository -SourceLocation $Source)
        Assert-FixedFailure (Invoke-SyntheticPreparation)
        Assert-RepositoryCalls -Reads 1 -Registrations 0
    }

    It 'rejects the non-NuGet provider <Label> without registering' -ForEach @(
        @{ Label = 'different'; Provider = 'PowerShellGet' }
        @{ Label = 'suffix'; Provider = 'NuGetExtra' }
        @{ Label = 'leading space'; Provider = ' NuGet' }
        @{ Label = 'trailing space'; Provider = 'NuGet ' }
        @{ Label = 'empty'; Provider = '' }
        @{ Label = 'null'; Provider = $null }
    ) {
        $script:RepositoryState.Before = @(New-SyntheticRepository -Provider $Provider)
        Assert-FixedFailure (Invoke-SyntheticPreparation)
        Assert-RepositoryCalls -Reads 1 -Registrations 0
    }

    It 'also validates source and provider after registration' -ForEach @(
        @{ Source = 'https://untrusted.invalid/feed'; Provider = 'NuGet' }
        @{ Source = 'https://www.powershellgallery.com/api/v2'; Provider = 'Other' }
    ) {
        $script:RepositoryState.Before = @()
        $script:RepositoryState.After = @(New-SyntheticRepository -SourceLocation $Source -Provider $Provider)
        Assert-FixedFailure (Invoke-SyntheticPreparation)
        Assert-RepositoryCalls -Reads 2 -Registrations 1
    }

    It 'redacts a missing registration property <Missing> as a validation failure' -ForEach @(
        @{ Missing = 'Name' }
        @{ Missing = 'SourceLocation' }
        @{ Missing = 'PackageManagementProvider' }
    ) {
        $row = New-SyntheticRepository
        $row.PSObject.Properties.Remove($Missing)
        $script:RepositoryState.Before = @($row)
        Assert-FixedFailure (Invoke-SyntheticPreparation)
        Assert-RepositoryCalls -Reads 1 -Registrations 0
    }

    It 'redacts property access exceptions from repository validation' {
        $row = New-SyntheticRepository
        $row | Add-Member -MemberType ScriptProperty -Name SourceLocation -Value { throw 'SYNTHETIC_PROVIDER_FAILURE_DO_NOT_EMIT' } -Force
        $script:RepositoryState.Before = @($row)
        Assert-FixedFailure (Invoke-SyntheticPreparation)
        Assert-RepositoryCalls -Reads 1 -Registrations 0
    }

    It 'rejects a non-CI marker <Label> before any repository command' -ForEach @(
        @{ Label = 'unset'; Value = $null }
        @{ Label = 'empty'; Value = '' }
        @{ Label = 'false'; Value = 'false' }
        @{ Label = 'uppercase'; Value = 'TRUE' }
        @{ Label = 'titlecase'; Value = 'True' }
        @{ Label = 'leading space'; Value = ' true' }
        @{ Label = 'trailing space'; Value = 'true ' }
        @{ Label = 'numeric'; Value = '1' }
        @{ Label = 'newline'; Value = "true`n" }
    ) {
        if ($null -eq $Value) {
            Remove-Item Env:GITHUB_ACTIONS -ErrorAction Stop
        }
        else {
            [Environment]::SetEnvironmentVariable('GITHUB_ACTIONS', $Value, 'Process')
        }
        Assert-FixedFailure (Invoke-SyntheticPreparation) -Message 'CI_PSGALLERY_RUNNER_ONLY'
        Assert-RepositoryCalls -Reads 0 -Registrations 0
    }
}
