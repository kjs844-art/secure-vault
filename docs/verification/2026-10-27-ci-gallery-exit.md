# CI Gallery preparation: verified-success exit status

Date: 2026-10-27 (Korea). Base: `11a7148a5d68dbcf9747a93b31be3763a8c06849`.
Scope: the Actions-only preparation helper and synthetic regression tests. No
developer repository registration, module installation, provider credentials or
product behavior changes. `REAL_SECRET_GATE=CLOSED`.

## Observed failure and bounded interpretation

The exact `8e8c28aefe24cbac568e7d3f745c8ddf8eab9f5a` push
[run 40394567787](https://github.com/kjs844-art/secure-vault/actions/runs/40394567787)
failed at Gallery preparation, after printing the success marker. The helper emits
that marker only after checking exactly one PSGallery entry, the official source
URL and the NuGet provider. The installed Actions runner was 2.338.0; its official
[PowerShell wrapper](https://github.com/actions/runner/blob/v2.338.0/src/Runner.Worker/Handlers/ScriptHandlerHelpers.cs)
exits with a remaining `LASTEXITCODE` after a successful script invocation.

This supports a residual native-exit-status failure. The exact internal program
that emitted the preceding source-option error is not identified. This change
does not claim to fix that program, package-download failures or product tests.
The later Pester/Rust/web steps did not run in that failed execution.

## Change

- Keep the exact Actions marker requirement, terminating query/registration
  errors, no replacement source, strict final registration checks and fixed error
  messages unchanged.
- Only after those conditions succeed, explicitly set the global native exit
  status to zero before emitting the ready marker.
- No `continue-on-error`, unconditional success exit, retries, alternate module
  source or weakened workflow gate is introduced.

## Checks

The subprocess fixture loads only built-in output/management commands, verifies
their sources, disables module autoloading and shadows repository commands with
verified synthetic functions. It executes the actual helper and Actions-style
wrapper in a child process. It does not infer exit status from output alone.

| Check | Exact outcome |
| --- | --- |
| Original success tail, corrected fixture, PowerShell 7 | 8 PASS / 4 FAIL, exit 1; all four intended success cases emitted exactly one READY, no stderr, actual exit 1 |
| Original success tail, corrected fixture, Windows PowerShell 5.1 | Same 8 PASS / 4 FAIL, exit 1 |
| Patched helper, same 12 cases, PowerShell 7 | 12 PASS / 0 FAIL, exit 0 |
| Patched helper, same 12 cases, Windows PowerShell 5.1 | 12 PASS / 0 FAIL, exit 0 |
| Invalid source/provider/duplicate/query/registration/missing/non-CI cases | Remain exit 1, without READY or private fixture detail |
| Pinned Pester 5.7.1 suite | NOT RUN locally: pinned module unavailable; exact-head CI required |
| Both engine parsers, all three scripts | exit 0; PowerShell 7.6.5 and Windows PowerShell 5.1.26100.9711 |
| Final independent read-only review | No must-fix found; not a substitute for Pester execution |
| Final repository Secret scan | Baseline 4, PASSED, CLOSED, exit 0 |
| Document links and `git diff --check` | exit 0 |

Commands from the repository root:

```powershell
pwsh -NoProfile -NonInteractive -File tests/verification/ensure-ci-psgallery-exit.Tests.ps1
powershell.exe -NoProfile -NonInteractive -File tests/verification/ensure-ci-psgallery-exit.Tests.ps1
```

Earlier fixture attempts lacked built-in commands after disabling autoloading.
Those failures are discarded as infrastructure errors, not counted as the
behavioral RED. Only READY=1, stderr empty and exit 1 in the corrected original
fixture qualify as the reproduced success-path failure.

The Pester suite also covers absent/present native status and restores the
original environment and status presence/value. The standalone regression checks
that its child processes leave parent state unchanged. Do not run the production
helper directly on a developer machine.

## Changed paths and remaining gate

- `scripts/ensure-ci-psgallery.ps1`
- `tests/verification/ensure-ci-psgallery.Tests.ps1`
- `tests/verification/ensure-ci-psgallery-exit.Tests.ps1`
- This verification note.

Exact-head CI must still be assessed before merge. Local subprocess passes are not a claim that GitHub
Actions has already passed or that KeyAtlas is ready for real credentials.
