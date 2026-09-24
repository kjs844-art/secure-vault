#requires -Version 5.1

Describe 'KeyAtlas security-gates workflow policy' {
    BeforeAll {
        $script:RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
        $script:WorkflowPath = Join-Path $script:RepositoryRoot '.github\workflows\security-gates.yml'
        if (-not (Test-Path -LiteralPath $script:WorkflowPath -PathType Leaf)) {
            throw 'The mandatory security-gates workflow is missing.'
        }

        $script:Workflow = Get-Content -Raw -LiteralPath $script:WorkflowPath
        if ([string]::IsNullOrWhiteSpace($script:Workflow)) {
            throw 'The mandatory security-gates workflow is empty.'
        }

        $script:ScannerPath = Join-Path $script:RepositoryRoot 'scripts\check-repository-secrets.ps1'
        if (-not (Test-Path -LiteralPath $script:ScannerPath -PathType Leaf)) {
            throw 'The mandatory repository Secret scanner is missing.'
        }
        $script:Scanner = Get-Content -Raw -LiteralPath $script:ScannerPath

        $script:ReleaseManifestToolPath = Join-Path $script:RepositoryRoot 'scripts\new-release-artifact-manifest.ps1'
        $script:ReleaseManifestTestPath = Join-Path $script:RepositoryRoot 'tests\verification\new-release-artifact-manifest.Tests.ps1'
        if (-not (Test-Path -LiteralPath $script:ReleaseManifestToolPath -PathType Leaf)) {
            throw 'The release manifest tool is missing.'
        }
        if (-not (Test-Path -LiteralPath $script:ReleaseManifestTestPath -PathType Leaf)) {
            throw 'The release manifest regression is missing.'
        }

        function Assert-Condition {
            param([bool]$Condition, [string]$Message)
            if (-not $Condition) { throw $Message }
        }

        function Assert-PinnedRustProvisioning {
            param([string]$Workflow)
            $commands = @([regex]::Matches($Workflow, '(?m)^\s*run: (rustup toolchain install[^\r\n]*)\s*$'))
            Assert-Condition ($commands.Count -eq 1) 'Exactly one Rust toolchain provisioning command is required.'
            $expected = 'rustup toolchain install 1.95.0 --profile minimal --component clippy --component rustfmt --target wasm32-unknown-unknown'
            Assert-Condition ([string]::Equals($commands[0].Groups[1].Value.Trim(), $expected, [StringComparison]::Ordinal)) 'Rust provisioning must pin the toolchain and pass each component with its own option.'
        }

        function Get-WorkflowStepBlock {
            param(
                [Parameter(Mandatory = $true)][string]$Workflow,
                [Parameter(Mandatory = $true)][string]$Name
            )
            $pattern = '(?ms)^      - name: ' + [regex]::Escape($Name) + '\r?\n(?<body>.*?)(?=^      - name: |\z)'
            return @([regex]::Matches($Workflow, $pattern))
        }

        function Assert-ReleaseManifestStep {
            param(
                [Parameter(Mandatory = $true)][string]$Workflow,
                [Parameter(Mandatory = $true)][string]$Name,
                [Parameter(Mandatory = $true)][string]$EngineCommand,
                [Parameter(Mandatory = $true)][string]$MarkerFailure
            )
            $matches = Get-WorkflowStepBlock -Workflow $Workflow -Name $Name
            Assert-Condition ($matches.Count -eq 1) "Exactly one workflow step is required: $Name"
            $block = $matches[0].Value
            Assert-Condition (([regex]::Matches($block, '(?m)^        shell: pwsh\s*$')).Count -eq 1) "$Name must use the reviewed pwsh shell."
            Assert-Condition (([regex]::Matches($block, '(?m)^        timeout-minutes: 10\s*$')).Count -eq 1) "$Name needs one runner-owned 10-minute timeout."
            Assert-Condition (([regex]::Matches($block, '(?m)^        run: \|\s*$')).Count -eq 1) "$Name must use the fail-closed command block."
            Assert-Condition ($block.Contains('$PSNativeCommandUseErrorActionPreference = $false')) "$Name must capture native exit codes explicitly."
            Assert-Condition ($block.Contains($EngineCommand)) "$Name uses the wrong engine command."
            Assert-Condition ($block.Contains('$testExit = $LASTEXITCODE')) "$Name must capture the engine exit code."
            Assert-Condition ($block.Contains('if (($null -eq $testExit) -or ($testExit -ne 0))')) "$Name must fail on a null or nonzero exit code."
            Assert-Condition ($block.Contains("`$_ -ceq 'RELEASE_MANIFEST_TESTS_PASSED=10'")) "$Name must require the exact success marker."
            Assert-Condition ($block.Contains(').Count -ne 1)')) "$Name must reject a missing or duplicated success marker."
            Assert-Condition ($block.Contains($MarkerFailure)) "$Name must retain its engine-specific marker failure."
            return $block
        }

        function Assert-ReleaseManifestWorkflowPolicy {
            param([Parameter(Mandatory = $true)][string]$Workflow)
            $powerShell7Name = 'Exercise release artifact manifest regressions with PowerShell 7'
            $windowsPowerShellName = 'Exercise release artifact manifest regressions with Windows PowerShell 5.1'
            [void](Assert-ReleaseManifestStep -Workflow $Workflow -Name $powerShell7Name -EngineCommand '& pwsh -NoProfile -NonInteractive -File .\tests\verification\new-release-artifact-manifest.Tests.ps1 2>&1' -MarkerFailure 'The PowerShell 7 release manifest tests did not emit exactly one success marker.')
            [void](Assert-ReleaseManifestStep -Workflow $Workflow -Name $windowsPowerShellName -EngineCommand '& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\tests\verification\new-release-artifact-manifest.Tests.ps1 2>&1' -MarkerFailure 'The Windows PowerShell 5.1 release manifest tests did not emit exactly one success marker.')
            Assert-Condition (([regex]::Matches($Workflow, [regex]::Escape('.\tests\verification\new-release-artifact-manifest.Tests.ps1'))).Count -eq 2) 'The manifest regression path must occur exactly once per engine.'

            $scanIndex = $Workflow.IndexOf('- name: Reject repository Secret material before dependency execution', [StringComparison]::Ordinal)
            $scanner7Index = $Workflow.IndexOf('- name: Exercise Secret scanner regressions with PowerShell 7', [StringComparison]::Ordinal)
            $scanner51Index = $Workflow.IndexOf('- name: Exercise Secret scanner regressions with Windows PowerShell 5.1', [StringComparison]::Ordinal)
            $manifest7Index = $Workflow.IndexOf("- name: $powerShell7Name", [StringComparison]::Ordinal)
            $manifest51Index = $Workflow.IndexOf("- name: $windowsPowerShellName", [StringComparison]::Ordinal)
            $dependencyIndex = $Workflow.IndexOf('- name: Install pinned Pester for workflow policy checks', [StringComparison]::Ordinal)
            Assert-Condition ($scanIndex -ge 0 -and $scanIndex -lt $scanner7Index -and $scanner7Index -lt $scanner51Index -and $scanner51Index -lt $manifest7Index -and $manifest7Index -lt $manifest51Index -and $manifest51Index -lt $dependencyIndex) 'The Secret-first scanner, manifest, and dependency order changed.'
        }
    }

    It 'uses only safe unprivileged triggers and least permissions' {
        Assert-Condition ($script:Workflow -match '(?m)^on:\s*$') 'The workflow trigger block is missing.'
        Assert-Condition ($script:Workflow -match '(?m)^  pull_request:\s*$') 'The pull_request trigger is missing.'
        Assert-Condition ($script:Workflow -match '(?m)^  push:\s*$') 'The push trigger is missing.'
        Assert-Condition ($script:Workflow -match '(?m)^  workflow_dispatch:\s*$') 'The manual trigger is missing.'
        Assert-Condition (-not ($script:Workflow -match '(?m)^\s*(pull_request_target|workflow_run|repository_dispatch|schedule):')) 'A privileged or unrelated trigger is forbidden.'

        Assert-Condition (([regex]::Matches($script:Workflow, '(?m)^permissions:\s*$')).Count -eq 1) 'Exactly one permissions block is required.'
        Assert-Condition ($script:Workflow -match '(?m)^permissions:\s*\r?\n  contents: read\s*$') 'Only contents read permission is allowed.'
        Assert-Condition (-not ($script:Workflow -match '(?m)^\s+[A-Za-z-]+:\s*write\s*$')) 'Write permissions are forbidden.'
        Assert-Condition (-not ($script:Workflow -match '\$\{\{\s*secrets\.')) 'GitHub Secret references are forbidden.'
    }

    It 'cancels superseded runs and has a finite timeout' {
        Assert-Condition ($script:Workflow -match '(?m)^concurrency:\s*$') 'The concurrency block is missing.'
        Assert-Condition ($script:Workflow -match '(?m)^  cancel-in-progress: true\s*$') 'Superseded runs must be cancelled.'
        Assert-Condition ($script:Workflow -match '(?m)^    runs-on: windows-latest\s*$') 'The Windows runner is mandatory.'
        Assert-Condition ($script:Workflow -match '(?m)^    timeout-minutes: 90\s*$') 'The finite job timeout is mandatory.'
    }

    It 'pins every allowed official action to the reviewed full commit SHA' {
        $uses = @([regex]::Matches($script:Workflow, '(?m)^\s*uses:\s*([^\s#]+)'))
        Assert-Condition ($uses.Count -eq 2) 'Exactly two reviewed actions are allowed.'
        $actualUses = @($uses | ForEach-Object { $_.Groups[1].Value }) -join "`n"
        $expectedUses = @(
            'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'
            'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020'
        ) -join "`n"
        Assert-Condition ([string]::Equals($actualUses, $expectedUses, [StringComparison]::Ordinal)) 'The action allowlist or pinned SHA changed.'
        foreach ($use in $uses) {
            Assert-Condition ($use.Groups[1].Value -match '^actions/(checkout|setup-node)@[0-9a-f]{40}$') 'Every action must use an official allowlisted owner and a full SHA.'
        }
        Assert-Condition ($script:Workflow -match '(?m)^          persist-credentials: false\s*$') 'Checkout credentials must not persist.'
        Assert-Condition ($script:Workflow -match '(?m)^          package-manager-cache: false\s*$') 'Automatic package caching must remain disabled.'
        Assert-Condition ($script:Workflow -match '(?m)^          node-version: 24\.8\.0\s*$') 'The exact Node.js version must remain pinned.'
        Assert-Condition ($script:Workflow -match '(?m)^\s*run: Install-Module -Name Pester -RequiredVersion 5\.7\.1 -Scope CurrentUser -Repository PSGallery -Force\s*$') 'The exact Pester installation version must remain pinned.'
        Assert-Condition ($script:Workflow -match '(?m)^\s*Import-Module Pester -RequiredVersion 5\.7\.1 -Force\s*$') 'The exact Pester import version must remain pinned.'
    }

    It 'runs the fail-closed repository scan before dependency setup or execution' {
        $scanIndex = $script:Workflow.IndexOf('.\scripts\check-repository-secrets.ps1', [StringComparison]::Ordinal)
        Assert-Condition ($scanIndex -gt -1) 'The repository Secret scanner invocation is missing.'

        foreach ($dependencyMarker in @(
            'Install-Module -Name Pester',
            'rustup toolchain install',
            'cargo fetch --locked',
            'cargo install wasm-bindgen-cli',
            'actions/setup-node@',
            'npm ci --ignore-scripts'
        )) {
            $dependencyIndex = $script:Workflow.IndexOf($dependencyMarker, [StringComparison]::Ordinal)
            Assert-Condition ($dependencyIndex -gt $scanIndex) "Dependency setup must follow the Secret scan: $dependencyMarker"
        }

        Assert-Condition ($script:Workflow -match "'SECRET_SCAN_PASSED'") 'The scan success marker must be verified.'
        Assert-Condition ($script:Workflow -match "'REAL_SECRET_GATE=CLOSED'") 'The real-Secret boundary marker must be verified.'
    }

    It 'runs scanner regressions on both Windows PowerShell engines' {
        Assert-Condition ($script:Workflow -match '(?m)^\s*run: pwsh -NoProfile -NonInteractive -File \.\\tests\\verification\\check-repository-secrets\.Tests\.ps1\s*$') 'PowerShell 7 scanner regression is missing.'
        Assert-Condition ($script:Workflow -match '(?m)^\s*run: powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \.\\tests\\verification\\check-repository-secrets\.Tests\.ps1\s*$') 'Windows PowerShell 5.1 scanner regression is missing.'
    }

    It 'runs release manifest regressions after the Secret gate with runner-owned timeouts' {
        Assert-ReleaseManifestWorkflowPolicy $script:Workflow
    }

    It 'rejects weakened release manifest timeout, marker, engine, and order policy' {
        $mutations = @(
            $script:Workflow.Replace('        timeout-minutes: 10', '        timeout-minutes: 11'),
            $script:Workflow.Replace('RELEASE_MANIFEST_TESTS_PASSED=10', 'RELEASE_MANIFEST_TESTS_PASSED=9'),
            $script:Workflow.Replace('powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\tests\verification\new-release-artifact-manifest.Tests.ps1', 'powershell.exe -NoProfile -NonInteractive -File .\tests\verification\new-release-artifact-manifest.Tests.ps1'),
            $script:Workflow.Replace('- name: Exercise release artifact manifest regressions with PowerShell 7', '- name: Install pinned Pester for workflow policy checks').Replace('- name: Install pinned Pester for workflow policy checks', '- name: Exercise release artifact manifest regressions with PowerShell 7')
        )
        foreach ($mutation in $mutations) {
            $rejected = $false
            try { Assert-ReleaseManifestWorkflowPolicy $mutation }
            catch { $rejected = $true }
            Assert-Condition $rejected 'A weakened release manifest workflow policy must be rejected.'
        }
    }

    It 'keeps the first gate independent of runner-provided scanners' {
        Assert-Condition (-not ($script:Scanner -match '(?i)\b(?:rg|ripgrep)(?:\.exe)?\b')) 'The repository Secret scanner must not depend on rg or ripgrep.'
        Assert-Condition (-not ($script:Scanner -match '(?m)^\s*(?:Import-Module|Install-Module|Add-Type|Start-Process|Invoke-Expression)\b')) 'The first gate must not load modules, compile code, or start external processes.'
        Assert-Condition ($script:Scanner -match '(?m)^\$maximumFileBytes = 8MB\s*$') 'The exact per-file scan bound must remain explicit.'
        Assert-Condition ($script:Scanner -match '(?m)^\$maximumAggregateBytes = 256MB\s*$') 'The exact aggregate scan bound must remain explicit.'
        Assert-Condition ($script:Scanner -match '(?m)^\$maximumFileCount = 50000\s*$') 'The exact file-count scan bound must remain explicit.'
        Assert-Condition ($script:Scanner -match '(?m)^\$maximumEntryCount = 100000\s*$') 'The exact entry-count scan bound must remain explicit.'
        Assert-Condition ($script:Scanner -match '(?m)^\$maximumDepth = 64\s*$') 'The exact tree-depth scan bound must remain explicit.'
        Assert-Condition ($script:Scanner -match '(?m)^\$maximumCooperativeElapsedSeconds = 300\s*$') 'The exact cooperative elapsed-time scan budget must remain explicit.'
        Assert-Condition ($script:Scanner -match '\[Text\.RegularExpressions\.RegexOptions\]::CultureInvariant') 'Regex interpretation must remain culture invariant.'
        Assert-Condition ($script:Scanner -match '\[TimeSpan\]::FromSeconds\(2\)') 'Regex execution must retain a finite timeout.'
    }

    It 're-scans generated artifacts after the web build' {
        $buildIndex = $script:Workflow.IndexOf('- name: Build the web app', [StringComparison]::Ordinal)
        $postBuildIndex = $script:Workflow.IndexOf('- name: Re-scan repository and generated artifacts after web build', [StringComparison]::Ordinal)
        Assert-Condition ($buildIndex -ge 0) 'The web build step is missing.'
        Assert-Condition ($postBuildIndex -gt $buildIndex) 'The generated-artifact scan must run after the web build.'
        Assert-Condition (([regex]::Matches($script:Workflow, '(?m)^\s*\$scanOutput = @\(& \.\\scripts\\check-repository-secrets\.ps1 -Root \$PWD\.Path 2>&1\)\s*$')).Count -eq 2) 'The workflow must run exactly one pre-dependency scan and one post-build scan.'
        Assert-Condition ($script:Workflow -match 'The post-build Secret scanner did not emit exactly one success marker\.') 'The post-build success marker must be checked.'
        Assert-Condition ($script:Workflow -match 'The post-build real-Secret boundary marker is missing or duplicated\.') 'The post-build closed-boundary marker must be checked.'
    }

    It 'runs the full Rust and locked web verification commands' {
        Assert-Condition ($script:Workflow -match '(?m)^    env:\s*\r?\n      # rustup merely installing a toolchain does not select it for later\s*\r?\n      # cargo/rustc subprocesses\. Pin every Rust proxy in this job explicitly\.\s*\r?\n      RUSTUP_TOOLCHAIN: 1\.95\.0\s*$') 'The job must select Rust 1.95.0 for every cargo/rustc subprocess.'
        Assert-PinnedRustProvisioning $script:Workflow
        Assert-Condition ($script:Workflow -match '(?m)^\s*run: cargo fetch --locked\s*$') 'Locked Rust dependency fetch is missing.'
        Assert-Condition ($script:Workflow -match '(?m)^\s*run: cargo install wasm-bindgen-cli --version 0\.2\.128 --locked --root "\$env:RUNNER_TEMP\\wasm-bindgen-cli"\s*$') 'The exact locked wasm-bindgen CLI installation is missing.'
        Assert-Condition ($script:Workflow -match '(?m)^\s*run: pwsh -NoProfile -NonInteractive -File \.\\scripts\\verify-local\.ps1 -Scope Workspace\s*$') 'Full Rust workspace verification is missing.'
        Assert-Condition ($script:Workflow -match '(?m)^\s*run: pwsh -NoProfile -NonInteractive -File \.\\scripts\\build-wasm\.ps1 -Release -BindgenPath "\$env:RUNNER_TEMP\\wasm-bindgen-cli\\bin\\wasm-bindgen\.exe"\s*$') 'Default release WASM generation is missing.'
        Assert-Condition ($script:Workflow -match '(?m)^\s*run: pwsh -NoProfile -NonInteractive -File \.\\scripts\\build-wasm\.ps1 -SyntheticDemo -Release -BindgenPath "\$env:RUNNER_TEMP\\wasm-bindgen-cli\\bin\\wasm-bindgen\.exe"\s*$') 'Synthetic-demo release WASM generation is missing.'
        Assert-Condition ($script:Workflow -match '(?m)^\s*run: node \.\\scripts\\test-wasm\.mjs\s*$') 'Default generated WASM smoke test is missing.'
        Assert-Condition ($script:Workflow -match '(?m)^\s*run: node \.\\scripts\\test-wasm\.mjs --demo\s*$') 'Synthetic-demo generated WASM smoke test is missing.'
        Assert-Condition ($script:Workflow -match '(?m)^\s*run: npm ci --ignore-scripts\s*$') 'Locked web install with lifecycle scripts disabled is missing.'
        Assert-Condition ($script:Workflow -match '(?m)^\s*run: npm test\s*$') 'Web tests are missing.'
        Assert-Condition ($script:Workflow -match '(?m)^\s*run: npm run typecheck\s*$') 'Web typecheck is missing.'
        Assert-Condition ($script:Workflow -match '(?m)^\s*run: npm run build\s*$') 'Web build is missing.'
    }

    It 'rejects a bare rustfmt argument that rustup would interpret as another toolchain' {
        $invalidWorkflow = $script:Workflow.Replace('--component clippy --component rustfmt', '--component clippy rustfmt')
        $rejected = $false
        try {
            Assert-PinnedRustProvisioning $invalidWorkflow
        }
        catch {
            Assert-Condition ($_.Exception.Message -eq 'Rust provisioning must pin the toolchain and pass each component with its own option.') 'The invalid component syntax must fail the provisioning assertion.'
            $rejected = $true
        }
        Assert-Condition $rejected 'A bare rustfmt argument must be rejected.'
    }

    It 'cannot silently continue or upload repository contents' {
        Assert-Condition (-not ($script:Workflow -match '(?m)^\s*continue-on-error:\s*true\s*$')) 'Silent continuation is forbidden.'
        Assert-Condition (-not ($script:Workflow -match '(?i)upload-artifact')) 'Artifact upload is forbidden.'
        Assert-Condition (-not ($script:Workflow -match '(?i)artifact-retention')) 'Artifact retention configuration is forbidden.'
    }
}
