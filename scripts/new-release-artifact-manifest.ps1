#requires -Version 5.1
# This tool proves bounded release-artifact integrity. It is not a Secret
# scanner and must run only after the repository Secret gate succeeds.
[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory = $true)][string]$ArtifactRoot,
    [string]$OutputPath,
    [string]$VerifyManifest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$exitCode = 1

$manifestSchema = 'keyatlas.release-artifact-manifest.v1'
$maximumFileCount = 10000
$maximumTotalEntries = 20000
$maximumDirectoryCount = 10000
$maximumDepth = 32
$maximumRelativePathCharacters = 512
$maximumSingleFileBytes = 512MB
$maximumAggregateFileBytes = 1GB
$maximumManifestBytes = 8MB
$maximumElapsedSeconds = 300
$streamBufferBytes = 64KB
$failurePrefix = 'RELEASE_MANIFEST_REASON:'
$allowedPathPattern = '^[A-Za-z0-9_][A-Za-z0-9._-]*(/[A-Za-z0-9_][A-Za-z0-9._-]*)*$'
$sha256Pattern = '^[0-9a-f]{64}$'
$forbiddenNamePatterns = @(
    '^\.env($|\.)', '\.pem$', '\.key$', '\.p12$', '\.pfx$', '\.jks$', '\.keystore$',
    '^local\.properties$', '^google-services\.json$', 'service-account.*\.json$'
)
$strictUtf8 = New-Object Text.UTF8Encoding($false, $true)
$outputUtf8 = New-Object Text.UTF8Encoding($false)
$operationTimer = [Diagnostics.Stopwatch]::StartNew()

function Stop-Manifest {
    param([Parameter(Mandatory = $true)][string]$Reason)
    throw ($failurePrefix + $Reason)
}

function Assert-WithinTimeBudget {
    # This is a cooperative budget checked between managed I/O calls. A caller
    # or CI job must provide the hard process timeout for a stalled OS call.
    $effectiveElapsedSeconds = Get-EffectiveLimit $maximumElapsedSeconds 'KEYATLAS_RELEASE_MANIFEST_TEST_MAX_ELAPSED_SECONDS'
    if ($operationTimer.Elapsed.TotalSeconds -gt $effectiveElapsedSeconds) {
        Stop-Manifest 'elapsed_budget'
    }
}

function Test-IsReparsePoint {
    param([Parameter(Mandatory = $true)][IO.FileSystemInfo]$Item)
    return (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Get-FullDirectoryPrefix {
    param([Parameter(Mandatory = $true)][string]$Path)
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.EndsWith([IO.Path]::DirectorySeparatorChar)) {
        $full += [IO.Path]::DirectorySeparatorChar
    }
    return $full
}

function Test-IsInsideRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$Root
    )
    $candidateFull = [IO.Path]::GetFullPath($Candidate)
    $rootFull = [IO.Path]::GetFullPath($Root)
    $rootPrefix = Get-FullDirectoryPrefix $rootFull
    return (($candidateFull -ieq $rootFull) -or
        $candidateFull.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase))
}

function Assert-SafeDirectoryChain {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$MissingReason
    )

    $current = New-Object IO.DirectoryInfo([IO.Path]::GetFullPath($Path))
    while ($null -ne $current) {
        Assert-WithinTimeBudget
        try {
            $current.Refresh()
            if (-not $current.Exists) { Stop-Manifest $MissingReason }
            if (Test-IsReparsePoint $current) { Stop-Manifest 'reparse_point' }
            $current = $current.Parent
        }
        catch {
            if ([string]$_.Exception.Message -like ($failurePrefix + '*')) { throw }
            Stop-Manifest $MissingReason
        }
    }
}

function Test-IsForbiddenName {
    param([Parameter(Mandatory = $true)][string]$Name)
    foreach ($pattern in $forbiddenNamePatterns) {
        if ($Name -match $pattern) { return $true }
    }
    return $false
}

# Test-only controls can only REDUCE limits or add a bounded delay. They cannot
# weaken a production policy. This keeps boundary tests small without allocating
# hundreds of MiB or creating tens of thousands of files.
function Get-EffectiveLimit {
    param(
        [Parameter(Mandatory = $true)][long]$Default,
        [Parameter(Mandatory = $true)][string]$EnvironmentName
    )
    if ($env:KEYATLAS_RELEASE_MANIFEST_TEST_MODE -cne 'reduce-only-v1') { return $Default }
    $raw = [Environment]::GetEnvironmentVariable($EnvironmentName)
    if ([string]::IsNullOrWhiteSpace($raw)) { return $Default }
    $candidate = [long]0
    if ([long]::TryParse($raw, [ref]$candidate) -and $candidate -gt 0 -and $candidate -le $Default) {
        return $candidate
    }
    return $Default
}

function Get-TestDelayMilliseconds {
    param([Parameter(Mandatory = $true)][string]$EnvironmentName)
    if ($env:KEYATLAS_RELEASE_MANIFEST_TEST_MODE -cne 'reduce-only-v1') { return 0 }
    $raw = [Environment]::GetEnvironmentVariable($EnvironmentName)
    $delay = 0
    if ([int]::TryParse($raw, [ref]$delay) -and $delay -ge 0 -and $delay -le 5000) {
        return $delay
    }
    return 0
}

function Get-FileSnapshot {
    param([Parameter(Mandatory = $true)][string]$FullPath)

    $effectiveSingleFileBytes = Get-EffectiveLimit $maximumSingleFileBytes 'KEYATLAS_RELEASE_MANIFEST_TEST_MAX_SINGLE_BYTES'
    $stream = $null
    $sha = $null
    try {
        Assert-WithinTimeBudget
        $before = New-Object IO.FileInfo([IO.Path]::GetFullPath($FullPath))
        $before.Refresh()
        if (-not $before.Exists) { Stop-Manifest 'unstable_snapshot' }
        if (Test-IsReparsePoint $before) { Stop-Manifest 'reparse_point' }
        $beforeLength = [long]$before.Length
        $beforeWriteTicks = [long]$before.LastWriteTimeUtc.Ticks
        $beforeAttributes = [IO.FileAttributes]$before.Attributes
        if ($beforeLength -lt 0 -or $beforeLength -gt $effectiveSingleFileBytes) { Stop-Manifest 'file_too_large' }

        # FileShare.Read prevents a writer/deleter from being introduced while this
        # handle is open. The surrounding metadata checks detect ordinary mutation.
        $stream = [IO.File]::Open($before.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        if ([long]$stream.Length -ne $beforeLength) { Stop-Manifest 'unstable_snapshot' }
        $sha = [Security.Cryptography.SHA256]::Create()
        $buffer = New-Object byte[] $streamBufferBytes
        $bytesRead = [long]0
        while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            Assert-WithinTimeBudget
            if ($bytesRead -gt ([long]::MaxValue - [long]$read)) { Stop-Manifest 'size_overflow' }
            $bytesRead += [long]$read
            if ($bytesRead -gt $effectiveSingleFileBytes) { Stop-Manifest 'file_too_large' }
            [void]$sha.TransformBlock($buffer, 0, $read, $buffer, 0)
        }
        [void]$sha.TransformFinalBlock($buffer, 0, 0)
        if ($bytesRead -ne $beforeLength -or [long]$stream.Length -ne $beforeLength) { Stop-Manifest 'unstable_snapshot' }

        $after = New-Object IO.FileInfo($before.FullName)
        $after.Refresh()
        if (-not $after.Exists -or (Test-IsReparsePoint $after)) { Stop-Manifest 'unstable_snapshot' }
        if ([long]$after.Length -ne $beforeLength -or
            [long]$after.LastWriteTimeUtc.Ticks -ne $beforeWriteTicks -or
            [IO.FileAttributes]$after.Attributes -ne $beforeAttributes) { Stop-Manifest 'unstable_snapshot' }

        return [pscustomobject]@{
            Size = $beforeLength
            Sha256 = [BitConverter]::ToString($sha.Hash).Replace('-', '').ToLowerInvariant()
        }
    }
    catch {
        if ([string]$_.Exception.Message -like ($failurePrefix + '*')) { throw }
        Stop-Manifest 'unstable_snapshot'
    }
    finally {
        if ($null -ne $sha) { $sha.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Get-ArtifactObservation {
    param([Parameter(Mandatory = $true)][string]$Root)

    $effectiveFileCount = Get-EffectiveLimit $maximumFileCount 'KEYATLAS_RELEASE_MANIFEST_TEST_MAX_FILES'
    $effectiveTotalEntries = Get-EffectiveLimit $maximumTotalEntries 'KEYATLAS_RELEASE_MANIFEST_TEST_MAX_ENTRIES'
    $effectiveDirectoryCount = Get-EffectiveLimit $maximumDirectoryCount 'KEYATLAS_RELEASE_MANIFEST_TEST_MAX_DIRECTORIES'
    $effectivePathCharacters = Get-EffectiveLimit $maximumRelativePathCharacters 'KEYATLAS_RELEASE_MANIFEST_TEST_MAX_PATH_CHARS'
    $effectiveAggregateBytes = Get-EffectiveLimit $maximumAggregateFileBytes 'KEYATLAS_RELEASE_MANIFEST_TEST_MAX_AGGREGATE_BYTES'

    try {
        Assert-WithinTimeBudget
        $rootInfo = New-Object IO.DirectoryInfo([IO.Path]::GetFullPath($Root))
        $rootInfo.Refresh()
        if (-not $rootInfo.Exists) { Stop-Manifest 'root_not_directory' }
        Assert-SafeDirectoryChain -Path $rootInfo.FullName -MissingReason 'root_not_directory'
        if (Test-IsReparsePoint $rootInfo) { Stop-Manifest 'reparse_point' }
        $rootPrefix = Get-FullDirectoryPrefix $rootInfo.FullName
        $entries = New-Object 'System.Collections.Generic.List[object]'
        $stack = New-Object 'System.Collections.Generic.Stack[object]'
        $stack.Push([pscustomobject]@{ Directory = $rootInfo; Depth = 0 })
        $directoryCount = [long]1
        $totalEntryCount = [long]1
        $aggregateBytes = [long]0

        while ($stack.Count -gt 0) {
            Assert-WithinTimeBudget
            $frame = $stack.Pop()
            if ([int]$frame.Depth -gt $maximumDepth) { Stop-Manifest 'too_deep' }
            $frame.Directory.Refresh()
            if (-not $frame.Directory.Exists) { Stop-Manifest 'unstable_snapshot' }
            if (Test-IsReparsePoint $frame.Directory) { Stop-Manifest 'reparse_point' }
            foreach ($item in $frame.Directory.EnumerateFileSystemInfos()) {
                Assert-WithinTimeBudget
                if ($totalEntryCount -ge $effectiveTotalEntries) { Stop-Manifest 'too_many_entries' }
                $totalEntryCount++
                $item.Refresh()
                if (-not $item.Exists) { Stop-Manifest 'unstable_snapshot' }
                if (Test-IsReparsePoint $item) { Stop-Manifest 'reparse_point' }
                if ($item -is [IO.DirectoryInfo]) {
                    if ($directoryCount -ge $effectiveDirectoryCount) { Stop-Manifest 'too_many_directories' }
                    $directoryCount++
                    $childDepth = [int]$frame.Depth + 1
                    if ($childDepth -gt $maximumDepth) { Stop-Manifest 'too_deep' }
                    $stack.Push([pscustomobject]@{ Directory = $item; Depth = $childDepth })
                    continue
                }
                if ($item -isnot [IO.FileInfo]) { Stop-Manifest 'unsupported_entry' }
                if ($entries.Count -ge $effectiveFileCount) { Stop-Manifest 'too_many_files' }
                $full = [IO.Path]::GetFullPath($item.FullName)
                if (-not $full.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { Stop-Manifest 'path_escape' }
                if (Test-IsForbiddenName $item.Name) { Stop-Manifest 'forbidden_file' }
                $relative = $full.Substring($rootPrefix.Length).Replace('\', '/')
                if ($relative.Length -gt $effectivePathCharacters -or $relative -cnotmatch $allowedPathPattern) { Stop-Manifest 'unsupported_path' }
                $snapshot = Get-FileSnapshot -FullPath $full
                if ($snapshot.Size -gt $effectiveAggregateBytes -or
                    $aggregateBytes -gt ($effectiveAggregateBytes - $snapshot.Size)) { Stop-Manifest 'aggregate_too_large' }
                $aggregateBytes += [long]$snapshot.Size
                $entries.Add([pscustomobject]@{ Path = $relative; Size = [long]$snapshot.Size; Sha256 = [string]$snapshot.Sha256 })
            }
        }

        $rootInfo.Refresh()
        if (-not $rootInfo.Exists -or (Test-IsReparsePoint $rootInfo)) { Stop-Manifest 'unstable_snapshot' }
        if ($entries.Count -eq 0) { Stop-Manifest 'empty_root' }
        $seenExact = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
        $seenCaseFolded = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in $entries) {
            if (-not $seenExact.Add($entry.Path)) { Stop-Manifest 'duplicate_path' }
            if (-not $seenCaseFolded.Add($entry.Path)) { Stop-Manifest 'case_collision' }
        }
        $sorted = New-Object 'System.Collections.Generic.List[object]'
        $sorted.AddRange($entries)
        $sorted.Sort([Comparison[object]] { param($a, $b) [string]::CompareOrdinal($a.Path, $b.Path) })
        return ,$sorted
    }
    catch {
        if ([string]$_.Exception.Message -like ($failurePrefix + '*')) { throw }
        Stop-Manifest 'unstable_snapshot'
    }
}

function ConvertTo-ManifestText {
    param([Parameter(Mandatory = $true)]$Entries)
    $builder = New-Object Text.StringBuilder
    [void]$builder.Append("{`n")
    [void]$builder.Append("  `"schema`": `"$manifestSchema`",`n")
    [void]$builder.Append("  `"algorithm`": `"sha256`",`n")
    [void]$builder.Append("  `"fileCount`": $($Entries.Count),`n")
    [void]$builder.Append("  `"files`": [`n")
    for ($index = 0; $index -lt $Entries.Count; $index++) {
        $entry = $Entries[$index]
        $separator = if ($index -lt ($Entries.Count - 1)) { ',' } else { '' }
        [void]$builder.Append("    { `"path`": `"$($entry.Path)`", `"size`": $($entry.Size), `"sha256`": `"$($entry.Sha256)`" }$separator`n")
    }
    [void]$builder.Append("  ]`n}`n")
    return $builder.ToString()
}

function Get-StableArtifactEntries {
    param([Parameter(Mandatory = $true)][string]$Root)
    $first = Get-ArtifactObservation -Root $Root
    $firstCanonical = ConvertTo-ManifestText -Entries $first
    $pause = Get-TestDelayMilliseconds 'KEYATLAS_RELEASE_MANIFEST_TEST_PAUSE_BETWEEN_OBSERVATIONS_MS'
    if ($pause -gt 0) { Start-Sleep -Milliseconds $pause }
    Assert-WithinTimeBudget
    $second = Get-ArtifactObservation -Root $Root
    $secondCanonical = ConvertTo-ManifestText -Entries $second
    if (-not [string]::Equals($firstCanonical, $secondCanonical, [StringComparison]::Ordinal)) { Stop-Manifest 'unstable_snapshot' }
    return ,$second
}

function Test-IsCanonicalInteger {
    param($Value)
    return (($Value -is [int]) -or ($Value -is [long]))
}

function Assert-ExactProperties {
    param(
        [Parameter(Mandatory = $true)]$Object,
        [Parameter(Mandatory = $true)][string[]]$Expected
    )
    if ($null -eq $Object -or $Object -is [System.Array]) { Stop-Manifest 'invalid_manifest' }
    $actual = @($Object.PSObject.Properties | ForEach-Object { $_.Name })
    if ($actual.Count -ne $Expected.Count -or (($actual -join [char]31) -cne ($Expected -join [char]31))) { Stop-Manifest 'invalid_manifest' }
}

function Read-BoundedManifestText {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = $null
    $memory = $null
    try {
        Assert-WithinTimeBudget
        $full = [IO.Path]::GetFullPath($Path)
        $parent = [IO.Path]::GetDirectoryName($full)
        if ([string]::IsNullOrWhiteSpace($parent)) { Stop-Manifest 'manifest_missing' }
        Assert-SafeDirectoryChain -Path $parent -MissingReason 'manifest_missing'
        $before = New-Object IO.FileInfo($full)
        $before.Refresh()
        if (-not $before.Exists) { Stop-Manifest 'manifest_missing' }
        if (Test-IsReparsePoint $before) { Stop-Manifest 'reparse_point' }
        $beforeLength = [long]$before.Length
        $beforeWriteTicks = [long]$before.LastWriteTimeUtc.Ticks
        $beforeAttributes = [IO.FileAttributes]$before.Attributes
        if ($beforeLength -lt 0 -or $beforeLength -gt $maximumManifestBytes) { Stop-Manifest 'invalid_manifest' }
        $stream = [IO.File]::Open($full, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        if ([long]$stream.Length -ne $beforeLength) { Stop-Manifest 'invalid_manifest' }
        $memory = New-Object IO.MemoryStream
        $buffer = New-Object byte[] $streamBufferBytes
        $total = [long]0
        while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            Assert-WithinTimeBudget
            if ($total -gt ([long]::MaxValue - [long]$read)) { Stop-Manifest 'invalid_manifest' }
            $total += [long]$read
            if ($total -gt $maximumManifestBytes) { Stop-Manifest 'invalid_manifest' }
            $memory.Write($buffer, 0, $read)
        }
        if ($total -ne $beforeLength -or [long]$stream.Length -ne $beforeLength) { Stop-Manifest 'invalid_manifest' }
        $after = New-Object IO.FileInfo($full)
        $after.Refresh()
        if (-not $after.Exists -or (Test-IsReparsePoint $after) -or
            [long]$after.Length -ne $beforeLength -or [long]$after.LastWriteTimeUtc.Ticks -ne $beforeWriteTicks -or
            [IO.FileAttributes]$after.Attributes -ne $beforeAttributes) { Stop-Manifest 'invalid_manifest' }
        Assert-SafeDirectoryChain -Path $parent -MissingReason 'manifest_missing'
        $bytes = $memory.ToArray()
        if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { Stop-Manifest 'invalid_manifest' }
        if ([Array]::IndexOf($bytes, [byte]13) -ge 0) { Stop-Manifest 'invalid_manifest' }
        try { return $strictUtf8.GetString($bytes) }
        catch { Stop-Manifest 'invalid_manifest' }
    }
    catch {
        if ([string]$_.Exception.Message -like ($failurePrefix + '*')) { throw }
        Stop-Manifest 'invalid_manifest'
    }
    finally {
        if ($null -ne $memory) { $memory.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Read-ManifestEntries {
    param([Parameter(Mandatory = $true)][string]$Path)
    $rawText = Read-BoundedManifestText -Path $Path
    try { $parsed = $rawText | ConvertFrom-Json }
    catch { Stop-Manifest 'invalid_manifest' }
    Assert-ExactProperties -Object $parsed -Expected @('schema', 'algorithm', 'fileCount', 'files')
    if ($parsed.schema -isnot [string] -or $parsed.schema -cne $manifestSchema -or
        $parsed.algorithm -isnot [string] -or $parsed.algorithm -cne 'sha256' -or
        -not (Test-IsCanonicalInteger $parsed.fileCount) -or [long]$parsed.fileCount -lt 1 -or
        [long]$parsed.fileCount -gt $maximumFileCount -or $parsed.files -isnot [System.Array]) { Stop-Manifest 'invalid_manifest' }
    $files = @($parsed.files)
    if ($files.Count -ne [long]$parsed.fileCount) { Stop-Manifest 'invalid_manifest' }
    $entries = New-Object 'System.Collections.Generic.List[object]'
    $map = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([StringComparer]::Ordinal)
    $seenCaseFolded = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $aggregateBytes = [long]0
    $previousPath = $null
    foreach ($file in $files) {
        Assert-ExactProperties -Object $file -Expected @('path', 'size', 'sha256')
        if ($file.path -isnot [string] -or $file.sha256 -isnot [string] -or -not (Test-IsCanonicalInteger $file.size)) { Stop-Manifest 'invalid_manifest' }
        $path = [string]$file.path
        $size = [long]$file.size
        $hash = [string]$file.sha256
        if ($path.Length -gt $maximumRelativePathCharacters -or $path -cnotmatch $allowedPathPattern -or
            $hash -cnotmatch $sha256Pattern -or $size -lt 0 -or $size -gt $maximumSingleFileBytes -or
            (Test-IsForbiddenName (($path -split '/')[-1]))) { Stop-Manifest 'invalid_manifest' }
        if ($null -ne $previousPath -and [string]::CompareOrdinal($previousPath, $path) -ge 0) { Stop-Manifest 'invalid_manifest' }
        if ($map.ContainsKey($path) -or -not $seenCaseFolded.Add($path)) { Stop-Manifest 'invalid_manifest' }
        if ($size -gt $maximumAggregateFileBytes -or $aggregateBytes -gt ($maximumAggregateFileBytes - $size)) { Stop-Manifest 'invalid_manifest' }
        $aggregateBytes += $size
        $entry = [pscustomobject]@{ Path = $path; Size = $size; Sha256 = $hash }
        $entries.Add($entry)
        $map.Add($path, $entry)
        $previousPath = $path
    }
    # Exact canonical text rejects BOM/CRLF/trailing bytes, alternate number
    # spellings, reordered/extra keys, and duplicate keys normalized by PS 5.1.
    $canonical = ConvertTo-ManifestText -Entries $entries
    if (-not [string]::Equals($rawText, $canonical, [StringComparison]::Ordinal)) { Stop-Manifest 'invalid_manifest' }
    return [pscustomobject]@{ Entries = $entries; Map = $map }
}

function Assert-ExactFileBytes {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][byte[]]$ExpectedBytes,
        [Parameter(Mandatory = $true)][string]$FailureReason
    )
    $stream = $null
    try {
        $info = New-Object IO.FileInfo([IO.Path]::GetFullPath($Path))
        $info.Refresh()
        if (-not $info.Exists -or (Test-IsReparsePoint $info) -or [long]$info.Length -ne [long]$ExpectedBytes.Length) {
            Stop-Manifest $FailureReason
        }

        # FileShare.Read denies ordinary writers, deletes, and renames while the
        # exact bytes are compared through this one bounded read handle.
        $stream = New-Object IO.FileStream($info.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read, $streamBufferBytes)
        if ([long]$stream.Length -ne [long]$ExpectedBytes.Length) { Stop-Manifest $FailureReason }
        $buffer = New-Object byte[] $streamBufferBytes
        $offset = 0
        while ($offset -lt $ExpectedBytes.Length) {
            Assert-WithinTimeBudget
            $wanted = [Math]::Min($buffer.Length, $ExpectedBytes.Length - $offset)
            $read = $stream.Read($buffer, 0, $wanted)
            if ($read -le 0) { Stop-Manifest $FailureReason }
            for ($index = 0; $index -lt $read; $index++) {
                if ($buffer[$index] -ne $ExpectedBytes[$offset + $index]) { Stop-Manifest $FailureReason }
            }
            $offset += $read
        }
        if ($stream.ReadByte() -ne -1) { Stop-Manifest $FailureReason }
    }
    catch {
        if ([string]$_.Exception.Message -like ($failurePrefix + '*')) { throw }
        Stop-Manifest $FailureReason
    }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
}

function Write-ManifestAtomically {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Text
    )
    $outputFull = [IO.Path]::GetFullPath($Path)
    $parent = [IO.Path]::GetDirectoryName($outputFull)
    if ([string]::IsNullOrWhiteSpace($parent)) { Stop-Manifest 'output_parent_missing' }
    Assert-SafeDirectoryChain -Path $parent -MissingReason 'output_parent_missing'
    $bytes = $outputUtf8.GetBytes($Text)
    if ([IO.File]::Exists($outputFull) -or [IO.Directory]::Exists($outputFull)) { Stop-Manifest 'output_exists' }
    $temporaryPath = $null
    $temporaryCreated = $false
    $stream = $null
    try {
        for ($attempt = 0; $attempt -lt 16 -and -not $temporaryCreated; $attempt++) {
            $temporaryPath = Join-Path $parent ('.keyatlas-manifest-' + [Guid]::NewGuid().ToString('N') + '.tmp')
            try {
                $stream = New-Object IO.FileStream($temporaryPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                $temporaryCreated = $true
            }
            catch [IO.IOException] { $stream = $null }
        }
        if (-not $temporaryCreated -or $null -eq $stream) { Stop-Manifest 'output_temp_unavailable' }
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        Assert-SafeDirectoryChain -Path $parent -MissingReason 'output_parent_missing'
        $pause = Get-TestDelayMilliseconds 'KEYATLAS_RELEASE_MANIFEST_TEST_PAUSE_BEFORE_MOVE_MS'
        if ($pause -gt 0) { Start-Sleep -Milliseconds $pause }
        Assert-WithinTimeBudget
        Assert-SafeDirectoryChain -Path $parent -MissingReason 'output_parent_missing'
        Assert-ExactFileBytes -Path $temporaryPath -ExpectedBytes $bytes -FailureReason 'unstable_output'
        try {
            # File.Move is non-overwriting on Windows/.NET Framework; a competitor
            # that creates the destination first wins and its bytes remain untouched.
            [IO.File]::Move($temporaryPath, $outputFull)
        }
        catch [IO.IOException] { Stop-Manifest 'output_exists' }
        $temporaryCreated = $false
        Assert-SafeDirectoryChain -Path $parent -MissingReason 'output_parent_missing'
        Assert-ExactFileBytes -Path $outputFull -ExpectedBytes $bytes -FailureReason 'unstable_output'
        # Managed PS 5.1 lacks openat-style rename bound to a directory handle.
        # These pre/post checks catch ordinary races, not a hostile atomic FS swap.
    }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
        # On failure, a remaining private temp is deliberately preserved. Managed
        # PS 5.1 cannot delete a pathname while proving it is still the file this
        # process created; guessing by path or length can delete an attacker swap.
    }
}

try {
    if ($PSBoundParameters.ContainsKey('OutputPath') -and $PSBoundParameters.ContainsKey('VerifyManifest')) { Stop-Manifest 'conflicting_modes' }
    $artifactRootFull = [IO.Path]::GetFullPath($ArtifactRoot)
    if ($PSBoundParameters.ContainsKey('OutputPath')) {
        $outputFull = [IO.Path]::GetFullPath($OutputPath)
        if (Test-IsInsideRoot -Candidate $outputFull -Root $artifactRootFull) { Stop-Manifest 'output_inside_root' }
    }
    if ($PSBoundParameters.ContainsKey('VerifyManifest')) {
        $verifyFull = [IO.Path]::GetFullPath($VerifyManifest)
        if (Test-IsInsideRoot -Candidate $verifyFull -Root $artifactRootFull) { Stop-Manifest 'manifest_inside_root' }
    }
    if ($PSBoundParameters.ContainsKey('VerifyManifest')) {
        $expected = Read-ManifestEntries -Path $verifyFull
        $actual = Get-StableArtifactEntries -Root $artifactRootFull
        $actualPaths = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
        foreach ($entry in $actual) { [void]$actualPaths.Add($entry.Path) }
        foreach ($path in $expected.Map.Keys) { if (-not $actualPaths.Contains($path)) { Stop-Manifest 'missing_file' } }
        foreach ($entry in $actual) {
            if (-not $expected.Map.ContainsKey($entry.Path)) { Stop-Manifest 'unexpected_file' }
            $want = $expected.Map[$entry.Path]
            if ([long]$want.Size -ne [long]$entry.Size -or [string]$want.Sha256 -cne [string]$entry.Sha256) { Stop-Manifest 'hash_mismatch' }
        }
        Write-Output "RELEASE_MANIFEST_VERIFIED files=$($actual.Count)"
        $exitCode = 0
    }
    else {
        $entries = Get-StableArtifactEntries -Root $artifactRootFull
        $text = ConvertTo-ManifestText -Entries $entries
        if ($PSBoundParameters.ContainsKey('OutputPath')) {
            Write-ManifestAtomically -Path $outputFull -Text $text
            Write-Output "RELEASE_MANIFEST_CREATED files=$($entries.Count)"
        }
        else { [Console]::Out.Write($text) }
        $exitCode = 0
    }
}
catch {
    $message = [string]$_.Exception.Message
    if ($message.StartsWith($failurePrefix, [StringComparison]::Ordinal)) {
        Write-Output ('RELEASE_MANIFEST_FAILED ' + $message.Substring($failurePrefix.Length))
    }
    else { Write-Output 'RELEASE_MANIFEST_FAILED setup_or_execution' }
    $exitCode = 1
}
finally { $operationTimer.Stop() }

exit $exitCode
