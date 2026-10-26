# Benefit history and conflicting expiry display

Date: 2026-10-27 Korea / 2026-10-26 UTC. `REAL_SECRET_GATE=CLOSED`.

## Scope and provenance

Branch: `codex/firstvibe-benefit-history-accuracy-20261027`.
Base: main `11a7148a5d68dbcf9747a93b31be3763a8c06849`.
Checkout: `agent-staging/keyatlas-pr35-framework-fixes-20261027`.
The clean checkout was reused after publishing the independent candidate-discard
Draft #44. This branch does **not** contain #44's candidate-discard additions.

Selected five product files from the preserved, dirty
`keyatlas-pr34-fixes-20261017` source were compared before porting. The source
checkout was not edited: HEAD `dd2af499a9243fca5daec720cd46f2875edc1c3c`,
dirty 374 / staged 0 at recheck. Only summary-related `DemoExperience` hunks
were taken; its separate review-preview/list demo imports and hooks were not.
Final preservation check: all 1,019 existing source files retain aggregate
path-plus-SHA256 `B621FB1FC3795DB1E114971886DEFD850DFC91060E68A972FCB165B4E0DEBA83`.
Final Secret re-scan after the runner/screenshots passed baseline 4 / CLOSED,
exit 0. No unrelated changes were staged.

The feature is **synthetic display accuracy**, not a connected provider balance,
entitlement decision, new parser for real mail, or a security boundary. Existing
strict canonical UTC history rules remain unchanged. A future adapter must
normalize other date representations with their provenance separately.

## Observable changes

- Trial countdown and history filtering share the existing strict instant parser.
  An impossible calendar date is not normalized into a confident countdown.
- A malformed benefit expiry or conflicting benefit/service trial dates remain
  reviewable, labelled `확인 필요` and `기록된 잔량`, without a spendable-looking meter.
- Both directions of trial-date disagreement are covered. An ended service does
  not silently archive unrelated credits, and a future service trial does not
  override an unrelated credit's explicit expiry.
- Each uncertain expiry adds one review attention item for the matching service.
  A recorded zero and a missing amount remain different facts.
- Past-view summary counts say `지난 기록`, not current benefits or pending review
  items. Past details remain absent from default markup until explicitly selected.
- No CSS/design change, new package, real account/mail/DB/Secret, cloud resource,
  deployment or device shutdown is included.

## Files

Product paths under `apps/benefits-web/`:

- `src/lib/mvp-demo-data.ts`
- `src/lib/demo-benefit-history.ts`
- `src/components/mvp-demo/BenefitCard.tsx`
- `src/components/mvp-demo/ServiceList.tsx`
- `src/components/mvp-demo/DemoExperience.tsx`

Tests: `tests/benefit-display-accuracy.test.ts`, `tests/demo-trial-conflict.test.ts`,
`tests/claude-benefits-qa-history-boundary.test.ts`.
The latter two preserve the original assertions except the deliberately excluded
CSS overflow-wrap check and its unused import; no design patch is included.
The browser fixture/runner are `scripts/fixtures/benefit-history-fixture.tsx` and
`scripts/verify-benefit-history-browser.ts`; they bundle the actual product
components with existing Vite/React/Playwright and no new downloads.
`README.md` now distinguishes the integrated synthetic UI from unconnected
production authentication/DB/routes. This document records current evidence.

## Executed checks

Node v24.19.0. Commands below are from `apps/benefits-web/` unless marked root.

| Check | Command | Result |
| --- | --- | --- |
| Behavioral RED before product edit | `node --import tsx --test tests/benefit-display-accuracy.test.ts` | 0/4 PASS, 4 FAIL, exit 1: impossible February 30 gave countdown 2 instead of unknown; three uncertain cards had no review label and retained a meter |
| Port integration RED | `node --import tsx --test tests/demo-trial-conflict.test.ts tests/claude-benefits-qa-history-boundary.test.ts` | 0/2 PASS, exit 1 due to missing new exports; not behavioral RED |
| Focused GREEN | Command below | 177/177 PASS, fail/cancel/skip 0, exit 0 |
| Full benefits regression | `npm test` | 3,319/3,319 PASS, fail/cancel/skip 0, exit 0 |
| Production build and app typecheck | `npm run build` | exit 0; existing module-directive warnings retained |
| Post-build boundary | `node scripts/check-boundaries.mjs` | exit 0, source 96/client 6 |
| Actual loopback SSR HTTP smoke | `npm run test:smoke` | exit 0, assets 5; not browser hydration proof |
| New test strict types | Three new tests, command below | exit 0 |
| Browser runner strict types | New runner and fixture, command below | exit 0 (author receipt) |
| Browser preflight refusal | Runner without the exact required synthetic flag | Expected exit 1 at PREFLIGHT, no browser/version/assets/checks; author receipt |
| Actual Chrome display/keyboard | Browser command below, `BROWSER_CHANNEL=chrome` | 14/14 groups PASS, exit 0; 7 error counters zero, 4 owned cleanup checks true |
| Actual Edge display/keyboard | Same command, `BROWSER_CHANNEL=msedge` | 14/14 groups PASS, exit 0; 7 error counters zero, 4 owned cleanup checks true |
| Screenshot evidence | Same Chrome command plus `--screenshots` | 14/14 groups PASS, exit 0; two synthetic screenshots, no overwrites; final runner strict types also root exit 0 |
| Secret scan, root | `pwsh -NoProfile -NonInteractive -File scripts/check-repository-secrets.ps1` | baseline 4, PASSED, CLOSED, exit 0 |
| Relative links, root | `pwsh -NoProfile -NonInteractive -File scripts/check-markdown-links.ps1 -Root <file>` for this report and benefits README | Each exit 0 |

```text
node --import tsx --test tests/benefit-display-accuracy.test.ts tests/demo-trial-conflict.test.ts tests/claude-benefits-qa-history-boundary.test.ts tests/demo-history.test.ts tests/mvp-demo-data.test.ts tests/mvp-demo-render.test.ts
node node_modules/typescript/bin/tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM,DOM.Iterable --types node --jsx react-jsx --strict --skipLibCheck --allowImportingTsExtensions --noUnusedLocals --noUnusedParameters --noImplicitReturns --noFallthroughCasesInSwitch --noUncheckedIndexedAccess --exactOptionalPropertyTypes tests/benefit-display-accuracy.test.ts tests/demo-trial-conflict.test.ts tests/claude-benefits-qa-history-boundary.test.ts
node node_modules/typescript/bin/tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM,DOM.Iterable --types node --jsx react-jsx --strict --skipLibCheck --allowImportingTsExtensions --noUnusedLocals --noUnusedParameters --noImplicitReturns --noFallthroughCasesInSwitch --noUncheckedIndexedAccess --exactOptionalPropertyTypes scripts/verify-benefit-history-browser.ts scripts/fixtures/benefit-history-fixture.tsx
node --import tsx scripts/verify-benefit-history-browser.ts --synthetic-only
```

The count differs from #44's 3,473: this is the independent main-based display
branch, not an omission or rerun of the discard suite. Unit tests do not prove
actual provider facts or a whole-product release.

## Browser evidence and limits

Chrome 155.0.8059.85 ran at 2026-10-26 19:50:29.020Z–19:50:36.201Z;
Edge 156.0.4314.42 ran at 19:50:45.706Z–19:50:49.168Z. Both used the same
211,822-byte entry, SHA256
`e15ba1dd32aea55fc1cd340bcd3bb0ea0505f7204512004362c07fdd5035ed1e`.
The runner records the exact eight input hashes as well. Owned browser/context,
server and sockets were confirmed closed before starting the next browser.

The 14 groups cover normal six records, opt-in two past records and accurate
summary counts, return to normal, keyboard selected/focus state, attention-link
focus, both trial conflicts, date-only benefit expiry, impossible service date,
escaped synthetic labels, and actual current/history horizontal overflow at
360px. Existing CSS is reused unchanged. The impossible service date is an
attention warning, not a newly inferred benefit-expiry policy.

The screenshot-only extension was checked by strict TypeScript and an actual
Chrome run at 19:53:16.556Z–19:53:19.255Z. The fixture entry hash stayed identical,
all 14 checks passed, errors stayed zero and owned cleanup was confirmed. The
runner refuses to overwrite existing screenshot paths. Normal execution writes
no images. Both screenshots were visually inspected; the top fixture-only mode
buttons are test controls, not a new product design.

- [Current view, 360px](images/benefit-history-20261027/narrow-current.png)
- [Opt-in past records, 360px](images/benefit-history-20261027/narrow-history.png)

This is a fresh bundle of the actual components in a test-only host, not an
existing stale dist, production route hydration or an account connection. Request
routing blocks non-loopback requests in this owned context; it is not OS-level
network isolation. Reference time is fixed synthetic data, not a mocked browser
clock or provider freshness evidence.

Independent read-only review found no concrete must-fix in the five product
files/three tests; review did not execute a browser. No Firefox/WebKit or physical mobile
device, continuously advancing provider clock, production entitlement, account
auth, durable DB, original live data or deployment is verified.

Rust product code was not changed. The earlier local workspace attempt was
blocked by Windows Application Control (exit 101); this display slice does not
bypass that restriction or claim a new local Rust pass. Exact-head CI is a
separate requirement before any merge.

#44's full Edge/native transport failure, earlier Chrome failure of unknown
cause, and #42's exact idle-transition INCONCLUSIVE evidence remain open
independently. This display fix does not resolve or hide them.

## PR #45 review follow-up (2026-10-26 20:17 UTC)

The receipts above describe initial head `779c042`; the following evidence is
newer. PR #45 was changed to **Draft** after the final Chrome cleanup failure
below. Neither earlier green browser evidence nor CI substitutes for this result.

| Review item | Change and evidence |
| --- | --- |
| Ended status with conflicting service end date | A matching `trial_ended` status now independently requires review when the explicit benefit expiry is future. Future/malformed service dates do not silently restore a usable-looking meter. History classification is unchanged; there is no automatic archive or new real-provider policy. |
| Card label versus attention item | Tests require both separately, not an either/or condition. |
| Visual meter despite removed ARIA | Tests and browser runner also check the actual inline-style bar. An actual SSR counterexample removes role/ARIA and proves the visual guard still detects the bar. |
| Ordinary valid meters | Every ordinary card is checked against its calculable ratio, including recorded zero and unknown values. |
| Irrelevant history count | History summary accepts two arguments; legacy three-argument/union-view use remains compatible. Review still requires a count in the type signature. |
| Screenshots from failed checks | PNGs stay in memory until all checks AND owned cleanup pass; absence checks and exclusive `wx` creation remain. Existing evidence is never deleted or overwritten. A new fixed `benefit-history-20261027-review/` directory is reserved for follow-up evidence. The failed Chrome run created no directory or screenshots. |
| Failure diagnostics | Fixed allowlisted stage/detail/scenario/code/name and separate cleanup failures preserve the failure location. Raw messages, stack traces, URLs and bodies are not emitted. |

Before the product fix, the three focused test files produced **39 PASS / 5 FAIL
of 44, exit 1**, no skip/cancel. Five new ended-status cases (future, impossible,
date-only, arbitrary text, empty string) all failed the actual card-label check:
the card showed ordinary remaining text and a meter. After the product fix the
six-file focus passed **182/182, exit 0**. Adding the independent visual-guard
counterexample then gave the final three-file focus **45/45 PASS, exit 0**.

Final full `npm test`: **3,325/3,325 PASS**, fail/cancel/skip 0, exit 0.
`npm run build`, post-build `node scripts/check-boundaries.mjs` (96 source / 6
client), `npm run test:smoke` (5 assets), and the same strict TypeScript command
covering three tests plus runner/fixture all exit 0. Existing build warnings are
not suppressed. Independent read-only review confirmed the conservative display
change does not alter the history decision or apply to unrelated credits.

### Final actual browser results — not all green

| Browser | Actual interval (UTC) | Functional checks | Overall result |
| --- | --- | --- | --- |
| Chrome 156.0.8078.48, with `--screenshots` | 20:15:13.527–20:15:35.068 | 20 groups recorded, all seven error counters 0 | **FAIL, exit 1**: `CLEANUP / BROWSER_CLOSE / HISTORY_DEADLINE`. All cleanup flags ultimately true; no screenshot published. |
| Edge 156.0.4314.42, without screenshots | 20:16:31.792–20:16:39.508 | 20 groups PASS, all seven error counters 0 | **PASS, exit 0**, all cleanup flags true, failure null. |

Both used the same 212,026-byte fixture entry SHA256
`dd214fd9969d72cfea198aa08a27f8eb982af84258e75042cdab2061ce420253`.
The added groups cover each viewport's valid meter positive control and
ended-status/future or malformed-date records. Requests remain loopback-only in
the owned context. Root confirmed zero matching Playwright test-browser processes
after Chrome before starting Edge. No existing browser/tool was installed,
upgraded, security-bypassed or terminated by name. Chrome reported a different
installed version from the earlier 155 receipt; this is observed version drift,
not evidence of its cause or proof that it caused the failure.

The runner's two preflight rejection cases (missing exact flag and existing PNG)
returned expected child exit 1 with fixed diagnostic codes, no browser/entry or
images, and cleanup true; the author's assertion wrapper exited 0. Those checks
used the original evidence directory before root selected the fresh review path.
The failed actual screenshot run now proves later cleanup failure leaves no
screenshots. Successful post-cleanup screenshot publication in the new revision
was not exercised. Two file writes are not a filesystem-atomic group: an I/O
failure on the second write can leave a first, already-validated image; the report
records the published path and FAIL. No claim of atomic image publication is made.

PR CI on initial `779c042` failed before Rust/web execution because pinned Pester
5.7.1 could not download; this is separate from Chrome cleanup. Its push run was
still in progress at the review checkpoint. Changed-head CI and review must be
checked anew. #44's transport failures and #42's timing INCONCLUSIVE remain
independent. This follow-up remains a Draft checkpoint, not merge/release approval.

## Single-close diagnostic follow-up — 2026-10-26 21:25 UTC

This is additional failure evidence, **not a cleanup fix or a passing rerun**.
The product files, fixture, twenty functional checks and screenshot requirements
are unchanged from `8e8c28a`. A test-only helper now records connection loss and
the one `browser.close()` Promise separately. The limit remains 10,000ms; a
settlement-time monotonic check also rejects completion at/after that limit even
if the timer callback is late. A later resolution/rejection cannot erase FAIL.
Only the observer's listener is removed. The new close-observation helper never
inspects rejected error values; the runner emits only allowlisted failure
metadata. Screenshot publication still requires all checks AND cleanup.

New/changed diagnostic paths:

- `apps/benefits-web/scripts/support/history-close-observation.ts`
- `apps/benefits-web/tests/history-close-observation.test.ts`
- `apps/benefits-web/scripts/verify-benefit-history-browser.ts`

Executed from `apps/benefits-web/`:

```text
node --import tsx --test tests/history-close-observation.test.ts
node node_modules/typescript/bin/tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM,DOM.Iterable --types node --jsx react-jsx --strict --skipLibCheck --allowImportingTsExtensions --noUnusedLocals --noUnusedParameters --noImplicitReturns --noFallthroughCasesInSwitch --noUncheckedIndexedAccess --exactOptionalPropertyTypes scripts/support/history-close-observation.ts tests/history-close-observation.test.ts scripts/verify-benefit-history-browser.ts scripts/fixtures/benefit-history-fixture.tsx
npm test
```

Results: helper **15/15 PASS, exit 0**; strict TypeScript **exit 0**; full benefits
**3,340/3,340 PASS, exit 0**, fail/cancel/skip 0. These include immediate/late
resolve and reject, disconnect without settlement, one-call reentry, the
9,999/10,000/10,001ms boundary, opaque errors, invalid clocks and listener
ownership/failures. An independent read-only review found no concrete must-fix;
it did not repeat the browser execution. Product build/boundary/SSR receipts
above remain earlier evidence, not newly repeated by this diagnostic-only change.

### Actual Chrome run — FAIL retained

Root ran the same runner with `BROWSER_CHANNEL=chrome`, `--synthetic-only` and
`--screenshots` exactly once after preparation. A local, ignored PowerShell
observer started the Node process with a hidden window and read its direct
Chrome child. It verified executable, creation time, debugging-pipe arguments
and the generated temporary-profile scope, then retained a process handle to
avoid PID-reuse confusion. It never terminated a process or printed raw command
lines, profile paths or stderr. The observer's first preparation attempt could
not start Node because executable lookup returned multiple paths; no Node or
browser was launched. Selecting and validating one existing Node executable
corrected that observer-only error before the actual measurement.

| Observation | Result |
| --- | --- |
| Observer UTC interval | 21:25:29.8826591–21:25:57.5793351 |
| Runner UTC interval | 21:25:31.047–21:25:56.258 |
| Browser | Installed Chrome 156.0.8078.48; no installation/update by this task |
| Product fixture | 212,026 bytes, SHA256 `dd214fd9969d72cfea198aa08a27f8eb982af84258e75042cdab2061ce420253`; all eight source hashes match the prior failing run |
| Function/error evidence | 20 groups completed, seven error counters 0, stderr characters 0 |
| Close operation | Exactly 1 call; start 16,222.8204ms, disconnect 16,295.7559ms, deadline observation 26,227.3209ms on the Node monotonic clock |
| Promise versus connection | At the deadline: Promise PENDING, connected false, outcome DEADLINE, passed false |
| OS handle evidence | Verified direct main process last observed alive at observer +27,332.260ms; first observed exited at +27,443.580ms |
| Final owned state | Runner exited 1; verified Chrome main handle exited; its temporary profile absent; root post-check found 0 matching test browsers and 0 history runners |
| Images | No PNGs published; the reserved review image directory remains absent |

The Node time-origin anchor was `1793049930020.163` epoch milliseconds. Node and
OS-observer monotonic values have different origins and must not be directly
subtracted. Mapping via their wall-time anchors approximately places the last
main-process-alive observation after the close deadline. The OS exit result is
a polling interval, not an exact exit timestamp or proof about every descendant.
Thus this run supports delayed actual Chrome main-process exit after connection
loss; it does **not** identify why exit was delayed or prove an application bug.
The final JSON has a pending Promise snapshot; it cannot show a later settlement
after serialization. `cleanup.browser=true` alone only means disconnected.

The local observer is an ignored diagnostic artifact, not a distributed project
command. Its result does not replace the committed runner or normal CI. No
second `browser.close()`, wider deadline, generic process kill, error-counter
reset, browser update or Windows-policy bypass was used. Playwright's own
internal shutdown behavior is not a guarantee that it never uses a fallback.

PR #45 remains **Draft/HOLD**. #44's native transport failures and #42's exact
idle-boundary INCONCLUSIVE result remain separate. No real provider, Secret,
authentication, production DB or deployment was enabled.
