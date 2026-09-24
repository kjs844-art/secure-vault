#requires -Version 5.1
[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory = $true)][string]$ArtifactRoot,
    [string]$OutputPath,
    [string]$VerifyManifest
)

# 로컬 release artifact 디렉터리의 SHA256 manifest를 만들거나 검증한다.
# 업로드·서명·배포는 하지 않으며, 출력에는 절대 경로를 남기지 않는다.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$exitCode = 1

# 고정 한도는 결과를 결정적으로 만들고 조작된 트리가 무한 순회를 만들지 못하게 한다.
$manifestSchema = 'keyatlas.release-artifact-manifest.v1'
$maximumFileCount = 10000
$maximumDepth = 32
$maximumRelativePathCharacters = 512
$maximumManifestBytes = 8MB
$failurePrefix = 'RELEASE_MANIFEST_REASON:'
$allowedPathPattern = '^[A-Za-z0-9_][A-Za-z0-9._-]*(/[A-Za-z0-9_][A-Za-z0-9._-]*)*$'
$sha256Pattern = '^[0-9a-f]{64}$'
# 서명 키·환경 파일이 release 묶음에 섞이는 사고를 manifest 단계에서 막는다.
$forbiddenNamePatterns = @(
    '^\.env($|\.)', '\.pem$', '\.key$', '\.p12$', '\.pfx$', '\.jks$', '\.keystore$',
    '^local\.properties$', '^google-services\.json$', 'service-account.*\.json$'
)

function Stop-Manifest {
    param([Parameter(Mandatory = $true)][string]$Reason)
    throw ($failurePrefix + $Reason)
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

function Get-ArtifactEntries {
    param([Parameter(Mandatory = $true)][string]$Root)

    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { Stop-Manifest 'root_not_directory' }
    $rootInfo = New-Object IO.DirectoryInfo([IO.Path]::GetFullPath($Root))
    if (Test-IsReparsePoint $rootInfo) { Stop-Manifest 'reparse_point' }
    $rootPrefix = Get-FullDirectoryPrefix $rootInfo.FullName

    $entries = New-Object 'System.Collections.Generic.List[object]'
    $stack = New-Object 'System.Collections.Generic.Stack[object]'
    $stack.Push([pscustomobject]@{ Directory = $rootInfo; Depth = 0 })

    while ($stack.Count -gt 0) {
        $frame = $stack.Pop()
        if ($frame.Depth -gt $maximumDepth) { Stop-Manifest 'too_deep' }
        foreach ($item in $frame.Directory.GetFileSystemInfos()) {
            # junction·symlink은 따라가지 않고 즉시 실패시킨다.
            if (Test-IsReparsePoint $item) { Stop-Manifest 'reparse_point' }
            if ($item -is [IO.DirectoryInfo]) {
                $stack.Push([pscustomobject]@{ Directory = $item; Depth = $frame.Depth + 1 })
                continue
            }

            $full = [IO.Path]::GetFullPath($item.FullName)
            if (-not $full.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                Stop-Manifest 'path_escape'
            }
            # 금지 이름을 먼저 검사해 '.env'처럼 allowlist에도 어긋나는 이름이 더 구체적인 사유로 보고되게 한다.
            foreach ($pattern in $forbiddenNamePatterns) {
                if ($item.Name -match $pattern) { Stop-Manifest 'forbidden_file' }
            }
            $relative = $full.Substring($rootPrefix.Length).Replace('\', '/')
            if (($relative.Length -gt $maximumRelativePathCharacters) -or
                ($relative -cnotmatch $allowedPathPattern)) {
                Stop-Manifest 'unsupported_path'
            }

            $entries.Add([pscustomobject]@{
                Path = $relative
                Size = [long]$item.Length
                Sha256 = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant()
            })
            if ($entries.Count -gt $maximumFileCount) { Stop-Manifest 'too_many_files' }
        }
    }

    if ($entries.Count -eq 0) { Stop-Manifest 'empty_root' }

    # 대소문자만 다른 경로는 다른 OS에서 서로 덮어쓰므로 거부한다.
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $entries) {
        if (-not $seen.Add($entry.Path)) { Stop-Manifest 'case_collision' }
    }

    $sorted = New-Object 'System.Collections.Generic.List[object]'
    $sorted.AddRange($entries)
    $sorted.Sort([Comparison[object]] { param($a, $b) [string]::CompareOrdinal($a.Path, $b.Path) })
    return , $sorted
}

function ConvertTo-ManifestText {
    param([Parameter(Mandatory = $true)]$Entries)

    # PowerShell 5.1과 7의 ConvertTo-Json 출력 차이를 피하려고 직접 직렬화한다.
    # 경로는 allowlist 문자만 허용하므로 JSON escape가 필요 없다.
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

function Read-ManifestEntries {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Stop-Manifest 'manifest_missing' }
    $info = New-Object IO.FileInfo([IO.Path]::GetFullPath($Path))
    if (Test-IsReparsePoint $info) { Stop-Manifest 'reparse_point' }
    if ($info.Length -gt $maximumManifestBytes) { Stop-Manifest 'invalid_manifest' }

    try {
        $parsed = [IO.File]::ReadAllText($info.FullName, (New-Object Text.UTF8Encoding($false, $true))) | ConvertFrom-Json
    }
    catch {
        Stop-Manifest 'invalid_manifest'
    }

    $names = @($parsed.PSObject.Properties | ForEach-Object { $_.Name })
    foreach ($required in @('schema', 'algorithm', 'fileCount', 'files')) {
        if ($names -notcontains $required) { Stop-Manifest 'invalid_manifest' }
    }
    if (($parsed.schema -cne $manifestSchema) -or ($parsed.algorithm -cne 'sha256')) {
        Stop-Manifest 'invalid_manifest'
    }

    $files = @($parsed.files)
    if (($files.Count -eq 0) -or ($files.Count -gt $maximumFileCount) -or ([long]$parsed.fileCount -ne $files.Count)) {
        Stop-Manifest 'invalid_manifest'
    }

    $result = @{}
    foreach ($file in $files) {
        $path = [string]$file.path
        $hash = [string]$file.sha256
        if (($path -cnotmatch $allowedPathPattern) -or ($hash -cnotmatch $sha256Pattern) -or
            ($null -eq $file.size) -or ([long]$file.size -lt 0) -or $result.ContainsKey($path)) {
            Stop-Manifest 'invalid_manifest'
        }
        $result[$path] = [pscustomobject]@{ Size = [long]$file.size; Sha256 = $hash }
    }
    return $result
}

try {
    if ($PSBoundParameters.ContainsKey('OutputPath') -and $PSBoundParameters.ContainsKey('VerifyManifest')) {
        Stop-Manifest 'conflicting_modes'
    }

    if ($PSBoundParameters.ContainsKey('VerifyManifest')) {
        $expected = Read-ManifestEntries -Path $VerifyManifest
        $actual = Get-ArtifactEntries -Root $ArtifactRoot
        $actualPaths = @{}
        foreach ($entry in $actual) { $actualPaths[$entry.Path] = $true }
        foreach ($path in $expected.Keys) {
            if (-not $actualPaths.ContainsKey($path)) { Stop-Manifest 'missing_file' }
        }
        foreach ($entry in $actual) {
            if (-not $expected.ContainsKey($entry.Path)) { Stop-Manifest 'unexpected_file' }
            $want = $expected[$entry.Path]
            if (($want.Size -ne $entry.Size) -or ($want.Sha256 -cne $entry.Sha256)) { Stop-Manifest 'hash_mismatch' }
        }
        Write-Output "RELEASE_MANIFEST_VERIFIED files=$($actual.Count)"
        $exitCode = 0
    }
    else {
        $entries = Get-ArtifactEntries -Root $ArtifactRoot
        $text = ConvertTo-ManifestText -Entries $entries
        if ($PSBoundParameters.ContainsKey('OutputPath')) {
            $outputFull = [IO.Path]::GetFullPath($OutputPath)
            $rootPrefix = Get-FullDirectoryPrefix $ArtifactRoot
            # manifest가 자기 자신을 artifact로 포함하거나 기존 파일을 덮어쓰지 않게 한다.
            if ($outputFull.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { Stop-Manifest 'output_inside_root' }
            if (Test-Path -LiteralPath $outputFull) { Stop-Manifest 'output_exists' }
            $outputParent = [IO.Path]::GetDirectoryName($outputFull)
            if (-not (Test-Path -LiteralPath $outputParent -PathType Container)) { Stop-Manifest 'output_parent_missing' }
            [IO.File]::WriteAllText($outputFull, $text, (New-Object Text.UTF8Encoding($false)))
            Write-Output "RELEASE_MANIFEST_CREATED files=$($entries.Count)"
        }
        else {
            [Console]::Out.Write($text)
        }
        $exitCode = 0
    }
}
catch {
    $message = [string]$_.Exception.Message
    if ($message.StartsWith($failurePrefix, [StringComparison]::Ordinal)) {
        Write-Output ('RELEASE_MANIFEST_FAILED ' + $message.Substring($failurePrefix.Length))
    }
    else {
        # 예상하지 못한 예외 메시지에는 절대 경로가 담길 수 있어 그대로 출력하지 않는다.
        Write-Output 'RELEASE_MANIFEST_FAILED setup_or_execution'
    }
    $exitCode = 1
}

exit $exitCode
