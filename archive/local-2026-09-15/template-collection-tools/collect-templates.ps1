param(
    [string]$Destination = 'C:\Users\USER\Desktop\PersonalProJect\KeyAtlas\템플릿모음_2026-09-12'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$expectedParent = [IO.Path]::GetFullPath('C:\Users\USER\Desktop\PersonalProJect\KeyAtlas')
$resolved = [IO.Path]::GetFullPath($Destination)
if ([IO.Path]::GetDirectoryName($resolved) -ne $expectedParent) { throw 'Unexpected collection destination.' }
New-Item -ItemType Directory -Path $resolved -Force | Out-Null
$headers = @{ 'User-Agent' = 'KeyAtlas-template-collection'; Accept = 'application/vnd.github+json' }
$items = @(
    @{ id='01-shadcn-admin'; name='shadcn-admin'; repo='satnaing/shadcn-admin'; demo='https://shadcn-admin.netlify.app/'; license='MIT'; note='Dashboard UI source; upstream explicitly says it is not a complete starter template.' },
    @{ id='02-tailadmin-react'; name='TailAdmin React Free'; repo='TailAdmin/free-react-tailwind-admin-dashboard'; demo='https://react-demo.tailadmin.com/'; license='MIT'; note='Free edition only. Advanced PRO pages are not included. Review chart/dependency licenses before shipping.' },
    @{ id='03-flowbite-admin'; name='Flowbite Admin Dashboard'; repo='themesberg/flowbite-admin-dashboard'; demo='https://flowbite-admin-dashboard.vercel.app/'; license='MIT'; note='HTML/Tailwind dashboard; not a React application. Dependencies and demo images require separate review.' },
    @{ id='04-coreui-react'; name='CoreUI Free React Admin'; repo='coreui/coreui-free-react-admin-template'; demo='https://coreui.io/demos/react/free/'; license='MIT'; note='Free React template; commercial PRO resources are not included.' },
    @{ id='05-mantis-react'; name='Mantis Free React'; repo='codedthemes/mantis-free-react-admin-template'; demo='https://mantisdashboard.io/free/'; license='MIT'; note='React/MUI free template. Review fonts, images and chart dependencies separately.' },
    @{ id='06-berry-react'; name='Berry Free React'; repo='codedthemes/berry-free-react-admin-template'; demo='https://berrydashboard.io/free/'; license='MIT'; note='Root code MIT; ApexCharts dependencies may require separate commercial/OEM licensing. Do not assume all dependencies are MIT.' },
    @{ id='07-tabler'; name='Tabler'; repo='tabler/tabler'; demo='https://preview.tabler.io/'; license='MIT'; note='Core UI MIT; third-party libraries/assets have separate terms, including recent ApexCharts. Source archive only, not a compiled website.' },
    @{ id='08-editorial'; name='HTML5 UP Editorial'; download='https://html5up.net/editorial/download'; demo='https://html5up.net/uploads/demos/editorial/'; license='CC-BY-3.0'; note='Keep HTML5 UP design attribution. Demo photos carry separate provenance; replace or verify them before release.' },
    @{ id='09-tailwind-landing'; name='Tailwind Toolbox Landing Page'; repo='tailwindtoolbox/Landing-Page'; demo='https://tailwindtoolbox.github.io/Landing-Page/'; license='MIT'; note='Template code MIT. Freepik hero and unDraw demo assets have attribution/asset-specific conditions; preserve credits or replace assets.' },
    @{ id='10-sb-admin-2'; name='Start Bootstrap SB Admin 2'; repo='StartBootstrap/startbootstrap-sb-admin-2'; demo='https://startbootstrap.github.io/startbootstrap-sb-admin-2/'; license='MIT'; note='Bootstrap/jQuery generation; useful layout source, not a drop-in modern React app. Audit/replace legacy dependencies before deployment.' }
)
$report = @()
Add-Type -AssemblyName System.IO.Compression.FileSystem
foreach ($item in $items) {
    $folder = Join-Path $resolved $item.id
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
    $entry = [ordered]@{ id=$item.id; name=$item.name; expected_license=$item.license; note=$item.note; demo=$item.demo; status='pending'; fetched_at_utc=[DateTime]::UtcNow.ToString('o') }
    try {
        if ($item.repo) {
            $metadata = Invoke-RestMethod -Uri ('https://api.github.com/repos/' + $item.repo) -Headers $headers -TimeoutSec 25
            $commit = Invoke-RestMethod -Uri ('https://api.github.com/repos/' + $item.repo + '/commits/' + $metadata.default_branch) -Headers $headers -TimeoutSec 25
            if ($commit.sha -notmatch '^[a-f0-9]{40}$') { throw 'Invalid commit SHA.' }
            $entry['source'] = $metadata.html_url
            $entry['commit'] = $commit.sha
            $entry['reported_license'] = $metadata.license.spdx_id
            $url = 'https://codeload.github.com/' + $item.repo + '/zip/' + $commit.sha
        } else { $entry['source']='https://html5up.net/editorial'; $url=$item.download }
        $zipPath = Join-Path $folder 'original-source.zip'
        $entry['archive_url'] = $url
        if (-not (Test-Path -LiteralPath $zipPath)) {
            Invoke-WebRequest -Uri $url -Headers @{ 'User-Agent'='KeyAtlas-template-collection' } -OutFile $zipPath -TimeoutSec 60 -UseBasicParsing
        }
        $archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
        try {
            $files = @($archive.Entries | Where-Object { -not $_.FullName.EndsWith('/') })
            $unsafe = @($files | Where-Object { $_.FullName -match '(^/|^[A-Za-z]:|(^|[/\\])\.\.([/\\]|$))' })
            if ($unsafe.Count) { throw 'Unsafe archive path; no extraction performed.' }
            $licenses = @($files | Where-Object { $_.Name -match '^(LICENSE|LICENCE|COPYING)(\..*)?$' })
            if (-not $licenses.Count) { throw 'No license file in archive; manual review required.' }
            $license = $licenses | Sort-Object { $_.FullName.Length } | Select-Object -First 1
            $reader = New-Object IO.StreamReader($license.Open())
            try { $licenseText = $reader.ReadToEnd() } finally { $reader.Dispose() }
            [IO.File]::WriteAllText((Join-Path $folder 'LICENSE-UPSTREAM.txt'),$licenseText,(New-Object Text.UTF8Encoding($false)))
            $entry['license_archive_path']=$license.FullName
            $entry['archive_file_count']=$files.Count
            $entry['expanded_bytes']=($files | Measure-Object -Property Length -Sum).Sum
            $entry['source_files']=@($files | Where-Object { $_.FullName -match '\.(html|tsx|jsx|css|scss|js|ts)$' } | Select-Object -First 8 -ExpandProperty FullName)
        } finally { $archive.Dispose() }
        $entry['archive_bytes']=(Get-Item -LiteralPath $zipPath).Length
        $entry['sha256']=(Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $entry['status']='downloaded-source-only'
        Write-Output ('COLLECTED ' + $item.id + ' bytes=' + $entry.archive_bytes)
    } catch {
        $entry['status']='needs-review'
        $entry['failure']=$_.Exception.Message
        Write-Output ('NEEDS_REVIEW ' + $item.id)
    }
    [IO.File]::WriteAllText((Join-Path $folder 'SOURCE.json'),($entry | ConvertTo-Json -Depth 6),(New-Object Text.UTF8Encoding($false)))
    $report += [pscustomobject]$entry
    [IO.File]::WriteAllText((Join-Path $resolved 'MANIFEST.json'),(ConvertTo-Json -InputObject $report -Depth 6),(New-Object Text.UTF8Encoding($false)))
}
Write-Output ('COLLECTION_RESULT ' + ($report | Group-Object status | Select-Object Name,Count | ConvertTo-Json -Compress))
if (@($report | Where-Object status -ne 'downloaded-source-only').Count) { exit 1 }
exit 0
