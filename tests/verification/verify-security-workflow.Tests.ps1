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

        $script:BenefitsWebSteps = @(
            @{ Name = 'Install locked benefits web dependencies without lifecycle scripts'; Command = 'npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org' }
            @{ Name = 'Run benefits web unit tests'; Command = 'npm test' }
            @{ Name = 'Build the benefits web app'; Command = 'npm run build' }
            @{ Name = 'Type-check the benefits web app'; Command = 'npm run typecheck' }
            @{ Name = 'Check benefits web server and client boundaries'; Command = 'npm run check:boundaries' }
            @{ Name = 'Smoke-test the benefits web SSR server on loopback'; Command = 'npm run test:smoke' }
        )

        function Get-NamedWorkflowSteps {
            param([string]$Workflow)
            @([regex]::Matches($Workflow, '(?ms)^      - name: (?<name>[^\r\n]+)\r?\n(?<body>.*?)(?=^      - name: |\z)'))
        }

        function Assert-BenefitsWebVerification {
            param([string]$Workflow)
            $steps = @(Get-NamedWorkflowSteps $Workflow)
            $webBuild = @($steps | Where-Object { $_.Groups['name'].Value -eq 'Build the web app' })
            Assert-Condition ($webBuild.Count -eq 1) 'Exactly one existing web build must precede benefits web verification.'
            $previousIndex = $webBuild[0].Index

            foreach ($definition in $script:BenefitsWebSteps) {
                $matchingSteps = @($steps | Where-Object { $_.Groups['name'].Value -eq $definition.Name })
                Assert-Condition ($matchingSteps.Count -eq 1) "Exactly one benefits web gate is required: $($definition.Name)"
                $step = $matchingSteps[0]
                Assert-Condition ($step.Index -gt $previousIndex) "Benefits web gates must retain their dependency order: $($definition.Name)"
                $previousIndex = $step.Index

                # Only these properties are allowed: no conditional skip, alternate
                # shell, continued failure, environment override, or hidden command.
                $actualBody = @($step.Groups['body'].Value -split '\r?\n' | Where-Object {
                    -not [string]::IsNullOrWhiteSpace($_) -and $_ -notmatch '^\s*#'
                }) -join "`n"
                $expectedBody = @(
                    '        shell: pwsh'
                    '        working-directory: apps/benefits-web'
                    "        run: $($definition.Command)"
                ) -join "`n"
                Assert-Condition ([string]::Equals($actualBody, $expectedBody, [StringComparison]::Ordinal)) "Benefits web gates must use the exact fail-closed command and working directory: $($definition.Name)"
            }

            $postBuild = @($steps | Where-Object { $_.Groups['name'].Value -eq 'Re-scan repository and generated artifacts after both app builds' })
            Assert-Condition ($postBuild.Count -eq 1) 'Exactly one post-build Secret scan is required.'
            Assert-Condition ($postBuild[0].Index -gt $previousIndex) 'The post-build Secret scan must follow all benefits web gates.'
            Assert-Condition ($postBuild[0].Index -eq $steps[-1].Index) 'The post-build Secret scan must remain the final workflow step.'
        }

        function Assert-BenefitsWebMutationRejected {
            param([string]$Workflow, [string]$Reason)
            Assert-Condition (-not [string]::Equals($Workflow, $script:Workflow, [StringComparison]::Ordinal)) "The policy mutation did not change the workflow: $Reason"
            $rejected = $false
            try {
                Assert-BenefitsWebVerification $Workflow
            }
            catch {
                $rejected = $true
            }
            Assert-Condition $rejected "An invalid benefits web workflow must be rejected: $Reason"
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

    It 're-scans generated artifacts after both app builds' {
        $buildIndex = $script:Workflow.IndexOf('- name: Build the web app', [StringComparison]::Ordinal)
        $benefitsBuildIndex = $script:Workflow.IndexOf('- name: Build the benefits web app', [StringComparison]::Ordinal)
        $postBuildIndex = $script:Workflow.IndexOf('- name: Re-scan repository and generated artifacts after both app builds', [StringComparison]::Ordinal)
        Assert-Condition ($buildIndex -ge 0) 'The web build step is missing.'
        Assert-Condition ($benefitsBuildIndex -ge 0) 'The benefits web build step is missing.'
        Assert-Condition ($postBuildIndex -gt $buildIndex) 'The generated-artifact scan must run after the web build.'
        Assert-Condition ($postBuildIndex -gt $benefitsBuildIndex) 'The generated-artifact scan must run after the benefits web build.'
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

    It 'runs every benefits web gate in order with its exact fail-closed command and directory' {
        Assert-BenefitsWebVerification $script:Workflow
    }

    It 'rejects missing or duplicated benefits web gates even when the other web app has the same command' {
        foreach ($definition in $script:BenefitsWebSteps) {
            $step = @(Get-NamedWorkflowSteps $script:Workflow | Where-Object { $_.Groups['name'].Value -eq $definition.Name })[0]
            Assert-BenefitsWebMutationRejected ($script:Workflow.Remove($step.Index, $step.Length)) "missing $($definition.Name)"
            Assert-BenefitsWebMutationRejected ($script:Workflow.Insert($step.Index, $step.Value)) "duplicated $($definition.Name)"
        }
    }

    It 'rejects a changed benefits web command or directory' {
        foreach ($definition in $script:BenefitsWebSteps) {
            $step = @(Get-NamedWorkflowSteps $script:Workflow | Where-Object { $_.Groups['name'].Value -eq $definition.Name })[0]
            foreach ($invalidStep in @(
                $step.Value.Replace('working-directory: apps/benefits-web', 'working-directory: apps/web')
                $step.Value.Replace("run: $($definition.Command)", 'run: Write-Output skipped')
                $step.Value.Replace('shell: pwsh', 'shell: cmd')
            )) {
                Assert-BenefitsWebMutationRejected ($script:Workflow.Replace($step.Value, $invalidStep)) "changed command context for $($definition.Name)"
            }
        }
    }

    It 'rejects conditional skips or ignored failures in benefits web gates' {
        foreach ($definition in $script:BenefitsWebSteps) {
            $step = @(Get-NamedWorkflowSteps $script:Workflow | Where-Object { $_.Groups['name'].Value -eq $definition.Name })[0]
            foreach ($bypass in @('if: false', 'continue-on-error: true')) {
                $invalidStep = $step.Value.Replace('        shell: pwsh', "        $bypass`n        shell: pwsh")
                Assert-BenefitsWebMutationRejected ($script:Workflow.Replace($step.Value, $invalidStep)) "$bypass in $($definition.Name)"
            }
            $maskedExit = $step.Value.Replace("run: $($definition.Command)", "run: $($definition.Command); exit 0")
            Assert-BenefitsWebMutationRejected ($script:Workflow.Replace($step.Value, $maskedExit)) "masked exit in $($definition.Name)"
        }
    }

    It 'rejects benefits web gates reordered ahead of their prerequisites' {
        $steps = @(Get-NamedWorkflowSteps $script:Workflow)
        for ($index = 1; $index -lt $script:BenefitsWebSteps.Count; $index++) {
            $earlier = @($steps | Where-Object { $_.Groups['name'].Value -eq $script:BenefitsWebSteps[$index - 1].Name })[0]
            $later = @($steps | Where-Object { $_.Groups['name'].Value -eq $script:BenefitsWebSteps[$index].Name })[0]
            $invalidWorkflow = $script:Workflow.Remove($later.Index, $later.Length).Insert($earlier.Index, $later.Value)
            Assert-BenefitsWebMutationRejected $invalidWorkflow "reordered $($script:BenefitsWebSteps[$index].Name)"
        }
    }

    It 'rejects a post-build Secret scan before the last benefits web gate or followed by more commands' {
        $steps = @(Get-NamedWorkflowSteps $script:Workflow)
        $lastGate = @($steps | Where-Object { $_.Groups['name'].Value -eq $script:BenefitsWebSteps[-1].Name })[0]
        $scan = $steps[-1]
        $earlyScan = $script:Workflow.Remove($scan.Index, $scan.Length).Insert($lastGate.Index, $scan.Value + "`n")
        Assert-BenefitsWebMutationRejected $earlyScan 'post-build scan before the final benefits gate'
        $lateCommand = $script:Workflow + "`n      - name: Unreviewed command after the final scan`n        shell: pwsh`n        run: Write-Output synthetic`n"
        Assert-BenefitsWebMutationRejected $lateCommand 'command after the final Secret scan'
    }

    It 'cannot silently continue or upload repository contents' {
        Assert-Condition (-not ($script:Workflow -match '(?m)^\s*continue-on-error:\s*true\s*$')) 'Silent continuation is forbidden.'
        Assert-Condition (-not ($script:Workflow -match '(?i)upload-artifact')) 'Artifact upload is forbidden.'
        Assert-Condition (-not ($script:Workflow -match '(?i)artifact-retention')) 'Artifact retention configuration is forbidden.'
    }
}
