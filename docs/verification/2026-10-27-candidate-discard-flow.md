# Pending-candidate discard: synthetic composition evidence

Date: 2026-10-27 Korea / 2026-10-26 UTC. `REAL_SECRET_GATE=CLOSED`.

**Latest follow-up:** the installed Edge 156.0.4314.50 full-composition run on
2026-10-29 passed 123 groups, all seven error counters zero and owned cleanup
confirmed. See the final section. Earlier Edge .42 and local Windows build
failures below remain historical failures, not corrected results or a proven
root cause. Fresh exact-head CI/review is still required before merge.

## Scope and ownership

Worktree: `agent-staging/keyatlas-pr35-framework-fixes-20261027`.
Branch: `codex/firstvibe-candidate-discard-flow-20261027`.
Starting HEAD: `962e45fa8534042b6638a047fafb8ed88d69dac2` (the subsequently merged PR #43 head).

This slice adds an internal candidate-discard HTTP adapter, a bounded explicit
client and request owner, and an actual React confirmation surface beside the
existing review composition. It is **not a production inbox endpoint, real
authentication, Gmail connection or durable database integration**.

The original `keyatlas-pr34-fixes-20261017` checkout was read only. Recheck:
HEAD `dd2af499a9243fca5daec720cd46f2875edc1c3c`, dirty 374 / staged 0,
1,019 existing nonignored files; aggregate path-plus-SHA256 remains
`B621FB1FC3795DB1E114971886DEFD850DFC91060E68A972FCB165B4E0DEBA83`.
Other agents' original changes and original installations were not overwritten.

## User-visible behavior

- Select a candidate ID and revision from one explicitly loaded batch.
- Inspect the exact target and consequences, then type `폐기` to submit.
- Cancel/Escape only retires an **unsent** confirmation. It is not undo.
- Pending candidate content and its linked preview content can be discarded;
  saved benefits, original mail and external accounts are not deleted.
- Access expiry and content erasure are different states. The discard surface
  shows only IDs/revisions, never expired names, extracted values or mail text.
- A missing response or a dispatched failure retains the original immutable
  request. Only explicit reconciliation of that same target/revision is offered.
- Completion-receipt refresh and candidate-list refresh do not erase an already
  attempted command. A different batch does not silently replace its target.
- Success invalidates only the matching loaded observation. The existing review
  panel stays mounted, preserving its independent uncertain save/delete request.
- Shared authority retirement closes the workspace. Native back navigation
  does not automatically reopen private content or send a new request.

The consent-patterns skill influenced the concrete target/impact preview,
type-to-confirm, safe cancellation, native labels, polite status updates and
the distinction between cancellation, uncertain completion and irreversible
content erasure. It did not authorize production connections or new policies.

## Changed paths

All paths below are relative to `apps/benefits-web/` unless stated otherwise.

| Layer | Files |
| --- | --- |
| Internal server | `src/server/http/inbox-discard-http.ts`, `inbox-discard-http-contracts.ts` |
| Browser domain | `src/domain/candidate-discard-client.ts`, `candidate-discard-owner.ts` |
| UI | `src/components/review-workspace/CandidateDiscardPanel.tsx`, `LoadedCandidateReviewWorkspace.tsx` |
| Tests | `tests/inbox-discard-http.test.ts`, `candidate-discard-client.test.ts`, `candidate-discard-owner.test.ts`, `candidate-discard-panel-ssr.test.ts` |
| Verification tooling | `scripts/verify-candidate-review-browser.ts`, `check-boundaries.mjs`, `smoke-server.mjs` |
| Bounded diagnostics | `scripts/support/native-network-diagnostics.ts`, `unexpected-transport-observation.ts`; corresponding `tests/native-network-diagnostics.test.ts`, `unexpected-transport-observation.test.ts` |
| Evidence | This document |

No package/lock files, Rust product code, public routes, design stylesheet,
credentials, remote resources or original worktree files changed in this slice.

## Validation receipts

Commands are from `apps/benefits-web/` except where explicitly stated.

| Check | Exact command or scope | Result |
| --- | --- | --- |
| Server focused | `node --import tsx --test --test-reporter=spec tests/inbox-discard-http.test.ts` | Author receipt: 86/86 PASS, exit 0 |
| Existing server/read/runtime regression | `node --import tsx --test --test-reporter=spec tests/candidate-inbox.test.ts tests/inbox-http.test.ts tests/candidate-batch-references.test.ts tests/batch-reference-store.test.ts tests/runtime-policy.test.ts` | Author receipt: 376/376 PASS, exit 0 |
| New client/owner | `node --import tsx --test tests/candidate-discard-client.test.ts tests/candidate-discard-owner.test.ts` | Author receipt: 104/104 PASS, exit 0 |
| UI SSR | `node --import tsx --test tests/candidate-discard-panel-ssr.test.ts tests/loaded-candidate-review-workspace-ssr.test.ts` | Root: 9/9 PASS, exit 0 |
| Complete benefits tests | `npm test` | Root final: 3,473/3,473 PASS, fail/cancel/skip 0, exit 0; earlier 3,472 before added discard-route diagnostic regression |
| App typecheck | `npm run typecheck` | Root: exit 0 |
| Build plus app typecheck | `npm run build` | Root: exit 0; existing module-directive warnings retained |
| Post-build boundary | `node scripts/check-boundaries.mjs` | Root: exit 0, source 101/client 6 |
| Real loopback SSR smoke | `npm run test:smoke` | Root: exit 0, assets 5; `/api/inbox/discard` POST remains fixed 503 |
| Browser runner strict types | Command below | Root: exit 0 |
| Secret scan, repository root | `pwsh -NoProfile -NonInteractive -File scripts/check-repository-secrets.ps1` | Root: baseline 4, PASSED, CLOSED, exit 0 |
| Focused actual Chrome | Browser command below plus `--discard-only` | Root: 10 groups PASS, exit 0, seven error counters 0, owned cleanup true |
| Focused actual Edge | Same focused command, `BROWSER_CHANNEL=msedge` | Root: 10 groups PASS, exit 0, seven error counters 0, owned cleanup true; does not override full Edge failure |
| Focused Chrome development effects | Same focused command plus `--development-effects` | Root: 10 groups PASS, exit 0; keyed remount 2 setups/1 cleanup; initial hydration separately 1/0 |
| Full actual Chrome | Browser command below, default mode | Root latest: 123 groups PASS, exit 0, seven error counters 0, owned cleanup true |
| Full actual Edge | Same full command, `BROWSER_CHANNEL=msedge` | **FAIL exit 1**; 122 recorded groups, two unexpected transport events, other six error counters 0, owned cleanup true |
| Rust workspace verifier, repository root | `pwsh -NoProfile -NonInteractive -File scripts/verify-local.ps1 -Scope Workspace` with process-only offline/incremental settings | Secret/format passed; Clippy BLOCKED by Windows Application Control `os error 4551`, exit 101; subsequent Rust tests/doctests NOT RUN |

```text
node node_modules/typescript/bin/tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM,DOM.Iterable --types node --jsx react-jsx --strict --skipLibCheck --allowImportingTsExtensions --noUnusedLocals --noUnusedParameters --noImplicitReturns --noFallthroughCasesInSwitch --noUncheckedIndexedAccess --exactOptionalPropertyTypes scripts/verify-candidate-review-browser.ts
node --import tsx scripts/verify-candidate-review-browser.ts --synthetic-only
```

Set `BROWSER_CHANNEL=chrome` or `msedge` only for the owned process. No new tool
or browser was downloaded. Existing Playwright 1.63.0 is reused through the two
ignored local package links documented in the [prior composition report](2026-10-27-candidate-workspace-integration.md).
The focused flag labels its report `DISCARD_ONLY` and does not claim to execute
the earlier full-composition groups. The full default retains those groups.
After browser execution, the fixed diagnostic route lists gained the new discard
path with unit coverage, and the focused report's limit wording was clarified.
No product/UI behavior or fixture bundle changed. Native diagnostic opt-in mode
was not run after this label-only extension; final unit and strict checks cover it.

Chrome full receipt: 2026-10-26 19:13:48.762Z–19:16:29.895Z. Fixture bundle
429,758 bytes, SHA256 `e985659ea2698a7bae80d182558954192788f8faf20a28841ab017f64ee362fa`.
The new prepared-discard native back path observed the same document with trusted
persisted pagehide/pageshow and private DOM closed. No new production route was
opened. Windows protection was not disabled or bypassed for the Rust failure.

Edge full receipt: 2026-10-26 19:17:30Z–19:20:17Z, Edge 156.0.4314.42.
Two `net::ERR_ABORTED` observations remained failures: one candidate batch POST
and one catalog list POST during earlier read/cancel scenarios. Both observed
HTTP 200 and later completed read helpers; their captured signals had no abort
event. Neither successful body decoding nor later readiness changes those
native transport failures into success. The candidate-discard scenarios and its
native back case executed, but the **full Edge result is not green**. No error
allowlist was expanded to suppress them. Cause/remediation is unresolved; do not
merge this slice as fully verified solely from Chrome or unit-test results.

## Earlier failed checks remain distinct

- Initial SSR test fixture supplied a forbidden clock during activation, so no
  valid lease was created: 8/9 PASS, exit 1. Setup now uses a valid clock, then
  forbids clock access during SSR. Final 9/9 receipt above is separate.
- An initial strict command incorrectly used NodeNext resolution for this
  Bundler-resolution project, producing import/type diagnostics, exit 2. The
  documented strict Bundler command passed after a nullable test callback helper
  was made explicit. App imports were not rewritten or type rules suppressed.
- First full Chrome attempt: 47 recorded groups including cleanup, **FAIL exit
  1** at the existing `create_focus_reentrant_close` setup; one unexpected console
  event, no page/bridge/transport errors, owned cleanup true. The first report
  only classified that console event as `OTHER`. Additional enum-only diagnostic
  summaries were added; the next full run passed. This is **not proof of the
  earlier failure's cause or resolution**. Do not discard the failed receipt.
- First discard-focused run failed before the expired-candidate scenario because
  a one-millisecond grant could expire during fixture staging. The final case
  uses a five-second grant, waits for the actual wall-clock deadline and reloads
  the real projected expired state. It does not alter the browser clock.

Raw synthetic receipts remain ignored under `target/reports/`; they are not
published as security diagnostics or used to infer real-account behavior.

## Review and remaining limits

Independent reviewers inspected the client/owner, server adapter and UI/runner
separately. Concrete findings were addressed before the latest browser pass;
final read-only reviews found no additional Important blocker. Reviewer analysis
is not a replacement for the root's executed test receipts.

No Firefox/WebKit, physical mobile device, production authentication, real
mailbox, durable DB/concurrency, external account deletion, external security
audit, production deploy or real Secret entry is verified. Chromium loopback
tests and passive external-request counters are not a pre-dispatch network
sandbox. Prior native EOF/ERR_ABORTED/control and exact idle-transition timing
limitations remain open independently of this feature.

Git publication and any eventual merge require exact-head CI plus a fresh
review-state check; local PASS is not CI or production readiness. At the original
publication this slice was a **Draft PR**, not ready for main merge, because full
Edge/native transport verification and the local Windows Rust build restriction
remained unresolved. The following current-environment result is separate.

## 2026-10-29 follow-up: current installed Edge full composition

The branch incorporated main `b36a279c6110af56480cce6bd3956355da32af0e`
through normal merge `24da17fc0b55fd993c054531cdf445e6a1356cb9`.
The benefits app, its lock file, Rust crates/Cargo inputs and workspace verifier
are byte-identical to PR44 head `a6db632cdf60cda59d90a330452f5948e9bf9610`.
The merge imports already-verified web discovery/focus and CI-gallery changes,
not a candidate transport workaround. No package or browser was installed.

One new full run, using the already-installed Edge version:

```powershell
$env:BROWSER_CHANNEL = 'msedge'
node --import tsx scripts/verify-candidate-review-browser.ts --synthetic-only
```

Working directory: `apps/benefits-web/`. This is the default
`ACTUAL_CANDIDATE_REVIEW_COMPOSITION_SYNTHETIC_HTTP` / `FULL_COMPOSITION`
production fixture, **not** discard-only, bootstrap, native-network-diagnostic,
cleanup-experiment or development-effects mode.

| Measurement | New result |
| --- | --- |
| Browser | Installed Edge 156.0.4314.50; Node 24.19.0 / existing Playwright 1.63.0 |
| UTC interval | 2026-10-29T15:08:18.233Z to 15:10:42.261Z |
| Full groups | 123 PASS; process exit 0 |
| Errors | bridge/page/console/external/websocket/CSP/transport: all 0 |
| Cleanup | true; cleanupErrors empty; no owned test browser processes after return |
| Fixture | 429,758 bytes; SHA256 `e985659ea2698a7bae80d182558954192788f8faf20a28841ab017f64ee362fa`, identical to the earlier full Chrome/Edge fixture |
| Native back/BFCache | All 11 measured paths PASS, same-document trusted persisted events, private content CLOSED, including candidate discard |
| Narrow viewport | 320/360px observations: no horizontal overflow, focus visible |
| Original receipt digest | SHA256 `29171a49e200634eeae6165e65d1175d4c181607b110de7d317c0cdfa718fde4` |

The raw synthetic receipt remains ignored at
`target/reports/candidate-discard-edge-156.0.4314.50-full-20261030.json`.
The older `candidate-discard-edge-full.json` was preserved unchanged. No timeout,
error allowlist, expected-abort matching, product cleanup or security gate was
relaxed. This is evidence for the current measured environment, **not proof of
the old ERR_ABORTED cause, a universal browser fix, or all-browser coverage**.

The historical 3,473-test/typecheck/build/boundary/SSR/strict results above apply
to unchanged benefits inputs and were not rerun to fill time. Historical full
Chrome 123 PASS remains a distinct receipt, not a new Chrome run. The current
candidate still needs fresh exact-head CI and review; old CI success is not
relabeled. The local Rust OS-policy restriction remains unresolved; no retry or
protection bypass is authorized. If the exact remote candidate's complete Rust
verifier succeeds, report that remote result separately from local NOT_RUN.

The new current-browser PASS removes this environment's full Edge failure from
the immediate promotion gate; it does not erase historical failures or open
production routes, real mail, credentials, DB or deployment. The independent
older native-control and exact idle-time observations remain separate limits.
