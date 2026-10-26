# Fresh synthetic vault five-minute idle evidence

Date: 2026-10-27 KST. Synthetic data only. `REAL_SECRET_GATE=CLOSED`.

## Scope and baseline

- Baseline commit: `41568f02219bbf6b5a86ec903126d87f612ea721`.
- Isolated branch: `codex/firstvibe-vault-idle-evidence-20261027`.
- This checkpoint changes verification tooling, CI policy and this report only. No vault, cryptography, storage, authentication or other product source was changed.
- The existing original working copy and its unrelated uncommitted work were not transferred or modified by this checkpoint.
- The production web bundle and generated WASM used here were freshly prepared in the isolated checkout. The browser runner fingerprints the files it actually serves before and after the run; that fingerprint alone is not reproducible source-to-build attestation.

The publication scope is exactly these six files. Local JSON reports, generated WASM, build output and dependencies are not included.

| File | Purpose |
| --- | --- |
| [Browser runner](../../apps/web/scripts/verify-local-vault-idle.mjs) | Real elapsed idle observation against the isolated production bundle; bounded owned-resource cleanup and sanitized failure diagnostics |
| [Timing helper](../../apps/web/tests/mvp-browser/idle-lock-timing.mjs) | Pure conservative interval classification, without browser or clock replacement |
| [Timing regressions](../../apps/web/tests/mvp-browser/idle-lock-timing.node-test.mjs) | 48 boundary and invalid-input cases |
| [Security workflow](../../.github/workflows/security-gates.yml) | Mandatory pure timing test step after web unit tests and before web typecheck |
| [Workflow policy regressions](../../tests/verification/verify-security-workflow.Tests.ps1) | 74 added lines; five new cases covering the mandatory step and rejection of weakened variants; existing tests retained |
| `docs/verification/2026-10-27-vault-idle-evidence.md` | This scoped evidence report, including the earlier failed attempt and remaining limits |

## What the browser check establishes

The runner opens only its own loopback server and fresh headless Chrome context, creates a synthetic three-item vault using the actual Worker/WASM path, and opens an editor. A browser-generated trusted Shift keydown is the final recognized activity. Passive listeners bracket the product's document activity handler with observations before and after it returns. There is no fake clock, accelerated product timer or injected `dispatchEvent` activity.

During observation, any additional trusted pointer/key activity, visibility/lifecycle change or detected clock discontinuity prevents a clean pass. The timing helper uses both ends of the activity interval:

- The pre-deadline sample must be at least 295 seconds after the latest possible activity time, while still strictly before 300 seconds after the earliest possible activity time.
- The first observed locked state must have a conservative elapsed lower bound of at least 300 seconds. An interval straddling the threshold is inconclusive, not a pass.
- Locked state, removal of private/editor DOM, preserved ciphertext and explicit reopening of the same three synthetic rows must all be observed. The observation ceiling is 360 seconds.
- Owned cleanup must finish successfully; failed or timed-out cleanup cannot be reported as PASS.

The identity-map selector is matched to the current committed markup, `.local-vault .identity-map`. No newer identity-map product implementation was ported to satisfy the runner.

## Retained first failure and diagnostic rerun

Two actual runs used the same bundle fingerprint. They are separate outcomes, not two successful runs.

| Run | UTC interval | Recorded outcome |
| --- | --- | --- |
| Initial fresh-bundle attempt | 2026-10-26 17:32:37.244 to 17:33:02.819 | FAIL at `create-vault-open-editor`; zero completed groups; `IDLE_CLEANUP_UNCONFIRMED`; cleanup not confirmed |
| Diagnostic rerun | 2026-10-26 17:43:13.244 to 17:48:23.798 | PASS; four groups completed; terminal exit code 0; cleanup confirmed |

The initial report's final cleanup classification overwrote the primary failure code. The report therefore cannot establish the original trigger or which cleanup operation failed. Its zero error counters do not turn that attempt into a pass.

Before the diagnostic rerun, the runner was improved to retain a sanitized primary failure code/stage and fixed cleanup-operation labels. Both OPEN-state expectations now use an explicit 30-second timeout. These are runner-only changes; they do not change the product's five-minute policy, the conservative interval requirements or the cleanup deadlines. The later successful run does not establish that the explicit timeout fixed the first failure, nor that a general browser-cleanup defect has been resolved.

The original failed report remains locally retained beside the diagnostic report. Raw report files are excluded from publication; this document contains only the necessary non-secret measurements.

### Successful run measurements

| Observation | Result |
| --- | --- |
| Node / Playwright / Chrome | v24.19.0 / 1.63.0 / 155.0.8059.85 |
| Last trusted activity | One keydown, one before observation and one after observation; no additional recognized activity |
| Conservative pre-deadline elapsed time | 295,644.4 ms; vault still open, editor present, document not hidden |
| Conservative first-lock elapsed lower bound | 300,076.1 ms |
| Settled locked-state elapsed lower bound | 300,716.6 ms |
| Private/editor nodes at first lock and settled sample | 0 / 0 |
| Ciphertext preserved through lock | Yes |
| Explicit reopening restores the same three synthetic rows | Yes |
| Page, console, HTTP, failed request, denied request, WebSocket, source-path and method error counters | All eight counters 0 |
| Cleanup | Confirmed; diagnostic cleanup-failure list empty |

Both attempts served the same five-file, 864,726-byte bundle:

```text
bundle SHA-256: c0eaf862cc671c92d711354c4941dd511f451c1483369351329d8caee055e9d3
index SHA-256:  9e48ab88fc252da87d5ce20ed50a11155325e2788405ef52e9865c72db7e8ed2
```

No archive bytes, credential values, private item content or machine-specific filesystem paths are included here.

## Commands and verification status

Commands are repository-relative unless a working directory is stated. Browser, timing, syntax, typecheck and build exits below were recorded by the root runner; they were not re-executed by the independent documentation reviewer.

| Check | Command / scope | Outcome |
| --- | --- | --- |
| Runner syntax | `node --check apps/web/scripts/verify-local-vault-idle.mjs` | PASS; exit 0 |
| Pure timing regression | `node --test apps/web/tests/mvp-browser/idle-lock-timing.node-test.mjs` | 48 PASS; exit 0 |
| Fresh web typecheck | `npm run typecheck` in `apps/web` | PASS; exit 0 |
| Fresh production web build | `npm run build` in `apps/web` | PASS; exit 0 |
| Actual five-minute diagnostic rerun | `node apps/web/scripts/verify-local-vault-idle.mjs --synthetic-only` | Four groups PASS; exit 0; measurements above |
| Workflow-policy PowerShell syntax | Parse `tests/verification/verify-security-workflow.Tests.ps1` with `System.Management.Automation.Language.Parser.ParseFile` | Zero parse errors; exit 0 |
| Workflow-policy whitespace validation | `git diff --check -- tests/verification/verify-security-workflow.Tests.ps1` | PASS; exit 0 |
| New workflow-policy regression execution | Pester 5.7.1 | NOT RUN locally; pinned version unavailable; no installation or older-Pester substitution |

The new mandatory CI step is named `Run vault idle timing boundary tests`, uses `shell: pwsh`, runs in `apps/web`, and executes `node --test tests/mvp-browser/idle-lock-timing.node-test.mjs`. The policy additions reject missing or duplicate steps, altered names/commands/shell/directories, conditional skipping, ignored or masked failures, and placement outside the unit-test/typecheck boundaries. These checks protect the pure timing step; they do not claim that CI executes the five-minute browser runner.

Independent read-only review found no Important-level issue in the ported runner, conservative timing helper, tests or selector compatibility. This is a scoped code review, not an external security audit. Fresh exact-head CI, including pinned Pester execution, remains required before a merge-ready claim.

## Remaining limits and boundaries

- One successful synthetic headless Chrome run is not proof for every browser, mobile device, OS sleep/resume scenario, background tab or real-time scheduling condition.
- DOM observations are not exact internal lock-call timestamps, heap-zeroization evidence or proof against hostile same-origin script.
- The earlier failed attempt remains unexplained. Existing Edge cleanup observations and native EOF/`ERR_ABORTED` control anomalies remain separate unresolved work; none is closed by this PASS.
- The older recorded idle run and earlier stale-bundle results are not substituted for this fresh-bundle result.
- No fresh full Rust or full application-suite pass is claimed by this six-file test-only checkpoint. Earlier broader results belong to their respective commits and reports.
- Loopback isolation and harness CSP are not deployment configuration. No external service, OAuth/Gmail session, production DB, domain, billing or deployment was activated.
- `REAL_SECRET_GATE=CLOSED` remains unchanged. No real password, API key, recovery material or user archive was entered. Real-secret release approval, external review and unresolved recovery/anchor policy remain outside this evidence.
- Publication, final Secret scanning and exact-head CI are handled separately by the root task. This report does not claim a commit, push, merge or release has occurred.
