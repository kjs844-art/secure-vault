# Candidate, catalog and reviewed-benefit composition checkpoint

Recorded 2026-10-26 UTC / 2026-10-27 Korea. Synthetic data only.
`REAL_SECRET_GATE=CLOSED`. This is an integration checkpoint, not a live-service
release or an authorization to accept real credentials or mail.

## Baseline and ownership

- Target branch: `codex/firstvibe-candidate-workspace-integration-20261027`.
- Starting HEAD: `5f6724dad7c3c04a6d4e5a97ab9304799bb4c06a` (PR 41).
- Target checkout: `agent-staging/keyatlas-pr35-framework-fixes-20261027`.
- Source checkout: `agent-staging/keyatlas-pr34-fixes-20261017`, baseline
  `dd2af499a9243fca5daec720cd46f2875edc1c3c`. It was read-only during this port;
  the rest of its dirty work was not copied, staged or reverted.
- Client/UI, server/support, and integration-policy files had separate authors.
  Independent read-only reviewers checked the other author's work.
- No package manifest, lockfile, hardened catalog HTTP/client implementation,
  public route, design system, crypto or recovery policy was changed.

## Implemented flow and explicit boundaries

```text
Explicit open in a fresh workspace
  -> explicitly receive an already completed synthetic analysis receipt
  -> manually read catalog and one known candidate batch
  -> select service and candidate (selection is not saving)
  -> review/correct fields -> preview -> explicit confirm/reject
  -> minimal result -> explicit read/list/detail -> optional past records
```

The actual React composition now includes service creation, all eight profile
fields in update, current-observation details/search, and explicit service-record
deletion. This deletes an application record, not an external account or mailbox.
Existing server rules reject deletion while live benefit records remain; the UI
does not infer safety from an incomplete visible list or cascade-delete records.

Catalog preview and execution share the original immutable request. Benefit
preview and confirmation are distinct request types; confirmation is bound to
the reviewed preview ID and its original operation ID. Uncertain responses
permit explicit rechecking of the original command, not automatic new writes. Closing a
view cancels its local authority but is not a rollback receipt. Navigation, lease
changes and late observations retire stale visible content and callbacks.

Reviewed benefits can be explicitly listed and inspected, with current/past
records separated. Values remain recorded observations, not verified current
provider balances or proof of account ownership. Source mail is not returned in
the minimal presentation. Pending-candidate discard is NOT included; preview
rejection, accepted-benefit deletion and alias expiry are different operations.

The public app does not mount these handlers or a live authenticated workspace.
`/api/catalog`, `/api/review` and `/api/inbox` are explicitly disconnected with
fixed 503/no-store responses. Runtime-mode query/cookie values cannot open them.
Real auth, Gmail/OAuth, production persistence, provider sync and deployment remain
separate held work. The browser fixture mounts real composition/handlers with
synthetic memory adapters; it is not a production account adapter.

## File scope

128 implementation/test/tooling paths plus this report:

| Owned set | Files | Scope |
| --- | ---: | --- |
| New client/UI and synthetic fixture sources | 36 | 34 product components/helpers, owners and React hook, plus 2 synthetic demo-data fixtures |
| New client/domain/SSR regressions | 38 | Explicit actions, session retirement, uncertainty, all profile values, details/history and no-I/O SSR |
| Server modules | 16 | 10 new inbox/review HTTP, alias, projection and delivery modules; 6 existing inbox/mail/review contract/service edits |
| Server regressions | 16 | 15 new tests plus one existing review-service test adjustment |
| Test adapters | 3 | New review loopback and candidate-selection fixture; expanded serialized memory store |
| Browser runner/fixture/support | 9 | Actual composition runner, three fixtures/probes, five diagnostic helpers |
| Browser-helper regressions | 6 | Abort identity, native lifecycle, diagnostics, read signals and experiment isolation |
| Integration policy/tests | 4 | Runtime namespace guard, 53 policy cases, client-bundle markers and actual SSR HTTP smoke |

The client author's 89 new files matched source after CRLF-to-LF normalization.
The server author's 35 files matched source byte-for-byte. Root's four files are
additive runtime/policy coverage, not source overlays. Existing catalog transport,
catalog view state from PR 41, package manifests/locks and catalog loopback helper
were verified unchanged. No generated output, JSON execution logs or dependencies
are included in the publication scope.

## Verification receipts

Commands below run in `apps/benefits-web` unless stated otherwise.

| Check | Exact command/scope | Outcome |
| --- | --- | --- |
| Full application tests | `npm test` | 3,280 PASS; zero failure/cancelled/skipped; exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Fresh build + build-script typecheck | `npm run build` | exit 0; existing dependency `use client` directive warnings retained |
| Post-build boundaries | `npm run check:boundaries` | exit 0; 96 source files, 6 public client output files; targeted checks, not full isolation proof |
| Actual public SSR smoke | `npm run test:smoke` | exit 0; public demo renders and disconnected inbox/review/catalog POST paths return fixed 503 |
| Runtime focused tests | `node --import tsx --test tests/runtime-policy.test.ts` | 53 PASS; exit 0; included in full-suite count |
| Browser helper regressions | Six helper test files | 65 PASS; exit 0; included in full-suite count |
| Browser runner standalone strict TypeScript | Command below | Initially exit 1: local Playwright module absent; after reusing existing 1.63.0 installation, exit 0 |
| Actual composition Chrome | `node --import tsx scripts/verify-candidate-review-browser.ts --synthetic-only`, `BROWSER_CHANNEL=chrome` | 116 groups PASS; exit 0; all seven error counters 0; owned cleanup true |
| Actual composition Edge | Same command, `BROWSER_CHANNEL=msedge` | 116 groups PASS; exit 0; all seven error counters 0; owned cleanup true |
| Development-effect Chrome | Same Chrome command plus `--development-effects` | 116 groups PASS; exit 0; errors 0; cleanup true; explicit keyed remount measured 2 setups / 1 cleanup |
| Repository Secret scan | Root `pwsh -NoProfile -NonInteractive -File scripts/check-repository-secrets.ps1` | exit 0; baseline 4 allowed, scan passed, CLOSED |

```text
node node_modules/typescript/bin/tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM,DOM.Iterable --types node --jsx react-jsx --strict --skipLibCheck --allowImportingTsExtensions --noUnusedLocals --noUnusedParameters --noImplicitReturns --noFallthroughCasesInSwitch --noUncheckedIndexedAccess --exactOptionalPropertyTypes scripts/verify-candidate-review-browser.ts
```

Playwright and playwright-core 1.63.0 were already present in the separate idle
verification checkout. Two ignored directory junctions reuse those exact local
packages for this runner. No browser/package was downloaded or upgraded, no
original installation changed, and this is not a clean-install reproducibility
claim. Dependency setup is not committed.

The default Chrome 155.0.8059.85 production-fixture run lasted from
2026-10-26 18:29:45.573 to 18:32:15.318 UTC. Its single 407,223-byte fixture
bundle SHA-256 was
`5ec907f7b7e9e8f4caf233b4b37dc2619eea1396ba859bcaabd54c3a9cfbe209`.
It exercised actual HTTP handlers, explicit service/benefit commands and
uncertain-result rechecking. The 320/360px viewport observations showed no
overflow and retained visible focus. Native history observations use trusted
persisted lifecycle events and same-document identity; controlled visibility
tests are separately labelled. No optional cleanup transform or native-network
diagnostic mode was enabled. This new PASS does not establish the cause or
resolution of earlier independent native EOF/cleanup anomalies.

Ten Chrome native-history paths recorded same-document identity plus trusted
persisted pagehide/pageshow with closed private DOM: saved detail, candidate
review, create/update/delete before and after commit, notes, and manual facts.
The Edge 156.0.4314.42 default run (18:32:54.395–18:35:22.665 UTC) served the
same fixture bundle and also passed these ten native-history observations. It
had no cleanup failures. That fresh result is retained beside, not substituted
for, the different earlier Edge framework/blank-control cleanup failures.

Development Chrome ran 18:35:59.508–18:38:46.089 UTC with a separate
1,273,985-byte fixture bundle, SHA-256
`d440b2d3a8ba17b83855e3fba4c4d6204533762f0687fcbadded7473edb8dda2`.
Initial hydration measured 1 setup / 0 cleanup; the explicit keyed remount
measured development StrictMode's 2 setups / 1 intervening cleanup, with no
automatic HTTP. All ten native history paths also passed. This is not a claim
that initial hydration itself replayed effects or that HMR was tested.

Original source preservation was rechecked after the port: HEAD unchanged,
374 dirty paths / staged 0; all 1,019 existing nonignored files retained the
same aggregate SHA-256
`B621FB1FC3795DB1E114971886DEFD850DFC91060E68A972FCB165B4E0DEBA83`.

Focused author runs are subsets/overlaps of the full-suite result, not additional
product test totals. One all-client focused command lost its terminal receipt;
it was not claimed as a pass. Root's subsequent full suite has a direct exit-0
receipt and includes those tests.

## Independent review and remaining limits

Independent read-only reviews found no concrete Important blocker in the client
composition, scoped server contracts or four runtime/boundary edits. The
agent-consent-patterns guidance informed explicit preview/confirm, immutable
requests, least-destructive cancellation, revocation and honest uncertainty.
This is not an external security audit or approval to activate real accounts.

- Stable host-owned workspace/client/completion ports and fresh verified session
  bindings remain required. A binding label is not an authentication credential.
- The synthetic serialized store demonstrates its contract, not production DB
  transaction isolation, durable concurrency or disaster recovery.
- Current/past views do not certify provider facts or remaining credit balances.
- Native browser timing/cleanup/transport failures must remain failures or
  inconclusive, even if body reads or functional assertions finish successfully.
  Historical original-source runs are not new evidence for this checkout.
- The fixture uses same-origin CSP, fresh browser contexts and fixed synthetic
  ports. Its external-request counters observe traffic; they are not a blanket
  pre-dispatch network sandbox. The default run does not enable optional cleanup
  transforms or native-network diagnostic observers.
- Chrome and Edge are both Chromium-based. They do not establish Firefox/WebKit,
  real mobile devices, screen-reader speech or OS suspension behavior.
- Source/lock/bundle marker checks are targeted controls, not a proof that all
  possible information flow is absent.
- Exact-head CI, final Secret/docs/diff checks and a fresh review-state query are
  required before merge. This report alone does not claim GitHub publication,
  merge, deployment or completion of the complete product.

Publication checks: final repository Secret scan, this document's relative links
and `git diff --check` all exited 0. The feature branch is synchronized before
publication with main's already-reviewed landing-only dependency update from
PR 40; that base synchronization is not a new package change in this feature's
PR diff. Browser reports and generated output remain ignored local evidence.
