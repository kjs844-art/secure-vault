# Existing Discovery Inbox focus and committed input scope

Status: scoped web/browser checks passed; workspace verification and publication
are still pending below. Not a release approval. `REAL_SECRET_GATE=CLOSED`.

## Scope and baseline

Branch `codex/firstvibe-discovery-focus-20261027` starts at main
`5744ce13a68d0577cab0f317ab6ebe911bf5c8ed`. The existing
`/?view=discovery-inbox` route is the target. This is not the C06 session-owned
`DiscoveryInboxReview` and does not enable mailbox access, authentication,
storage, provider verification, or real credentials. No new product route,
design, package, contract, or Rust source is required.

The original `keyatlas-pr34-fixes-20261017` checkout is read-only. Its remaining
focus patch is a reference, not a blanket overlay: current main behavior and
tests must be preserved. PR #48 remains on its own branch; this branch does not
silently incorporate that unmerged work.

## Before-change evidence

- New callback/lifetime regression file: 12 tests, **6 PASS / 6 FAIL, exit 1**,
  using `npm test -- src/features/discovery-inbox/DiscoveryInboxPanel.interaction.test.tsx`
  from `apps/web`. The failures concern removed active triggers and a retained
  callback after unmount; hook mocks do not prove browser or React scheduling.
- Actual installed Chrome `156.0.8078.48`, command from repository root:
  `node apps/web/scripts/verify-discovery-focus-browser.mjs --synthetic-only --channel=chrome`.
  2026-10-26T22:44:18.773Z to 22:44:26.201Z: baseline group passed, then
  `FIXTURE_CONFIRM_REMOVED_ROW_FOCUS` failed, **exit 1**. Native Enter removed
  the row but the selected needs-review filter did not regain focus.
- Eleven browser/error counters were zero. Context, browser and server cleanup
  resolved within their existing deadlines; sockets were zero. A separate
  process check after the run found zero test browsers and relevant runners.
- RED fixture entry SHA256:
  `ba75940fcd29d8add02ac40fb92b73479b0545e874016128026ce5341455712e`;
  asset manifest SHA256:
  `6213175092e0ba1b1b5ab1e139b361ffc8dcdbe6a48963ef08b455cd70dc6be3`.
  This RED run used the production component in a synthetic React wrapper,
  not the app dist route. The failed focus assertion must stay unchanged.

## Change and review

Input context and its initial view are memoized without render-phase state
writes. Ownership is published only by layout commit and cleared on cleanup.
Both dispatch and the eventual updater reject an obsolete scope. Current-scope
queued actions reduce the latest view. Same-array return after an actual input
replacement gets a fresh scope; a discarded render is not a committed change.

Only an explicitly active status button can request a focus handoff. If that
button disappears and focus falls to its document body, the connected selected
filter in the same document receives focus once. Connected controls, external
focus, source replacements and old callbacks do not steal or clear that handoff.
No labels, status meanings, model, route, styles, C06 or persistent data changed.

An independent read-only review of the product, two test files and two browser
files found no concrete must-fix or weakened existing assertion. This is not an
external security certification or proof of absence of all defects.

## After-change checks

Commands below use the same fixed source; web commands run in `apps/web`.

| Check | Result |
| --- | --- |
| `npm test -- src/features/discovery-inbox` | 44/44 PASS, five files, exit 0 |
| `npm test` | 2,102/2,102 PASS, 70 files, exit 0; started 07:53:31 KST, 31.33s |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0, Vite 8.3.4, 63 modules; existing synthetic WASM reused |
| `node --check apps/web/scripts/verify-discovery-focus-browser.mjs` | exit 0 |
| Strict fixture TypeScript command below | exit 0 |
| CLI refusal/preflight | eight invalid invocations each expected exit 2, four preflights exit 0; wrapper exit 0 |
| `pwsh -NoProfile -NonInteractive -File scripts/check-repository-secrets.ps1` | exit 0, baseline allowed 4, PASSED/CLOSED |
| `pwsh -NoProfile -NonInteractive -File scripts/verify-local.ps1 -Scope Workspace` | still running; do not call complete yet |

The original 12 interaction cases are preserved; three more check a queued
updater after replacement/unmount and authority of uncommitted input. All
seven existing refresh assertions remain, with event/ref/effect test-harness
support added. Hook-mock checks do not replace the actual browser evidence.

```text
node apps/web/node_modules/typescript/bin/tsc --ignoreConfig --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM,DOM.Iterable --types node --jsx react-jsx --strict --skipLibCheck --noUnusedLocals --noUnusedParameters --noImplicitReturns --noFallthroughCasesInSwitch --noUncheckedIndexedAccess --exactOptionalPropertyTypes apps/web/scripts/fixtures/discovery-focus-fixture.tsx apps/web/src/vite-env.d.ts
```

### Actual browser results

Root ran the browsers one at a time, checking prior test-process absence before
the second browser and after final cleanup. The commands are:

```text
node apps/web/scripts/verify-discovery-focus-browser.mjs --synthetic-only --built-app --channel=chrome
node apps/web/scripts/verify-discovery-focus-browser.mjs --synthetic-only --built-app --channel=msedge
```

| Browser | UTC interval on 2026-10-26 | Result |
| --- | --- | --- |
| Chrome 156.0.8078.48 | 22:56:49.200 to 22:57:02.209 | 16 groups PASS, exit 0 |
| Edge 156.0.4314.42 | 22:58:27.399 to 22:58:34.779 | 16 groups PASS, exit 0 |

Each run checked 12 fixture groups and four fresh built-app route groups. The
first failed focus assertion from RED is unchanged; the fixture subsequently
gained two concurrent-render groups. Both browsers observed four suspended
attempts, two released gates, zero commits from discarded B, and one fresh B
commit. A remained interactive while B was suspended, retained its edits after
B was discarded/late-released, and fresh B reset correctly on actual commit.

Native keyboard confirmation, last-row dismissal, restoration from dismissed,
an active button removed while its row remains, connected sibling/external
focus, replacement/empty/ABA, remount, 320/360px layout, empty browser storage,
the real home link and built C04 route were checked. All eleven request/error
counters were zero, all owned cleanup steps resolved, sockets were zero, and
post-run test-browser/relevant-runner counts were zero.

The two after-change runs served identical hashes:

| Input | SHA256 |
| --- | --- |
| Fixture entry | `849d7ec7c8755b4e6a848a41042f6a5f5ded2f9c4d0fc93b3a6447e2242f2bd2` |
| Fixture assets manifest | `85ef5fe4fc9ccaa305e5895b95db871fced020c69dbc6a9a3a527b355268039f` |
| Built index | `093e7a63aa0ea09310becbfd59b149f98bb26132f237820ac51be051ff255323` |
| Built assets manifest | `ed423ce36e958f4c64f8b807a5771696ca09dbdbadc604e94d14349ce1bca3e0` |

## Limits and publication

These are synthetic desktop browser checks, not actual mobile OS, assistive
technology, authentication, mailbox, vault or deployment validation. Production
React wrapped in StrictMode is not development effect-replay evidence. No
BFCache assertion is made. Storage snapshots do not prove no transient write
ever happened. Request interception is not OS-level network isolation. Served
byte hashes are not a general source-to-build attestation. Deadline success is
not proof about every browser descendant; a separate process check complements
the owned cleanup report. There was no force kill or deadline widening.

No commit, push, PR or merge has been performed for this change at this point.
Existing PR #44/#45/#48 browser holds and #32 recovery-policy/conflict hold are
separate and remain unresolved; success here does not erase their failures.
No test-browser download has been approved. The original checkout is preserved.
