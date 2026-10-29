# Identity Map browser-close observation

Date: 2026-10-29 Korea / 2026-10-29 UTC. `REAL_SECRET_GATE=CLOSED`.

## Scope and retained evidence

This is a diagnostic-only follow-up to commit
`62bedc45ebce6467a10ad26beac5a754be42a9fb`. It does not change product code,
the Identity Map fixture, dependencies, browser deadlines or release status.

The prior installed-browser evidence remains authoritative and unchanged:

- Edge 156.0.4314.42 completed all 15 functional groups with all 11 counters
  zero, but `BROWSER_CLOSE` reached the 10,000ms deadline. The run remains
  **FAIL / exit 1** and the work remains **HOLD**.
- Chrome 156.0.8078.48 completed the same 15 groups and cleanup with
  **PASS / exit 0**. That later pass does not clear the Edge failure.
- The separately observed PR45 Chrome failure established that connection loss,
  close-Promise settlement and OS process exit are different events. It did not
  establish an application defect or a general browser fix.

Root reported that the currently installed channels are Chrome 156.0.8078.49
and Edge 156.0.4314.50. This task did not launch either current browser and does
not transfer the older results to those versions.

## Diagnostic implementation

`apps/web/scripts/support/identity-close-observation.mjs` ports the reviewed
PR45 single-close contract to dependency-free JavaScript:

- exactly one `browser.close()` call is published and reused, including during
  synchronous reentry;
- the limit remains exactly 10,000ms on a monotonic clock;
- settlement at 10,000ms or later is `DEADLINE`;
- a late resolve or reject is recorded but cannot clear `DEADLINE`;
- `disconnected` event timing, close-Promise timing and connection probes remain
  separate observations;
- invalid clocks, listener failures and connection-probe failures cannot
  certify cleanup;
- arbitrary phase text is rejected and cannot enter serialized evidence;
- thrown values are never inspected or serialized;
- no environment value, command line, filesystem path or process detail is
  collected;
- there is no process-kill or browser-launch API in the helper.

`apps/web/scripts/verify-identity-map-browser.mjs` now attaches the observer
immediately after browser acquisition, marks context/browser/server/final
cleanup phases and uses the observer for the runner's one normal close call.
The existing cleanup step stays fail-closed. A deadline remains `DEADLINE`; any
other incomplete observation remains `REJECTED`. The fixed-field snapshot is
emitted as `browserCloseObservation` and is also required for cleanup
confirmation.

The runner can therefore distinguish at least these cases without widening the
deadline:

1. disconnected early, close Promise still pending at the boundary;
2. close Promise settled before the boundary but browser still connected;
3. close Promise rejected before the boundary;
4. close Promise settled at or after the strict boundary;
5. observation itself was not trustworthy.

## Synthetic verification

No installed browser, network service, deployment, credential or real Secret
was used. All browser objects, events and clocks in the tests are synthetic.

| Command | Result |
| --- | --- |
| `node --check apps/web/scripts/support/identity-close-observation.mjs` | exit 0 |
| `node --check apps/web/scripts/support/identity-close-observation.test.mjs` | exit 0 |
| `node --check apps/web/scripts/verify-identity-map-browser.mjs` | exit 0 |
| `node --test apps/web/scripts/support/identity-close-observation.test.mjs` | 16/16 pass, fail/cancel/skip 0, exit 0 |
| `node apps/web/scripts/verify-identity-map-browser.mjs --synthetic-only --preflight --channel=msedge` | `PREFLIGHT_ONLY`, `browserStarted:false`, exit 0 |

The unit coverage includes 9,999/10,000/10,001ms settlement, an early
disconnect with a pending Promise, late resolve, opaque late reject,
synchronous throw, reentry, invalid clocks, failed probes, partial listener
registration, listener-removal failure and arbitrary phase rejection.

## Limits and next evidence

This change improves attribution; it does not explain or fix the historical
Edge close delay. It does not prove whether Playwright, the installed browser,
Windows process lifetime or another environment condition caused that delay.
The previous FAIL and HOLD status must not be changed from synthetic tests.

If root later authorizes an installed-browser measurement, the smallest next
step is one Edge run with this instrumentation, followed by a zero-process
post-check. No retry, parallel browser, deadline increase or result suppression
is justified by this diagnostic change.

## Root integration and current installed-browser measurements

The preceding section records the initial diagnostic-only checkpoint. Root
subsequently merged current main `b36a279c6110af56480cce6bd3956355da32af0e`
into this feature branch normally, producing local merge `bb612a7`, without
overwriting the four diagnostic files. This includes the separately verified
PR49 discovery-focus changes; it does not merge this PR to main.

On that combined candidate, `npm test -- --reporter=dot` passed 71 files /
2,122 tests, `npm run typecheck` exited 0 and `npm run build` exited 0.
The new helper's independent review found no must-fix. Its Node test file is
not accidentally discovered by Vitest: `vite.config.ts` explicitly includes
only `src/**/*.test.{ts,tsx}`.

Root then ran exactly one instrumented measurement per installed channel,
sequentially, with no owned test browser observed before the next launch:

| Command | Current result |
| --- | --- |
| `node apps/web/scripts/verify-identity-map-browser.mjs --synthetic-only --built-app --channel=msedge` | Edge 156.0.4314.50; 15 groups; all 11 error counters 0; cleanup confirmed; exit 0 |
| `node apps/web/scripts/verify-identity-map-browser.mjs --synthetic-only --built-app --channel=chrome` | Chrome 156.0.8078.49; 15 groups; all 11 error counters 0; cleanup confirmed; exit 0 |

Edge ran from `2026-10-29T14:20:00.758Z` to `14:20:08.175Z`. Its one
close Promise resolved after about 1,805.10ms; disconnect was observed after
about 85.82ms. Chrome ran from `14:21:23.023Z` to `14:21:35.129Z`; its one
close resolved after about 1,221.17ms, with disconnect after about 41.44ms.
Both retain the original strict 10,000ms gate. Connection loss was not used
as a replacement for Promise settlement. All observation flags were false,
servers were no longer listening and owned socket counts were zero. The
post-run OS query found no Playwright-profile Chrome/Edge process.

Both runs served the same fixture and application bytes:

- fixture entry SHA256: `e07a9d261f1a67ad290501849446a56bd319bf9d4e4766eb41d7cc7afa68572d`
- fixture assets SHA256: `57517b937dfa1cdc7f956e8931617dd417bc9886a5d2c5f3828120daa5f3f15c`
- app index SHA256: `64cadaaff8e4391fab87c434826f2058db87061d0d1f0e260ffe982d870f4303`
- app assets SHA256: `487b043d6be1eb0b8b2911a6fef088a546448acd4907612aec1ec3fa843c3c89`

These are new passing browser gates for the current candidate and installed
versions, not a retroactive pass for Edge 156.0.4314.42 and not proof of its
failure's cause. No browser was installed or updated by this work. Current
local passes do not replace exact-head CI, prove all supported browser/OS
versions, open the real-Secret gate or certify production readiness.

## Workspace verifier limitation

Root also ran `pwsh -NoProfile -NonInteractive -File
./scripts/verify-local.ps1 -Scope Workspace` on the combined candidate.
Secret scan (baseline four/CLOSED), formatting and Clippy exited 0. The default
Rust tests progressed through the crypto/core suites and SQLite library tests
(48 passed, one intentional child-entrypoint ignore), but Windows Application
Control refused to execute `bounds-0f4b1e7c702c082b.exe` (OS error 4551).
The bounds tests **never executed**. Cargo returned 101 and the wrapper exited
1 with `LOCAL_CHECKS_FAILED stage=default-tests exit=101`.

Consequently this run is **not a full local workspace pass**. Later default
tests, the feasibility-probe phase and workspace doctests were not reached.
No application policy was disabled, no exception was installed, and the same
blocked binary was not retried to manufacture a pass. Rust sources and locked
dependencies are unchanged by this UI/diagnostic slice. The separately
verified main CI `40884978114` passed at 14:18:21Z, but is historical evidence
for main `b36a279`, not a substitute for fresh exact-head PR CI.

## CI coverage follow-up

Independent review identified that the 16 observer tests were local-only:
the src-only Vitest suite and existing idle Node step did not execute them.
The workflow now explicitly runs
`node --test apps/web/scripts/support/identity-close-observation.test.mjs`
from the repository root, after idle timing tests and before web typecheck.
No conditional skip or failure override was added. The workflow policy adds
four assertions, including 15 rejected mutations for missing/duplicate/reordered
steps, changed shell/directory/command, conditional skips and masked failures.

The exact new Node command passed 16/16, exit 0. PowerShell parsing, extracted
static policy assertions (including the existing idle-order/Secret-first
assertions), Secret scan baseline four/CLOSED, documentation links and diff
checks also passed. **Pester 5.7.1 was NOT_RUN locally:** only Pester 3.4.0 was
available and no installation was authorized. Static assertion execution is not
a replacement for Pester. Fresh exact-head CI must run its existing pinned
Pester 5.7.1 policy step and the new 16-test step before their remote gates can
be called passed. Product/browser inputs were unchanged by this CI follow-up.
