#requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$scanner = Join-Path $repositoryRoot 'scripts\check-repository-secrets.ps1'
$engine = (Get-Process -Id $PID).Path
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("keyatlas-secret-scan-$([Guid]::NewGuid().ToString('N'))")
$passed = 0

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) {
        throw $Message
    }
}

function Invoke-Scanner {
    param(
        [string]$Root,
        [string]$ScannerPath = $scanner
    )
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& $engine -NoProfile -NonInteractive -File $ScannerPath -Root $Root 2>&1)
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $savedPreference
    }
    [pscustomobject]@{ Code = $code; Text = ($lines -join "`n") }
}

function New-ScannerVariant {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][hashtable]$Replacements
    )

    $variantDirectory = Join-Path $temporaryRoot 'scanner-variants'
    New-Item -ItemType Directory -Path $variantDirectory -Force -ErrorAction Stop | Out-Null
    $source = [IO.File]::ReadAllText($scanner)
    foreach ($entry in $Replacements.GetEnumerator()) {
        $original = [string]$entry.Key
        if (-not $source.Contains($original)) {
            throw "The scanner variant anchor is missing: $original"
        }
        $source = $source.Replace($original, [string]$entry.Value)
    }
    $variantPath = Join-Path $variantDirectory ($Name + '.ps1')
    [IO.File]::WriteAllText($variantPath, $source, (New-Object Text.UTF8Encoding($false)))
    return $variantPath
}

function Assert-BoundFailure {
    param(
        [Parameter(Mandatory = $true)]$Result,
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Name
    )
    Assert-Condition ($Result.Code -eq 1) "$Name must fail closed."
    Assert-Condition ($Result.Text.Contains('SECRET_SCAN_FAILED setup_or_execution')) "$Name needs the generic failure marker."
    Assert-Condition (-not $Result.Text.Contains('SECRET_SCAN_PASSED')) "$Name must not emit a success marker."
    Assert-Condition (-not $Result.Text.Contains([IO.Path]::GetFullPath($Root))) "$Name must not disclose an absolute fixture path."
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

function Remove-TestJunction {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path) {
        [IO.Directory]::Delete($Path)
    }
}

try {
    if (-not (Test-Path -LiteralPath $scanner -PathType Leaf)) {
        throw 'The repository Secret scanner is missing.'
    }

    New-Item -ItemType Directory -Path $temporaryRoot -ErrorAction Stop | Out-Null
    $fixture = Join-Path $temporaryRoot 'candidate.txt'
    Set-Content -LiteralPath $fixture -Value 'synthetic metadata without credentials' -NoNewline

    $result = Invoke-Scanner -Root $temporaryRoot
    Assert-Condition ($result.Code -eq 0) 'A clean directory must pass.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_PASSED')) 'A clean scan needs an explicit success marker.'
    Assert-Condition ($result.Text.Contains('REAL_SECRET_GATE=CLOSED')) 'The real-Secret gate must remain closed.'
    $passed++
    Write-Output 'PASS: clean directory'

    $placeholderCases = @(
        [pscustomobject]@{ Name = 'quoted-env-placeholder'; Value = (('API_' + 'KEY') + '=' + [char]34 + 'your_api_key' + [char]34) },
        [pscustomobject]@{ Name = 'prefixed-env-placeholder'; FileName = '.env.example'; Value = (('CUSTOM_' + 'API_KEY') + '=example_value') },
        [pscustomobject]@{ Name = 'uppercase-placeholder'; FileName = '.env'; Value = (('API_' + 'KEY') + '=YOUR_API_KEY') },
        [pscustomobject]@{ Name = 'structured-placeholder'; FileName = 'candidate.json'; Value = ('{' + [char]34 + ('pass' + 'word') + [char]34 + ': ' + [char]34 + 'replace_me' + [char]34 + '}') },
        [pscustomobject]@{ Name = 'node-dynamic-reference'; Value = (('API_' + 'KEY') + '=process.env.OPENAI_API_KEY') },
        [pscustomobject]@{ Name = 'browser-dynamic-reference'; Value = (('API_' + 'KEY') + '=import.meta.env.VITE_API_KEY') },
        [pscustomobject]@{ Name = 'python-dynamic-reference'; Value = (('API_' + 'KEY') + ' = os.getenv(' + [char]34 + 'OPENAI_API_KEY' + [char]34 + ')') },
        [pscustomobject]@{ Name = 'rust-dynamic-reference'; Value = (('API_' + 'KEY') + ' = std::env::var(' + [char]34 + 'OPENAI_API_KEY' + [char]34 + ')') },
        [pscustomobject]@{ Name = 'source-function-call'; FileName = 'candidate.js'; Value = (('API_' + 'KEY') + ' = getApiKey();') },
        [pscustomobject]@{ Name = 'source-identifier-reference'; FileName = 'candidate.js'; Value = (('API_' + 'KEY') + ' = settings.OPENAI_API_KEY;') },
        [pscustomobject]@{ Name = 'powershell-env-reference'; FileName = 'candidate.ps1'; Value = ([char]36 + 'env:' + ('API_' + 'KEY') + ' = ' + [char]36 + 'env:SOURCE_API_KEY') },
        [pscustomobject]@{ Name = 'cmd-env-reference'; FileName = 'candidate.cmd'; Value = ('set ' + ('API_' + 'KEY') + '=' + [char]37 + 'SOURCE_API_KEY' + [char]37) },
        [pscustomobject]@{ Name = 'cmd-placeholder'; FileName = 'candidate.cmd'; Value = ('set ' + ('API_' + 'KEY') + '=your_api_key') },
        [pscustomobject]@{ Name = 'python-placeholder'; FileName = 'candidate.py'; Value = (('api_' + 'key') + ' = ' + [char]34 + 'your_api_key' + [char]34) },
        [pscustomobject]@{ Name = 'python-dynamic-source'; FileName = 'candidate.py'; Value = (('client_' + 'secret') + ' = os.getenv(' + [char]34 + 'CLIENT_SECRET' + [char]34 + ')') },
        [pscustomobject]@{ Name = 'object-property-placeholder'; FileName = 'candidate.ts'; Value = (('api' + 'Key') + ': ' + [char]34 + 'your_api_key' + [char]34) },
        [pscustomobject]@{ Name = 'object-property-dynamic'; FileName = 'candidate.ts'; Value = (('client' + 'Secret') + ': process.env.CLIENT_SECRET') },
        [pscustomobject]@{ Name = 'properties-placeholder'; FileName = 'application.properties'; Value = ('spring.datasource.' + ('pass' + 'word') + '=your_password') },
        [pscustomobject]@{ Name = 'properties-dynamic'; FileName = 'application.properties'; Value = ('openai.' + ('api-' + 'key') + '=' + [char]36 + '{OPENAI_API_KEY}') },
        [pscustomobject]@{ Name = 'namespaced-json-placeholder'; FileName = 'candidate.json'; Value = ('{' + [char]34 + 'provider.' + ('client_' + 'secret') + [char]34 + ': ' + [char]34 + 'replace_me' + [char]34 + '}') },
        [pscustomobject]@{ Name = 'camel-prefixed-source-placeholder'; FileName = 'candidate.ts'; Value = ('const ' + ('openai' + 'ApiKey') + ' = ' + [char]34 + 'your_api_key' + [char]34 + ';') },
        [pscustomobject]@{ Name = 'camel-prefixed-property-dynamic'; FileName = 'candidate.ts'; Value = (('anthropic' + 'ClientSecret') + ': process.env.CLIENT_SECRET') },
        [pscustomobject]@{ Name = 'camel-prefixed-config-dynamic'; FileName = 'application.properties'; Value = (('openai' + 'ApiKey') + '=' + [char]36 + '{OPENAI_API_KEY}') }
    )

    foreach ($placeholderCase in $placeholderCases) {
        $placeholderFileName = 'candidate.txt'
        if ($placeholderCase.PSObject.Properties.Name -contains 'FileName') {
            $placeholderFileName = $placeholderCase.FileName
        }
        $placeholderPath = Join-Path $temporaryRoot $placeholderFileName
        Set-Content -LiteralPath $fixture -Value 'synthetic metadata without credentials' -NoNewline
        Set-Content -LiteralPath $placeholderPath -Value $placeholderCase.Value -NoNewline
        $result = Invoke-Scanner -Root $temporaryRoot
        Assert-Condition ($result.Code -eq 0) "$($placeholderCase.Name) must remain a clean example."
        Assert-Condition ($result.Text.Contains('SECRET_SCAN_PASSED')) "$($placeholderCase.Name) needs an explicit success marker."
        Assert-Condition (-not $result.Text.Contains('SECRET_SCAN_FINDINGS=')) "$($placeholderCase.Name) must not become a finding."
        if (-not [string]::Equals($placeholderPath, $fixture, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $placeholderPath -Force
        }
        $passed++
        Write-Output "PASS: $($placeholderCase.Name) is not treated as a Secret"
    }

    $cases = @(
        [pscustomobject]@{ Name = 'openai'; Value = (('s' + 'k-') + ('A' * 24)) },
        [pscustomobject]@{ Name = 'github'; Value = (('g' + 'hp_') + ('B' * 24)) },
        [pscustomobject]@{ Name = 'aws'; Value = (('A' + 'KIA') + ('C' * 16)) },
        [pscustomobject]@{ Name = 'quoted-password'; Value = (('PASS' + 'WORD') + ' = ' + [char]34 + ('D' * 12) + [char]34) },
        [pscustomobject]@{ Name = 'quoted-field'; FileName = 'candidate.json'; Value = ('{' + [char]34 + 'api_key' + [char]34 + ': ' + [char]34 + ('F' * 12) + [char]34 + '}') },
        [pscustomobject]@{ Name = 'unquoted-env'; FileName = 'candidate.env'; Value = (('API_' + 'KEY') + '=' + ('G' * 24)) },
        [pscustomobject]@{ Name = 'prefixed-env'; FileName = 'candidate.env'; Value = (('CUSTOM_' + 'API_KEY') + '=' + ('I' * 24)) },
        [pscustomobject]@{ Name = 'aws-secret-access'; FileName = 'candidate.env'; Value = (('AWS_' + 'SECRET_ACCESS_KEY') + '=' + ('J' * 40)) },
        [pscustomobject]@{ Name = 'yaml-password'; FileName = 'candidate.yaml'; Value = (('pass' + 'word') + ': ' + [char]34 + ('K' * 16) + [char]34) },
        [pscustomobject]@{ Name = 'yaml-unquoted-password'; FileName = 'candidate.yml'; Value = (('pass' + 'word') + ': ' + ('M' * 20)) },
        [pscustomobject]@{ Name = 'toml-api-key'; FileName = 'candidate.toml'; Value = (('api_' + 'key') + ' = ' + [char]34 + ('L' * 16) + [char]34) },
        [pscustomobject]@{ Name = 'lowercase-dotenv'; FileName = '.env'; Value = (('pass' + 'word') + '=' + ('N' * 20)) },
        [pscustomobject]@{ Name = 'test-prefix-is-not-placeholder'; FileName = 'candidate.env'; Value = (('CUSTOM_' + 'API_KEY') + '=test' + ('P' * 24)) },
        [pscustomobject]@{ Name = 'unquoted-symbol-password'; FileName = '.env'; Value = (('PASS' + 'WORD') + '=Abcd1234!') },
        [pscustomobject]@{ Name = 'unquoted-mid-dollar-secret'; FileName = '.env.local'; Value = (('CLIENT_' + 'SECRET') + '=Abcd$1234&?') },
        [pscustomobject]@{ Name = 'declared-quoted-secret'; FileName = 'candidate.js'; Value = ('const ' + ('API_' + 'KEY') + ' = ' + [char]34 + ('Q' * 20) + [char]34 + ';') },
        [pscustomobject]@{ Name = 'camel-api-key-declaration'; FileName = 'candidate.js'; Value = ('const ' + ('api' + 'Key') + ' = ' + [char]34 + ('S' * 20) + [char]34 + ';') },
        [pscustomobject]@{ Name = 'camel-client-secret-declaration'; FileName = 'candidate.ts'; Value = ('let ' + ('client' + 'Secret') + ': string = ' + [char]34 + ('T' * 20) + [char]34 + ';') },
        [pscustomobject]@{ Name = 'snake-api-key-declaration'; FileName = 'candidate.rs'; Value = ('let ' + ('api_' + 'key') + ': &str = ' + [char]34 + ('U' * 20) + [char]34 + ';') },
        [pscustomobject]@{ Name = 'lowercase-password-declaration'; FileName = 'candidate.rs'; Value = ('let ' + ('pass' + 'word') + ': &str = ' + [char]34 + ('V' * 20) + [char]34 + ';') },
        [pscustomobject]@{ Name = 'export-const-declaration'; FileName = 'candidate.ts'; Value = ('export const ' + ('api' + 'Key') + ' = ' + [char]34 + ('d' * 20) + [char]34 + ';') },
        [pscustomobject]@{ Name = 'kotlin-val-declaration'; FileName = 'candidate.kt'; Value = ('val ' + ('api' + 'Key') + ' = ' + [char]34 + ('e' * 20) + [char]34) },
        [pscustomobject]@{ Name = 'rust-let-mut-declaration'; FileName = 'candidate.rs'; Value = ('let mut ' + ('api_' + 'key') + ' = ' + [char]34 + ('f' * 20) + [char]34 + ';') },
        [pscustomobject]@{ Name = 'object-property-secret'; FileName = 'candidate.ts'; Value = (('api' + 'Key') + ': ' + [char]34 + ('g' * 20) + [char]34 + ',') },
        [pscustomobject]@{ Name = 'python-api-key-assignment'; FileName = 'candidate.py'; Value = (('api_' + 'key') + ' = ' + [char]34 + ('a' * 20) + [char]34) },
        [pscustomobject]@{ Name = 'python-password-assignment'; FileName = 'candidate.py'; Value = (('pass' + 'word') + ': str = ' + [char]34 + ('b' * 20) + [char]34) },
        [pscustomobject]@{ Name = 'python-client-secret-assignment'; FileName = 'candidate.py'; Value = (('client_' + 'secret') + ' = ' + [char]39 + ('c' * 20) + [char]39) },
        [pscustomobject]@{ Name = 'spring-password-property'; FileName = 'application.properties'; Value = ('spring.datasource.' + ('pass' + 'word') + '=' + ('h' * 20)) },
        [pscustomobject]@{ Name = 'openai-api-key-property'; FileName = 'application.properties'; Value = ('openai.' + ('api-' + 'key') + '=' + ('i' * 20)) },
        [pscustomobject]@{ Name = 'ini-client-secret'; FileName = 'candidate.ini'; Value = ('provider.' + ('client-' + 'secret') + '=' + ('j' * 20)) },
        [pscustomobject]@{ Name = 'namespaced-json-secret'; FileName = 'candidate.json'; Value = ('{' + [char]34 + ('OPENAI_' + 'API_KEY') + [char]34 + ': ' + [char]34 + ('k' * 20) + [char]34 + '}') },
        [pscustomobject]@{ Name = 'camel-prefixed-api-key-declaration'; FileName = 'candidate.ts'; Value = ('const ' + ('openai' + 'ApiKey') + ' = ' + [char]34 + ('l' * 20) + [char]34 + ';') },
        [pscustomobject]@{ Name = 'camel-prefixed-password-declaration'; FileName = 'candidate.kt'; Value = ('val ' + ('vault' + 'Password') + ' = ' + [char]34 + ('m' * 20) + [char]34) },
        [pscustomobject]@{ Name = 'camel-prefixed-object-secret'; FileName = 'candidate.ts'; Value = ([char]34 + ('anthropic' + 'ClientSecret') + [char]34 + ': ' + [char]34 + ('n' * 20) + [char]34 + ',') },
        [pscustomobject]@{ Name = 'camel-prefixed-config-secret'; FileName = 'application.properties'; Value = (('openai' + 'ApiKey') + '=' + ('o' * 20)) },
        [pscustomobject]@{ Name = 'shell-export-secret'; FileName = 'candidate.sh'; Value = ('export ' + ('API_' + 'KEY') + '=' + ('R' * 20)) },
        [pscustomobject]@{ Name = 'powershell-env-secret'; FileName = 'candidate.ps1'; Value = ([char]36 + 'env:' + ('API_' + 'KEY') + ' = ' + [char]34 + ('W' * 20) + [char]34) },
        [pscustomobject]@{ Name = 'cmd-set-secret'; FileName = 'candidate.cmd'; Value = ('set ' + ('API_' + 'KEY') + '=' + ('X' * 20)) },
        [pscustomobject]@{ Name = 'cmd-set-quoted-secret'; FileName = 'candidate.cmd'; Value = ('set ' + ('API_' + 'KEY') + '=' + [char]34 + ('Y' * 20) + [char]34) },
        [pscustomobject]@{ Name = 'cmd-set-wrapped-secret'; FileName = 'candidate.cmd'; Value = ('set ' + [char]34 + ('API_' + 'KEY') + '=' + ('Z' * 20) + [char]34) },
        [pscustomobject]@{ Name = 'cmd-set-wrapped-multiline-secret'; FileName = 'candidate.cmd'; Value = ('set ' + [char]34 + ('API_' + 'KEY') + '=' + ('Z' * 20) + [char]34 + "`r`necho safe") },
        [pscustomobject]@{ Name = 'private-key'; Value = ('-----BEGIN ' + 'OPENSSH PRIVATE KEY-----') },
        [pscustomobject]@{ Name = 'encrypted-private-key'; Value = ('-----BEGIN ' + 'ENCRYPTED PRIVATE KEY-----') },
        [pscustomobject]@{ Name = 'dsa-private-key'; Value = ('-----BEGIN ' + 'DSA PRIVATE KEY-----') },
        [pscustomobject]@{ Name = 'pgp-private-key'; Value = ('-----BEGIN ' + 'PGP PRIVATE KEY BLOCK-----') }
    )

    foreach ($case in $cases) {
        $caseFileName = 'candidate.txt'
        if ($case.PSObject.Properties.Name -contains 'FileName') {
            $caseFileName = $case.FileName
        }
        $casePath = Join-Path $temporaryRoot $caseFileName
        Set-Content -LiteralPath $fixture -Value 'synthetic metadata without credentials' -NoNewline
        Set-Content -LiteralPath $casePath -Value $case.Value -NoNewline
        $result = Invoke-Scanner -Root $temporaryRoot
        Assert-Condition ($result.Code -eq 1) "$($case.Name) must fail the scan."
        Assert-Condition ($result.Text.Contains('SECRET_SCAN_FINDINGS=1')) "$($case.Name) must report one finding."
        Assert-Condition ($result.Text.Contains("SECRET_SCAN_FILE=$caseFileName")) "$($case.Name) must report only the relative file."
        Assert-Condition (-not $result.Text.Contains($case.Value)) "$($case.Name) value must never be printed."
        Assert-Condition (-not $result.Text.Contains('SECRET_SCAN_PASSED')) "$($case.Name) must not produce a success marker."
        if (-not [string]::Equals($casePath, $fixture, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $casePath -Force
        }
        $passed++
        Write-Output "PASS: $($case.Name) is detected without value disclosure"
    }

    $unicodeCaseFoldPath = Join-Path $temporaryRoot 'unicode-casefold-token.py'
    $unicodeCaseFoldValue = ('access_to' + [char]0x212A + 'en = ' + [char]34 + ('z' * 20) + [char]34)
    Set-Content -LiteralPath $fixture -Value 'synthetic metadata without credentials' -NoNewline
    $unicodeCaseFoldEncoding = [Text.UTF8Encoding]::new($false, $true)
    [IO.File]::WriteAllText($unicodeCaseFoldPath, $unicodeCaseFoldValue, $unicodeCaseFoldEncoding)
    Assert-Condition (
        [string]::Equals(
            [IO.File]::ReadAllText($unicodeCaseFoldPath, $unicodeCaseFoldEncoding),
            $unicodeCaseFoldValue,
            [StringComparison]::Ordinal
        )
    ) 'The Unicode case-fold fixture must survive an exact UTF-8 round trip.'
    $unicodeCaseFoldExpected = [regex]::IsMatch(
        $unicodeCaseFoldValue,
        '(?m:^[\x20\t]*)(?i:access[_-]?token)[\x20\t]*=[\x20\t]*[\x22\x27][^\x22\x27\r\n]{8,}[\x22\x27]',
        [Text.RegularExpressions.RegexOptions]::CultureInvariant
    )
    $result = Invoke-Scanner -Root $temporaryRoot
    if ($unicodeCaseFoldExpected) {
        Assert-Condition ($result.Code -eq 1) 'The prefilter must retain this engine''s invariant Unicode regex finding.'
        Assert-Condition ($result.Text.Contains('SECRET_SCAN_FILE=unicode-casefold-token.py')) 'The Unicode case-fold finding needs the safe relative path.'
    }
    else {
        Assert-Condition ($result.Code -eq 0) 'The prefilter must not expand this engine''s invariant Unicode regex language.'
        Assert-Condition ($result.Text.Contains('SECRET_SCAN_PASSED')) 'A non-finding Unicode case-fold case needs a success marker.'
    }
    Remove-Item -LiteralPath $unicodeCaseFoldPath -Force
    $passed++
    Write-Output 'PASS: anchor prefilter preserves the current engine Unicode case-fold behavior'

    $ignoreFile = Join-Path $temporaryRoot '.gitignore'
    $ignoredValue = (('s' + 'k-') + ('E' * 24))
    Set-Content -LiteralPath $ignoreFile -Value 'candidate.txt' -NoNewline
    Set-Content -LiteralPath $fixture -Value $ignoredValue -NoNewline
    $result = Invoke-Scanner -Root $temporaryRoot
    Assert-Condition ($result.Code -eq 1) 'A candidate hidden by an ignore rule must fail the scan.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_FINDINGS=1')) 'An ignored candidate must report one finding.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_FILE=candidate.txt')) 'An ignored candidate must report only the relative file.'
    Assert-Condition (-not $result.Text.Contains($ignoredValue)) 'An ignored candidate value must never be printed.'
    Assert-Condition (-not $result.Text.Contains('SECRET_SCAN_PASSED')) 'An ignored candidate must not produce a success marker.'
    Remove-Item -LiteralPath $ignoreFile -Force
    $passed++
    Write-Output 'PASS: ignore rules cannot hide a candidate'

    $distDirectory = Join-Path $temporaryRoot 'dist'
    $distFile = Join-Path $distDirectory 'app.js'
    $distValue = (('s' + 'k-') + ('H' * 24))
    New-Item -ItemType Directory -Path $distDirectory -ErrorAction Stop | Out-Null
    Set-Content -LiteralPath $fixture -Value 'synthetic metadata without credentials' -NoNewline
    Set-Content -LiteralPath $distFile -Value $distValue -NoNewline
    $result = Invoke-Scanner -Root $temporaryRoot
    Assert-Condition ($result.Code -eq 1) 'A candidate inside dist must fail the scan.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_FINDINGS=1')) 'A dist candidate must report one finding.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_FILE=dist/app.js')) 'A dist candidate must report only the relative file.'
    Assert-Condition (-not $result.Text.Contains($distValue)) 'A dist candidate value must never be printed.'
    Remove-Item -LiteralPath $distDirectory -Recurse -Force
    $passed++
    Write-Output 'PASS: dist cannot hide a candidate'

    $baselineSource = Join-Path $repositoryRoot 'tests\fixtures\synthetic\v0alpha1-vectors.json'
    $baselineTarget = Join-Path $temporaryRoot 'tests\fixtures\synthetic\v0alpha1-vectors.json'
    $baselineDirectory = Split-Path -Path $baselineTarget -Parent
    New-Item -ItemType Directory -Path $baselineDirectory -ErrorAction Stop | Out-Null
    Copy-Item -LiteralPath $baselineSource -Destination $baselineTarget -ErrorAction Stop
    $result = Invoke-Scanner -Root $temporaryRoot
    Assert-Condition ($result.Code -eq 0) 'The exact reviewed synthetic baseline must pass.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_BASELINE_ALLOWED=1')) 'The synthetic baseline exemption must be visible.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_PASSED')) 'The exact synthetic baseline needs an explicit success marker.'
    $passed++
    Write-Output 'PASS: exact synthetic baseline is visible and allowed'

    Add-Content -LiteralPath $baselineTarget -Value ' ' -NoNewline
    $result = Invoke-Scanner -Root $temporaryRoot
    Assert-Condition ($result.Code -eq 1) 'A modified synthetic baseline must fail the scan.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_FAILED setup_or_execution')) 'A modified baseline needs a generic integrity failure.'
    Assert-Condition (-not $result.Text.Contains('SECRET_SCAN_PASSED')) 'A modified synthetic baseline must not produce a success marker.'
    $passed++
    Write-Output 'PASS: modified synthetic baseline fails closed'

    Set-Content -LiteralPath $baselineTarget -Value 'clean text that no credential pattern can match' -NoNewline
    $result = Invoke-Scanner -Root $temporaryRoot
    Assert-Condition ($result.Code -eq 1) 'A baseline changed to nonmatching content must fail the scan.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_FAILED setup_or_execution')) 'Nonmatching baseline drift needs a generic integrity failure.'
    Assert-Condition (-not $result.Text.Contains('SECRET_SCAN_PASSED')) 'Nonmatching baseline drift must not produce a success marker.'
    $passed++
    Write-Output 'PASS: nonmatching synthetic baseline drift fails closed'

    Remove-Item -LiteralPath (Join-Path $temporaryRoot 'tests') -Recurse -Force

    $ownedRepository = Join-Path $temporaryRoot 'owned-repository'
    $ownedScriptDirectory = Join-Path $ownedRepository 'scripts'
    New-Item -ItemType Directory -Path $ownedScriptDirectory -ErrorAction Stop | Out-Null
    $ownedScanner = Join-Path $ownedScriptDirectory 'check-repository-secrets.ps1'
    Copy-Item -LiteralPath $scanner -Destination $ownedScanner -ErrorAction Stop
    $result = Invoke-Scanner -Root $ownedRepository -ScannerPath $ownedScanner
    Assert-Condition ($result.Code -eq 1) 'The scanner own repository with a missing baseline must fail.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_FAILED setup_or_execution')) 'A missing own-repository baseline needs a generic integrity failure.'
    Assert-Condition (-not $result.Text.Contains('SECRET_SCAN_PASSED')) 'A missing own-repository baseline must not produce a success marker.'
    Remove-Item -LiteralPath $ownedRepository -Recurse -Force
    $passed++
    Write-Output 'PASS: own-repository baseline completeness cannot be disabled by deleting Cargo.toml'

    Set-Content -LiteralPath $fixture -Value 'synthetic metadata without credentials' -NoNewline
    $hiddenPath = Join-Path $temporaryRoot '.hidden-candidate.txt'
    $hiddenValue = (('s' + 'k-') + ('q' * 24))
    Set-Content -LiteralPath $hiddenPath -Value $hiddenValue -NoNewline
    $result = Invoke-Scanner -Root $temporaryRoot
    Assert-Condition ($result.Code -eq 1) 'A dot-prefixed hidden candidate must fail.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_FILE=.hidden-candidate.txt')) 'The hidden candidate safe path must be reported.'
    Assert-Condition (-not $result.Text.Contains($hiddenValue)) 'The hidden candidate value must not be disclosed.'
    Remove-Item -LiteralPath $hiddenPath -Force
    $passed++
    Write-Output 'PASS: dot-prefixed hidden files are scanned'

    $excludedValue = (('s' + 'k-') + ('r' * 24))
    foreach ($excludedName in @('.git', 'target', 'node_modules', 'coverage', '.vite')) {
        $excludedDirectory = Join-Path $temporaryRoot $excludedName
        New-Item -ItemType Directory -Path $excludedDirectory -ErrorAction Stop | Out-Null
        Set-Content -LiteralPath (Join-Path $excludedDirectory 'candidate.txt') -Value $excludedValue -NoNewline
    }
    $result = Invoke-Scanner -Root $temporaryRoot
    Assert-Condition ($result.Code -eq 0) 'Only the five exact excluded directory names may be skipped.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_PASSED')) 'Exact exclusions must retain an explicit pass marker.'
    foreach ($excludedName in @('.git', 'target', 'node_modules', 'coverage', '.vite')) {
        Remove-Item -LiteralPath (Join-Path $temporaryRoot $excludedName) -Recurse -Force
    }
    $nearDirectory = Join-Path $temporaryRoot 'target-safe'
    New-Item -ItemType Directory -Path $nearDirectory -ErrorAction Stop | Out-Null
    Set-Content -LiteralPath (Join-Path $nearDirectory 'candidate.txt') -Value $excludedValue -NoNewline
    $result = Invoke-Scanner -Root $temporaryRoot
    Assert-Condition ($result.Code -eq 1) 'A near-name directory must not inherit an exclusion.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_FILE=target-safe/candidate.txt')) 'The near-name candidate must be reported.'
    Remove-Item -LiteralPath $nearDirectory -Recurse -Force
    $passed++
    Write-Output 'PASS: exclusions are exact and near-name directories remain in scope'

    $plainConfigLike = Join-Path $temporaryRoot 'config-scope.txt'
    $configScoped = Join-Path $temporaryRoot 'config-scope.env.local'
    $configValue = (('API_' + 'KEY') + '=' + ('s' * 24))
    Set-Content -LiteralPath $plainConfigLike -Value $configValue -NoNewline
    $result = Invoke-Scanner -Root $temporaryRoot
    Assert-Condition ($result.Code -eq 0) 'An unquoted structured assignment outside config globs must stay out of the config-only scope.'
    Remove-Item -LiteralPath $plainConfigLike -Force
    Set-Content -LiteralPath $configScoped -Value $configValue -NoNewline
    $result = Invoke-Scanner -Root $temporaryRoot
    Assert-Condition ($result.Code -eq 1) 'The same assignment inside an env glob must be detected.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_FILE=config-scope.env.local')) 'The config-glob finding must use the safe relative path.'
    Remove-Item -LiteralPath $configScoped -Force
    $passed++
    Write-Output 'PASS: all-text and config-glob pattern scopes remain distinct'

    $encodingCases = @(
        [pscustomobject]@{ Name = 'utf8-bom'; Encoding = (New-Object Text.UTF8Encoding($true, $true)) },
        [pscustomobject]@{ Name = 'utf16-le'; Encoding = (New-Object Text.UnicodeEncoding($false, $true, $true)) },
        [pscustomobject]@{ Name = 'utf16-be'; Encoding = (New-Object Text.UnicodeEncoding($true, $true, $true)) },
        [pscustomobject]@{ Name = 'utf32-le'; Encoding = (New-Object Text.UTF32Encoding($false, $true, $true)) },
        [pscustomobject]@{ Name = 'utf32-be'; Encoding = (New-Object Text.UTF32Encoding($true, $true, $true)) }
    )
    foreach ($encodingCase in $encodingCases) {
        $encodedPath = Join-Path $temporaryRoot ($encodingCase.Name + '.txt')
        $encodedValue = (('s' + 'k-') + ('t' * 24))
        $preamble = $encodingCase.Encoding.GetPreamble()
        $body = $encodingCase.Encoding.GetBytes($encodedValue)
        $encodedBytes = New-Object byte[] ($preamble.Length + $body.Length)
        [Array]::Copy($preamble, 0, $encodedBytes, 0, $preamble.Length)
        [Array]::Copy($body, 0, $encodedBytes, $preamble.Length, $body.Length)
        [IO.File]::WriteAllBytes($encodedPath, $encodedBytes)
        $result = Invoke-Scanner -Root $temporaryRoot
        Assert-Condition ($result.Code -eq 1) "$($encodingCase.Name) must be decoded strictly and detected."
        Assert-Condition ($result.Text.Contains("SECRET_SCAN_FILE=$($encodingCase.Name).txt")) "$($encodingCase.Name) needs the safe file marker."
        Assert-Condition (-not $result.Text.Contains($encodedValue)) "$($encodingCase.Name) must not disclose the value."
        Remove-Item -LiteralPath $encodedPath -Force
        $passed++
        Write-Output "PASS: $($encodingCase.Name) strict decoding"
    }

    $invalidUtf8Path = Join-Path $temporaryRoot 'invalid-utf8.txt'
    [IO.File]::WriteAllBytes($invalidUtf8Path, [byte[]](0xC3, 0x28))
    $result = Invoke-Scanner -Root $temporaryRoot
    Assert-Condition ($result.Code -eq 1) 'Invalid unmarked UTF-8 must fail closed.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_FAILED setup_or_execution')) 'Invalid UTF-8 needs a generic failure marker.'
    Assert-Condition (-not $result.Text.Contains('invalid-utf8.txt')) 'A decode failure must not disclose its path.'
    Remove-Item -LiteralPath $invalidUtf8Path -Force
    $passed++
    Write-Output 'PASS: invalid UTF-8 fails closed without path disclosure'

    $binaryPath = Join-Path $temporaryRoot 'candidate.bin'
    [IO.File]::WriteAllBytes($binaryPath, [byte[]](0, 1, 2, 3, 10, 255))
    $result = Invoke-Scanner -Root $temporaryRoot
    Assert-Condition ($result.Code -eq 0) 'A clean bounded binary must be inspected through its ASCII projection.'
    $binaryValue = [Text.Encoding]::ASCII.GetBytes((('s' + 'k-') + ('u' * 24)))
    $binaryBytes = New-Object byte[] ($binaryValue.Length + 4)
    $binaryBytes[0] = 0
    $binaryBytes[1] = 255
    [Array]::Copy($binaryValue, 0, $binaryBytes, 2, $binaryValue.Length)
    $binaryBytes[$binaryBytes.Length - 2] = 0
    $binaryBytes[$binaryBytes.Length - 1] = 1
    [IO.File]::WriteAllBytes($binaryPath, $binaryBytes)
    $result = Invoke-Scanner -Root $temporaryRoot
    Assert-Condition ($result.Code -eq 1) 'A provider token embedded in binary must be detected.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_FILE=candidate.bin')) 'A binary finding must report only its safe path.'
    Remove-Item -LiteralPath $binaryPath -Force
    $binaryConfigPath = Join-Path $temporaryRoot 'candidate.env'
    [IO.File]::WriteAllBytes($binaryConfigPath, [byte[]](0, 1, 2, 3))
    $result = Invoke-Scanner -Root $temporaryRoot
    Assert-Condition ($result.Code -eq 1) 'Binary content in a configuration glob must fail closed.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_FAILED setup_or_execution')) 'Binary config content needs a generic failure marker.'
    Remove-Item -LiteralPath $binaryConfigPath -Force
    $passed++
    Write-Output 'PASS: binary content is inspected and binary config content fails closed'

    $wasmLikePath = Join-Path $temporaryRoot 'generated-wasm-like.bin'
    $wasmLikeBytes = New-Object byte[] (512KB)
    $benignBinaryText = [Text.Encoding]::ASCII.GetBytes('password metadata without an assignment')
    [Array]::Copy($benignBinaryText, 0, $wasmLikeBytes, 4096, $benignBinaryText.Length)
    [IO.File]::WriteAllBytes($wasmLikePath, $wasmLikeBytes)
    $result = Invoke-Scanner -Root $temporaryRoot
    Assert-Condition ($result.Code -eq 0) 'A large clean WASM-like binary projection must complete without a regex timeout.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_PASSED')) 'A large clean WASM-like scan needs a success marker.'

    $wasmLikeValue = [Text.Encoding]::ASCII.GetBytes((('s' + 'k-') + ('q' * 24)))
    [Array]::Copy($wasmLikeValue, 0, $wasmLikeBytes, 8192, $wasmLikeValue.Length)
    [IO.File]::WriteAllBytes($wasmLikePath, $wasmLikeBytes)
    $result = Invoke-Scanner -Root $temporaryRoot
    Assert-Condition ($result.Code -eq 1) 'A provider token in a large WASM-like binary must still be detected.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_FILE=generated-wasm-like.bin')) 'A large binary finding must report only its safe path.'
    Remove-Item -LiteralPath $wasmLikePath -Force
    $passed++
    Write-Output 'PASS: large WASM-like binary projections are deterministic and still scanned'

    $anchorDenseRoot = Join-Path $temporaryRoot 'anchor-dense-root'
    New-Item -ItemType Directory -Path $anchorDenseRoot -ErrorAction Stop | Out-Null
    $anchorDensePath = Join-Path $anchorDenseRoot 'anchor-dense-wasm-like.bin'
    $anchorDenseBytes = [Text.Encoding]::ASCII.GetBytes(('password metadata' + [char]0) * 7000)
    [IO.File]::WriteAllBytes($anchorDensePath, $anchorDenseBytes)
    $anchorDenseScanner = New-ScannerVariant -Name 'anchor-dense-budget' -Replacements @{
        '$maximumCooperativeElapsedSeconds = 300' = '$maximumCooperativeElapsedSeconds = 15'
    }
    $result = Invoke-Scanner -Root $anchorDenseRoot -ScannerPath $anchorDenseScanner
    Assert-Condition ($result.Code -eq 0) 'Anchor-dense binary input must remain within the bounded scan budget.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_PASSED')) 'Anchor-dense binary input needs a success marker.'
    Remove-Item -LiteralPath $anchorDenseRoot -Recurse -Force
    $passed++
    Write-Output 'PASS: anchor-dense binary projections are scanned with bounded forward progress'

    foreach ($bomlessCase in @(
        [pscustomobject]@{ Name = 'bomless-utf16-le'; Encoding = (New-Object Text.UnicodeEncoding($false, $false, $true)) },
        [pscustomobject]@{ Name = 'bomless-utf16-be'; Encoding = (New-Object Text.UnicodeEncoding($true, $false, $true)) }
    )) {
        $bomlessPath = Join-Path $temporaryRoot ($bomlessCase.Name + '.txt')
        $bomlessValue = (('s' + 'k-') + ('n' * 24))
        [IO.File]::WriteAllBytes($bomlessPath, $bomlessCase.Encoding.GetBytes($bomlessValue))
        $result = Invoke-Scanner -Root $temporaryRoot
        Assert-Condition ($result.Code -eq 1) "$($bomlessCase.Name) must not hide a provider token behind NUL bytes."
        Assert-Condition ($result.Text.Contains("SECRET_SCAN_FILE=$($bomlessCase.Name).txt")) "$($bomlessCase.Name) needs the safe file marker."
        Assert-Condition (-not $result.Text.Contains($bomlessValue)) "$($bomlessCase.Name) must not disclose the value."
        Remove-Item -LiteralPath $bomlessPath -Force
        $passed++
        Write-Output "PASS: $($bomlessCase.Name) binary lane projection"
    }

    $oversizePath = Join-Path $temporaryRoot 'oversize.txt'
    $oversizeStream = New-Object IO.FileStream($oversizePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $oversizeStream.SetLength(8MB + 1) } finally { $oversizeStream.Dispose() }
    $result = Invoke-Scanner -Root $temporaryRoot
    Assert-Condition ($result.Code -eq 1) 'A file over the documented 8 MiB bound must fail closed.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_FAILED setup_or_execution')) 'An oversized file needs a generic failure marker.'
    Remove-Item -LiteralPath $oversizePath -Force
    $passed++
    Write-Output 'PASS: oversized files fail closed'

    $lockedPath = Join-Path $temporaryRoot 'locked.txt'
    Set-Content -LiteralPath $lockedPath -Value 'synthetic metadata without credentials' -NoNewline
    $lockedStream = New-Object IO.FileStream($lockedPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        $result = Invoke-Scanner -Root $temporaryRoot
    }
    finally {
        $lockedStream.Dispose()
    }
    Assert-Condition ($result.Code -eq 1) 'A read-denied or exclusively locked file must fail closed.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_FAILED setup_or_execution')) 'A read failure needs a generic failure marker.'
    Remove-Item -LiteralPath $lockedPath -Force
    $passed++
    Write-Output 'PASS: read failures fail closed'

    $resourceEncoding = New-Object Text.UTF8Encoding($false)

    $aggregateRoot = Join-Path $temporaryRoot 'resource-aggregate'
    New-Item -ItemType Directory -Path $aggregateRoot -ErrorAction Stop | Out-Null
    [IO.File]::WriteAllText((Join-Path $aggregateRoot 'a.txt'), 'abcdefghij', $resourceEncoding)
    [IO.File]::WriteAllText((Join-Path $aggregateRoot 'b.txt'), 'klmnopqrst', $resourceEncoding)
    $aggregateScanner = New-ScannerVariant -Name 'aggregate' -Replacements @{
        '$maximumAggregateBytes = 256MB' = '$maximumAggregateBytes = 16'
    }
    $result = Invoke-Scanner -Root $aggregateRoot -ScannerPath $aggregateScanner
    Assert-BoundFailure -Result $result -Root $aggregateRoot -Name 'The aggregate-byte bound'
    Remove-Item -LiteralPath $aggregateRoot -Recurse -Force
    $passed++
    Write-Output 'PASS: aggregate-byte bound fails closed'

    $fileCountRoot = Join-Path $temporaryRoot 'resource-file-count'
    New-Item -ItemType Directory -Path $fileCountRoot -ErrorAction Stop | Out-Null
    foreach ($name in @('a.txt', 'b.txt', 'c.txt')) {
        [IO.File]::WriteAllText((Join-Path $fileCountRoot $name), 'x', $resourceEncoding)
    }
    $fileCountScanner = New-ScannerVariant -Name 'file-count' -Replacements @{
        '$maximumFileCount = 50000' = '$maximumFileCount = 2'
    }
    $result = Invoke-Scanner -Root $fileCountRoot -ScannerPath $fileCountScanner
    Assert-BoundFailure -Result $result -Root $fileCountRoot -Name 'The file-count bound'
    Remove-Item -LiteralPath $fileCountRoot -Recurse -Force
    $passed++
    Write-Output 'PASS: file-count bound fails closed'

    $entryCountRoot = Join-Path $temporaryRoot 'resource-entry-count'
    New-Item -ItemType Directory -Path $entryCountRoot -ErrorAction Stop | Out-Null
    foreach ($name in @('a', 'b', 'c')) {
        New-Item -ItemType Directory -Path (Join-Path $entryCountRoot $name) -ErrorAction Stop | Out-Null
    }
    $entryCountScanner = New-ScannerVariant -Name 'entry-count' -Replacements @{
        '$maximumEntryCount = 100000' = '$maximumEntryCount = 2'
    }
    $result = Invoke-Scanner -Root $entryCountRoot -ScannerPath $entryCountScanner
    Assert-BoundFailure -Result $result -Root $entryCountRoot -Name 'The entry-count bound'
    Remove-Item -LiteralPath $entryCountRoot -Recurse -Force
    $passed++
    Write-Output 'PASS: entry-count bound fails closed'

    $pathLengthRoot = Join-Path $temporaryRoot 'resource-path-length'
    New-Item -ItemType Directory -Path $pathLengthRoot -ErrorAction Stop | Out-Null
    [IO.File]::WriteAllText((Join-Path $pathLengthRoot '123456789.txt'), 'x', $resourceEncoding)
    $pathLengthScanner = New-ScannerVariant -Name 'path-length' -Replacements @{
        '$maximumRelativePathCharacters = 4096' = '$maximumRelativePathCharacters = 8'
    }
    $result = Invoke-Scanner -Root $pathLengthRoot -ScannerPath $pathLengthScanner
    Assert-BoundFailure -Result $result -Root $pathLengthRoot -Name 'The relative-path bound'
    Remove-Item -LiteralPath $pathLengthRoot -Recurse -Force
    $passed++
    Write-Output 'PASS: relative-path bound fails closed'

    $elapsedRoot = Join-Path $temporaryRoot 'resource-elapsed'
    New-Item -ItemType Directory -Path $elapsedRoot -ErrorAction Stop | Out-Null
    [IO.File]::WriteAllText((Join-Path $elapsedRoot 'candidate.txt'), 'x', $resourceEncoding)
    $elapsedScanner = New-ScannerVariant -Name 'elapsed' -Replacements @{
        '$maximumCooperativeElapsedSeconds = 300' = '$maximumCooperativeElapsedSeconds = 0'
    }
    $result = Invoke-Scanner -Root $elapsedRoot -ScannerPath $elapsedScanner
    Assert-BoundFailure -Result $result -Root $elapsedRoot -Name 'The elapsed-time bound'
    Remove-Item -LiteralPath $elapsedRoot -Recurse -Force
    $passed++
    Write-Output 'PASS: elapsed-time bound fails closed'

    $regexTimeoutRoot = Join-Path $temporaryRoot 'resource-regex-timeout'
    New-Item -ItemType Directory -Path $regexTimeoutRoot -ErrorAction Stop | Out-Null
    [IO.File]::WriteAllText((Join-Path $regexTimeoutRoot 'candidate.txt'), ('password' + ('a' * 200000) + '!'), $resourceEncoding)
    $regexTimeoutScanner = New-ScannerVariant -Name 'regex-timeout' -Replacements @{
        '$allTextPattern = ''(?:'' + $environmentQuotedAssignment + ''|'' + $declaredQuotedAssignment + ''|'' + $bareQuotedAssignment + ''|'' + $bareQuotedProperty + ''|'' + $exportUnquotedAssignment + ''|'' + $powerShellEnvironmentQuotedAssignment + ''|'' + $cmdEnvironmentAssignment + ''|'' + $cmdWrappedEnvironmentAssignment + ''|'' + $providerShape + '')''' = '$allTextPattern = ''^password(a+)+$'''
        '$regexTimeout = [TimeSpan]::FromSeconds(2)' = '$regexTimeout = [TimeSpan]::FromMilliseconds(1)'
    }
    $result = Invoke-Scanner -Root $regexTimeoutRoot -ScannerPath $regexTimeoutScanner
    Assert-BoundFailure -Result $result -Root $regexTimeoutRoot -Name 'The regex timeout'
    Remove-Item -LiteralPath $regexTimeoutRoot -Recurse -Force
    $passed++
    Write-Output 'PASS: regex timeout fails closed'

    $orderDirectory = Join-Path $temporaryRoot 'ordering'
    New-Item -ItemType Directory -Path $orderDirectory -ErrorAction Stop | Out-Null
    Set-Content -LiteralPath (Join-Path $orderDirectory 'z.env') -Value (('API_' + 'KEY') + '=' + ('v' * 24)) -NoNewline
    Set-Content -LiteralPath (Join-Path $orderDirectory 'a.env') -Value (('API_' + 'KEY') + '=' + ('w' * 24)) -NoNewline
    $result = Invoke-Scanner -Root $temporaryRoot
    $findingLines = @($result.Text -split '\r?\n' | Where-Object { $_ -match '^SECRET_SCAN_FILE=' })
    Assert-Condition ($result.Code -eq 1) 'Multiple findings must fail.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_FINDINGS=2')) 'Each file must be deduplicated to one finding.'
    Assert-Condition (($findingLines.Count -eq 2) -and ($findingLines[0] -eq 'SECRET_SCAN_FILE=ordering/a.env') -and ($findingLines[1] -eq 'SECRET_SCAN_FILE=ordering/z.env')) 'Finding paths must use deterministic ordinal order.'
    Remove-Item -LiteralPath $orderDirectory -Recurse -Force
    $passed++
    Write-Output 'PASS: findings are deduplicated and deterministically ordered'

    $deepRoot = Join-Path $temporaryRoot 'deep'
    New-Item -ItemType Directory -Path $deepRoot -ErrorAction Stop | Out-Null
    $deepCursor = $deepRoot
    for ($depth = 0; $depth -lt 66; $depth++) {
        $deepCursor = Join-Path $deepCursor 'd'
        New-Item -ItemType Directory -Path $deepCursor -ErrorAction Stop | Out-Null
    }
    $result = Invoke-Scanner -Root $temporaryRoot
    Assert-Condition ($result.Code -eq 1) 'A tree over the fixed depth bound must fail closed.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_FAILED setup_or_execution')) 'A depth failure needs a generic marker.'
    Remove-Item -LiteralPath $deepRoot -Recurse -Force
    $passed++
    Write-Output 'PASS: repository depth is bounded'

    $outsideRoot = Join-Path ([IO.Path]::GetTempPath()) ("keyatlas-secret-outside-$([Guid]::NewGuid().ToString('N'))")
    $junctionPath = Join-Path $temporaryRoot 'junction'
    $rootJunction = $null
    try {
        New-Item -ItemType Directory -Path $outsideRoot -ErrorAction Stop | Out-Null
        Set-Content -LiteralPath (Join-Path $outsideRoot 'outside.txt') -Value (('s' + 'k-') + ('x' * 24)) -NoNewline
        New-TestJunction -Path $junctionPath -Target $outsideRoot
        $result = Invoke-Scanner -Root $temporaryRoot
        Assert-Condition ($result.Code -eq 1) 'An in-scope junction must fail instead of being followed.'
        Assert-Condition ($result.Text.Contains('SECRET_SCAN_FAILED setup_or_execution')) 'A reparse failure needs a generic marker.'
        Assert-Condition (-not $result.Text.Contains('outside.txt')) 'No outside path may be disclosed.'
        Remove-TestJunction -Path $junctionPath

        $rootJunction = Join-Path ([IO.Path]::GetTempPath()) ("keyatlas-secret-root-link-$([Guid]::NewGuid().ToString('N'))")
        New-TestJunction -Path $rootJunction -Target $outsideRoot
        $result = Invoke-Scanner -Root $rootJunction
        Assert-Condition ($result.Code -eq 1) 'A reparse-point root must fail closed.'
        Assert-Condition ($result.Text.Contains('SECRET_SCAN_FAILED setup_or_execution')) 'A reparse root needs a generic marker.'
        Remove-TestJunction -Path $rootJunction
        $passed++
        Write-Output 'PASS: reparse roots and descendants fail without traversal'
    }
    finally {
        if (Test-Path -LiteralPath $junctionPath) { Remove-TestJunction -Path $junctionPath }
        if (($null -ne $rootJunction) -and (Test-Path -LiteralPath $rootJunction)) { Remove-TestJunction -Path $rootJunction }
        if (Test-Path -LiteralPath $outsideRoot) { Remove-Item -LiteralPath $outsideRoot -Recurse -Force }
    }

    $result = Invoke-Scanner -Root $fixture
    Assert-Condition ($result.Code -eq 1) 'A file passed as the root must fail closed.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_FAILED setup_or_execution')) 'An invalid root needs a generic failure marker.'
    $passed++
    Write-Output 'PASS: scan root must be a regular directory'

    Write-Output "SECRET_SCANNER_TESTS_PASSED=$passed"
}
catch {
    Write-Output "FAIL: $($_.Exception.Message)"
    exit 1
}
finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}
