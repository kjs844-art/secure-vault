#requires -Version 5.1
[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$Root = (Split-Path -Path $PSScriptRoot -Parent)
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$exitCode = 1
$locationPushed = $false
$knownSyntheticBaselines = @{
    'crates/vault-client-wasm/src/archive.rs' = 'B524DB25C3782DC34BD2D0824A3EE7CC2751FB23AA8808F0DC812BBB314E50D6'
    'crates/vault-crypto/examples/synthetic_local_alpha.rs' = '505D53E3CE03342325ECAD14A428DC5FDF87F2C1D6284C0F9500025EA0FEDEB1'
    'crates/vault-crypto/src/v0alpha1/tests.rs' = '772A842836BC0082DB7E90E16290A06899B06FB4EEC1272ED307BED2B15801E5'
    'tests/fixtures/synthetic/v0alpha1-vectors.json' = '305D55C738AF9C8BF08961891362892A29565ED4AB06C3989E98884C28E4D1BD'
}

function Get-NormalizedTextSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $content = [IO.File]::ReadAllText($Path)
    $normalized = $content.Replace("`r`n", "`n").Replace("`r", "`n")
    $encoding = New-Object System.Text.UTF8Encoding($false)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $encoding.GetBytes($normalized)
        return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '')
    }
    finally {
        $algorithm.Dispose()
    }
}

# Keep these expressions narrow enough to avoid ordinary source identifiers.
# Findings are reported by file only: never print a matching line or value.
$credentialNames = '(?:api[_-]?key|client[_-]?secret|secret[_-]?(?:access[_-]?)?key|password|access[_-]?token|refresh[_-]?token)'
$environmentNames = '(?:(?:[A-Z][A-Z0-9_]*_)?(?:API_KEY|CLIENT_SECRET|SECRET_KEY|SECRET_ACCESS_KEY|PASSWORD|ACCESS_TOKEN|REFRESH_TOKEN))'
$camelPrefixedCredentialNames = '(?:[a-z][A-Za-z0-9]*)(?:ApiKey|ClientSecret|SecretKey|SecretAccessKey|Password|AccessToken|RefreshToken)'
$sourceCredentialNames = '(?:' + $credentialNames + '|' + $environmentNames + '|' + $camelPrefixedCredentialNames + ')'
$placeholderValues = '(?i:(?:your_(?:api_key|client_secret|secret_key|password|access_token|refresh_token)|example_(?:value|api_key|secret|password)|sample_(?:value|api_key|secret|password)|dummy_(?:value|api_key|secret|password)|test_value|changeme|replace_me|placeholder|redacted|none|null))'
$dynamicReference = '(?:process\.env\.|import\.meta\.env\.|env\.|os\.(?:environ|getenv)|config\.|std::env(?:::|\.))'
$quotedValue = '(?:r#)?[\x22\x27](?!' + $placeholderValues + '[\x22\x27])(?![$%])[^\x22\x27\r\n]{8,}[\x22\x27]'
$unquotedValue = '(?!' + $placeholderValues + '(?:[\x20\t#;\r\n]|$))(?!' + $dynamicReference + ')(?![$%\x22\x27])[^\x00-\x20\x22\x23\x27\x3B\x7F]{8,}(?=[\x20\t#;\r\n]|$)'
$configCredentialNames = '(?:(?:[A-Za-z0-9][A-Za-z0-9_-]*[._-])*(?:' + $sourceCredentialNames + '))'
$structuredAssignment = '(?im:^[\x20\t]*[\x22\x27]?' + $configCredentialNames + '[\x22\x27]?[\x20\t]*[:=][\x20\t]*)(?:' + $quotedValue + '|' + $unquotedValue + ')'
$jsonAssignment = '(?i:[\x22\x27]' + $configCredentialNames + '[\x22\x27][\x20\t]*:[\x20\t]*)' + $quotedValue
$environmentQuotedAssignment = '(?m:^[\x20\t]*(?:export[\x20\t]+)?)(?-i:' + $environmentNames + ')[\x20\t]*=[\x20\t]*' + $quotedValue
$environmentUnquotedAssignment = '(?m:^[\x20\t]*(?:export[\x20\t]+)?)(?-i:' + $environmentNames + ')[\x20\t]*=[\x20\t]*' + $unquotedValue
$declarationPrefix = '(?i:(?:(?:public|private|protected|internal|pub|static|final|readonly|export|default|const|let|var|val|mut|string)[\x20\t]+)+)'
$declaredCredentialNames = $sourceCredentialNames
$declaredQuotedAssignment = '(?m:^[\x20\t]*)' + $declarationPrefix + '(?i:' + $declaredCredentialNames + ')(?:[\x20\t]*:[^=;\r\n]+)?[\x20\t]*=[\x20\t]*' + $quotedValue
$bareQuotedAssignment = '(?m:^[\x20\t]*)(?i:' + $declaredCredentialNames + ')(?:[\x20\t]*:[^=;\r\n]+)?[\x20\t]*=[\x20\t]*' + $quotedValue
$bareQuotedProperty = '(?m:^[\x20\t]*[\x22\x27]?)(?i:' + $declaredCredentialNames + ')[\x22\x27]?[\x20\t]*:[\x20\t]*' + $quotedValue
$exportUnquotedAssignment = '(?m:^[\x20\t]*export[\x20\t]+)(?-i:' + $environmentNames + ')[\x20\t]*=[\x20\t]*' + $unquotedValue
$powerShellEnvironmentQuotedAssignment = '(?mi:^[\x20\t]*\x24env:)(?i:' + $environmentNames + ')[\x20\t]*=[\x20\t]*' + $quotedValue
$cmdEnvironmentAssignment = '(?mi:^[\x20\t]*set[\x20\t]+)(?i:' + $environmentNames + ')[\x20\t]*=[\x20\t]*(?:' + $quotedValue + '|' + $unquotedValue + ')'
$cmdWrappedUnquotedValue = '(?!' + $placeholderValues + '\x22)(?!' + $dynamicReference + ')(?![$%\x22\x27])[^\x00-\x20\x22\x23\x27\x3B\x7F]{8,}(?=\x22[\x20\t]*(?m:\r?$))'
$cmdWrappedEnvironmentAssignment = '(?mi:^[\x20\t]*set[\x20\t]+\x22)(?i:' + $environmentNames + ')[\x20\t]*=[\x20\t]*' + $cmdWrappedUnquotedValue + '\x22[\x20\t]*(?m:\r?$)'
$privateKeyHeader = '-----BEGIN (?:(?:RSA|OPENSSH|EC|DSA|ENCRYPTED) )?PRIVATE KEY-----'
$pgpPrivateKeyHeader = '-----BEGIN PGP PRIVATE KEY ' + 'BLOCK-----'
$providerShape = '(?i:\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,})\b|' + $privateKeyHeader + '|' + $pgpPrivateKeyHeader + ')'
$scanSpecs = @(
    @{
        Pattern = '(?:' + $environmentQuotedAssignment + '|' + $declaredQuotedAssignment + '|' + $bareQuotedAssignment + '|' + $bareQuotedProperty + '|' + $exportUnquotedAssignment + '|' + $powerShellEnvironmentQuotedAssignment + '|' + $cmdEnvironmentAssignment + '|' + $cmdWrappedEnvironmentAssignment + '|' + $providerShape + ')'
        IncludeGlobs = @()
    },
    @{
        Pattern = '(?:' + $structuredAssignment + '|' + $jsonAssignment + '|' + $environmentUnquotedAssignment + ')'
        IncludeGlobs = @('*.json', '*.yaml', '*.yml', '*.toml', '*.ini', '*.cfg', '*.conf', '*.properties', '*.env', '*.env.*', '.env', '.env.*')
    }
)

try {
    $resolvedRoot = (Resolve-Path -LiteralPath $Root -ErrorAction Stop).Path
    if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) {
        throw 'The scan root must be a directory.'
    }

    # Treat reviewed synthetic files as an integrity manifest, not merely as
    # post-scan exceptions. Existing entries are always checked; a Rust
    # workspace scan additionally requires every manifest entry to exist.
    $requireCompleteBaselineManifest = Test-Path -LiteralPath (Join-Path $resolvedRoot 'Cargo.toml') -PathType Leaf
    $verifiedSyntheticBaselines = @{}
    foreach ($baselineEntry in $knownSyntheticBaselines.GetEnumerator()) {
        $baselinePath = [string]$baselineEntry.Key
        if ([IO.Path]::IsPathRooted($baselinePath) -or
            (($baselinePath -split '[\\/]') -contains '..')) {
            throw 'The synthetic baseline manifest contains an unsafe path.'
        }

        $nativeBaselinePath = $baselinePath.Replace('/', [IO.Path]::DirectorySeparatorChar)
        $absoluteBaselinePath = Join-Path $resolvedRoot $nativeBaselinePath
        if (-not (Test-Path -LiteralPath $absoluteBaselinePath -PathType Leaf)) {
            if ($requireCompleteBaselineManifest) {
                throw 'A required synthetic baseline is missing.'
            }
            continue
        }

        $baselineItem = Get-Item -LiteralPath $absoluteBaselinePath -Force
        if (($baselineItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'A synthetic baseline must be a regular file.'
        }
        $baselineHash = Get-NormalizedTextSha256 -Path $absoluteBaselinePath
        if (-not [string]::Equals(
                $baselineHash,
                [string]$baselineEntry.Value,
                [StringComparison]::OrdinalIgnoreCase)) {
            throw 'A synthetic baseline failed its integrity check.'
        }
        $verifiedSyntheticBaselines[$baselinePath] = $true
    }

    $rgPath = (Get-Command rg -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    Push-Location -LiteralPath $resolvedRoot
    $locationPushed = $true

    $rawCandidates = @()
    $scannerFailed = $false
    foreach ($scanSpec in $scanSpecs) {
        $arguments = @(
            '--pcre2',
            '--files-with-matches',
            '--hidden',
            '--no-ignore',
            '--no-messages'
        )
        foreach ($includeGlob in $scanSpec.IncludeGlobs) {
            $arguments += @('--glob', $includeGlob)
        }
        $arguments += @(
            '--glob', '!.git/**',
            '--glob', '!**/target/**',
            '--glob', '!**/node_modules/**',
            '--glob', '!**/coverage/**',
            '--glob', '!**/.vite/**',
            '--',
            $scanSpec.Pattern,
            '.'
        )

        $scanOutput = @(& $rgPath @arguments 2>$null)
        $scanExit = $LASTEXITCODE
        if ($null -eq $scanExit) {
            throw 'The scanner did not supply an exit code.'
        }
        $nonemptyOutput = @(
            $scanOutput |
                ForEach-Object { ([string]$_).Trim() } |
                Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        )

        switch ($scanExit) {
            0 {
                if ($nonemptyOutput.Count -eq 0) {
                    throw 'The scanner reported findings without file names.'
                }
                $rawCandidates += $nonemptyOutput
            }
            1 {
                if ($nonemptyOutput.Count -ne 0) {
                    throw 'The scanner returned output with a no-match exit code.'
                }
            }
            default {
                Write-Output "SECRET_SCAN_FAILED scanner_exit=$scanExit"
                $exitCode = 1
                $scannerFailed = $true
            }
        }
        if ($scannerFailed) { break }
    }

    if (-not $scannerFailed) {
        if ($rawCandidates.Count -eq 0) {
            Write-Output 'SECRET_SCAN_PASSED'
            $exitCode = 0
        }
        else {
            $candidates = @(
                $rawCandidates |
                    ForEach-Object { ([string]$_).Trim() } |
                    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
                    Sort-Object -Unique
            )
            if ($candidates.Count -eq 0) {
                throw 'The scanner reported findings without file names.'
            }

            $safePaths = @(
                foreach ($candidate in $candidates) {
                    if ([IO.Path]::IsPathRooted($candidate) -or
                        (($candidate -split '[\\/]') -contains '..')) {
                        throw 'The scanner returned a path outside the repository boundary.'
                    }
                    ($candidate -replace '^[.][\\/]', '') -replace '\\', '/'
                }
            )

            $actionablePaths = @()
            $baselineAllowed = 0
            foreach ($safePath in $safePaths) {
                if ($verifiedSyntheticBaselines.ContainsKey($safePath)) {
                    $baselineAllowed++
                    continue
                }
                $actionablePaths += $safePath
            }

            if ($baselineAllowed -gt 0) {
                Write-Output "SECRET_SCAN_BASELINE_ALLOWED=$baselineAllowed"
            }

            if ($actionablePaths.Count -eq 0) {
                Write-Output 'SECRET_SCAN_PASSED'
                $exitCode = 0
            }
            else {
                Write-Output "SECRET_SCAN_FINDINGS=$($actionablePaths.Count)"
                foreach ($safePath in $actionablePaths) {
                    Write-Output "SECRET_SCAN_FILE=$safePath"
                }
                $exitCode = 1
            }
        }
    }
}
catch {
    Write-Output 'SECRET_SCAN_FAILED setup_or_execution'
    $exitCode = 1
}
finally {
    if ($locationPushed) {
        Pop-Location
    }
}

Write-Output 'REAL_SECRET_GATE=CLOSED'
exit $exitCode
