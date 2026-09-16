#requires -Version 5.1
[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$Root = (Split-Path -Path $PSScriptRoot -Parent)
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$exitCode = 1

# Fixed resource bounds make the scanner deterministic and prevent an
# attacker-controlled tree from turning the CI gate into an unbounded walk.
$maximumFileBytes = 8MB
$maximumAggregateBytes = 256MB
$maximumFileCount = 50000
$maximumEntryCount = 100000
$maximumDepth = 64
$maximumRelativePathCharacters = 4096
$maximumCooperativeElapsedSeconds = 300
$excludedDirectoryNames = @('.git', 'target', 'node_modules', 'coverage', '.vite')
$knownSyntheticBaselines = @{
    'crates/vault-client-wasm/src/archive.rs' = 'EDF72B64AE6E34ED7880E0E6E1691C25BF6079F0728E17501863A13D1856E939'
    'crates/vault-crypto/examples/synthetic_local_alpha.rs' = '505D53E3CE03342325ECAD14A428DC5FDF87F2C1D6284C0F9500025EA0FEDEB1'
    'crates/vault-crypto/src/v0alpha1/tests.rs' = '772A842836BC0082DB7E90E16290A06899B06FB4EEC1272ED307BED2B15801E5'
    'tests/fixtures/synthetic/v0alpha1-vectors.json' = '305D55C738AF9C8BF08961891362892A29565ED4AB06C3989E98884C28E4D1BD'
}

function Test-IsExcludedDirectoryName {
    param([Parameter(Mandatory = $true)][string]$Name)
    foreach ($excludedName in $excludedDirectoryNames) {
        if ([string]::Equals($Name, $excludedName, [StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

function Assert-WithinScanTimeBudget {
    if ($scanStopwatch.Elapsed.TotalSeconds -gt $maximumCooperativeElapsedSeconds) {
        throw 'The repository scan exceeded the cooperative elapsed-time budget.'
    }
}

function Get-SafeRelativePath {
    param(
        [Parameter(Mandatory = $true)][string]$RootPrefix,
        [Parameter(Mandatory = $true)][string]$AbsolutePath
    )

    $fullPath = [IO.Path]::GetFullPath($AbsolutePath)
    if (-not $fullPath.StartsWith($RootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'An enumerated path escaped the repository root.'
    }
    $relativePath = $fullPath.Substring($RootPrefix.Length).Replace('\', '/')
    if ([string]::IsNullOrWhiteSpace($relativePath) -or
        ($relativePath.Length -gt $maximumRelativePathCharacters) -or
        [IO.Path]::IsPathRooted($relativePath) -or
        (($relativePath -split '/') -contains '..') -or
        ($relativePath -match '[\x00-\x1F\x7F]')) {
        throw 'An enumerated path cannot be reported safely.'
    }
    return $relativePath
}

function Assert-RegularParentChain {
    param(
        [Parameter(Mandatory = $true)][string]$RootPath,
        [Parameter(Mandatory = $true)][string]$AbsoluteFilePath
    )

    $rootFullPath = [IO.Path]::GetFullPath($RootPath)
    $rootPathPrefix = $rootFullPath.TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
    ) + [IO.Path]::DirectorySeparatorChar
    $current = [IO.Directory]::GetParent([IO.Path]::GetFullPath($AbsoluteFilePath))
    while ($null -ne $current) {
        Assert-WithinScanTimeBudget
        $currentPath = [IO.Path]::GetFullPath($current.FullName)
        $isRoot = [string]::Equals($currentPath, $rootFullPath, [StringComparison]::OrdinalIgnoreCase)
        if ((-not $isRoot) -and
            (-not $currentPath.StartsWith($rootPathPrefix, [StringComparison]::OrdinalIgnoreCase))) {
            throw 'An included file parent escaped the repository root.'
        }

        $currentItem = Get-Item -LiteralPath $currentPath -Force -ErrorAction Stop
        if ((-not $currentItem.PSIsContainer) -or
            (($currentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
            (-not [string]::Equals(
                [IO.Path]::GetFullPath($currentItem.FullName),
                $currentPath,
                [StringComparison]::OrdinalIgnoreCase))) {
            throw 'An included file parent is not a regular directory.'
        }
        if ($isRoot) { return }
        $current = $current.Parent
    }
    throw 'An included file has no verified repository-root ancestor.'
}

function Test-IsConfigFile {
    param([Parameter(Mandatory = $true)][string]$Name)
    $lowerName = $Name.ToLowerInvariant()
    if (($lowerName -eq '.env') -or
        $lowerName.StartsWith('.env.') -or
        $lowerName.Contains('.env.')) {
        return $true
    }
    foreach ($suffix in @('.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties', '.env')) {
        if ($lowerName.EndsWith($suffix, [StringComparison]::Ordinal)) {
            return $true
        }
    }
    return $false
}

function Get-BoundedFileBytes {
    param([Parameter(Mandatory = $true)][string]$Path)

    $before = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($before.PSIsContainer -or (($before.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw 'An included entry is no longer a regular file.'
    }
    if (($before.Length -lt 0) -or ($before.Length -gt $maximumFileBytes) -or ($before.Length -gt [int]::MaxValue)) {
        throw 'An included file exceeds the fixed scan bound.'
    }

    $stream = New-Object IO.FileStream(
        $Path,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        [IO.FileShare]::Read
    )
    try {
        if ($stream.Length -ne $before.Length) {
            throw 'An included file changed before it was read.'
        }
        $bytes = New-Object byte[] ([int]$stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            Assert-WithinScanTimeBudget
            $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($read -le 0) {
                throw 'An included file could not be read completely.'
            }
            $offset += $read
        }
        if (($stream.ReadByte() -ne -1) -or ($stream.Length -ne $before.Length)) {
            throw 'An included file changed while it was being read.'
        }
    }
    finally {
        $stream.Dispose()
    }

    $after = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($after.PSIsContainer -or
        (($after.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
        ($after.Length -ne $before.Length) -or
        ($after.LastWriteTimeUtc.Ticks -ne $before.LastWriteTimeUtc.Ticks) -or
        ($after.Attributes -ne $before.Attributes)) {
        throw 'An included file changed while it was being scanned.'
    }
    return ,$bytes
}

function ConvertTo-AsciiBinaryProjection {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)

    # Binary files are not skipped. Printable ASCII runs are projected
    # one-for-one and all other bytes become newlines. Separate 2-byte and
    # 4-byte lanes prevent BOM-less UTF-16/UTF-32 ASCII text from hiding a
    # token behind interleaved NUL bytes. These are bounded projections, not a
    # permissive fallback decoder.
    $projections = New-Object 'Collections.Generic.List[string]'
    foreach ($stride in @(1, 2, 4)) {
        for ($lane = 0; $lane -lt $stride; $lane++) {
            if ($lane -ge $Bytes.Length) { continue }
            $length = [int][Math]::Ceiling(($Bytes.Length - $lane) / [double]$stride)
            $characters = New-Object char[] $length
            $outputIndex = 0
            for ($index = $lane; $index -lt $Bytes.Length; $index += $stride) {
                if (($outputIndex -band 0xFFF) -eq 0) { Assert-WithinScanTimeBudget }
                $value = $Bytes[$index]
                if ((($value -ge 0x20) -and ($value -le 0x7E)) -or
                    ($value -eq 0x09) -or ($value -eq 0x0A) -or ($value -eq 0x0D)) {
                    $characters[$outputIndex] = [char]$value
                }
                else {
                    $characters[$outputIndex] = "`n"
                }
                $outputIndex++
            }
            $projections.Add((New-Object -TypeName System.String -ArgumentList (,$characters)))
        }
    }
    return [string]::Join("`n", $projections.ToArray())
}

function ConvertFrom-StrictContentBytes {
    param(
        [Parameter(Mandatory = $true)][byte[]]$Bytes,
        [Parameter(Mandatory = $true)][bool]$ConfigFile
    )

    $offset = 0
    $encoding = $null
    if (($Bytes.Length -ge 4) -and
        ($Bytes[0] -eq 0x00) -and ($Bytes[1] -eq 0x00) -and
        ($Bytes[2] -eq 0xFE) -and ($Bytes[3] -eq 0xFF)) {
        $encoding = New-Object Text.UTF32Encoding($true, $true, $true)
        $offset = 4
    }
    elseif (($Bytes.Length -ge 4) -and
        ($Bytes[0] -eq 0xFF) -and ($Bytes[1] -eq 0xFE) -and
        ($Bytes[2] -eq 0x00) -and ($Bytes[3] -eq 0x00)) {
        $encoding = New-Object Text.UTF32Encoding($false, $true, $true)
        $offset = 4
    }
    elseif (($Bytes.Length -ge 3) -and
        ($Bytes[0] -eq 0xEF) -and ($Bytes[1] -eq 0xBB) -and ($Bytes[2] -eq 0xBF)) {
        $encoding = New-Object Text.UTF8Encoding($false, $true)
        $offset = 3
    }
    elseif (($Bytes.Length -ge 2) -and ($Bytes[0] -eq 0xFE) -and ($Bytes[1] -eq 0xFF)) {
        $encoding = New-Object Text.UnicodeEncoding($true, $true, $true)
        $offset = 2
    }
    elseif (($Bytes.Length -ge 2) -and ($Bytes[0] -eq 0xFF) -and ($Bytes[1] -eq 0xFE)) {
        $encoding = New-Object Text.UnicodeEncoding($false, $true, $true)
        $offset = 2
    }
    else {
        $hasBinaryControl = $false
        for ($byteIndex = 0; $byteIndex -lt $Bytes.Length; $byteIndex++) {
            if (($byteIndex -band 0xFFF) -eq 0) { Assert-WithinScanTimeBudget }
            $value = $Bytes[$byteIndex]
            if (($value -eq 0) -or
                (($value -lt 0x20) -and ($value -ne 0x09) -and ($value -ne 0x0A) -and ($value -ne 0x0D))) {
                $hasBinaryControl = $true
                break
            }
        }
        if ($hasBinaryControl) {
            if ($ConfigFile) {
                throw 'A configuration file contains unsupported binary content.'
            }
            return [pscustomobject]@{
                Text = (ConvertTo-AsciiBinaryProjection -Bytes $Bytes)
                IsBinaryProjection = $true
            }
        }
        # Unmarked content has one deterministic interpretation. Invalid UTF-8
        # fails closed instead of falling back to a runner-specific code page.
        $encoding = New-Object Text.UTF8Encoding($false, $true)
    }

    Assert-WithinScanTimeBudget
    $text = $encoding.GetString($Bytes, $offset, $Bytes.Length - $offset)
    Assert-WithinScanTimeBudget
    if ($text -match '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]') {
        throw 'An included text file contains unsupported control content.'
    }
    return [pscustomobject]@{ Text = $text; IsBinaryProjection = $false }
}

function Get-NormalizedTextSha256 {
    param([Parameter(Mandatory = $true)][string]$Text)
    $normalized = $Text.Replace("`r`n", "`n").Replace("`r", "`n")
    $encoding = New-Object Text.UTF8Encoding($false)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        Assert-WithinScanTimeBudget
        $hash = ([BitConverter]::ToString($algorithm.ComputeHash($encoding.GetBytes($normalized)))).Replace('-', '')
        Assert-WithinScanTimeBudget
        return $hash
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
$allTextPattern = '(?:' + $environmentQuotedAssignment + '|' + $declaredQuotedAssignment + '|' + $bareQuotedAssignment + '|' + $bareQuotedProperty + '|' + $exportUnquotedAssignment + '|' + $powerShellEnvironmentQuotedAssignment + '|' + $cmdEnvironmentAssignment + '|' + $cmdWrappedEnvironmentAssignment + '|' + $providerShape + ')'
$configPattern = '(?:' + $structuredAssignment + '|' + $jsonAssignment + '|' + $environmentUnquotedAssignment + ')'
$regexTimeout = [TimeSpan]::FromSeconds(2)
$regexOptions = [Text.RegularExpressions.RegexOptions]::CultureInvariant
$allTextRegex = New-Object Text.RegularExpressions.Regex($allTextPattern, $regexOptions, $regexTimeout)
$configRegex = New-Object Text.RegularExpressions.Regex($configPattern, $regexOptions, $regexTimeout)

try {
    $scanStopwatch = [Diagnostics.Stopwatch]::StartNew()
    $resolvedRoot = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Root -ErrorAction Stop).ProviderPath)
    $rootItem = Get-Item -LiteralPath $resolvedRoot -Force -ErrorAction Stop
    if (-not $rootItem.PSIsContainer) { throw 'The scan root must be a directory.' }
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The scan root must not be a reparse point.'
    }

    $rootPrefix = $resolvedRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $pending = New-Object 'Collections.Generic.Stack[object]'
    $pending.Push([pscustomobject]@{ Path = $resolvedRoot; Depth = 0 })
    $filePaths = New-Object 'Collections.Generic.List[string]'
    $relativeByAbsolute = @{}
    [long]$entryCount = 0

    while ($pending.Count -gt 0) {
        Assert-WithinScanTimeBudget
        $work = $pending.Pop()
        if ($work.Depth -gt $maximumDepth) { throw 'The repository tree exceeds the fixed depth bound.' }
        $directoryBefore = Get-Item -LiteralPath $work.Path -Force -ErrorAction Stop
        if ((-not $directoryBefore.PSIsContainer) -or
            (($directoryBefore.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw 'An included directory is no longer a regular directory.'
        }
        $directoryPath = [IO.Path]::GetFullPath($directoryBefore.FullName)
        if ($work.Depth -eq 0) {
            if (-not [string]::Equals($directoryPath, $resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'The repository root changed during traversal.'
            }
        }
        else {
            [void](Get-SafeRelativePath -RootPrefix $rootPrefix -AbsolutePath $directoryPath)
        }

        foreach ($entry in $directoryBefore.EnumerateFileSystemInfos()) {
            Assert-WithinScanTimeBudget
            $entryCount++
            if ($entryCount -gt $maximumEntryCount) {
                throw 'The repository tree exceeds the fixed entry-count bound.'
            }
            $absolutePath = [IO.Path]::GetFullPath($entry.FullName)
            $relativePath = Get-SafeRelativePath -RootPrefix $rootPrefix -AbsolutePath $absolutePath
            $isDirectory = ($entry.Attributes -band [IO.FileAttributes]::Directory) -ne 0
            if ($isDirectory -and (Test-IsExcludedDirectoryName -Name $entry.Name)) { continue }
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'An included reparse point is forbidden.'
            }
            if ($isDirectory) {
                $pending.Push([pscustomobject]@{ Path = $absolutePath; Depth = $work.Depth + 1 })
                continue
            }
            if (-not ($entry -is [IO.FileInfo])) { throw 'An included filesystem entry is unsupported.' }
            if ($filePaths.Count -ge $maximumFileCount) { throw 'The repository tree exceeds the fixed file-count bound.' }
            $filePaths.Add($absolutePath)
            $relativeByAbsolute[$absolutePath] = $relativePath
        }

        # This narrows directory-swap races without claiming handle-based
        # confinement. Concurrent repository mutation remains fail-closed and
        # outside the clean-runner threat model documented for this gate.
        $directoryAfter = Get-Item -LiteralPath $work.Path -Force -ErrorAction Stop
        if ((-not $directoryAfter.PSIsContainer) -or
            (($directoryAfter.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
            (-not [string]::Equals(
                [IO.Path]::GetFullPath($directoryAfter.FullName),
                $directoryPath,
                [StringComparison]::OrdinalIgnoreCase)) -or
            ($directoryAfter.CreationTimeUtc.Ticks -ne $directoryBefore.CreationTimeUtc.Ticks) -or
            ($directoryAfter.LastWriteTimeUtc.Ticks -ne $directoryBefore.LastWriteTimeUtc.Ticks) -or
            ($directoryAfter.Attributes -ne $directoryBefore.Attributes)) {
            throw 'An included directory changed during traversal.'
        }
    }

    # Completeness is mandatory only for the scanner's own repository root. It
    # cannot be disabled by deleting Cargo.toml from an attacked checkout.
    $scannerRepositoryRoot = [IO.Path]::GetFullPath((Split-Path -Path $PSScriptRoot -Parent))
    $requireCompleteBaselineManifest = [string]::Equals($resolvedRoot, $scannerRepositoryRoot, [StringComparison]::OrdinalIgnoreCase)
    $safeSyntheticBaselines = @{}
    foreach ($baselinePath in $knownSyntheticBaselines.Keys) {
        if ([IO.Path]::IsPathRooted($baselinePath) -or (($baselinePath -split '[\\/]') -contains '..')) {
            throw 'The synthetic baseline manifest contains an unsafe path.'
        }
        $safeSyntheticBaselines[$baselinePath.Replace('\', '/')] = [string]$knownSyntheticBaselines[$baselinePath]
    }

    $candidateSet = New-Object 'Collections.Generic.SortedSet[string]' ([StringComparer]::Ordinal)
    $verifiedSyntheticBaselines = @{}
    $sortedFiles = $filePaths.ToArray()
    [Array]::Sort($sortedFiles, [StringComparer]::Ordinal)
    [long]$aggregateBytes = 0
    foreach ($absoluteFile in $sortedFiles) {
        Assert-WithinScanTimeBudget
        $relativePath = [string]$relativeByAbsolute[$absoluteFile]
        Assert-RegularParentChain -RootPath $resolvedRoot -AbsoluteFilePath $absoluteFile
        $bytes = Get-BoundedFileBytes -Path $absoluteFile
        Assert-RegularParentChain -RootPath $resolvedRoot -AbsoluteFilePath $absoluteFile
        $aggregateBytes += $bytes.LongLength
        if ($aggregateBytes -gt $maximumAggregateBytes) { throw 'The repository exceeds the fixed aggregate scan bound.' }
        $isConfig = Test-IsConfigFile -Name ([IO.Path]::GetFileName($absoluteFile))
        $content = ConvertFrom-StrictContentBytes -Bytes $bytes -ConfigFile $isConfig

        # A baseline hash and its pattern scan use this exact in-memory file
        # snapshot; no second read can race the allow decision.
        if ($safeSyntheticBaselines.ContainsKey($relativePath)) {
            if ($content.IsBinaryProjection) { throw 'A synthetic baseline must be strict text.' }
            $baselineHash = Get-NormalizedTextSha256 -Text $content.Text
            if (-not [string]::Equals($baselineHash, [string]$safeSyntheticBaselines[$relativePath], [StringComparison]::OrdinalIgnoreCase)) {
                throw 'A synthetic baseline failed its integrity check.'
            }
            $verifiedSyntheticBaselines[$relativePath] = $true
        }

        $matched = $allTextRegex.IsMatch($content.Text)
        if ((-not $matched) -and $isConfig -and (-not $content.IsBinaryProjection)) {
            $matched = $configRegex.IsMatch($content.Text)
        }
        if ($matched) { [void]$candidateSet.Add($relativePath) }

        # Release the largest per-file objects before reading the next file.
        $content = $null
        $bytes = $null
        Assert-WithinScanTimeBudget
    }

    if ($requireCompleteBaselineManifest) {
        foreach ($safeBaselinePath in $safeSyntheticBaselines.Keys) {
            if (-not $verifiedSyntheticBaselines.ContainsKey($safeBaselinePath)) {
                throw 'A required synthetic baseline is missing.'
            }
        }
    }

    $actionablePaths = New-Object 'Collections.Generic.List[string]'
    $baselineAllowed = 0
    foreach ($candidatePath in $candidateSet) {
        if ($verifiedSyntheticBaselines.ContainsKey($candidatePath)) { $baselineAllowed++ }
        else { $actionablePaths.Add($candidatePath) }
    }
    if ($baselineAllowed -gt 0) { Write-Output "SECRET_SCAN_BASELINE_ALLOWED=$baselineAllowed" }
    if ($actionablePaths.Count -eq 0) {
        Write-Output 'SECRET_SCAN_PASSED'
        $exitCode = 0
    }
    else {
        Write-Output "SECRET_SCAN_FINDINGS=$($actionablePaths.Count)"
        foreach ($safePath in $actionablePaths) { Write-Output "SECRET_SCAN_FILE=$safePath" }
        $exitCode = 1
    }
}
catch {
    # Error details and paths are intentionally withheld because decoding and
    # read failures can themselves contain attacker-controlled data.
    Write-Output 'SECRET_SCAN_FAILED setup_or_execution'
    $exitCode = 1
}

Write-Output 'REAL_SECRET_GATE=CLOSED'
exit $exitCode
