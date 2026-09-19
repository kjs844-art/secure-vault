$scriptPath = Join-Path $PSScriptRoot '..\..\scripts\check-markdown-links.ps1'
$fixtureRoot = Join-Path $PSScriptRoot '..\fixtures\synthetic\link-check'
$runner = Get-Command pwsh -ErrorAction SilentlyContinue

if (-not $runner) {
    $runner = Get-Command powershell -ErrorAction Stop
}

# The checker is a command-line script and intentionally calls `exit` so CI can
# consume its status. Run it in a child PowerShell process; invoking it directly
# would terminate this regression test after the first fixture.
& $runner.Source -NoProfile -File $scriptPath -Root (Join-Path $fixtureRoot 'ok.md') -IncludeFixtures
if ($LASTEXITCODE -ne 0) {
    throw 'valid fixture failed'
}

& $runner.Source -NoProfile -File $scriptPath -Root $fixtureRoot
if ($LASTEXITCODE -ne 0) {
    throw 'fixtures were not excluded by default'
}

& $runner.Source -NoProfile -File $scriptPath -Root (Join-Path $fixtureRoot 'broken.md') -IncludeFixtures 2>$null
if ($LASTEXITCODE -ne 1) {
    throw 'broken fixture passed'
}

Write-Output 'Markdown link checker regression OK: valid=0 broken=1'
exit 0
