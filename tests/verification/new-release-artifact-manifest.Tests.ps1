#requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$tool = Join-Path $repositoryRoot 'scripts\new-release-artifact-manifest.ps1'
$engine = (Get-Process -Id $PID).Path
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("keyatlas-release-manifest-$([Guid]::NewGuid().ToString('N'))")
$utf8 = New-Object Text.UTF8Encoding($false)
$passed = 0

$abcSha256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
$allByteValuesSha256 = '40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880'

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Invoke-Tool {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& $engine -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $tool @Arguments 2>&1)
        $code = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $savedPreference }
    [pscustomobject]@{ Code = $code; Text = ($lines -join "`n") }
}

function New-ArtifactTree {
    param([Parameter(Mandatory = $true)][string]$Name)
    $root = Join-Path $temporaryRoot $Name
    New-Item -ItemType Directory -Path (Join-Path $root 'web\assets') -Force -ErrorAction Stop | Out-Null
    [IO.File]::WriteAllText((Join-Path $root 'web\index.html'), 'abc', $utf8)
    [IO.File]::WriteAllText((Join-Path $root 'web\assets\app.js'), 'synthetic bundle', $utf8)
    [IO.File]::WriteAllText((Join-Path $root 'NOTICE.txt'), 'synthetic notice', $utf8)
    return $root
}

function Assert-Failure {
    param(
        [Parameter(Mandatory = $true)]$Result,
        [Parameter(Mandatory = $true)][string]$Reason,
        [Parameter(Mandatory = $true)][string]$Name
    )
    Assert-Condition ($Result.Code -eq 1) "$Name must fail closed. Output: $($Result.Text)"
    Assert-Condition ($Result.Text.Contains("RELEASE_MANIFEST_FAILED $Reason")) "$Name needs reason $Reason but got: $($Result.Text)"
    Assert-Condition (-not $Result.Text.Contains('RELEASE_MANIFEST_CREATED')) "$Name must not emit a creation marker."
    Assert-Condition (-not $Result.Text.Contains('RELEASE_MANIFEST_VERIFIED')) "$Name must not emit a verification marker."
    Assert-Condition (-not $Result.Text.Contains($temporaryRoot)) "$Name must not disclose an absolute fixture path."
}

function New-TestJunction {
    param([string]$Path, [string]$Target)
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $null = & $env:ComSpec /d /c mklink /J $Path $Target 2>&1
        $code = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $savedPreference }
    if ($code -ne 0) { throw 'The reparse-point test fixture could not be created.' }
}

function Use-ReducedTestPolicy {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Values,
        [Parameter(Mandatory = $true)][scriptblock]$Body
    )
    $allValues = @{'KEYATLAS_RELEASE_MANIFEST_TEST_MODE' = 'reduce-only-v1'}
    foreach ($key in $Values.Keys) { $allValues[$key] = [string]$Values[$key] }
    $saved = @{}
    foreach ($key in $allValues.Keys) {
        $saved[$key] = [Environment]::GetEnvironmentVariable($key)
        [Environment]::SetEnvironmentVariable($key, $allValues[$key])
    }
    try { & $Body }
    finally {
        foreach ($key in $allValues.Keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key]) }
    }
}

function Wait-TestJob {
    param([Parameter(Mandatory = $true)]$Job)
    try {
        $completed = Wait-Job -Job $Job -Timeout 10
        if ($null -eq $completed -or $Job.State -notin @('Completed', 'Failed')) {
            throw "A synthetic concurrency job did not finish: $($Job.State)"
        }
        if ($Job.State -eq 'Failed') {
            $details = Receive-Job -Job $Job -ErrorAction Continue | Out-String
            throw "A synthetic concurrency job failed: $details"
        }
    }
    finally { Remove-Job -Job $Job -Force -ErrorAction SilentlyContinue }
}

function Assert-InvalidManifestText {
    param(
        [Parameter(Mandatory = $true)][string]$ArtifactRoot,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Text
    )
    $path = Join-Path $temporaryRoot ("invalid-$Name.json")
    [IO.File]::WriteAllText($path, $Text, $utf8)
    Assert-Failure (Invoke-Tool @('-ArtifactRoot', $ArtifactRoot, '-VerifyManifest', $path)) 'invalid_manifest' $Name
}

function Remove-TestTreeSafely {
    param([Parameter(Mandatory = $true)][string]$Root)
    if (-not (Test-Path -LiteralPath $Root)) { return }
    $stack = New-Object 'System.Collections.Generic.Stack[IO.DirectoryInfo]'
    $stack.Push((New-Object IO.DirectoryInfo($Root)))
    while ($stack.Count -gt 0) {
        $directory = $stack.Pop()
        foreach ($item in $directory.GetFileSystemInfos()) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                if ($item -is [IO.DirectoryInfo]) { [IO.Directory]::Delete($item.FullName) }
                else { [IO.File]::Delete($item.FullName) }
            }
            elseif ($item -is [IO.DirectoryInfo]) { $stack.Push($item) }
        }
    }
    Remove-Item -LiteralPath $Root -Recurse -Force
}

try {
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw 'The release artifact manifest tool is missing.' }
    New-Item -ItemType Directory -Path $temporaryRoot -ErrorAction Stop | Out-Null

    # 1. Deterministic sorting and two known binary vectors, including NUL, FF,
    # 80, CR, and LF as members of the complete 00..FF sequence.
    $root = New-ArtifactTree 'deterministic'
    [byte[]]$allByteValues = 0..255
    [IO.File]::WriteAllBytes((Join-Path $root 'all-bytes.bin'), $allByteValues)
    $first = Invoke-Tool @('-ArtifactRoot', $root)
    $second = Invoke-Tool @('-ArtifactRoot', $root)
    Assert-Condition ($first.Code -eq 0) "Manifest creation must pass: $($first.Text)"
    Assert-Condition ($first.Text -ceq $second.Text) 'Two runs over the same tree must be byte-identical.'
    $parsed = $first.Text | ConvertFrom-Json
    Assert-Condition ($parsed.schema -ceq 'keyatlas.release-artifact-manifest.v1') 'The schema identifier is wrong.'
    Assert-Condition ($parsed.algorithm -ceq 'sha256') 'The algorithm must be sha256.'
    Assert-Condition ($parsed.fileCount -eq 4) 'The file count is wrong.'
    $paths = @($parsed.files | ForEach-Object { $_.path })
    Assert-Condition (($paths -join '|') -ceq 'NOTICE.txt|all-bytes.bin|web/assets/app.js|web/index.html') "Paths are not ordinal sorted: $($paths -join '|')"
    $index = @($parsed.files | Where-Object { $_.path -ceq 'web/index.html' })[0]
    $binary = @($parsed.files | Where-Object { $_.path -ceq 'all-bytes.bin' })[0]
    Assert-Condition ($index.sha256 -ceq $abcSha256 -and $index.size -eq 3) 'The abc vector is wrong.'
    Assert-Condition ($binary.sha256 -ceq $allByteValuesSha256 -and $binary.size -eq 256) 'The 00..FF binary vector is wrong.'
    Assert-Condition (-not $first.Text.Contains($temporaryRoot)) 'The manifest must not contain absolute paths.'
    $passed++
    Write-Output 'PASS: deterministic two-pass manifest and known binary vectors'

    # 2. Same-parent output is canonical UTF-8/LF and verifies.
    $manifest = Join-Path $temporaryRoot 'deterministic.manifest.json'
    $created = Invoke-Tool @('-ArtifactRoot', $root, '-OutputPath', $manifest)
    Assert-Condition ($created.Code -eq 0) "Writing the manifest must pass: $($created.Text)"
    $bytes = [IO.File]::ReadAllBytes($manifest)
    Assert-Condition (-not ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)) 'The manifest must not start with a BOM.'
    Assert-Condition ([Array]::IndexOf($bytes, [byte]13) -lt 0) 'The manifest must use LF only.'
    $verified = Invoke-Tool @('-ArtifactRoot', $root, '-VerifyManifest', $manifest)
    Assert-Condition ($verified.Code -eq 0) "Verification must pass: $($verified.Text)"
    Assert-Condition ($verified.Text.Contains('RELEASE_MANIFEST_VERIFIED files=4')) 'Verification marker is missing.'
    $passed++
    Write-Output 'PASS: canonical file output verifies'

    # 3. Same-size one-byte mutation, added file, and missing file fail distinctly.
    [IO.File]::WriteAllText((Join-Path $root 'web\index.html'), 'abd', $utf8)
    Assert-Failure (Invoke-Tool @('-ArtifactRoot', $root, '-VerifyManifest', $manifest)) 'hash_mismatch' 'Same-size one-byte mutation'
    [IO.File]::WriteAllText((Join-Path $root 'web\index.html'), 'abc', $utf8)
    [IO.File]::WriteAllText((Join-Path $root 'web\extra.js'), 'synthetic extra', $utf8)
    Assert-Failure (Invoke-Tool @('-ArtifactRoot', $root, '-VerifyManifest', $manifest)) 'unexpected_file' 'Added file'
    Remove-Item -LiteralPath (Join-Path $root 'web\extra.js')
    Remove-Item -LiteralPath (Join-Path $root 'NOTICE.txt')
    Assert-Failure (Invoke-Tool @('-ArtifactRoot', $root, '-VerifyManifest', $manifest)) 'missing_file' 'Missing file'
    $passed++
    Write-Output 'PASS: mutation, addition, and removal fail verification'

    # 4. Root, self-inclusion, overwrite, and mixed-mode guards.
    $empty = Join-Path $temporaryRoot 'empty'
    New-Item -ItemType Directory -Path $empty | Out-Null
    Assert-Failure (Invoke-Tool @('-ArtifactRoot', $empty)) 'empty_root' 'Empty root'
    Assert-Failure (Invoke-Tool @('-ArtifactRoot', (Join-Path $temporaryRoot 'absent'))) 'root_not_directory' 'Absent root'
    $guardRoot = New-ArtifactTree 'output-guard'
    Assert-Failure (Invoke-Tool @('-ArtifactRoot', $guardRoot, '-OutputPath', (Join-Path $guardRoot 'manifest.json'))) 'output_inside_root' 'Output inside root'
    $insideVerify = Join-Path $guardRoot 'existing-manifest.json'
    [IO.File]::WriteAllText($insideVerify, '{}', $utf8)
    Assert-Failure (Invoke-Tool @('-ArtifactRoot', $guardRoot, '-VerifyManifest', $insideVerify)) 'manifest_inside_root' 'Verification manifest inside root'
    Remove-Item -LiteralPath $insideVerify
    $existing = Join-Path $temporaryRoot 'existing.json'
    [IO.File]::WriteAllText($existing, 'competitor-sentinel', $utf8)
    Assert-Failure (Invoke-Tool @('-ArtifactRoot', $guardRoot, '-OutputPath', $existing)) 'output_exists' 'Existing output'
    Assert-Condition ([IO.File]::ReadAllText($existing) -ceq 'competitor-sentinel') 'Existing output must remain untouched.'
    Assert-Failure (Invoke-Tool @('-ArtifactRoot', $guardRoot, '-OutputPath', (Join-Path $temporaryRoot 'mixed.json'), '-VerifyManifest', $existing)) 'conflicting_modes' 'Conflicting modes'
    $passed++
    Write-Output 'PASS: root and output mode guards fail closed'

    # 5. Forbidden and unsupported names remain defense in depth.
    foreach ($name in @('.env', '.env.production', 'release.pem', 'upload.keystore', 'ci-service-account.json')) {
        $forbiddenRoot = New-ArtifactTree ('forbidden-' + [Guid]::NewGuid().ToString('N'))
        [IO.File]::WriteAllText((Join-Path $forbiddenRoot $name), 'synthetic placeholder', $utf8)
        Assert-Failure (Invoke-Tool @('-ArtifactRoot', $forbiddenRoot)) 'forbidden_file' "Forbidden name $name"
    }
    $spaceRoot = New-ArtifactTree 'unsupported-space'
    [IO.File]::WriteAllText((Join-Path $spaceRoot 'has space.txt'), 'x', $utf8)
    Assert-Failure (Invoke-Tool @('-ArtifactRoot', $spaceRoot)) 'unsupported_path' 'Path with a space'
    $passed++
    Write-Output 'PASS: forbidden and unsupported artifact names are rejected'

    # 6. Reparse points in artifact and output/verify parent chains fail without traversal.
    $junctionRoot = New-ArtifactTree 'junction'
    $outside = Join-Path $temporaryRoot 'outside'
    New-Item -ItemType Directory -Path $outside | Out-Null
    [IO.File]::WriteAllText((Join-Path $outside 'outside.txt'), 'synthetic outside', $utf8)
    $junction = Join-Path $junctionRoot 'linked'
    New-TestJunction -Path $junction -Target $outside
    try {
        Assert-Failure (Invoke-Tool @('-ArtifactRoot', $junctionRoot)) 'reparse_point' 'Junction inside root'
        Assert-Failure (Invoke-Tool @('-ArtifactRoot', $junction)) 'reparse_point' 'Junction as root'
    }
    finally { [IO.Directory]::Delete($junction) }

    $realOutputParent = Join-Path $temporaryRoot 'real-output-parent'
    New-Item -ItemType Directory -Path $realOutputParent | Out-Null
    $junctionParent = Join-Path $temporaryRoot 'junction-output-parent'
    New-TestJunction -Path $junctionParent -Target $realOutputParent
    try {
        Assert-Failure (Invoke-Tool @('-ArtifactRoot', $guardRoot, '-OutputPath', (Join-Path $junctionParent 'manifest.json'))) 'reparse_point' 'Output parent junction'
        [IO.File]::Copy($manifest, (Join-Path $realOutputParent 'verify.json'))
        Assert-Failure (Invoke-Tool @('-ArtifactRoot', $guardRoot, '-VerifyManifest', (Join-Path $junctionParent 'verify.json'))) 'reparse_point' 'Verify parent junction'
    }
    finally { [IO.Directory]::Delete($junctionParent) }
    $passed++
    Write-Output 'PASS: artifact and manifest reparse paths are rejected'

    # 7. An ordinary external mutation between full observations is detected.
    $changingRoot = New-ArtifactTree 'changing'
    $changingFile = Join-Path $changingRoot 'web\index.html'
    Use-ReducedTestPolicy @{'KEYATLAS_RELEASE_MANIFEST_TEST_PAUSE_BETWEEN_OBSERVATIONS_MS' = '3000'} {
        $job = Start-Job -ScriptBlock {
            param($Path)
            Start-Sleep -Milliseconds 700
            [IO.File]::WriteAllText($Path, 'abd', (New-Object Text.UTF8Encoding($false)))
        } -ArgumentList $changingFile
        try {
            Assert-Failure (Invoke-Tool @('-ArtifactRoot', $changingRoot)) 'unstable_snapshot' 'Concurrent ordinary mutation'
        }
        finally { Wait-TestJob $job }
    }
    $passed++
    Write-Output 'PASS: two observations detect an ordinary concurrent mutation'

    # 8. Destination and temp-path races fail closed without deleting uncertain files.
    $raceRoot = New-ArtifactTree 'output-race'
    $raceParent = Join-Path $temporaryRoot 'output-race-parent'
    New-Item -ItemType Directory -Path $raceParent -ErrorAction Stop | Out-Null
    $raceOutput = Join-Path $raceParent 'raced-output.json'
    Use-ReducedTestPolicy @{'KEYATLAS_RELEASE_MANIFEST_TEST_PAUSE_BEFORE_MOVE_MS' = '3000'} {
        $job = Start-Job -ScriptBlock {
            param($Path)
            Start-Sleep -Milliseconds 700
            $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes('competitor-sentinel')
            try {
                $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
                finally { $stream.Dispose() }
            }
            catch [IO.IOException] { }
        } -ArgumentList $raceOutput
        try {
            Assert-Failure (Invoke-Tool @('-ArtifactRoot', $raceRoot, '-OutputPath', $raceOutput)) 'output_exists' 'Competitor output race'
        }
        finally { Wait-TestJob $job }
    }
    Assert-Condition ([IO.File]::ReadAllText($raceOutput) -ceq 'competitor-sentinel') 'The race winner sentinel must be preserved.'
    $preservedTemps = @(Get-ChildItem -LiteralPath $raceParent -Filter '.keyatlas-manifest-*.tmp' -File)
    Assert-Condition ($preservedTemps.Count -eq 1) 'An uncertain temporary file must be preserved instead of path-guessed deletion.'
    $preservedVerify = Invoke-Tool @('-ArtifactRoot', $raceRoot, '-VerifyManifest', $preservedTemps[0].FullName)
    Assert-Condition ($preservedVerify.Code -eq 0) "The preserved private temp must remain canonical: $($preservedVerify.Text)"

    $swapRoot = New-ArtifactTree 'temp-swap'
    $swapBaselineParent = Join-Path $temporaryRoot 'temp-swap-baseline'
    $swapParent = Join-Path $temporaryRoot 'temp-swap-parent'
    New-Item -ItemType Directory -Path $swapBaselineParent -ErrorAction Stop | Out-Null
    New-Item -ItemType Directory -Path $swapParent -ErrorAction Stop | Out-Null
    $swapBaseline = Join-Path $swapBaselineParent 'baseline.json'
    $swapOutput = Join-Path $swapParent 'swapped-output.json'
    $baselineResult = Invoke-Tool @('-ArtifactRoot', $swapRoot, '-OutputPath', $swapBaseline)
    Assert-Condition ($baselineResult.Code -eq 0) "The swap baseline must be created: $($baselineResult.Text)"
    $replacementLength = [int](Get-Item -LiteralPath $swapBaseline).Length
    Use-ReducedTestPolicy @{'KEYATLAS_RELEASE_MANIFEST_TEST_PAUSE_BEFORE_MOVE_MS' = '3000'} {
        $job = Start-Job -ScriptBlock {
            param($Directory, $Length)
            $deadline = [DateTime]::UtcNow.AddSeconds(8)
            while ([DateTime]::UtcNow -lt $deadline) {
                $candidate = Get-ChildItem -LiteralPath $Directory -Filter '.keyatlas-manifest-*.tmp' -File -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($null -ne $candidate) {
                    try {
                        [IO.File]::Delete($candidate.FullName)
                        $replacement = New-Object byte[] $Length
                        for ($index = 0; $index -lt $replacement.Length; $index++) { $replacement[$index] = 88 }
                        [IO.File]::WriteAllBytes($candidate.FullName, $replacement)
                        return
                    }
                    catch [IO.IOException] { }
                    catch [UnauthorizedAccessException] { }
                }
                Start-Sleep -Milliseconds 5
            }
            throw 'The synthetic temp replacement did not win the test window.'
        } -ArgumentList $swapParent, $replacementLength
        try {
            $swapResult = Invoke-Tool @('-ArtifactRoot', $swapRoot, '-OutputPath', $swapOutput)
        }
        finally { Wait-TestJob $job }
        Assert-Failure $swapResult 'unstable_output' 'Same-length temporary replacement'
        Assert-Condition (-not (Test-Path -LiteralPath $swapOutput)) 'A rejected temporary replacement must not be published.'
    }
    $passed++
    Write-Output 'PASS: output races preserve competitor bytes and reject temporary replacement'

    # 9. Strict schema and canonical bytes reject normalized or ambiguous JSON.
    $strictRoot = New-ArtifactTree 'strict-schema'
    $strictManifest = Join-Path $temporaryRoot 'strict-valid.json'
    $strictCreated = Invoke-Tool @('-ArtifactRoot', $strictRoot, '-OutputPath', $strictManifest)
    Assert-Condition ($strictCreated.Code -eq 0) "Strict fixture creation failed: $($strictCreated.Text)"
    $validText = [IO.File]::ReadAllText($strictManifest, $utf8)
    $validObject = $validText | ConvertFrom-Json
    $firstHash = [string]$validObject.files[0].sha256
    Assert-InvalidManifestText $strictRoot 'extra-top-key' ($validText.Replace("  `"files`": [", "  `"extra`": true,`n  `"files`": ["))
    Assert-InvalidManifestText $strictRoot 'missing-top-key' ($validText.Replace("  `"algorithm`": `"sha256`",`n", ''))
    Assert-InvalidManifestText $strictRoot 'duplicate-top-key' ($validText.Replace("  `"algorithm`": `"sha256`",`n", "  `"algorithm`": `"sha256`",`n  `"algorithm`": `"sha256`",`n"))
    Assert-InvalidManifestText $strictRoot 'duplicate-file-key' ([regex]::Replace($validText, '"sha256": "([0-9a-f]{64})"', '"sha256": "$1", "sha256": "$1"', 1))
    Assert-InvalidManifestText $strictRoot 'non-array-files' '{"schema":"keyatlas.release-artifact-manifest.v1","algorithm":"sha256","fileCount":1,"files":{"path":"a","size":1,"sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}}'
    Assert-InvalidManifestText $strictRoot 'string-file-count' ($validText.Replace('"fileCount": 3', '"fileCount": "3"'))
    Assert-InvalidManifestText $strictRoot 'float-file-count' ($validText.Replace('"fileCount": 3', '"fileCount": 3.0'))
    Assert-InvalidManifestText $strictRoot 'negative-size' ([regex]::Replace($validText, '"size": [0-9]+', '"size": -1', 1))
    Assert-InvalidManifestText $strictRoot 'overflow-size' ([regex]::Replace($validText, '"size": [0-9]+', '"size": 9223372036854775808', 1))
    Assert-InvalidManifestText $strictRoot 'uppercase-hash' ($validText.Replace($firstHash, $firstHash.ToUpperInvariant()))
    Assert-InvalidManifestText $strictRoot 'extra-file-key' ([regex]::Replace($validText, '"sha256": "([0-9a-f]{64})" \}', '"sha256": "$1", "extra": 1 }', 1))
    Assert-InvalidManifestText $strictRoot 'missing-file-key' ([regex]::Replace($validText, ', "sha256": "[0-9a-f]{64}"', '', 1))
    Assert-InvalidManifestText $strictRoot 'trailing-whitespace' ($validText + ' ')
    Assert-InvalidManifestText $strictRoot 'crlf' ($validText.Replace("`n", "`r`n"))
    $bomPath = Join-Path $temporaryRoot 'invalid-bom.json'
    $bom = New-Object byte[] ($utf8.GetByteCount($validText) + 3)
    $bom[0] = 0xEF; $bom[1] = 0xBB; $bom[2] = 0xBF
    [Array]::Copy($utf8.GetBytes($validText), 0, $bom, 3, $bom.Length - 3)
    [IO.File]::WriteAllBytes($bomPath, $bom)
    Assert-Failure (Invoke-Tool @('-ArtifactRoot', $strictRoot, '-VerifyManifest', $bomPath)) 'invalid_manifest' 'BOM manifest'
    $entryLines = [regex]::Matches($validText, '(?m)^    \{ .* \},?$')
    Assert-Condition ($entryLines.Count -ge 2) 'Strict fixture must contain at least two entries.'
    $unsorted = $validText.Replace($entryLines[0].Value, '__FIRST__').Replace($entryLines[1].Value, $entryLines[0].Value).Replace('__FIRST__', $entryLines[1].Value)
    Assert-InvalidManifestText $strictRoot 'unsorted-files' $unsorted
    $firstPath = [string]$validObject.files[0].path
    $secondPath = [string]$validObject.files[1].path
    Assert-InvalidManifestText $strictRoot 'duplicate-path' ($validText.Replace("`"path`": `"$secondPath`"", "`"path`": `"$firstPath`""))
    Assert-InvalidManifestText $strictRoot 'case-collision' ($validText.Replace("`"path`": `"$secondPath`"", "`"path`": `"$($firstPath.ToLowerInvariant())`""))
    $passed++
    Write-Output 'PASS: strict schema and canonical byte representation are enforced'

    # 10. Resource limits are exercised through reduce-only test policy controls.
    $limitRoot = New-ArtifactTree 'limits'
    Use-ReducedTestPolicy @{'KEYATLAS_RELEASE_MANIFEST_TEST_MAX_FILES' = '2'} {
        Assert-Failure (Invoke-Tool @('-ArtifactRoot', $limitRoot)) 'too_many_files' 'File count limit'
    }
    Use-ReducedTestPolicy @{'KEYATLAS_RELEASE_MANIFEST_TEST_MAX_ENTRIES' = '2'} {
        Assert-Failure (Invoke-Tool @('-ArtifactRoot', $limitRoot)) 'too_many_entries' 'Total entry limit'
    }
    Use-ReducedTestPolicy @{'KEYATLAS_RELEASE_MANIFEST_TEST_MAX_DIRECTORIES' = '2'} {
        Assert-Failure (Invoke-Tool @('-ArtifactRoot', $limitRoot)) 'too_many_directories' 'Directory count limit'
    }
    Use-ReducedTestPolicy @{'KEYATLAS_RELEASE_MANIFEST_TEST_MAX_PATH_CHARS' = '10'} {
        Assert-Failure (Invoke-Tool @('-ArtifactRoot', $limitRoot)) 'unsupported_path' 'Path character limit'
    }
    Use-ReducedTestPolicy @{'KEYATLAS_RELEASE_MANIFEST_TEST_MAX_SINGLE_BYTES' = '2'} {
        Assert-Failure (Invoke-Tool @('-ArtifactRoot', $limitRoot)) 'file_too_large' 'Single file byte limit'
    }
    Use-ReducedTestPolicy @{'KEYATLAS_RELEASE_MANIFEST_TEST_MAX_AGGREGATE_BYTES' = '20'} {
        Assert-Failure (Invoke-Tool @('-ArtifactRoot', $limitRoot)) 'aggregate_too_large' 'Aggregate byte limit'
    }
    $deepRoot = Join-Path $temporaryRoot 'depth-limit'
    New-Item -ItemType Directory -Path $deepRoot | Out-Null
    $cursor = $deepRoot
    for ($depth = 1; $depth -le 33; $depth++) {
        $cursor = Join-Path $cursor ("d$depth")
        New-Item -ItemType Directory -Path $cursor | Out-Null
    }
    [IO.File]::WriteAllText((Join-Path $cursor 'leaf.txt'), 'x', $utf8)
    Assert-Failure (Invoke-Tool @('-ArtifactRoot', $deepRoot)) 'too_deep' 'Depth limit'
    $oversizedManifest = Join-Path $temporaryRoot 'oversized-manifest.json'
    $oversized = [IO.File]::Open($oversizedManifest, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $oversized.SetLength(8MB + 1) }
    finally { $oversized.Dispose() }
    Assert-Failure (Invoke-Tool @('-ArtifactRoot', $limitRoot, '-VerifyManifest', $oversizedManifest)) 'invalid_manifest' 'Manifest byte limit'
    Use-ReducedTestPolicy @{
        'KEYATLAS_RELEASE_MANIFEST_TEST_MAX_ELAPSED_SECONDS' = '1'
        'KEYATLAS_RELEASE_MANIFEST_TEST_PAUSE_BETWEEN_OBSERVATIONS_MS' = '1500'
    } {
        Assert-Failure (Invoke-Tool @('-ArtifactRoot', $limitRoot)) 'elapsed_budget' 'Cooperative elapsed budget'
    }
    $source = [IO.File]::ReadAllText($tool)
    foreach ($policy in @('$maximumFileCount = 10000', '$maximumTotalEntries = 20000', '$maximumDirectoryCount = 10000', '$maximumDepth = 32', '$maximumRelativePathCharacters = 512', '$maximumSingleFileBytes = 512MB', '$maximumAggregateFileBytes = 1GB', '$maximumManifestBytes = 8MB', '$maximumElapsedSeconds = 300', '$streamBufferBytes = 64KB')) {
        Assert-Condition ($source.Contains($policy)) "Missing policy declaration: $policy"
    }
    $passed++
    Write-Output 'PASS: count, depth, path, byte, manifest, cooperative elapsed, and buffer policies are bounded'

    Write-Output "RELEASE_MANIFEST_TESTS_PASSED=$passed"
    exit 0
}
catch {
    Write-Output ('RELEASE_MANIFEST_TESTS_FAILED: ' + $_.Exception.Message)
    exit 1
}
finally {
    Remove-TestTreeSafely -Root $temporaryRoot
}
