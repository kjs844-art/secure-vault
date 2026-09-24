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

# 'abc'의 SHA256 공개 test vector (FIPS 180-2)
$abcSha256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) {
        throw $Message
    }
}

function Invoke-Tool {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& $engine -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $tool @Arguments 2>&1)
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $savedPreference
    }
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
    Assert-Condition ($Result.Code -eq 1) "$Name must fail closed."
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
    finally {
        $ErrorActionPreference = $savedPreference
    }
    if ($code -ne 0) { throw 'The reparse-point test fixture could not be created.' }
}

try {
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) {
        throw 'The release artifact manifest tool is missing.'
    }
    New-Item -ItemType Directory -Path $temporaryRoot -ErrorAction Stop | Out-Null

    # 1. stdout 출력은 결정적이며 경로 순서가 ordinal 정렬이다.
    $root = New-ArtifactTree 'deterministic'
    $first = Invoke-Tool @('-ArtifactRoot', $root)
    $second = Invoke-Tool @('-ArtifactRoot', $root)
    Assert-Condition ($first.Code -eq 0) "Manifest creation must pass: $($first.Text)"
    Assert-Condition ($first.Text -ceq $second.Text) 'Two runs over the same tree must be byte-identical.'
    $parsed = $first.Text | ConvertFrom-Json
    Assert-Condition ($parsed.schema -ceq 'keyatlas.release-artifact-manifest.v1') 'The schema identifier is wrong.'
    Assert-Condition ($parsed.algorithm -ceq 'sha256') 'The algorithm must be sha256.'
    Assert-Condition ($parsed.fileCount -eq 3) 'The file count is wrong.'
    $paths = @($parsed.files | ForEach-Object { $_.path })
    Assert-Condition (($paths -join '|') -ceq 'NOTICE.txt|web/assets/app.js|web/index.html') "Paths must be ordinal-sorted with forward slashes: $($paths -join '|')"
    $index = @($parsed.files | Where-Object { $_.path -ceq 'web/index.html' })[0]
    Assert-Condition ($index.sha256 -ceq $abcSha256) 'The SHA256 of the known vector is wrong.'
    Assert-Condition ($index.size -eq 3) 'The recorded size is wrong.'
    Assert-Condition (-not $first.Text.Contains($temporaryRoot)) 'The manifest must not contain absolute paths.'
    $passed++
    Write-Output 'PASS: deterministic sorted manifest with known vector'

    # 2. 파일로 저장한 manifest는 BOM 없는 UTF-8, LF 줄바꿈이며 검증을 통과한다.
    $manifest = Join-Path $temporaryRoot 'deterministic.manifest.json'
    $created = Invoke-Tool @('-ArtifactRoot', $root, '-OutputPath', $manifest)
    Assert-Condition ($created.Code -eq 0) "Writing the manifest must pass: $($created.Text)"
    Assert-Condition ($created.Text.Contains('RELEASE_MANIFEST_CREATED files=3')) 'Creation needs an explicit marker.'
    $bytes = [IO.File]::ReadAllBytes($manifest)
    Assert-Condition (-not (($bytes.Length -ge 3) -and ($bytes[0] -eq 0xEF) -and ($bytes[1] -eq 0xBB) -and ($bytes[2] -eq 0xBF))) 'The manifest must not start with a BOM.'
    Assert-Condition (-not ([Array]::IndexOf($bytes, [byte]13) -ge 0)) 'The manifest must use LF line endings only.'
    $verified = Invoke-Tool @('-ArtifactRoot', $root, '-VerifyManifest', $manifest)
    Assert-Condition ($verified.Code -eq 0) "Verification of an untouched tree must pass: $($verified.Text)"
    Assert-Condition ($verified.Text.Contains('RELEASE_MANIFEST_VERIFIED files=3')) 'Verification needs an explicit marker.'
    $passed++
    Write-Output 'PASS: written manifest is BOM-free, LF-only, and verifies'

    # 3. 내용 변조, 추가 파일, 누락 파일은 각각 다른 사유로 실패한다.
    [IO.File]::WriteAllText((Join-Path $root 'web\index.html'), 'abd', $utf8)
    Assert-Failure (Invoke-Tool @('-ArtifactRoot', $root, '-VerifyManifest', $manifest)) 'hash_mismatch' 'Tampered content'
    [IO.File]::WriteAllText((Join-Path $root 'web\index.html'), 'abc', $utf8)
    [IO.File]::WriteAllText((Join-Path $root 'web\extra.js'), 'synthetic extra', $utf8)
    Assert-Failure (Invoke-Tool @('-ArtifactRoot', $root, '-VerifyManifest', $manifest)) 'unexpected_file' 'Added file'
    Remove-Item -LiteralPath (Join-Path $root 'web\extra.js')
    Remove-Item -LiteralPath (Join-Path $root 'NOTICE.txt')
    Assert-Failure (Invoke-Tool @('-ArtifactRoot', $root, '-VerifyManifest', $manifest)) 'missing_file' 'Missing file'
    $passed++
    Write-Output 'PASS: tampered, added, and missing files fail verification'

    # 4. 빈 디렉터리와 존재하지 않는 root는 실패한다.
    $empty = Join-Path $temporaryRoot 'empty'
    New-Item -ItemType Directory -Path $empty | Out-Null
    Assert-Failure (Invoke-Tool @('-ArtifactRoot', $empty)) 'empty_root' 'Empty root'
    Assert-Failure (Invoke-Tool @('-ArtifactRoot', (Join-Path $temporaryRoot 'absent'))) 'root_not_directory' 'Absent root'
    $passed++
    Write-Output 'PASS: empty and absent roots fail'

    # 5. 출력 경로는 artifact root 안이거나 기존 파일이면 거부되고 덮어쓰지 않는다.
    $outputRoot = New-ArtifactTree 'output-guard'
    Assert-Failure (Invoke-Tool @('-ArtifactRoot', $outputRoot, '-OutputPath', (Join-Path $outputRoot 'manifest.json'))) 'output_inside_root' 'Output inside root'
    Assert-Condition (-not (Test-Path -LiteralPath (Join-Path $outputRoot 'manifest.json'))) 'A rejected output must not be written.'
    $existing = Join-Path $temporaryRoot 'existing.json'
    [IO.File]::WriteAllText($existing, 'keep', $utf8)
    Assert-Failure (Invoke-Tool @('-ArtifactRoot', $outputRoot, '-OutputPath', $existing)) 'output_exists' 'Existing output'
    Assert-Condition ([IO.File]::ReadAllText($existing) -ceq 'keep') 'An existing file must not be overwritten.'
    Assert-Failure (Invoke-Tool @('-ArtifactRoot', $outputRoot, '-OutputPath', (Join-Path $temporaryRoot 'x.json'), '-VerifyManifest', $existing)) 'conflicting_modes' 'Conflicting modes'
    $passed++
    Write-Output 'PASS: output guard refuses self-inclusion, overwrite, and mixed modes'

    # 6. 키·환경 파일 이름은 release 묶음에 들어갈 수 없다.
    foreach ($name in @('.env', '.env.production', 'release.pem', 'upload.keystore', 'ci-service-account.json')) {
        $forbiddenRoot = New-ArtifactTree ('forbidden-' + [Guid]::NewGuid().ToString('N'))
        [IO.File]::WriteAllText((Join-Path $forbiddenRoot $name), 'synthetic placeholder', $utf8)
        Assert-Failure (Invoke-Tool @('-ArtifactRoot', $forbiddenRoot)) 'forbidden_file' "Forbidden name $name"
    }
    $passed++
    Write-Output 'PASS: key and environment file names are rejected'

    # 7. allowlist 밖 문자(공백·비ASCII)가 있는 경로는 거부된다.
    $spaceRoot = New-ArtifactTree 'unsupported-space'
    [IO.File]::WriteAllText((Join-Path $spaceRoot 'has space.txt'), 'x', $utf8)
    Assert-Failure (Invoke-Tool @('-ArtifactRoot', $spaceRoot)) 'unsupported_path' 'Path with a space'
    $unicodeRoot = New-ArtifactTree 'unsupported-unicode'
    [IO.File]::WriteAllText((Join-Path $unicodeRoot ('caf' + [char]0x00E9 + '.txt')), 'x', $utf8)
    Assert-Failure (Invoke-Tool @('-ArtifactRoot', $unicodeRoot)) 'unsupported_path' 'Non-ASCII path'
    $passed++
    Write-Output 'PASS: paths outside the allowlist are rejected'

    # 8. junction은 따라가지 않고 실패한다.
    $junctionRoot = New-ArtifactTree 'junction'
    $outside = Join-Path $temporaryRoot 'outside'
    New-Item -ItemType Directory -Path $outside | Out-Null
    [IO.File]::WriteAllText((Join-Path $outside 'secret-looking.txt'), 'synthetic outside', $utf8)
    $junction = Join-Path $junctionRoot 'linked'
    New-TestJunction -Path $junction -Target $outside
    try {
        Assert-Failure (Invoke-Tool @('-ArtifactRoot', $junctionRoot)) 'reparse_point' 'Junction inside root'
        Assert-Failure (Invoke-Tool @('-ArtifactRoot', $junction)) 'reparse_point' 'Junction as root'
    }
    finally {
        [IO.Directory]::Delete($junction)
    }
    $passed++
    Write-Output 'PASS: reparse points fail without traversal'

    # 9. 손상되었거나 schema가 다른 manifest는 검증 전에 거부된다.
    $validRoot = New-ArtifactTree 'invalid-manifest'
    $cases = @(
        'not json',
        '{"schema":"other","algorithm":"sha256","fileCount":1,"files":[{"path":"a","size":1,"sha256":"' + $abcSha256 + '"}]}',
        '{"schema":"keyatlas.release-artifact-manifest.v1","algorithm":"md5","fileCount":1,"files":[{"path":"a","size":1,"sha256":"' + $abcSha256 + '"}]}',
        '{"schema":"keyatlas.release-artifact-manifest.v1","algorithm":"sha256","fileCount":2,"files":[{"path":"a","size":1,"sha256":"' + $abcSha256 + '"}]}',
        '{"schema":"keyatlas.release-artifact-manifest.v1","algorithm":"sha256","fileCount":1,"files":[{"path":"../a","size":1,"sha256":"' + $abcSha256 + '"}]}',
        '{"schema":"keyatlas.release-artifact-manifest.v1","algorithm":"sha256","fileCount":1,"files":[{"path":"a","size":1,"sha256":"XYZ"}]}',
        '{"schema":"keyatlas.release-artifact-manifest.v1","algorithm":"sha256","fileCount":0,"files":[]}'
    )
    $caseIndex = 0
    foreach ($content in $cases) {
        $caseIndex++
        $bad = Join-Path $temporaryRoot "bad-$caseIndex.json"
        [IO.File]::WriteAllText($bad, $content, $utf8)
        Assert-Failure (Invoke-Tool @('-ArtifactRoot', $validRoot, '-VerifyManifest', $bad)) 'invalid_manifest' "Invalid manifest case $caseIndex"
    }
    Assert-Failure (Invoke-Tool @('-ArtifactRoot', $validRoot, '-VerifyManifest', (Join-Path $temporaryRoot 'absent.json'))) 'manifest_missing' 'Absent manifest'
    $passed++
    Write-Output 'PASS: malformed manifests are rejected'

    Write-Output "RELEASE_MANIFEST_TESTS_PASSED=$passed"
    exit 0
}
catch {
    Write-Output ('RELEASE_MANIFEST_TESTS_FAILED: ' + $_.Exception.Message)
    exit 1
}
finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}
