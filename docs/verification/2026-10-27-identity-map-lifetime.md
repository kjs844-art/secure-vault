# Identity Map account identity and committed-view lifetime

Date: 2026-10-27 Korea / 2026-10-26 UTC. `REAL_SECRET_GATE=CLOSED`.
Branch: `codex/firstvibe-identity-map-lifetime-20261027`.
Base: main `5744ce13a68d0577cab0f317ab6ebe911bf5c8ed`.

## Scope

This is a narrow synthetic UI correction, not real account discovery, identity
verification, authentication, a persistent identifier change or an external
connection. The preserved dirty source checkout was compared read-only; only
the relevant semantic changes were applied to the current main-based checkout.
No package/lock, CSS, copy overhaul, routing, Rust, wire contract or real data was
changed. Existing assertions were not removed or weakened.

- Account identity is a private JSON tuple of provider and recorded account.
  Within the accepted string/null contract, missing versus empty and delimiter
  characters in either value no longer collapse into one UI identity.
- Replacement input gets a fresh scope. Only committed layouts publish that
  scope; rendering a replacement does not mutate shared selection state.
  Old-input/unmounted callbacks cannot alter the current selection.
- Escape is scoped to the active panel rather than the whole document.
- Focus returns to the selected step only when the active trigger was removed
  and focus fell to that document's body. External focus is not stolen.
- Embedded panels use distinct heading/section IDs for accessible labels.

Product and regression paths under `apps/web/src/features/identity-map/`:

- `identityMapModel.ts`, `identityMapModel.test.ts`
- `IdentityMapPanel.tsx`, `IdentityMapPanel.test.tsx`
- `IdentityMapPanel.interaction.test.tsx` (new)

Browser evidence uses the actual product component via
`apps/web/scripts/fixtures/identity-map-fixture.tsx` and
`apps/web/scripts/verify-identity-map-browser.mjs`. The fixture is test-only.

## RED and local checks

From `apps/web/`, the author ran this identical selection before and after the
product edit:

```text
npm test -- src/features/identity-map/identityMapModel.test.ts src/features/identity-map/IdentityMapPanel.test.tsx src/features/identity-map/IdentityMapPanel.interaction.test.tsx -t 'keeps unrecorded|keeps delimiter|does not let stale account|ignores old|gives two embedded'
```

Before: **7 FAIL / 27 filtered out, exit 1** (two identity collisions, four stale
callback cases, one duplicate ARIA-ID case). After: **7 PASS / 27 filtered out,
exit 0**. The filter exclusion is not a new `.skip`; the subsequent unfiltered
feature run passed all **34 tests / 3 files, exit 0**.

| Check | Command | Result |
| --- | --- | --- |
| Feature, author | `npm test -- src/features/identity-map` | 34/34 PASS, exit 0 |
| Full web, root | `npm test` | **2,107/2,107 PASS, 70 files, exit 0** |
| App types, root | `npm run typecheck` | exit 0 |
| Fresh production build, root | `npm run build` | exit 0, Vite 8.3.4; existing ignored demo WASM reused |
| Runner syntax | `node --check apps/web/scripts/verify-identity-map-browser.mjs` from root | exit 0 |
| Runner preflight | Eight invalid argument cases and four positive `--preflight` cases | Expected child exit 2 / 0 respectively, assertion wrapper exit 0; no browser launched |

Strict fixture types, from root, exit 0:

```text
node apps/web/node_modules/typescript/bin/tsc --ignoreConfig --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM,DOM.Iterable --types node --jsx react-jsx --strict --skipLibCheck --noUnusedLocals --noUnusedParameters --noImplicitReturns --noFallthroughCasesInSwitch --noUncheckedIndexedAccess --exactOptionalPropertyTypes apps/web/scripts/fixtures/identity-map-fixture.tsx apps/web/src/vite-env.d.ts
```

Independent read-only review found no concrete must-fix in the five product/test
files and confirmed the original assertions were preserved. The interaction tests
mock hooks to inspect callbacks/state; they do not prove real DOM focus or React
concurrent scheduling. The following browser fixture supplies separate evidence.

## Actual installed browsers — mixed outcome, not all green

Root built the app immediately before these runs. The runner itself only reads
existing dist and never claims that its hash alone proves source-to-build
freshness. The explicit commands, from root, were:

```text
node apps/web/scripts/verify-identity-map-browser.mjs --synthetic-only --built-app --channel=msedge
node apps/web/scripts/verify-identity-map-browser.mjs --synthetic-only --built-app --channel=chrome
```

| Browser and UTC interval | Functional evidence | Overall outcome |
| --- | --- | --- |
| Edge 156.0.4314.42, 21:44:09.108–21:44:28.816 | 15 groups completed, all 11 counters zero | **FAIL / exit 1**: BROWSER_CLOSE reached its 10,000ms deadline; context/server resolved, disconnected, sockets 0 |
| Chrome 156.0.8078.48, 21:45:46.622–21:45:54.309 | 15 groups completed, all 11 counters zero | **PASS / exit 0**, all owned cleanup steps resolved |

Root confirmed zero matching Playwright test browsers after Edge, before Chrome.
Final disconnected/closed state does not erase a preceding cleanup deadline.
Neither browser was installed/updated by this task, no user's browser profile
was attached, and no process was terminated by name. The runner calls no
process-kill API; that is not a guarantee about Playwright's internal fallback.

The 11 fixture groups cover panel-local ARIA, actual keyboard and focus,
programmatic actions without focus theft, scoped Escape, A/B/empty replacement,
discarded and fresh committed Suspense renders, missing/empty accounts,
delimiter-containing accounts, unmount/remount and 360/320px layout/storage.
Four built-app groups check the real home link and identity route, closed gate,
keyboard/back/reset, 320px navigation, built assets and empty local/session/IDB
storage. Request interception in the owned context is not an OS network sandbox.

Both runs observed six suspension attempts, two gate releases, **zero discarded
B commits** and **one fresh B commit**. These are production React fixture
observations, not development StrictMode effect-replay coverage.

Both used the same byte evidence:

```text
fixture entry SHA256: e07a9d261f1a67ad290501849446a56bd319bf9d4e4766eb41d7cc7afa68572d
fixture assets SHA256: 57517b937dfa1cdc7f956e8931617dd417bc9886a5d2c5f3828120daa5f3f15c
built index SHA256: 38c4a442ef568b05d1e65e15775ff9d612b39c30ed16c7a1ff884dc9cc88c9c8
built assets SHA256: a0f80590d4759324e24f0b1fa380934b8425626bdbc77bc4ff2a1a0e5902282a
```

The Edge deadline remains unresolved and prevents an all-green/merge-ready
claim. A later Chrome pass does not resolve that failure or #45's separate
Chrome-close failure. #44's native transport failure and #42's exact idle timing
INCONCLUSIVE evidence remain independent. No repeated run, wider timeout,
failure suppression or real-account experiment was used to manufacture PASS.

## Remaining limits

- No real account/Secret/mail, authentication, operational DB, deployment or
  physical mobile device was tested or enabled.
- No BFCache claim is made by this runner.
- Closing is bounded waiting, not guaranteed cancellation or proof that every
  OS descendant has exited.
- Rust source is unchanged. The earlier full workspace verifier at the #47
  predecessor completed exit 0; this UI slice did not rerun all Rust tests.
- Exact-head CI/review must still be checked after publication. Preserve Draft
  status while the Edge cleanup failure remains unexplained.
