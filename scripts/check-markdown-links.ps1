[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Root,[switch]$IncludeFixtures)
$resolvedRoot=(Resolve-Path -LiteralPath $Root).Path
$rootItem=Get-Item -LiteralPath $resolvedRoot
$files=if($rootItem.PSIsContainer){Get-ChildItem -LiteralPath $resolvedRoot -Recurse -File -Filter '*.md'}else{@($rootItem)}
$files=$files | Where-Object {$IncludeFixtures -or $_.FullName -notmatch '[\\/]tests[\\/]fixtures[\\/]'}
$pattern='\[[^\]]+\]\(([^)]+)\)'; $failures=@()
foreach($file in $files){$lineNo=0; foreach($line in Get-Content -LiteralPath $file.FullName){$lineNo++; foreach($m in [regex]::Matches($line,$pattern)){$target=$m.Groups[1].Value.Trim().Split('#')[0]; if([string]::IsNullOrWhiteSpace($target) -or $target -match '^(https?:|mailto:|#)'){continue}; $candidate=Join-Path $file.DirectoryName $target; if(-not(Test-Path -LiteralPath $candidate)){$failures += "{0}:{1} -> {2}" -f $file.FullName,$lineNo,$target}}}}
if($failures.Count -gt 0){$failures | ForEach-Object {Write-Error $_}; exit 1}; Write-Output "Markdown relative links OK: $($files.Count) files checked"; exit 0
