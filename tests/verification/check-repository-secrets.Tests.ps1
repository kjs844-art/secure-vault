#requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$scanner = Join-Path $repositoryRoot 'scripts\check-repository-secrets.ps1'
$engine = (Get-Process -Id $PID).Path
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("keyatlas-secret-scan-$([Guid]::NewGuid().ToString('N'))")
$originalPath = $env:PATH
$originalRgMode = $env:KEYATLAS_TEST_RG_MODE
$passed = 0

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) {
        throw $Message
    }
}

function Invoke-Scanner {
    param([string]$Root)
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& $engine -NoProfile -NonInteractive -File $scanner -Root $Root 2>&1)
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $savedPreference
    }
    [pscustomobject]@{ Code = $code; Text = ($lines -join "`n") }
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

    $workspaceMarker = Join-Path $temporaryRoot 'Cargo.toml'
    Set-Content -LiteralPath $workspaceMarker -Value '[workspace]' -NoNewline
    $result = Invoke-Scanner -Root $temporaryRoot
    Assert-Condition ($result.Code -eq 1) 'A repository scan with a missing baseline must fail.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_FAILED setup_or_execution')) 'A missing baseline needs a generic integrity failure.'
    Assert-Condition (-not $result.Text.Contains('SECRET_SCAN_PASSED')) 'A missing baseline must not produce a success marker.'
    Remove-Item -LiteralPath $workspaceMarker -Force
    $passed++
    Write-Output 'PASS: missing repository baseline fails closed'

    $toolDirectory = Join-Path $temporaryRoot 'tool-fixture'
    New-Item -ItemType Directory -Path $toolDirectory -ErrorAction Stop | Out-Null
    $rgFixture = @'
@echo off
if "%KEYATLAS_TEST_RG_MODE%"=="stdout-exit-one" (
    echo .\synthetic-candidate.txt
    exit /b 1
)
exit /b 23
'@
    Set-Content -LiteralPath (Join-Path $toolDirectory 'rg.cmd') -Value $rgFixture -NoNewline
    Set-Content -LiteralPath $fixture -Value 'synthetic metadata without credentials' -NoNewline
    $env:PATH = $toolDirectory
    $env:KEYATLAS_TEST_RG_MODE = 'stdout-exit-one'
    $result = Invoke-Scanner -Root $temporaryRoot
    Assert-Condition ($result.Code -eq 1) 'Output paired with a no-match exit must fail closed.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_FAILED setup_or_execution')) 'Contradictory scanner output needs a generic failure.'
    Assert-Condition (-not $result.Text.Contains('SECRET_SCAN_PASSED')) 'Contradictory scanner output must never produce a success marker.'
    $passed++
    Write-Output 'PASS: output with no-match exit fails closed'

    $env:KEYATLAS_TEST_RG_MODE = ''
    $result = Invoke-Scanner -Root $temporaryRoot
    Assert-Condition ($result.Code -eq 1) 'An unknown scanner exit must fail closed.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_FAILED scanner_exit=23')) 'The scanner exit code must be classified without stderr disclosure.'
    Assert-Condition (-not $result.Text.Contains('SECRET_SCAN_PASSED')) 'A scanner error must never produce a success marker.'
    $passed++
    Write-Output 'PASS: scanner error fails closed'

    $env:PATH = ''
    $result = Invoke-Scanner -Root $temporaryRoot
    Assert-Condition ($result.Code -eq 1) 'A missing scanner must fail closed.'
    Assert-Condition ($result.Text.Contains('SECRET_SCAN_FAILED setup_or_execution')) 'A missing scanner needs a generic setup failure.'
    Assert-Condition (-not $result.Text.Contains('SECRET_SCAN_PASSED')) 'A missing scanner must never produce a success marker.'
    $passed++
    Write-Output 'PASS: missing scanner fails closed'

    Write-Output "SECRET_SCANNER_TESTS_PASSED=$passed"
}
catch {
    Write-Output "FAIL: $($_.Exception.Message)"
    exit 1
}
finally {
    $env:PATH = $originalPath
    $env:KEYATLAS_TEST_RG_MODE = $originalRgMode
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}
