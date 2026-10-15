#requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Only the ephemeral Actions runner may change its module repository registration.
# Local tests shadow and mock the repository commands; do not run this helper locally.
if ($env:GITHUB_ACTIONS -cne 'true') {
    throw 'CI_PSGALLERY_RUNNER_ONLY'
}

try {
    # A failed query is not an absent repository. Only a successful empty result
    # permits registering the built-in default; never replace an existing source.
    $gallery = @(Get-PSRepository -ErrorAction Stop -WarningAction SilentlyContinue | Where-Object {
        [string]::Equals($_.Name, 'PSGallery', [StringComparison]::OrdinalIgnoreCase)
    })
    if ($gallery.Count -eq 0) {
        Register-PSRepository -Default -ErrorAction Stop | Out-Null
        $gallery = @(Get-PSRepository -ErrorAction Stop -WarningAction SilentlyContinue | Where-Object {
            [string]::Equals($_.Name, 'PSGallery', [StringComparison]::OrdinalIgnoreCase)
        })
    }

    if ($gallery.Count -ne 1 -or
        -not [string]::Equals($gallery[0].SourceLocation, 'https://www.powershellgallery.com/api/v2', [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($gallery[0].PackageManagementProvider, 'NuGet', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'CI_PSGALLERY_INVALID_REGISTRATION'
    }
}
catch {
    # Do not print configured URLs or the original provider exception.
    throw 'CI_PSGALLERY_PREPARATION_FAILED'
}

Write-Output 'CI_PSGALLERY_READY'
