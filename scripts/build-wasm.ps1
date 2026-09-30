param(
    [switch]$SyntheticDemo,
    [switch]$Release,
    [string]$BindgenPath = $env:KEYATLAS_WASM_BINDGEN
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$expectedVersion = 'wasm-bindgen 0.2.128'
if (-not $BindgenPath) {
    $localTool = Join-Path $env:LOCALAPPDATA 'KeyAtlas\build-tools\wasm-bindgen-0.2.128\wasm-bindgen-0.2.128-x86_64-pc-windows-msvc\wasm-bindgen.exe'
    if (Test-Path -LiteralPath $localTool) { $BindgenPath = $localTool }
    else { $BindgenPath = 'wasm-bindgen' }
}
Push-Location $repo
try {
    $version = & $BindgenPath --version
    if ($LASTEXITCODE -ne 0 -or $version.Trim() -ne $expectedVersion) {
        throw "Expected $expectedVersion. Install the matching official CLI."
    }
    $buildArgs = @('build', '-p', 'vault-client-wasm', '--locked', '--offline', '--target', 'wasm32-unknown-unknown')
    if ($SyntheticDemo) { $buildArgs += @('--features', 'synthetic-demo') }
    if ($Release) { $buildArgs += '--release' }
    & cargo @buildArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $metadataJson = & cargo metadata --no-deps --format-version 1 --locked --offline
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $metadata = $metadataJson | ConvertFrom-Json
    $profile = if ($Release) { 'release' } else { 'debug' }
    $inputPath = Join-Path $metadata.target_directory "wasm32-unknown-unknown\$profile\vault_client_wasm.wasm"
    $folder = if ($SyntheticDemo) { 'vault-wasm-demo' } else { 'vault-wasm' }
    $outPath = Join-Path $repo "apps\web\src\generated\$folder"
    & $BindgenPath $inputPath --target web --out-dir $outPath --out-name vault_client_wasm --typescript
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Output "WASM_BUILD_OK mode=$folder profile=$profile output=$outPath"
}
finally { Pop-Location }
