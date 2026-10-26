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
