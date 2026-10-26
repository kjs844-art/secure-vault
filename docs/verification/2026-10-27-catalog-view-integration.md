# Catalog view integration checkpoint

Recorded 2026-10-26 UTC / 2026-10-27 Korea. Synthetic data only;
`REAL_SECRET_GATE=CLOSED`. This is a narrow local integration and verification
record, not a deployment approval or evidence of a mounted catalog application.

## Baseline and ownership

- Target checkout: `agent-staging/keyatlas-pr35-framework-fixes-20261027`.
- Target branch: `codex/firstvibe-catalog-view-integration-20261027`.
- Baseline main: `41568f02219bbf6b5a86ec903126d87f612ea721`.
- Read-only source: `agent-staging/keyatlas-pr34-fixes-20261017`, whose baseline
  is `dd2af499a9243fca5daec720cd46f2875edc1c3c` and whose uncommitted work remains
  separate. This port does not take that checkout's complete dirty tree.
- The compatible Start `1.169.3` / Router `1.170.45` installation and existing
  hardened catalog transport were already integrated. No package manifest,
  lockfile, dependency installation or framework version was changed here.

The implementation scope is exactly fourteen files: six new production modules,
seven new test files and one additive public-export edit. This report is the
fifteenth file. Generated build output is ignored and is not part of the port.

## Implemented slice

The existing bounded, request-correlated catalog client now has reusable
in-memory owners for observations, commands, paging and React lifecycle binding:

| Layer | Responsibility |
| --- | --- |
| View state | Apply only matching view/generation observations; preserve newer rows and deletion observations; retain explicit refresh requirements |
| Command controller | Issue opaque tokens for detached original requests; fence late replies and old sessions; permit only explicit same-command retries |
| View store | Bind an active view to an opaque lease; revoke old commands and observations before cancellation callbacks; publish immutable snapshots |
| Page session | Explicit bounded traversal using its own validated cursor; stop on collection changes or capacity instead of silently restarting |
| Selection source | Expose only the current explicit catalog observation; hide uncertain or stale selection data and require deliberate retry/restart |
| React hook | Use an empty server snapshot and caller-owned lifecycle binding; mask mismatched context during render and register native navigation invalidation |

No new product route is mounted. The existing runtime policy still returns 503
for `/api/catalog` and its descendants. This implementation does not authenticate
the caller or connect a real provider, operational database, account or mailbox.

## Exact implementation paths

All paths below are relative to `apps/benefits-web/`.

New production modules:

- `src/domain/catalog-client/view-state.ts`
- `src/domain/catalog-client/view-controller.ts`
- `src/domain/catalog-client/view-store.ts`
- `src/domain/catalog-client/page-session.ts`
- `src/domain/catalog-client/selection-source.ts`
- `src/hooks/useCatalogView.ts`

New focused tests:

- `tests/catalog-client-view-state.test.ts`
- `tests/catalog-client-view-controller.test.ts`
- `tests/catalog-client-view-store.test.ts`
- `tests/catalog-client-view-composition.test.ts`
- `tests/catalog-client-page-session.test.ts`
- `tests/catalog-client-react-ssr.test.ts`
- `tests/catalog-selection-source.test.ts`

The only existing implementation file edited is
`src/domain/catalog-client/index.ts`. It adds `CatalogViewContext` and the five
domain modules' factories, reducer, limits and associated types. The React hook
remains a direct import, so the domain barrel does not import React.

## Preservation and dependency closure

Thirteen new files were compared with the read-only source after normalizing
CRLF to LF; their content matches. The imported module closure of the six new
production files is exactly nine concrete files: those six and the already
integrated `client.ts`, `requests.ts`, `responses.ts`. The additive barrel is
tracked separately above. No review/mail controller or review-workspace UI was
pulled into this closure.

SHA-256 before/after comparison confirmed these eight existing files unchanged:

- `src/domain/catalog-client/client.ts`
- `src/domain/catalog-client/requests.ts`
- `src/domain/catalog-client/responses.ts`
- `tests/support/catalog-http-loopback.ts`
- `tests/support/review-memory-store.ts`
- `tests/framework-compatibility.test.ts`
- `package.json`
- `package-lock.json`

In particular, the page-session loopback test uses the existing integrated
helper and memory store. It does not require copying the original checkout's
expanded review/inbox test infrastructure. The synthetic HTTP fixture is not
proof of production ingress memory bounds or durable database isolation.

## Verification evidence and provenance

Commands run in `apps/benefits-web` unless explicitly marked repository root.
The evidence sources below are deliberately distinguished.

| Check | Observed result | Evidence provenance |
| --- | --- | --- |
| Seven focused files, exact command below | 143 passed; 0 failed/cancelled/skipped/todo; 1757.9356 ms; exit 0 | Directly observed terminal result from this port |
| `npm run typecheck` | exit 0 | Directly observed terminal result from this port |
| `npm test` full suite | Log records 1579 passed; 0 failed/cancelled/skipped/todo; 6463.1173 ms | Root's retained `target/reports/catalog-view-full-tests.log`, read by the report author; original terminal exit receipt was truncated and was not independently recovered; suite was not repeated |
| Publication `npm test` confirmation | 1579 passed; 0 failed/cancelled/skipped/todo; 5995.6575 ms; exit 0 | Root reran once specifically to obtain an unambiguous publication exit receipt after the earlier tool response was truncated; `target/reports/catalog-view-publication-tests.log` |
| Fresh `npm run build` | Client/SSR/Nitro build and subsequent TypeScript check completed; exit 0 | Newly executed by the report author, including final terminal completion receipt; not inferred from the earlier build log |
| `npm run check:boundaries` | exit 0 | Root reported its separate recheck; not independently rerun by this report author |
| `npm run test:smoke` | exit 0 | Root reported its separate recheck; not independently rerun by this report author |
| Normalized source comparison / protected hashes / import closure | 13 matching new files / 8 unchanged protected files / 9-file concrete production closure; exit 0 | Directly observed read-only validation |
| UTF-8/LF/whitespace and repository `git diff --check` | exit 0 | Directly observed after the implementation port |

The fresh build retained the existing module-level `use client` directive
warnings and bundler debug-name warning. Its exit 0 does not mean warning-free
output or complete browser verification.

Exact focused command:

```text
node --import tsx --test tests/catalog-client-view-state.test.ts tests/catalog-client-view-controller.test.ts tests/catalog-client-view-store.test.ts tests/catalog-client-view-composition.test.ts tests/catalog-client-page-session.test.ts tests/catalog-client-react-ssr.test.ts tests/catalog-selection-source.test.ts
```

The 143 focused cases are included in the 1579 full-suite cases; do not add the
counts together. Historical browser runs from the original dirty source or
older framework checkpoints are not fresh evidence for this integrated slice.

Root's post-build repository Secret scan also completed with exit 0:
`SECRET_SCAN_BASELINE_ALLOWED=4`, `SECRET_SCAN_PASSED`, `REAL_SECRET_GATE=CLOSED`.
The original source remained at its baseline, with 374 dirty paths, no staged
paths and all 1019 existing nonignored file hashes unchanged. Main advanced to
`e21348e5ed103c67acd85b0d68d5c51e8d7978b4` through the independently reviewed
landing-only dependency PR; benefits manifests and hardened transport remain
identical to that main revision.

## Independent review and unverified boundaries

An independent read-only review reported no confirmed must-fix in this scoped
port. It retained the following limitations; this is not an external security
audit or a declaration that the complete product is ready.

- No mounted React catalog route, real authenticated session owner or successful
  production catalog operation was exercised. `bindingId` and generation values
  are caller-supplied lifecycle labels, not credentials or authorization.
- A real host must keep one stable store per owner, avoid an SSR/module-global
  shared store, and synchronously retire the old lease when verified authority
  changes. A fresh binding identity is required for a new session.
- React SSR tests prove empty output and no activation/transport for their
  scenarios. They do not prove hydration, effect cleanup, actual `pagehide`,
  `pageshow`, history navigation or BFCache behavior in this integrated checkout.
- Current browser execution, keyboard/focus behavior, screen-reader speech,
  real mobile devices, OS suspension and process termination were not checked
  in this port. No browser was launched by the implementation/report author.
- In-memory original-command retry is not durable recovery. Closing the owner
  can discard its request token; cancellation or an error is not proof that a
  server write rolled back. Already returned JavaScript references cannot be
  retroactively erased by clearing this store.
- End-of-pagination means an observed end, not complete/fresh provider truth.
  Real provider balances, account discovery, subscriptions and credentials remain
  disconnected. The pending-candidate discard client and confirmation UI are
  separate unfinished work and were not imported here.
- The existing Edge close-deadline and native EOF/ERR_ABORTED investigations
  remain separate OPEN items, not resolved by these model/SSR tests. See the
  [framework checkpoint](2026-10-27-pr35-framework-compatibility.md) for its
  separately recorded browser outcomes and limitations.

No commit, push, PR creation, CI request, merge, public route activation,
production account/DB connection, real Secret activation or computer shutdown
was performed by this port/report task. Publication status must be recorded
separately by the root task after its own checks and authority review.
